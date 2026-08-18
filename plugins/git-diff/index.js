// Git Diff — runs git in a session's working folder and renders the patch with diff2html.
// Nothing here writes to the repository: no add, no index updates, read-only commands only.
//
// This file is the wiring: it answers the client's messages, holds the caches, and puts the
// other modules in order. The work itself lives next to it — git.js runs git, untracked.js
// synthesises patches for untracked files, budget.js says what may be parsed, format.js shapes
// the reply, and render.js is the only module that touches an npm package.

const { homedir } = require('os');
const { promises: fsp } = require('fs');
const { collectUntracked } = require('./untracked');
const { MAX_PATCH_BYTES, MAX_LINE_CHARS, capLongLines } = require('./budget');
const {
  makeGit, resolveRepo, resolveBase, listWorktrees, assessTrust, diffPatch, listUntracked, numstatFiles,
} = require('./git');
const {
  clampContext, clampMaxChanges, untrackedFileList, parsedFileList, sumTotals, tooBigVerdict,
  shouldHighlight, cacheKey, normaliseScope, normaliseLayout, diffPayload, failPayload,
} = require('./format');
const {
  parsePatch, renderHtml, installBrowserBundle, highlightStyles, diff2htmlStyles,
} = require('./render');

const CACHE_MAX = 20;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000;
const FOLDER_STAT_TIMEOUT = 2000;
const TRUST_TTL = 60 * 1000;

// The folder to diff. An explicit client choice wins, as long as it is a directory. Otherwise
// use where the session was spawned. UPSTREAM.md proposes exposing the session's process id so
// a plugin could follow the shell's real working directory instead.
async function resolveFolder(session, requested) {
  if (typeof requested === 'string' && requested) {
    if (await isDirectory(requested)) return { folder: requested, rejected: false };
    return { folder: session.cwd, rejected: true };
  }
  return { folder: session.cwd, rejected: false };
}

// An asynchronous stat with a deadline. A path on a dead NFS or autofs mount answers neither
// way, and the synchronous version would hold the event loop for as long as that takes. The
// stat itself keeps occupying a threadpool slot after the timeout, which cannot be cancelled,
// but the server carries on.
async function isDirectory(path) {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), FOLDER_STAT_TIMEOUT); });
    const stat = await Promise.race([fsp.stat(path), timeout]);
    return !!stat && stat.isDirectory();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function buildDiff(cwd, scope, settings, opts = {}) {
  const git = makeGit(!!opts.untrusted);
  const repo = await resolveRepo(git, cwd);
  if (!repo.ok) return repo;

  const { repoRoot, branch } = repo;
  const { base, baseLabel, baseFallback, baseIsHead, badSetting } =
    await resolveBase(git, repoRoot, scope, String(settings.baseBranch || '').trim());

  const tracked = await diffPatch(git, repoRoot, base, clampContext(settings.contextLines));
  if (!tracked.ok) {
    if (tracked.timedOut) return { ok: false, code: 'timeout', message: 'git diff timed out' };
    return { ok: false, code: 'git-failed', message: tracked.message || 'git diff failed' };
  }

  const untracked = await collectUntracked(repoRoot, await listUntracked(git, repoRoot));
  const patch = tracked.stdout + untracked.patch;
  const patchBytes = Buffer.byteLength(patch);
  const maxChanges = clampMaxChanges(settings.maxChanges);

  const worktrees = await listWorktrees(git, repoRoot);
  // Skipped paths contribute no patch text, so they never appear in a parsed file list and have
  // to travel separately.
  const skippedEntries = [...untracked.skipped].map(([path, kind]) => ({ path, kind }));
  const common = {
    ok: true, repoRoot, branch, base, baseLabel, baseFallback, baseIsHead: !!baseIsHead,
    baseBranchInvalid: !!badSetting, patch, patchBytes, maxChanges, worktrees, skippedEntries,
    untrackedTruncated: untracked.truncated || null,
  };

  // Parsing is where a huge diff costs the server, so the byte check comes before it. The file
  // list then has to come from somewhere other than the parse.
  if (patchBytes > MAX_PATCH_BYTES) {
    const files = [...await numstatFiles(git, repoRoot, base), ...untrackedFileList(untracked.entries)];
    const totals = sumTotals(files);
    return {
      ...common,
      parsed: [],
      totals,
      files,
      tooBig: tooBigVerdict({
        patchBytes, changes: totals.additions + totals.deletions, maxChanges, maxPatchBytes: MAX_PATCH_BYTES,
      }),
    };
  }

  // A change count says nothing about line length, and cost grows with it: a minified bundle is
  // a few lines of a few hundred kilobytes each. Those files are replaced by git's own binary
  // placeholder before parsing. The patch kept for Copy patch is the real one, not this.
  const capped = capLongLines(patch);
  const parsed = parsePatch(capped.patch, maxChanges);
  const files = parsedFileList(parsed, { oversized: untracked.oversized, longLines: capped.longLines });
  const totals = sumTotals(files);

  return {
    ...common,
    parsed,
    totals,
    files,
    tooBig: tooBigVerdict({
      patchBytes, changes: totals.additions + totals.deletions, maxChanges, maxPatchBytes: MAX_PATCH_BYTES,
    }),
  };
}

module.exports = {
  init(api) {
    const bundleReady = installBrowserBundle(api.pluginDir, (m) => api.log(m));

    // sessionId → last built diff, so a layout toggle re-renders instead of re-running git.
    const cache = new Map();
    // Diffs already being built, so two tabs polling one session share the work rather than
    // starting a second set of git processes.
    const inFlight = new Map();
    // sessionCwd|folder → whether that folder's git configuration may be used, with the keys
    // that made it unsafe. Cached because it costs two git calls and rarely changes.
    const trustCache = new Map();

    function pruneCache() {
      const now = Date.now();
      for (const [id, entry] of cache) {
        if (now - entry.at > CACHE_TTL || !api.getSession(id)) cache.delete(id);
      }
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      // A single large diff can hold more memory than every other entry together, so the cache
      // is bounded by bytes as well as by count. Oldest first, same as the count rule.
      let bytes = 0;
      for (const entry of cache.values()) bytes += entry.bytes;
      for (const [id, entry] of cache) {
        if (bytes <= CACHE_MAX_BYTES) break;
        bytes -= entry.bytes;
        cache.delete(id);
      }
      for (const [key, entry] of trustCache) {
        if (now - entry.at > TRUST_TTL) trustCache.delete(key);
      }
    }

    async function trustFor(sessionCwd, folder) {
      const key = `${sessionCwd}|${folder}`;
      const hit = trustCache.get(key);
      if (hit && Date.now() - hit.at < TRUST_TTL) return hit.verdict;
      const verdict = await assessTrust(sessionCwd, folder);
      trustCache.set(key, { at: Date.now(), verdict });
      return verdict;
    }

    function fail(msg, code, message, folder, extra = {}) {
      const session = api.getSession(msg.sessionId);
      api.sendToFrontend('diff', failPayload({
        msg, code, message, folder, sessionCwd: session?.cwd || '', home: homedir(), extra,
      }));
    }

    function reply(msg, built, layout, session, folder, folderRejected, trusted) {
      const settings = api.getSettings();
      api.sendToFrontend('diff', diffPayload({
        msg,
        built,
        layout,
        session,
        folder,
        folderRejected,
        trusted,
        home: homedir(),
        maxLineChars: MAX_LINE_CHARS,
        highlight: bundleReady && shouldHighlight(built.totals, settings),
        // A diff past either limit is not rendered at all: the client draws its own file list.
        html: built.tooBig ? '' : renderHtml(built.parsed, layout),
      }));
    }

    // Every request gets an answer. A tab that is left waiting stops polling, since its own
    // request is still outstanding as far as it knows, so replies are never suppressed for
    // being out of date: the client drops the ones whose requestId is not its own.
    async function handleDiff(msg) {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      const settings = api.getSettings();
      const scope = normaliseScope(msg.scope);
      const layout = normaliseLayout(msg.layout);
      const { folder, rejected } = await resolveFolder(session, msg.folder);

      let trust;
      try {
        trust = await trustFor(session.cwd, folder);
      } catch (e) {
        return fail(msg, 'git-failed', e.message, folder);
      }
      if (!trust.trusted && trust.riskyKeys.length && msg.allowUnsafe !== true) {
        return fail(
          msg,
          'unsafe-config',
          `This folder is outside the session's repository and its git configuration names commands git would run while diffing it: ${trust.riskyKeys.join(', ')}`,
          folder,
          { riskyKeys: trust.riskyKeys },
        );
      }

      const key = `${msg.sessionId}|${scope}|${cacheKey(settings, folder)}`;
      let built;
      try {
        let pending = inFlight.get(key);
        if (!pending) {
          pending = buildDiff(folder, scope, settings, { untrusted: !trust.trusted })
            .finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        built = await pending;
      } catch (e) {
        return fail(msg, 'git-failed', e.message, folder);
      }
      if (!built.ok) return fail(msg, built.code, built.message, folder);

      pruneCache();
      cache.set(msg.sessionId, {
        scope, folder, key: cacheKey(settings, folder), at: Date.now(), built, bytes: built.patchBytes || 0,
      });
      reply(msg, built, layout, session, folder, rejected, trust.trusted);
    }

    api.onFrontendMessage('diff', handleDiff);

    // Layout toggle — reuse the cached patch when it still matches, otherwise re-run git.
    api.onFrontendMessage('render', async (msg) => {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      const scope = normaliseScope(msg.scope);
      const layout = normaliseLayout(msg.layout);
      const { folder } = await resolveFolder(session, msg.folder);
      const entry = cache.get(msg.sessionId);

      if (entry && entry.scope === scope && entry.key === cacheKey(api.getSettings(), folder)) {
        const trust = trustCache.get(`${session.cwd}|${folder}`);
        return reply(msg, entry.built, layout, session, folder, false, trust ? trust.verdict.trusted : undefined);
      }
      return handleDiff(msg);
    });

    api.onFrontendMessage('getPatch', (msg) => {
      const entry = cache.get(msg.sessionId);
      api.sendToFrontend('patch', {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        patch: entry ? entry.built.patch : '',
      });
    });

    api.onFrontendMessage('getStyles', () => {
      const settings = api.getSettings();
      api.sendToFrontend('styles', {
        css: diff2htmlStyles(),
        hljsCss: settings.syntaxHighlight === false || !bundleReady ? '' : highlightStyles(settings.highlightTheme),
        theme: settings.highlightTheme || 'github-dark',
        highlight: bundleReady && settings.syntaxHighlight !== false,
      });
    });

    api.onFrontendMessage('getSettings', () => {
      api.sendToFrontend('settings', api.getSettings());
    });
    api.onSettingsChange(() => {
      api.sendToFrontend('settings', api.getSettings());
    });
  },
};

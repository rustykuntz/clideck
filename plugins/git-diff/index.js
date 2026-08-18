// Git Diff — runs git in a session's working folder and renders the patch with diff2html.
// Nothing here writes to the repository: no add, no index updates, read-only commands only.
//
// This file is the wiring: it answers the client's messages, holds the caches, and puts the
// other modules in order. The work itself lives next to it — git.js runs git, untracked.js
// synthesises patches for untracked files, longlines.js caps a file with over-long lines before
// the parse, payload.js shapes the reply the panel receives, and diff2html.js parses and renders
// the patch. That last one is the only module that touches an npm package.

const { homedir } = require('os');
const { promises: fsp } = require('fs');
const { collectUntracked } = require('./untracked');
const { MAX_LINE_CHARS, capLongLines } = require('./longlines');
const { diffKey, belongsTo, makeCache } = require('./cache');
const {
  makeGit, resolveRepo, resolveBase, listWorktrees, probeFilterDrivers, diffPatch, listUntracked, numstatFiles,
} = require('./git');
const {
  MAX_PATCH_BYTES, clampContext, clampMaxChanges, untrackedFileList, parsedFileList, sumTotals,
  tooBigVerdict, shouldHighlight, normaliseScope, normaliseLayout, diffPayload, failPayload,
} = require('./payload');
const {
  parsePatch, renderHtml, installBrowserBundle, highlightStyles, diff2htmlStyles,
} = require('./diff2html');

const FOLDER_STAT_TIMEOUT = 2000;
const DRIVERS_TTL = 60 * 1000;

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
  const git = makeGit(opts.drivers);
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

    // Built diffs, keyed by diffKey(): the session, the scope, the folder and the settings that
    // shaped the patch. A layout toggle re-renders from one instead of re-running git, and Copy
    // patch reads the patch text out of the entry the panel is showing.
    const cache = makeCache({ isLive: (id) => !!api.getSession(id) });
    // Diffs already being built, so two tabs polling one session share the work rather than
    // starting a second set of git processes.
    const inFlight = new Map();
    // folder → the filter drivers its own config defines, which every git call for that folder
    // switches off by name. Cached because it costs a git call per diff and rarely changes.
    const driversCache = new Map();

    function pruneCaches() {
      cache.prune();
      const now = Date.now();
      for (const [key, entry] of driversCache) {
        if (now - entry.at > DRIVERS_TTL) driversCache.delete(key);
      }
    }

    async function driversFor(folder) {
      const hit = driversCache.get(folder);
      if (hit && Date.now() - hit.at < DRIVERS_TTL) return hit.drivers;
      const drivers = await probeFilterDrivers(folder);
      driversCache.set(folder, { at: Date.now(), drivers });
      return drivers;
    }

    function fail(msg, code, message, folder, extra = {}) {
      const session = api.getSession(msg.sessionId);
      api.sendToFrontend('diff', failPayload({
        msg, code, message, folder, sessionCwd: session?.cwd || '', home: homedir(), extra,
      }));
    }

    // patchKey names the cache entry this reply was built from. The panel sends it back with Copy
    // patch, so that reads the patch for the diff on screen. Asking by session alone would get
    // whatever was cached for the session last, which is another folder whenever a second tab is
    // open on it or two of one tab's requests are in flight.
    function reply(msg, built, layout, session, folder, folderRejected, patchKey) {
      const settings = api.getSettings();
      api.sendToFrontend('diff', diffPayload({
        msg,
        built,
        layout,
        session,
        folder,
        folderRejected,
        patchKey,
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

      let drivers;
      try {
        drivers = await driversFor(folder);
      } catch (e) {
        return fail(msg, 'git-failed', e.message, folder);
      }
      // A driver whose name cannot go into a -c key cannot be switched off, and diffing the folder
      // would run it. Nothing here can make that safe, so the diff stops.
      if (drivers.rejected.length) {
        return fail(
          msg,
          'unfilterable-config',
          `This folder's git configuration defines a filter driver whose name cannot be overridden safely, so diffing it would run the driver's command: ${drivers.rejected.join(', ')}`,
          folder,
          { drivers: drivers.rejected },
        );
      }

      const key = diffKey(msg.sessionId, scope, folder, settings);
      let built;
      try {
        let pending = inFlight.get(key);
        if (!pending) {
          pending = buildDiff(folder, scope, settings, { drivers: drivers.usable })
            .finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        built = await pending;
      } catch (e) {
        return fail(msg, 'git-failed', e.message, folder);
      }
      if (!built.ok) return fail(msg, built.code, built.message, folder);

      pruneCaches();
      cache.set(key, { sessionId: msg.sessionId, built, bytes: built.patchBytes || 0 });
      reply(msg, built, layout, session, folder, rejected, key);
    }

    api.onFrontendMessage('diff', handleDiff);

    // Layout toggle — reuse the cached patch when it still matches, otherwise re-run git.
    api.onFrontendMessage('render', async (msg) => {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      const scope = normaliseScope(msg.scope);
      const layout = normaliseLayout(msg.layout);
      const { folder } = await resolveFolder(session, msg.folder);
      // The key states the scope, the folder and the settings the entry was built under, so a hit
      // is already the right diff and a miss means something changed: re-run git.
      const key = diffKey(msg.sessionId, scope, folder, api.getSettings());
      const entry = cache.get(key);

      if (entry) return reply(msg, entry.built, layout, session, folder, false, key);
      return handleDiff(msg);
    });

    // The panel names the entry it is showing, by the patchKey its diff arrived with. A key naming
    // another session gets nothing, and an entry already dropped from the cache is reported as
    // stale, so the panel can tell the user to refresh instead of copying an empty patch.
    api.onFrontendMessage('getPatch', (msg) => {
      const entry = belongsTo(msg.patchKey, msg.sessionId) ? cache.get(msg.patchKey) : null;
      api.sendToFrontend('patch', {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: !!entry,
        code: entry ? '' : 'stale',
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

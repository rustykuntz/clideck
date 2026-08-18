// Git Diff — runs git in a session's working folder and renders the patch with diff2html.
// Nothing here writes to the repository: no add, no index updates, read-only commands only.

const { readFileSync, statSync, copyFileSync, mkdirSync, promises: fsp } = require('fs');
const { homedir } = require('os');
const { join, dirname } = require('path');
const d2h = require('diff2html');
const { collectUntracked } = require('./untracked');
const { diffArgs } = require('./safety');
const { MAX_PATCH_BYTES, MAX_CHANGES_CEILING, MAX_LINE_CHARS, capLongLines } = require('./budget');
const {
  makeGit, trustedGit, resolveRepo, resolveBase, listWorktrees, assessTrust, listUntracked, numstatFiles,
} = require('./git');
// highlight.js is not called from here: the browser does the highlighting through diff2html's
// own bundle. The package is still needed for its theme stylesheets, resolved by path below.

const HIGHLIGHT_MAX_LINES = 6000; // above this the browser is told not to highlight
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

// The untracked half of the file list for a diff too large to parse. Everything needed is
// already in the scan's records, so no second pass over the filesystem is required.
function untrackedFileList(entries) {
  return entries.map((e) => ({
    path: e.path,
    oldPath: '',
    additions: e.additions || 0,
    deletions: 0,
    isNew: true,
    isDeleted: false,
    isRename: false,
    isBinary: !!e.binary,
    isTooBig: false,
    oversizedBytes: e.oversized ? e.bytes : 0,
    longestLine: 0,
  }));
}

function sumTotals(files) {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + (f.additions || 0),
      deletions: acc.deletions + (f.deletions || 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

async function buildDiff(cwd, scope, settings, opts = {}) {
  const git = makeGit(!!opts.untrusted);
  const repo = await resolveRepo(git, cwd);
  if (!repo.ok) return repo;

  const { repoRoot, branch } = repo;
  const { base, baseLabel, baseFallback, baseIsHead, badSetting } =
    await resolveBase(git, repoRoot, scope, String(settings.baseBranch || '').trim());

  const context = Number.isFinite(settings.contextLines) ? Math.max(0, Math.min(20, settings.contextLines)) : 3;
  const tracked = await git(diffArgs(base, context), repoRoot);
  if (!tracked.ok) {
    if (tracked.timedOut) return { ok: false, code: 'timeout', message: 'git diff timed out' };
    return { ok: false, code: 'git-failed', message: tracked.message || 'git diff failed' };
  }

  const untracked = await collectUntracked(repoRoot, await listUntracked(git, repoRoot));
  const patch = tracked.stdout + untracked.patch;
  const patchBytes = Buffer.byteLength(patch);
  const maxChanges = Number.isFinite(settings.maxChanges)
    ? Math.max(100, Math.min(MAX_CHANGES_CEILING, settings.maxChanges))
    : 20000;

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
      tooBig: { reason: 'bytes', bytes: patchBytes, changes: totals.additions + totals.deletions },
    };
  }

  // A change count says nothing about line length, and cost grows with it: a minified bundle is
  // a few lines of a few hundred kilobytes each. Those files are replaced by git's own binary
  // placeholder before parsing. The patch kept for Copy patch is the real one, not this.
  const capped = capLongLines(patch);

  // diffMaxChanges is a parse-time option and applies per file, so it caps one enormous file.
  const parsed = d2h.parse(capped.patch, {
    diffMaxChanges: maxChanges,
    diffTooBigMessage: () => 'File has too many changes to display',
  });

  const oversized = untracked.oversized;
  const files = parsed.map((f) => {
    const path = f.newName && f.newName !== '/dev/null' ? f.newName : f.oldName;
    return {
      path,
      oldPath: f.isRename ? f.oldName : '',
      additions: f.addedLines || 0,
      deletions: f.deletedLines || 0,
      isNew: !!f.isNew,
      isDeleted: !!f.isDeleted,
      isRename: !!f.isRename,
      // An oversized untracked file and a file with over-long lines both render through git's
      // binary placeholder but are text. They are reported separately so the UI can say which
      // limit it was rather than calling the file binary.
      isBinary: !!f.isBinary && !oversized.has(path) && !capped.longLines.has(path),
      isTooBig: !!f.isTooBig,
      oversizedBytes: oversized.get(path) || 0,
      longestLine: capped.longLines.get(path) || 0,
    };
  });

  const totals = sumTotals(files);
  const changes = totals.additions + totals.deletions;
  // Separate whole-diff guard: diffMaxChanges never fires on a diff made of thousands of
  // small files, which is exactly the case that would lock up the browser tab.
  const tooBig = changes > maxChanges ? { reason: 'changes', bytes: patchBytes, changes } : null;

  return { ...common, parsed, totals, files, tooBig };
}

function renderHtml(built, layout, settings) {
  if (built.tooBig) return ''; // client renders its own file list instead
  const html = d2h.html(built.parsed, {
    outputFormat: layout === 'line-by-line' ? 'line-by-line' : 'side-by-side',
    drawFileList: true,
    colorScheme: 'dark',
    matching: 'words',
    renderNothingWhenEmpty: false,
  });
  return html;
}

// Highlighting itself runs in the browser, through diff2html's own diff2html-ui bundle. This
// only decides whether it is worth doing: very large diffs are left plain so the tab stays
// responsive.
function shouldHighlight(built, settings) {
  if (settings.syntaxHighlight === false) return false;
  return built.totals.additions + built.totals.deletions <= HIGHLIGHT_MAX_LINES;
}

// diff2html's browser bundle does the highlighting. Only files under the plugin's public/
// folder can be served (plugin-loader.js resolveFile), so the bundle is copied out of
// node_modules on startup. Copying beats committing a megabyte of minified third-party code,
// and beats sending it over the WebSocket, which the browser could not cache.
const VENDOR_BUNDLE = 'diff2html-ui.min.js';

function installBrowserBundle(pluginDir, log) {
  try {
    const source = require.resolve(`diff2html/bundles/js/${VENDOR_BUNDLE}`);
    const targetDir = join(pluginDir, 'public', 'vendor');
    const target = join(targetDir, VENDOR_BUNDLE);
    // Size is enough to spot a version change; the file is only ever replaced wholesale.
    let current = -1;
    try { current = statSync(target).size; } catch { /* not copied yet */ }
    const wanted = statSync(source).size;
    if (current === wanted) return true;
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(source, target);
    log(`copied ${VENDOR_BUNDLE} (${Math.round(wanted / 1024)} KB) for the browser`);
    return true;
  } catch (e) {
    log(`could not install the highlighter bundle, syntax highlighting is off: ${e.message}`);
    return false;
  }
}

// The chosen highlight.js theme, read from the installed package. Only the token colours are
// wanted, so the theme's own background is neutralised in git-diff.css.
const themeCache = new Map();
function highlightStyles(theme) {
  const name = /^[a-z0-9-]+$/.test(String(theme || '')) ? theme : 'github-dark';
  if (themeCache.has(name)) return themeCache.get(name);
  let css = '';
  for (const candidate of [name, 'github-dark']) {
    try {
      css = readFileSync(require.resolve(`highlight.js/styles/${candidate}.min.css`), 'utf8');
      break;
    } catch { /* try the fallback theme */ }
  }
  themeCache.set(name, css);
  return css;
}

let stylesCache = null;
function diff2htmlStyles() {
  if (stylesCache !== null) return stylesCache;
  try {
    // No "exports" field in diff2html's package.json, so the deep path resolves.
    stylesCache = readFileSync(require.resolve('diff2html/bundles/css/diff2html.min.css'), 'utf8');
  } catch {
    // Fall back to walking up from the module entry point.
    try {
      const pkgDir = dirname(dirname(require.resolve('diff2html')));
      stylesCache = readFileSync(join(pkgDir, 'bundles', 'css', 'diff2html.min.css'), 'utf8');
    } catch {
      stylesCache = '';
    }
  }
  return stylesCache;
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

    function cacheKey(settings, folder) {
      return `${folder}|${settings.contextLines}|${settings.maxChanges}|${settings.baseBranch || ''}`;
    }

    // Folders the client can switch between: where the session started, and every worktree of
    // the repository in view. The folder in use is always present so the selector can always
    // show it.
    function folderChoices(session, built, folder) {
      const seen = new Map();
      const add = (path, label, kind) => {
        if (!path || seen.has(path)) return;
        seen.set(path, { path, label, kind });
      };
      add(session.cwd, 'session start', 'session');
      for (const tree of built.worktrees || []) {
        add(tree.path, tree.branch || (tree.detached ? 'detached' : ''), tree.path === built.repoRoot ? 'current-worktree' : 'worktree');
      }
      add(folder, '', 'current');
      return [...seen.values()];
    }

    // Errors still carry the folder and the session's own folder, so the selector stays
    // usable — otherwise picking a folder that is not a repository would be a dead end.
    function fail(msg, code, message, folder, extra = {}) {
      const session = api.getSession(msg.sessionId);
      const choices = [];
      if (session?.cwd) choices.push({ path: session.cwd, label: 'Session folder', kind: 'session' });
      if (folder && folder !== session?.cwd) choices.push({ path: folder, label: '', kind: 'current' });
      api.sendToFrontend('diff', {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: false,
        code,
        message,
        folder: folder || session?.cwd || '',
        folders: choices,
        home: homedir(),
        ...extra,
      });
    }

    function reply(msg, built, layout, session, folder, folderRejected, trusted) {
      api.sendToFrontend('diff', {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        sessionName: session.name,
        cwd: session.cwd,
        folder,
        folderRejected: !!folderRejected,
        folderTrusted: trusted !== false,
        folders: folderChoices(session, built, folder),
        home: homedir(),
        repoRoot: built.repoRoot,
        branch: built.branch,
        scope: msg.scope === 'base' ? 'base' : 'uncommitted',
        layout,
        baseLabel: built.baseLabel,
        baseFallback: built.baseFallback,
        baseIsHead: built.baseIsHead,
        baseBranchInvalid: !!built.baseBranchInvalid,
        totals: built.totals,
        files: built.files,
        skippedEntries: built.skippedEntries || [],
        untrackedTruncated: built.untrackedTruncated || null,
        tooBig: built.tooBig || null,
        patchBytes: built.patchBytes || 0,
        maxChanges: built.maxChanges,
        maxLineChars: MAX_LINE_CHARS,
        highlight: bundleReady && shouldHighlight(built, api.getSettings()),
        html: renderHtml(built, layout, api.getSettings()),
      });
    }

    // Every request gets an answer. A tab that is left waiting stops polling, since its own
    // request is still outstanding as far as it knows, so replies are never suppressed for
    // being out of date: the client drops the ones whose requestId is not its own.
    async function handleDiff(msg) {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      const settings = api.getSettings();
      const scope = msg.scope === 'base' ? 'base' : 'uncommitted';
      const layout = msg.layout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
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

      const scope = msg.scope === 'base' ? 'base' : 'uncommitted';
      const layout = msg.layout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
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

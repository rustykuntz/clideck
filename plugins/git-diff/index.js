// Git Diff — runs git in a session's working folder and renders the patch with diff2html.
// Nothing here writes to the repository: no add, no index updates, read-only commands only.

const { execFile } = require('child_process');
const { readFileSync, statSync, copyFileSync, mkdirSync } = require('fs');
const { homedir } = require('os');
const { join, dirname } = require('path');
const d2h = require('diff2html');
// highlight.js is not called from here: the browser does the highlighting through diff2html's
// own bundle. The package is still needed for its theme stylesheets, resolved by path below.

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_TIMEOUT = 15000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 512 * 1024; // larger untracked files are listed, not rendered
const BINARY_SNIFF_BYTES = 8000;
const HIGHLIGHT_MAX_LINES = 6000; // above this the browser is told not to highlight
const CACHE_MAX = 20;
const CACHE_TTL = 5 * 60 * 1000;

// GIT_OPTIONAL_LOCKS=0 stops `git diff` taking index.lock to refresh the index stat cache.
// Without it, polling a folder where an agent is also running git can collide on that lock.
// GIT_TERMINAL_PROMPT=0 stops git ever blocking on a credential prompt.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

// Run git and never throw — callers branch on ok.
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: GIT_ENV, timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const out = (stdout || Buffer.alloc(0)).toString('utf8');
      const errOut = (stderr || Buffer.alloc(0)).toString('utf8');
      if (!err) return resolve({ ok: true, stdout: out, stderr: errOut });
      resolve({
        ok: false,
        stdout: out,
        stderr: errOut,
        missing: err.code === 'ENOENT',
        timedOut: !!err.killed,
        message: errOut.trim() || err.message,
      });
    });
  });
}

async function resolveRepo(cwd) {
  const top = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) {
    if (top.missing) return { ok: false, code: 'no-git', message: 'git was not found on PATH' };
    if (top.timedOut) return { ok: false, code: 'timeout', message: 'git rev-parse timed out' };
    return { ok: false, code: 'not-a-repo', message: `Not a git repository: ${cwd}` };
  }
  const repoRoot = top.stdout.trim();
  if (!repoRoot) return { ok: false, code: 'not-a-repo', message: `Not a git repository: ${cwd}` };

  const named = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  let branch = named.ok ? named.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    const short = await runGit(['rev-parse', '--short', 'HEAD'], repoRoot);
    branch = short.ok && short.stdout.trim() ? `detached at ${short.stdout.trim()}` : 'no commits yet';
  }
  return { ok: true, repoRoot, branch };
}

async function hasCommits(repoRoot) {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
  return head.ok && !!head.stdout.trim();
}

// Which commit the diff is taken against, and what to call it in the header.
async function resolveBase(repoRoot, scope, baseBranchSetting) {
  const committed = await hasCommits(repoRoot);
  const localBase = committed ? 'HEAD' : EMPTY_TREE;
  const localLabel = committed ? 'HEAD' : 'empty repo';

  if (scope !== 'base') return { base: localBase, baseLabel: localLabel, baseFallback: false };
  if (!committed) return { base: localBase, baseLabel: localLabel, baseFallback: true };

  const candidates = [];
  if (baseBranchSetting) {
    candidates.push(baseBranchSetting);
  } else {
    const originHead = await runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
    if (originHead.ok && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
    candidates.push('origin/main', 'origin/master', 'main', 'master');
  }

  const head = await runGit(['rev-parse', 'HEAD'], repoRoot);
  const headSha = head.ok ? head.stdout.trim() : '';

  for (const candidate of candidates) {
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], repoRoot);
    if (!exists.ok || !exists.stdout.trim()) continue;
    const mergeBase = await runGit(['merge-base', 'HEAD', candidate], repoRoot);
    if (!mergeBase.ok || !mergeBase.stdout.trim()) continue;
    const base = mergeBase.stdout.trim();
    // On the base branch itself the merge base is HEAD, so this scope shows nothing extra.
    return { base, baseLabel: candidate, baseFallback: false, baseIsHead: base === headSha };
  }
  // Nothing to compare against — show uncommitted work instead and say so.
  return { base: localBase, baseLabel: localLabel, baseFallback: true };
}

// Every worktree attached to this repository, main checkout included. A session started in
// the main checkout can therefore offer its worktrees as targets, which is the common case
// when an agent works on a branch in a worktree.
async function listWorktrees(repoRoot) {
  const listed = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  if (!listed.ok) return [];
  const trees = [];
  let current = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9).trim(), branch: '', detached: false, bare: false };
      trees.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  return trees.filter((t) => t.path && !t.bare);
}

// The folder to diff. An explicit client choice wins, as long as it is a directory. Otherwise
// use where the session was spawned. UPSTREAM.md proposes exposing the session's process id so
// a plugin could follow the shell's real working directory instead.
function resolveFolder(session, requested) {
  if (typeof requested === 'string' && requested) {
    try {
      if (statSync(requested).isDirectory()) return { folder: requested, rejected: false };
    } catch { /* fall through below */ }
    return { folder: session.cwd, rejected: true };
  }
  return { folder: session.cwd, rejected: false };
}

function isBinaryBuffer(buf) {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

// Build an added-file patch for an untracked file. Synthesising avoids `git diff --no-index
// /dev/null` (no such path on Windows) and `git add -N` (which would touch the index).
// Returns { patch, oversized } so the caller can tell "too large to show" apart from "binary".
function synthesiseAddedFile(repoRoot, relPath) {
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n`;
  const placeholder = `${header}Binary files /dev/null and b/${relPath} differ\n`;

  let buf;
  try {
    buf = readFileSync(join(repoRoot, relPath));
  } catch {
    return null; // vanished or unreadable between listing and reading
  }
  if (buf.length > MAX_UNTRACKED_BYTES) return { patch: placeholder, oversized: true, bytes: buf.length };
  if (isBinaryBuffer(buf)) return { patch: placeholder, oversized: false, bytes: buf.length };
  if (buf.length === 0) return { patch: header, oversized: false, bytes: 0 }; // new but empty, no hunk

  const text = buf.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const body = lines.map((l) => `+${l}`).join('\n');
  const noNewline = endsWithNewline ? '' : '\n\\ No newline at end of file';
  return {
    patch: `${header}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}\n`,
    oversized: false,
    bytes: buf.length,
  };
}

async function untrackedPatch(repoRoot) {
  const listed = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
  if (!listed.ok) return { patch: '', oversized: new Map() };
  const paths = listed.stdout.split('\0').filter(Boolean).sort();
  const parts = [];
  const oversized = new Map(); // path → byte size, for files we listed but did not render
  for (const relPath of paths) {
    const result = synthesiseAddedFile(repoRoot, relPath);
    if (!result) continue;
    parts.push(result.patch);
    if (result.oversized) oversized.set(relPath, result.bytes);
  }
  return { patch: parts.join(''), oversized };
}

async function buildDiff(cwd, scope, settings) {
  const repo = await resolveRepo(cwd);
  if (!repo.ok) return repo;

  const { repoRoot, branch } = repo;
  const { base, baseLabel, baseFallback, baseIsHead } = await resolveBase(repoRoot, scope, String(settings.baseBranch || '').trim());

  const context = Number.isFinite(settings.contextLines) ? Math.max(0, Math.min(20, settings.contextLines)) : 3;
  const tracked = await runGit(
    ['-c', 'core.quotepath=false', 'diff', '--no-color', '--find-renames', `-U${context}`, base],
    repoRoot,
  );
  if (!tracked.ok) {
    if (tracked.timedOut) return { ok: false, code: 'timeout', message: 'git diff timed out' };
    return { ok: false, code: 'git-failed', message: tracked.message || 'git diff failed' };
  }

  const untracked = await untrackedPatch(repoRoot);
  const patch = tracked.stdout + untracked.patch;
  const maxChanges = Number.isFinite(settings.maxChanges) ? Math.max(100, settings.maxChanges) : 20000;
  // diffMaxChanges is a parse-time option and applies per file, so it caps one enormous file.
  const parsed = d2h.parse(patch, {
    diffMaxChanges: maxChanges,
    diffTooBigMessage: () => 'File has too many changes to display',
  });

  const totals = parsed.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + (f.addedLines || 0),
      deletions: acc.deletions + (f.deletedLines || 0),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );

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
      // An oversized untracked file uses git's binary placeholder to render, but it is text —
      // report it separately so the UI does not call it binary.
      isBinary: !!f.isBinary && !untracked.oversized.has(path),
      isTooBig: !!f.isTooBig,
      oversizedBytes: untracked.oversized.get(path) || 0,
    };
  });

  // Separate whole-diff guard: diffMaxChanges never fires on a diff made of thousands of
  // small files, which is exactly the case that would lock up the browser tab.
  const tooBig = totals.additions + totals.deletions > maxChanges;

  const worktrees = await listWorktrees(repoRoot);

  return {
    ok: true, repoRoot, branch, base, baseLabel, baseFallback, baseIsHead: !!baseIsHead,
    patch, parsed, totals, files, tooBig, maxChanges, worktrees,
  };
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
    // sessionId → newest requestId, so a superseded poll's reply is dropped.
    const newest = new Map();

    function pruneCache() {
      const now = Date.now();
      for (const [id, entry] of cache) {
        if (now - entry.at > CACHE_TTL || !api.getSession(id)) cache.delete(id);
      }
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      for (const id of newest.keys()) {
        if (!api.getSession(id)) newest.delete(id);
      }
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
    function fail(msg, code, message, folder) {
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
      });
    }

    function reply(msg, built, layout, session, folder, folderRejected) {
      api.sendToFrontend('diff', {
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        ok: true,
        sessionName: session.name,
        cwd: session.cwd,
        folder,
        folderRejected: !!folderRejected,
        folders: folderChoices(session, built, folder),
        home: homedir(),
        repoRoot: built.repoRoot,
        branch: built.branch,
        scope: msg.scope === 'base' ? 'base' : 'uncommitted',
        layout,
        baseLabel: built.baseLabel,
        baseFallback: built.baseFallback,
        baseIsHead: built.baseIsHead,
        totals: built.totals,
        files: built.files,
        tooBig: built.tooBig,
        maxChanges: built.maxChanges,
        highlight: bundleReady && shouldHighlight(built, api.getSettings()),
        html: renderHtml(built, layout, api.getSettings()),
      });
    }

    async function handleDiff(msg) {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      newest.set(msg.sessionId, msg.requestId);
      const settings = api.getSettings();
      const scope = msg.scope === 'base' ? 'base' : 'uncommitted';
      const layout = msg.layout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
      const { folder, rejected } = resolveFolder(session, msg.folder);

      let built;
      try {
        built = await buildDiff(folder, scope, settings);
      } catch (e) {
        return fail(msg, 'git-failed', e.message);
      }
      if (newest.get(msg.sessionId) !== msg.requestId) return; // a newer request already went out
      if (!built.ok) return fail(msg, built.code, built.message, folder);

      pruneCache();
      cache.set(msg.sessionId, { scope, folder, key: cacheKey(settings, folder), at: Date.now(), built });
      reply(msg, built, layout, session, folder, rejected);
    }

    api.onFrontendMessage('diff', handleDiff);

    // Layout toggle — reuse the cached patch when it still matches, otherwise re-run git.
    api.onFrontendMessage('render', async (msg) => {
      const session = api.getSession(msg.sessionId);
      if (!session || !session.cwd) return fail(msg, 'no-session', 'Session is no longer running');

      const scope = msg.scope === 'base' ? 'base' : 'uncommitted';
      const layout = msg.layout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
      const { folder } = resolveFolder(session, msg.folder);
      const entry = cache.get(msg.sessionId);

      if (entry && entry.scope === scope && entry.key === cacheKey(api.getSettings(), folder)) {
        newest.set(msg.sessionId, msg.requestId);
        return reply(msg, entry.built, layout, session, folder, false);
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

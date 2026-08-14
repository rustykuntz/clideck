// Git Diff — runs git in a session's working folder and renders the patch with diff2html.
// Nothing here writes to the repository: no add, no index updates, read-only commands only.

const { execFile } = require('child_process');
const { readFileSync, statSync, readlinkSync } = require('fs');
const { homedir } = require('os');
const { join, dirname } = require('path');
const d2h = require('diff2html');
const hljs = require('highlight.js');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_TIMEOUT = 15000;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_UNTRACKED_BYTES = 512 * 1024; // larger untracked files are listed, not rendered
const BINARY_SNIFF_BYTES = 8000;
const HIGHLIGHT_MAX_LINES = 6000;      // above this, skip highlighting to keep the tab responsive
const HIGHLIGHT_MAX_LINE_CHARS = 2000; // minified or generated lines are not worth colouring
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

// --- live working directory of a session's process (Linux) ---
//
// api.getSession() reports where a session was spawned, not where its shell or agent has since
// moved, so a session whose agent has cd'd into a worktree still reports the original folder.
// Reading /proc/<pid>/cwd answers that, but it needs the session's process id.
//
// CliDeck does not currently include a pid in the projection from api.getSession(), so this
// stays inert and the folder falls back to where the session was spawned. The folder selector
// still lists the session folder and every worktree of the repository, so the common case is
// covered either way.
//
// A pid can be dug out of core's internals from here, by finding the already-loaded
// sessions.js in require.cache and reading pty.pid off the live session map. That is
// deliberately not done: it bypasses the projection the plugin API exists to provide, hands
// over the whole pty object rather than one field, and would break silently on any rename or
// refactor. UPSTREAM.md proposes the two-line addition to plugin-loader.js instead. When that
// lands, this starts working with no change here.

const LIVE_CWD_SUPPORTED = process.platform === 'linux';

function ptyPid(session) {
  return session && Number.isInteger(session.pid) && session.pid > 0 ? session.pid : 0;
}

function procCwd(pid) {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return ''; }
}

function procName(pid) {
  try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return ''; }
}

// Where the session's own command is sitting right now. Only that process is inspected, not
// anything it launched.
function liveFolders(session) {
  if (!LIVE_CWD_SUPPORTED) return [];
  const pid = ptyPid(session);
  if (!pid) return [];
  const cwd = procCwd(pid);
  return cwd ? [{ path: cwd, process: procName(pid) || `pid ${pid}` }] : [];
}

// The folder to diff. An explicit client choice wins. Otherwise prefer where the session's
// processes actually are, falling back to where it was spawned.
function resolveFolder(session, requested) {
  if (typeof requested === 'string' && requested) {
    try {
      if (statSync(requested).isDirectory()) return { folder: requested, rejected: false };
    } catch { /* fall through below */ }
    return { folder: defaultFolder(session), rejected: true };
  }
  return { folder: defaultFolder(session), rejected: false };
}

// Prefer where the session's command actually is. It only wins over the spawn folder when it
// is inside a repository, so a session sitting somewhere unrelated does not open on an error.
function defaultFolder(session) {
  const live = liveFolders(session)[0];
  if (!live || live.path === session.cwd) return session.cwd;
  if (looksLikeRepo(live.path)) return live.path;
  return looksLikeRepo(session.cwd) ? session.cwd : live.path;
}

function looksLikeRepo(dir) {
  let current = dir;
  for (let i = 0; i < 40; i++) {
    try {
      if (statSync(join(current, '.git')) ) return true;
    } catch { /* keep walking up */ }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
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
  const changed = built.totals.additions + built.totals.deletions;
  if (settings.syntaxHighlight === false || changed > HIGHLIGHT_MAX_LINES) return html;
  return highlightHtml(html);
}

// --- syntax highlighting ---
//
// diff2html only highlights in the browser, through its diff2html-ui bundle, which pulls in a
// megabyte of highlight.js. Since rendering already happens here, highlighting happens here
// too and the browser receives finished markup plus a small theme stylesheet.
//
// The wrinkle is word-level diffing: each rendered line already contains <ins> and <del> from
// diff2html, and highlight.js wants plain text. diff2html-ui reconciles the two by walking DOM
// node streams, which needs a document. Instead the two are merged by character offset below.

// diff2html puts the file extension in data-lang. highlight.js accepts extensions directly as
// language aliases, so no mapping table is needed. Aliases are then resolved to canonical ids
// so the emitted class is "javascript" whether the file was .js, .mjs or .cjs. Built once by
// matching each registered language object against the alias, since highlight.js exposes no
// alias-to-id call.
const PLAINTEXT = hljs.getLanguage('plaintext');
const CANONICAL_LANGUAGE = new Map();
for (const id of hljs.listLanguages()) CANONICAL_LANGUAGE.set(hljs.getLanguage(id), id);

// Returns the canonical language id, or '' when there is nothing worth colouring, which covers
// both unknown extensions and ones that resolve to plain text.
function languageFor(extension) {
  if (!extension) return '';
  const language = hljs.getLanguage(extension);
  if (!language || language === PLAINTEXT) return '';
  return CANONICAL_LANGUAGE.get(language) || extension;
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return whole;
      try { return String.fromCodePoint(value); } catch { return whole; }
    }
    return NAMED_ENTITIES[code] ?? whole;
  });
}

function escapeChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  return ch;
}

// A rendered line into plain characters plus which of them diff2html marked as inserted or
// deleted. Returns null for anything other than ins/del markup, so unexpected input is left
// untouched rather than mangled.
function splitLineMarks(inner) {
  const chars = [];
  const marks = [];
  let mark = '';
  let index = 0;
  const token = /<(\/?)(ins|del)>|([^<]+)/g;
  let match;
  while ((match = token.exec(inner)) !== null) {
    if (match.index !== index) return null; // skipped over markup we do not understand
    index = token.lastIndex;
    if (match[2]) { mark = match[1] ? '' : match[2]; continue; }
    for (const ch of decodeEntities(match[3])) { chars.push(ch); marks.push(mark); }
  }
  return index === inner.length ? { chars, marks } : null;
}

// highlight.js output into the same shape: one class stack per character.
function splitHighlighted(html) {
  const chars = [];
  const stacks = [];
  const stack = [];
  let index = 0;
  const token = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let match;
  while ((match = token.exec(html)) !== null) {
    if (match.index !== index) return null;
    index = token.lastIndex;
    if (match[1] !== undefined) { stack.push(match[1]); continue; }
    if (match[2] === undefined) { stack.pop(); continue; }
    for (const ch of decodeEntities(match[2])) { chars.push(ch); stacks.push(stack.slice()); }
  }
  return index === html.length ? { chars, stacks } : null;
}

function sameStack(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Re-emit the line with the ins/del mark on the outside and highlight spans nested inside.
//
// The nesting order matters. Where a marked range and a token overlap only partially, one of
// the two has to be split, and diff2html styles ins/del with a border radius and
// inline-block, so splitting a mark shows up as two rounded boxes with a seam mid-word.
// Highlight spans carry only a colour, so splitting those is invisible. Marks therefore stay
// whole and spans are closed and reopened around them.
function weave(chars, stacks, marks) {
  let out = '';
  let openStack = [];
  let openMark = '';
  for (let i = 0; i < chars.length; i++) {
    const stack = stacks[i];
    const mark = marks[i];
    if (mark !== openMark) {
      out += '</span>'.repeat(openStack.length);
      if (openMark) out += `</${openMark}>`;
      openStack = [];
      openMark = mark;
      if (mark) out += `<${mark}>`;
    }
    if (!sameStack(stack, openStack)) {
      out += '</span>'.repeat(openStack.length);
      for (const cls of stack) out += `<span class="${cls}">`;
      openStack = stack;
    }
    out += escapeChar(chars[i]);
  }
  out += '</span>'.repeat(openStack.length);
  if (openMark) out += `</${openMark}>`;
  return out;
}

function highlightLine(inner, language) {
  const split = splitLineMarks(inner);
  if (!split || !split.chars.length || split.chars.length > HIGHLIGHT_MAX_LINE_CHARS) return null;
  let result;
  try {
    result = hljs.highlight(split.chars.join(''), { language, ignoreIllegals: true });
  } catch { return null; }
  const highlighted = splitHighlighted(result.value);
  // Bail unless the highlighter returned exactly the same characters back.
  if (!highlighted || highlighted.chars.length !== split.chars.length) return null;
  return weave(highlighted.chars, highlighted.stacks, split.marks);
}

function highlightHtml(html) {
  let language = '';
  return html.replace(
    /data-lang="([^"]*)"|<span class="d2h-code-line-ctn">([\s\S]*?)<\/span>/g,
    (whole, dataLang, inner) => {
      if (dataLang !== undefined) { language = languageFor(dataLang); return whole; }
      if (!language) return whole; // unknown or plain text, nothing to colour
      const woven = highlightLine(inner, language);
      return woven === null ? whole : `<span class="d2h-code-line-ctn hljs ${language}">${woven}</span>`;
    },
  );
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

    // Folders the client can switch between: wherever the session's processes currently are,
    // where the session started, and every worktree of the repository in view. The folder in
    // use is always present so the selector can always show it.
    function folderChoices(session, built, folder) {
      const seen = new Map();
      const add = (path, label, kind) => {
        if (!path || seen.has(path)) return;
        seen.set(path, { path, label, kind });
      };
      for (const live of liveFolders(session)) add(live.path, live.process, 'live');
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
        hljsCss: settings.syntaxHighlight === false ? '' : highlightStyles(settings.highlightTheme),
        theme: settings.highlightTheme || 'github-dark',
        highlight: settings.syntaxHighlight !== false,
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

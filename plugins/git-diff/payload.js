// The reply the panel receives, built from a diff that index.js has already assembled: the file
// records, the totals, which limit a diff fell foul of, the folders it can be pointed at, and the
// two payloads themselves. Kept apart from index.js so this layer can be checked without running
// git or rendering anything.
//
// Everything here is a plain function over plain data. Nothing runs a subprocess, touches the
// filesystem or calls the plugin api, and there are no npm dependencies, so the tests drive all
// of it in a checkout where the plugin has not been installed.

const MAX_PATCH_BYTES = 8 * 1024 * 1024;  // above this the patch is never parsed at all
const HIGHLIGHT_MAX_LINES = 6000;         // above this the browser is told not to highlight
const MAX_CHANGES_CEILING = 200000;       // hard ceiling on the maxChanges setting

// Both settings reach code that has to hold: the context count goes into git's argv, and the
// change limit bounds what the browser is asked to lay out. A missing or nonsense value takes
// the default rather than the nearest bound, since an empty setting is not a request for zero.
function clampContext(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 3;
}

function clampMaxChanges(value) {
  return Number.isFinite(value) ? Math.max(100, Math.min(MAX_CHANGES_CEILING, value)) : 20000;
}

// The untracked half of the file list for a diff too large to parse. Everything needed is
// already in the scan's records, so no second pass over the filesystem is required.
function untrackedFileList(entries) {
  return (entries || []).map((e) => ({
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

// The files of a parsed patch, in the record shape parseNumstat also returns, so the panel reads
// one shape whether the list came from a parse or from numstat.
function parsedFileList(parsed, { oversized = new Map(), longLines = new Map() } = {}) {
  return (parsed || []).map((f) => {
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
      isBinary: !!f.isBinary && !oversized.has(path) && !longLines.has(path),
      isTooBig: !!f.isTooBig,
      oversizedBytes: oversized.get(path) || 0,
      longestLine: longLines.get(path) || 0,
    };
  });
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

// Which limit, if either, the diff is past. Bytes first, because that check happens before the
// patch is parsed at all: over that limit the change count comes from numstat instead. The
// change count is a separate guard because diffMaxChanges is a per-file parse option and never
// fires on a diff made of thousands of small files, which is exactly the case that would lock up
// the browser tab.
function tooBigVerdict({ patchBytes, changes, maxChanges, maxPatchBytes }) {
  if (patchBytes > maxPatchBytes) return { reason: 'bytes', bytes: patchBytes, changes };
  if (changes > maxChanges) return { reason: 'changes', bytes: patchBytes, changes };
  return null;
}

// Highlighting itself runs in the browser, through diff2html's own diff2html-ui bundle. This
// only decides whether it is worth doing: very large diffs are left plain so the tab stays
// responsive.
function shouldHighlight(totals, settings) {
  if (settings.syntaxHighlight === false) return false;
  return totals.additions + totals.deletions <= HIGHLIGHT_MAX_LINES;
}

// Folders the client can switch between: where the session started, and every worktree of the
// repository in view. The folder in use is always present so the selector can always show it.
function folderChoices(sessionCwd, worktrees, repoRoot, folder) {
  const seen = new Map();
  const add = (path, label, kind) => {
    if (!path || seen.has(path)) return;
    seen.set(path, { path, label, kind });
  };
  add(sessionCwd, 'session start', 'session');
  for (const tree of worktrees || []) {
    add(tree.path, tree.branch || (tree.detached ? 'detached' : ''), tree.path === repoRoot ? 'current-worktree' : 'worktree');
  }
  add(folder, '', 'current');
  return [...seen.values()];
}

// The client sends both of these back with every request, so an unknown value is treated as the
// default rather than passed on.
function normaliseScope(scope) {
  return scope === 'base' ? 'base' : 'uncommitted';
}

function normaliseLayout(layout) {
  return layout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
}

function diffPayload({ msg, built, layout, session, folder, folderRejected, trusted, highlight, html, home, maxLineChars, patchKey }) {
  return {
    requestId: msg.requestId,
    sessionId: msg.sessionId,
    ok: true,
    // Names the cache entry this reply was built from, for the panel to quote back with Copy patch.
    patchKey,
    sessionName: session.name,
    cwd: session.cwd,
    folder,
    folderRejected: !!folderRejected,
    folderTrusted: trusted !== false,
    folders: folderChoices(session.cwd, built.worktrees, built.repoRoot, folder),
    home,
    repoRoot: built.repoRoot,
    branch: built.branch,
    scope: normaliseScope(msg.scope),
    layout: normaliseLayout(layout),
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
    maxLineChars,
    highlight: !!highlight,
    html: html || '',
  };
}

// A failure still carries the folder and the session's own folder, so the selector stays
// usable — otherwise picking a folder that is not a repository would be a dead end.
function failPayload({ msg, code, message, folder, sessionCwd, home, extra = {} }) {
  const choices = [];
  if (sessionCwd) choices.push({ path: sessionCwd, label: 'Session folder', kind: 'session' });
  if (folder && folder !== sessionCwd) choices.push({ path: folder, label: '', kind: 'current' });
  return {
    requestId: msg.requestId,
    sessionId: msg.sessionId,
    ok: false,
    code,
    message,
    folder: folder || sessionCwd || '',
    folders: choices,
    home,
    ...extra,
  };
}

module.exports = {
  MAX_PATCH_BYTES,
  HIGHLIGHT_MAX_LINES,
  MAX_CHANGES_CEILING,
  clampContext,
  clampMaxChanges,
  untrackedFileList,
  parsedFileList,
  sumTotals,
  tooBigVerdict,
  shouldHighlight,
  folderChoices,
  normaliseScope,
  normaliseLayout,
  diffPayload,
  failPayload,
};

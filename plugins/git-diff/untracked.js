// Untracked files have no blob in the index, so `git diff` never mentions them. This module
// builds an added-file patch for each one instead. Synthesising avoids `git diff --no-index
// /dev/null` (no such path on Windows) and `git add -N` (which would touch the index).
//
// Nothing here reads a path that is not a regular file, and nothing follows a symlink: an
// untracked link pointing at ~/.ssh/id_rsa must never end up rendered as patch content, and
// opening a fifo or device node would block the single node process the whole server runs in.
//
// Kept out of index.js so the tests can drive it without the plugin's npm dependencies.

const { lstatSync, readlinkSync, openSync, closeSync, fstatSync, readFileSync, constants } = require('fs');
const { join } = require('path');

const MAX_UNTRACKED_BYTES = 512 * 1024; // larger untracked files are listed, not rendered
const BINARY_SNIFF_BYTES = 8000;

function isBinaryBuffer(buf) {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

// What to call a path we refuse to read, for the note in the UI.
function describeKind(st) {
  if (st.isDirectory()) return 'directory';
  if (st.isFIFO()) return 'fifo';
  if (st.isSocket()) return 'socket';
  if (st.isCharacterDevice()) return 'character device';
  if (st.isBlockDevice()) return 'block device';
  return 'unknown';
}

// O_NOFOLLOW closes the window between the lstat and this open, where the path could be
// replaced by a symlink and we would read whatever it points at. O_NONBLOCK makes opening a
// fifo return immediately instead of waiting for a writer. Neither constant exists on Windows,
// so there the lstat is the only guard.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

// Reads through a descriptor so the type and size checks apply to the file actually opened,
// not to whatever the path pointed at a moment earlier.
function readRegularFile(abs) {
  let fd;
  try {
    fd = openSync(abs, OPEN_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: describeKind(st) };
    if (st.size > MAX_UNTRACKED_BYTES) return { oversizedBytes: st.size };
    return { buf: readFileSync(fd) };
  } catch {
    return null; // vanished, unreadable, or swapped for a symlink since the lstat
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing left to do */ } }
  }
}

// Returns one of:
//   null                        — vanished or unreadable between listing and reading
//   { patch, oversized, bytes } — rendered, or a placeholder for binary and oversized files
//   { skipped: true, kind }     — not a regular file, so never read
function synthesiseAddedFile(repoRoot, relPath) {
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n`;
  const placeholder = `${header}Binary files /dev/null and b/${relPath} differ\n`;

  // A newline in the name would end the header line early and let the rest of the name be read
  // as patch syntax, so such a file is listed rather than rendered.
  if (/[\r\n]/.test(relPath)) return { skipped: true, kind: 'newline in name' };

  const abs = join(repoRoot, relPath);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }

  // A symlink is shown the way git shows it once added: mode 120000, with the link target as
  // the content. readlinkSync never opens the target, so a link out of the repository cannot
  // leak the file it points at.
  if (st.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(abs);
    } catch {
      return null;
    }
    const linkHeader = `diff --git a/${relPath} b/${relPath}\nnew file mode 120000\n`;
    const bytes = Buffer.byteLength(target);
    if (/[\r\n]/.test(target)) {
      return { patch: `${linkHeader}Binary files /dev/null and b/${relPath} differ\n`, oversized: false, bytes };
    }
    return {
      patch: `${linkHeader}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`,
      oversized: false,
      bytes,
    };
  }

  if (!st.isFile()) return { skipped: true, kind: describeKind(st) };
  // Checked from the stat, so an enormous file is never pulled into memory to be rejected.
  if (st.size > MAX_UNTRACKED_BYTES) return { patch: placeholder, oversized: true, bytes: st.size };

  const read = readRegularFile(abs);
  if (!read) return null;
  if (read.kind) return { skipped: true, kind: read.kind };
  if (read.oversizedBytes) return { patch: placeholder, oversized: true, bytes: read.oversizedBytes };

  const buf = read.buf;
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

// One patch for the whole untracked list, plus what was left out and why:
//   oversized: path → byte size, listed but not rendered
//   skipped:   path → kind, never read
function collectUntracked(repoRoot, paths) {
  const parts = [];
  const oversized = new Map();
  const skipped = new Map();
  for (const relPath of paths) {
    const result = synthesiseAddedFile(repoRoot, relPath);
    if (!result) continue;
    if (result.skipped) {
      skipped.set(relPath, result.kind);
      continue;
    }
    parts.push(result.patch);
    if (result.oversized) oversized.set(relPath, result.bytes);
  }
  return { patch: parts.join(''), oversized, skipped };
}

module.exports = { synthesiseAddedFile, collectUntracked, MAX_UNTRACKED_BYTES };

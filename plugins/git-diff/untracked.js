// Untracked files have no blob in the index, so `git diff` never mentions them. This module
// builds an added-file patch for each one instead. Synthesising avoids `git diff --no-index
// /dev/null` (no such path on Windows) and `git add -N` (which would touch the index).
//
// Nothing here reads a path that is not a regular file, and nothing follows a symlink: an
// untracked link pointing at ~/.ssh/id_rsa must never end up rendered as patch content, and
// opening a fifo or device node would block the process the whole server runs in.
//
// The work is bounded and asynchronous. Bounded because an unignored node_modules can put a
// hundred thousand paths on the list, and asynchronous because a slow or dead mount would
// otherwise freeze the event loop for as long as the filesystem takes to answer.
//
// Kept out of index.js so the tests can drive it without the plugin's npm dependencies.

const { promises: fsp, constants } = require('fs');
const { join } = require('path');

const MAX_UNTRACKED_BYTES = 512 * 1024;              // per file: larger ones are listed, not read
const MAX_UNTRACKED_FILES = 2000;                    // paths classified per scan
const MAX_UNTRACKED_TOTAL_BYTES = 8 * 1024 * 1024;   // bytes read per scan
const SCAN_CONCURRENCY = 8;
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

// Reads through a handle so the type and size checks apply to the file actually opened, not to
// whatever the path pointed at a moment earlier.
async function readRegularFile(abs) {
  let handle;
  try {
    handle = await fsp.open(abs, OPEN_FLAGS);
    const st = await handle.stat();
    if (!st.isFile()) return { kind: describeKind(st) };
    if (st.size > MAX_UNTRACKED_BYTES) return { oversizedBytes: st.size };
    return { buf: await handle.readFile() };
  } catch {
    return null; // vanished, unreadable, or swapped for a symlink since the lstat
  } finally {
    if (handle) { try { await handle.close(); } catch { /* nothing left to do */ } }
  }
}

// First pass over a path: decide what it is, and how many bytes reading it would cost. Nothing
// is read here, so this stays cheap enough to run over the whole list.
//
// Returns one of:
//   null                            — vanished or unreadable, or a name we will not render
//   { type: 'symlink', target }
//   { type: 'regular', size }
//   { type: 'skipped', kind }
async function classifyPath(repoRoot, relPath) {
  // A newline in the name would end the diff header line early and let the rest of the name be
  // read as patch syntax, so such a file is listed rather than rendered.
  if (/[\r\n]/.test(relPath)) return { type: 'skipped', kind: 'newline in name' };

  const abs = join(repoRoot, relPath);
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return null;
  }

  // readlink never opens the target, so a link out of the repository cannot leak the file it
  // points at.
  if (st.isSymbolicLink()) {
    try {
      return { type: 'symlink', target: await fsp.readlink(abs) };
    } catch {
      return null;
    }
  }
  if (!st.isFile()) return { type: 'skipped', kind: describeKind(st) };
  return { type: 'regular', size: st.size };
}

function headerFor(relPath, mode) {
  return `diff --git a/${relPath} b/${relPath}\nnew file mode ${mode}\n`;
}

// A symlink is shown the way git shows it once added: mode 120000, with the link target as the
// content and git's no-newline marker, since a target has no trailing newline.
function symlinkPatch(relPath, target) {
  const header = headerFor(relPath, '120000');
  if (/[\r\n]/.test(target)) return `${header}Binary files /dev/null and b/${relPath} differ\n`;
  return `${header}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`;
}

// Second pass for a regular file that fits the budget. The size checks run again against the
// open handle, so a file that grew since it was classified is still caught.
async function regularFileResult(repoRoot, relPath) {
  const header = headerFor(relPath, '100644');
  const placeholder = `${header}Binary files /dev/null and b/${relPath} differ\n`;

  const read = await readRegularFile(join(repoRoot, relPath));
  if (!read) return null;
  if (read.kind) return { skipped: true, kind: read.kind };
  if (read.oversizedBytes) return { patch: placeholder, oversized: true, bytes: read.oversizedBytes, additions: 0 };

  const buf = read.buf;
  if (isBinaryBuffer(buf)) return { patch: placeholder, oversized: false, binary: true, bytes: buf.length, additions: 0 };
  if (buf.length === 0) return { patch: header, oversized: false, bytes: 0, additions: 0 }; // new but empty, no hunk

  const text = buf.toString('utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const body = lines.map((l) => `+${l}`).join('\n');
  const noNewline = endsWithNewline ? '' : '\n\\ No newline at end of file';
  return {
    patch: `${header}--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}\n`,
    oversized: false,
    bytes: buf.length,
    additions: lines.length,
  };
}

// One path, classified and rendered. Kept exported because it is the unit the tests drive.
async function synthesiseAddedFile(repoRoot, relPath) {
  const info = await classifyPath(repoRoot, relPath);
  if (!info) return null;
  if (info.type === 'skipped') return { skipped: true, kind: info.kind };
  if (info.type === 'symlink') {
    return { patch: symlinkPatch(relPath, info.target), oversized: false, bytes: Buffer.byteLength(info.target), additions: 1 };
  }
  if (info.size > MAX_UNTRACKED_BYTES) {
    return { patch: `${headerFor(relPath, '100644')}Binary files /dev/null and b/${relPath} differ\n`, oversized: true, bytes: info.size, additions: 0 };
  }
  return regularFileResult(repoRoot, relPath);
}

// Runs fn over the list with a fixed number of workers, keeping results in input order.
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// One patch for the whole untracked list, plus what was left out and why:
//   oversized: path → byte size, listed but not rendered
//   skipped:   path → kind, never read
//   truncated: { files, reason } for paths past the scan budget, or null
//   entries:   one record per rendered path, so a caller can build a file list without the patch
//
// Both filesystem passes run concurrently, and the budget is spent by walking the classified
// list in order, so the same repository always cuts the list at the same place.
async function collectUntracked(repoRoot, paths) {
  const considered = paths.slice(0, MAX_UNTRACKED_FILES);
  let truncated = paths.length > considered.length
    ? { files: paths.length - considered.length, reason: 'count' }
    : null;

  const classified = await mapWithLimit(considered, SCAN_CONCURRENCY, (relPath) => classifyPath(repoRoot, relPath));

  // Decide what happens to every path before reading anything, so the byte budget is spent on
  // the same files every time regardless of how the reads interleave.
  const oversized = new Map();
  const skipped = new Map();
  const steps = [];
  let bytesPlanned = 0;
  let budgetHit = -1;

  for (let i = 0; i < considered.length; i++) {
    const relPath = considered[i];
    const info = classified[i];
    if (!info) continue;
    if (info.type === 'skipped') {
      skipped.set(relPath, info.kind);
      continue;
    }
    if (info.type === 'symlink') {
      steps.push({ relPath, patch: symlinkPatch(relPath, info.target), bytes: Buffer.byteLength(info.target), additions: 1 });
      continue;
    }
    // Oversized files are never read, so they cost no budget: they render as a placeholder.
    if (info.size > MAX_UNTRACKED_BYTES) {
      oversized.set(relPath, info.size);
      steps.push({ relPath, patch: `${headerFor(relPath, '100644')}Binary files /dev/null and b/${relPath} differ\n`, bytes: info.size, additions: 0, oversized: true });
      continue;
    }
    if (bytesPlanned + info.size > MAX_UNTRACKED_TOTAL_BYTES) {
      budgetHit = i;
      break;
    }
    bytesPlanned += info.size;
    steps.push({ relPath, read: true });
  }

  // Everything from the file that broke the budget onwards is left alone, whatever its type.
  if (budgetHit >= 0) {
    truncated = { files: (considered.length - budgetHit) + (truncated ? truncated.files : 0), reason: 'bytes' };
  }

  const read = await mapWithLimit(steps, SCAN_CONCURRENCY, (step) => (step.read ? regularFileResult(repoRoot, step.relPath) : null));

  const parts = [];
  const entries = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.read) {
      parts.push(step.patch);
      entries.push({ path: step.relPath, additions: step.additions, bytes: step.bytes, oversized: !!step.oversized, binary: false });
      continue;
    }
    const result = read[i];
    if (!result) continue;                       // vanished between the two passes
    if (result.skipped) {                        // swapped for something unreadable in between
      skipped.set(step.relPath, result.kind);
      continue;
    }
    parts.push(result.patch);
    if (result.oversized) oversized.set(step.relPath, result.bytes);
    entries.push({
      path: step.relPath,
      additions: result.additions,
      bytes: result.bytes,
      oversized: !!result.oversized,
      binary: !!result.binary,
    });
  }

  return { patch: parts.join(''), oversized, skipped, entries, truncated };
}

module.exports = {
  synthesiseAddedFile,
  collectUntracked,
  MAX_UNTRACKED_BYTES,
  MAX_UNTRACKED_FILES,
  MAX_UNTRACKED_TOTAL_BYTES,
};

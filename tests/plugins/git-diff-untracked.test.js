// The Git Diff panel renders untracked files by synthesising an added-file patch for each one.
// Everything asserted here is about what that code is allowed to touch:
//
//   1. a symlink is never followed — a link to a file outside the repository must show the link
//      target, never the contents of what it points at
//   2. a fifo, socket, or device node is never opened for reading — that would block the single
//      node process the whole server runs in
//   3. an oversized file is rejected from its stat, not after being read into memory
//   4. normal text and binary files still render exactly as before
//
//   node tests/plugins/git-diff-untracked.test.js

const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const { synthesiseAddedFile, collectUntracked, MAX_UNTRACKED_BYTES } = require('../../plugins/git-diff/untracked');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

const root = mkdtempSync(join(tmpdir(), 'clideck-git-diff-'));
const outside = join(root, 'outside');
const repo = join(root, 'repo');
mkdirSync(outside);
mkdirSync(repo);

// Stands in for ~/.ssh/id_rsa: a file outside the repository that must never be read.
const SECRET = 'SUPER-SECRET-PRIVATE-KEY';
writeFileSync(join(outside, 'secret.txt'), `${SECRET}\n`);

try {
  // Plain text.
  writeFileSync(join(repo, 'plain.txt'), 'hello\nworld\n');
  const plain = synthesiseAddedFile(repo, 'plain.txt');
  check('text file: rendered as an added file',
    !!plain && !plain.skipped && plain.patch.includes('new file mode 100644') && plain.patch.includes('+hello') && plain.patch.includes('@@ -0,0 +1,2 @@'),
    plain && plain.patch);

  // No trailing newline keeps git's marker.
  writeFileSync(join(repo, 'nonewline.txt'), 'tail');
  const nonewline = synthesiseAddedFile(repo, 'nonewline.txt');
  check('text file without a trailing newline: keeps the no-newline marker',
    !!nonewline && nonewline.patch.includes('+tail\n\\ No newline at end of file'),
    nonewline && nonewline.patch);

  // Empty file: header only, no hunk.
  writeFileSync(join(repo, 'empty.txt'), '');
  const empty = synthesiseAddedFile(repo, 'empty.txt');
  check('empty file: header only, no hunk',
    !!empty && empty.bytes === 0 && !empty.patch.includes('@@'),
    empty && empty.patch);

  // Binary file: placeholder, no contents.
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0x50, 0x00, 0x51, 0x52]));
  const binary = synthesiseAddedFile(repo, 'blob.bin');
  check('binary file: git\'s binary placeholder, no contents',
    !!binary && binary.oversized === false && binary.patch.includes('Binary files /dev/null and b/blob.bin differ') && !binary.patch.includes('@@'),
    binary && binary.patch);

  // Oversized file: listed with its real size, and rejected from the stat.
  const bigBytes = MAX_UNTRACKED_BYTES + 1024;
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(bigBytes));
  const big = synthesiseAddedFile(repo, 'big.txt');
  check('oversized file: reported as oversized with its real size',
    !!big && big.oversized === true && big.bytes === bigBytes && !big.patch.includes('xxxx'),
    big && `oversized=${big && big.oversized} bytes=${big && big.bytes}`);

  // A symlink out of the repository: target shown, target's contents never read.
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'leak'));
  const link = synthesiseAddedFile(repo, 'leak');
  check('symlink: rendered as mode 120000 with the target as its content',
    !!link && !link.skipped && link.patch.includes('new file mode 120000') && link.patch.includes(`+${join(outside, 'secret.txt')}`),
    link && link.patch);
  check('symlink: the target file\'s contents never appear in the patch',
    !!link && !link.patch.includes(SECRET),
    link && link.patch);

  // A dangling symlink is still a symlink, and still must not be read.
  symlinkSync(join(root, 'does-not-exist'), join(repo, 'dangling'));
  const dangling = synthesiseAddedFile(repo, 'dangling');
  check('dangling symlink: still rendered as mode 120000',
    !!dangling && !dangling.skipped && dangling.patch.includes('new file mode 120000'),
    dangling && dangling.patch);

  // A directory is never a patch. git ls-files does not normally list one, but a stale listing
  // or a symlink swap can hand us one.
  mkdirSync(join(repo, 'adir'));
  const dir = synthesiseAddedFile(repo, 'adir');
  check('directory: skipped, reported as a directory',
    !!dir && dir.skipped === true && dir.kind === 'directory',
    JSON.stringify(dir));

  // A fifo blocks readFileSync forever with no writer attached. This call has to return.
  let fifoMade = true;
  try {
    execFileSync('mkfifo', [join(repo, 'pipe')], { stdio: 'ignore' });
  } catch {
    fifoMade = false; // no mkfifo (Windows), nothing to assert
  }
  if (fifoMade) {
    const startedAt = Date.now();
    const fifo = synthesiseAddedFile(repo, 'pipe');
    const tookMs = Date.now() - startedAt;
    check('fifo: skipped, reported as a fifo',
      !!fifo && fifo.skipped === true && fifo.kind === 'fifo',
      JSON.stringify(fifo));
    check('fifo: the call returns instead of blocking on a reader',
      tookMs < 1000,
      `took ${tookMs}ms`);
  } else {
    console.log('  \x1b[33mSKIP\x1b[0m  fifo: mkfifo is not available here');
  }

  // A newline in the name would let the rest of the name be read as patch syntax.
  writeFileSync(join(repo, 'odd\nname.txt'), 'x\n');
  const oddName = synthesiseAddedFile(repo, 'odd\nname.txt');
  check('newline in the name: skipped rather than rendered',
    !!oddName && oddName.skipped === true && oddName.kind === 'newline in name',
    JSON.stringify(oddName));

  // A path that is gone by the time it is read.
  check('missing path: returns null', synthesiseAddedFile(repo, 'never-existed.txt') === null);

  // The whole list at once, the way the plugin calls it.
  const listed = [
    'plain.txt', 'nonewline.txt', 'empty.txt', 'blob.bin', 'big.txt',
    'leak', 'dangling', 'adir', 'odd\nname.txt', 'never-existed.txt',
    ...(fifoMade ? ['pipe'] : []),
  ].sort();
  const all = collectUntracked(repo, listed);
  check('collectUntracked: oversized files are reported with their sizes',
    all.oversized.get('big.txt') === bigBytes,
    [...all.oversized]);
  check('collectUntracked: skipped paths are reported with their kinds',
    all.skipped.get('adir') === 'directory'
      && all.skipped.get('odd\nname.txt') === 'newline in name'
      && (!fifoMade || all.skipped.get('pipe') === 'fifo'),
    [...all.skipped]);
  check('collectUntracked: skipped paths contribute no patch text',
    !all.patch.includes('b/adir') && !all.patch.includes('b/pipe'),
    all.patch.slice(0, 400));
  check('collectUntracked: the secret outside the repository is nowhere in the patch',
    !all.patch.includes(SECRET));
  check('collectUntracked: one header per rendered path',
    (all.patch.match(/^diff --git /gm) || []).length === (fifoMade ? listed.length - 4 : listed.length - 3),
    (all.patch.match(/^diff --git .*/gm) || []).join('\n'));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall git-diff untracked checks passed');

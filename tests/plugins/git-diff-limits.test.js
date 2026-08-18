// Counting changed lines is not enough to bound what the panel renders. A minified bundle or a
// one-line JSON blob is two changed lines of several hundred kilobytes, which passes any
// change-count limit. Parsing it is cheap; the cost is the HTML, about twice the line length,
// broadcast to every open tab on every poll and then laid out by the browser.
//
// capLongLines replaces such a file, before parsing, with the placeholder git uses for binary
// content. What is asserted here:
//
//   1. a file whose longest line is over the ceiling keeps its header and loses its content
//   2. every other file comes back byte for byte, including the trailing newline
//   3. the file is reported by path with its longest line length, so the panel can say why
//   4. renames, new files and multi-file patches are handled
//   5. the scan itself is cheap enough to run on every diff
//
//   node tests/plugins/git-diff-limits.test.js

const { capLongLines, pathFromHeader, MAX_LINE_CHARS, MAX_PATCH_BYTES } = require('../../plugins/git-diff/budget');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

function file(path, lines) {
  return [`diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', ...lines].join('\n');
}

const ordinary = `${file('src/app.js', ['-old line', '+new line'])}\n`;
const minified = `${file('dist/bundle.js', ['-old', `+${'x'.repeat(MAX_LINE_CHARS + 500)}`])}\n`;

// 1 and 3. The long line goes, the header and the report stay.
const one = capLongLines(minified);
check('over the ceiling: header kept, content replaced by git\'s binary wording',
  one.patch.includes('diff --git a/dist/bundle.js b/dist/bundle.js')
    && one.patch.includes('Binary files a/dist/bundle.js and b/dist/bundle.js differ')
    && !one.patch.includes('xxxx'),
  one.patch.slice(0, 300));
check('over the ceiling: the ---/+++ pair and the hunk go with it',
  !one.patch.includes('--- a/dist/bundle.js') && !one.patch.includes('@@'),
  one.patch);
check('over the ceiling: reported by path with its longest line',
  one.longLines.get('dist/bundle.js') === MAX_LINE_CHARS + 501,
  [...one.longLines]);
check('over the ceiling: the result still ends in a newline', one.patch.endsWith('\n'));

// 2. Nothing else is touched.
const untouched = capLongLines(ordinary);
check('under the ceiling: returned byte for byte',
  untouched.patch === ordinary && untouched.longLines.size === 0,
  JSON.stringify(untouched.patch));
check('empty patch: no work, no report',
  capLongLines('').patch === '' && capLongLines('').longLines.size === 0);

// A line exactly on the limit is kept; one character more is not.
const atLimit = `${file('edge.txt', [`+${'y'.repeat(MAX_LINE_CHARS - 1)}`])}\n`;
check('exactly at the ceiling: kept', capLongLines(atLimit).longLines.size === 0);
const overLimit = `${file('edge.txt', [`+${'y'.repeat(MAX_LINE_CHARS)}`])}\n`;
check('one character over the ceiling: replaced', capLongLines(overLimit).longLines.get('edge.txt') === MAX_LINE_CHARS + 1);

// 4. A mixed patch: only the offender loses its content, and order is preserved.
const mixed = `${ordinary}${minified}${file('src/other.js', ['-a', '+b'])}\n`;
const many = capLongLines(mixed);
check('mixed patch: only the offending file is replaced',
  many.longLines.size === 1 && many.longLines.has('dist/bundle.js')
    && many.patch.includes('+new line') && many.patch.includes('+b'),
  [...many.longLines]);
check('mixed patch: file order is unchanged',
  (many.patch.match(/^diff --git a\/(\S+)/gm) || []).join(' ')
    === 'diff --git a/src/app.js diff --git a/dist/bundle.js diff --git a/src/other.js',
  (many.patch.match(/^diff --git a\/(\S+)/gm) || []).join(' '));

// A new file has no index line and a /dev/null side; a rename names two paths.
const added = ['diff --git a/new.json b/new.json', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/new.json', '@@ -0,0 +1 @@', `+${'z'.repeat(MAX_LINE_CHARS + 1)}`, ''].join('\n');
const addedCapped = capLongLines(added);
check('new file: mode line kept, content replaced',
  addedCapped.patch.includes('new file mode 100644')
    && addedCapped.patch.includes('Binary files a/new.json and b/new.json differ')
    && addedCapped.longLines.get('new.json') === MAX_LINE_CHARS + 2,
  addedCapped.patch);

check('rename header: the new path is the one reported',
  pathFromHeader('diff --git a/old/name.js b/new/name.js') === 'new/name.js');
check('identical paths with a space: read as one path',
  pathFromHeader('diff --git a/my dir/file.js b/my dir/file.js') === 'my dir/file.js');

// A header we cannot read a path from still loses its content, using the name-free marker.
const odd = ['diff --cc weird.txt', 'index 1111111..2222222 100644', '@@ -1 +1 @@', `+${'q'.repeat(MAX_LINE_CHARS + 1)}`, ''].join('\n');
check('unparseable header: passed through rather than mangled',
  capLongLines(odd).patch === odd && capLongLines(odd).longLines.size === 0,
  capLongLines(odd).patch.slice(0, 120));

// 5. Cost on the largest patch the panel will ever parse.
const bigLine = `+${'k'.repeat(2000)}`;
const chunks = [];
for (let i = 0; chunks.join('\n').length < MAX_PATCH_BYTES / 2; i++) {
  chunks.push(file(`src/f${i}.js`, Array.from({ length: 40 }, () => bigLine)));
}
const bigPatch = `${chunks.join('\n')}\n`;
const startedAt = Date.now();
const scanned = capLongLines(bigPatch);
const tookMs = Date.now() - startedAt;
check('a multi-megabyte patch of ordinary lines is scanned quickly and unchanged',
  scanned.longLines.size === 0 && scanned.patch === bigPatch && tookMs < 500,
  `${(bigPatch.length / 1048576).toFixed(1)} MB in ${tookMs}ms`);
console.log(`        (scanned ${(bigPatch.length / 1048576).toFixed(1)} MB in ${tookMs}ms)`);

// 6. A conflicted file, since git reports those differently when no base is named. The plugin
// always names one, so the ordinary header form is what arrives, and the ceiling applies.
const { execFileSync } = require('child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { GLOBAL_ARGS, diffArgs } = require('../../plugins/git-diff/safety');

const repo = mkdtempSync(join(tmpdir(), 'clideck-git-limits-'));
try {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'f.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-q', '-b', 'side']);
  writeFileSync(join(repo, 'f.txt'), `${'a'.repeat(MAX_LINE_CHARS + 1000)}\n`);
  git(['commit', '-qam', 'side']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(repo, 'f.txt'), `${'b'.repeat(MAX_LINE_CHARS + 1000)}\n`);
  git(['commit', '-qam', 'main']);
  try { git(['merge', 'side']); } catch { /* the conflict is the point */ }

  const conflicted = execFileSync('git', [...GLOBAL_ARGS, ...diffArgs('HEAD', 3)], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const cappedConflict = capLongLines(conflicted);
  const longestAfter = Math.max(...cappedConflict.patch.split('\n').map((l) => l.length));
  check('a conflicted file with long lines is capped like any other',
    cappedConflict.longLines.get('f.txt') > MAX_LINE_CHARS && longestAfter < 200,
    `${[...cappedConflict.longLines]} then longest ${longestAfter}`);
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall git-diff limit checks passed');

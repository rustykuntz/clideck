// Between running git and sending the panel a diff sits a layer of plain shaping: the file
// records, the totals, which limit the diff fell foul of, the folders it can be pointed at, and
// the message itself. It used to live inside index.js, where nothing could reach it without
// loading diff2html. payload.js holds it now, with no dependencies, so it is checked directly.
//
// What is asserted here:
//
//   1. sumTotals counts files, additions and deletions, missing counts included
//   2. untrackedFileList marks every entry new and carries binary and oversized through
//   3. parsedFileList picks the right path per file kind, and reports a file left out for size
//      or line length as text rather than binary
//   4. its records match parseNumstat's field for field, so both file lists send one shape
//   5. the settings clamps hold both bounds and fall back to the defaults
//   6. tooBigVerdict names the limit that was passed, bytes before changes
//   7. shouldHighlight is off when the setting is off and above the line ceiling
//   8. folderChoices lists the session folder, every worktree, and the folder in use, once each
//   9. diffPayload and failPayload carry every field the client reads
//
// The cache key moved to cache.js, so its checks are in tests/plugins/git-diff-cache.test.js.
//
//   node tests/plugins/git-diff-payload.test.js

const {
  HIGHLIGHT_MAX_LINES, MAX_CHANGES_CEILING, clampContext, clampMaxChanges, untrackedFileList,
  parsedFileList, sumTotals, tooBigVerdict, shouldHighlight, folderChoices, normaliseScope,
  normaliseLayout, diffPayload, failPayload,
} = require('../../plugins/git-diff/payload');
const { parseNumstat } = require('../../plugins/git-diff/git');
const { MAX_PATCH_BYTES } = require('../../plugins/git-diff/budget');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

// 1. Totals.
const someFiles = [
  { path: 'a.js', additions: 3, deletions: 1 },
  { path: 'b.js', additions: 0, deletions: 7 },
  { path: 'c.js' }, // a binary file carries no counts
];
const totals = sumTotals(someFiles);
check('totals: one count per file, additions and deletions summed',
  totals.files === 3 && totals.additions === 3 && totals.deletions === 8,
  JSON.stringify(totals));
check('totals: no files means zeroes, not NaN',
  JSON.stringify(sumTotals([])) === JSON.stringify({ files: 0, additions: 0, deletions: 0 }),
  JSON.stringify(sumTotals([])));

// 2. The untracked half of the file list, built from the scan's records rather than a patch.
const untracked = untrackedFileList([
  { path: 'new.txt', additions: 4, bytes: 40, oversized: false, binary: false },
  { path: 'logo.png', additions: 0, bytes: 900, oversized: false, binary: true },
  { path: 'dump.sql', additions: 0, bytes: 900000, oversized: true, binary: false },
]);
check('untracked: every entry is a new file with no deletions',
  untracked.length === 3 && untracked.every((f) => f.isNew && f.deletions === 0 && !f.isRename && !f.isDeleted),
  JSON.stringify(untracked));
check('untracked: additions come from the scan',
  untracked[0].additions === 4 && untracked[1].additions === 0);
check('untracked: a binary file is marked binary, a text file is not',
  untracked[1].isBinary === true && untracked[0].isBinary === false);
check('untracked: an oversized file reports its size and is not called binary',
  untracked[2].oversizedBytes === 900000 && untracked[2].isBinary === false,
  JSON.stringify(untracked[2]));
check('untracked: a file within the size limit reports no oversized bytes',
  untracked[0].oversizedBytes === 0 && untracked[1].oversizedBytes === 0);
check('untracked: no entries means no files', untrackedFileList([]).length === 0 && untrackedFileList(undefined).length === 0);

// 3. The parsed half. These objects are the shape diff2html's parse returns, written out here so
// the test needs no npm package.
const parsed = [
  { oldName: 'src/app.js', newName: 'src/app.js', addedLines: 2, deletedLines: 1 },
  { oldName: 'old/name.js', newName: 'new/name.js', addedLines: 0, deletedLines: 0, isRename: true },
  { oldName: 'gone.js', newName: '/dev/null', addedLines: 0, deletedLines: 12, isDeleted: true },
  { oldName: '/dev/null', newName: 'added.js', addedLines: 5, deletedLines: 0, isNew: true },
  { oldName: 'logo.png', newName: 'logo.png', addedLines: 0, deletedLines: 0, isBinary: true },
  { oldName: 'dump.sql', newName: 'dump.sql', addedLines: 0, deletedLines: 0, isBinary: true, isNew: true },
  { oldName: 'dist/bundle.js', newName: 'dist/bundle.js', addedLines: 0, deletedLines: 0, isBinary: true },
  { oldName: 'huge.js', newName: 'huge.js', addedLines: 0, deletedLines: 0, isTooBig: true },
];
const list = parsedFileList(parsed, {
  oversized: new Map([['dump.sql', 900000]]),
  longLines: new Map([['dist/bundle.js', 41000]]),
});
const byPath = Object.fromEntries(list.map((f) => [f.path, f]));
check('parsed: an ordinary file keeps its path and both counts',
  byPath['src/app.js'].additions === 2 && byPath['src/app.js'].deletions === 1 && byPath['src/app.js'].oldPath === '',
  JSON.stringify(byPath['src/app.js']));
check('parsed: a rename is named by its new path and records the old one',
  byPath['new/name.js'].isRename === true && byPath['new/name.js'].oldPath === 'old/name.js',
  JSON.stringify(byPath['new/name.js']));
check('parsed: a deleted file is named by its old path, not /dev/null',
  !!byPath['gone.js'] && byPath['gone.js'].isDeleted === true && byPath['gone.js'].deletions === 12,
  JSON.stringify(list.map((f) => f.path)));
check('parsed: a new file is named by its new path and carries no old path',
  byPath['added.js'].isNew === true && byPath['added.js'].oldPath === '',
  JSON.stringify(byPath['added.js']));
check('parsed: a real binary file stays binary',
  byPath['logo.png'].isBinary === true && byPath['logo.png'].oversizedBytes === 0);
check('parsed: an untracked file left out for size is text, and reports its size',
  byPath['dump.sql'].isBinary === false && byPath['dump.sql'].oversizedBytes === 900000,
  JSON.stringify(byPath['dump.sql']));
check('parsed: a file left out for line length is text, and reports its longest line',
  byPath['dist/bundle.js'].isBinary === false && byPath['dist/bundle.js'].longestLine === 41000,
  JSON.stringify(byPath['dist/bundle.js']));
check('parsed: a file over the per-file change limit is flagged',
  byPath['huge.js'].isTooBig === true && byPath['huge.js'].isBinary === false);
check('parsed: no reports means nothing is called oversized or long',
  parsedFileList(parsed).every((f) => f.oversizedBytes === 0 && f.longestLine === 0),
  JSON.stringify(parsedFileList(parsed).map((f) => [f.path, f.oversizedBytes, f.longestLine])));

// 4. Both file lists reach the same client code, so they have to carry the same fields.
const fromNumstat = parseNumstat('2\t1\tsrc/app.js\0')[0];
const fromParse = byPath['src/app.js'];
check('one record shape: parsed files and numstat files have identical fields',
  JSON.stringify(Object.keys(fromParse).sort()) === JSON.stringify(Object.keys(fromNumstat).sort()),
  `${Object.keys(fromParse).sort()}\n${Object.keys(fromNumstat).sort()}`);
check('one record shape: the same file reads the same either way',
  JSON.stringify(fromParse) === JSON.stringify({ ...fromNumstat, path: 'src/app.js' }),
  `${JSON.stringify(fromParse)}\n${JSON.stringify(fromNumstat)}`);
check('one record shape: an untracked record matches too',
  JSON.stringify(Object.keys(untracked[0]).sort()) === JSON.stringify(Object.keys(fromNumstat).sort()),
  Object.keys(untracked[0]).sort());

// 5. The clamps. An empty setting takes the default, not the nearest bound.
check('context lines: the default when unset or nonsense',
  clampContext(undefined) === 3 && clampContext(NaN) === 3 && clampContext('4') === 3,
  [clampContext(undefined), clampContext(NaN), clampContext('4')]);
check('context lines: zero is allowed and both bounds hold',
  clampContext(0) === 0 && clampContext(-5) === 0 && clampContext(20) === 20 && clampContext(99) === 20,
  [clampContext(0), clampContext(-5), clampContext(20), clampContext(99)]);
check('max changes: the default when unset or nonsense',
  clampMaxChanges(undefined) === 20000 && clampMaxChanges(Infinity) === 20000,
  [clampMaxChanges(undefined), clampMaxChanges(Infinity)]);
check('max changes: floor of 100 and the ceiling from payload.js',
  clampMaxChanges(1) === 100 && clampMaxChanges(100) === 100
    && clampMaxChanges(MAX_CHANGES_CEILING + 1) === MAX_CHANGES_CEILING
    && clampMaxChanges(500) === 500,
  [clampMaxChanges(1), clampMaxChanges(MAX_CHANGES_CEILING + 1)]);

// 6. Which limit was passed. Bytes wins, because that check runs before the patch is parsed.
const under = tooBigVerdict({ patchBytes: 1000, changes: 50, maxChanges: 20000, maxPatchBytes: MAX_PATCH_BYTES });
check('too big: under both limits there is no verdict', under === null, JSON.stringify(under));
const byBytes = tooBigVerdict({ patchBytes: MAX_PATCH_BYTES + 1, changes: 50, maxChanges: 20000, maxPatchBytes: MAX_PATCH_BYTES });
check('too big: over the byte limit reports bytes, with both numbers',
  byBytes.reason === 'bytes' && byBytes.bytes === MAX_PATCH_BYTES + 1 && byBytes.changes === 50,
  JSON.stringify(byBytes));
const byChanges = tooBigVerdict({ patchBytes: 1000, changes: 20001, maxChanges: 20000, maxPatchBytes: MAX_PATCH_BYTES });
check('too big: over the change limit reports changes',
  byChanges.reason === 'changes' && byChanges.changes === 20001,
  JSON.stringify(byChanges));
check('too big: exactly on either limit is not too big',
  tooBigVerdict({ patchBytes: MAX_PATCH_BYTES, changes: 20000, maxChanges: 20000, maxPatchBytes: MAX_PATCH_BYTES }) === null);
check('too big: past both limits reports bytes, the one the user cannot raise',
  tooBigVerdict({ patchBytes: MAX_PATCH_BYTES + 1, changes: 999999, maxChanges: 20000, maxPatchBytes: MAX_PATCH_BYTES }).reason === 'bytes');

// 7. Whether the browser is asked to highlight.
check('highlight: off when the setting is off',
  shouldHighlight({ additions: 1, deletions: 0 }, { syntaxHighlight: false }) === false);
check('highlight: on for an ordinary diff',
  shouldHighlight({ additions: 100, deletions: 20 }, {}) === true);
check('highlight: on exactly at the line ceiling',
  shouldHighlight({ additions: HIGHLIGHT_MAX_LINES, deletions: 0 }, {}) === true);
check('highlight: off one line over the ceiling',
  shouldHighlight({ additions: HIGHLIGHT_MAX_LINES, deletions: 1 }, {}) === false);

// 8. The folder selector. A session started in a main checkout offers its worktrees, which is
// the common case when an agent works on a branch in one.
const trees = [
  { path: '/repo', branch: 'main' },
  { path: '/repo/.worktrees/feature', branch: 'feature' },
  { path: '/repo/.worktrees/loose', branch: '', detached: true },
];
const choices = folderChoices('/repo', trees, '/repo/.worktrees/feature', '/repo/.worktrees/feature');
check('folders: the session folder comes first',
  choices[0].path === '/repo' && choices[0].kind === 'session',
  JSON.stringify(choices));
check('folders: every worktree is offered, labelled by branch',
  choices.some((c) => c.path === '/repo/.worktrees/feature' && c.label === 'feature')
    && choices.some((c) => c.path === '/repo/.worktrees/loose' && c.label === 'detached'),
  JSON.stringify(choices));
check('folders: the worktree in view is marked as the current one',
  choices.find((c) => c.path === '/repo/.worktrees/feature').kind === 'current-worktree',
  JSON.stringify(choices));
check('folders: the session folder is not listed twice when it is also a worktree',
  choices.filter((c) => c.path === '/repo').length === 1,
  JSON.stringify(choices));
const unlisted = folderChoices('/repo', [], '', '/elsewhere');
check('folders: a folder that is no worktree of this repository is still offered',
  unlisted.length === 2 && unlisted[1].path === '/elsewhere' && unlisted[1].kind === 'current',
  JSON.stringify(unlisted));
check('folders: no session folder and no worktrees still leaves the folder in use',
  JSON.stringify(folderChoices('', [], '', '/only')) === JSON.stringify([{ path: '/only', label: '', kind: 'current' }]),
  JSON.stringify(folderChoices('', [], '', '/only')));

// The client sends both of these back on every request, so an unknown value takes the default.
check('scope: only "base" means base', normaliseScope('base') === 'base' && normaliseScope('nonsense') === 'uncommitted' && normaliseScope(undefined) === 'uncommitted');
check('layout: only "line-by-line" means unified',
  normaliseLayout('line-by-line') === 'line-by-line' && normaliseLayout('nonsense') === 'side-by-side');

// 9. The messages themselves. Every field named here is read by client.js.
const built = {
  ok: true,
  repoRoot: '/repo',
  branch: 'feature',
  baseLabel: 'origin/main',
  baseFallback: false,
  baseIsHead: false,
  baseBranchInvalid: false,
  totals: { files: 1, additions: 2, deletions: 1 },
  files: [byPath['src/app.js']],
  patchBytes: 400,
  maxChanges: 20000,
  worktrees: trees,
  skippedEntries: [{ path: 'pipe', kind: 'fifo' }],
  untrackedTruncated: { files: 12, reason: 'count' },
  tooBig: null,
};
const payload = diffPayload({
  msg: { requestId: 'r1', sessionId: 's1', scope: 'base' },
  built,
  layout: 'line-by-line',
  session: { name: 'agent', cwd: '/repo' },
  folder: '/repo/.worktrees/feature',
  folderRejected: false,
  trusted: true,
  highlight: true,
  html: '<div class="d2h-wrapper"></div>',
  home: '/home/someone',
  maxLineChars: 20000,
  patchKey: 's1|base|/repo/.worktrees/feature|3|20000|',
});
const CLIENT_FIELDS = [
  'requestId', 'sessionId', 'ok', 'patchKey', 'sessionName', 'cwd', 'folder', 'folderRejected', 'folderTrusted',
  'folders', 'home', 'repoRoot', 'branch', 'scope', 'layout', 'baseLabel', 'baseFallback',
  'baseIsHead', 'baseBranchInvalid', 'totals', 'files', 'skippedEntries', 'untrackedTruncated',
  'tooBig', 'patchBytes', 'maxChanges', 'maxLineChars', 'highlight', 'html',
];
check('diff reply: every field the client reads is present',
  CLIENT_FIELDS.every((f) => f in payload),
  CLIENT_FIELDS.filter((f) => !(f in payload)).join(', '));
check('diff reply: the request is echoed back so a tab can drop another tab\'s reply',
  payload.requestId === 'r1' && payload.sessionId === 's1' && payload.ok === true);
check('diff reply: the cache entry is named, for Copy patch to quote back',
  payload.patchKey === 's1|base|/repo/.worktrees/feature|3|20000|', payload.patchKey);
check('diff reply: scope and layout are the normalised values',
  payload.scope === 'base' && payload.layout === 'line-by-line');
check('diff reply: the folder list is built from the session folder and the worktrees',
  payload.folders.length === 3 && payload.folders[0].path === '/repo'
    && payload.folders.some((c) => c.path === '/repo/.worktrees/feature'),
  JSON.stringify(payload.folders));
check('diff reply: an untrusted folder is reported as untrusted',
  diffPayload({ msg: {}, built, layout: 'side-by-side', session: { cwd: '/repo' }, folder: '/x', trusted: false, home: '' }).folderTrusted === false);
check('diff reply: a trust verdict the caller does not have is not a warning',
  diffPayload({ msg: {}, built, layout: 'side-by-side', session: { cwd: '/repo' }, folder: '/x', trusted: undefined, home: '' }).folderTrusted === true);
check('diff reply: an unknown scope or layout falls back to the defaults',
  (() => {
    const p = diffPayload({ msg: { scope: 'nonsense' }, built, layout: 'nonsense', session: { cwd: '/repo' }, folder: '/repo', home: '' });
    return p.scope === 'uncommitted' && p.layout === 'side-by-side';
  })());
check('diff reply: a diff with no HTML still sends a string, not undefined',
  diffPayload({ msg: {}, built: { ...built, tooBig: { reason: 'bytes', bytes: 1, changes: 1 } }, layout: 'side-by-side', session: { cwd: '/repo' }, folder: '/repo', home: '' }).html === '');
check('diff reply: skipped entries and the truncation note travel with it',
  payload.skippedEntries[0].kind === 'fifo' && payload.untrackedTruncated.files === 12);

const failure = failPayload({
  msg: { requestId: 'r2', sessionId: 's1' },
  code: 'unsafe-config',
  message: 'names commands: diff.external',
  folder: '/elsewhere',
  sessionCwd: '/repo',
  home: '/home/someone',
  extra: { riskyKeys: ['diff.external'] },
});
check('failure: the code and message reach the client',
  failure.ok === false && failure.code === 'unsafe-config' && failure.message.includes('diff.external'));
check('failure: the session folder is still offered, so a bad choice is not a dead end',
  failure.folders.length === 2 && failure.folders[0].path === '/repo' && failure.folders[1].path === '/elsewhere',
  JSON.stringify(failure.folders));
check('failure: extra fields for this code are carried through',
  JSON.stringify(failure.riskyKeys) === JSON.stringify(['diff.external']));
check('failure: the session folder is listed once when it is the folder that failed',
  failPayload({ msg: {}, code: 'not-a-repo', message: 'x', folder: '/repo', sessionCwd: '/repo', home: '' }).folders.length === 1);
check('failure: no session folder still reports the folder that failed',
  failPayload({ msg: {}, code: 'no-session', message: 'x', folder: '', sessionCwd: '', home: '' }).folder === '');

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall git-diff payload checks passed');

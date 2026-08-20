// Runs every Git Diff plugin suite in one go.
//
//   node tests/plugins/git-diff/run.js            all of them
//   node tests/plugins/git-diff/run.js cache      just the ones named
//
// Each suite is a plain Node script that prints its own PASS lines and exits non-zero if any check
// failed, so this only orders them, streams their output, and reports which ones failed. A suite
// that is added to this folder is picked up without being listed here; the order below just puts
// the cheap ones first, so a failure shows up before the suites that write thousands of files.
//
// Every suite runs even when an earlier one fails, since they cover different modules and one
// failure says nothing about the rest.

const { spawnSync } = require('child_process');
const { readdirSync } = require('fs');
const { join } = require('path');

const ORDER = ['cache', 'payload', 'limits', 'resolve', 'untracked', 'safety'];
const COLOR = { pass: '\x1b[32m', fail: '\x1b[31m', head: '\x1b[1m', dim: '\x1b[2m', off: '\x1b[0m' };

const here = __dirname;
const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => f.replace(/\.test\.js$/, ''))
  .sort((a, b) => {
    const rank = (n) => (ORDER.indexOf(n) === -1 ? ORDER.length : ORDER.indexOf(n));
    return rank(a) - rank(b) || a.localeCompare(b);
  });

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: node tests/plugins/git-diff/run.js [${suites.join('|')}]`);
  process.exit(0);
}
const selected = wanted.length ? suites.filter((s) => wanted.includes(s)) : suites;
const unknown = wanted.filter((w) => !suites.includes(w));
if (unknown.length) {
  console.error(`unknown suite: ${unknown.join(', ')} (have ${suites.join(', ')})`);
  process.exit(2);
}

console.log(`\n${COLOR.head}Git Diff plugin tests${COLOR.off} — ${selected.join(', ')}`);

const results = [];
for (const name of selected) {
  console.log(`\n${COLOR.head}── ${name} ──${COLOR.off}`);
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [join(here, `${name}.test.js`)], { stdio: 'inherit' });
  results.push({ name, ok: run.status === 0, code: run.status, ms: Date.now() - startedAt });
}

console.log(`\n${COLOR.head}── summary ──${COLOR.off}`);
for (const r of results) {
  const verdict = r.ok ? `${COLOR.pass}PASS${COLOR.off}` : `${COLOR.fail}FAIL${COLOR.off}`;
  const code = r.ok ? '' : ` ${COLOR.dim}(exit ${r.code})${COLOR.off}`;
  console.log(`  ${verdict}  ${r.name.padEnd(10)} ${COLOR.dim}${(r.ms / 1000).toFixed(1)}s${COLOR.off}${code}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} suite(s) failed\n` : `\nall ${results.length} suites passed\n`);
process.exit(failed.length ? 1 : 0);

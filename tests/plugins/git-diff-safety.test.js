// Diffing a folder means running that folder's git configuration. Four config keys name a
// command that git executes during an ordinary diff, and the Git Diff panel re-runs git every
// few seconds on its own, so a folder picked in the UI would otherwise run whatever its
// .git/config says, repeatedly.
//
// The checks below run real git against throwaway repositories whose config points at a script
// that touches a marker file, so a marker on disk is proof the command ran.
//
//   1. --no-ext-diff stops diff.external, and the real patch still appears
//   2. --no-textconv stops a textconv driver
//   3. -c core.fsmonitor= stops the monitor hook, which GIT_OPTIONAL_LOCKS=0 does not
//   4. filter.<driver>.clean still runs under all of those, which is why the plugin refuses an
//      untrusted folder that names one until the user says go ahead. This is asserted so the
//      suite records the gap rather than implying it is closed.
//   5. riskyKeys finds the keys that name commands and leaves ordinary config alone
//   6. isValidRefName rejects anything that would reach git's argv as an option
//
//   node tests/plugins/git-diff-safety.test.js

const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const {
  GLOBAL_ARGS, UNTRUSTED_ARGS, diffArgs, numstatArgs, riskyKeys, isValidRefName,
} = require('../../plugins/git-diff/git');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

const root = mkdtempSync(join(tmpdir(), 'clideck-git-safety-'));
const marker = join(root, 'MARKER');

// Same environment the plugin runs git in, so GIT_OPTIONAL_LOCKS is not doing the work here.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repository with one committed file and one uncommitted change to it, so a diff has work.
function makeRepo(name) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  git(['add', 'f.txt'], dir);
  git(['commit', '-qm', 'init'], dir);
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\n');
  return dir;
}

// Writes a script that records that it ran. `cat` keeps the filter and textconv cases valid,
// since git expects content back on stdout.
function makeScript(dir, name, passThrough) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch ${marker}\n${passThrough}\n`);
  chmodSync(path, 0o755);
  return path;
}

function ran() {
  const hit = existsSync(marker);
  if (hit) rmSync(marker);
  return hit;
}

try {
  // 1. diff.external
  const ext = makeRepo('ext');
  git(['config', 'diff.external', makeScript(ext, 'driver.sh', 'exit 0')], ext);
  const withoutGuard = git([...GLOBAL_ARGS, 'diff', '--no-color', 'HEAD'], ext);
  check('diff.external: runs on an unguarded diff, and hides the real patch',
    ran() && !withoutGuard.includes('+two'),
    JSON.stringify(withoutGuard));
  const guarded = git([...GLOBAL_ARGS, ...diffArgs('HEAD', 3)], ext);
  check('diff.external: does not run under diffArgs, and the real patch appears',
    !ran() && guarded.includes('+two'),
    JSON.stringify(guarded));
  const numstat = git([...GLOBAL_ARGS, ...numstatArgs('HEAD')], ext);
  check('diff.external: does not run under numstatArgs either',
    !ran() && numstat.includes('f.txt'),
    JSON.stringify(numstat));

  // 2. diff.<driver>.textconv
  const tc = makeRepo('textconv');
  git(['config', 'diff.demo.textconv', makeScript(tc, 'tc.sh', 'cat "$1"')], tc);
  writeFileSync(join(tc, '.gitattributes'), 'f.txt diff=demo\n');
  git([...GLOBAL_ARGS, 'diff', '--no-color', 'HEAD'], tc);
  check('textconv: runs on an unguarded diff', ran());
  git([...GLOBAL_ARGS, ...diffArgs('HEAD', 3)], tc);
  check('textconv: does not run under diffArgs', !ran());

  // 3. core.fsmonitor
  const fsm = makeRepo('fsmonitor');
  git(['config', 'core.fsmonitor', makeScript(fsm, 'fsmon.sh', 'exit 1')], fsm);
  git([...GLOBAL_ARGS, ...diffArgs('HEAD', 3)], fsm);
  check('core.fsmonitor: runs even with GIT_OPTIONAL_LOCKS=0 and the diff flags', ran());
  git([...GLOBAL_ARGS, ...UNTRUSTED_ARGS, ...diffArgs('HEAD', 3)], fsm);
  check('core.fsmonitor: does not run under UNTRUSTED_ARGS', !ran());

  // 4. filter.<driver>.clean, the one no flag switches off
  const flt = makeRepo('filter');
  git(['config', 'filter.demo.clean', makeScript(flt, 'clean.sh', 'cat')], flt);
  writeFileSync(join(flt, '.gitattributes'), 'f.txt filter=demo\n');
  git([...GLOBAL_ARGS, ...UNTRUSTED_ARGS, ...diffArgs('HEAD', 3)], flt);
  check('filter.clean: still runs under every flag, which is the known gap', ran());

  // 5. riskyKeys over what `git config --local --list -z` actually produces
  const listed = git(['config', '--local', '--list', '-z'], flt);
  const found = riskyKeys(listed);
  check('riskyKeys: finds the clean filter in real config output',
    found.includes('filter.demo.clean'),
    `${JSON.stringify(found)} from ${JSON.stringify(listed)}`);
  check('riskyKeys: ignores ordinary keys',
    !found.some((k) => k.startsWith('core.repositoryformatversion') || k.startsWith('user.')),
    JSON.stringify(found));

  const synthetic = [
    'diff.external\n/bin/false',
    'diff.Demo.textconv\n/bin/cat',
    'filter.lfs.process\ngit-lfs filter-process',
    'core.fsmonitor\n/bin/true',
    'core.hooksPath\n/tmp/hooks',
    'core.bare\nfalse',
    'branch.main.remote\norigin',
    'diff.demo.cachetextconv\ntrue',
    'filter.demo.required\ntrue',
  ].join('\0');
  check('riskyKeys: exactly the command-bearing keys, subsections and case included',
    JSON.stringify(riskyKeys(synthetic)) === JSON.stringify([
      'diff.external', 'diff.Demo.textconv', 'filter.lfs.process', 'core.fsmonitor', 'core.hooksPath',
    ]),
    JSON.stringify(riskyKeys(synthetic)));
  check('riskyKeys: empty output means no keys', riskyKeys('').length === 0 && riskyKeys(undefined).length === 0);

  // 6. the base branch setting, which reaches rev-parse and merge-base argv
  for (const good of ['main', 'origin/main', 'origin/feature/thing', 'release-1.2', 'v1.0']) {
    check(`isValidRefName: accepts ${good}`, isValidRefName(good));
  }
  for (const bad of ['--help', '-x', 'a b', 'has..dots', 'brace@{0}', 'star*', 'q?', 'colon:', 'tilde~1', 'caret^', '/lead', 'trail/', '.hidden', 'ends.', 'thing.lock', '', 'null\x00byte', 'bell\x07inside', 'double//slash']) {
    check(`isValidRefName: rejects ${JSON.stringify(bad)}`, !isValidRefName(bad));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall git-diff safety checks passed');

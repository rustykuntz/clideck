// Diffing a folder means running that folder's git configuration. Four config keys name a
// command that git executes during an ordinary diff, and the Git Diff panel re-runs git every
// few seconds on its own, so a folder picked in the UI would otherwise run whatever its
// .git/config says, repeatedly. No folder is exempt, the session's own included.
//
// The checks below run real git against throwaway repositories whose config points at a script
// that touches a marker file, so a marker on disk is proof the command ran.
//
//   1. --no-ext-diff stops diff.external, and the real patch still appears
//   2. --no-textconv stops a textconv driver
//   3. -c core.fsmonitor= stops the monitor hook, which GIT_OPTIONAL_LOCKS=0 does not
//   4. filter.<driver>.clean survives every flag, and is stopped by name instead. required=false
//      is part of that: a required filter producing no output aborts the command, so overriding
//      clean on its own turns a working diff into a fatal error.
//   5. filter.<driver>.process, the protocol filter, is stopped the same way
//   6. filterDrivers finds the drivers a real config defines and refuses a name it cannot put in
//      a -c key, since git would read the rest of it as a value
//   7. isValidRefName rejects anything that would reach git's argv as an option
//
//   node tests/plugins/git-diff/safety.test.js

const { execFileSync } = require('child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const {
  BASE_ARGS, diffArgs, numstatArgs, filterDrivers, filterOverrideArgs, isValidRefName,
} = require('../../../plugins/git-diff/git');

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

// The required-filter case is expected to fail, so that one needs the exit status rather than an
// exception.
function tryGit(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (e) {
    return { ok: false, out: e.stdout || '', err: (e.stderr || e.message || '').trim() };
  }
}

// Everything before core.fsmonitor= was added, so a check can show BASE_ARGS is what stops the
// monitor hook rather than the environment.
const QUOTEPATH_ONLY = ['-c', 'core.quotepath=false'];

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
  const withoutGuard = git([...BASE_ARGS, 'diff', '--no-color', 'HEAD'], ext);
  check('diff.external: runs on an unguarded diff, and hides the real patch',
    ran() && !withoutGuard.includes('+two'),
    JSON.stringify(withoutGuard));
  const guarded = git([...BASE_ARGS, ...diffArgs('HEAD', 3)], ext);
  check('diff.external: does not run under diffArgs, and the real patch appears',
    !ran() && guarded.includes('+two'),
    JSON.stringify(guarded));
  const numstat = git([...BASE_ARGS, ...numstatArgs('HEAD')], ext);
  check('diff.external: does not run under numstatArgs either',
    !ran() && numstat.includes('f.txt'),
    JSON.stringify(numstat));

  // 2. diff.<driver>.textconv
  const tc = makeRepo('textconv');
  git(['config', 'diff.demo.textconv', makeScript(tc, 'tc.sh', 'cat "$1"')], tc);
  writeFileSync(join(tc, '.gitattributes'), 'f.txt diff=demo\n');
  git([...BASE_ARGS, 'diff', '--no-color', 'HEAD'], tc);
  check('textconv: runs on an unguarded diff', ran());
  git([...BASE_ARGS, ...diffArgs('HEAD', 3)], tc);
  check('textconv: does not run under diffArgs', !ran());

  // 3. core.fsmonitor
  const fsm = makeRepo('fsmonitor');
  git(['config', 'core.fsmonitor', makeScript(fsm, 'fsmon.sh', 'exit 1')], fsm);
  git([...QUOTEPATH_ONLY, ...diffArgs('HEAD', 3)], fsm);
  check('core.fsmonitor: runs even with GIT_OPTIONAL_LOCKS=0 and the diff flags', ran());
  git([...BASE_ARGS, ...diffArgs('HEAD', 3)], fsm);
  check('core.fsmonitor: does not run under BASE_ARGS', !ran());

  // 4. filter.<driver>.clean, the one no flag switches off
  const flt = makeRepo('filter');
  git(['config', 'filter.demo.clean', makeScript(flt, 'clean.sh', 'cat')], flt);
  writeFileSync(join(flt, '.gitattributes'), 'f.txt filter=demo\n');
  const unfiltered = git([...BASE_ARGS, ...diffArgs('HEAD', 3)], flt);
  check('filter.clean: runs under every flag, since none of them cover it',
    ran() && unfiltered.includes('+two'),
    JSON.stringify(unfiltered));
  const overridden = git([...BASE_ARGS, ...filterOverrideArgs(['demo']), ...diffArgs('HEAD', 3)], flt);
  check('filter.clean: does not run once the driver is overridden, and the patch is intact',
    !ran() && overridden.includes('+two'),
    JSON.stringify(overridden));

  // A required filter aborts the command when it produces nothing, so required=false has to be
  // part of the override or the diff fails instead of skipping the filter.
  git(['config', 'filter.demo.required', 'true'], flt);
  const cleanOnly = tryGit([...BASE_ARGS, '-c', 'filter.demo.clean=', ...diffArgs('HEAD', 3)], flt);
  check('filter.clean: required=true fails when only clean is overridden',
    !ran() && !cleanOnly.ok && /clean filter/.test(cleanOnly.err),
    `${cleanOnly.ok} ${JSON.stringify(cleanOnly.err)}`);
  const full = tryGit([...BASE_ARGS, ...filterOverrideArgs(['demo']), ...diffArgs('HEAD', 3)], flt);
  check('filter.clean: required=true succeeds under the full override',
    !ran() && full.ok && full.out.includes('+two'),
    `${full.ok} ${JSON.stringify(full.err || full.out)}`);

  // 5. filter.<driver>.process, the protocol filter, which serves the clean side too
  const proc = makeRepo('process');
  git(['config', 'filter.demo.process', makeScript(proc, 'proc.sh', 'exit 0')], proc);
  writeFileSync(join(proc, '.gitattributes'), 'f.txt filter=demo\n');
  git([...BASE_ARGS, ...diffArgs('HEAD', 3)], proc);
  check('filter.process: runs under every flag', ran());
  const procOverridden = git([...BASE_ARGS, ...filterOverrideArgs(['demo']), ...diffArgs('HEAD', 3)], proc);
  check('filter.process: does not run once the driver is overridden, and the patch is intact',
    !ran() && procOverridden.includes('+two'),
    JSON.stringify(procOverridden));

  // 6. filterDrivers over what `git config --local --list -z` actually produces
  const listed = git(['config', '--local', '--list', '-z'], flt);
  const found = filterDrivers(listed);
  check('filterDrivers: finds the driver in real config output',
    JSON.stringify(found.usable) === JSON.stringify(['demo']) && found.rejected.length === 0,
    `${JSON.stringify(found)} from ${JSON.stringify(listed)}`);

  const synthetic = [
    'diff.external\n/bin/false',
    'diff.Demo.textconv\n/bin/cat',
    'filter.lfs.process\ngit-lfs filter-process',
    'filter.Mixed.CLEAN\n/bin/cat',
    'filter.dotted.name.clean\n/bin/cat',
    'filter.lfs.smudge\ngit-lfs smudge',
    'core.fsmonitor\n/bin/true',
    'core.hooksPath\n/tmp/hooks',
    'core.bare\nfalse',
    'branch.main.remote\norigin',
    'filter.demo.required\ntrue',
  ].join('\0');
  const fromSynthetic = filterDrivers(synthetic);
  check('filterDrivers: only filter drivers, subsection case and dots preserved',
    JSON.stringify(fromSynthetic.usable) === JSON.stringify(['lfs', 'Mixed', 'dotted.name']),
    JSON.stringify(fromSynthetic));
  check('filterDrivers: smudge alone is not a driver definition, since nothing here writes a worktree',
    !filterDrivers('filter.only.smudge\n/bin/cat').usable.length);

  // A name git would split on = would set a key of its own choosing, so it is refused instead.
  const hostile = filterDrivers(['filter.a=b.clean\n/bin/cat', 'filter.ok.clean\n/bin/cat'].join('\0'));
  check('filterDrivers: refuses a name that would inject config, and keeps the rest',
    JSON.stringify(hostile.usable) === JSON.stringify(['ok'])
      && JSON.stringify(hostile.rejected) === JSON.stringify(['a=b']),
    JSON.stringify(hostile));
  const injected = git([...BASE_ARGS, '-c', 'filter.a=b.clean=', 'config', '--get', 'filter.a'], flt);
  check('filterDrivers: that name really does set another key, which is why it is refused',
    injected.trim() === 'b.clean=',
    JSON.stringify(injected));

  check('filterDrivers: empty output means no drivers',
    filterDrivers('').usable.length === 0 && filterDrivers(undefined).usable.length === 0);
  check('filterOverrideArgs: nothing to override means no arguments',
    filterOverrideArgs([]).length === 0 && filterOverrideArgs(undefined).length === 0);

  // 7. the base branch setting, which reaches rev-parse and merge-base argv
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

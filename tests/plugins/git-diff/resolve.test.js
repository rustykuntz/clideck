// git.js hands the git runner to resolveRepo, resolveBase, listWorktrees and the readers, so all of
// them can be driven with a stub that records what was asked for and answers with canned output. No
// repository and no subprocess are needed for those, which is what this file uses:
//
//   1. resolveBase: which commit a diff is taken against, the candidate order it tries, and the
//      base branch setting it refuses to hand to git
//   2. resolveRepo: the repository root, the branch label for a detached or empty checkout, and the
//      mapping from a failed git call to an error code
//   3. listWorktrees: the porcelain reader
//   4. the argument builders, and the driver-name rule that keeps a name out of a -c key
//   5. makeGit's prefix, against real git, since the -c arguments have to precede the subcommand
//
//   node tests/plugins/git-diff/resolve.test.js

const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const {
  EMPTY_TREE, diffArgs, numstatArgs, isValidDriverName, makeGit,
  resolveRepo, resolveBase, listWorktrees,
} = require('../../../plugins/git-diff/git');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

// A stub runner in the shape makeGit returns: (args, cwd) => { ok, stdout, ... }. Replies are
// matched in order against the argv, and every call is recorded so the order of the candidates a
// caller tried can be asserted.
function stubGit(replies) {
  const calls = [];
  const git = async (args, cwd) => {
    calls.push({ args, cwd, argv: args.join(' ') });
    const hit = replies.find(([match]) => match(args.join(' ')));
    return hit ? hit[1] : { ok: false, stdout: '', stderr: '', message: 'not stubbed' };
  };
  return { git, calls, argvs: () => calls.map((c) => c.argv) };
}

const ok = (stdout) => ({ ok: true, stdout, stderr: '' });
const no = (extra = {}) => ({ ok: false, stdout: '', stderr: '', message: 'failed', ...extra });
const is = (argv) => (seen) => seen === argv;
const has = (fragment) => (seen) => seen.includes(fragment);

const HEAD_SHA = 'a'.repeat(40);
const MERGE_BASE = 'b'.repeat(40);

// The calls every committed repository answers the same way.
const COMMITTED = [
  [is('rev-parse --verify --quiet HEAD'), ok(`${HEAD_SHA}\n`)],
  [is('rev-parse HEAD'), ok(`${HEAD_SHA}\n`)],
];

async function main() {
  // 1a. Uncommitted scope. The diff is against HEAD, and none of the base detection runs.
  {
    const { git, argvs } = stubGit(COMMITTED);
    const base = await resolveBase(git, '/repo', 'uncommitted', '');
    check('uncommitted: the base is HEAD, labelled HEAD',
      base.base === 'HEAD' && base.baseLabel === 'HEAD' && base.baseFallback === false,
      JSON.stringify(base));
    check('uncommitted: no base branch is looked for',
      !argvs().some((a) => a.startsWith('merge-base') || a.startsWith('symbolic-ref')),
      argvs().join(' | '));
  }

  // 1b. A repository with no commits. There is no HEAD to diff against, so the empty tree stands in.
  {
    const { git } = stubGit([[is('rev-parse --verify --quiet HEAD'), no()]]);
    const local = await resolveBase(git, '/repo', 'uncommitted', '');
    check('empty repo: the base is the empty tree, labelled for the user',
      local.base === EMPTY_TREE && local.baseLabel === 'empty repo' && local.baseFallback === false,
      JSON.stringify(local));
    const wanted = await resolveBase(git, '/repo', 'base', '');
    check('empty repo: base scope falls back and says so',
      wanted.base === EMPTY_TREE && wanted.baseFallback === true,
      JSON.stringify(wanted));
  }

  // 1c. Base scope with no setting. origin/HEAD names the remote's default branch, so it is asked
  // for first and its answer is tried before the guessed names.
  {
    const { git, calls, argvs } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), ok('origin/trunk\n')],
      [is('rev-parse --verify --quiet origin/trunk^{commit}'), ok(`${'c'.repeat(40)}\n`)],
      [is('merge-base HEAD origin/trunk'), ok(`${MERGE_BASE}\n`)],
    ]);
    const base = await resolveBase(git, '/repo', 'base', '');
    check('base scope: origin/HEAD is consulted and its branch is the first candidate',
      argvs().includes('symbolic-ref --short refs/remotes/origin/HEAD')
        && argvs().find((a) => a.startsWith('rev-parse --verify --quiet origin')) === 'rev-parse --verify --quiet origin/trunk^{commit}',
      argvs().join(' | '));
    check('base scope: the base is the merge base and the label is the branch, not a sha',
      base.base === MERGE_BASE && base.baseLabel === 'origin/trunk',
      JSON.stringify(base));
    check('base scope: a base behind HEAD is not reported as HEAD',
      base.baseIsHead === false && base.baseFallback === false,
      JSON.stringify(base));
    check('base scope: every call runs in the repository root', calls.every((c) => c.cwd === '/repo'),
      JSON.stringify(calls.map((c) => c.cwd)));
  }

  // 1d. No origin/HEAD. The guessed names are tried in a fixed order, and only the one that resolves
  // is used.
  {
    const { git, argvs } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), no()],
      [is('rev-parse --verify --quiet master^{commit}'), ok(`${'d'.repeat(40)}\n`)],
      [has('rev-parse --verify --quiet'), ok('')],   // a ref that does not exist: quiet, empty, ok
      [is('merge-base HEAD master'), ok(`${MERGE_BASE}\n`)],
    ]);
    const base = await resolveBase(git, '/repo', 'base', '');
    const tried = argvs().filter((a) => a.startsWith('rev-parse --verify --quiet') && a.endsWith('^{commit}'));
    check('no origin/HEAD: candidates are tried in order, stopping at the first that resolves',
      tried.join(' ') === 'rev-parse --verify --quiet origin/main^{commit} '
        + 'rev-parse --verify --quiet origin/master^{commit} '
        + 'rev-parse --verify --quiet main^{commit} '
        + 'rev-parse --verify --quiet master^{commit}',
      tried.join('\n'));
    check('no origin/HEAD: the candidate that resolved is the base', base.baseLabel === 'master' && base.base === MERGE_BASE,
      JSON.stringify(base));
  }

  // A ref that resolves but whose merge base cannot be worked out is no use either, so the next
  // candidate is tried rather than the diff failing.
  {
    const { git } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), no()],
      [has('rev-parse --verify --quiet origin/main^{commit}'), ok(`${'e'.repeat(40)}\n`)],
      [is('merge-base HEAD origin/main'), no()],                    // unrelated history
      [has('rev-parse --verify --quiet origin/master^{commit}'), ok(`${'f'.repeat(40)}\n`)],
      [is('merge-base HEAD origin/master'), ok(`${MERGE_BASE}\n`)],
    ]);
    const base = await resolveBase(git, '/repo', 'base', '');
    check('a candidate with no merge base is skipped for the next one',
      base.baseLabel === 'origin/master' && base.base === MERGE_BASE, JSON.stringify(base));
  }

  // On the base branch itself the merge base is HEAD, so the panel says the two scopes show the same.
  {
    const { git } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), ok('origin/main\n')],
      [has('rev-parse --verify --quiet origin/main^{commit}'), ok(`${HEAD_SHA}\n`)],
      [is('merge-base HEAD origin/main'), ok(`${HEAD_SHA}\n`)],
    ]);
    const base = await resolveBase(git, '/repo', 'base', '');
    check('a merge base equal to HEAD is reported as such', base.baseIsHead === true, JSON.stringify(base));
  }

  // Nothing to compare against: uncommitted work is shown instead, and the fallback is reported so
  // the panel can say why the scope did not change what is on screen.
  {
    const { git } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), no()],
      [has('rev-parse --verify --quiet'), ok('')],
    ]);
    const base = await resolveBase(git, '/repo', 'base', '');
    check('no candidate resolves: falls back to HEAD and says so',
      base.base === 'HEAD' && base.baseLabel === 'HEAD' && base.baseFallback === true,
      JSON.stringify(base));
  }

  // 1e. The setting. A valid name is the only candidate; nothing is guessed behind it.
  {
    const { git, argvs } = stubGit([
      ...COMMITTED,
      [is('rev-parse --verify --quiet develop^{commit}'), ok(`${'0'.repeat(40)}\n`)],
      [is('merge-base HEAD develop'), ok(`${MERGE_BASE}\n`)],
    ]);
    const base = await resolveBase(git, '/repo', 'base', 'develop');
    check('a valid base branch setting is used, and nothing is guessed behind it',
      base.baseLabel === 'develop' && base.badSetting === false
        && !argvs().some((a) => a.includes('origin/main') || a.includes('symbolic-ref')),
      argvs().join(' | '));
  }

  // A setting that is not a ref name never reaches git's argv. It would be read as an option or as
  // revision syntax of git's own, so it is dropped and the client is told.
  for (const hostile of ['--upload-pack=touch /tmp/x', '-x', 'a b', 'has..dots', 'brace@{0}', 'thing.lock']) {
    const { git, argvs } = stubGit([
      ...COMMITTED,
      [is('symbolic-ref --short refs/remotes/origin/HEAD'), no()],
      [has('rev-parse --verify --quiet'), ok('')],
    ]);
    const base = await resolveBase(git, '/repo', 'base', hostile);
    check(`a base branch setting of ${JSON.stringify(hostile)} is refused and never reaches git`,
      base.badSetting === true && !argvs().some((a) => a.includes(hostile)),
      `${JSON.stringify(base)}\n${argvs().join(' | ')}`);
  }
  check('no setting is not a bad setting',
    (await resolveBase(stubGit(COMMITTED).git, '/repo', 'uncommitted', '')).badSetting === false);

  // 2. resolveRepo. The root, the branch label, and what a failed call becomes.
  {
    const { git, calls } = stubGit([
      [is('rev-parse --show-toplevel'), ok('/repo\n')],
      [is('rev-parse --abbrev-ref HEAD'), ok('feature/thing\n')],
    ]);
    const repo = await resolveRepo(git, '/repo/sub/folder');
    check('resolveRepo: the root is the toplevel, trimmed, and the branch is its name',
      repo.ok === true && repo.repoRoot === '/repo' && repo.branch === 'feature/thing',
      JSON.stringify(repo));
    check('resolveRepo: the branch is asked for in the root, not the folder that was passed in',
      calls[0].cwd === '/repo/sub/folder' && calls[1].cwd === '/repo',
      JSON.stringify(calls.map((c) => [c.argv, c.cwd])));
  }
  {
    const { git } = stubGit([[is('rev-parse --show-toplevel'), ok('\n')]]);
    const repo = await resolveRepo(git, '/tmp');
    check('resolveRepo: an empty toplevel is not a repository',
      repo.ok === false && repo.code === 'not-a-repo' && repo.message.includes('/tmp'),
      JSON.stringify(repo));
  }
  for (const [label, reply, code] of [
    ['git is not installed', no({ missing: true }), 'no-git'],
    ['git timed out', no({ timedOut: true }), 'timeout'],
    ['the folder is not a repository', no(), 'not-a-repo'],
  ]) {
    const { git } = stubGit([[is('rev-parse --show-toplevel'), reply]]);
    const repo = await resolveRepo(git, '/tmp');
    check(`resolveRepo: ${label} reads as ${code}`, repo.ok === false && repo.code === code, JSON.stringify(repo));
  }
  {
    const { git } = stubGit([
      [is('rev-parse --show-toplevel'), ok('/repo\n')],
      [is('rev-parse --abbrev-ref HEAD'), ok('HEAD\n')],
      [is('rev-parse --short HEAD'), ok('1a2b3c4\n')],
    ]);
    check('resolveRepo: a detached HEAD is named by its short sha',
      (await resolveRepo(git, '/repo')).branch === 'detached at 1a2b3c4');
  }
  {
    const { git } = stubGit([
      [is('rev-parse --show-toplevel'), ok('/repo\n')],
      [has('rev-parse'), no()],
    ]);
    check('resolveRepo: a repository with no commits is labelled as such',
      (await resolveRepo(git, '/repo')).branch === 'no commits yet');
  }

  // 3. The worktree list, in the porcelain form git prints.
  {
    const porcelain = [
      'worktree /home/me/repo',
      `HEAD ${HEAD_SHA}`,
      'branch refs/heads/main',
      '',
      'worktree /home/me/repo/.worktrees/my feature',
      `HEAD ${MERGE_BASE}`,
      'branch refs/heads/feature/thing',
      '',
      'worktree /home/me/repo/.worktrees/loose',
      `HEAD ${MERGE_BASE}`,
      'detached',
      '',
      'worktree /home/me/mirror.git',
      'bare',
      '',
    ].join('\n');
    const { git } = stubGit([[is('worktree list --porcelain'), ok(porcelain)]]);
    const trees = await listWorktrees(git, '/home/me/repo');
    check('worktrees: one record per checkout, bare ones left out',
      trees.length === 3 && !trees.some((t) => t.path.endsWith('mirror.git')),
      JSON.stringify(trees));
    check('worktrees: refs/heads/ is stripped from the branch',
      trees[0].branch === 'main' && trees[1].branch === 'feature/thing',
      JSON.stringify(trees.map((t) => t.branch)));
    check('worktrees: a path containing a space survives',
      trees[1].path === '/home/me/repo/.worktrees/my feature', JSON.stringify(trees[1]));
    check('worktrees: a detached checkout is flagged and has no branch',
      trees[2].detached === true && trees[2].branch === '', JSON.stringify(trees[2]));
    check('worktrees: the HEAD lines are not read as anything',
      trees.every((t) => !t.path.startsWith('HEAD')), JSON.stringify(trees.map((t) => t.path)));
  }
  {
    const { git } = stubGit([[is('worktree list --porcelain'), no()]]);
    check('worktrees: a failed call means no choices, not a crash',
      JSON.stringify(await listWorktrees(git, '/repo')) === '[]');
  }
  {
    // A branch line before any worktree line has nothing to attach to.
    const { git } = stubGit([[is('worktree list --porcelain'), ok('branch refs/heads/stray\n\nworktree /repo\nbranch refs/heads/main\n')]]);
    const trees = await listWorktrees(git, '/repo');
    check('worktrees: a stray field before the first record is ignored',
      trees.length === 1 && trees[0].path === '/repo' && trees[0].branch === 'main',
      JSON.stringify(trees));
  }

  // 4. The argument builders. Their effect is checked in safety.test.js against real git;
  // what is asserted here is the argv itself, since the context setting and the base both land in it.
  check('diffArgs: the exact argument list, with the base last',
    JSON.stringify(diffArgs('HEAD', 3))
      === JSON.stringify(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U3', 'HEAD']),
    JSON.stringify(diffArgs('HEAD', 3)));
  check('diffArgs: the context setting is the one in -U',
    diffArgs('abc123', 0).includes('-U0') && diffArgs('abc123', 20).includes('-U20'),
    JSON.stringify([diffArgs('abc123', 0), diffArgs('abc123', 20)]));
  check('numstatArgs: the exact argument list, NUL separated, with the base last',
    JSON.stringify(numstatArgs(EMPTY_TREE))
      === JSON.stringify(['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames', EMPTY_TREE]),
    JSON.stringify(numstatArgs(EMPTY_TREE)));

  // A driver name goes into a -c key, which git splits on the first =, so the rule is checked
  // directly as well as through filterDrivers in safety.test.js.
  for (const good of ['lfs', 'dotted.name', 'A_b-1', 'demo']) {
    check(`isValidDriverName: accepts ${good}`, isValidDriverName(good) === true);
  }
  for (const bad of ['a=b', 'a b', '', 'a\nb', 'quote"name', 'unïcode', undefined, null]) {
    check(`isValidDriverName: rejects ${JSON.stringify(bad)}`, isValidDriverName(bad) === false);
  }

  // 5. makeGit's prefix, against real git. -c has to come before the subcommand, so this asks git
  // itself what configuration it was run with.
  const dir = mkdtempSync(join(tmpdir(), 'clideck-git-resolve-'));
  try {
    const listed = await makeGit(['demo'])(['config', '--list'], dir);
    check('makeGit: the hardening reaches git, before the subcommand',
      listed.ok && listed.stdout.includes('core.quotepath=false') && listed.stdout.includes('core.fsmonitor='),
      `${listed.ok} ${JSON.stringify(listed.stdout.split('\n').filter((l) => l.startsWith('core.')))}`);
    check('makeGit: a named driver is switched off, both commands and the required flag',
      listed.stdout.includes('filter.demo.clean=')
        && listed.stdout.includes('filter.demo.process=')
        && listed.stdout.includes('filter.demo.required=false'),
      JSON.stringify(listed.stdout.split('\n').filter((l) => l.startsWith('filter.'))));
    // The user's own global config may define drivers of its own, so what is asserted is that no
    // override was added, not that git reports no filters at all.
    const bare = await makeGit()(['config', '--list'], dir);
    check('makeGit: no drivers means no overrides are added',
      !bare.stdout.includes('.clean=\n') && !bare.stdout.includes('.required=false'),
      JSON.stringify(bare.stdout.split('\n').filter((l) => l.startsWith('filter.'))));

    // A failing call resolves rather than throwing, since every caller branches on ok.
    const outside = await makeGit()(['rev-parse', '--show-toplevel'], dir);
    check('makeGit: a folder that is no repository fails without throwing',
      outside.ok === false && !!outside.message && outside.missing !== true,
      JSON.stringify(outside));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((e) => { console.error(e); failed++; })
  .finally(() => {
    if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
    console.log('\nall git-diff resolve checks passed');
  });

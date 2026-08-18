// Everything that runs git and reads what it prints: the arguments, the calls, and the readers
// for their output. Kept apart from index.js so the plugin's own code reads as what it does with
// a diff rather than how it obtains one.
//
// Three rules hold throughout.
//
// Nothing here writes to the repository: no add, no index updates, read-only commands only.
//
// Nothing reaches git's argv unchecked. The base branch setting is the only value a user types
// that gets there, and a ref name is what it has to look like.
//
// A folder outside the session's repository does not get to run the commands its own config
// names, as far as git allows. Several config keys name a command git executes during an
// ordinary diff, and this panel re-runs git every few seconds with no user action beyond opening
// it, so the arguments below switch off the ones that can be switched off and riskyKeys reports
// the rest for the user to decide on.
//
// No npm dependencies, so the tests can drive all of this in a checkout where the plugin has
// not been installed.

const { execFile } = require('child_process');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_TIMEOUT = 15000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Applied to every git call. quotepath=false keeps non-ASCII paths readable in the patch.
const GLOBAL_ARGS = ['-c', 'core.quotepath=false'];

// Applied on top of the above in a folder outside the session's own repository. Setting
// core.fsmonitor to nothing stops git running the repository's monitor hook. It is left alone
// for trusted folders, where it is the user's own setting and worth real speed on a large repo.
const UNTRUSTED_ARGS = ['-c', 'core.fsmonitor='];

// --no-ext-diff drops diff.external, --no-textconv drops the textconv drivers. Both cost
// output a diff panel does not need: an external driver's formatting, and text extracted from
// binary files such as PDFs, which show as binary instead. Both run a command per poll.
function diffArgs(base, context) {
  return ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', `-U${context}`, base];
}

// Same guards, used for the file list when a patch is too large to parse.
function numstatArgs(base) {
  return ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames', base];
}

const RISKY_EXACT = new Set(['diff.external', 'core.fsmonitor', 'core.hookspath']);
const RISKY_LEAVES = { diff: new Set(['textconv', 'command']), filter: new Set(['clean', 'smudge', 'process']) };

// git config lowercases the section and the last segment but keeps the middle one as written,
// so a driver called "Demo" stays "Demo" while "CLEAN" arrives as "clean".
function isRiskyKey(key) {
  const lower = String(key).toLowerCase();
  if (RISKY_EXACT.has(lower)) return true;
  const parts = lower.split('.');
  if (parts.length < 3) return false;
  return !!RISKY_LEAVES[parts[0]]?.has(parts[parts.length - 1]);
}

// Reads the output of `git config --local --list -z`, whose records are "key\nvalue" separated
// by NULs, and returns the keys that name a command. Matching happens here rather than through
// git config --get-regexp so the patterns stay under our control. --local covers keys pulled in
// by include.path from the repository's own config file, since git resolves those while parsing
// it.
//
// filter.<driver>.clean is reported but cannot be switched off per invocation: git has no flag
// for it, and it runs whenever a worktree file is compared against a blob. Reporting it is the
// only handling available, which is why an untrusted folder needs the user to say go ahead.
function riskyKeys(configListZ) {
  const found = [];
  for (const record of String(configListZ || '').split('\0')) {
    if (!record) continue;
    const key = record.split('\n')[0];
    if (key && isRiskyKey(key)) found.push(key);
  }
  return found;
}

// The base branch setting goes into git's argv, so it has to be a plausible ref name and not an
// option. A leading dash would be read as one, and the rest of the characters below are either
// illegal in a ref name or revision syntax git would resolve to something else.
//
// A regex rather than `git check-ref-format` or `--end-of-options`: the first costs another
// subprocess per diff, the second needs git 2.24 and would quietly change base detection on
// anything older.
function isValidRefName(value) {
  const name = String(value || '');
  if (!name || name.startsWith('-') || name.startsWith('/') || name.startsWith('.')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\]/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  return true;
}

// GIT_OPTIONAL_LOCKS=0 stops `git diff` taking index.lock to refresh the index stat cache.
// Without it, polling a folder where an agent is also running git can collide on that lock.
// GIT_TERMINAL_PROMPT=0 stops git ever blocking on a credential prompt.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

// Run git and never throw — callers branch on ok.
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: GIT_ENV, timeout: GIT_TIMEOUT, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const out = (stdout || Buffer.alloc(0)).toString('utf8');
      const errOut = (stderr || Buffer.alloc(0)).toString('utf8');
      if (!err) return resolve({ ok: true, stdout: out, stderr: errOut });
      resolve({
        ok: false,
        stdout: out,
        stderr: errOut,
        missing: err.code === 'ENOENT',
        timedOut: !!err.killed,
        message: errOut.trim() || err.message,
      });
    });
  });
}

// Every git call goes through one of these. The trusted one leaves the repository's own
// settings alone; the untrusted one switches off what ./safety can switch off. -c has to come
// before the subcommand, which is why it is prepended here rather than passed by the callers.
function makeGit(untrusted) {
  const prefix = untrusted ? [...GLOBAL_ARGS, ...UNTRUSTED_ARGS] : GLOBAL_ARGS;
  return (args, cwd) => runGit([...prefix, ...args], cwd);
}

const trustedGit = makeGit(false);

async function resolveRepo(git, cwd) {
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) {
    if (top.missing) return { ok: false, code: 'no-git', message: 'git was not found on PATH' };
    if (top.timedOut) return { ok: false, code: 'timeout', message: 'git rev-parse timed out' };
    return { ok: false, code: 'not-a-repo', message: `Not a git repository: ${cwd}` };
  }
  const repoRoot = top.stdout.trim();
  if (!repoRoot) return { ok: false, code: 'not-a-repo', message: `Not a git repository: ${cwd}` };

  const named = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  let branch = named.ok ? named.stdout.trim() : '';
  if (!branch || branch === 'HEAD') {
    const short = await git(['rev-parse', '--short', 'HEAD'], repoRoot);
    branch = short.ok && short.stdout.trim() ? `detached at ${short.stdout.trim()}` : 'no commits yet';
  }
  return { ok: true, repoRoot, branch };
}

async function hasCommits(git, repoRoot) {
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
  return head.ok && !!head.stdout.trim();
}

// Which commit the diff is taken against, and what to call it in the header.
async function resolveBase(git, repoRoot, scope, baseBranchSetting) {
  const committed = await hasCommits(git, repoRoot);
  const localBase = committed ? 'HEAD' : EMPTY_TREE;
  const localLabel = committed ? 'HEAD' : 'empty repo';

  // The setting reaches git's argv, so a name that is not a ref name is dropped rather than
  // handed over. The client says so, since silently ignoring it looks like a broken setting.
  const badSetting = !!baseBranchSetting && !isValidRefName(baseBranchSetting);
  const wanted = badSetting ? '' : baseBranchSetting;

  if (scope !== 'base') return { base: localBase, baseLabel: localLabel, baseFallback: false, badSetting };
  if (!committed) return { base: localBase, baseLabel: localLabel, baseFallback: true, badSetting };

  const candidates = [];
  if (wanted) {
    candidates.push(wanted);
  } else {
    const originHead = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
    if (originHead.ok && originHead.stdout.trim()) candidates.push(originHead.stdout.trim());
    candidates.push('origin/main', 'origin/master', 'main', 'master');
  }

  const head = await git(['rev-parse', 'HEAD'], repoRoot);
  const headSha = head.ok ? head.stdout.trim() : '';

  for (const candidate of candidates) {
    const exists = await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], repoRoot);
    if (!exists.ok || !exists.stdout.trim()) continue;
    const mergeBase = await git(['merge-base', 'HEAD', candidate], repoRoot);
    if (!mergeBase.ok || !mergeBase.stdout.trim()) continue;
    const base = mergeBase.stdout.trim();
    // On the base branch itself the merge base is HEAD, so this scope shows nothing extra.
    return { base, baseLabel: candidate, baseFallback: false, baseIsHead: base === headSha, badSetting };
  }
  // Nothing to compare against — show uncommitted work instead and say so.
  return { base: localBase, baseLabel: localLabel, baseFallback: true, badSetting };
}

// Every worktree attached to this repository, main checkout included. A session started in
// the main checkout can therefore offer its worktrees as targets, which is the common case
// when an agent works on a branch in a worktree.
async function listWorktrees(git, repoRoot) {
  const listed = await git(['worktree', 'list', '--porcelain'], repoRoot);
  if (!listed.ok) return [];
  const trees = [];
  let current = null;
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9).trim(), branch: '', detached: false, bare: false };
      trees.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  return trees.filter((t) => t.path && !t.bare);
}

// Whether the plugin may hand a folder's own git configuration to git. Diffing a repository
// runs commands it names in diff.external, diff.<driver>.textconv, filter.<driver>.clean and
// core.fsmonitor, and this panel re-runs git every few seconds on its own. The session's folder
// and the worktrees of its repository are trusted: that is where the user's agent already runs.
// Anything else has its configuration read first, and a folder that names a command needs the
// user to say go ahead.
//
// rev-parse and config run no hooks or filters, so probing is safe. They still go through the
// untrusted git, which switches off core.fsmonitor.
async function assessTrust(sessionCwd, folder) {
  if (!folder || folder === sessionCwd) return { trusted: true, riskyKeys: [] };

  const untrustedGit = makeGit(true);
  const sessionRepo = await resolveRepo(trustedGit, sessionCwd);
  if (sessionRepo.ok) {
    const trees = await listWorktrees(trustedGit, sessionRepo.repoRoot);
    const own = new Set([sessionRepo.repoRoot, ...trees.map((t) => t.path)]);
    const top = await untrustedGit(['rev-parse', '--show-toplevel'], folder);
    if (top.ok && own.has(top.stdout.trim())) return { trusted: true, riskyKeys: [] };
  }

  const config = await untrustedGit(['config', '--local', '--list', '-z'], folder);
  return { trusted: false, riskyKeys: config.ok ? riskyKeys(config.stdout) : [] };
}

// The patch for tracked files. The argument list is this module's business, so callers ask for
// a diff rather than assembling one.
function diffPatch(git, repoRoot, base, context) {
  return git(diffArgs(base, context), repoRoot);
}

// The untracked paths, sorted so the synthesised patch is stable between polls. An empty list
// covers both "none" and "git would not say", which read the same in the panel.
async function listUntracked(git, repoRoot) {
  const listed = await git(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
  if (!listed.ok) return [];
  return listed.stdout.split('\0').filter(Boolean).sort();
}

// The file list when the patch is too large to parse. numstat covers tracked files only, so the
// untracked side comes from the scan's own records. -z records are "adds\tdels\tpath", except a
// rename, which is "adds\tdels\t" followed by the old and new paths as separate records, and a
// binary file, which reports "-" for both counts.
function parseNumstat(out) {
  const fields = String(out || '').split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw] = parts;
    let path = parts.slice(2).join('\t');
    let oldPath = '';
    if (!path) {
      oldPath = fields[++i] || '';
      path = fields[++i] || '';
    }
    files.push({
      path,
      oldPath,
      additions: addRaw === '-' ? 0 : Number(addRaw) || 0,
      deletions: delRaw === '-' ? 0 : Number(delRaw) || 0,
      isNew: false,
      isDeleted: false,
      isRename: !!oldPath,
      isBinary: addRaw === '-' && delRaw === '-',
      isTooBig: false,
      oversizedBytes: 0,
      longestLine: 0,
    });
  }
  return files;
}

// Per-file counts without a patch, for a diff too large to parse. Tracked files only, since git
// never reports an untracked file in a diff.
async function numstatFiles(git, repoRoot, base) {
  const numstat = await git(numstatArgs(base), repoRoot);
  return numstat.ok ? parseNumstat(numstat.stdout) : [];
}


module.exports = {
  EMPTY_TREE,
  GLOBAL_ARGS,
  UNTRUSTED_ARGS,
  diffArgs,
  numstatArgs,
  isRiskyKey,
  riskyKeys,
  isValidRefName,
  makeGit,
  trustedGit,
  resolveRepo,
  resolveBase,
  listWorktrees,
  assessTrust,
  diffPatch,
  listUntracked,
  numstatFiles,
  parseNumstat,
};

// Running git inside a folder means running that folder's git configuration. Several config
// keys name a command that git executes as part of an ordinary diff: diff.external,
// diff.<driver>.textconv, filter.<driver>.clean and core.fsmonitor all do. This panel re-runs
// git every few seconds without the user typing anything, so a folder chosen in the picker
// would otherwise run whatever its .git/config says, over and over.
//
// What is here: the argument lists that switch off the vectors git lets us switch off, the
// check for the ones it does not, and the ref-name check for the base branch setting.
//
// No npm dependencies, so the tests can drive this in a checkout where the plugin has not
// been installed.

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

module.exports = {
  GLOBAL_ARGS, UNTRUSTED_ARGS, diffArgs, numstatArgs, isRiskyKey, riskyKeys, isValidRefName,
};

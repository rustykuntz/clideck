// The Git Diff panel's replies are broadcast to every open browser tab, so a cache entry that only
// names a session can be read by a tab that did not build it. Two tabs on one session, pointed at
// different folders, would take turns overwriting the single entry, and Copy patch would hand back
// whichever folder wrote last. The same happens inside one tab: it can have two requests in flight,
// and the slower one can land last while the panel shows the other.
//
// The fix is the key. diffKey() names the session, the scope, the folder and every setting that
// shaped the patch, so those diffs are separate entries and each reader addresses the one it means.
// What is asserted here:
//
//   1. two folders on one session are two entries, each returning its own patch
//   2. the same view asked for twice is one entry, so tabs showing it share the build
//   3. scope, contextLines, maxChanges and baseBranch each separate entries
//   4. belongsTo accepts a key for its own session and refuses one for another, including when a
//      folder path contains the separator
//   5. entries expire by age, by count, by total bytes, and when their session ends
//   6. rebuilding a diff moves its entry to the back of the eviction order
//
//   node tests/plugins/git-diff-cache.test.js

const {
  CACHE_MAX, CACHE_MAX_BYTES, CACHE_TTL, diffKey, belongsTo, makeCache,
} = require('../../plugins/git-diff/cache');

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}`);
  if (!cond) { failed++; if (detail !== undefined) console.log(`        ${String(detail).replace(/\n/g, '\n        ')}`); }
}

// The shape index.js stores: a built diff whose patch is the thing Copy patch returns.
function built(patch) {
  return { patch, totals: { files: 1, additions: 1, deletions: 0 }, patchBytes: patch.length };
}

const SETTINGS = { contextLines: 3, maxChanges: 20000, baseBranch: '' };

// A clock the test drives, so the age rules can be checked without waiting five minutes.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// 1. Two tabs on one session, different folders. The regression the review comment names.
{
  const cache = makeCache();
  const keyA = diffKey('s1', 'uncommitted', '/repo', SETTINGS);
  const keyB = diffKey('s1', 'uncommitted', '/repo/.worktrees/wt', SETTINGS);
  cache.set(keyA, { sessionId: 's1', built: built('PATCH-REPO'), bytes: 10 });
  cache.set(keyB, { sessionId: 's1', built: built('PATCH-WORKTREE'), bytes: 14 });
  check('two folders on one session are two entries', cache.size() === 2, cache.keys());
  check('each folder returns its own patch',
    cache.get(keyA).built.patch === 'PATCH-REPO' && cache.get(keyB).built.patch === 'PATCH-WORKTREE',
    [cache.get(keyA).built.patch, cache.get(keyB).built.patch]);
  // The old behaviour: an entry addressed by session alone. Nothing answers to a bare session id.
  check('a bare session id addresses nothing', cache.get('s1') === null);
}

// 2. The same view twice is one entry, so a second tab reuses the first tab's build.
{
  const cache = makeCache();
  const key = diffKey('s1', 'base', '/repo', SETTINGS);
  check('the same view produces the same key', key === diffKey('s1', 'base', '/repo', { ...SETTINGS }));
  cache.set(key, { sessionId: 's1', built: built('ONE'), bytes: 3 });
  cache.set(key, { sessionId: 's1', built: built('ONE'), bytes: 3 });
  check('the same view is cached once', cache.size() === 1, cache.keys());
}

// 3. Every input that changes the patch changes the key.
{
  const base = diffKey('s1', 'uncommitted', '/repo', SETTINGS);
  const differs = (label, ...args) => check(`${label} separates entries`, diffKey(...args) !== base, diffKey(...args));
  differs('scope', 's1', 'base', '/repo', SETTINGS);
  differs('folder', 's1', 'uncommitted', '/other', SETTINGS);
  differs('session', 's2', 'uncommitted', '/repo', SETTINGS);
  differs('contextLines', 's1', 'uncommitted', '/repo', { ...SETTINGS, contextLines: 10 });
  differs('maxChanges', 's1', 'uncommitted', '/repo', { ...SETTINGS, maxChanges: 500 });
  differs('baseBranch', 's1', 'uncommitted', '/repo', { ...SETTINGS, baseBranch: 'develop' });
  // An unset base branch is the same request as an empty one, so it must not split the entry.
  check('an unset base branch reads the same as an empty one',
    diffKey('s1', 'uncommitted', '/repo', { contextLines: 3, maxChanges: 20000 }) === base, base);
}

// 4. A key arrives from a browser with Copy patch, so it is checked against the session it claims.
{
  const key = diffKey('s1', 'uncommitted', '/repo', SETTINGS);
  check('a key is accepted for its own session', belongsTo(key, 's1') === true);
  check('a key is refused for another session', belongsTo(key, 's2') === false);
  check('a missing key is refused', belongsTo(undefined, 's1') === false && belongsTo('', 's1') === false);
  check('a key is refused when no session is named', belongsTo(key, '') === false);
  // A path may contain the separator, so the check is a prefix test and not a split on '|'.
  const piped = diffKey('s1', 'uncommitted', '/repo/odd|name', SETTINGS);
  check('a folder containing the separator still belongs to its session',
    belongsTo(piped, 's1') === true && belongsTo(piped, 's2') === false, piped);
  // A session id that is a prefix of another must not reach across.
  check('a longer session id is not matched by a shorter one',
    belongsTo(diffKey('s10', 'uncommitted', '/repo', SETTINGS), 's1') === false);
}

// 5a. Age. An entry older than the TTL is gone whether it is read or pruned.
{
  const clock = fakeClock();
  const cache = makeCache({ now: clock.now });
  const key = diffKey('s1', 'uncommitted', '/repo', SETTINGS);
  cache.set(key, { sessionId: 's1', built: built('OLD'), bytes: 3 });
  clock.advance(CACHE_TTL - 1);
  check('inside the TTL: still cached', cache.get(key)?.built.patch === 'OLD');
  clock.advance(2);
  check('past the TTL: a read misses', cache.get(key) === null);
  cache.set(key, { sessionId: 's1', built: built('AGAIN'), bytes: 5 });
  clock.advance(CACHE_TTL + 1);
  cache.prune();
  check('past the TTL: prune drops it', cache.size() === 0, cache.keys());
}

// 5b. A session that has ended. The check reads the session id off the entry, since the key is no
// longer a session id: reading the key would drop every entry on the first prune.
{
  const live = new Set(['s1']);
  const cache = makeCache({ isLive: (id) => live.has(id) });
  const keyLive = diffKey('s1', 'uncommitted', '/repo', SETTINGS);
  const keyDead = diffKey('s2', 'uncommitted', '/repo', SETTINGS);
  cache.set(keyLive, { sessionId: 's1', built: built('LIVE'), bytes: 4 });
  cache.set(keyDead, { sessionId: 's2', built: built('DEAD'), bytes: 4 });
  cache.prune();
  check('a running session keeps its entry through a prune', cache.get(keyLive)?.built.patch === 'LIVE', cache.keys());
  check('a session that has ended loses its entry', cache.get(keyDead) === null);
  live.delete('s1');
  cache.prune();
  check('the last session ending empties the cache', cache.size() === 0, cache.keys());
}

// 5c. The count cap, oldest first.
{
  const cache = makeCache();
  for (let i = 0; i < CACHE_MAX + 5; i++) {
    cache.set(diffKey('s1', 'uncommitted', `/repo/${i}`, SETTINGS), { sessionId: 's1', built: built(`P${i}`), bytes: 2 });
  }
  cache.prune();
  check('the count cap holds', cache.size() === CACHE_MAX, cache.size());
  check('the count cap evicts oldest first',
    cache.get(diffKey('s1', 'uncommitted', '/repo/0', SETTINGS)) === null
      && cache.get(diffKey('s1', 'uncommitted', `/repo/${CACHE_MAX + 4}`, SETTINGS)) !== null,
    cache.keys());
}

// 5d. The byte cap. One enormous diff can outweigh every other entry, so bytes are capped too.
{
  const cache = makeCache();
  const small = diffKey('s1', 'uncommitted', '/repo/small', SETTINGS);
  const huge = diffKey('s1', 'uncommitted', '/repo/huge', SETTINGS);
  cache.set(small, { sessionId: 's1', built: built('SMALL'), bytes: 1024 });
  cache.set(huge, { sessionId: 's1', built: built('HUGE'), bytes: CACHE_MAX_BYTES });
  cache.prune();
  check('the byte cap evicts the oldest entry, not the largest',
    cache.get(small) === null && cache.get(huge) !== null, cache.keys());
  check('the byte cap stops once the total fits', cache.size() === 1, cache.keys());
}

// 6. A rebuilt diff is the newest entry. Without this, an entry rebuilt on every poll would keep
// its original place in the eviction order and be dropped while it is the one in use.
{
  const cache = makeCache();
  const first = diffKey('s1', 'uncommitted', '/repo/first', SETTINGS);
  for (let i = 0; i < CACHE_MAX; i++) {
    cache.set(i === 0 ? first : diffKey('s1', 'uncommitted', `/repo/${i}`, SETTINGS),
      { sessionId: 's1', built: built(`P${i}`), bytes: 2 });
  }
  cache.set(first, { sessionId: 's1', built: built('REBUILT'), bytes: 2 });   // polled again
  check('rebuilding does not duplicate the entry', cache.size() === CACHE_MAX, cache.size());
  cache.set(diffKey('s1', 'uncommitted', '/repo/new', SETTINGS), { sessionId: 's1', built: built('NEW'), bytes: 2 });
  cache.prune();
  check('a rebuilt entry survives the eviction it would otherwise have hit',
    cache.get(first)?.built.patch === 'REBUILT', cache.keys());
  check('the entry evicted instead is the one untouched for longest',
    cache.get(diffKey('s1', 'uncommitted', '/repo/1', SETTINGS)) === null, cache.keys());
}

console.log(failed ? `\n  ${failed} check(s) failed` : '\n  all checks passed');
process.exit(failed ? 1 : 0);

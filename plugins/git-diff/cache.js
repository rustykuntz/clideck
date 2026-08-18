// The built-diff cache. Two readers: a layout toggle, which re-renders a diff already built, and
// Copy patch, which needs its patch text.
//
// Keyed by everything that shapes a diff, not by session. Plugin replies are broadcast to every
// open browser tab, and two tabs on one session can be pointed at different folders or scopes, so
// an entry that only names a session can be handed to the tab that did not build it. Two requests
// from a single tab can also be in flight at once, and the last one to finish is not necessarily
// the one on screen. With the inputs in the key both entries live side by side, and each reader
// names the one it means.

const CACHE_MAX = 20;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000;

// Also the key index.js gives to its in-flight map, so one build serves every request for the same
// diff. Settings are read here rather than arriving already joined, so the format lives in one
// place.
function diffKey(sessionId, scope, folder, settings = {}) {
  return [
    sessionId, scope, folder,
    settings.contextLines, settings.maxChanges, settings.baseBranch || '',
  ].join('|');
}

// Whether a key names this session, for a reader handed a key by a browser. A prefix test rather
// than a split on '|', since a folder path may contain one.
function belongsTo(key, sessionId) {
  return typeof key === 'string' && !!sessionId && key.startsWith(`${sessionId}|`);
}

// isLive(sessionId) reports whether a session is still running, so entries for sessions that have
// gone can be dropped. now() is injectable so the expiry rule can be tested without waiting.
function makeCache({ isLive = () => true, now = () => Date.now() } = {}) {
  const entries = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now() - entry.at > CACHE_TTL) { entries.delete(key); return null; }
    return entry;
  }

  function set(key, { sessionId, built, bytes = 0 }) {
    // Deleted first so the key moves to the back. Map iterates in insertion order, which is what
    // both caps below evict by, and a diff just rebuilt is the newest entry, not the oldest.
    entries.delete(key);
    entries.set(key, { sessionId, built, bytes, at: now() });
  }

  function prune() {
    const at = now();
    for (const [key, entry] of entries) {
      if (at - entry.at > CACHE_TTL || !isLive(entry.sessionId)) entries.delete(key);
    }
    while (entries.size > CACHE_MAX) entries.delete(entries.keys().next().value);
    // A single large diff can hold more memory than every other entry together, so the cache is
    // bounded by bytes as well as by count. Oldest first, same as the count rule.
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.bytes;
    for (const [key, entry] of entries) {
      if (bytes <= CACHE_MAX_BYTES) break;
      bytes -= entry.bytes;
      entries.delete(key);
    }
  }

  return { get, set, prune, size: () => entries.size, keys: () => [...entries.keys()] };
}

module.exports = { CACHE_MAX, CACHE_MAX_BYTES, CACHE_TTL, diffKey, belongsTo, makeCache };

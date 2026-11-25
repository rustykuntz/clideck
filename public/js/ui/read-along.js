// Host-owned read-along. A plugin supplies the exact text it spoke plus cues carrying REAL audio times
// (concatenated sample boundaries), and never gets DOM or xterm access in return. The surface resolves that
// text against its own content ONCE, when playback starts, so a time update only picks an already-prepared
// range — never a search while the audio runs.
//
// A cue is a WINDOW, never a single word: the plugin advances one source word at a time and each cue covers
// three of them — "Item 3 is" → "3 is now" → "is now your". The times are estimated from the text and pulled
// straight again at every real chunk boundary; three words is a wider target than one, not a promise that the
// drift fits inside it. Nothing here points at one word, because nothing here knows which word is being said.

const MAX_SOURCE_CHARS = 8192;    // the SDK caps spoken text at 8 000; this is that with headroom
const MAX_CUES = 8192;            // one window per word advance, so the ceiling is the CHARACTER cap, not chunks
const MAX_ANCHOR_CHARS = 256;

const surfaces = new Map();
let active = null;

// The user's switch for the whole mark — highlight AND the follow-scroll that comes with it. On by default;
// off is remembered. Off never stops the timeline: playback keeps choosing cues, it just paints nothing, so
// switching back on mid-read lands on the words being spoken now.
const ENABLED_KEY = "clideck.readAlong";
let enabled = (() => { try { return localStorage.getItem(ENABLED_KEY) !== "off"; } catch { return true; } })();
export function readAlongEnabled() { return enabled; }
export function setReadAlongEnabled(on) {
  enabled = !!on;
  try { enabled ? localStorage.removeItem(ENABLED_KEY) : localStorage.setItem(ENABLED_KEY, "off"); } catch {}
  if (!active) return;
  active.index = -1;                                          // repaint (or clear) on the next clock tick
  if (!enabled) { try { active.handle.clear(); } catch {} }
}

export function registerReadAlongSurface(name, resolve) {
  if (typeof name !== "string" || typeof resolve !== "function") return () => {};
  surfaces.set(name, resolve);
  return () => { if (surfaces.get(name) === resolve) surfaces.delete(name); };
}

// Plugin input is untrusted, and a PARTIAL timeline is worse than none — it would light the wrong chunk with
// full confidence. So every field is checked and one bad entry rejects the whole payload.
// Windows OVERLAP by design, so the only ordering rule is that `start` never goes backwards. `end` is
// validated but never used to choose the window — the current one is simply the last one that has started,
// which is what holds the highlight through a gap instead of blinking it off.
const SURFACES = new Set(["terminal", "viewer"]);
function timeline(value) {
  if (!value || !SURFACES.has(value.surface) || !value.sessionId) return null;
  // A document tab can change under a long read, so `viewer` has to say WHICH document it read.
  const contentId = typeof value.contentId === "string" ? value.contentId : "";
  if (value.surface === "viewer" && !contentId) return null;
  // Where this clip's text sits in the text the host handed the plugin. With it the surface verifies that one
  // slice and never searches, so a document that repeats itself cannot map to the wrong copy.
  const offset = Number(value.sourceOffset);
  const sourceOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : -1;
  const sourceText = typeof value.sourceText === "string" ? value.sourceText : "";
  if (!sourceText.trim() || sourceText.length > MAX_SOURCE_CHARS) return null;
  if (!Array.isArray(value.cues) || !value.cues.length || value.cues.length > MAX_CUES) return null;
  const cues = [];
  let lastStart = -1;
  for (const raw of value.cues) {
    const start = Number(raw && raw.start), end = Number(raw && raw.end);
    const textStart = Math.floor(Number(raw && raw.textStart)), textEnd = Math.floor(Number(raw && raw.textEnd));
    if (![start, end, textStart, textEnd].every(Number.isFinite)) return null;
    if (start < 0 || end < start || start < lastStart) return null;                     // ordered, so a lookup can bisect
    if (textStart < 0 || textEnd <= textStart || textEnd > sourceText.length) return null;
    lastStart = start;
    cues.push({ start, end, textStart, textEnd });
  }
  // `timing` is the plugin saying how much its clock is worth. Estimated times get a softer wash with no
  // hard edge, because a crisp boundary on a guessed time reads as a claim we cannot make.
  const timing = value.timing === "estimated" ? "estimated" : "measured";
  // The anchor is an OPAQUE token the host minted for a selection and the plugin echoed back. Only the
  // surface that minted it can read it; here it is carried, length-capped, and nothing more.
  const anchor = typeof value.anchor === "string" && value.anchor.length <= MAX_ANCHOR_CHARS ? value.anchor : "";
  return { surface: value.surface, sessionId: String(value.sessionId), contentId, sourceText, sourceOffset, cues, timing, anchor };
}

// The last cue that has STARTED. Chunks are separated by a short synthesized silence; holding the current
// chunk across that gap is what makes the highlight read as one moving thing instead of a blink per sentence.
function cueAt(cues, seconds) {
  if (!Number.isFinite(seconds)) return -1;
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= seconds) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Fails CLOSED at every step: an unparseable timeline, an unknown surface, or a surface that cannot map the
// source completely all end the same way — no highlight, no message, playback untouched.
export function startReadAlong(value) {
  stopReadAlong();
  const meta = timeline(value);
  if (!meta) return false;
  let handle = null;
  try { handle = surfaces.get(meta.surface)?.(meta) || null; } catch { handle = null; }
  if (!handle) return false;
  active = { handle, cues: meta.cues, index: -1 };
  return true;
}

export function updateReadAlong(seconds, playing = true) {
  if (!active) return;
  const index = playing && enabled ? cueAt(active.cues, Number(seconds)) : -1;
  if (index === active.index) return;
  active.index = index;
  try { index >= 0 ? active.handle.show(index) : active.handle.clear(); } catch {}
}

export function stopReadAlong() {
  if (!active) return;
  const handle = active.handle;
  active = null;
  try { handle.dispose(); } catch {}
}

// Markdown DELIMITERS the agent's own renderer has already turned into styling. Claude's canonical final
// message is raw markdown — `**ready**`, `## Plan`, `` `flag` `` — while what xterm holds is the rendered
// form, bold and heading colour with the marks gone.
//
// Recognised by SHAPE, never by the character alone, because most of these characters are ordinary text in a
// terminal. An emphasis run (* _ ~) has to FLANK — a non-space just inside it, no word character just
// outside — and has to find a partner of the same character and length on the same line. `#` counts only as
// an ATX heading: start of the line, then a space. Backticks count only as a matched pair on one line.
// So `**ready**`, `## Plan` and `` `flag` `` are syntax, while `foo_bar`, `a*b`, `2 * 3`, `snake_case_name`
// and `issue#12` are text and stay text — which is what keeps two DIFFERENT strings from reducing to the
// same one and letting a match land on cells that hold other words.
const EMPHASIS = "*_~";
const LIST = "-*+\u2022";
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE_CHAR = /\s/u;
const isWord = (ch) => ch !== undefined && WORD_CHAR.test(ch);
const isSpace = (ch) => ch === undefined || SPACE_CHAR.test(ch);

function markdownDelimiters(text) {
  const drop = new Set();
  for (let lineStart = 0; lineStart <= text.length;) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;

    let head = lineStart;
    while (head < lineEnd && (text[head] === " " || text[head] === "\t")) head++;
    // A LIST MARKER is structure, not a word: an agent writes `- item` and its renderer prints `• item`.
    // Dropped from both readings, so the two spellings of the same line meet. Only at the head of a line and
    // only with a space after it, which is what keeps `-1`, `a - b` and `*args` as the text they are.
    if (LIST.includes(text[head]) && text[head + 1] === " ") drop.add(head);
    if (text[head] === "#") {                                  // ATX heading, and only that
      let end = head;
      while (end < lineEnd && text[end] === "#") end++;
      if (end - head <= 6 && (end >= lineEnd || text[end] === " ")) for (let at = head; at < end; at++) drop.add(at);
    }

    const runs = [];
    for (let at = lineStart; at < lineEnd; at++) {
      const ch = text[at];
      if (ch !== "`" && !EMPHASIS.includes(ch)) continue;
      let end = at;
      while (end < lineEnd && text[end] === ch) end++;
      if (!drop.has(at)) runs.push({ ch, start: at, end });
      at = end - 1;
    }
    const paired = new Set();
    for (let a = 0; a < runs.length; a++) {
      const open = runs[a];
      if (paired.has(a)) continue;
      // Code spans delimit by pairing alone; emphasis also has to flank, which is what saves `foo_bar`.
      if (open.ch !== "`" && (isSpace(text[open.end]) || isWord(text[open.start - 1]))) continue;
      for (let b = a + 1; b < runs.length; b++) {
        const close = runs[b];
        if (paired.has(b) || close.ch !== open.ch || close.end - close.start !== open.end - open.start) continue;
        if (close.ch !== "`" && (isSpace(text[close.start - 1]) || isWord(text[close.end]))) continue;
        for (let at = open.start; at < open.end; at++) drop.add(at);
        for (let at = close.start; at < close.end; at++) drop.add(at);
        paired.add(a); paired.add(b);
        break;
      }
    }
    lineStart = lineEnd + 1;
  }
  return drop;
}

// Reduce text to what two renderings of it must have in common: whitespace RUNS become one space (xterm
// re-wraps and re-indents what it prints), and with `unmark` the markdown delimiters above disappear too.
// Everything else must be identical. Keeps an index map both ways, so a cue offset in the original still
// resolves to a cell. `unmark` is the FALLBACK spelling — the caller tries the exact form first.
export function matchable(text, unmark = false) {
  const drop = unmark ? markdownDelimiters(text) : null;
  const at = [], to = new Array(text.length).fill(-1);
  let out = "", pending = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (drop && drop.has(i)) continue;
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\v" || ch === "\f") { pending = !!out; continue; }
    if (pending) { at.push(i); out += " "; pending = false; }
    to[i] = out.length; at.push(i); out += ch;
  }
  return { text: out, at, to };
}

export function __readAlongForTest() { return active ? { index: active.index, cues: active.cues.length } : null; }

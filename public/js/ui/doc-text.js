// The one place a document becomes text. Both the reader (what a plugin speaks) and the mark (where those
// words sit on screen) come out of this walk, so the two can never describe different documents.
//
// ⚠️ INLINED into the sandboxed HTML preview, where there is no module loader and no same-origin fetch: the
// host strips `export ` and concatenates this file with the bridge. So it must import NOTHING and touch no
// global beyond the nodes it is handed. doc-text-it.mjs asserts both, because the day that stops being true
// the preview would break in silence.

export const MAX_VIEWER_TEXT = 256 * 1024;
export const SILENT_TAGS = new Set(["HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
export const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
// A heading and the paragraph under it are two utterances, and a reader that runs them together says
// "Plan The build is green". These tags end with a BLANK line so a speech chunker sees a paragraph break.
// Whitespace is the only thing we may add: a full stop we invented would be a word the document never said,
// and it would break the read-along match, which needs the spoken text to differ from the screen by
// whitespace alone. List items and table cells keep a single break — they are one list, not many paragraphs.
export const PARAGRAPH_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIGURE", "FOOTER",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL"]);


export function tagName(node) { return String(node && (node.tagName || node.tag) || "").toUpperCase(); }
export function hiddenNode(node, tag) {
  if (SILENT_TAGS.has(tag) || node.classList?.contains("md-colophon")) return true;
  if (node.hasAttribute?.("hidden") || node.getAttribute?.("aria-hidden") === "true") return true;
  if (tag === "INPUT" && String(node.getAttribute?.("type") || "").toLowerCase() === "hidden") return true;
  const style = String(node.getAttribute?.("style") || "");
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(style);
}

// One walk, two answers: the text a reader speaks, and where every character of it came from. Both the
// selection's offset and the read-along highlight need the second half — without it, "read from here" and
// "mark these words" are searches, and a search over a document that repeats itself lands on the wrong copy.
export const MAX_NODES = 120000;          // a pathological document is refused, never chased forever
export function textParts(root) {
  const parts = [], chunks = [];
  let length = 0, newlines = 0, budget = MAX_NODES;
  const push = (text, node, base) => {
    if (!text) return;
    parts.push({ node, base, from: length, to: length + text.length });
    chunks.push(text); length += text.length;
    // Inspect only the new chunk; indexing a growing concatenated string can copy
    // the whole document again at every paragraph boundary.
    let trailing = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === "\n"; i--) trailing++;
    newlines = trailing === text.length ? newlines + trailing : trailing;
  };
  const breakTo = (want) => { if (!length) return; for (let have = newlines; have < want; have++) push("\n", null, 0); };
  const walk = (node, inItem) => {
    if (!node || budget-- <= 0) return;
    if (node.nodeType === 3) { push(node.nodeValue || "", node, 0); return; }
    const tag = tagName(node);
    if (hiddenNode(node, tag)) return;
    // A list item is ONE utterance however the renderer wraps it — markdown items each hold a <p>, and left
    // alone that would make every bullet its own paragraph. The list is the paragraph; the items are lines.
    let want = PARAGRAPH_TAGS.has(tag) ? 2 : BLOCK_TAGS.has(tag) ? 1 : 0;
    if (inItem && want > 1) want = 1;
    if (want) breakTo(want);
    const children = node.childNodes || node.children;
    const nested = inItem || tag === "LI";
    if (children && children.length) for (const child of children) walk(child, nested);
    else if (node.textContent) push(node.textContent, node, 0);
    if (want) breakTo(want);
  };
  walk(root, false);
  return { raw: chunks.join(""), parts };
}

// normalizeViewerText, character by character, keeping a map back to the raw text. The rules are the same
// ones: CRLF folds, runs of spaces and tabs become one, lines are trimmed, three or more blank lines become
// one blank line, and the whole thing is trimmed and capped.
export function normalizeWithMap(raw) {
  const out = [], at = [];
  let pendingSpace = false, newlines = 0, started = false;
  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    if (ch === "\r") { if (raw[i + 1] === "\n") continue; ch = "\n"; }
    if (ch === "\n") { if (started) newlines++; pendingSpace = false; continue; }
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") { if (started && !newlines) pendingSpace = true; continue; }
    if (newlines) { for (let k = 0, n = Math.min(newlines, 2); k < n; k++) { out.push("\n"); at.push(i); } newlines = 0; pendingSpace = false; }
    else if (pendingSpace) { out.push(" "); at.push(i); pendingSpace = false; }
    out.push(ch); at.push(i); started = true;
    if (out.length >= MAX_VIEWER_TEXT) return { text: out.join(""), at, truncated: i < raw.length - 1 };
  }
  return { text: out.join(""), at, truncated: false };
}

// A document's text with the map still attached. Rebuilt on demand: it describes the DOM as it is now, and a
// document that re-rendered underneath us must not be marked through a map of what it used to be.

export function partAt(index, parts) {
  let lo = 0, hi = parts.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; const part = parts[mid];
    if (index < part.from) hi = mid - 1; else if (index >= part.to) lo = mid + 1;
    else return { node: part.node, offset: part.base + (index - part.from) }; }
  return null;
}

// The same walk, when the caller only wants the words — an HTML document parsed out of its frame has no
// Everything a caller needs about one root: the text, where each character came from, and the nodes it lives in.
export function docTextIndex(root) {
  if (!root) return null;
  const { raw, parts } = textParts(root);
  const { text, at, truncated } = normalizeWithMap(raw);
  return { root, text, at, parts, truncated };
}

// A cheap agreement check between two extractions of the same document — the host's, out of its own parse,
// and the frame's, out of the DOM the user is looking at. Different numbers mean the two are describing
// different documents, and the honest answer to that is no mark at all.
export function textFingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return String(hash) + ":" + text.length;
}

// The content dock — a resizable panel docked right of the terminal that holds an agent's rich content as tabs
// (per active session). Home for text/json/html/markdown/pdf/mermaid/diff/chart/testresults, and for image/video LOOPS
// (content.show with `replaces`, e.g. a screenshot loop) — anything you keep open beside the terminal. One-shot
// image/video still uses the glance lightbox (content-viewer). `replaces` swaps a tab's content in place. Follows
// the 13c transient-surface language; resizable width persists like the sidebar. Shown assets are held in the
// session record by the engine and replayed on every connect, so a document survives a refresh and an engine
// restart — which is why closing one has to TELL the engine, or it comes back on the next reconnect.
import { store } from "../store.js";
import { closeContent } from "../ws.js";
import { h, copyText } from "../util.js";
import { renderText, renderJson, renderMarkdown, renderDiff, renderChart, renderTestResults, htmlFrame, pdfEmbed, imageEl, videoEl, mermaidEl } from "./content-renderers.js";
import { registerCoreViewer, viewerFor, isRenderableKind, isPluginKind, iconForKind, onViewersChange } from "./viewer-registry.js";
import { pluginFrame, isPluginFrame, disposePluginFrame, setPluginFrameVisible } from "./plugin-frame.js";
import { hasActions, resolveActions, resolveImmediateActions, runAction, onActionsChange } from "./action-registry.js";
import { openMenu, closeMenu } from "./menu.js";
import { toast } from "./toast.js";
import { registerReadAlongSurface, matchable } from "./read-along.js";
import { MAX_VIEWER_TEXT, docTextIndex, normalizeWithMap, partAt, textParts, textFingerprint } from "./doc-text.js";

const KIND_ICON = {
  terminal: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg>',
  text: icon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/>'),
  json: icon('<path d="M9 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/><path d="M15 4h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/>'),
  html: icon('<path d="M4 17V7l4 5 4-5v10"/><path d="M15 7v10h5"/>'),
  markdown: icon('<path d="M4 16V8l3 3 3-3v8"/><path d="M17 8v6"/><path d="M14.5 11.5L17 14l2.5-2.5"/>'),
  pdf: icon('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>'),
  mermaid: icon('<rect x="4" y="4" width="7" height="5" rx="1"/><rect x="13" y="15" width="7" height="5" rx="1"/><path d="M7.5 9v3a2 2 0 0 0 2 2h7"/>'),
  diff: icon('<path d="M6 3v12"/><circle cx="6" cy="18" r="2.4"/><path d="M18 21V9"/><circle cx="18" cy="6" r="2.4"/>'),
  chart: icon('<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="11" width="3" height="6"/><rect x="13" y="7" width="3" height="10"/>'),
  testresults: icon('<path d="M9 11l2 2 4-4"/><rect x="4" y="4" width="16" height="16" rx="2"/>'),
  image: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 15l-5-5L5 20"/>'),
  video: icon('<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 9l4-2v10l-4-2z"/>'),
};
const REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v5h-5"/></svg>';
const X = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
function icon(inner) { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + inner + "</svg>"; }
// What the dock will open a tab for. A registered viewer draws its own body; a well-formed plugin kind with
// no viewer behind it gets the placeholder in `bodyFor` — an honest, CLOSABLE tab. Dropping it instead is
// what left a disabled plugin's persisted content held by the engine with nothing on screen to release it.
const renderableKind = (k) => isRenderableKind(k) || isPluginKind(k);

const RAIL_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v5"/><path d="M9.5 14.5h5"/></svg>';

const docks = new Map();   // sessionId -> { items:[{id,kind,name,url,node,built}], activeId }
const TEXT_VIEWERS = new Set(["text", "markdown", "html"]);
// Documents the user has closed but the engine has not yet confirmed dropping. Deliberately NOT inside `docks`:
// store.reset() empties that on every connect, which is the exact moment the engine replays the document we
// just closed — a tombstone kept there would be wiped a beat before it is needed. Keyed sessionId -> Set(id).
//
// It only has to outlive that window. A contentId is a fresh randomUUID per registration (even a same-name
// re-show mints a new one and drops the old), so a tombstone can never shadow a document the user opens later,
// and it is retired the moment the engine acknowledges — or with the session. This is a short-lived
// reconciliation set, never a history of what was closed.
const pendingCloses = new Map();
function tombstone(sid, id) {
  let set = pendingCloses.get(sid);
  if (!set) { set = new Set(); pendingCloses.set(sid, set); }
  set.add(id);
}
function isTombstoned(sid, id) { const s = pendingCloses.get(sid); return !!s && s.has(id); }
function clearTombstone(sid, id) {
  const s = pendingCloses.get(sid); if (!s) return;
  s.delete(id);
  if (!s.size) pendingCloses.delete(sid);
}
let tabsEl = null, bodyEl = null, termPanel = null, railEl = null, dropArmed = false;
let viewerActionEpoch = 0, viewerHeaderSeq = 0;
const TERMINAL_TAB = "__terminal__";      // the terminal is simply the first tab, always present, never closable
let onTerminalShown = () => {};

// Content now opens as TABS IN THE MAIN PANE (VS Code model): the session header stays fixed as identity, the
// strip sits directly beneath it, and the terminal is the first tab. The old right-hand column — and its
// width-drag — is gone: a tab fills the pane, so there is no width to drag.
export function initContentDock() {
  tabsEl = document.getElementById("pane-tabs");
  bodyEl = document.getElementById("pane-body");
  termPanel = document.getElementById("term-panel");
  if (!tabsEl || !bodyEl) return;
  store.on("active", renderDock);
  store.on("reset", () => { for (const entry of docks.values()) releaseEntry(entry); docks.clear(); renderDock(); });   // NB: pendingCloses deliberately survives — see its comment
  store.on("session:remove", (id) => { pendingCloses.delete(id); const entry = docks.get(id); if (entry) releaseEntry(entry); if (docks.delete(id)) renderDock(); });
  store.on("content:closed", onContentClosed);
  onViewersChange(() => { resetPluginViewerNodes(); renderDock(); });
  onActionsChange(() => {
    viewerActionEpoch++;
    const item = activeDocument();
    if (item && item.node && item.node._primePluginContext) item.node._primePluginContext();
    paintViewerActions(item);
  });
  renderDock();                      // establish the bare-terminal state before any content arrives
}

// Record + show content for a session. Called by content-viewer for dock kinds. Returns nothing.
export function presentInDock(ev) {
  // A document the user closed can still be in flight towards us: the engine starts replaying the moment the
  // socket opens, before it has read the close we flush on the same event. Dropping the frame is the whole
  // reconciliation — we never answer it, so there is no close to echo and nothing to loop.
  if (isTombstoned(ev.sessionId, ev.contentId)) return;
  const entry = docks.get(ev.sessionId) || { items: [], activeId: null };
  docks.set(ev.sessionId, entry);
  let item = ev.replaces ? entry.items.find((it) => it.id === ev.replaces) : null;
  if (item) { releaseItemNode(item); item.id = ev.contentId; item.kind = ev.kind; item.name = ev.name; item.url = ev.url; item.sourcePath = ev.sourcePath || ""; item.sessionId = ev.sessionId; }   // swap in place
  else { item = { id: ev.contentId, kind: ev.kind, name: ev.name, url: ev.url, sourcePath: ev.sourcePath || "", sessionId: ev.sessionId, node: null, built: false }; entry.items.push(item); }
  entry.activeId = item.id;
  if (ev.sessionId === store.activeId) renderDock();
}

// ── the strip as a DROP TARGET ───────────────────────────────────────────────────────────────────────────
// Drop a file on the tab strip and it opens as a document; drop it on the terminal and its path is still pasted
// for the agent. Distinct target, distinct intention — which is what makes it unambiguous without a modifier key.
// With nothing open the strip is absent, so a drag REVEALS the target as a rail. The rail is an OVERLAY on the
// pane body, never inserted into the flow: a target that reflows into existence shifts the terminal under a
// cursor that is already moving toward it.
function currentItems() { const e = docks.get(store.activeId); return (e && e.items) || []; }
function activeDocument() {
  const entry = docks.get(store.activeId);
  return entry && entry.activeId !== TERMINAL_TAB ? entry.items.find((item) => item.id === entry.activeId) || null : null;
}

function normalizeViewerText(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .split("\n").map((line) => line.replace(/[\t\f\v ]+/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_VIEWER_TEXT);
}
function documentIndex(item) {
  return docTextIndex(item && item.node && item.kind === "markdown" ? item.node.querySelector?.(".md-view")
    : item && item.node && item.kind === "text" ? item.node.querySelector?.(".ct-text-body") : null);
}

// raw index -> the node holding that character, and how far into it
// live nodes to point at, but it must read exactly as the others do.
function visibleDomText(root) { return root ? normalizeWithMap(textParts(root).raw).text : ""; }

function stillActive(sessionId, contentId) {
  const item = activeDocument();
  return store.activeId === sessionId && !!item && item.id === contentId;
}

// ── the HTML preview's bridge ────────────────────────────────────────────────────────────────────────────
// An HTML document renders inside `sandbox="allow-scripts"` with no allow-same-origin, so the host cannot
// reach its DOM — which is the whole point, and is not being relaxed. To mark words in there we load the
// document as `srcdoc` with a host-owned script inlined ahead of it, and talk to that script by postMessage.
//
// What crosses is deliberately unprivileged. Down: integer ranges to mark, and a request for the selection.
// Up: a fingerprint, "the user touched me", and a selection ONLY in reply to a request that named an id.
// event.source proves which FRAME spoke, never which script inside it — the author's own code shares that
// frame and can forge any of this — so nothing from the frame is trusted with an action. The worst a forged
// message achieves is dismissing a menu the user was done with, or offering text they then hear read back.
const previews = new Map();                       // iframe -> { item, url, text, fp, agreed, gen, ask }
let bridgeSource = null;
async function bridgeScript() {
  if (bridgeSource) return bridgeSource;
  const [shared, bridge] = await Promise.all([
    fetch("/js/ui/doc-text.js").then((r) => r.text()),
    fetch("/js/ui/preview-bridge.js").then((r) => r.text()),
  ]);
  // The frame has no module loader and no same-origin fetch, so the shared extractor goes in as plain source —
  // and the WHOLE thing is wrapped in one function, because a top-level `const MAX_VIEWER_TEXT` in the author's
  // own global scope is a name collision waiting to happen, and a duplicate declaration is a SyntaxError that
  // would take their scripts down with ours.
  bridgeSource = "(function(){\n" + shared.replace(/^export /gm, "") + "\n" + bridge + "\n})();";
  return bridgeSource;
}
async function loadPreview(frame, item) {
  // A reload gives the frame a NEW contentWindow, and entries are matched by that window — so a late message
  // from the document we just replaced matches nothing and is ignored, with no generation counter to keep.
  const entry = { item, url: item.url, text: "", fp: "", agreed: false, truncated: false, ask: null };
  previews.set(frame, entry);
  try {
    const [source, script] = await Promise.all([
      fetch(item.url).then((r) => (r.ok === false ? "" : r.text())),
      bridgeScript(),
    ]);
    if (!source || previews.get(frame) !== entry) throw new Error("stale");
    if (typeof DOMParser === "function") {
      const parsed = new DOMParser().parseFromString(source, "text/html");
      entry.text = visibleDomText(parsed.body);
      entry.fp = textFingerprint(entry.text);
      entry.truncated = entry.text.length >= MAX_VIEWER_TEXT;
    }
    // Relative urls resolve against the ASSET, not about:srcdoc — but an author who wrote their own <base>
    // keeps it: the first base wins, and overriding theirs would move their whole document.
    const base = /<base\s[^>]*href=/i.test(source) ? "" : '<base href="' + String(item.url).replace(/"/g, "&quot;") + '">';
    // ⚠️ The DOCTYPE must stay the first thing in the document. Anything before it puts the browser in QUIRKS
    // mode, which silently re-lays-out the author's page — a far bigger change than the feature we came for.
    // So: keep the doctype where it is, and inject into <head> when there is one.
    const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
    const rest = doctype ? source.slice(doctype[0].length) : source;
    const head = /<head[^>]*>/i.exec(rest);
    const inject = base + "<script>" + script + "<\/script>";
    const at = head ? head.index + head[0].length : 0;
    frame.removeAttribute("src");
    frame.srcdoc = (doctype ? doctype[0] : "") + rest.slice(0, at) + inject + rest.slice(at);
  } catch {
    previews.delete(frame);
    frame.src = item.url;                        // no bridge; the document still renders exactly as before
  }
}
function previewEntry(source) {
  for (const [frame, entry] of previews) if (frame.contentWindow === source) return entry;
  return null;
}
function onPreviewMessage(event) {
  const entry = previewEntry(event.source);
  const data = entry && event.data;
  if (!data || typeof data.ck !== "string") return;
  if (data.ck === "pointer") { closeMenu(); return; }         // an outside click that never reaches this document
  if (data.ck === "ready") {
    // Canonical text agreement: if the frame's reading of the document differs from ours by one character,
    // every offset we would send it is wrong. Disagreement disables the mark; it never guesses.
    // Also arrives when the document rewrites itself: the frame re-announces, and a text that no longer
    // matches ours takes the mark away rather than moving it to the wrong words.
    entry.agreed = !!entry.fp && data.fp === entry.fp;
    if (data.truncated) entry.truncated = true;
    return;
  }
  if (data.ck === "selection" && entry.ask && data.id === entry.ask.id) {
    const ask = entry.ask; entry.ask = null;
    ask.resolve({ text: String(data.text || "").slice(0, MAX_VIEWER_TEXT), offset: Math.floor(Number(data.offset)),
      truncated: data.truncated === true });
  }
}
if (typeof window !== "undefined" && window.addEventListener) window.addEventListener("message", onPreviewMessage);

export function __previewsForTest() {
  return [...previews.values()].map((entry) => ({ id: entry.item.id, agreed: entry.agreed, fp: entry.fp, text: entry.text.length }));
}
// Rebuilding a document's node leaves its old frame behind, and a host that keeps talking to the dead one
// posts marks into a window nobody is looking at. Entries go when their node does, and a lookup ignores any
// frame that is no longer in the page — both, because either alone would still leave the other case wrong.
function releasePreviews(node) {
  for (const frame of [...previews.keys()]) if (node === frame || (node.contains && node.contains(frame))) previews.delete(frame);
}
function previewFor(item) {
  for (const [frame, entry] of previews) {
    if (entry.item.id !== item.id) continue;
    if (frame.isConnected === false) { previews.delete(frame); continue; }
    return entry;
  }
  return null;
}
function frameOf(entry) {
  for (const [frame, value] of previews) if (value === entry) return frame;
  return null;
}
function askPreviewSelection(item) {
  const entry = previewFor(item), frame = entry && frameOf(entry);
  if (!entry || !frame || !entry.agreed) return Promise.resolve(null);
  const id = "s" + Date.now() + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    entry.ask = { id, resolve };
    try { frame.contentWindow.postMessage({ ck: "selection", id }, "*"); } catch { entry.ask = null; resolve(null); }
    setTimeout(() => { if (entry.ask && entry.ask.id === id) { entry.ask = null; resolve(null); } }, 400);
  });
}

// ── Read-along on a document ─────────────────────────────────────────────────────────────────────────────
// The plugin speaks text it got from getActiveViewerText, so the honest way to find those words again is to
// look where it says they are: sourceOffset names the slice, and we verify that one slice rather than search.
// Without an offset we accept only a UNIQUE occurrence — a document that says the same thing twice gets no
// mark rather than a mark on the wrong paragraph.
//
// The mark itself is the CSS Custom Highlight API: ranges are painted without touching the DOM, so the
// document keeps the markup the agent wrote — no injected spans, no reflow, nothing to clean up but the
// highlight registry. Where the API is missing, there is simply no mark.
const READ_ALONG_HIGHLIGHT = "read-along";
// The same reading, one boundary further out: the host works out WHICH characters, the frame works out where
// they are on screen. Refused unless the two agree on what the document says.
function previewReadAlong(item, meta) {
  const entry = previewFor(item), frame = entry && frameOf(entry);
  if (!entry || !frame || !entry.agreed || !entry.text) return null;
  const source = matchable(meta.sourceText), page = matchable(entry.text);
  if (!source.text) return null;
  let base = -1;
  if (meta.sourceOffset >= 0) {
    let hint = -1;
    for (let i = meta.sourceOffset; i < entry.text.length && hint < 0; i++) if (page.to[i] >= 0) hint = page.to[i];
    if (hint >= 0 && page.text.startsWith(source.text, hint)) base = hint;
  }
  if (base < 0) {
    const first = page.text.indexOf(source.text);
    if (first >= 0 && first === page.text.lastIndexOf(source.text)) base = first;
  }
  if (base < 0) return null;
  const spans = meta.cues.map((cue) => {
    let from = -1, to = -1;
    for (let i = cue.textStart; i < cue.textEnd; i++) { const at = source.to[i]; if (at < 0) continue; if (from < 0) from = at; to = at; }
    if (from < 0) return null;
    const start = page.at[base + from], end = page.at[base + to];
    return start === undefined || end === undefined ? null : [start, end + 1];
  });
  if (!spans.some(Boolean)) return null;
  const post = (message) => { try { frame.contentWindow.postMessage(message, "*"); } catch {} };
  return {
    show(cue) {
      const current = activeDocument();
      if (!current || current.id !== meta.contentId || store.activeId !== meta.sessionId) return post({ ck: "clear" });
      const span = spans[cue];
      post(span ? { ck: "mark", ranges: [span] } : { ck: "clear" });
    },
    clear() { post({ ck: "clear" }); },
    dispose() { post({ ck: "clear" }); },
  };
}
function viewerReadAlong(meta) {
  if (typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return null;
  const item = activeDocument();
  if (!item || item.id !== meta.contentId || store.activeId !== meta.sessionId) return null;
  if (item.kind === "html") return previewReadAlong(item, meta);          // marked through its own frame
  if (item.kind !== "markdown" && item.kind !== "text") return null;
  const index = documentIndex(item);
  if (!index || !index.text) return null;

  // Whitespace is the latitude, and the only one. A native selection that crosses a heading into a paragraph
  // comes back as "Title\nBody" while the extractor writes "Title\n\nBody" — the same words, spaced
  // differently. Both sides reduce through the SAME matchable() the terminal uses; nothing else is dropped,
  // because in a document every other character is content.
  const source = matchable(meta.sourceText);
  const page = matchable(index.text);
  if (!source.text) return null;
  let base = -1;
  if (meta.sourceOffset >= 0) {
    let hint = -1;
    for (let i = meta.sourceOffset; i < index.text.length && hint < 0; i++) if (page.to[i] >= 0) hint = page.to[i];
    if (hint >= 0 && page.text.startsWith(source.text, hint)) base = hint;
  }
  if (base < 0) {
    const first = page.text.indexOf(source.text);
    if (first >= 0 && first === page.text.lastIndexOf(source.text)) base = first;   // unique, or nothing
  }
  if (base < 0) return null;

  // reduced page index -> the character it came from -> the node holding it
  const nodeAt = (reduced) => {
    const normalized = page.at[reduced];
    return normalized === undefined ? null : partAt(index.at[normalized], index.parts);
  };
  const ranges = [];
  for (const cue of meta.cues) {
    let from = -1, to = -1;
    for (let i = cue.textStart; i < cue.textEnd; i++) { const at = source.to[i]; if (at < 0) continue; if (from < 0) from = at; to = at; }
    const start = from < 0 ? null : nodeAt(base + from), end = from < 0 ? null : nodeAt(base + to);
    if (!start || !end || !start.node || !end.node) { ranges.push(null); continue; }
    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, Math.min(end.offset + 1, (end.node.nodeValue || "").length));
      ranges.push(range);
    } catch { ranges.push(null); }
  }
  if (!ranges.some(Boolean)) return null;

  const highlight = new Highlight();
  CSS.highlights.set(READ_ALONG_HIGHLIGHT, highlight);
  const clear = () => { try { highlight.clear(); } catch {} };
  return {
    show(cue) {
      clear();
      const current = activeDocument();
      if (!current || current.id !== meta.contentId || store.activeId !== meta.sessionId) return;
      const range = ranges[cue];
      if (range) { try { highlight.add(range); } catch {} }
    },
    clear,
    dispose() { clear(); try { CSS.highlights.delete(READ_ALONG_HIGHLIGHT); } catch {} },
  };
}
registerReadAlongSurface("viewer", viewerReadAlong);

// Requester API for plugins such as speech: only the active core document is readable. HTML stays in its
// opaque sandbox; the host fetches the same asset and extracts human-visible DOM text without script/style data.
export async function getActiveViewerText(expectedContentId) {
  const item = activeDocument();
  if (!expectedContentId || !item || item.id !== expectedContentId || !TEXT_VIEWERS.has(item.kind) || !item.node) return "";
  const sessionId = store.activeId, contentId = item.id;
  // Markdown and text come from the SAME walk that builds the highlight's map, so the string a plugin reads
  // and the string the host can point at are the same string, character for character.
  if (item.kind === "text" || item.kind === "markdown") return (documentIndex(item) || { text: "" }).text;
  const preview = previewFor(item);
  if (preview && preview.text) return preview.text;
  try {
    const response = await fetch(item.url);
    if (response.ok === false) return "";
    const source = await response.text();
    if (!stillActive(sessionId, contentId) || typeof DOMParser !== "function") return "";
    const doc = new DOMParser().parseFromString(source, "text/html");
    return stillActive(sessionId, contentId) ? visibleDomText(doc.body) : "";
  } catch { return ""; }
}

// Hotkeys have no click context to carry an ID, so capture identity and text together. If the tab changes while
// HTML is loading, keep the captured document identity but drop its text; null means Terminal/no document only.
export async function getActiveViewerTextSnapshot() {
  const item = activeDocument();
  if (!item) return null;
  const sessionId = store.activeId, id = item.id, kind = item.kind;
  const selection = normalizeViewerText(selectedText(item.node));
  const text = TEXT_VIEWERS.has(kind) ? await getActiveViewerText(id) : "";
  const active = stillActive(sessionId, id);
  // `truncated` is not a detail: a reader that speaks a capped document while believing it complete stops
  // mid-sentence and calls it the end. The cap is the host's safety bound and stays; saying so is the fix.
  const index = active && (kind === "markdown" || kind === "text") ? documentIndex(item) : null;
  const preview = kind === "html" ? previewFor(item) : null;
  const framed = preview && active ? await askPreviewSelection(item) : null;
  return { id, kind, text: active ? text : "",
    selection: active ? (framed ? framed.text : selection) : "",
    selectionOffset: active ? (framed ? framed.offset : selectionOffset(item)) : -1,
    truncated: !!(index && index.truncated) || !!(preview && preview.truncated),
    selectionTruncated: (framed ? framed.truncated : selection.length >= MAX_VIEWER_TEXT) === true };
}
function showRail(on) {
  if (!on) { if (railEl) { railEl.remove(); railEl = null; } return; }
  if (railEl || !bodyEl) return;
  railEl = h("div", "cd-rail");
  const ic = h("span", "cd-rail-ic", RAIL_ICON);
  const label = h("span", "cd-rail-label"); label.textContent = "Drop to open as a document";
  railEl.append(ic, label);
  bodyEl.appendChild(railEl);
}
export function armTabDrop(on) {
  on = !!on;
  if (!tabsEl || on === dropArmed) return;
  dropArmed = on;
  const bare = currentItems().length === 0;
  showRail(on && bare);
  // An armed strip must sit ABOVE the drop veil. Left in normal flow it is behind the veil's blur, so the one
  // element that has to say "let go here" is the one element you cannot read.
  tabsEl.classList.toggle("drop-armed", on && !bare);
  if (!on) tabsEl.classList.remove("drop-over");
}
// True when (x,y) is over whichever element is currently the target. Paints the hover state itself, so callers
// need no handle on the element — and returns false on a zero rect, so an unlaid-out probe reads as a miss.
export function overTabDrop(x, y) {
  const el = railEl || (tabsEl && !tabsEl.hidden ? tabsEl : null);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const on = r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  el.classList.toggle("drop-over", on);
  return on;
}

function renderDock() {
  if (!tabsEl || !bodyEl) return;
  const entry = docks.get(store.activeId);
  const items = (entry && entry.items) || [];
  // With no documents open the strip disappears entirely and the terminal fills the pane exactly as before.
  const bare = items.length === 0;
  tabsEl.hidden = bare;
  if (entry && items.length && !items.some((it) => it.id === entry.activeId) && entry.activeId !== TERMINAL_TAB) {
    entry.activeId = items[items.length - 1].id;
  }
  const activeId = bare ? TERMINAL_TAB : (entry.activeId || TERMINAL_TAB);

  tabsEl.replaceChildren();
  if (!bare) {
    tabsEl.appendChild(terminalTab(activeId === TERMINAL_TAB));
    for (const it of items) tabsEl.appendChild(docTab(it, it.id === activeId, entry));
  }

  // The terminal is HIDDEN, never unmounted — remounting xterm would lose scrollback. So is every OPEN
  // document, for the same kind of reason: unmounting a node throws away everything the host is holding
  // inside it. A read-along range over detached text describes nothing on screen, and an <iframe> loses its
  // browsing context outright and RELOADS when it comes back — so a second document arriving while the
  // reader was talking took the highlight down with it, and rebuilt the preview's bridge underneath it.
  // That was a large part of "the highlighting is intermittent". Only a node whose tab is gone is removed;
  // `releaseItemNode` is the one path that unmounts a document, and closing is the one thing that calls it.
  const showTerm = activeId === TERMINAL_TAB;
  const mounted = new Set(items.map((it) => it.node).filter(Boolean));
  // ⚠️ WORK OUT WHAT WILL BE VISIBLE BEFORE HIDING ANYTHING. The sweep below used to hide every frame and then
  // unhide the active one, so on EVERY render — a rename, a new tab, a status change — the frame on screen was
  // told false and then true. A plugin that pauses work while hidden would restart it on unrelated renders.
  const activeItem = showTerm ? null : items.find((it) => it.id === activeId);
  const visibleNode = activeItem ? bodyFor(activeItem) : null;
  for (const n of [...bodyEl.children]) {
    if (n === termPanel || n === railEl) continue;
    if (mounted.has(n) || isPluginFrame(n)) { n.hidden = n !== visibleNode; if (isPluginFrame(n)) setPluginFrameVisible(n, n === visibleNode); }
    else n.remove();
  }
  if (termPanel) termPanel.hidden = !showTerm;
  let active = activeItem || null;
  if (!showTerm) {
    if (active && visibleNode) {
      visibleNode.hidden = false; if (isPluginFrame(visibleNode)) setPluginFrameVisible(visibleNode, true);
      if (visibleNode.parentNode !== bodyEl) bodyEl.appendChild(visibleNode);
    }
  } else onTerminalShown();          // a hidden terminal measures 0, so it must be refit + refocused on return
  paintViewerActions(active);
  // Last, so it survives the sweep above: a document landing mid-drag hands the target back to the real strip.
  showRail(dropArmed && bare);
}

function terminalTab(on) {
  const tab = h("div", "cd-tab cd-tab-term" + (on ? " on" : ""));
  tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(on));
  tab.append(spanIcon("terminal"));
  const label = h("span", "cd-tab-name"); label.textContent = "Terminal";
  tab.appendChild(label);
  tab.addEventListener("click", () => { const e = docks.get(store.activeId); if (e) { e.activeId = TERMINAL_TAB; renderDock(); } });
  return tab;
}
function docTab(it, on, entry) {
  const tab = h("div", "cd-tab" + (on ? " on" : ""));
  tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(on));
  tab.append(spanIcon(it.kind));
  const label = h("span", "cd-tab-name"); label.textContent = it.name || it.kind; label.title = it.name || it.kind;
  const close = h("button", "cd-tab-x", X); close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close " + (it.name || it.kind));
  close.addEventListener("click", (e) => { e.stopPropagation(); closeItem(store.activeId, it.id); });
  tab.append(label, close);
  tab.addEventListener("click", () => { entry.activeId = it.id; renderDock(); });
  // The tab is where the document's IDENTITY lives, so its menu answers "what file is this?". Only a document
  // the engine sourced from disk has an answer; a payload the agent sent inline has no file, and the row says
  // so rather than quietly copying a /content URL that is not a path anyone can open.
  tab.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const path = it.sourcePath || "";
    openMenu({ x: event.clientX, y: event.clientY }, [{
      label: "Copy file path",
      disabled: !path,
      onSelect: (ctl) => { ctl.close(); copyText(path); },
    }, ...(path ? [] : [{ caption: true, label: "This preview was sent inline — it has no file on disk." }])],
    { align: "start", returnFocus: tab });
  });
  return tab;
}

// terminal.js registers what to do when its tab comes back (refit + focus).
export function onTerminalTabShown(fn) { onTerminalShown = typeof fn === "function" ? fn : () => {}; }

function bodyFor(item) {
  if (item.built && item.node) return item.node;
  if (item.workspace) {
    item.node = pluginFrame(item.pluginId, item.workspaceDef.src, workspaceContext(item), { className: "plugin-frame plugin-workspace", title: item.name, onClose: () => dropLocally(item.sessionId, item.id) });
    item.built = true; return item.node;
  }
  const viewer = viewerFor(item.kind);
  // No viewer for this kind: the plugin that draws it is disabled or gone. Say so, and leave the tab — closing
  // it is the only thing that releases the asset, so it must not be a dead end.
  if (!viewer) { item.node = h("div", "cd-error"); item.node.textContent = "Nothing here can draw " + (item.kind || "this content") + " — its plugin is disabled or no longer installed. Enable it to see this again, or close the tab to discard it."; item.built = true; return item.node; }
  try {
    item.node = viewer.build
      ? viewer.build(item)
      : pluginFrame(viewer.pluginId, viewer.src, viewerContext(item), { className: "plugin-frame plugin-viewer", title: item.name || viewer.title });
  } catch (error) { item.node = h("div", "cd-error"); item.node.textContent = "Couldn't open this plugin view — " + error.message; }
  item.built = true;
  bindViewerContext(item.node, item);
  return item.node;
}

function fetchView(item, mode, render) {
  const host = h("div", "cd-render"); host.appendChild(h("div", "cd-loading", "Loading…"));
  const fail = (e) => { const er = h("div", "cd-error"); er.setAttribute("role", "alert"); er.textContent = "Couldn't load this content" + (e && e.message ? " — " + e.message : "."); host.replaceChildren(er); };
  fetch(item.url).then((r) => { if (r.ok === false) throw new Error("HTTP " + r.status); return mode === "json" ? r.json() : r.text(); }).then((value) => host.replaceChildren(render(value, item))).catch(fail);
  return host;
}

function viewerContext(item, selection = "", offset = -1) {
  const session = store.sessions.get(item.sessionId || store.activeId);
  const project = session && session.projectId ? store.projects.find((p) => p.id === session.projectId) || null : null;
  return { surface: "viewer", selection: { text: String(selection || ""), surface: "viewer", offset }, session: session ? { id: session.id, name: session.name, provider: session.provider, cwd: session.cwd, projectId: session.projectId, live: session.live !== false, status: session.status } : null, project, tab: { id: item.id, kind: item.kind, name: item.name }, content: { id: item.id, kind: item.kind, name: item.name, url: item.url } };
}
function workspaceContext(item) { return { surface: "workspace", sessionId: item.sessionId, workspace: { id: item.workspaceDef.id, title: item.name }, options: item.options || {} }; }
function selectedText(node) {
  try { const selection = window.getSelection && window.getSelection(); if (!selection || !selection.rangeCount) return ""; const range = selection.getRangeAt(0); return node.contains(range.commonAncestorContainer) ? selection.toString() : ""; } catch { return ""; }
}
// Where the selection STARTS in the document's own text. A reader that is handed only the words has to search
// for them, and a document that says the same thing twice sends it to the wrong copy; an offset does not
// search at all. -1 when there is no selection, or when it cannot be placed.
function selectionOffset(item) {
  try {
    const selection = window.getSelection && window.getSelection();
    if (!selection || !selection.rangeCount || !item || !item.node) return -1;
    const range = selection.getRangeAt(0);
    if (!item.node.contains(range.commonAncestorContainer)) return -1;
    const index = documentIndex(item);
    if (!index) return -1;
    for (const part of index.parts) {
      if (part.node !== range.startContainer) continue;
      const rawAt = part.from + Math.max(0, Math.min(range.startOffset - part.base, part.to - part.from));
      for (let j = 0; j < index.at.length; j++) if (index.at[j] >= rawAt) return j;
      return index.text.length;
    }
    return -1;
  } catch { return -1; }
}
function bindViewerContext(node, item) {
  if (!node || !node.addEventListener || node._pluginContextBound) return; node._pluginContextBound = true;
  const prime = () => {
    if (!hasActions("viewer.context")) { node._pluginActionCache = null; return; }
    const context = viewerContext(item, selectedText(node), selectionOffset(item));
    const key = viewerActionEpoch + "\0" + context.selection.offset + "\0" + context.selection.text;
    resolveActions("viewer.context", context).then((actions) => { node._pluginActionCache = { key, actions }; });
  };
  node._primePluginContext = prime;
  node.addEventListener("pointerup", prime); node.addEventListener("keyup", prime);
  node.addEventListener("contextmenu", (event) => {
    if (event.shiftKey || !hasActions("viewer.context")) return;
    const context = viewerContext(item, selectedText(node), selectionOffset(item));
    const key = viewerActionEpoch + "\0" + context.selection.offset + "\0" + context.selection.text;
    const cached = node._pluginActionCache && node._pluginActionCache.key === key ? node._pluginActionCache.actions : [];
    const actions = [...resolveImmediateActions("viewer.context", context), ...cached.filter((action) => action.hasWhen)];
    if (!actions.length) { prime(); return; } // no plugin hit: preserve the browser's native menu
    event.preventDefault();
    openMenu({ x: event.clientX, y: event.clientY }, actions.map((action) => ({ label: action.label, onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } })), { align: "start", returnFocus: node });
  });
  prime();
}

// The tab strip's trailing cluster. It is HOST-owned and built synchronously with the tabs, because it now
// carries a host control (Reload) as well as plugin actions — an async plugin resolve must not decide whether
// the reload button exists. Plugin actions fill the slot inside it; Reload always sits last, at the far right.
function paintDockTools(item) {
  if (!tabsEl) return null;
  tabsEl.querySelector(".cd-viewer-actions")?.remove();
  const previewable = !!(item && item.kind === "html" && item.url);
  if (!item || (!previewable && !hasActions("viewer.header"))) return null;
  const toolbar = h("div", "cd-viewer-actions"); toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", "Document actions");
  toolbar.appendChild(h("div", "cd-viewer-plugin-slot"));
  if (previewable) {
    const reload = h("button", "cd-viewer-action cd-dock-refresh", REFRESH); reload.type = "button";
    reload.title = "Reload preview"; reload.setAttribute("aria-label", "Reload preview");
    reload.addEventListener("click", () => { if (reloadPreview(item)) reload.classList.add("spun"); setTimeout(() => reload.classList.remove("spun"), 620); });
    toolbar.appendChild(reload);
  }
  tabsEl.appendChild(toolbar);
  return toolbar;
}

function paintViewerActions(item) {
  const seq = ++viewerHeaderSeq;
  if (!tabsEl) return;
  const toolbar = paintDockTools(item);
  if (!toolbar || !item || !hasActions("viewer.header")) return;
  resolveActions("viewer.header", viewerContext(item, "")).then((actions) => {
    if (seq !== viewerHeaderSeq || activeDocument()?.id !== item.id || !actions.length) return;
    const slot = tabsEl.querySelector(".cd-viewer-plugin-slot");
    if (!slot) return;                                   // the strip was rebuilt under this resolve
    slot.replaceChildren();
    for (const action of actions) {
      const button = h("button", "cd-viewer-action"); button.type = "button"; button.title = action.label; button.setAttribute("aria-label", action.label);
      const glyph = h("span", "cd-viewer-action-ic"); glyph.textContent = action.icon || "✦"; glyph.setAttribute("aria-hidden", "true");
      button.appendChild(glyph);
      button.addEventListener("click", async () => {
        if (button.disabled) return; button.disabled = true; button.classList.add("busy");
        try { await runAction(action, action.context); } finally { button.disabled = false; button.classList.remove("busy"); }
      });
      slot.appendChild(button);
    }
  });
}

// Markdown gets a per-tab Rendered | Source toggle. The choice lives on the ITEM, not globally, because the
// real use is comparing one doc's source against another doc's rendering — a global flag would fight that.
// Both views are built once and swapped, so toggling never re-fetches and never loses scroll on the other view.
function markdownShell(text, item) {
  const shell = h("div", "md-shell");
  const bar = h("div", "md-bar");
  const seg = h("div", "md-seg");
  const rendered = renderMarkdown(text);
  // Colophon: bookends the document against the eyebrow, in the same mono register. Rendered view only — it is
  // our chrome, not the author's text, so it must never appear in Source. Deliberately NOT uppercased: the
  // eyebrow shouts because it is a label, a colophon should not, and upper-casing would mangle the file name.
  const colophon = h("div", "md-colophon");
  colophon.textContent = "clideck · Read-only view"
    + (item && item.name ? " · figures regenerated from " + item.name : "");
  rendered.appendChild(colophon);
  const source = h("pre", "md-src"); source.textContent = text;
  const body = h("div", "md-view");
  const bRendered = h("button", null, "Rendered"); bRendered.type = "button";
  const bSource = h("button", null, "Source"); bSource.type = "button";
  const paint = () => {
    const src = item.mdSource === true;
    bRendered.className = src ? "" : "on";
    bSource.className = src ? "on" : "";
    bRendered.setAttribute("aria-pressed", String(!src));
    bSource.setAttribute("aria-pressed", String(src));
    body.replaceChildren(src ? source : rendered);
  };
  bRendered.addEventListener("click", () => { item.mdSource = false; paint(); });
  bSource.addEventListener("click", () => { item.mdSource = true; paint(); });
  seg.append(bRendered, bSource);
  const copy = h("button", "cd-viewer-action md-copy", icon('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'));
  copy.type = "button";
  copy.title = "Copy Markdown"; copy.setAttribute("aria-label", "Copy Markdown");
  copy.addEventListener("click", async () => {
    if (copy.disabled) return;
    copy.disabled = true;
    try {
      const copied = await copyText(text);
      toast({ id: "markdown-copy", type: copied ? "success" : "error",
        body: copied ? "Markdown copied" : "Could not copy Markdown. Try selecting the text in Source view." });
    } finally { copy.disabled = false; }
  });
  bar.append(seg, copy);
  shell.append(bar, body);
  paint();
  return shell;
}

// An html preview is the frame and nothing else. Reload used to sit on a full-width bar of its own directly
// under the tab strip — two chrome rows stacked, the second holding one button and otherwise empty. The
// control now lives at the right-hand end of the tab strip, where the tab strip already reserves that space.
function htmlShell(item) {
  const shell = h("div", "cd-html");
  const frame = htmlFrame();
  loadPreview(frame, item);
  shell.append(frame);
  return shell;
}

// Cache-bust so a reload really re-fetches rather than being answered from memory.
function reloadPreview(item) {
  const frame = item && item.node && item.node.querySelector ? item.node.querySelector("iframe") : null;
  if (!frame || !item.url) return false;
  loadPreview(frame, { ...item, url: item.url + (item.url.includes("?") ? "&" : "?") + "r=" + Date.now() });
  return true;
}
function wrapMedia(el) { const w = h("div", "cd-media"); w.appendChild(el); return w; }
function spanIcon(kind) { const s = h("span", "cd-tab-ic"); s.innerHTML = iconForKind(kind) || KIND_ICON[kind] || KIND_ICON.html; return s; }

// The user closed a tab. Tombstone FIRST — before the control goes out or into the offline queue — so the
// suppression is already armed if the reconnect replay beats our close to the wire.
function closeItem(sid, id) {
  const entry = docks.get(sid); if (!entry) return;
  const item = entry.items.find((it) => it.id === id); if (!item) return;
  if (item.workspace) { dropLocally(sid, id); return; }
  tombstone(sid, id);
  closeContent(sid, id);   // durable: the engine drops the asset, so replay cannot bring this tab back
  dropLocally(sid, id);
}

// Workspace applications use the same tab shell as documents, but are client-owned rather than persisted
// content assets. One workspace ID opens once per session; reopening selects the existing tab.
export function openWorkspaceTab(pluginId, definition, options = {}) {
  const sid = (options && options.sessionId) || store.activeId; if (!sid || !store.sessions.has(sid)) return false;
  const entry = docks.get(sid) || { items: [], activeId: null }; docks.set(sid, entry);
  const id = "workspace:" + pluginId + "/" + definition.id;
  let item = entry.items.find((candidate) => candidate.id === id);
  if (!item) {
    item = { id, kind: pluginId + "/" + definition.id, name: String(options.title || definition.title || definition.id), sessionId: sid, workspace: true, pluginId, workspaceDef: definition, options, node: null, built: false };
    entry.items.push(item);
  } else item.options = options;
  entry.activeId = id; if (sid === store.activeId) renderDock(); return true;
}

export function closePluginTabs(pluginId) {
  let any = false;
  for (const [sid, entry] of [...docks]) {
    const before = entry.items.length;
    for (const item of entry.items) if (item.workspace && item.pluginId === pluginId) releaseItemNode(item);
    // Workspaces are client-owned and close on unload. Persisted custom content stays: content.close is the
    // only durable deletion path. The registry change resets its renderer to unavailable/rebuildable.
    entry.items = entry.items.filter((item) => !(item.workspace && item.pluginId === pluginId));
    if (entry.items.length !== before) { any = true; if (!entry.items.length) docks.delete(sid); else if (!entry.items.some((item) => item.id === entry.activeId)) entry.activeId = entry.items[0].id; }
  }
  if (any) renderDock();
}

// Core kinds register through the same lookup the plugin kinds use. Adding a renderer no longer adds another
// bodyFor branch; the host shell remains stable while the implementation is replaceable.
for (const definition of [
  { kind: "text", icon: KIND_ICON.text, build: (item) => fetchView(item, "text", (text) => renderText(text)) },
  { kind: "json", icon: KIND_ICON.json, build: (item) => fetchView(item, "text", (text) => renderJson(text)) },
  { kind: "html", icon: KIND_ICON.html, build: htmlShell },
  { kind: "pdf", icon: KIND_ICON.pdf, build: (item) => pdfEmbed(item.url) },
  { kind: "image", icon: KIND_ICON.image, build: (item) => wrapMedia(imageEl(item.url, item.name)) },
  { kind: "video", icon: KIND_ICON.video, build: (item) => wrapMedia(videoEl(item.url)) },
  { kind: "markdown", icon: KIND_ICON.markdown, build: (item) => fetchView(item, "text", markdownShell) },
  { kind: "diff", icon: KIND_ICON.diff, build: (item) => fetchView(item, "text", (text) => renderDiff(text)) },
  { kind: "mermaid", icon: KIND_ICON.mermaid, build: (item) => fetchView(item, "text", (text) => mermaidEl(text)) },
  { kind: "chart", icon: KIND_ICON.chart, build: (item) => fetchView(item, "json", (spec) => renderChart(spec)) },
  { kind: "testresults", icon: KIND_ICON.testresults, build: (item) => fetchView(item, "json", (spec) => renderTestResults(spec)) },
]) registerCoreViewer(definition);

// The engine dropped an asset — this client, another window, or a lifecycle rule. Purely local and idempotent:
// retire the tab if we still show it, retire the tombstone because the close is now confirmed, and send
// NOTHING. Answering an acknowledgement with another close is exactly the loop this must not have.
function onContentClosed(ev) {
  if (!ev || !ev.sessionId) return;
  clearTombstone(ev.sessionId, ev.contentId);
  dropLocally(ev.sessionId, ev.contentId);
}

function dropLocally(sid, id) {
  const entry = docks.get(sid); if (!entry) return;
  const i = entry.items.findIndex((it) => it.id === id); if (i < 0) return;   // already gone → no-op
  releaseItemNode(entry.items[i]);
  entry.items.splice(i, 1);
  if (!entry.items.length) { docks.delete(sid); renderDock(); return; }
  if (entry.activeId === id) entry.activeId = (entry.items[i] || entry.items[i - 1] || entry.items[0]).id;   // neighbour, VS Code style
  renderDock();
}

function releaseItemNode(item) {
  if (!item) return;
  if (item.node) { disposePluginFrame(item.node); releasePreviews(item.node); if (item.node.remove) item.node.remove(); }
  item.node = null; item.built = false;
}
function releaseEntry(entry) { for (const item of (entry && entry.items) || []) releaseItemNode(item); }
function resetPluginViewerNodes() {
  for (const entry of docks.values()) for (const item of entry.items) {
    if (!item.workspace && String(item.kind || "").includes("/")) releaseItemNode(item);
  }
}

// ── width: resizable + persisted (mirrors the sidebar client-pref pattern) ──
export { renderableKind };
export { markdownShell as __mdShellForTest };   // test seam: the toggle is worth asserting on the real shell
// Test seam: a tombstone that is never retired would be a growing record of what the user closed, so its
// clearing is asserted directly rather than inferred from what happens to be on screen.
export function __pendingClosesForTest(sid) { const s = pendingCloses.get(sid); return s ? [...s] : []; }

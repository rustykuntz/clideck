// The right pane: a real, themed xterm terminal you type into directly.
// Keystrokes go out as {type:'input', sessionId} raw controls. Output events feed
// term.write(). Focusing a session resets the terminal and rewrites its buffer.
// No composer — the terminal IS the input surface.
import { store } from "../store.js";
import { installScrollbackPreservation } from "../terminal-scrollback.js";
import { send, renameSession, openContentPath } from "../ws.js";
import { sessionFace } from "../providers-ui.js";
import { esc, shortId, debounce, copyText, inlineRename, askAddress, SESSION_NAME_MAX, limitSessionName } from "../util.js";
import { onTheme } from "../theme.js";
import { appliedXterm } from "../terminal-themes.js";
import { openTerminalMenu } from "./session-menu.js";
import { toast } from "./toast.js";
import { closePromptDropdown, registerTerminalFocus } from "./prompts.js";
import { attachToTerminal } from "./hotkeys.js";
import { pastePayload } from "./paste.js";
import { startBounce } from "./bounce.js";
import { onTerminalTabShown } from "./content-dock.js";
import { candidatesIn, linkFor, probeDebounced } from "./paths.js";
import { resolveActions, runAction } from "./action-registry.js";
import { registerReadAlongSurface, matchable } from "./read-along.js";

const FONT_FAMILY = "'SF Mono','JetBrains Mono','Fira Code',ui-monospace,Menlo,Consolas,monospace";
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.3;
const URL_RE = /https?:\/\/[^\s]+/g;
const URL_TRAIL = /[),.;:!?\]}'"]+$/;   // trailing punctuation to peel off a matched URL (v1 terminals.js:199-210)

// The xterm palette is the ACTIVE session's applied theme (its per-session override, else the app-mode
// default) — resolved live from the theme library, so switching sessions / picking a theme re-colours the pane.
// A session with no explicit per-session theme always follows the CURRENT app mode's default (appliedXterm →
// defaultThemeId(resolvedTheme())); explicit per-session themes win. (13d B2.)
function applyActiveTheme() {
  if (!term) return;
  const theme = appliedXterm(store.activeId);
  term.options.theme = theme;
  if (!mount) return;
  mount.style.backgroundColor = theme.background;              // pane gutter (below the last row) stays on-theme
  // xterm's DOM renderer never repaints .xterm-viewport after open — it defaults to black, showing through the
  // sub-cell gutter band AND behind an empty/short terminal (reads as a dark pane in light chrome). Keep it on
  // the session theme so the whole pane matches. (13d B1.)
  const vp = mount.querySelector(".xterm-viewport");
  if (vp) vp.style.backgroundColor = theme.background;
}

let term = null;
let mount = null;
let scrollBtn = null;
let nameEl = null;
let renameBtn = null;
let copyResetT = null;
let renaming = false;
let chipBounceStop = null;                                                        // header working animation (see updateHeader)
const stopChipBounce = () => { if (chipBounceStop) { chipBounceStop(); chipBounceStop = null; } };
let renameHandle = null;
let replayWrites = 0;
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const stampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const tokenFormat = new Intl.NumberFormat();

// Replay is a property of a WRITE, not of its bytes: OSC52 is valid live output but must have no clipboard
// side effect when history is restored. Keep the guard raised until xterm confirms parsing, including when
// multiple replay writes overlap.
function writeTerminal(data, replay = false, done) {
  if (!replay) { term.write(data, done); return; }
  replayWrites++;
  try {
    term.write(data, () => { replayWrites--; if (done) done(); });
  } catch (error) { replayWrites--; throw error; }
}

export function initTerminal() {
  mount = document.getElementById("term");
  if (!window.Terminal) { mount.textContent = "xterm failed to load (/vendor/xterm.js)"; return; }

  term = new window.Terminal({
    fontFamily: FONT_FAMILY, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, letterSpacing: 0.3,
    cursorStyle: "block", cursorBlink: true, theme: appliedXterm(store.activeId),
    scrollback: 10000, cols: 120, rows: 34, allowProposedApi: true,
    minimumContrastRatio: 4.5, smoothScrollDuration: 180,        // v1 parity: legibility floor + gentle scroll
    macOptionIsMeta: true, drawBoldTextInBrightColors: true,
  });
  term.open(mount);
  installScrollbackPreservation(term);
  onTheme(applyActiveTheme);                    // app light/dark flip re-applies the active session's theme (mode default may change)
  store.on("config", applyActiveTheme);         // a theme-library config change re-colours the open terminal live
  registerLinks();
  registerTerminalFocus(() => { if (term) term.focus(); });
  // The terminal tab hides rather than unmounts (scrollback must survive), and a hidden element measures 0 so
  // fit() correctly no-ops while away. Coming back therefore needs an EXPLICIT refit + focus.
  onTerminalTabShown(() => requestAnimationFrame(() => { fit(true); if (!renaming) term && term.focus(); updateScrollBtn(); }));          // prompt-paste refocuses the terminal

  // Full per-terminal key + clipboard pipeline (OSC52 → Ctrl+C-copy → Shift+Enter → clear/Ctrl+K → // trigger
  // → registry) lives in hotkeys.js. The pane is shared across sessions, so Shift+Enter's Claude-compatible
  // provider scoping resolves against the LIVE active provider.
  attachToTerminal(term, () => { const s = store.active(); return s ? s.provider : null; }, () => replayWrites > 0);

  // Right-click opens the TEXT menu — copy / paste / read aloud — not the session menu the row ▾ opens.
  // Shift+right-click is left untouched so it passes through to xterm / the native menu (copy-paste).
  mount.addEventListener("contextmenu", async (e) => {
    if (e.shiftKey) return;
    const s = store.active(); if (!s) return;
    e.preventDefault();
    // ONE snapshot, so the text and the anchor describe the same selection. Without the anchor a right-click
    // read has only the words, and words far up the scrollback — or repeated earlier on the screen — are
    // exactly what an anchor exists to place. The hotkey path already had it; this one did not.
    const snapshot = getTerminalSelectionSnapshot();
    const selection = snapshot ? snapshot.text : terminalSelection();
    const project = s.projectId ? store.projects.find((p) => p.id === s.projectId) || null : null;
    const context = { surface: "terminal", selection: { text: selection, surface: "terminal", anchor: snapshot ? snapshot.anchor : "" }, session: { id: s.id, name: s.name || "", provider: s.provider || "", cwd: s.cwd || "", projectId: s.projectId || null, live: s.live !== false, status: s.status || "" }, project };
    const pluginActions = await resolveActions("terminal.context", context);
    if (store.activeId !== s.id) return;
    openTerminalMenu({ x: e.clientX, y: e.clientY }, s.id, {
      returnFocus: term.textarea || mount,
      selection, live: s.live !== false,
      pluginItems: pluginActions.map((action) => ({ label: action.label, onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } })),
    });
  });

  // A paste is one literal input transaction, never a sequence of Enter keypresses. Capture before xterm's
  // textarea handler so clipboard line endings or embedded bracket markers cannot submit partway through.
  mount.addEventListener("paste", (e) => {
    const s = store.active();
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    const bracketedPaste = s?.bracketedPaste ?? term.modes.bracketedPasteMode;
    if (!s || s.live === false || !text || !bracketedPaste) return;
    e.preventDefault();
    e.stopPropagation();
    send({ type: "input", sessionId: s.id, data: pastePayload(text) });
  }, true);

  // every keystroke → raw input for the focused session (menu digits included).
  // Dormant sessions are read-only: the PTY is gone, so input goes nowhere — drop it locally.
  term.onData((data) => { const s = store.active(); if (s && s.live !== false) send({ type: "input", sessionId: s.id, data }); });

  scrollBtn = document.getElementById("scroll-btn");
  nameEl = document.getElementById("th-name");
  renameBtn = document.getElementById("th-rename");
  scrollBtn.onclick = () => { term.scrollToBottom(); updateScrollBtn(); };
  // The title IS the copy control — one click, one meaning. Renaming moved wholly onto the pencil beside it,
  // because a title that both copied on click and renamed on double-click would copy on the way to every rename.
  nameEl.addEventListener("click", () => { if (!renaming) copyAddress(); });
  nameEl.addEventListener("keydown", (e) => { if (!renaming && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); copyAddress(); } });
  // Pressing the ✕ must not first blur the input — blur COMMITS, so the cancel would have saved instead.
  renameBtn.addEventListener("mousedown", (e) => { if (renaming) e.preventDefault(); });
  renameBtn.onclick = () => (renaming ? discardRename() : startRename());
  term.onScroll(() => { updateScrollBtn(); probeVisiblePaths(); });

  requestAnimationFrame(() => fit(false));
  const ro = new ResizeObserver(debounce(() => { fit(true); updateScrollBtn(); }, 90));
  ro.observe(mount);

  store.on("active", (id) => focusSession(id));
  store.on("session:output", (id, data, replay) => { if (id === store.activeId) writeTerminal(data, replay, () => { updateScrollBtn(); probeVisiblePaths(); }); });   // callback fires post-parse, so baseY is current
  store.on("session:update", (id) => { if (id === store.activeId) updateHeader(); });
  store.on("connection", () => { updateHeader(); updateEmpty(); });   // connect lands AFTER reset paints "offline"; with no sessions nothing else ever repaints it
  store.on("chrome", updateEmpty);
  store.on("reset", () => { closePromptDropdown(); term.reset(); applyActiveTheme(); updateHeader(); updateEmpty(); updateScrollBtn(); sentDims.clear(); });
  store.on("session:remove", (id) => sentDims.delete(id));

  // Buffer row numbers stop meaning what they meant after a reflow or a session change, so a selection anchor
  // minted before one is refused rather than adjusted — see getTerminalSelectionSnapshot.
  let epochCols = term.cols;
  term.onResize(({ cols }) => { if (cols === epochCols) return; epochCols = cols; bufferEpoch++; });
  store.on("active", () => bufferEpoch++);
  store.on("reset", () => bufferEpoch++);

  updateHeader(); updateEmpty();
}

function focusSession(id) {
  closePromptDropdown();                        // a session switch cancels any open // dropdown
  applyActiveTheme();                           // re-colour to the newly-active session's theme
  const s = id != null ? store.sessions.get(id) : null;
  updateEmpty();
  updateHeader();
  if (!s) return;
  term.reset();
  // ⚠️ THE CACHE IS THIS BROWSER'S MEMORY, NOT THE PTY'S STATE. Another client can resize the same session
  // while we are looking elsewhere, and the engine does not broadcast that — so on the way back our entry
  // would still say "already told them 92x28", we would skip, and the pty would stay at the other client's
  // size while we render ours. Forget what we think we told THIS session on every explicit focus and
  // re-assert; the engine dedupes against the pty's real size, so a re-assertion that changes nothing costs
  // nothing. Observer ticks after that still dedupe, which is the whole point of the cache.
  sentDims.delete(id);
  if (s.outputBuf) writeTerminal(s.outputBuf, true);   // a focus rewrite is replay even when its buffer contains once-live output
  requestAnimationFrame(() => { fit(true); if (!renaming) term.focus(); updateScrollBtn(); probeVisiblePaths(); });   // don't steal focus from an inline rename

}

// scroll-to-latest arrow: visible only when the viewport is off the live tail.
function updateScrollBtn() {
  if (!term || !scrollBtn) return;
  let atBottom = true;
  try { const b = term.buffer.active; atBottom = b.viewportY >= b.baseY; } catch {}
  scrollBtn.classList.toggle("show", !atBottom);
}

// copy the session's ask address = exactly what /ask resolves: @Project/name in a project, else name||id.
async function copyAddress() {
  const s = store.active(); if (!s) return;
  const addr = askAddress(s, store.projects);
  if (!(await copyText(addr))) return;
  if (nameEl) {                                             // a brief sage flash on the title — it composes with the toast
    nameEl.classList.add("copied");
    clearTimeout(copyResetT);
    copyResetT = setTimeout(() => nameEl.classList.remove("copied"), 1200);
  }
  toast.success({ title: "Ask target copied", body: "`" + addr + "`", markdown: true, id: "copy-address" });
}

// Header inline rename via the shared helper. Live per-project duplicate validation blocks the commit
// and paints the error into the header meta slot; empty reverts. The engine re-broadcasts
// session.created with the new name → the store folds it in → header + row + copy-address all refresh.
function startRename() {
  if (renaming) return;
  const s = store.active(); if (!s) return;
  renaming = true;
  const msg = document.getElementById("th-rename-msg");
  const head = document.getElementById("term-head");
  renameHandle = inlineRename(nameEl, {
    value: limitSessionName(s.name || ""), placeholder: "Name (optional)", maxLength: SESSION_NAME_MAX,
    // The scope is {cwd, projectId} — passing a bare cwd string made scopeKey() resolve to "c:", which
    // matches no session, so the header never saw a duplicate and let a rename the ENGINE then refused go out.
    validate: (name) => (store.isNameTaken({ cwd: s.cwd, projectId: s.projectId }, name, s.id) ? "Name already used in this project" : null),
    showError: (m) => { if (msg) { msg.textContent = m || ""; msg.hidden = !m; } },
    onStart: () => { if (renameBtn) { renameBtn.classList.add("editing"); renameBtn.title = "Cancel rename"; renameBtn.setAttribute("aria-label", "Cancel rename"); } },
    onCommit: (name) => renameSession(s.id, name),
    onEnd: () => {
      renaming = false; renameHandle = null;
      if (renameBtn) { renameBtn.classList.remove("editing"); renameBtn.title = "Rename session"; renameBtn.setAttribute("aria-label", "Rename session"); }
      // The identity signature describes the title the HEADER last painted, and a rename replaces that title
      // behind its back. Without clearing it, ending an edit that did not change s.name — cancel, or a rename
      // the engine refused — repaints nothing and the input stays on screen for good.
      if (head) head._identitySig = "";
      updateHeader();
    },
  });
}
function discardRename() { if (renameHandle) renameHandle.end(); }   // end() → onEnd → renaming=false, updateHeader

// The current xterm selection (only the active session has a live terminal) — feeds the menu's Copy item.
export function terminalSelection() { try { return term && term.hasSelection() ? term.getSelection() : ""; } catch { return ""; } }
export function terminalFocusTarget() { return (term && term.textarea) || mount; }
// ── Read-along ────────────────────────────────────────────────────────────────────────────────────────────
// Supertonic hands us the exact text it spoke plus one cue per WORD ADVANCE, each covering a three-word
// window — "Item 3 is" → "3 is now" → "is now your". The three-word policy and the clock are the PLUGIN's;
// this side only turns a cue into cells. Its times are estimated from the text and pulled straight again at
// every real chunk boundary, so nothing here draws a per-word edge: the mark says "around here", loosely.
//
// We resolve the spoken text against the buffer ONCE, before the first note. After that a clock move only
// slides an already-placed band — no searching while the audio runs, which is what the abandoned experiment
// did and what made it fragile.
//
// One decoration per ROW, spanning everything that row holds of the spoken text, and inside it one BAND that
// moves. xterm keeps the decoration positioned, clipped and hidden on the alternate screen; the window is
// then two style properties on a child, which is why there is no per-advance bookkeeping here at all.

// Buffer row numbers stop meaning what they meant after a reflow or a session change. An anchor minted under
// an older epoch is refused, not adjusted, because the alternative is highlighting the wrong copy.
//
// ⚠️ A REFLOW IS A COLUMN CHANGE. xterm re-wraps its lines when `cols` moves; a change of `rows` alone leaves
// every line's text exactly where it was. Treating the two alike is what made the first read after the audio
// player appeared silently refuse: showing the transport shortens the terminal, that fires onResize with the
// same cols, and the anchor the plugin had just been handed was retired before it was ever used. Read again
// with the bar already up and it worked — which is precisely how it was reported, as intermittent. The
// narrower rule is also safe on its own terms: an anchored reading still has to FIND its words in the cells
// the anchor names, so coordinates that have gone stale some other way produce no mark rather than a wrong one.
let bufferEpoch = 0;
const ANCHOR = /^ra1\.(\d+)\.([^.]+)\.(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

// The selection as a plugin may carry it: its text, plus an OPAQUE token for where those cells are. The token
// is derived, never allocated — the same selection over the same buffer always spells the same string, so a
// plugin can key a speech cache on it and a repeated shortcut still means pause rather than replay.
export function getTerminalSelectionSnapshot() {
  const text = terminalSelection();
  const sessionId = store.activeId ? String(store.activeId) : "";
  if (!text || !sessionId) return null;
  let range = null;
  try { range = term.getSelectionPosition() || null; } catch {}
  const anchor = range ? `ra1.${bufferEpoch}.${sessionId}.${range.start.y}.${range.start.x}.${range.end.y}.${range.end.x}` : "";
  return { sessionId, text, anchor };
}

function readAlongAnchor(value, sessionId) {
  const parts = typeof value === "string" && value ? ANCHOR.exec(value) : null;
  if (!parts) return null;
  if (Number(parts[1]) !== bufferEpoch || parts[2] !== String(sessionId)) return null;   // stale, or another session
  const startY = Number(parts[3]), startX = Number(parts[4]), endY = Number(parts[5]), endX = Number(parts[6]);
  if (endY < startY || (endY === startY && endX <= startX)) return null;
  return { startY, startX, endY, endX };                                                 // endX is exclusive, as xterm reports it
}

function terminalReadAlong(meta) {
  const buffer = term && term.buffer.active;
  if (!term || !buffer || buffer.type !== "normal" || meta.sessionId !== store.activeId) return null;
  // An anchor we cannot trust is a REFUSAL, never a fallback: the plugin sent it precisely because the words
  // it spoke may appear more than once, so settling for the freshest copy is the mistake it was there to stop.
  const anchor = readAlongAnchor(meta.anchor, meta.sessionId);
  if (meta.anchor && !anchor) return null;

  // With an anchor the haystack is the SELECTED CELLS THEMSELVES — first row from its column, last row to its
  // column — so a second copy of the same phrase is not in the haystack to be found. If the scrollback has
  // since trimmed, those coordinates name other text, the match fails, and we refuse. Without an anchor, read
  // a tail generous enough to hold the spoken text and take the freshest copy in it.
  const span = Math.min(buffer.length, Math.max(240, Math.ceil(meta.sourceText.length / Math.max(1, term.cols)) * 3 + 40));
  const top = anchor ? Math.max(0, Math.min(anchor.startY, buffer.length - 1)) : buffer.length - span;
  const bottom = anchor ? Math.min(buffer.length - 1, anchor.endY) : buffer.length - 1;

  // Rebuild LOGICAL lines: a wrapped row continues its predecessor, so it must not contribute a line break.
  const cells = [];
  let flat = "";
  let lineStart = 0;
  for (let y = top; y <= bottom; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const fromX = anchor && y === anchor.startY ? Math.max(0, anchor.startX) : 0;
    const toX = anchor && y === anchor.endY ? Math.min(term.cols, anchor.endX) : term.cols;
    for (let x = fromX; x < toX; x++) {
      const cell = line.getCell(x);
      const width = cell ? cell.getWidth() : 0;
      if (!width) continue;                                   // the trailing half of a wide glyph owns no column
      const chars = cell.getChars() || " ";
      const at = { y, x, width };
      for (let i = 0; i < chars.length; i++) cells.push(at);   // a combining sequence lives in ONE cell
      flat += chars;
    }
    const next = buffer.getLine(y + 1);
    if (y >= bottom || !next || !next.isWrapped) {
      // The BUFFER pads every row out to `cols` with blank cells; xterm's own selection string does not, it
      // trims each line's tail. Left in, that padding is drift between the selection's coordinates and the
      // screen's — and `sourceOffset` is written in the selection's — so on a tall selection of short lines
      // a batch would aim its hint hundreds of characters early. Whitespace only, and only at a line's end.
      let cut = flat.length;
      while (cut > lineStart && flat[cut - 1] === " ") cut--;
      if (cut < flat.length) { flat = flat.slice(0, cut); cells.length = cut; }
      cells.push(null); flat += "\n"; lineStart = flat.length;
    }
  }

  // The EXACT reading first — whitespace only, nothing removed. It is the safe one and it is what selections
  // and un-styled output land on. Only when that finds nothing do we retry with the markdown the renderer has
  // already turned into styling dropped from BOTH sides, for the auto-read case where the spoken text is
  // canonical markdown and the screen holds the rendered form. The LAST occurrence is the one just printed.
  // A long read arrives in batches, and a selection can repeat itself inside ONE of them — "ping the server
  // ... ping the server" is one selection with two identical halves. Without a hint every batch would settle
  // on the LAST copy and the mark would sit still while the voice moved. `sourceOffset` says how far into the
  // selection this batch starts, so we take the occurrence NEAREST that point rather than the newest one.
  // Nearest, not exact: the offset is in the selection's own coordinates and this is the screen's, so it
  // places the batch without pretending the two spellings are the same string.
  // ⚠️ It is only meaningful WITH AN ANCHOR, because only then is the haystack that selection. An auto-read
  // carries no anchor and its offset counts from the start of the REPLY, which the scrollback tail knows
  // nothing about — and every terminal read now arrives with one, `0` for the first batch. Honoured there it
  // would drag a reply the agent printed twice onto the OLDEST copy in the tail. Unanchored, the freshest
  // copy is the answer, which is what `lastIndexOf` already gives.
  const pick = (haystack, needle, hint) => {
    if (!needle) return -1;
    if (hint < 0) return haystack.lastIndexOf(needle);
    let best = -1, bestGap = Infinity;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const gap = Math.abs(at - hint);
      if (gap < bestGap) { best = at; bestGap = gap; }
    }
    return best;
  };
  let screen = matchable(flat), source = matchable(meta.sourceText);
  const hintAt = (reduced) => {
    if (!anchor || meta.sourceOffset < 0) return -1;
    for (let i = meta.sourceOffset; i < flat.length; i++) if (reduced.to[i] >= 0) return reduced.to[i];
    return reduced.text.length;
  };
  let base = pick(screen.text, source.text, hintAt(screen));
  if (base < 0) {
    screen = matchable(flat, true); source = matchable(meta.sourceText, true);
    base = pick(screen.text, source.text, hintAt(screen));
  }
  if (base < 0) return null;

  // Per cue, the cells it covers, one run per row; and per row, everything the whole reading covers there —
  // that union is the decoration, and the cue's run is where the band sits inside it.
  const ranges = [], spans = new Map();
  for (const cue of meta.cues) {
    let from = -1, to = -1;
    for (let i = cue.textStart; i < cue.textEnd; i++) {
      const at = source.to[i];
      if (at < 0) continue;                                    // whitespace, or a marker the renderer replaced
      if (from < 0) from = at;
      to = at;
    }
    const rows = [];
    for (let n = base + from; from >= 0 && n <= base + to; n++) {
      const cell = cells[screen.at[n]];
      if (!cell) continue;
      const row = rows[rows.length - 1];
      if (row && row.y === cell.y) row.end = Math.max(row.end, cell.x + cell.width);
      else rows.push({ y: cell.y, x: cell.x, end: cell.x + cell.width });
    }
    for (const row of rows) {
      const span = spans.get(row.y);
      if (span) { span.x = Math.min(span.x, row.x); span.end = Math.max(span.end, row.end); }
      else spans.set(row.y, { x: row.x, end: row.end });
    }
    ranges.push(rows);                                         // a window that maps to nothing simply does not light
  }
  if (!ranges.some((rows) => rows.length)) return null;

  // Markers are what make this survive live output and scrolling: they track their line as the scrollback
  // grows and retire themselves when it is trimmed away.
  const estimated = meta.timing === "estimated";
  const bands = new Map();
  const parts = [];
  let usable = true, current = -1;

  const place = (y) => {
    const band = bands.get(y), span = spans.get(y);
    if (!band || !span) return;
    const rows = usable && current >= 0 && meta.sessionId === store.activeId ? ranges[current] || [] : [];
    const part = rows.find((row) => row.y === y);
    if (!part) return band.classList.remove("on");
    const width = span.end - span.x;
    band.style.left = ((part.x - span.x) / width * 100) + "%";
    band.style.width = ((part.end - part.x) / width * 100) + "%";
    band.classList.add("on");
  };
  const paint = () => { for (const y of bands.keys()) place(y); };
  const clear = () => { current = -1; paint(); };
  const stand = () => { usable = false; clear(); };

  for (const [y, span] of spans) {
    const marker = term.registerMarker(y - (buffer.baseY + buffer.cursorY));
    const decoration = marker && term.registerDecoration({ marker, x: span.x, width: span.end - span.x, layer: "bottom" });
    if (!decoration) {
      if (marker) marker.dispose();
      for (const part of parts) { try { part.decoration.dispose(); part.marker.dispose(); } catch {} }
      return null;
    }
    parts.push({ marker, decoration });
    // xterm owns the element and keeps it positioned, clipped to the viewport and hidden on the alternate
    // screen. We add our class and the one child that moves; the look lives entirely in CSS.
    decoration.onRender((element) => {
      element.classList.add("term-read-along");
      let band = element.firstElementChild;
      if (!band) { band = document.createElement("div"); band.className = "ra-band"; element.appendChild(band); }
      band.classList.toggle("ra-estimated", estimated);
      bands.set(y, band);
      place(y);
    });
  }

  // A reflow re-wraps every line, so the prepared columns stop describing the text; switching or resetting the
  // session replaces the buffer outright. Retire the reading instead of guessing new coordinates — the next
  // thing spoken resolves against the new geometry, once. A change of ROWS is not that: xterm's own markers
  // keep each decoration on its line, so the reading simply carries on — which it must, because the audio
  // player appearing is itself a change of rows, in the middle of the reading it belongs to.
  const preparedCols = term.cols;
  const resize = term.onResize(({ cols }) => { if (cols !== preparedCols) stand(); });
  const offs = [() => resize.dispose(), store.on("active", stand), store.on("reset", stand)];
  // The words may have left the screen while the plugin was synthesising — an agent that keeps printing
  // scrolls them off the top, and a mark on a line nobody can see reads exactly like no mark at all. So the
  // first thing a reading does is bring its own text into view. ONCE, at the start: after that the user is
  // free to scroll, and a reader that dragged the viewport back on every word would be unusable.
  let arrived = false;
  const reveal = (rows) => {
    if (arrived || !rows || !rows.length) return;
    arrived = true;
    const top = buffer.viewportY, y = rows[0].y;
    if (y >= top && y < top + term.rows) return;
    try { term.scrollToLine(Math.max(0, y - Math.floor(term.rows / 3))); } catch {}
  };
  return {
    show(index) { current = index; reveal(ranges[index]); paint(); },
    clear,
    dispose() {
      clear();
      for (const off of offs) { try { off(); } catch {} }
      for (const part of parts) { try { part.decoration.dispose(); } catch {} try { part.marker.dispose(); } catch {} }
      bands.clear();
    },
  };
}
registerReadAlongSurface("terminal", terminalReadAlong);

export function commitTerminalDraft(text, options = {}) {
  text = String(text == null ? "" : text);
  const sessionId = String(options.sessionId || "");
  const session = store.active();
  if (!text || !sessionId || !session || session.id !== sessionId || session.live === false) return false;
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) return false;
  send({ type: "input", sessionId, data: pastePayload(text) + (options.submit === true ? "\r" : "") });
  if (term) term.focus();
  return true;
}

// Clickable URLs (v1 terminals.js:199-239): per buffer line, match http/https, peel trailing punctuation,
// open in a new tab with the opener severed. xterm underlines provided links + shows a pointer on hover.
function openUrl(url) { const w = window.open(url, "_blank", "noopener,noreferrer"); if (w) w.opener = null; }
const linkProviders = [];
function addLinkProvider(p) { linkProviders.push(p); term.registerLinkProvider(p); }
// Gate seam: the browser gate drives these EXACT objects, so it exercises the real matcher and the real
// wrapped-line range maths rather than a copy of them.
export function __linkProvidersForTest() { return linkProviders; }
export function __termForTest() { return term; }   // gate seam: real cols/viewportY, never assumed

function registerLinks() {
  if (!term.registerLinkProvider) return;
  addLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { callback(undefined); return; }
      const text = line.translateToString(true);
      const links = []; let m; URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(text))) {
        let url = m[0];
        const t = url.match(URL_TRAIL);
        if (t) url = url.slice(0, url.length - t[0].length);
        if (url.length < 11 || !/^https?:\/\/[^\s.]+\.[^\s]/.test(url)) continue;   // needs a host with a dot
        const sx = m.index + 1, ex = m.index + url.length;                          // 1-based, end inclusive
        links.push({ text: url, range: { start: { x: sx, y }, end: { x: ex, y } }, activate: (_e, uri) => openUrl(uri) });
      }
      callback(links.length ? links : undefined);
    },
  });
  // A SECOND provider for printed document paths. It only ever offers a link for a candidate the engine has
  // already confirmed is a renderable file — an unprobed or missing path stays plain text, so nothing here can
  // promise something that is not there.
  addLinkProvider({
    provideLinks(y, callback) {
      const sid = store.activeId;
      if (!sid) { callback(undefined); return; }
      const { start, text, cols } = logicalLine(y);
      if (!text) { callback(undefined); return; }
      const links = [];
      const pos = (i) => ({ x: (i % cols) + 1, y: start + Math.floor(i / cols) + 1 });   // 1-based, may span rows
      for (const c of candidatesIn(text)) {
        const abs = linkFor(sid, c.text);
        if (typeof abs !== "string") continue;                                      // undefined = unprobed, null = not a file
        links.push({ text: c.text, range: { start: pos(c.start - 1), end: pos(c.end - 1) }, activate: () => openContentPath(sid, abs) });
      }
      callback(links.length ? links : undefined);
    },
  });
}

// xterm WRAPS long output, and one printed path can straddle the wrap — the first probe of Or's own example
// went out as "MMER-INPUT-…SPEC.md" because the row it landed on held only the tail. So rebuild the LOGICAL
// line: walk back over continuation rows, then forward while they keep wrapping. Rows are read UNTRIMMED so
// every row is exactly `cols` wide and an offset maps back to (row, column) by division — trimming would
// silently shift every position after the first short row.
function logicalLine(y) {
  const cols = term.cols || 80;
  const b = term.buffer.active;
  let start = y - 1;
  while (start > 0) { const l = b.getLine(start); if (l && l.isWrapped) start--; else break; }
  let text = "";
  for (let i = start; i < b.length; i++) {
    const l = b.getLine(i);
    if (!l || (i > start && !l.isWrapped)) break;
    text += l.translateToString(false);
  }
  return { start, text, cols };
}

// Probe the VISIBLE rows only, debounced. The whole scrollback on every frame would be a stat storm over text
// nobody is looking at; paths.js then never re-probes a candidate it has already resolved either way.
function probeVisiblePaths() {
  const sid = store.activeId;
  if (!term || !sid) return;
  let texts = [];
  try {
    const b = term.buffer.active;
    const seen = new Set();
    for (let i = 0; i < term.rows; i++) {
      if (!b.getLine(b.viewportY + i)) continue;
      // Probe the LOGICAL line, deduped by its start row: a candidate cut in half at the wrap would be probed
      // as a fragment, and the engine would rightly answer null for a file that does exist.
      const { start, text } = logicalLine(b.viewportY + i + 1);
      if (seen.has(start)) continue;
      seen.add(start);
      if (text) texts.push(text);
    }
  } catch { texts = []; }
  if (texts.length) probeDebounced(sid, texts);
}

// manual fit (FitAddon-style, no dep): size the grid to the padded pane.
function cellSize() {
  try {
    const cell = term._core && term._core._renderService && term._core._renderService.dimensions
      && term._core._renderService.dimensions.css && term._core._renderService.dimensions.css.cell;
    if (cell && cell.width > 0 && cell.height > 0) return { w: cell.width, h: cell.height };
  } catch {}
  // fallback: measure the font on a canvas
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = FONT_SIZE + "px " + FONT_FAMILY;
  return { w: ctx.measureText("M").width || FONT_SIZE * 0.6, h: Math.ceil(FONT_SIZE * LINE_HEIGHT) };
}

function fit(sendResize) {
  if (!term || !mount || mount.clientWidth === 0) return;
  const cs = getComputedStyle(mount);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const cell = cellSize();
  let scrollW = 0;
  try { scrollW = (term._core && term._core.viewport && term._core.viewport.scrollBarWidth) || 0; } catch {}
  const cols = Math.max(20, Math.floor((mount.clientWidth - padX - scrollW) / cell.w));
  const rows = Math.max(6, Math.floor((mount.clientHeight - padY) / cell.h));
  if (!isFinite(cols) || !isFinite(rows)) return;
  store.setTermSize(cols, rows);                    // remembered for the session.restart dims
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
  // Avoid redundant resize requests: agents may clear history when their size changes.
  // Guard by what was sent FOR THIS SESSION, not term.cols: after a switch the terminal
  // may already be the right size while that session's pty has never been told.
  if (!sendResize || store.activeId == null) return;
  const dims = cols + "x" + rows;
  if (sentDims.get(store.activeId) === dims) return;
  sentDims.set(store.activeId, dims);
  send({ type: "resize", sessionId: store.activeId, cols, rows });
}
// Last dims actually sent to the engine, per session. Dropped when a session goes, so a replacement pty is
// always told once; cleared wholesale on reset, where every pty is new.
const sentDims = new Map();
export function __sentDimsForTest() { return sentDims; }

function updateHeader() {
  if (renaming) return;                 // don't clobber the inline name input mid-edit
  const s = store.active();
  const head = document.getElementById("term-head");
  if (!s) { stopChipBounce(); const c = document.getElementById("th-chip"); if (c) c._sig = ""; head.classList.add("hidden"); return; }
  head.classList.remove("hidden");
  const p = sessionFace(s);   // §A: custom-command sessions show their command's icon/label
  const address = askAddress(s, store.projects);
  const identitySig = [s.id, s.name || "", p.sig, p.id, p.label, address].join("\0");
  if (head._identitySig !== identitySig) {
    head._identitySig = identitySig;
    const av = document.getElementById("th-avatar");
    av.className = "th-avatar " + p.cls; av.replaceChildren(p.mark());
    const title = document.getElementById("th-name");
    // The avatar identifies the provider; the name distinguishes this session from the others.
    title.innerHTML = s.name
      ? esc(limitSessionName(s.name))
      : esc(p.label) + ' <span>· ' + esc(shortId(s.id)) + "</span>";
    title.title = "Copy ask address — " + address;
  }
  const chip = document.getElementById("th-chip");
  chip.className = "tb-status th-pill";
  let label, dot;
  if (s.closed) { label = "closed"; dot = "offline"; chip.classList.add("st-closed"); }
  else if (s.live === false) { label = "asleep · read-only"; dot = "offline"; chip.classList.add("st-closed"); }
  else if (s.attention) { label = "needs you"; dot = "attention"; chip.classList.add("st-attention"); }
  else if (s.status === "working") { label = "working"; dot = "working"; chip.classList.add("st-working"); }
  else if (s.status === "idle") { label = "idle"; dot = "idle"; chip.classList.add("st-idle"); }
  else { label = "starting…"; dot = "offline"; chip.classList.add("st-closed"); }
  // Rebuild the chip ONLY when the state actually changes — updateHeader runs on every session:update
  // (agent.update fires constantly while working), and a rebuild each time would restart the balls forever.
  const sig = dot + "|" + label;
  if (chip._sig !== sig) {
    chip._sig = sig;
    stopChipBounce();
    // Working shows the balls INSTEAD of the dot — one motion signal per surface, matching v1's pill.
    chip.innerHTML = (dot === "working" ? '<span class="tb-bounce"></span>' : '<span class="dot ' + dot + '"></span>') + " <span>" + label + "</span>";
    if (dot === "working") chipBounceStop = startBounce(chip.querySelector(".tb-bounce"));
  }
  paintHeaderTelemetry(s);
  // The model qualifies the context window beside it, so it sits with it — quiet, unboxed, and capped in CSS
  // so a long id can never push the pills off their column. Unknown shows nothing at all.
  const model = document.getElementById("th-model");
  if (model) { model.textContent = s.model || ""; if (s.model) model.title = "Model: " + s.model; else model.removeAttribute("title"); }
  document.getElementById("th-meta").textContent = s.pid ? "pid " + s.pid : (s.live === false ? "saved" : "");
  const rp = document.getElementById("rp");
  const wasReadonly = rp.classList.contains("readonly");
  const readonly = s.live === false;
  rp.classList.toggle("readonly", readonly);
  term.options.cursorBlink = !readonly;                       // blink returns when a resumed session goes live
  if (wasReadonly && !readonly && store.activeId === s.id) {  // dormant→live flip on the open session: keep the buffer, sync PTY size, focus for input
    requestAnimationFrame(() => { fit(true); term.focus(); });
  }
}

function paintHeaderTelemetry(session) {
  const context = document.getElementById("th-context");
  const usage = session.contextUsage;
  if (context) {
    const usageSig = usage ? [usage.usedTokens, usage.windowTokens, usage.percent, usage.estimated].join("|") : "";
    if (context._sig !== usageSig) {
      context._sig = usageSig;
      context.hidden = !usage;
      if (usage) {
        const percent = Math.round(usage.percent);
        context.classList.toggle("estimated", usage.estimated);
        context.classList.toggle("warm", percent >= 75 && percent < 90);
        context.classList.toggle("hot", percent >= 90);
        context.setAttribute("aria-valuenow", String(percent));
        context.setAttribute("aria-label", "Context usage " + percent + " percent" + (usage.estimated ? ", estimated" : ", exact") + ". " + tokenFormat.format(usage.usedTokens) + " of " + tokenFormat.format(usage.windowTokens) + " tokens.");
        context.title = tokenFormat.format(usage.usedTokens) + " / " + tokenFormat.format(usage.windowTokens) + " tokens · " + (usage.estimated ? "Estimated" : "Exact");
        const fill = document.getElementById("th-context-fill"); if (fill) fill.style.width = usage.percent + "%";
        const value = document.getElementById("th-context-value"); if (value) value.textContent = percent + "%";
      } else context.removeAttribute("aria-valuenow");
    }
  }
  const last = document.getElementById("th-last");
  if (last && last._at !== session.lastAgentAt) {
    last._at = session.lastAgentAt;
    last.hidden = !session.lastAgentAt;
    if (session.lastAgentAt) {
      const date = new Date(session.lastAgentAt), time = clockFormat.format(date);
      last.title = "Last finalized reply · " + stampFormat.format(date);
      last.setAttribute("aria-label", "Last finalized agent reply at " + time);
      const value = document.getElementById("th-last-value"); if (value) value.textContent = time;
    }
  }
}

function updateEmpty() {
  const s = store.active();
  document.getElementById("rp").classList.toggle("hidden", !s);
  const empty = document.getElementById("rp-empty");
  empty.classList.toggle("hidden", !!s);
  if (!s) {
    const anyLive = store.sessions.size > 0;
    document.getElementById("rp-empty-big").textContent = !store.connected ? "Engine offline" : anyLive ? "No session selected" : "No sessions yet";
    document.getElementById("rp-empty-sub").textContent = !store.connected ? "Reconnecting…" : anyLive ? "Pick a session on the left." : "Press + to start one.";
  }
}

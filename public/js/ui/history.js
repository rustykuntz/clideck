// Read-only canonical conversation history. The terminal remains a bounded live surface; older user/agent
// turns are fetched from the append-only transcript JSONL in small pages as this list is scrolled upward.
import { store } from "../store.js";
import { requestTranscriptPage } from "../ws.js";
import { h, shortId, copyText } from "../util.js";
import { toast } from "./toast.js";
import { openMenu } from "./menu.js";

const PAGE_SIZE = 30;
const NEAR_TOP = 64;          // px from the top that pulls the next page in
const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const DOWNLOAD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
const EXPORT_PAGE = 100;      // the engine's largest transcript page
const CLOSE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let overlay = null;
let list = null;
let more = null;
let sessionId = null;
let cursor;
let requestedBefore = null;
let loading = false;
let hasMore = true;
let failed = false;           // retry explicitly or scroll upward again
let lastError = "";
let returnFocus = null;
let offPage = null;
let offActive = null;
let offRemove = null, offAppend = null, offConnection = null, offReset = null, offReplay = null;
let replaying = false;
let search = null, clear = null, updates = null, query = "", searchTimer = null;
let requestId = null, requestSequence = 0, interrupted = false;

export function initHistory(terminalFocusTarget) {
  const trigger = document.getElementById("th-history");
  if (!trigger) return;
  trigger.addEventListener("click", (event) => {
    const focus = event.detail === 0 ? trigger : terminalFocusTarget && terminalFocusTarget();
    openHistory(focus || trigger);
  });
}

function openHistory(focusTarget) {
  const session = store.active();
  if (!session) return;
  closeHistory(false);
  sessionId = session.id; query = ""; interrupted = false; replaying = false;
  cursor = undefined;
  loading = false;
  hasMore = true;
  failed = false; lastError = "";
  returnFocus = focusTarget;

  overlay = h("div", "hist-overlay");
  const modal = h("div", "hist-modal");
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", "Conversation history");
  const head = h("div", "hist-head");
  const heading = h("div", "hist-heading");
  heading.append(h("div", "hist-title", "Conversation history"));
  const subtitle = h("div", "hist-subtitle");
  subtitle.textContent = session.name || shortId(session.id);
  heading.append(subtitle);
  const close = h("button", "hist-close", CLOSE_ICON);
  close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
  close.onclick = () => closeHistory();
  const field = h("div", "hist-search");
  search = h("input", "hist-search-input"); search.type = "search"; search.maxLength = 256;
  search.placeholder = "Search saved conversation"; search.setAttribute("aria-label", search.placeholder);
  clear = h("button", "hist-search-clear", CLOSE_ICON); clear.type = "button"; clear.hidden = true; clear.setAttribute("aria-label", "Clear search");
  clear.onclick = () => { search.value = ""; refresh(); search.focus(); };
  search.addEventListener("input", () => { if (!search.isComposing) refresh(200); });
  search.addEventListener("compositionstart", () => { search.isComposing = true; clearTimeout(searchTimer); requestId = null; });
  search.addEventListener("compositionend", () => { search.isComposing = false; refresh(200); });
  field.append(search, clear);
  // Whole-conversation actions: they always cover every saved turn, not just the loaded or matching ones.
  const copyAll = h("button", "hist-act", COPY_ICON); copyAll.type = "button";
  copyAll.title = "Copy conversation"; copyAll.setAttribute("aria-label", "Copy conversation");
  copyAll.onclick = () => exportConversation("copy", copyAll);
  const download = h("button", "hist-act", DOWNLOAD_ICON); download.type = "button";
  download.title = "Download conversation"; download.setAttribute("aria-label", "Download conversation"); download.setAttribute("aria-haspopup", "menu");
  download.onclick = () => openMenu(download, [
    { label: "Text file (.txt)", onSelect: (ctl) => { ctl.close(); exportConversation("txt", download); } },
    { label: "Markdown (.md)", onSelect: (ctl) => { ctl.close(); exportConversation("md", download); } },
  ], { align: "end" });
  head.append(heading, field, copyAll, download, close);
  updates = h("button", "hist-updates"); updates.type = "button"; updates.hidden = true;
  updates.onclick = () => refresh();

  list = h("div", "hist-list");
  // Older turns arrive by scrolling; failures offer an explicit retry even when the list is empty.
  more = h("div", "hist-more");
  more.setAttribute("aria-live", "polite");
  list.append(more);
  list.addEventListener("scroll", onScroll);
  modal.append(head, updates, list);
  overlay.append(modal);
  overlay.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    if (event.target === overlay) closeHistory();
  });
  overlay.addEventListener("click", (event) => event.stopPropagation());
  document.body.append(overlay);
  document.body.classList.add("cd-modal-open");
  document.addEventListener("keydown", onKey, true);
  offPage = store.on("transcript:page", onPage);
  offActive = store.on("active", (id) => { if (!replaying && id !== sessionId) closeHistory(); });
  offRemove = store.on("session:remove", (id) => { if (id === sessionId) closeHistory(); });
  offReset = store.on("reset", () => { replaying = true; });
  offReplay = store.on("transcripts", () => { replaying = false; if (!store.sessions.has(sessionId)) closeHistory(); });
  offAppend = store.on("transcript:append", (id) => { if (id === sessionId) showUpdates(); });
  offConnection = store.on("connection", (connected) => {
    if (!connected) { interrupted = interrupted || loading; requestId = null; loading = false; renderMore(); return; }
    if (interrupted || cursor === undefined) { interrupted = false; failed = false; loadOlder(); }
    else { showUpdates("Reconnected"); renderMore(); }
  });
  const opened = overlay;
  requestAnimationFrame(() => { if (overlay === opened) { overlay.classList.add("show"); search.focus(); } });
  loadOlder();
}

function showUpdates(prefix = "New messages") {
  updates.textContent = prefix + (query ? " · Refresh search" : " · Jump to latest");
  updates.hidden = false;
}
function refresh(delay = 0) {
  clearTimeout(searchTimer); searchTimer = null; requestId = null;
  query = search.value.slice(0, 256).trim(); clear.hidden = !search.value;
  cursor = undefined; requestedBefore = null; loading = false; hasMore = true; failed = false; lastError = "";
  list.replaceChildren(more); updates.hidden = true;
  if (delay) {
    loading = true; renderMore();
    searchTimer = setTimeout(() => { searchTimer = null; loading = false; loadOlder(); }, delay);
  } else loadOlder();
}

// Nearing the top pulls the next page in. A failed page is not a dead end: `failed` is cleared here, so simply
// scrolling up again retries; the status also offers a Retry button.
function onScroll() {
  if (!list || list.scrollTop >= NEAR_TOP) return;
  if (failed) { failed = false; renderMore(); }
  loadOlder();
}

function loadOlder() {
  if (!overlay || loading || !hasMore || failed) return;
  if (!store.connected) { renderMore(); return; }
  loading = true;
  requestedBefore = Number.isSafeInteger(cursor) ? cursor : null;
  renderMore();
  requestId = "history-" + Date.now().toString(36) + "-" + (++requestSequence);
  requestTranscriptPage(sessionId, cursor, PAGE_SIZE, { query, requestId });
}

// Lazy loading needs something to scroll. If a page doesn't overflow the panel there is no scrollbar and no
// scroll event will ever fire, so keep pulling until the list is actually scrollable or history runs out.
function fillViewport() {
  if (!list || loading || !hasMore || failed) return;
  if (list.scrollHeight <= list.clientHeight + NEAR_TOP) loadOlder();
}

function onPage(result) {
  if (!overlay || result.sessionId !== sessionId || !loading || !requestId
    || (result.before ?? null) !== requestedBefore) return;
  if (typeof result.requestId !== "string") {
    loading = false; failed = true;
    lastError = "Restart the CliDeck engine, then refresh this page to use updated conversation history.";
    renderMore(); return;
  }
  if (result.requestId !== requestId || (result.query ?? "") !== query) return;
  loading = false;
  if (!result.success) {
    failed = true;                       // scrolling up again clears this and retries (onScroll)
    lastError = result.error || "";
    renderMore();
    more.classList.add("error");
    return;
  }

  const initial = cursor === undefined;
  const oldHeight = Number(list.scrollHeight) || 0;
  const turns = Array.isArray(result.turns) ? result.turns : [];
  // `children` is an HTMLCollection in a real browser — it has no indexOf, so the old lookup threw here on
  // EVERY page and nothing ever rendered. The status strip is always first, so older turns insert right after it.
  const anchor = more.nextSibling || null;
  for (const turn of turns) list.insertBefore(turnElement(turn), anchor);
  cursor = Number.isSafeInteger(result.cursor) ? result.cursor : null;
  hasMore = result.hasMore === true;
  renderMore(turns.length === 0 && initial);
  const paintedRequest = requestId;
  requestAnimationFrame(() => {
    if (!list || requestId !== paintedRequest) return;
    // Anchor the reader: on the first page land at the newest turn, afterwards keep the turn they were looking
    // at exactly where it was while older content is prepended above it.
    if (initial) list.scrollTop = list.scrollHeight;
    else list.scrollTop += Math.max(0, (Number(list.scrollHeight) || 0) - oldHeight);
    fillViewport();                      // a short page leaves nothing to scroll — keep pulling until it does
  });
}

function turnElement(turn) {
  const role = turn.role === "user" ? "user" : "agent";
  const row = h("article", "hist-turn " + role);
  const meta = h("div", "hist-turn-meta");
  meta.append(h("span", "hist-role", role === "user" ? "You" : "Agent"));
  if (turn.ts) {
    const time = h("time", "hist-time");
    const date = new Date(turn.ts);
    if (!Number.isNaN(date.getTime())) time.textContent = date.toLocaleString();
    if (time.textContent) meta.append(time);
  }
  const copy = h("button", "hist-turn-copy", COPY_ICON); copy.type = "button";
  copy.title = "Copy message"; copy.setAttribute("aria-label", "Copy message");
  copy.onclick = async () => { const ok = await copyText(String(turn.text || "")); toast({ id: "history-copy", type: ok ? "success" : "error", body: ok ? "Message copied" : "Couldn't copy the message." }); };
  meta.append(copy);
  const text = h("pre", "hist-text");
  const value = String(turn.text || "");
  let highlightNote = null;
  if (!query) text.textContent = value;
  else {
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let offset = 0, highlights = 0, capped = false;
    for (const match of value.matchAll(pattern)) {
      if (highlights++ === 200) { capped = true; break; }
      text.append(document.createTextNode(value.slice(offset, match.index)));
      const mark = h("mark"); mark.textContent = match[0]; text.append(mark); offset = match.index + match[0].length;
    }
    text.append(document.createTextNode(value.slice(offset)));
    if (capped) highlightNote = h("div", "hist-highlight-note", "First 200 matches highlighted.");
  }
  row.append(meta, text); if (highlightNote) row.append(highlightNote);
  return row;
}

// ── whole-conversation export ──
// Reads every saved turn (newest page first, then older), independent of what the list has loaded or matched.
let exporting = false;
function fetchAllTurns(id) {
  return new Promise((resolve, reject) => {
    const turns = [], tag = "history-all-" + Date.now().toString(36) + "-";
    let page = 0, before;
    const off = store.on("transcript:page", (result) => {
      if (result.sessionId !== id || typeof result.requestId !== "string" || result.requestId !== tag + page) return;
      if (!result.success) { off(); reject(new Error(result.error || "Couldn't read the saved conversation.")); return; }
      turns.unshift(...(Array.isArray(result.turns) ? result.turns : []));
      if (result.hasMore === true && Number.isSafeInteger(result.cursor) && page < 2000) { before = result.cursor; next(); }
      else { off(); resolve(turns); }
    });
    const next = () => {
      if (!store.connected) { off(); reject(new Error("Offline — reconnect to export the conversation.")); return; }
      page++; requestTranscriptPage(id, before, EXPORT_PAGE, { requestId: tag + page });
    };
    next();
  });
}
function stamp(ts) { const d = ts ? new Date(ts) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString() : ""; }
function formatConversation(name, turns, markdown) {
  const who = (t) => (t.role === "user" ? "You" : "Agent");
  if (markdown) {
    return "# " + name + "\n\n" + turns.map((t) => "### " + who(t) + (stamp(t.ts) ? " · " + stamp(t.ts) : "") + "\n\n" + String(t.text || "").trim() + "\n").join("\n");
  }
  return name + "\n\n" + turns.map((t) => who(t) + (stamp(t.ts) ? " · " + stamp(t.ts) : "") + "\n" + String(t.text || "").trim() + "\n").join("\n");
}
async function exportConversation(kind, button) {
  if (exporting || !sessionId) return;
  const id = sessionId, session = store.sessions.get(id), name = (session && session.name) || shortId(id);
  exporting = true; button.disabled = true; button.classList.add("busy");
  try {
    const turns = await fetchAllTurns(id);
    if (!turns.length) { toast({ id: "history-export", type: "info", body: "There's no saved conversation yet." }); return; }
    const text = formatConversation(name, turns, kind === "md");
    if (kind === "copy") {
      const ok = await copyText(text);
      toast({ id: "history-export", type: ok ? "success" : "error", body: ok ? "Conversation copied (" + turns.length + " messages)" : "Couldn't copy. Use Download instead." });
      return;
    }
    const file = (name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "conversation") + "-" + new Date().toISOString().slice(0, 10) + "." + kind;
    const url = URL.createObjectURL(new Blob([text], { type: (kind === "md" ? "text/markdown" : "text/plain") + ";charset=utf-8" }));
    const a = h("a"); a.href = url; a.download = file; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast({ id: "history-export", type: "success", body: "Saved " + file });
  } catch (error) {
    toast({ id: "history-export", type: "error", body: error.message || "Couldn't export the conversation." });
  } finally { exporting = false; button.disabled = false; button.classList.remove("busy"); }
}

function renderMore(empty = false) {
  if (!more) return;
  empty = empty || (!loading && !failed && !hasMore && !list.querySelector(".hist-turn"));
  more.classList.remove("error");
  // Scrolling loads older pages; errors also offer Retry.
  if (!store.connected) more.textContent = "Offline — reconnect to load conversation history.";
  else if (loading) more.textContent = query ? "Searching saved conversation…" : "Loading older messages…";
  else if (failed) more.textContent = lastError || "Couldn't load older messages — scroll up to retry";
  else if (empty) more.textContent = query ? "No matching saved messages" : "No saved conversation yet";
  else if (hasMore) more.textContent = query ? "Scroll up for older matches" : "Scroll up for older messages";
  else more.textContent = query ? "All saved matches loaded" : "Beginning of conversation";
  if (failed && store.connected) {
    const retry = h("button", "hist-retry", "Retry"); retry.type = "button";
    retry.onclick = () => { failed = false; loadOlder(); }; more.append(retry);
  }
}

function onKey(event) {
  if (event.key !== "Escape" || event.isComposing || search?.isComposing) return;
  event.preventDefault(); event.stopPropagation(); closeHistory();
}

function closeHistory(restore = true) {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey, true);
  if (offPage) offPage(); if (offActive) offActive(); if (offRemove) offRemove();
  offAppend?.(); offConnection?.(); offReset?.(); offReplay?.();
  offAppend = offConnection = offReset = offReplay = null;
  clearTimeout(searchTimer); searchTimer = null; requestId = null;
  offPage = offActive = offRemove = null;
  const node = overlay;
  const focus = returnFocus;
  overlay = list = more = search = clear = updates = null;
  sessionId = null; cursor = undefined; requestedBefore = null;
  loading = false; hasMore = true; failed = false; lastError = ""; returnFocus = null;
  node.classList.remove("show");
  setTimeout(() => { node.remove(); if (!overlay) document.body.classList.remove("cd-modal-open"); }, 180);
  if (restore && focus && focus.focus) focus.focus();
}

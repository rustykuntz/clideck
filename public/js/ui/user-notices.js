// Messages an agent sends to the person with `clideck notify` — core, so they work with or without any chat
// app plugin. The engine keeps the unread ones (GET /api/notifications, WS user.notices replay + user.notice
// live); this module shows each as a sticky toast with Open session, and marks it read when the person opens
// or dismisses it (POST {action:"read", id}). Shown at most once per page, so a reconnect replay never
// toasts twice; read in another window → its toast leaves here too. An engine without the endpoint (404)
// simply has no notices.
import { store } from "../store.js";
import { toast } from "./toast.js";

const API = "/api/notifications";
const MAX_TOASTS = 3;
const ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.4A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14h4"/></svg>';

let unread = [];                      // engine truth: [{id, sessionId, text, at}]
let updates = 0;
const shown = new Map();              // id → toast handle while on screen, null once gone
let summary = null, summaryCount = 0, summaryHidden = new Set();
const visible = () => [...shown.values()].filter(Boolean).length;
const valid = (n) => n && typeof n.id === "string" && n.id && n.read !== true;

function markRead(id) {
  fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", id }) })
    .then((r) => r.json().catch(() => null).then((body) => { if (r.ok && body && Array.isArray(body.notices)) adopt(body.notices); }))
    .catch(() => {});
}
function show(n) {
  if (shown.has(n.id)) return;
  const name = store.sessions.get(n.sessionId)?.name || "";
  const done = () => { shown.set(n.id, null); markRead(n.id); };
  shown.set(n.id, toast({
    id: "notice-" + n.id, type: "info", duration: 0, iconHtml: ICON,
    title: name || "Message from an agent",
    body: String(n.text || ""),
    ...(name ? { action: { label: "Open session", onClick: () => { store.select(n.sessionId); done(); } } } : {}),
    onDismiss: done,
  }));
}
// The newest few as toasts; older unread ones fold into one summary so a chatty agent can't bury the screen.
function sync() {
  const ids = new Set(unread.map((n) => n.id));
  for (const [id, handle] of shown) if (!ids.has(id) && handle) { handle.dismiss(); shown.set(id, null); }
  const fresh = unread.filter((n) => !shown.has(n.id)).sort((a, b) => (a.at || 0) - (b.at || 0));
  const room = Math.max(0, MAX_TOASTS - visible());
  if (room) for (const n of fresh.slice(-room)) show(n);
  const waiting = unread.filter((n) => !shown.has(n.id));
  if (!waiting.length) { summary?.dismiss(); summary = null; summaryCount = 0; return; }
  if (!summary && waiting.every((n) => summaryHidden.has(n.id))) return;
  if (summary && summaryCount === waiting.length) return;
  summaryCount = waiting.length;
  summary = toast({
    id: "notice-more", type: "info", duration: 0, iconHtml: ICON,
    title: waiting.length === 1 ? "1 more message from an agent" : `${waiting.length} more messages from agents`,
    body: "Older messages you haven’t read yet.",
    action: { label: "Mark all read", onClick: () => { for (const n of waiting) { shown.set(n.id, null); markRead(n.id); } summary = null; summaryCount = 0; } },
    onDismiss: () => { summaryHidden = new Set(waiting.map((n) => n.id)); summary = null; summaryCount = 0; },
  });
}
function adopt(list) { unread = (Array.isArray(list) ? list : []).filter(valid); sync(); }

// A late GET never overwrites a newer replay/broadcast.
export async function loadNotices() {
  const seen = updates;
  try {
    const response = await fetch(API, { cache: "no-store" });
    if (!response.ok) return;                      // 404 = engine without notices; nothing to show
    const body = await response.json().catch(() => null);
    if (updates === seen && body && Array.isArray(body.notices)) adopt(body.notices);
  } catch {}
}

export function initUserNotices() {
  store.on("user:notices", (ev) => { updates++; adopt(ev.notices); });
  store.on("user:notice", (n) => {
    if (!valid(n) || shown.has(n.id)) return;
    updates++;
    if (!unread.some((x) => x.id === n.id)) unread.push({ id: n.id, sessionId: n.sessionId, text: n.text, at: n.at });
    sync();
  });
  store.on("connection", (up) => { if (up) loadNotices(); });
  if (store.connected) loadNotices();
}
export function __resetNoticesForTest() { unread = []; updates = 0; shown.clear(); summary = null; summaryCount = 0; summaryHidden = new Set(); }

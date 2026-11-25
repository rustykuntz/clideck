// Stale-UI notice. The page remembers the UI build it loaded (a meta tag the engine stamps into index.html)
// and now and then asks the engine which build is on disk. When they differ it offers Refresh, which reloads
// only this browser tab — never the engine or a session, and never on its own. Refresh is the person's own
// action: like any reload it drops unsaved drafts in open dialogs. A failed or odd answer is never read as an
// update, and without the meta tag (older engine) the whole feature stays off.
import { store } from "../store.js";
import { toast } from "./toast.js";

let baseline = "", notice = null, noticeVersion = "", pending = null, lastCheck = -Infinity, timer = null, wasBusy = false;
let everyMs = 5 * 60 * 1000, gapMs = 30 * 1000, timeoutMs = 5000;
const dismissed = new Set();   // builds the person waved away — for this page's lifetime only

const visible = () => document.visibilityState !== "hidden";
// The engine's own update flow already says "restart CliDeck"; a refresh mid-install would load half a build.
const engineBusy = () => ["installing", "installed"].includes(store.engineUpdate?.state);

function clearNotice() { notice?.dismiss(); notice = null; noticeVersion = ""; }

function show(version) {
  if (version === noticeVersion) return;
  if (dismissed.has(version)) { clearNotice(); return; }   // any notice for another build is out of date too
  noticeVersion = version;
  notice = toast.info({
    id: "ui-refresh", title: "Updated CliDeck is ready", body: "Refresh to load it. Your sessions keep running.", duration: 0,
    onDismiss: () => { dismissed.add(version); notice = null; noticeVersion = ""; },
    action: { label: "Refresh", onClick: () => location.reload() },
  });
}

function schedule() {
  clearTimeout(timer); timer = null;
  if (visible()) timer = setTimeout(() => check(true), everyMs);
}

// A disconnect abandons the question: its answer may describe an engine that no longer exists.
function abandon() { pending?.abort(); pending = null; }

// force skips the event throttle (start, reconnect, engine update finished, the slow timer); window focus and
// returning to the tab do not.
async function check(force = false) {
  if (pending || !store.connected || !visible()) return;
  const now = Date.now();
  if (!force && now - lastCheck < gapMs) return;
  lastCheck = now;
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), timeoutMs);
  pending = controller;
  try {
    const response = await fetch("/api/ui-version", { cache: "no-store", signal: controller.signal });
    if (!response.ok) return;
    const data = await response.json();
    if (pending !== controller) return;
    const version = typeof data?.version === "string" ? data.version.trim() : "";
    if (!version || version.length > 200) return;
    // A new package on disk under the old engine: Refresh alone would mix the two. The engine's restart
    // guidance covers it, so say nothing here.
    if (version === baseline || data.restartRequired === true) clearNotice();
    else if (!engineBusy()) show(version);
  } catch {
    // Offline, old engine, timeout or malformed reply: say nothing.
  } finally {
    clearTimeout(deadline);
    if (pending === controller) { pending = null; schedule(); }
  }
}

export function initUiVersion(options = {}) {
  baseline = String(document.querySelector('meta[name="clideck-ui-version"]')?.getAttribute("content") || "").trim();
  if (!baseline) return;
  if (options.everyMs) everyMs = options.everyMs;
  if (options.gapMs != null) gapMs = options.gapMs;
  if (options.timeoutMs) timeoutMs = options.timeoutMs;
  // Offline, Refresh would reload into an engine that isn't answering, so the notice steps aside; the check on
  // reconnect brings it back unless it was dismissed.
  store.on("connection", (connected) => { if (connected) check(true); else { abandon(); clearNotice(); clearTimeout(timer); timer = null; } });
  store.on("engine.update", () => {
    const busy = engineBusy();
    if (busy) clearNotice();
    else if (wasBusy) check(true);   // install finished or the restarted engine is back: look now
    wasBusy = busy;
  });
  window.addEventListener("focus", () => check());
  document.addEventListener("visibilitychange", () => { if (visible()) { check(); schedule(); } else { clearTimeout(timer); timer = null; } });
  check(true);
}

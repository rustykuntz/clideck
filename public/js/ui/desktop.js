// Desktop app integration. Everything here is dormant in a browser: it activates only when the Electron preload
// exposes window.clideckDesktop to this (top) frame. The shell owns the window, menus, tray and engine lifecycle;
// this module turns its state into page chrome (title-bar insets, translucency, engine overlay), routes menu
// actions to the existing UI entry points, and reports the counts the shell shows (dock badge, tray).
import { store } from "../store.js";
import { h } from "../util.js";
import { onTheme, onThemePref, themePref } from "../theme.js";
import { openSettings } from "./settings.js";
import { openTerminalSearch } from "./terminal-search.js";
import { closeActiveTab } from "./content-dock.js";
import { toast } from "./toast.js";
import { checkForUpdates } from "./updates.js";

// A function declaration, not a const: settings.js reads isDesktop() while modules are still evaluating (import
// cycle), and a hoisted function is safe to call before this module's body has run.
function detectBridge() { try { return window.top === window ? window.clideckDesktop || null : null; } catch { return null; } }
const bridge = detectBridge();
const root = document.documentElement;
const SIDEBAR_KEY = "clideck.desktop.sidebarHidden";
let state = null;

export const desktop = bridge;
export function isDesktop() { return !!detectBridge(); }
export function desktopState() { return state; }
const listeners = new Set();
export function onDesktopState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Native notification with a click that focuses the window and selects the session. Returns false in a browser so
// the caller keeps its web Notification path.
export function desktopNotify({ title, body, sessionId } = {}) {
  if (!bridge || typeof bridge.notify !== "function") return false;
  try { bridge.notify({ title: String(title || "CliDeck"), body: String(body || ""), ...(sessionId ? { sessionId } : {}) }); return true; }
  catch { return false; }
}

// One link-opening path for plugins (worker api.openExternal and workspace pages' clideck.open): http(s) or mailto,
// never this origin, at most one per second. The desktop app hands it to the default browser.
let lastLink = 0;
export function openPluginLink(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { return false; }
  if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.origin === location.origin) return false;
  const now = Date.now(); if (now - lastLink < 1000) return false; lastLink = now;
  try {
    if (bridge && typeof bridge.openExternal === "function") bridge.openExternal(url.href);
    else window.open(url.href, "_blank", "noopener,noreferrer");
    return true;
  } catch { return false; }
}

export function initDesktop() {
  if (!bridge) return;
  root.classList.add("desktop");
  root.dataset.platform = String(bridge.platform || "");
  initSidebarToggle();
  watchZoom();
  watchFocus();
  syncAppearance();
  onTheme(syncAppearance); onThemePref(syncAppearance);
  watchCounts();
  if (typeof bridge.onAction === "function") bridge.onAction(runAction);
  if (typeof bridge.onState === "function") bridge.onState(applyState);
  Promise.resolve().then(() => bridge.getState && bridge.getState()).then(applyState).catch(() => {});
}

// ── shell state → chrome ───────────────────────────────────────────────────────
function applyState(next) {
  if (!next || typeof next !== "object") return;
  state = next;
  const caps = next.capabilities || {}, win = next.window || {};
  root.classList.toggle("dk-vibrancy", caps.vibrancy === true);
  root.classList.toggle("dk-wco", caps.titleBarOverlay === true);
  root.classList.toggle("dk-fullscreen", win.fullscreen === true);
  if (typeof win.focused === "boolean") root.classList.toggle("dk-blurred", !win.focused);
  paintEngine(next.engine || {});
  for (const fn of listeners) { try { fn(state); } catch {} }
}

// Electron zoom scales CSS pixels but not the traffic lights, so the inset that clears them is divided by the
// zoom factor (outer/inner width: the frameless window has no chrome of its own).
function watchZoom() {
  const apply = () => {
    const z = window.outerWidth && window.innerWidth ? window.outerWidth / window.innerWidth : 1;
    root.style.setProperty("--dk-zoom", String(z > 0.25 && z < 5 ? Math.round(z * 100) / 100 : 1));
  };
  window.addEventListener("resize", apply); apply();
}
// The page's own focus events are immediate; the shell's window.focused only confirms them.
function watchFocus() {
  const apply = () => root.classList.toggle("dk-blurred", !document.hasFocus());
  window.addEventListener("focus", apply); window.addEventListener("blur", apply); apply();
}

// The shell follows CliDeck's own theme choice (vibrancy material, native menus, Windows caption buttons).
function syncAppearance() {
  if (typeof bridge.setAppearance !== "function") return;
  const pref = themePref();
  const css = getComputedStyle(root);
  try {
    bridge.setAppearance({
      mode: pref === "auto" ? "system" : pref,
      overlay: { color: "#00000000", symbolColor: css.getPropertyValue("--dim").trim() || "#a1a4ad" },
    });
  } catch {}
}

// ── badge + tray counts ────────────────────────────────────────────────────────
function watchCounts() {
  let timer = null, last = "";
  const flush = () => {
    timer = null;
    let working = 0, waiting = 0;
    for (const s of store.sessions.values()) {
      if (s.live === false || s.closed) continue;
      if (s.attention) waiting++; else if (s.status === "working") working++;
    }
    const unread = store.unreadSessions();
    const key = working + "/" + waiting + "/" + unread;
    if (key === last) return; last = key;
    try { bridge.setBadgeCount && bridge.setBadgeCount(unread); } catch {}
    try { bridge.setActivity && bridge.setActivity({ working, waiting }); } catch {}
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 250); };
  for (const ev of ["session:update", "session:add", "session:remove", "reset", "active", "chrome"]) store.on(ev, schedule);
  schedule();
}

// ── menu actions ───────────────────────────────────────────────────────────────
const click = (id) => { const el = document.getElementById(id); if (el && !el.disabled) { el.click(); return true; } return false; };
function visibleRows() {
  return [...document.querySelectorAll("#list .row[data-id]")].filter((n) => n.offsetParent !== null && store.sessions.has(n.dataset.id));
}
function stepSession(delta) {
  const rows = visibleRows(); if (!rows.length) return;
  const i = rows.findIndex((n) => n.dataset.id === store.activeId);
  const next = rows[(i < 0 ? (delta > 0 ? 0 : rows.length - 1) : (i + delta + rows.length) % rows.length)];
  selectRow(next);
}
function selectRow(row) {
  if (!row) return;
  store.select(row.dataset.id);
  row.scrollIntoView({ block: "nearest" });
}
function nextUnread() {
  const rows = visibleRows(), i = rows.findIndex((n) => n.dataset.id === store.activeId);
  const ordered = [...rows.slice(i + 1), ...rows.slice(0, i + 1)];
  const hit = ordered.find((n) => { const s = store.sessions.get(n.dataset.id); return s && (s.attention || s.unread > 0) && n.dataset.id !== store.activeId; });
  if (hit) selectRow(hit);
  else toast.info("No session is waiting for you.");
}

const ACTIONS = {
  "settings": () => openSettings(),
  // Settings shows the update status (nav footer) live while the check runs; an available update also toasts.
  "check-updates": () => { openSettings(); checkForUpdates(); },
  "new-session": () => { revealSidebar(); click("new-btn"); },
  "new-project": () => { revealSidebar(); click("proj-btn"); },
  "toggle-sidebar": () => setSidebarHidden(!root.classList.contains("dk-sidebar-hidden")),
  "find": () => openTerminalSearch(),
  "history": () => click("th-history"),
  "next-session": () => stepSession(1),
  "prev-session": () => stepSession(-1),
  "next-unread": () => nextUnread(),
  "close-tab": () => { if (!closeActiveTab() && bridge.hideWindow) bridge.hideWindow(); },
};

function runAction(action) {
  const id = typeof action === "string" ? action : action && action.id;
  if (id === "focus-session") {
    const sid = action && action.sessionId;
    if (sid && store.sessions.has(sid)) store.select(sid);
    return;
  }
  const n = /^session-([1-9])$/.exec(id || "");
  if (n) { selectRow(visibleRows()[Number(n[1]) - 1]); return; }
  const fn = ACTIONS[id];
  if (fn) { try { fn(); } catch (error) { console.warn("[desktop] action failed", id, error); } }
}

// ── sidebar toggle ─────────────────────────────────────────────────────────────
// One button pinned beside the window controls: it stays put whether the sidebar is open or not, so the eye
// (and the cursor) always find it in the same place.
function initSidebarToggle() {
  const btn = h("button", "dk-sidebar-btn", `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="3.2"/><path d="M9.5 4.5v15"/><path class="dk-sb-fill" d="M5.6 8h1.6M5.6 11h1.6"/></svg>`);
  btn.id = "dk-sidebar-btn"; btn.type = "button";
  btn.addEventListener("click", () => setSidebarHidden(!root.classList.contains("dk-sidebar-hidden")));
  document.body.append(btn);
  let hidden = false; try { hidden = localStorage.getItem(SIDEBAR_KEY) === "1"; } catch {}
  setSidebarHidden(hidden, true);
}
function setSidebarHidden(hidden, instant = false) {
  if (instant) root.classList.add("dk-no-anim");
  root.classList.toggle("dk-sidebar-hidden", hidden);
  const btn = document.getElementById("dk-sidebar-btn");
  if (btn) {
    const label = hidden ? "Show sidebar" : "Hide sidebar";
    btn.title = label + " (" + (bridge.platform === "darwin" ? "⌃⌘S" : "Ctrl+Shift+S") + ")";
    btn.setAttribute("aria-label", label); btn.setAttribute("aria-pressed", String(!hidden));
  }
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) sidebar.inert = hidden;
  try { localStorage.setItem(SIDEBAR_KEY, hidden ? "1" : "0"); } catch {}
  if (instant) setTimeout(() => root.classList.remove("dk-no-anim"), 60);
}
function revealSidebar() { if (root.classList.contains("dk-sidebar-hidden")) setSidebarHidden(false); }

// ── engine overlay ─────────────────────────────────────────────────────────────
// The page stays loaded while the shell restarts or reconnects the engine; this card covers it until the shell
// reports ready again (the socket then reconnects on its own). A wait that drags on offers the way out the error
// state has, so the person is never left watching a spinner with nothing to press.
const SLOW_MS = 8000;
let overlay = null, waitingSince = 0, slowTimer = null, lastEngine = null;
function paintEngine(engine) {
  lastEngine = engine;
  const st = String(engine.state || "ready");
  if (st === "ready" || st === "running") {
    clearTimeout(slowTimer); slowTimer = null; waitingSince = 0;
    if (overlay) { const o = overlay; overlay = null; o.classList.remove("show"); setTimeout(() => o.remove(), 220); }
    return;
  }
  if (!overlay) {
    overlay = h("div", "dk-engine");
    overlay.setAttribute("role", "alertdialog"); overlay.setAttribute("aria-modal", "true");
    const card = h("div", "dk-engine-card"), mark = h("div", "dk-engine-mark"), bar = h("div", "dk-engine-bar"), error = h("pre", "dk-engine-error");
    mark.setAttribute("aria-hidden", "true"); bar.setAttribute("aria-hidden", "true"); bar.append(h("i")); error.hidden = true;
    card.append(mark, h("div", "dk-engine-title"), h("div", "dk-engine-sub"), error, bar, h("div", "dk-engine-actions"));
    overlay.append(card);
    document.body.append(overlay);
    requestAnimationFrame(() => overlay && overlay.classList.add("show"));
  }
  const failed = st === "error" || st === "failed" || st === "stopped";
  if (failed) { clearTimeout(slowTimer); slowTimer = null; waitingSince = 0; }
  else if (!waitingSince) { waitingSince = Date.now(); slowTimer = setTimeout(() => { slowTimer = null; if (lastEngine) paintEngine(lastEngine); }, SLOW_MS); }
  const slow = !failed && waitingSince && Date.now() - waitingSince >= SLOW_MS;
  overlay.classList.toggle("failed", failed);
  overlay.querySelector(".dk-engine-title").textContent = failed ? "The CliDeck engine stopped" : st === "starting" ? "Starting the engine…" : "Reconnecting to the engine…";
  overlay.querySelector(".dk-engine-sub").textContent = failed
    ? "Your sessions are saved. Start the engine again to pick up where you left off."
    : slow ? "This is taking longer than usual. If the engine stopped, start it again."
    : "CliDeck picks up again as soon as the engine answers.";
  const err = overlay.querySelector(".dk-engine-error");
  err.hidden = !(failed && engine.error); err.textContent = failed && engine.error ? String(engine.error) : "";
  const actions = overlay.querySelector(".dk-engine-actions");
  const want = failed ? "failed" : slow ? "slow" : "";
  if (actions.dataset.mode === want) return;   // repeated state pushes must not rebuild (and refocus) the buttons
  actions.dataset.mode = want; actions.textContent = "";
  if (!want) return;
  const retry = h("button", "tour-btn" + (failed ? " tour-primary" : ""), "Start engine"); retry.type = "button";
  retry.onclick = () => { retry.disabled = true; Promise.resolve(bridge.retryEngine && bridge.retryEngine()).catch(() => {}).finally(() => { retry.disabled = false; }); };
  actions.append(retry);
  if (engine.logPath && bridge.showItemInFolder) {
    const logs = h("button", "tour-btn" + (failed ? "" : " tour-quiet"), "Show logs"); logs.type = "button";
    logs.onclick = () => bridge.showItemInFolder(engine.logPath);
    actions.append(logs);
  }
  if (failed) requestAnimationFrame(() => retry.focus());
}

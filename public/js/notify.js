// Sound + browser-notification engine (v1 parity: idle sound terminals.js:917-925, browser notif 927-934,
// dispatch cue app.js:40-46). Subscribes to the store's already-replay-guarded signals and applies the
// FEEL gating: mute, min-work, background-only sound, tab-hidden-only notifications. Prefs live in the
// server config store (synced across clients); this module merges them over v1 defaults.
import { store } from "./store.js";
import { updateConfig } from "./ws.js";
import { basename, firstLine, shortId } from "./util.js";
import { isDesktop, desktopNotify } from "./ui/desktop.js";

export const SOUND_OPTS = [
  { id: "default-beep", label: "Default" }, { id: "soft-beep", label: "Soft" },
  { id: "bold-beep-idle", label: "Bold" }, { id: "echo-beep-idle", label: "Echo" },
  { id: "musical-beep-idle", label: "Musical" }, { id: "small-bleep-idle", label: "Bleep" },
  { id: "space-idle", label: "Space" },
];
export const DISPATCH_OPTS = [
  { id: "agent-dispatch-ambient", label: "Ambient" }, { id: "agent-dispatch-soft", label: "Soft" },
];
export const MINWORK_OPTS = [{ v: 0, label: "Always" }, { v: 10, label: "After 10s" }, { v: 30, label: "After 30s" }];

const DEFAULTS = { enabled: true, sound: true, pick: "default-beep", minWorkSec: 0, browser: false, dispatch: true, dispatchPick: "agent-dispatch-ambient" };
let prefs = { ...DEFAULTS };

const audio = new Map();
function play(name) {
  if (!name) return;
  try {
    let a = audio.get(name);
    if (!a) { a = new Audio("/fx/" + name + ".mp3"); audio.set(name, a); }
    a.currentTime = 0; a.play().catch(() => {});     // autoplay/gesture failures are silent (v1)
  } catch {}
}

const docHidden = () => typeof document !== "undefined" && document.hidden === true;
const canNotify = () => typeof Notification !== "undefined";
function syncPrefs() { prefs = { ...DEFAULTS, ...(store.notify || {}) }; }

export function initNotify() {
  syncPrefs();
  store.on("config", () => { syncPrefs(); emitPrefs(); });
  store.on("session:wentIdle", onIdle);
  store.on("session:dispatch", onDispatch);
}

// working→idle (store already guarantees this is a genuine live transition, never a replay). Sound only
// when NOT muted, work ≥ minWork, and the session is backgrounded (tab hidden OR not the active one).
function onIdle(id, workMs) {
  if (!prefs.enabled) return;
  const s = store.sessions.get(id);
  if (!s || s.muted) return;
  const backgrounded = docHidden() || store.activeId !== id;
  if (prefs.sound && backgrounded && workMs >= (prefs.minWorkSec || 0) * 1000) play(prefs.pick);
  // The desktop app counts as "away" as soon as its window loses focus; a browser tab only once it is hidden.
  const away = isDesktop() ? !document.hasFocus() : docHidden();
  if (prefs.browser && away && canNotify() && Notification.permission === "granted") fireNotification(s);
}

// dispatch cue when /ask injects into a session — suppressed if the TARGET is muted (v1 app.js:40-46).
function onDispatch(ev) {
  if (!prefs.enabled) return;
  const to = ev && store.sessions.get(ev.toId);
  if (to && to.muted) return;
  if (prefs.dispatch) play(prefs.dispatchPick);
}

function fireNotification(s) {
  const name = s.name || shortId(s.id);
  const group = basename(s.cwd);
  const title = group && group !== "/" ? group + ": " + name : name;
  const preview = firstLine(s.latestAgent);
  if (desktopNotify({ title, body: preview ? "Now idle · " + preview : "Now idle", sessionId: s.id })) return;   // native; click → focus-session
  try {
    const n = new Notification(title, { body: preview ? "Now idle · " + preview : "Now idle", tag: s.id });   // tag dedupes per session
    n.onclick = () => { try { window.focus(); } catch {} store.select(s.id); n.close(); };
  } catch {}
}

// ── settings API ──────────────────────────────────────────────────────────────
const prefsListeners = new Set();
export function onPrefs(fn) { prefsListeners.add(fn); return () => prefsListeners.delete(fn); }
function emitPrefs() { for (const fn of prefsListeners) fn(getPrefs()); }
export function getPrefs() { return { ...prefs }; }
export function notifyPermission() { return canNotify() ? Notification.permission : "unsupported"; }
export function previewSound(kind) { play(kind === "dispatch" ? prefs.dispatchPick : prefs.pick); }

export function setPref(key, val) {
  prefs = { ...prefs, [key]: val };
  emitPrefs();
  updateConfig({ notify: { ...prefs } });          // send the FULL notify object (engine may shallow-merge)
}

// Turning browser alerts ON needs a user gesture → request permission first; only flip the pref on grant.
export function enableBrowser() {
  if (!canNotify()) return Promise.resolve("unsupported");
  if (Notification.permission === "granted") { setPref("browser", true); return Promise.resolve("granted"); }
  if (Notification.permission === "denied") { emitPrefs(); return Promise.resolve("denied"); }
  return Notification.requestPermission().then((p) => { if (p === "granted") setPref("browser", true); else emitPrefs(); return p; });
}

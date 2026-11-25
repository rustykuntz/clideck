import { actionIcon } from "./action-icon.js";
// Browser plugin host. client.js runs in a module Worker, never in CliDeck's window. The host owns every
// visible surface and converts Worker registrations into action/viewer/workspace records with deterministic
// teardown on disable, failure, replacement, or reconnect.
import { store } from "../store.js";
import { sendPluginMessage } from "../ws.js";
import { terminalSelection, terminalFocusTarget, commitTerminalDraft, getTerminalSelectionSnapshot } from "./terminal.js";
import { registerHotkey, unregisterHotkey, unregisterAllForPlugin } from "./hotkeys.js";
import { registerAction, unregisterActionsForPlugin, resolveActions, runAction, onActionsChange, setActionErrorHandler } from "./action-registry.js";
import { registerPluginViewer, registerWorkspace, unregisterViewersForPlugin, workspaceFor } from "./viewer-registry.js";
import { openWorkspaceTab, closePluginTabs, getActiveViewerText, getActiveViewerTextSnapshot } from "./content-dock.js";
import { openMenu, closeMenu } from "./menu.js";
import { toast } from "./toast.js";
import { playPluginAudio, playPluginAudioAndWait, stopPluginAudio, togglePluginAudio } from "./plugin-audio.js";
import { startPluginMicrophone, stopPluginMicrophone } from "./plugin-microphone.js";
import { openPluginComposition, updatePluginComposition, closePluginComposition } from "./plugin-composition.js";
import { openPluginPicker, closePluginPicker } from "./plugin-picker.js";
import { pluginSessionSnapshot as sessionSnapshot, activeSessionFocus, initPluginRealtime, openRealtimeAudio,
  setRealtimeAudioAnswer, sendRealtimeAudioData, closeRealtimeAudio, stopPluginRealtimeAudio, cancelRealtimeAudioOpen } from "./plugin-realtime.js";
import { isDesktop, desktopNotify, openPluginLink } from "./desktop.js";
import { getPrefs } from "../notify.js";

// Plugin notifications follow the person's own notification settings and are throttled per plugin. A click
// focuses CliDeck and, when the session still exists, selects it.
const lastPluginNotify = new Map();
function pluginNotify(plugin, options) {
  const prefs = getPrefs();
  if (!prefs.enabled || !prefs.browser) return false;
  const now = Date.now(); if (now - (lastPluginNotify.get(plugin.id) || 0) < 1000) return false;
  const sessionId = options.sessionId && store.sessions.has(options.sessionId) ? options.sessionId : undefined;
  const title = String(options.title || plugin.title || plugin.name || plugin.id).slice(0, 120);
  const body = String(options.body || "").slice(0, 400);
  if (!title && !body) return false;
  lastPluginNotify.set(plugin.id, now);
  if (desktopNotify({ title, body, sessionId })) return true;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => { try { window.focus(); } catch {} if (sessionId && store.sessions.has(sessionId)) store.select(sessionId); n.close(); };
    return true;
  } catch { return false; }
}

const runtimes = new Map();           // pluginId -> Runtime
const errors = new Map();             // local client failures; engine worker status remains authoritative separately
const listeners = new Set();
let headerBtn = null, headerPaintSeq = 0, runtimeSequence = 0;

function notify() { for (const fn of listeners) fn(); paintHeader(); }
function clientSettings(plugin) {
  const secret = new Set((plugin.settings || []).filter((setting) => setting.type === "secret").map((setting) => setting.key));
  for (const key of Object.keys(plugin.configured || {})) secret.add(key);
  const values = {}; for (const [key, value] of Object.entries(plugin.values || {})) if (!secret.has(key)) values[key] = value;
  const configured = {}; for (const key of secret) configured[key] = !!(plugin.configured && plugin.configured[key]);
  return { values, configured };
}
function declaredViewer(plugin, definition) {
  const id = String(definition && definition.id || ""), rawKind = String(definition && definition.kind || "");
  const kind = rawKind.includes("/") ? rawKind : plugin.id + "/" + rawKind;
  return !!id && !!rawKind && (plugin.viewers || []).some((viewer) => viewer.id === id && viewer.kind === kind);
}
function projectFor(session) { return session && session.projectId ? store.projects.find((p) => p.id === session.projectId) || null : null; }
// `selection.anchor` is an opaque token saying WHERE on the terminal those cells are — a plugin carries it
// back untouched (read-along, speech caching) and never parses it. Empty on every other surface, and empty
// when the terminal cannot place the selection; `selection.text` is unchanged either way.
export function pluginActionContext(surface, selection, extra = {}) {
  const session = store.active();
  const anchor = surface === "terminal" ? (getTerminalSelectionSnapshot() || {}).anchor || "" : "";
  return {
    surface,
    selection: { text: String(selection || ""), surface, anchor },
    session: sessionSnapshot(session),
    project: projectFor(session),
    ...extra,
  };
}

class Runtime {
  constructor(plugin) {
    this.instanceId = ++runtimeSequence;
    this.plugin = plugin; this.cleanups = new Map(); this.pending = new Map(); this.seq = 0; this.ready = false;
    const workerUrl = "/js/plugin-client-worker.js?id=" + encodeURIComponent(plugin.id);
    this.worker = new Worker(workerUrl, { type: "module", name: "clideck-plugin-" + plugin.id });
    this.worker.onmessage = (event) => this.message(event.data || {});
    this.worker.onerror = (event) => this.fail(event.message || "Plugin client worker crashed.");
    const settings = clientSettings(plugin);
    this.settingsSignature = JSON.stringify(settings);
    this.worker.postMessage({ type: "init", clientUrl: plugin.clientUrl + "?v=" + encodeURIComponent(plugin.version || "0"), settings, capabilities: { realtimeAudio: true, ...(isDesktop() ? { desktop: true } : {}) } });
  }
  signature() { return this.plugin.clientUrl + "|" + this.plugin.version; }
  update(plugin) {
    this.plugin = plugin;
    const settings = clientSettings(plugin), signature = JSON.stringify(settings);
    if (signature !== this.settingsSignature) { this.settingsSignature = signature; this.worker.postMessage({ type: "settings", settings }); }
  }
  invoke(method, id, context) {
    const requestId = "h" + (++this.seq);
    return new Promise((resolve, reject) => {
      const predicate = method === "match-action";
      const timer = predicate ? setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, 120) : null;
      this.pending.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ type: "invoke", requestId, method, id, context });
    });
  }
  response(requestId, success, value, error) { this.worker.postMessage({ type: "response", requestId, success, value, error }); }
  async request(message) {
    const id = this.plugin.id;
    try {
      if (this.stopped) throw new Error("Plugin client stopped.");
      let value;
      if (message.method === "get-active-session") value = sessionSnapshot(store.active());
      else if (message.method === "open-settings") {
        const { openPluginSettings } = await import("./settings.js");
        if (this.stopped) throw new Error("Plugin client stopped.");
        openPluginSettings(id); value = true;
      }
      else if (message.method === "notify") value = pluginNotify(this.plugin, message.options || {});
      else if (message.method === "open-external") value = openPluginLink(message.url);
      else if (message.method === "open-realtime-audio") value = await openRealtimeAudio(id, message.options,
        event => this.worker.postMessage({ type: "realtime-audio", event }), `${this.instanceId}:${message.requestId}`);
      else if (message.method === "set-realtime-audio-answer") value = await setRealtimeAudioAnswer(id, message.id, message.sdp);
      else if (message.method === "send-realtime-audio-data") value = sendRealtimeAudioData(id, message.id, message.data);
      else if (message.method === "close-realtime-audio") value = closeRealtimeAudio(id, message.id);
      else if (message.method === "get-terminal-selection") value = terminalSelection();
      else if (message.method === "get-terminal-selection-snapshot") value = getTerminalSelectionSnapshot();
      else if (message.method === "get-active-viewer-text") value = await getActiveViewerTextSnapshot();
      else if (message.method === "get-viewer-text") value = await getActiveViewerText(message.contentId);
      else if (message.method === "open-picker") value = await openPluginPicker(id, message.options);
      else if (message.method === "toggle-audio") value = togglePluginAudio(id);
      else if (message.method === "play-audio-wait") value = await playPluginAudioAndWait(id, message.buffer, message.options || {});
      else if (message.method === "start-microphone") {
        value = await startPluginMicrophone(id,
          (buffer, info) => this.worker.postMessage({ type: "microphone-data", buffer, info }, [buffer]),
          (state) => this.worker.postMessage({ type: "microphone-state", state }));
      }
      else if (message.method === "stop-microphone") value = await stopPluginMicrophone(id);
      else if (message.method === "open-terminal-composition") {
        value = openPluginComposition(id, message.options, (action) => this.worker.postMessage({ type: "terminal-composition-action", action }));
      }
      else if (message.method === "commit-terminal-draft") value = commitTerminalDraft(message.text, message.options);
      else { this.response(message.requestId, false, null, "Unknown host request."); return; }
      this.response(message.requestId, true, value);
    } catch (error) { this.response(message.requestId, false, null, error && error.message || String(error)); }
  }
  setCleanup(key, cleanup) { const prev = this.cleanups.get(key); if (prev) prev(); this.cleanups.set(key, cleanup); }
  dropCleanup(key) { const cleanup = this.cleanups.get(key); if (cleanup) cleanup(); this.cleanups.delete(key); }
  message(message) {
    const id = this.plugin.id;
    if (this.stopped) return;
    if (message.type === "ready") { this.ready = true; errors.delete(id); notify(); return; }
    if (message.type === "failed") { this.fail(message.error || "Plugin client failed to load."); return; }
    if (message.type === "runtime-error") { clientError(id, message.error || "Plugin client action failed."); return; }
    if (message.type === "invoke-result") {
      const pending = this.pending.get(message.requestId); if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.success) pending.resolve(message.value); else pending.reject(new Error(message.error || "Plugin action failed."));
      return;
    }
    if (message.type === "register-action") this.setCleanup("action:" + message.definition.id, registerAction(id, message.definition, (...args) => this.invoke(...args)));
    else if (message.type === "unregister-action") this.dropCleanup("action:" + message.id);
    else if (message.type === "register-viewer") {
      if (!declaredViewer(this.plugin, message.definition)) { clientError(id, "Client viewer is not declared in the plugin manifest."); return; }
      this.setCleanup("viewer:" + String(message.registrationId || "default"), registerPluginViewer(id, message.definition));
    }
    else if (message.type === "unregister-viewer") this.dropCleanup("viewer:" + String(message.id || "default"));
    else if (message.type === "register-workspace") this.setCleanup("workspace:" + String(message.definition && message.definition.id || ""), registerWorkspace(id, message.definition));
    else if (message.type === "unregister-workspace") this.dropCleanup("workspace:" + String(message.id || ""));
    else if (message.type === "open-workspace") {
      const def = workspaceFor(id, message.id); if (def) openWorkspaceTab(id, def, message.options || {});
    } else if (message.type === "register-hotkey") {
      const combo = String(message.combo || "");
      if (registerHotkey(id, combo, (event) => this.invoke("hotkey", combo, { key: event.key, code: event.code }))) this.setCleanup("hotkey:" + combo, () => unregisterHotkey(id, combo));
    } else if (message.type === "unregister-hotkey") this.dropCleanup("hotkey:" + String(message.combo || ""));
    else if (message.type === "send") sendPluginMessage(id, message.event, message.data);
    else if (message.type === "play-audio") playPluginAudio(id, message.buffer, message.options || {}).catch((error) => clientError(id, error.message));
    else if (message.type === "stop-audio") stopPluginAudio(id);
    else if (message.type === "terminal-composition-update") updatePluginComposition(id, message.patch);
    else if (message.type === "terminal-composition-close") closePluginComposition(id);
    else if (message.type === "toast") {
      const kind = ["success", "warn", "error"].includes(message.kind) ? message.kind : "info";
      toast[kind]({ ...(message.options || {}), title: (message.options && message.options.title) || this.plugin.name });
    } else if (message.type === "request") this.request(message);
    else if (message.type === "cancel-realtime-open") cancelRealtimeAudioOpen(id, `${this.instanceId}:${message.requestId}`);
    else if (message.type === "watch-active-session") {
      this.watchingFocus = message.enabled === true;
      if (this.watchingFocus) this.worker.postMessage({ type: "active-session", focus: activeSessionFocus() });
    }
  }
  deliver(event, data, requestId) { try { this.worker.postMessage({ type: "plugin-message", event, data, requestId }); } catch {} }
  fail(reason) { clientError(this.plugin.id, reason); this.stop(); }
  stop() {
    this.stopped = true;
    stopPluginRealtimeAudio(this.plugin.id);
    for (const cleanup of this.cleanups.values()) { try { cleanup(); } catch {} }
    this.cleanups.clear(); stopPluginAudio(this.plugin.id); stopPluginMicrophone(this.plugin.id); closePluginComposition(this.plugin.id); closePluginPicker(this.plugin.id); closePluginTabs(this.plugin.id); unregisterActionsForPlugin(this.plugin.id); unregisterViewersForPlugin(this.plugin.id); unregisterAllForPlugin(this.plugin.id);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Plugin client stopped.")); }
    this.pending.clear();
    try { this.worker.postMessage({ type: "shutdown" }); setTimeout(() => this.worker.terminate(), 250); } catch {}
  }
}

function clientError(pluginId, reason) {
  const message = String(reason || "Plugin client failed.").split("\n")[0];
  errors.set(pluginId, message); notify();
  toast.error({ id: "plugin-client:" + pluginId, title: "Plugin client stopped", body: message });
}

function reconcile(plugins) {
  const wanted = new Map((plugins || []).map((plugin) => [plugin.id, plugin]));
  for (const [id, runtime] of [...runtimes]) {
    const plugin = wanted.get(id);
    const shouldRun = plugin && plugin.enabled && plugin.status === "ready" && plugin.clientUrl;
    if (!shouldRun || runtime.signature() !== plugin.clientUrl + "|" + plugin.version) { runtime.stop(); runtimes.delete(id); }
    else runtime.update(plugin);
  }
  for (const plugin of wanted.values()) {
    if (!plugin.enabled || plugin.status !== "ready" || !plugin.clientUrl || runtimes.has(plugin.id)) continue;
    try { runtimes.set(plugin.id, new Runtime(plugin)); }
    catch (error) { clientError(plugin.id, error.message); }
  }
  for (const id of [...errors.keys()]) if (!wanted.has(id)) errors.delete(id);
  notify();
}

// The session header lists only what acts on THIS session ("terminal.header"). App-wide plugin actions
// ("toolbar") live in the sidebar footer's Plugins menu, which works with no session open.
let headerRepaintTimer = null;
async function paintHeader() {
  if (!headerBtn) return;
  const seq = ++headerPaintSeq;
  const actions = await resolveActions("terminal.header", pluginActionContext("terminal", ""));
  if (seq !== headerPaintSeq) return;
  headerBtn.hidden = !actions.length;
  headerBtn._actions = actions;
}


// Re-resolved on open: a plugin's `when` may depend on state that changed since the last paint (a Telegram
// session switched on in another window), and a menu must never offer what no longer applies.
async function openHeaderMenu(event) {
  await paintHeader();
  const actions = headerBtn && headerBtn._actions || []; if (!actions.length) return;
  headerBtn.setAttribute("aria-expanded", "true");
  openMenu(headerBtn, actions.map((action) => ({ label: action.label, icon: actionIcon(action.icon), onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } })), {
    align: "end", returnFocus: headerBtn, pointerReturnFocus: terminalFocusTarget(), sourceEvent: event,
    onClose: () => headerBtn && headerBtn.setAttribute("aria-expanded", "false"),
  });
}

// App-wide plugin tools ("toolbar") as menu items, for the sidebar footer's app menu.
export async function appPluginMenuItems() {
  const actions = await resolveActions("toolbar", pluginActionContext("toolbar", ""));
  return actions.map((action) => ({ label: action.label, icon: actionIcon(action.icon), onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } }));
}

export function initPluginHost() {
  initPluginRealtime(focus => {
    for (const runtime of runtimes.values()) if (runtime.watchingFocus && !runtime.stopped) runtime.worker.postMessage({ type: "active-session", focus });
  });
  headerBtn = document.getElementById("plugin-actions");
  if (headerBtn) headerBtn.addEventListener("click", (event) => { if (headerBtn.getAttribute("aria-expanded") === "true") closeMenu(); else openHeaderMenu(event); });
  setActionErrorHandler((id, error) => clientError(id, error && error.message || error));
  onActionsChange(paintHeader);
  store.on("plugins", reconcile);
  store.on("plugin:message", (message) => {
    runtimes.get(message.pluginId)?.deliver(message.event, message.data, message.requestId);
    // A plugin's `when` usually follows its own state, which arrives as messages (Telegram paired, a session
    // switched on). Repaint the header once the burst settles so the button appears/disappears with it.
    clearTimeout(headerRepaintTimer); headerRepaintTimer = setTimeout(paintHeader, 120);
  });
  store.on("active", paintHeader); store.on("session:update", (id) => { if (id === store.activeId) paintHeader(); });
  reconcile(store.plugins);
}

// Host-originated message to a plugin client (no engine hop). False until its activate() has finished, since
// a message delivered before the client registers its handlers would be silently lost.
export function deliverPluginMessage(pluginId, event, data) {
  const runtime = runtimes.get(pluginId);
  if (!runtime || !runtime.ready) return false;
  runtime.deliver(event, data);
  return true;
}

export function pluginClientError(pluginId) { return errors.get(pluginId) || ""; }
export function onPluginHostChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function __runtimeCountForTest() { return runtimes.size; }

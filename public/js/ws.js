// WebSocket transport. Connects back to whatever host:port served the page
// (4100, or a side port like 4123), so it works wherever the engine runs.
import { store } from "./store.js";
import { resolvedTheme } from "./theme.js";
import { toast } from "./ui/toast.js";

let ws = null;
let retry = null;

// ── Offline send-queue (§U, v1 state.js:17-65) ──────────────────────────────────
// While the socket is down for ORDINARY offline (not the stale-engine state — a stale engine 1003-closes our
// controls, so replaying into it is pointless), queue user ACTIONS and flush them in order on reconnect.
// Keystrokes ('input') and 'resize' are NEVER queued — replaying stale keystrokes is wrong; they're dropped.
// config.update coalesces into a single entry (newest keys win, position preserved) so a burst of edits made
// offline lands as one write. Capped; past the cap the newest action is dropped with a one-time toast.
const QUEUEABLE = new Set([
  "session.create", "session.close", "session.resume", "session.rename", "session.setProject",
  "session.restart", "session.mute", "project.open", "project.delete", "config.update",
  "dirs.list", "dirs.mkdir",
  // Closing a document is a user action like any other, and "closed stays closed" does not acquire an
  // exception because the socket happened to be down. Dropped here, the close is lost and the engine replays
  // the document on reconnect — the exact symptom this is fixing. Each close carries its own contentId and
  // only config.update coalesces, so two offline closes stay two closes.
  "content.close",
]);
const MAX_QUEUE = 200;
let queue = [];            // offline actions, in issue order
let queuedConfig = null;   // the single coalesced config.update entry (also referenced inside `queue`)
let overflowed = false;

function enqueue(obj) {
  const t = obj && obj.type;
  if (stale || !QUEUEABLE.has(t)) return;            // stale engine → drop (can't process); input/resize/unknown → drop
  if (t === "config.update") {                        // coalesce to one entry, newest keys win, keep its slot
    if (queuedConfig) { queuedConfig.config = { ...queuedConfig.config, ...(obj.config || {}) }; return; }
    queuedConfig = { type: "config.update", config: { ...(obj.config || {}) } };
    queue.push(queuedConfig);
    return;
  }
  if (queue.length >= MAX_QUEUE) {                     // sane cap — drop the newest + warn once
    if (!overflowed) { overflowed = true; toast.warn({ id: "queue-full", title: "Too many offline changes", body: "Some queued actions were dropped — reconnect to sync.", duration: 0 }); }
    return;
  }
  queue.push(obj);
}
function flushQueue() {
  overflowed = false;
  if (!queue.length) return;
  const pending = queue; queue = []; queuedConfig = null;
  for (const m of pending) if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}
// Observability for tests: the queued action types (in order) + the coalesced config patch.
export function pendingQueue() { return queue.map((m) => ({ ...m })); }

// Stale-engine guard: an OUTDATED engine 1003-closes the socket the instant we send a control it doesn't
// understand ('unknown control message'). Left alone that becomes a silent reset/reconnect CHURN (each open
// resets the store → the UI flickers empty forever). So we watch socket lifetimes: HEALTHY_MS+ = a real
// connection; several sub-HEALTHY_MS closes in a row = the engine is stale → stop churning, keep the last UI,
// back off, and show a banner. A socket that survives >HEALTHY_MS clears it and a clean reconnect resumes.
const HEALTHY_MS = 2000;
const STALE_AFTER = 3;
const RETRY_MS = 1500, STALE_RETRY_MS = 4000;
const STALE_MSG = "Engine is outdated or unreachable — restart the engine (node src/server.js) and refresh.";
let openedAt = 0, fastCloses = 0, stale = false, healthyT = null;

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  else enqueue(obj);   // offline → queue whitelisted actions, flushed in order on reconnect (input/resize dropped)
}

export function createSession(provider, cwd, name, projectId, commandId) {
  // cols/rows are the PTY's initial size; the terminal refits + resizes on focus.
  const msg = { type: "session.create", cols: 120, rows: 40 };
  if (commandId) msg.commandId = commandId; // spawn a custom command (engine resolves it; provider omitted)
  else if (provider) msg.provider = provider;   // omitted → engine default (claude-code)
  // Working dir: an explicit cwd wins; a blank cwd with NO project falls back to the configured Default working
  // directory (Settings → store.defaultCwd). If that's also blank, cwd is omitted → engine default (unchanged).
  const eff = cwd || (projectId ? "" : store.defaultCwd);
  if (eff) msg.cwd = eff;
  if (name) msg.name = name;                // optional label; omitted → unnamed
  if (projectId) msg.projectId = projectId; // spawn straight into a project (per-project + button)
  msg.theme = resolvedTheme();              // 'light'|'dark' — advertise UI theme so the agent renders to match
  store.expectLocalCreate();                // adopt+focus the session THIS local action creates — never a remote/replayed session.created
  send(msg);
}

export function closeSession(id) {
  // Works on live sessions and dormant (persisted) ones; the engine replies session.closed.
  send({ type: "session.close", sessionId: id });
}

export function resumeSession(id) {
  // Valid only on dormant rows; the engine re-broadcasts session.created{live:true} for the
  // same id. Silently dropped on live/unknown ids, so double-clicks are harmless. Resume
  // respawns the PTY, so re-advertise the theme too so the fresh process renders to match.
  send({ type: "session.resume", sessionId: id, theme: resolvedTheme() });
}

export function restartSession(id, theme) {
  // Re-spawn this session's PTY (engine `session.restart` lands in parallel). Carry a light/dark theme
  // (→ COLORFGBG, so the fresh process renders themed) + the current pane size. `theme` defaults to the app
  // mode; the theme picker passes the session's chosen theme polarity so a restart applies its color mode.
  send({ type: "session.restart", sessionId: id, theme: theme === "light" || theme === "dark" ? theme : resolvedTheme(), cols: store.termCols, rows: store.termRows });
}

export function renameSession(id, name) {
  // Works live AND dormant; empty string clears the name. The engine re-broadcasts
  // session.created with the new name for the same id → the store folds it in as an update.
  send({ type: "session.rename", sessionId: id, name: String(name == null ? "" : name) });
}

export function setMute(id, muted) {
  // Engine persists it + re-broadcasts session.created with the new `muted` for the same id.
  send({ type: "session.mute", sessionId: id, muted: !!muted });
}

export function updateConfig(patch) {
  // Engine merges + broadcasts {type:'config'} to all clients. Send the full notify object,
  // not a sub-key, in case the store shallow-merges top-level keys.
  send({ type: "config.update", config: patch });
}

// Open a dropped document as a tab, BY VALUE. The browser hands us a File, so we send its bytes; the engine
// registers them exactly like a `clideck show --stdin` payload and broadcasts content.show — the same frame the
// CLI produces — so the tab draws through the existing handler, survives a refresh/restart, and closes like any
// other asset. Deliberately NOT a client-side blob: URL (dies on reload, second asset model), and deliberately
// NOT a filesystem path: recovering one means parsing text/uri-list, which only Finder is obliged to provide.
export function openContent(sessionId, doc) {
  send({ type: "content.open", sessionId, name: String(doc.name || ""), kind: String(doc.kind || ""), data: String(doc.data == null ? "" : doc.data) });
}

// Open a file the engine already has on disk, by PATH. Used by the terminal's clickable document paths, where a
// path is exactly what we have and the engine has already confirmed the file exists.
export function openContentPath(sessionId, path) { send({ type: "content.open", sessionId, path: String(path == null ? "" : path) }); }

// Drop a document the user closed. The dock removes the tab immediately either way — this is what makes the
// removal DURABLE: the engine holds shown assets in the session record and replays them on every connect, so a
// close it never hears about comes back on the next reconnect. Closing an id the engine no longer holds is a
// silent no-op there, so a stale or duplicate close is harmless.
export function closeContent(sessionId, contentId) {
  send({ type: "content.close", sessionId, contentId: String(contentId == null ? "" : contentId) });
}

// Ask which of these printed candidate strings are really renderable files. Requester-only reply
// {type:'content.resolve.result', sessionId, resolved:{candidate: absolutePath|null}}. Existence is tested
// BEFORE anything is decorated — a link that goes nowhere is worse than the plain text it replaced.
export function resolveContentPaths(sessionId, paths) { send({ type: "content.resolve", sessionId, paths }); }

export function requestConfig() { send({ type: "config.get" }); }   // engine replies {type:'config'}

export function checkAvailability() { send({ type: "checkAvailability" }); }   // engine replies requester-only {type:'availability.result'}

let pluginRequestSeq = 0;
function pluginControl(type, fields = {}) {
  const requestId = "ui-" + Date.now().toString(36) + "-" + (++pluginRequestSeq).toString(36);
  send({ type, requestId, ...fields });
  return requestId;
}
export function refreshPlugins() { return pluginControl("plugins.refresh"); }
export function installPlugin(path) { return pluginControl("plugin.install", { path: String(path || "") }); }
export function removePlugin(pluginId) { return pluginControl("plugin.remove", { pluginId: String(pluginId || "") }); }
export function openPluginFolder() { return pluginControl("plugin.openFolder"); }
export function setPluginEnabled(pluginId, enabled) { return pluginControl("plugin.setEnabled", { pluginId: String(pluginId || ""), enabled: !!enabled }); }
export function updatePluginSettings(pluginId, settings) { return pluginControl("plugin.settings.update", { pluginId: String(pluginId || ""), settings: { ...(settings || {}) } }); }
export function sendPluginMessage(pluginId, event, data) { return pluginControl("plugin.message", { pluginId: String(pluginId || ""), event: String(event || ""), data }); }

// R2: answer a blocked-agent prompt (card buttons/text, or annotate marks JSON). Any client may resolve it;
// the engine broadcasts prompt.resolved to dismiss the card everywhere. `value` is an opaque string.
export function answerPrompt(promptId, value) { send({ type: "prompt.answer", promptId, value: String(value == null ? "" : value) }); }

// R2: raw file upload for a live session — PUT /upload?sessionId&name with the file as the body. Resolves to
// {ok, path, name} (name may be suffixed on collision). onProgress(fraction 0..1) fires for big files. The
// caller pastes the returned path into the terminal input (never auto-sent).
export function uploadFile(sessionId, name, body, onProgress) {
  return new Promise((resolve, reject) => {
    const url = "/upload?sessionId=" + encodeURIComponent(sessionId) + "&name=" + encodeURIComponent(name);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (xhr.upload && typeof onProgress === "function") xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let r = {}; try { r = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && r.ok) resolve(r);
      else reject(new Error(r.error || r.message || "Upload failed (" + xhr.status + ")"));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(body);
  });
}

export function setSessionProject(id, projectId) {
  // Move a session into a project (or null = remove from project). The engine re-broadcasts the session's
  // snapshot with the new projectId → the store folds it in. On a name collision / unknown project it instead
  // re-broadcasts the UNCHANGED snapshot with an `error` (operation:'session.setProject') → setProjectRejected.
  send({ type: "session.setProject", sessionId: id, projectId: projectId || null });
}

export function deleteProject(id) {
  // Engine cascades: closes every session in the project (session.closed each), then removes it from
  // config.projects and broadcasts {type:'config'}. Irreversible — the caller confirms first.
  send({ type: "project.delete", id });
}

export function openProject(cwd) {
  // Engine opens the folder in the OS file manager; replies requester-only project.open.result
  // ({success, fallback:'copy'} on failure → the UI copies the path instead).
  send({ type: "project.open", cwd });
}

export function listDir(path, showHidden) {
  // Engine replies requester-only dirs.list.result {path(echoed), resolvedPath, entries:[{name,hidden}]}.
  send({ type: "dirs.list", path, showHidden: !!showHidden });
}
export function makeDir(parent, name) {
  // Engine replies requester-only dirs.mkdir.result {success, path} — the new folder's path on success.
  send({ type: "dirs.mkdir", parent, name });
}

export function requestTranscriptPage(sessionId, before, limit = 30) {
  const message = { type: "transcript.page", sessionId, limit };
  if (Number.isSafeInteger(before) && before >= 0) message.before = before;
  send(message);
}

export function connectWs() {
  clearTimeout(retry);
  try { ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`); }
  catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    openedAt = Date.now();
    clearTimeout(healthyT);
    healthyT = setTimeout(onHealthy, HEALTHY_MS);   // survives this long → a real, working engine
    if (!stale) { initConnection(); flushQueue(); }  // fresh connect: reset + replay + config, then flush offline actions
    else requestConfig();                            // stale probe: DON'T wipe the UI; a healthy engine replies + survives
  };
  ws.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    store.applyEvent(ev);
  };
  ws.onclose = () => {
    clearTimeout(healthyT);
    store.setConnected(false);
    if (openedAt) fastCloses = Date.now() - openedAt < HEALTHY_MS ? fastCloses + 1 : 0;   // count only sockets that OPENED then died fast
    openedAt = 0;
    if (fastCloses >= STALE_AFTER && !stale) { stale = true; store.setStale(true, STALE_MSG); }   // the failure now explains itself
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function initConnection() {
  store.reset();               // replay is the full truth of live sessions
  store.setConnected(true);    // engine replays each live session on connect
  requestConfig();             // pull config (engine replies {type:'config'})
}
// A socket that survived HEALTHY_MS proves the engine works. If we'd gone stale, clear the banner and drop this
// probe socket so a fresh reconnect runs the normal path (clean reset + full replay); otherwise just reset the counter.
function onHealthy() {
  fastCloses = 0;
  if (stale) { stale = false; store.setStale(false, ""); try { ws.close(); } catch {} }
}

function scheduleReconnect() { clearTimeout(retry); retry = setTimeout(connectWs, stale ? STALE_RETRY_MS : RETRY_MS); }

// The store: per-session state + derived flags (needs-you, unread) + a tiny pub/sub.
// Owns the single source of truth; components subscribe and render.
//
// Events emitted:
//   session:add(id) · session:remove(id) · session:update(id) · session:output(id,data,replay)
//   session:renameRejected(id, name) · session:createRejected(message, err) · session:setProjectRejected(id, err)
//   session:restartFailed(id, message)
//   session:wentIdle(id, workMs) · session:dispatch(ev) · content:show(ev) · saved(ok, err) · config() · project:openResult(ev)
//   dirs:list(ev) · dirs:mkdir(ev) · transcripts() · transcript:append(id) · transcript:page(ev) · availability(data)
//   active(id|null) · chrome() · filter() · connection(bool) · stale(on, message) · reset()

const MAX_BUF = 2 * 1024 * 1024; // 2MB per-session raw output cap
const TRANSCRIPT_CAP = 50 * 1024; // per-session searchable transcript cap (matches the engine's 50KB cache)
const SEARCH_TAIL = 32 * 1024;    // tail of raw output made searchable (ANSI-stripped, cached per session — E3)

// Strip ANSI/OSC control sequences so a raw PTY tail reads as plain text (row-preview fallback, P4).
// Canonical ansi-regex (chalk) via RegExp — matches CSI/OSC escape runs; keeps control chars as explicit \u escapes.
const ANSI_RE = new RegExp([
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)",
  "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
].join("|"), "g");
// OSC strip (titles, OSC-8 hyperlinks) — arbitrary payload up to a BEL or ST terminator; ANSI_RE's own OSC
// arm can't span a payload with spaces, so drop these first.
const OSC_RE = new RegExp("(?:\\u001B\\]|\\u009D)[\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C)", "g");

// ANSI-stripped, lowercased, tail-capped rendition of a session's raw output — the search haystack for shell
// output and mid-turn agent text the transcript cache doesn't carry (E3). Cached on the session and recomputed
// only when the buffer has grown since (s._searchDirty, set by appendBuf) — never re-strips 2MB per keystroke.
function outputSearchText(id) {
  const s = sessions.get(id);
  if (!s || !s.outputBuf) return "";
  if (s._searchText == null || s._searchDirty) {
    const raw = s.outputBuf.length > SEARCH_TAIL ? s.outputBuf.slice(-SEARCH_TAIL) : s.outputBuf;
    s._searchText = raw.replace(OSC_RE, "").replace(ANSI_RE, "").toLowerCase();
    s._searchDirty = false;
  }
  return s._searchText;
}

const listeners = Object.create(null);
function on(ev, fn) { (listeners[ev] || (listeners[ev] = new Set())).add(fn); return () => listeners[ev].delete(fn); }
function emit(ev, ...args) { const set = listeners[ev]; if (set) for (const fn of set) fn(...args); }

const sessions = new Map();
const transcripts = new Map();   // sessionId -> lowercased, tail-capped conversation text (for search; live + dormant)
let order = 0;
let activeId = null;
let pendingLocalCreate = false;     // one-shot: this client just asked to create a session (ws.createSession armed it).
                                    // The next brand-new LIVE session.created adopts selection+focus. Cleared on reset()
                                    // so a reconnect/replay burst can never consume it, and on a create-error snapshot.
let connected = false;
let stale = false, staleMsg = "";   // set when the engine looks outdated/unreachable (repeated instant socket closes)
let filter = "all";     // 'all' | 'unread'
let search = "";
let termCols = 80, termRows = 24;   // last measured size of the shared xterm pane (for session.restart dims)
let notifyPrefs = {};               // server-persisted config.notify (merged with defaults in notify.js)
let voicePrefs = {};                // server-persisted config.voice {readAloud?:bool} — R2 voice toggles
let promptMru = {};                 // config.promptMru {projectKey:[promptId,…]} — per-project recently-used prompts
let promptsList = [];               // server-persisted config.prompts [{id,name,text}] — the prompt library
let themeDefaults = {};             // config.theme {darkDefault,lightDefault} — per-mode terminal theme id
let sessionThemes = {};             // config.sessionThemes {sessionId:themeId} — per-session terminal overrides
let customThemes = [];              // config.customThemes [{id,name,accent,mode?,theme}] — user themes
let projects = [];                  // config.projects [{id,name,path,color,collapsed}] — user projects (order = display order)
let commandsList = [];              // config.commands [{id,label,icon,command,enabled,isAgent,canResume,env,resumeCommand,sessionIdPattern}]
let hiddenProviders = [];           // config.hiddenProviders [providerId] — picker visibility only; sessions/providers stay intact
let providerArgs = {};              // config.providerArgs {providerId:quote-parsed launch args} — future spawns only
let confirmClose = true;            // config.confirmClose — gate the session-delete confirm (Settings General)
let defaultCwd = "";                // config.defaultCwd — default working dir for new sessions
let about = {};                     // config.about {name,timeZone,notes} — the About me profile (Settings ▸ General).
                                    // A MISSING or BLANK field means "not shared": the engine never invents one.
let onboarding = null;              // config.onboarding {completed,seenTips} — NULL means the key is ABSENT, which is
                                    // an existing/unknown install and must NEVER auto-run the full tour. Only an
                                    // explicit completed===false (seeded by the engine on a fresh install) does that.
let engineVersion = "";             // config.version if the engine advertises it (footer); "" otherwise
let availability = null;            // last availability.result: {providers:Map, commands:Map, at} (requester-only)
let pluginsList = [];                // engine-owned plugin inventory replayed as one full snapshot
let pluginsSeen = false;

// index an availability array (providers[] / commands[]) by id for O(1) per-row lookup.
function byId(arr) { const m = new Map(); if (Array.isArray(arr)) for (const e of arr) if (e && e.id != null) m.set(e.id, e); return m; }

// The engine sends `lastActive` as an ISO string when it has one; anything unparseable is treated as absent.
function engineActive(ev) {
  const t = ev && ev.lastActive ? Date.parse(ev.lastActive) : NaN;
  return Number.isFinite(t) ? t : null;
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
function epochMs(value) { return Number.isFinite(value) && value > 0 ? value : null; }
function contextUsage(value) {
  if (!value || typeof value !== "object") return null;
  const { usedTokens, windowTokens, percent } = value;
  if (!Number.isFinite(usedTokens) || !Number.isFinite(windowTokens) || !Number.isFinite(percent)
    || usedTokens < 0 || windowTokens <= 0 || percent < 0 || percent > 100) return null;
  return { usedTokens, windowTokens, percent, estimated: value.estimated === true, updatedAt: epochMs(value.updatedAt) };
}
// The engine sends the active model as a string, or null when it does not know. Unknown stays EMPTY and the
// header simply shows nothing — a guessed model name would be worse than an absent one.
function modelName(value) { return typeof value === "string" ? value.trim().slice(0, 64) : ""; }
function applySessionTelemetry(session, event) {
  if (hasOwn(event, "contextUsage")) session.contextUsage = contextUsage(event.contextUsage);
  if (hasOwn(event, "lastAgentAt")) session.lastAgentAt = epochMs(event.lastAgentAt);
  if (hasOwn(event, "model")) session.model = modelName(event.model);
}

// A restart or a resume is a NEW PROCESS behind the same row, so the status, the menu it was showing, the work
// clock, the context it had filled and the model it was running all describe something that no longer exists.
// This is not client-side synthesis: it only ever writes EMPTY, and the same snapshot's own values are applied
// straight after, so the wire always wins. The user's own state — the name they gave it, the mute — survives.
function respawned(session, event) {
  return event.restarted === true
    || (event.live !== false) !== (session.live !== false)
    || (!!event.pid && !!session.pid && event.pid !== session.pid);
}
function resetProcessState(session) {
  session.status = null; session.menu = []; session.menuContext = "";
  session.workStartedAt = 0; session.contextUsage = null; session.model = "";
}

function makeSession(ev) {
  return {
    id: ev.sessionId, cwd: ev.cwd || "", pid: ev.pid, order: order++,
    provider: ev.provider || "claude-code",   // graceful vs a committed engine w/o provider
    commandId: ev.commandId || "",             // custom-command sessions: config.commands id (drives the row icon, §A)
    commandLabel: ev.label || "",              // the command's label (snapshot carries it as `label`)
    live: ev.live !== false,                   // dormant (engine restarted, PTY gone) => false
    name: ev.name || "",                       // optional user label (may be empty; not unique)
    projectId: ev.projectId || null,           // owning project (config.projects) or null → grouped by cwd
    status: null, menu: [], menuContext: "", latestAgent: "", lastAgentMessage: "",
    contextUsage: contextUsage(ev.contextUsage), lastAgentAt: epochMs(ev.lastAgentAt), model: modelName(ev.model),
    muted: ev.muted === true,
    bracketedPaste: typeof ev.bracketedPaste === "boolean" ? ev.bracketedPaste : null,
    workStartedAt: 0,
    // The ENGINE's last-activity stamp (persistence.js `lastActive`), epoch ms, or null when it did not send
    // one. Kept SEPARATE from lastActivity, which this client stamps: a dormant row must show a real time or
    // no time, never "now" for a session that has been asleep for a week.
    lastActive: engineActive(ev),
    unread: 0, closed: false, lastActivity: engineActive(ev) || Date.now(), outputBuf: "",
    // derived needs-you / attention flag — computed in ONE place
    get attention() { return this.status === "idle" && this.menu.length > 0; },
  };
}

// Keep the searchable transcript bounded + pre-lowercased so a keystroke-time substring test stays cheap.
const capTail = (s) => (s.length > TRANSCRIPT_CAP ? s.slice(s.length - TRANSCRIPT_CAP) : s);
const capLower = (s) => capTail(String(s == null ? "" : s).toLowerCase());

function appendBuf(s, data) {
  s.outputBuf += data;
  s._searchDirty = true;   // E3: invalidate the cached search rendition (recomputed lazily, only while searching)
  if (s.outputBuf.length > MAX_BUF) {
    s.outputBuf = s.outputBuf.slice(s.outputBuf.length - MAX_BUF);
    // trim a likely-partial leading line so a rewrite doesn't start mid-escape
    const nl = s.outputBuf.indexOf("\n");
    if (nl > 0 && nl < 4096) s.outputBuf = s.outputBuf.slice(nl + 1);
  }
}

function applyEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {                                  // session-less broadcasts (no sessionId)
    case "config": {
      const c = ev.config || {};
      notifyPrefs = c.notify || {};
      voicePrefs = (c.voice && typeof c.voice === "object") ? c.voice : {};   // R2 voice prefs ride config unknown-keys (like notify)
      promptMru = (c.promptMru && typeof c.promptMru === "object") ? c.promptMru : {};
      promptsList = Array.isArray(c.prompts) ? c.prompts : [];
      themeDefaults = (c.theme && typeof c.theme === "object") ? c.theme : {};
      sessionThemes = (c.sessionThemes && typeof c.sessionThemes === "object") ? c.sessionThemes : {};
      customThemes = Array.isArray(c.customThemes) ? c.customThemes : [];
      projects = Array.isArray(c.projects) ? c.projects : [];
      commandsList = Array.isArray(c.commands) ? c.commands : [];       // custom CLI-agent commands (Settings §M)
      hiddenProviders = Array.isArray(c.hiddenProviders) ? [...new Set(c.hiddenProviders.filter((id) => typeof id === "string" && id))] : [];
      providerArgs = (c.providerArgs && typeof c.providerArgs === "object" && !Array.isArray(c.providerArgs)) ? { ...c.providerArgs } : {};
      confirmClose = c.confirmClose !== false;                          // default ON; false → delete skips the confirm
      defaultCwd = typeof c.defaultCwd === "string" ? c.defaultCwd : "";
      about = (c.about && typeof c.about === "object" && !Array.isArray(c.about)) ? { ...c.about } : {};
      // ABSENT vs present-but-empty is the whole gate here, so it is preserved rather than defaulted to {}.
      onboarding = (c.onboarding && typeof c.onboarding === "object" && !Array.isArray(c.onboarding)) ? { ...c.onboarding } : null;
      engineVersion = typeof c.version === "string" ? c.version : engineVersion;   // forward-compat (engine may add it)
      emit("config", ev); return;
    }
    case "availability.result": {                                        // requester-only {providers:[{id,available,version,error}], commands:[...]}
      availability = { providers: byId(ev.providers), commands: byId(ev.commands), at: Date.now() };
      emit("availability", availability); return;
    }
    case "plugins":
      pluginsSeen = true; pluginsList = Array.isArray(ev.plugins) ? ev.plugins.slice() : [];
      emit("plugins", pluginsList); return;
    case "plugin.message": emit("plugin:message", ev); return;
    case "plugin.result": emit("plugin:result", ev); return;
    case "sessions.saved": emit("saved", ev.success !== false, ev.error || ""); return;
    case "session.dispatch": emit("session:dispatch", ev); return;   // {fromId,fromName,toId,toName}
    case "content.show": emit("content:show", ev); return;   // {sessionId,contentId,kind,name,url} — re-emit only; the engine holds the asset and replays it on connect
    case "content.closed": emit("content:closed", ev); return;   // {sessionId,contentId} — the engine dropped an asset; every client retires that tab, and NONE answers back
    case "content.resolve.result": emit("content:resolved", ev); return;   // requester-only {sessionId, resolved:{candidate: absPath|null}}
    case "prompt.show": emit("prompt:show", ev); return;     // {sessionId,promptId,question,options} OR {sessionId,promptId,annotate:{contentId,url,name}} — a blocked agent asks
    case "prompt.resolved": emit("prompt:resolved", ev); return;   // {promptId} — answered/timed-out/session-closed; ALWAYS dismiss the card in every client
    case "upload.done": emit("upload:done", ev); return;     // {sessionId,name,path,...} — a raw upload landed
    case "project.open.result": emit("project:openResult", ev); return;   // requester-only {cwd,success,fallback}
    case "dirs.list.result": emit("dirs:list", ev); return;                // requester-only {path,success,resolvedPath,entries}
    case "dirs.mkdir.result": emit("dirs:mkdir", ev); return;              // requester-only {parent,name,success,path}
    case "transcript.page.result": emit("transcript:page", ev); return;    // requester-only lazy history page
    case "transcript.cache": {                                             // on connect: {cache:{sessionId:text}} (50KB-capped, live + dormant)
      transcripts.clear();
      const c = (ev.cache && typeof ev.cache === "object") ? ev.cache : {};
      for (const id in c) transcripts.set(id, capLower(c[id]));
      emit("transcripts"); return;
    }
    case "transcript.append": {                                            // live turn: {id, role, text} — note `id`, not sessionId
      const id = ev.id;
      if (id) {
        const prev = transcripts.get(id) || "";
        transcripts.set(id, capTail(prev + (prev ? "\n" : "") + String(ev.text || "").toLowerCase()));
        // The row preview's PURE source: a finalized agent turn (ANSI-stripped, only on turn completion) — never
        // the live terminal tail, so the user's typing / deletes / pastes can't corrupt what the panel shows.
        if (ev.role === "agent" && ev.text) { const s = sessions.get(id); if (s) s.lastAgentMessage = String(ev.text); }
        emit("transcript:append", id);
      }
      return;
    }
  }
  if (!ev.sessionId) return;
  if (ev.type === "session.created") {
    // Name-conflict snapshot: on a create/rename collision the engine re-broadcasts session.created for the
    // UNCHANGED (conflicting) session with an added error {code:'name_conflict', operation, value, message, …}.
    // It's a no-op state-wise — never add a row, mutate, or auto-select; just route it to the repair surface.
    if (ev.error) {
      const op = String(ev.error.operation || "");   // 'session.rename' | 'session.create' | 'session.setProject' | 'session.restart' | 'content.open'
      // Apply the error snapshot's STATE to a KNOWN session FIRST — a restart_failed snapshot is dormant
      // (live:false, pid:null), so the row must go dormant, not linger live with a dead PID. Never add a row
      // or auto-select on an error snapshot. Rename/create/setProject snapshots are unchanged-state → no-op.
      const known = sessions.get(ev.sessionId);
      if (known) {
        if (respawned(known, ev)) resetProcessState(known);
        known.live = ev.live !== false; known.pid = ev.pid; known.name = ev.name || ""; known.lastActivity = Date.now();
        applySessionTelemetry(known, ev);
        known.lastActive = engineActive(ev) || known.lastActive;
        known.muted = ev.muted === true;
        if (typeof ev.bracketedPaste === "boolean") known.bracketedPaste = ev.bracketedPaste;
        known.projectId = ev.projectId || null;
        emit("session:update", known.id);
      }
      // content.open rides the same snapshot+error channel, so it MUST be routed explicitly: the catch-all below
      // is the create-repair surface, and an unopenable file falling into it would disarm the create focus
      // one-shot and report a failed drop as "that name is already taken".
      if (op === "content.open") emit("content:openFailed", ev.sessionId, ev.error);
      else if (op.endsWith("setProject")) emit("session:setProjectRejected", ev.sessionId, ev.error);   // name_conflict | unknown_project
      else if (op.endsWith("rename")) emit("session:renameRejected", ev.sessionId, ev.error.value || "");
      else if (op.endsWith("restart")) emit("session:restartFailed", ev.sessionId, ev.error.message || "");   // respawn failed → row already went dormant above
      else { pendingLocalCreate = false; emit("session:createRejected", ev.error.message || "That name is already taken in this project.", ev.error); }   // our create bounced → disarm the focus one-shot
      return;
    }
    const known = sessions.get(ev.sessionId);
    if (!known) { const s = makeSession(ev); sessions.set(s.id, s); emit("session:add", s.id); }
    else {   // same id re-broadcast — resume flip (live/pid), rename (name), mute, or setProject; update IN PLACE, keep history/buffer/unread
      if (respawned(known, ev)) resetProcessState(known);
      known.live = ev.live !== false; known.pid = ev.pid; known.name = ev.name || ""; known.lastActivity = Date.now();
      applySessionTelemetry(known, ev);
      known.lastActive = engineActive(ev) || known.lastActive;
      known.muted = ev.muted === true;   // mute toggles arrive as a session.created re-broadcast
      if (typeof ev.bracketedPaste === "boolean") known.bracketedPaste = ev.bracketedPaste;
      known.projectId = ev.projectId || null;   // setProject re-broadcasts the snapshot with the new projectId
      emit("session:update", known.id);
    }
    // Focus on create: a brand-new LIVE session THIS client just asked for (ws.createSession armed the one-shot)
    // becomes active — select() drives the terminal focus via store.on("active"). A replayed/reconnect burst can't
    // reach here armed (reset() disarms first) and a remote/agent spawn never armed it → neither steals the user's place.
    if (!known && pendingLocalCreate && ev.live !== false) { pendingLocalCreate = false; select(ev.sessionId); }
    else if (activeId == null && ev.live !== false) select(ev.sessionId);   // else auto-open the first LIVE session (don't force a dormant one)
    emit("chrome"); return;
  }
  const s = sessions.get(ev.sessionId);
  if (!s) return;                                  // event for a session we don't track
  s.lastActivity = Date.now();
  const active = activeId === s.id;
  switch (ev.type) {
    case "session.closed":
      s.closed = true; sessions.delete(s.id); transcripts.delete(s.id); emit("session:remove", s.id);
      if (active) { activeId = null; emit("active", null); }
      emit("chrome"); return;
    case "status": {
      // Replay-safe idle detector: the engine replays only ONE status event per session on connect
      // (the current state), so a working→idle PAIR can only come from a genuine live transition —
      // guarding on prev==='working' (null after reset()) never fires on a reconnect replay burst.
      const prev = s.status;
      s.status = ev.state;
      applySessionTelemetry(s, ev);          // contextUsage and the active model ride the status frame
      if (ev.state === "working" && prev !== "working") s.workStartedAt = Date.now();
      else if (ev.state === "idle" && prev === "working") emit("session:wentIdle", s.id, Date.now() - (s.workStartedAt || Date.now()));
      emit("session:update", s.id);
      break;
    }
    case "agent.update": s.latestAgent = ev.text; emit("session:update", s.id); break;
    case "agent.final":
      s.latestAgent = ev.text || s.latestAgent;
      if (ev.text) s.lastAgentMessage = ev.text;    // finalized agent message → the pure preview source
      if (epochMs(ev.at)) s.lastAgentAt = ev.at;
      if (!active) s.unread += 1;                   // unread = final while unfocused
      emit("session:update", s.id); emit("chrome"); break;
    case "menu": s.menu = ev.choices || []; s.menuContext = ev.context || ""; emit("session:update", s.id); break;
    case "output": appendBuf(s, ev.data); emit("session:output", s.id, ev.data, ev.replay === true); break;
    // turn.user is intentionally ignored — the terminal already echoes what you type.
  }
}

function select(id) {
  const s = sessions.get(id); if (!s) return;
  const prev = activeId; activeId = id;
  s.unread = 0;
  if (prev != null && prev !== id) emit("session:update", prev);
  emit("session:update", id);
  emit("active", id);
  if (filter === "unread" && unreadCount() === 0) { filter = "all"; emit("filter"); }   // last unread read → fall back to All (v1 terminals.js:830-840)
  emit("chrome");
}

// A session's name-uniqueness scope = its project (if any), else its cwd. Mirrors how sessions are grouped
// AND the engine's sameSessionScope [project-scope.js]. Two sessions collide only within the same scope key.
function scopeKey(s) { return s && s.projectId ? "p:" + s.projectId : "c:" + ((s && s.cwd) || ""); }
// Duplicate-name check within a scope ({cwd, projectId}), case-insensitive, excluding self. The engine
// enforces the same server-side; this is the live inline-rename validation (v1 terminals.js:68-90).
function isNameTaken(scope, name, exceptId) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return false;
  const key = scopeKey(scope);
  for (const s of sessions.values()) {
    if (s.id === exceptId) continue;
    if (scopeKey(s) !== key) continue;
    if ((s.name || "").trim().toLowerCase() === n) return true;
  }
  return false;
}

function unreadCount() { let n = 0; for (const s of sessions.values()) if (s.unread > 0) n++; return n; }

function reset() {
  sessions.clear(); transcripts.clear(); pluginsList = []; pluginsSeen = false; activeId = null; pendingLocalCreate = false;
  emit("plugins", pluginsList); emit("reset"); emit("chrome");
}

export const store = {
  on,
  applyEvent, select, reset,
  expectLocalCreate() { pendingLocalCreate = true; },   // ws.createSession arms this so the resulting NEW session takes focus (local action only)
  sessions,
  get activeId() { return activeId; },
  get connected() { return connected; },
  get filter() { return filter; },
  get search() { return search; },
  active() { return activeId != null ? sessions.get(activeId) : null; },
  setFilter(f) { filter = f; emit("filter"); },
  setSearch(q) { search = q; emit("filter"); },
  setConnected(b) { connected = b; emit("connection", b); },
  get stale() { return stale; },
  get staleMessage() { return staleMsg; },
  setStale(on, msg) { stale = !!on; staleMsg = on ? (msg || "") : ""; emit("stale", stale, staleMsg); },   // ws.js drives this; the sidebar renders the banner
  unreadSessions: unreadCount,
  isNameTaken,
  setTermSize(c, r) { if (c > 0 && r > 0) { termCols = c; termRows = r; } },
  get termCols() { return termCols; },
  get termRows() { return termRows; },
  get notify() { return notifyPrefs; },   // raw server config.notify; notify.js merges defaults
  get voice() { return voicePrefs; },      // raw server config.voice {readAloud?} — voice.js reads/writes via updateConfig
  get promptMru() { return promptMru; },
  setPromptMru(o) { promptMru = (o && typeof o === "object") ? o : {}; emit("config"); },
  get prompts() { return promptsList; },   // server config.prompts [{id,name,text}] — the prompt library
  transcriptText(id) { return transcripts.get(id) || ""; },   // lowercased, capped conversation text for search (live + dormant)
  outputSearchText,   // ANSI-stripped, lowercased, capped rendition of raw output for the search haystack (E3)
  // Optimistic local write so the library/dropdown re-render instantly; the engine echoes {type:'config'}
  // right after config.update and re-affirms this same array (idempotent) — no flicker, single source.
  setPrompts(arr) { promptsList = Array.isArray(arr) ? arr.slice() : []; emit("config"); },
  // Terminal theme library config (rides the config store's unknown keys). Optimistic writes emit "config"
  // so the open terminal + theme picker re-render instantly; the engine echo re-affirms the same value.
  get themeDefaults() { return themeDefaults; },
  get sessionThemes() { return sessionThemes; },
  get customThemes() { return customThemes; },
  setThemeDefaults(o) { themeDefaults = (o && typeof o === "object") ? o : {}; emit("config"); },
  setSessionThemes(o) { sessionThemes = (o && typeof o === "object") ? o : {}; emit("config"); },
  // User projects (config.projects) — order IS the display order. Optimistic writes emit "config" so the
  // sidebar reflects a create/rename/recolor/reorder instantly; the engine echoes {type:'config'} to re-affirm.
  get projects() { return projects; },
  setProjects(arr) { projects = Array.isArray(arr) ? arr.slice() : []; emit("config"); },
  // Settings surface (§M) — projections of the config keys + the requester-only availability cache.
  get commands() { return commandsList; },
  setCommands(arr) { commandsList = Array.isArray(arr) ? arr.slice() : []; emit("config"); },   // optimistic; engine echoes {type:'config'}
  get hiddenProviders() { return hiddenProviders; },
  setHiddenProviders(arr) { hiddenProviders = Array.isArray(arr) ? [...new Set(arr.filter((id) => typeof id === "string" && id))] : []; emit("config"); },
  get providerArgs() { return providerArgs; },
  setProviderArgs(value) { providerArgs = (value && typeof value === "object" && !Array.isArray(value)) ? { ...value } : {}; emit("config"); },
  get confirmClose() { return confirmClose; },
  get defaultCwd() { return defaultCwd; },
  // About me (config.about) + onboarding state (config.onboarding). Optimistic writes emit "config" so the
  // open Settings pane and the tour see an edit immediately; the engine echoes {type:'config'} to re-affirm.
  get about() { return about; },
  setAbout(o) { about = (o && typeof o === "object" && !Array.isArray(o)) ? { ...o } : {}; emit("config"); },
  get onboarding() { return onboarding; },                       // null = key absent (existing/unknown install)
  get onboardingCompleted() { return !!(onboarding && onboarding.completed); },
  get seenTips() { return (onboarding && Array.isArray(onboarding.seenTips)) ? onboarding.seenTips : []; },
  setOnboarding(o) { onboarding = (o && typeof o === "object" && !Array.isArray(o)) ? { ...o } : null; emit("config"); },
  get engineVersion() { return engineVersion; },
  get availability() { return availability; },   // {providers:Map,commands:Map,at} or null until checkAvailability replies
  get plugins() { return pluginsList; },          // full engine snapshot; plugin-host reconciles client runtimes from it
  get pluginsLoaded() { return pluginsSeen; },
};

import { state, send } from './state.js';
import { esc, binName, resolveIconPath } from './utils.js';
import { addTerminal, removeTerminal, select, startRename, startResumableRename, startProjectRename, setSessionTheme, openMenu, closeMenu, setStatus, updateMuteIndicator, updatePreview, markUnread, applyFilter, setTab, renderResumable, regroupSessions, reorderTerms, setHasToken, toggleProjectCollapse, setSessionProject, estimateSize, restartComplete, positionMenu, addPill, updatePill, removePill, appendPillLog, setPillLogs, closePillLog, applyFontSize, clampFontSize, FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX } from './terminals.js';
import { renderSettings, updateVersionFooter, setFontSize } from './settings.js';
import { openCreator, closeCreator, refreshCreator } from './creator.js';
import { handleDirsResponse, handleMkdirResponse, openFolderPicker } from './folder-picker.js';
import { confirmClose } from './confirm.js';
import { applyTheme } from './profiles.js';
import { toggleMode, applyMode } from './color-mode.js';
import { showToast } from './toast.js';
import { sessionsInCwd } from './session-collisions.js';
import './nav.js';
import { initDrag, wasDragging } from './drag.js';
import { init as initSidebarResize, applySidebarWidth } from './sidebar-resize.js';
import { registerHotkey, unregisterHotkey, unregisterAllForPlugin } from './hotkeys.js';
import { renderPrompts } from './prompts.js';

const shownAgentHealthToasts = new Set();
let reconnectReplaySkip = null;

// Connection liveness. Browsers leave WebSocket sockets in a half-open state
// when the underlying TCP connection silently dies (laptop sleep, Wi-Fi roam,
// NAT timeout, idle proxy). Without an app-level heartbeat the user is stuck:
// keystrokes hit a socket the OS still thinks is open, so onclose never fires
// and the only escape was a full page refresh. We send a ping every 20s and
// force a reconnect if no pong arrives within 10s.
const HEARTBEAT_MS = 20000;
const PONG_TIMEOUT_MS = 10000;
let heartbeatTimer = null;
let pongTimer = null;
let lastDropToastId = null;

// ── Connection lozenge (lower-left of the page) ──
// Lance asked for an unambiguous "am I connected?" indicator with uptime
// + version. Green when the WebSocket is OPEN, red when not. Flips
// instantly on ws.onopen/onclose; a 1s tick keeps the uptime string
// fresh without polling the server.
let connectedAt = null;
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60), rem = s % 60;
  if (m < 60)   return `${m}m ${rem}s`;
  const h = Math.floor(m / 60), mrem = m % 60;
  return `${h}h ${mrem}m`;
}
function renderStatusBadge() {
  const badge = document.getElementById('app-status-badge');
  const dot   = document.getElementById('app-status-dot');
  const text  = document.getElementById('app-status-text');
  if (!badge || !dot || !text) return;
  const open = state.ws && state.ws.readyState === WebSocket.OPEN && connectedAt;
  const v    = state.cfg?.version ? `v${state.cfg.version}` : '';
  // Overlay version: visible text is the HEAD commit's timestamp (no
  // commit-lookup required at a glance); hover tooltip surfaces the SHA
  // + commit message so a build is verifiable on demand. `ovInfo` is null
  // when the image wasn't stamped (upstream clideck running without the
  // clideck-docker-lance overlay), in which case nothing extra is rendered.
  const ovInfo = state.cfg?.overlayVersion;
  const ov     = ovInfo?.timestamp ? `overlay ${ovInfo.timestamp}${ovInfo.dirty ? ' (dirty)' : ''}` : '';
  badge.title  = ovInfo
    ? `${ovInfo.sha || '(no sha)'}${ovInfo.dirty ? ' (dirty working tree)' : ''}\n${ovInfo.message || ''}`
    : '';
  badge.classList.remove(
    'bg-slate-800/80', 'border-slate-700/60', 'text-slate-400',
    'bg-emerald-900/50', 'border-emerald-700/50', 'text-emerald-300',
    'bg-red-900/50', 'border-red-700/50', 'text-red-300',
  );
  dot.classList.remove('bg-slate-500', 'bg-emerald-400', 'bg-red-400', 'animate-pulse');
  if (open) {
    badge.classList.add('bg-emerald-900/50', 'border-emerald-700/50', 'text-emerald-300');
    dot.classList.add('bg-emerald-400');
    const up = fmtUptime(Date.now() - connectedAt);
    text.textContent = `connected · ${up}${v ? ' · ' + v : ''}${ov ? ' · ' + ov : ''}`;
  } else {
    badge.classList.add('bg-red-900/50', 'border-red-700/50', 'text-red-300');
    dot.classList.add('bg-red-400', 'animate-pulse');
    text.textContent = 'disconnected · reconnecting…';
  }
}
window.__refreshStatusBadge = renderStatusBadge;
setInterval(renderStatusBadge, 1000);

function clearHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (pongTimer) return; // a ping is already in flight
    send({ type: 'ping', t: Date.now() });
    pongTimer = setTimeout(() => {
      pongTimer = null;
      // Server didn't respond — assume the connection is dead and force the
      // reconnect path. close() will fire onclose, which schedules connect().
      try { state.ws && state.ws.close(); } catch { /* noop */ }
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

function connect() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${wsProtocol}//${location.host}`);

  state.ws.onopen = () => {
    connectedAt = Date.now();
    renderStatusBadge();
    reconnectReplaySkip = new Set(state.terms.keys());
    if (lastDropToastId) {
      showToast('Reconnected', { id: lastDropToastId, type: 'success', duration: 2000 });
      lastDropToastId = null;
    }
    startHeartbeat();
    send({ type: 'remote.status' });
  };

  state.ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'pong':
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
        break;
      case 'config': {
        state.cfg = msg.config;
        applyMode(state.cfg.colorMode || 'dark');
        regroupSessions();
        renderSettings();
        renderPrompts();
        refreshCreator();
        for (const [, entry] of state.terms) applyTheme(entry.term, entry.themeId);
        // Phase 9 (D-03): a config broadcast can carry a new terminalFontSize
        // (e.g. another connected client used the stepper). Push it to every
        // open xterm so the size stays consistent across clients/tabs.
        applyFontSize(state.cfg.terminalFontSize);
        // Phase 9 (D-06): config is the source of truth for sidebarWidth.
        // The paint-hint in sidebar-resize.js applies localStorage
        // synchronously at module load; this call replaces that with the
        // authoritative value from the server and re-mirrors to localStorage
        // (healing any out-of-band drift between cache and config.json).
        applySidebarWidth(state.cfg.sidebarWidth);
        break;
      }
      case 'themes':
        state.themes = msg.themes;
        renderSettings();
        break;
      case 'presets':
        state.presets = msg.presets;
        renderSettings();
        refreshCreator();
        for (const p of state.presets) {
          if (p.available && p.health && !p.health.ok && p.health.reason !== 'Not installed' && !shownAgentHealthToasts.has(p.presetId)) {
            shownAgentHealthToasts.add(p.presetId);
            showToast(`${p.name}: ${p.health.reason}`, { id: `agent-health-${p.presetId}`, type: p.versionOk === false ? 'error' : 'warn', duration: 0, title: 'Agent Attention' });
          }
        }
        break;
      case 'sessions.resumable':
        state.resumable = msg.list;
        renderResumable();
        break;
      case 'sessions.reorder':
        // Server confirmed (or another client initiated) a drag-to-reorder.
        // Rebuild the local Maps to match — the originating client already
        // did this optimistically, so this is a no-op there; on other
        // clients it's the live sync.
        reorderTerms(msg.ids);
        break;
      case 'error':
        showToast(msg.message || 'CliDeck action failed.', { type: 'error', title: 'CliDeck Error', duration: 5000 });
        break;
      case 'sessions':
        {
          const liveIds = new Set(msg.list.map(s => s.id));
          for (const id of [...state.terms.keys()]) {
            if (!liveIds.has(id)) removeTerminal(id);
          }
          msg.list.forEach(s => {
            addTerminal(s.id, s.name, s.themeId, s.commandId, s.projectId, s.muted, s.lastPreview, s.presetId, s.cwd);
            setHasToken(s.id, !!s.hasToken);
          });
          if (!state.active || !state.terms.has(state.active)) {
            if (msg.list.length) select(msg.list[0].id);
          }
        }
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.themeId, msg.commandId, msg.projectId, msg.muted, msg.lastPreview, msg.presetId, msg.cwd);
        // Resumed sessions already carry a captured token — without
        // propagating it here, the Pause menu item stays disabled
        // until the agent emits a fresh token (which it usually
        // won't during a resume — the token IS the resume key).
        setHasToken(msg.id, !!msg.hasToken);
        select(msg.id);
        applyFilter();
        closeMobileSidebar();
        break;
      case 'output': {
        const entry = state.terms.get(msg.id);
        if (msg.replay && reconnectReplaySkip?.has(msg.id) && entry) break;
        if (entry && !entry.queue(msg.data)) entry.term.write(msg.data);
        updatePreview(msg.id);
        // Primary unread trigger is the working→idle transition inside
        // setStatus (terminals.js) — it gates the dot so it can't collide
        // with the bouncing "working" indicator. This fallback path only
        // fires for passive output (a session that never enters working
        // state, e.g. a `tail -f` in a Shell preset), so the dot still
        // flags unattended activity for non-agent sessions.
        if (entry && !entry.working) markUnread(msg.id);
        break;
      }
      case 'closed':
        if (msg.reason === 'paused') {
          const entry = state.terms.get(msg.id);
          const name = entry ? document.querySelector(`.group[data-id="${msg.id}"] .name`)?.textContent || 'Session' : 'Session';
          showToast(`Paused "${name}" — available under Previous Sessions.`, { type: 'info', duration: 2500 });
        }
        removeTerminal(msg.id);
        break;
      case 'session.token':
        // Server captured a session token for this id. Flip the entry's
        // hasToken flag so the next open of the menu shows Pause as
        // enabled. (No live re-render of an already-open menu — the
        // user can close and reopen.)
        setHasToken(msg.id, !!msg.hasToken);
        break;
      case 'session.recovered': {
        // The server tried to resume a dormant session, the underlying
        // agent couldn't find that conversation, so it spawned a fresh
        // session in the same working directory. Tell the user.
        const cwd = (msg.cwd || '').replace(/\\\\/g, '\\');
        const short = cwd.length > 60 ? '…' + cwd.slice(-60) : cwd;
        showToast(`Couldn't resume previous session — started a fresh one in ${short || 'the same folder'}.`, { duration: 6000 });
        break;
      }
      case 'session.restarted':
        console.log('[session] got session.restarted from server', msg);
        restartComplete(msg.id, msg);
        break;
      // Telemetry/bridge working/idle
      case 'session.status':
        setStatus(msg.id, msg.working);
        break;
      // Server requests terminal capture (e.g. after PermissionRequest hook)
      case 'terminal.capture': {
        const ce = state.terms.get(msg.id);
        if (ce?.term) {
          const buf = ce.term.buffer.active;
          const lines = [];
          for (let i = 0; i < buf.length; i++) { const line = buf.getLine(i); if (line) lines.push(line.translateToString(true)); }
          send({ type: 'terminal.buffer', id: msg.id, lines, menuVersion: msg.menuVersion });
        }
        break;
      }
      case 'session.history': {
        const entry = state.terms.get(msg.id);
        if (msg.replay && reconnectReplaySkip?.has(msg.id) && entry) break;
        if (entry && !entry.queue(msg.text + '\n')) entry.term.write(msg.text + '\n');
        updatePreview(msg.id);
        break;
      }
      // Bridge preview text (OpenCode plugin)
      case 'session.preview': {
        const pe = state.terms.get(msg.id);
        if (pe && msg.text) {
          pe.lastPreviewText = msg.text;
          pe.lastActivityAt = Date.now();
          const el = document.querySelector(`.group[data-id="${msg.id}"] .session-preview`);
          if (el) el.textContent = msg.text;
          // Persist bridge preview on server — picked up by 30s auto-save
          send({ type: 'session.setPreview', id: msg.id, text: msg.text, timestamp: new Date().toISOString() });
        }
        break;
      }
      /* [OLD-STATUS] I/O burst heuristic — replaced by onRender detection in terminals.js
      case 'stats': {
        for (const [sid, st] of Object.entries(msg.stats)) {
          const entry = state.terms.get(sid);
          if (!entry) continue;
          const cmd = state.cfg.commands.find(c => c.id === entry.commandId);
          if (cmd?.bridge) continue;
          const net = Math.max(st.rawRateOut || 0, st.rawRateIn || 0);
          const burstUp = (st.burstMs || 0) > (entry.prevBurst || 0) && st.burstMs > 0;
          const userTyping = (st.rawRateIn || 0) > 0 && (st.rawRateIn || 0) < 50;
          entry.prevBurst = st.burstMs || 0;

          const isWorking = burstUp && net >= 800 && !userTyping;
          const isIdle = !burstUp && net < 800;

          if (isWorking) entry.workTicks = (entry.workTicks || 0) + 1;
          else entry.workTicks = 0;
          if (isIdle) entry.idleTicks = (entry.idleTicks || 0) + 1;
          else entry.idleTicks = 0;

          if (entry.workTicks >= 2) {
            if (!entry.working) send({ type: 'session.statusReport', id: sid, working: true });
            setStatus(sid, true);
          } else if (entry.idleTicks >= 2) {
            if (entry.working) send({ type: 'session.statusReport', id: sid, working: false });
            setStatus(sid, false);
          }
        }
        break;
      }
      [OLD-STATUS] */
      case 'transcript.cache':
        state.transcriptCache = msg.cache;
        for (const [id, text] of Object.entries(msg.cache)) {
          const entry = state.terms.get(id);
          if (entry) entry.searchText = text;
        }
        break;
      case 'transcript.append': {
        state.transcriptCache[msg.id] = (state.transcriptCache[msg.id] || '') + '\n' + msg.text;
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.searchText = (entry.searchText || '') + '\n' + msg.text;
          if (state.filter.query) applyFilter();
        }
        break;
      }
      case 'dirs':
        handleDirsResponse(msg);
        break;
      case 'dirs.subdirs':
        handleBulkSubdirsResponse(msg);
        break;
      case 'dirs.mkdir':
        handleMkdirResponse(msg);
        break;
      case 'session.theme': {
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.themeId = msg.themeId;
          applyTheme(entry.term, msg.themeId);
        }
        break;
      }
      case 'session.setProject': {
        const entry = state.terms.get(msg.id);
        if (entry) { entry.projectId = msg.projectId; regroupSessions(); }
        break;
      }
      case 'session.mute': {
        const entry = state.terms.get(msg.id);
        if (entry) { entry.muted = !!msg.muted; updateMuteIndicator(msg.id); }
        break;
      }
      case 'session.needsSetup': {
        const entry = state.terms.get(msg.id);
        if (entry) showTelemetrySetup(entry.commandId, msg.id);
        break;
      }
      case 'renamed': {
        const el = document.querySelector(`.group[data-id="${msg.id}"] .name`);
        if (el && el.contentEditable !== 'true') el.textContent = msg.name;
        break;
      }
      case 'telemetry.autosetup.result': {
        const toast = document.querySelector(`[data-setup-preset="${msg.presetId}"]`);
        if (!toast) break;
        const actionsEl = toast.querySelector('.setup-actions');
        if (msg.success) {
          const sid = (toast.dataset.sessionId && toast.dataset.sessionId !== 'null' && toast.dataset.sessionId !== 'undefined')
            ? toast.dataset.sessionId
            : '';
          const reviewNote = msg.presetId === 'codex'
            ? `<div class="w-full px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-400/20 text-[11px] leading-relaxed text-amber-200/90">
              Codex may show <span class="font-semibold text-amber-100">2 hooks need review</span>. Open <code class="px-1 py-0.5 rounded bg-slate-950/50 text-amber-100">/hooks</code> in Codex and approve the CliDeck hooks once.
            </div>`
            : '';
          actionsEl.className = 'setup-actions px-4 pb-3.5 flex flex-col gap-2';
          actionsEl.innerHTML = `
            ${reviewNote}
            <div class="w-full flex items-center gap-2">
              <div class="flex-1 flex items-center gap-1.5 text-xs text-emerald-400">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
                Configured
              </div>
              ${sid ? `<button class="restart-btn px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Restart Session</button>` : ''}
              <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Dismiss</button>
            </div>
          `;
          actionsEl.querySelector('.dismiss-btn').onclick = () => toast.remove();
          if (sid) actionsEl.querySelector('.restart-btn').onclick = () => {
            const entry = state.terms.get(sid);
            send({ type: 'session.restart', id: sid, themeId: entry?.themeId, cols: entry?.term?.cols, rows: entry?.term?.rows });
            toast.remove();
          };
        } else {
          shownSetup.delete(msg.presetId);
          const btn = toast.querySelector('.auto-setup-btn');
          btn.textContent = 'Failed — configure manually';
          btn.className = 'auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-red-600/20 text-red-400 border border-red-500/30 rounded-lg cursor-default';
        }
        break;
      }
      case 'project.openPath.result':
        if (!msg.success) showToast(msg.error || 'Failed to open project folder', { type: 'error' });
        break;
      case 'sessions.saved':
        flashSaveIndicator();
        break;
      case 'plugins':
        loadPlugins(msg.list);
        break;
      case 'plugin.install.result': {
        const btn = document.querySelector(`.plugin-install-btn[data-plugin-id="${msg.pluginId}"]`);
        if (!btn) break;
        if (msg.success) {
          btn.textContent = 'Installed';
          btn.className = btn.className.replace('bg-blue-600 hover:bg-blue-500 text-white', 'bg-emerald-600/20 text-emerald-400 cursor-default');
        } else {
          btn.textContent = 'Failed';
          btn.className = btn.className.replace('bg-blue-600 hover:bg-blue-500', 'bg-red-600/20 text-red-400 cursor-default');
          btn.disabled = false;
        }
        break;
      }
      case 'pills':
        {
          const liveIds = new Set(msg.list.map(p => p.id));
          for (const id of [...state.pills.keys()]) {
            if (!liveIds.has(id)) removePill(id);
          }
          for (const p of msg.list) {
            if (state.pills.has(p.id)) updatePill(p);
            else addPill(p);
          }
        }
        break;
      case 'pill.added':
        addPill(msg.pill);
        break;
      case 'pill.updated':
        updatePill(msg.pill);
        break;
      case 'pill.removed':
        removePill(msg.id);
        break;
      case 'pill.log':
        appendPillLog(msg.id, msg.entry);
        break;
      case 'pill.logs':
        setPillLogs(msg.id, msg.logs);
        break;
      case 'plugin.delete.error':
        showToast(`Failed to remove plugin: ${msg.error}`, { duration: 4000 });
        break;
      case 'remote.status':
        handleRemoteStatus(msg);
        break;
      case 'remote.paired':
        handleRemotePaired(msg);
        break;
      case 'remote.unpaired':
        handleRemoteUnpaired();
        break;
      case 'remote.error':
        handleRemoteError(msg.error);
        break;
      case 'remote.install.progress':
        appendInstallLog(msg.text);
        break;
      case 'remote.install.done':
        handleInstallDone(msg.success);
        break;
      case 'remote.update':
        remoteUpdateInfo = msg?.available ? msg : null;
        if (remotePreflight?.pending) {
          remotePreflight.updateSeen = true;
          finishRemotePreflight();
        }
        break;
      default:
        if (msg.type?.startsWith('plugin.')) dispatchPluginMessage(msg);
        break;
    }
  };

  state.ws.onclose = () => {
    connectedAt = null;
    renderStatusBadge();
    clearHeartbeat();
    if (!lastDropToastId) {
      lastDropToastId = `ws-reconnect-${Date.now()}`;
      showToast('Connection lost — reconnecting…', { id: lastDropToastId, type: 'warn', duration: 0 });
    }
    setTimeout(connect, 1000);
  };
  // onerror by itself does not trigger reconnect — close() does. Force-close
  // so the onclose path runs.
  state.ws.onerror = () => {
    try { state.ws && state.ws.close(); } catch { /* noop */ }
  };
}

// When the tab becomes visible again (laptop wake, switching back), the
// socket may already be dead even though no event fired. Kick the reconnect
// path immediately rather than waiting for the next heartbeat tick.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    try { state.ws && state.ws.close(); } catch { /* noop */ }
  }
});

// Mobile sidebar
const mobileQuery = window.matchMedia('(max-width: 960px)');
function closeMobileSidebar() { document.body.classList.remove('mobile-nav-open'); }
document.getElementById('mobile-nav-toggle').addEventListener('click', () => {
  if (mobileQuery.matches) document.body.classList.toggle('mobile-nav-open');
});
document.getElementById('mobile-nav-close').addEventListener('click', closeMobileSidebar);
document.getElementById('mobile-sidebar-backdrop').addEventListener('click', closeMobileSidebar);
mobileQuery.addEventListener('change', (e) => { if (!e.matches) closeMobileSidebar(); });

// Sidebar events
const sessionList = document.getElementById('session-list');
sessionList.addEventListener('projects-rendered', () => renderProjectActions());

sessionList.addEventListener('click', (e) => {
  closeCreator();
  closeProjectCreator();

  // Project header click — toggle collapse (skip if just finished a drag)
  const projHeader = e.target.closest('.project-header');
  if (e.target.closest('.project-path-btn')) {
    const projId = e.target.closest('.project-header')?.dataset.projectId;
    if (projId) send({ type: 'project.openPath', id: projId });
    return;
  }
  if (e.target.closest('.plugin-project-btn')) return; // handled by btn's own click listener
  if (projHeader && !e.target.closest('.project-menu-btn') && !wasDragging()) {
    toggleProjectCollapse(projHeader.dataset.projectId);
    return;
  }
  // Project menu button
  if (e.target.closest('.project-menu-btn')) {
    const projId = e.target.closest('.project-group')?.dataset.projectId;
    if (projId) openProjectMenu(projId, e.target.closest('.project-menu-btn'));
    return;
  }

  // Previous sessions menu button
  if (e.target.closest('.prev-sessions-menu-btn')) {
    openPrevSessionsMenu(e.target.closest('.prev-sessions-menu-btn'));
    return;
  }

  // Per-row menu button on a dormant ("resumable") session — must run
  // BEFORE the row-level resume handler below, otherwise clicking the
  // dots immediately fires a resume.
  const resumableMenuBtn = e.target.closest('.resumable-menu-btn');
  if (resumableMenuBtn) {
    const row = resumableMenuBtn.closest('[data-resumable-id]');
    if (row) openResumableRowMenu(row.dataset.resumableId, resumableMenuBtn);
    return;
  }

  // Resumable session click
  const resumableRow = e.target.closest('[data-resumable-id]');
  if (resumableRow) {
    send({ type: 'session.resume', id: resumableRow.dataset.resumableId });
    closeMobileSidebar();
    return;
  }

  // Pill row click — handled by pill's own listener
  if (e.target.closest('.pill-row')) return;

  const item = e.target.closest('.group');
  if (!item) return;

  // Menu button
  if (e.target.closest('.menu-btn')) {
    openMenu(item.dataset.id, e.target.closest('.menu-btn'));
    return;
  }

  select(item.dataset.id);
  closeMobileSidebar();
});

sessionList.addEventListener('dblclick', (e) => {
  const nameEl = e.target.closest('.name');
  if (nameEl) {
    const id = e.target.closest('.group[data-id]')?.dataset.id;
    if (id) startRename(id);
  }
  // Project name rename
  const projNameEl = e.target.closest('.project-name');
  if (projNameEl) {
    const projId = e.target.closest('.project-group')?.dataset.projectId;
    if (projId) startProjectRename(projId);
  }
  // Resumable (dormant) row rename
  const resumableNameEl = e.target.closest('.resumable-name');
  if (resumableNameEl) {
    const rid = e.target.closest('[data-resumable-id]')?.dataset.resumableId;
    if (rid) startResumableRename(rid);
  }
});

// Session delete from context menu — always confirm
sessionList.addEventListener('session-delete', async (e) => {
  const id = e.detail.id;
  const ok = await confirmClose();
  if (!ok) return;
  send({ type: 'close', id });
});

// Mode toggle theme switch — dispatched from color-mode.js to avoid circular import
let modeToastQueued = false;
document.addEventListener('clideck-theme-switch', (e) => {
  setSessionTheme(e.detail.id, e.detail.themeId, { showBanner: false });
  if (!modeToastQueued) {
    modeToastQueued = true;
    queueMicrotask(() => {
      modeToastQueued = false;
      showModeToast();
    });
  }
});

function showModeToast() {
  showToast('If a terminal looks off, right-click the session and choose <strong class="text-slate-200">Refresh session</strong>.', {
    type: 'warn', duration: 4000, id: 'mode', html: true,
  });
}

document.getElementById('btn-new').addEventListener('click', () => {
  send({ type: 'checkAvailability' });
  openCreator();
});
document.getElementById('btn-new-project').addEventListener('click', () => {
  closeCreator();
  openProjectCreator();
});
document.getElementById('btn-bulk-import').addEventListener('click', () => {
  closeCreator();
  openBulkImport();
});

// Search & filter toolbar
document.getElementById('search-input').addEventListener('input', (e) => {
  state.filter.query = e.target.value;
  applyFilter();
});
document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});



// Telemetry setup notification — shown once per agent type
const shownSetup = new Set();
document.addEventListener('clideck:setup', (e) => showTelemetrySetup(e.detail.commandId, null));
function showTelemetrySetup(commandId, sessionId) {
  const cmd = state.cfg.commands.find(c => c.id === commandId);
  if (!cmd) return;
  // Skip if telemetry is already configured via settings
  if (cmd.telemetryEnabled && cmd.telemetryStatus?.ok) return;
  const bin = binName(cmd.command);
  const preset = state.presets.find(p => binName(p.command) === bin);
  const setupRaw = preset.telemetrySetup || preset.pluginSetup;
  if (!setupRaw || shownSetup.has(preset.presetId)) return;
  shownSetup.add(preset.presetId);

  const port = location.port || '4000';
  const setupText = setupRaw.replace(/\{\{port\}\}/g, port);
  const [desc, ...codeParts] = setupText.split('\n\n');
  const code = codeParts.join('\n\n');
  const auto = preset.telemetryAutoSetup;
  const iconSrc = preset.icon?.startsWith('/') ? resolveIconPath(preset.icon) : null;
  const title = preset.bridge ? 'Bridge Plugin' : 'Status Tracking';

  const toast = document.createElement('div');
  toast.dataset.setupPreset = preset.presetId;
  if (sessionId) toast.dataset.sessionId = sessionId;
  toast.dataset.commandId = commandId;
  toast.className = 'fixed bottom-5 right-5 z-[500] w-[360px] bg-slate-800/95 backdrop-blur-sm border border-slate-700/60 rounded-xl shadow-2xl shadow-black/60';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(12px)';
  toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

  toast.innerHTML = `
    <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
      ${iconSrc ? `<img src="${esc(iconSrc)}" class="w-5 h-5 object-contain flex-shrink-0">` : ''}
      <span class="text-[13px] font-semibold text-slate-200">${esc(preset.name)} — ${title}</span>
      <button class="dismiss-btn ml-auto w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <p class="px-4 pt-1 pb-2.5 text-xs text-slate-400 leading-relaxed">${esc(desc)}</p>
    ${code ? `<div class="mx-4 mb-3 px-3 py-2.5 bg-slate-900/70 rounded-lg border border-slate-700/40">
      <pre class="text-[11px] text-emerald-400/80 font-mono leading-relaxed whitespace-pre-wrap">${esc(code)}</pre>
    </div>` : ''}
    <div class="setup-actions px-4 pb-3.5 flex items-center gap-2">
      ${auto ? `<button class="auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">
        ${esc(auto.label)}
      </button>` : ''}
      <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Dismiss</button>
    </div>`;

  toast.querySelectorAll('.dismiss-btn').forEach(b => b.onclick = () => {
    shownSetup.delete(preset.presetId);
    toast.remove();
  });

  const autoBtn = toast.querySelector('.auto-setup-btn');
  if (autoBtn) {
    autoBtn.onclick = () => {
      autoBtn.disabled = true;
      autoBtn.innerHTML = `<svg class="w-3.5 h-3.5 inline animate-spin -mt-px mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2a10 10 0 0 1 10 10"/></svg>Configuring…`;
      autoBtn.className = 'auto-setup-btn flex-1 px-3 py-2 text-xs font-medium bg-slate-700 text-slate-300 rounded-lg cursor-wait';
      send({ type: 'telemetry.autosetup', presetId: preset.presetId });
    };
  }

  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
}

// --- Project context menu ---
let projectMenuCleanup = null;

function resumeDormantSessions(ids, label) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return;
  showToast(`Starting ${uniqueIds.length} dormant session${uniqueIds.length > 1 ? 's' : ''}${label ? ` from ${label}` : ''}…`, { duration: 3000 });
  uniqueIds.forEach((id, index) => {
    setTimeout(() => {
      if (state.resumable.some(s => s.id === id)) send({ type: 'session.resume', id });
    }, index * 1000);
  });
}

function openProjectMenu(projectId, anchorEl) {
  if (projectMenuCleanup) projectMenuCleanup();
  const proj = (state.cfg.projects || []).find(p => p.id === projectId);
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';
  // Count dormant (resumable) sessions in this project
  const dormantIds = state.resumable.filter(s => s.projectId === projectId).map(s => s.id);
  const hasDormant = dormantIds.length > 0;

  menu.innerHTML = `
    <div class="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Color</div>
    <div class="px-3 pb-2 flex gap-1.5">
      ${PROJECT_COLORS.map(c => `
        <button class="color-pick w-5 h-5 rounded-full transition-transform hover:scale-125 ${proj?.color === c ? 'ring-2 ring-white/40 scale-110' : ''}" data-color="${c}" style="background:${c}"></button>
      `).join('')}
    </div>
    <div class="border-t border-slate-700/50 my-1"></div>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="rename">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      Rename
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm ${hasDormant ? 'text-slate-300 hover:bg-slate-700 cursor-pointer' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="start-dormant" ${hasDormant ? '' : 'disabled'}>
      <svg class="w-4 h-4 flex-shrink-0 ${hasDormant ? 'text-slate-400' : 'text-slate-600'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="7 5 19 12 7 19 7 5"/></svg>
      Start all dormant sessions
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm ${hasDormant ? 'text-slate-300 hover:bg-slate-700 cursor-pointer' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="clear-dormant" ${hasDormant ? '' : 'disabled'}>
      <svg class="w-4 h-4 flex-shrink-0 ${hasDormant ? 'text-slate-400' : 'text-slate-600'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
      Clear dormant sessions
    </button>
    <button class="pm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors text-left" data-action="delete">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      Delete project
    </button>`;
  positionMenu(menu, rect);
  const onClick = (e) => {
    // Color pick
    const colorBtn = e.target.closest('.color-pick');
    if (colorBtn && proj) {
      proj.color = colorBtn.dataset.color;
      send({ type: 'config.update', config: state.cfg });
      regroupSessions();
      if (projectMenuCleanup) projectMenuCleanup();
      return;
    }
    const btn = e.target.closest('.pm-action');
    if (!btn) return;
    if (projectMenuCleanup) projectMenuCleanup();
    if (btn.dataset.action === 'rename') {
      startProjectRename(projectId);
      return;
    }
    if (btn.dataset.action === 'start-dormant') {
      const ids = [...document.querySelectorAll(`.project-group[data-project-id="${projectId}"] .project-sessions [data-resumable-id]`)]
        .map(el => el.dataset.resumableId);
      if (!ids.length) return;
      resumeDormantSessions(ids, `"${proj?.name || 'project'}"`);
      return;
    }
    if (btn.dataset.action === 'clear-dormant') {
      const ids = state.resumable.filter(s => s.projectId === projectId).map(s => s.id);
      if (!ids.length) return;
      confirmClose(`Clear ${ids.length} dormant session${ids.length > 1 ? 's' : ''} from "${proj?.name}"?`, 'Clear').then(ok => {
        if (ok) for (const id of ids) send({ type: 'close', id });
      });
      return;
    }
    if (btn.dataset.action === 'delete') {
      const count = [...state.terms.values()].filter(e => e.projectId === projectId).length;
      const msg = count
        ? `Delete project "${proj?.name}"? This will close ${count} active session${count > 1 ? 's' : ''}.`
        : `Delete project "${proj?.name}"?`;
      confirmClose(msg, 'Delete').then(ok => {
        if (ok) send({ type: 'project.delete', id: projectId });
      });
    }
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) { if (projectMenuCleanup) projectMenuCleanup(); } };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));
  projectMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    projectMenuCleanup = null;
  };
}

// --- Previous Sessions menu ---
let prevMenuCleanup = null;
function openPrevSessionsMenu(anchorEl) {
  if (prevMenuCleanup) prevMenuCleanup();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';

  // Clear exactly the dormant sessions currently rendered in "Previous Sessions".
  // This keeps the action aligned with the UI even if a session has a stale projectId
  // that no longer resolves to a real project group.
  const dormantIds = [...document.querySelectorAll('#resumable-section [data-resumable-id]')]
    .map(el => el.dataset.resumableId)
    .filter(Boolean);

  menu.innerHTML = `
    <button class="pv-action flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="clear-dormant">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
      Clear dormant sessions
    </button>`;
  positionMenu(menu, rect);
  const onClick = (e) => {
    const btn = e.target.closest('.pv-action');
    if (!btn) return;
    if (prevMenuCleanup) prevMenuCleanup();
    confirmClose(`Clear ${dormantIds.length} dormant session${dormantIds.length > 1 ? 's' : ''}?`, 'Clear').then(ok => {
      if (ok) for (const id of dormantIds) send({ type: 'close', id });
    });
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) { if (prevMenuCleanup) prevMenuCleanup(); } };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));
  prevMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    prevMenuCleanup = null;
  };
}

// --- Per-row menu on a Previous Sessions entry ---
// Mirrors the active session's three-dot menu (openMenu in terminals.js)
// but limits the actions to the two that make sense for a dormant entry:
// rename (in-place) and delete (with the standard confirm modal).
let resumableRowMenuCleanup = null;
function openResumableRowMenu(resumableId, anchorEl) {
  if (resumableRowMenuCleanup) resumableRowMenuCleanup();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[140px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';
  menu.innerHTML = `
    <button class="rrm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="rename">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      Rename
    </button>
    <button class="rrm-action flex items-center gap-2 w-full px-3 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors text-left" data-action="delete">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      Delete
    </button>`;
  positionMenu(menu, rect);
  const onClick = (e) => {
    const btn = e.target.closest('.rrm-action');
    if (!btn) return;
    if (resumableRowMenuCleanup) resumableRowMenuCleanup();
    if (btn.dataset.action === 'rename') {
      startResumableRename(resumableId);
      return;
    }
    if (btn.dataset.action === 'delete') {
      confirmClose('Delete this previous session?', 'Delete').then(ok => {
        if (ok) send({ type: 'close', id: resumableId });
      });
    }
  };
  const onOutside = (e) => { if (!menu.contains(e.target)) { if (resumableRowMenuCleanup) resumableRowMenuCleanup(); } };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));
  resumableRowMenuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    resumableRowMenuCleanup = null;
  };
}

// --- Project creator ---
const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#84cc16'];
const FOLDER_SVG = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

function closeProjectCreator() {
  document.getElementById('project-creator')?.remove();
}

function openProjectCreator() {
  if (document.getElementById('project-creator')) { closeProjectCreator(); return; }
  // Close session creator if open
  closeCreator();

  const defaultPath = state.cfg.defaultPath || '';

  const card = document.createElement('div');
  card.id = 'project-creator';
  card.className = 'p-3 border-b border-slate-700/50 bg-slate-800/30';
  card.innerHTML = `
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Project folder</div>
    <div class="flex items-center gap-1.5 mb-2">
      <input id="pc-path" type="text" value="${esc(defaultPath)}" placeholder="Project folder path"
        class="flex-1 px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors font-mono">
      <button id="pc-browse" class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors" title="Browse">
        ${FOLDER_SVG}
      </button>
    </div>
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
      Project name <span class="text-slate-600 font-medium normal-case tracking-normal">(auto-filled from folder name)</span>
    </div>
    <input id="pc-name" type="text" maxlength="35" placeholder="Project name"
      class="w-full px-3 py-2 text-sm bg-slate-900 border border-slate-700 rounded-md text-slate-200 placeholder-slate-500 outline-none focus:border-blue-500 transition-colors mb-2">
    <div class="flex items-center gap-2">
      <button id="pc-create" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors">Create</button>
      <button id="pc-cancel" class="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors">Cancel</button>
    </div>`;

  const list = document.getElementById('session-list');
  list.parentElement.insertBefore(card, list);

  const nameInput = card.querySelector('#pc-name');
  const pathInput = card.querySelector('#pc-path');
  pathInput.focus();

  // Auto-fill project name from last folder in path
  const autoFillName = () => {
    const path = pathInput.value.trim();
    if (!path) return;
    const lastFolder = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (lastFolder && !nameInput.dataset.userEdited) {
      nameInput.value = lastFolder;
    }
  };
  pathInput.addEventListener('input', autoFillName);
  pathInput.addEventListener('change', autoFillName);
  nameInput.addEventListener('input', () => { nameInput.dataset.userEdited = '1'; });

  const doCreate = () => {
    const path = pathInput.value.trim();
    const lastFolder = path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    const name = nameInput.value.trim() || lastFolder;
    if (!name) { nameInput.focus(); return; }
    const projects = state.cfg.projects || [];
    projects.push({
      id: crypto.randomUUID(),
      name,
      path: path || undefined,
      color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length],
      collapsed: false,
    });
    state.cfg.projects = projects;
    closeProjectCreator();
    regroupSessions();
    send({ type: 'config.update', config: state.cfg });
  };

  card.querySelector('#pc-create').addEventListener('click', doCreate);
  card.querySelector('#pc-cancel').addEventListener('click', closeProjectCreator);
  card.querySelector('#pc-browse').addEventListener('click', () => {
    openFolderPicker(pathInput.value.trim() || defaultPath, (path) => {
      pathInput.value = path;
      autoFillName();
    });
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') closeProjectCreator();
  });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doCreate();
    if (e.key === 'Escape') closeProjectCreator();
  });
}

// --- Bulk session import ---
// Two-step flow: (1) folder-pick a parent, (2) checklist of subfolders +
// an agent/preset picker. On confirm we send one `create` message per
// checked subfolder, staggered ~1s apart so we don't slam node-pty into
// spawning N PTYs in the same tick (same cadence as resumeDormantSessions
// uses for batch-resume).
//
// Earlier this flow created `cfg.projects` entries; Lance asked for
// sessions instead — each folder becomes a live agent session in its own
// cwd, which is what he actually wants for "pull all my repos into
// clideck".
const BULK_AGENT_KEY = 'clideck.bulkImport.preset';
let bulkImportContext = null;

function openBulkImport() {
  if (bulkImportContext) closeBulkImport();
  openFolderPicker(state.cfg.defaultPath || '', (parentPath) => {
    bulkImportContext = { parentPath };
    send({ type: 'dirs.listSubdirs', path: parentPath });
    // Render an empty modal so the user sees feedback while the server replies.
    renderBulkImportModal({ path: parentPath, entries: null });
  });
}

function closeBulkImport() {
  const el = document.getElementById('bulk-import-modal');
  if (el) el.remove();
  bulkImportContext = null;
}

function handleBulkSubdirsResponse(msg) {
  if (!bulkImportContext) return;
  if (msg.path !== bulkImportContext.parentPath) return;
  renderBulkImportModal(msg);
}

// Which presets are available for "start a session"? Mirrors the logic
// in creator.js's sortedPresets: enabled, not missing, isAgent first then
// shells, most-recently-used floats to the top.
function availableSessionPresets() {
  const all = (state.presets || []).filter(p => {
    const cmd = (state.cfg.commands || []).find(c => c.presetId === p.presetId);
    return !cmd || cmd.enabled !== false;
  });
  const agents = all.filter(p => p.isAgent);
  const shells = all.filter(p => !p.isAgent);
  return [...agents, ...shells];
}

function defaultBulkPresetId() {
  const presets = availableSessionPresets();
  if (!presets.length) return '';
  const stored = localStorage.getItem(BULK_AGENT_KEY);
  if (stored && presets.some(p => p.presetId === stored)) return stored;
  const mru = localStorage.getItem('termui-last-preset'); // creator.js's MRU
  if (mru && presets.some(p => p.presetId === mru)) return mru;
  return presets[0].presetId;
}

// Ensure a cfg.commands entry exists for the given preset and return its
// id. Adapted from creator.js's ensureCommandForPreset — duplicated here
// (a small block) rather than added as an export to avoid widening the
// creator module's API for a single caller.
function ensureCommandIdForPreset(presetId) {
  const preset = (state.presets || []).find(p => p.presetId === presetId);
  if (!preset) return null;
  let cmd = (state.cfg.commands || []).find(c => c.presetId === presetId);
  if (cmd) return cmd.id;
  cmd = {
    id: crypto.randomUUID(),
    presetId: preset.presetId,
    label: preset.name,
    icon: preset.icon,
    command: preset.command,
    enabled: true,
    defaultPath: '',
    isAgent: preset.isAgent,
    canResume: preset.canResume,
    resumeCommand: preset.resumeCommand,
    sessionIdPattern: preset.sessionIdPattern,
    outputMarker: preset.outputMarker || null,
    telemetryEnabled: !!preset.telemetrySetup,
    telemetryStatus: null,
    bridge: preset.bridge,
  };
  state.cfg.commands = [...(state.cfg.commands || []), cmd];
  send({ type: 'config.update', config: state.cfg });
  return cmd.id;
}

function renderBulkImportModal(msg) {
  closeBulkImport(); // wipe the empty placeholder, then rehydrate
  bulkImportContext = { parentPath: msg.path };

  const modal = document.createElement('div');
  modal.id = 'bulk-import-modal';
  modal.className = 'fixed inset-0 z-[500] flex items-center justify-center bg-black/60 backdrop-blur-sm';

  const entries = Array.isArray(msg.entries) ? msg.entries : null;
  const hasEntries = entries && entries.length > 0;
  const presets = availableSessionPresets();
  const selectedPresetId = defaultBulkPresetId();
  const initialSelectableCount = entries
    ? entries.filter(e => sessionsInCwd(e.full).length === 0).length
    : 0;

  modal.innerHTML = `
    <div class="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl shadow-black/60 w-[480px] max-w-[92vw] max-h-[80vh] flex flex-col">
      <div class="px-5 py-4 border-b border-slate-700/60">
        <div class="text-sm font-semibold text-slate-200">Start sessions for these folders</div>
        <div class="text-xs text-slate-500 mt-0.5 truncate" title="${esc(msg.path || '')}">${esc(msg.path || '')}</div>
      </div>
      <div class="px-5 py-3 border-b border-slate-700/40 flex items-center gap-3 ${entries ? '' : 'hidden'}">
        <label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input type="checkbox" id="bi-select-all" class="accent-blue-500" ${hasEntries ? '' : 'disabled'}>
          <span>Select all</span>
        </label>
        <label class="flex items-center gap-2 ml-auto text-xs text-slate-400">
          <span>Agent</span>
          <select id="bi-preset" class="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 outline-none focus:border-blue-500 transition-colors">
            ${presets.map(p => `<option value="${esc(p.presetId)}" ${p.presetId === selectedPresetId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div id="bi-list" class="flex-1 overflow-y-auto tmx-scroll px-2 py-2">
        ${entries === null
          ? `<div class="p-6 text-center text-sm text-slate-500">Loading…</div>`
          : !hasEntries
            ? `<div class="p-6 text-center text-sm text-slate-500">No subfolders found.</div>`
            : entries.map(e => {
                const collisions = sessionsInCwd(e.full);
                const has = collisions.length > 0;
                const kind = has
                  ? collisions.some(c => c.kind === 'active') ? 'session running' : 'previous session'
                  : '';
                const titleAttr = has
                  ? `${e.full} — ${collisions.map(c => c.name).join(', ')} (${kind})`
                  : e.full;
                return `
                <label class="flex items-center gap-2.5 px-3 py-1.5 rounded hover:bg-slate-700/40 cursor-pointer ${has ? 'opacity-60' : ''}">
                  <input type="checkbox" class="bi-row accent-blue-500" data-name="${esc(e.name)}" data-full="${esc(e.full)}" data-collides="${has ? '1' : ''}" ${has ? '' : 'checked'}>
                  <span class="flex-1 text-sm ${has ? 'text-slate-400' : 'text-slate-200'} truncate" title="${esc(titleAttr)}">${esc(e.name)}</span>
                  ${has ? `<span class="text-[10px] uppercase tracking-wider text-amber-400/80 flex-shrink-0">${esc(kind)}</span>` : ''}
                </label>`;
              }).join('')}
      </div>
      <div class="px-5 py-3 border-t border-slate-700/60 flex items-center gap-2">
        <span id="bi-count" class="text-[11px] text-slate-500">${initialSelectableCount ? `${initialSelectableCount} selected` : ''}</span>
        <button id="bi-cancel" class="ml-auto px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">Cancel</button>
        <button id="bi-ok" class="px-4 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed" ${initialSelectableCount ? '' : 'disabled'}>Start sessions</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const updateCount = () => {
    const n = modal.querySelectorAll('.bi-row:checked').length;
    modal.querySelector('#bi-ok').disabled = n === 0;
    const countEl = modal.querySelector('#bi-count');
    if (countEl) countEl.textContent = n ? `${n} selected` : '';
  };

  modal.querySelector('#bi-cancel').addEventListener('click', closeBulkImport);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeBulkImport(); });
  const selectAll = modal.querySelector('#bi-select-all');
  const syncMaster = () => {
    if (!selectAll) return;
    const rows = modal.querySelectorAll('.bi-row');
    if (rows.length === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      return;
    }
    const checked = modal.querySelectorAll('.bi-row:checked').length;
    selectAll.checked = checked === rows.length;
    selectAll.indeterminate = checked > 0 && checked < rows.length;
  };
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      // Browser clears indeterminate on user click, but be explicit so the
      // post-click state matches what syncMaster would compute.
      selectAll.indeterminate = false;
      for (const cb of modal.querySelectorAll('.bi-row')) cb.checked = selectAll.checked;
      updateCount();
    });
  }
  for (const cb of modal.querySelectorAll('.bi-row')) {
    cb.addEventListener('change', () => { updateCount(); syncMaster(); });
  }
  syncMaster();

  modal.querySelector('#bi-ok').addEventListener('click', async () => {
    const picked = [...modal.querySelectorAll('.bi-row:checked')].map(cb => ({
      name: cb.dataset.name,
      full: cb.dataset.full,
      collides: cb.dataset.collides === '1',
    }));
    if (!picked.length) { closeBulkImport(); return; }
    const overrides = picked.filter(p => p.collides);
    if (overrides.length) {
      const ok = await confirmClose(
        `${overrides.length} of these folder${overrides.length > 1 ? 's already have' : ' already has'} a session (active or previous). Start additional sessions in ${overrides.length > 1 ? 'them' : 'it'} anyway?`,
        'Start anyway',
      );
      if (!ok) return;
    }
    const presetSel = modal.querySelector('#bi-preset');
    const presetId = presetSel?.value || defaultBulkPresetId();
    const commandId = ensureCommandIdForPreset(presetId);
    if (!commandId) {
      showToast('Could not resolve agent for bulk import.', { type: 'error' });
      return;
    }
    localStorage.setItem(BULK_AGENT_KEY, presetId);
    showToast(`Starting ${picked.length} session${picked.length > 1 ? 's' : ''}…`, { duration: 3000 });
    // Stagger 1s/session to keep node-pty + agent boot orderly. Same pattern
    // as resumeDormantSessions; on a fast machine this still drains quickly.
    picked.forEach((p, i) => {
      setTimeout(() => {
        send({ type: 'create', commandId, name: p.name, cwd: p.full, ...estimateSize() });
      }, i * 1000);
    });
    closeBulkImport();
  });
}

document.getElementById('btn-theme-toggle').addEventListener('click', toggleMode);

// --- Plugin system (frontend) ---

const pluginMessageHandlers = new Map();
const loadedPlugins = new Set();

function dispatchPluginMessage(msg) {
  const fn = pluginMessageHandlers.get(msg.type);
  if (fn) {
    try { fn(msg); }
    catch (e) { console.error(`[plugin] client handler error for ${msg.type}:`, e); }
  }
}

function addPluginToolbarButton(pluginId, opts) {
  const toolbar = document.getElementById('plugin-toolbar');
  const btn = document.createElement('button');
  btn.className = 'plugin-btn w-8 h-8 flex items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors backdrop-blur-sm';
  btn.title = opts.title || '';
  btn.innerHTML = opts.icon || '';
  btn.dataset.pluginId = pluginId;
  if (opts.id) btn.dataset.actionId = opts.id;
  btn.addEventListener('click', () => {
    if (typeof opts.onClick === 'function') opts.onClick();
  });
  toolbar.appendChild(btn);
  return btn;
}

function getPluginExpanded() {
  try { return JSON.parse(localStorage.getItem('clideck.pluginsExpanded') || '{}'); } catch { return {}; }
}
function setPluginExpanded(id, open) {
  const map = getPluginExpanded();
  if (open) map[id] = true; else delete map[id];
  localStorage.setItem('clideck.pluginsExpanded', JSON.stringify(map));
}

function renderPluginsPanel(list) {
  const container = document.getElementById('plugins-list');
  if (!list.length) {
    container.innerHTML = `<div class="flex flex-col items-center justify-center h-full px-6 text-center">
      <p class="text-sm text-slate-400 mb-1">No plugins installed</p>
      <p class="text-xs text-slate-600 leading-relaxed">Plugins live in <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">${esc(state.cfg.pluginsDir || '~/.clideck/plugins')}</code><br>Each one is a folder with a <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">clideck-plugin.json</code> and <code class="px-1 py-0.5 rounded bg-slate-800 text-slate-400 text-[11px]">index.js</code></p>
    </div>`;
    return;
  }
  const expanded = getPluginExpanded();
  const trashSvg = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`;
  const defaultIcon = `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2m6.36 1.64l-1.42 1.42M21 12h-2M17.94 17.94l-1.42-1.42M12 19v2M6.06 17.94l1.42-1.42M3 12h2M6.06 6.06l1.42 1.42"/><circle cx="12" cy="12" r="4"/></svg>`;

  container.innerHTML = list.map((p, i) => {
    const open = !!expanded[p.id];
    const icon = p.icon || defaultIcon;
    const deleteBtn = p.bundled ? '' : `<div class="plugin-delete flex items-center justify-center w-6 h-6 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700/50 cursor-pointer transition-colors flex-shrink-0" data-plugin-id="${esc(p.id)}" data-plugin-name="${esc(p.name)}" title="Remove plugin">${trashSvg}</div>`;
    const hasFooter = p.author || !p.bundled;

    if (!p.installed) {
      return `
      <div class="plugin-card ${i > 0 ? 'border-t border-slate-700/50' : ''}">
        <div class="px-4 py-3">
          <div class="flex items-center gap-2">
            <span class="text-slate-500 flex-shrink-0">${icon}</span>
            <span class="flex-1 text-sm font-medium text-slate-400 truncate">${esc(p.name)}</span>
            <span class="text-[10px] text-slate-600 flex-shrink-0">v${esc(p.version)}</span>
            <button class="plugin-install-btn px-2.5 py-1 text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors flex-shrink-0" data-plugin-id="${esc(p.id)}">Install</button>
          </div>
          ${p.description ? `<p class="text-[11px] text-slate-600 mt-0.5 leading-snug">${esc(p.description)}</p>` : ''}
        </div>
      </div>`;
    }

    return `
    <div class="plugin-card ${i > 0 ? 'border-t border-slate-700/50' : ''}">
      <div class="plugin-toggle px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer" data-plugin-id="${esc(p.id)}">
        <div class="flex items-center gap-2">
          <span class="text-slate-400 flex-shrink-0">${icon}</span>
          <span class="flex-1 text-sm font-medium text-slate-200 truncate">${esc(p.name)}</span>
          <span class="text-[10px] text-slate-500 flex-shrink-0">v${esc(p.version)}</span>
          <svg class="plugin-chevron w-4 h-4 text-slate-500 transition-transform duration-200 flex-shrink-0 ${open ? '' : 'collapsed'}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>
        </div>
        ${p.description ? `<p class="text-[11px] text-slate-500 mt-0.5 leading-snug">${esc(p.description)}</p>` : ''}
        ${hasFooter ? `<div class="flex items-center justify-end gap-2 mt-1">${p.author ? `<span class="text-[10px] text-slate-600">${esc(p.author)}</span>` : ''}${deleteBtn}</div>` : ''}
      </div>
      <div class="plugin-body ${open ? '' : 'hidden'}">
        <div class="px-4 pb-3">
          ${(p.settings || []).map(s => renderSettingField(p.id, s, p.settingValues[s.key] ?? s.default, p.dynamicOptions)).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.plugin-toggle').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.plugin-delete')) return;
      const id = el.dataset.pluginId;
      const card = el.closest('.plugin-card');
      const body = card.querySelector('.plugin-body');
      const chevron = card.querySelector('.plugin-chevron');
      if (!body) return;
      const nowHidden = body.classList.toggle('hidden');
      chevron.classList.toggle('collapsed', nowHidden);
      setPluginExpanded(id, !nowHidden);
    });
  });

  container.querySelectorAll('.plugin-delete').forEach(el => {
    el.addEventListener('click', async () => {
      const pluginId = el.dataset.pluginId;
      const name = el.dataset.pluginName;
      const ok = await confirmClose(`Remove plugin "${name}"? Its folder will be permanently deleted.`, 'Remove');
      if (ok) send({ type: 'plugin.delete', pluginId });
    });
  });

  container.querySelectorAll('.plugin-install-btn').forEach(el => {
    el.addEventListener('click', () => {
      el.disabled = true;
      el.textContent = 'Installing...';
      el.className = el.className.replace('bg-blue-600 hover:bg-blue-500', 'bg-slate-700 cursor-wait');
      send({ type: 'plugin.install', pluginId: el.dataset.pluginId });
    });
  });

  container.querySelectorAll('[data-setting]').forEach(el => {
    const pluginId = el.dataset.plugin;
    const key = el.dataset.setting;
    const onChange = (value) => send({ type: 'plugin.settings.update', pluginId, key, value });
    if (el.type === 'checkbox') el.addEventListener('change', () => onChange(el.checked));
    else if (el.tagName === 'SELECT') el.addEventListener('change', () => onChange(el.value));
    else if (el.type === 'number') el.addEventListener('change', () => onChange(Number(el.value)));
    else el.addEventListener('change', () => onChange(el.value));
  });
}

function renderSettingField(pluginId, setting, value, dynamicOptions) {
  const id = `ps-${pluginId}-${setting.key}`;
  const attrs = `data-plugin="${esc(pluginId)}" data-setting="${esc(setting.key)}"`;
  const label = esc(setting.label || setting.key);
  const desc = setting.description ? `<p class="text-[11px] text-slate-600 mt-0.5">${esc(setting.description)}</p>` : '';

  if (setting.type === 'toggle') {
    return `<label class="flex items-center gap-2 mt-2 cursor-pointer">
      <input type="checkbox" id="${id}" ${attrs} ${value ? 'checked' : ''} class="accent-blue-500">
      <span class="text-xs text-slate-400">${label}</span>
    </label>${desc}`;
  }
  if (setting.type === 'select' || setting.type === 'dynamic-select') {
    const source = setting.type === 'dynamic-select' ? (dynamicOptions?.[setting.key] || []) : (setting.options || []);
    let opts = source.map(o => {
      const optVal = typeof o === 'object' ? o.value : o;
      const optLabel = typeof o === 'object' ? o.label : o;
      return `<option value="${esc(String(optVal))}" ${String(value) === String(optVal) ? 'selected' : ''}>${esc(String(optLabel))}</option>`;
    }).join('');
    // Dynamic-select with no options yet: show the saved value so the control isn't blank
    if (setting.type === 'dynamic-select' && !source.length && value) {
      opts = `<option value="${esc(String(value))}" selected>${esc(String(value))}</option>`;
    }
    return `<div class="mt-2">
      <label class="block text-xs text-slate-400 mb-1">${label}</label>
      <select id="${id}" ${attrs} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 outline-none focus:border-blue-500 transition-colors">${opts}</select>
      ${desc}
    </div>`;
  }
  if (setting.type === 'number') {
    const min = setting.min != null ? `min="${setting.min}"` : '';
    const max = setting.max != null ? `max="${setting.max}"` : '';
    return `<div class="mt-2">
      <label class="block text-xs text-slate-400 mb-1">${label}</label>
      <input type="number" id="${id}" ${attrs} value="${value ?? ''}" ${min} ${max} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 outline-none focus:border-blue-500 transition-colors">
      ${desc}
    </div>`;
  }
  // Default: text
  return `<div class="mt-2">
    <label class="block text-xs text-slate-400 mb-1">${label}</label>
    <input type="text" id="${id}" ${attrs} value="${esc(String(value ?? ''))}" ${setting.placeholder ? `placeholder="${esc(setting.placeholder)}"` : ''} class="w-full px-2 py-1.5 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-200 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors">
    ${desc}
  </div>`;
}

async function loadPlugins(list) {
  const activeIds = new Set(list.map(p => p.id));

  // Clean up removed plugins: hotkeys, toolbar buttons, message handlers
  for (const id of loadedPlugins) {
    if (!activeIds.has(id)) {
      unregisterAllForPlugin(id);
      for (const [key] of pluginMessageHandlers) {
        if (key.startsWith(`plugin.${id}.`)) pluginMessageHandlers.delete(key);
      }
      loadedPlugins.delete(id);
    }
  }

  renderPluginsPanel(list);

  // Store project-header actions from plugins (used by regroupSessions to render icons)
  state.projectActions = [];
  for (const plugin of list) {
    for (const action of plugin.actions || []) {
      if (action.slot === 'project-header') state.projectActions.push({ ...action, pluginId: plugin.id });
    }
  }
  renderProjectActions();

  // Render server-registered toolbar actions — also clears stale client toolbar buttons
  const toolbar = document.getElementById('plugin-toolbar');
  toolbar.querySelectorAll('.plugin-btn').forEach(b => {
    if (!activeIds.has(b.dataset.pluginId)) b.remove();
  });
  toolbar.querySelectorAll('.plugin-btn[data-server]').forEach(b => b.remove());
  for (const plugin of list) {
    for (const action of plugin.actions || []) {
      if (action.slot !== 'toolbar') continue;
      const btn = document.createElement('button');
      btn.className = 'plugin-btn w-8 h-8 flex items-center justify-center rounded-lg bg-slate-800/80 border border-slate-700/50 text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors backdrop-blur-sm';
      btn.title = action.title || '';
      btn.innerHTML = action.icon || '';
      btn.dataset.pluginId = plugin.id;
      btn.dataset.server = '1';
      btn.addEventListener('click', () => {
        send({ type: `plugin.${plugin.id}.${action.id}`, action: action.id });
      });
      toolbar.appendChild(btn);
    }
  }

  // Load client-side plugins
  for (const plugin of list) {
    if (!plugin.hasClient || loadedPlugins.has(plugin.id)) continue;
    loadedPlugins.add(plugin.id);
    try {
      const mod = await import(`/plugins/${plugin.id}/client.js`);
      if (typeof mod.init === 'function') {
        mod.init({
          pluginId: plugin.id,
          send(event, data = {}) { send({ ...data, type: `plugin.${plugin.id}.${event}` }); },
          onMessage(event, fn) { pluginMessageHandlers.set(`plugin.${plugin.id}.${event}`, fn); },
          addToolbarButton(opts) { return addPluginToolbarButton(plugin.id, opts); },
          getActiveSessionId() { return state.active; },
          getTerminalSelection() { const e = state.terms.get(state.active); return e ? e.term.getSelection() : ''; },
          writeToSession(id, text) { send({ type: 'input', id, data: text }); },
          toast(message, opts) { return showToast(message, opts); },
          registerHotkey(combo, callback) { return registerHotkey(plugin.id, combo, callback); },
          unregisterHotkey(combo) { unregisterHotkey(plugin.id, combo); },
        });
      }
    } catch (e) { console.error(`[plugin:${plugin.id}] client load failed:`, e); }
  }
}

// Render plugin-registered project header action buttons into all project groups
function renderProjectActions() {
  const actions = state.projectActions || [];
  for (const slot of document.querySelectorAll('.project-plugin-actions')) {
    slot.innerHTML = '';
    const projId = slot.closest('.project-header')?.dataset.projectId;
    if (!projId) continue;
    for (const action of actions) {
      const btn = document.createElement('button');
      btn.className = 'project-plugin-action plugin-project-btn text-slate-600 hover:text-indigo-400 flex-shrink-0 p-0.5';
      btn.title = action.title || '';
      btn.innerHTML = action.icon || '';
      btn.dataset.pluginId = action.pluginId;
      btn.dataset.actionId = action.id;
      btn.dataset.projectId = projId;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: `plugin.${action.pluginId}.${action.id}`, action: action.id, projectId: projId });
      });
      slot.appendChild(btn);
    }
  }
}

let saveTimer = null;
function flashSaveIndicator() {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  clearTimeout(saveTimer);
  el.classList.add('saving');
  el.classList.remove('saved');
  saveTimer = setTimeout(() => {
    el.classList.remove('saving');
    el.classList.add('saved');
    saveTimer = setTimeout(() => el.classList.remove('saved'), 4000);
  }, 1500);
}

function initSessionScrollbarVisibility() {
  const el = document.getElementById('session-list');
  if (!el) return;
  let t;
  el.addEventListener('scroll', () => {
    el.classList.add('is-scrolling');
    clearTimeout(t);
    t = setTimeout(() => el.classList.remove('is-scrolling'), 220);
  }, { passive: true });
}

// --- Remote (thin connector to clideck-remote CLI) ---

const remoteModal = document.getElementById('remote-modal');
const remotePanes = {
  intro: document.getElementById('remote-intro'),
  installing: document.getElementById('remote-installing'),
  connecting: document.getElementById('remote-connecting'),
  qr: document.getElementById('remote-qr'),
  active: document.getElementById('remote-active'),
  error: document.getElementById('remote-error'),
};
const btnRemote = document.getElementById('btn-remote');

let remoteInstalled = false;
let remoteState = 'idle'; // idle | connecting | waiting | paired
let remoteModalOpen = false;
let remoteStatusPoll = null;
let remoteConnectedAt = null;
let remoteStatsTimer = null;
let remoteUpdateInfo = null;
let remotePreflight = null;
let remoteLastStatus = null;

function startRemotePoll() {
  stopRemotePoll();
  remoteStatusPoll = setInterval(() => {
    if (remoteState === 'waiting' || remoteState === 'paired') send({ type: 'remote.status' });
    else stopRemotePoll();
  }, 3000);
}

function stopRemotePoll() {
  if (remoteStatusPoll) { clearInterval(remoteStatusPoll); remoteStatusPoll = null; }
}

function setRemotePane(pane) {
  for (const [k, el] of Object.entries(remotePanes)) {
    el.classList.toggle('hidden', k !== pane);
  }
}

function showRemoteIntro(opts = {}) {
  const title = document.getElementById('remote-intro-title');
  const text = document.getElementById('remote-intro-text');
  const foot = document.getElementById('remote-intro-foot');
  const btn = document.getElementById('remote-add');
  title.textContent = opts.title || 'CliDeck Mobile Remote';
  text.textContent = opts.text || 'Control your AI agents from your phone. See live status, send messages, and get notifications — all end-to-end encrypted.';
  foot.innerHTML = opts.foot || 'Installs the <code class="text-slate-500">clideck-remote</code> package via npm';
  btn.textContent = opts.button || 'Add to CliDeck';
  setRemotePane('intro');
}

function showRemoteUpdateRequired() {
  showRemoteIntro({
    title: 'Update Required',
    text: `Version ${remoteUpdateInfo.latest} is available. Update CliDeck Remote to continue with mobile pairing on this machine.`,
    foot: `Installed: <code class="text-slate-500">${esc(remoteUpdateInfo.installed)}</code> · Latest: <code class="text-slate-500">${esc(remoteUpdateInfo.latest)}</code>`,
    button: 'Update to Continue',
  });
}

function finishRemotePreflight() {
  if (!remotePreflight?.pending || !remotePreflight.statusSeen || !remotePreflight.updateSeen) return;
  remotePreflight = null;
  if (!remoteInstalled) {
    showRemoteIntro();
    return;
  }
  if (remoteUpdateInfo?.available) {
    showRemoteUpdateRequired();
    return;
  }
  if (remoteState === 'idle') {
    remoteState = 'connecting';
    setRemotePane('connecting');
    send({ type: 'remote.pair' });
    return;
  }
  if (remoteState === 'paired' && remoteLastStatus?.paired) {
    setRemotePane('active');
    setRemoteLock(true);
    startRemoteStats(remoteLastStatus.pairedAt);
    const deviceEl = document.getElementById('remote-device-info');
    if (deviceEl) {
      const parts = [remoteLastStatus.deviceName, remoteLastStatus.location].filter(Boolean);
      deviceEl.textContent = parts.length ? parts.join(' · ') : '';
    }
    return;
  }
  if (remoteState === 'waiting' && remoteLastStatus?.connected && remoteLastStatus?.url) {
    document.getElementById('remote-url-box').textContent = remoteLastStatus.url;
    const qrImg = document.getElementById('remote-qr-img');
    if (remoteLastStatus.qr && remoteLastStatus.qr.startsWith('data:')) { qrImg.src = remoteLastStatus.qr; qrImg.classList.remove('hidden'); }
    else qrImg.classList.add('hidden');
    setRemotePane('qr');
    return;
  }
  setRemotePane(remoteState === 'paired' ? 'active' : remoteState === 'waiting' ? 'qr' : 'connecting');
}

function openRemoteModal() {
  remoteModalOpen = true;
  remoteModal.classList.remove('hidden');
  remoteModal.style.display = 'flex';
}

function closeRemoteModal() {
  if (remoteState === 'paired') return; // can't dismiss while connected
  remoteModalOpen = false;
  remoteModal.classList.add('hidden');
  remoteModal.style.display = '';
  setRemoteLock(false);
}

let remoteLocked = false;

function remoteLockKeyTrap(e) {
  // Only allow Tab within the modal and the Disconnect button
  const modal = document.getElementById('remote-modal');
  if (modal && modal.contains(e.target)) return;
  e.stopPropagation();
  e.preventDefault();
}

function setRemoteLock(locked) {
  remoteLocked = locked;
  const modal = document.getElementById('remote-modal');
  const closeBtn = document.getElementById('remote-close');
  if (locked) {
    modal.style.backdropFilter = 'blur(24px)';
    modal.style.webkitBackdropFilter = 'blur(24px)';
    modal.style.background = 'rgba(0,0,0,0.75)';
    closeBtn.classList.add('hidden');
    // Blur any focused terminal/element and trap keyboard
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    window.addEventListener('keydown', remoteLockKeyTrap, true);
    window.addEventListener('keypress', remoteLockKeyTrap, true);
    window.addEventListener('keyup', remoteLockKeyTrap, true);
    // Focus the disconnect button so keyboard focus is inside the modal
    const disconnectBtn = document.getElementById('remote-disconnect2');
    if (disconnectBtn) disconnectBtn.focus();
  } else {
    modal.style.backdropFilter = '';
    modal.style.webkitBackdropFilter = '';
    modal.style.background = '';
    closeBtn.classList.remove('hidden');
    window.removeEventListener('keydown', remoteLockKeyTrap, true);
    window.removeEventListener('keypress', remoteLockKeyTrap, true);
    window.removeEventListener('keyup', remoteLockKeyTrap, true);
  }
}

function startRemoteStats(pairedAt) {
  if (remoteStatsTimer) { clearInterval(remoteStatsTimer); remoteStatsTimer = null; }
  remoteConnectedAt = pairedAt || Date.now();
  updateRemoteStats();
  remoteStatsTimer = setInterval(updateRemoteStats, 1000);
}

function stopRemoteStats() {
  if (remoteStatsTimer) { clearInterval(remoteStatsTimer); remoteStatsTimer = null; }
  remoteConnectedAt = null;
}

function updateRemoteStats() {
  if (!remoteConnectedAt) return;
  const elapsed = Math.floor((Date.now() - remoteConnectedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  const h = Math.floor(m / 60);
  const timeStr = h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  const el = document.getElementById('remote-stat-time');
  if (el) el.textContent = timeStr;
  const sessEl = document.getElementById('remote-stat-sessions');
  if (sessEl) sessEl.textContent = document.querySelectorAll('.group[data-id]').length || '0';
}

function updateRemoteButton() {
  btnRemote.classList.toggle('text-blue-400', remoteState === 'waiting');
  btnRemote.classList.toggle('text-emerald-400', remoteState === 'paired');
  if (remoteState === 'idle' || remoteState === 'connecting') {
    btnRemote.classList.remove('text-blue-400', 'text-emerald-400');
  }
}

function handleRemoteStatus(msg) {
  remoteLastStatus = msg;
  remoteInstalled = !!msg.installed;
  state.remoteVersion = msg.version || (msg.installed ? null : 'not installed');
  updateVersionFooter();
  const wasPaired = remoteState === 'paired';
  const preflighting = !!remotePreflight?.pending;
  if (!msg.installed) {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  } else if (msg.paired) {
    const wasFresh = remoteState !== 'paired';
    remoteState = 'paired';
    if (!remoteStatusPoll) startRemotePoll();
    if (wasFresh && !preflighting) {

      setRemotePane('active');
      setRemoteLock(true);
      startRemoteStats(msg.pairedAt);
      if (!remoteModalOpen) openRemoteModal();
    }
    const deviceEl = document.getElementById('remote-device-info');
    if (deviceEl) {
      const parts = [msg.deviceName, msg.location].filter(Boolean);
      deviceEl.textContent = parts.length ? parts.join(' \u00b7 ') : '';
    }
  } else if (msg.connected && msg.url) {
    remoteState = 'waiting';
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
    document.getElementById('remote-url-box').textContent = msg.url;
    const qrImg = document.getElementById('remote-qr-img');
    if (msg.qr && msg.qr.startsWith('data:')) { qrImg.src = msg.qr; qrImg.classList.remove('hidden'); }
    else qrImg.classList.add('hidden');
    startRemotePoll();
    if (!preflighting && remoteModalOpen) setRemotePane('qr');
  } else {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  }
  if (remoteUpdateInfo?.available && remoteModalOpen) {
    showRemoteUpdateRequired();
  }
  updateRemoteButton();
  if (remotePreflight?.pending) {
    remotePreflight.statusSeen = true;
    finishRemotePreflight();
  }
}

function handleRemotePaired(msg) {
  remoteInstalled = true;
  remoteState = 'waiting';
  document.getElementById('remote-url-box').textContent = msg.url || '';
  const qrImg = document.getElementById('remote-qr-img');
  if (msg.qr && msg.qr.startsWith('data:')) { qrImg.src = msg.qr; qrImg.classList.remove('hidden'); }
  else qrImg.classList.add('hidden');
  updateRemoteButton();
  startRemotePoll();
  if (remoteUpdateInfo?.available && remoteModalOpen) {
    showRemoteUpdateRequired();
    return;
  }
  if (remotePreflight?.pending) {
    remotePreflight.statusSeen = true;
    finishRemotePreflight();
    return;
  }
  setRemotePane('qr');
}

function handleRemoteUnpaired() {
  remoteState = 'idle';
  stopRemotePoll();
  stopRemoteStats();
  setRemoteLock(false);
  closeRemoteModal();
  updateRemoteButton();
}

function handleRemoteError(error) {
  document.getElementById('remote-error-text').textContent = error || 'Unknown error';
  setRemotePane('error');
  remoteState = 'idle';
  stopRemotePoll();
  updateRemoteButton();
}

function appendInstallLog(text) {
  const log = document.getElementById('remote-install-log');
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
}

function handleInstallDone(success) {
  if (success) {
    remoteInstalled = true;
    remoteUpdateInfo = null;
    // Installed — go straight to pairing
    remoteState = 'connecting';
    setRemotePane('connecting');
    send({ type: 'remote.pair' });
  } else {
    const log = document.getElementById('remote-install-log');
    log.textContent += '\n— Install failed. Check permissions or run manually:\n  npm install -g clideck-remote\n';
    log.scrollTop = log.scrollHeight;
  }
}

// Button click
btnRemote.addEventListener('click', () => {
  if (remoteModalOpen && remoteState !== 'paired') { closeRemoteModal(); return; }
  if (remoteModalOpen) return; // paired — can't dismiss
  if (!remoteInstalled) {
    showRemoteIntro();
    document.getElementById('remote-install-log').textContent = '';
    openRemoteModal();
    return;
  }
  remotePreflight = { pending: true, statusSeen: false, updateSeen: false };
  setRemotePane('connecting');
  openRemoteModal();
  send({ type: 'remote.status' });
});

// Install button
document.getElementById('remote-add').addEventListener('click', () => {
  document.getElementById('remote-install-log').textContent = '';
  setRemotePane('installing');
  send({ type: 'remote.install' });
});

// Close / disconnect
document.getElementById('remote-close').addEventListener('click', closeRemoteModal);
document.getElementById('remote-error-dismiss').addEventListener('click', closeRemoteModal);

document.getElementById('remote-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('remote-url-box').textContent).then(() => {
    const btn = document.getElementById('remote-copy');
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = 'copy the link'; }, 1500);
  });
});
document.getElementById('remote-url-box').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('remote-url-box').textContent);
});

function doRemoteDisconnect() {
  send({ type: 'remote.unpair' });
}
document.getElementById('remote-disconnect').addEventListener('click', doRemoteDisconnect);
document.getElementById('remote-disconnect2').addEventListener('click', doRemoteDisconnect);

// ── Font-size keyboard shortcuts (Phase 9 — terminal display sizing) ──
//
// D-01: Ctrl/Cmd + = / + / - / 0 adjust the terminal font-size when a
// terminal is focused. D-04 (named risk): MUST NOT hijack browser zoom
// in any other context — Settings inputs, sidebar search, agent name
// fields, prompt editors, contenteditable cells, etc.
//
// Guard order is load-bearing:
//   1. Cheap key-match first (skip 99.9% of keystrokes immediately).
//   2. Reject if any "other" modifier is held (Alt with anything but
//      the bare +/-/0 keys; Shift on a non-`+` key — `+` ITSELF is
//      shift+`=` on US layouts so we accept it on the `+` path).
//   3. Compute isTerminalFocused:
//        - activeElement must NOT be input/textarea/select/contenteditable;
//        - the Settings overlay must be hidden (the overlay can capture
//          focus globally — even when activeElement is something benign
//          like a card div, we don't want Ctrl+= to steal browser zoom
//          while Settings is on screen);
//        - activeElement must have an ancestor `.term-wrap.active` —
//          the xterm helper element that gains `.active` in terminals.js
//          select() when a terminal becomes the focused one.
//   4. ONLY THEN preventDefault. Reaching this line means the user is
//      genuinely inside a terminal and the keystroke would otherwise
//      browser-zoom the page; D-04 says we own it.
//
// Listener is on document, bubble phase. Capture phase would intercept
// before any input got a chance to ignore the modifier — that's wrong;
// we want the input to keep its native browser-zoom behaviour.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key;
  const isPlus = key === '=' || key === '+';
  const isMinus = key === '-';
  const isZero = key === '0';
  if (!isPlus && !isMinus && !isZero) return;
  // Alt + ctrl + key — different OS-level binding, don't steal it.
  if (e.altKey) return;

  // Settings overlay open? Hand the keystroke back to the browser
  // (zoom). The user is in a settings context, not a terminal one.
  const overlay = document.getElementById('settings-overlay');
  if (overlay && !overlay.classList.contains('hidden')) return;

  const active = document.activeElement;
  if (!active) return;

  // Terminal-focus check FIRST. xterm.js routes all keystrokes through
  // an invisible textarea (.xterm-helper-textarea) which IS a child of
  // the active .term-wrap. We must accept this textarea (it IS the
  // focused terminal), so the term-wrap.active ancestor check runs
  // before the generic textarea reject below.
  const inActiveTerm = !!active.closest('.term-wrap.active');

  if (!inActiveTerm) {
    // Not in a terminal. Now apply the "this looks like a real text
    // input — let the browser zoom" guard. (Inside an active terminal
    // we accept TEXTAREA because xterm uses one as its key proxy.)
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (active.isContentEditable) return;
    // Nothing focused & not in a terminal — let browser handle (zoom).
    return;
  }

  e.preventDefault();
  if (isZero) setFontSize(FONT_SIZE_DEFAULT);
  else if (isPlus) setFontSize((state.cfg.terminalFontSize ?? FONT_SIZE_DEFAULT) + 1);
  else if (isMinus) setFontSize((state.cfg.terminalFontSize ?? FONT_SIZE_DEFAULT) - 1);
});

initDrag();
initSidebarResize();
initSessionScrollbarVisibility();
connect();

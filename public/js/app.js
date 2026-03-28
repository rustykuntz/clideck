import { state, send } from './state.js';
import { esc, binName } from './utils.js';
import { addTerminal, removeTerminal, select, startRename, startProjectRename, setSessionTheme, openMenu, closeMenu, setStatus, updateMuteIndicator, updatePreview, markUnread, applyFilter, setTab, renderResumable, regroupSessions, toggleProjectCollapse, setSessionProject, estimateSize, restartComplete, positionMenu, addPill, updatePill, removePill, appendPillLog, setPillLogs, closePillLog } from './terminals.js';
import { renderSettings, updateVersionFooter } from './settings.js';
import { openCreator, closeCreator, refreshCreator } from './creator.js';
import { handleDirsResponse, openFolderPicker } from './folder-picker.js';
import { confirmClose } from './confirm.js';
import { applyTheme } from './profiles.js';
import { toggleMode, applyMode } from './color-mode.js';
import { showToast } from './toast.js';
import './nav.js';
import { initDrag, wasDragging } from './drag.js';
import { registerHotkey, unregisterHotkey, unregisterAllForPlugin } from './hotkeys.js';
import { renderPrompts } from './prompts.js';
import { renderRoles } from './roles.js';

function connect() {
  state.ws = new WebSocket(`ws://${location.host}`);

  state.ws.onopen = () => {
    for (const [, e] of state.terms) { e.ro.disconnect(); e.term.dispose(); e.el.remove(); }
    state.terms.clear();
    state.pills.clear();
    state.activePill = null;
    document.getElementById('session-list').innerHTML = '';
    document.getElementById('pill-log-panel')?.remove();
    state.active = null;
    document.getElementById('empty').style.display = 'flex';
    send({ type: 'remote.status' });
  };

  state.ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'config':
        state.cfg = msg.config;
        applyMode(state.cfg.colorMode || 'dark');
        regroupSessions();
        renderSettings();
        renderPrompts();
        renderRoles();
        for (const [, entry] of state.terms) applyTheme(entry.term, entry.themeId);
        break;
      case 'themes':
        state.themes = msg.themes;
        renderSettings();
        break;
      case 'presets':
        state.presets = msg.presets;
        renderSettings();
        refreshCreator();
        break;
      case 'sessions.resumable':
        state.resumable = msg.list;
        renderResumable();
        break;
      case 'sessions':
        msg.list.forEach(s => addTerminal(s.id, s.name, s.themeId, s.commandId, s.projectId, s.muted, s.lastPreview));
        if (msg.list.length) select(msg.list[0].id);
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.themeId, msg.commandId, msg.projectId, msg.muted, msg.lastPreview);
        select(msg.id);
        applyFilter();
        closeMobileSidebar();
        break;
      case 'output': {
        const entry = state.terms.get(msg.id);
        if (entry && !entry.queue(msg.data)) entry.term.write(msg.data);
        updatePreview(msg.id);
        markUnread(msg.id);
        break;
      }
      case 'closed':
        removeTerminal(msg.id);
        break;
      case 'session.restarted':
        console.log('[restart] got session.restarted from server', msg);
        restartComplete(msg.id, msg);
        break;
      // Telemetry/bridge working/idle
      case 'session.status':
        setStatus(msg.id, msg.working);
        break;
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
          const sid = toast.dataset.sessionId;
          const cmdId = toast.dataset.commandId;
          actionsEl.innerHTML = `
            <div class="flex-1 flex items-center gap-1.5 text-xs text-emerald-400">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M5 13l4 4L19 7"/></svg>
              Configured
            </div>
            <button class="restart-btn px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Restart Session</button>
            <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Dismiss</button>`;
          actionsEl.querySelector('.dismiss-btn').onclick = () => toast.remove();
          actionsEl.querySelector('.restart-btn').onclick = () => {
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
      case 'sessions.saved':
        flashSaveIndicator();
        break;
      case 'plugins':
        loadPlugins(msg.list);
        break;
      case 'pills':
        state.pills.clear();
        for (const p of msg.list) addPill(p);
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
        showRemoteUpdateToast(msg);
        break;
      default:
        if (msg.type?.startsWith('plugin.')) dispatchPluginMessage(msg);
        break;
    }
  };

  state.ws.onclose = () => setTimeout(connect, 1000);
}

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
  const iconSrc = preset.icon?.startsWith('/') ? preset.icon : null;
  const title = preset.bridge ? 'Bridge Plugin' : 'Status Tracking';

  const toast = document.createElement('div');
  toast.dataset.setupPreset = preset.presetId;
  toast.dataset.sessionId = sessionId;
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

  const dormantIds = state.resumable.filter(s => !s.projectId).map(s => s.id);

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
    <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">New Project</div>
    <div class="flex items-center gap-1.5 mb-2">
      <input id="pc-path" type="text" value="${esc(defaultPath)}" placeholder="Project folder path"
        class="flex-1 px-3 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-md text-slate-400 placeholder-slate-600 outline-none focus:border-blue-500 transition-colors font-mono">
      <button id="pc-browse" class="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700 transition-colors" title="Browse">
        ${FOLDER_SVG}
      </button>
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

  container.innerHTML = list.map((p, i) => {
    const open = !!expanded[p.id];
    const deleteBtn = p.bundled ? '' : `<div class="plugin-delete flex items-center justify-center w-6 h-6 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700/50 cursor-pointer transition-colors flex-shrink-0" data-plugin-id="${esc(p.id)}" data-plugin-name="${esc(p.name)}" title="Remove plugin">${trashSvg}</div>`;
    const hasFooter = p.author || !p.bundled;
    return `
    <div class="plugin-card ${i > 0 ? 'border-t border-slate-700/50' : ''}">
      <div class="plugin-toggle px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer" data-plugin-id="${esc(p.id)}">
        <div class="flex items-center gap-2">
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
      btn.className = 'project-plugin-action plugin-project-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-indigo-400 flex-shrink-0 transition-opacity p-0.5';
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
  remoteInstalled = !!msg.installed;
  state.remoteVersion = msg.version || (msg.installed ? null : 'not installed');
  updateVersionFooter();
  const wasPaired = remoteState === 'paired';
  if (!msg.installed) {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  } else if (msg.paired) {
    const wasFresh = remoteState !== 'paired';
    remoteState = 'paired';
    if (!remoteStatusPoll) startRemotePoll();
    if (wasFresh) {

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
    if (remoteModalOpen) setRemotePane('qr');
  } else {
    remoteState = 'idle';
    stopRemotePoll();
    if (wasPaired) { stopRemoteStats(); setRemoteLock(false); }
  }
  updateRemoteButton();
}

function handleRemotePaired(msg) {
  remoteInstalled = true;
  remoteState = 'waiting';
  document.getElementById('remote-url-box').textContent = msg.url || '';
  const qrImg = document.getElementById('remote-qr-img');
  if (msg.qr && msg.qr.startsWith('data:')) { qrImg.src = msg.qr; qrImg.classList.remove('hidden'); }
  else qrImg.classList.add('hidden');
  setRemotePane('qr');
  updateRemoteButton();
  startRemotePoll();
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

let remoteUpdateShown = false;

function showRemoteUpdateToast(msg) {
  if (remoteUpdateShown) return;
  remoteUpdateShown = true;

  const toast = document.createElement('div');
  toast.className = 'fixed bottom-5 right-5 z-[500] w-[360px] bg-slate-800/95 backdrop-blur-sm border border-slate-700/60 rounded-xl shadow-2xl shadow-black/60';
  toast.style.cssText = 'opacity:0;transform:translateY(12px);transition:opacity 0.3s ease,transform 0.3s ease';

  toast.innerHTML = `
    <div class="flex items-center gap-2.5 px-4 pt-3.5 pb-1">
      <svg class="w-5 h-5 flex-shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
      <span class="text-[13px] font-semibold text-slate-200">CliDeck Remote Update</span>
      <button class="dismiss-btn ml-auto w-6 h-6 flex items-center justify-center rounded-md text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <p class="px-4 pt-1 pb-2.5 text-xs text-slate-400 leading-relaxed">
      Version <span class="text-slate-300">${esc(msg.latest)}</span> is available (installed: ${esc(msg.installed)}).
    </p>
    <div class="px-4 pb-3.5 flex items-center gap-2">
      <button class="update-btn flex-1 px-3 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors">Update</button>
      <button class="dismiss-btn px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors">Later</button>
    </div>`;

  const dismiss = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 300);
  };

  toast.querySelectorAll('.dismiss-btn').forEach(b => {
    b.onclick = () => { dismiss(); setTimeout(() => { remoteUpdateShown = false; }, 600000); };
  });

  toast.querySelector('.update-btn').onclick = () => {
    dismiss();
    remoteUpdateShown = false;
    document.getElementById('remote-install-log').textContent = '';
    setRemotePane('installing');
    openRemoteModal();
    send({ type: 'remote.install' });
  };

  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
}

// Button click
btnRemote.addEventListener('click', () => {
  if (remoteModalOpen && remoteState !== 'paired') { closeRemoteModal(); return; }
  if (remoteModalOpen) return; // paired — can't dismiss
  if (!remoteInstalled) {
    setRemotePane('intro');
    document.getElementById('remote-install-log').textContent = '';
    openRemoteModal();
    return;
  }
  if (remoteState === 'idle') {
    remoteState = 'connecting';
    setRemotePane('connecting');
    openRemoteModal();
    send({ type: 'remote.pair' });
  } else {
    setRemotePane(remoteState === 'paired' ? 'active' : remoteState === 'waiting' ? 'qr' : 'connecting');
    openRemoteModal();
  }
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

initDrag();
initSessionScrollbarVisibility();
connect();

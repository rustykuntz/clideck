import { state, send } from './state.js';
import { addTerminal, removeTerminal, select, startRename, setSessionProfile, updatePreview, openMenu, closeMenu, setStatus } from './terminals.js';
import { renderSettings } from './settings.js';
import { openCreator, closeCreator } from './creator.js';
import { handleDirsResponse } from './folder-picker.js';
import { confirmClose } from './confirm.js';
import { applyTheme } from './profiles.js';
import './nav.js';

function connect() {
  state.ws = new WebSocket(`ws://${location.host}`);

  state.ws.onopen = () => {
    for (const [, e] of state.terms) { e.term.dispose(); e.el.remove(); }
    state.terms.clear();
    document.getElementById('session-list').innerHTML = '';
    state.active = null;
    document.getElementById('empty').style.display = 'flex';
  };

  state.ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.type) {
      case 'config':
        state.cfg = msg.config;
        renderSettings();
        for (const [, entry] of state.terms) applyTheme(entry.term, entry.profileId);
        break;
      case 'themes':
        state.themes = msg.themes;
        renderSettings();
        break;
      case 'presets':
        state.presets = msg.presets;
        break;
      case 'sessions.resumable':
        state.resumable = msg.list;
        break;
      case 'sessions':
        msg.list.forEach(s => addTerminal(s.id, s.name, s.profileId, s.commandId));
        if (msg.list.length) select(msg.list[0].id);
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.profileId, msg.commandId);
        select(msg.id);
        break;
      case 'output':
        state.terms.get(msg.id)?.term.write(msg.data);
        updatePreview(msg.id, msg.data);
        break;
      case 'closed':
        removeTerminal(msg.id);
        break;
      // TEMPORARY: stats overlay + working/idle detection
      case 'stats': {
        const el = document.getElementById('stats-overlay');
        const id = state.active;
        const s = id && msg.stats[id];
        if (el) el.innerHTML = s ? [
          `CPU ${s.cpu.toFixed(1)}%  ·  MEM ${s.memMB} MB`,
          `↑${s.rateOut || '0 B/s'}  ↓${s.rateIn || '0 B/s'}  ·  IN ${s.netIn || '0 B'}  OUT ${s.netOut || '0 B'}`,
          `Silence ${s.silence || '-'}  ·  Burst ${s.burst || '-'}  ·  Chunks ${s.chunks || 0}  ·  AvgChunk ${s.avgChunk || 0}B`,
          `<span class="text-slate-500">${s.lastLine ? s.lastLine.slice(0, 60) : '-'}</span>`,
        ].join('<br>') : '';
        // Working/idle detection per session
        for (const [sid, st] of Object.entries(msg.stats)) {
          const entry = state.terms.get(sid);
          if (!entry) continue;
          const net = Math.max(st.rawRateOut || 0, st.rawRateIn || 0);
          const burstUp = (st.burstMs || 0) > (entry.prevBurst || 0) && st.burstMs > 0;
          const userTyping = (st.rawRateIn || 0) > 0 && (st.rawRateIn || 0) < 50;
          entry.prevBurst = st.burstMs || 0;

          // Working: burst increasing + net >= 800B + no typing
          const isWorking = burstUp && net >= 800 && !userTyping;
          // Idle: burst not increasing + net < 800B
          const isIdle = !burstUp && net < 800;

          // Sustain for ~1.5s (2 ticks)
          if (isWorking) entry.workTicks = (entry.workTicks || 0) + 1;
          else entry.workTicks = 0;
          if (isIdle) entry.idleTicks = (entry.idleTicks || 0) + 1;
          else entry.idleTicks = 0;

          if (entry.workTicks >= 2) setStatus(sid, true);
          else if (entry.idleTicks >= 2) setStatus(sid, false);
        }
        break;
      }
      case 'dirs':
        handleDirsResponse(msg);
        break;
      case 'session.profile': {
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.profileId = msg.profileId;
          applyTheme(entry.term, msg.profileId);
        }
        break;
      }
      case 'renamed': {
        const el = document.querySelector(`.group[data-id="${msg.id}"] .name`);
        if (el && el.contentEditable !== 'true') el.textContent = msg.name;
        break;
      }
    }
  };

  state.ws.onclose = () => setTimeout(connect, 1000);
}

// Sidebar events
const sessionList = document.getElementById('session-list');

sessionList.addEventListener('click', (e) => {
  const item = e.target.closest('.group');
  if (!item) return;

  // Menu button
  if (e.target.closest('.menu-btn')) {
    openMenu(item.dataset.id, e.target.closest('.menu-btn'));
    return;
  }

  select(item.dataset.id);
});

sessionList.addEventListener('dblclick', (e) => {
  if (e.target.closest('.name')) {
    startRename(e.target.closest('.group').dataset.id);
  }
});

// Session delete from context menu
sessionList.addEventListener('session-delete', async (e) => {
  const id = e.detail.id;
  if (state.cfg.confirmClose !== false) {
    const ok = await confirmClose();
    if (!ok) return;
  }
  send({ type: 'close', id });
});

document.getElementById('btn-new').addEventListener('click', openCreator);

new ResizeObserver(() => {
  if (!state.active) return;
  const entry = state.terms.get(state.active);
  if (entry) {
    entry.fit.fit();
    send({ type: 'resize', id: state.active, cols: entry.term.cols, rows: entry.term.rows });
  }
}).observe(document.getElementById('terminals'));

connect();

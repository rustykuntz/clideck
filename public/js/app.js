import { state, send } from './state.js';
import { addTerminal, removeTerminal, select, startRename, setSessionTheme, openMenu, closeMenu, setStatus, debugBuffer, updatePreview, markUnread, applyFilter, setTab, renderResumable } from './terminals.js';
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
        for (const [, entry] of state.terms) applyTheme(entry.term, entry.themeId);
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
        renderResumable();
        break;
      case 'sessions':
        msg.list.forEach(s => addTerminal(s.id, s.name, s.themeId, s.commandId));
        if (msg.list.length) select(msg.list[0].id);
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.themeId, msg.commandId);
        select(msg.id);
        applyFilter();
        break;
      case 'output':
        state.terms.get(msg.id)?.term.write(msg.data);
        updatePreview(msg.id);
        markUnread(msg.id);
        break;
      case 'closed':
        removeTerminal(msg.id);
        break;
      // TEMPORARY: stats overlay + working/idle detection
      case 'stats': {
        const el = document.getElementById('stats-overlay');
        const id = state.active;
        const s = id && msg.stats[id];
        // Debug: dump buffer analysis for active terminal
        const activeEntry = id && state.terms.get(id);
        const bufDump = activeEntry ? debugBuffer(activeEntry.term) : '';
        if (el) el.innerHTML = s ? [
          `CPU ${s.cpu.toFixed(1)}%  ·  MEM ${s.memMB} MB`,
          `↑${s.rateOut || '0 B/s'}  ↓${s.rateIn || '0 B/s'}  ·  IN ${s.netIn || '0 B'}  OUT ${s.netOut || '0 B'}`,
          `Silence ${s.silence || '-'}  ·  Burst ${s.burst || '-'}  ·  Chunks ${s.chunks || 0}  ·  AvgChunk ${s.avgChunk || 0}B`,
          `<pre class="text-[10px] text-slate-400 mt-1 whitespace-pre leading-tight">${bufDump}</pre>`,
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
      case 'transcript.cache':
        for (const [id, text] of Object.entries(msg.cache)) {
          const entry = state.terms.get(id);
          if (entry) entry.searchText = text;
        }
        break;
      // #6: Re-apply filter when transcript data changes
      case 'transcript.append': {
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
  // Resumable session click
  const resumableRow = e.target.closest('[data-resumable-id]');
  if (resumableRow) {
    send({ type: 'session.resume', id: resumableRow.dataset.resumableId });
    return;
  }

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

// Search & filter toolbar
document.getElementById('search-input').addEventListener('input', (e) => {
  state.filter.query = e.target.value;
  applyFilter();
});
document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});


new ResizeObserver(() => {
  if (!state.active) return;
  const entry = state.terms.get(state.active);
  if (entry) {
    entry.fit.fit();
    send({ type: 'resize', id: state.active, cols: entry.term.cols, rows: entry.term.rows });
  }
}).observe(document.getElementById('terminals'));

connect();

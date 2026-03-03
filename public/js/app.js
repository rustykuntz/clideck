import { state, send } from './state.js';
import { addTerminal, removeTerminal, select, startRename, setSessionProfile, openProfilePicker } from './terminals.js';
import { renderSettings } from './settings.js';
import { openLauncher } from './launcher.js';
import { handleDirsResponse } from './folder-picker.js';
import { confirmClose } from './confirm.js';
import { applyTheme, resolveAccent } from './profiles.js';
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
        // Re-apply themes to all running terminals whose profile may have changed
        for (const [, entry] of state.terms) {
          applyTheme(entry.term, entry.profileId);
        }
        break;
      case 'themes':
        state.themes = msg.themes;
        renderSettings();
        break;
      case 'sessions':
        msg.list.forEach(s => addTerminal(s.id, s.name, s.profileId));
        if (msg.list.length) select(msg.list[0].id);
        break;
      case 'created':
        if (!state.terms.has(msg.id)) addTerminal(msg.id, msg.name, msg.profileId);
        select(msg.id);
        break;
      case 'output':
        state.terms.get(msg.id)?.term.write(msg.data);
        break;
      case 'closed':
        removeTerminal(msg.id);
        break;
      case 'dirs':
        handleDirsResponse(msg);
        break;
      case 'session.profile': {
        const entry = state.terms.get(msg.id);
        if (entry) {
          entry.profileId = msg.profileId;
          applyTheme(entry.term, msg.profileId);
          const dot = document.querySelector(`.group[data-id="${msg.id}"] .profile-dot`);
          if (dot) dot.style.background = resolveAccent(msg.profileId);
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
document.getElementById('session-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.group');
  if (!item) return;
  if (e.target.classList.contains('profile-dot')) {
    openProfilePicker(item.dataset.id, e.target);
    return;
  }
  if (e.target.classList.contains('close-btn')) {
    if (state.cfg.confirmClose !== false) {
      const ok = await confirmClose();
      if (!ok) return;
    }
    send({ type: 'close', id: item.dataset.id });
  } else {
    select(item.dataset.id);
  }
});

document.getElementById('session-list').addEventListener('dblclick', (e) => {
  if (e.target.classList.contains('name')) {
    startRename(e.target.closest('.group').dataset.id);
  }
});

document.getElementById('btn-new').addEventListener('click', openLauncher);

new ResizeObserver(() => {
  if (!state.active) return;
  const entry = state.terms.get(state.active);
  if (entry) {
    entry.fit.fit();
    send({ type: 'resize', id: state.active, cols: entry.term.cols, rows: entry.term.rows });
  }
}).observe(document.getElementById('terminals'));

connect();

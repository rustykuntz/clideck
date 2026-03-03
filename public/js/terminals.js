import { state, send } from './state.js';
import { esc } from './utils.js';
import { resolveTheme, resolveAccent, applyTheme } from './profiles.js';

let pickerCleanup = null;

export function openProfilePicker(sessionId, dotEl) {
  closeProfilePicker();
  const entry = state.terms.get(sessionId);
  if (!entry) return;

  const rect = dotEl.getBoundingClientRect();
  const picker = document.createElement('div');
  picker.className = 'fixed z-[400] min-w-[180px] bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';

  picker.innerHTML = state.cfg.profiles.map(p =>
    `<div class="profile-pick flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors text-sm ${p.id === entry.profileId ? 'bg-slate-700/50' : ''}" data-profile="${p.id}">
      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${p.accentColor || '#3b82f6'}"></span>
      <span class="flex-1 text-slate-200">${esc(p.name)}</span>
    </div>`
  ).join('');

  document.body.appendChild(picker);

  const onClick = (e) => {
    const item = e.target.closest('.profile-pick');
    if (item) {
      setSessionProfile(sessionId, item.dataset.profile);
      dotEl.style.background = resolveAccent(item.dataset.profile);
    }
    closeProfilePicker();
  };
  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== dotEl) closeProfilePicker();
  };
  picker.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));

  pickerCleanup = () => {
    picker.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    picker.remove();
    pickerCleanup = null;
  };
}

export function closeProfilePicker() {
  if (pickerCleanup) pickerCleanup();
}

export function addTerminal(id, name, profileId) {
  if (state.terms.has(id)) return;
  profileId = profileId || state.cfg.defaultProfile || 'default';

  const item = document.createElement('div');
  item.className = 'group flex items-center gap-2 px-4 py-2.5 cursor-pointer border-l-[3px] border-transparent hover:bg-slate-800/60 text-sm transition-colors';
  item.dataset.id = id;
  item.innerHTML = `
    <span class="profile-dot w-2.5 h-2.5 rounded-full flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-slate-500 transition-shadow" style="background:${resolveAccent(profileId)}" title="Change profile"></span>
    <span class="name flex-1 truncate">${esc(name)}</span>
    <button class="close-btn opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 text-sm px-1 transition-opacity">&times;</button>`;
  document.getElementById('session-list').appendChild(item);

  const el = document.createElement('div');
  el.className = 'term-wrap';
  document.getElementById('terminals').appendChild(el);

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: resolveTheme(profileId),
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(data => send({ type: 'input', id, data }));

  state.terms.set(id, { term, fit, el, profileId });
  document.getElementById('empty').style.display = 'none';
  document.getElementById('terminals').style.pointerEvents = '';
}

export function removeTerminal(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.el.remove();
  state.terms.delete(id);
  document.querySelector(`.group[data-id="${id}"]`)?.remove();

  if (state.active === id) {
    const next = state.terms.keys().next().value;
    if (next) select(next);
    else {
      state.active = null;
      document.getElementById('empty').style.display = 'flex';
      document.getElementById('terminals').style.pointerEvents = 'none';
    }
  }
}

export function select(id) {
  if (state.active === id) return;

  // Deactivate old
  const prev = document.querySelector('.group.active-session');
  if (prev) {
    prev.classList.remove('active-session', 'bg-slate-800/80', 'border-blue-500');
    prev.classList.add('border-transparent');
  }
  document.querySelector('.term-wrap.active')?.classList.remove('active');

  // Activate new
  const item = document.querySelector(`.group[data-id="${id}"]`);
  if (item) {
    item.classList.add('active-session', 'bg-slate-800/80', 'border-blue-500');
    item.classList.remove('border-transparent');
  }
  const entry = state.terms.get(id);
  if (entry) {
    entry.el.classList.add('active');
    requestAnimationFrame(() => {
      entry.fit.fit();
      send({ type: 'resize', id, cols: entry.term.cols, rows: entry.term.rows });
      entry.term.focus();
    });
  }
  state.active = id;
}

export function setSessionProfile(id, profileId) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.profileId = profileId;
  applyTheme(entry.term, profileId);
  send({ type: 'session.profile', id, profileId });
}

export function startRename(id) {
  const el = document.querySelector(`.group[data-id="${id}"] .name`);
  if (!el || el.contentEditable === 'true') return;
  const original = el.textContent;
  el.contentEditable = 'true';
  el.focus();
  document.getSelection().selectAllChildren(el);

  let cancelled = false;
  const finish = () => {
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    if (cancelled) el.textContent = original;
    else {
      const name = el.textContent.trim() || original;
      el.textContent = name;
      send({ type: 'rename', id, name });
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { cancelled = true; el.blur(); }
  };
  el.addEventListener('blur', finish, { once: true });
  el.addEventListener('keydown', onKey);
}

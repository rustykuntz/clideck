import { state, send } from './state.js';
import { esc } from './utils.js';
import { resolveTheme, resolveAccent, applyTheme } from './profiles.js';

// --- Helpers ---

// Strip all ANSI/VT escape sequences + control chars
const stripAnsi = s => s.replace(/\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g, '');
const timeNow = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });


const TERMINAL_SVG = `<svg class="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

const SPINNER_SVG = `<svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;

function iconHtml(commandId) {
  const icon = state.cfg.commands.find(c => c.id === commandId)?.icon || 'terminal';
  if (icon.startsWith('/'))
    return `<img src="${esc(icon)}" class="w-7 h-7 object-contain" draggable="false">`;
  return TERMINAL_SVG;
}

// --- Session context menu ---

let menuCleanup = null;

function closeMenu() {
  if (menuCleanup) menuCleanup();
}

function openMenu(sessionId, anchorEl) {
  closeMenu();

  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';

  const items = [
    { label: 'Profile', icon: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8"/></svg>`, action: 'profile' },
    { label: 'Delete', icon: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`, action: 'delete', cls: 'text-red-400' },
  ];

  menu.innerHTML = items.map(i =>
    `<button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm ${i.cls || 'text-slate-300'} hover:bg-slate-700 transition-colors text-left" data-action="${i.action}">
      <span class="flex-shrink-0 ${i.cls || 'text-slate-400'}">${i.icon}</span>
      ${i.label}
    </button>`
  ).join('');

  document.body.appendChild(menu);

  const onClick = (e) => {
    const btn = e.target.closest('.menu-action');
    if (!btn) return;
    closeMenu();
    const action = btn.dataset.action;
    if (action === 'delete') {
      document.getElementById('session-list').dispatchEvent(
        new CustomEvent('session-delete', { detail: { id: sessionId } })
      );
    } else if (action === 'profile') {
      const iconEl = document.querySelector(`.group[data-id="${sessionId}"] .session-icon`);
      if (iconEl) openProfilePicker(sessionId, iconEl);
    }
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  menu.addEventListener('click', onClick);
  requestAnimationFrame(() => document.addEventListener('click', onOutside));

  menuCleanup = () => {
    menu.removeEventListener('click', onClick);
    document.removeEventListener('click', onOutside);
    menu.remove();
    menuCleanup = null;
  };
}

// --- Profile picker ---

let pickerCleanup = null;

export function openProfilePicker(sessionId, anchorEl) {
  closeProfilePicker();
  const entry = state.terms.get(sessionId);
  if (!entry) return;

  const rect = anchorEl.getBoundingClientRect();
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
    if (item) setSessionProfile(sessionId, item.dataset.profile);
    closeProfilePicker();
  };
  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) closeProfilePicker();
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

// --- Terminal management ---

export function addTerminal(id, name, profileId, commandId) {
  if (state.terms.has(id)) return;
  profileId = profileId || state.cfg.defaultProfile || 'default';

  const item = document.createElement('div');
  item.className = 'group flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-800/50 transition-colors';
  item.dataset.id = id;
  item.innerHTML = `
    <div class="session-icon w-11 h-11 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0 overflow-hidden">
      ${iconHtml(commandId)}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline justify-between gap-2">
        <span class="name font-semibold text-[13px] text-slate-200 truncate">${esc(name)}</span>
        <span class="session-time text-[11px] text-slate-500 flex-shrink-0">${timeNow()}</span>
      </div>
      <div class="flex items-center gap-1.5 mt-0.5">
        <span class="session-status text-emerald-500 flex-shrink-0 leading-none" style="transition:opacity 0.2s">${SPINNER_SVG}</span>
        <span class="session-preview text-xs text-slate-500 truncate">Starting...</span>
      </div>
    </div>
    <button class="menu-btn opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 flex-shrink-0 p-0.5 transition-opacity" title="Menu">
      <svg class="w-4 h-4" fill="none" viewBox="0 0 20 20"><path d="M10 6l-4 4h8l-4-4z" fill="currentColor"/></svg>
    </button>`;
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

  state.terms.set(id, { term, fit, el, profileId, commandId, outputBuf: '', working: true });
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

  const prev = document.querySelector('.group.active-session');
  if (prev) prev.classList.remove('active-session', 'bg-slate-800/80');
  document.querySelector('.term-wrap.active')?.classList.remove('active');

  const item = document.querySelector(`.group[data-id="${id}"]`);
  if (item) item.classList.add('active-session', 'bg-slate-800/80');

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

// --- Preview & status ---

export function updatePreview(id, rawData) {
  const entry = state.terms.get(id);
  if (!entry) return;
  // Just accumulate output — preview text updated when status goes idle
  entry.outputBuf = (entry.outputBuf + rawData).slice(-1000);
}

// Called by setStatus when transitioning to idle
function flushPreview(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  const clean = stripAnsi(entry.outputBuf).replace(/[^\x20-\x7E]/g, ' ');
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  const el = document.querySelector(`.group[data-id="${id}"] .session-preview`);
  if (el && last) el.textContent = last;
  const timeEl = document.querySelector(`.group[data-id="${id}"] .session-time`);
  if (timeEl) timeEl.textContent = timeNow();
  entry.outputBuf = '';
}

function setStatus(id, working) {
  const entry = state.terms.get(id);
  if (!entry || entry.working === working) return;
  entry.working = working;

  const el = document.querySelector(`.group[data-id="${id}"] .session-status`);
  if (!el) return;

  // Fade out, swap, fade in
  el.style.opacity = '0';
  setTimeout(() => {
    if (working) {
      el.className = 'session-status text-emerald-500 flex-shrink-0 leading-none';
      el.innerHTML = SPINNER_SVG;
    } else {
      el.className = 'session-status text-slate-600 flex-shrink-0 text-[11px] leading-none';
      el.innerHTML = '<span>z<sup>z</sup>Z</span>';
      flushPreview(id);
    }
    el.style.opacity = '1';
  }, 200);
}

// --- Profile ---

export function setSessionProfile(id, profileId) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.profileId = profileId;
  applyTheme(entry.term, profileId);
  send({ type: 'session.profile', id, profileId });
}

// --- Rename ---

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

export { openMenu, closeMenu, setStatus };

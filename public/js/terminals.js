import { state, send } from './state.js';
import { esc } from './utils.js';
import { resolveTheme, resolveAccent, applyTheme, themePreviewColors } from './profiles.js';

// --- Helpers ---

function formatTime(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0 && d.getDate() === now.getDate())
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 2 && (now.getDate() - d.getDate() === 1 || (now.getDate() < d.getDate() && days < 2)))
    return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}


const TERMINAL_SVG = `<svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

const SPINNER_SVG = `<svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;

function iconHtml(commandId) {
  const icon = state.cfg.commands.find(c => c.id === commandId)?.icon || 'terminal';
  if (icon.startsWith('/'))
    return `<img src="${esc(icon)}" class="w-5 h-5 object-contain" draggable="false">`;
  return TERMINAL_SVG;
}

function shortPath(p) {
  return p ? p.replace(/^\/(?:Users|home)\/[^/]+/, '~') : '';
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
    { label: 'Theme', icon: `<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8"/></svg>`, action: 'theme' },
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
    } else if (action === 'theme') {
      const iconEl = document.querySelector(`.group[data-id="${sessionId}"] .session-icon`);
      if (iconEl) openThemePicker(sessionId, iconEl);
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

// --- Theme picker (per-session) ---

let pickerCleanup = null;

function openThemePicker(sessionId, anchorEl) {
  closeThemePicker();
  const entry = state.terms.get(sessionId);
  if (!entry) return;

  const rect = anchorEl.getBoundingClientRect();
  const picker = document.createElement('div');
  picker.className = 'fixed z-[400] min-w-[220px] max-h-[280px] overflow-y-auto bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';

  picker.innerHTML = state.themes.map(t => {
    const colors = themePreviewColors(t.id);
    const strip = colors.length
      ? `<div class="flex mt-1 rounded overflow-hidden">${colors.map(c => `<span class="flex-1 h-2" style="background:${c}"></span>`).join('')}</div>`
      : '';
    return `<div class="theme-pick px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors ${t.id === entry.themeId ? 'bg-slate-700/50' : ''}" data-theme="${t.id}">
      <div class="text-sm text-slate-200">${esc(t.name)}</div>
      ${strip}
    </div>`;
  }).join('');

  document.body.appendChild(picker);

  const onClick = (e) => {
    const item = e.target.closest('.theme-pick');
    if (item) setSessionTheme(sessionId, item.dataset.theme);
    closeThemePicker();
  };
  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) closeThemePicker();
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

function closeThemePicker() {
  if (pickerCleanup) pickerCleanup();
}

// --- Terminal management ---

export function addTerminal(id, name, themeId, commandId) {
  if (state.terms.has(id)) return;
  themeId = themeId || state.cfg.defaultTheme || 'default';

  const item = document.createElement('div');
  item.className = 'group flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-slate-800/50 transition-colors';
  item.dataset.id = id;
  item.innerHTML = `
    <div class="session-icon w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0 overflow-hidden">
      ${iconHtml(commandId)}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2">
        <span class="name flex-1 font-semibold text-[13px] text-slate-200 truncate">${esc(name)}</span>
        <span class="session-time text-[11px] text-slate-500 flex-shrink-0">${formatTime(Date.now())}</span>
      </div>
      <div class="flex items-center gap-1 mt-0.5">
        <span class="session-status text-emerald-500 flex-shrink-0 leading-none" style="transition:opacity 0.2s">${SPINNER_SVG}</span>
        <span class="session-preview flex-1 text-xs text-slate-500 truncate"></span>
        <span class="unread-dot hidden w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"></span>
        <button class="menu-btn opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 flex-shrink-0 transition-opacity" title="Menu">
          <svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 20 20"><path d="M10 14l-4-4h8l-4 4z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>`;
  const sessionList = document.getElementById('session-list');
  const resumableSection = document.getElementById('resumable-section');
  if (resumableSection) sessionList.insertBefore(item, resumableSection);
  else sessionList.appendChild(item);

  const el = document.createElement('div');
  el.className = 'term-wrap';
  document.getElementById('terminals').appendChild(el);

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: resolveTheme(themeId),
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData(data => send({ type: 'input', id, data }));

  state.terms.set(id, { term, fit, el, themeId, commandId, working: true, lastActivityAt: Date.now(), unread: false, lastPreviewText: '', searchText: '', opened: false });
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
    if (!entry.opened) {
      entry.term.open(entry.el);
      entry.opened = true;
    }
    if (entry.unread) {
      entry.unread = false;
      const dot = document.querySelector(`.group[data-id="${id}"] .unread-dot`);
      if (dot) dot.classList.add('hidden');
      updateUnreadBadge();
      if (state.filter.tab === 'unread') setTab('all');
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      entry.fit.fit();
      send({ type: 'resize', id, cols: entry.term.cols, rows: entry.term.rows });
      entry.term.focus();
    }));
  }
  state.active = id;
}

// --- Preview & status ---

export function markUnread(id) {
  const entry = state.terms.get(id);
  if (!entry || id === state.active || entry.unread) return;
  entry.unread = true;
  const dot = document.querySelector(`.group[data-id="${id}"] .unread-dot`);
  if (dot) dot.classList.remove('hidden');
  updateUnreadBadge();
  applyFilter();
}

export function updatePreview(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  const last = readLastAgentLine(entry.term, entry.commandId);
  const el = document.querySelector(`.group[data-id="${id}"] .session-preview`);
  if (el && last && el.textContent !== last) {
    el.textContent = last;
    entry.lastPreviewText = last;
    entry.lastActivityAt = Date.now();
  }
  const timeEl = document.querySelector(`.group[data-id="${id}"] .session-time`);
  if (timeEl) timeEl.textContent = formatTime(entry.lastActivityAt);
}

// Read the terminal buffer bottom-up, return the last line
// where most characters use default foreground and aren't dim
function readLineText(buf, y) {
  const line = buf.getLine(y);
  if (!line) return '';
  let text = '';
  for (let x = 0; x < line.length; x++) {
    text += line.getCell(x)?.getChars() || ' ';
  }
  return text.trimEnd();
}

function readLastAgentLine(term, commandId) {
  const marker = state.cfg.commands.find(c => c.id === commandId)?.outputMarker;
  if (!marker) return '';
  const buf = term.buffer.active;
  for (let y = buf.baseY + buf.cursorY; y >= 0; y--) {
    const text = readLineText(buf, y).trim();
    if (!text || !text.startsWith(marker)) continue;
    const content = text.slice(marker.length).trim();
    if (content) return content;
  }
  return '';
}

// TEMPORARY: debug — dump last N lines of buffer with their stats
export function debugBuffer(term) {
  const buf = term.buffer.active;
  const lines = [];
  const startY = Math.max(0, buf.baseY + buf.cursorY - 15);
  for (let y = startY; y <= buf.baseY + buf.cursorY; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    let text = '', total = 0, strong = 0, modes = new Set();
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const ch = cell.getChars();
      text += ch || ' ';
      if (!ch || ch === ' ') continue;
      total++;
      const mode = cell.getFgColorMode();
      const dim = cell.isDim();
      modes.add(`m${mode}${dim ? 'd' : ''}`);
      if (mode === 0 && !dim) strong++;
    }
    text = text.trimEnd();
    if (!text) continue;
    const pct = total ? Math.round(strong / total * 100) : 0;
    lines.push(`y${y} [${pct}% strong] [${[...modes].join(',')}] "${text.slice(0, 50)}"`);
  }
  return lines.join('\n');
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
    }
    el.style.opacity = '1';
  }, 200);
}

// --- Theme ---

export function setSessionTheme(id, themeId) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.themeId = themeId;
  applyTheme(entry.term, themeId);
  send({ type: 'session.theme', id, themeId });
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

// --- Resumable sessions ---

const PLAY_SVG = `<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;

export function renderResumable() {
  const list = document.getElementById('session-list');
  let section = document.getElementById('resumable-section');

  if (!state.resumable.length) {
    if (section) section.remove();
    return;
  }

  if (!section) {
    section = document.createElement('div');
    section.id = 'resumable-section';
  }

  section.innerHTML =
    `<div class="resumable-header px-2.5 py-2 mt-1 border-t border-slate-700/50">
      <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-600">Previous Sessions</span>
    </div>` +
    state.resumable.map(s => {
      const cmd = state.cfg.commands.find(c => c.id === s.commandId);
      const label = cmd?.label || 'Session';
      const time = formatTime(new Date(s.savedAt).getTime());
      const path = shortPath(s.cwd);
      return `
    <div class="group resumable-row flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-slate-800/30 transition-colors" data-resumable-id="${s.id}">
      <div class="w-8 h-8 rounded-full bg-slate-800/50 flex items-center justify-center flex-shrink-0 overflow-hidden opacity-40">
        ${iconHtml(s.commandId)}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2">
          <span class="resumable-name flex-1 font-semibold text-[13px] text-slate-400 truncate">${esc(s.name)}</span>
          <span class="text-[11px] text-slate-600 flex-shrink-0">${time}</span>
        </div>
        <div class="flex items-center gap-1 mt-0.5">
          <span class="flex-1 text-xs text-slate-600 truncate">${esc(label)}${path ? ' · ' + esc(path) : ''}</span>
          <button class="resume-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400 flex-shrink-0 transition-all" title="Resume session">
            ${PLAY_SVG}
          </button>
        </div>
      </div>
    </div>`;
    }).join('');

  list.appendChild(section);
  applyFilter();
}

// --- Filtering ---

export function applyFilter() {
  const { query, tab } = state.filter;
  const q = query.toLowerCase();
  for (const [id, entry] of state.terms) {
    const el = document.querySelector(`.group[data-id="${id}"]`);
    if (!el) continue;
    const matchTab = tab === 'all' || entry.unread;
    const name = el.querySelector('.name')?.textContent.toLowerCase() || '';
    const matchQuery = !q || name.includes(q) || (entry.searchText || '').toLowerCase().includes(q);
    el.style.display = matchTab && matchQuery ? '' : 'none';
  }
  // Resumable: hidden in Unread tab, filtered by name otherwise
  const section = document.getElementById('resumable-section');
  if (!section) return;
  if (tab === 'unread') { section.style.display = 'none'; return; }
  section.style.display = '';
  let anyVisible = false;
  for (const row of section.querySelectorAll('[data-resumable-id]')) {
    const name = row.querySelector('.resumable-name')?.textContent.toLowerCase() || '';
    const show = !q || name.includes(q);
    row.style.display = show ? '' : 'none';
    if (show) anyVisible = true;
  }
  section.querySelector('.resumable-header').style.display = anyVisible ? '' : 'none';
}

export function setTab(tab) {
  state.filter.tab = tab;
  document.querySelectorAll('.filter-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    const base = 'filter-tab flex-1 text-[11px] font-medium py-[5px] rounded-md transition-all';
    const extra = btn.dataset.tab === 'unread' ? ' flex items-center justify-center gap-1' : '';
    btn.className = base + extra + (active ? ' bg-slate-700/60 text-slate-200' : ' text-slate-500 hover:text-slate-400');
  });
  applyFilter();
}

function updateUnreadBadge() {
  let count = 0;
  for (const [, entry] of state.terms) if (entry.unread) count++;
  const badge = document.getElementById('unread-badge');
  if (badge) {
    badge.textContent = count || '';
    badge.classList.toggle('hidden', count === 0);
  }
}

// Refresh displayed timestamps every 60s so they age naturally
setInterval(() => {
  for (const [id, entry] of state.terms) {
    const timeEl = document.querySelector(`.group[data-id="${id}"] .session-time`);
    if (timeEl) timeEl.textContent = formatTime(entry.lastActivityAt);
  }
}, 60000);

export { openMenu, closeMenu, setStatus };

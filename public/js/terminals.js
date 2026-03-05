import { state, send } from './state.js';
import { esc } from './utils.js';
import { resolveTheme, resolveAccent, applyTheme } from './profiles.js';

// --- Helpers ---

const RECENT_MS = 15 * 60 * 1000; // 15 minutes

function isRecent(ts) { return Date.now() - ts < RECENT_MS; }

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

function updateTimeEl(el, ts) {
  el.textContent = formatTime(ts);
  el.classList.toggle('recent', isRecent(ts));
}


const TERMINAL_SVG = `<svg class="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

const DARK_BALLS = ['#00e5ff', '#5df0d6', '#9b8cff'];
const LIGHT_BALLS = ['#0891b2', '#059669', '#7c3aed'];

function startBounce(container) {
  const isDark = !document.documentElement.classList.contains('light');
  const colors = isDark ? DARK_BALLS : LIGHT_BALLS;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '30');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '5 18 90 28');
  svg.style.opacity = '0.75';
  container.innerHTML = '';
  container.appendChild(svg);

  const floor = 40, gravity = 0.18, restitution = 0.7;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const radii = [4.5, 4, 3.5];

  const balls = colors.map((fill, i) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', radii[i]);
    c.setAttribute('fill', fill);
    svg.appendChild(c);
    return { el: c, x: 10 + i * rand(14, 22), y: floor - rand(0, 15), vx: rand(0.6, 1.3), vy: -rand(2.5, 5), r: radii[i] };
  });

  let raf;
  function step() {
    balls.forEach(b => {
      b.vy += gravity;
      b.x += b.vx;
      b.y += b.vy;
      if (b.y > floor) { b.y = floor; b.vy *= -restitution; }
    });
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i], b = balls[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy), min = a.r + b.r;
        if (dist < min) {
          const nx = dx / dist, ny = dy / dist;
          const p = a.vx * nx + a.vy * ny - b.vx * nx - b.vy * ny;
          a.vx -= p * nx; a.vy -= p * ny;
          b.vx += p * nx; b.vy += p * ny;
        }
      }
    }
    balls.forEach(b => {
      if (b.x > 100) { b.x = rand(5, 15); b.y = floor - rand(0, 10); b.vx = rand(0.6, 1.3); b.vy = -rand(2.5, 5); }
      b.el.setAttribute('cx', b.x);
      b.el.setAttribute('cy', b.y);
    });
    raf = requestAnimationFrame(step);
  }
  step();
  return () => cancelAnimationFrame(raf);
}

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

  const entry = state.terms.get(sessionId);
  const projects = state.cfg.projects || [];

  let html = '';

  // Project submenu items
  if (projects.length) {
    html += `<div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Move to project</div>`;
    for (const p of projects) {
      const active = entry?.projectId === p.id;
      html += `<button class="menu-action flex items-center gap-2 w-full px-3 py-1.5 text-sm ${active ? 'text-blue-400' : 'text-slate-300'} hover:bg-slate-700 transition-colors text-left" data-action="project" data-project-id="${p.id}">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${projectColor(p)}"></span>
        ${esc(p.name)}${active ? ' ✓' : ''}
      </button>`;
    }
    if (entry?.projectId) {
      html += `<button class="menu-action flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-700 transition-colors text-left" data-action="unproject">
        <span class="w-2 h-2 rounded-full flex-shrink-0 border border-slate-600"></span>
        Remove from project
      </button>`;
    }
    html += `<div class="border-t border-slate-700/50 my-1"></div>`;
  }

  html += `
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="rename">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></span>
      Rename
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="theme">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8"/></svg></span>
      Theme
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors text-left" data-action="delete">
      <span class="flex-shrink-0 text-red-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span>
      Delete
    </button>`;

  menu.innerHTML = html;
  document.body.appendChild(menu);

  const onClick = (e) => {
    const btn = e.target.closest('.menu-action');
    if (!btn) return;
    closeMenu();
    const action = btn.dataset.action;
    if (action === 'rename') {
      startRename(sessionId);
    } else if (action === 'delete') {
      document.getElementById('session-list').dispatchEvent(
        new CustomEvent('session-delete', { detail: { id: sessionId } })
      );
    } else if (action === 'theme') {
      const iconEl = document.querySelector(`.group[data-id="${sessionId}"] .session-icon`);
      if (iconEl) openThemePicker(sessionId, iconEl);
    } else if (action === 'project') {
      setSessionProject(sessionId, btn.dataset.projectId);
    } else if (action === 'unproject') {
      setSessionProject(sessionId, null);
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
  picker.className = 'fixed z-[400] min-w-[220px] max-h-[400px] overflow-y-auto bg-slate-800 border border-slate-600 rounded-lg shadow-xl shadow-black/40 py-1';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';

  picker.innerHTML = state.themes.map(t => {
    return `<div class="theme-pick px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors ${t.id === entry.themeId ? 'bg-blue-500/15 border-l-2 border-blue-400' : ''}" data-theme="${t.id}">
      <div class="text-sm text-slate-200 mb-1">${esc(t.name)}</div>
      <div class="text-[10px] font-mono leading-[1.4] whitespace-pre rounded overflow-hidden" style="background:${t.theme.background};padding:4px 6px"><span style="color:${t.theme.green}">~</span> <span style="color:${t.theme.blue}">src</span> <span style="color:${t.theme.foreground}">$ ls</span>\n<span style="color:${t.theme.yellow}">app.ts</span>  <span style="color:${t.theme.cyan}">utils.ts</span>  <span style="color:${t.theme.brightBlack}">README</span></div>
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

// --- Terminal size estimation (for PTY spawn) ---

export function estimateSize() {
  const el = document.getElementById('terminals');
  // Account for inset-1 padding (4px each side)
  const w = el.clientWidth - 8, h = el.clientHeight - 8;
  // Menlo 13px: ~7.8px wide, ~17px tall
  return { cols: Math.max(Math.floor(w / 7.8), 80), rows: Math.max(Math.floor(h / 17), 24) };
}

// --- Terminal management ---

export function addTerminal(id, name, themeId, commandId, projectId) {
  if (state.terms.has(id)) return;
  themeId = themeId || state.cfg.defaultTheme || 'default';

  const item = document.createElement('div');
  item.className = 'group flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors select-none';
  item.dataset.id = id;
  item.innerHTML = `
    <div class="session-icon w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center flex-shrink-0 overflow-hidden pointer-events-none">
      ${iconHtml(commandId)}
    </div>
    <div class="flex-1 min-w-0 pointer-events-none">
      <div class="flex items-baseline gap-2">
        <span class="name flex-1 font-semibold text-[13px] text-slate-200 truncate pointer-events-auto cursor-default">${esc(name)}</span>
        <span class="session-time recent text-[11px] flex-shrink-0">${formatTime(Date.now())}</span>
      </div>
      <div class="flex items-center gap-1 mt-0.5">
        <span class="session-status flex-shrink-0 leading-none" style="transition:opacity 0.2s"></span>
        <span class="session-preview flex-1 text-xs text-slate-500 truncate"></span>
        <span class="unread-dot hidden w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"></span>
        <button class="menu-btn opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-300 flex-shrink-0 transition-opacity pointer-events-auto" title="Menu">
          <svg class="w-[18px] h-[18px]" fill="none" viewBox="0 0 20 20"><path d="M10 14l-4-4h8l-4 4z" fill="currentColor"/></svg>
        </button>
      </div>
    </div>`;

  document.getElementById('session-list').appendChild(item);
  const statusEl = item.querySelector('.session-status');
  const stopBounce = startBounce(statusEl);

  const el = document.createElement('div');
  el.className = 'term-wrap';
  el.style.backgroundColor = resolveTheme(themeId).background;
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

  term.open(el);
  const ro = new ResizeObserver(() => {
    if (!el.offsetWidth) return;
    fit.fit();
    send({ type: 'resize', id, cols: term.cols, rows: term.rows });
  });
  ro.observe(el);
  state.terms.set(id, { term, fit, el, ro, themeId, commandId, projectId: projectId || null, working: true, stopBounce, lastActivityAt: Date.now(), unread: false, lastPreviewText: '', searchText: '' });
  document.getElementById('empty').style.display = 'none';
  document.getElementById('terminals').style.pointerEvents = '';

  regroupSessions();
}

export function removeTerminal(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  if (entry.stopBounce) entry.stopBounce();
  entry.ro?.disconnect();
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
  regroupSessions();
}

export function select(id) {
  if (state.active === id) return;

  const prev = document.querySelector('.group.active-session');
  if (prev) prev.classList.remove('active-session');
  document.querySelector('.term-wrap.active')?.classList.remove('active');

  const item = document.querySelector(`.group[data-id="${id}"]`);
  if (item) item.classList.add('active-session');

  const entry = state.terms.get(id);
  if (entry) {
    entry.el.classList.add('active');
    if (entry.unread) {
      entry.unread = false;
      const dot = document.querySelector(`.group[data-id="${id}"] .unread-dot`);
      if (dot) dot.classList.add('hidden');
      updateUnreadBadge();
      if (state.filter.tab === 'unread') setTab('all');
    }
    entry.term.scrollToBottom();
    if (!document.querySelector('[contenteditable="true"]')) entry.term.focus();
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
  if (timeEl) updateTimeEl(timeEl, entry.lastActivityAt);
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

  // Stop previous animation if any
  if (entry.stopBounce) { entry.stopBounce(); entry.stopBounce = null; }

  // Fade out, swap, fade in
  el.style.opacity = '0';
  setTimeout(() => {
    if (working) {
      el.className = 'session-status flex-shrink-0 leading-none';
      entry.stopBounce = startBounce(el);
    } else {
      el.className = 'session-status dormant flex-shrink-0 text-[11px] leading-none';
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
  entry.el.style.backgroundColor = resolveTheme(themeId).background;
  send({ type: 'session.theme', id, themeId });
}

// --- Rename ---

export function startRename(id) {
  const el = document.querySelector(`.group[data-id="${id}"] .name`);
  if (!el || el.contentEditable === 'true') return;
  const original = el.textContent;
  el.contentEditable = 'true';
  el.style.userSelect = 'text';
  el.style.webkitUserSelect = 'text';
  el.classList.add('cursor-text');
  el.focus();
  document.getSelection().selectAllChildren(el);

  let cancelled = false;
  const finish = () => {
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    el.style.userSelect = '';
    el.style.webkitUserSelect = '';
    el.classList.remove('cursor-text');
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

export function startProjectRename(projectId) {
  const el = document.querySelector(`.project-group[data-project-id="${projectId}"] .project-name`);
  if (!el || el.contentEditable === 'true') return;
  const original = el.textContent;
  el.contentEditable = 'true';
  el.classList.add('text-slate-200');
  el.focus();
  document.getSelection().selectAllChildren(el);

  let cancelled = false;
  const finish = () => {
    el.removeEventListener('keydown', onKey);
    el.contentEditable = 'false';
    el.classList.remove('text-slate-200');
    if (cancelled) { el.textContent = original; return; }
    const name = el.textContent.trim() || original;
    el.textContent = name;
    const proj = (state.cfg.projects || []).find(p => p.id === projectId);
    if (proj) {
      proj.name = name;
      send({ type: 'config.update', config: state.cfg });
    }
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { cancelled = true; el.blur(); }
  };
  el.addEventListener('blur', finish, { once: true });
  el.addEventListener('keydown', onKey);
}

// --- Project grouping ---

const CHEVRON_SVG = `<svg class="w-3 h-3 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`;

const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#84cc16'];

function projectColor(project) {
  return project.color || PROJECT_COLORS[0];
}

export function regroupSessions() {
  const list = document.getElementById('session-list');
  const projects = state.cfg.projects || [];

  // Detach all session rows (preserve DOM nodes)
  const rows = new Map();
  for (const [id] of state.terms) {
    const row = document.querySelector(`.group[data-id="${id}"]`);
    if (row) { row.remove(); rows.set(id, row); }
  }
  // Remove old project headers, resumable rows, and resumable section
  list.querySelectorAll('.project-group').forEach(el => el.remove());
  list.querySelectorAll('[data-resumable-id]').forEach(el => el.remove());
  document.getElementById('resumable-section')?.remove();

  // Render project groups
  for (const proj of projects) {
    const header = document.createElement('div');
    header.className = 'project-group';
    header.dataset.projectId = proj.id;

    const collapsed = proj.collapsed;
    header.innerHTML = `
      <div class="group project-header flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-slate-800/30 transition-colors select-none" data-project-id="${proj.id}">
        <span class="project-chevron ${collapsed ? 'collapsed' : ''} text-slate-500">${CHEVRON_SVG}</span>
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${projectColor(proj)}"></span>
        <span class="project-name flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 truncate">${esc(proj.name)}</span>
        <span class="project-count text-[10px] text-slate-600">0</span>
        <button class="project-menu-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-slate-400 flex-shrink-0 transition-opacity p-0.5" title="Project menu">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20"><circle cx="10" cy="4" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="16" r="1.5" fill="currentColor"/></svg>
        </button>
      </div>
      <div class="project-sessions ${collapsed ? 'hidden' : ''}"></div>`;

    list.appendChild(header);
  }

  // Place active sessions into their groups or ungrouped at top
  const ungrouped = [];
  for (const [id, entry] of state.terms) {
    const row = rows.get(id);
    if (!row) continue;
    if (entry.projectId) {
      const container = list.querySelector(`.project-group[data-project-id="${entry.projectId}"] .project-sessions`);
      if (container) { container.appendChild(row); continue; }
    }
    ungrouped.push(row);
  }

  const firstGroup = list.querySelector('.project-group');
  for (const row of ungrouped) list.insertBefore(row, firstGroup);

  // Place resumable sessions into their project groups or ungrouped section
  const ungroupedResumable = [];
  for (const s of state.resumable) {
    const row = buildResumableRow(s);
    if (s.projectId) {
      const container = list.querySelector(`.project-group[data-project-id="${s.projectId}"] .project-sessions`);
      if (container) { container.appendChild(row); continue; }
    }
    ungroupedResumable.push(row);
  }

  // Ungrouped resumable → "Previous Sessions" section at the bottom
  if (ungroupedResumable.length) {
    const section = document.createElement('div');
    section.id = 'resumable-section';
    section.innerHTML = `<div class="resumable-header px-2.5 py-2 mt-1 border-t border-slate-700/50">
      <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-600">Previous Sessions</span>
    </div>`;
    for (const row of ungroupedResumable) section.appendChild(row);
    list.appendChild(section);
  }

  // Update counts (active + resumable inside each project)
  for (const proj of projects) {
    const container = list.querySelector(`.project-group[data-project-id="${proj.id}"] .project-sessions`);
    const countEl = list.querySelector(`.project-group[data-project-id="${proj.id}"] .project-count`);
    if (container && countEl) countEl.textContent = container.children.length;
  }

  applyFilter();
}

export function toggleProjectCollapse(projectId) {
  const proj = (state.cfg.projects || []).find(p => p.id === projectId);
  if (!proj) return;
  proj.collapsed = !proj.collapsed;
  send({ type: 'config.update', config: state.cfg });

  const group = document.querySelector(`.project-group[data-project-id="${projectId}"]`);
  if (!group) return;
  const sessions = group.querySelector('.project-sessions');
  const chevron = group.querySelector('.project-chevron');
  if (sessions) sessions.classList.toggle('hidden', proj.collapsed);
  if (chevron) chevron.classList.toggle('collapsed', proj.collapsed);
}

export function setSessionProject(id, projectId) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.projectId = projectId;
  send({ type: 'session.setProject', id, projectId });
  regroupSessions();
}

// --- Resumable sessions ---

const RESUME_SVG = `<svg class="w-3 h-3 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;

function buildResumableRow(s) {
  const cmd = state.cfg.commands.find(c => c.id === s.commandId);
  const label = cmd?.label || 'Session';
  const time = formatTime(new Date(s.savedAt).getTime());
  const path = shortPath(s.cwd);
  const row = document.createElement('div');
  row.className = 'group resumable-row flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-slate-800/30 transition-colors';
  row.dataset.resumableId = s.id;
  row.innerHTML = `
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
        <button class="resume-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-emerald-400 flex-shrink-0 transition-all flex items-center gap-0.5 text-[11px] font-medium" title="Resume session">
          Resume${RESUME_SVG}
        </button>
      </div>
    </div>`;
  return row;
}

export function renderResumable() {
  // Just rebuild rows and let regroupSessions place them
  regroupSessions();
}

// --- Filtering ---

export function applyFilter() {
  const { query, tab } = state.filter;
  const q = query.toLowerCase();

  // Filter active sessions
  for (const [id, entry] of state.terms) {
    const el = document.querySelector(`.group[data-id="${id}"]`);
    if (!el) continue;
    const matchTab = tab === 'all' || entry.unread;
    const name = el.querySelector('.name')?.textContent.toLowerCase() || '';
    const matchQuery = !q || name.includes(q) || (entry.searchText || '').toLowerCase().includes(q);
    el.style.display = matchTab && matchQuery ? '' : 'none';
  }

  // Filter all resumable rows (both inside projects and ungrouped)
  for (const row of document.querySelectorAll('[data-resumable-id]')) {
    if (tab === 'unread') { row.style.display = 'none'; continue; }
    const name = row.querySelector('.resumable-name')?.textContent.toLowerCase() || '';
    row.style.display = !q || name.includes(q) ? '' : 'none';
  }

  // Show/hide project groups
  for (const group of document.querySelectorAll('.project-group')) {
    const sessions = group.querySelector('.project-sessions');
    const hasVisible = sessions && [...sessions.children].some(c => c.style.display !== 'none');
    let show;
    if (q) {
      const projName = group.querySelector('.project-name')?.textContent.toLowerCase() || '';
      show = projName.includes(q) || hasVisible;
    } else {
      show = tab === 'all' || hasVisible;
    }
    group.style.display = show ? '' : 'none';
  }

  // Ungrouped resumable section
  const section = document.getElementById('resumable-section');
  if (!section) return;
  if (tab === 'unread') { section.style.display = 'none'; return; }
  section.style.display = '';
  const anyVisible = [...section.querySelectorAll('[data-resumable-id]')].some(r => r.style.display !== 'none');
  const header = section.querySelector('.resumable-header');
  if (header) header.style.display = anyVisible ? '' : 'none';
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
  const rail = document.getElementById('rail-unread');
  if (rail) {
    rail.textContent = count || '';
    rail.classList.toggle('hidden', count === 0);
  }
}

// Refresh displayed timestamps every 60s so they age naturally
setInterval(() => {
  for (const [id, entry] of state.terms) {
    const timeEl = document.querySelector(`.group[data-id="${id}"] .session-time`);
    if (timeEl) updateTimeEl(timeEl, entry.lastActivityAt);
  }
}, 60000);

export { openMenu, closeMenu, setStatus, PROJECT_COLORS };

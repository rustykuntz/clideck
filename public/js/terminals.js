import { state, send } from './state.js';
import { esc, miniMarkdown, resolveIconPath } from './utils.js';
import { resolveTheme, resolveAccent, applyTheme } from './profiles.js';
import { attachToTerminal, registerHotkey } from './hotkeys.js';
import { closeDropdown } from './prompts.js';
import { showToast } from './toast.js';
import { URL_RE, cleanUrlMatch } from './terminal-urls.js';
function isLightBg(themeId) {
  const bg = resolveTheme(themeId)?.background;
  if (!bg || bg[0] !== '#') return false;
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

// --- Helpers ---

// Re-focus the active terminal after a paste/dismiss/teardown completes.
//
// Phase 11 fixes a class of regressions where a Ctrl+V, drag-and-drop, or
// toast/modal dismiss left focus on `<body>` (or a button that was about to
// be removed), so Enter became a no-op until the user clicked the narrow
// prompt row. Every paste path and every dismiss handler now routes through
// this helper so the active xterm's hidden helper-textarea regains focus
// before the next keystroke.
//
// R2 mitigation: the call is deferred to the next animation frame so any
// sibling synchronous + microtask handlers (toast teardown's 300ms remove,
// the lozenge animation, modal hide transitions, drag-end browser-side
// focus shuffling) have all run by the time we focus the term. Ordering
// matters — if we focused synchronously, a later handler that re-focuses a
// dismiss button (then removes it) would undo our work and re-drop focus
// to body.
//
// Guards (re-evaluated on the rAF tick so DOM mutations between scheduling
// and firing are caught):
//
//   - Visible confirm-modal overlay (`.confirm-overlay:not(.hidden)`) or
//     creator card (`.creator-card`) → skip (user is in a dialog).
//   - `document.activeElement` is an input/textarea/select/contenteditable/
//     role=combobox → skip (user is typing into a real form control like
//     the sidebar search box or a contenteditable rename).
//   - EXCEPTION to the above: xterm's hidden `.xterm-helper-textarea` IS
//     a `<textarea>`, but it's a descendant of `.term-wrap.active`. That
//     particular textarea IS the focus we want, so a TEXTAREA inside a
//     `.term-wrap.active` ancestor is NOT a "real input" — fall through
//     to focus. Same Phase 9 lesson learned from the Ctrl/Cmd +/-/0
//     keydown handler.
//   - Entry may have been removed between scheduling and the rAF tick —
//     re-lookup before calling `term.focus()`.
//
// Always exported — callers in other modules (toast.js, confirm.js) import
// this rather than reimplementing the guard.
export function refocusActiveTerm(idOverride) {
  const id = idOverride ?? state.active;
  if (!id) return;
  if (!state.terms.has(id)) return;
  requestAnimationFrame(() => {
    if (document.querySelector('.confirm-overlay:not(.hidden), .creator-card')) return;
    const ae = document.activeElement;
    if (ae && typeof ae.matches === 'function'
        && ae.matches('input, textarea, select, [contenteditable="true"], [role="combobox"]')) {
      // xterm's hidden helper-textarea exception (Phase 9 lesson).
      if (!ae.closest?.('.term-wrap.active')) return;
    }
    const entry = state.terms.get(id);
    if (entry) entry.term.focus();
  });
}

// Expose the helper on `window` so dismiss handlers in non-importing
// modules (toast.js, confirm.js) can reach it without forcing a
// circular import (terminals.js already imports both). Mirrors the
// `window.__refreshStatusBadge` pattern in app.js.
if (typeof window !== 'undefined') {
  window.__refocusActiveTerm = refocusActiveTerm;
}

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
const MIN_CONTRAST_RATIO = 4.5;

const DARK_BALLS = ['#00e5ff', '#5df0d6', '#9b8cff'];
const LIGHT_BALLS = ['#0891b2', '#059669', '#7c3aed'];

// --- Terminal URL clickability ---
//
// The SPEC's load-bearing constraint is "plain click must continue to
// start a text selection." That means we override xterm's default
// link-activator behaviour (open on plain click) — instead, we only
// open a URL when Ctrl or Cmd is held at click time. Plain click on a
// link surface falls through to xterm's selection path; the URL is
// just text again until you Ctrl/Cmd it.
//
// All `window.open` calls also pass `noopener,noreferrer`. Terminal
// content is untrusted by definition (any agent or shell could print
// hostile text); the new tab must not inherit our origin context and
// must not leak a Referer.

function openTerminalLink(url) {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (win) win.opener = null;
}

function addLinkProvider(term) {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links = [];
      for (const match of text.matchAll(URL_RE)) {
        const cleaned = cleanUrlMatch(match[0], match.index || 0);
        if (!cleaned) continue;
        links.push({
          text: cleaned.text,
          range: {
            start: { x: cleaned.index + 1, y },
            end: { x: cleaned.index + cleaned.text.length, y },
          },
          activate: (event, linkText) => {
            // Plain click → fall through to xterm's selection path.
            // Defence-in-depth scheme check on top of cleanUrlMatch.
            if (!(event.ctrlKey || event.metaKey)) return;
            if (!/^https?:\/\//i.test(linkText)) return;
            openTerminalLink(linkText);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

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

  let raf, lastFrame = 0;
  function step(now = performance.now()) {
    const dt = lastFrame ? Math.min((now - lastFrame) / 16.67, 4) : 1;
    lastFrame = now;
    balls.forEach(b => {
      b.vy += gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
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
    return `<img src="${esc(resolveIconPath(icon))}" class="w-5 h-5 object-contain" draggable="false">`;
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

function positionMenu(menu, anchorRect) {
  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  const mh = menu.offsetHeight;
  const mw = menu.offsetWidth;
  const gap = 4;
  const spaceBelow = window.innerHeight - anchorRect.bottom - gap;
  const left = Math.min(
    Math.max(gap, anchorRect.left),
    Math.max(gap, window.innerWidth - mw - gap)
  );
  menu.style.top = (spaceBelow >= mh
    ? anchorRect.bottom + gap
    : Math.max(gap, anchorRect.top - gap - mh)) + 'px';
  menu.style.left = left + 'px';
  menu.style.visibility = '';
}

function pointRect(x, y) {
  return { top: y, bottom: y, left: x, right: x };
}

async function copyTerminalSelection(sessionId) {
  const entry = state.terms.get(sessionId);
  const text = entry?.term?.getSelection() || '';
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showToast('Clipboard write failed.', { type: 'error' });
    return false;
  }
}

async function pasteIntoTerminal(sessionId) {
  // Try the binary-aware path first. If the clipboard holds an image
  // or any non-text blob, upload it to the session inbox; otherwise
  // fall through to the original text-paste behaviour (load-bearing:
  // the Ctrl+V phase's E2E and dictation tools depend on this).
  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const binaryType = item.types.find(t => !t.startsWith('text/'));
        if (binaryType) {
          const blob = await item.getType(binaryType);
          await uploadBlobToSession(sessionId, blob, binaryType);
          // AC 1 — restore focus after the binary-blob paste so the
          // user's next Enter reaches the PTY without an intervening
          // click. rAF-deferred to win over any teardown that fires
          // after our resolve. binary intent wins; do NOT also send
          // text to PTY.
          refocusActiveTerm(sessionId);
          return;
        }
      }
    }
  } catch (e) {
    // navigator.clipboard.read can throw for various reasons (no
    // permission, no clipboard, headless environments). Fall through
    // to the text path — that's the existing behaviour and keeps the
    // common case working even when read() is unavailable.
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) send({ type: 'input', id: sessionId, data: text });
  } catch {
    showToast('Clipboard read failed.', { type: 'error' });
  }
  // AC 1 — restore focus after the text paste lands. Same rationale as
  // above: Ctrl+V hits the document keydown listener which fires AFTER
  // xterm's custom handler, so focus has typically drifted to <body>
  // by the time send() returns.
  refocusActiveTerm(sessionId);
}

async function uploadBlobToSession(sessionId, blob, mime, filename) {
  const sizeMb = (blob.size / (1024 * 1024)).toFixed(1);
  const label = filename || mime;
  showToast(`Pasting ${label} (${sizeMb} MB)…`, { id: 'paste-blob', type: 'info', duration: 8000 });
  try {
    const headers = { 'Content-Type': mime || 'application/octet-stream' };
    // X-Filename gives the server a hint; the sanitiser will strip
    // anything path-shaped, so dropping the source filename in raw
    // is safe (only the basename's safe chars survive).
    if (filename) headers['X-Filename'] = filename;
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/paste-blob`, {
      method: 'POST',
      headers,
      body: blob,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      const reason = json.error || `HTTP ${res.status}`;
      showToast(`Paste failed: ${reason}`, { id: 'paste-blob', type: 'error', duration: 4000 });
      return false;
    }
    showToast(`Pasted → ${json.path}`, { id: 'paste-blob', type: 'success', duration: 2500 });
    return true;
  } catch (e) {
    showToast(`Paste failed: ${e?.message || 'network error'}`, { id: 'paste-blob', type: 'error', duration: 4000 });
    return false;
  }
}

function openMenu(sessionId, anchor) {
  closeMenu();

  const rect = anchor?.getBoundingClientRect ? anchor.getBoundingClientRect() : pointRect(anchor.x, anchor.y);
  const menu = document.createElement('div');
  menu.className = 'fixed z-[400] min-w-[160px] bg-slate-800 border border-slate-700 rounded-lg shadow-xl shadow-black/40 py-1';

  const entry = state.terms.get(sessionId);
  const projects = state.cfg.projects || [];
  const hasSelection = !!entry?.term?.hasSelection();

  let html = '';

  html += `
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm ${hasSelection ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="copy" ${hasSelection ? '' : 'disabled'}>
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>
      Copy
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="paste">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/><path d="M8 2h6a2 2 0 0 1 2 2v6H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M8 10v4"/><path d="M12 14H4a2 2 0 0 0-2 2v2"/></svg></span>
      Paste
    </button>
    <div class="border-t border-slate-700/50 my-1"></div>`;

  // Project submenu items
  if (projects.length) {
    html += `<div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Move to project</div>`;
    html += `<div class="tmx-scroll py-0.5" style="max-height:10rem;overflow-y:auto">`;
    for (const p of projects) {
      const active = entry?.projectId === p.id;
      html += `<button class="menu-action flex items-center gap-2 w-full px-3 py-1.5 text-sm ${active ? 'text-blue-400' : 'text-slate-300'} hover:bg-slate-700 transition-colors text-left" data-action="project" data-project-id="${p.id}">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${projectColor(p)}"></span>
        ${esc(p.name)}${active ? ' ✓' : ''}
      </button>`;
    }
    html += `</div>`;
    if (entry?.projectId) {
      html += `<button class="menu-action flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-700 transition-colors text-left" data-action="unproject">
        <span class="w-2 h-2 rounded-full flex-shrink-0 border border-slate-600"></span>
        Remove from project
      </button>`;
    }
    html += `<div class="border-t border-slate-700/50 my-1"></div>`;
  }

  const muted = !!entry?.muted;
  html += `
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="rename">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></span>
      Rename
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="mute">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${muted
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>'}</svg></span>
      ${muted ? 'Unmute' : 'Mute'}
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="theme">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 20 4 4 0 0 1 0-8 4 4 0 0 0 0-8"/></svg></span>
      Theme
    </button>
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors text-left" data-action="refresh">
      <span class="flex-shrink-0 text-slate-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h4.5M20 20v-5h-4.5M4 9a9 9 0 0 1 15.36-5.36M20 15a9 9 0 0 1-15.36 5.36"/></svg></span>
      Refresh session
    </button>`;
  // Pause: present only when the underlying command is resumable.
  // Enabled only when a sessionToken has been captured by the agent —
  // pause without a token would silently degrade to delete, which is
  // unacceptable per the SPEC. The disabled-state tooltip names the
  // reason so the user isn't left guessing.
  const cmd = (state.cfg.commands || []).find(c => c.id === entry?.commandId);
  const canPause = !!(cmd && cmd.canResume && cmd.resumeCommand);
  if (canPause) {
    const pauseEnabled = !!entry?.hasToken;
    const pauseTitle = pauseEnabled
      ? 'End the live session and move it to Previous Sessions. You can resume it later.'
      : 'Pause unavailable until the agent emits a resumable session ID.';
    html += `
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm ${pauseEnabled ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 cursor-default'} transition-colors text-left" data-action="pause" title="${esc(pauseTitle)}" aria-label="${esc(pauseTitle)}" ${pauseEnabled ? '' : 'disabled'}>
      <span class="flex-shrink-0 ${pauseEnabled ? 'text-slate-400' : 'text-slate-600'}"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></span>
      Pause
    </button>`;
  }
  html += `
    <button class="menu-action flex items-center gap-2.5 w-full px-3 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors text-left" data-action="delete">
      <span class="flex-shrink-0 text-red-400"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span>
      Delete
    </button>`;

  menu.innerHTML = html;
  positionMenu(menu, rect);

  const onClick = async (e) => {
    const btn = e.target.closest('.menu-action');
    if (!btn) return;
    closeMenu();
    const action = btn.dataset.action;
    if (action === 'copy') {
      await copyTerminalSelection(sessionId);
    } else if (action === 'paste') {
      await pasteIntoTerminal(sessionId);
    } else if (action === 'rename') {
      startRename(sessionId);
    } else if (action === 'mute') {
      toggleMute(sessionId);
    } else if (action === 'refresh') {
      const re = state.terms.get(sessionId);
      if (re) send({ type: 'session.restart', id: sessionId, themeId: re.themeId, cols: re.term.cols, rows: re.term.rows });
    } else if (action === 'delete') {
      document.getElementById('session-list').dispatchEvent(
        new CustomEvent('session-delete', { detail: { id: sessionId } })
      );
    } else if (action === 'pause') {
      send({ type: 'session.pause', id: sessionId });
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

  const currentIsLight = isLightBg(entry.themeId);
  picker.innerHTML = state.themes.map(t => {
    const polarityFlip = isLightBg(t.id) !== currentIsLight;
    return `<div class="theme-pick px-3 py-2 cursor-pointer hover:bg-slate-700 transition-colors ${t.id === entry.themeId ? 'bg-blue-500/15 border-l-2 border-blue-400' : ''}" data-theme="${t.id}">
      <div class="text-sm text-slate-200 mb-1">${esc(t.name)}</div>
      <div class="text-[10px] font-mono leading-[1.4] whitespace-pre rounded overflow-hidden" style="background:${t.theme.background};padding:4px 6px"><span style="color:${t.theme.green}">~</span> <span style="color:${t.theme.blue}">src</span> <span style="color:${t.theme.foreground}">$ ls</span>\n<span style="color:${t.theme.yellow}">app.ts</span>  <span style="color:${t.theme.cyan}">utils.ts</span>  <span style="color:${t.theme.brightBlack}">README</span></div>${polarityFlip ? '<div class="text-[10px] text-slate-500 mt-1">Restart session to apply color mode</div>' : ''}
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

// Width of the OS scrollbar gutter, measured once. The real FitAddon fit
// subtracts this from the available width; the old estimate didn't, which is
// why it over-counted columns by 1-2.
let _sbWidth = null;
function scrollbarWidth() {
  if (_sbWidth != null) return _sbWidth;
  try {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;overflow-y:scroll;width:50px;height:50px;';
    document.body.appendChild(probe);
    _sbWidth = probe.offsetWidth - probe.clientWidth;
    probe.remove();
  } catch { _sbWidth = 0; }
  return _sbWidth;
}

export function estimateSize() {
  // The PTY spawns at this size BEFORE the real terminal mounts and fits, so
  // it's the width an agent's TUI first paints against. Every terminal shares
  // the single #terminals area, so if one is already live the new one will fit
  // to exactly its cols/rows — return that and skip the lossy guess entirely.
  // (An over-wide guess made Claude Code's input box paint one column too wide
  // and left the cursor offset; the later resize fixed the PTY, not the agent.)
  let active = null, anyFitted = null;
  for (const t of state.terms.values()) {
    if (!t?.term || !(t.term.cols > 0) || !(t.term.rows > 0)) continue;
    const size = { cols: t.term.cols, rows: t.term.rows };
    if (t.el?.classList?.contains('active')) active = size;
    anyFitted = anyFitted || size;
  }
  if (active || anyFitted) return active || anyFitted;

  // Cold start: nothing to measure. Replicate the real fit as closely as we
  // can — subtract the inset (4px each side) AND the scrollbar gutter the fit
  // removes, so we under- rather than over-estimate (under is harmless; the
  // first resize widens it, over leaves the agent painted too wide).
  const el = document.getElementById('terminals');
  const w = (el ? el.clientWidth : 0) - 8 - scrollbarWidth();
  const h = (el ? el.clientHeight : 0) - 8;
  // Menlo 13px: ~7.8px wide, ~17px tall.
  return { cols: Math.max(Math.floor(w / 7.8), 80), rows: Math.max(Math.floor(h / 17), 24) };
}

// --- Font-size clamp helper (Phase 9 — terminal display sizing) ---
//
// D-02 (CONTEXT.md): xterm font-size range 8..32px, step 1px, default 13px.
// This is a pure helper so it lives next to estimateSize. Anything that
// touches the font-size (the Settings stepper, the keyboard shortcut
// handler, the Terminal constructor) routes through here so the clamp +
// fallback behaviour is identical in every call site.
//
// Bad input (NaN / null / undefined / non-numeric / Infinity) → default.
// This is the cold-start guard: `state.cfg.terminalFontSize` may not have
// arrived yet when the first terminal mounts, and clampFontSize(undefined)
// returning 13 keeps the constructor happy without explicit `??` everywhere.

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 13;

export function clampFontSize(n) {
  const num = typeof n === 'string' ? Number(n) : n;
  if (typeof num !== 'number' || !Number.isFinite(num)) return FONT_SIZE_DEFAULT;
  const i = Math.floor(num);
  if (i < FONT_SIZE_MIN) return FONT_SIZE_MIN;
  if (i > FONT_SIZE_MAX) return FONT_SIZE_MAX;
  return i;
}

// Apply a new font-size to every open terminal AND broadcast the resulting
// resize to each PTY so the shell recomputes cols/rows. D-03: live apply
// to all open terminals globally (not per-session). The proposeDimensions
// guard mirrors doFit() so a font-size change that doesn't actually shift
// cols/rows (e.g. a tiny tweak inside the same character cell) skips the
// spurious PTY resize. Callers (Settings stepper, Ctrl+/- handler) pass
// any value; clampFontSize normalises it.
export function applyFontSize(px) {
  const size = clampFontSize(px);
  for (const [id, entry] of state.terms) {
    try {
      entry.term.options.fontSize = size;
      const dims = entry.fit.proposeDimensions();
      if (!dims) continue;
      const changed = dims.cols !== entry.term.cols || dims.rows !== entry.term.rows;
      entry.fit.fit();
      if (changed) {
        send({ type: 'resize', id, cols: entry.term.cols, rows: entry.term.rows });
      }
    } catch {
      // A single terminal in a bad state must not stop the loop — every
      // other open terminal still needs the new size applied.
    }
  }
  return size;
}

// --- Terminal management ---

export function addTerminal(id, name, themeId, commandId, projectId, muted, lastPreview, presetId, cwd) {
  if (state.terms.has(id)) return;
  themeId = themeId || state.cfg.defaultTheme || 'default';

  const item = document.createElement('div');
  item.className = 'group session-row flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors select-none';
  item.dataset.id = id;
  item.innerHTML = `
    <div class="session-icon w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden pointer-events-none" style="background:var(--color-session-icon-bg)">
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

  // Show saved preview from last session if available (survives reconnect/sleep)
  if (lastPreview) item.querySelector('.session-preview').textContent = lastPreview;

  document.getElementById('session-list').appendChild(item);
  const statusEl = item.querySelector('.session-status');
  const cmd = state.cfg.commands.find(c => c.id === commandId);
  const hasBridge = !!cmd?.bridge;
  const stopBounce = null;

  const el = document.createElement('div');
  el.className = 'term-wrap';
  el.style.backgroundColor = resolveTheme(themeId).background;
  document.getElementById('terminals').appendChild(el);

  const term = new Terminal({
    // Phase 9 (D-03): every new terminal reads the live config value so
    // it joins existing terminals at the user's chosen size. clampFontSize
    // returns the default 13 when state.cfg hasn't yet arrived (cold
    // start path), so no explicit guard is needed here.
    fontSize: clampFontSize(state.cfg?.terminalFontSize),
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: resolveTheme(themeId),
    // Keep ANSI/truecolor output readable across dark and light terminal themes.
    minimumContrastRatio: MIN_CONTRAST_RATIO,
    cursorBlink: true,
    scrollback: 10000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.onData(data => send({ type: 'input', id, data }));

  // [TRANSCRIPT-CAPTURE] initial settled capture plus one delayed idle save
  let _captureTimer = null, _renderSilent = false, _lastTyping = 0, _initialCaptureDone = false, _idleSaveTimer = null;
  function _sendCapture() {
    const entry = state.terms.get(id);
    if (!entry?.term) return;
    const buf = entry.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) { const line = buf.getLine(i); if (line) lines.push(line.translateToString(true)); }
    send({ type: 'terminal.buffer', id, lines });
  }
  function _isChrome(t) {
    return !t
      || /^[─━═\u2500-\u257f]+$/.test(t)
      || /^[▀▄█▌▐░▒▓╭╮╰╯│╔╗╚╝║]+$/.test(t)
      || (/[█▀▄▌▐░▒▓]/.test(t) && /^[█▀▄▌▐░▒▓\s]+$/.test(t))
      || /^[❯>$%#]\s*$/.test(t)
      || /^(esc to interrupt|\? for shortcuts)$/i.test(t);
  }
  function _hasContent() {
    const entry = state.terms.get(id);
    if (!entry?.term) return false;
    const buf = entry.term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true).trim();
      if (!_isChrome(text)) return true;
    }
    return false;
  }
  function _tryCapture() {
    const entry = state.terms.get(id);
    if (!_renderSilent || Date.now() - _lastTyping < 2000) return;
    // Initial capture: first time render settles with real content, capture regardless of working/idle
    if (!_initialCaptureDone) {
      if (!_hasContent()) return; // retry on next silence
      _initialCaptureDone = true;
      _sendCapture();
      return;
    }
  }
  term.onData(() => {
    _lastTyping = Date.now();
    // User typing invalidates pending capture — will re-try after silence
    _renderSilent = false;
    clearTimeout(_captureTimer);
    _captureTimer = setTimeout(() => { _renderSilent = true; _tryCapture(); }, 2000);
  });
  term.onRender(() => {
    _renderSilent = false;
    clearTimeout(_captureTimer);
    _captureTimer = setTimeout(() => { _renderSilent = true; _tryCapture(); }, 2000);
  });
  term.onWriteParsed(() => {
    if (Date.now() - _lastTyping < 500) return;
    const entry = state.terms.get(id);
    if (entry) entry.lastRenderAt = Date.now();
  });

  // Expose capture function so setStatus can schedule a retry
  setTimeout(() => {
    const e = state.terms.get(id);
    if (e) {
      e.tryCapture = _tryCapture;
      e.sendCaptureNow = _sendCapture;
      e.scheduleIdleCapture = () => {
        clearTimeout(_idleSaveTimer);
        _idleSaveTimer = setTimeout(() => {
          const entry = state.terms.get(id);
          if (!entry || entry.working) return;
          _sendCapture();
        }, 300);
      };
      e.cancelIdleCapture = () => clearTimeout(_idleSaveTimer);
    }
  }, 0);

  term.open(el);
  attachToTerminal(term, presetId);
  const linkProvider = addLinkProvider(term);

  // Drop overlay — covers the whole term-wrap with a modal-ish
  // dashed-border target during file drag. Hidden by default; the
  // `.drag-target` class on el reveals it. Lives inside el so it
  // moves with the active terminal.
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.innerHTML = `
    <div class="drop-overlay-card">
      <svg class="w-10 h-10 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <div class="drop-overlay-title">Drop to attach to session</div>
      <div class="drop-overlay-sub">File lands in <code>.clideck/paste/</code> and the path is typed into your prompt.</div>
    </div>`;
  el.appendChild(dropOverlay);
  const onContextMenu = (e) => {
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    select(id);
    openMenu(id, { x: e.clientX, y: e.clientY });
  };
  el.addEventListener('contextmenu', onContextMenu);

  // Auto-copy on drag-selection release. Plain click never reaches
  // `term.hasSelection()` truthy here, so the clipboard stays
  // untouched — selection requires a non-trivial drag.
  // Fixed-id toast dedupes rapid back-to-back copies into a single
  // resetting confirmation; see toast.js's `if (id) … remove()` path.
  const onPointerUp = async () => {
    if (!term.hasSelection()) return;
    if (await copyTerminalSelection(id)) {
      showToast('Copied', { id: 'terminal-copy', type: 'success', duration: 1200 });
    }
    // Defence-in-depth: a pointer-release that copied a selection
    // landed inside .xterm-screen, so focus is usually already on the
    // helper-textarea. But showToast mutates DOM and a subsequent
    // animation tick could shift activeElement — re-anchor focus.
    refocusActiveTerm(id);
  };
  el.addEventListener('pointerup', onPointerUp);

  // AC 4 — wider click target. A click anywhere over the .term-wrap
  // (the padded container around the xterm canvas) refocuses the
  // terminal. Previously the clickable hitbox was only the rendered
  // prompt row; mis-clicks landed on bare .term-wrap padding, focus
  // stayed wherever it was, and Enter went nowhere.
  //
  // Guards:
  //   - Skip when the click target is an interactive child
  //     (button, anchor, contenteditable, input, textarea, the
  //     drop-overlay card while a drag is being staged) — those
  //     widgets have their own focus semantics we mustn't trample.
  //   - Skip when xterm reports an active selection — the pointerup-
  //     copy path above is mutually exclusive with a plain click,
  //     but guarding here keeps the two handlers strictly separated
  //     (selection release → copy + refocus; plain click → refocus
  //     only).
  //
  // term.focus() is idempotent; clicking inside .xterm-screen when
  // the term already holds focus is a no-op.
  const onClickRefocus = (e) => {
    if (e.target.closest?.('button, a, [contenteditable="true"], input, textarea, .drop-overlay-card')) return;
    if (term.hasSelection()) return;
    term.focus();
  };
  el.addEventListener('click', onClickRefocus);

  // Drag-and-drop file upload. Files copied from File Explorer don't
  // put their bytes on the clipboard (only their path), so paste from
  // clipboard can't see them — D&D is the only path that gives us a
  // real File object. Drop anywhere on the terminal pane uploads each
  // dropped file via the same /sessions/:id/paste-blob endpoint the
  // clipboard-paste path uses.
  //
  // preventDefault on dragover is what tells the browser "this is a
  // valid drop target" — without it the browser navigates the tab to
  // the dropped file's content (the friction Lance hit during UAT).
  const onDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-target');
  };
  const onDragLeave = (e) => {
    // Only clear the highlight when the cursor actually exits el.
    // Dragging over child xterm elements fires dragleave on el even
    // though we're still inside; check relatedTarget.
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-target');
  };
  const onDrop = async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    el.classList.remove('drag-target');
    const files = [...e.dataTransfer.files];
    for (const file of files) {
      await uploadBlobToSession(id, file, file.type || 'application/octet-stream', file.name);
    }
    // AC 2 — restore focus after drag-and-drop teardown. The browser's
    // drag-drop pipeline ends with focus on <body>; without this the
    // user's next Enter is swallowed until they click the prompt row.
    refocusActiveTerm(id);
  };
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);
  let fitted = false, pending = [];
  // [FIT-GUARD] only call fit() when proposed dimensions actually change — prevents
  // unnecessary buffer reflows that cause scrollbar jumpiness on sub-pixel layout shifts
  let fitRaf = 0;
  function doFit() {
    const dims = fit.proposeDimensions();
    if (!dims || (dims.cols === term.cols && dims.rows === term.rows)) return;
    fit.fit();
    send({ type: 'resize', id, cols: term.cols, rows: term.rows });
  }
  const ro = new ResizeObserver(() => {
    if (!el.offsetWidth) return;
    if (!fitted) {
      fitted = true;
      fit.fit();
      send({ type: 'resize', id, cols: term.cols, rows: term.rows });
      for (const chunk of pending) term.write(chunk);
      pending = null;
      updatePreview(id);
      return;
    }
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => { fitRaf = 0; doFit(); });
  });
  ro.observe(el);
  // Safety: if RO hasn't fired within 500ms, let visible terminals proceed.
  // For hidden/unmeasured terminals, keep the PTY at a reasonable fallback size
  // but do not flush queued output until a real measured fit happens; replaying
  // buffered output into fake geometry is what leaves the rebuilt terminal messy
  // after refresh/logout/login.
  setTimeout(() => {
    if (!fitted) {
      if (!el.offsetWidth) {
        term.resize(120, 30);
        send({ type: 'resize', id, cols: 120, rows: 30 });
        return;
      }
      fitted = true;
      for (const chunk of pending) term.write(chunk);
      pending = null;
      updatePreview(id);
    }
  }, 500);
  const cancelFitRaf = () => { if (fitRaf) { cancelAnimationFrame(fitRaf); fitRaf = 0; } };
  state.terms.set(id, { term, fit, el, ro, cancelFitRaf, onContextMenu, onPointerUp, onClickRefocus, onDragOver, onDragLeave, onDrop, linkProvider, themeId, commandId, presetId: presetId || null, projectId: projectId || null, muted: !!muted, cwd: cwd || '', working: false, workStartedAt: null, stopBounce, queue: (data) => { if (!fitted) { pending.push(data); return true; } return false; }, lastActivityAt: Date.now(), unread: false, lastPreviewText: lastPreview || '', searchText: '', hasToken: false });
  document.getElementById('empty').style.display = 'none';
  document.getElementById('terminals').style.pointerEvents = '';
  if (muted) requestAnimationFrame(() => updateMuteIndicator(id));

  regroupSessions();
}

export function removeTerminal(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  if (entry.stopBounce) entry.stopBounce();
  entry.cancelFitRaf?.();
  entry.ro?.disconnect();
  entry.el.removeEventListener?.('contextmenu', entry.onContextMenu);
  if (entry.onPointerUp) entry.el.removeEventListener?.('pointerup', entry.onPointerUp);
  if (entry.onClickRefocus) entry.el.removeEventListener?.('click', entry.onClickRefocus);
  if (entry.onDragOver) entry.el.removeEventListener?.('dragover', entry.onDragOver);
  if (entry.onDragLeave) entry.el.removeEventListener?.('dragleave', entry.onDragLeave);
  if (entry.onDrop) entry.el.removeEventListener?.('drop', entry.onDrop);
  entry.linkProvider?.dispose?.();
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
  closeDropdown();
  closePillLog();
  document.querySelectorAll('.pill-row.active-session').forEach(r => r.classList.remove('active-session'));

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
    // Was: `if (!document.querySelector('[contenteditable="true"]')) entry.term.focus();`.
    // The new refocusActiveTerm() extends the same guard to inputs/
    // textareas/selects/combobox + visible modals/overlays. state.active
    // hasn't been updated yet at this point, so pass the explicit id.
    refocusActiveTerm(id);
  }
  state.active = id;
}

// --- Preview & status ---

// Rebuild state.terms (and state.resumable) to match a new id sequence.
// Used by the drag-to-reorder flow: drag emits `session.reorder`, server
// broadcasts back, this handler applies the order. Entries not mentioned
// in `ids` are appended at the end so an out-of-date client never loses
// rows the server didn't bother to enumerate.
export function reorderTerms(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const seenLive = new Set();
  const rebuilt = new Map();
  for (const id of ids) {
    if (state.terms.has(id) && !seenLive.has(id)) {
      rebuilt.set(id, state.terms.get(id));
      seenLive.add(id);
    }
  }
  for (const [id, entry] of state.terms) {
    if (!seenLive.has(id)) rebuilt.set(id, entry);
  }
  state.terms = rebuilt;

  const idx = new Map(state.resumable.map((r, i) => [r.id, i]));
  const seenDormant = new Set();
  const rebuiltResumable = [];
  for (const id of ids) {
    if (idx.has(id) && !seenDormant.has(id)) {
      rebuiltResumable.push(state.resumable[idx.get(id)]);
      seenDormant.add(id);
    }
  }
  for (const r of state.resumable) {
    if (!seenDormant.has(r.id)) rebuiltResumable.push(r);
  }
  state.resumable = rebuiltResumable;

  regroupSessions();
}

// Update a session entry's hasToken state — drives the Pause menu
// item's enabled / disabled appearance. Called by app.js when the
// server announces a token capture (`session.token` broadcast) and
// on initial `sessions` / `created` broadcasts that include the
// hasToken field. The menu reads this lazily when opened, so the
// next open after a capture reflects the new state — no live
// re-render needed.
export function setHasToken(id, hasToken) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.hasToken = !!hasToken;
}

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
    // Persist preview on server — picked up by 30s auto-save
    send({ type: 'session.setPreview', id, text: last, timestamp: new Date().toISOString() });
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

// Platform-specific marker alternatives.
// Claude Code uses ⏺ (U+23FA) on Mac but ● (U+25CF) on Windows.
const MARKER_ALTS = { '\u23FA': ['\u23FA', '\u25CF'] };

function readLastAgentLine(term, commandId) {
  const marker = state.cfg.commands.find(c => c.id === commandId)?.outputMarker;
  if (!marker) return '';
  const markers = MARKER_ALTS[marker] || [marker];
  const buf = term.buffer.active;
  for (let y = buf.baseY + buf.cursorY; y >= 0; y--) {
    const text = readLineText(buf, y).trim();
    if (!text) continue;
    const match = markers.find(m => text.startsWith(m));
    if (!match) continue;
    const content = text.slice(match.length).trim();
    if (content) return content;
  }
  return '';
}

function setStatus(id, working) {
  const entry = state.terms.get(id);
  if (!entry || entry.working === working) return;

  const wasWorking = entry.working;
  entry.working = working;

  // Notify on working → idle transition
  if (wasWorking && !working && !entry.muted) {
    const minWork = state.cfg.notifyMinWork ?? 0;
    const workDuration = (Date.now() - (entry.workStartedAt || 0)) / 1000;
    if (workDuration >= minWork) {
      entry.workStartedAt = null;
      // Sound: all sessions when tab unfocused, all except active when focused
      if (state.cfg.notifySoundEnabled !== false && (!document.hasFocus() || state.active !== id)) {
        new Audio(`/fx/${(state.cfg.notifySound || 'default-beep')}.mp3`).play().catch(() => {});
      }
      // Browser notification: plays when the CliDeck tab is not focused
      if (state.cfg.notifyIdle && !document.hasFocus()
          && 'Notification' in window && Notification.permission === 'granted') {
        const sessionName = document.querySelector(`.group[data-id="${id}"] .name`)?.textContent || 'Session';
        const proj = state.cfg.projects?.find(p => p.id === entry.projectId);
        const title = proj ? `${proj.name}: ${sessionName}` : sessionName;
        const n = new Notification(title, { body: `Is now idle.\n${entry.lastPreviewText || ''}`, icon: '/img/clideck-logo-icon.png', tag: id });
        n.onclick = () => { window.focus(); select(id); n.close(); };
      }
    }
  }

  // Save once shortly after idle unless the agent resumes first.
  // Also fire the unread dot here — the unread state means "an idle
  // session has output you haven't seen", which is precisely the
  // working→idle edge. Anchoring it to this transition (rather than
  // every output chunk) keeps the dot mutually exclusive with the
  // bouncing "working" indicator on the row's left side.
  if (wasWorking && !working) {
    entry.scheduleIdleCapture?.();
    if (id !== state.active) markUnread(id);
  }

  if (working) {
    entry.cancelIdleCapture?.();
    if (!entry.workStartedAt) entry.workStartedAt = Date.now();
    // Idle→working: hide any stale unread dot. The dot's contract is
    // "idle and unattended"; once the session is working, that meaning
    // no longer applies. If output remains unread after this work
    // cycle, the working→idle branch above will re-set the dot.
    if (!wasWorking && entry.unread) {
      entry.unread = false;
      document.querySelector(`.group[data-id="${id}"] .unread-dot`)?.classList.add('hidden');
      updateUnreadBadge();
    }
  }

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

// --- Mute ---

const MUTE_SVG = `<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;

function toggleMute(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.muted = !entry.muted;
  send({ type: 'session.mute', id, muted: entry.muted });
  updateMuteIndicator(id);
}

function updateMuteIndicator(id) {
  const entry = state.terms.get(id);
  if (!entry) return;
  const row = document.querySelector(`.group[data-id="${id}"]`);
  if (!row) return;
  let icon = row.querySelector('.mute-icon');
  if (entry.muted) {
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'mute-icon flex-shrink-0 text-slate-600';
      icon.innerHTML = MUTE_SVG;
      const dot = row.querySelector('.unread-dot');
      dot.parentNode.insertBefore(icon, dot);
    }
  } else {
    icon?.remove();
  }
}

// --- Theme ---

export function setSessionTheme(id, themeId, { showBanner = true } = {}) {
  const entry = state.terms.get(id);
  if (!entry) return;
  const oldLight = isLightBg(entry.themeId);
  const newLight = isLightBg(themeId);
  entry.themeId = themeId;
  applyTheme(entry.term, themeId);
  entry.el.style.backgroundColor = resolveTheme(themeId).background;
  send({ type: 'session.theme', id, themeId });
  if (showBanner && oldLight !== newLight) showRestartBanner(id, themeId);
  else hideRestartBanner(id);
}

function showRestartBanner(id, themeId) {
  const group = document.querySelector(`.group[data-id="${id}"]`);
  if (!group || group.querySelector('.restart-banner')) return;
  const entry = state.terms.get(id);
  if (!entry) return;
  const mode = isLightBg(themeId) ? 'light' : 'dark';
  const banner = document.createElement('div');
  banner.className = 'restart-banner flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-blue-400 cursor-pointer hover:text-blue-300 transition-colors';
  banner.style.marginLeft = '2.75rem'; // align with text (past icon)
  banner.innerHTML = `<svg class="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h4.5M20 20v-5h-4.5M4 9a9 9 0 0 1 15.36-5.36M20 15a9 9 0 0 1-15.36 5.36"/></svg><span>Restart to apply ${mode} theme</span>`;
  banner.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('[restart] click banner, sending session.restart', { id, themeId: entry.themeId });
    send({ type: 'session.restart', id, themeId: entry.themeId, cols: entry.term.cols, rows: entry.term.rows });
  });
  group.appendChild(banner);
}

function hideRestartBanner(id) {
  document.querySelector(`.group[data-id="${id}"] .restart-banner`)?.remove();
}

export function restartComplete(id, msg) {
  hideRestartBanner(id);
  const entry = state.terms.get(id);
  if (!entry) return;
  entry.term.clear();
  if (state.active !== id) select(id);
  else entry.term.focus();
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
const PATH_SVG = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.379a1.5 1.5 0 0 1 1.06.44l1.122 1.12a1.5 1.5 0 0 0 1.06.44H19.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"/></svg>`;

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
  // Remove old project headers, resumable rows, pill rows, and resumable section
  list.querySelectorAll('.project-group').forEach(el => el.remove());
  list.querySelectorAll('.pill-row').forEach(el => el.remove());
  list.querySelectorAll('[data-resumable-id]').forEach(el => el.remove());
  document.getElementById('resumable-section')?.remove();

  // Render project groups
  for (const proj of projects) {
    const header = document.createElement('div');
    header.className = 'project-group';
    header.dataset.projectId = proj.id;

    const collapsed = proj.collapsed;
    header.innerHTML = `
      <div class="group project-header flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer hover:bg-slate-800/30 transition-colors select-none" data-project-id="${proj.id}" style="background:var(--color-project-header-bg)">
        <span class="project-chevron ${collapsed ? 'collapsed' : ''} text-slate-500">${CHEVRON_SVG}</span>
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${projectColor(proj)}"></span>
        <span class="project-name flex-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 truncate">${esc(proj.name)}</span>
        <span class="project-count text-[10px] text-slate-600">0</span>
        <button class="project-path-btn ${proj.path ? 'text-slate-600 hover:text-slate-300' : 'text-slate-700 cursor-default'} flex-shrink-0 p-0.5" title="${proj.path ? 'Open project folder' : 'Project path not set'}" ${proj.path ? '' : 'disabled'}>
          ${PATH_SVG}
        </button>
        <span class="project-plugin-actions"></span>
        <button class="project-menu-btn text-slate-600 hover:text-slate-400 flex-shrink-0 p-0.5" title="Project menu">
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

  // Place pill rows at top of their project groups, or ungrouped at top
  const ungroupedPills = [];
  for (const [, pill] of state.pills) {
    if (pill.projectId) {
      const container = list.querySelector(`.project-group[data-project-id="${pill.projectId}"] .project-sessions`);
      if (container) { container.insertBefore(buildPillRow(pill), container.firstChild); continue; }
    }
    ungroupedPills.push(pill);
  }
  for (const pill of ungroupedPills) list.insertBefore(buildPillRow(pill), firstGroup);

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
    section.innerHTML = `<div class="resumable-header group flex items-center gap-1.5 px-2.5 py-2 mt-1 border-t border-slate-700/50">
      <span class="flex-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Previous Sessions</span>
      <button class="prev-sessions-menu-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-slate-400 flex-shrink-0 transition-opacity p-0.5" title="Previous sessions menu">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20"><circle cx="10" cy="4" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="16" r="1.5" fill="currentColor"/></svg>
      </button>
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
  list.dispatchEvent(new Event('projects-rendered'));
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
    <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden opacity-40" style="background:var(--color-session-icon-bg)">
      ${iconHtml(s.commandId)}
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2">
        <span class="resumable-name flex-1 font-semibold text-[13px] text-slate-400 truncate">${esc(s.name)}</span>
        <span class="text-[11px] text-slate-600 flex-shrink-0">${time}</span>
      </div>
      <div class="flex items-center gap-1 mt-0.5">
        <span class="flex-1 text-xs text-slate-600 truncate">${s.lastPreview ? esc(s.lastPreview) : esc(label) + (path ? ' · ' + esc(path) : '')}</span>
        <button class="resumable-menu-btn opacity-0 group-hover:opacity-100 text-slate-600 hover:text-slate-300 flex-shrink-0 transition-opacity p-0.5" title="Rename or delete">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20"><circle cx="10" cy="4" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="16" r="1.5" fill="currentColor"/></svg>
        </button>
        <button class="resume-btn opacity-60 group-hover:opacity-100 text-slate-500 hover:text-emerald-400 flex-shrink-0 transition-all flex items-center gap-0.5 text-[11px] font-medium" title="Resume session">
          Resume${RESUME_SVG}
        </button>
      </div>
    </div>`;
  return row;
}

// In-place rename for a resumable ("Previous Sessions") row, mirroring
// startRename for active sessions but addressing the resumable-row DOM
// and routing to the new `resumable.rename` server handler.
export function startResumableRename(id) {
  const el = document.querySelector(`[data-resumable-id="${id}"] .resumable-name`);
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
    if (cancelled) { el.textContent = original; return; }
    const name = el.textContent.trim() || original;
    el.textContent = name;
    if (name !== original) send({ type: 'resumable.rename', id, name });
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { cancelled = true; el.blur(); }
  };
  el.addEventListener('blur', finish, { once: true });
  el.addEventListener('keydown', onKey);
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
    const tx = (state.transcriptCache?.[row.dataset.resumableId] || '').toLowerCase();
    row.style.display = !q || name.includes(q) || tx.includes(q) ? '' : 'none';
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
    btn.style.background = !active && btn.dataset.tab === 'unread' ? 'var(--color-filter-unread-bg)' : '';
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

// Refresh pill elapsed times every second
setInterval(() => {
  for (const [, pill] of state.pills) {
    if (!pill.startedAt) continue;
    const el = document.querySelector(`.pill-row[data-pill-id="${pill.id}"] .pill-elapsed`);
    if (el) el.textContent = formatElapsed(pill.startedAt);
  }
}, 1000);

// --- Session pills (plugin virtual rows) ---

export function addPill(pill) {
  state.pills.set(pill.id, { ...pill, logs: [] });
  regroupSessions();
}

export function updatePill(pill) {
  const p = state.pills.get(pill.id);
  if (!p) return;
  Object.assign(p, pill);
  const row = document.querySelector(`.pill-row[data-pill-id="${pill.id}"]`);
  if (!row) return;
  const statusEl = row.querySelector('.pill-status');
  if (statusEl) {
    statusEl.textContent = pill.statusText || (pill.working ? '' : 'idle');
    statusEl.className = `pill-status text-xs truncate ${pill.working ? 'text-emerald-400' : 'text-slate-600'}`;
  }
  const animEl = row.querySelector('.pill-anim');
  if (animEl) {
    if (pill.working) {
      if (!animEl.children.length) { animEl._stop = startBounce(animEl); }
    } else {
      if (animEl._stop) { animEl._stop(); animEl._stop = null; }
      animEl.innerHTML = '<span class="text-[11px] text-slate-600 dormant">z<sup>z</sup>Z</span>';
    }
  }
}

export function removePill(id) {
  state.pills.delete(id);
  document.querySelector(`.pill-row[data-pill-id="${id}"]`)?.remove();
  // If this pill's log panel is open, close it
  if (state.activePill === id) closePillLog();
  regroupSessions();
}

export function appendPillLog(id, entry) {
  const p = state.pills.get(id);
  if (!p) return;
  p.logs.push(entry);
  if (p.logs.length > 200) p.logs.splice(0, p.logs.length - 200);
  // If log panel is open for this pill, append line
  if (state.activePill === id) appendLogLine(entry);
}

function pillColors() {
  const light = document.documentElement.classList.contains('light');
  return { bg: light ? '#e0fcd7' : '#2a4a30', accent: light ? '#4a8c3f' : '#54ab63' };
}

const PILL_CLOCK_SVG = `<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
const PILL_BOT_SVG = `<svg class="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m-3 4h6m-8 0a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H7z"/><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1" fill="currentColor" stroke="none"/></svg>`;

function formatElapsed(startedAt) {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 0) return '0s';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d >= 2) return `${d}d ${h}h`;
  if (m >= 91) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function buildPillRow(pill) {
  const { bg, accent } = pillColors();
  const row = document.createElement('div');
  row.className = 'pill-row group flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors select-none';
  row.dataset.pillId = pill.id;
  const elapsed = pill.startedAt ? formatElapsed(pill.startedAt) : '';
  row.innerHTML = `
    <div class="session-icon w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden pointer-events-none" style="background:${bg}">
      <div class="relative w-full h-full flex items-center justify-center">
        <div class="absolute" style="top:2px;left:3px;color:${accent}">${PILL_CLOCK_SVG}</div>
        <div class="absolute bottom-0 right-0 w-3.5 h-3.5 rounded-full flex items-center justify-center border border-slate-900" style="background:${accent};color:#fff">${PILL_BOT_SVG}</div>
      </div>
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-2">
        <span class="flex-1 font-semibold text-[13px] text-slate-300 truncate">${esc(pill.title)}</span>
        <span class="pill-elapsed text-[11px] text-slate-600 flex-shrink-0">${elapsed}</span>
      </div>
      <div class="flex items-center gap-1.5 mt-0.5">
        <span class="pill-anim flex-shrink-0 leading-none"></span>
        <span class="pill-status text-xs truncate ${pill.working ? 'text-emerald-400' : 'text-slate-600'}">${pill.statusText || (pill.working ? '' : 'idle')}</span>
      </div>
    </div>`;

  // Init animation state
  const animEl = row.querySelector('.pill-anim');
  if (pill.working) {
    animEl._stop = startBounce(animEl);
  } else {
    animEl.innerHTML = '<span class="text-[11px] text-slate-600 dormant">z<sup>z</sup>Z</span>';
  }

  row.addEventListener('click', () => selectPill(pill.id));
  return row;
}

function selectPill(id) {
  // Deselect any active terminal
  const prev = document.querySelector('.group.active-session');
  if (prev) prev.classList.remove('active-session');
  document.querySelector('.term-wrap.active')?.classList.remove('active');

  // Highlight pill row
  document.querySelectorAll('.pill-row').forEach(r => r.classList.remove('active-session'));
  document.querySelector(`.pill-row[data-pill-id="${id}"]`)?.classList.add('active-session');

  state.active = null;
  openPillLog(id);
}

function openPillLog(id) {
  const pill = state.pills.get(id);
  if (!pill) return;
  state.activePill = id;

  // Request full logs from server
  send({ type: 'pill.getLogs', id });

  // Create or show log panel
  let panel = document.getElementById('pill-log-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'pill-log-panel';
    panel.className = 'term-wrap active';
    panel.innerHTML = `
      <div class="flex flex-col h-full bg-slate-900 rounded-lg overflow-hidden">
        <div class="pill-log-header flex items-center gap-2 px-4 py-2 border-b border-slate-700/50">
          <span class="pill-log-title font-semibold text-sm text-slate-300"></span>
          <span class="flex-1"></span>
          <button class="pill-log-clear text-[11px] text-slate-600 hover:text-slate-400 transition-colors">Clear</button>
        </div>
        <div class="pill-log-body flex-1 overflow-y-auto p-4 text-xs leading-relaxed tmx-scroll"></div>
      </div>`;
    document.getElementById('terminals').appendChild(panel);
    panel.querySelector('.pill-log-clear').addEventListener('click', () => {
      panel.querySelector('.pill-log-body').innerHTML = '';
    });
  } else {
    panel.classList.add('active');
  }

  panel.querySelector('.pill-log-title').textContent = pill.title;
  const body = panel.querySelector('.pill-log-body');
  body.innerHTML = '';
  for (const entry of pill.logs) appendLogLine(entry);

  // Hide empty state
  document.getElementById('empty').style.display = 'none';
  document.getElementById('terminals').style.pointerEvents = '';
}

export function setPillLogs(id, logs) {
  const pill = state.pills.get(id);
  if (!pill) return;
  pill.logs = logs;
  if (state.activePill !== id) return;
  const body = document.querySelector('#pill-log-panel .pill-log-body');
  if (!body) return;
  body.innerHTML = '';
  for (const entry of logs) appendLogLine(entry);
}

function appendLogLine(entry) {
  const body = document.querySelector('#pill-log-panel .pill-log-body');
  if (!body) return;
  body.querySelectorAll('.pill-log-live').forEach(el => el.classList.remove('pill-log-live'));
  const line = document.createElement('div');
  const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const t = entry.text;

  // Categorize log entries for visual treatment
  let color = 'text-slate-400';
  let icon = '';
  let content = esc(t);
  if (/^Started with/.test(t)) {
    color = 'text-emerald-400';
    icon = '<span class="text-emerald-500">&#9654;</span>';
  } else if (/^Routed /.test(t)) {
    color = 'text-indigo-400';
    icon = '<span class="text-indigo-500">&#8594;</span>';
  } else if (/^Notify:/.test(t)) {
    color = 'text-amber-300';
    icon = '<span class="text-amber-500">&#9679;</span>';
    content = '<strong class="text-amber-300">Notify:</strong> ' + miniMarkdown(t.replace(/^Notify:\s*/, ''));
  } else if (/^Consulting /.test(t)) {
    color = 'text-slate-500';
    icon = '<span class="text-slate-600">&#8230;</span>';
  } else if (/→ working$/.test(t)) {
    color = 'text-blue-400';
    icon = '<span class="pill-log-icon text-blue-500">&#9679;</span>';
  } else if (/→ idle$/.test(t)) {
    color = 'text-slate-500';
    icon = '<span class="text-slate-600">&#9675;</span>';
  } else if (/^Completed$/.test(t)) {
    color = 'text-emerald-400';
    icon = '<span class="text-emerald-500">&#10003;</span>';
  } else if (/^Stopped$/.test(t)) {
    color = 'text-slate-500';
    icon = '<span class="text-slate-600">&#9632;</span>';
  } else if (/^Paused/.test(t)) {
    color = 'text-amber-400';
    icon = '<span class="text-amber-500">&#9646;&#9646;</span>';
  }

  line.className = 'flex gap-3 py-1 items-start';
  if (/→ working$/.test(t)) line.classList.add('pill-log-live');
  line.innerHTML = `<span class="text-slate-600 flex-shrink-0 tabular-nums">${time}</span><span class="w-4 flex-shrink-0 text-center">${icon}</span><span class="${color} leading-relaxed">${content}</span>`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

const pillLogStyle = document.createElement('style');
pillLogStyle.textContent = `
  @keyframes pill-log-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.9); }
  }
  .pill-log-live .pill-log-icon {
    display: inline-block;
    animation: pill-log-pulse 1s ease-in-out infinite;
  }
`;
document.head.appendChild(pillLogStyle);

export function closePillLog() {
  state.activePill = null;
  const panel = document.getElementById('pill-log-panel');
  if (panel) panel.classList.remove('active');
}

export { openMenu, closeMenu, setStatus, updateMuteIndicator, positionMenu, PROJECT_COLORS };

// Clear active terminal scrollback — Cmd+K (macOS), Ctrl+Shift+K (Windows/Linux)
const clearTerminal = () => {
  const entry = state.active && state.terms.get(state.active);
  if (entry) entry.term.clear();
};
registerHotkey('core', 'Cmd+K', clearTerminal);
registerHotkey('core', 'Ctrl+Shift+K', clearTerminal);

// Paste clipboard into active terminal — Ctrl+V (Windows/Linux), Cmd+V (macOS).
// xterm.js doesn't bind Ctrl+V by default; without this it falls through to
// the PTY as raw ^V (0x16) and does nothing, which also breaks dictation
// tools that synthesize Ctrl+V to deliver transcribed text. Right-click
// Paste and Shift+Insert already work; this brings the conventional
// shortcut into line.
const pasteActive = () => {
  if (state.active) pasteIntoTerminal(state.active);
};
registerHotkey('core', 'Ctrl+V', pasteActive);

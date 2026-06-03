// public/js/sidebar-resize.js
//
// Phase 9 (terminal-display-sizing), PLAN-sidebar — owns the drag-resize
// behavior for the left sidebar. The module is wired by app.js once at
// startup via init(); after that it manages everything autonomously:
//
//   - DOM listener block on #sidebar-resize-gutter (pointerdown / move /
//     up, dblclick).
//   - rAF-throttled live reflow of #sidebar width + xterm fit during
//     drag (D-07 — no PTY resize during drag, only on release).
//   - DOMContentLoaded paint-hint reading localStorage so the sidebar
//     appears at the user's chosen width on first paint (D-06).
//   - applySidebarWidth(px) for case 'config' in app.js to re-sync
//     when a config broadcast arrives.

import { state, send } from './state.js';

const PAINT_HINT_KEY = 'clideck.sidebarWidth';
const MOBILE_BREAKPOINT = 960;

// D-08: range bounds. Hard max is 640px; dynamic max is min(hard, 50vw)
// so very narrow viewports still cap at half-viewport. Default/reset
// is 354 (the historical fixed width).
export const SIDEBAR_WIDTH_MIN = 280;
export const SIDEBAR_WIDTH_MAX_HARD = 640;
export const SIDEBAR_WIDTH_DEFAULT = 354;

// Pure: (px, viewportWidth) -> integer in [SIDEBAR_WIDTH_MIN,
//                                          min(SIDEBAR_WIDTH_MAX_HARD,
//                                              floor(viewportWidth * 0.5))].
// Bad first arg → default. Non-finite viewport → use hard max only
// (defensive; production always has a finite viewport).
//
// Floors non-integer numeric input; coerces numeric strings. Mirrors
// the contract style of clampFontSize so the two clamps read identically.
export function clampSidebarWidth(px, viewportWidth) {
  const num = typeof px === 'string' ? Number(px) : px;
  if (typeof num !== 'number' || !Number.isFinite(num)) return SIDEBAR_WIDTH_DEFAULT;
  const i = Math.floor(num);
  const vw = typeof viewportWidth === 'number' && Number.isFinite(viewportWidth)
    ? viewportWidth
    : null;
  const dynamicCap = vw != null ? Math.floor(vw * 0.5) : SIDEBAR_WIDTH_MAX_HARD;
  const effectiveMax = Math.min(SIDEBAR_WIDTH_MAX_HARD, dynamicCap);
  if (i < SIDEBAR_WIDTH_MIN) return SIDEBAR_WIDTH_MIN;
  if (i > effectiveMax) return effectiveMax;
  return i;
}

// Apply a new sidebar width to the DOM AND mirror it to localStorage as
// the paint-hint cache (D-06). Does NOT re-fit terminals — that's the
// caller's job after this returns (drag-end runs fit() THEN sends PTY
// resize; case 'config' in app.js runs fit() via the xterm ResizeObserver
// triggered by the layout change). Returns the clamped value so callers
// can persist exactly what was applied.
export function applySidebarWidth(px) {
  const clamped = clampSidebarWidth(px, window.innerWidth);
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.width = clamped + 'px';
  }
  try {
    localStorage.setItem(PAINT_HINT_KEY, String(clamped));
  } catch {
    // localStorage can throw in private-browsing / quota cases. The
    // sidebar width still applies; only the paint-hint cache is lost.
    // Next reload will show the cold-start default until config arrives.
  }
  return clamped;
}

// Iterate every open terminal and trigger a fit() + send PTY resize.
// This is the "user committed a new width" hook called by drag-end and
// dblclick. During pointermove we only fit() (no PTY send) — the PTY
// resize is exclusively here, per D-07 to avoid SIGWINCH spam.
function refitAllTerminalsAndNotifyPTYs() {
  for (const [id, entry] of state.terms) {
    try {
      entry.fit.fit();
      send({ type: 'resize', id, cols: entry.term.cols, rows: entry.term.rows });
    } catch {
      // A single broken terminal shouldn't stop the loop.
    }
  }
}

// Live reflow during drag — fit each open terminal so the xterm renderer
// reflows immediately. Throttled to one update per animation frame so a
// flurry of pointermove events doesn't trigger N fits per frame.
let _fitRaf = 0;
function scheduleLiveFit() {
  if (_fitRaf) return;
  _fitRaf = requestAnimationFrame(() => {
    _fitRaf = 0;
    for (const [, entry] of state.terms) {
      try {
        entry.fit.fit();
      } catch {
        // ignore — see refitAllTerminalsAndNotifyPTYs
      }
    }
  });
}

// Persist the user's chosen width to config.json. Reuses the existing
// {type:'config.update'} round-trip so the server-side save path is
// identical to every other settings save. Mirrors to localStorage too —
// applySidebarWidth already does that, but on drag-end we have the
// authoritative final value and want to re-mirror to be sure.
function persistWidth(clamped) {
  state.cfg.sidebarWidth = clamped;
  try { localStorage.setItem(PAINT_HINT_KEY, String(clamped)); } catch { /* see applySidebarWidth */ }
  send({ type: 'config.update', config: state.cfg });
}

// --- Drag state (module-level singletons; only one drag at a time) ---
let _dragStartX = 0;
let _dragStartWidth = 0;
let _activePointerId = null;

function isMobileBreakpoint() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

function onPointerDown(e) {
  if (isMobileBreakpoint()) return; // D-10: gutter inert on mobile
  if (e.button !== undefined && e.button !== 0) return; // primary button only
  const gutter = e.currentTarget;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  e.preventDefault();
  try { gutter.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
  _activePointerId = e.pointerId;
  _dragStartX = e.clientX;
  // Use getBoundingClientRect for the live width (handles the case
  // where the sidebar is still at its Tailwind w-[354px] before any
  // inline style was applied).
  _dragStartWidth = sidebar.getBoundingClientRect().width;
  gutter.classList.add('dragging');
  document.body.classList.add('sidebar-resizing');
}

function onPointerMove(e) {
  if (_activePointerId == null || e.pointerId !== _activePointerId) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const desired = _dragStartWidth + (e.clientX - _dragStartX);
  const next = clampSidebarWidth(desired, window.innerWidth);
  sidebar.style.width = next + 'px';
  // D-07: live visual reflow ONLY. No PTY resize during drag.
  scheduleLiveFit();
}

function endDrag(e) {
  if (_activePointerId == null) return;
  if (e && e.pointerId !== _activePointerId) return;
  const gutter = document.getElementById('sidebar-resize-gutter');
  try { gutter?.releasePointerCapture(_activePointerId); } catch { /* old browsers */ }
  _activePointerId = null;
  if (gutter) gutter.classList.remove('dragging');
  document.body.classList.remove('sidebar-resizing');
  // Cancel any pending live fit; final fit happens below alongside the
  // PTY resize so xterm cols/rows and PTY cols/rows agree on the
  // authoritative final width.
  if (_fitRaf) { cancelAnimationFrame(_fitRaf); _fitRaf = 0; }

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const finalWidth = clampSidebarWidth(
    parseFloat(sidebar.style.width) || sidebar.getBoundingClientRect().width,
    window.innerWidth
  );
  // Snap any rounding drift to the clamped int.
  sidebar.style.width = finalWidth + 'px';
  refitAllTerminalsAndNotifyPTYs(); // D-07: PTY resize on release ONLY
  persistWidth(finalWidth);
}

function onDoubleClick(e) {
  if (isMobileBreakpoint()) return;
  e.preventDefault();
  // Treat as a single "commit-new-width" event: snap to default, fit,
  // tell PTYs, persist.
  applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  refitAllTerminalsAndNotifyPTYs();
  persistWidth(SIDEBAR_WIDTH_DEFAULT);
}

// Apply the localStorage paint-hint synchronously as soon as the module
// runs. This MUST happen before xterm mounts and before the config WS
// broadcast arrives — otherwise the sidebar paints at the cold-start
// 354 default and then snaps to the user's chosen width, violating
// AC 7 ("applies before first paint, no visible jump").
//
// app.js imports this module at the top of its import block, so the
// import (and this top-level paint-hint) runs synchronously before
// connect() opens the WS or any terminal is added. If #sidebar isn't
// in the DOM yet (script loaded in <head>), the DOMContentLoaded
// fallback handles it.
function applyPaintHint() {
  let cached = null;
  try { cached = localStorage.getItem(PAINT_HINT_KEY); } catch { /* see applySidebarWidth */ }
  if (cached == null) return;
  const n = Number(cached);
  if (!Number.isFinite(n)) return;
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.width = clampSidebarWidth(n, window.innerWidth) + 'px';
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPaintHint, { once: true });
  } else {
    applyPaintHint();
  }
}

let _initialized = false;
export function init() {
  if (_initialized) return;
  const gutter = document.getElementById('sidebar-resize-gutter');
  if (!gutter) return;
  _initialized = true;
  gutter.addEventListener('pointerdown', onPointerDown);
  gutter.addEventListener('pointermove', onPointerMove);
  gutter.addEventListener('pointerup', endDrag);
  gutter.addEventListener('pointercancel', endDrag);
  gutter.addEventListener('dblclick', onDoubleClick);
}

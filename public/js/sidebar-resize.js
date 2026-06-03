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
//
// Task 1 lands the pure clamp helper + constants only. Drag/PT logic
// arrives in Task 4.

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

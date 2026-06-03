// @vitest-environment happy-dom
//
// Terminal-display-sizing phase — sidebar width clamp helper.
//
// Uses happy-dom because clampSidebarWidth lives in
// public/js/sidebar-resize.js, and that module pulls in state.js +
// (transitively) public/js/terminals.js which imports prompts.js,
// which touches `document` at module-load time. The pure-helper
// logic under test is environment-agnostic; happy-dom is just a
// host so the import graph resolves. Mirrors
// tests/font-size-clamp.test.js.
//
// D-08 (CONTEXT.md verbatim): "min 280px, max min(640px, 50vw),
// default/reset 354px". The clamp helper takes (px, viewportWidth)
// because the cap depends on viewport — at 1920×1080 the cap is
// 640 (50vw=960 > 640); at 600×anything the cap drops to 300 (50vw).
//
// The defensive fallback when viewportWidth is non-finite simply
// drops the dynamic cap and uses SIDEBAR_WIDTH_MAX_HARD — viewport
// is always a real number in production, but tests pass NaN/undefined
// to pin the contract.

import { describe, it, expect } from 'vitest';
import {
  clampSidebarWidth,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX_HARD,
  SIDEBAR_WIDTH_DEFAULT,
} from '../public/js/sidebar-resize.js';

describe('clampSidebarWidth constants', () => {
  it('exports SIDEBAR_WIDTH_MIN = 280', () => {
    expect(SIDEBAR_WIDTH_MIN).toBe(280);
  });
  it('exports SIDEBAR_WIDTH_MAX_HARD = 640', () => {
    expect(SIDEBAR_WIDTH_MAX_HARD).toBe(640);
  });
  it('exports SIDEBAR_WIDTH_DEFAULT = 354', () => {
    expect(SIDEBAR_WIDTH_DEFAULT).toBe(354);
  });
});

describe('clampSidebarWidth', () => {
  it('returns the default for the literal default value at any viewport', () => {
    expect(clampSidebarWidth(354, 1920)).toBe(354);
    expect(clampSidebarWidth(354, 800)).toBe(354); // 50vw=400, in range
  });

  it('clamps below-min values up to min (280)', () => {
    expect(clampSidebarWidth(100, 1920)).toBe(280);
    expect(clampSidebarWidth(0, 1920)).toBe(280);
    expect(clampSidebarWidth(-50, 1920)).toBe(280);
  });

  it('clamps to the hard cap (640) on wide viewports (50vw > 640)', () => {
    expect(clampSidebarWidth(9999, 1920)).toBe(640);
    expect(clampSidebarWidth(1000, 1500)).toBe(640); // 50vw=750 > 640
  });

  it('clamps to 50vw on narrow viewports (50vw < 640)', () => {
    // 50vw=500 < 640 → cap is 500
    expect(clampSidebarWidth(9999, 1000)).toBe(500);
    // 50vw=400 < 640 → cap is 400; requested 500 → clamped to 400
    expect(clampSidebarWidth(500, 800)).toBe(400);
  });

  it('handles the squeeze case where min approaches cap', () => {
    // viewport=600 → 50vw=300; min=280; range is [280, 300]
    expect(clampSidebarWidth(290, 600)).toBe(290);
    expect(clampSidebarWidth(400, 600)).toBe(300);
    expect(clampSidebarWidth(280, 600)).toBe(280);
    expect(clampSidebarWidth(200, 600)).toBe(280);
  });

  it('floors non-integer numeric input', () => {
    expect(clampSidebarWidth(354.7, 1920)).toBe(354);
    expect(clampSidebarWidth(354.001, 1920)).toBe(354);
  });

  it('coerces numeric strings to numbers', () => {
    expect(clampSidebarWidth('500', 1920)).toBe(500);
    expect(clampSidebarWidth('300', 1920)).toBe(300);
  });

  it('returns the default for null / undefined / NaN / non-numeric first arg', () => {
    expect(clampSidebarWidth(null, 1920)).toBe(354);
    expect(clampSidebarWidth(undefined, 1920)).toBe(354);
    expect(clampSidebarWidth(NaN, 1920)).toBe(354);
    expect(clampSidebarWidth('not a number', 1920)).toBe(354);
    expect(clampSidebarWidth({}, 1920)).toBe(354);
  });

  it('falls back to hard cap when viewportWidth is non-finite', () => {
    // Defensive: viewport is always finite in production, but the
    // helper must not crash if it isn't. Use hard cap as effective max.
    expect(clampSidebarWidth(500, NaN)).toBe(500);
    expect(clampSidebarWidth(9999, NaN)).toBe(640);
    expect(clampSidebarWidth(500, undefined)).toBe(500);
    expect(clampSidebarWidth(500, null)).toBe(500);
  });
});

// @vitest-environment happy-dom
//
// Terminal-display-sizing phase — font-size clamp helper.
//
// Uses happy-dom (not node) because clampFontSize is exported from
// public/js/terminals.js, and that module imports prompts.js which
// touches `document` at module-load time. Pure-helper logic is still
// what's under test; the DOM environment is just a host so the import
// graph resolves. (Mirrors tests/terminal-size-estimate.test.js.)
//
// Pure helper: clampFontSize(n) -> integer in [FONT_SIZE_MIN, FONT_SIZE_MAX]
// with FONT_SIZE_DEFAULT (13) returned for any non-finite / non-numeric input.
//
// D-02 (CONTEXT.md): Range 8..32px, step 1px, default 13px. Clamp at both
// ends. Non-integers floor to int. Bad input → default. These cases ARE
// the contract; tests pin them so a future refactor can't silently widen
// the range or change defaults without re-pinning here first.

import { describe, it, expect } from 'vitest';
import {
  clampFontSize,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_DEFAULT,
} from '../public/js/terminals.js';

describe('clampFontSize constants', () => {
  it('exports FONT_SIZE_MIN = 8', () => {
    expect(FONT_SIZE_MIN).toBe(8);
  });
  it('exports FONT_SIZE_MAX = 32', () => {
    expect(FONT_SIZE_MAX).toBe(32);
  });
  it('exports FONT_SIZE_DEFAULT = 13', () => {
    expect(FONT_SIZE_DEFAULT).toBe(13);
  });
});

describe('clampFontSize', () => {
  it('returns the default for the literal default value', () => {
    expect(clampFontSize(13)).toBe(13);
  });

  it('clamps below-min values up to min', () => {
    expect(clampFontSize(7)).toBe(8);
    expect(clampFontSize(-5)).toBe(8);
  });

  it('clamps above-max values down to max', () => {
    expect(clampFontSize(33)).toBe(32);
    expect(clampFontSize(9999)).toBe(32);
  });

  it('passes through values at the endpoints', () => {
    expect(clampFontSize(8)).toBe(8);
    expect(clampFontSize(32)).toBe(32);
  });

  it('floors non-integer numeric input', () => {
    expect(clampFontSize(13.7)).toBe(13);
    expect(clampFontSize(13.001)).toBe(13);
    expect(clampFontSize(31.999)).toBe(31);
  });

  it('coerces numeric strings to numbers', () => {
    expect(clampFontSize('14')).toBe(14);
    expect(clampFontSize('8')).toBe(8);
  });

  it('returns the default for null / undefined / NaN / non-numeric', () => {
    expect(clampFontSize(null)).toBe(13);
    expect(clampFontSize(undefined)).toBe(13);
    expect(clampFontSize(NaN)).toBe(13);
    expect(clampFontSize('not a number')).toBe(13);
    expect(clampFontSize({})).toBe(13);
  });

  it('returns the default for Infinity / -Infinity', () => {
    expect(clampFontSize(Infinity)).toBe(13);
    expect(clampFontSize(-Infinity)).toBe(13);
  });
});

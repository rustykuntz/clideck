// @vitest-environment node
//
// validateCwdPath — pure-helper unit tests for the new utils.js export.
//
// Phase 10 (creator-ergonomics) introduces a `validateCwdPath(p)` helper used
// by the `mkdir-cwd` WS handler to gate mkdirSync calls. The contract:
//   - Empty / whitespace-only / null / undefined → { ok:false, error:'empty' }
//   - Relative paths (no drive letter on win32, no leading `/` on POSIX) →
//     { ok:false, error:'not-absolute' }
//   - Any `..` path segment anywhere in the input → { ok:false, error:'parent-traversal' }
//   - Otherwise → { ok:true, path: <trimmed input> }
//
// resolveValidDir (the existing silent-fallback helper) is intentionally left
// alone — see SPEC §57 and PLAN Task 1. validateCwdPath sits alongside it.

import { describe, it, expect } from 'vitest';
const { validateCwdPath } = require('../utils.js');

describe('validateCwdPath', () => {
  it('returns { ok:false, error:"empty" } for empty string', () => {
    expect(validateCwdPath('')).toEqual({ ok: false, error: 'empty' });
  });

  it('returns { ok:false, error:"empty" } for null', () => {
    expect(validateCwdPath(null)).toEqual({ ok: false, error: 'empty' });
  });

  it('returns { ok:false, error:"empty" } for undefined', () => {
    expect(validateCwdPath(undefined)).toEqual({ ok: false, error: 'empty' });
  });

  it('returns { ok:false, error:"empty" } for whitespace-only string', () => {
    expect(validateCwdPath('   ')).toEqual({ ok: false, error: 'empty' });
  });

  it('returns { ok:false, error:"not-absolute" } for a relative path', () => {
    expect(validateCwdPath('relative/path')).toEqual({ ok: false, error: 'not-absolute' });
  });

  it('returns { ok:false, error:"not-absolute" } for a ./ relative path', () => {
    expect(validateCwdPath('./foo')).toEqual({ ok: false, error: 'not-absolute' });
  });

  it('rejects absolute paths containing a `..` segment in the middle', () => {
    // On win32 path.isAbsolute('C:/...') is true so we must catch the `..`
    // via a separate split-on-separators check.
    const input = process.platform === 'win32' ? 'C:/abs/../escape' : '/abs/../escape';
    expect(validateCwdPath(input)).toEqual({ ok: false, error: 'parent-traversal' });
  });

  it('rejects absolute paths ending in a `..` segment', () => {
    const input = process.platform === 'win32' ? 'C:/abs/sub/..' : '/abs/sub/..';
    expect(validateCwdPath(input)).toEqual({ ok: false, error: 'parent-traversal' });
  });

  it('accepts a plain absolute path on the current platform', () => {
    // path.isAbsolute is platform-aware. On win32 'C:\\...' is absolute; on
    // POSIX '/home/...' is absolute. We construct accordingly.
    const input = process.platform === 'win32'
      ? 'C:\\Users\\Lance\\Projects\\new'
      : '/home/lance/projects/new';
    const result = validateCwdPath(input);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(input);
  });

  it('accepts an absolute path with a trailing separator (no false-positive on empty segment)', () => {
    const input = process.platform === 'win32'
      ? 'C:/Users/Lance/'
      : '/home/lance/';
    const result = validateCwdPath(input);
    expect(result.ok).toBe(true);
  });
});

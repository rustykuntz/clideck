// @vitest-environment node
//
// Phase 10 Task 2 — server-side `mkdir-cwd` WS handler. Recursive mkdirSync
// gated by validateCwdPath. Drives R2 (mkdir EACCES surfaces ok:false; the
// client must not call createFromPreset on a failed mkdir) and SPEC AC 2, 8.
//
// Cross-references PLAN.md Task 2 GREEN section for the case body shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, statSync, existsSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';

let TEST_DATA_DIR;
let TMP;

function freshHandlers() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${require('path').sep}clideck${require('path').sep}`) &&
        !k.includes('node_modules')) {
      delete require.cache[k];
    }
  }
  return require('../handlers.js');
}

function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (raw) => { try { ws.sent.push(JSON.parse(raw)); } catch { ws.sent.push(raw); } };
  ws.ping = () => {};
  ws.terminate = () => {};
  return ws;
}

beforeEach(() => {
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'clideck-mkdir-cwd-test-'));
  TMP = mkdtempSync(join(tmpdir(), 'clideck-mkdir-cwd-fixtures-'));
  process.env.CLIDECK_DATA_DIR = TEST_DATA_DIR;
});

afterEach(() => {
  delete process.env.CLIDECK_DATA_DIR;
  vi.restoreAllMocks();
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('mkdir-cwd WS handler', () => {
  it('creates an absolute multi-segment path recursively (ok:true)', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const target = join(TMP, 'a', 'b', 'c');
    ws.emit('message', JSON.stringify({ type: 'mkdir-cwd', path: target }));
    const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
    expect(result).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it('rejects a relative path (no mkdir attempted)', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    ws.emit('message', JSON.stringify({ type: 'mkdir-cwd', path: 'relative/foo' }));
    const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
    expect(result).toBeTruthy();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not-absolute');
    // The CWD-side 'relative/foo' should not have appeared anywhere.
    expect(existsSync(join(process.cwd(), 'relative', 'foo'))).toBe(false);
  });

  it('rejects an absolute path containing a `..` segment', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const evil = process.platform === 'win32' ? 'C:/abs/../escape' : '/abs/../escape';
    ws.emit('message', JSON.stringify({ type: 'mkdir-cwd', path: evil }));
    const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
    expect(result).toBeTruthy();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('parent-traversal');
  });

  it('returns ok:true for an existing directory (recursive mkdir is a no-op)', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const existing = join(TMP, 'pre-existing');
    mkdirSync(existing);
    ws.emit('message', JSON.stringify({ type: 'mkdir-cwd', path: existing }));
    const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
    expect(result).toBeTruthy();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it('surfaces EACCES when mkdirSync throws (R2 mitigation)', () => {
    // Install the spy AFTER freshHandlers() so the paths.js module-load
    // mkdir(DATA_DIR) (which fires during require-cache reload) runs
    // unimpeded. The handler-side mkdir-cwd case calls require('fs')
    // .mkdirSync, which is the spied binding.
    const handlers = freshHandlers();
    const fs = require('fs');
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });
    try {
      const ws = fakeWs();
      handlers.onConnection(ws);
      const target = process.platform === 'win32' ? 'C:/Windows/cannot-create' : '/root/cannot-create';
      ws.emit('message', JSON.stringify({ type: 'mkdir-cwd', path: target }));
      const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
      expect(result).toBeTruthy();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('EACCES');
    } finally {
      spy.mockRestore();
    }
  });

  it('never throws on null/missing path — returns invalid-input', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    expect(() => ws.emit('message', JSON.stringify({ type: 'mkdir-cwd' }))).not.toThrow();
    const result = ws.sent.find(m => m.type === 'mkdir-cwd-result');
    expect(result).toBeTruthy();
    expect(result.ok).toBe(false);
    // validateCwdPath(undefined) returns { ok:false, error:'empty' } —
    // the handler propagates that as the error. 'empty' is the
    // semantically-correct surface for "no path supplied".
    expect(result.error).toBe('empty');
  });
});

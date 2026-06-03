// @vitest-environment node
//
// Phase 10 Task 2 — server-side `check-cwd` WS handler. Pure stat, no side
// effects. Drives the not-exists / file-at-path / EACCES / broken-symlink
// branches that the client's pre-flight check (Task 4) consumes to decide
// whether to pop the create-or-cancel modal (SPEC AC 1, 4, 5).
//
// Test strategy: instantiate a fake ws as a Node EventEmitter with a
// recording `send`, call onConnection(fakeWs), then `fakeWs.emit('message',
// JSON.stringify({type:'check-cwd', path:...}))`. The dispatcher uses
// ws.on('message', ...) so emitting fires the existing switch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync, statSync as realStatSync } from 'fs';
import { EventEmitter } from 'events';

let TEST_DATA_DIR;
let TMP;

// Cache-busting reload so handlers.js gets a fresh closure with the
// reset module-state of its deps (config, sessions, plugins, ...).
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
  TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'clideck-check-cwd-test-'));
  TMP = mkdtempSync(join(tmpdir(), 'clideck-check-cwd-fixtures-'));
  process.env.CLIDECK_DATA_DIR = TEST_DATA_DIR;
});

afterEach(() => {
  delete process.env.CLIDECK_DATA_DIR;
  vi.restoreAllMocks();
  try { rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('check-cwd WS handler', () => {
  it('reports exists:true, isDirectory:true for a real directory', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    ws.emit('message', JSON.stringify({ type: 'check-cwd', path: TMP }));
    const result = ws.sent.find(m => m.type === 'check-cwd-result');
    expect(result).toBeTruthy();
    expect(result.path).toBe(TMP);
    expect(result.exists).toBe(true);
    expect(result.isDirectory).toBe(true);
    expect(result.error).toBeNull();
  });

  it('reports exists:false for a path that does not exist', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const ghost = join(TMP, 'does-not-exist-yet');
    ws.emit('message', JSON.stringify({ type: 'check-cwd', path: ghost }));
    const result = ws.sent.find(m => m.type === 'check-cwd-result');
    expect(result).toBeTruthy();
    expect(result.path).toBe(ghost);
    expect(result.exists).toBe(false);
    expect(result.isDirectory).toBe(false);
    // ENOENT is mapped to error:null because not-existing is normal,
    // not an error — the client uses { exists:false, error:null } to
    // pop the offer-to-create modal.
    expect(result.error).toBeNull();
  });

  it('reports exists:true, isDirectory:false for a file path', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const filePath = join(TMP, 'a-file.txt');
    writeFileSync(filePath, 'hello');
    ws.emit('message', JSON.stringify({ type: 'check-cwd', path: filePath }));
    const result = ws.sent.find(m => m.type === 'check-cwd-result');
    expect(result).toBeTruthy();
    expect(result.exists).toBe(true);
    expect(result.isDirectory).toBe(false);
    expect(result.error).toBeNull();
  });

  it('reports error:"EACCES" when statSync throws EACCES', () => {
    // EACCES on Windows is hard to produce naturally — admin accounts can
    // open most things. Mock fs.statSync at the require boundary.
    // Install the spy AFTER freshHandlers() so the paths.js / utils.js
    // load-time stats run unimpeded. The handler-side check-cwd case
    // calls require('fs').statSync, which IS the spied binding.
    const handlers = freshHandlers();
    const fs = require('fs');
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(() => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    });
    try {
      const ws = fakeWs();
      handlers.onConnection(ws);
      ws.emit('message', JSON.stringify({ type: 'check-cwd', path: 'C:/anything' }));
      const result = ws.sent.find(m => m.type === 'check-cwd-result');
      expect(result).toBeTruthy();
      expect(result.exists).toBe(false);
      expect(result.isDirectory).toBe(false);
      expect(result.error).toBe('EACCES');
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('reports exists:false, error:null for a dangling symlink (POSIX)', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    const target = join(TMP, 'target-then-removed');
    const linkPath = join(TMP, 'dangling-link');
    writeFileSync(target, 'x');
    symlinkSync(target, linkPath);
    unlinkSync(target);
    ws.emit('message', JSON.stringify({ type: 'check-cwd', path: linkPath }));
    const result = ws.sent.find(m => m.type === 'check-cwd-result');
    expect(result).toBeTruthy();
    // Handler uses statSync (not lstatSync) so a broken symlink raises
    // ENOENT — which the handler maps to exists:false + error:null per
    // SPEC §61 "Broken symlink -> reports not-exists (correct)".
    expect(result.exists).toBe(false);
    expect(result.isDirectory).toBe(false);
    expect(result.error).toBeNull();
  });

  it('never throws on null/missing path — sends invalid-input result', () => {
    const handlers = freshHandlers();
    const ws = fakeWs();
    handlers.onConnection(ws);
    expect(() => ws.emit('message', JSON.stringify({ type: 'check-cwd' }))).not.toThrow();
    const result = ws.sent.find(m => m.type === 'check-cwd-result');
    expect(result).toBeTruthy();
    expect(result.exists).toBe(false);
    expect(result.error).toBe('invalid-input');
  });
});

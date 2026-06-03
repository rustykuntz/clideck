// @vitest-environment node
//
// Phase 10 — end-to-end integration check for the creator pre-flight contract.
//
// Spawns the real server.js on a throwaway port + isolated data dir, opens a
// real WebSocket, drives check-cwd / mkdir-cwd through the wire, and asserts
// the on-disk + protocol-level outcomes match SPEC AC 1, 2, 4, 5, 6, 8 and R2.
//
// This is the server-side half of Task 7's UAT — browser-side AC 9-11 are
// covered separately by the Playwright smoke suite. The browser-driven
// modal sequences (AC 1+2+3, 4, 5) are covered by the unit tests in
// confirm-modal-onebutton.test.js + the check-cwd-handler/mkdir-cwd-handler
// tests in combination.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { spawn } from 'child_process';
import WebSocket from 'ws';

let serverProc;
let dataDir;
let fixturesDir;
const PORT = 4099;
const WS_URL = `ws://127.0.0.1:${PORT}/`;
const BOOT_TIMEOUT_MS = 12000;
const WS_TIMEOUT_MS = 5000;

function once(ws, predicate, timeoutMs = WS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (predicate(m)) {
          ws.off('message', onMsg);
          clearTimeout(t);
          resolve(m);
        }
      } catch { /* skip non-JSON */ }
    };
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${predicate.name || 'predicate'}`));
    }, timeoutMs);
    ws.on('message', onMsg);
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => reject(new Error('ws open timeout')), WS_TIMEOUT_MS);
    ws.once('open', () => { clearTimeout(t); resolve(ws); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'clideck-phase10-uat-'));
  fixturesDir = mkdtempSync(join(tmpdir(), 'clideck-phase10-fixtures-'));
  serverProc = spawn(
    process.execPath,
    [join(process.cwd(), 'server.js')],
    {
      env: { ...process.env, CLIDECK_PORT: String(PORT), CLIDECK_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Wait for the server to start listening.
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let stderrBuf = '';
    serverProc.stderr.on('data', (d) => { stderrBuf += d.toString(); });
    const tryConnect = () => {
      if (Date.now() > deadline) {
        reject(new Error(`server boot timeout. stderr=${stderrBuf}`));
        return;
      }
      const probe = new WebSocket(WS_URL);
      let done = false;
      probe.once('open', () => { if (!done) { done = true; probe.close(); resolve(); } });
      probe.once('error', () => { if (!done) setTimeout(tryConnect, 200); });
    };
    tryConnect();
  });
}, BOOT_TIMEOUT_MS + 5000);

afterAll(() => {
  if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fixturesDir, { recursive: true, force: true }); } catch {}
});

describe('Phase 10 pre-flight integration (server-side AC 1, 2, 4, 5, 8 + R2)', () => {
  it('AC 1 — non-existent path: check-cwd returns exists:false, error:null', async () => {
    const ws = await connect();
    const ghost = join(fixturesDir, 'ac1-ghost-folder');
    ws.send(JSON.stringify({ type: 'check-cwd', path: ghost }));
    const r = await once(ws, (m) => m.type === 'check-cwd-result' && m.path === ghost);
    expect(r.exists).toBe(false);
    expect(r.isDirectory).toBe(false);
    expect(r.error).toBeNull();
    ws.close();
  });

  it('AC 1 — existing directory: check-cwd returns exists:true, isDirectory:true', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'check-cwd', path: fixturesDir }));
    const r = await once(ws, (m) => m.type === 'check-cwd-result' && m.path === fixturesDir);
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(true);
    expect(r.error).toBeNull();
    ws.close();
  });

  it('AC 2 — mkdir-cwd creates the path recursively, follow-up check-cwd confirms it exists', async () => {
    const ws = await connect();
    const target = join(fixturesDir, 'ac2-deep', 'nested', 'folder');
    ws.send(JSON.stringify({ type: 'mkdir-cwd', path: target }));
    const m = await once(ws, (mm) => mm.type === 'mkdir-cwd-result' && mm.path === target);
    expect(m.ok).toBe(true);
    expect(m.error).toBeNull();
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).isDirectory()).toBe(true);
    // Round-trip with check-cwd to mirror what the client does:
    ws.send(JSON.stringify({ type: 'check-cwd', path: target }));
    const c = await once(ws, (mm) => mm.type === 'check-cwd-result' && mm.path === target);
    expect(c.exists).toBe(true);
    expect(c.isDirectory).toBe(true);
    ws.close();
  });

  it('AC 4 — file at path: check-cwd returns exists:true, isDirectory:false', async () => {
    const ws = await connect();
    const filePath = join(fixturesDir, 'ac4-file.txt');
    writeFileSync(filePath, 'hello');
    ws.send(JSON.stringify({ type: 'check-cwd', path: filePath }));
    const r = await once(ws, (m) => m.type === 'check-cwd-result' && m.path === filePath);
    expect(r.exists).toBe(true);
    expect(r.isDirectory).toBe(false);
    expect(r.error).toBeNull();
    ws.close();
  });

  it('AC 8 — mkdir-cwd rejects relative paths', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'mkdir-cwd', path: 'relative/foo' }));
    const r = await once(ws, (m) => m.type === 'mkdir-cwd-result' && m.path === 'relative/foo');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not-absolute');
    ws.close();
  });

  it('AC 8 — mkdir-cwd rejects absolute paths containing `..`', async () => {
    const ws = await connect();
    const evil = process.platform === 'win32' ? 'C:/abs/../escape' : '/abs/../escape';
    ws.send(JSON.stringify({ type: 'mkdir-cwd', path: evil }));
    const r = await once(ws, (m) => m.type === 'mkdir-cwd-result' && m.path === evil);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('parent-traversal');
    ws.close();
  });

  it('handler robustness — missing path returns invalid-input without throwing', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'check-cwd' }));
    const r = await once(ws, (m) => m.type === 'check-cwd-result');
    expect(r.exists).toBe(false);
    expect(r.error).toBe('invalid-input');
    ws.close();
  });

  it('R2 — mkdir failure surfaces error code (driven by Windows-reserved path on win32, /root on POSIX)', async () => {
    const ws = await connect();
    // Use a path that any normal account cannot write to. On Windows
    // C:\System Volume Information is owned by SYSTEM and admin-protected.
    // On POSIX /root usually requires root. Either way, mkdirSync should
    // throw EACCES / EPERM and the handler should surface it.
    const denied = process.platform === 'win32'
      ? 'C:/System Volume Information/clideck-cannot-create'
      : '/root/clideck-cannot-create';
    ws.send(JSON.stringify({ type: 'mkdir-cwd', path: denied }));
    const r = await once(ws, (m) => m.type === 'mkdir-cwd-result' && m.path === denied);
    expect(r.ok).toBe(false);
    expect(['EACCES', 'EPERM', 'ENOTDIR', 'EROFS']).toContain(r.error);
    // Most importantly: the folder is NOT created (the client must not
    // proceed to createFromPreset on this branch).
    expect(existsSync(denied)).toBe(false);
    ws.close();
  });
});

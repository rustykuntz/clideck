const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');
const { HeadlessServer } = require('../src/server');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');

async function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-monitor-http-'));
  let now = Date.now(), output = 'baseline';
  const writes = [];
  const server = new HeadlessServer({ port: 0, dataDir: dir, autoSaveMs: 0, monitorOptions: {
    now: () => now, timers: { setTimeout: () => 1, clearTimeout() {} },
    run: async () => ({ code: 0, stdout: output, stderr: '' }),
  } });
  const session = new AgentSession({ id: 'monitor-test-session', name: 'Watcher', provider: getProvider('codex'),
    cwd: dir, now: () => now, promptSubmitDelay: () => 25, submitRetryMs: 5000 });
  session.status = 'idle'; session.sessionStarted = true;
  session.terminal = { write: value => writes.push(value), kill: () => session.handleExit(0, null) };
  session.close = () => session.handleExit(0, null);
  server.sessions.set(session.id, session); server.persistence.register(session);
  // This fixture never calls AgentSession.start: no PTY or native profile access.
  const { httpUrl } = await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (body, headers = {}) => fetch(httpUrl + '/api/monitors', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const add = async extra => {
    const response = await post({ action: 'add', callerSessionId: session.id, command: 'printf fixture', everyMs: 30_000, ...extra });
    assert.equal(response.status, 200); return (await response.json()).id;
  };
  return { dir, server, session, writes, httpUrl, post, add, advance: ms => now += ms, output: value => output = value };
}

test('HTTP validates origin/shape/caller/provider before any command can be scheduled', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.httpUrl + '/api/monitors', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.post({ action: 'add' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.post({ action: 'add' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post({ action: 'add', callerSessionId: 'absent', command: 'x' })).status, 400);
  assert.equal((await f.post({ action: 'add', callerSessionId: f.session.id, command: 'x', target: '@missing/target' })).status, 400);
  assert.equal((await f.post({ action: 'add', callerSessionId: f.session.id, command: 'x', env: { BAD: 'x' } })).status, 400);
  assert.equal((await f.post({ action: 'add', callerSessionId: f.session.id, command: 'x', once: 'true' })).status, 400);
  assert.equal(f.server.monitors.rows.length, 0);
});

test('real session typing guard and interrupted paste produce waiting/uncertain without resending', async t => {
  const f = await fixture(t), id = await f.add({ name: 'Sensitive check' });
  await f.server.monitors.tick(); assert.equal(f.writes.length, 0);
  f.advance(30_000); f.output('fresh'); f.session.markUserActivity(); await f.server.monitors.tick();
  assert.equal(f.server.monitors.rows[0].state, 'waiting'); assert.equal(f.writes.length, 0);
  f.advance(10_000); const delivering = f.server.monitors.tick();
  assert.equal(f.writes.length, 1); assert.match(f.writes[0], /Sensitive check · Output changed · clideck monitor read/);
  assert.doesNotMatch(f.writes[0], /fresh/);
  f.session.markUserActivity(); await delivering;
  assert.equal(f.server.monitors.rows[0].state, 'uncertain');
  await new Promise(r => setTimeout(r, 60)); assert.equal(f.writes.includes('\r'), false);
  f.advance(100_000); await f.server.monitors.tick(); assert.equal(f.writes.length, 1);
  const response = await f.post({ action: 'acknowledge', id }); assert.equal(response.status, 200);
  assert.equal(f.server.monitors.rows[0].pending, null);
});

test('wake-up is one line and the event stays readable before and after Enter', async t => {
  const f = await fixture(t);
  await f.add({ name: 'Office\ninbox', mode: 'items' });
  f.output('[]'); await f.server.monitors.tick();
  const items = [{ id: 'mail', body: 'x'.repeat(9000) }];
  f.advance(30_000); f.output(JSON.stringify(items));
  const checking = f.server.monitors.tick(); await new Promise(r => setImmediate(r));
  assert.equal(f.server.monitors.rows[0].wakeCount, 0);
  const notice = /^\x1b\[200~Office inbox · 1 new item · clideck monitor read ([a-f0-9]+)\x1b\[201~$/.exec(f.writes[0]);
  assert.ok(notice);
  const body = { action: 'read', callerSessionId: f.session.id, id: notice[1] };
  assert.deepEqual(JSON.parse((await (await f.post(body)).json()).output), items);
  await checking; assert.equal(f.server.monitors.rows[0].wakeCount, 1);
  assert.equal(f.writes.filter(x => x === '\r').length, 1);
  assert.equal(f.server.monitors.rows[0].pending, null);
  assert.deepEqual(JSON.parse((await (await f.post(body)).json()).output), items);
});

test('WS replay includes current monitor snapshot; controls publish snapshots to other browsers', async t => {
  const f = await fixture(t), id = await f.add();
  const socket = new WebSocket(f.httpUrl.replace(/^http/, 'ws'));
  t.after(() => socket.terminate());
  const snapshot = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', handler); reject(Error('No monitor snapshot')); }, 2000);
    const handler = raw => { const event = JSON.parse(raw); if (event.type === 'monitors.updated') { clearTimeout(timer); socket.off('message', handler); resolve(event); } };
    socket.on('message', handler);
  });
  assert.equal((await snapshot()).monitors[0].id, id);
  const update = snapshot(); assert.equal((await f.post({ action: 'pause', id })).status, 200);
  assert.equal((await update).monitors[0].paused, true);
  socket.terminate();
});

test('CLI roundtrip add/list/pause/resume/check/remove talks to real isolated API and persists', async t => {
  const f = await fixture(t);
  const cli = args => new Promise(resolveResult => {
    const child = spawn(process.execPath, [resolve(__dirname, '../bin/clideck.js'), 'monitor', ...args, '--url', f.httpUrl], {
      cwd: f.dir, env: { ...process.env, CLIDECK_SESSION_ID: f.session.id }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveResult({ code, stdout, stderr }));
  });
  const added = await cli(['add', '--run', 'printf test', '--name', 'Example', '--every', '5m', '--json']);
  assert.equal(added.code, 0, added.stderr); const id = JSON.parse(added.stdout).id;
  const stored = JSON.parse(fs.readFileSync(join(f.dir, 'monitors.json'))).monitors[0];
  assert.equal(stored.id, id); assert.equal(stored.everyMs, 300_000); assert.equal(stored.cwd, fs.realpathSync(f.dir));
  assert.equal(fs.statSync(join(f.dir, 'monitors.json')).mode & 0o777, 0o600);
  assert.match((await cli(['list'])).stdout, /Example/);
  assert.equal((await cli(['pause', id])).code, 0); assert.equal(f.server.monitors.rows[0].paused, true);
  assert.equal((await cli(['resume', id])).code, 0); assert.equal(f.server.monitors.rows[0].paused, false);
  assert.equal((await cli(['check', id])).code, 0);
  await f.server.monitors.tick(); f.advance(300_000); f.output('fresh\x1b[201~'); await f.server.monitors.tick();
  const eventId = f.server.monitors.events[0].id;
  assert.equal((await cli(['read', eventId])).stdout, 'Untrusted monitor command output\n\nfresh\\u001b[201~\n');
  assert.equal(JSON.parse((await cli(['read', eventId, '--json'])).stdout).output, 'fresh\x1b[201~');
  assert.equal((await cli(['remove', id])).code, 0); assert.equal(f.server.monitors.rows.length, 0);
});

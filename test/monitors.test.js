const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Monitors, inspectResult } = require('../src/monitors');
const { runMonitorCommand } = require('../src/monitor-runner');
const { createMonitorDelivery } = require('../src/monitor-delivery');
const { parseMonitorArgs } = require('../src/monitor-cli');
const { scheduledAt } = require('../src/monitor-http');

const d = { name: 'Watch notes', command: 'cat notes', cwd: tmpdir(), sessionId: 'a', mode: 'change', everyMs: 30_000, at: null, once: false, resumeSession: false };
const result = stdout => ({ code: 0, stdout, stderr: '' });
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-monitors-'));
  let now = 100_000, output = 'first', runs = 0, deliveries = 0;
  const timers = { setTimeout(fn, delay) { timers.delay = delay; timers.count++; return 1; }, clearTimeout() { timers.count--; }, count: 0 };
  const options = { dataDir: dir, now: () => now, timers,
    run: async () => { runs++; return result(output); },
    deliver: async (m, { commit }) => { commit(); deliveries++; return { state: 'sent', message: 'Delivered.' }; }, ...extra };
  const manager = new Monitors(options); manager.start();
  t.after(async () => { await manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { manager, options, dir, timers, advance: ms => now += ms, output: value => output = value, runs: () => runs, deliveries: () => deliveries };
}

test('empty scheduler is dormant; baseline is silent, changed output submits once', async t => {
  const f = fixture(t); assert.equal(f.timers.count, 0);
  f.manager.add(d); await f.manager.tick(); assert.equal(f.deliveries(), 0);
  f.advance(30_000); await f.manager.tick(); assert.equal(f.deliveries(), 0);
  f.output('new'); f.advance(30_000); await f.manager.tick(); assert.equal(f.deliveries(), 1);
  f.advance(30_000); await f.manager.tick(); assert.equal(f.deliveries(), 1);
  const row = f.manager.snapshot().monitors[0]; assert.equal(row.wakeCount, 1); assert.equal(row.lastFinding, 'new');
  assert.equal('seen' in row, false); assert.equal('pending' in row, false);
});

test('items dedup survives reordering, disappearance/reappearance and engine restart', async t => {
  const f = fixture(t); f.output('[{"id":"old"}]'); f.manager.add({ ...d, mode: 'items' }); await f.manager.tick();
  f.advance(30_000); f.output('[{"id":"new","value":3},{"id":"old"}]'); await f.manager.tick(); assert.equal(f.deliveries(), 1);
  const eventId = f.manager.events[0].id;
  await f.manager.close(); const restored = new Monitors(f.options); restored.start();
  t.after(() => restored.close());
  f.output('[]'); f.advance(30_000); await restored.tick();
  f.output('[{"id":"old"},{"id":"new","value":4}]'); f.advance(30_000); await restored.tick();
  assert.equal(f.deliveries(), 1);
  f.output('[{"id":"a"},{"id":"b"}]'); f.advance(30_000); await restored.tick();
  assert.equal(restored.rows[0].history[1].message, '2 new items.');
  assert.deepEqual(JSON.parse(restored.readEvent(eventId, 'a').output), [{ id: 'new', value: 3 }]);
  assert.throws(() => restored.readEvent(eventId, 'b'), /unavailable/);
});

test('bad items, duplicate IDs and failed commands do not advance baseline', () => {
  const m = { ...d, mode: 'items', seen: [], baseline: false };
  for (const output of ['{}', 'invalid', '[{}]', '[{"id":"a"},{"id":"a"}]']) assert.throws(() => inspectResult(m, result(output)));
  assert.throws(() => inspectResult(m, { code: 1, stderr: 'offline' }), /exited 1/);
  assert.deepEqual(m.seen, []);
});

test('until-success fires without needing an output change; one-shot schedules fire once', async t => {
  let code = 1;
  const f = fixture(t, { run: async () => ({ code, stdout: '', stderr: '' }) });
  f.manager.add({ ...d, mode: 'until-success' }); await f.manager.tick(); assert.equal(f.deliveries(), 0);
  code = 0; f.advance(30_000); await f.manager.tick(); assert.equal(f.deliveries(), 1);
  assert.equal(f.manager.snapshot().monitors[0].state, 'complete');
  const id = f.manager.add({ ...d, everyMs: null, at: 200_000 });
  await f.manager.tick(); assert.equal(f.deliveries(), 1);
  f.advance(70_000); await f.manager.tick(); assert.equal(f.deliveries(), 2);
  assert.equal(f.manager.rows.find(m => m.id === id).state, 'complete');
});

test('pending findings wait, persist, block further checks and do not retry a partial delivery', async t => {
  let available = false;
  const f = fixture(t, { deliver: async (m, { commit }) => {
    if (!available) return { state: 'waiting', message: 'User typing.' };
    commit(); return { state: 'uncertain', message: 'Text inserted but no Enter.' };
  } });
  const id = f.manager.add(d); await f.manager.tick(); f.output('changed'); f.advance(30_000); await f.manager.tick();
  assert.equal(f.manager.rows[0].state, 'waiting'); assert.equal(f.runs(), 2);
  f.advance(10_000); await f.manager.tick(); assert.equal(f.runs(), 2);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'monitors.json'))).monitors[0].pending.text, 'changed');
  available = true; f.advance(10_000); await f.manager.tick(); assert.equal(f.manager.rows[0].state, 'uncertain');
  f.advance(1000_000); await f.manager.tick(); assert.equal(f.runs(), 2);
  assert.throws(() => f.manager.act({ action: 'check', id }), /current state/);
  f.manager.act({ action: 'acknowledge', id }); assert.equal(f.manager.rows[0].pending, null);
  f.advance(30_000); await f.manager.tick(); assert.equal(f.manager.rows[0].wakeCount, 0);
});

test('crash during submission restores uncertain, never automatic resend', async t => {
  const f = fixture(t); f.manager.add(d);
  Object.assign(f.manager.rows[0], { state: 'waiting', pending: { id: 'event', text: 'found', phase: 'delivering' } });
  f.manager.save(); const restored = new Monitors(f.options); restored.start(); t.after(() => restored.close());
  await restored.tick(); assert.equal(restored.rows[0].state, 'uncertain'); assert.equal(f.deliveries(), 0);
});

test('one shared runner, no overlaps; pause/removal cancels only its own check', async t => {
  let finish, signal;
  const f = fixture(t, { run: options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const id = f.manager.add(d); f.manager.add({ ...d, name: 'second' });
  const pending = f.manager.tick(); await f.manager.tick(); assert.equal(f.manager.active.id, id);
  f.manager.act({ action: 'pause', id }); assert.equal(signal.aborted, true);
  finish(result('ignored')); await pending; assert.equal(f.manager.rows[0].baseline, false);
  assert.equal(f.manager.rows[0].state, 'paused');
  f.manager.act({ action: 'remove', id }); assert.equal(f.manager.rows.length, 1);
});

test('error backoff and missed intervals do not cause catch-up storms', async t => {
  let calls = 0;
  const f = fixture(t, { run: async () => { calls++; throw Error('network unavailable'); } }); f.manager.add(d);
  await f.manager.tick(); assert.equal(f.manager.rows[0].nextCheckAt, 130_000);
  f.advance(30_000); await f.manager.tick(); assert.equal(f.manager.rows[0].nextCheckAt, 190_000);
  f.advance(10_000_000); await f.manager.tick(); await f.manager.tick(); assert.equal(calls, 3);
});

test('unchanged pending status does not write or broadcast repeatedly; session-ready retries promptly', async t => {
  let updates = 0;
  const f = fixture(t, { onChange: () => updates++, deliver: async () => ({ state: 'waiting', retryAfterMs: 60_000, message: 'Session stopped.' }) });
  f.manager.add(d); await f.manager.tick(); f.output('new'); f.advance(30_000); await f.manager.tick();
  const count = updates, saved = fs.readFileSync(join(f.dir, 'monitors.json'), 'utf8');
  f.advance(10_000); await f.manager.tick(); assert.equal(updates, count);
  f.advance(50_000); await f.manager.tick(); assert.equal(updates, count);
  assert.equal(fs.readFileSync(join(f.dir, 'monitors.json'), 'utf8'), saved);
  assert(f.manager.rows[0].deliveryAt > f.options.now());
  f.manager.sessionReady('a'); assert.equal(f.manager.rows[0].deliveryAt, f.options.now());
  await f.manager.tick(); assert.equal(updates, count);
});

test('deleted target pauses its monitor before running another command', async t => {
  const f = fixture(t, { targetExists: () => false });
  f.manager.add(d); await f.manager.tick(); assert.equal(f.runs(), 0);
  assert.equal(f.manager.rows[0].paused, true); assert.match(f.manager.rows[0].message, /deleted/);
  f.advance(100_000); await f.manager.tick(); assert.equal(f.runs(), 0);
});

test('corrupt storage fails closed and is never overwritten; unwritable storage stops execution', async t => {
  const f = fixture(t); const path = join(f.dir, 'monitors.json'); fs.writeFileSync(path, '{bad');
  const broken = new Monitors(f.options); broken.start(); t.after(() => broken.close());
  assert.match(broken.snapshot().error, /Cannot read/); assert.throws(() => broken.add(d)); assert.equal(fs.readFileSync(path, 'utf8'), '{bad');
  fs.unlinkSync(path); fs.mkdirSync(path); assert.throws(() => f.manager.add(d), /Cannot save/);
  await f.manager.tick(); assert.equal(f.runs(), 0);
});

test('monitor definitions and actions are bounded', async t => {
  const f = fixture(t);
  for (const patch of [{ everyMs: 100 }, { cwd: '.' }, { mode: 'ai' }, { command: '' }, { resumeSession: 'true' }, { at: 0 }]) assert.throws(() => f.manager.add({ ...d, ...patch }));
  const id = f.manager.add(d); assert.throws(() => f.manager.act({ action: 'remove', id, command: 'x' }));
  f.manager.act({ action: 'configure', id, resumeSession: true }); assert.equal(f.manager.rows[0].resumeSession, true);
});

test('delivery honors user typing, busy/menu and explicit stopped-session opt-in', async () => {
  const entry = { id: 'a', provider: 'codex', resumeHandle: 'native' };
  let typed = true, commits = 0, sends = 0, resumes = 0;
  const session = { id: 'a', status: 'idle', menu: [], isUserTyping: () => typed,
    sendPrompt() { sends++; this.pendingSubmission = { completion: Promise.resolve({ ok: true }) }; return true; } };
  const server = { persistence: { get: () => entry }, sessions: new Map([['a', session]]),
    askCoordinator: { isActive: () => false }, resumeSession() { resumes++; this.sessions.set('a', session); return session; } };
  const deliver = createMonitorDelivery(server), m = { ...d, id: 'm', pending: { id: 'e', text: 'finding' } };
  const ctx = { signal: new AbortController().signal, commit: () => commits++, checkpoint: v => Object.assign(m.pending, v) };
  assert.equal((await deliver(m, ctx)).state, 'waiting'); assert.equal(commits, 0); assert.equal(sends, 0);
  typed = false; session.menu = ['Choose']; assert.equal((await deliver(m, ctx)).state, 'waiting');
  session.menu = []; session.turnOpen = true; assert.equal((await deliver(m, ctx)).state, 'waiting');
  session.turnOpen = false; assert.equal((await deliver(m, ctx)).state, 'sent'); assert.equal(sends, 1);
  server.sessions.clear(); assert.equal((await deliver(m, ctx)).state, 'waiting'); assert.equal(resumes, 0);
  m.resumeSession = true; assert.equal((await deliver(m, ctx)).state, 'sent'); assert.equal(resumes, 1);
  server.sessions.clear(); assert.equal((await deliver(m, ctx)).state, 'error'); assert.equal(resumes, 1);
});

test('missing/changed native conversation and interrupted submission never report successful wake', async () => {
  const entry = { id: 'a', provider: 'codex' }, sessions = new Map();
  const server = { persistence: { get: () => entry }, sessions, askCoordinator: { isActive: () => false } };
  const deliver = createMonitorDelivery(server), m = { ...d, resumeSession: true, pending: { id: 'e', text: 'x' } };
  const ctx = { signal: new AbortController().signal, commit() {}, checkpoint: v => Object.assign(m.pending, v) };
  assert.match((await deliver(m, ctx)).message, /No saved/);
  sessions.set('a', { id: 'a', status: 'idle', menu: [], sendPrompt() { this.pendingSubmission = { completion: Promise.resolve({ ok: false, message: 'interrupted' }) }; return true; } });
  assert.equal((await deliver(m, ctx)).state, 'uncertain');
  m.pending.resumeHandle = 'before'; entry.resumeHandle = 'after'; assert.match((await deliver(m, ctx)).message, /changed/);
});

test('CLI parses schedules/modes and rejects ambiguous or unsupported options', () => {
  const p = parseMonitorArgs(['add', '--run', 'printf test', '--every', '5m', '--wake', '@p/a', '--resume-session', '--mode', 'items'], { CLIDECK_SESSION_ID: 'me' });
  assert.equal(p.body.everyMs, 300_000); assert.equal(p.body.target, '@p/a'); assert.equal(p.body.callerSessionId, 'me');
  assert.throws(() => parseMonitorArgs(['add', '--run', 'x', '--every', '5m', '--at', '09:00'], { CLIDECK_SESSION_ID: 'a' }));
  assert.throws(() => parseMonitorArgs(['add', '--run', 'x', '--if', 'new'], { CLIDECK_SESSION_ID: 'a' }));
  assert.throws(() => parseMonitorArgs(['add', '--run', 'x'], {}), /inside/);
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(scheduledAt('2026-11-05T09:00:00+07:00', now), Date.parse('2026-11-05T02:00:00Z'));
  assert(scheduledAt('09:00', now) > now);
  assert.throws(() => scheduledAt('2026-11-06T09:00:00', now), /timezone/);
});

test('real short command runs in saved cwd; output overflow and timeout kill owned group', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-monitor-run-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await runMonitorCommand({ command: 'pwd', cwd: dir, env: process.env }); assert.equal(first.stdout.trim(), fs.realpathSync(dir));
  const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
  await assert.rejects(runMonitorCommand({ command: `${quote(process.execPath)} -e 'process.stdout.write("x".repeat(70000))'`, cwd: dir, env: process.env }), /64 KiB/);
  const pidFile = join(dir, 'child.pid');
  const childCode = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`;
  await assert.rejects(runMonitorCommand({ command: `${quote(process.execPath)} -e ${quote(childCode)} & wait`, cwd: dir, env: process.env, timeoutMs: 500 }), /time limit/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  // Allow the OS a moment to reap the child; no signals to anything outside our isolated group.
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 20)); } catch { alive = false; } }
  assert.equal(alive, false);
});

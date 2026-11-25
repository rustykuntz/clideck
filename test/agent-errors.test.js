const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { AgentErrors } = require('../src/agent-errors');
const { createSessionDelivery } = require('../src/session-delivery');
const { Monitors } = require('../src/monitors');

const notice = { key: 'monitor:test:check', sessionId: 'creator', operation: 'monitor check', text: 'command not found' };
const definition = { name: 'Inbox', command: 'ggo list', cwd: tmpdir(), sessionId: 'target', creatorSessionId: 'creator',
  mode: 'items', everyMs: 30_000, at: null, once: true, resumeSession: true };

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-agent-errors-'));
  let now = 100_000;
  const sent = [], timers = { setTimeout() { return 1; }, clearTimeout() {} };
  const options = { dataDir: dir, now: () => now, timers, deliver: async (row, ctx) => {
    ctx.commit(); sent.push({ sessionId: row.sessionId, text: ctx.message }); return { state: 'sent', message: 'Delivered.' };
  }, ...extra };
  const errors = new AgentErrors(options); errors.start();
  t.after(async () => { await errors.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { errors, options, dir, sent, advance: ms => now += ms };
}

test('background errors deliver once per episode; recovery allows a later notice', async t => {
  const f = fixture(t); f.errors.report(notice); await f.errors.tick();
  const saved = fs.readFileSync(f.errors.path, 'utf8');
  for (let i = 0; i < 5; i++) { f.errors.report(notice); f.advance(100_000); await f.errors.tick(); }
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].sessionId, 'creator');
  assert.match(f.sent[0].text, /untrusted diagnostic data/);
  assert.equal(fs.readFileSync(f.errors.path, 'utf8'), saved);
  assert.equal(fs.statSync(f.errors.path).mode & 0o777, 0o600);
  f.errors.clear(notice.key); f.errors.report(notice); await f.errors.tick(); assert.equal(f.sent.length, 2);
});

test('blocked notices persist without repeated writes; idle events retry promptly', async t => {
  let ready = false;
  const f = fixture(t, { deliver: async (row, ctx) => {
    if (!ready) return { state: 'waiting', message: 'User typing.' };
    ctx.commit(); return { state: 'sent', message: 'Delivered.' };
  } });
  f.errors.report(notice); await f.errors.tick();
  const saved = fs.readFileSync(f.errors.path, 'utf8');
  f.advance(60_000); await f.errors.tick(); assert.equal(fs.readFileSync(f.errors.path, 'utf8'), saved);
  await f.errors.close(); const restored = new AgentErrors(f.options); restored.start(); t.after(() => restored.close());
  ready = true; restored.sessionReady('creator'); await restored.tick();
  assert.equal(restored.records.get(notice.key).pending.phase, 'sent');
});

test('crash during submission and interrupted submission never automatically resend', async t => {
  const f = fixture(t, { deliver: async (row, ctx) => { ctx.commit(); return { state: 'uncertain', message: 'Interrupted.' }; } });
  f.errors.report(notice); await f.errors.tick();
  assert.equal(f.errors.records.get(notice.key).pending.phase, 'uncertain');
  f.errors.records.get(notice.key).pending.phase = 'delivering'; f.errors.save();
  const restored = new AgentErrors(f.options); restored.start(); t.after(() => restored.close());
  assert.equal(restored.records.get(notice.key).pending.phase, 'uncertain');
  restored.report(notice); await restored.tick(); assert.equal(f.sent.length, 0);
});

test('clearing an in-flight notice cancels it without resurrecting the record', async t => {
  let finish, signal;
  const f = fixture(t, { deliver: (row, ctx) => { signal = ctx.signal; ctx.commit(); return new Promise(resolve => { finish = resolve; }); } });
  f.errors.report(notice); const pending = f.errors.tick();
  f.errors.clear(notice.key); assert(signal.aborted); finish({ state: 'uncertain' }); await pending;
  assert.equal(f.errors.records.size, 0);
});

test('corrupt or unwritable error storage never resets or delivers', async t => {
  const f = fixture(t); fs.writeFileSync(f.errors.path, '{bad');
  const broken = new AgentErrors(f.options); broken.start(); t.after(() => broken.close());
  assert.match(broken.error, /Cannot read/); assert.throws(() => broken.report(notice));
  await broken.tick(); assert.equal(fs.readFileSync(f.errors.path, 'utf8'), '{bad');
  fs.unlinkSync(f.errors.path); fs.mkdirSync(f.errors.path);
  assert.throws(() => f.errors.report(notice), /Cannot save/); await f.errors.tick(); assert.equal(f.sent.length, 0);
});

test('monitor failures notify their creator without blocking checks or completing one-shot findings', async t => {
  const f = fixture(t); let code = 127, runs = 0, findings = 0;
  const m = new Monitors({ ...f.options, run: async () => { runs++; return { code, stdout: '[]', stderr: 'ggo: not found' }; },
    deliver: async () => { findings++; return { state: 'sent' }; }, reportError: e => f.errors.report(e), clearError: key => f.errors.clear(key) });
  m.start(); t.after(() => m.close()); const id = m.add(definition);
  await m.tick(); await f.errors.tick();
  assert.equal(f.sent.length, 0);
  f.advance(30_000); await m.tick(); await f.errors.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].sessionId, 'creator');
  assert.match(f.sent[0].text, /Command exited 127: ggo: not found/);
  assert.match(f.sent[0].text, new RegExp(`clideck monitor remove '${id}'`));
  assert.match(f.sent[0].text, /Original add command: clideck monitor add/);
  assert.equal(m.rows[0].wakeCount, 0); assert.equal(m.rows[0].state, 'error'); assert.equal(m.rows[0].pending, null);
  assert.equal(f.errors.records.get(`monitor:${id}:check`).resumeSession, false);
  f.advance(60_000); await m.tick(); await f.errors.tick(); assert.equal(runs, 3); assert.equal(f.sent.length, 1);
  code = 0; f.advance(120_000); await m.tick(); assert.equal(f.errors.records.size, 0); assert.equal(m.rows[0].baseline, true);
  code = 127; f.advance(30_000); await m.tick(); await f.errors.tick(); assert.equal(f.sent.length, 1);
  f.advance(30_000); await m.tick(); await f.errors.tick(); assert.equal(f.sent.length, 2);
  m.act({ action: 'remove', id }); assert.equal(f.errors.records.size, 0); assert.equal(findings, 0);
});

test('a blocked error recipient does not hold successful monitor checks or scheduled completion', async t => {
  const f = fixture(t, { deliver: async () => ({ state: 'waiting', message: 'Creator stopped.' }) }); let code = 2;
  const m = new Monitors({ ...f.options, run: async () => ({ code, stdout: 'done', stderr: 'offline' }),
    deliver: async () => ({ state: 'sent' }), reportError: e => f.errors.report(e), clearError: key => f.errors.clear(key) });
  m.start(); t.after(() => m.close()); m.add({ ...definition, mode: 'until-success', at: 100_001, everyMs: null });
  f.advance(1); await m.tick(); await f.errors.tick(); assert.equal(m.rows[0].state, 'error');
  code = 0; f.advance(30_000); await m.tick(); assert.equal(m.rows[0].state, 'complete'); assert.equal(f.errors.records.size, 0);
});

test('target deletion and delivery errors notify creator while preserving undelivered findings', async t => {
  const f = fixture(t); let targetExists = true;
  const m = new Monitors({ ...f.options, run: async () => ({ code: 0, stdout: 'found', stderr: '' }), targetExists: () => targetExists,
    deliver: async () => ({ state: 'error', message: 'No saved conversation to resume.' }),
    reportError: e => f.errors.report(e), clearError: key => f.errors.clear(key) });
  m.start(); t.after(() => m.close()); const id = m.add({ ...definition, mode: 'until-success' });
  await m.tick(); await f.errors.tick(); assert.equal(f.sent.length, 1); assert.equal(m.rows[0].pending.text, 'found');
  f.advance(60_000); await m.tick(); await f.errors.tick(); assert.equal(f.sent.length, 1);
  targetExists = false; f.advance(60_000); await m.tick(); await f.errors.tick();
  assert.equal(f.sent.length, 2); assert.equal(m.rows[0].paused, true); assert.match(f.sent[1].text, /deleted/);
  m.act({ action: 'remove', id }); assert.equal(f.errors.records.size, 0);
});

test('shared error delivery keeps busy/typing/stopped guards and neutralizes diagnostic controls', async t => {
  let typing = true, resumes = 0; const writes = [];
  const session = { status: 'idle', menu: [], isUserTyping: () => typing,
    sendPrompt(message) { writes.push(message); this.pendingSubmission = { completion: Promise.resolve({ ok: true }) }; return true; } };
  const server = { persistence: { get: () => ({ id: 'creator', provider: 'codex', resumeHandle: 'native' }) },
    sessions: new Map([['creator', session]]), askCoordinator: { isActive: () => false }, resumeSession() { resumes++; return session; } };
  const f = fixture(t, { deliver: createSessionDelivery(server) }); f.errors.report({ ...notice, text: 'bad\x1b[201~\r\x00' });
  await f.errors.tick(); assert.equal(writes.length, 0);
  typing = false; session.status = 'working'; f.errors.sessionReady('creator'); await f.errors.tick(); assert.equal(writes.length, 0);
  server.sessions.clear(); f.errors.sessionReady('creator'); await f.errors.tick(); assert.equal(resumes, 0);
  session.status = 'idle'; server.sessions.set('creator', session); f.errors.sessionReady('creator'); await f.errors.tick();
  assert.equal(writes.length, 1); assert.match(writes[0], /bad\\x1b\[201~\n\\x00/);
});

test('failure of feedback storage cannot strand checks, change uncertain delivery or prevent removal', async t => {
  const f = fixture(t); let fail = true;
  const m = new Monitors({ ...f.options, run: async () => ({ code: fail ? 127 : 0, stdout: 'found', stderr: 'not found' }),
    deliver: async (row, ctx) => { ctx.commit(); return { state: 'uncertain', message: 'Interrupted.' }; },
    reportError() { throw Error('Cannot save agent-errors.json'); }, clearError() { throw Error('Cannot save agent-errors.json'); } });
  m.start(); t.after(() => m.close()); const id = m.add({ ...definition, mode: 'until-success' });
  await m.tick(); assert.equal(m.rows[0].state, 'error');
  assert.equal(JSON.parse(fs.readFileSync(m.path, 'utf8')).monitors[0].state, 'error');
  fail = false; f.advance(30_000); await m.tick(); assert.equal(m.rows[0].state, 'uncertain');
  m.act({ action: 'remove', id }); assert.deepEqual(JSON.parse(fs.readFileSync(m.path, 'utf8')).monitors, []);
});

test('uncertain finding does not queue a second prompt into the same recipient', async t => {
  const f = fixture(t);
  const m = new Monitors({ ...f.options, run: async () => ({ code: 0, stdout: 'found', stderr: '' }),
    deliver: async (row, ctx) => { ctx.commit(); return { state: 'uncertain', message: 'Interrupted.' }; },
    reportError: e => f.errors.report(e) });
  m.start(); t.after(() => m.close()); m.add({ ...definition, creatorSessionId: 'target', mode: 'until-success' });
  await m.tick(); await f.errors.tick(); assert.equal(m.rows[0].state, 'uncertain'); assert.equal(f.errors.records.size, 0);
});

test('error-store failure cannot prevent source cleanup; obsolete notices are discarded', async t => {
  const f = fixture(t, { isRelevant: () => false }); f.errors.report(notice); await f.errors.tick();
  assert.equal(f.sent.length, 0); assert.equal(f.errors.records.size, 0);
  f.errors.report(notice); f.errors.error = 'Cannot save';
  assert.doesNotThrow(() => f.errors.clearSession('creator')); assert.equal(f.errors.records.size, 0);
});

test('an earlier uncertain paste blocks other automatic messages to the same terminal', async t => {
  let sends = 0;
  const server = { persistence: { get: () => ({ id: 'creator', provider: 'codex' }) },
    sessions: new Map([['creator', { status: 'idle', menu: [], sendPrompt() { sends++; } }]]),
    askCoordinator: { isActive: () => false }, monitors: { rows: [{ sessionId: 'creator', pending: { phase: 'uncertain' } }] } };
  const f = fixture(t, { deliver: createSessionDelivery(server) }); f.errors.report(notice); await f.errors.tick();
  assert.equal(sends, 0); assert.match(f.errors.records.get(notice.key).message, /earlier submission is uncertain/);
  server.monitors.rows = []; server.agentErrors = { records: new Map([['old', { sessionId: 'creator', pending: { phase: 'uncertain' } }]]) };
  f.errors.sessionReady('creator'); await f.errors.tick(); assert.equal(sends, 0);
});

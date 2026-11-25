const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ChatApps } = require('../plugin-packages/telegram/phone');
const { Telegram, TelegramError, messageParts } = require('../plugin-packages/telegram/telegram');
const { Presence } = require('../plugin-packages/telegram/presence');
const { setupState } = require('../plugin-packages/telegram/server');

const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz0123456789';
const USER = 42;
async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-telegram-'));
  let now = 100_000, topicId = 10;
  const calls = [], deliveries = [], released = [], errors = [], notices = [], entries = [{ id: 'one', provider: 'codex', name: 'Main' }];
  const call = async (method, body, options) => {
    calls.push({ method, body: structuredClone(body), options });
    if (extra.call) { const result = await extra.call(method, body, options); if (result !== undefined) return result; }
    if (method === 'getMe') return { id: 123456, username: 'fixture_bot', first_name: 'Fixture', is_bot: true, has_topics_enabled: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'createForumTopic') return { message_thread_id: ++topicId };
    if (method === 'getUpdates') return [];
    return true;
  };
  const options = { dataDir: dir, entries: () => entries, describe: () => 'Project · Main', now: () => now,
    polling: false, timers: { setTimeout: () => 1, clearTimeout() {} }, telegram: () => ({ call }),
    presenceProbe: async () => ({ supported: true, away: false }),
    deliver: async (row, context) => { deliveries.push({ row, text: context.message }); return { state: 'sent', message: 'sent' }; },
    releaseRequest: async id => { released.push(id); return true; },
    reportError: row => errors.push(row), notifyUser: async (id, text) => notices.push({ id, text }), ...extra.options };
  const app = new ChatApps(options); await app.start();
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const update = (id, text, overrides = {}) => ({ update_id: id, message: { date: Math.floor(now / 1000),
    chat: { id: USER, type: 'private' }, from: { id: USER, first_name: 'Or', is_bot: false }, text, ...overrides } });
  const drain = async () => { for (let i = 0; i < 100 && app.state.outbox.some(row => row.nextAt <= now); i++) await app.work(); };
  const paired = async () => {
    await app.act({ action: 'connect', token: TOKEN }); await app.act({ action: 'pair' });
    app.receive(update(1, '/start ' + app.state.pairing.code)); await drain();
    await app.act({ action: 'phone', sessionId: 'one', enabled: true }); await drain();
  };
  const incoming = (id = 2, text = 'Hello') => update(id, text, { message_thread_id: app.state.topics.one.id });
  return { app, dir, calls, deliveries, errors, notices, released, options, entries, update, incoming, paired, drain, advance: ms => now += ms };
}

test('pairing accepts one fresh private account, hides credentials and persists privately', async t => {
  const f = await fixture(t);
  assert.equal(setupState(f.app.snapshot()).next.step, 'connect');
  await f.app.act({ action: 'connect', token: TOKEN }); await f.app.act({ action: 'pair' });
  const code = f.app.state.pairing.code;
  await f.app.act({ action: 'pair' }); assert.equal(f.app.state.pairing.code, code, 'repeated setup must not invalidate the displayed link');
  f.app.receive(f.update(1, '/start ' + code, { chat: { id: USER, type: 'group' } }));
  f.app.receive(f.update(2, '/start ' + code, { date: 1 }));
  f.app.receive(f.update(3, '/start wrong'));
  assert.equal(f.app.state.paired, null); assert.equal(f.app.state.outbox.length, 0);
  f.app.receive(f.update(4, '/start ' + code));
  assert.equal(f.app.state.paired.id, USER); assert.equal(f.app.snapshot().telegram.pairing, null);
  f.app.receive(f.update(5, '/start ' + code, { chat: { id: 99, type: 'private' }, from: { id: 99 } }));
  assert.equal(f.app.state.paired.id, USER);
  assert(!JSON.stringify(f.app.snapshot()).includes(TOKEN));
  assert.equal(fs.statSync(f.app.path).mode & 0o777, 0o600);
});

test('existing webhook and unsupported sessions refuse before taking over or making a topic', async t => {
  const f = await fixture(t, { call: async method => method === 'getWebhookInfo' ? { url: 'https://existing.example/hook' } : undefined });
  await assert.rejects(f.app.act({ action: 'connect', token: TOKEN }), /webhook/);
  assert.equal(f.app.state.token, '');
  const g = await fixture(t); await g.paired(); g.entries.push({ id: 'shell', provider: 'shell' });
  const count = g.calls.length;
  await assert.rejects(g.app.act({ action: 'phone', sessionId: 'shell', enabled: true }), /Claude and Codex/);
  assert.equal(g.calls.length, count);
});

test('deduplicated inbound requests route only their owned final; unrelated finals never reach phone', async t => {
  const f = await fixture(t); await f.paired();
  f.app.receive(f.incoming()); f.app.receive(f.incoming()); await f.app.work();
  assert.equal(f.deliveries.length, 1); const row = f.app.state.inbox[0];
  f.app.sessionEvent({ id: 'one' }, { type: 'agent.final', requestId: 'peer', origin: 'agent', text: 'peer secret' });
  f.app.sessionEvent({ id: 'one' }, { type: 'agent.final', requestId: row.id, origin: 'plugin:other', text: 'other plugin' });
  assert.equal(f.app.state.outbox.length, 0);
  f.app.sessionEvent({ id: 'one' }, { type: 'turn.started', requestId: row.id, origin: 'plugin:telegram' });
  f.app.sessionEvent({ id: 'one' }, { type: 'agent.final', requestId: row.id, origin: 'plugin:telegram', text: 'Your answer' });
  await f.drain(); assert.equal(f.app.state.inbox.length, 0);
  assert.equal(f.calls.filter(c => c.method === 'sendMessage' && c.body.text === 'Your answer').length, 1);
  assert(!JSON.stringify(f.calls).includes('peer secret'));
});

test('received requests and polling offset survive restart without accepting duplicate update IDs', async t => {
  const f = await fixture(t); await f.paired(); f.app.receive(f.incoming());
  await f.app.close(); const restored = new ChatApps(f.options); await restored.start(); t.after(() => restored.close());
  restored.receive(f.incoming()); await restored.work(); assert.equal(f.deliveries.length, 1);
  assert.equal(restored.state.offset, 3);
});

test('engine-owned completed receipt recovers an answer after the plugin missed its final event', async t => {
  const f = await fixture(t); await f.paired(); f.app.receive(f.incoming()); await f.app.work();
  const row = f.app.state.inbox[0]; await f.app.close();
  const restored = new ChatApps({ ...f.options, getRequests: async () => [{ id: row.id, state: 'complete', answer: 'Recovered final' }] });
  await restored.start(); t.after(() => restored.close());
  assert.equal(restored.state.inbox.length, 0); assert(restored.state.outbox.some(row => row.body.text === 'Recovered final'));
  assert.equal(f.deliveries.length, 1);
});

test('restart during a paste never resends, and explicit acknowledgment releases the hold', async t => {
  const f = await fixture(t); await f.paired(); f.app.receive(f.incoming());
  const row = f.app.state.inbox[0]; row.phase = 'submitting'; row.pending.phase = 'delivering'; f.app.save(); await f.app.close();
  let acknowledged = '';
  const restored = new ChatApps({ ...f.options, getRequests: async () => [{ id: row.id, state: 'uncertain', message: 'Inspect terminal' }],
    acknowledgeRequest: async id => { acknowledged = id; return true; } });
  await restored.start(); t.after(() => restored.close());
  await restored.work(); assert.equal(f.deliveries.length, 0); assert.equal(restored.snapshot().sessions[0].pending.state, 'uncertain');
  await restored.act({ action: 'acknowledge', id: row.id }); assert.equal(acknowledged, row.id); assert.equal(restored.state.inbox.length, 0);
});

test('Phone off discards queued requests/replies, keeps the topic, and on is idempotent', async t => {
  const f = await fixture(t); await f.paired(); const topic = f.app.state.topics.one;
  const revision = topic.revision, id = topic.id;
  await f.app.act({ action: 'phone', sessionId: 'one', enabled: true }); assert.equal(topic.revision, revision);
  f.app.receive(f.incoming()); f.app.queueReply('one', 'must not send', 'reply');
  await f.app.act({ action: 'phone', sessionId: 'one', enabled: false }); await f.drain();
  assert.equal(f.deliveries.length, 0); assert.equal(f.app.state.inbox.length, 0);
  assert(!f.calls.some(c => c.body?.text === 'must not send'));
  f.advance(10_000); await f.app.act({ action: 'phone', sessionId: 'one', enabled: true });
  assert.equal(topic.id, id); assert.equal(f.calls.filter(c => c.method === 'createForumTopic').length, 1);
  const old = f.incoming(3); old.message.date -= 5; f.app.receive(old);
  assert.equal(f.app.state.inbox.length, 0, 'messages sent while off must not run after on');
});

test('OFF during submission preserves uncertainty instead of repeating the prompt', async t => {
  const f = await fixture(t, { options: { deliver: (row, ctx) => new Promise(resolve => ctx.signal.addEventListener('abort', () => resolve({ state: 'uncertain', message: 'paste interrupted' }))) } });
  await f.paired(); f.app.receive(f.incoming()); const running = f.app.work();
  await f.app.act({ action: 'phone', sessionId: 'one', enabled: false }); await running;
  assert.equal(f.app.state.inbox[0].phase, 'uncertain'); assert.equal(f.app.snapshot().sessions[0].pending.state, 'uncertain');
});

test('stale polls cannot pair or submit after disconnect, and never reuse old bot mappings', async t => {
  let finish;
  const f = await fixture(t, { call: method => method === 'getUpdates' ? new Promise(resolve => { finish = resolve; }) : undefined });
  await f.paired(); const running = f.app.poll();
  await f.app.act({ action: 'disconnect' }); finish([f.update(99, 'old message', { message_thread_id: 11 })]); await running;
  assert.equal(f.app.state.paired, null); assert.deepEqual(f.app.state.topics, {}); assert.equal(f.app.state.inbox.length, 0);
  await f.app.act({ action: 'connect', token: TOKEN }); assert.equal(f.app.state.offset, 0);
});

test('away notices are explicit, deduplicated and include every text chunk; plugin failures never loop', async t => {
  const f = await fixture(t); await f.paired();
  f.app.acceptNotification({ id: 'here', sessionId: 'one', text: 'local only', at: 100_000 }); assert.equal(f.app.state.outbox.length, 0);
  await f.app.act({ action: 'presence', mode: 'away' });
  const notice = { id: 'important', sessionId: 'one', text: 'x'.repeat(3500), at: 100_000 };
  f.app.acceptNotification(notice); f.app.acceptNotification(notice);
  f.app.acceptNotification({ ...notice, id: 'failure', origin: 'plugin:telegram' });
  assert.equal(f.app.state.outbox.length, 1);
  await f.app.work(); f.advance(1000); await f.app.work();
  assert.equal(f.calls.filter(c => c.method === 'sendMessage' && /^x+$/.test(c.body.text)).map(c => c.body.text).join('').length, 3500);
});

test('failed outgoing delivery reaches initiating agent and is visible locally after give-up', async t => {
  let fail = false;
  const f = await fixture(t, { call: async method => { if (fail && method === 'sendMessage') throw new TelegramError('bot blocked', { code: 403 }); } });
  await f.paired(); fail = true; f.app.queueReply('one', 'answer', 'reply'); await f.app.work();
  assert.equal(f.errors.length, 1); assert.match(f.errors[0].text, /bot blocked/); assert.equal(f.notices.length, 1);
  assert.equal(f.app.state.outbox.length, 0);
});

test('Telegram client redacts credential-bearing failures; split text preserves Unicode', async () => {
  const client = new Telegram(TOKEN, { fetch: async url => { throw Error(url); } });
  await assert.rejects(client.call('sendMessage', {}), error => error.uncertain && !error.message.includes(TOKEN));
  const text = '😀'.repeat(5000); assert.equal(messageParts(text).join(''), text);
  assert(messageParts(text).every(part => part.length <= 4096));
});

test('one presence probe supports explicit overrides without browser visibility assumptions', async () => {
  let probes = 0, resolve;
  const presence = new Presence({ probe: () => { probes++; return new Promise(done => { resolve = done; }); }, timers: { setTimeout: () => 1, clearTimeout() {} } });
  const pending = presence.check(), duplicate = presence.check();
  assert.equal(probes, 1); resolve({ supported: true, away: true }); await Promise.all([pending, duplicate]);
  assert.equal(presence.snapshot().away, true); presence.setMode('here'); assert.equal(presence.snapshot().away, false);
  presence.setMode('away'); assert.equal(presence.snapshot().away, true); await presence.close();
});

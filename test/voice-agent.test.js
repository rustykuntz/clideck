const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { EventEmitter } = require('node:events');
const { Calls } = require('../plugin-packages/voice-agent/calls');
const { activate } = require('../plugin-packages/voice-agent/server');
const { OpenAILive, setup, configuration } = require('../plugin-packages/voice-agent/openai');
const { HeadlessServer } = require('../src/server');

const config = { 'openai-key': 'sk-test-PRIVATE', 'sip-url': 'sips:test.pstn.twilio.com:5061', 'sip-username': 'PRIVATE-USERNAME', 'sip-password': 'PRIVATE-PASSWORD', 'caller-number': '+14155550101' };
const task = { requestId: 'test-call-1', destination: '+14155550102', objective: 'Explain this authorized voice test.', maxSeconds: 120 };
const immediate = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-voice-')), commands = new Map(), messages = new Map(), events = new Map();
  const errors = [], updates = [], submissions = [], releases = [], shutdowns = [], connections = new Map();
  const metrics = { creates: 0, hangups: [], sent: [] };
  const settings = { ...config };
  const api = { dataDir: dir, capabilities: { sessionSteer: true, boundedTurns: true }, getSetting: key => settings[key], log() {},
    getSession: async id => ({ sessionId: id, provider: 'codex' }),
    getRequests: async () => [], getTurns: async () => [],
    onSettingsChange: () => () => {},
    registerCommand: (name, handler) => commands.set(name, handler), onClientMessage: (name, handler) => messages.set(name, handler),
    onEvent: (name, handler) => events.set(name, handler), onShutdown: handler => shutdowns.push(handler),
    sendToClients: (event, data) => updates.push({ event, data }),
    reportError: async (...args) => errors.push(args), clearError: async () => {},
    submitRequest: async (...args) => { submissions.push(args); return { state: 'sent' }; },
    releaseRequest: async id => releases.push(id),
  };
  const provider = () => ({
    check: async () => ({ modelAccess: true, phoneConnectionTested: false }),
    create: async (...args) => { metrics.creates++; if (overrides.create) return overrides.create(...args); return { session: { id: `live_${metrics.creates}` } }; },
    hangup: async id => { metrics.hangups.push(id); if (overrides.hangup) return overrides.hangup(id); connections.get(id)?.event({ type: 'session.closed', event_id: 'closed-' + id, reason: 'close_requested', usage: { seconds: 17 } }); return {}; },
    attach: (id, handlers) => {
      connections.set(id, handlers);
      const conn = { ready: overrides.ready || Promise.resolve(), close() {}, send: event => {
        metrics.sent.push(event);
        if (overrides.noAck) return;
        queueMicrotask(() => handlers.event({ type: event.type === 'transport.dtmf.send' ? 'transport.dtmf.sent' : event.type.replace(/\.append$/, '.appended'),
          event_id: 'ack-' + event.event_id, client_event_id: event.event_id }));
      } };
      return conn;
    },
  });
  const options = { provider, tickMs: 0, ackMs: 30 };
  const calls = new Calls(api, options);
  t.after(async () => { await calls.close(); await Promise.all(shutdowns.map(fn => fn())); fs.rmSync(dir, { recursive: true, force: true }); });
  const emit = (row, event) => connections.get(row.providerId).event(event);
  return { dir, api, calls, options, settings, metrics, connections, emit, errors, submissions, releases, commands, messages, updates,
    run: (name, args = [], input, sessionId = 'one') => commands.get(name)({ args, stdin: input === undefined ? '' : JSON.stringify(input), sessionId }) };
}

test('start is durable and idempotent, including concurrent retries and changed briefs', async t => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.calls.start('one', task), f.calls.start('one', task)]);
  assert.equal(a.id, b.id); assert.equal(f.metrics.creates, 1); assert.equal(a.state, 'connecting');
  assert.equal(fs.statSync(join(f.dir, 'calls.json')).mode & 0o777, 0o600);
  await assert.rejects(f.calls.start('one', { ...task, objective: 'Different' }), /different brief/);
  await assert.rejects(f.calls.start('one', { ...task, requestId: 'another' }), /active or uncertain/);
  const stored = fs.readFileSync(join(f.dir, 'calls.json'), 'utf8');
  for (const secret of ['sk-test-PRIVATE', 'PRIVATE-USERNAME', 'PRIVATE-PASSWORD']) assert(!stored.includes(secret));
});

test('timeout never redials and blocks a new call until the uncertain call is resolved', async t => {
  const f = fixture(t, { create: async () => { throw Error('Request timed out'); } });
  await assert.rejects(f.calls.start('one', task), /never blindly redial/);
  const retry = await f.calls.start('one', task);
  assert.equal(retry.state, 'uncertain'); assert.equal(f.metrics.creates, 1);
  await assert.rejects(f.calls.start('one', { ...task, requestId: 'new' }), /uncertain/);
});

test('validation, missing setup and unsupported supervisors cannot dial', async t => {
  const f = fixture(t);
  f.api.capabilities = {};
  await assert.rejects(f.calls.start('one', task), /restart CliDeck/);
  f.api.capabilities.sessionSteer = true;
  await assert.rejects(f.calls.start('one', { ...task, destination: '555' }), /country code/);
  await assert.rejects(f.calls.start('one', { ...task, requestId: undefined }), /requestId/);
  f.settings['openai-key'] = '';
  await assert.rejects(f.calls.start('one', task), /setup incomplete/);
  f.settings['openai-key'] = config['openai-key']; f.api.getSession = async () => ({ provider: 'shell' });
  await assert.rejects(f.calls.start('one', task), /supervisor/);
  assert.equal(f.metrics.creates, 0);
  assert.equal(setup({ ...config, 'sip-url': 'http://localhost' }).ready, false);
});

test('transcripts and events stay with their call; steering waits for a correlated receipt', async t => {
  const f = fixture(t), a = await f.calls.start('one', task), b = await f.calls.start('two', task);
  const row = f.calls.get(a.id, 'one');
  f.emit(a, { type: 'transport.answered', event_id: 'answered' });
  f.emit(a, { type: 'session.input_transcript.delta', event_id: 'speech', delta: 'Can you help?', start_ms: 0, end_ms: 800 });
  f.emit(a, { type: 'session.input_transcript.delta', event_id: 'speech', delta: 'duplicate' });
  assert.equal(row.transcript.length, 1); assert.equal(f.calls.get(b.id).transcript.length, 0);
  assert.throws(() => f.calls.get(a.id, 'two'), /does not belong/);
  const result = await f.calls.steer(row, { text: 'Ask which document is missing.' });
  assert.equal(result.accepted, true); assert.equal(result.actedOn, false);
  assert.equal(f.metrics.sent[0].type, 'session.instructions.append');
  await f.calls.key(row, '#'); assert.equal(f.metrics.sent.at(-1).event, '#');
  assert.throws(() => f.calls.key(row, '12'), /one keypad/);
});

test('delegations require explicit current IDs; generic agent replies are never spoken', async t => {
  const f = fixture(t), started = await f.calls.start('one', task), row = f.calls.get(started.id);
  for (const id of ['d1', 'd2']) f.emit(started, { type: 'session.delegation.created', event_id: id, delegation: { id, target: 'client' } });
  await assert.rejects(f.calls.steer(row, { kind: 'answer', text: 'Old result', delegationId: 'd1' }), /Stale/);
  const result = await f.calls.steer(row, { kind: 'answer', text: 'The missing document is a receipt.', delegationId: 'd2' });
  assert.equal(result.accepted, true); assert.equal(row.delegations[1].state, 'answered');
  await assert.rejects(f.calls.steer(row, { kind: 'answer', text: 'Duplicate', delegationId: 'd2' }), /Stale/);
  assert.equal(f.metrics.sent.length, 1);
});

test('unacknowledged steering is uncertain and is not retried', async t => {
  const f = fixture(t, { noAck: true }), start = await f.calls.start('one', task);
  await assert.rejects(f.calls.steer(f.calls.get(start.id), { text: 'Ask again.' }), /unconfirmed/);
  assert.equal(f.metrics.sent.length, 1); assert.equal(f.calls.get(start.id).controls[0].state, 'unconfirmed');
});

test('supervisor delivery reuses immutable pending requests and coalesces later speech', async t => {
  const f = fixture(t), start = await f.calls.start('one', task), row = f.calls.get(start.id);
  let deliveryState = 'waiting';
  f.api.submitRequest = async (...args) => { f.submissions.push(args); return { state: deliveryState }; };
  await f.calls.tick();
  f.emit(start, { type: 'session.input_transcript.delta', event_id: 'speech', delta: 'New facts.' });
  deliveryState = 'sent'; await f.calls.tick();
  assert.equal(f.submissions[0][1], f.submissions[1][1]); assert.equal(f.submissions[0][2], f.submissions[1][2]);
  assert.deepEqual(f.submissions[1][3], { steer: true }); assert.equal(f.releases.length, 1);
  assert(row.deliveredSeq < row.updateSeq);
  row.urgent = true; await f.calls.tick(); assert.match(f.submissions[2][2], /New facts/);
});

test('uncertain supervisor delivery is held instead of retried', async t => {
  const f = fixture(t), start = await f.calls.start('one', task);
  f.api.submitRequest = async (...args) => { f.submissions.push(args); return { state: 'uncertain', message: 'Inspect terminal' }; };
  await f.calls.tick(); await f.calls.tick();
  assert.equal(f.submissions.length, 1); assert.equal(f.calls.get(start.id).updateDelivery, 'uncertain');
  assert(f.errors.length);
  f.calls.acknowledged(f.submissions[0][1]); await f.calls.tick();
  assert.equal(f.submissions.length, 1, 'acknowledging never replays the possibly delivered update');
});

test('control loss explicitly hangs up; stop is idempotent and captures final usage', async t => {
  const f = fixture(t), start = await f.calls.start('one', task), row = f.calls.get(start.id);
  f.connections.get(start.providerId).disconnected('Connection lost'); await immediate();
  assert.deepEqual(f.metrics.hangups, [start.providerId]); assert.equal(row.state, 'ended');
  assert.equal(row.finalized, true); assert.equal(row.usageSeconds, 17);
  await f.calls.stop(row); assert.equal(f.metrics.hangups.length, 1);
});

test('failed hangup stays uncertain and allows an explicit stop retry', async t => {
  let fail = true;
  const f = fixture(t, { hangup: async () => { if (fail) throw Error('offline'); return {}; } });
  const start = await f.calls.start('one', task), row = f.calls.get(start.id);
  await assert.rejects(f.calls.stop(row), /not confirmed/); assert.equal(row.state, 'uncertain');
  fail = false; await f.calls.stop(row); assert.equal(f.metrics.hangups.length, 2);
  assert.equal(row.hangupAccepted, true); assert.equal(row.finalized, false);
});

test('restart ends known remote calls rather than redialing; corrupt state is preserved', async t => {
  const f = fixture(t), start = await f.calls.start('one', task);
  const recovered = new Calls(f.api, f.options); await recovered.recover();
  assert.equal(f.metrics.creates, 1); assert(f.metrics.hangups.includes(start.providerId));
  assert.equal(recovered.rows[0].state, 'ended'); assert.equal(recovered.rows[0].finalized, false); await recovered.close();
  fs.writeFileSync(join(f.dir, 'calls.json'), '{broken');
  const broken = new Calls(f.api, f.options);
  await assert.rejects(broken.start('two', task), /call store/);
  assert.equal(fs.readFileSync(join(f.dir, 'calls.json'), 'utf8'), '{broken'); await broken.close();
});

test('cancel during call creation hangs up the eventual call ID', async t => {
  let finish;
  const f = fixture(t, { create: () => new Promise(resolve => { finish = resolve; }) });
  const starting = f.calls.start('one', task); await immediate();
  const row = f.calls.rows[0]; await f.calls.stop(row);
  finish({ session: { id: 'live_late' } }); await starting;
  assert.deepEqual(f.metrics.hangups, ['live_late']); assert.equal(row.state, 'ended');
});

test('local duration deadline explicitly hangs up the remote call', async t => {
  const f = fixture(t);
  let time = 0; f.calls.now = () => { time += 200_000; return time; };
  const started = await f.calls.start('one', task);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.metrics.hangups, [started.providerId]); assert.equal(f.calls.get(started.id).state, 'ended');
});

test('provider request uses Live SIP, masks errors and never retries ambiguous failures', async () => {
  const requests = [];
  const p = new OpenAILive(config, { fetchImpl: async (url, options) => {
    requests.push({ url, options }); return { ok: true, text: async () => '{"session":{"id":"live_test"}}' };
  } });
  await p.create(task);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(body.session.model, 'gpt-live-1'); assert.equal(body.session.delegation.type, 'client');
  assert.equal(body.session.audio.output.voice, 'marin');
  assert.match(body.session.instructions, /Speak naturally and concisely/);
  assert.equal(body.transport.trunk.auth.password, config['sip-password']); assert(!body.session.audio.format);
  const errorProvider = new OpenAILive(config, { fetchImpl: async () => ({ ok: false, status: 502, text: async () => JSON.stringify({ error: { message: config['sip-password'] } }) }) });
  await assert.rejects(errorProvider.create(task), error => !error.definite && !error.message.includes(config['sip-password']));
});

test('voice preferences reach OpenAI while task permissions remain; invalid preferences cannot dial', async t => {
  const f = fixture(t);
  f.settings.voice = 'cedar'; f.settings.instructions = 'Speak Hebrew, slowly, in one short sentence.';
  let payload;
  const provider = new OpenAILive(configuration(f.api), { fetchImpl: async (_, options) => {
    payload = JSON.parse(options.body); return { ok: true, text: async () => '{"session":{"id":"live_preferences"}}' };
  } });
  await provider.create({ ...task, limits: 'Information gathering only.' });
  assert.equal(payload.session.audio.output.voice, 'cedar');
  assert.match(payload.session.instructions, /Speak Hebrew, slowly/);
  assert.match(payload.session.instructions, /Permission limits: Information gathering only/);
  assert.equal(payload.session.delegation.type, 'client');
  f.settings.voice = 'not-a-voice';
  await assert.rejects(f.calls.start('one', task), /Choose a supported voice/);
  f.settings.voice = 'cedar'; f.settings.instructions = 'x'.repeat(8001);
  await assert.rejects(f.calls.start('one', task), /8,000 characters/);
  assert.equal(f.metrics.creates, 0);
});

test('sideband authenticates privately, discards reflected audio and has no session.start', async () => {
  let socket, endpoint, options;
  class Socket extends EventEmitter { constructor(url, opts) { super(); socket = this; endpoint = url; options = opts; this.readyState = 1; } terminate() { this.emit('close'); } send(value) { this.sent = value; } ping() {} }
  const seen = [], p = new OpenAILive(config, { Socket });
  const conn = p.attach('live_test', { event: event => seen.push(event), disconnected: () => assert.fail('intentional close') });
  socket.emit('open'); await conn.ready;
  assert.equal(options.headers.Authorization, 'Bearer ' + config['openai-key']); assert(!endpoint.includes(config['openai-key']));
  socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'audio' }));
  socket.emit('message', JSON.stringify({ type: 'transport.answered' }));
  assert.equal(seen.length, 1); assert.equal(socket.sent, undefined); conn.close();
});

test('commands report missing configuration and enforce call ownership; browser cannot dial', async t => {
  const f = fixture(t); const service = await activate(f.api, f.options);
  f.settings['sip-password'] = '';
  const missing = await f.run('setup'); assert.equal(JSON.parse(missing.stdout).ready, true); assert.equal(JSON.parse(missing.stdout).phone.ready, false);
  assert.equal((await f.run('start', [], task)).exitCode, 1);
  f.settings['sip-password'] = config['sip-password'];
  const started = await f.run('start', [], task), id = JSON.parse(started.stdout).id;
  assert.equal((await f.run('stop', [id], undefined, 'other')).exitCode, 1);
  let reply;
  await f.messages.get('request')({ action: 'start', requestId: 'browser' }, { reply: (_, value) => { reply = value; } });
  assert.equal(reply.ok, false); assert.equal(f.metrics.creates, 1);
  await service.close();
});

test('packaged plugin loads in an isolated engine and secrets stay out of snapshots', async t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-voice-worker-')), bundled = join(dir, 'bundled'); fs.mkdirSync(bundled);
  const server = new HeadlessServer({ port: 0, dataDir: join(dir, 'data'), bundledPluginsDir: bundled, pluginCatalogDir: resolve(__dirname, '../plugin-packages'), autoSaveMs: 0 });
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await server.listen();
  assert.equal(server.pluginManager.records.get('voice-agent').worker, null);
  await server.pluginManager.updateSettings('voice-agent', { 'openai-key': 'sk-private-fixture' });
  await server.pluginManager.setEnabled('voice-agent', true);
  const result = await server.pluginManager.runCommand('voice-agent', 'setup', { args: [], sessionId: 'fixture' });
  assert.equal(JSON.parse(result.stdout).ready, true);
  assert.equal(JSON.parse(result.stdout).phone.ready, false);
  assert.equal(JSON.parse(result.stdout).supervisorSupported, true);
  assert(!JSON.stringify(server.pluginManager.snapshot()).includes('sk-private-fixture'));
  assert(!result.stdout.includes('sk-private-fixture'));
  await server.pluginManager.updateSettings('voice-agent', { 'talk-to-sessions': false });
  const disabled = await server.pluginManager.runCommand('voice-agent', 'setup', { args: [], sessionId: 'fixture' });
  assert.equal(JSON.parse(disabled.stdout).ready, false);
  assert.match(JSON.parse(disabled.stdout).errors[0], /Talk to sessions/);
});

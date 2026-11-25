const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');
const { PluginRequests } = require('../src/plugin-requests');
const { PluginManager } = require('../src/plugin-manager');
const { createSessionDelivery } = require('../src/session-delivery');

async function fixture(t, { provider = 'codex', plugin = false } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-plugin-requests-')), bundled = join(dir, 'bundled'); fs.mkdirSync(bundled);
  if (plugin) {
    const path = join(bundled, 'test-plugin'); fs.mkdirSync(path);
    fs.writeFileSync(join(path, 'clideck-plugin.json'), JSON.stringify({ id: 'test-plugin', name: 'Test plugin', version: '1.0.0', apiVersion: 1,
      commands: [{ name: 'probe', description: 'Check worker requests.', usage: 'test-plugin/probe' }] }));
    fs.writeFileSync(join(path, 'server.js'), `exports.activate = api => {
      api.registerCommand('probe', async ({ args, sessionId }) => ({ stdout: JSON.stringify(args[0] === 'submit'
        ? await api.submitRequest(sessionId, 'worker-request', 'worker update', { steer: true })
        : args[0] === 'turns' ? await api.getTurns(sessionId, 4, 5)
        : { capabilities: api.capabilities, frozen: Object.isFrozen(api.capabilities) }) }));
    };`);
  }
  const server = new HeadlessServer({ port: 0, dataDir: dir, autoSaveMs: 0, bundledPluginsDir: bundled });
  const session = new AgentSession({ id: 'request-session', name: 'Main', provider: getProvider(provider), cwd: dir, promptSubmitDelay: () => 5, submitRetryMs: 10000 });
  const writes = [], events = [];
  session.status = 'idle'; session.sessionStarted = true;
  session.terminal = { write: value => writes.push(value), kill: () => session.handleExit(0, null) };
  session.close = () => session.handleExit(0, null);
  session.on('reply', event => { events.push(event); server.pluginRequests.reply(event); });
  server.sessions.set(session.id, session); server.persistence.register(session);
  await server.listen(); t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const submit = (id, text = 'question', options) => server.pluginRequests.submit('test-plugin', session.id, id, text, options);
  const start = text => session.handleHook('start', { turn_id: 'native-' + events.length, prompt: text });
  return { dir, server, session, writes, events, submit, start };
}

test('only native prompt echoes after Enter establish reply ownership; next final alone cannot', async t => {
  const f = await fixture(t); await f.submit('request-one');
  f.session.handleHook('stop', { last_assistant_message: 'unmatched stale answer' });
  assert.equal(f.events.filter(e => e.type === 'agent.final').length, 0);
  f.session.handleHook('start', { turn_id: 'unrelated', prompt: 'peer question' });
  f.session.handleHook('stop', { turn_id: 'unrelated', last_assistant_message: 'peer answer' });
  assert.equal(f.events.filter(e => e.type === 'agent.final').length, 0);
});

test('owned requests deduplicate, record their own final and never inherit a continuation', async t => {
  const f = await fixture(t); await f.submit('request-one');
  f.start('question');
  f.session.handleHook('stop', { turn_id: f.session.activeHookTurn, last_assistant_message: 'owned answer' });
  assert.equal(f.server.pluginRequests.list('test-plugin')[0].answer, 'owned answer');
  const before = f.writes.length; assert.equal((await f.submit('request-one')).state, 'sent'); assert.equal(f.writes.length, before);
  f.session.handleHook('start', { turn_id: 'continuation' });
  f.session.handleHook('stop', { turn_id: 'continuation', last_assistant_message: 'background continuation' });
  assert.deepEqual(f.events.filter(e => e.type === 'agent.final').map(e => e.text), ['owned answer']);
  await assert.rejects(f.submit('request-one', 'different'), /different prompt/);
});

test('native matching bypasses a missing older echo; a peer steer invalidates phone ownership', async t => {
  const f = await fixture(t);
  f.session.pendingPromptEchoes.push({ text: 'lost hook', origin: 'agent', at: Date.now(), submitted: true });
  await f.submit('request-one'); f.start('question');
  assert.equal(f.session.replyOwner.requestId, 'request-one');
  f.session.steerPrompt('peer steering');
  assert.equal(f.session.replyOwner, null);
  assert.match(f.server.pluginRequests.list('test-plugin')[0].message, /steered/);
});

test('terminal focus and protocol reports preserve phone ownership; actual typing still ends it', async t => {
  const f = await fixture(t); await f.submit('request-one'); f.start('question');
  for (const data of ['\x1b[I', '\x1b[O', '\x1b[I\x1b[O', '\x1b[12;40R', '\x1b[?1;2c',
    '\x1b[>0;276;0c', '\x1b[0n', '\x1b[?1u', '\x1b]11;rgb:0000/0000/0000\x07']) {
    f.session.writeInput(data, { fromUser: true });
    assert.equal(f.writes.at(-1), data, 'report still reaches the PTY');
    assert.equal(f.session.replyOwner?.requestId, 'request-one', JSON.stringify(data));
  }
  f.session.emitAgentUpdate('Reading the chats.');
  assert.equal(f.events.at(-1).type, 'agent.update');
  assert.equal(f.events.at(-1).requestId, 'request-one');
  f.session.writeInput('new input', { fromUser: true });
  assert.equal(f.session.replyOwner, null);
  assert.match(f.server.pluginRequests.list('test-plugin')[0].message, /Input changed/);
});

test('busy and typing never paste; native safe resume refuses a missing conversation handle', async t => {
  const f = await fixture(t); f.session.status = 'working';
  assert.equal((await f.submit('request-one')).state, 'waiting'); assert.equal(f.writes.length, 0);
  f.session.status = 'idle'; f.session.markUserActivity();
  assert.equal((await f.submit('request-one')).state, 'waiting'); assert.equal(f.writes.length, 0);
  f.server.sessions.delete(f.session.id);
  assert.equal((await f.server.pluginRequests.submit('test-plugin', f.session.id, 'other', 'hello', { resume: true })).state, 'error');
  f.server.sessions.set(f.session.id, f.session);
});

test('interrupted paste stays uncertain across restart and blocks every automatic sender until acknowledged', async t => {
  const f = await fixture(t), pending = f.submit('request-one');
  f.session.markUserActivity(); assert.equal((await pending).state, 'uncertain');
  const restored = new PluginRequests(f.server); f.server.pluginRequests = restored;
  assert.equal(restored.uncertain(f.session.id).id, 'request-one');
  assert.equal((await restored.submit('test-plugin', f.session.id, 'request-one', 'question')).state, 'uncertain');
  f.session.userActivityUntil = 0;
  let committed = false;
  const result = await createSessionDelivery(f.server)({ sessionId: f.session.id, pending: {}, resumeSession: false },
    { commit() { committed = true; }, checkpoint() {}, signal: new AbortController().signal, message: 'background message' });
  assert.equal(result.state, 'waiting'); assert.equal(committed, false);
  assert.equal(await restored.release('test-plugin', 'request-one'), false);
  await restored.release('other-plugin', 'request-one', true); assert(restored.uncertain(f.session.id));
  await restored.release('test-plugin', 'request-one', true); assert(!restored.uncertain(f.session.id));
  assert.equal(f.writes.filter(x => x === '\r').length, 0);
});

test('Stop is limited to the exact owned active turn; disabling never interrupts later work', async t => {
  const f = await fixture(t); await f.submit('request-one'); f.start('question');
  assert.equal(f.server.pluginRequests.cancel('other-plugin', 'request-one'), false);
  assert.equal(f.server.pluginRequests.cancel('test-plugin', 'request-one'), true);
  assert.equal(f.writes.at(-1), '\x1b'); assert.equal(f.session.replyOwner, null);
  f.session.handleHook('start', { turn_id: 'later', prompt: 'local work' });
  const before = f.writes.length; assert.equal(f.server.pluginRequests.cancel('test-plugin', 'request-one'), false);
  f.server.pluginRequests.stopPlugin('test-plugin'); assert.equal(f.writes.length, before);
});

test('engine restart returns a completed failure receipt rather than resubmitting accepted work', async t => {
  const f = await fixture(t); await f.submit('request-one'); f.start('question');
  const restored = new PluginRequests(f.server);
  const receipt = restored.list('test-plugin')[0]; assert.equal(receipt.state, 'complete'); assert.match(receipt.message, /restarted/);
  const before = f.writes.length; await restored.submit('test-plugin', f.session.id, 'request-one', 'question'); assert.equal(f.writes.length, before);
});

test('core errors can acknowledge a disabled plugin request without loading its code', async t => {
  const f = await fixture(t), pending = f.submit('request-one');
  f.session.markUserActivity(); await pending; f.server.pluginRequests.stopPlugin('test-plugin');
  const url = f.server.address().httpUrl + '/api/session/errors';
  const response = await fetch(url + '?callerSessionId=' + f.session.id), body = await response.json();
  const id = body.notices.find(row => row.operation === 'plugin test-plugin').id;
  const ack = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerSessionId: f.session.id, action: 'acknowledge', id }) });
  assert.equal(ack.status, 200); assert(!f.server.pluginRequests.uncertain(f.session.id)); assert.equal(f.writes.filter(value => value === '\r').length, 0);
});

test('automatic prompts clear stale desktop attribution before native echo matching', async t => {
  const f = await fixture(t); f.session.rawInputOrigin = 'desktop';
  f.session.sendPrompt('monitor result'); await new Promise(resolve => setTimeout(resolve, 10));
  f.session.handleHook('start', { turn_id: 'monitor', prompt: 'different native rendering' });
  assert.equal(f.session.replyOwner, null);
});

for (const provider of ['codex', 'claude-code']) test(`${provider}: busy plugin steering is durable delivery only and ends prior reply ownership`, async t => {
  const f = await fixture(t, { provider });
  await f.submit('owned'); f.start('question');
  assert.equal(f.session.replyOwner.requestId, 'owned');
  f.session.baselineCandidate = 'existing turn';
  const snapshots = [], write = f.session.terminal.write;
  f.session.terminal.write = text => {
    snapshots.push(JSON.parse(fs.readFileSync(f.server.pluginRequests.path, 'utf8')).find(row => row.id === 'steer-one'));
    write(text);
  };
  const result = await f.submit('steer-one', 'new constraint', { steer: true });
  assert.equal(result.state, 'sent'); assert.equal(result.steered, true); assert.match(result.message, /delivery only/);
  assert(snapshots.every(row => row.state === 'delivering' && row.steer === true));
  assert.equal(f.session.baselineCandidate, 'existing turn'); assert.equal(f.session.replyOwner, null);
  assert.equal(f.session.status, 'working');
  assert.equal(f.writes.filter(text => text.includes('new constraint')).length, 1);
  f.start('new constraint'); f.session.emitProtocol('agent.final', { text: 'answer to the ongoing work' });
  const receipt = f.server.pluginRequests.list('test-plugin').find(row => row.id === 'steer-one');
  assert.equal(receipt.state, 'complete'); assert.equal(receipt.steered, true); assert.equal(receipt.answer, undefined);
  assert.equal(f.events.some(event => event.requestId === 'steer-one'), false);
  assert.equal(f.server.pluginRequests.cancel('test-plugin', 'steer-one'), false);
  const restored = new PluginRequests(f.server), before = f.writes.length;
  assert.deepEqual(await restored.submit('test-plugin', f.session.id, 'steer-one', 'new constraint', { steer: true }), result);
  assert.equal(f.writes.length, before);
  assert.equal(restored.list('test-plugin').find(row => row.id === 'steer-one').message, result.message);
});

test('steer opt-in keeps native reply ownership when the target is idle', async t => {
  const f = await fixture(t), result = await f.submit('idle', 'question', { steer: true });
  assert.equal(result.state, 'sent'); assert.equal(result.steered, undefined);
  f.start('question'); assert.equal(f.session.replyOwner.requestId, 'idle');
  f.session.emitProtocol('agent.final', { text: 'owned answer' });
  assert.equal(f.server.pluginRequests.list('test-plugin')[0].answer, 'owned answer');
});

test('steering validates and binds delivery options to the stable request ID', async t => {
  const f = await fixture(t); f.session.status = 'working'; f.session.markUserActivity();
  for (const options of [{ steer: 'true' }, { steer: 1 }, { resume: 1 }, { unknown: true }]) {
    await assert.rejects(f.submit('invalid', 'update', options), /Invalid plugin request/);
  }
  assert.equal(f.server.pluginRequests.list('test-plugin').length, 0);
  assert.equal((await f.submit('held', 'update', { steer: true })).state, 'waiting');
  await assert.rejects(f.submit('held', 'update'), /different delivery options/);
  await assert.rejects(f.submit('held', 'update', { steer: true, resume: true }), /different delivery options/);
  f.server.pluginRequests = new PluginRequests(f.server); f.session.userActivityUntil = 0;
  assert.equal((await f.submit('held', 'update', { steer: true })).steered, true);
  await assert.rejects(f.submit('held', 'update', { steer: false }), /different delivery options/);
});

test('steering waits for typing, menus, submission and session shutdown without pasting', async t => {
  const f = await fixture(t); f.session.status = 'working';
  const gates = [
    () => { f.session.markUserActivity(); return () => { f.session.userActivityUntil = 0; }; },
    () => { f.session.menu = [{ label: 'Approve' }]; return () => { f.session.menu = []; }; },
    () => { f.session.pendingSubmission = { submitted: false }; return () => { f.session.pendingSubmission = null; }; },
    () => { f.session.closeRequested = true; return () => { f.session.closeRequested = false; }; },
  ];
  for (const gate of gates) {
    const reset = gate();
    try { assert.equal((await f.submit('guarded', 'update', { steer: true })).state, 'waiting'); assert.equal(f.writes.length, 0); }
    finally { reset(); }
  }
  assert.equal((await f.submit('guarded', 'update', { steer: true })).steered, true);
});

test('steering respects outstanding ask reservations without claiming their final reply', async t => {
  const f = await fixture(t);
  f.server.askCoordinator.active.set(f.session.id, true);
  const result = await f.submit('steer-one', 'update', { steer: true });
  assert.equal(result.steered, true); assert.equal(f.server.askCoordinator.isActive(f.session.id), true);
  f.start('update'); assert.equal(f.session.replyOwner, null);
});

test('interrupted steering stays uncertain after restart and blocks other requests until inspected', async t => {
  const f = await fixture(t); f.session.status = 'working';
  const delivery = f.submit('steer-one', 'update', { steer: true });
  assert.equal((await f.submit('steer-one', 'update', { steer: true })).state, 'waiting');
  f.session.markUserActivity();
  assert.equal((await delivery).state, 'uncertain');
  f.server.pluginRequests = new PluginRequests(f.server); f.session.userActivityUntil = 0;
  const before = f.writes.length;
  assert.equal((await f.submit('steer-one', 'update', { steer: true })).state, 'uncertain');
  const held = await f.submit('another', 'later update', { steer: true });
  assert.equal(held.state, 'waiting'); assert.match(held.message, /plugin-request:test-plugin:steer-one/);
  assert.equal(f.writes.length, before); assert.equal(f.writes.filter(text => text === '\r').length, 0);
  assert.equal(await f.server.pluginRequests.release('test-plugin', 'steer-one'), false);
  assert.equal(await f.server.pluginRequests.release('test-plugin', 'steer-one', true), true);
});

test('monitor and error uncertainty also block opted-in busy steering', async t => {
  const f = await fixture(t); f.session.status = 'working';
  const monitor = { id: 'uncertain-monitor', sessionId: f.session.id, pending: { phase: 'uncertain' } };
  f.server.monitors.rows.push(monitor);
  assert.match((await f.submit('held', 'update', { steer: true })).message, /monitor acknowledge uncertain-monitor/);
  f.server.monitors.rows.pop();
  f.server.agentErrors.records.set('uncertain-error', { sessionId: f.session.id, pending: { id: 'uncertain-error', phase: 'uncertain' } });
  assert.match((await f.submit('held', 'update', { steer: true })).message, /errors acknowledge uncertain-error/);
  f.server.agentErrors.records.delete('uncertain-error'); assert.equal(f.writes.length, 0);
});

test('steering cannot bypass native resume requirements or claim delivery without a receipt', async t => {
  const f = await fixture(t); f.server.sessions.delete(f.session.id);
  assert.equal((await f.submit('stopped', 'update', { steer: true })).state, 'waiting');
  assert.match((await f.submit('resume', 'update', { steer: true, resume: true })).message, /No saved conversation/);
  f.server.sessions.set(f.session.id, f.session); f.session.status = 'working';
  f.session.steerPrompt = () => true;
  assert.equal((await f.submit('missing-receipt', 'update', { steer: true })).state, 'uncertain');
  assert.equal(f.writes.length, 0);
});

test('real workers receive runtime steering capability and can deliver; absent parent capability stays absent', async t => {
  const f = await fixture(t, { plugin: true });
  const probe = (manager, args = []) => manager.runCommand('test-plugin', 'probe', { args, sessionId: f.session.id });
  const info = JSON.parse((await probe(f.server.pluginManager)).stdout);
  assert.deepEqual(info, { capabilities: { sessionSteer: true, boundedTurns: true }, frozen: true });
  f.server.transcriptStore.append(f.session.id, 'agent', 'the latest words');
  assert.deepEqual(JSON.parse((await probe(f.server.pluginManager, ['turns'])).stdout), [{ role: 'agent', text: 'words' }]);
  f.session.status = 'working';
  const result = JSON.parse((await probe(f.server.pluginManager, ['submit'])).stdout);
  assert.equal(result.state, 'sent'); assert.equal(result.steered, true);
  const oldParent = new PluginManager({ dataDir: join(f.dir, 'old-parent'), bundledDir: join(f.dir, 'bundled'), catalogDir: join(f.dir, 'empty'), log() {} });
  try {
    await oldParent.start();
    assert.deepEqual(JSON.parse((await probe(oldParent)).stdout), { capabilities: {}, frozen: true });
  } finally { await oldParent.close(); }
});

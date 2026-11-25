const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { ChatBridge } = require('../plugin-packages/chat-apps/bridge');
const { WhatsApp } = require('../plugin-packages/chat-apps/whatsapp');
const { activate } = require('../plugin-packages/chat-apps/server');

const GROUP = '120363001@g.us', OTHER = '120363002@g.us', NOW = 1800000000000;
function fixture(t, dataDir) {
  const dir = dataDir || fs.mkdtempSync(join(tmpdir(), 'clideck-chat-apps-'));
  const submitted = [], sent = [], released = [], notices = [], receipts = [];
  let serial = 0, validGroup = true, clock = NOW;
  const api = { id: 'chat-apps', dataDir: dir,
    getSessions: async () => [{ sessionId: 'personal', name: 'Personal assistant', provider: 'claude-code', projectId: 'p' },
      { sessionId: 'legal', name: 'Legal assistant', provider: 'codex', projectId: 'p' }, { sessionId: 'shell', provider: 'shell' }],
    getProjects: async () => [{ id: 'p', name: 'Personal' }],
    getRequests: async () => receipts,
    submitRequest: async (...args) => { submitted.push(args); receipts.push({ id: args[1], state: 'working' }); return { state: 'sent' }; },
    releaseRequest: async id => { released.push(id); return true; },
    acknowledgeRequest: async id => { released.push(id); },
    notifyUser: async (...args) => notices.push(args), sendToClients() {},
  };
  const transport = { status: 'connected', snapshot() { return { status: this.status, qrDataUrl: 'data:image/png;base64,PRIVATE', error: '' }; },
    start: async () => {}, close: async () => {}, connect() {}, disconnect: async () => { transport.status = 'disconnected'; },
    groups: async () => [{ id: GROUP, name: 'Notes' }],
    verifyGroup: async id => { if (!validGroup) throw Error('Only-you group required'); return { id, subject: 'Notes' }; },
    messageId: () => 'OUT' + ++serial,
    send: async (...args) => { sent.push(args); },
  };
  const bridge = new ChatBridge(api, { transport, now: () => clock, timers: false });
  bridge.connectedAt = NOW / 1000;
  t.after(async () => { await bridge.close(); if (!dataDir) fs.rmSync(dir, { recursive: true, force: true }); });
  const message = (id = 'MSG1', text = 'Hello', group = GROUP, more = {}) => ({ type: 'notify', messages: [{
    key: { id, remoteJid: group, fromMe: true }, messageTimestamp: NOW / 1000, message: { conversation: text }, ...more,
  }] });
  return { dir, bridge, api, transport, submitted, sent, released, notices, receipts, message,
    setValid: value => { validGroup = value; }, advance: ms => { clock += ms; } };
}

test('Chat apps links one own-only group to one supported agent', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  assert.equal(f.bridge.snapshot().routes[0].sessionId, 'personal');
  assert.equal(f.bridge.snapshot().sessions[0].projectName, 'Personal');
  await assert.rejects(f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'legal' }), /already connected/);
  await assert.rejects(f.bridge.act({ action: 'bind', groupId: OTHER, sessionId: 'personal' }), /already connected/);
  await assert.rejects(f.bridge.act({ action: 'bind', groupId: OTHER, sessionId: 'shell' }), /Claude or Codex/);
  f.setValid(false);
  await assert.rejects(f.bridge.act({ action: 'bind', groupId: OTHER, sessionId: 'legal' }), /Only-you/);
});

test('only fresh own messages in linked groups become prompts; history and duplicates do not', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive({ ...f.message('history'), type: 'append' });
  await f.bridge.receive(f.message('old', 'old', GROUP, { messageTimestamp: NOW / 1000 - 1 }));
  await f.bridge.receive(f.message('stranger', 'no', GROUP, { key: { id: 'stranger', remoteJid: GROUP, fromMe: false } }));
  await f.bridge.receive(f.message('unlinked', 'no', OTHER));
  assert.equal(f.bridge.state.requests.length, 0);
  await f.bridge.receive(f.message()); await f.bridge.receive(f.message());
  await f.bridge.tick();
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0][0], 'personal'); assert.equal(f.submitted[0][2], 'Hello');
  assert.deepEqual(f.submitted[0][3], { resume: true });
  await f.bridge.tick(); assert.equal(f.submitted.length, 1);
});

test('agent answers stay in their group and synchronous outgoing echoes never loop', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.act({ action: 'bind', groupId: OTHER, sessionId: 'legal' });
  await f.bridge.receive(f.message('one', 'personal question'));
  await f.bridge.receive(f.message('two', 'legal question', OTHER));
  await f.bridge.tick();
  f.receipts[0].state = 'complete'; f.receipts[0].answer = 'Personal answer';
  f.receipts[1].state = 'complete'; f.receipts[1].answer = 'Legal answer';
  f.transport.send = async (group, text, id) => { f.sent.push([group, text, id]); await f.bridge.receive(f.message(id, text, group)); };
  await f.bridge.tick();
  assert.equal(f.submitted.length, 2); assert.equal(f.bridge.state.requests.length, 0);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0][0], GROUP); assert.match(f.sent[0][1], /Personal assistant\]\n\*Final response\*\nPersonal answer$/);
  assert.equal(f.sent[1][0], OTHER); assert.match(f.sent[1][1], /Legal assistant\]\n\*Final response\*\nLegal answer$/);
  assert.equal(f.released.length, 2);
  assert.equal(f.bridge.state.sent.length, 2); // Keep originals for WhatsApp decryption retries.
  assert.equal(fs.statSync(f.bridge.file).mode & 0o777, 0o600);
});

test('terminal previews stay local while explicit notices and final replies reach WhatsApp', async t => {
  const f = fixture(t), events = new EventEmitter();
  Object.assign(f.api, { onShutdown() {}, onClientMessage() {}, registerCommand() {},
    onEvent(types, handler) { for (const type of [types].flat()) events.on(type, handler); } });
  const bridge = await activate(f.api, { transport: f.transport, timers: false, now: () => NOW });
  t.after(() => bridge.close());
  bridge.connectedAt = NOW / 1000;
  await bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await bridge.receive(f.message()); await bridge.tick();
  const row = bridge.state.requests[0];
  for (let second = 1; second <= 8; second++) {
    events.emit('session.reply', { phase: 'agent.update', origin: 'plugin:chat-apps',
      requestId: row.id, sessionId: 'personal', text: 'Running… ' + second });
    await bridge.tick();
  }
  events.emit('user.notice', { id: 'notice-1', origin: 'agent', sessionId: 'personal', text: 'Found three listings.' });
  f.receipts[0].state = 'complete'; f.receipts[0].answer = 'Here are the prices.';
  await bridge.tick();
  assert.deepEqual(f.sent.map(message => message[1]), [
    '[CliDeck · Personal · Personal assistant]\n*Status*\nThe agent is working on your request.',
    '[CliDeck · Personal · Personal assistant]\nFound three listings.',
    '[CliDeck · Personal · Personal assistant]\n*Final response*\nHere are the prices.',
  ]);
});

test('losing reply tracking explains where to follow up without claiming work continues', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  Object.assign(f.receipts[0], { state: 'sent' });
  await f.bridge.tick();
  Object.assign(f.receipts[0], { state: 'complete', message: 'Input changed in CliDeck. Check the conversation there.' });
  await f.bridge.tick();
  assert.deepEqual(f.sent.map(message => message[1]), [
    '[CliDeck · Personal · Personal assistant]\n*Status*\nWhatsApp stopped tracking this request. Open the agent’s chat in CliDeck to follow up.',
  ]);
});

for (const boundary of ['same turn', 'turn.user', 'status', 'session.closed', 'turn.started']) test(
  'final after terminal input stays with the original WhatsApp turn: ' + boundary, async t => {
    const f = fixture(t); await f.bridge.start();
    await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
    await f.bridge.receive(f.message()); await f.bridge.tick();
    const receipt = f.receipts[0], sessionId = 'personal';
    const reason = 'Input changed in CliDeck. Check the conversation there.';
    f.bridge.observeTurn({ type: 'session.reply', phase: 'turn.ended', origin: 'plugin:chat-apps',
      sessionId, requestId: receipt.id, reason });
    Object.assign(receipt, { state: 'complete', message: reason });
    await f.bridge.tick(); assert.equal(f.sent.length, 0);
    if (boundary === 'turn.started') f.bridge.observeTurn({ type: 'session.reply', phase: boundary, sessionId });
    else if (boundary !== 'same turn') f.bridge.observeTurn({ type: boundary, state: 'idle', sessionId });
    f.bridge.observeTurn({ type: 'agent.final', sessionId, text: 'Search complete.' });
    await f.bridge.tick();
    assert.equal(f.sent.length, 1);
    if (boundary === 'same turn') assert.match(f.sent[0][1], /\*Final response\*\nSearch complete\.$/);
    else assert.doesNotMatch(f.sent[0][1], /Search complete/);
  });

test('a submitted prompt merged with a terminal draft ends without routing the unrelated answer', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  f.receipts[0].state = 'sent'; // Native prompt echo never confirmed ownership.
  f.bridge.observeTurn({ type: 'agent.final', sessionId: 'personal', text: 'Private draft answer.' });
  await f.bridge.tick();
  assert.equal(f.bridge.state.requests.length, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /could not match/);
  assert.doesNotMatch(f.sent[0][1], /Private draft/);
});

test('queued messages wait safely, membership changes stop delivery, unbinding never reroutes', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  f.api.submitRequest = async (...args) => { f.submitted.push(args); return { state: 'waiting' }; };
  await f.bridge.receive(f.message()); await f.bridge.tick();
  await f.bridge.tick(); assert.equal(f.submitted.length, 1);
  f.advance(11000); f.setValid(false); await f.bridge.tick();
  assert.equal(f.submitted.length, 1); assert.equal(f.notices.length, 1);
  await f.bridge.act({ action: 'unbind', groupId: GROUP });
  assert.equal(f.bridge.state.requests.length, 0);
  assert.equal(f.sent.length, 0);
});

for (const delivered of [false, true]) test(`final answer replaces matching ${delivered ? 'delivered' : 'queued'} terminal update despite Markdown and wrapping`, async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  const row = f.bridge.state.requests[0];
  const screen = 'Waiting on two answers:\n- Daniel: why are you\nselling?\n- Prince: is cash on delivery OK?';
  const final = 'Waiting on two answers:\n- **Daniel:** why are you selling?\n- **Prince:** is cash on delivery OK?';
  // Simulate an in-flight request saved before terminal forwarding was removed.
  row.lastProgressText = screen;
  row.lastProgressIds = f.bridge.queue(f.bridge.state.routes[0], screen, 'Working update');
  if (delivered) await f.bridge.tick();
  const originalId = (delivered ? f.bridge.state.sent : f.bridge.state.outbox)[0].messageId;
  f.receipts[0].state = 'complete'; f.receipts[0].answer = final;
  await f.bridge.tick();
  assert.equal(f.sent.length, delivered ? 2 : 1);
  const outgoing = f.sent.at(-1);
  assert.match(outgoing[1], /\*Final response\*/);
  assert.match(outgoing[1], /- \*Daniel:\* why are you selling\?/);
  assert.doesNotMatch(outgoing[1], /\*\*Daniel/);
  assert.equal(outgoing[3], delivered ? originalId : undefined);
  assert.equal(f.bridge.state.sent.find(item => item.messageId === originalId).text, outgoing[1]);
  // An edit echo must not become another prompt.
  await f.bridge.receive(f.message(outgoing[2], outgoing[1]));
  assert.equal(f.bridge.state.requests.length, 0);
});

test('pending final suppresses matching screen snapshot and leaves code unchanged', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  const row = f.bridge.state.requests[0];
  row.updates = [{ text: 'Unsent terminal preview', at: NOW }];
  f.receipts[0].state = 'complete'; f.receipts[0].answer = '**Done** now.\n`**literal**`\n```\n**also literal**\n```';
  await f.bridge.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /\*Done\* now\.\n`\*\*literal\*\*`\n```\n\*\*also literal\*\*\n```$/);
});

test('an unconfirmed final edit is persisted and never resent after restart', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  const row = f.bridge.state.requests[0];
  row.lastProgressText = 'Finished.';
  row.lastProgressIds = f.bridge.queue(f.bridge.state.routes[0], row.lastProgressText, 'Working update');
  f.advance(1500); await f.bridge.tick();
  const originalId = f.sent[0][2];
  f.receipts[0].state = 'complete'; f.receipts[0].answer = 'Finished.';
  f.transport.send = async (...args) => { f.sent.push(args); throw Error('Connection lost after edit'); };
  await f.bridge.tick();
  assert.equal(f.bridge.state.outbox[0].editMessageId, originalId);
  assert.equal(f.bridge.state.outbox[0].state, 'uncertain');
  const restarted = new ChatBridge(f.api, { transport: f.transport, now: () => NOW + 1500, timers: false });
  await restarted.start(); await restarted.tick(); await restarted.close();
  assert.equal(f.sent.length, 2);
});

test('restart recovers captured replies and does not repeat uncertain submissions or sends', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  await f.bridge.receive(f.message()); await f.bridge.tick();
  const row = f.bridge.state.requests[0]; row.state = 'submitting'; f.bridge.save();
  const recovered = new ChatBridge(f.api, { transport: f.transport, now: () => NOW, timers: false });
  await recovered.start(); await recovered.tick();
  assert.equal(f.submitted.length, 1); // Native receipt says it was sent: do not submit again.
  f.receipts[0].state = 'complete'; f.receipts[0].answer = 'Recovered answer';
  f.transport.send = async () => { throw Error('network lost after send'); };
  await recovered.tick();
  assert.equal(recovered.snapshot().pending.length, 1);
  await recovered.close();
  const restarted = new ChatBridge(f.api, { transport: f.transport, now: () => NOW, timers: false });
  f.transport.send = async (...args) => f.sent.push(args);
  await restarted.start(); await restarted.tick(); assert.equal(f.sent.length, 1); // Only the confirmed working status.
  await restarted.act({ action: 'acknowledge', id: restarted.snapshot().pending[0].id });
  assert.equal(restarted.snapshot().pending.length, 0); assert.equal(f.sent.length, 1);
  await restarted.close();
});

test('uncertain native delivery is inspect-and-clear only; switching a group cannot replay it', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  f.api.submitRequest = async (...args) => { f.submitted.push(args); return { state: 'uncertain', message: 'Inspect terminal' }; };
  await f.bridge.receive(f.message()); await f.bridge.tick(); await f.bridge.tick();
  assert.equal(f.submitted.length, 1);
  const pending = f.bridge.snapshot().pending[0]; assert.equal(pending.message, 'Inspect terminal');
  await f.bridge.act({ action: 'unbind', groupId: GROUP });
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'legal' });
  await f.bridge.tick(); assert.equal(f.submitted.length, 1);
  await f.bridge.act({ action: 'acknowledge', id: pending.id });
  assert.equal(f.bridge.state.requests.length, 0);
});

test('Chat apps commands hide pairing secrets and plugin activation sends no WhatsApp messages', async t => {
  const f = fixture(t), commands = {};
  Object.assign(f.api, { onShutdown() {}, onEvent() {}, onClientMessage() {}, registerCommand: (name, handler) => { commands[name] = handler; } });
  const bridge = await activate(f.api, { transport: f.transport, timers: false });
  const result = await commands.whatsapp({ args: ['status'], sessionId: 'personal' });
  assert.equal(JSON.parse(result.stdout).whatsapp.qrDataUrl, null);
  assert.doesNotMatch(result.stdout, /PRIVATE/); assert.equal(f.sent.length, 0);
  assert.equal((await commands.whatsapp({ args: ['bind'], sessionId: 'personal' })).exitCode, 1);
  await bridge.close();
});

test('Send test reports unconfirmed WhatsApp delivery rather than claiming success', async t => {
  const f = fixture(t); await f.bridge.start();
  await f.bridge.act({ action: 'bind', groupId: GROUP, sessionId: 'personal' });
  f.transport.send = async () => { throw Error('Network timeout'); };
  await assert.rejects(f.bridge.act({ action: 'test', groupId: GROUP }), /could not be confirmed/);
  assert.equal(f.bridge.snapshot().pending.length, 1);
});

test('WhatsApp transport supports PN/LID self-only groups and avoids history/online presence', async t => {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'clideck-whatsapp-'));
  let options, received = 0, sent;
  const ev = new EventEmitter();
  const socket = { ev, user: { id: '111:4@s.whatsapp.net', lid: '999:4@lid', name: 'Or' }, end() {},
    sendMessage: async (...args) => { sent = args; },
    groupFetchAllParticipating: async () => ({
      one: { id: GROUP, subject: 'Notes', participants: [{ id: '999@lid' }] },
      two: { id: OTHER, subject: 'Other', participants: [{ id: '111@s.whatsapp.net' }, { id: '222@s.whatsapp.net' }] },
    }),
  };
  const whatsapp = new WhatsApp({ dataDir, onChange() {}, onMessages: () => received++, getMessage: async () => undefined,
    runtime: async () => ({ baileys: { default: config => { options = config; return socket; },
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => {} }), Browsers: { macOS: () => ['Mac'] }, DisconnectReason: {} },
      qrcode: { toDataURL: async () => 'data:image/png;base64,QR' }, logger: {} }),
  });
  t.after(async () => { await whatsapp.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  whatsapp.connect(); await whatsapp.connectJob; ev.emit('connection.update', { connection: 'open' });
  assert.equal(options.markOnlineOnConnect, false); assert.equal(options.shouldSyncHistoryMessage({}), false);
  assert.equal(options.shouldIgnoreJid('111@s.whatsapp.net'), true);
  assert.deepEqual(await whatsapp.groups(), [{ id: GROUP, name: 'Notes' }]);
  await whatsapp.send(GROUP, 'Final answer', 'EDIT1', 'ORIGINAL1');
  assert.deepEqual(sent, [GROUP, { text: 'Final answer', edit: { remoteJid: GROUP, id: 'ORIGINAL1', fromMe: true } }, { messageId: 'EDIT1' }]);
  ev.emit('messages.upsert', {}); assert.equal(received, 1);
  await whatsapp.close(); ev.emit('messages.upsert', {}); assert.equal(received, 1);
});

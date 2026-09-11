const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { DEFAULT_DATA_DIR, SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');

function temporaryDirectory(name) {
  return mkdtempSync(join(tmpdir(), name));
}

function fakeSession(id = 'session-one') {
  return {
    id,
    provider: { id: 'claude-code' },
    name: 'Reviewer',
    cwd: '/tmp/project',
    cols: 100,
    rows: 30,
    latestUpdate: '',
  };
}

test('v2 persistence uses its own data directory', () => {
  assert.equal(DEFAULT_DATA_DIR.endsWith('/.clideck-next'), true);
  assert.equal(DEFAULT_DATA_DIR.endsWith('/.clideck'), false);
});

function waitFor(messages, predicate, timeoutMs = 2000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const value = messages.find(predicate);
      if (!value) return;
      clearInterval(timer);
      clearTimeout(timeout);
      resolve(value);
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(new Error('timed out waiting for replay event'));
    }, timeoutMs);
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, messages };
}

test('registry and capped terminal history survive reload', () => {
  const dataDir = temporaryDirectory('clideck-next-persistence-');
  let tick = 0;
  try {
    const persistence = new SessionPersistence({
      dataDir,
      historyLimit: 10,
      debounceMs: 10_000,
      now: () => `time-${++tick}`,
    });
    const session = fakeSession();
    session.muted = true;
    persistence.register(session);
    persistence.appendHistory(session.id, '12345678');
    persistence.appendHistory(session.id, 'abcdefgh');
    persistence.recordFinal(session.id, 'final answer', 123456);
    persistence.recordResumeMetadata(session.id, {
      handle: 'native-session-id',
      transcriptPath: '/tmp/native-session-id.jsonl',
    });
    persistence.close();

    const restored = new SessionPersistence({ dataDir, historyLimit: 10 });
    assert.deepEqual(restored.get(session.id), {
      id: session.id,
      provider: 'claude-code',
      name: 'Reviewer',
      cwd: '/tmp/project',
      cols: 100,
      rows: 30,
      muted: true,
      createdAt: 'time-1',
      lastActive: 'time-5',
      lastFinal: 'final answer',
      lastAgentAt: 123456,
      resumeHandle: 'native-session-id',
      transcriptPath: '/tmp/native-session-id.jsonl',
    });
    assert.equal(restored.historyTail(session.id), '78abcdefgh');
    restored.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dormant sessions replay metadata, final preview, and history and can be removed', async () => {
  const dataDir = temporaryDirectory('clideck-next-dormant-');
  const lastActive = '2026-08-01T09:30:00.000Z';
  const seed = new SessionPersistence({ dataDir, debounceMs: 10_000, now: () => lastActive });
  const session = fakeSession('dormant-session');
  seed.register(session);
  seed.recordFinal(session.id, 'saved final', 4242);
  seed.appendHistory(session.id, '\x1b[32msaved terminal\x1b[0m');
  seed.close();

  let server = new HeadlessServer({ port: 0, dataDir });
  let client;
  try {
    const address = await server.listen();
    client = await connect(address.url);
    await waitFor(client.messages, (event) => event.type === 'output');

    assert.deepEqual(client.messages.slice(0, 3).map((event) => event.type), [
      'session.created',
      'agent.update',
      'output',
    ]);
    assert.equal(client.messages[0].sessionId, session.id);
    assert.equal(client.messages[0].name, 'Reviewer');
    assert.equal(client.messages[0].live, false);
    assert.equal(client.messages[0].pid, null);
    assert.equal(client.messages[0].muted, false);
    assert.equal(client.messages[0].lastAgentAt, 4242);
    assert.equal(client.messages[0].lastActive, lastActive);
    assert.equal(client.messages[1].text, 'saved final');
    assert.equal(client.messages[2].data, '\x1b[32msaved terminal\x1b[0m');
    assert.equal(client.messages[2].replay, true);

    // Opening CliDeck again must preserve when this session was used.
    client.socket.close();
    await server.close();
    server = new HeadlessServer({ port: 0, dataDir });
    client = await connect((await server.listen()).url);
    const replayed = await waitFor(client.messages, (event) => event.type === 'session.created');
    assert.equal(replayed.lastActive, lastActive);

    client.socket.send(JSON.stringify({ type: 'prompt', sessionId: session.id, text: 'ignored' }));
    client.socket.send(JSON.stringify({ type: 'input', sessionId: session.id, data: 'ignored' }));
    client.socket.send(JSON.stringify({ type: 'resize', sessionId: session.id, cols: 80, rows: 20 }));
    client.socket.send(JSON.stringify({ type: 'session.close', sessionId: session.id }));
    const closed = await waitFor(client.messages, (event) => event.type === 'session.closed');

    assert.equal(server.persistence.has(session.id), false);
    assert.equal(client.socket.readyState, WebSocket.OPEN);
    assert.equal(closed.exitCode, null);
    assert.equal(closed.signal, null);
  } finally {
    client?.socket.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('closing a live session removes its persisted row across engine restart', async () => {
  const dataDir = temporaryDirectory('clideck-next-live-delete-');
  let server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  let client;
  try {
    let address = await server.listen();
    client = await connect(address.url);
    client.socket.send(JSON.stringify({
      type: 'session.create',
      provider: 'shell',
      name: 'Delete me',
      cwd: dataDir,
    }));
    const created = await waitFor(
      client.messages,
      (event) => event.type === 'session.created' && event.name === 'Delete me',
    );
    client.socket.send(JSON.stringify({
      type: 'session.close', sessionId: created.sessionId,
    }));
    await waitFor(
      client.messages,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
    );
    assert.equal(server.persistence.has(created.sessionId), false);

    client.socket.close();
    client = null;
    await server.close();
    server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
    address = await server.listen();
    assert.deepEqual(server.persistence.list(), []);
  } finally {
    client?.socket.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a session whose process exits becomes dormant without leaving the session panel', async () => {
  const dataDir = temporaryDirectory('clideck-next-natural-exit-');
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  let client;
  try {
    const address = await server.listen();
    client = await connect(address.url);
    client.socket.send(JSON.stringify({
      type: 'session.create',
      provider: 'shell',
      name: 'Natural exit',
      cwd: dataDir,
    }));
    const created = await waitFor(
      client.messages,
      (event) => event.type === 'session.created' && event.name === 'Natural exit',
    );

    client.socket.send(JSON.stringify({
      type: 'input', sessionId: created.sessionId, data: 'exit\r',
    }));
    const dormant = await waitFor(
      client.messages,
      (event) => event.type === 'session.created'
        && event.sessionId === created.sessionId
        && event.live === false,
    );

    assert.equal(dormant.name, 'Natural exit');
    assert.equal(dormant.cwd, dataDir);
    assert.equal(dormant.pid, null);
    assert.equal(server.persistence.has(created.sessionId), true);
    assert.equal(client.messages.some((event) => (
      event.type === 'session.closed' && event.sessionId === created.sessionId
    )), false);
  } finally {
    client?.socket.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('late clients receive live terminal history before current live state', async () => {
  const dataDir = temporaryDirectory('clideck-next-live-replay-');
  const server = new HeadlessServer({ port: 0, dataDir });
  const stored = fakeSession('live-session');
  server.persistence.register(stored);
  server.persistence.appendHistory(stored.id, 'terminal tail');
  server.persistence.flushHistory(stored.id);
  const live = {
    ...stored,
    closed: false,
    status: 'idle',
    latestUpdate: 'latest answer',
    menu: [],
    snapshot: () => ({
      type: 'session.created',
      sessionId: stored.id,
      protocol: 1,
      provider: 'claude-code',
      name: stored.name,
      cwd: stored.cwd,
      cols: stored.cols,
      rows: stored.rows,
      muted: false,
      live: true,
    }),
    close() {
      this.closed = true;
    },
  };
  server.sessions.set(live.id, live);
  let client;
  try {
    const address = await server.listen();
    client = await connect(address.url);
    await waitFor(client.messages, (event) => event.type === 'agent.update');

    assert.deepEqual(client.messages.slice(0, 4).map((event) => event.type), [
      'session.created',
      'output',
      'status',
      'agent.update',
    ]);
    assert.equal(client.messages[0].live, true);
    assert.equal(client.messages[1].data, 'terminal tail');
    assert.equal(client.messages[1].replay, true);
  } finally {
    client?.socket.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

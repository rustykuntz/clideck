const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const WebSocket = require('ws');
const { getProvider } = require('../src/providers');
const { HeadlessServer } = require('../src/server');

function waitFor(messages, predicate, timeoutMs = 5000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const event = messages.find(predicate);
      if (!event) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve(event);
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error('timed out waiting for restart smoke event'));
    }, timeoutMs);
  });
}

test('restart smoke preserves identity, history, theme, and native transcript context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clideck-next-restart-smoke-'));
  const dataDir = join(root, 'data');
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const command = join(root, 'fake-claude.js');
  const transcriptPath = join(cwd, 'native-context.jsonl');
  const previousHome = process.env.HOME;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(command, `#!${process.execPath}
const { readFileSync } = require('fs');
const { join } = require('path');
const args = process.argv.slice(2);
const index = args.indexOf('--resume');
if (index >= 0) {
  const handle = args[index + 1];
  const context = readFileSync(join(process.cwd(), \`${'${handle}'}.jsonl\`), 'utf8').trim();
  process.stdout.write(\`RESUMED:${'${context}'}:${'${process.env.COLORFGBG || "unset"}'}\\n\`);
} else {
  process.stdout.write(\`FRESH:${'${process.env.COLORFGBG || "unset"}'}\\n\`);
}
process.stdin.on('data', (data) => {
  if (data.includes(4)) process.exit(0);
});
process.stdin.resume();
`);
  chmodSync(command, 0o755);
  process.env.HOME = home;

  const server = new HeadlessServer({
    port: 0,
    cwd,
    dataDir,
    commands: { 'claude-code': command },
  });
  let socket;
  try {
    const address = await server.listen();
    socket = new WebSocket(address.url);
    const messages = [];
    socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    socket.send(JSON.stringify({
      type: 'session.create',
      provider: 'claude-code',
      name: 'Restartable',
      cwd,
      theme: 'dark',
      cols: 88,
      rows: 24,
    }));
    const created = await waitFor(
      messages,
      (event) => event.type === 'session.created' && event.name === 'Restartable',
    );
    await waitFor(
      messages,
      (event) => event.type === 'output'
        && event.sessionId === created.sessionId
        && event.data.includes('FRESH:15;0'),
    );

    writeFileSync(transcriptPath, 'CONTEXT_SURVIVED\n');
    const hook = await fetch(`${address.httpUrl}/hooks/${created.sessionId}/session-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_path: transcriptPath }),
    });
    assert.equal(hook.status, 204);
    const originalEntry = server.persistence.get(created.sessionId);
    const originalHistory = server.persistence.historyTail(created.sessionId);
    assert.equal(originalEntry.resumeHandle, 'native-context');
    assert.equal(originalEntry.transcriptPath, transcriptPath);
    assert.equal(created.muted, false);

    socket.send(JSON.stringify({
      type: 'session.mute',
      sessionId: created.sessionId,
      muted: true,
    }));
    await waitFor(
      messages,
      (event) => event.type === 'session.created'
        && event.sessionId === created.sessionId
        && event.muted === true,
    );
    assert.equal(server.persistence.get(created.sessionId).muted, true);

    socket.send(JSON.stringify({
      type: 'session.restart',
      sessionId: created.sessionId,
      theme: 'light',
      cols: 96,
      rows: 28,
    }));
    const restarted = await waitFor(
      messages,
      (event) => event.type === 'session.created'
        && event.sessionId === created.sessionId
        && event.restarted === true,
    );
    assert.equal(restarted.sessionId, created.sessionId);
    assert.equal(restarted.name, created.name);
    assert.equal(restarted.cwd, created.cwd);
    assert.equal(restarted.cols, 96);
    assert.equal(restarted.rows, 28);
    assert.equal(restarted.resumed, true);
    assert.equal(restarted.muted, true);
    await waitFor(
      messages,
      (event) => event.type === 'output'
        && event.sessionId === created.sessionId
        && event.data.includes('RESUMED:CONTEXT_SURVIVED:0;15'),
    );

    const restartedEntry = server.persistence.get(created.sessionId);
    const restartedHistory = server.persistence.historyTail(created.sessionId);
    assert.equal(restartedEntry.createdAt, originalEntry.createdAt);
    assert.equal(restartedEntry.name, 'Restartable');
    assert.equal(restartedEntry.cwd, cwd);
    assert.equal(restartedEntry.cols, 96);
    assert.equal(restartedEntry.rows, 28);
    assert.equal(restartedEntry.muted, true);
    assert.equal(restartedHistory.includes(originalHistory), true);
    assert.equal(restartedHistory.includes('FRESH:15;0'), true);
    assert.equal(restartedHistory.includes('RESUMED:CONTEXT_SURVIVED:0;15'), true);
    assert.equal(messages.some((event) => event.type === 'session.closed'
      && event.sessionId === created.sessionId), false);

    socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
    await waitFor(
      messages,
      (event) => event.type === 'session.closed' && event.sessionId === created.sessionId,
    );
    assert.equal(readFileSync(transcriptPath, 'utf8'), 'CONTEXT_SURVIVED\n');
  } finally {
    socket?.close();
    await server.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart preserves the native conversation ID when its transcript path is unavailable', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-restart-fallback-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const session = {
    id: 'fallback-session',
    provider: getProvider('claude-code'),
    name: 'Fallback',
    command: 'claude',
    cwd: '/tmp/fallback-project',
    cols: 80,
    rows: 24,
    closed: false,
    async stopForRestart() {
      this.closed = true;
    },
  };
  const starts = [];
  try {
    await server.listen();
    server.persistence.register(session);
    server.persistence.recordResumeMetadata(session.id, {
      handle: 'missing-native-context',
      transcriptPath: join(dataDir, 'missing.jsonl'),
    });
    server.sessions.set(session.id, session);
    server.startSession = (options, register, createdFields) => {
      starts.push({ options, register, createdFields });
      return { ...options };
    };

    await server.restartSession({
      type: 'session.restart',
      sessionId: session.id,
      theme: 'dark',
      cols: 90,
      rows: 30,
    });
    assert.equal(starts.length, 1);
    assert.equal(starts[0].options.providerOptions.resumeHandle, 'missing-native-context');
    assert.equal(starts[0].options.id, session.id);
    assert.equal(starts[0].options.name, session.name);
    assert.equal(starts[0].options.cwd, session.cwd);
    assert.equal(starts[0].options.theme, 'dark');
    assert.deepEqual(starts[0].createdFields, { restarted: true, resumed: true });
  } finally {
    server.sessions.clear();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

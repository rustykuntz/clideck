const test = require('node:test');
const assert = require('node:assert/strict');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { SessionPersistence } = require('../src/persistence');
const { HeadlessServer } = require('../src/server');
const { TranscriptStore } = require('../src/transcript-store');

function registrySession(id, cwd) {
  return {
    id,
    provider: { id: 'claude-code' },
    name: 'Reviewer',
    cwd,
    cols: 100,
    rows: 30,
  };
}

function fakeSocket(messages = []) {
  return {
    send(raw) {
      messages.push(JSON.parse(raw));
    },
    on() {},
    close() {},
  };
}

test('transcript store preserves unknown ids for recovery, caps cache, and reads recent turns', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-store-'));
  const directory = join(dataDir, 'transcripts');
  mkdirSync(directory);
  const rows = [
    { ts: 1, role: 'user', text: 'first' },
    { ts: 2, role: 'user', text: 'continued' },
    { ts: 3, role: 'agent', text: 'answer' },
    { ts: 4, role: 'user', text: 'latest question' },
  ];
  writeFileSync(join(directory, 'known.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  writeFileSync(join(directory, 'unknown.jsonl'), `${JSON.stringify(rows[0])}\n`);
  try {
    const store = new TranscriptStore({
      dataDir, validIds: ['known'], cacheLimit: 24, now: () => 5,
    });
    assert.equal(existsSync(join(directory, 'unknown.jsonl')), true);
    assert.deepEqual(store.getTurns('known', 2), [
      { role: 'agent', text: 'answer' },
      { role: 'user', text: 'latest question' },
    ]);
    store.append('known', 'agent', 'final response 🚀🚀🚀');
    assert.equal(Buffer.byteLength(store.getCache().known) <= 24, true);
    assert.match(store.getCache().known, /response/);

    const latest = store.getPage('known', undefined, 2);
    assert.deepEqual(latest.turns.map(({ ts, role }) => ({ ts, role })), [
      { ts: 4, role: 'user' },
      { ts: 5, role: 'agent' },
    ]);
    assert.equal(latest.hasMore, true);
    const older = store.getPage('known', latest.cursor, 2);
    assert.deepEqual(older.turns.map(({ ts, role }) => ({ ts, role })), [
      { ts: 2, role: 'user' },
      { ts: 3, role: 'agent' },
    ]);
    const oldest = store.getPage('known', older.cursor, 2);
    assert.deepEqual(oldest.turns.map(({ ts, role }) => ({ ts, role })), [
      { ts: 1, role: 'user' },
    ]);
    assert.equal(oldest.hasMore, false);
    assert.equal(oldest.cursor, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('bounded recent turns preserve grouping and old signature, clip newest Unicode text, and cap reads', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-bounded-turns-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new TranscriptStore({ dataDir });
  store.append('recent', 'user', 'first'); store.append('recent', 'user', 'continued');
  store.append('recent', 'agent', 'earlier answer'); store.append('recent', 'user', 'question');
  store.append('recent', 'agent', 'newest 🚀 reply');
  assert.deepEqual(store.getTurns('recent', 4, 1000), store.getTurns('recent', 4));
  assert.deepEqual(store.getTurns('recent', 2, 12), [{ role: 'agent', text: 'est 🚀 reply' }]);
  assert.deepEqual(store.getTurns('recent', 2, 20), [{ role: 'user', text: 'stion' }, { role: 'agent', text: 'newest 🚀 reply' }]);
  store.append('emoji', 'agent', 'a🚀');
  assert.deepEqual(store.getTurns('emoji', 1, 1), []);
  assert.deepEqual(store.getTurns('emoji', 1, 2), [{ role: 'agent', text: '🚀' }]);
  for (const invalid of [0, -1, 1.5, 64001, NaN, Infinity, null, '12']) assert.throws(() => store.getTurns('recent', 4, invalid), /maxChars/);
  assert.deepEqual(store.getTurns('missing', 4, 12000), []);
  // The old record is larger than the read budget; newest complete records still work.
  store.append('long', 'user', 'old '.repeat(400000));
  store.append('long', 'agent', 'latest answer');
  assert.deepEqual(store.getTurns('long', 4, 12000), [{ role: 'agent', text: 'latest answer' }]);
  store.append('long', 'user', 'new '.repeat(400000));
  assert.throws(() => store.getTurns('long', 4, 12000), /exceeds the bounded context read/);
});

test('transcript pages are requester-only and reject unknown sessions', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-pages-'));
  const id = 'paged-transcript';
  const persistence = new SessionPersistence({ dataDir });
  persistence.register(registrySession(id, dataDir));
  persistence.close();
  const seed = new TranscriptStore({ dataDir, validIds: [id], now: () => 1 });
  seed.append(id, 'user', 'question');
  seed.append(id, 'agent', 'answer');

  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const requesterMessages = [];
  const peerMessages = [];
  const requester = fakeSocket(requesterMessages);
  const peer = fakeSocket(peerMessages);
  server.clients.add(requester);
  server.clients.add(peer);
  try {
    await server.listen();
    server.handleControl(requester, Buffer.from(JSON.stringify({
      type: 'transcript.page', sessionId: id, limit: 1,
    })));
    assert.deepEqual(requesterMessages, [{
      type: 'transcript.page.result',
      sessionId: id,
      before: null,
      success: true,
      turns: [{ ts: 1, role: 'agent', text: 'answer' }],
      cursor: requesterMessages[0].cursor,
      hasMore: true,
    }]);
    assert.equal(Number.isSafeInteger(requesterMessages[0].cursor), true);
    assert.deepEqual(peerMessages, []);

    server.handleControl(requester, Buffer.from(JSON.stringify({
      type: 'transcript.page', sessionId: 'missing', limit: 30,
    })));
    assert.deepEqual(requesterMessages.at(-1), {
      type: 'transcript.page.result',
      sessionId: 'missing',
      before: null,
      success: false,
      error: 'Unknown session.',
    });
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('transcript paging reads backward across disk chunks without gaps', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-chunks-'));
  const directory = join(dataDir, 'transcripts');
  mkdirSync(directory);
  const rows = Array.from({ length: 45 }, (_, index) => ({
    ts: index,
    role: index % 2 ? 'agent' : 'user',
    text: `turn-${index}-🚀-${'x'.repeat(3000)}`,
  }));
  writeFileSync(join(directory, 'known.jsonl'), `${rows.map(JSON.stringify).join('\n')}\n`);
  try {
    const store = new TranscriptStore({ dataDir, validIds: ['known'] });
    const seen = [];
    let before;
    do {
      const page = store.getPage('known', before, 10);
      seen.unshift(...page.turns.map((turn) => turn.ts));
      before = page.cursor;
      if (!page.hasMore) break;
    } while (true);
    assert.deepEqual(seen, rows.map((row) => row.ts));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('canonical turn events append and broadcast, then explicit close deletes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-events-'));
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const broadcasts = [];
  server.broadcast = (event) => broadcasts.push(event);
  const provider = {
    id: 'test-agent',
    command: process.execPath,
    supportsAsk: true,
    requiresSessionStart: false,
    finalizeOnStop: true,
    finalText: (payload) => String(payload.answer || ''),
    createLaunch: ({ command }) => ({
      command,
      args: ['-e', 'process.stdin.resume()'],
    }),
  };
  try {
    await server.listen();
    const session = server.startSession({
      provider,
      command: process.execPath,
      cwd: dataDir,
      port: server.port,
    }, true);
    session.sendPrompt('first line\nsecond line');
    session.handleHook('stop', { answer: 'Canonical answer' });

    assert.deepEqual(broadcasts.filter((event) => event.type === 'transcript.append'), [
      {
        type: 'transcript.append',
        id: session.id,
        role: 'user',
        text: 'first line\nsecond line',
      },
      {
        type: 'transcript.append',
        id: session.id,
        role: 'agent',
        text: 'Canonical answer',
      },
    ]);
    assert.deepEqual(server.transcriptStore.getTurns(session.id, 10), [
      { role: 'user', text: 'first line\nsecond line' },
      { role: 'agent', text: 'Canonical answer' },
    ]);
    const path = join(dataDir, 'transcripts', `${session.id}.jsonl`);
    const entries = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 2);
    assert.equal(typeof entries[0].ts, 'number');
    assert.deepEqual(
      entries.map(({ role, text }) => ({ role, text })),
      server.transcriptStore.getTurns(session.id, 10),
    );

    server.handleControl(fakeSocket(), Buffer.from(JSON.stringify({
      type: 'session.close',
      sessionId: session.id,
    })));
    await session.waitForClose();
    assert.equal(existsSync(path), false);
    assert.equal(Object.hasOwn(server.transcriptStore.getCache(), session.id), false);
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('dormant transcripts survive engine restart and replay in one cache event', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-transcript-dormant-'));
  const id = 'dormant-transcript';
  const persistence = new SessionPersistence({ dataDir });
  persistence.register(registrySession(id, dataDir));
  persistence.close();
  const seed = new TranscriptStore({ dataDir, validIds: [id] });
  seed.append(id, 'user', 'remember this');
  seed.append(id, 'agent', 'remembered');

  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  const messages = [];
  try {
    await server.listen();
    server.handleConnection(fakeSocket(messages));
    assert.deepEqual(server.transcriptStore.getTurns(id, 2), [
      { role: 'user', text: 'remember this' },
      { role: 'agent', text: 'remembered' },
    ]);
    assert.equal(messages[0].type, 'session.created');
    assert.deepEqual(messages.at(-1), {
      type: 'transcript.cache',
      cache: { [id]: 'remember this\nremembered' },
    });
  } finally {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('native human prompts reach History broadcasts and persisted pages for both providers', async () => {
  const { getProvider } = require('../src/providers');
  for (const id of ['claude-code', 'codex']) {
    const dataDir = mkdtempSync(join(tmpdir(), 'clideck-native-history-'));
    const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
    const broadcasts = [];
    server.broadcast = (event) => broadcasts.push(event);
    const provider = {
      ...getProvider(id),
      createLaunch: () => ({
        command: process.execPath,
        args: ['-e', 'process.stdin.resume()'],
        env: { HOME: dataDir, CLAUDE_CONFIG_DIR: join(dataDir, '.claude'), CODEX_HOME: join(dataDir, '.codex') },
      }),
    };
    try {
      await server.listen();
      const session = server.startSession({ provider, command: process.execPath, cwd: dataDir, port: server.port }, true);
      const expected = [];
      for (const turn_id of ['first', 'second']) {
        session.handleHook('start', { turn_id, prompt_id: turn_id, prompt: 'My message\nsecond line' });
        session.handleHook('stop', { turn_id, last_assistant_message: 'Agent answer' });
        expected.push({ role: 'user', text: 'My message\nsecond line' }, { role: 'agent', text: 'Agent answer' });
      }
      assert.deepEqual(broadcasts.filter((event) => event.type === 'transcript.append')
        .map(({ role, text }) => ({ role, text })), expected);
      assert.deepEqual(server.transcriptStore.getPage(session.id, undefined, 10).turns
        .map(({ role, text }) => ({ role, text })), expected);
      const records = readFileSync(join(dataDir, 'transcripts', session.id + '.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
      assert.deepEqual(records.map(({ role, text }) => ({ role, text })), expected);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

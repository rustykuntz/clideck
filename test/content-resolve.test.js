const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { homedir, tmpdir } = require('os');
const { join, relative } = require('path');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');
const { ContentStore } = require('../src/content-store');

test('preview events expose real file paths on open and replay, never payload storage paths', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-preview-path-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'report.md');
  writeFileSync(path, '# Report');
  const content = new ContentStore({ dataDir });
  const opened = await content.addOpenFile('path-session', path);
  assert.equal(opened.sourcePath, realpathSync(path));
  const payload = content.addOpenPayload('path-session', '# Draft', 'markdown', 'draft.md');
  assert.equal(Object.hasOwn(payload, 'sourcePath'), false);
  const { events: replayed } = await content.replay('path-session');
  assert.equal(replayed.find(event => event.contentId === opened.contentId).sourcePath, realpathSync(path));
  assert.equal(Object.hasOwn(replayed.find(event => event.contentId === payload.contentId), 'sourcePath'), false);
  const restored = new ContentStore({ dataDir });
  restored.restoreSession('path-session', dataDir, content.metadata('path-session'));
  const restart = await restored.replay('path-session');
  assert.equal(restart.events.find(event => event.contentId === opened.contentId).sourcePath, realpathSync(path));
  assert.equal(Object.hasOwn(restart.events.find(event => event.contentId === payload.contentId), 'sourcePath'), false);
});

function fakeSocket(messages) {
  return {
    readyState: WebSocket.OPEN,
    send(raw) { messages.push(JSON.parse(raw)); },
    close() {},
  };
}

function waitFor(messages, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const event = messages.find(predicate);
      if (event) return resolve(event);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for event.'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('content.resolve returns existing viewer files to its requester only', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-next-content-resolve-'));
  const cwd = join(dataDir, 'project');
  const first = 'docs/STRATEGY-IMPLEMENTATION-SPEC.md';
  const second = 'docs/archive/PROGRAMMER-INPUT-STRATEGY-IMPLEMENTATION-SPEC.md';
  const homePath = `~/${relative(homedir(), join(cwd, first))}`;
  const homeMissing = `~/${relative(homedir(), join(cwd, 'docs/missing.md'))}`;
  const outside = join(dataDir, 'outside.pdf');
  mkdirSync(join(cwd, 'docs', 'archive'), { recursive: true });
  writeFileSync(join(cwd, first), '# Strategy\n');
  writeFileSync(join(cwd, second), '# Input\n');
  writeFileSync(join(cwd, 'notes.txt'), 'plain text\n');
  writeFileSync(join(cwd, 'positions.csv'), 'id,amount\n001,10\n');
  writeFileSync(join(cwd, 'unsupported.bin'), 'binary\n');
  writeFileSync(outside, 'pdf');

  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  server.persistence.register({
    id: 'resolve-session',
    provider: { id: 'shell' },
    name: 'Resolve',
    cwd,
    cols: 80,
    rows: 24,
  });
  const requesterMessages = [];
  const peerMessages = [];
  const requester = fakeSocket(requesterMessages);
  const peer = fakeSocket(peerMessages);
  server.clients.add(requester);
  server.clients.add(peer);

  try {
    const paths = [first, second, homePath, homeMissing, 'notes.txt', 'positions.csv', 'docs/missing.md', 'unsupported.bin', outside];
    while (paths.length < 50) paths.push(`docs/missing-${paths.length}.md`);
    paths.push('docs/ignored.md');
    server.handleControl(requester, Buffer.from(JSON.stringify({
      type: 'content.resolve',
      sessionId: 'resolve-session',
      paths,
    })));

    const result = await waitFor(
      requesterMessages,
      (event) => event.type === 'content.resolve.result',
    );
    assert.equal(result.sessionId, 'resolve-session');
    assert.equal(result.resolved[first], realpathSync(join(cwd, first)));
    assert.equal(result.resolved[second], realpathSync(join(cwd, second)));
    assert.equal(result.resolved[homePath], realpathSync(join(cwd, first)));
    assert.equal(result.resolved[homeMissing], null);
    assert.equal(result.resolved['notes.txt'], realpathSync(join(cwd, 'notes.txt')));
    assert.equal(result.resolved['positions.csv'], realpathSync(join(cwd, 'positions.csv')));
    assert.equal(result.resolved['docs/missing.md'], null);
    assert.equal(result.resolved['unsupported.bin'], null);
    assert.equal(result.resolved[outside], realpathSync(outside));
    assert.equal(Object.hasOwn(result.resolved, 'docs/ignored.md'), false);
    assert.equal(Object.keys(result.resolved).length, 50);
    assert.deepEqual(peerMessages, []);
  } finally {
    server.clients.clear();
    server.persistence.close();
    server.webSocketServer.close();
    server.httpServer.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});


test('CSV file and dropped payload previews survive restore without altering text', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-csv-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'positions.CSV');
  const source = '\uFEFFid,note\r\n001,"a,b"\r\n002,"two\nlines"\r\n';
  writeFileSync(path, source);
  const content = new ContentStore({ dataDir });
  const file = await content.addOpenFile('csv-session', path);
  const payload = content.addOpenPayload('csv-session', source, 'csv', 'dropped.csv');
  assert.equal(file.kind, 'csv');
  assert.equal(payload.kind, 'csv');
  assert.equal(content.get(payload.contentId).mime, 'text/csv');
  const restored = new ContentStore({ dataDir });
  restored.restoreSession('csv-session', dataDir, content.metadata('csv-session'));
  const { events } = await restored.replay('csv-session');
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.kind === 'csv'));
  for (const event of events) {
    const entry = restored.get(event.contentId);
    assert.equal(entry.data ? entry.data.toString('utf8') : require('fs').readFileSync(entry.path, 'utf8'), source);
  }
});


test('oversized CSV files are refused on open and rechecked after growth', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-csv-size-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'large.csv');
  writeFileSync(path, 'id,value\n1,2\n');
  const content = new ContentStore({ dataDir });
  const file = await content.addOpenFile('csv-session', path);
  require('fs').truncateSync(path, 10 * 1024 * 1024 + 1);
  await assert.rejects(content.addOpenFile('other-session', path), /CSV preview exceeds/);
  assert.equal(await content.getServable(file.contentId), null);
});

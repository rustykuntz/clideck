const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { once } = require('events');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');

function nextEvent(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);
    function onMessage(data) {
      const event = JSON.parse(data);
      if (event.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(event);
    }
    socket.on('message', onMessage);
  });
}

test('a deleted project folder reports an error and the same connection can create after repair', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-create-folder-'));
  const folder = join(dataDir, 'deleted-project');
  mkdirSync(folder);
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  let socket;
  try {
    await server.listen();
    server.configStore.update({ projects: [{ id: 'project', name: 'Project', path: folder, color: '', collapsed: false }] });
    rmSync(folder, { recursive: true });
    socket = new WebSocket(server.address().url);
    await once(socket, 'open');
    const failed = nextEvent(socket, 'session.create.result');
    socket.send(JSON.stringify({ type: 'session.create', provider: 'shell',
      cwd: folder, projectId: 'project', name: 'Keep this name' }));
    const result = await failed;
    assert.equal(result.success, false);
    assert.equal(result.code, 'folder_not_found');
    assert.equal(result.cwd, folder);
    assert.match(result.error, /Project folder not found/);
    assert.ok(result.error.includes(folder));
    assert.match(result.error, /moved or deleted/);
    assert.equal(socket.readyState, WebSocket.OPEN);
    assert.equal(server.persistence.list().length, 0);
    assert.equal(server.sessions.size, 0);

    mkdirSync(folder);
    const created = nextEvent(socket, 'session.created');
    socket.send(JSON.stringify({ type: 'session.create', provider: 'shell',
      cwd: folder, projectId: 'project', name: 'Keep this name' }));
    const session = await created;
    assert.equal(session.live, true);
    assert.equal(session.cwd, folder);
    assert.equal(session.name, 'Keep this name');
    assert.equal(server.persistence.list().length, 1);
  } finally {
    socket?.terminate();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

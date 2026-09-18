const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

test('failed install permissions leave no plugin behind and allow a successful retry', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-plugin-permissions-'));
  const dataDir = join(root, 'state');
  const pluginsDir = join(dataDir, 'plugins');
  const source = join(root, 'permission-check');
  const destination = join(pluginsDir, 'permission-check');
  let manager;
  t.after(async () => {
    await manager?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(source);
  fs.chmodSync(source, 0o755);
  const manifest = JSON.stringify({
    id: 'permission-check', name: 'Permission Check', version: '1.0.0', apiVersion: 1,
  });
  fs.writeFileSync(join(source, 'clideck-plugin.json'), manifest);

  const permissionError = Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  const chmod = fs.chmodSync;
  let failPermissions = true;
  t.mock.method(fs, 'chmodSync', (path, mode) => {
    if (failPermissions && dirname(path) === pluginsDir && mode === 0o700) {
      throw permissionError;
    }
    return chmod(path, mode);
  });
  // Load after the mock: PluginManager captures filesystem functions when required.
  const { PluginManager } = require('../src/plugin-manager');
  manager = new PluginManager({ dataDir, bundledDir: join(root, 'empty'), log: () => {} });
  await manager.start();

  await assert.rejects(manager.install(source), (error) => error === permissionError);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(pluginsDir), []);
  await manager.refresh();
  assert.deepEqual(manager.snapshot(), []);

  failPermissions = false;
  const installed = await manager.install(source);
  assert.equal(installed.manifest.id, 'permission-check');
  assert.equal(installed.status, 'ready');
  assert.equal(fs.statSync(destination).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(pluginsDir), ['permission-check']);
  assert.equal(fs.readFileSync(join(destination, 'clideck-plugin.json'), 'utf8'), manifest);
  assert.equal(fs.readFileSync(join(source, 'clideck-plugin.json'), 'utf8'), manifest);
  assert.equal(fs.statSync(source).mode & 0o777, 0o755);
});

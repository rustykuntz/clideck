const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { HeadlessServer } = require('../src/server');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');
const { PluginManager } = require('../src/plugin-manager');

const CLI = resolve(__dirname, '../bin/clideck.js');
async function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'clideck-plugin-agent-')), catalog = join(dir, 'catalog'), bundled = join(dir, 'bundled');
  fs.mkdirSync(catalog); fs.mkdirSync(bundled);
  const pkg = join(catalog, 'available-tool'); fs.mkdirSync(pkg);
  fs.writeFileSync(join(pkg, 'clideck-plugin.json'), JSON.stringify({ id: 'available-tool', name: 'Available tool', version: '1.0.0', apiVersion: 1, enabledByDefault: false,
    description: 'An optional capability.', commands: [{ name: 'status', usage: 'available-tool/status', description: 'Check setup.' }],
    settings: [{ key: 'token', label: 'Token', type: 'secret', default: '' }, { key: 'label', label: 'Label', type: 'text', default: 'initial' }] }));
  fs.writeFileSync(join(pkg, 'README.md'), 'Setup: configure the token, then run available-tool/status.');
  fs.writeFileSync(join(pkg, 'server.js'), `exports.activate = api => { api.registerCommand('status', () => JSON.stringify({ ready: Boolean(api.getSetting('token')), label: api.getSetting('label') })); };`);
  const server = new HeadlessServer({ port: 0, dataDir: join(dir, 'data'), bundledPluginsDir: bundled, pluginCatalogDir: catalog, autoSaveMs: 0 });
  const session = new AgentSession({ id: 'agent-session', name: 'Main', provider: getProvider('codex'), cwd: dir });
  session.status = 'idle'; session.terminal = { write() {}, kill: () => session.handleExit(0, null) }; session.close = () => session.handleExit(0, null);
  server.persistence.register(session); server.sessions.set(session.id, session);
  const { httpUrl } = await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const cli = (args, stdin = '', caller = session.id) => new Promise(resolveResult => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, CLIDECK_URL: httpUrl, CLIDECK_SESSION_ID: caller } });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.on('close', code => resolveResult({ code, stdout, stderr })); child.stdin.end(stdin);
  });
  return { server, session, dir, httpUrl, pkg, cli };
}

test('agents discover disabled shipped plugins, read instructions, configure and enable them', async t => {
  const f = await fixture(t);
  const listed = JSON.parse((await f.cli(['plugins', '--json'])).stdout);
  assert.equal(listed[0].id, 'available-tool'); assert.equal(listed[0].source, 'bundled'); assert.equal(listed[0].status, 'disabled');
  assert.equal(JSON.parse((await f.cli(['plugins', '--all', '--json'])).stdout)[0].installed, true);
  const record = f.server.pluginManager.records.get('available-tool');
  assert.equal(record.worker, null); assert.deepEqual(f.server.pluginManager.publicCommands(), []);
  assert.equal(fs.existsSync(join(f.server.pluginManager.pluginDataDir, 'available-tool')), false);
  assert.deepEqual(fs.readdirSync(f.server.pluginManager.pluginsDir), []);
  const info = await f.cli(['plugin', 'info', 'available-tool', '--json']); assert.equal(info.code, 0, info.stderr);
  assert.match(JSON.parse(info.stdout).help, /Setup/); assert.equal(record.worker, null);
  const installed = await f.cli(['plugin', 'install', 'available-tool']); assert.equal(installed.code, 1); assert.match(installed.stderr, /plugin enable/);
  const configured = await f.cli(['plugin', 'settings', 'available-tool', '--stdin', '--json'], JSON.stringify({ token: 'secret-value', label: 'configured' }));
  assert.equal(configured.code, 0, configured.stderr); assert(!configured.stdout.includes('secret-value'));
  assert.equal(JSON.parse(configured.stdout).configured.token, true);
  assert.equal(record.worker, null);
  assert.equal((await f.cli(['plugin', 'enable', 'available-tool'])).code, 0);
  const result = await f.cli(['available-tool/status']); assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ready: true, label: 'configured' });
  const disabled = await f.cli(['plugin', 'disable', 'available-tool']); assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal((await f.cli(['available-tool/status'])).code, 1);
  const enabled = await f.cli(['plugin', 'enable', 'available-tool']); assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(JSON.parse((await f.cli(['plugins', '--all', '--json'])).stdout)[0].installed, true);
});

test('invalid settings and failed plugin activation return errors rather than successful enable', async t => {
  const f = await fixture(t); await f.cli(['plugin', 'enable', 'available-tool']);
  assert.equal((await f.cli(['plugin', 'settings', 'available-tool', '--stdin'], '{"unknown":true}')).code, 1);
  await f.cli(['plugin', 'disable', 'available-tool']);
  fs.writeFileSync(join(f.pkg, 'server.js'), 'exports.activate = () => { throw Error("fixture activation failure"); };');
  const result = await f.cli(['plugin', 'enable', 'available-tool']); assert.equal(result.code, 1); assert.match(result.stderr, /activation failure/);
});

test('notification CLI is caller-scoped, durable and rate limited; browser can read it without Telegram', async t => {
  const f = await fixture(t);
  const result = await f.cli(['notify', 'The export is ready.', '--json']); assert.equal(result.code, 0, result.stderr);
  const id = JSON.parse(result.stdout).id;
  const notices = await (await fetch(f.httpUrl + '/api/notifications')).json();
  assert.equal(notices.notices[0].text, 'The export is ready.'); assert.equal(notices.notices[0].sessionId, f.session.id);
  assert.equal(fs.statSync(f.server.notifications.path).mode & 0o777, 0o600);
  assert.equal((await f.cli(['notify', 'no caller'], '', 'missing')).code, 1);
  const response = await fetch(f.httpUrl + '/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', id }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).notices.length, 0);
  for (let n = 0; n < 9; n++) f.server.notifications.add(f.session.id, 'notice');
  await assert.rejects(async () => f.server.notifications.add(f.session.id, 'flood'), /10 notifications/);
});

test('plugin controls and notification endpoints reject cross-origin requests without mutating state', async t => {
  const f = await fixture(t);
  for (const path of ['/api/plugins?all=true', '/api/plugins/info?id=available-tool', '/api/notifications']) {
    assert.equal((await fetch(f.httpUrl + path, { headers: { Origin: 'https://evil.example' } })).status, 403);
  }
  for (const path of ['/api/plugins/manage', '/api/session/notify', '/api/notifications']) {
    assert.equal((await fetch(f.httpUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
  }
  assert.equal(f.server.pluginManager.records.get('available-tool').worker, null); assert.equal(f.server.notifications.rows.length, 0);
});

test('the real shipped Telegram plugin stays off until enabled and reports remaining human setup', async t => {
  const f = await fixture(t);
  f.server.pluginManager.catalogDir = resolve(__dirname, '../plugin-packages');
  await f.server.pluginManager.refresh();
  const available = JSON.parse((await f.cli(['plugins', '--all', '--json'])).stdout);
  assert(available.some(row => row.id === 'telegram' && row.installed && !row.enabled && row.source === 'bundled'));
  assert.equal(f.server.pluginManager.records.get('telegram').worker, null);
  const result = await f.cli(['plugin', 'enable', 'telegram']); assert.equal(result.code, 0, result.stderr);
  const status = await f.cli(['telegram/setup', 'status']); assert.equal(status.code, 0, status.stderr);
  const state = JSON.parse(status.stdout); assert.equal(state.telegram.connected, false); assert.equal(state.next.step, 'connect');
  assert.equal((await f.cli(['telegram/phone', 'on'])).code, 1);
  assert.equal((await f.cli(['plugin', 'disable', 'telegram'])).code, 0);
});

test('earlier folder installations preserve code, choices and data; removing one restores the shipped plugin off', async t => {
  const f = await fixture(t);
  await f.server.pluginManager.close();
  const local = join(f.server.pluginManager.pluginsDir, 'available-tool');
  fs.cpSync(f.pkg, local, { recursive: true });
  const manifestPath = join(local, 'clideck-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.9.0', enabledByDefault: true }));
  f.server.configStore.update({ plugins: { 'available-tool': { settings: { token: 'saved-token', label: 'saved-label' } } } });
  const create = () => new PluginManager({ dataDir: join(f.dir, 'data'), bundledDir: join(f.dir, 'bundled'),
    catalogDir: join(f.dir, 'catalog'), configStore: f.server.configStore });
  let manager = create(); t.after(() => manager.close());
  await manager.start();
  let row = manager.snapshot()[0];
  assert.equal(manager.snapshot().length, 1); assert.equal(row.source, 'user'); assert.equal(row.version, '0.9.0');
  assert.equal(row.enabled, true); assert.equal(row.values.label, 'saved-label');
  assert.equal(JSON.parse((await manager.runCommand('available-tool', 'status')).stdout).ready, true);
  const dataFile = join(manager.pluginDataDir, 'available-tool', 'access.json');
  fs.writeFileSync(dataFile, '{"mode":"selected","projects":[]}');
  await manager.setEnabled('available-tool', false); await manager.close();
  manager = create(); await manager.start();
  assert.equal(manager.snapshot()[0].enabled, false); assert.equal(manager.records.get('available-tool').worker, null);
  await manager.setEnabled('available-tool', true);
  assert.equal(await manager.remove('available-tool'), true);
  row = manager.snapshot()[0];
  assert.equal(row.source, 'bundled'); assert.equal(row.version, '1.0.0'); assert.equal(row.enabled, false);
  assert.equal(manager.records.get('available-tool').worker, null); assert.equal(row.values.label, 'saved-label');
  assert.equal(fs.existsSync(local), false); assert.equal(fs.readFileSync(dataFile, 'utf8'), '{"mode":"selected","projects":[]}');
  await manager.close(); manager = create(); await manager.start();
  assert.equal(manager.snapshot()[0].enabled, false); assert.equal(manager.snapshot()[0].values.label, 'saved-label');
});

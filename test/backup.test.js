const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { WebSocket } = require('ws');
const { HeadlessServer } = require('../src/server');
const { SessionPersistence } = require('../src/persistence');
const { ConfigStore } = require('../src/config-store');
const { createBackup, parseBackup, previewBackup, restoreBackup, MAX_BACKUP_BYTES } = require('../src/backup');

const project = { id: 'game', name: 'FPS game', path: '/tmp', color: '#abc', collapsed: false };
const command = { id: 'custom', label: 'Custom agent', icon: '', command: 'example --model small',
  enabled: true, isAgent: true, canResume: true, env: { EXAMPLE: 'value' }, resumeCommand: 'example --resume {{sessionId}}', sessionIdPattern: null };
const session = { id: 'programmer', provider: 'codex', name: 'Programmer', cwd: '/tmp', projectId: 'game',
  cols: 120, rows: 40, createdAt: '2026-01-01T00:00:00.000Z', lastActive: '2026-09-10T01:00:00.000Z', resumeHandle: 'native-chat' };
const clone = (v) => JSON.parse(JSON.stringify(v));
function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-backup-test-'));
  mkdirSync(join(dataDir, 'bundled'));
  const server = new HeadlessServer({ dataDir, port: 0, bundledPluginsDir: join(dataDir, 'bundled') });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return server;
}
function sample(server) {
  server.configStore.update({ projects: [project], about: { name: 'Source' }, commands: [command],
    providerArgs: { codex: '--model sample' }, hiddenProviders: ['gemini'], confirmClose: false,
    notify: { enabled: false, browser: true }, prompts: [{ id: 'prompt', name: 'Hello', text: 'Hello {{session_name}}' }],
    promptMru: { game: ['prompt'] }, theme: { darkDefault: 'custom-theme' },
    customThemes: [{ id: 'custom-theme', name: 'Custom', theme: { background: '#123456' } }],
    sessionThemes: { programmer: 'custom-theme', skipped: 'custom-theme' },
  });
  server.persistence.importMissing([session, { ...session, id: 'skipped', name: 'Reviewer', commandId: command.id, provider: 'custom-command' },
    { ...session, id: 'ungrouped', projectId: null }]);
  return createBackup(server, { 'clideck.theme': 'light', 'clideck.sidebarW': '280',
    'clideck.collapsed': '["/tmp"]', 'clideck.mru-provider': 'codex',
    'clideck.picker.emoji.emoji.recent': '["smile"]', 'unrelated-token': 'secret' });
}
const select = (settings = [], projects = [], sessions = []) => ({ settings, projects, sessions });

test('full backup and preview include settings, all sessions and only known browser preferences', (t) => {
  const server = fixture(t), backup = sample(server);
  assert.equal(backup.format, 'clideck-backup');
  assert.equal(Object.keys(backup.settings).length, 9);
  assert.equal(backup.settings.about.config.about.name, 'Source');
  assert.deepEqual(backup.settings.prompts.config.promptMru, { game: ['prompt'] });
  assert.equal(backup.sessions.length, 3);
  assert.equal(backup.sessions[0].resumeHandle, 'native-chat');
  assert.equal(JSON.stringify(backup).includes('unrelated-token'), false);
  const preview = previewBackup(server, backup);
  assert.equal(preview.projects[0].sessions.length, 2);
  assert.equal(preview.projects[0].exists, true);
  assert.equal(preview.sessions[0].id, 'ungrouped');
});

test('Ctrl+V preference is validated and restored only with Behavior', (t) => {
  const server = fixture(t);
  for (const enabled of ['true', 'false']) {
    const backup = createBackup(server, { 'clideck.ctrlVPaste': enabled });
    assert.equal(backup.settings.behavior.browser['clideck.ctrlVPaste'], enabled);
    assert.deepEqual(restoreBackup(server, backup, select(['behavior'])).browser,
      { 'clideck.ctrlVPaste': enabled });
    assert.deepEqual(restoreBackup(server, backup, select(['appearance'])).browser, {});
  }
  for (const invalid of ['yes', '', true, 1]) {
    assert.throws(() => createBackup(server, { 'clideck.ctrlVPaste': invalid }), /Invalid browser preference/);
  }
  const backup = createBackup(server, {});
  backup.settings.behavior.browser['clideck.ctrlVPaste'] = 'yes';
  assert.throws(() => parseBackup(backup), /Invalid browser preference/);
});

test('restore one session brings its project and theme, keeps other state, and survives restart', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  target.configStore.update({ about: { name: 'Target' }, projects: [{ ...project, id: 'other' }],
    sessionThemes: { existing: 'v2-dark' }, confirmClose: true });
  const result = restoreBackup(target, backup, select([], [], ['programmer']));
  assert.deepEqual(result.restored, { projects: 1, sessions: 1, settings: 0 });
  assert.deepEqual(result.browser, {});
  assert.equal(target.sessions.size, 0);
  assert.equal(target.persistence.list().length, 1);
  assert.equal(target.configStore.get().about.name, 'Target');
  assert.equal(target.configStore.get().confirmClose, true);
  assert.equal(target.configStore.get().projects.length, 2);
  assert.deepEqual(target.configStore.get().sessionThemes, { existing: 'v2-dark', programmer: 'custom-theme' });
  assert.equal(target.configStore.get().customThemes[0].id, 'custom-theme');
  const disk = new SessionPersistence({ dataDir: target.persistence.dataDir });
  assert.equal(disk.get('programmer').lastActive, session.lastActive);
  assert.equal(disk.get('programmer').resumeHandle, session.resumeHandle);
  disk.close();
  assert.equal(new ConfigStore({ dataDir: target.persistence.dataDir }).get().projects.length, 2);
});

test('repeated restore never overwrites live or dormant sessions, history, projects or session themes', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  target.persistence.importMissing([{ ...session, name: 'Local name', resumeHandle: 'local-chat' }]);
  writeFileSync(target.persistence.historyPath(session.id), 'precious scrollback');
  target.configStore.update({ projects: [{ ...project, name: 'Local project' }], sessionThemes: { programmer: 'v2-dark' } });
  const events = []; target.broadcast = (v) => events.push(v);
  const current = target.persistence.get(session.id);
  for (let i = 0; i < 2; i++) {
    const result = restoreBackup(target, backup, select([], ['game'], ['programmer']));
    assert.equal(result.skipped, 2);
    assert.equal(result.restored.sessions, 0);
    assert.deepEqual(target.persistence.get(session.id), current);
  }
  assert.equal(readFileSync(target.persistence.historyPath(session.id), 'utf8'), 'precious scrollback');
  assert.equal(target.configStore.get().projects[0].name, 'Local project');
  assert.equal(target.configStore.get().sessionThemes.programmer, 'v2-dark');
  assert.equal(events.some((e) => e.type === 'session.created'), false);
});

test('selected settings merge libraries and preserve unselected sections; missing commands follow sessions', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  target.configStore.update({ about: { name: 'Target', notes: 'Old notes' }, confirmClose: true,
    prompts: [{ id: 'local', name: 'Local', text: 'Keep' }] });
  const result = restoreBackup(target, backup, select(['about', 'prompts', 'appearance'], [], ['skipped']));
  assert.deepEqual(target.configStore.get().about, { name: 'Source' });
  assert.equal(target.configStore.get().confirmClose, true);
  assert.deepEqual(target.configStore.get().commands, [command]);
  assert.equal(target.configStore.get().prompts.length, 2);
  assert.equal(result.browser['clideck.theme'], 'light');
  assert.equal(result.browser['clideck.mru-provider'], undefined);
  assert.equal(target.persistence.list().length, 1);
});

test('legacy backups restore definitions and leave all settings alone', (t) => {
  const target = fixture(t), before = target.configStore.get();
  const old = { format: 'clideck-session-backup', version: 1, projects: [project], sessions: [session] };
  const preview = previewBackup(target, old);
  assert.deepEqual(preview.settings, []);
  restoreBackup(target, old, select([], ['game'], ['programmer']));
  assert.equal(target.persistence.get(session.id).resumeHandle, 'native-chat');
  assert.deepEqual(target.configStore.get().commands, before.commands);
});

test('legacy custom sessions missing a command restore dormant with a clear warning', (t) => {
  const target = fixture(t);
  const backup = { format: 'clideck-session-backup', version: 1, projects: [],
    sessions: [{ ...session, provider: 'custom-command', commandId: 'missing', projectId: null }] };
  const result = restoreBackup(target, backup, select([], [], ['programmer']));
  assert.equal(result.restored.sessions, 1);
  assert.match(result.warnings.join(' '), /cannot resume/);
  assert.equal(target.sessions.size, 0);
  assert.equal(target.persistence.get('programmer').commandId, 'missing');
  const errors = []; target.broadcastSessionError = (_id, error) => errors.push(error);
  assert.equal(target.resumeSession('programmer'), null);
  assert.equal(errors[0].code, 'command_unavailable');
});

test('theme markup is rejected before either Appearance or a session dependency can persist it', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  const markup = 'red"></span><img src=x onerror=alert(1)><span style="color:red';
  for (const field of ['green', 'accent']) {
    const value = clone(backup), theme = value.settings.appearance.config.customThemes[0];
    if (field === 'accent') theme.accent = markup; else theme.theme.green = markup;
    for (const selection of [select(['appearance']), select([], [], ['programmer'])]) {
      assert.throws(() => restoreBackup(target, value, selection), /Invalid custom theme/);
      assert.deepEqual(target.persistence.list(), []);
      assert.equal(target.configStore.get().customThemes, undefined);
    }
  }
  backup.settings.appearance.config.customThemes[0].theme.selectionBackground = 'rgba(22, 40, 80, 0.3)';
  assert.doesNotThrow(() => parseBackup(backup));
});

test('invalid files and selections make no writes, including prototype keys, duplicate IDs and invalid settings', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  const bad = [];
  for (const change of [
    (v) => { v.version = 2; },
    (v) => { v.sessions.push(clone(v.sessions[0])); },
    (v) => { v.sessions[0].id = '../escape'; },
    (v) => { v.sessions[0].cwd = 42; },
    (v) => { v.settings.behavior.config.confirmClose = 'no'; },
    (v) => { v.settings.defaults.config.plugins = {}; },
    (v) => { v.settings.appearance.browser['clideck.theme'] = 'pink'; },
  ]) { const value = clone(backup); change(value); bad.push(value); }
  bad.push(JSON.parse(JSON.stringify(backup).replace('"about":{', '"__proto__":{},"about":{')));
  const before = target.configStore.get();
  for (const value of bad) assert.throws(() => restoreBackup(target, value, select(['about'])));
  assert.throws(() => restoreBackup(target, backup, select([], [], ['not-in-file'])));
  assert.throws(() => restoreBackup(target, backup, select()));
  assert.throws(() => parseBackup({ large: 'x'.repeat(MAX_BACKUP_BYTES) }), /too large/);
  assert.deepEqual(target.configStore.get(), before);
  assert.deepEqual(target.persistence.list(), []);
});

test('registry write failure rolls back settings and imported entries without touching history', (t) => {
  const backup = sample(fixture(t)), target = fixture(t);
  target.persistence.importMissing([{ ...session, id: 'local' }]);
  writeFileSync(target.persistence.historyPath('local'), 'history');
  const configBefore = target.configStore.get(), sessionsBefore = target.persistence.list();
  const path = target.persistence.registryPath;
  target.persistence.registryPath = target.persistence.dataDir; // rename file over directory fails
  assert.throws(() => restoreBackup(target, backup, select(['about'], [], ['programmer'])));
  target.persistence.registryPath = path;
  assert.deepEqual(target.configStore.get(), configBefore);
  assert.deepEqual(target.persistence.list(), sessionsBefore);
  assert.deepEqual(new ConfigStore({ dataDir: target.persistence.dataDir }).get(), configBefore);
  assert.equal(readFileSync(target.persistence.historyPath('local'), 'utf8'), 'history');
});

test('HTTP backup/restore requires local JSON requests and broadcasts only dormant definitions', async (t) => {
  const backup = sample(fixture(t)), server = fixture(t);
  await server.listen();
  const base = `http://127.0.0.1:${server.port}`;
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const route of ['/api/session/backup', '/api/session/restore/preview', '/api/session/restore']) {
    assert.equal((await post(route, {}, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(route, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(route, {}, { 'Content-Type': 'text/plain' })).status, 415);
  }
  const downloaded = await post('/api/session/backup', { browser: {} });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /clideck-backup-/);
  assert.equal(downloaded.headers.get('cache-control'), 'no-store');
  assert.equal((await post('/api/session/restore/preview', { backup })).status, 200);
  const events = []; server.broadcast = (v) => events.push(v);
  const restored = await post('/api/session/restore', { backup, selection: select([], [], ['programmer']) });
  assert.equal(restored.status, 200);
  const event = events.find((v) => v.type === 'session.created');
  assert.equal(event.live, false); assert.equal(event.pid, null);
  assert.equal(server.sessions.size, 0);
  const legacy = await fetch(base + '/api/session/backup');
  assert.equal((await legacy.json()).format, 'clideck-session-backup');
});

test('config.get acknowledges writes in order with the caller requestId', async (t) => {
  const server = fixture(t); await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  t.after(() => socket.terminate());
  await new Promise((resolve) => socket.once('open', resolve));
  const reply = new Promise((resolve) => socket.on('message', (raw) => {
    const message = JSON.parse(raw); if (message.requestId === 'backup-test') resolve(message);
  }));
  socket.send(JSON.stringify({ type: 'config.update', config: { defaultCwd: '/tmp/new-value' } }));
  socket.send(JSON.stringify({ type: 'config.get', requestId: 'backup-test' }));
  assert.equal((await reply).config.defaultCwd, '/tmp/new-value');
});

test('plugin backup excludes secrets; restore applies declared settings to a real worker and preserves local credentials', async (t) => {
  const server = fixture(t);
  const root = join(server.persistence.dataDir, 'plugins', 'sample');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'clideck-plugin.json'), JSON.stringify({
    id: 'sample', name: 'Sample', version: '1.0.0', apiVersion: 1, enabledByDefault: false,
    commands: [{ name: 'read', description: 'Read setting', usage: 'sample/read' }],
    settings: [{ key: 'label', label: 'Label', type: 'text', default: 'Before' },
      { key: 'token', label: 'Token', type: 'secret', default: 'default-secret' }],
  }));
  writeFileSync(join(root, 'server.js'), `exports.activate = (api) => {
    api.registerCommand('read', () => api.getSetting('label'));
  };`);
  await server.listen();
  await server.pluginManager.updateSettings('sample', { token: 'local-secret' });
  const backup = createBackup(server);
  assert.equal(JSON.stringify(backup).includes('secret'), false);
  backup.settings.plugins.config.plugins.sample = { enabled: true, settings: { label: 'Restored', token: 'foreign-secret' } };
  backup.settings.plugins.config.plugins.missing = { enabled: true, settings: {} };
  const preview = previewBackup(server, backup);
  assert.match(preview.warnings.join(' '), /not installed/);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/session/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backup, selection: select(['plugins']) }),
  });
  assert.equal(response.status, 200);
  assert.match((await response.json()).warnings.join(' '), /not installed/);
  assert.equal(server.pluginManager.snapshot()[0].status, 'ready');
  assert.equal(server.configStore.get().plugins.sample.settings.token, 'local-secret');
  const record = server.pluginManager.records.get('sample');
  assert.equal(record.settings.label, 'Restored');
  assert.equal(record.settings.token, 'local-secret');
  assert.equal(server.configStore.get().plugins.missing, undefined);
  backup.settings.plugins.config.plugins.sample.settings.label = 123;
  const before = server.configStore.get();
  assert.throws(() => restoreBackup(server, backup, select(['plugins'])), /Invalid Sample setting/);
  assert.deepEqual(server.configStore.get(), before);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('fs');
const { spawn } = require('child_process');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const { ConfigStore } = require('../src/config-store');
const { PluginManager } = require('../src/plugin-manager');
const { PluginManifestError, readPluginManifest } = require('../src/plugin-manifest');
const { HeadlessServer } = require('../src/server');
const { WebSocket } = require('ws');

const CLI = resolve(__dirname, '../bin/clideck.js');

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writePlugin(root, manifest, server = '') {
  const dir = join(root, manifest.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'clideck-plugin.json'), JSON.stringify(manifest, null, 2));
  if (server) writeFileSync(join(dir, 'server.js'), server);
  return dir;
}

function runCli(args, env, input = '') {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const baseManifest = {
  id: 'echo-tool',
  name: 'Echo Tool',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Echoes input.',
  commands: [{ name: 'echo', description: 'Echo text.', usage: 'echo-tool/echo <text>' }],
  settings: [
    { key: 'prefix', label: 'Prefix', type: 'text', default: 'echo:' },
    { key: 'token', label: 'Token', type: 'secret', default: '' },
  ],
  viewers: [{ id: 'preview', mime: 'application/json' }],
};

const echoServer = `
exports.activate = async (api) => {
  api.registerCommand('echo', async ({ args, stdin, sessionId }) => ({
    stdout: args[0] === 'sessions'
      ? JSON.stringify(await api.getSessions())
      : api.getSetting('prefix') + args.join(' ') + stdin,
    stderr: sessionId,
    exitCode: 0,
  }));
  api.onEvent('agent.final', (event) => api.sendToClients('saw-final', event.text));
  api.onClientMessage('ping', (data, context) => context.reply('pong', data));
};
`;

function openSocket(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    const events = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw)));
    socket.once('open', () => resolveSocket({ socket, events }));
    socket.once('error', rejectSocket);
  });
}

async function waitFor(events, predicate, timeout = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error('Timed out waiting for plugin event.');
}

test('an unreadable plugin stays a failed inventory row without breaking healthy plugins', async () => {
  const root = tempDir('clideck-plugin-unreadable-');
  const bundledDir = join(root, 'bundled');
  mkdirSync(join(bundledDir, 'leftover-folder'), { recursive: true });
  writePlugin(bundledDir, baseManifest);
  const manager = new PluginManager({ dataDir: join(root, 'data'), bundledDir });
  try {
    await manager.start();
    const rows = manager.snapshot();
    const failed = rows.find((row) => row.id === 'leftover-folder');
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error);
    assert.deepEqual(failed.viewers, []);
    assert.equal(rows.find((row) => row.id === baseManifest.id).status, 'ready');
    assert.doesNotThrow(() => manager.publicCommands());
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin manifests validate stable identities, commands, and settings', () => {
  const root = tempDir('clideck-plugin-manifest-');
  const dir = writePlugin(root, baseManifest);
  const manifest = readPluginManifest(dir);
  assert.equal(manifest.id, 'echo-tool');
  assert.equal(manifest.enabledByDefault, true);
  assert.deepEqual(manifest.commands.map((command) => command.name), ['echo']);
  assert.deepEqual(manifest.settings.map((setting) => setting.key), ['prefix', 'token']);
  assert.deepEqual(manifest.viewers, [{
    id: 'preview', kind: 'echo-tool/preview', mime: 'application/json',
  }]);

  writeFileSync(join(dir, 'clideck-plugin.json'), JSON.stringify({
    ...baseManifest,
    commands: [...baseManifest.commands, baseManifest.commands[0]],
  }));
  assert.throws(() => readPluginManifest(dir), PluginManifestError);

  writeFileSync(join(dir, 'clideck-plugin.json'), JSON.stringify({
    ...baseManifest,
    commands: [{ ...baseManifest.commands[0], usage: 'ask @reviewer' }],
  }));
  assert.throws(() => readPluginManifest(dir), (error) => (
    error instanceof PluginManifestError && error.code === 'invalid_command_usage'
  ));
});

test('plugin activation defaults validate booleans and preserve saved choices', async (t) => {
  const root = tempDir('clideck-plugin-default-');
  const bundledDir = join(root, 'bundled');
  const dir = writePlugin(bundledDir, { ...baseManifest, enabledByDefault: false }, echoServer);
  assert.equal(readPluginManifest(dir).enabledByDefault, false);
  writePlugin(bundledDir, { ...baseManifest, enabledByDefault: 'false' }, echoServer);
  assert.throws(() => readPluginManifest(dir), (error) => error.code === 'invalid_manifest');
  writePlugin(bundledDir, { ...baseManifest, enabledByDefault: false }, echoServer);
  const configStore = new ConfigStore({ dataDir: root });
  const manager = new PluginManager({ dataDir: root, bundledDir, configStore, log: () => {} });
  t.after(() => manager.close());
  await manager.start();
  assert.equal(manager.snapshot()[0].status, 'disabled');
  await manager.setEnabled(baseManifest.id, true);
  assert.equal(manager.snapshot()[0].status, 'ready');
  await manager.refresh();
  assert.equal(manager.snapshot()[0].enabled, true, 'saved true overrides default false');
  await manager.setEnabled(baseManifest.id, false);
  writePlugin(bundledDir, { ...baseManifest, enabledByDefault: true }, echoServer);
  await manager.refresh();
  assert.equal(manager.snapshot()[0].status, 'disabled', 'saved false overrides default true');
});

test('release plugins expose the requested fresh defaults without overriding saved settings', async (t) => {
  const dataDir = tempDir('clideck-release-plugins-');
  const configStore = new ConfigStore({ dataDir });
  const manager = new PluginManager({ dataDir, configStore, log: () => {} });
  t.after(() => manager.close());
  await manager.start();
  const plugins = new Map(manager.snapshot().map(plugin => [plugin.id, plugin]));
  assert.deepEqual([...plugins.keys()].sort(), ['emoji', 'git-diff', 'smart-dictation', 'supertonic']);
  assert.equal(plugins.get('emoji').status, 'ready');
  assert.equal(plugins.get('git-diff').status, 'ready');
  assert.equal(plugins.get('supertonic').status, 'ready');
  assert.equal(plugins.get('smart-dictation').status, 'disabled');
  assert.deepEqual(plugins.get('supertonic').values, {
    voice: 'female-2', shortcut: 'F5', language: 'en', quality: 12,
    normalization: 'english', 'auto-read': false,
  });
  await manager.updateSettings('supertonic', {
    voice: 'female-1', shortcut: '', language: 'na', quality: 7,
    normalization: 'off', 'auto-read': true,
  });
  await manager.setEnabled('supertonic', false);
  await manager.setEnabled('emoji', false);
  await manager.setEnabled('smart-dictation', true);
  await manager.refresh();
  const saved = new Map(manager.snapshot().map(plugin => [plugin.id, plugin]));
  assert.equal(saved.get('supertonic').status, 'disabled');
  assert.equal(saved.get('emoji').status, 'disabled');
  assert.equal(saved.get('smart-dictation').status, 'ready');
  assert.deepEqual(saved.get('supertonic').values, {
    voice: 'female-1', shortcut: '', language: 'na', quality: 7,
    normalization: 'off', 'auto-read': true,
  });
});

test('plugin select previews and shortcut settings are safe and preserved', () => {
  const root = tempDir('clideck-plugin-setting-surfaces-');
  const manifest = {
    id: 'voice-tool', name: 'Voice Tool', version: '1.0.0', apiVersion: 1,
    settings: [
      {
        key: 'voice', label: 'Voice', type: 'select', default: 'one',
        options: [{ value: 'one', label: 'One', preview: 'public/one.mp3' }],
      },
      { key: 'shortcut', label: 'Shortcut', type: 'shortcut', default: '' },
    ],
  };
  const dir = writePlugin(root, manifest);
  const loaded = readPluginManifest(dir);
  assert.equal(loaded.settings[0].options[0].preview, 'public/one.mp3');
  assert.equal(loaded.settings[1].type, 'shortcut');

  writeFileSync(join(dir, 'clideck-plugin.json'), JSON.stringify({
    ...manifest,
    settings: [{
      ...manifest.settings[0], options: [{ value: 'one', label: 'One', preview: '../secret.mp3' }],
    }],
  }));
  assert.throws(() => readPluginManifest(dir), (error) => (
    error instanceof PluginManifestError && error.code === 'invalid_setting'
  ));
});

test('plugin backend content uses the durable viewer lifecycle end to end', async (t) => {
  const dataDir = tempDir('clideck-plugin-viewer-data-');
  const bundledDir = tempDir('clideck-plugin-viewer-bundled-');
  const manifest = {
    id: 'viewer-tool', name: 'Viewer Tool', version: '1.0.0', apiVersion: 1,
    commands: [{ name: 'show', description: 'Show a preview.', usage: 'viewer-tool/show' }],
    settings: [],
    viewers: [{ id: 'preview', mime: 'application/json' }],
  };
  writePlugin(bundledDir, manifest, `
    exports.activate = (api) => {
      api.registerCommand('show', async ({ args, sessionId }) => api.showContent(sessionId, {
        kind: args[0] === 'invalid' ? 'viewer-tool/missing' : 'viewer-tool/preview',
        mime: 'application/json',
        name: 'live-report.json',
        data: JSON.stringify({ ok: true }),
      }));
    };
  `);
  const caller = {
    id: 'viewer-caller', name: 'Viewer Caller', provider: { id: 'shell' }, cwd: dataDir,
    cols: 100, rows: 30, status: 'idle', closed: false, menu: [], latestUpdate: '',
    snapshot() {
      return {
        type: 'session.created', sessionId: this.id, provider: this.provider.id,
        name: this.name, cwd: this.cwd, cols: this.cols, rows: this.rows, live: true,
      };
    },
    close() { this.closed = true; },
    waitForClose() { return Promise.resolve(); },
  };

  const firstServer = new HeadlessServer({
    port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0,
  });
  t.after(() => firstServer.close());
  firstServer.persistence.register(caller);
  firstServer.sessions.set(caller.id, caller);
  const firstAddress = await firstServer.listen();
  const first = await openSocket(firstAddress.url);
  const env = { CLIDECK_SESSION_ID: caller.id, CLIDECK_URL: firstAddress.httpUrl };
  const shown = await runCli(['viewer-tool/show'], env);
  assert.equal(shown.code, 0, shown.stderr);
  const event = await waitFor(first.events, (value) => (
    value.type === 'content.show' && value.kind === 'viewer-tool/preview'
  ));
  assert.equal(event.name, 'live-report.json');
  const served = await fetch(firstAddress.httpUrl + event.url);
  assert.equal(served.headers.get('content-type'), 'application/json');
  assert.deepEqual(await served.json(), { ok: true });

  const invalid = await runCli(['viewer-tool/show', 'invalid'], env);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /viewer is not declared/i);
  first.socket.close();
  await firstServer.close();

  const secondServer = new HeadlessServer({
    port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0,
  });
  t.after(() => secondServer.close());
  const secondAddress = await secondServer.listen();
  const second = await openSocket(secondAddress.url);
  t.after(() => second.socket.close());
  const replayed = await waitFor(second.events, (value) => (
    value.type === 'content.show' && value.contentId === event.contentId
  ));
  assert.equal(replayed.kind, 'viewer-tool/preview');
  const replayBody = await fetch(secondAddress.httpUrl + replayed.url);
  assert.equal(replayBody.headers.get('content-type'), 'application/json');
  assert.deepEqual(await replayBody.json(), { ok: true });
});

test('CLI validates a plugin folder without contacting an engine', async () => {
  const root = tempDir('clideck-plugin-validate-');
  const dir = writePlugin(root, baseManifest, echoServer);
  const result = await runCli(['plugin', 'validate', dir, '--json'], {});
  assert.equal(result.code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.id, 'echo-tool');
  assert.equal(summary.server, true);
  assert.deepEqual(summary.commands.map((command) => command.name), ['echo']);
  assert.deepEqual(summary.viewers.map((viewer) => viewer.kind), ['echo-tool/preview']);
});

test('plugin workers isolate commands, canonical events, and settings', async (t) => {
  const dataDir = tempDir('clideck-plugin-manager-');
  const bundledDir = tempDir('clideck-plugin-bundled-');
  writePlugin(bundledDir, baseManifest, echoServer);
  const clientEvents = [];
  const configStore = new ConfigStore({ dataDir });
  const manager = new PluginManager({
    dataDir,
    bundledDir,
    configStore,
    engineVersion: 'test',
    onClientEvent: (event) => clientEvents.push(event),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  assert.equal(manager.snapshot()[0].status, 'ready');
  assert.equal(manager.snapshot()[0].values.token, undefined);
  assert.equal(manager.snapshot()[0].configured.token, false);

  const first = await manager.runCommand('echo-tool', 'echo', {
    args: ['hello'], stdin: '!', sessionId: 'session-1',
  });
  assert.deepEqual(first, { stdout: 'echo:hello!', stderr: 'session-1', exitCode: 0 });

  manager.emitCoreEvent({ type: 'agent.final', sessionId: 'session-1', text: 'done' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(clientEvents, [{
    type: 'plugin.message', pluginId: 'echo-tool', event: 'saw-final', data: 'done',
  }]);

  assert.equal(await manager.updateSettings('echo-tool', { prefix: 'say:', token: 'private' }), true);
  const second = await manager.runCommand('echo-tool', 'echo', { args: ['hi'] });
  assert.equal(second.stdout, 'say:hi');
  assert.equal(configStore.get().plugins['echo-tool'].settings.prefix, 'say:');
  assert.equal(manager.snapshot()[0].values.token, undefined);
  assert.equal(manager.snapshot()[0].configured.token, true);
  assert.equal(await manager.updateSettings('echo-tool', { unknown: true }), false);
});

test('plugin discovery rejects duplicate names and installation never overwrites', async (t) => {
  const dataDir = tempDir('clideck-plugin-install-');
  const sourceRoot = tempDir('clideck-plugin-source-');
  const bundledDir = tempDir('clideck-plugin-none-');
  const source = writePlugin(sourceRoot, baseManifest, echoServer);
  const manager = new PluginManager({
    dataDir,
    bundledDir,
    configStore: new ConfigStore({ dataDir }),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  await manager.install(source);
  assert.equal(manager.snapshot()[0].id, 'echo-tool');
  await assert.rejects(() => manager.install(source), (error) => error.code === 'plugin_exists');
  assert.match(readFileSync(join(dataDir, 'plugins', 'echo-tool', 'server.js'), 'utf8'), /registerCommand/);

  const duplicate = {
    ...baseManifest,
    id: 'other-tool',
    commands: [{ ...baseManifest.commands[0], usage: 'other-tool/echo <text>' }],
  };
  writePlugin(join(dataDir, 'plugins'), duplicate, echoServer);
  await manager.refresh();
  const record = manager.snapshot().find((plugin) => plugin.id === 'other-tool');
  assert.equal(record.status, 'failed');
  assert.match(record.error, /already installed/);
});

test('a duplicate user ID never suppresses the bundled plugin', async (t) => {
  const dataDir = tempDir('clideck-plugin-duplicate-id-');
  const bundledDir = tempDir('clideck-plugin-duplicate-bundled-');
  writePlugin(bundledDir, baseManifest, echoServer);
  writePlugin(join(dataDir, 'plugins'), {
    ...baseManifest,
    name: 'Shadow Copy',
  }, 'exports.activate = () => { throw new Error("shadow loaded"); };');
  const logs = [];
  const manager = new PluginManager({
    dataDir,
    bundledDir,
    configStore: new ConfigStore({ dataDir }),
    log: (...values) => logs.push(values.join(' ')),
  });
  t.after(() => manager.close());
  await manager.start();
  assert.equal(manager.snapshot().length, 1);
  assert.equal(manager.snapshot()[0].name, 'Echo Tool');
  assert.equal(manager.snapshot()[0].status, 'ready');
  assert.equal(logs.some((line) => /already installed/.test(line)), true);
});

test('plugin workers reject non-canonical subscriptions and unsafe client payloads', async (t) => {
  const dataDir = tempDir('clideck-plugin-boundary-');
  const bundledDir = tempDir('clideck-plugin-boundary-bundled-');
  const badManifest = { ...baseManifest, id: 'bad-events', name: 'Bad Events', commands: [] };
  writePlugin(bundledDir, badManifest, `
    exports.activate = (api) => api.onEvent('plugin.message', () => {});
  `);
  const clientEvents = [];
  const manager = new PluginManager({
    dataDir,
    bundledDir,
    configStore: new ConfigStore({ dataDir }),
    onClientEvent: (event) => clientEvents.push(event),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  assert.equal(manager.snapshot()[0].status, 'failed');

  const record = manager.records.get('bad-events');
  assert.doesNotThrow(() => manager.handleWorkerMessage(record, {
    type: 'client-event', event: 'unsafe', json: '{broken',
  }));
  assert.doesNotThrow(() => manager.handleWorkerMessage(record, {
    type: 'client-event', event: 'huge', json: `"${'x'.repeat(1024 * 1024)}"`,
  }));
  assert.deepEqual(clientEvents, []);
});

test('a crashing backend fails only its plugin worker', async (t) => {
  const dataDir = tempDir('clideck-plugin-crash-');
  const bundledDir = tempDir('clideck-plugin-crash-bundled-');
  const manifest = { ...baseManifest, id: 'crash-tool', name: 'Crash Tool', commands: [] };
  writePlugin(bundledDir, manifest, 'exports.activate = () => { throw new Error("boom"); };');
  const manager = new PluginManager({
    dataDir,
    bundledDir,
    configStore: new ConfigStore({ dataDir }),
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  assert.equal(manager.snapshot()[0].status, 'failed');
  assert.match(manager.snapshot()[0].error, /boom/);
});

test('real CLI discovers and dispatches namespaced plugin commands for a live caller', async (t) => {
  const dataDir = tempDir('clideck-plugin-cli-');
  const bundledDir = tempDir('clideck-plugin-cli-bundled-');
  const dir = writePlugin(bundledDir, baseManifest, echoServer);
  writeFileSync(join(dir, 'client.js'), 'export async function activate() {}\n');
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'app.html'), '<h1>plugin app</h1>');
  writeFileSync(join(dir, 'public', 'model.onnx'), '0123456789');
  const server = new HeadlessServer({
    port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0,
  });
  const caller = {
    id: 'plugin-caller', name: 'Programmer', provider: { id: 'shell' }, cwd: dataDir,
    cols: 100, rows: 30, status: 'idle', closed: false, menu: [], latestUpdate: '',
    snapshot() {
      return {
        type: 'session.created', sessionId: this.id, provider: this.provider.id,
        name: this.name, cwd: this.cwd, cols: this.cols, rows: this.rows, live: true,
      };
    },
    close() { this.closed = true; },
    waitForClose() { return Promise.resolve(); },
  };
  server.persistence.register(caller);
  server.sessions.set(caller.id, caller);
  t.after(() => server.close());
  const { httpUrl } = await server.listen();
  const env = { CLIDECK_SESSION_ID: caller.id, CLIDECK_URL: httpUrl };

  const listed = await runCli(['plugins', '--json'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].id, 'echo-tool');

  const help = await runCli(['--help'], env);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /echo-tool\/echo/);

  const invoked = await runCli(['echo-tool/echo', 'hello'], env, '!');
  assert.equal(invoked.code, 0, invoked.stderr);
  assert.equal(invoked.stdout, 'echo:hello!');
  assert.equal(invoked.stderr, caller.id);

  const pluginUrlArgument = await runCli([
    '--url', httpUrl, 'echo-tool/echo', 'hello', '--url', 'plugin-value',
  ], { CLIDECK_SESSION_ID: caller.id });
  assert.equal(pluginUrlArgument.code, 0, pluginUrlArgument.stderr);
  assert.equal(pluginUrlArgument.stdout, 'echo:hello --url plugin-value');

  const sessions = await runCli(['echo-tool/echo', 'sessions'], env);
  assert.equal(sessions.code, 0, sessions.stderr);
  assert.equal(JSON.parse(sessions.stdout)[0].sessionId, caller.id);

  const unknownCaller = await runCli(['echo-tool/echo', 'hello'], {
    CLIDECK_SESSION_ID: 'missing', CLIDECK_URL: httpUrl,
  });
  assert.equal(unknownCaller.code, 1);
  assert.match(unknownCaller.stderr, /Caller session is not active/);

  const client = await fetch(`${httpUrl}/plugins/echo-tool/client.js`);
  assert.equal(client.status, 200);
  assert.match(await client.text(), /activate/);
  const app = await fetch(`${httpUrl}/plugins/echo-tool/public/app.html`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /plugin app/);
  const model = await fetch(`${httpUrl}/plugins/echo-tool/public/model.onnx`, {
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(model.status, 206);
  assert.equal(await model.text(), '2345');
  assert.equal(model.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(model.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${httpUrl}/plugins/echo-tool/public/..%2Fserver.js`)).status, 404);
});

test('plugin controls broadcast state and namespaced messages without dynamic protocol types', async (t) => {
  const dataDir = tempDir('clideck-plugin-controls-');
  const bundledDir = tempDir('clideck-plugin-controls-bundled-');
  writePlugin(bundledDir, baseManifest, echoServer);
  const server = new HeadlessServer({
    port: 0, dataDir, bundledPluginsDir: bundledDir, autoSaveMs: 0,
  });
  t.after(() => server.close());
  const { url } = await server.listen();
  const first = await openSocket(url);
  const second = await openSocket(url);
  t.after(() => { first.socket.close(); second.socket.close(); });
  await waitFor(first.events, (event) => event.type === 'plugins');

  first.socket.send(JSON.stringify({
    type: 'plugin.settings.update', pluginId: 'echo-tool', settings: { prefix: 'new:' },
    requestId: 'settings-1',
  }));
  const result = await waitFor(first.events, (event) => (
    event.type === 'plugin.result' && event.operation === 'settings'
  ));
  assert.equal(result.success, true);
  assert.equal(result.requestId, 'settings-1');
  const state = await waitFor(second.events, (event) => (
    event.type === 'plugins' && event.plugins[0]?.values?.prefix === 'new:'
  ));
  assert.equal(state.plugins[0].status, 'ready');
  assert.equal(state.plugins[0].values.token, undefined);

  first.socket.send(JSON.stringify({ type: 'config.get' }));
  const config = await waitFor(first.events, (event) => event.type === 'config');
  assert.equal(config.config.plugins, undefined);

  first.socket.send(JSON.stringify({
    type: 'config.update', config: { plugins: { 'echo-tool': { enabled: false } } },
  }));
  const reserved = await waitFor(first.events, (event) => (
    event.type === 'config.update.result' && event.code === 'reserved_config_key'
  ));
  assert.equal(reserved.success, false);
  assert.equal(server.pluginManager.snapshot()[0].enabled, true);

  first.socket.send(JSON.stringify({
    type: 'plugin.message', pluginId: 'echo-tool', event: 'ping', data: { value: 7 },
    requestId: 'ping-1',
  }));
  const acknowledged = await waitFor(first.events, (event) => (
    event.type === 'plugin.result' && event.operation === 'message'
  ));
  assert.equal(acknowledged.requestId, 'ping-1');
  const pong1 = await waitFor(first.events, (event) => event.type === 'plugin.message');
  assert.deepEqual(pong1, {
    type: 'plugin.message', pluginId: 'echo-tool', event: 'pong', data: { value: 7 },
    requestId: 'ping-1',
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(second.events.some((event) => event.type === 'plugin.message'), false);

  first.socket.send(JSON.stringify({
    type: 'plugin.setEnabled', pluginId: 'echo-tool', enabled: false,
  }));
  const disabled = await waitFor(second.events, (event) => (
    event.type === 'plugins' && event.plugins[0]?.status === 'disabled'
  ));
  assert.equal(disabled.plugins[0].enabled, false);
});

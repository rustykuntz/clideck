const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Engine, alive, probe, readLock, packagedRuntime, preferredPort } = require('../lib/engine.cjs');
const { UiState } = require('../lib/ui-state.cjs');
const { externalUrl, externalDestination, localEngineUrl, trustedDocument, sameDocument } = require('../lib/policy.cjs');
const { Preferences } = require('../lib/preferences.cjs');
const { createUpdateInstaller } = require('../../src/update-install');
const WebSocket = require('../../node_modules/ws');

const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clideck-desktop-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('external web browsing never embeds Google OAuth or executable URLs', () => {
  assert.equal(externalDestination('https://example.com/docs', 'app'), 'app');
  assert.equal(externalDestination('https://example.com/docs', 'browser'), 'browser');
  for (const url of ['https://accounts.google.com/o/oauth2/auth', 'https://example.com/oauth/authorize', 'mailto:test@example.com']) {
    assert.equal(externalDestination(url, 'app'), 'browser');
  }
  for (const url of ['file:///tmp/run.sh', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com', 'https://a.test/\n']) {
    assert.throws(() => externalUrl(url));
  }
});

test('native bridge document policy excludes plugin pages, previews and external origins', () => {
  const engine = 'http://127.0.0.1:1234'; const startup = 'file:///app/renderer/index.html';
  assert.equal(trustedDocument(engine + '/', engine, startup), true);
  assert.equal(trustedDocument(startup, engine, startup), true);
  for (const url of [engine + '/plugin/x/index.html', engine + '/content/x', 'https://example.com/', 'file:///tmp/index.html']) {
    assert.equal(trustedDocument(url, engine, startup), false);
  }
  assert.equal(localEngineUrl(engine), true);
  assert.equal(localEngineUrl('http://192.168.1.1:1234'), false);
  assert.equal(localEngineUrl('https://127.0.0.1:1234'), false);
});

test('desktop settings persist separately and reject unknown values', async t => {
  const directory = await temporary(t); const settings = new Preferences(directory);
  settings.update({ externalLinks: 'app', closeToTray: false });
  const reopened = new Preferences(directory);
  assert.equal(reopened.value.externalLinks, 'app'); assert.equal(reopened.value.closeToTray, false);
  assert.equal(reopened.value.startAtLogin, false);
  assert.throws(() => reopened.update({ engineUrl: 'https://example.com' }));
  assert.throws(() => reopened.update({ startAtLogin: 'yes' }));
  assert.deepEqual((await fs.readdir(directory)).sort(), ['desktop.json']);
});

test('bundled engine updates never invoke npm or overwrite the running engine', async () => {
  let called = false;
  const installer = createUpdateInstaller({ distribution: 'desktop', run: () => { called = true; } });
  assert.equal((await installer.capability()).canInstall, false);
  await assert.rejects(installer.install('2.7.0'), /desktop app/);
  assert.equal(called, false);
});

test('runtime remains available after application resources are replaced', async t => {
  const directory = await temporary(t); const resources = path.join(directory, 'resources');
  await fs.mkdir(path.join(resources, 'runtime', 'engine'), { recursive: true });
  await fs.mkdir(path.join(resources, 'runtime', 'bin'));
  await fs.writeFile(path.join(resources, 'runtime', 'manifest.json'), JSON.stringify({ id: 'a'.repeat(64) }));
  await fs.writeFile(path.join(resources, 'runtime', 'engine', 'saved.js'), 'original');
  const runtime = await packagedRuntime(resources, path.join(directory, 'profile'));
  await fs.rm(resources, { recursive: true });
  assert.equal(await fs.readFile(path.join(runtime.root, 'saved.js'), 'utf8'), 'original');
});

test('real engine survives launcher exit, reuses its lock and runs a shell without changing saved config', { timeout: 30000 }, async t => {
  const directory = await temporary(t); const dataDir = path.join(directory, 'data');
  const profile = path.join(directory, 'profile'); await fs.mkdir(dataDir);
  const saved = { projects: [], defaultProvider: 'shell', customDesktopRegressionMarker: 'preserve-me' };
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify(saved));
  // A separate launcher exits before we check the engine: this exercises detachment,
  // rather than merely mocking spawn/unref or assuming shell closure is harmless.
  const source = `const {Engine}=require(${JSON.stringify(path.join(root, 'desktop/lib/engine.cjs'))});
    const e=new Engine({dataDir:${JSON.stringify(dataDir)},profile:${JSON.stringify(profile)},
      runtime:async()=>({node:process.execPath,root:${JSON.stringify(root)}}),environment:async()=>({...process.env})});
    e.start().then(s=>{console.log(JSON.stringify(s));if(s.state!=='ready')process.exitCode=1});`;
  let pid;
  t.after(async () => {
    pid ||= readLock(dataDir)?.pid;
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 60 && alive(pid); i++) await delay(50);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', source], { timeout: 15000 });
  const state = JSON.parse(stdout.trim()); pid = state.pid;
  assert.equal(state.state, 'ready'); assert.equal(alive(pid), true); assert.equal(await probe(state.url), true);
  const again = new Engine({ dataDir, profile, runtime: () => { throw new Error('must reuse existing engine'); } });
  assert.equal((await again.start()).pid, pid);
  const ws = new WebSocket(state.url.replace('http:', 'ws:'));
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Shell output timeout')), 7000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'session.create', provider: 'shell', cwd: directory, name: 'desktop lifecycle', cols: 80, rows: 24 })));
    ws.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.created') ws.send(JSON.stringify({ type: 'input', sessionId: event.sessionId, data: "printf 'DESKTOP_%s\\n' 'SURVIVED'\r" }));
      if (event.type === 'output' && event.data.includes('DESKTOP_SURVIVED')) { clearTimeout(timeout); resolve(); }
    });
    ws.on('error', reject);
  });
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')).customDesktopRegressionMarker, 'preserve-me');
  ws.close();
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60 && alive(pid); i++) await delay(50);
  assert.equal(alive(pid), false);
  const restart = new Engine({ dataDir, profile, runtime: async () => ({ node: process.execPath, root }), environment: async () => ({ ...process.env }) });
  const restarted = await restart.start(); pid = restarted.pid;
  assert.equal(restarted.state, 'ready'); assert.equal(restarted.url, state.url, 'desktop origin stays stable after engine restart');
});

test('an unresponsive live lock is not replaced with a second engine', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'server.lock'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1' }));
  const engine = new Engine({ dataDir: directory, profile: directory, timeout: 100,
    runtime: () => { throw new Error('must never start a competing engine'); } });
  const state = await engine.start();
  assert.equal(state.state, 'error'); assert.match(state.error, /already running/);
  assert.equal(readLock(directory).pid, process.pid);
});

test('engine health reports a stopped engine and bounds unresponsive reconnection', async t => {
  const directory = await temporary(t);
  const engine = new Engine({ dataDir: directory, profile: directory });
  engine.publish({ state: 'ready', url: 'http://127.0.0.1:1' });
  await engine.check(); assert.equal(engine.state.state, 'error'); assert.match(engine.state.error, /stopped/);
  await fs.writeFile(path.join(directory, 'server.lock'), JSON.stringify({ pid: process.pid, url: 'http://127.0.0.1:1' }));
  engine.healthFailures = 0; engine.publish({ state: 'ready' });
  await engine.check(); assert.equal(engine.state.state, 'reconnecting');
  await engine.check(); await engine.check(); assert.equal(engine.state.state, 'error');
  assert.equal(readLock(directory).pid, process.pid);
});

test('UI preferences survive an origin change and remain scoped to their engine data', async t => {
  const directory = await temporary(t); const store = new UiState(directory, '/data/one');
  store.save('http://127.0.0.1:1234', { theme: 'dark', sidebar: '248' });
  const reopened = new UiState(directory, '/data/one');
  assert.equal(reopened.restore('http://127.0.0.1:1234'), null, 'same-origin browser state remains authoritative');
  assert.deepEqual(reopened.restore('http://127.0.0.1:5678'), { theme: 'dark', sidebar: '248' });
  assert.equal(new UiState(directory, '/data/two').restore('http://127.0.0.1:5678'), null);
  assert.throws(() => store.save('http://127.0.0.1:1234', { theme: {} }));
});

test('a busy previous port falls back without taking over another service', async t => {
  const directory = await temporary(t); const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await fs.writeFile(path.join(directory, 'desktop-engine.json'), JSON.stringify({ port: server.address().port }));
  assert.equal(await preferredPort(directory), 0); assert.equal(server.listening, true);
});

test('reconnection compares canonical document URLs without reloading the same origin', () => {
  assert.equal(sameDocument('http://127.0.0.1:58281/', 'http://127.0.0.1:58281'), true);
  assert.equal(sameDocument('http://127.0.0.1:58281/', 'http://127.0.0.1:58282'), false);
  assert.equal(sameDocument('file:///app/renderer/index.html', 'http://127.0.0.1:58281'), false);
});

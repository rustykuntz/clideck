const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createInstaller, selectBuild, VERSION } = require('../plugin-packages/google/install');
const { activate } = require('../plugin-packages/google/server');

const missing = () => { throw Object.assign(Error('missing'), { code: 'GOG_NOT_FOUND' }); };
function fixture(t, version = VERSION, member = 'gog') {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gog-install-')), payload = join(root, 'payload'), dataDir = join(root, 'data');
  fs.mkdirSync(payload); fs.mkdirSync(dataDir);
  fs.writeFileSync(join(payload, 'gog'), '#!' + process.execPath + '\n' + `if(process.argv.includes('--version')) console.log('v${version} fixture'); else console.log(JSON.stringify({accounts:[],clients:[],services:[]}));\n`, { mode: 0o700 });
  const archive = join(root, 'gog.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', payload, member]);
  const bytes = fs.readFileSync(archive), events = [], calls = [];
  const build = { version: VERSION, key: 'fixture', file: 'fixture.tar.gz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const options = { dataDir, build, locate: missing, onProgress: value => events.push(value), fetchImpl: async url => { calls.push(url); return new Response(bytes); } };
  const installed = join(dataDir, 'runtime', `gog-${VERSION}-fixture`, 'gog');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, payload, dataDir, options, bytes, events, calls, installed };
}

test('official asset selection covers Intel and ARM Macs and Ubuntu; old macOS fails explicitly', () => {
  for (const platform of ['darwin', 'linux']) for (const arch of ['x64', 'arm64']) {
    const build = selectBuild(platform, arch, '24.0.0');
    assert.equal(build.file, `gogcli_${VERSION}_${platform}_${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`);
    assert.match(build.sha256, /^[a-f0-9]{64}$/); assert(build.bytes > 10_000_000);
  }
  assert.throws(() => selectBuild('darwin', 'arm64', '23.0.0'), /macOS 15/);
  assert.throws(() => selectBuild('linux', 'arm', '6.0'), /x64 or ARM64/);
  assert.throws(() => selectBuild('win32', 'x64', '10.0'), /macOS and Ubuntu/);
});

test('existing system or chosen gog is reused without download, even on an unsupported installer platform', async t => {
  const f = fixture(t), installer = createInstaller({ ...f.options, platform: 'win32', locate: async path => path || '/existing/gog' });
  t.after(() => installer.close());
  assert.equal(await installer.ensure(), '/existing/gog'); assert.equal(installer.snapshot().source, 'system');
  assert.equal(await installer.ensure('/chosen/gog'), '/chosen/gog'); assert.equal(installer.snapshot().source, 'custom');
  assert.equal(f.calls.length, 0); assert(!fs.existsSync(join(f.dataDir, 'runtime')));
});

test('missing gog installs once for concurrent callers, verifies it and reuses it after restart', async t => {
  const f = fixture(t), installer = createInstaller(f.options); t.after(() => installer.close());
  const paths = await Promise.all([installer.ensure(), installer.ensure(), installer.ensure()]);
  assert(paths.every(path => path === f.installed)); assert.equal(f.calls.length, 1);
  assert(f.calls[0].startsWith(`https://github.com/openclaw/gogcli/releases/download/v${VERSION}/`));
  assert.equal(fs.statSync(f.installed).mode & 0o777, 0o700);
  assert.equal(execFileSync(f.installed, ['--version'], { encoding: 'utf8' }).trim(), `v${VERSION} fixture`);
  assert(f.events.some(event => event.state === 'downloading')); assert(f.events.some(event => event.state === 'verifying'));
  assert.equal(installer.snapshot().source, 'managed');
  const restarted = createInstaller({ ...f.options, fetchImpl: () => { throw Error('unexpected network'); } });
  assert.equal(await restarted.ensure(), f.installed); await restarted.close();
  assert.deepEqual(fs.readdirSync(join(f.dataDir, 'runtime')), [`gog-${VERSION}-fixture`]);
});

test('bad configured executable never silently installs or selects another one', async t => {
  const f = fixture(t), installer = createInstaller({ ...f.options, locate: undefined }); t.after(() => installer.close());
  await assert.rejects(installer.ensure(join(f.root, 'missing')), /Cannot run gog/);
  assert.equal(f.calls.length, 0); assert.equal(installer.snapshot().state, 'error');
});

test('official archives with a ./gog entry install with both GNU and BSD tar', async t => {
  const f = fixture(t, VERSION, './gog'), installer = createInstaller(f.options);
  t.after(() => installer.close());
  assert.equal(await installer.ensure(), f.installed);
  assert.equal(execFileSync(f.installed, ['--version'], { encoding: 'utf8' }).trim(), `v${VERSION} fixture`);
});

test('checksum mismatch and excessive downloads fail before extraction and leave no partial install', async t => {
  const f = fixture(t), changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1;
  for (const data of [changed, Buffer.concat([f.bytes, Buffer.from('extra')])]) {
    const installer = createInstaller({ ...f.options, fetchImpl: async () => new Response(data) });
    await assert.rejects(installer.ensure(), /checksum|expected size/);
    assert(!fs.existsSync(f.installed)); assert.deepEqual(fs.readdirSync(join(f.dataDir, 'runtime')), []);
    await installer.close();
  }
});

test('HTTP failures can retry explicitly; a wrong executable version is never published', async t => {
  const f = fixture(t); let fail = true;
  const installer = createInstaller({ ...f.options, fetchImpl: async () => fail ? new Response('unavailable', { status: 503 }) : new Response(f.bytes) });
  t.after(() => installer.close());
  await assert.rejects(installer.ensure(), /HTTP 503/); assert(!fs.existsSync(f.installed));
  fail = false; assert.equal(await installer.ensure(), f.installed);
  const g = fixture(t, '0.1.0'), wrong = createInstaller(g.options); t.after(() => wrong.close());
  await assert.rejects(wrong.ensure(), /version did not match/); assert(!fs.existsSync(g.installed));
});

test('shutdown aborts an in-flight download and cleans only its own staging folder', async t => {
  const f = fixture(t); let started;
  const begun = new Promise(resolve => { started = resolve; });
  const installer = createInstaller({ ...f.options, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  }) });
  const job = installer.ensure(); const rejected = assert.rejects(job, /disabled during/);
  await begun; await installer.close(); await rejected;
  assert(!fs.existsSync(f.installed)); assert.deepEqual(fs.readdirSync(join(f.dataDir, 'runtime')), []);
  await assert.rejects(installer.ensure(), /disabled during/);
});

test('plugin status automatically installs a missing dependency and keeps the caller waiting for the result', async t => {
  const f = fixture(t), commands = new Map(), shutdowns = [], broadcasts = [], handlers = new Map();
  fs.writeFileSync(join(f.dataDir, 'access.json'), JSON.stringify({ mode: 'selected', projects: [] }));
  const api = { dataDir: f.dataDir, getSetting: () => '', getSession: async () => ({ sessionId: 'caller', cwd: f.root }),
    getProjects: async () => [], getSessions: async () => [], registerCommand: (name, handler) => commands.set(name, handler),
    sendToClients: (event, data) => broadcasts.push({ event, data }), onClientMessage: (name, handler) => handlers.set(name, handler), onSettingsChange() {}, onShutdown: fn => shutdowns.push(fn) };
  activate(api, f.options); t.after(async () => { await Promise.all(shutdowns.map(fn => fn())); });
  assert.equal(f.calls.length, 0, 'activation stays immediate; first use installs');
  assert.equal((await commands.get('status')({ sessionId: 'caller', args: [], stdin: '' })).exitCode, 1);
  assert.equal(f.calls.length, 0, 'a blocked caller cannot initiate a download');
  let saved;
  await handlers.get('request')({ requestId: 'allow', action: 'access-save', access: { version: 2, accounts: [{ email: 'one@example.com', client: 'default', mode: 'all', projects: [] }], defaults: [] } }, { reply: (event, value) => { saved = value; } });
  assert.equal(saved.ok, true); assert.equal(f.calls.length, 0, 'access settings save immediately without installing anything');
  const result = await commands.get('status')({ sessionId: 'caller', args: [], stdin: '' });
  assert.equal(result.exitCode, 0, result.stderr);
  const state = JSON.parse(result.stdout); assert.equal(state.executable, f.installed); assert.equal(state.available, true);
  assert.equal(state.installation.source, 'managed'); assert.equal(f.calls.length, 1);
  assert(broadcasts.some(event => event.event === 'install-progress' && event.data.state === 'downloading'));
});

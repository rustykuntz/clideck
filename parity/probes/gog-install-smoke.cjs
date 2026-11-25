// Native Mac/Ubuntu plugin smoke, using an empty temporary gog profile.
// No existing accounts, Google API calls, real sessions or system installation.
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { createInstaller, VERSION } = require('../../plugin-packages/google/install');
const { createRunner } = require('../../plugin-packages/google/runner');
const { activate } = require('../../plugin-packages/google/server');

(async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gog-smoke-'));
  const commands = new Map(), shutdown = [];
  const locate = () => { throw Object.assign(Error('Clean-install fixture'), { code: 'GOG_NOT_FOUND' }); };
  // Optional offline input tests the same installer/hash checks during CDN outages.
  const archive = process.env.CLIDECK_GOG_SMOKE_ARCHIVE;
  const fetchImpl = archive ? async () => new Response(fs.readFileSync(archive)) : fetch;
  const env = { PATH: '/usr/bin:/bin', GOG_HOME: join(root, 'gog-profile'), GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: 'fake-smoke-test-password', DBUS_SESSION_BUS_ADDRESS: 'disabled:', TMPDIR: root };
  const sessions = ['allowed', 'blocked'].map(sessionId => ({ sessionId, projectId: 'fixture', cwd: root }));
  fs.writeFileSync(join(root, 'access.json'), JSON.stringify({ version: 2, accounts: [{ email: 'smoke@example.invalid', client: 'default', mode: 'selected', projects: [
    { projectId: 'fixture', agents: 'selected', sessionIds: ['allowed'] },
  ] }], defaults: [] }), { mode: 0o600 });
  const api = { dataDir: root, getSetting: () => '', getSession: async id => sessions.find(row => row.sessionId === id),
    getSessions: async () => sessions, getProjects: async () => [{ id: 'fixture', name: 'Fixture' }],
    registerCommand: (name, handler) => commands.set(name, handler), onClientMessage() {}, onSettingsChange() {},
    onShutdown: callback => shutdown.push(callback), sendToClients(event, state) {
      if (event === 'install-progress' && (state.percent === undefined || state.percent % 25 === 0)) console.log(state.message);
    } };
  activate(api, { locate, env, fetchImpl, runner: createRunner({ env }) });
  const run = (name, args = [], sessionId = 'allowed') => commands.get(name)({ args, stdin: '', sessionId });
  let reused;
  try {
    if (archive) console.log('Using a supplied archive; the pinned checksum and size are still verified.');
    const denied = await run('status', [], 'blocked');
    assert.equal(denied.exitCode, 1); assert.match(denied.stderr, /not enabled for this agent/);
    assert(!fs.existsSync(join(root, 'runtime'))); console.log('PASS excluded agent cannot start installation');
    const result = await run('status'); assert.equal(result.exitCode, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    assert.equal(state.available, true); assert.equal(state.installation.source, 'managed');
    assert.equal(state.version.split(/\s/)[0], `v${VERSION}`); assert.deepEqual(state.accounts, []);
    console.log('PASS plugin installs verified native gog and sees only its empty temporary profile');
    const help = await run('help', ['gmail', 'search']); assert.equal(help.exitCode, 0, help.stderr); assert.match(help.stdout, /Usage:/);
    console.log('PASS plugin help returns real gog command help');
    const version = await run('run', ['--version']); assert.equal(version.exitCode, 0, version.stderr); assert.match(version.stdout, new RegExp(VERSION.replaceAll('.', '\\.')));
    console.log('PASS plugin run returns the real gog version');
    const failed = await run('run', ['clideck-nonexistent-operation']); assert.notEqual(failed.exitCode, 0); assert(failed.stderr || failed.stdout);
    console.log('PASS gog command errors return to the calling agent');
    assert.equal((await run('run', ['--version'], 'blocked')).exitCode, 1);
    reused = createInstaller({ dataDir: root, locate, env, fetchImpl: () => { throw Error('Unexpected second download'); } });
    assert.equal(await reused.ensure(), state.executable);
    console.log(`PASS ${process.platform}/${process.arch}: installed binary reused; excluded agent remains blocked (${state.version})`);
  } finally {
    await Promise.all(shutdown.map(close => close())); await reused?.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

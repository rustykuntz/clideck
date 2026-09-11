const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { migrateLegacy } = require('../src/legacy-migration');
const { HeadlessServer } = require('../src/server');
const { createCustomCommandProvider } = require('../src/custom-command');

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'clideck-upgrade-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const legacyDir = join(home, '.clideck');
  const dataDir = join(home, '.clideck-next');
  mkdirSync(legacyDir); mkdirSync(dataDir);
  const write = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  const command = { id: '2', label: 'Codex', presetId: 'codex', command: 'codex', enabled: true, isAgent: true, canResume: true, env: {}, resumeCommand: 'codex resume {{sessionId}}' };
  write(legacyDir, 'config.json', { commands: [command], projects: [{ id: 'project', name: 'Website', path: home }], prompts: [{ id: 'prompt', name: 'Review', text: 'Review my changes' }], defaultPath: home });
  write(legacyDir, 'sessions.json', [{ id: 'old', name: 'Reviewer', cwd: home, commandId: '2', presetId: 'codex', sessionToken: 'native-id', projectId: 'project', themeId: 'catppuccin-mocha' }]);
  return { home, legacyDir, dataDir, write, command };
}

test('v1 upgrade restores dormant sessions, native resume, projects, prompts and transcripts', async (t) => {
  const f = fixture(t);
  const original = readFileSync(join(f.legacyDir, 'sessions.json'), 'utf8');
  mkdirSync(join(f.legacyDir, 'transcripts'));
  const transcript = JSON.stringify({ role: 'agent', text: 'Original reply', ts: 123 }) + '\n';
  writeFileSync(join(f.legacyDir, 'transcripts/old.jsonl'), transcript);
  assert.equal(migrateLegacy(f).sessions, 1);
  const server = new HeadlessServer({ port: 0, dataDir: f.dataDir });
  await server.listen();
  try {
    const entry = server.persistence.get('old');
    assert.equal(entry.resumeHandle, 'native-id');
    assert.equal(entry.commandId, undefined); // use the native provider, no duplicate built-in tile
    assert.equal(server.dormantSnapshot(entry).live, false);
    assert.equal(server.configStore.get().projects[0].id, 'project');
    assert.equal(server.configStore.get().prompts[0].text, 'Review my changes');
    assert.equal(server.configStore.get().commands.length, 0);
    assert.equal(server.transcriptStore.getTurns('old', 10)[0].text, 'Original reply');
    const options = server.resumeLaunch(require('../src/providers').getProvider('codex'), entry);
    assert.equal(options.resumed, true);
    assert.equal(options.providerOptions.resumeHandle, 'native-id');
  } finally { await server.close(); }
  assert.equal(readFileSync(join(f.legacyDir, 'sessions.json'), 'utf8'), original);
  assert.equal(readFileSync(join(f.legacyDir, 'transcripts/old.jsonl'), 'utf8'), transcript);
  assert.equal(readFileSync(join(f.dataDir, 'before-v1-migration/legacy-sessions.json'), 'utf8'), original);
  const restarted = new HeadlessServer({ port: 0, dataDir: f.dataDir });
  await restarted.listen();
  try {
    assert.equal(restarted.persistence.get('old').resumeHandle, 'native-id');
    assert.equal(restarted.transcriptStore.getTurns('old', 10)[0].text, 'Original reply');
  } finally { await restarted.close(); }
});

test('already-used v2 workspaces merge once, preserve new data and keep a pre-import backup', (t) => {
  const f = fixture(t);
  const current = [{ id: 'new', name: 'New work', cwd: f.home, provider: 'codex', resumeHandle: 'new-id' }];
  f.write(f.dataDir, 'sessions.json', current);
  f.write(f.dataDir, 'config.json', { prompts: [{ id: 'prompt', name: 'My edit', text: 'Keep this' }], defaultCwd: '/existing', plugins: { supertonic: { enabled: false } } });
  migrateLegacy(f);
  const config = JSON.parse(readFileSync(join(f.dataDir, 'config.json')));
  assert.equal(config.prompts[0].text, 'Keep this');
  assert.equal(config.plugins.supertonic.enabled, false);
  assert.equal(config.defaultCwd, '/existing');
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'before-v1-migration/sessions.json'))), current);
  const entries = JSON.parse(readFileSync(join(f.dataDir, 'sessions.json')));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], current[0]);
  f.write(f.dataDir, 'sessions.json', current); // user closes the imported session
  assert.equal(migrateLegacy(f), null);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'sessions.json'))), current);
});

test('configured native commands retain flags, account environment, Ask and resume after migration', (t) => {
  const f = fixture(t);
  f.write(f.legacyDir, 'config.json', { commands: [{ ...f.command, command: 'codex --model example', env: { CODEX_HOME: '/account' } }] });
  migrateLegacy(f);
  const config = JSON.parse(readFileSync(join(f.dataDir, 'config.json')));
  const provider = createCustomCommandProvider(config.commands[0]);
  assert.equal(provider.id, 'codex');
  assert.equal(provider.supportsAsk, true);
  const launch = provider.createLaunch({ port: 4567, sessionId: 'old', resumeHandle: 'native-id' });
  assert.equal(launch.command, 'codex');
  assert.ok(launch.args.includes('native-id'));
  assert.ok(launch.args.includes('example'));
  assert.equal(launch.env.CODEX_HOME, '/account');
});

test('invalid legacy data does not overwrite existing v2 state or mark migration complete', (t) => {
  const f = fixture(t);
  f.write(f.dataDir, 'sessions.json', []);
  writeFileSync(join(f.legacyDir, 'sessions.json'), 'broken');
  assert.throws(() => migrateLegacy(f));
  assert.equal(readFileSync(join(f.dataDir, 'sessions.json'), 'utf8'), '[]');
  assert.equal(existsSync(join(f.dataDir, 'v1-migration.json')), false);
});

test('migration preserves a valid v2 recovery registry when its primary file is missing', (t) => {
  const f = fixture(t);
  const recovered = { id: 'recovery', name: 'Recovered', provider: 'codex', cwd: f.home, resumeHandle: 'recovery-id' };
  f.write(f.dataDir, 'sessions.backup.json', [recovered]);
  migrateLegacy(f);
  const entries = JSON.parse(readFileSync(join(f.dataDir, 'sessions.json')));
  assert.deepEqual(entries[0], recovered);
  assert.equal(entries.length, 2);
});

test('fresh and already-imported Claude, Gemini and Pi sessions launch with their original native IDs', async (t) => {
  const f = fixture(t);
  const old = ['claude-code', 'gemini-cli', 'pi'].map((presetId, index) => ({
    id: `native-${index}`, name: presetId, cwd: f.home, presetId, sessionToken: `original-${index}`,
  }));
  f.write(f.legacyDir, 'sessions.json', old);
  migrateLegacy(f);
  for (let restart = 0; restart < 2; restart++) {
    const server = new HeadlessServer({ port: 0, dataDir: f.dataDir });
    await server.listen();
    try {
      for (const source of old) {
        const entry = server.persistence.get(source.id);
        const provider = require('../src/providers').getProvider(entry.provider);
        assert.equal(entry.transcriptPath, undefined);
        const options = server.resumeLaunch(provider, entry);
        assert.equal(options.resumed, true, source.presetId);
        const launch = provider.createLaunch({ ...options.providerOptions, port: server.port, sessionId: entry.id });
        try {
          const flag = entry.provider === 'pi' ? '--session' : '--resume';
          assert.equal(launch.args[launch.args.indexOf(flag) + 1], source.sessionToken, source.presetId);
        } finally { launch.cleanup?.(); }
      }
    } finally { await server.close(); }
    assert.equal(migrateLegacy(f), null); // a 2.0.1 migration marker must not prevent the fix
  }
});

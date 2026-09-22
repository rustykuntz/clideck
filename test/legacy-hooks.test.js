const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { migrateLegacyHooks } = require('../src/legacy-hooks');
const { AgentSession } = require('../src/session');
const pty = require('../src/pty');

function fixture(t, provider, document) {
  const home = fs.mkdtempSync(join(tmpdir(), 'clideck-hook-upgrade-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = join(home, provider === 'codex' ? '.codex' : '.claude');
  fs.mkdirSync(profile);
  const path = join(profile, provider === 'codex' ? 'hooks.json' : 'settings.json');
  const original = typeof document === 'string' ? document : JSON.stringify(document);
  fs.writeFileSync(path, original);
  return { home, profile, path, original, env: { HOME: home } };
}
function old(provider, route) {
  return { type: 'command', command: `"/home/or/.nvm/versions/node/v24.18.0/bin/node" "/home/or/.nvm/versions/node/v24.18.0/lib/node_modules/clideck/bin/${provider}-hook.js" 4000 ${route}` };
}
const own = { type: 'command', command: 'echo user-owned' };

test('Claude upgrade removes only old inner hooks and preserves original backup and settings', t => {
  const hooks = {};
  for (const [event, route] of Object.entries({ UserPromptSubmit: 'start', Stop: 'stop', SessionStart: 'session-start', SessionEnd: 'session-end', PreToolUse: 'menu', Notification: 'idle' })) {
    hooks[event] = [{ ...(event === 'Notification' ? { matcher: 'idle_prompt' } : {}), hooks: [old('claude', route)] }];
  }
  hooks.Stop[0].hooks.push(own);
  hooks.Stop[0].timeout = 42;
  hooks.Notification.push({ matcher: 'other', hooks: [old('claude', 'idle')] });
  hooks.Other = [{ hooks: [own] }];
  const f = fixture(t, 'claude', { theme: 'dark', permissions: { allow: ['Read'] }, hooks });
  fs.chmodSync(f.path, 0o640);
  const result = migrateLegacyHooks('claude-code', f.env, f.home);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o640);
  assert.equal(result.removed, 6);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), f.original);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  const actual = JSON.parse(fs.readFileSync(f.path));
  assert.deepEqual(actual, { theme: 'dark', permissions: { allow: ['Read'] }, hooks: {
    Stop: [{ hooks: [own], timeout: 42 }], Notification: [{ matcher: 'other', hooks: [old('claude', 'idle')] }], Other: [{ hooks: [own] }],
  } });
  const names = fs.readdirSync(f.profile);
  assert.equal(migrateLegacyHooks('claude-code', f.env, f.home), null);
  assert.deepEqual(fs.readdirSync(f.profile), names);
});

test('Codex migration preserves other hooks, metadata, and config.toml', t => {
  const f = fixture(t, 'codex', { metadata: { keep: true }, hooks: {
    UserPromptSubmit: [{ hooks: [old('codex', 'start')] }],
    Stop: [{ matcher: '*', hooks: [own, old('codex', 'stop')] }],
  } });
  const config = '[features]\nhooks = true\n';
  fs.writeFileSync(join(f.profile, 'config.toml'), config);
  assert.equal(migrateLegacyHooks('codex', f.env, f.home).removed, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.path)), { metadata: { keep: true }, hooks: { Stop: [{ matcher: '*', hooks: [own] }] } });
  assert.equal(fs.readFileSync(join(f.profile, 'config.toml'), 'utf8'), config);
});

test('similar filenames, v2 commands, other routes and wrapped commands are untouched', t => {
  const base = old('claude', 'stop');
  const hooks = [own,
    { ...base, command: base.command.replace('/bin/claude-hook.js', '/src/claude-hook.js') },
    { ...base, command: `${base.command} && echo done` },
    { ...base, command: base.command.replace('4000 stop', '4000 start') },
    { ...base, command: base.command.replace('4000 stop', '4000 session stop') },
    { ...base, command: base.command.replace('4000 stop', '0 stop') },
  ];
  const f = fixture(t, 'claude', { hooks: { Stop: [{ hooks }] } });
  assert.equal(migrateLegacyHooks('claude-code', f.env, f.home), null);
  assert.equal(fs.readFileSync(f.path, 'utf8'), f.original);
  assert.deepEqual(fs.readdirSync(f.profile), ['settings.json']);
});

test('malformed files remain byte-identical and report a warning', t => {
  for (const invalid of ['{bad', '[]', { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: [old('claude', 'stop')] }], PreToolUse: [{}] } }]) {
    const f = fixture(t, 'claude', invalid), warnings = [];
    assert.equal(migrateLegacyHooks('claude-code', f.env, f.home, s => warnings.push(s)), null);
    assert.equal(warnings.length, 1);
    assert.equal(fs.readFileSync(f.path, 'utf8'), f.original);
    assert.deepEqual(fs.readdirSync(f.profile), ['settings.json']);
  }
});

test('effective custom profile and symlink are respected; default profile is untouched', t => {
  for (const provider of ['claude-code', 'codex']) {
    const f = fixture(t, provider === 'codex' ? 'codex' : 'claude', { hooks: { Stop: [{ hooks: [old(provider === 'codex' ? 'codex' : 'claude', 'stop')] }] } });
    const custom = join(f.home, 'custom'); fs.mkdirSync(custom);
    const target = join(f.home, 'real-settings.json'); fs.writeFileSync(target, f.original);
    const linked = join(custom, provider === 'codex' ? 'hooks.json' : 'settings.json'); fs.symlinkSync(target, linked);
    const env = { ...f.env, [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: 'custom' };
    assert.equal(migrateLegacyHooks(provider, env, f.home).removed, 1);
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target)), { hooks: {} });
    assert.equal(fs.readFileSync(f.path, 'utf8'), f.original);
  }
});

test('native launch repairs effective launch env profile before PTY creation', t => {
  const f = fixture(t, 'codex', { hooks: { Stop: [{ hooks: [old('codex', 'stop')] }] } });
  const originalSpawn = pty.spawn;
  let launched = false;
  pty.spawn = (_command, _args, options) => {
    assert.equal(options.env.CODEX_HOME, f.profile);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.path)), { hooks: {} });
    launched = true;
    return { pid: 123, onData() {}, onExit() {} };
  };
  const session = new AgentSession({ cwd: f.home, provider: { id: 'codex', command: 'fixture', createLaunch: () => ({ command: 'fixture', env: { CODEX_HOME: f.profile } }) } });
  try { session.start(); assert.equal(launched, true); } finally { pty.spawn = originalSpawn; session.handleExit(0, null); }
});

test('configured native commands retain custom profile env and current packaged hook paths', t => {
  const { createCustomCommandProvider } = require('../src/custom-command');
  for (const providerId of ['claude-code', 'codex']) {
    const f = fixture(t, providerId === 'codex' ? 'codex' : 'claude', {
      hooks: { Stop: [{ hooks: [old(providerId === 'codex' ? 'codex' : 'claude', 'stop')] }] },
    });
    const key = providerId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
    const provider = createCustomCommandProvider({ providerId, command: providerId === 'codex' ? 'codex' : 'claude', env: { [key]: f.profile } });
    const originalSpawn = pty.spawn;
    pty.spawn = (_command, args, options) => {
      assert.equal(options.env[key], f.profile);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.path)), { hooks: {} });
      if (providerId === 'claude-code') {
        const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1]));
        assert.match(settings.hooks.Stop[0].hooks[0].command, /src\/claude-hook\.js/);
      } else assert(args.some(arg => arg.includes('src/codex-hook.js')));
      return { pid: 123, onData() {}, onExit() {} };
    };
    const session = new AgentSession({ cwd: f.home, provider, port: 1 });
    try { session.start(); } finally { pty.spawn = originalSpawn; session.handleExit(0, null); }
  }
});

test('failed atomic replacement leaves original intact and a recoverable backup', t => {
  const f = fixture(t, 'claude', { hooks: { Stop: [{ hooks: [old('claude', 'stop')] }] } });
  const rename = fs.renameSync, warnings = [];
  fs.renameSync = () => { throw new Error('forced rename failure'); };
  try { assert.equal(migrateLegacyHooks('claude-code', f.env, f.home, s => warnings.push(s)), null); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.path, 'utf8'), f.original);
  assert.equal(warnings.length, 1);
  const names = fs.readdirSync(f.profile);
  assert.equal(names.filter(n => n.endsWith('.tmp')).length, 0);
  const backup = names.find(n => n.includes('clideck-v1-backup'));
  assert.equal(fs.readFileSync(join(f.profile, backup), 'utf8'), f.original);
});

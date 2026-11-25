const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { findGog, createRunner } = require('../plugin-packages/google/runner');
const { activate, commandArgs, scopedArgs } = require('../plugin-packages/google/server');
const { Access } = require('../plugin-packages/google/access');
const { HeadlessServer } = require('../src/server');
const { AgentSession } = require('../src/session');
const { getProvider } = require('../src/providers');

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'clideck-google-')));
  const bin = join(dir, 'gog fixture');
  fs.writeFileSync(bin, '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.argv[1]+'.calls', JSON.stringify(args)+'\n');
const done = (stdout, code = 0, stderr = '') => { process.stdout.write(stdout); process.stderr.write(stderr); process.exitCode = code; };
if (args.includes('--version')) done('v0.45.0 fixture\n');
else if (args.includes('--help')) done('Usage: gog gmail search <query>\n');
else if (args.includes('credentials')) done(JSON.stringify({clients:[{client:'default'},{client:'clideck'}]}));
else if (args.includes('services')) done(JSON.stringify({services:[{service:'gmail',user:true,apis:['Gmail API']}]}));
else if (args.includes('auth')) done(JSON.stringify({accounts:(fs.existsSync(process.argv[1]+'.accounts') ? JSON.parse(fs.readFileSync(process.argv[1]+'.accounts','utf8')) : [{email:'one@example.com',client:'default',services:['gmail','drive'],auth:'oauth',refresh_token:'MUST_NOT_LEAK'}]).map(a=>({...a,...(args.includes('--check')?{valid:false,error:'invalid_grant'}:{})}))}));
else if (args.includes('hang')) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (args.includes('huge')) process.stdout.write('x'.repeat(300000));
else if (args.includes('denied')) done('{"error":{"code":4,"message":"expired"}}\n', 4, 'Please sign in again.\n');
else { let stdin=''; process.stdin.on('data', chunk => stdin+=chunk); process.stdin.on('end', () => done(JSON.stringify({args,stdin,cwd:process.cwd()}))); }
`, { mode: 0o700 });
  const config = { executable: bin, client: 'default' };
  const projects = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  const sessions = [{ sessionId: 'caller', name: 'Main', cwd: dir, projectId: 'p1', provider: 'codex', live: true }];
  const commands = new Map(), messages = new Map(), broadcasts = [], shutdowns = [];
  const api = {
    dataDir: dir, getSetting: key => config[key], getSession: async id => sessions.find(session => session.sessionId === id) || null,
    getProjects: async () => projects, getSessions: async () => sessions,
    registerCommand: (name, handler) => commands.set(name, handler), onClientMessage: (name, handler) => messages.set(name, handler),
    sendToClients: (event, state) => broadcasts.push({ event, state }), onSettingsChange() {}, onShutdown: callback => shutdowns.push(callback),
  };
  activate(api);
  t.after(async () => { await Promise.all(shutdowns.map(callback => callback())); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (action, access) => {
    let result;
    if (access && !access.version) access = { version: 2, accounts: [{ email: 'one@example.com', client: 'default', ...access }], defaults: [] };
    await messages.get('request')({ requestId: 'test', action, ...(access && { access }) }, { reply: (event, value) => { result = value; } });
    return result;
  };
  return { dir, bin, config, api, projects, sessions, commands, messages, broadcasts, request, cleanup: shutdowns, run: (name, args = [], stdin = '', sessionId = 'caller') => commands.get(name)({ args, stdin, sessionId }) };
}

test('gog discovery supports paths containing spaces and fails clearly for a bad configured path', async t => {
  const f = fixture(t);
  assert.equal(await findGog(f.bin), f.bin);
  await assert.rejects(findGog('relative/gog'), /full path/);
  await assert.rejects(findGog(join(f.dir, 'missing')), /Cannot run gog/);
  const local = join(f.dir, '.local', 'bin'); fs.mkdirSync(local, { recursive: true }); fs.copyFileSync(f.bin, join(local, 'gog'));
  assert.equal(await findGog('', { PATH: '' }, f.dir), join(local, 'gog'));
});

test('status reads only account metadata; credential checks expose failure without exposing tokens', async t => {
  const f = fixture(t);
  const stored = await f.run('status'); assert.equal(stored.exitCode, 0, stored.stderr);
  const state = JSON.parse(stored.stdout);
  assert.equal(state.available, true); assert.equal(state.checked, false); assert.equal(state.accounts[0].valid, undefined);
  assert.equal(state.accounts[0].email, 'one@example.com'); assert(!stored.stdout.includes('MUST_NOT_LEAK'));
  const checked = await f.run('status', ['--check']); assert.equal(checked.exitCode, 1);
  assert.equal(JSON.parse(checked.stdout).accounts[0].valid, false); assert.match(checked.stdout, /invalid_grant/);
  assert.equal(JSON.parse(checked.stdout).next.message, '');
  assert(!checked.stdout.includes('MUST_NOT_LEAK'));
  f.config.executable = join(f.dir, 'missing');
  const missing = await f.run('status'); assert.equal(missing.exitCode, 1); assert.equal(JSON.parse(missing.stdout).available, false);
});

test('run preserves argv, stdin and caller cwd without executing shell syntax', async t => {
  const f = fixture(t);
  const marker = join(f.dir, 'shell-was-run');
  const query = '$(touch ' + marker + ') ; echo private';
  const response = await f.run('run', ['gmail', 'search', query, '--account', 'one@example.com', '--client=default'], 'line one\nline two\n');
  assert.equal(response.exitCode, 0, response.stderr);
  const output = JSON.parse(response.stdout);
  assert.deepEqual(output.args, ['--no-input', '--color=never', '--json', '--account', 'one@example.com', '--client', 'default', 'gmail', 'search', query]);
  assert.equal(output.stdin, 'line one\nline two\n'); assert.equal(output.cwd, f.dir); assert(!fs.existsSync(marker));
  assert.equal((await f.run('run', ['gmail', 'search', 'x'], '', 'deleted')).exitCode, 1);
});

test('default identity and output options respect explicit gog flags; interactive mode is refused', () => {
  const settings = { account: 'default@example.com', client: 'work' };
  assert.deepEqual(commandArgs(['drive', 'ls', '--plain'], settings), ['--no-input', '--color=never', '--account', settings.account, '--client', 'work', 'drive', 'ls', '--plain']);
  assert(!commandArgs(['-aother@example.com', 'drive', 'ls'], settings).includes(settings.account));
  assert(commandArgs(['gmail', 'search', '--', '--account'], settings).includes(settings.account), 'a literal positional flag does not override account selection');
  assert.throws(() => commandArgs(['--no-input=false', 'auth', 'add'], settings), /interactive/);
});

test('runner accepts deferred stdin for sign-in and rejects invalid input without exposing it', async t => {
  const f = fixture(t), runner = createRunner(); t.after(() => runner.close());
  let send;
  const input = new Promise(resolve => { send = resolve; });
  const result = runner.run(f.bin, ['echo'], { stdin: () => input });
  send('PRIVATE_CALLBACK\n');
  const reply = await result;
  assert.equal(reply.exitCode, 0); assert.equal(JSON.parse(reply.stdout).stdin, 'PRIVATE_CALLBACK\n');
  assert(!fs.readFileSync(f.bin + '.calls', 'utf8').includes('PRIVATE_CALLBACK'));
  for (const value of [null, 'x'.repeat(1024 * 1024 + 1)]) {
    const rejected = await runner.run(f.bin, ['echo'], { stdin: async () => value });
    assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr, /Invalid gog stdin/);
  }
  const rejected = await runner.run(f.bin, ['echo'], { stdin: async () => { throw Error('PRIVATE_ERROR'); } });
  assert.equal(rejected.exitCode, 1); assert(!rejected.stderr.includes('PRIVATE_ERROR'));
});

test('gog errors and help return directly to the agent, including the original exit code', async t => {
  const f = fixture(t);
  const result = await f.run('run', ['gmail', 'denied']); assert.equal(result.exitCode, 4);
  assert.equal(JSON.parse(result.stdout).error.code, 4); assert.match(result.stderr, /sign in again/);
  const help = await f.run('help', ['gmail', 'search']); assert.equal(help.exitCode, 0); assert.match(help.stdout, /Usage/);
  assert.equal((await f.run('help', ['--some-flag'])).exitCode, 1);
});

test('oversized output and deadlines are errors; timeout kills its own uncooperative child', async t => {
  const f = fixture(t), runner = createRunner(); t.after(() => runner.close());
  const huge = await runner.run(f.bin, ['huge']); assert.equal(huge.exitCode, 1); assert.equal(huge.stdout, ''); assert.match(huge.stderr, /exceeded/);
  const hung = await runner.run(f.bin, ['hang'], { timeout: 500 }); assert.equal(hung.exitCode, 124); assert.match(hung.stderr, /before retrying/);
  const next = await runner.run(f.bin, ['--version']); assert.equal(next.exitCode, 0);
});

test('disabling cancels outstanding commands, refuses new commands, and never retries', async t => {
  const f = fixture(t), runner = createRunner();
  const jobs = Array.from({ length: 4 }, () => runner.run(f.bin, ['hang']));
  assert.throws(() => runner.run(f.bin, ['hang']), /busy/);
  await runner.close();
  for (const job of jobs) assert.equal((await job).exitCode, 130);
  assert.throws(() => runner.run(f.bin, ['--version']), /stopping/);
});

test('browser status/check contract reports account failures; arbitrary commands are unavailable', async t => {
  const f = fixture(t), replies = [], context = { reply: (event, data) => replies.push({ event, data }) };
  await f.messages.get('request')({ requestId: 'first', action: 'check' }, context);
  assert.equal(replies[0].data.ok, true); assert.equal(replies[0].data.checked, true); assert.match(replies[0].data.error, /attention/);
  assert(f.broadcasts.some(event => event.event === 'updated'));
  await f.messages.get('request')({ requestId: 'second', action: 'run', args: ['send'] }, context);
  assert.equal(replies[1].data.ok, false);
});

test('opening Google setup checks connections without needing a live agent session', async t => {
  const f = fixture(t); f.sessions.length = 0;
  const state = await f.request('check');
  assert.equal(state.ok, true); assert.equal(state.checked, true);
  assert.equal(state.accounts[0].valid, false); assert.match(state.accounts[0].error, /invalid_grant/);
  assert(!state.next.message.includes('Check a connection'));
});

test('a configured OAuth client scopes status and checks without showing another app\'s saved account', async t => {
  const f = fixture(t); f.config.client = 'clideck';
  const state = await f.request('check');
  assert.equal(state.ok, true); assert.deepEqual(state.accounts, []); assert.equal(state.error, '');
  assert.equal(state.defaults.client, 'clideck');
  const calls = fs.readFileSync(f.bin + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const check = calls.find(args => args.includes('--check'));
  assert.equal(check[check.indexOf('--client') + 1], 'clideck');
});

test('project access blocks every agent command before gog starts and follows current project membership', async t => {
  const f = fixture(t);
  f.sessions.push({ sessionId: 'other', name: 'Main', cwd: f.dir, projectId: 'p2' });
  assert.equal((await f.run('help', [], '', 'other')).exitCode, 0, 'all projects is the initial behavior');
  const saved = await f.request('access-save', { mode: 'selected', projects: [{ projectId: 'p1', agents: 'all', sessionIds: [] }] });
  assert.equal(saved.ok, true); assert.equal(saved.accessOptions[0].sessions[0].id, 'caller');
  const before = fs.readFileSync(f.bin + '.calls', 'utf8');
  for (const [command, args] of [['status', []], ['status', ['--check']], ['help', ['gmail']], ['run', ['gmail', 'search', 'x']]]) {
    const denied = await f.run(command, args, '', 'other'); assert.equal(denied.exitCode, 1); assert.match(denied.stderr, /not enabled for this agent/); assert.equal(denied.stdout, '');
  }
  assert.equal(fs.readFileSync(f.bin + '.calls', 'utf8'), before, 'denied commands never launch gog');
  f.sessions.push({ sessionId: 'future', name: 'Future', cwd: f.dir, projectId: 'p1' });
  assert.equal((await f.run('run', ['drive', 'ls'], '', 'future')).exitCode, 0, 'all agents includes future sessions');
  f.projects[0].name = 'Renamed'; f.sessions[0].name = 'Renamed too';
  assert.equal((await f.run('help')).exitCode, 0);
  f.sessions[0].projectId = 'p2'; assert.equal((await f.run('help')).exitCode, 1, 'moving an agent out removes access');
  f.projects.splice(0, 1); assert.equal((await f.run('help', [], '', 'future')).exitCode, 1, 'a deleted project cannot leave an orphaned grant');
});

test('selected agents use IDs, reject cross-project choices, and an empty selection permits nobody', async t => {
  const f = fixture(t);
  f.sessions.push({ sessionId: 'peer', name: 'Main', cwd: f.dir, projectId: 'p1' });
  const chosen = { mode: 'selected', projects: [{ projectId: 'p1', agents: 'selected', sessionIds: ['caller'] }] };
  assert.equal((await f.request('access-save', chosen)).ok, true);
  assert.equal((await f.run('help', [], '', 'peer')).exitCode, 1);
  f.sessions[0].name = 'New name'; assert.equal((await f.run('help')).exitCode, 0);
  assert.equal((await f.request('access-save', { mode: 'selected', projects: [{ projectId: 'p2', agents: 'selected', sessionIds: ['caller'] }] })).ok, false);
  assert.deepEqual((({ email, client, ...policy }) => policy)((await f.request('status')).access.accounts[0]), chosen, 'invalid updates leave the prior rule in force');
  assert.equal((await f.request('access-save', { mode: 'selected', projects: [{ projectId: 'p1', agents: 'selected', sessionIds: [] }] })).ok, true);
  assert.equal((await f.run('help')).exitCode, 1, 'an empty agent selection grants no access within its project');
  assert.equal((await f.request('access-save', { mode: 'selected', projects: [] })).ok, true);
  assert.equal((await f.run('help')).exitCode, 1);
  assert.equal((await f.request('access-save', { mode: 'all', projects: [] })).ok, true, 'the user can restore access from the plugin even if its current session is excluded');
  assert.equal((await f.run('help')).exitCode, 0);
});

test('access survives restart, handles unassigned sessions, and damaged storage blocks commands until repaired', async t => {
  const f = fixture(t); f.sessions[0].projectId = null;
  const access = new Access(f.api), chosen = { mode: 'selected', projects: [{ projectId: null, agents: 'selected', sessionIds: ['caller'] }] };
  await access.save(chosen);
  assert.equal(fs.statSync(access.path).mode & 0o777, 0o600);
  const restored = new Access(f.api); await restored.assert('caller'); assert.deepEqual((await restored.snapshot()).access, chosen);
  fs.writeFileSync(access.path, '{broken'); const broken = new Access(f.api);
  await assert.rejects(broken.assert('caller'), /commands are blocked/);
  assert.match((await broken.snapshot()).accessError, /Cannot read/);
  const repaired = { version: 2, accounts: [{ email: 'one@example.com', client: 'default', ...chosen }], defaults: [] };
  await broken.save(repaired); await broken.assert('caller');
  fs.unlinkSync(access.path); fs.mkdirSync(access.path);
  await assert.rejects(broken.save({ version: 2, accounts: [], defaults: [] }), /Previous access is unchanged/);
  assert.deepEqual((await broken.snapshot()).access, repaired);
});

test('shipped Google plugin is listed disabled and runs through the real worker after enable', async t => {
  const f = fixture(t), bundled = join(f.dir, 'bundled'); fs.mkdirSync(bundled);
  const server = new HeadlessServer({ port: 0, dataDir: join(f.dir, 'data'), bundledPluginsDir: bundled, pluginCatalogDir: resolve(__dirname, '../plugin-packages'), autoSaveMs: 0 });
  const session = new AgentSession({ id: 'caller', name: 'Fixture', provider: getProvider('codex'), cwd: f.dir });
  session.status = 'idle'; session.terminal = { write() {}, kill: () => session.handleExit(0, null) }; session.close = () => session.handleExit(0, null);
  server.persistence.register(session); server.sessions.set(session.id, session);
  const { httpUrl } = await server.listen(); f.cleanup.push(() => server.close());
  const cli = (args, stdin = '') => new Promise(resolveResult => {
    const child = spawn(process.execPath, [resolve(__dirname, '../bin/clideck.js'), ...args], { env: { ...process.env, CLIDECK_URL: httpUrl, CLIDECK_SESSION_ID: session.id } });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('close', code => resolveResult({ code, stdout, stderr })); child.stdin.end(stdin);
  });
  const available = JSON.parse((await cli(['plugins', '--all', '--json'])).stdout);
  assert(available.some(row => row.id === 'google' && row.installed && !row.enabled && row.source === 'bundled'));
  assert.equal(server.pluginManager.records.get('google').worker, null);
  const configured = await cli(['plugin', 'settings', 'google', '--stdin'], JSON.stringify({ executable: f.bin, client: 'default' }));
  assert.equal(configured.code, 0, configured.stderr);
  const enabled = await cli(['plugin', 'enable', 'google']); assert.equal(enabled.code, 0, enabled.stderr);
  const status = await cli(['google/status']); assert.equal(status.code, 0, status.stderr); assert.equal(JSON.parse(status.stdout).accounts.length, 1);
  const result = await cli(['google/run', 'drive', 'ls'], 'payload'); assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).stdin, 'payload'); assert.equal(JSON.parse(result.stdout).cwd, f.dir);
  assert.equal((await cli(['google/run', 'gmail', 'denied'])).code, 4);
  const accessSave = policy => new Promise((resolveResult, reject) => {
    const access = { version: 2, accounts: [{ email: 'one@example.com', client: 'default', ...policy }], defaults: [] };
    const timer = setTimeout(() => reject(Error('Access save timed out')), 5000);
    server.pluginManager.clientMessage('google', 'request', { requestId: 'policy', action: 'access-save', access }, {
      reply: event => { clearTimeout(timer); resolveResult(event.data); },
    });
  });
  assert.equal((await accessSave({ mode: 'selected', projects: [] })).ok, true);
  const blocked = await cli(['google/run', 'drive', 'ls']); assert.equal(blocked.code, 1); assert.match(blocked.stderr, /not enabled for this agent/);
  await cli(['plugin', 'disable', 'google']); await cli(['plugin', 'enable', 'google']);
  assert.equal((await cli(['google/status'])).code, 1, 'restriction survives an actual worker restart');
  assert.equal((await accessSave({ mode: 'selected', projects: [{ projectId: null, agents: 'selected', sessionIds: [session.id] }] })).ok, true);
  assert.equal((await cli(['google/status'])).code, 0, 'browser management can restore access for a blocked caller');
  assert.equal((await cli(['plugin', 'disable', 'google'])).code, 0);
  assert.equal((await cli(['google/status'])).code, 1);
});

const grant = (email, projectId, sessionIds = [], client = 'default') => ({ email, client, mode: 'selected', projects: [{ projectId, agents: sessionIds.length ? 'selected' : 'all', sessionIds }] });
const policy = (accounts, defaults = []) => ({ version: 2, accounts, defaults });

test('accounts are scoped to current project and agent; explicit overrides cannot cross the boundary', async t => {
  const f = fixture(t);
  f.sessions.push({ sessionId: 'support', projectId: 'p2', cwd: f.dir }, { sessionId: 'peer', projectId: 'p1', cwd: f.dir });
  assert.equal((await f.request('access-save', policy([grant('one@example.com', 'p1', ['caller']), grant('support@example.com', 'p2')]))).ok, true);
  for (const [caller, email] of [['caller', 'one@example.com'], ['support', 'support@example.com']]) {
    const result = await f.run('run', ['gmail', 'search', 'in:inbox'], '', caller);
    assert.equal(result.exitCode, 0, result.stderr);
    const args = JSON.parse(result.stdout).args;
    assert.equal(args[args.indexOf('--account') + 1], email);
    assert.equal(args[args.indexOf('--client') + 1], 'default');
  }
  const before = fs.readFileSync(f.bin + '.calls', 'utf8');
  for (const args of [
    ['gmail', 'search', 'x', '--account', 'support@example.com'],
    ['gmail', 'search', 'x', '--acct=support@example.com'],
    ['-asupport@example.com', 'gmail', 'search', 'x'],
    ['gmail', 'search', 'x', '--client=other'],
    ['gmail', 'search', 'x', '--account=auto'],
    ['auth', 'list'], ['--json', 'auth', 'tokens', 'export'], ['config', 'set'], ['login'], ['logout'], ['status'], ['st'], ['backup'], ['mcp'], ['api'],
    ['gmail', 'search', 'x', '--home=/tmp/other'], ['gmail', 'search', 'x', '--access-token=secret'],
    ['gmail', 'search', 'x', '-jasupport@example.com'],
    ['gmail', 'search', 'x', '--account=one@example.com', '-asupport@example.com'],
  ]) assert.equal((await f.run('run', args)).exitCode, 1, JSON.stringify(args));
  assert.equal((await f.run('run', ['gmail', 'search', 'x'], '', 'peer')).exitCode, 1);
  assert.equal(fs.readFileSync(f.bin + '.calls', 'utf8'), before, 'denials never invoke gog');
  f.sessions[0].projectId = 'p2';
  const moved = JSON.parse((await f.run('run', ['gmail', 'search', 'x'])).stdout).args;
  assert.equal(moved[moved.indexOf('--account') + 1], 'support@example.com');
});

test('project defaults resolve multiple accounts without falling back to global settings', async t => {
  const f = fixture(t), accounts = [grant('one@example.com', 'p1'), grant('two@example.com', 'p1'), grant('one@example.com', 'p1', [], 'other')];
  await f.request('access-save', policy(accounts));
  assert.match((await f.run('run', ['drive', 'ls'])).stderr, /Multiple Google accounts/);
  assert.match((await f.run('run', ['drive', 'ls', '--account=one@example.com'])).stderr, /Multiple Google accounts/);
  assert.equal((await f.run('run', ['drive', 'ls', '--account=one@example.com', '--client=other'])).exitCode, 0);
  assert.equal((await f.request('access-save', policy(accounts, [{ projectId: 'p1', email: 'two@example.com', client: 'default' }]))).ok, true);
  const args = JSON.parse((await f.run('run', ['--readonly', 'drive', 'ls'])).stdout).args;
  assert.equal(args[args.indexOf('--account') + 1], 'two@example.com');
  assert.equal((await f.request('access-save', policy(accounts, [{ projectId: 'p2', email: 'two@example.com', client: 'default' }]))).ok, false);
  assert.equal((await f.request('access-save', policy([...accounts, accounts[0]]))).ok, false);
});

test('agent status hides other accounts and setup cannot manage other identities or shared credentials', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.bin + '.accounts', JSON.stringify([{ email: 'one@example.com', client: 'default' }, { email: 'private@example.com', client: 'default' }]));
  await f.request('access-save', policy([grant('one@example.com', 'p1')]));
  const status = await f.run('status'); assert.equal(status.exitCode, 0);
  assert(!status.stdout.includes('private@example.com'));
  assert.equal(JSON.parse(status.stdout).accounts.length, 1);
  assert.equal(JSON.parse(status.stdout).accessOptions, undefined);
  assert.equal((await f.request('status')).accounts.length, 2, 'the user still manages all accounts');
  const before = fs.readFileSync(f.bin + '.calls', 'utf8');
  for (const [action, fields] of [['auth-start', { email: 'private@example.com' }], ['account-remove', { email: 'private@example.com' }], ['credentials-save', {}], ['credentials-remove', {}], ['auth-cancel', { id: 'foreign' }]]) {
    assert.equal((await f.run('setup', [action], JSON.stringify(fields))).exitCode, 1);
  }
  assert.equal(fs.readFileSync(f.bin + '.calls', 'utf8'), before);
});

test('legacy grants migrate once and newly connected accounts remain unassigned after restart', async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.dir, 'access.json'), JSON.stringify({ mode: 'selected', projects: [{ projectId: 'p1', agents: 'selected', sessionIds: ['caller'] }] }));
  const access = new Access(f.api);
  access.migrate([{ email: 'one@example.com', client: 'default' }]);
  access.migrate([{ email: 'new@example.com', client: 'default' }]);
  const restored = new Access(f.api);
  assert.deepEqual(await restored.resolve('caller'), { email: 'one@example.com', client: 'default' });
  await assert.rejects(restored.resolve('caller', { email: 'new@example.com' }), /not allowed/);
  await assert.rejects(restored.save({ mode: 'all', projects: [] }), /Refresh/);
  assert.equal(fs.statSync(restored.path).mode & 0o777, 0o600);
});

test('argument selection preserves literal values and refuses ambiguous flags', () => {
  assert.deepEqual(scopedArgs(['--readonly', '--account=one@example.com', 'gmail', 'search', '--', '--account']), {
    requested: { email: 'one@example.com' }, args: ['--readonly', 'gmail', 'search', '--', '--account'],
  });
  for (const args of [['--account', 'gmail'], ['gmail', '--client'], ['--color', '--account=x', 'gmail'], ['--json', '--', 'auth']]) assert.throws(() => scopedArgs(args));
});

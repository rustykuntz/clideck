const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createRunner } = require('../plugin-packages/google/runner');
const { createSetup, errorMessage } = require('../plugin-packages/google/setup');
const { activate, createService } = require('../plugin-packages/google/server');

const connectionFile = JSON.stringify({ installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'PRIVATE_CLIENT_SECRET' } });
const startRequest = { action: 'auth-start', email: 'one@example.com', client: 'default', services: ['gmail'], readonly: true };

function fixture(t, options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'clideck-google-setup-'))), bin = join(dir, 'fake-gog');
  fs.writeFileSync(bin, '#!' + process.execPath + '\n' + String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2), root = process.argv[1];
fs.appendFileSync(root+'.calls', JSON.stringify(args)+'\n');
const read = (suffix, fallback) => { try { return JSON.parse(fs.readFileSync(root+suffix,'utf8')); } catch { return fallback; } };
const save = (suffix, value) => fs.writeFileSync(root+suffix, JSON.stringify(value));
const value = flag => args[args.indexOf(flag)+1];
const client = args.includes('--client') ? value('--client') : 'default';
const done = value => process.stdout.write(JSON.stringify(value));
const fail = message => { process.stderr.write(message); process.exitCode=1; };
if (args.includes('credentials')) {
  const clients = read('.clients', []);
  if (args.includes('list')) done({clients:clients.map(client=>({client,client_secret:'MUST_NOT_LEAK'}))});
  else if (args.includes('set')) {
    let input=''; process.stdin.on('data',chunk=>input+=chunk);
    process.stdin.on('end',()=>{ const file=JSON.parse(input); if(!file.installed.client_secret) return fail('missing secret');
      save('.clients',[...new Set([...clients,client])]); done({saved:true,client}); });
  } else if (args.includes('remove')) { if(!fs.existsSync(root+'.ignore-remove')) save('.clients',clients.filter(c=>c!==args.at(-1))); done({removed:true}); }
} else if (args.includes('services')) done({services:[{service:'gmail',user:true,apis:['Gmail API']},{service:'drive',user:true,apis:['Drive API']},{service:'ads',user:false,apis:['Google Ads API']},{service:'admin',user:false,apis:['Admin API']}]});
else if (args.includes('list')) done({accounts:read('.accounts',[])});
else if (args.includes('remove')) { if(!fs.existsSync(root+'.ignore-remove')) save('.accounts',read('.accounts',[]).filter(a=>a.client!==client||a.email!==args.at(-1))); done({removed:true}); }
else if (args.includes('add')) {
  const email = value('add');
  if(email.startsWith('before-')) { fail('Password storage is locked.'); return; }
  const redirect=args.find(arg=>arg.startsWith('--redirect-uri='))?.slice('--redirect-uri='.length);
  if(!args.includes('--manual') || !redirect) { fail('manual callback required'); return; }
  let input=''; process.stdin.on('data',chunk=>input+=chunk);
  process.stdin.on('end',()=>{
    const url=new URL(input.trim());
    if(url.searchParams.get('state')!=='fixture-state' || url.origin+url.pathname!==redirect) return fail('state mismatch');
    if(url.searchParams.has('error')) return fail('Authorization denied by Google.');
    if(url.searchParams.get('code')==='bad') return fail('exchange code: invalid_grant code=SECRET_CODE');
    const finish=()=>{
      save('.accounts',[...read('.accounts',[]),{email,client,services:['gmail'],scopes:['https://www.googleapis.com/auth/gmail.readonly'],auth:'oauth'}]);
      done({stored:!email.startsWith('unconfirmed-'),email,client});
    };
    if(email.startsWith('slow-')) setTimeout(finish,150); else finish();
  });
  const url=new URL('https://accounts.google.com/o/oauth2/auth');
  url.searchParams.set('redirect_uri',redirect);
  url.searchParams.set('state','fixture-state');
  const line=url.href+'\n'; process.stderr.write(line.slice(0,37)); setTimeout(()=>process.stderr.write(line.slice(37)),5);
} else if (args.includes('--version')) process.stdout.write('v0.48.0');
`, { mode: 0o700 });
  const runner = createRunner(), changes = [];
  let setup;
  setup = createSetup({ execute: (args, opts) => runner.run(bin, args, opts), changed: () => changes.push(setup.snapshot()), ...options });
  t.after(async () => { await setup.close(); await runner.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(bin + '.calls', 'utf8').trim().split('\n').map(JSON.parse);
  const upload = fields => setup.action({ action: 'credentials-save', client: 'default', json: connectionFile, ...fields });
  const callback = (code = 'accepted') => {
    const state = setup.snapshot().authorization, link = new URL(state.url), url = new URL(link.searchParams.get('redirect_uri'));
    url.searchParams.set('state', link.searchParams.get('state')); url.searchParams.set('code', code); return url;
  };
  return { dir, bin, setup, runner, changes, calls, upload, callback };
}
async function ended(setup) {
  const deadline = Date.now() + 4000;
  while (['starting', 'waiting'].includes(setup.snapshot().authorization?.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const state = setup.snapshot().authorization;
  assert(!['starting', 'waiting'].includes(state?.status), 'sign-in should settle');
  return state;
}

test('setup reads services and client names; uploads Desktop credentials through stdin without exposing secrets', async t => {
  const f = fixture(t);
  assert.deepEqual((await f.setup.read()).clients, []);
  await f.upload();
  const state = f.setup.snapshot();
  assert.deepEqual(state.clients, [{ name: 'default' }]);
  assert.deepEqual(state.services.map(item => item.id), ['gmail', 'drive', 'ads']);
  assert.deepEqual(state.services[0].apis, ['gmail.googleapis.com']);
  assert.equal(state.services.find(item => item.id === 'ads').supportsReadonly, false);
  assert(!JSON.stringify(state).includes('PRIVATE_CLIENT_SECRET')); assert(!JSON.stringify(state).includes('MUST_NOT_LEAK'));
  const call = f.calls().find(args => args.includes('set'));
  assert.equal(call.at(-1), '-'); assert(!call.includes('--insecure')); assert(!JSON.stringify(f.calls()).includes('PRIVATE_CLIENT_SECRET'));
  await assert.rejects(f.upload(), /Confirm replacement/);
  await f.upload({ replace: true });
});

test('invalid files, names and reserved all cannot mutate credentials', async t => {
  const f = fixture(t);
  for (const json of ['{', '{}', JSON.stringify({ web: JSON.parse(connectionFile).installed }), 'x'.repeat(65537)]) await assert.rejects(f.upload({ json }), /file/);
  for (const client of ['all', 'ALL', '../work', '--force']) await assert.rejects(f.upload({ client }), /connection name/);
  assert(!fs.existsSync(f.bin + '.calls'), 'validation happens before starting gog');
});

test('Gmail Desktop consent excludes admin-only sharing and preserves narrower choices', async t => {
  const f = fixture(t); await f.upload();
  for (const gmailScope of [undefined, 'full', 'readonly', 'send', 'read-send']) {
    await f.setup.action({ ...startRequest, readonly: false, gmailScope });
    const add = f.calls().filter(args => args.includes('add')).at(-1);
    const full = gmailScope === undefined || gmailScope === 'full';
    assert(add.includes(`--gmail-scope=${full ? 'send' : gmailScope}`));
    const extra = add.find(arg => arg.startsWith('--extra-scopes='));
    assert.equal(extra, full ? '--extra-scopes=https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/gmail.settings.basic' : undefined);
    assert(!add.some(arg => arg.includes('gmail.settings.sharing')));
    await f.setup.action({ action: 'auth-cancel', id: f.setup.snapshot().authorization.id });
  }
  await f.setup.action({ ...startRequest, gmailScope: 'full' });
  const read = f.calls().filter(args => args.includes('add')).at(-1);
  assert(read.includes('--readonly'));
  assert(!read.some(arg => arg.startsWith('--extra-scopes=')));
});

test('built-in connections expose only the five reviewed services and omit Gmail settings', async t => {
  const f = fixture(t, { currentClient: () => 'clideck' });
  await f.upload({ client: 'clideck' });
  assert.deepEqual(f.setup.snapshot().services.map(item => item.id), ['gmail', 'drive']);
  const request = { ...startRequest, client: 'clideck', readonly: false };
  await assert.rejects(f.setup.action({ ...request, services: ['ads'] }), /custom Google connection/);
  await f.setup.action(request);
  assert.equal(f.calls().find(args => args.includes('add')).find(arg => arg.startsWith('--extra-scopes=')),
    '--extra-scopes=https://www.googleapis.com/auth/gmail.modify');
});

test('sign-in splits stderr safely, keeps explicit permissions, and only succeeds after gog stores the account', async t => {
  const f = fixture(t); await f.upload();
  await f.setup.action(startRequest);
  const pending = f.setup.snapshot().authorization;
  assert.equal(pending.status, 'waiting'); assert.match(pending.url, /^https:\/\/accounts\.google\.com\//);
  const add = f.calls().find(args => args.includes('add'));
  assert(add.includes('--readonly')); assert(add.includes('--force-consent')); assert(add.includes('--manual'));
  assert(add.some(arg => /^--redirect-uri=http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/.test(arg)));
  assert.equal(add[add.indexOf('--services') + 1], 'gmail');
  const result = await fetch(f.callback('PRIVATE_OAUTH_CODE'));
  const html = await result.text();
  assert.equal(result.status, 200); assert.equal(new URL(result.url).pathname, '/done'); assert.equal(new URL(result.url).search, '');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer'); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html, /CliDeck/); assert.match(html, /https:\/\/github.com\/openclaw\/gogcli/); assert.match(html, /https:\/\/github.com\/rustykuntz\/clideck/);
  assert(!html.includes('PRIVATE_OAUTH_CODE')); assert(!html.includes('fixture-state')); assert(!JSON.stringify(f.calls()).includes('PRIVATE_OAUTH_CODE'));
  const state = await ended(f.setup);
  assert.equal(state.status, 'connected'); assert.equal(state.url, '');
  assert(f.changes.some(change => change.authorization.status === 'connected'));
});

test('callback rejects mismatches and duplicate fields without consuming the valid sign-in', async t => {
  const f = fixture(t); await f.upload(); await f.setup.action(startRequest);
  const valid = f.callback(), invalid = [new URL(valid), new URL(valid), new URL(valid), new URL(valid)];
  invalid[0].searchParams.set('state', 'wrong'); invalid[1].searchParams.append('state', 'fixture-state');
  invalid[2].searchParams.append('code', 'another-code'); invalid[3].searchParams.set('error', 'access_denied');
  for (const url of invalid) {
    const result = await fetch(url); assert.equal(result.status, 400); await result.text();
    assert.equal(f.setup.snapshot().authorization.status, 'waiting');
  }
  const wrongHost = await new Promise((resolve, reject) => {
    require('node:http').get(valid, { headers: { Host: 'untrusted.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(wrongHost, 400);
  const wrongMethod = await fetch(valid, { method: 'POST' });
  assert.equal(wrongMethod.status, 400); await wrongMethod.text();
  const result = await fetch(valid); await result.text();
  assert.equal((await ended(f.setup)).status, 'connected');
  const duplicate = await fetch(valid); assert.equal(duplicate.status, 400); await duplicate.text();
  assert.equal(f.calls().filter(args => args.includes('add')).length, 1);
});

test('completion waits for saved credentials, keeps failures visible and cleans up its listener', async t => {
  const f = fixture(t); await f.upload();
  await f.setup.action({ ...startRequest, email: 'slow-one@example.com' });
  const callback = f.callback(), done = new URL('/done', callback);
  let replied = false;
  const pending = fetch(callback, { redirect: 'manual' }).then(result => { replied = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(replied, false, 'the page cannot claim success before gog finishes saving');
  assert.equal(f.setup.snapshot().authorization.status, 'waiting');
  const redirect = await pending; assert.equal(redirect.status, 303); assert.equal(redirect.headers.get('location'), '/done'); await redirect.text();
  assert.equal(f.setup.snapshot().authorization.status, 'connected');
  await f.setup.action({ ...startRequest, email: 'unconfirmed-one@example.com' });
  await assert.rejects(fetch(done), 'starting again closes the previous callback listener');
  const failed = await fetch(f.callback()); const html = await failed.text();
  assert.equal(f.setup.snapshot().authorization.status, 'failed');
  assert(!html.includes('Google account connected')); assert.match(html, /did not confirm/);
  await f.setup.action(startRequest);
  const declined = f.callback(); declined.searchParams.delete('code'); declined.searchParams.set('error', 'access_denied');
  const denial = await fetch(declined); assert.match(await denial.text(), /not approved/);
  assert.equal(f.setup.snapshot().authorization.status, 'failed');
  const lastPage = new URL('/done', declined);
  await f.setup.close(); await assert.rejects(fetch(lastPage));
});

test('remote browser completion reaches only the active local callback and never puts the code on argv', async t => {
  const f = fixture(t); await f.upload(); await f.setup.action(startRequest);
  const id = f.setup.snapshot().authorization.id, original = f.callback('PRIVATE_OAUTH_CODE');
  const invalid = [new URL(original), new URL(original), new URL(original), new URL(original), new URL(original)];
  invalid[0].hostname = 'example.com'; invalid[1].port = String(Number(original.port) + 1);
  invalid[2].pathname = '/other'; invalid[3].searchParams.set('state', 'another-state'); invalid[4].username = 'user';
  for (const url of invalid) await assert.rejects(f.setup.action({ action: 'auth-complete', id, url: url.href }), /does not match/);
  await assert.rejects(f.setup.action({ action: 'auth-complete', id: 'old', url: original.href }), /ended/);
  await f.setup.action({ action: 'auth-complete', id, url: original.href });
  assert.equal((await ended(f.setup)).status, 'connected');
  assert(!JSON.stringify(f.calls()).includes('PRIVATE_OAUTH_CODE'));
  await assert.rejects(f.setup.action({ action: 'auth-complete', id, url: original.href }), /ended/);
});

test('cancel closes only the sign-in child; errors and uncertain completion never look connected', async t => {
  const f = fixture(t); await f.upload(); await f.setup.action(startRequest);
  const id = f.setup.snapshot().authorization.id, url = f.callback();
  await assert.rejects(f.upload({ replace: true }), /Finish or cancel/);
  await assert.rejects(f.setup.action(startRequest), /Finish or cancel/);
  await f.setup.action({ action: 'auth-cancel', id });
  assert.equal((await ended(f.setup)).status, 'cancelled');
  await assert.rejects(fetch(url));
  assert.equal((await f.runner.run(f.bin, ['--version'])).exitCode, 0, 'other runner work is still usable');
  await f.setup.action({ ...startRequest, email: 'before-failure@example.com' });
  assert.equal((await ended(f.setup)).status, 'failed'); assert.match(f.setup.snapshot().authorization.message, /locked/);
  await f.setup.action(startRequest);
  await (await fetch(f.callback('bad'))).text();
  assert.equal((await ended(f.setup)).status, 'failed');
  assert.match(f.setup.snapshot().authorization.message, /invalid_grant/); assert(!JSON.stringify(f.setup.snapshot()).includes('SECRET_CODE'));
  await f.setup.action({ ...startRequest, email: 'unconfirmed-store@example.com' });
  await (await fetch(f.callback())).text();
  assert.equal((await ended(f.setup)).status, 'failed');
});

test('disconnect and client removal are scoped to the chosen account; occupied clients are protected', async t => {
  const f = fixture(t); await f.upload(); await f.upload({ client: 'work' });
  fs.writeFileSync(f.bin + '.accounts', JSON.stringify([
    { email: 'one@example.com', client: 'default', auth: 'oauth' },
    { email: 'one@example.com', client: 'work', auth: 'oauth' },
  ]));
  await assert.rejects(f.setup.action({ action: 'credentials-remove', client: 'default' }), /Disconnect the accounts/);
  await f.setup.action({ action: 'account-remove', email: 'one@example.com', client: 'default' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.bin + '.accounts')), [{ email: 'one@example.com', client: 'work', auth: 'oauth' }]);
  await f.setup.action({ action: 'credentials-remove', client: 'default' });
  assert.deepEqual(f.setup.snapshot().clients, [{ name: 'work' }]);
  await assert.rejects(f.setup.action({ action: 'credentials-remove', client: 'ALL' }), /reserved/);
});

test('sign-in rejects unspecified permissions, unsupported services and conflicting scopes', async t => {
  const f = fixture(t); await f.upload();
  for (const fields of [{ readonly: undefined }, { services: ['admin'] }, { services: ['ads'] }, { services: [] }, { email: '--help' }, { client: 'missing' }, { gmailScope: 'send' }, { driveScope: 'file' }]) {
    await assert.rejects(f.setup.action({ ...startRequest, ...fields }));
  }
  assert(!f.calls().some(args => args.includes('add')));
});

test('removal is not reported as successful when the helper leaves credentials or accounts behind', async t => {
  const f = fixture(t); await f.upload(); fs.writeFileSync(f.bin + '.ignore-remove', '');
  await assert.rejects(f.setup.action({ action: 'credentials-remove', client: 'default' }), /still saved/);
  fs.writeFileSync(f.bin + '.accounts', JSON.stringify([{ email: 'one@example.com', client: 'default', auth: 'oauth' }]));
  await assert.rejects(f.setup.action({ action: 'account-remove', client: 'default', email: 'one@example.com' }), /still saved/);
});

test('shutdown cancels outstanding sign-in and refuses another setup', async t => {
  const f = fixture(t); await f.upload(); await f.setup.action(startRequest);
  const url = f.callback(); await f.setup.close();
  await assert.rejects(fetch(url)); await assert.rejects(f.setup.action(startRequest), /stopping/);
});

test('errors do not echo token fields or the Google authorization URL', () => {
  const error = errorMessage('Opening browser for authorization…\nhttps://accounts.google.com/o/oauth2/auth?state=x\nexchange failed code=SECRET refresh_token=TOKEN\n{"client_secret":"CLIENT"}');
  assert.match(error, /exchange failed/);
  for (const value of ['SECRET', 'TOKEN', 'CLIENT', 'accounts.google.com']) assert(!error.includes(value));
  assert.equal(errorMessage("Visit this URL to authorize:\nhttps://accounts.google.com/o/oauth2/auth?state=x\nAfter authorizing, you'll be redirected to a loopback URL that won't load.\nCopy the URL from your browser's address bar and paste it here.\nPaste redirect URL (Enter or Ctrl-D): state mismatch"), 'state mismatch');
});

test('agent setup uses the same flow, enforces access and reports a later sign-in failure to its caller', async t => {
  const f = fixture(t); await f.upload();
  const commands = new Map(), messages = new Map(), failures = [], shutdowns = [];
  const api = { dataDir: f.dir, getSetting: key => key === 'executable' ? f.bin : '',
    getProjects: async () => [{ id: 'p', name: 'Project' }], getSessions: async () => [{ sessionId: 'caller', projectId: 'p', cwd: f.dir }],
    getSession: async () => ({ sessionId: 'caller', projectId: 'p', cwd: f.dir }),
    registerCommand: (name, fn) => commands.set(name, fn), onClientMessage: (name, fn) => messages.set(name, fn),
    sendToClients() {}, onSettingsChange() {}, onShutdown: fn => shutdowns.push(fn),
    reportError: async (...args) => failures.push(args),
  };
  fs.writeFileSync(join(f.dir, 'access.json'), JSON.stringify({ version: 2, accounts: [{ email: 'one@example.com', client: 'default', mode: 'all', projects: [] }], defaults: [] }));
  activate(api); t.after(async () => { for (const fn of shutdowns) await fn(); });
  const command = (args, fields) => commands.get('setup')({ args, stdin: JSON.stringify(fields), sessionId: 'caller' });
  const started = await command(['auth-start'], startRequest);
  assert.equal(started.exitCode, 0, started.stderr);
  const auth = JSON.parse(started.stdout).setup.authorization;
  assert.equal(auth.status, 'waiting');
  const url = new URL(new URL(auth.url).searchParams.get('redirect_uri'));
  url.searchParams.set('state', 'fixture-state'); url.searchParams.set('code', 'bad');
  await (await fetch(url)).text();
  const deadline = Date.now() + 4000;
  while (!failures.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failures.length, 1); assert.equal(failures[0][0], 'caller'); assert.match(failures[0][2], /invalid_grant/);
  let reply;
  await messages.get('request')({ requestId: 'restrict', action: 'access-save', access: { version: 2, accounts: [], defaults: [] } }, { reply: (_, state) => { reply = state; } });
  assert.equal(reply.ok, true);
  const before = f.calls().length, denied = await command(['credentials-remove'], { client: 'default' });
  assert.equal(denied.exitCode, 1); assert.match(denied.stderr, /not enabled/); assert.equal(f.calls().length, before);
});

test('a status read started before a setup change cannot publish stale accounts afterward', async t => {
  const f = fixture(t);
  let release, begun, reads = 0, saved = false;
  const started = new Promise(resolve => { begun = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const runner = { close: async () => {}, run: async (_, args) => {
    const reply = value => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
    if (args.includes('--version')) return { stdout: 'v0.48.0', stderr: '', exitCode: 0 };
    if (args.includes('credentials')) {
      if (args.includes('set')) { saved = true; return reply({ saved: true }); }
      return reply({ clients: saved ? [{ client: 'default' }] : [] });
    }
    if (args.includes('services')) return reply({ services: [{ service: 'gmail' }] });
    const accounts = saved ? [{ email: 'new@example.com', client: 'default', services: ['gmail'] }] : [];
    if (++reads === 1) { begun(); await gate; }
    return reply({ accounts });
  } };
  const service = createService({ dataDir: f.dir, getSetting: key => key === 'client' ? 'default' : '', sendToClients() {} }, { runner, locate: async () => f.bin });
  t.after(() => service.close());
  const early = service.status(); await started;
  await service.setup({ action: 'credentials-save', json: connectionFile });
  const later = service.status(); release();
  const [before, after] = await Promise.all([early, later]);
  assert.equal(before.accounts[0]?.email, 'new@example.com');
  assert.equal(after.accounts[0]?.email, 'new@example.com');
  assert.equal(service.current().accounts[0]?.email, 'new@example.com');
  assert.equal(reads, 2, 'the overlapping requests share one fresh read after the mutation');
});

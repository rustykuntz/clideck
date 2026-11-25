// Real engine, installer, plugin worker and browser; the gog download is a fixture.
// All state and the browser profile live in a temporary directory.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { HeadlessServer } = require('../../src/server');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(read, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await sleep(50); }
  throw Error('Condition timed out.');
}

(async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-google-browser-'));
  const dataDir = join(root, 'data'), bundled = join(root, 'bundled'), catalog = join(root, 'catalog'), gog = join(root, 'gog');
  fs.mkdirSync(dataDir); fs.mkdirSync(bundled);
  fs.writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  // Fake gog: keeps sign-in files and accounts in a state file, and runs `auth add --manual --redirect-uri=<plugin
  // callback>` like gog v0.48: prints the Google URL (that redirect_uri + a state) on stderr, then reads the full
  // callback URL from stdin and stores the account only for the same origin/path/state with a code. Empty stdin
  // (cancel) or any mismatch fails. No network, no real Google.
  const gogState = join(root, 'gog-state.json'), gogLog = join(root, 'gog-args.log');
  fs.writeFileSync(gog, '#!' + process.execPath + '\n' + `const STATE=${JSON.stringify(gogState)}, LOG=${JSON.stringify(gogLog)};\n` + String.raw`
const fs = require('node:fs'), http = require('node:http');
const args = process.argv.slice(2), out = value => process.stdout.write(JSON.stringify(value) + '\n');
fs.appendFileSync(LOG, JSON.stringify(args) + '\n');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { clients: [], accounts: [
  { email: 'good@example.com', client: 'default', auth: 'oauth', services: ['gmail', 'calendar'] },
  { email: 'expired@example.com', client: 'default', auth: 'oauth', services: ['drive'] },
  { email: 'slow@example.com', client: 'default', auth: 'oauth', services: ['gmail'] }] }; } };
const save = state => fs.writeFileSync(STATE, JSON.stringify(state));
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const eq = name => (args.find(a => a.startsWith(name + '=')) || '').slice(name.length + 1);
const client = flag('--client') || 'default', sub = args.slice(args.indexOf('auth') + 1), state = load();
if (args.includes('--version')) console.log('v0.48.0 browser fixture');
else if (args.includes('--help')) console.log('gog browser fixture help');
else if (sub[0] === 'services') out({ services: [{ service: 'gmail', apis: ['gmail.googleapis.com'] }, { service: 'calendar', apis: ['calendar-json.googleapis.com'] }, { service: 'drive', apis: ['drive.googleapis.com'] }] });
else if (sub[0] === 'credentials' && sub[1] === 'list') out({ clients: state.clients.map(name => ({ client: name })) });
else if (sub[0] === 'credentials' && sub[1] === 'set') {
  const file = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!file.installed?.client_secret) { process.stderr.write('not a desktop client'); process.exit(1); }
  state.clients = [...new Set([...state.clients, client])]; save(state); out({ saved: true });
} else if (sub[0] === 'credentials' && sub[1] === 'remove') { state.clients = state.clients.filter(name => name !== sub[2]); save(state); out({ removed: true }); }
else if (sub[0] === 'remove') { state.accounts = state.accounts.filter(a => !(a.email === sub[1] && a.client === client)); save(state); out({ removed: true }); }
else if (sub[0] === 'add') {
  const email = sub[1], services = String(flag('--services') || '').split(',').filter(Boolean), readonly = args.includes('--readonly'), gmail = eq('--gmail-scope');
  const redirect = eq('--redirect-uri');
  if (!args.includes('--manual') || !redirect) { process.stderr.write('fixture: manual callback required'); process.exit(2); }
  const token = 'st-' + process.pid, scope = id => 'https://www.googleapis.com/auth/' + (id === 'gmail' ? (readonly ? 'gmail.readonly' : gmail === 'send' ? 'gmail.send' : 'gmail.modify') : readonly ? id + '.readonly' : id);
  const fail = message => { process.stderr.write(message); process.exit(1); };
  let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    if (!input.trim()) return fail('authorization cancelled: no redirect URL');
    let url, expected; try { url = new URL(input.trim()); expected = new URL(redirect); } catch { return fail('invalid redirect URL'); }
    if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get('state') !== token || !url.searchParams.get('code')) return fail('state mismatch');
    const next = load(); next.accounts = next.accounts.filter(a => !(a.email === email && a.client === client))
      .concat({ email, client, auth: 'oauth', services, scopes: ['openid', 'email', ...services.map(scope)] });
    save(next); out({ stored: true, email, client });
  });
  process.stderr.write('Opening browser for authorization...\nIf the browser does not open, visit:\nhttps://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + token + '&response_type=code\n');
  process.on('SIGTERM', () => process.exit(1));
} else if (sub[0] === 'list') out({ accounts: state.accounts.map(a => ({ ...a, ...(args.includes('--check') ? (a.email === 'expired@example.com' ? { valid: false, error: 'invalid_grant' } : a.email === 'slow@example.com' ? { valid: false, error: 'context deadline exceeded (Client.Timeout exceeded while awaiting headers)' } : { valid: true }) : {}) })) });
else if (args.includes('gmail')) out({ account: flag('--account'), client: flag('--client') });
else { process.stderr.write('fixture: unsupported ' + args.join(' ')); process.exit(2); }
`, { mode: 0o700 });
  const source = resolve(__dirname, '../../plugin-packages/google');
  fs.cpSync(source, join(catalog, 'google'), { recursive: true });
  const archive = join(root, 'gog.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', root, 'gog']);
  const bytes = fs.readFileSync(archive), build = { version: '0.48.0', key: 'browser', file: 'fixture.tar.gz', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  // Inject only discovery and download into the real installer, leaving extraction,
  // integrity checks, progress messages and first-use command handling unchanged.
  fs.writeFileSync(join(catalog, 'google/install.js'), `
const {createInstaller} = require(${JSON.stringify(join(source, 'install.js'))});
const {findGog} = require('./runner');
exports.createInstaller = options => createInstaller({...options, build:${JSON.stringify(build)},
  locate: path => { if(path) return findGog(path); throw Object.assign(Error('fixture missing'),{code:'GOG_NOT_FOUND'}); },
  fetchImpl: async () => { await new Promise(done=>setTimeout(done,1000)); return new Response(require('node:fs').readFileSync(${JSON.stringify(archive)})); }
});
`);
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0, bundledPluginsDir: bundled, pluginCatalogDir: catalog });
  const session = new AgentSession({ id: 'google-fixture', provider: getProvider('codex'), name: 'Google test', cwd: root });
  session.terminal = { write() {}, resize() {}, kill: () => session.handleExit(0, null) };
  session.status = 'idle'; session.close = () => session.handleExit(0, null);
  const peer = new AgentSession({ id: 'google-peer', provider: getProvider('codex'), name: 'Other agent', cwd: root });
  peer.terminal = { write() {}, kill: () => peer.handleExit(0, null) }; peer.status = 'idle'; peer.close = () => peer.handleExit(0, null);
  // Like a fresh install, the browser starts with no live session; the two agents join after the no-session part.
  const addSessions = () => { for (const s of [session, peer]) { server.persistence.register(s); server.sessions.set(s.id, s); } };
  let chrome, socket;
  try {
    const { httpUrl } = await server.listen();
    assert.equal(server.pluginManager.records.get('google').worker, null);
    assert.equal(server.pluginManager.snapshot().find(p => p.id === 'google').status, 'disabled');
    const command = async (id, name = 'help', args = []) => {
      const response = await fetch(httpUrl + '/api/plugins/command/google/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id, args, stdin: '' }) });
      assert.equal(response.status, 200); return response.json();
    };
    const profile = join(root, 'chrome');
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort'); await until(() => fs.existsSync(portFile));
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise(done => socket.once('open', done));
    let seq = 0; const pending = new Map();
    socket.on('message', raw => { const value = JSON.parse(raw); pending.get(value.id)?.(value); });
    const cmd = (method, params = {}) => new Promise((resolveCommand, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 12000);
      pending.set(id, value => { clearTimeout(timer); pending.delete(id); value.error ? reject(Error(JSON.stringify(value.error))) : resolveCommand(value.result); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression, contextId) => {
      const value = await cmd('Runtime.evaluate', { expression, ...(contextId && { contextId }), returnByValue: true, awaitPromise: true });
      if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result?.value;
    };
    const frame = async () => {
      const tree = await cmd('Page.getFrameTree');
      const child = tree.frameTree.childFrames?.find(frame => frame.frame.url.includes('/plugins/google/public/'));
      if (!child) return null;
      return (await cmd('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'proof' })).executionContextId;
    };
    const fjs = async expression => evaluate(expression, await frame());
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Page.navigate', { url: httpUrl });
    await until(() => evaluate(`Boolean(document.getElementById('app-menu'))`));
    // No session is selected on purpose: setup must work from Settings without one.
    assert.equal(await evaluate(`(async()=>{const {store}=await import('/js/store.js');return store.active()?1:0})()`), 0);
    await evaluate(`(async()=>{(await import('/js/ui/settings.js')).openSettingsAt('plugins')})()`);
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="Enable Google Workspace"]'))`));
    assert.equal(await evaluate(`document.querySelector('[aria-label="Enable Google Workspace"]').getAttribute('aria-checked')`), 'false');
    console.log('PASS shipped Google plugin appears in Settings disabled without an install command');
    await evaluate(`document.querySelector('[aria-label="Enable Google Workspace"]').click()`);
    await until(() => server.pluginManager.records.get('google').status === 'ready');
    assert.equal(fs.existsSync(join(dataDir, 'plugin-data/google/runtime')), false);
    console.log('PASS the Settings switch enables the shipped plugin; gog setup waits for first use');
    // ── Configure with NO session: the page fills the main pane instead of demanding a session.
    await evaluate(`document.querySelector('[aria-label="Open Google Workspace settings"]').click()`);
    await until(() => evaluate(`[...document.querySelectorAll('.set-modal button')].some(b=>b.textContent.trim()==='Configure'&&!b.disabled)`));
    await evaluate(`[...document.querySelectorAll('.set-modal button')].find(b=>b.textContent.trim()==='Configure').click()`);
    await until(frame);
    assert(await evaluate(`(()=>{const ws=document.getElementById('app-ws');return !!ws&&!ws.hidden&&document.getElementById('rp-empty').classList.contains('hidden')&&document.getElementById('rp').classList.contains('hidden')&&!!ws.querySelector('iframe.plugin-workspace')&&ws.querySelector('.cd-tab-name').textContent==='Google Workspace'})()`));
    assert(await evaluate(`!document.querySelector('.toast')||![...document.querySelectorAll('.toast')].some(t=>/session first/i.test(t.textContent))`));
    console.log('PASS Configure with no session opens Google Workspace in the main pane (no "open a session" toast)');
    await until(() => fjs(`!!document.querySelector('.gw-install') && document.body.textContent.includes('Preparing Google connection')`));
    assert(await fjs(`!/Downloading gog|gog v|github/i.test(document.querySelector('.gw-install').textContent)`));
    console.log('PASS first use shows honest "Preparing Google connection" progress, no gog/download mechanics');
    // Status verifies the saved sign-ins (backend contract): the expired one leads with its next step.
    await until(() => fjs(`!!document.querySelector('[data-account="expired@example.com"] .gw-fail')`), 20000);
    const failing = JSON.parse(await fjs(`(()=>{const row=document.querySelector('[data-account="expired@example.com"]'),main=row.querySelector('.gw-acct-main');
      const kids=[...main.children],fail=row.querySelector('.gw-fail'),svc=row.querySelector('.gw-services'),det=row.querySelector('details.gw-tech');
      return JSON.stringify({chip:row.querySelector('.plg-status')?.textContent,fail:fail.textContent,failFirst:kids.indexOf(fail)<kids.indexOf(svc),
        reconnect:fail.querySelector('[data-control="reconnect-expired@example.com"]')?.className,detailsClosed:!!det&&!det.open,errorHidden:!!det&&det.textContent.includes('invalid_grant')&&!fail.textContent.includes('invalid_grant'),
        good:document.querySelector('[data-account="good@example.com"] .plg-status')?.textContent,head:document.querySelector('.gw-head .plg-status')?.textContent,
        words:/Not checked|Stored|Verified|Check failed/.test(document.body.textContent)});})()`));
    assert.equal(failing.chip, 'Needs reconnecting'); assert(failing.failFirst && failing.reconnect === 'plg-primary' && failing.detailsClosed && failing.errorHidden, JSON.stringify(failing));
    assert.equal(failing.good, 'Connected'); assert.equal(failing.head, 'Needs attention'); assert.equal(failing.words, false);
    console.log('PASS failing account: "Needs reconnecting", plain reason + Reconnect above its services, exact error collapsed; good account Connected');
    const slow = JSON.parse(await fjs(`(()=>{const row=document.querySelector('[data-account="slow@example.com"]');return JSON.stringify({chip:row.querySelector('.plg-status')?.textContent,
      text:row.querySelector('.gw-fail')?.textContent||'',again:!!row.querySelector('[data-control="recheck-slow@example.com"]'),lead:row.querySelector('.gw-fail [data-control^="reconnect-"]')?1:0,
      hidden:!row.querySelector('.gw-fail').textContent.includes('deadline')&&row.textContent.includes('deadline')});})()`));
    assert.equal(slow.chip, 'Couldn’t check'); assert(slow.again && !slow.lead && slow.hidden && /couldn’t check this connection/.test(slow.text), JSON.stringify(slow));
    console.log('PASS a timed-out check says "Couldn’t check" + Check again (no Reconnect lead); invalid_grant alone says Needs reconnecting');
    assert.equal(await evaluate(`(async()=>{const d=await import('/js/ui/content-dock.js');return d.openWorkspaceTab('google',{id:'account',title:'Google Workspace',src:'/plugins/google/public/index.html'},{sessionId:'deleted-session'})})()`), false);
    assert.equal(await evaluate(`document.querySelectorAll('#app-ws').length`), 1);
    console.log('PASS an explicit but unknown session is refused, not moved to the app workspace');
    for (const theme of ['dark', 'light']) {
      await evaluate(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`); await sleep(250);
      const shot = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(join(tmpdir(), `clideck-google-nosession-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await evaluate(`document.querySelector('#app-ws .cd-tab-x').click()`);
    await until(() => evaluate(`!document.getElementById('app-ws') && !document.getElementById('rp-empty').classList.contains('hidden')`));
    console.log('PASS closing it brings back the empty state');
    await evaluate(`(async()=>{(await import('/js/ui/settings.js')).closeSettings()})()`);
    addSessions();
    await cmd('Page.navigate', { url: httpUrl });
    await until(() => evaluate(`Boolean(document.getElementById('app-menu')) && !!document.querySelector('.row[data-id=${JSON.stringify(session.id)}]')`));
    await evaluate(`(async()=>{const {store}=await import('/js/store.js');store.select(${JSON.stringify(session.id)})})()`);
    await until(() => evaluate(`(async()=> (await (await import('/js/ui/plugin-host.js')).appPluginMenuItems()).some(item=>item.label==='Google Workspace'))()`));
    await evaluate(`document.getElementById('app-menu').click()`);
    await until(() => evaluate(`[...document.querySelectorAll('.menu-item')].some(e=>e.textContent.includes('Google Workspace'))`));
    await evaluate(`[...document.querySelectorAll('.menu-item')].find(e=>e.textContent.includes('Google Workspace')).click()`);
    await until(frame);
    await until(() => fjs(`document.body.textContent.includes('expired@example.com')`));
    assert(await fjs(`document.body.textContent.includes('Installed by CliDeck') && !document.querySelector('[data-control=fold-advanced]').open`));
    console.log('PASS with a session, the app menu opens the same page beside it; gog details stay under Advanced');
    await fjs(`document.querySelector('[data-control=check]').click()`);
    await until(() => fjs(`document.querySelector('[data-control=check]')?.textContent==='Check again' && document.body.textContent.includes('invalid_grant')`));
    assert(await fjs(`document.querySelector('[data-account="good@example.com"] .plg-status').textContent==='Connected' && document.querySelector('.gw-head .plg-status').textContent==='Needs attention'`));
    console.log('PASS Check again: browser -> worker -> gog check keeps valid and expired accounts separate');
    await server.pluginManager.updateSettings('google', { executable: join(root, 'missing-gog') });
    await until(() => fjs(`document.querySelector('.gw-head .plg-status')?.textContent==='Not available'`));
    assert(await fjs(`!document.querySelector('[data-control=check]') && !document.querySelector('[data-account]')`));
    console.log('PASS settings change reports a missing executable as Not available, no false Connected');
    await server.pluginManager.updateSettings('google', { executable: '' });
    await until(() => fjs(`!!document.querySelector('[data-account="good@example.com"]')`));
    assert(await fjs(`document.body.textContent.includes('Installed by CliDeck')`));
    console.log('PASS clearing the bad override reuses the managed installation');

    // ── Setup inside CliDeck: sign-in file → Google sign-in (callback) → reconnect (pasted address) → disconnect.
    await evaluate(`window.__opened=[];window.open=(url)=>{window.__opened.push(String(url));return null;}`);
    const fstate = () => JSON.parse(fs.readFileSync(gogState, 'utf8'));
    const typeInto = (control, value) => fjs(`(()=>{const el=document.querySelector('[data-control="${control}"]');el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input'));})()`);
    const click = control => fjs(`document.querySelector('[data-control="${control}"]').click()`);
    await click('connect-open');
    await until(() => fjs(`document.body.textContent.includes('One-time setup: a Google sign-in file')`));
    assert(await fjs(`['gmail','calendar','drive'].every(id=>document.querySelector('[data-control="service-'+id+'"]').checked) && document.querySelector('[data-control="level-write"]').getAttribute('aria-pressed')==='true'`));
    assert(await fjs(`document.querySelector('[data-control="guide-apis"]').title.endsWith('apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com') && !document.body.innerHTML.includes('gogcli')`));
    console.log('PASS no sign-in file yet: inline Google Cloud guide; Gmail, Calendar, Drive + Read and change preselected; no gog docs');
    const credentials = join(root, 'client.json'), secret = 'GOCSPX-browser-fixture-secret';
    fs.writeFileSync(credentials, JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: secret, redirect_uris: ['http://localhost'] } }));
    const world = await frame();
    const input = await cmd('Runtime.evaluate', { expression: `document.querySelector('[data-control="credentials-file"]')`, contextId: world });
    await cmd('DOM.setFileInputFiles', { files: [credentials], objectId: input.result.objectId });
    await until(() => fjs(`document.body.textContent.includes('Google sign-in file saved')`));
    assert.deepEqual(fstate().clients, ['default']);
    assert(await fjs(`!document.body.textContent.includes('One-time setup') && !document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`));
    console.log('PASS the real file input hands the Desktop JSON to gog; the guide steps away; the secret never shows');
    await typeInto('auth-email', 'new@example.com');
    assert(await fjs(`document.body.textContent.includes('Agents can read and make changes in Gmail, Calendar and Drive, including sending and deleting.')`));
    await click('level-read');   // Read only stays available; this account will be read-only
    assert(await fjs(`document.body.textContent.includes('Agents can read Gmail, Calendar and Drive. They can’t send, change or delete anything.')`));
    await click('auth-start');
    await until(() => fjs(`!!document.querySelector('[data-control="auth-open"]') && document.body.textContent.includes('Approve access for new@example.com')`));
    assert.deepEqual(await evaluate(`window.__opened`), []);
    const added = fs.readFileSync(gogLog, 'utf8').trim().split('\n').map(JSON.parse).filter(a => a.includes('add')).at(-1);
    assert(added.includes('--readonly') && added.includes('gmail,calendar,drive') && !added.some(a => a.startsWith('--gmail-scope')));
    assert(added.includes('--manual') && added.some(a => /^--redirect-uri=http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/.test(a)));
    console.log('PASS Sign in (Read only chosen) starts gog auth add read-only for Gmail, Calendar, Drive; Google is not opened until asked');
    await click('auth-open');
    await until(() => evaluate(`window.__opened.length===1`));
    const google = new URL(await evaluate(`window.__opened[0]`)), callback = new URL(google.searchParams.get('redirect_uri'));
    assert.equal(google.origin, 'https://accounts.google.com');
    callback.searchParams.set('state', google.searchParams.get('state')); callback.searchParams.set('code', 'fixture-code');
    // What the browser does after the person approves: the plugin's callback hands the address to gog on stdin,
    // waits for stored:true, then 303s to a clean /done (no code in the address bar) with CliDeck's page.
    const back1 = await fetch(callback, { redirect: 'manual' });
    assert.equal(back1.status, 303); assert.equal(back1.headers.get('location'), '/done');
    const doneUrl = new URL('/done', callback).href, done = await fetch(doneUrl);
    assert.equal(done.status, 200); assert.match(done.headers.get('content-type'), /^text\/html/);
    assert.equal(done.headers.get('cache-control'), 'no-store'); assert.equal(done.headers.get('referrer-policy'), 'no-referrer');
    assert.match(done.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await done.text();
    assert(html.includes('Google account connected') && html.includes('new@example.com') && html.includes('close this tab') && !html.includes('fixture-code') && !/<script/i.test(html));
    assert(html.includes('href="https://github.com/openclaw/gogcli"') && html.includes('href="https://github.com/rustykuntz/clideck"'));
    assert(!fs.readFileSync(gogLog, 'utf8').includes('fixture-code'));
    // The same page in a real browser tab: rendered, branded, no outside requests, both themes.
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const tws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(done => tws.once('open', done));
    let tseq = 0; const tpending = new Map(), tabRequests = [];
    tws.on('message', raw => { const v = JSON.parse(raw); if (v.method === 'Network.requestWillBeSent') tabRequests.push(v.params.request.url); tpending.get(v.id)?.(v); });
    const tcmd = (method, params = {}) => new Promise(done => { const id = ++tseq; tpending.set(id, v => { tpending.delete(id); done(v.result); }); tws.send(JSON.stringify({ id, method, params })); });
    await tcmd('Network.enable'); await tcmd('Page.enable');
    for (const theme of ['dark', 'light']) {
      await tcmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      tabRequests.length = 0; await tcmd('Page.navigate', { url: doneUrl }); await sleep(500);
      const seen = (await tcmd('Runtime.evaluate', { expression: `JSON.stringify({h1:document.querySelector('h1')?.textContent,title:document.title,links:document.querySelectorAll('a[rel="noopener noreferrer"]').length})`, returnByValue: true })).result.value;
      const got = JSON.parse(seen);
      assert.equal(got.h1, 'Google account connected'); assert.equal(got.links, 2); assert.deepEqual(tabRequests, [doneUrl]);
      const shot = await tcmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(join(tmpdir(), `clideck-google-done-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    tws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`);
    console.log('PASS the callback 303s to a clean /done with CliDeck’s branded page (no-store, no-referrer, CSP; one request; both themes)');
    await until(() => fjs(`document.body.textContent.includes('Connected new@example.com')`));
    await until(() => fjs(`(()=>{const r=document.querySelector('[data-account="new@example.com"]');return !!r&&r.textContent.includes('Read only')})()`));
    console.log('PASS Open Google sign-in → callback → gog stores it → Connected, listed as Read only');
    await click('auth-dismiss'); await click('reconnect-new@example.com');
    await until(() => fjs(`document.body.textContent.includes('Reconnect new@example.com') && document.body.textContent.includes('Kept from this account’s current access')`));
    assert(await fjs(`document.querySelector('[data-control="level-read"]').getAttribute('aria-pressed')==='true' && document.querySelector('[data-control="auth-email"]').readOnly && document.body.textContent.includes('Agents can read Gmail, Calendar and Drive.')`));
    await click('level-write');
    await fjs(`document.querySelector('[data-control="fold-scopes"] > summary').click()`); await sleep(100);   // a person opens it first
    await fjs(`(()=>{const s=document.querySelector('[data-control="gmail-scope"]');s.value='send';s.dispatchEvent(new Event('change'));})()`);
    assert(await fjs(`document.querySelector('[data-control="fold-scopes"]').open && document.body.textContent.includes('Gmail (send only)')`));
    console.log('PASS Reconnect keeps email/services and the actual read-only grant; changing it and fine-tuning survive repaints');
    await click('auth-start');
    await until(() => fjs(`(()=>{const o=document.querySelector('[data-control="auth-open"]');return !!o&&!o.disabled})()`));
    const again = fs.readFileSync(gogLog, 'utf8').trim().split('\n').map(JSON.parse).filter(a => a.includes('add')).at(-1);
    assert(!again.includes('--readonly') && again.includes('--gmail-scope=send'));
    await fjs(`document.querySelector('[data-control="fold-paste"] > summary').click()`); await sleep(100);
    await typeInto('auth-url', 'http://127.0.0.1:1/oauth2/callback?state=wrong&code=x');
    await until(() => fjs(`(()=>{const b=document.querySelector('[data-control="auth-complete"]');return !!b&&!b.disabled})()`));   // a person clicks an enabled button
    await click('auth-complete');
    await until(() => fjs(`document.body.textContent.includes('does not match this sign-in')`));
    assert(await fjs(`!!document.querySelector('[data-control="auth-open"]')`));
    console.log('PASS a pasted address from another sign-in is refused; still waiting');
    await sleep(1100);   // the host opens at most one outside page per second; a person is slower than this script
    await click('auth-open'); await until(() => evaluate(`window.__opened.length===2`));
    const google2 = new URL(await evaluate(`window.__opened[1]`)), back = new URL(google2.searchParams.get('redirect_uri'));
    back.searchParams.set('state', google2.searchParams.get('state')); back.searchParams.set('code', 'fixture-code-2');
    await typeInto('auth-url', back.href);
    await until(() => fjs(`(()=>{const b=document.querySelector('[data-control="auth-complete"]');return !!b&&!b.disabled})()`));
    await click('auth-complete');
    await until(() => fjs(`document.body.textContent.includes('Connected new@example.com')`));
    await until(() => fjs(`document.querySelector('[data-account="new@example.com"]')?.textContent.includes('Can make changes')`));
    console.log('PASS pasting the final address completes the sign-in through the server; access shows Can make changes');
    await click('disconnect-new@example.com');
    assert(await fjs(`document.body.textContent.includes('removes its saved sign-in from this computer')`));
    await click('disconnect-yes');
    await until(() => fjs(`document.body.textContent.includes('Disconnected new@example.com') && !document.querySelector('[data-account="new@example.com"]')`));
    assert(!fstate().accounts.some(a => a.email === 'new@example.com'));
    console.log('PASS Disconnect asks first, then gog removes the saved sign-in');
    await click('connect-open'); await typeInto('auth-email', 'later@example.com'); await click('auth-start');
    await until(() => fjs(`(()=>{const c=document.querySelector('[data-control="auth-cancel"]');return !!c&&!c.disabled&&!!document.querySelector('[data-control="auth-open"]')})()`));
    await click('auth-cancel');
    await until(() => fjs(`document.body.textContent.includes('Sign-in stopped')`));
    assert(!fstate().accounts.some(a => a.email === 'later@example.com'));
    console.log('PASS Cancel sign-in stops gog; nothing is saved');
    for (const theme of ['dark', 'light']) {
      await evaluate(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`); await sleep(200);
      const shot = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(join(tmpdir(), `clideck-google-setup-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    const change = (control, value) => fjs(`(()=>{const el=document.querySelector('[data-control="${control}"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change'));})()`);
    const save = async () => {
      await fjs(`document.querySelector('[data-control=access-save]').click()`);
      await until(() => fjs(`document.body.textContent.includes('Access saved.') && !document.querySelector('[data-control=access-save]')`));
    };
    // Per-account access (v2). The earlier single policy (all projects) was moved onto the accounts that existed
    // then; accounts connected afterwards start with no agent access.
    const G = 'good@example.com|default', E = 'expired@example.com|default', S = 'slow@example.com|default';
    const value = c => fjs(`document.querySelector('[data-control="${c}"]')?.value`);
    assert.deepEqual([await value('access-mode-' + G), await value('access-mode-' + E), await value('access-mode-' + S)], ['all', 'all', 'all']);
    console.log('PASS the earlier all-projects access moved once onto each account that existed then');
    for (const k of [G, E, S]) await change('access-mode-' + k, 'selected');
    await save();
    assert.equal((await command(session.id)).exitCode, 1); assert.equal((await command(peer.id)).exitCode, 1);
    console.log('PASS no account allowed anywhere blocks commands for both agents');
    await change('access-add-' + G, 'none'); await save();
    assert.equal((await command(session.id)).exitCode, 0); assert.equal((await command(peer.id)).exitCode, 0);
    console.log('PASS All agents grants the chosen project to both current agents');
    await change('agents-' + G + '-none', 'selected');
    await fjs(`document.querySelector('[data-control="agent-${G}-google-fixture"]').click()`); await save();
    assert.equal((await command(session.id)).exitCode, 0); assert.equal((await command(peer.id)).exitCode, 1);
    console.log('PASS selected agent may run commands while its project peer is refused');
    assert(!(await fjs(`!!document.querySelector('[data-control="default-none"]')`)));
    await change('access-add-' + E, 'none'); await save();
    await until(() => fjs(`!!document.querySelector('[data-control="default-none"]')`));
    const ran = async id => { const r = await command(id, 'run', ['gmail', 'search', 'x']); return r.exitCode ? r : JSON.parse(r.stdout.trim().split('\n').pop()); };
    assert.match((await ran(session.id)).stderr, /Multiple Google accounts are allowed/);
    assert.equal((await ran(peer.id)).account, 'expired@example.com');
    const peerStatus = JSON.parse((await command(peer.id, 'status')).stdout);
    assert.deepEqual(peerStatus.accounts.map(a => a.email), ['expired@example.com']);
    console.log('PASS two allowed accounts need a choice; an agent with one allowed account uses it and sees only it');
    await change('default-none', G); await save();
    assert.equal((await ran(session.id)).account, 'good@example.com');
    const ownStatus = JSON.parse((await command(session.id, 'status')).stdout);
    assert.deepEqual(ownStatus.accounts.map(a => a.email).sort(), ['expired@example.com', 'good@example.com']);
    assert.equal(ownStatus.defaults.account, 'good@example.com');
    console.log('PASS the project default account picked in the page is the one agents run with');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false }); await sleep(300);
    for (const theme of ['dark', 'light']) {
      await evaluate(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`); await sleep(200);
      await fjs(`document.querySelector('.gw-access').scrollIntoView()`);
      const shot = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(join(tmpdir(), `clideck-google-access-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
    await cmd('Emulation.clearDeviceMetricsOverride'); await sleep(200);
    await server.pluginManager.setEnabled('google', false);
    await until(() => evaluate(`!document.querySelector('iframe.plugin-workspace')`));
    await evaluate(`document.getElementById('app-menu').click()`);
    assert(await evaluate(`![...document.querySelectorAll('.menu-item')].some(e=>e.textContent.includes('Google Workspace'))`));
    console.log('PASS disabling closes its workspace and removes its menu item');
    await server.pluginManager.setEnabled('google', true);
    assert.equal((await ran(session.id)).account, 'good@example.com'); assert.equal((await ran(peer.id)).account, 'expired@example.com');
    console.log('PASS saved agent access is enforced after a plugin worker restart');
  } finally {
    socket?.close();
    if (chrome) { chrome.kill(); await new Promise(done => chrome.exitCode !== null ? done() : chrome.once('exit', done)); }
    await server.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

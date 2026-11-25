// Stale-UI notice browser proof. Isolated engine with the HeadlessServer uiVersion seam (no real files touched),
// one AgentSession with a fake terminal (no native start, no PTY). Checks are triggered by dropping the page's
// WebSocket (forced reconnect check). No live sessions or engine restarts.
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-ui-version-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ui-version-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  let disk = { version: 'build-a', restartRequired: false }, endpointCalls = 0, failing = false;
  const uiVersion = async ({ fresh = false } = {}) => { if (!fresh) endpointCalls++; if (failing) throw new Error('unavailable'); return { ...disk }; };
  const server = new HeadlessServer({ port: 0, dataDir, uiVersion });
  const agent = new AgentSession({ provider: getProvider('claude-code'), name: 'Keeps running', cwd: dataDir });
  let killed = 0, writes = 0;
  agent.terminal = { pid: 4301, write: () => { writes++; }, resize: () => {}, kill: () => { killed++; agent.handleExit(0, null); } };
  agent.status = 'working'; server.sessions.set(agent.id, agent); server.persistence.register(agent);
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const profile = mkdtempSync(join(tmpdir(), 'ui-version-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => cws.on('open', r));
    let seq = 0; const pending = new Map(), errors = [];
    cws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); cws.send(JSON.stringify({ id, method, params })); });
    const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    const snap = async name => { const s = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(s.data, 'base64')); };
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    const load = async () => { await cmd('Page.navigate', { url: base }); await sleep(2200); await js(`(async()=>{window.store=(await import('/js/store.js')).store;window.marker='same-page'})()`); };
    const meta = () => js(`document.querySelector('meta[name="clideck-ui-version"]')?.content||''`);
    const notice = () => js(`(()=>{const t=document.getElementById('toast-ui-refresh');return t&&t.classList.contains('in')?t.textContent:''})()`);
    // Forced check: drop the page's socket; the client reconnects and asks again.
    const recheck = async () => {
      const before = endpointCalls;
      for (const client of server.clients) client.terminate();
      for (let i = 0; i < 100 && endpointCalls === before; i++) await sleep(100);
      await sleep(400);
    };

    await load();
    check('page carries the build it loaded', await meta() === 'build-a');
    check('same build: no notice', await notice() === '' && endpointCalls >= 1, endpointCalls);
    await js(`store.select(${JSON.stringify(agent.id)})`); await sleep(200);
    await js(`document.querySelector('#term textarea')?.focus()`);
    const focusBefore = await js(`document.activeElement?.className||document.activeElement?.tagName`);

    disk = { version: 'build-b', restartRequired: false }; await recheck();
    const text = await notice();
    check('new build on disk: sticky notice with exact copy', text.includes('Updated CliDeck is ready') && text.includes('Refresh to load it. Your sessions keep running.'), text);
    check('notice offers Refresh and Dismiss', await js(`[...document.querySelectorAll('#toast-ui-refresh .toast-act')].map(b=>b.textContent).join('|')`) === 'Refresh|Dismiss');
    check('notice does not steal focus', await js(`document.activeElement?.className||document.activeElement?.tagName`) === focusBefore, focusBefore);
    await sleep(3500);
    check('notice is sticky (still there after several seconds) and never reloads on its own', await notice() !== '' && await js('window.marker') === 'same-page');
    for (const theme of ['dark', 'light']) { await js(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`); await sleep(150); await snap(`ui-refresh-${theme}.png`); }
    await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 760, deviceScaleFactor: 1, mobile: false }); await sleep(200);
    await snap('ui-refresh-narrow.png');
    check('narrow: notice fits the viewport', await js(`(()=>{const r=document.getElementById('toast-ui-refresh').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await js(`import('/js/theme.js').then(m=>m.setThemePref('dark'))`);

    const sessionsBefore = server.sessions.size;
    server.persistence.appendHistory(agent.id, 'history survives refresh\r\n'); writes = 0;
    await js(`document.querySelector('#toast-ui-refresh .toast-primary').click()`); await sleep(2500);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store})()`);
    check('Refresh reloads the browser tab and loads the new build', await js('window.marker') === undefined && await meta() === 'build-b');
    check('after Refresh: no notice for the build now loaded', await notice() === '');
    check('engine and sessions untouched by Refresh', server.sessions.get(agent.id) === agent && !agent.closed && killed === 0 && server.sessions.size === sessionsBefore);
    check('the session is still live in the refreshed page', await js(`store.sessions.get(${JSON.stringify(agent.id)})?.live===true`));
    check('same PID and terminal history after Refresh', await js(`(()=>{const s=store.sessions.get(${JSON.stringify(agent.id)});return s.pid===4301&&s.outputBuf.includes('history survives refresh')})()`));
    check('Refresh sent no input and no restart/close to the session', writes === 0 && killed === 0 && !agent.closeRequested);
    await js(`window.marker='same-page'`);

    disk = { version: 'build-c', restartRequired: true }; await recheck();
    check('restart required (new package under old engine): no Refresh offered', await notice() === '');
    failing = true; await recheck();
    check('endpoint failure is never read as an update', await notice() === '');
    failing = false;

    disk = { version: 'build-d', restartRequired: false }; await recheck();
    check('newer build: notice again', await notice() !== '');
    await js(`[...document.querySelectorAll('#toast-ui-refresh .toast-act')].find(b=>b.textContent==='Dismiss').click()`); await sleep(400);
    await recheck();
    check('Dismiss: the same build stays quiet', await notice() === '');
    disk = { version: 'build-e', restartRequired: false }; await recheck();
    check('a different build notifies again', await notice() !== '');
    disk = { version: 'build-b', restartRequired: false }; await recheck(); await sleep(400);
    check('disk back to the loaded build: notice removed', await notice() === '' && await js('window.marker') === 'same-page');

    disk = { version: 'not a valid build!', restartRequired: false }; await load();
    const calls = endpointCalls; for (const client of server.clients) client.terminate(); await sleep(4000);
    check('older engine (no meta tag): the page never polls', await meta() === '' && endpointCalls === calls, endpointCalls - calls);
    check('no uncaught browser exceptions', errors.length === 0, errors);
  } finally {
    if (!agent.closed) agent.handleExit(0, null);
    cws?.close(); if (chrome) { chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); } await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`); process.exitCode = fails ? 1 : 0;
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

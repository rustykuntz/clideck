// Telegram plugin UI browser proof: the REAL plugin client.js + public/ page from plugin-packages/telegram,
// loaded as a plugin by an isolated HeadlessServer, with a stand-in server.js that keeps the contract in memory
// (no Telegram, no network, no token stored). One Claude AgentSession with a fake terminal. Captures dark +
// light screenshots of the workspace, the header menu and the generic plugin-card Configure button.
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-telegram-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

const MANIFEST = { id: 'telegram', name: 'Telegram', version: '0.0.0-gate', apiVersion: 1, enabledByDefault: true, description: 'Talk to your sessions from your phone.', icon: 'send' };
const FAKE_SERVER = `
let state = { telegram: { connected: false, bot: null, topicsEnabled: false, paired: null, pairing: null, status: 'off', error: '' }, sessions: [], presence: { mode: 'auto', away: false, supported: true, idleSeconds: 600 } };
exports.activate = (api) => {
  api.onClientMessage('request', (data, context) => {
    const t = state.telegram, reply = (extra) => context.reply('result', { requestId: data.requestId, ...extra });
    const fail = (message) => reply({ ok: false, error: 'refused', message });
    if (data.action === 'connect') {
      if (data.token && !/^\\d+:/.test(data.token)) return fail('Telegram rejected this token. Copy it again from @BotFather.');
      Object.assign(t, { connected: true, bot: { id: 1, username: 'or_deck_bot', name: 'Or’s CliDeck' }, topicsEnabled: true, status: 'ready' });
    } else if (data.action === 'pair') t.pairing = { url: 'https://t.me/or_deck_bot?start=Zk3p9', expiresAt: Date.now() + 10 * 60000 };
    else if (data.action === 'gate-pair') { t.pairing = null; t.paired = { id: 7, name: 'Or', username: 'or_k' }; }
    else if (data.action === 'phone') { const e = state.sessions.find(s => s.sessionId === data.sessionId); if (e) e.enabled = data.enabled; else state.sessions.push({ sessionId: data.sessionId, name: 'Strategy', enabled: data.enabled, topicId: 9, error: '', supported: true }); }
    else if (data.action === 'presence') Object.assign(state.presence, { mode: data.mode, away: data.mode === 'away' });
    else if (data.action === 'disconnect') state.telegram = { connected: false, bot: null, topicsEnabled: false, paired: null, pairing: null, status: 'off', error: '' };
    else if (data.action !== 'status') return fail('Unknown action.');
    reply({ ok: true, ...state });
    if (data.action !== 'status') api.sendToClients('updated', state);
  });
};`;

async function openBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'telegram-chrome-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => cws.on('open', r));
  let seq = 0; const pending = new Map(), errors = [];
  const cmd = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); cws.send(JSON.stringify({ id, method, params })); });
  cws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  const point = async (expr) => js(`(()=>{const e=${expr};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const clickAt = async (p) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(350); };
  const click = async (selector) => { const p = await point(`[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1)`); if (!p) throw new Error('missing ' + selector); await clickAt(p); };
  const menuPick = async (label) => { const p = await point(`[...document.querySelectorAll('.menu-item')].find(e=>e.textContent===${JSON.stringify(label)})`); if (!p) throw new Error('no menu item ' + label); await clickAt(p); };
  // Inside the workspace iframe (cross-origin sandbox): evaluate via the frame's own document from the host is
  // impossible, so clicks go by screen coordinates computed from the frame offset + an element rect we ask for
  // through CDP's isolated world on that frame.
  const frameCtx = async () => {
    const tree = await cmd('Page.getFrameTree');
    const child = (tree.frameTree.childFrames || []).map(f => f.frame).find(f => /\/plugins\/telegram\/public\//.test(f.url));
    if (!child) return null;
    const world = await cmd('Page.createIsolatedWorld', { frameId: child.id, worldName: 'gate' });
    return world.executionContextId;
  };
  const fjs = async (expression) => { const ctx = await frameCtx(); const r = await cmd('Runtime.evaluate', { expression, contextId: ctx, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  const fclick = async (selector) => {
    const offset = await js(`(()=>{const f=document.querySelector('iframe.plugin-workspace');const r=f.getBoundingClientRect();return {x:r.left,y:r.top}})()`);
    const p = await fjs(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].at(-1);if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!p) throw new Error('missing in frame ' + selector);
    await clickAt({ x: offset.x + p.x, y: offset.y + p.y });
  };
  const shot = async name => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Runtime.enable'); await cmd('Page.enable');
  const close = async () => { cws.close(); chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); };
  return { cmd, js, fjs, click, fclick, menuPick, shot, errors, close };
}

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'telegram-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const bundled = mkdtempSync(join(tmpdir(), 'telegram-plugins-'));
  const pluginDir = join(bundled, 'telegram'); mkdirSync(pluginDir);
  cpSync(join(__dirname, '../../plugin-packages/telegram/client.js'), join(pluginDir, 'client.js'));
  cpSync(join(__dirname, '../../plugin-packages/telegram/public'), join(pluginDir, 'public'), { recursive: true });
  writeFileSync(join(pluginDir, 'clideck-plugin.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(pluginDir, 'server.js'), FAKE_SERVER);
  const server = new HeadlessServer({ port: 0, dataDir, bundledPluginsDir: bundled });
  const agent = new AgentSession({ provider: getProvider('claude-code'), name: 'Strategy', cwd: dataDir });
  agent.terminal = { pid: 4701, write: () => {}, resize: () => {}, kill: () => agent.handleExit(0, null) };
  agent.status = 'idle'; server.sessions.set(agent.id, agent); server.persistence.register(agent);
  let b;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    b = await openBrowser();
    for (const theme of ['dark', 'light']) {
      await b.cmd('Page.navigate', { url: base }); await sleep(1200);
      await b.js(`localStorage.setItem('clideck.theme',${JSON.stringify(theme)})`);
      await b.cmd('Page.reload'); await sleep(2500);
      await b.js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(agent.id)})})()`); await sleep(500);
      if (theme === 'dark') check('dark: before setup the session header has no plugin actions', await b.js(`document.getElementById('plugin-actions').hidden`));
      check(`${theme}: footer = app menu + bell + gear only; no app tools in the session header`, await b.js(`document.querySelectorAll('.side-foot button').length===3&&!!document.querySelector('.side-foot #app-menu')&&!document.querySelector('.th-actions #task-manager,.th-actions #monitors')`));
      await b.click('#app-menu'); await sleep(400);
      const items = await b.js(`[...document.querySelectorAll('.menu-item')].map(e=>e.textContent)`);
      check(`${theme}: app menu = labelled tools, plugin tools, Manage plugins`, JSON.stringify(items) === JSON.stringify(['Prompt library', 'Task Manager', 'Monitors', 'Telegram', 'Manage plugins…']), items);
      if (theme === 'dark') await b.shot('dark-0-footer-plugins');
      await b.menuPick('Telegram'); await sleep(1200);
      check(`${theme}: Telegram opens as a workspace tab`, await b.js(`[...document.querySelectorAll('.cd-tab-name')].some(e=>e.textContent==='Telegram')`));
      if (theme === 'dark') {
        await b.shot(`${theme}-1-setup`);
        await b.fjs(`(()=>{const i=document.querySelector('[data-control=token]');i.value='bad';i.dispatchEvent(new Event('input'))})()`);
        await b.fclick('[data-control=connect]'); await sleep(500);
        check('dark: rejected token shows the reason', /Telegram rejected this token/.test(await b.fjs(`document.body.textContent`)));
        await b.fjs(`(()=>{const i=document.querySelector('[data-control=token]');i.value='123:AAE';i.dispatchEvent(new Event('input'))})()`);
        await b.fclick('[data-control=connect]'); await sleep(500);
        await b.fclick('[data-control=pair]'); await sleep(500);
        check('dark: pairing link shown in the page', /start=Zk3p9/.test(await b.fjs(`document.querySelector('.ca-pair-url')?.value||''`)));
        await b.shot('dark-2-pairing');
        await b.fjs(`parent.postMessage({type:'clideck.send',event:'request',data:{requestId:'gate',action:'gate-pair'}},'*')`); await sleep(600);
      }
      check(`${theme}: paired view with presence`, /Paired with Or/.test(await b.fjs(`document.body.textContent`)) && /after 10 min/.test(await b.fjs(`document.body.textContent`)));
      await b.shot(`${theme}-3-paired`);
      await b.click('#plugin-actions'); await sleep(300);
      await b.shot(`${theme}-4-menu`);
      const ready = await b.js(`[...document.querySelectorAll('.menu-item')].map(e=>e.textContent)`);
      if (theme === 'dark') {
        check('dark: paired → session header menu has only session things', ready.some(t => t === 'Send this session to my phone') && ready.some(t => /I’m away/.test(t)) && !ready.includes('Telegram'), ready);
        await b.menuPick('Send this session to my phone'); await sleep(600);
        check('dark: switching on is confirmed with a toast', /Phone on/.test(await b.js(`document.querySelector('.toaster')?.textContent||''`)));
        check('dark: the page shows the session On', await b.fjs(`document.querySelector('[aria-label="Phone for Strategy"]')?.getAttribute('aria-checked')`) === 'true');
        await b.click('#plugin-actions'); await sleep(300);
        check('dark: menu re-resolved on open → now offers Stop', (await b.js(`[...document.querySelectorAll('.menu-item')].map(e=>e.textContent)`)).includes('Stop sending to my phone'));
        await b.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(200);
      }
      await b.js(`(async()=>{(await import('/js/ui/settings.js')).openSettingsAt('plugins')})()`); await sleep(500);
      await b.click('[aria-label="Open Telegram settings"]'); await sleep(500);
      check(`${theme}: plugin card shows the generic Configure button`, await b.js(`document.querySelector('.plg-card-actions')?.textContent`) === 'Configure');
      await b.shot(`${theme}-5-plugin-card`);
      await b.click('.plg-card-actions button'); await sleep(600);
      check(`${theme}: Configure closes Settings and shows the Telegram tab`, !(await b.js(`!!document.querySelector('.set-overlay.show')`)) && await b.js(`[...document.querySelectorAll('.cd-tab.on .cd-tab-name, .cd-tab[aria-selected=true] .cd-tab-name')].some(e=>e.textContent==='Telegram')`));
    }
    await b.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    for (const w of [240, 340, 560]) {
      await b.js(`document.documentElement.style.setProperty('--sidebar-w','${w}px')`); await sleep(300);
      const fit = await b.js(`(()=>{const f=document.querySelector('.side-foot');const r=f.getBoundingClientRect();return [...f.querySelectorAll('button')].every(x=>{const q=x.getBoundingClientRect();return q.right<=r.right+0.5&&q.left>=r.left-0.5&&q.width>0})})()`);
      check(`footer at sidebar ${w}px: every button visible inside the bar`, fit);
      if (w === 340) { await b.click('#app-menu'); await sleep(400); const m = await b.js(`(()=>{const r=document.querySelector('.app-menu').getBoundingClientRect();return {x:0,y:r.top-8,width:r.right+16,height:900-r.top+8}})()`); const sh = await b.cmd('Page.captureScreenshot', { format: 'png', clip: { ...m, scale: 2 } }); writeFileSync(join(out, 'app-menu.png'), Buffer.from(sh.data, 'base64')); await b.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await sleep(200); }
      const r = await b.js(`(()=>{const f=document.querySelector('.side-foot').getBoundingClientRect();return {x:0,y:f.top-6,width:${w}+20,height:f.height+12}})()`);
      const shot = await b.cmd('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } }); writeFileSync(join(out, `footer-${w}.png`), Buffer.from(shot.data, 'base64'));
    }
    await b.js(`document.documentElement.style.removeProperty('--sidebar-w')`);
    await b.js(`store.select(null)`); await sleep(400);
    check('app menu present', await b.js(`!!document.querySelector('.side-foot #app-menu')`));
    await b.click('#app-menu'); await sleep(400); await b.menuPick('Task Manager'); await sleep(500);
    check('Task Manager dialog opens with no session', await b.js(`!!document.querySelector('.tasks-dialog')`));
    await b.shot('no-session-task-manager');
    await b.js(`document.querySelector('.tasks-close')?.click()`); await sleep(300);
    await b.cmd('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(500);
    await b.shot('narrow-paired');
    check('no uncaught browser exceptions', b.errors.length === 0, b.errors);
  } finally {
    if (!agent.closed) agent.handleExit(0, null);
    await b?.close(); await server.close();
  }
  console.log(`\n${passes}/${passes + fails} passed · captures ${out}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

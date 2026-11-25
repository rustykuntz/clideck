// Monitors window browser proof: real /api/monitors HTTP + WS through an isolated engine, with the HeadlessServer
// `monitors` seam replaced by an in-memory fake (no commands run, no real monitors, no native agents).
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Monitors opens from the sidebar footer's app menu (real clicks on the menu button, then its item).
const openVia = async ({ click, js }) => { await click('#app-menu'); await sleep(200); await js(`[...document.querySelectorAll('.menu-item')].find(n=>/^Monitors/.test(n.textContent.trim()))?.setAttribute('data-gate','monitors')`); await click('[data-gate="monitors"]'); };
const out = process.env.GATE_OUT || '/tmp/clideck-monitors-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };

const now = Date.now(), min = 60000;
const mk = (over) => ({ name: 'Monitor', sessionId: 's1', sessionName: 'Strategy manager', projectName: 'AI Trading', command: 'wc -l data/options.csv', cwd: '/tmp/demo', mode: 'change',
  everyMs: 5 * min, at: null, once: false, resumeSession: false, paused: false, state: 'watching', message: '', lastCheckAt: now - 2 * min, nextCheckAt: now + 3 * min,
  lastFiredAt: null, wakeCount: 0, lastFinding: '', pendingCount: 0, history: [], createdAt: now, ...over });
let list = [
  mk({ id: 'm1', name: 'New rows in options.csv', wakeCount: 4, lastFiredAt: now - 95 * min, lastFinding: '1842 data/options.csv' }),
  mk({ id: 'm2', name: 'Broker API health', command: 'curl -fsS https://api.broker.test/health', mode: 'until-success', everyMs: 30 * min, state: 'error', message: 'Command exited with code 22: 503 Service Unavailable', lastFinding: 'curl: (22) The requested URL returned error: 503', history: [{ at: now - 9 * min, status: 'error', message: 'exit 22' }, { at: now - 39 * min, status: 'no change', message: '' }] }),
  mk({ id: 'm3', name: 'Render folder has new files', sessionId: 's2', sessionName: 'Video researcher', projectName: 'Studio', mode: 'items', everyMs: 60000, state: 'waiting', message: 'You’re typing in this session — the finding will be delivered after you pause.', pendingCount: 1, wakeCount: 7, lastFiredAt: now - 4 * min, nextCheckAt: null }),
  mk({ id: 'm4', name: 'Deploy status changed', sessionId: 's2', sessionName: 'Video researcher', projectName: 'Studio', state: 'uncertain', message: 'Delivery was interrupted after the text was inserted. Check the session before clearing.', pendingCount: 1, wakeCount: 2, lastFiredAt: now - 12 * min, nextCheckAt: null }),
  mk({ id: 'm5', name: 'Nightly backup finished', sessionId: 's2', sessionName: 'Video researcher', projectName: 'Studio', everyMs: null, at: now + 9 * 3600000, once: true, paused: true, state: 'paused', nextCheckAt: null, lastCheckAt: null }),
];
let storageError = '', gets = 0, refuse = '';
const acts = [];
const fake = {
  snapshot() { gets++; return { monitors: JSON.parse(JSON.stringify(list)), ...(storageError && { error: storageError }) }; },
  async act(body) {
    acts.push(body);
    if (refuse) throw new Error(refuse);
    const m = list.find(x => x.id === body.id); if (!m) throw new Error('Monitor not found.');
    if (body.action === 'pause') Object.assign(m, { paused: true, state: 'paused', nextCheckAt: null });
    else if (body.action === 'resume') Object.assign(m, { paused: false, state: 'watching', nextCheckAt: Date.now() + 5 * min });
    else if (body.action === 'remove') list = list.filter(x => x !== m);
    else if (body.action === 'acknowledge') Object.assign(m, { state: 'watching', message: '', pendingCount: 0 });
    else if (body.action === 'configure') m.resumeSession = body.resumeSession === true;
    else if (body.action === 'check') Object.assign(m, { state: 'checking' });
    return this.snapshot();
  },
  start() {}, close() {},
};

// One isolated headless Chrome tab with small helpers. Each phase owns and closes its own.
async function openBrowser(base) {
  const profile = mkdtempSync(join(tmpdir(), 'monitors-chrome-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => cws.on('open', r));
  let seq = 0; const pending = new Map(), errors = [];
  cws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); cws.send(JSON.stringify({ id, method, params })); });
  const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  const click = async selector => {
    const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    if (!p) throw new Error('missing ' + selector);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(250);
  };
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
  const close = async () => { cws.close(); chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); };
  return { cmd, js, click, errors, close };
}

// Phase 2: the REAL Monitors service, HTTP, WS broadcast and delivery. Only the command runner is injected (no shell
// commands run) and the target is an AgentSession with a fake terminal (no native agent, no PTY).
async function realFlow() {
  const dataDir = mkdtempSync(join(tmpdir(), 'monitors-real-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  let output = 'build: running\n', runs = 0;
  const server = new HeadlessServer({ port: 0, dataDir, monitorOptions: { run: async () => { runs++; return { code: 0, stdout: output, stderr: '' }; } } });
  const agent = new AgentSession({ provider: getProvider('claude-code'), name: 'Builder', cwd: dataDir, promptSubmitDelay: () => 60, submitRetryMs: 100 });
  const writes = [];
  agent.terminal = { pid: 4501, write: d => writes.push(d), resize: () => {}, kill: () => agent.handleExit(0, null) };
  agent.status = 'idle'; server.sessions.set(agent.id, agent); server.persistence.register(agent);
  let b;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const api = body => fetch(base + '/api/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
    const saved = () => JSON.parse(readFileSync(join(dataDir, 'monitors.json'), 'utf8')).monitors;
    b = await openBrowser(base);
    await b.cmd('Page.navigate', { url: base }); await sleep(2200);
    await b.js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(agent.id)})})()`); await sleep(200);
    await openVia(b); await sleep(400);
    check('real: empty engine shows the empty state', /No monitors yet/.test(await b.js(`document.querySelector('.tasks-state').textContent`)));

    const added = await api({ action: 'add', callerSessionId: agent.id, name: 'Build status changed', command: 'cat build.log', everyMs: 30000, mode: 'change', cwd: dataDir });
    const id = added.id; await sleep(800);
    const row = () => b.js(`(()=>{const e=document.querySelector('[data-control="remove-${id}"]');return e?e.closest('.mon-row').textContent:''})()`);
    check('real: monitor created by an agent appears live, grouped under its session', added.status === 200 && /Build status changed/.test(await row()) && /Builder/.test(await b.js(`document.querySelector('.mon-group')?.textContent||''`)), added.error);
    check('real: first check ran, saved a baseline and is scheduled', runs === 1 && /Watching/.test(await row()) && /next (in |due now)/.test(await row()));

    output = 'build: passed\n'; writes.length = 0;
    await b.click(`[data-control="check-${id}"]`); await sleep(1200);
    const sent = writes.join('');
    check('real: Check now finds the change and wakes the session through the real delivery', runs === 2 && sent.includes('[CliDeck monitor "Build status changed"') && sent.includes('build: passed') && writes.includes('\r'), writes.length);
    check('real: row shows the wake', /1 wake\b/.test(await row()));

    await b.click(`[data-control="pause-${id}"]`); await sleep(400);
    check('real: Pause saves to monitors.json', /Paused/.test(await row()) && saved()[0].paused === true && saved()[0].wakeCount === 1);
    await b.cmd('Page.reload'); await sleep(2200);
    await openVia(b); await sleep(400);
    check('real: after a page reload it is still paused with its wake count', /Paused/.test(await row()) && /1 wake/.test(await row()) && !!(await b.js(`!!document.querySelector('[data-control="resume-${id}"]')`)));
    const runsBefore = runs; await sleep(1000);
    check('real: a paused monitor does not run', runs === runsBefore);
    await b.click(`[data-control="resume-${id}"]`); await sleep(600);
    check('real: Resume checks again right away', runs === runsBefore + 1 && !saved()[0].paused);
    for (const client of server.clients) client.terminate();
    await sleep(300);
    check('real: lost connection freezes controls with a reconnecting note', await b.js(`document.querySelector('[data-control="pause-${id}"]').disabled&&!document.querySelector('.mon-offline').hidden`));
    for (let i = 0; i < 40 && await b.js(`document.querySelector('[data-control="pause-${id}"]').disabled`); i++) await sleep(150);
    check('real: reconnect snapshot unfreezes them', await b.js(`!document.querySelector('[data-control="pause-${id}"]').disabled&&document.querySelector('.mon-offline').hidden`));
    await b.click(`[data-control="remove-${id}"]`); await b.click(`[data-control="confirm-${id}"]`); await sleep(400);
    check('real: Delete removes it from disk and from the window', saved().length === 0 && /No monitors yet/.test(await b.js(`document.querySelector('.tasks-state').textContent`)));
    check('real: no uncaught browser exceptions', b.errors.length === 0, b.errors);
  } finally {
    if (!agent.closed) agent.handleExit(0, null);
    await b?.close(); await server.close();
  }
}

async function fakeFlow() {
  const dataDir = mkdtempSync(join(tmpdir(), 'monitors-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const server = new HeadlessServer({ port: 0, dataDir, monitors: fake });
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    const profile = mkdtempSync(join(tmpdir(), 'monitors-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => cws.on('open', r));
    let seq = 0; const pending = new Map(), errors = [];
    cws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')); }, 12000); pending.set(id, m => { clearTimeout(t); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); }); cws.send(JSON.stringify({ id, method, params })); });
    const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    const snap = async name => { const s = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name), Buffer.from(s.data, 'base64')); };
    // Real mouse clicks on the element's centre (scrolled into view first).
    const click = async selector => {
      const p = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
      if (!p) throw new Error('missing ' + selector);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
      await sleep(250);
    };
    const key = async (key, code, vk) => { for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }); await sleep(150); };
    const broadcast = () => server.broadcast({ type: 'monitors.updated', ...fake.snapshot() });
    const row = id => js(`(()=>{const b=document.querySelector('[data-control="remove-${id}"]');return b?b.closest('.mon-row').textContent:''})()`);
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cmd('Page.navigate', { url: base }); await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.applyEvent({type:'session.created',sessionId:'s1',provider:'shell',live:false,cwd:'/tmp',name:'Strategy manager'});store.select('s1')})()`); await sleep(200);

    check('Monitors lives in the footer app menu', await js(`!!document.getElementById('app-menu')&&!document.getElementById('monitors')`));
    broadcast(); await sleep(300);
    check('header dot appears for monitors that need the person', await js(`document.getElementById('app-menu').classList.contains('has-alert')&&document.getElementById('app-menu').title==='Monitors — 2 need attention'`));
    const crop = await cmd('Page.captureScreenshot', { format: 'png', clip: await js(`(()=>{const r=document.getElementById('app-menu').getBoundingClientRect();return {x:r.left-8,y:r.top-8,width:r.width+16,height:r.height+16,scale:2}})()`) }); writeFileSync(join(out, 'header-dot.png'), Buffer.from(crop.data, 'base64'));

    const getsBefore = gets;
    await openVia({ click, js }); await sleep(400);
    check('opening loads once over HTTP and lists every monitor', gets === getsBefore + 1 && await js(`document.querySelectorAll('.mon-row').length`) === 5);
    check('focus moves into the window', await js(`document.activeElement?.classList.contains('tasks-close')`));
    check('grouped by project / session', await js(`[...document.querySelectorAll('.mon-group')].map(g=>g.textContent.replace(/\\d+$/,'')).join('|')`) === 'AI Trading / Strategy manager|Studio / Video researcher');
    await click('[data-control="expand-m2"]');
    for (const theme of ['dark', 'light']) { await js(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`); await sleep(200); await js(`document.querySelector('.tasks-scroll').scrollTop=0`); await snap(`monitors-${theme}.png`); }
    await js(`import('/js/theme.js').then(m=>m.setThemePref('dark'))`);
    check('expanded details show command, folder and finding', /curl -fsS https:\/\/api\.broker\.test\/health/.test(await row('m2')) && /\/tmp\/demo/.test(await row('m2')) && /returned error: 503/.test(await row('m2')));

    await click('[data-control="pause-m1"]'); await sleep(300);
    check('Pause goes through the real API and the row updates', JSON.stringify(acts.at(-1)) === JSON.stringify({ action: 'pause', id: 'm1' }) && /Paused/.test(await row('m1')) && await js(`!!document.querySelector('[data-control="resume-m1"]')`));
    await click('[data-control="resume-m1"]'); await sleep(300);
    check('Resume goes through the real API', acts.at(-1).action === 'resume' && /Watching/.test(await row('m1')));
    await click('[data-control="resume-session-m2"]'); await sleep(300);
    check('resume-stopped-session opt-in saved via configure', JSON.stringify(acts.at(-1)) === JSON.stringify({ action: 'configure', id: 'm2', resumeSession: true }) && await js(`document.querySelector('[data-control="resume-session-m2"]').checked`));

    const beforeDelete = acts.length;
    await click('[data-control="remove-m1"]');
    check('Delete asks inline and focuses Cancel', /Delete this monitor\?/.test(await row('m1')) && acts.length === beforeDelete && await js(`document.activeElement?.dataset.control==='cancel-m1'`));
    await key('Escape', 'Escape', 27);
    check('Escape closes only the confirmation and returns focus to Delete', !/Delete this monitor\?/.test(await row('m1')) && await js(`!!document.querySelector('.mon-dialog')&&document.activeElement?.dataset.control==='remove-m1'`));
    await click('[data-control="remove-m1"]'); await click('[data-control="confirm-m1"]'); await sleep(300);
    check('confirmed Delete removes it', acts.at(-1).action === 'remove' && await js(`document.querySelectorAll('.mon-row').length`) === 4);

    await js(`document.querySelector('.tasks-scroll').scrollTop=9999`);
    await click('[data-control="acknowledge-m4"]'); await sleep(150);
    await snap('monitors-clear-pending.png');
    check('Clear pending warns before acting', /Text may already be in the session\. Clear this pending finding without sending it again\?/.test(await row('m4')) && acts.at(-1).action === 'remove');
    await click('[data-control="confirm-m4"]'); await sleep(300);
    check('confirmed Clear pending sends acknowledge, never a resend', JSON.stringify(acts.at(-1)) === JSON.stringify({ action: 'acknowledge', id: 'm4' }) && /Watching/.test(await row('m4')));

    refuse = 'Monitor is checking right now.';
    await click('[data-control="check-m2"]'); await sleep(300);
    check('a refused action is explained and nothing else changes', await js(`document.querySelector('.tasks-notice.error').textContent`) === 'Monitor is checking right now.' && await js(`document.querySelectorAll('.mon-row').length`) === 4);
    refuse = '';

    list = list.map(m => m.id === 'm3' ? { ...m, state: 'watching', message: '', pendingCount: 0 } : m); broadcast(); await sleep(300);
    check('engine broadcast updates the open window live', /Watching/.test(await row('m3')) && !/typing/.test(await row('m3')));
    storageError = 'EACCES: permission denied, open monitors.json'; broadcast(); await sleep(300);
    check('storage error is shown plainly, nothing reset', /can’t be read or saved: EACCES/.test(await js(`document.querySelector('.tasks-notice.error').textContent`)) && await js(`document.querySelectorAll('.mon-row').length`) === 4);
    storageError = ''; broadcast();

    await click('.tasks-seg-b[data-value="attention"]');
    check('Needs attention filter', await js(`[...document.querySelectorAll('.mon-row')].map(r=>r.querySelector('.mon-name').textContent).join('|')`) === 'Broker API health');
    await click('.tasks-seg-b[data-value="paused"]');
    check('Paused filter', await js(`[...document.querySelectorAll('.mon-row')].map(r=>r.querySelector('.mon-name').textContent).join('|')`) === 'Nightly backup finished');
    await click('.tasks-seg-b[data-value="all"]');

    const idleGets = gets; await sleep(3000);
    check('no polling while open', gets === idleGets);
    await cmd('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false }); await sleep(300);
    await js(`document.querySelector('.tasks-scroll').scrollTop=0`); await snap('monitors-narrow.png');
    check('narrow: window fits, no sideways scroll, buttons visible', await js(`(()=>{const d=document.querySelector('.mon-dialog').getBoundingClientRect(),s=document.querySelector('.tasks-scroll'),b=document.querySelector('[data-control="check-m2"]').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&s.scrollWidth<=s.clientWidth&&b.right<=d.right})()`));
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await key('Escape', 'Escape', 27);
    check('Escape closes the window and focus returns to the app menu button', await js(`!document.querySelector('.mon-dialog')&&document.activeElement?.id==='app-menu'`));
    list = []; broadcast(); await sleep(200);
    await openVia({ click, js }); await sleep(400);
    check('empty state explains how monitors are created', /No monitors yet\. Ask an agent to watch something for you/.test(await js(`document.querySelector('.tasks-state').textContent`)));
    await snap('monitors-empty.png');
    check('no uncaught browser exceptions', errors.length === 0, errors);
  } finally {
    cws?.close(); if (chrome) { chrome.kill(); await new Promise(r => chrome.exitCode !== null ? r() : chrome.once('exit', r)); } await server.close();
  }
}

(async () => {
  try { await fakeFlow(); await realFlow(); }
  finally { console.log(`${passes} passed, ${fails} failed; captures ${out}`); process.exitCode = fails ? 1 : 0; }
})().catch(e => { console.error(e); process.exitCode = 1; });

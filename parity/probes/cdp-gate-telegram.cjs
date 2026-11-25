// Actual optional plugin server/client/page + core SDK + browser. Only Telegram's
// HTTPS transport and the native agent terminal are fixtures. No live user data,
// bot token, model download, or provider launch is used.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { HeadlessServer } = require('../../src/server');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(read, predicate = Boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await sleep(50); }
  throw Error('Condition timed out.');
}

(async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-telegram-browser-'));
  const dataDir = join(root, 'data'), bundled = join(root, 'plugins'), plugin = join(bundled, 'telegram');
  fs.mkdirSync(dataDir); fs.mkdirSync(bundled);
  fs.writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const calls = [], updates = [], waiters = new Set(); let messageId = 0, topicId = 10;
  const flush = () => {
    if (!updates.length) return;
    for (const res of waiters) { res.end(JSON.stringify({ ok: true, result: updates.splice(0) })); waiters.delete(res); break; }
  };
  const telegram = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data), method = req.url.slice(1); calls.push({ method, body });
    res.setHeader('Content-Type', 'application/json');
    if (method === 'getUpdates') { waiters.add(res); res.on('close', () => waiters.delete(res)); flush(); return; }
    const result = method === 'getMe' ? { id: 123456, is_bot: true, username: 'fixture_bot', first_name: 'Fixture', has_topics_enabled: true }
      : method === 'getWebhookInfo' ? { url: '' } : method === 'createForumTopic' ? { message_thread_id: ++topicId }
      : method === 'sendMessage' ? { message_id: ++messageId, ...body } : true;
    res.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise(done => telegram.listen(0, '127.0.0.1', done));
  fs.cpSync(resolve(__dirname, '../../plugin-packages/telegram'), plugin, { recursive: true });
  fs.writeFileSync(join(plugin, 'telegram.js'), `const base = require(${JSON.stringify(resolve(__dirname, '../../plugin-packages/telegram/telegram.js'))});
module.exports = {...base, Telegram: class extends base.Telegram { constructor(token) { super(token, {fetch: (url, options) => fetch(${JSON.stringify('http://127.0.0.1:' + telegram.address().port + '/') } + new URL(url).pathname.split('/').pop(), options)}); } }};`);
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0, bundledPluginsDir: bundled });
  const writes = [], originalStart = AgentSession.prototype.start;
  // Exercise HeadlessServer's real session wiring, skipping only native launch.
  AgentSession.prototype.start = function () {
    this.terminal = { write: value => writes.push(value), resize() {}, kill: () => this.handleExit(0, null) };
    this.status = 'idle'; this.sessionStarted = true; this.close = () => this.handleExit(0, null);
  };
  let session;
  try { session = server.startSession({ provider: getProvider('codex'), name: 'Phone test', cwd: dataDir, promptSubmitDelay: () => 20, submitRetryMs: 10000 }, true); }
  finally { AgentSession.prototype.start = originalStart; }
  let chrome, socket;
  try {
    const { httpUrl } = await server.listen();
    const command = async (name, args = [], stdin = '') => {
      const response = await fetch(httpUrl + '/api/plugins/command/telegram/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, args, stdin, timeoutMs: 20000 }) });
      const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); assert(!value.exitCode, JSON.stringify(value));
      return JSON.parse(value.stdout);
    };
    const status = () => command('setup', ['status']);
    const push = (id, text, thread) => { updates.push({ update_id: id, message: { date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Or', is_bot: false }, text, ...(thread && { message_thread_id: thread }) } }); flush(); };
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
      const child = tree.frameTree.childFrames?.find(frame => frame.frame.url.includes('/plugins/telegram/public/'));
      if (!child) return null;
      return (await cmd('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'proof' })).executionContextId;
    };
    const fjs = async expression => evaluate(expression, await frame());
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Page.navigate', { url: httpUrl }); await sleep(1500);
    await evaluate(`(async()=>{window.proofStore=(await import('/js/store.js')).store;proofStore.select(${JSON.stringify(session.id)})})()`);
    await until(() => evaluate(`!document.getElementById('plugin-actions').hidden`));
    await evaluate(`document.getElementById('plugin-actions').click()`);
    await until(() => evaluate(`[...document.querySelectorAll('.menu-item')].some(e=>e.textContent==='Telegram')`));
    await evaluate(`[...document.querySelectorAll('.menu-item')].find(e=>e.textContent==='Telegram').click()`);
    await until(frame);
    await until(() => fjs(`Boolean(document.querySelector('[data-control=token]'))`));
    const token = '123456:abcdefghijklmnopqrstuvwxyz0123456789';
    await fjs(`(()=>{const e=document.querySelector('[data-control=token]');e.value=${JSON.stringify(token)};e.dispatchEvent(new Event('input'));document.querySelector('[data-control=connect]').click()})()`);
    await until(status, state => state.telegram.connected);
    await until(() => fjs(`Boolean(document.querySelector('[data-control=pair]'))`));
    await fjs(`document.querySelector('[data-control=pair]').click()`);
    const pairing = await until(status, state => Boolean(state.telegram.pairing));
    push(1, '/start ' + new URL(pairing.telegram.pairing.url).searchParams.get('start'));
    await until(status, state => state.telegram.paired?.id === 42);
    await until(() => fjs(`document.body.textContent.includes('Paired with Or')`));
    console.log('PASS real browser setup -> worker -> Telegram transport -> paired account');
    await fjs(`document.querySelector('[data-control=test]').click()`);
    await until(() => calls.some(call => call.method === 'sendMessage' && call.body.text.includes('CliDeck is connected')));
    await command('phone', ['on']); const enabled = await status(), topic = enabled.sessions[0].topicId;
    await until(() => fjs(`document.querySelector('[role=switch]')?.getAttribute('aria-checked')==='true'`));
    // Wait for the new authoritative routing revision's poll before sending.
    push(2, 'routing settle'); await until(() => calls.filter(call => call.method === 'getUpdates').length >= 3);
    push(3, 'What changed?', topic);
    await until(() => writes.includes('\r'));
    const pasted = writes.find(value => value.startsWith('\x1b[200~')).slice(6, -6);
    session.handleHook('start', { turn_id: 'phone-turn', prompt: pasted });
    session.handleHook('stop', { turn_id: 'phone-turn', last_assistant_message: 'The requested change is complete.' });
    await until(() => calls.some(call => call.method === 'sendMessage' && call.body.text === 'The requested change is complete.'));
    assert.equal(writes.filter(value => value === '\r').length, 1);
    console.log('PASS phone request -> actual paste/Enter/native receipt -> its own final reply');
    session.handleHook('start', { turn_id: 'peer-turn', prompt: 'peer-only question' });
    session.handleHook('stop', { turn_id: 'peer-turn', last_assistant_message: 'PEER_ONLY' }); await sleep(150);
    assert(!calls.some(call => call.body.text === 'PEER_ONLY'));
    console.log('PASS peer completions never leak into the phone thread');
    await command('away', ['away']);
    const notify = await fetch(httpUrl + '/api/session/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerSessionId: session.id, text: 'The background export is ready.' }) });
    assert.equal(notify.status, 200);
    await until(() => calls.some(call => call.method === 'sendMessage' && call.body.text === 'The background export is ready.'));
    console.log('PASS explicit notify routes through the enabled plugin when away');
    await command('phone', ['off']); const before = writes.length;
    push(4, 'Do not execute this', topic); await until(() => calls.some(call => call.method === 'sendMessage' && /Phone is off/.test(call.body.text)));
    assert.equal(writes.length, before);
    console.log('PASS Phone off rejects incoming work and keeps its topic');
    await command('phone', ['on']);
    const polls = calls.filter(call => call.method === 'getUpdates').length;
    push(5, 'routing settle'); await until(() => calls.filter(call => call.method === 'getUpdates').length > polls);
    session.promptSubmitDelay = () => 250;
    push(6, 'Interrupted request', topic); await until(() => writes.length > before);
    session.markUserActivity();
    const uncertain = await until(status, state => state.sessions[0].pending?.state === 'uncertain');
    assert(uncertain.sessions[0].pending.id);
    const errors = await (await fetch(httpUrl + '/api/session/errors?callerSessionId=' + session.id)).json();
    const id = errors.notices.find(row => row.id.startsWith('plugin-request:')).id;
    const acknowledged = await fetch(httpUrl + '/api/session/errors', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerSessionId: session.id, action: 'acknowledge', id }) });
    assert.equal(acknowledged.status, 200); await until(status, state => !state.sessions[0].pending);
    assert.equal(writes.filter(value => value === '\r').length, 1);
    console.log('PASS core acknowledgment clears plugin uncertainty too, without resending');
    await server.pluginManager.setEnabled('telegram', false);
    await until(() => evaluate(`!document.querySelector('iframe.plugin-workspace')`));
    const pollCount = calls.filter(call => call.method === 'getUpdates').length;
    await sleep(600); assert.equal(calls.filter(call => call.method === 'getUpdates').length, pollCount);
    console.log('PASS disabling removes the workspace and stops Telegram polling');
  } finally {
    socket?.close();
    if (chrome) { chrome.kill(); await new Promise(done => chrome.exitCode !== null ? done() : chrome.once('exit', done)); }
    await server.close(); telegram.closeAllConnections(); await new Promise(done => telegram.close(done));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

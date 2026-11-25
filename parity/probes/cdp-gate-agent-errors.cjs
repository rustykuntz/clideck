// Real browser/worker/HTTP/WS feedback. Only speech synthesis and the agent's
// terminal are fake; no native agent, model download or audible playback.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { HeadlessServer } = require('../../src/server');
const { AgentSession } = require('../../src/session');
const { getProvider } = require('../../src/providers');
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until(read, predicate, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await sleep(50); }
  throw Error('Condition did not become true.');
}

(async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-error-browser-'));
  const dataDir = join(root, 'state'), bundled = join(root, 'plugins'), plugin = join(bundled, 'supertonic');
  fs.mkdirSync(dataDir); fs.mkdirSync(bundled);
  fs.writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  fs.cpSync(resolve(__dirname, '../../plugins/supertonic'), plugin, { recursive: true });
  fs.appendFileSync(join(plugin, 'client.js'), `
runtimePromise = Promise.resolve({ styles: new Map(), helper: {
  chunkTextRanges: text => [{start:0,end:text.length}], loadVoiceStyle: async () => ({}),
  writeWavFile: () => {
    const n=1600,b=new ArrayBuffer(44+n*2),v=new DataView(b);
    const s=(o,t)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};
    s(0,'RIFF');v.setUint32(4,36+n*2,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);
    v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);
    v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
    s(36,'data');v.setUint32(40,n*2,true);return b;
  }
}, textToSpeech: { sampleRate:8000, call:async text => {
  if(text.includes('FAIL_SYNTHESIS'))throw Error('Fixture synthesis failed');
  return {wav:new Float32Array(1600),duration:[0.2]};
}} });
`);
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0, bundledPluginsDir: bundled });
  const agent = new AgentSession({ provider: getProvider('codex'), name: 'Feedback test', cwd: dataDir,
    promptSubmitDelay: () => 20, submitRetryMs: 10_000 });
  const writes = [];
  agent.terminal = { write: value => writes.push(value), resize() {}, kill: () => agent.handleExit(0, null) };
  agent.close = () => agent.handleExit(0, null); agent.status = 'idle'; agent.sessionStarted = true;
  server.sessions.set(agent.id, agent); server.persistence.register(agent);
  let chrome, socket;
  try {
    const { httpUrl } = await server.listen();
    const profile = join(root, 'chrome');
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank',
    ], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort'); await until(() => fs.existsSync(portFile), Boolean);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolveOpen => socket.once('open', resolveOpen));
    let sequence = 0; const pending = new Map();
    socket.on('message', raw => { const message = JSON.parse(raw); pending.get(message.id)?.(message); });
    const cmd = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); rejectCommand(Error(`${method} timed out`)); }, 12_000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); message.error ? rejectCommand(Error(JSON.stringify(message.error))) : resolveCommand(message.result); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async expression => {
      const result = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value;
    };
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable');
    await cmd('Network.setBlockedURLs', { urls: ['https://huggingface.co/*', 'https://cdn.jsdelivr.net/*'] });
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cmd('Page.navigate', { url: httpUrl }); await sleep(1500);
    await js(`(async()=>{window.testStore=(await import('/js/store.js')).store;testStore.select(${JSON.stringify(agent.id)})})()`);
    await until(() => js(`testStore.plugins.some(p=>p.id==='supertonic'&&p.status==='ready')`), Boolean);
    const show = async (name, kind, payload) => {
      const response = await fetch(httpUrl + '/show', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.id, name, kind, payload }) }); assert.equal(response.status, 200); return response.json();
    };
    const shown = await show('Broken JSON', 'json', '{broken');
    await until(() => writes.filter(value => value === '\r').length, count => count === 1);
    assert(writes[0].includes('[CliDeck error: show preview')); assert(writes[0].includes(shown.contentId));
    console.log('PASS browser preview failure reaches originating session via real submission');
    await cmd('Page.reload'); await sleep(1600);
    assert.equal(writes.filter(value => value === '\r').length, 1);
    console.log('PASS replayed failure does not duplicate the notice');
    await js(`(async()=>{window.testStore=(await import('/js/store.js')).store;testStore.select(${JSON.stringify(agent.id)})})()`);
    const speak = async text => {
      const response = await fetch(httpUrl + '/api/plugins/command/supertonic/speak', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: agent.id, args: [text], stdin: '', timeoutMs: 20_000 }) });
      assert.equal(response.status, 200); return response.json();
    };
    const spoken = await speak('Silent fixture'); assert.equal(spoken.exitCode, 0, JSON.stringify(spoken));
    assert.match(spoken.stdout, /Read aloud/);
    console.log('PASS actual browser playback completion returns to the waiting command');
    const failed = await speak('FAIL_SYNTHESIS'); assert.equal(failed.exitCode, 1); assert.match(failed.stderr, /Fixture synthesis failed/);
    console.log('PASS browser synthesis failure returns diagnostic nonzero command result');
    const fixed = await show('Broken JSON', 'json', '{"fixed":true}');
    assert.notEqual(fixed.contentId, shown.contentId); assert.equal(server.agentErrors.records.size, 0);
    console.log('PASS replacing broken content retires its error episode');
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await new Promise(resolveExit => chrome.once('exit', resolveExit)); }
    await server.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

// Exercise the built app, its staged ordinary-Node runtime and a real PTY.
// Own temporary profile/data only; never reads or stops the user's live engine.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('../../node_modules/ws');
const { alive, readLock } = require('../lib/engine.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = process.argv[2];
if (!executable) throw new Error('Pass the packaged desktop executable path.');

async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(100); } while (Date.now() < deadline);
  throw new Error('Packaged app check timed out.');
}
function connect(ws) {
  let sequence = 0; const pending = new Map();
  ws.on('message', raw => {
    const message = JSON.parse(raw); const handler = pending.get(message.id);
    if (handler) { pending.delete(message.id); handler(message); }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clideck-packaged-'));
  const dataDir = path.join(directory, 'data'), profile = path.join(directory, 'profile');
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  let child, debuggerSocket, control, pid, stderr = '';
  const launch = async () => {
    stderr = '';
    const env = { ...process.env, CLIDECK_DESKTOP_DATA_DIR: dataDir, CLIDECK_DESKTOP_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', data => { stderr = (stderr + data).slice(-50000); });
    const port = await until(() => {
      if (child.exitCode !== null) throw new Error(`Desktop exited: ${stderr}`);
      return /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1];
    });
    const target = await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url));
    }, 60000);
    debuggerSocket = new WebSocket(target.webSocketDebuggerUrl); await once(debuggerSocket, 'open');
    const evaluate = connect(debuggerSocket);
    const state = await evaluate('window.clideckDesktop.getState()');
    assert.equal(state.engine.state, 'ready'); pid = state.engine.pid;
    return { evaluate, state };
  };
  try {
    let { evaluate, state } = await launch();
    if (process.argv.includes('--recovery-only')) {
      const oldUrl = state.engine.url;
      await evaluate("localStorage.setItem('clideck.desktop.sidebarHidden','1'); localStorage.setItem('desktop-recovery-theme','dark'); window.__recoverySentinel='stay-loaded'");
      process.kill(pid, 'SIGTERM');
      await until(() => !alive(pid));
      await until(async () => (await evaluate('window.clideckDesktop.getState()')).engine.state === 'error');
      await evaluate('window.clideckDesktop.retryEngine()');
      state = await evaluate('window.clideckDesktop.getState()'); pid = state.engine.pid;
      assert.equal(state.engine.url, oldUrl);
      assert.equal(await evaluate('window.__recoverySentinel'), 'stay-loaded', 'same-origin recovery must not reload the page');
      assert.equal(await evaluate("localStorage.getItem('clideck.desktop.sidebarHidden')"), '1');
      // A different service taking the old port must not lose UI preferences.
      process.kill(pid, 'SIGTERM'); await until(() => !alive(pid));
      const blocker = require('node:net').createServer();
      await new Promise(resolve => blocker.listen(Number(new URL(oldUrl).port), '127.0.0.1', resolve));
      try {
        await evaluate('window.clideckDesktop.retryEngine(); true');
        state = await until(async () => {
          try {
            const current = await evaluate('window.clideckDesktop.getState()');
            return current.engine.state === 'ready' && current.engine.url !== oldUrl ? current : false;
          } catch { return false; }
        });
        pid = state.engine.pid;
        await until(async () => await evaluate('location.origin') === new URL(state.engine.url).origin);
        assert.equal(await evaluate("localStorage.getItem('clideck.desktop.sidebarHidden')"), '1');
        assert.equal(await evaluate("localStorage.getItem('desktop-recovery-theme')"), 'dark');
      } finally { await new Promise(resolve => blocker.close(resolve)); }
      console.log('PASS packaged recovery: same-port restart preserves the live page/sidebar; occupied-port fallback preserves UI preferences.');
      const exited = once(child, 'exit'); await evaluate('window.clideckDesktop.quit()'); await exited;
      return;
    }
    assert.equal(await evaluate('typeof require'), 'undefined');
    assert.equal(await evaluate('typeof process'), 'undefined');
    assert.equal(await evaluate("window.clideckDesktop.openExternal('file:///tmp/forbidden').then(()=>false,()=>true)"), true);
    await evaluate("localStorage.setItem('desktop-smoke-preference', 'retained'); window.clideckDesktop.setPreferences({externalLinks:'app'})");
    const events = [];
    control = new WebSocket(state.engine.url.replace('http:', 'ws:'));
    control.on('message', raw => events.push(JSON.parse(raw))); await once(control, 'open');
    await until(() => events.find(event => event.type === 'plugins'));
    const plugins = events.find(event => event.type === 'plugins').plugins;
    assert(plugins.some(plugin => plugin.id === 'git-diff' && plugin.status === 'ready'), 'bundled Node plugin worker loads');
    control.send(JSON.stringify({ type: 'session.create', provider: 'shell', cwd: directory, name: 'packaged smoke', cols: 80, rows: 24 }));
    const created = await until(() => events.find(event => event.type === 'session.created'));
    // Quit only the client, then use the same engine and PTY while no app is open.
    const exited = once(child, 'exit');
    await evaluate('window.clideckDesktop.quit()'); await exited;
    debuggerSocket.close();
    assert.equal(alive(pid), true);
    control.send(JSON.stringify({ type: 'input', sessionId: created.sessionId, data: "printf 'PACKAGED_%s\\n' 'SURVIVED'\r" }));
    await until(() => events.some(event => event.type === 'output' && event.data.includes('PACKAGED_SURVIVED')));
    const firstPid = pid;
    ({ evaluate, state } = await launch());
    assert.equal(state.engine.pid, firstPid); assert.equal(state.preferences.externalLinks, 'app');
    assert.equal(await evaluate("localStorage.getItem('desktop-smoke-preference')"), 'retained');
    const runtimes = await fs.readdir(path.join(profile, 'runtimes'));
    assert.equal(runtimes.filter(name => /^[a-f0-9]{64}$/.test(name)).length, 1);
    console.log('PASS packaged startup, native bridge isolation, bundled plugin worker, real PTY, quit/reopen continuity, retained settings and immutable runtime cache.');
    const finalExit = once(child, 'exit'); await evaluate('window.clideckDesktop.quit()'); await finalExit;
  } finally {
    control?.terminate(); debuggerSocket?.terminate();
    if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); }
    pid ||= readLock(dataDir)?.pid;
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 100 && alive(pid); i++) await delay(50);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

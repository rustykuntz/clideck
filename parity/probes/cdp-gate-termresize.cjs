// Real-Chrome gate: the terminal must not send a resize the dimensions did not ask for.
//
// Or's report: "I see a line, scroll down and start typing, and the previous line vanishes." Traced end to
// end, in this harness, before anything was changed:
//   1. `fit(true)` sent a resize frame UNCONDITIONALLY — the dimension guard covered only `term.resize()`.
//      One traced session sent three identical 92x22 frames: session focus, terminal-tab-shown, and a
//      ResizeObserver tick.
//   2. The engine forwards every resize to the pty (`session.js` resize → TIOCSWINSZ), which raises SIGWINCH
//      whether or not the size changed.
//   3. Codex answers SIGWINCH with `ESC[2J ESC[3J`. In a recorded Codex stream those bytes appear in the
//      resize phase and NOWHERE else — not on boot, not on the trust prompt, not while typing.
//   4. `ESC[3J` erases the scrollback: measured here at 62 lines → 22, baseY 40 → 0.
//
// So this gate holds two separate claims, because either one alone would let the bug back:
//   • a no-op fit sends NOTHING, while a genuine size change still sends exactly one frame;
//   • `ESC[3J` really does destroy scrollback, so the first claim is worth having.
//
// Own Chrome + temp profile + ephemeral engine. No real agent is launched: the recorded Codex bytes are
// replayed, so nothing is spawned, no prompt is sent and no model is called.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server');
const WebSocket = require('../../node_modules/ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.GATE_OUT || tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` [${detail}]` : ''}`);
  if (!pass) failures++;
}
async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const v = await fn(); if (v) return v; await sleep(110); }
  return null;
}

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-termresize-data-'));
  const work = join(mkdtempSync(join(tmpdir(), 'clideck-termresize-work-')), 'demo');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true }, defaultCwd: work }));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', (raw) => { try { events.push(JSON.parse(raw)); } catch {} });
  await new Promise((res, rej) => { ctl.once('open', res); ctl.once('error', rej); });
  ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'stage', cwd: work }));
  const made = await waitFor(() => events.find((e) => e.type === 'session.created' && e.name === 'stage'));

  const profile = mkdtempSync(join(tmpdir(), 'clideck-termresize-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let cdp = null;
  try {
    if (!made) throw new Error('the staging session did not start');
    const pf = join(profile, 'DevToolsActivePort');
    await waitFor(() => existsSync(pf));
    const port = readFileSync(pf, 'utf8').split('\n')[0].trim();
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { cdp.once('open', res); cdp.once('error', rej); });
    let seq = 0; const pend = new Map();
    cdp.on('message', (raw) => { const m = JSON.parse(raw); const d = pend.get(m.id); if (d) { pend.delete(m.id); d(m); } });
    const cmd = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); cdp.send(JSON.stringify({ id, method, params })); });
    const js = async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
    await cmd('Runtime.enable');
    await cmd('Page.enable');        // addScriptToEvaluateOnNewDocument is a no-op without it
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 620, deviceScaleFactor: 1, mobile: false });
    // ⚠️ INSTRUMENT BEFORE THE DOCUMENT EXISTS. Installing the hook after `Page.navigate` and a sleep missed
    // the boot frame entirely and made "nothing was sent on the way up" look like a product bug.
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__rs = [];
      const orig = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) {
        try { const p = JSON.parse(d); if (p && p.type === 'resize') window.__rs.push(p.cols + 'x' + p.rows); } catch {}
        return orig.call(this, d); };
    ` });
    await cmd('Page.navigate', { url: `http://127.0.0.1:${addr.port}` });
    await sleep(5200);
    await js(`(async () => { const m = await import('/js/ui/terminal.js'); window.__t = m.__termForTest();
      const s = await import('/js/store.js'); window.__s = s.store; window.__sid = ${JSON.stringify(made.sessionId)};
      window.__feed = (d) => window.__s.applyEvent({ type: 'output', sessionId: window.__sid, data: d });
      return true; })()`);

    const boot = await js(`window.__rs.slice()`);
    check('a session tells its pty its size exactly once on the way up', boot.length === 1, JSON.stringify(boot));

    // ── a no-op fit must be silent ──────────────────────────────────────────
    // ⚠️ NOT a session switch. Re-selecting deliberately re-asserts (see the multi-client check below); what
    // must be silent is everything that is NOT a user changing something — observer ticks, layout nudges,
    // window resize events at an unchanged size. Every one of these used to send a frame, and every frame
    // was a SIGWINCH the user never asked for.
    await js(`window.__rs.length = 0`);
    await js(`window.dispatchEvent(new Event('resize'))`);
    await sleep(500);
    await js(`(() => { const el = document.getElementById('term'); el.style.opacity = '0.999'; })()`);
    await sleep(500);
    await js(`(() => { const el = document.getElementById('term'); el.style.opacity = ''; })()`);
    await sleep(700);
    const quiet = await js(`window.__rs.slice()`);
    check('re-fitting at the SAME size, with no session switch, sends nothing at all', quiet.length === 0, JSON.stringify(quiet));

    // ── a real size change must still be sent, once ─────────────────────────
    await cmd('Emulation.setDeviceMetricsOverride', { width: 820, height: 620, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const changed = await js(`window.__rs.slice()`);
    check('a genuine viewport change still reaches the pty, exactly once',
      changed.length === 1 && changed[0] !== boot[0], JSON.stringify({ boot, changed }));
    await js(`window.__rs.length = 0`);
    await js(`window.dispatchEvent(new Event('resize'))`);
    await sleep(700);
    check('…and re-fitting at the new size is silent again', (await js(`window.__rs.length`)) === 0);

    // ── a session switch must RE-ASSERT, because another client may have resized it ──
    // ⚠️ The cache is this browser's memory of what it sent, not the pty's state. Browser B can resize the
    // same session while we are away and the engine does not broadcast it, so coming back must tell the pty
    // our size again even though nothing changed HERE. The engine dedupes against the real pty size, so a
    // re-assertion that changes nothing is free.
    ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'other', cwd: work }));
    const other = await waitFor(() => events.find((e) => e.type === 'session.created' && e.name === 'other'));
    await sleep(900);
    await js(`window.__rs.length = 0`);
    await js(`window.__s.select(${JSON.stringify(other.sessionId)})`);
    await sleep(800);
    const away = await js(`window.__rs.slice()`);
    check('switching to another session tells THAT session its size', away.length === 1, JSON.stringify(away));
    await js(`window.__rs.length = 0`);
    await js(`window.__s.select(window.__sid)`);
    await sleep(800);
    const back = await js(`window.__rs.slice()`);
    check('…and switching BACK re-asserts, rather than trusting a stale cache', back.length === 1, JSON.stringify(back));
    await js(`window.__rs.length = 0`);
    await js(`window.dispatchEvent(new Event('resize'))`);
    await sleep(700);
    check('…while an observer tick after that is still silent', (await js(`window.__rs.length`)) === 0);

    // ── why it matters: ESC[3J really does erase the scrollback ─────────────
    await js(`(() => { let s = ''; for (let i = 1; i <= 60; i++) s += 'LINE-' + i + '\\r\\n'; window.__feed(s); })()`);
    await sleep(600);
    const full = await js(`(() => { const b = window.__t.buffer.active; return { len: b.length, baseY: b.baseY }; })()`);
    check('sixty lines of output build real scrollback', full.len > 40 && full.baseY > 20, JSON.stringify(full));
    await js(`window.__feed('\\x1b[2J\\x1b[3J\\x1b[H')`);
    await sleep(500);
    const wiped = await js(`(() => { const b = window.__t.buffer.active; return { len: b.length, baseY: b.baseY }; })()`);
    check('ESC[2J + ESC[3J erases ALL of it — which is what Codex sends on SIGWINCH',
      wiped.baseY === 0 && wiped.len < full.len, JSON.stringify({ full, wiped }));

    console.log(`\n${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
  } catch (error) {
    console.log('THREW', error && error.stack || error);
    failures++;
  } finally {
    try { if (cdp) cdp.close(); } catch {}
    try { ctl.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { await server.close(); } catch {}
  }
  process.exit(failures ? 1 : 0);
})();

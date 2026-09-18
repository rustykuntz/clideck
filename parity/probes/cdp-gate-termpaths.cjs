// Gate: clickable document paths in the terminal, end-to-end on the REAL engine in a real browser.
//
// Or's acceptance line is the case, verbatim, with BOTH paths on one line:
//   "The MD file is ready: docs/STRATEGY-IMPLEMENTATION-SPEC.md - 761 lines, written with the programmer,
//    whose full input is at docs/archive/PROGRAMMER-INPUT-STRATEGY-IMPLEMENTATION-SPEC.md."
// Both become links when the files exist. NEITHER becomes one when they do not — that is the whole design, so
// the negative case is gated as hard as the positive one. Then a click must open the viewer tab.
//
// WHAT THIS GATE DOES AND DOES NOT PROVE — read before trusting it.
// It drives the REAL provider objects the app handed xterm, so the matcher, the wrapped-line range maths, the
// cache and the click path are all exercised for real, in a real browser, against the real engine.
// It does NOT prove that xterm itself invokes those providers on hover. I tried: hovering with a real mouse
// moved no observable needle — but neither did the CONTROL, the shipped v1-parity URL link that demonstrably
// works in the product. A probe whose control does not move cannot support a conclusion either way, so rather
// than keep a check that passes vacuously I removed it and wrote this down. The residual risk is narrow: the
// path provider is registered by the SAME registerLinkProvider call, in the same function, as those URL links.
//
// Own headless Chrome + temp profile + ephemeral HeadlessServer. Never :9222, never 4100, never ~/.clideck-next.
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('/Users/rusty/Projects/clideck-next/src/server.js');
const WebSocket = require('/Users/rusty/Projects/clideck-next/node_modules/ws/index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/private/tmp/claude-501/-Users-rusty-Projects-termix/8e18f83b-dbd6-4f41-9fda-777c0e2c7ffe/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fail++; };

const A = 'docs/STRATEGY-IMPLEMENTATION-SPEC.md';
const B = 'docs/archive/PROGRAMMER-INPUT-STRATEGY-IMPLEMENTATION-SPEC.md';
const LINE = 'The MD file is ready: ' + A + ' - 761 lines, written with the programmer, whose full input is at ' + B + '.';

// Ask xterm itself what it would link on a given row, by driving the registered providers.
const RIG = `
// Drive the REAL provider objects the app handed xterm — this exercises the actual matcher and the actual
// wrapped-line range maths, not a copy of them. (Whether xterm *calls* them is proven separately, by hover.)
window.__rig = async () => { const m = await import('/js/ui/terminal.js'); window.__providers = m.__linkProvidersForTest(); return window.__providers.length; };
window.__rowOf = async (needle) => {
  const { store } = await import('/js/store.js');
  const t = document.querySelector('#term');
  const rows = [...t.querySelectorAll('.xterm-rows > div')];
  for (let i = 0; i < rows.length; i++) if ((rows[i].textContent || '').includes(needle)) return i;
  return -1;
};
window.__linksOn = async (needle) => {
  const vrow = await window.__rowOf(needle);
  if (vrow < 0) return { err: 'line not found on screen' };
  const el = document.querySelector('#term .xterm-rows > div');
  const out = [];
  // provider y is the same 1-based buffer row the app's own URL provider uses (getLine(y-1))
  const ydisp = window.__ydisp || 0;
  const y = ydisp + vrow + 1;
  for (const p of window.__providers) {
    await new Promise((res) => { p.provideLinks(y, (links) => { (links || []).forEach(l => out.push(l)); res(); }); });
  }
  window.__lastLinks = out;
  return { vrow, y, links: out.map(l => l.text) };
};
window.__clickLink = (t) => { const l = (window.__lastLinks || []).find(x => x.text === t); if (!l) return false; l.activate({button: 0}, l.text); return true; };
window.__cellRect = async (needle, offsetInLine) => {
  const vrow = await window.__rowOf(needle); if (vrow < 0) return null;
  const rows = [...document.querySelectorAll('#term .xterm-rows > div')];
  const r = rows[vrow].getBoundingClientRect();
  const cols = window.__cols || 120;
  const cw = r.width / cols;
  return { x: Math.round(r.left + cw * (offsetInLine + 0.5)), y: Math.round(r.top + r.height / 2) };
};
window.__tabs = () => [...document.querySelectorAll('.cd-tab .cd-tab-name')].map(t => t.textContent);
`;

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-data-'));
  const realDir = mkdtempSync(join(tmpdir(), 'tp-real-'));      // session cwd where BOTH files exist
  const emptyDir = mkdtempSync(join(tmpdir(), 'tp-empty-'));    // session cwd where NEITHER exists
  mkdirSync(join(realDir, 'docs', 'archive'), { recursive: true });
  writeFileSync(join(realDir, A), '# Strategy implementation spec\n\n- one\n- two\n');
  writeFileSync(join(realDir, B), '# Programmer input\n\nDetail.\n');

  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', d => { try { events.push(JSON.parse(d)); } catch {} });
  await new Promise((res, rej) => { ctl.on('open', res); ctl.on('error', rej); });
  ctl.send(JSON.stringify({ type: 'config.get' }));
  const make = async (name, cwd) => {
    ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name, cwd }));
    return new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => {
      const hit = events.find(e => e.type === 'session.created' && e.name === name);
      if (hit) { clearInterval(iv); res(hit.sessionId); } else if (Date.now() - t0 > 10000) { clearInterval(iv); rej(new Error('no session ' + name)); } }, 40); });
  };
  const sidReal = await make('hasfiles', realDir);
  const sidEmpty = await make('nofiles', emptyDir);

  const prof = mkdtempSync(join(tmpdir(), 'chrome-tp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(200);
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { cws.on('open', res); cws.on('error', rej); });
  let seq = 0; const pending = new Map();
  cws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (m, p = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); cws.send(JSON.stringify({ id, method: m, params: p })); });
  const js = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async (name) => { const s = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); console.log('  captured ' + name); };
  // Print the line into a session's terminal by feeding the app's OWN store — the same singleton the UI reads.
  const printInto = async (sid) => js(`(async () => {
    const { store } = await import('/js/store.js');
    store.applyEvent({ type: 'output', sessionId: ${JSON.stringify(sid)}, data: ${JSON.stringify(LINE + '\r\n')} });
    await new Promise(r => setTimeout(r, 1400));
    return true; })()`);

  await cmd('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 2, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cmd('Page.navigate', { url: base });
  await sleep(4500);

  // ── 1. THE ACCEPTANCE CASE — both files exist, both become links ────────────────────────────────
  await js(`(() => { const r = document.querySelector('.row[data-id="${sidReal}"]'); r && r.click(); return !!r; })()`);
  await sleep(700);
  await js(RIG); await js(`(async () => { const m = await import('/js/ui/terminal.js');
    window.__providers = m.__linkProvidersForTest();
    const t = m.__termForTest();
    window.__cols = t ? t.cols : 120; window.__ydisp = t ? t.buffer.active.viewportY : 0;
    return { providers: window.__providers.length, cols: window.__cols, ydisp: window.__ydisp }; })()`);
  await printInto(sidReal);
  const resolveSent = await js(`(async () => { const { store } = await import('/js/store.js'); return true; })()`);
  const hit = await js(`window.__linksOn('STRATEGY-IMPLEMENTATION-SPEC')`);
  check('1a the printed line is on screen', hit && !hit.err, JSON.stringify(hit && hit.text));
  check('1b BOTH printed paths became links, from one line',
        hit && hit.links && hit.links.includes(A) && hit.links.includes(B), JSON.stringify(hit && hit.links));
  check('1c the trailing full stop is not part of the second link',
        hit && (hit.links || []).every(l => !l.endsWith('.md.')), JSON.stringify(hit && hit.links));
  await snap('termpaths-dark-links.png');

  // ── 2. click opens the viewer through the existing content.show path ───────────────────────────
  const clicked = await js(`window.__clickLink(${JSON.stringify(A)})`);
  await sleep(1600);
  const tabs = await js(`window.__tabs()`);
  check('2a clicking a linked path opened the viewer tab', clicked === true && (tabs || []).some(x => x.includes('STRATEGY-IMPLEMENTATION-SPEC')), JSON.stringify(tabs));
  const body = await js(`(() => { const md = document.querySelector('#pane-body .md'); return md ? md.textContent.slice(0, 60) : null; })()`);
  check('2b it rendered the real file', /Strategy implementation spec/.test(body || ''), body);
  await snap('termpaths-dark-opened.png');

  // ── 3. THE OTHER HALF — same line, a session where neither file exists → NO links ───────────────
  await js(`(() => { const r = document.querySelector('.row[data-id="${sidEmpty}"]'); r && r.click(); return !!r; })()`);
  await sleep(900);
  await js(RIG); await js(`(async () => { const m = await import('/js/ui/terminal.js');
    window.__providers = m.__linkProvidersForTest();
    const t = m.__termForTest();
    window.__cols = t ? t.cols : 120; window.__ydisp = t ? t.buffer.active.viewportY : 0;
    return { providers: window.__providers.length, cols: window.__cols, ydisp: window.__ydisp }; })()`);
  await printInto(sidEmpty);
  const miss = await js(`window.__linksOn('STRATEGY-IMPLEMENTATION-SPEC')`);
  check('3a the same line is on screen in the other session', miss && !miss.err, JSON.stringify(miss && miss.text));
  check('3b NEITHER path is a link when the files do not exist — no dead links',
        miss && Array.isArray(miss.links) && !miss.links.includes(A) && !miss.links.includes(B),
        JSON.stringify(miss && miss.links));
  await snap('termpaths-dark-nolinks.png');

  // ── 4. the cache: a candidate is probed once per session, hit or miss ───────────────────────────
  const probes = await js(`(async () => {
    const sent = [];
    const S = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.type === 'content.resolve') sent.push(m.paths.join('|')); } catch {} return S.call(this, d); };
    const { store } = await import('/js/store.js');
    for (let i = 0; i < 3; i++) {
      store.applyEvent({ type: 'output', sessionId: ${JSON.stringify(sidEmpty)}, data: ${JSON.stringify(LINE + '\r\n')} });
      await new Promise(r => setTimeout(r, 500));
    }
    WebSocket.prototype.send = S;
    return sent; })()`);
  check('4 a resolved-or-missing candidate is never probed again (3 more prints, 0 new probes)',
        Array.isArray(probes) && probes.length === 0, JSON.stringify(probes));

  // ── 5. URLs still belong to the URL provider, and are not double-decorated ──────────────────────
  await js(`(async () => { const { store } = await import('/js/store.js');
    store.applyEvent({ type: 'output', sessionId: ${JSON.stringify(sidEmpty)}, data: 'see https://example.dev/docs/readme.md now\\r\\n' });
    await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const urlRow = await js(`window.__linksOn('example.dev')`);
  check('5 a path inside a URL yields exactly one link, the URL itself',
        urlRow && (urlRow.links || []).length === 1 && urlRow.links[0].startsWith('https://'), JSON.stringify(urlRow && urlRow.links));

  // ── 6. light theme ─────────────────────────────────────────────────────────────────────────────
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(800);
  await js(`(() => { const r = document.querySelector('.row[data-id="${sidReal}"]'); r && r.click(); return !!r; })()`);
  await sleep(900);
  await js(RIG); await js(`(async () => { const m = await import('/js/ui/terminal.js');
    window.__providers = m.__linkProvidersForTest();
    const t = m.__termForTest();
    window.__cols = t ? t.cols : 120; window.__ydisp = t ? t.buffer.active.viewportY : 0;
    return { providers: window.__providers.length, cols: window.__cols, ydisp: window.__ydisp }; })()`);
  const lightHit = await js(`window.__linksOn('STRATEGY-IMPLEMENTATION-SPEC')`);
  check('6 light: both paths are still links', lightHit && (lightHit.links || []).includes(A) && (lightHit.links || []).includes(B), JSON.stringify(lightHit && lightHit.links));
  await snap('termpaths-light-links.png');

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  try { chrome.kill(); } catch {} try { ctl.close(); } catch {} try { await server.close(); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log('THREW', e && e.stack || e); process.exit(1); });

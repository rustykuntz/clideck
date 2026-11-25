// Gate — (1) sessions can be dragged into a new order inside a project; the order is saved in config and survives
// a reload. (2) Pane tabs drag like browser tabs: the held tab follows the pointer, the others slide aside, the drop
// reorders; with more tabs than fit, holding at the strip's edge scrolls it, and the vertical wheel scrolls it.
// Real HeadlessServer + headless Chrome; pointer events dispatched on the grabbed element.
const { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.OT_OUT || '/tmp/order-tabs-shot';
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fail++; };

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ot-data-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', d => { try { events.push(JSON.parse(d)); } catch {} });
  await new Promise((res, rej) => { ctl.on('open', res); ctl.on('error', rej); });
  const path = mkdtempSync(join(tmpdir(), 'ot-p-'));
  ctl.send(JSON.stringify({ type: 'config.update', config: { projects: [{ id: 'p0', name: 'Alpha', path, color: '#4c9be0', collapsed: false }, { id: 'p1', name: 'Beta', path, color: '#e0904c', collapsed: false }] } }));
  for (const n of ['a1', 'a2', 'a3']) { ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: n, projectId: 'p0', cwd: path })); await sleep(150); }
  ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'b1', projectId: 'p1', cwd: path }));
  const t0 = Date.now();
  while (events.filter(e => e.type === 'session.created').length < 4 && Date.now() - t0 < 8000) await sleep(40);
  const idOf = n => events.find(e => e.type === 'session.created' && e.name === n)?.sessionId;
  const [a1, a2, a3, b1] = ['a1', 'a2', 'a3', 'b1'].map(idOf);
  check('0 sessions created', a1 && a2 && a3 && b1);

  const prof = mkdtempSync(join(tmpdir(), 'chrome-cdp-'));
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
  const snap = async (name) => { const s = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); console.log('captured ' + join(OUT, name)); };
  const FIRE = `const fire = (el, ty, x, y) => el.dispatchEvent(new PointerEvent(ty, { bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons: ty === 'pointerup' ? 0 : 1, pointerId:7, isPrimary:true }));`;

  await cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 2, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cmd('Page.navigate', { url: base });
  await sleep(4000);
  const order = (pid) => js(`[...document.querySelectorAll('.project[data-project-id="${pid}"] > .rows > .row[data-id]')].map(r => r.dataset.id).join(',')`);
  check('1 arrival order a1,a2,a3', await order('p0') === [a1, a2, a3].join(','));

  // 1 — drag a3 above a1 within Alpha
  await js(`(() => { ${FIRE} const row = document.querySelector('.row[data-id="${a3}"]'), top = document.querySelector('.row[data-id="${a1}"]').getBoundingClientRect(), r = row.getBoundingClientRect();
    const x = r.left + r.width / 2; fire(row, 'pointerdown', x, r.top + r.height / 2); fire(row, 'pointermove', x, r.top + r.height / 2 - 10); fire(row, 'pointermove', x, top.top + 6); return true; })()`);
  await sleep(150);
  const line = JSON.parse(await js(`(() => { const l = document.querySelector('.session-drop-line'), a = document.querySelector('.row[data-id="${a1}"]'); if (!l) return 'null'; const lr = l.getBoundingClientRect(), ar = a.getBoundingClientRect(); return JSON.stringify({ dy: Math.round(lr.top - ar.top) }); })()`));
  check('1 an insertion line marks the slot just above a1', line && Math.abs(line.dy) <= 4, JSON.stringify(line));
  await snap('session-reorder-dragging.png');
  await js(`(() => { ${FIRE} const row = document.querySelector('.row[data-id="${a3}"]'), top = document.querySelector('.row[data-id="${a1}"]').getBoundingClientRect(); fire(row, 'pointerup', top.left + 40, top.top + 6); return true; })()`);
  await sleep(400);
  check('1 dropped: Alpha reads a3,a1,a2', await order('p0') === [a3, a1, a2].join(','), await order('p0'));
  const saved = server.configStore.get().projects.find(p => p.id === 'p0').sessionOrder;
  check('1 the order is saved in config (project.sessionOrder)', JSON.stringify(saved) === JSON.stringify([a3, a1, a2]), JSON.stringify(saved));
  check('1 a drop never selects the dragged row', !(await js(`document.querySelector('.row[data-id="${a3}"]').classList.contains('active')`)));

  // 2 — drag b1 from Beta into Alpha between a3 and a1
  await js(`(() => { ${FIRE} const row = document.querySelector('.row[data-id="${b1}"]'), at = document.querySelector('.row[data-id="${a1}"]').getBoundingClientRect(), r = row.getBoundingClientRect();
    const x = r.left + r.width / 2; fire(row, 'pointerdown', x, r.top + r.height / 2); fire(row, 'pointermove', x, r.top + r.height / 2 - 10); fire(row, 'pointermove', x, at.top + 5); fire(row, 'pointerup', x, at.top + 5); return true; })()`);
  await sleep(600);
  check('2 a session from another project lands in the chosen slot', await order('p0') === [a3, b1, a1, a2].join(','), await order('p0'));

  // 3 — reload: the order persists
  await cmd('Page.reload'); await sleep(3500);
  check('3 after a reload the order is the same', await order('p0') === [a3, b1, a1, a2].join(','), await order('p0'));

  // 4 — tabs: open 12 documents for a1, select it
  await js(`document.querySelector('.row[data-id="${a1}"]').click()`); await sleep(300);
  for (let i = 1; i <= 12; i++) { ctl.send(JSON.stringify({ type: 'content.open', sessionId: a1, name: 'Document number ' + i, kind: 'text', data: 'doc ' + i })); await sleep(60); }
  await sleep(1200);
  const tabs = () => js(`[...document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')].map(t => t.textContent.replace('Document number ', 'D')).join(',')`);
  const names0 = await tabs();
  check('4 twelve document tabs, strip overflows', names0.split(',').length === 12 && await js(`(() => { const s = document.getElementById('pane-tabs'); return s.scrollWidth > s.clientWidth; })()`), names0);
  await js(`document.getElementById('pane-tabs').scrollLeft = 0`);
  // drag D1 right past D3
  await js(`(() => { ${FIRE} const tabs = [...document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')], t = tabs[0], r = t.getBoundingClientRect(), r3 = tabs[2].getBoundingClientRect();
    window.__tx = r.left + r.width / 2; fire(t, 'pointerdown', __tx, r.top + 10); fire(t, 'pointermove', __tx + 8, r.top + 10); fire(t, 'pointermove', r3.right - 5, r.top + 10); window.__ty = r.top + 10; return true; })()`);
  await sleep(250);
  const mid = JSON.parse(await js(`JSON.stringify({ dragging: !!document.querySelector('.cd-tab.dragging'), shifted: [...document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')].slice(1, 3).every(t => /translateX\\(-/.test(t.style.transform)) })`));
  check('4 the held tab follows; the two it passed slid left', mid.dragging && mid.shifted, JSON.stringify(mid));
  await snap('tab-dragging.png');
  await js(`(() => { ${FIRE} const t = document.querySelector('.cd-tab.dragging'); fire(t, 'pointerup', 0, __ty); return true; })()`);
  await sleep(400);
  const names1 = await tabs();
  check('4 dropped after D3: D2,D3,D1,…', names1.startsWith('D2,D3,D1,D4'), names1);
  check('4 the dropped tab is selected; transforms cleared', await js(`document.querySelector('#pane-tabs .cd-tab.on')?.textContent.includes('number 1') && [...document.querySelectorAll('#pane-tabs .cd-tab')].every(t => !t.style.transform)`));

  // 5 — edge auto-scroll: hold D2 at the strip's right edge
  await js(`document.getElementById('pane-tabs').scrollLeft = 0`);
  await js(`(() => { ${FIRE} const s = document.getElementById('pane-tabs'), t = s.querySelector('.cd-tab[data-item-id]'), r = t.getBoundingClientRect(), sr = s.getBoundingClientRect();
    fire(t, 'pointerdown', r.left + 20, r.top + 10); fire(t, 'pointermove', r.left + 30, r.top + 10); fire(t, 'pointermove', sr.right - 4, r.top + 10); window.__ty = r.top + 10; return true; })()`);
  const t1 = Date.now();
  while (Date.now() - t1 < 5000 && !(await js(`(() => { const s = document.getElementById('pane-tabs'); return s.scrollLeft + s.clientWidth >= s.scrollWidth - 1; })()`))) await sleep(100);
  check('5 holding at the right edge scrolls the strip to the end', await js(`(() => { const s = document.getElementById('pane-tabs'); return s.scrollLeft > 0 && s.scrollLeft + s.clientWidth >= s.scrollWidth - 1; })()`));
  await snap('tab-edge-scroll.png');
  await js(`(() => { ${FIRE} const s = document.getElementById('pane-tabs'), t = document.querySelector('.cd-tab.dragging'); fire(t, 'pointerup', s.getBoundingClientRect().right - 4, __ty); return true; })()`);
  await sleep(400);
  const names2 = await tabs();
  check('5 dropped at the end of the strip', names2.endsWith(',D2'), names2);

  // 6 — vertical wheel scrolls the strip sideways
  await js(`document.getElementById('pane-tabs').scrollLeft = 0`);
  await js(`(() => { const s = document.getElementById('pane-tabs'), r = s.getBoundingClientRect(); s.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, deltaY: 200, clientX: r.left + 50, clientY: r.top + 10 })); return true; })()`);
  await sleep(100);
  check('6 the vertical wheel scrolls the tab strip', await js(`document.getElementById('pane-tabs').scrollLeft`) > 0);

  // 7 — a click without movement still just selects
  await js(`document.getElementById('pane-tabs').scrollLeft = 0`);
  await js(`(() => { ${FIRE} const t = document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')[1], r = t.getBoundingClientRect(); fire(t, 'pointerdown', r.left + 20, r.top + 10); fire(t, 'pointerup', r.left + 20, r.top + 10); t.click(); return true; })()`);
  await sleep(200);
  check('7 a plain click selects without reordering', (await tabs()) === names2 && await js(`document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')[1].classList.contains('on')`));

  // 7b — clicking a tab the strip cuts off glides it fully into view, close button included (browser-like)
  await js(`document.getElementById('pane-tabs').scrollLeft = 0`); await sleep(50);
  const cut = await js(`(() => { const s = document.getElementById('pane-tabs').getBoundingClientRect(); const t = [...document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]')].find(t => { const r = t.getBoundingClientRect(); return r.left < s.right && r.right > s.right; }); if (!t) return null; window.__cut = t.dataset.itemId; return t.dataset.itemId; })()`);
  check('7b a tab is cut off by the strip edge', !!cut);
  // Clickable, not just inside the strip: the pinned document toolbar floats over the strip's right end, so the
  // X's centre must hit-test to the X itself.
  const xInView = `(() => { const b = document.querySelector('#pane-tabs .cd-tab[data-item-id="' + window.__cut + '"] .cd-tab-x'), x = b.getBoundingClientRect(); const hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2); return !!document.querySelector('#pane-tabs .cd-viewer-actions') && (hit === b || b.contains(hit)); })()`;
  await js(`(() => { const t = document.querySelector('#pane-tabs .cd-tab[data-item-id="' + window.__cut + '"]'); t.click(); return true; })()`);
  await sleep(40);
  const midGlide = await js(`document.getElementById('pane-tabs').scrollLeft`);
  await sleep(700);
  const endGlide = await js(`document.getElementById('pane-tabs').scrollLeft`);
  check('7b the strip glides (not jumps) until the clicked tab and its X are fully visible', midGlide > 0 && midGlide < endGlide && await js(xInView) && await js(`document.querySelector('#pane-tabs .cd-tab[data-item-id="' + window.__cut + '"]').classList.contains('on')`), JSON.stringify({ midGlide, endGlide }));
  await js(`document.getElementById('pane-tabs').scrollLeft -= 120`); await sleep(50);
  await js(`document.querySelector('#pane-tabs .cd-tab.on').click()`); await sleep(700);
  check('7b clicking the already-selected tab while it is cut off brings it back into view', await js(xInView));

  // 7c — switching sessions lands on the terminal (with keyboard focus), never on the last document
  check('7c a document tab is in front before switching', await js(`!document.querySelector('#pane-tabs .cd-tab.on')?.classList.contains('cd-tab-term')`));
  await js(`document.querySelector('.row[data-id="${a2}"]').click()`); await sleep(400);
  await js(`document.querySelector('.row[data-id="${a1}"]').click()`); await sleep(600);
  check('7c back on that session: the Terminal tab is selected and the terminal is visible', await js(`document.querySelector('#pane-tabs .cd-tab.on')?.classList.contains('cd-tab-term') && !document.getElementById('term-panel').hidden && document.querySelectorAll('#pane-tabs .cd-tab[data-item-id]').length === 12`));
  check('7c the terminal has keyboard focus', await js(`document.activeElement?.classList.contains('xterm-helper-textarea')`), await js(`document.activeElement?.className`));

  // 8 — history overlay header
  await js(`document.getElementById('th-history').click()`); await sleep(500);
  check('8 history shows Copy and Download conversation', await js(`[...document.querySelectorAll('.hist-act')].map(b => b.getAttribute('aria-label')).join('|')`) === 'Copy conversation|Download conversation');
  await snap('history-actions.png');
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(300); await snap('history-actions-light.png');

  ctl.close(); cws.close(); chrome.kill(); await server.close();
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

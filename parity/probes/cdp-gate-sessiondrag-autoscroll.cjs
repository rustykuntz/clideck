// Gate — dragging in the sidebar auto-scrolls the list. With more projects than fit, a session dragged to the
// list's bottom edge must scroll the list, highlight a project that started out of view, and drop into it; a
// project header dragged to the top edge must scroll back up and reorder before a project that was out of view.
// Real headless Chrome + real HeadlessServer; pointer events dispatched on the captured row/header.
const { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('/Users/rusty/Projects/clideck-next/src/server.js');
const WebSocket = require('/Users/rusty/Projects/clideck-next/node_modules/ws/index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SDA_OUT || '/tmp/sda-shot';
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra ? '  [' + extra + ']' : '')); if (!ok) fail++; };
const N = 14;

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'sda-data-'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', d => { try { events.push(JSON.parse(d)); } catch {} });
  await new Promise((res, rej) => { ctl.on('open', res); ctl.on('error', rej); });
  const projects = [];
  for (let i = 0; i < N; i++) projects.push({ id: 'p' + i, name: 'Proj ' + String(i).padStart(2, '0'), path: mkdtempSync(join(tmpdir(), 'sda-p' + i + '-')), color: '#4c9be0', collapsed: false });
  ctl.send(JSON.stringify({ type: 'config.get' }));
  ctl.send(JSON.stringify({ type: 'config.update', config: { projects } }));
  for (const n of ['a1', 'a2', 'a3']) ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: n, projectId: 'p0', cwd: projects[0].path }));
  const t0 = Date.now();
  while (events.filter(e => e.type === 'session.created').length < 3 && Date.now() - t0 < 8000) await sleep(40);
  const sid = events.find(e => e.type === 'session.created' && e.name === 'a1')?.sessionId;
  check('0 sessions created in the first project', !!sid);

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

  await cmd('Emulation.setDeviceMetricsOverride', { width: 1400, height: 720, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await cmd('Page.navigate', { url: base });
  await sleep(4500);
  const info = JSON.parse(await js(`(() => { const l = document.getElementById('list'); const lr = l.getBoundingClientRect();
    const last = [...document.querySelectorAll('.project.is-project')].pop().getBoundingClientRect();
    return JSON.stringify({ groups: document.querySelectorAll('.project.is-project').length, overflow: l.scrollHeight > l.clientHeight, lastHidden: last.top > lr.bottom, scrollTop: l.scrollTop }); })()`));
  check('0 list overflows and the last project starts out of view', info.groups === N && info.overflow && info.lastHidden && info.scrollTop === 0, JSON.stringify(info));

  // 1 — session drag held at the bottom edge scrolls the list
  await js(`(() => { const row = document.querySelector('.row[data-id="${sid}"]'); const r = row.getBoundingClientRect();
    const fire = (ty, x, y) => row.dispatchEvent(new PointerEvent(ty, { bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1, pointerId:1, isPrimary:true }));
    const cx = r.left + r.width/2; window.__dx = cx; fire('pointerdown', cx, r.top + r.height/2); fire('pointermove', cx, r.top + r.height/2 + 12);
    const lr = document.getElementById('list').getBoundingClientRect(); fire('pointermove', cx, lr.bottom - 20); return true; })()`);
  await sleep(200);
  const st1 = await js(`document.getElementById('list').scrollTop`);
  check('1 holding at the bottom edge scrolls the list down', st1 > 0, 'scrollTop=' + st1);
  const gh = JSON.parse(await js(`(() => { const g = document.querySelector('.drag-ghost'); const r = g.getBoundingClientRect(); const row = document.querySelector('.row.dragging').getBoundingClientRect(); const lr = document.getElementById('list').getBoundingClientRect();
    return JSON.stringify({ pos: getComputedStyle(g).position, top: r.top, bottom: r.bottom, left: r.left, rowLeft: row.left, listBottom: lr.bottom }); })()`));
  check('1 the row ghost is visible under the pointer (fixed, in view, aligned with the row)', gh.pos === 'fixed' && gh.top < gh.listBottom && gh.bottom > gh.listBottom - 80 && Math.abs(gh.left - gh.rowLeft) < 1, JSON.stringify(gh));
  await snap('sda-scrolling-down.png');
  // keep holding until it reaches the end
  const t1 = Date.now();
  while (Date.now() - t1 < 6000 && !(await js(`(() => { const l = document.getElementById('list'); return l.scrollTop + l.clientHeight >= l.scrollHeight - 1; })()`))) await sleep(100);
  check('1 keeps scrolling to the end of the list', await js(`(() => { const l = document.getElementById('list'); return l.scrollTop + l.clientHeight >= l.scrollHeight - 1; })()`));
  // the pointer is still at the edge — the target follows the scrolled content (last group under the pointer)
  const under = await js(`(() => { const h = document.querySelector('.group-head.drop-highlight'); return h ? h.closest('.project').dataset.projectId : null; })()`);
  check('1 the drop target follows the scroll without moving the pointer', under === 'p' + (N - 1), 'highlight=' + under);

  // 2 — move onto the last project (was out of view), drop → moved
  await js(`(() => { const g = document.querySelector('.project[data-project-id="p${N - 1}"] > .group-head'); const r = g.getBoundingClientRect();
    document.querySelector('.row[data-id="${sid}"]').dispatchEvent(new PointerEvent('pointermove', { bubbles:true, clientX:window.__dx, clientY:r.top + r.height/2, button:0, buttons:1, pointerId:1 })); return true; })()`);
  await sleep(150);
  const st2a = await js(`document.getElementById('list').scrollTop`);
  await sleep(250);
  const st2b = await js(`document.getElementById('list').scrollTop`);
  check('2 away from the edge, scrolling stops', st2a === st2b, st2a + ' → ' + st2b);
  check('2 the last project is the highlighted drop target', (await js(`!!document.querySelector('.project[data-project-id="p${N - 1}"] > .group-head.drop-highlight')`)) === true);
  await snap('sda-over-last.png');
  await js(`document.querySelector('.row[data-id="${sid}"]').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0, pointerId:1 }))`);
  const t2 = Date.now();
  while (!events.some(e => e.sessionId === sid && e.projectId === 'p' + (N - 1)) && Date.now() - t2 < 4000) await sleep(40);
  check('2 drop moved the session into the last project', events.some(e => e.sessionId === sid && e.projectId === 'p' + (N - 1)));
  await sleep(300);
  const after = await js(`document.getElementById('list').scrollTop`);
  await sleep(300);
  check('2 no scrolling after the drop', after === await js(`document.getElementById('list').scrollTop`));
  check('2 drag visuals cleaned up', (await js(`document.querySelectorAll('.drag-ghost, .drop-highlight, .drop-target, .dragging').length`)) === 0);

  // 3 — project header dragged to the top edge scrolls up; reorder before the first project
  const lastProj = 'p' + (N - 2);
  await js(`(() => { const h = document.querySelector('.project[data-project-id="${lastProj}"] > .group-head'); h.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(100);
  const st3a = await js(`document.getElementById('list').scrollTop`);
  await js(`(() => { const h = document.querySelector('.project[data-project-id="${lastProj}"] > .group-head'); const r = h.getBoundingClientRect();
    const fire = (ty, x, y) => h.dispatchEvent(new PointerEvent(ty, { bubbles:true, cancelable:true, clientX:x, clientY:y, button:0, buttons:1, pointerId:2, isPrimary:true }));
    const cx = r.left + 40; window.__hx = cx; fire('pointerdown', cx, r.top + r.height/2); fire('pointermove', cx, r.top + r.height/2 - 12);
    const lr = document.getElementById('list').getBoundingClientRect(); fire('pointermove', cx, lr.top - 20); return true; })()`);
  const t3 = Date.now();
  while (Date.now() - t3 < 6000 && (await js(`document.getElementById('list').scrollTop`)) > 0) await sleep(100);
  check('3 project drag past the top edge scrolls all the way up', st3a > 0 && (await js(`document.getElementById('list').scrollTop`)) === 0, 'from ' + st3a);
  await sleep(150);
  check('3 insertion line shows above the first project', (await js(`(() => { const l = document.querySelector('.project-drop-line'); return !!l && l.nextElementSibling === document.querySelector('.project[data-project-id="p0"]'); })()`)) === true);
  await snap('sda-reorder-top.png');
  await js(`document.querySelector('.project[data-project-id="${lastProj}"] > .group-head').dispatchEvent(new PointerEvent('pointerup', { bubbles:true, button:0, pointerId:2 }))`);
  await sleep(400);
  check('3 the project moved to the top', (await js(`document.querySelector('.project.is-project').dataset.projectId`)) === lastProj);

  cws.close(); chrome.kill(); ctl.close(); await server.close?.();
  console.log(fail === 0 ? 'ALL PASS' : fail + ' FAILURES');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR: ' + e.message); process.exit(2); });

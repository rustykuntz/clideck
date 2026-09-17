// Gate: the HTML preview bridge. A sandboxed, opaque-origin frame the host cannot reach into — so the mark is
// made by a host-owned script INLINED ahead of the document, talking postMessage.
//
// What only a browser can tell you here:
//   • that injecting the bridge did not change the author's document — standards mode kept, their scripts
//     still run, their styles still apply, their relative urls still resolve, their globals do not collide;
//   • that the mark actually paints INSIDE the frame, asserted in the frame's own context;
//   • that the frame is never trusted: a forged "ready" from the author's own script disarms the mark rather
//     than steering it, and a document that rewrites its text takes the mark away instead of moving it.
const { mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.GATE_OUT || tmpdir();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (n, ok, extra) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + n + (extra !== undefined ? '  [' + extra + ']' : '')); if (!ok) fail++; };

// An author's document that is deliberately awkward: a doctype, its own script, its own globals with OUR
// names, a stylesheet, and a relative image.
const PAGE = `<!doctype html>
<html><head><title>Report</title>
<style>#verdict { color: rgb(9, 130, 60); }</style>
<script>
  const MAX_VIEWER_TEXT = 7;
  const SILENT_TAGS = "mine";
  function textParts() { return "author's own"; }
  window.__authorRan = MAX_VIEWER_TEXT + SILENT_TAGS.length + textParts().length;
<\/script>
</head><body>
<h1>Release report</h1>
<p id="verdict">The build is green and the reader is ready for review.</p>
<img src="mark.png" alt="" width="8" height="8">
<p>Ship it when the checks pass.</p>
</body></html>`;

(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pv-data-'));
  const projDir = mkdtempSync(join(tmpdir(), 'pv-proj-'));
  writeFileSync(join(projDir, 'report.html'), PAGE);
  writeFileSync(join(dataDir,'config.json'),JSON.stringify({onboarding:{completed:true,seenTips:['guided-tour','about-me']}}));
  const template = execFileSync(process.execPath,[join(__dirname,'../../bin/clideck.js'),'show','--template'],{encoding:'utf8'});
  const themed = template.replace('</head>', '<script>window.__firstTheme=document.documentElement.getAttribute("data-clideck-theme");<\/script></head>');
  const themePath=join(projDir,'themed.html');writeFileSync(themePath,themed);
  writeFileSync(join(projDir, 'mark.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
  const server = new HeadlessServer({ port: 0, dataDir });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const ctl = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  const events = [];
  ctl.on('message', d => { try { events.push(JSON.parse(d)); } catch {} });
  await new Promise((res, rej) => { ctl.on('open', res); ctl.on('error', rej); });
  ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'preview', cwd: projDir }));
  const sid = await new Promise((res, rej) => { const t0 = Date.now(); const iv = setInterval(() => {
    const hit = events.find(e => e.type === 'session.created' && e.name === 'preview');
    if (hit) { clearInterval(iv); res(hit.sessionId); } else if (Date.now() - t0 > 12000) { clearInterval(iv); rej(new Error('no session')); } }, 40); });
  const show = (body) => fetch(base + '/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, ...body }) });

  const prof = mkdtempSync(join(tmpdir(), 'chrome-pv-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let cws;
  try {
  const portFile = join(prof, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(200);
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  cws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => { cws.on('open', res); cws.on('error', rej); });
  let seq = 0; const pending = new Map();
  // A sandboxed, opaque-origin frame is its own TARGET, so its scripts are not reachable from the page's
  // session at all. Attach to it flat and talk to it by sessionId — that is the only way to assert anything
  // about the author's own document from out here.
  let frameSession = '';
  cws.on('message', d => { const m = JSON.parse(d);
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') frameSession = m.params.sessionId;
    if (m.method === 'Target.detachedFromTarget' && m.params.sessionId === frameSession) frameSession = '';
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const cmd = (m, p = {}, sessionId) => new Promise((res) => { const id = ++seq; pending.set(id, res);
    cws.send(JSON.stringify(sessionId ? { id, method: m, params: p, sessionId } : { id, method: m, params: p })); });
  const js = async (expr, sessionId) => (await cmd('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const snap = async (name) => { const s = await cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); console.log('  captured ' + name); };
  const inFrame = async (expr) => (frameSession ? js(expr, frameSession) : undefined);
  const startRead = (payload) => js(`(async () => (await import('/js/ui/read-along.js')).startReadAlong(${JSON.stringify(payload)}))()`);
  const tick = async (seconds) => { await js(`(async () => { const m = await import('/js/ui/read-along.js'); m.updateReadAlong(${seconds}, true); return true; })()`); await sleep(450); };
  const stop = () => js(`(async () => { (await import('/js/ui/read-along.js')).stopReadAlong(); return true; })()`);

  await cmd('Page.enable');
  await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  for (const scheme of ['dark', 'light']) {
    console.log('\n── ' + scheme + ' ──');
    frameSession = '';
    await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await cmd('Page.navigate', { url: base });
    await sleep(4500);
    await show({ path: join(projDir, 'report.html') });
    await sleep(2200);

    // ── the author's document is still the author's document ──────────────────────────────────────
    check('0 the preview is its own sandboxed target, reachable only as one', !!frameSession, frameSession || 'none');
    check('1 the DOCTYPE survived: standards mode, not quirks',
      (await inFrame(`document.compatMode`)) === 'CSS1Compat', await inFrame(`document.compatMode`));
    check('2 the author\'s own script still ran', (await inFrame(`window.__authorRan`)) === 7 + 4 + 12,
      String(await inFrame(`window.__authorRan`)));
    check('3 their globals kept THEIR values, despite sharing our names',
      (await inFrame(`MAX_VIEWER_TEXT + "/" + SILENT_TAGS + "/" + textParts()`)) === "7/mine/author's own",
      await inFrame(`MAX_VIEWER_TEXT + "/" + SILENT_TAGS`));
    check('4 their stylesheet still applies',
      (await inFrame(`getComputedStyle(document.getElementById('verdict')).color`)) === 'rgb(9, 130, 60)');
    // Relative urls resolve exactly where they always did. They do not FIND anything — an asset is served at
    // /content/<id>, not from a directory, so a sibling file was never reachable — but that is the engine's
    // url scheme and not something the bridge is allowed to change. The invariant is "identical", not "works".
    const relative = await inFrame(`document.querySelector('img').src`);
    check('5 a relative url resolves exactly where it did before the bridge',
      relative === base + '/content/mark.png', relative);
    check('6 and the bridge is there, without the author being able to see the host',
      (await inFrame(`typeof docTextIndex`)) === 'undefined', 'shared code stays inside its own function');

    // ── the mark, made in a frame the host cannot touch ───────────────────────────────────────────
    const text = await js(`(async () => (await import('/js/ui/content-dock.js')).getActiveViewerTextSnapshot())()`);
    check('7 the host reads the document out of its own parse', !!text && /Release report/.test(text.text) && text.kind === 'html');
    const words = 'The build is green';
    const at = text.text.indexOf(words);
    check('8 a reading of it resolves, which means the frame AGREED on the text',
      (await startRead({ surface: 'viewer', sessionId: sid, contentId: text.id, sourceText: words, sourceOffset: at,
        timing: 'estimated', cues: [{ start: 0, end: 1, textStart: 0, textEnd: words.length }] })) === true, `offset ${at}`);
    await tick(0.2);
    const painted = await inFrame(`(() => { const set = CSS.highlights.get('read-along'); if (!set) return null;
      const out = []; for (const r of set) out.push(r.toString()); return out; })()`);
    check('9 and the mark is painted INSIDE the frame, on the words it claims',
      Array.isArray(painted) && painted.length === 1 && /The build is green/.test(painted[0]), JSON.stringify(painted));
    await snap(`preview-${scheme}.png`);
    await stop();
    check('10 the host keeps ONE live preview for the document, not a graveyard of replaced frames',
      (await js(`(async () => (await import('/js/ui/content-dock.js')).__previewsForTest())()`)).length === 1);
    check('11 stopping clears it in there too', (await inFrame(`!CSS.highlights.get('read-along')`)) === true);

    // ── the frame is never trusted ────────────────────────────────────────────────────────────────
    // event.source proves which FRAME spoke, never which script inside it. The author's own code can forge
    // anything the bridge sends, so a forged text agreement must DISARM the mark, never redirect it.
    await inFrame(`parent.postMessage({ ck: 'ready', fp: 'not-the-document' }, '*'); true`);
    await sleep(500);
    check('12 a forged agreement from the page takes the mark away rather than steering it',
      (await startRead({ surface: 'viewer', sessionId: sid, contentId: text.id, sourceText: words, sourceOffset: at,
        cues: [{ start: 0, end: 1, textStart: 0, textEnd: words.length }] })) === false);
    check('13 and nothing is painted', (await inFrame(`!CSS.highlights.get('read-along')`)) === true);
    await stop();

    // A document that rewrites its own text invalidates every offset the host holds.
    await cmd('Page.navigate', { url: base });
    await sleep(4200);
    await show({ path: join(projDir, 'report.html') });
    await sleep(2200);
    const again = await js(`(async () => (await import('/js/ui/content-dock.js')).getActiveViewerTextSnapshot())()`);
    check('14 a fresh preview agrees again', (await startRead({ surface: 'viewer', sessionId: sid, contentId: again.id,
      sourceText: words, sourceOffset: again.text.indexOf(words), cues: [{ start: 0, end: 1, textStart: 0, textEnd: words.length }] })) === true);
    await inFrame(`document.getElementById('verdict').textContent = 'Everything moved somewhere else entirely.'; true`);
    await sleep(250);
    await tick(0.2);
    check('15 a document that rewrote itself paints NOTHING, rather than marking words that moved',
      (await inFrame(`(() => { const s = CSS.highlights.get('read-along'); return !s || s.size === 0; })()`)) === true);
    await stop();
  }


  // Divider: real mouse events, including an off-center grab across the preview.
  const width = () => js(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
  const mouse = (type,x,y,extras={}) => cmd('Input.dispatchMouseEvent',{type,x,y,...extras});
  const prefs = mode => js(`import('/js/theme.js').then(m=>m.setThemePref(${JSON.stringify(mode)}))`);
  await cmd('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});await sleep(300);
  await js(`window.__dragEvents=[];for(const kind of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture','blur'])window.addEventListener(kind,e=>window.__dragEvents.push({kind,id:e.pointerId,x:e.clientX,target:e.target.id,dragging:document.body.classList.contains('resizing')}),true)`);
  await prefs('dark');await mouse('mouseMoved',343,120);await sleep(180);
  check('divider hover shows rounded Sessions percentage', await js(`document.querySelector('.resize-tooltip').textContent==='Sessions · 28%'&&getComputedStyle(document.querySelector('.resize-tooltip')).visibility==='visible'`));
  await snap('divider-dark.png');
  await mouse('mousePressed',343,120,{button:'left',clickCount:1});await mouse('mouseMoved',343,120,{button:'left',buttons:1});
  check('grabbing the edge of the handle does not jump',await width()===340);
  await mouse('mouseMoved',356,140,{button:'left',buttons:1});
  check('drag advances in five-pixel steps accounting for grab offset',await width()===355,await width());
  await mouse('mouseMoved',1100,140,{button:'left',buttons:1});
  check('drag remains captured over iframe and keeps maximum bound',await width()===560,await width());
  await mouse('mouseReleased',1100,140,{button:'left',clickCount:1});
  check('release persists and ends resizing',await js(`localStorage.getItem('clideck.sidebarW')==='560'&&!document.body.classList.contains('resizing')`));
  await mouse('mousePressed',560,120,{button:'left',clickCount:1});await mouse('mouseMoved',100,120,{button:'left',buttons:1});
  check('minimum bound is preserved',await width()===240,await width());
  await js(`document.querySelector('#resize-handle').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true}))`);
  await mouse('mouseReleased',100,120,{button:'left',clickCount:1});
  check('pointercancel persists width and clears drag',await js(`localStorage.getItem('clideck.sidebarW')==='240'&&!document.body.classList.contains('resizing')`));
  await mouse('mousePressed',240,120,{button:'left',clickCount:2});await mouse('mouseReleased',240,120,{button:'left',clickCount:2});
  check('double click restores the existing default',await width()===340);
  writeFileSync(join(OUT,'drag-trace.json'),JSON.stringify(await js('window.__dragEvents'),null,2));
  await prefs('light');await mouse('mouseMoved',340,120);await sleep(180);await snap('divider-light.png');
  await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:780,deviceScaleFactor:1,mobile:false});await sleep(300);await mouse('mouseMoved',340,120);
  check('narrow tooltip updates percent and remains within viewport',await js(`(()=>{const t=document.querySelector('.resize-tooltip'),r=t.getBoundingClientRect();return t.textContent==='Sessions · 81%'&&r.left>=0&&r.right<=innerWidth})()`));
  await snap('divider-narrow.png');
  await cmd('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});await sleep(300);

  // The fixed-color, unmarked author page must ignore theme changes entirely.
  await prefs('dark');await sleep(200);
  check('unmarked HTML never receives a theme attribute or loses its own color',await inFrame(`!document.documentElement.hasAttribute('data-clideck-theme')&&getComputedStyle(document.querySelector('#verdict')).color==='rgb(9, 130, 60)'`));
  await js(`document.querySelectorAll('.cd-tab-x').forEach(b=>b.click())`);await sleep(300);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
  await show({path:themePath,name:'Themed report'});await sleep(1300);
  check('marked preview uses CliDeck dark before author script, despite light OS',await inFrame(`window.__firstTheme==='dark'&&document.documentElement.getAttribute('data-clideck-theme')==='dark'&&getComputedStyle(document.documentElement).backgroundColor==='rgb(25, 26, 30)'`));
  check('sandbox stays opaque and script-only',await js(`document.querySelector('.ct-frame').getAttribute('sandbox')==='allow-scripts'`));
  await snap('themed-preview-dark.png');
  await prefs('light');await sleep(200);
  check('theme changes repaint the same document without reload',await inFrame(`window.__firstTheme==='dark'&&document.documentElement.getAttribute('data-clideck-theme')==='light'&&getComputedStyle(document.documentElement).backgroundColor==='rgb(245, 246, 248)'`));
  await snap('themed-preview-light.png');
  await inFrame(`window.postMessage({ck:'theme',theme:'dark'},'*')`);await sleep(100);
  check('a non-parent theme message is ignored in the actual iframe',await inFrame(`document.documentElement.getAttribute('data-clideck-theme')==='light'`));
  const sameWindow = await inFrame(`window.__identity='same-document';true`);
  await prefs('auto');await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await sleep(250);
  check('Auto follows live OS changes without rebuilding preview',sameWindow&&await inFrame(`document.documentElement.getAttribute('data-clideck-theme')==='dark'&&window.__identity==='same-document'`));
  await prefs('light');
  writeFileSync(themePath,themed.replace('<h1>Report</h1>','<h1>Updated report</h1>'));
  await show({path:themePath,name:'Themed report'});await sleep(1200);
  check('replacement gets the current theme before author script and releases old frame',await inFrame(`window.__firstTheme==='light'&&document.querySelector('h1').textContent==='Updated report'`));
  check('only the replacement remains registered',await js(`import('/js/ui/content-dock.js').then(m=>m.__previewsForTest().length===1)`));

  // Other sessions cache detached preview nodes. A theme change must not discard their bridge entry.
  ctl.send(JSON.stringify({type:'session.create',provider:'shell',name:'other',cwd:projDir}));
  for(let i=0;i<60&&!events.some(e=>e.type==='session.created'&&e.name==='other');i++)await sleep(100);
  const other=events.find(e=>e.type==='session.created'&&e.name==='other');if(!other)throw Error('No isolated second session');
  await js(`import('/js/store.js').then(m=>m.store.select(${JSON.stringify(other.sessionId)}))`);await sleep(300);
  await prefs('dark');
  check('a detached cached preview retains its registration',await js(`import('/js/ui/content-dock.js').then(m=>m.__previewsForTest().length===1)`));
  await js(`import('/js/store.js').then(m=>m.store.select(${JSON.stringify(sid)}))`);await sleep(1000);
  check('returning to the cached preview resyncs to the current theme',await inFrame(`document.documentElement.getAttribute('data-clideck-theme')==='dark'`));
  await cmd('Emulation.setDeviceMetricsOverride',{width:720,height:780,deviceScaleFactor:1,mobile:false});await sleep(300);
  check('plain HTML template fits the narrow preview without horizontal overflow',await inFrame(`document.documentElement.scrollWidth<=innerWidth`));
  await snap('themed-preview-narrow.png');
  await js(`document.querySelectorAll('.cd-tab-x').forEach(b=>b.click())`);await sleep(250);await prefs('light');
  check('closing a preview releases the theme/read-along registration',await js(`import('/js/ui/content-dock.js').then(m=>m.__previewsForTest().length===0)`));

  // The actual CLI template is self-contained and follows OS appearance when opened directly.
  await cmd('Emulation.setDeviceMetricsOverride',{width:720,height:780,deviceScaleFactor:1,mobile:false});
  await cmd('Page.navigate',{url:'file://'+themePath});await sleep(700);
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});await sleep(100);
  check('offline template auto follows dark OS',await js(`document.documentElement.getAttribute('data-clideck-theme')==='auto'&&getComputedStyle(document.documentElement).backgroundColor==='rgb(25, 26, 30)'`));
  await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});await sleep(100);
  check('offline template auto follows light OS',await js(`getComputedStyle(document.documentElement).backgroundColor==='rgb(245, 246, 248)'`));
  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED'));
  } finally {
    try { chrome.kill(); } catch {}
    ctl.close(); if(cws)cws.close(); await server.close();
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('ERR ' + e.stack); process.exit(1); });

// Real mouse regression for terminal links; isolated engine, shell and Chrome only.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-linkmenu-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'linkmenu-data-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'linkmenu-files-')));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  writeFileSync(join(cwd, 'notes.md'), '# Notes\n\n[Example](https://example.com/)\n');
  writeFileSync(join(cwd, 'notes.txt'), 'Plain text document\n');
  writeFileSync(join(cwd, 'notes.html'), '<!doctype html><html><body><a href="https://example.com/">Example</a></body></html>');
  const server = new HeadlessServer({ port: 0, dataDir });
  let chrome, ctl, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;
    ctl = new WebSocket(base.replace('http:', 'ws:'));
    const events = [];
    ctl.on('message', raw => { try { events.push(JSON.parse(raw)); } catch {} });
    await new Promise(r => ctl.on('open', r));
    ctl.send(JSON.stringify({ type: 'session.create', provider: 'shell', name: 'links', cwd }));
    for (let i=0; i<100 && !events.some(e=>e.type==='session.created'); i++) await sleep(100);
    const sid = events.find(e=>e.type==='session.created').sessionId;
    const profile = mkdtempSync(join(tmpdir(), 'linkmenu-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i=0; i<100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r=>cws.on('open',r));
    let seq=0; const pending=new Map();
    cws.on('message', raw=> {const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},12000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});cws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const snap=async name=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(s.data,'base64'));};
    const mouse=async(point,button='right',modifiers=0)=>{await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+12,y:point.y+20});await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(250);await cmd('Input.dispatchMouseEvent',{type:'mousePressed',...point,button,modifiers,buttons:button==='right'?2:1,clickCount:1});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button,modifiers,buttons:0,clickCount:1});await sleep(450);};
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{}return send.call(this,data)};window.opened=[];window.open=(...args)=>{opened.push(args);return {opener:null}};})()`);
    const place=async text=>{
      await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:10});
      await js(`(async()=>{(await import('/js/ui/menu.js')).closeMenu();document.querySelector('.cd-tab')?.click();term.reset();await new Promise(r=>term.write(${JSON.stringify(text+'\r\n')},r));(await import('/js/ui/paths.js')).probe(store.activeId,[${JSON.stringify(text)}]);})()`);
      await sleep(600);
      return js(`(()=>{const r=term.element.querySelector('.xterm-screen').getBoundingClientRect();const c=term._core._renderService.dimensions.css.cell;return {x:r.left+c.width*2.5,y:r.top+c.height/2}})()`);
    };
    const labels=()=>js(`[...document.querySelectorAll('.menu-item')].map(e=>e.textContent)`);
    const countOpens=()=>js(`sent.filter(e=>e.type==='content.open').length`);
    for(const file of ['notes.md','notes.txt','notes.html']) {
      for(const [button,modifiers,name] of [['right',0,'right-click'],['left',2,'Mac Control-click']]) {
        const point=await place(file), before=await countOpens();
        await mouse(point,button,modifiers);
        check(file+' '+name+' does not open preview',await countOpens()===before);
        check(file+' '+name+' keeps text menu', (await labels()).slice(0,2).join('|')==='Copy|Paste',await labels());
        await js(`(async()=>{(await import('/js/ui/menu.js')).closeMenu()})()`);
        await mouse(point,'left');
        check(file+' next left-click opens inside CliDeck',await countOpens()===before+1);
      }
      const tabPoint=await js(`(()=>{const e=[...document.querySelectorAll('.cd-tab')].find(e=>e.textContent.includes(${JSON.stringify(file)}));const r=e.getBoundingClientRect();return{x:r.left+24,y:r.top+r.height/2}})()`);
      await mouse(tabPoint);
      check(file+' tab menu only offers Copy file path',(await labels()).join('|')==='Copy file path',await labels());
    }
    const urlPoint=await place('https://example.com/notes.md');
    const beforeUrl=await js('opened.length');
    for(const [button,modifiers] of [['right',0],['left',2]]) {
      await mouse(urlPoint,button,modifiers);
      check('URL context click does not navigate',await js('opened.length')===beforeUrl);
      await js(`(async()=>{(await import('/js/ui/menu.js')).closeMenu()})()`);
    }
    await mouse(urlPoint,'left');
    check('URL normal left-click still opens browser',await js('opened.length')===beforeUrl+1&&await js('opened.at(-1)[0]')==='https://example.com/notes.md');
    await mouse(urlPoint,'middle');
    check('middle button does not trigger left-click action',await js('opened.length')===beforeUrl+1);
    const plain=await place('plain text selected');await js('term.select(0,0,10)');await mouse(plain);
    check('right-click preserves selection and existing text actions',await js('term.getSelection()')==='plain text'&&(await labels()).slice(0,2).join('|')==='Copy|Paste');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    check('Escape closes menu',!await js("!!document.querySelector('.menu')"));
    const shiftPoint=await place('notes.md'), beforeShift=await countOpens();await mouse(shiftPoint,'right',8);
    check('Shift right-click keeps native menu without opening preview',await countOpens()===beforeShift&&!await js("!!document.querySelector('.menu')"));
    await js(`[...document.querySelectorAll('.cd-tab')].find(e=>e.textContent.includes('notes.md')).click()`);await sleep(300);
    const anchor=await js(`(()=>{const a=document.querySelector('.md a');const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2});a.dispatchEvent(e);return{native:!e.defaultPrevented,menu:!!document.querySelector('.menu')}})()`);
    check('Markdown body links keep native menu',anchor?.native&&!anchor.menu);
    await js(`[...document.querySelectorAll('.cd-tab')].find(e=>e.textContent.includes('notes.html')).click()`);await sleep(500);
    const htmlPoint=await js(`(()=>{const r=document.querySelector('iframe.ct-frame').getBoundingClientRect();return{x:r.left+20,y:r.top+16}})()`);
    const targets=(await cmd('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length;await mouse(htmlPoint);
    check('HTML body right-click keeps native menu without opening page',!await js("!!document.querySelector('.menu')")&&(await cmd('Target.getTargets')).targetInfos.filter(t=>t.type==='page').length===targets);
    for(const theme of ['dark','light']) {
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref(${JSON.stringify(theme)})})()`);
      const point=await place('notes.md');await mouse(point);await snap('text-menu-'+theme+'.png');
      check(theme+' text menu fits viewport',await js(`(()=>{const r=document.querySelector('.menu').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
    }
    await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:800,deviceScaleFactor:1,mobile:false});await sleep(300);
    const point=await place('notes.md');await mouse(point);await snap('text-menu-narrow.png');
    check('narrow text menu fits viewport',await js(`(()=>{const r=document.querySelector('.menu').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`));
  } finally {
    cws?.close();ctl?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);
    process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

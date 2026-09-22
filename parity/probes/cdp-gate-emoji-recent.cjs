// Real F7 emoji picker, Worker and terminal insertion; isolated engine/profile/shell only.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-emoji-recent-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'emoji-recent-data-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'emoji-recent-files-')));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: { emoji: { enabled: true, settings: { shortcut: 'F7' } } }, onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
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
    const profile = mkdtempSync(join(tmpdir(), 'emoji-recent-chrome-'));
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
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Page.enable');await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cmd('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',platform:'Linux x86_64'});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{sent.push(JSON.parse(data))}catch{}return send.call(this,data)};})()`);
    const key = async (key,code,n) => {
      await cmd('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n});
      await cmd('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n});await sleep(200);
    };
    const open = async()=>{await js('term.focus()');await key('F7','F7',118);};
    const focus = ()=>js(`document.activeElement?.dataset.itemId || document.activeElement?.className`);
    await open();
    check('F7 without recents focuses search',await focus()==='pk-input');
    await js(`document.querySelector('.pk-item[data-item-id="rocket"]').click()`);await sleep(250);
    check('selection saves recent emoji',await js(`JSON.parse(localStorage.getItem('clideck.picker.emoji.emoji.recent'))[0]==='rocket'`));
    await open();check('F7 focuses most recent emoji',await focus()==='rocket');
    await js('sent=[]');await key('Enter','Enter',13);
    check('Enter inserts recent emoji once without submitting',await js(`JSON.stringify(sent.filter(e=>e.type==='input').map(e=>e.data))===JSON.stringify(['\\x1b[200~🚀\\x1b[201~'])`));
    check('selection closes picker and returns terminal focus',await js(`!document.querySelector('.pk-overlay')&&document.activeElement===term.textarea`));
    await open();await key('ArrowRight','ArrowRight',39);check('arrows still navigate choices',await focus()==='smile');
    await key('Escape','Escape',27);check('Escape restores terminal focus',await js(`document.activeElement===term.textarea&&!document.querySelector('.pk-overlay')`));
    await js(`localStorage.setItem('clideck.picker.emoji.emoji.recent','["removed","rocket"]')`);await open();
    check('invalid recent skipped',await focus()==='rocket');
    await key('ArrowUp','ArrowUp',38);check('ArrowUp returns to search',await focus()==='pk-input');
    await key('Escape','Escape',27);
    await js(`localStorage.setItem('clideck.picker.emoji.emoji.recent','["removed"]')`);await open();check('all invalid recents fall back to search',await focus()==='pk-input');await key('Escape','Escape',27);
    await js(`localStorage.setItem('clideck.picker.emoji.emoji.recent','["rocket","smile"]')`);
    for(const theme of ['dark','light']) {
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref('${theme}')})()`);await open();await sleep(250);await snap('emoji-recent-'+theme+'.png');await key('Escape','Escape',27);
    }
    await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:800,deviceScaleFactor:1,mobile:false});await open();await sleep(250);await snap('emoji-recent-narrow.png');
    check('narrow picker keeps recent focus and fits viewport',await focus()==='rocket'&&await js(`(()=>{const r=document.querySelector('.pk-modal').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));
  } finally {
    cws?.close();ctl?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

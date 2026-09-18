// Document Reload: actual disk changes under the same asset, isolated engine and browser.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, renameSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-refresh-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
function pdf(text) {
  const stream=`BT /F1 12 Tf 20 40 Td (${text}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let result='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=Buffer.byteLength(result);result+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return result;
}
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'refresh-data-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-files-')));
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
    const profile = mkdtempSync(join(tmpdir(), 'refresh-chrome-'));
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
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.select(${JSON.stringify(sid)});window.tm=await import('/js/ui/terminal.js');window.term=tm.__termForTest();window.keepTerminal=term.element;window.sent=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{sent.push(JSON.parse(d))}catch{}return send.call(this,d)};window.requests=[];const originalFetch=window.fetch;window.fetch=(...args)=>{requests.push(String(args[0]));return originalFetch(...args)};})()`);
    const show=async file=>{const r=await fetch(base+'/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,path:join(cwd,file)})});if(!r.ok)throw new Error(await r.text());await sleep(650);return r.json();};
    const refresh=async()=>{const p=await js(`(()=>{const r=document.querySelector('.cd-dock-refresh').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);await cmd('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await sleep(650);};
    const replaceFile=(file,data)=>{writeFileSync(join(cwd,file+'.new'),data);renameSync(join(cwd,file+'.new'),join(cwd,file));};
    const visibleText=()=>js(`document.querySelector('#pane-body .cd-render:not([hidden])')?.textContent`);
    check('terminal has no Reload',!await js(`!!document.querySelector('.cd-dock-refresh')`));
    await show('notes.md');
    await js(`document.querySelectorAll('.md-seg button')[1].click();window.mdNode=document.querySelector('.md-shell');window.tabLabels=[...document.querySelectorAll('.cd-tab-name')].map(e=>e.textContent)`);
    replaceFile('notes.md','# Updated from disk\n\nNew Markdown text.');await refresh();
    check('Markdown reload reads actual disk change', (await visibleText()).includes('# Updated from disk'));
    check('Markdown source choice and tab names survive',await js(`document.querySelectorAll('.md-seg button')[1].classList.contains('on')&&JSON.stringify(tabLabels)===JSON.stringify([...document.querySelectorAll('.cd-tab-name')].map(e=>e.textContent))`));
    check('focus follows replacement Reload',await js(`document.activeElement===document.querySelector('.cd-dock-refresh')`));
    await js(`document.querySelectorAll('.md-seg button')[0].click()`);replaceFile('notes.md','# Rendered update');await refresh();
    check('Markdown rendered choice survives',await js(`document.querySelectorAll('.md-seg button')[0].classList.contains('on')&&document.querySelector('.md h1').textContent==='Rendered update'`));
    await js(`window.savedMarkdown=document.querySelector('.md-shell')`);
    await show('notes.txt');replaceFile('notes.txt','Text saved after opening');await refresh();
    check('text reload reads actual disk change',(await visibleText()).includes('Text saved after opening'));
    check('other document and terminal survive',await js(`savedMarkdown.isConnected&&term.element===keepTerminal&&keepTerminal.isConnected`));
    const urls=[];for(let i=0;i<3;i++){await refresh();urls.push(await js('requests.filter(u=>u.startsWith("/content/")).at(-1)'));}
    check('repeated refresh uses unique bounded query',new Set(urls).size===3&&urls.every(u=>new URL(u,base).searchParams.getAll('r').length===1));
    await js(`window.realFetch=window.fetch;window.delayed=[];window.fetch=(url,...rest)=>String(url).startsWith('/content/')?new Promise(resolve=>delayed.push(resolve)):realFetch(url,...rest)`);
    await refresh();await refresh();
    await js(`delayed[1](new Response('Newest response'));`);await sleep(100);
    await js(`delayed[0](new Response('Old response'));window.fetch=realFetch`);await sleep(100);
    check('older pending text fetch cannot win',(await visibleText()).includes('Newest response')&&!(await visibleText()).includes('Old response'));
    await js(`window.fetch=(url,...rest)=>String(url).startsWith('/content/')?Promise.reject(new Error('Temporary network failure')):realFetch(url,...rest)`);
    await refresh();check('failed fetch shows existing load error',await js(`!!document.querySelector('.cd-render:not([hidden]) .cd-error')`));
    await js(`window.fetch=realFetch`);replaceFile('notes.txt','Restored connection');await refresh();check('refresh retries after temporary fetch failure',(await visibleText()).includes('Restored connection'));
    const png=async(w,h)=>Buffer.from(await js(`(()=>{const c=document.createElement('canvas');c.width=${w};c.height=${h};c.getContext('2d').fillRect(0,0,c.width,c.height);return c.toDataURL().split(',')[1]})()`),'base64');
    writeFileSync(join(cwd,'image.png'),await png(8,6));await show('image.png');check('image initially decodes',await js(`document.querySelector('.ct-img').naturalWidth===8`));
    replaceFile('image.png',await png(12,9));await refresh();check('image reload decodes changed file',await js(`document.querySelector('.ct-img').naturalWidth===12&&document.querySelector('.ct-img').naturalHeight===9`));
    writeFileSync(join(cwd,'report.pdf'),pdf('Before'));await show('report.pdf');
    const oldPdf=await js(`document.querySelector('.ct-pdf').src`);replaceFile('report.pdf',pdf('After'));await refresh();
    const pdfUrl=await js(`document.querySelector('.ct-pdf').src`);
    check('PDF reload changes frame URL and serves current file',pdfUrl!==oldPdf&&(await(await fetch(pdfUrl)).text()).includes('After'));
    const video=async size=>Buffer.from(await js(`(async()=>{const c=document.createElement('canvas');c.width=${size};c.height=${size};c.getContext('2d').fillRect(0,0,c.width,c.height);const stream=c.captureStream(10),r=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];r.ondataavailable=e=>chunks.push(e.data);const done=new Promise(resolve=>r.onstop=resolve);r.start();await new Promise(resolve=>setTimeout(resolve,250));r.stop();await done;stream.getTracks().forEach(t=>t.stop());const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());return btoa(String.fromCharCode(...bytes))})()`),'base64');
    writeFileSync(join(cwd,'clip.webm'),await video(16));await show('clip.webm');check('video initially loads metadata',await js(`document.querySelector('.ct-video').videoWidth===16`));
    replaceFile('clip.webm',await video(24));await refresh();check('video reload reads new media metadata',await js(`document.querySelector('.ct-video').videoWidth===24`));
    await show('notes.html');
    replaceFile('notes.html','<!doctype html><html data-clideck-theme="auto"><body>Refreshed HTML</body></html>');await refresh();
    check('HTML reload preserves sandbox and bridge',await js(`(()=>{const f=document.querySelector('.ct-frame');return f.getAttribute('sandbox')==='allow-scripts'&&f.srcdoc.includes('Refreshed HTML')&&f.srcdoc.includes('initialPreviewTheme')})()`));
    for(const theme of ['dark','light']){
      await js(`(async()=>{(await import('/js/theme.js')).setThemePref(${JSON.stringify(theme)});[...document.querySelectorAll('.cd-tab')].find(e=>e.textContent.includes('notes.md')).click()})()`);await refresh();await snap('reload-'+theme+'.png');
      check(theme+' Reload stays far right',await js(`(()=>{const b=document.querySelector('.cd-dock-refresh');return b.parentNode.lastElementChild===b&&b.getBoundingClientRect().right<=innerWidth})()`));
    }
    await cmd('Emulation.setDeviceMetricsOverride',{width:600,height:800,deviceScaleFactor:1,mobile:false});await sleep(200);await snap('reload-narrow.png');
    check('narrow Reload stays visible',await js(`(()=>{const r=document.querySelector('.cd-dock-refresh').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));
    check('reload never opens/closes another asset',await js(`!sent.some(e=>e.type==='content.open'||e.type==='content.close')`));
    await js(`document.querySelector('.cd-tab-term').click()`);check('terminal still has no Reload',!await js(`!!document.querySelector('.cd-dock-refresh')`));
  } finally {
    cws?.close();ctl?.close();chrome?.kill();await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);
    process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

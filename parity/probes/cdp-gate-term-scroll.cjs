const fs = require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
// Synthetic controls only: no model, live session, or private replay file is used.
const ROOT=join(__dirname,'../..');
const {HeadlessServer}=require(join(ROOT,'src/server'));
const WS=require(join(ROOT,'node_modules/ws'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const dataDir=fs.mkdtempSync(join(tmpdir(),'clideck-scroll-data-'));
 fs.writeFileSync(join(dataDir,'config.json'),JSON.stringify({onboarding:{completed:true,seenTips:['guided-tour','about-me']}}));
 const server=new HeadlessServer({dataDir,port:0});
 server.persistence.importMissing([{id:'scroll-repro',name:'Synthetic reply',provider:'codex',cwd:tmpdir(),cols:132,rows:33}]);
 const profile='scroll-repro-'+process.pid;
 const para=async(...args)=>(await run('paratab',['--profile',profile,...args],{timeout:20000})).stdout;
 let cdp,created=false;
 try{
 const addr=await server.listen();const base=`http://127.0.0.1:${addr.port}`;
 const info=JSON.parse((await run('paratab',['profile','create',profile,'--temporary','--headless'])).stdout);created=true;
 await para('start');await para('open',JSON.stringify({worker_id:'scroll',url:'about:blank'}));
 const tabs=await(await fetch(`http://127.0.0.1:${info.port}/json/list`)).json();
 cdp=new WS(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>cdp.once('open',r));
 let seq=0;const pending=new Map();cdp.on('message',raw=>{const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
 const call=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);cdp.send(JSON.stringify({id,method,params}));});
 const js=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result?.result?.value;};
 await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1400,height:850,deviceScaleFactor:1,mobile:false});
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__resize=[];const send=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{const m=JSON.parse(d);if(m.type==='resize')window.__resize.push(m)}catch{}return send.call(this,d)}`});
 await call('Page.navigate',{url:base});await sleep(1800);
 const result=await js(`(async()=>{
 const {store}=await import('/js/store.js');const mod=await import('/js/ui/terminal.js');store.select('scroll-repro');await new Promise(r=>setTimeout(r,400));
 const app=mod.__termForTest();window.__app=app;window.__store=store;
 const host=document.createElement('div');document.body.append(host);const native=new Terminal({cols:132,rows:33,allowProposedApi:true,scrollback:10000});native.open(host);
 const write=(t,d)=>new Promise(r=>t.write(d,r));
 const seed=Array.from({length:26},(_,i)=>'\\x1b['+(i+1)+';1H\\x1b[2KREPLY-'+String(i+1).padStart(2,'0')).join('')+'\\x1b[28;1HCOMPOSER stays here\\x1b[29;1Hnext input';
 const scroll='\\x1b[1;26r\\x1b[29;11H\\x1b[10S';
 // The exact control sequence found when Codex grows its composer (text is synthetic).
 const grow='\\x1b[1;26r\\x1b[10S\\x1b[r\\x1b[17;1H\\x1b[J\\x1b[17;1HCOMPOSER grew\\x1b[18;1Hwrapped input';
 const snap=t=>{const b=t.buffer.active;return {base:b.baseY,view:b.viewportY,cursor:[b.cursorX,b.cursorY],lines:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true))}};
 const replies=s=>s.lines.filter(l=>/^REPLY-\\d{2}$/.test(l));
 const checks=[];const check=(name,pass)=>checks.push({name,pass:!!pass});
 const flush=()=>write(app,'');
 const feed=async d=>{store.applyEvent({type:'output',sessionId:'scroll-repro',data:d});await flush()};
 const reset=async(d=seed)=>{app.reset();store.active().outputBuf='';await feed(d)};
 await write(native,seed);await write(native,grow);const lost=snap(native);
 check('unmodified xterm reproduces deletion of the first ten reply lines',lost.base===0&&replies(lost).length===16&&replies(lost)[0]==='REPLY-11');
 await reset();const size=[app.cols,app.rows];window.__resize.length=0;
 let resets=0,resizes=0;const originalReset=app.reset.bind(app),originalResize=app.resize.bind(app);
 app.reset=(...a)=>{resets++;return originalReset(...a)};app.resize=(...a)=>{resizes++;return originalResize(...a)};
 await feed(grow);const kept=snap(app);
 check('the same Codex repaint retains all 26 reply lines in the app',kept.base===10&&replies(kept).length===26&&replies(kept)[0]==='REPLY-01');
 check('raw store output retains every reply marker',Array.from({length:26},(_,i)=>'REPLY-'+String(i+1).padStart(2,'0')).every(s=>store.active().outputBuf.includes(s)));
 check('loss/recovery needs no resize, reset, ED2 or ED3',resets===0&&resizes===0&&window.__resize.length===0&&!/\\x1b\\[(2|3)J/.test(seed+grow));
 check('composer repaints at its requested screen row',kept.lines[kept.base+16]==='COMPOSER grew'&&kept.lines[kept.base+17]==='wrapped input');
 app.reset=originalReset;app.resize=originalResize;
 await reset();await feed('\\x1b[29;11H');const cursor=snap(app).cursor;const marker=app.registerMarker(-28);
 await feed(scroll);
 check('scroll preserves the cursor and rows below the region',JSON.stringify(snap(app).cursor)===JSON.stringify(cursor)&&snap(app).lines[app.buffer.active.baseY+27]==='COMPOSER stays here');
 check('markers follow retained history',marker.line===0&&!marker.isDisposed);marker.dispose();
 for(const [save,restore] of [['\\x1b7','\\x1b8'],['\\x1b[s','\\x1b[u']]){
 await reset();await feed('\\x1b[29;7H'+save+'\\x1b[1;26r\\x1b[10S\\x1b[r'+restore+'RESTORED');
 check('saved cursor remains on its original input row ('+(save.endsWith('7')?'DEC':'CSI')+')',app.buffer.active.cursorY===28&&app.buffer.active.getLine(app.buffer.active.baseY+28).translateToString(true).includes('RESTORED'));
 }

 await reset();await feed('\\x1b[1;26r\\x1b[41m\\x1b[S');
 check('default count scrolls one line and retains erase background',app.buffer.active.baseY===1&&app.buffer.active.getLine(app.buffer.active.baseY+25).getCell(0).getBgColor()===1);
 await feed('\\x1b[0S');check('zero count also scrolls one line',app.buffer.active.baseY===2);
 await reset();await feed('\\x1b[1;26r\\x1b[2147483647S');
 check('huge counts are bounded to the region height',app.buffer.active.baseY===26&&replies(snap(app)).length===26);
 await reset();await feed('\\x1b[1;26r\\x1b[1');await feed('0S');
 check('split output chunks still preserve reply history',app.buffer.active.baseY===10&&replies(snap(app)).length===26);
 await reset();native.reset();await write(native,seed);
 const interior='\\x1b[3;26r\\x1b[10S';await feed(interior);await write(native,interior);
 check('non-top regions keep native behavior',app.buffer.active.baseY===0&&JSON.stringify(snap(app).lines.slice(0,33))===JSON.stringify(snap(native).lines));
 await reset();native.reset();const alt='\\x1b[?1049h'+seed+scroll;await feed(alt);await write(native,alt);
 check('alternate screen keeps native behavior without history',app.buffer.active.type==='alternate'&&app.buffer.active.baseY===0&&JSON.stringify(snap(app).lines.slice(0,33))===JSON.stringify(snap(native).lines));
 await feed('\\x1b[?1049l');
 await reset(Array.from({length:300},(_,i)=>'HISTORY-'+i+'\\r\\n').join('')+seed);
 await new Promise(r=>setTimeout(r,100));app.scrollToTop();await new Promise(r=>setTimeout(r,300));const view=snap(app).view;const top=snap(app).lines[view];await feed(scroll);
 window.__viewportTrace={before:view,after:app.buffer.active.viewportY,top,history:snap(app).lines.includes('HISTORY-0'),replies:replies(snap(app)).length};
 check('output preserves the scrolled-up viewport and long history',view===0&&app.buffer.active.viewportY===view&&snap(app).lines[view]===top&&snap(app).lines.includes('HISTORY-0')&&replies(snap(app)).length===26);
 // Low scrollback exercises xterm's native trim/marker path without thousands of writes.
 const limit=app.options.scrollback;app.options.scrollback=12;
 await reset(Array.from({length:80},(_,i)=>'OLD-'+i+'\\r\\n').join('')+seed);await feed(scroll);
 check('a full history buffer retains the newest reply and respects its limit',app.buffer.active.length===app.rows+12&&replies(snap(app)).length===26);
 app.options.scrollback=limit;
 await reset();await feed(grow);const replayBefore=snap(app);
 store.select('scroll-repro');await new Promise(r=>setTimeout(r,300));await flush();
 check('session reset and replay retain the same reply history',JSON.stringify(replies(snap(app)))===JSON.stringify(replies(replayBefore))&&app.buffer.active.baseY===10);
 // A deterministic no-model responder emits the observed composer-growth sequence on actual browser input.
 await reset(Array.from({length:300},(_,i)=>'HISTORY-'+i+'\\r\\n').join('')+seed);
 await new Promise(r=>setTimeout(r,100));app.scrollToTop();await new Promise(r=>setTimeout(r,300));app.focus();window.__resize.length=0;
 window.__inputTrace={resets:0,resizes:0,bytes:'',before:[app.cols,app.rows],viewportBefore:app.buffer.active.viewportY};
 app.reset=(...a)=>{window.__inputTrace.resets++;return originalReset(...a)};
 app.resize=(...a)=>{window.__inputTrace.resizes++;return originalResize(...a)};
 let input='';window.__inputHook=app.onData(d=>{input+=d;window.__inputTrace.bytes+=d;if(input.length>app.cols&&!window.__inputTrace.grew){window.__inputTrace.grew=true;store.applyEvent({type:'output',sessionId:'scroll-repro',data:grow+'\\x1b[19;1H'+input});}});
 window.__checks=checks;window.__snap=()=>snap(app);window.__replies=()=>replies(snap(app));
 native.dispose();host.remove();
 return {lost:replies(lost),kept:replies(kept),size,checks,viewport:window.__viewportTrace};})()`);
 await call('Input.insertText',{text:'typed next message '.repeat(12)});
 await js(`new Promise(r=>window.__app.write('',r))`);await sleep(250);
 const typed=await js(`(()=>{const t=window.__app,b=t.buffer.active;return {...window.__inputTrace,sent:window.__resize,replies:window.__replies(),after:[t.cols,t.rows],wrapped:b.getLine(b.baseY+19).isWrapped}})()`);
 result.checks.push({name:'real browser typing wraps input and retains all previous reply lines',pass:typed.viewportBefore===0&&typed.grew&&typed.wrapped&&typed.replies.length===26});
 result.checks.push({name:'typing and composer growth cause no terminal resize/reset or resize frame',pass:typed.resets===0&&typed.resizes===0&&typed.sent.length===0&&JSON.stringify(typed.before)===JSON.stringify(typed.after)});
 result.typing={...typed,bytes:typed.bytes.length};
 const out=process.env.GATE_OUT||fs.mkdtempSync(join(tmpdir(),'clideck-scroll-evidence-'));fs.mkdirSync(out,{recursive:true});
 await js(`window.__app.scrollToLine(window.__app.buffer.active.baseY-10)`);await sleep(300);
 const capture=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(join(out,'retained-history.png'),Buffer.from(capture.result.data,'base64'));
 fs.writeFileSync(join(out,'trace.json'),JSON.stringify(result,null,2));
 for(const c of result.checks)console.log((c.pass?'PASS ':'FAIL ')+c.name);
 console.log('Artifacts: '+out);console.log(result.checks.filter(c=>c.pass).length+'/'+result.checks.length+' passed');
 if(result.checks.some(c=>!c.pass))process.exitCode=1;
 }finally{cdp?.close();try{if(created)await para('stop','--close-browser');}finally{await server.close();}}
})().catch(e=>{console.error(e);process.exitCode=1});

// Task Manager browser proof: isolated engine with fake processes/signals; no live jobs or native agents.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { HeadlessServer } = require('../../src/server.js');
const WebSocket = require('ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = process.env.GATE_OUT || '/tmp/clideck-task-manager-ui';
mkdirSync(out, { recursive: true });
let fails = 0, passes = 0;
const check = (name, yes, detail) => { yes ? passes++ : fails++; console.log(`${yes ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'task-manager-data-'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ plugins: { emoji: { enabled: true, settings: { shortcut: 'F7' } } }, onboarding: { completed: true, seenTips: ['guided-tour', 'about-me'] } }));
  const { TaskManager } = require('../../src/task-manager');
  let scans = 0, now = Date.now(), stops = [];
  const proc = (pid, ppid, command, cpu, memory, uid=501) => ({pid,ppid,uid,pgid:pid,command,commandHash:command,cpu,memory,elapsed:'01:04:30',started:'Thu Oct 29 06:00:00 2026'});
  const manager = new TaskManager({ platform:'darwin', uid:501, enginePid:10, now:()=>now,
    sessions:()=>[{id:'research',name:'Strategy manager',project:'AI Trading',pid:20},{id:'video',name:'Video researcher',project:'Studio',pid:30}],
    collect:async()=>{scans++;return [proc(10,1,'node clideck',0.2,400e6),proc(20,10,'codex',0.1,180e6),proc(21,20,'python fetch_options.py --resume',98.7,950e6),proc(22,21,'python parquet_worker.py',21.4,300e6),proc(30,10,'claude',0.4,200e6),proc(31,30,'python score.py --workers 6',346.2,2.6e9),proc(32,31,'ffmpeg -i clip.mp4 <untrusted>',10.5,90e6),proc(40,1,'Google Chrome',0.3,400e6),proc(41,40,'Google Chrome Helper (Renderer)',125.3,1.2e9)];},
    readOwners:async()=>new Map(),signal:(pid,signal)=>stops.push([pid,signal])});
  const server = new HeadlessServer({ port: 0, dataDir, taskManager:manager });
  let chrome, cws;
  try {
    const address = await server.listen(), base = `http://127.0.0.1:${address.port}`;

    const profile = mkdtempSync(join(tmpdir(), 'task-manager-chrome-'));
    chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i=0; i<100 && !existsSync(portFile); i++) await sleep(100);
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'})).json();
    cws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r=>cws.on('open',r));
    let seq=0; const pending=new Map(), errors=[];
    cws.on('message', raw=> {const m=JSON.parse(raw);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
    const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},12000);pending.set(id,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});cws.send(JSON.stringify({id,method,params}));});
    const js=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    const snap=async name=>{const s=await cmd('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(s.data,'base64'));};
    await cmd('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await cmd('Runtime.enable');await cmd('Page.enable');await cmd('Emulation.setFocusEmulationEnabled',{enabled:true});
    await cmd('Emulation.setUserAgentOverride',{userAgent:'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',platform:'Linux x86_64'});
    await cmd('Page.navigate',{url:base});await sleep(2200);
    await js(`(async()=>{window.store=(await import('/js/store.js')).store;store.applyEvent({type:'session.created',sessionId:'synthetic',provider:'shell',live:false,cwd:'/tmp',name:'Task Manager test'});store.select('synthetic');window.openTasks=()=>import('/js/ui/task-manager.js').then(m=>m.openTaskManager());window.choose=(label,value)=>{const s=document.querySelector('[aria-label="'+label+'"]');if(s.tagName!=='SELECT')return s.querySelector('[data-value="'+value+'"]').click();s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));};})()`);
    check('zero process scans while Task Manager is closed',scans===0,scans);
    await js('openTasks()');await sleep(300);
    check('agent/process groups and aggregate CPU are rendered',await js("document.querySelector('.tasks-stat strong').textContent==='6'&&document.querySelector('.tasks-summary').textContent.includes('18 cores')&&document.querySelector('.tasks-table').textContent.includes('AI Trading / Strategy manager')&&document.querySelector('.tasks-table').textContent.includes('Studio / Video researcher')"));
    check('agents keep a stable A–Z order (project, then session), not a CPU race',await js("[...document.querySelectorAll('.tasks-group')].map(g=>g.textContent.split('%')[0]).join('|').startsWith('AI Trading / Strategy manager')"));
    // Sortable headers: one sort for agents and jobs; click reverses; the choice survives reopening.
    await js(`window.groupsOrder=()=>[...document.querySelectorAll('.tasks-group .tasks-group-project')].map(n=>n.textContent).join('|');window.sortBy=label=>[...document.querySelectorAll('.tasks-sort')].find(b=>b.textContent===label).click();window.ariaSort=label=>[...document.querySelectorAll('.tasks-table th')].find(t=>t.textContent===label).getAttribute('aria-sort');`);
    check('the table opens sorted by Process A→Z, shown on its header',await js("ariaSort('Process')==='ascending'&&ariaSort('CPU')==='none'&&!document.querySelector('[aria-label=\"Sort processes\"]')"));
    await js("sortBy('CPU')");
    check('clicking CPU sorts agents by their total CPU, heaviest first',await js("ariaSort('CPU')==='descending'&&ariaSort('Process')==='none'&&groupsOrder()==='Studio|AI Trading'"),await js('groupsOrder()'));
    await js("sortBy('CPU')");
    check('clicking CPU again reverses it',await js("ariaSort('CPU')==='ascending'&&groupsOrder()==='AI Trading|Studio'"));
    await js("document.querySelector('.tasks-close').click();openTasks()");await sleep(300);
    check('the sort survives closing and reopening',await js("ariaSort('CPU')==='ascending'&&groupsOrder()==='AI Trading|Studio'"));
    await js("sortBy('RAM')");
    check('a new column starts in its natural direction (RAM high→low)',await js("ariaSort('RAM')==='descending'&&groupsOrder()==='Studio|AI Trading'"));
    await snap('task-manager-sorted.png');
    await js("sortBy('Process')");
    check('Process returns to the A→Z order',await js("ariaSort('Process')==='ascending'&&groupsOrder()==='AI Trading|Studio'"));
    check('the agent itself is its group row: no codex/claude rows, no Protected label; jobs have stop controls',await js("![...document.querySelectorAll('.tasks-proc-name')].some(n=>/^(codex|claude)$/.test(n.textContent))&&!document.querySelector('.tasks-table').textContent.includes('Protected')&&document.querySelectorAll('.tasks-stop').length===2"));
    check('process names read as program + arguments',await js("[...document.querySelectorAll('.tasks-row')].some(r=>r.querySelector('.tasks-proc-name')?.textContent==='python'&&r.querySelector('.tasks-proc-args')?.textContent==='fetch_options.py --resume')"));
    check('a collapsed job says how many processes are inside',await js("[...document.querySelectorAll('.tasks-row')].some(r=>r.textContent.includes('fetch_options')&&r.querySelector('.tasks-proc-more')?.textContent==='+1')"));
    await js("document.querySelector('[aria-label=\"Show children of PID 31\"]').click()");
    check('expanding reveals children and treats command as plain text',await js("document.querySelector('.tasks-table').textContent.includes('ffmpeg -i clip.mp4 <untrusted>')&&!document.querySelector('untrusted')"));
    check('group rows show per-agent totals (agent included)',await js("[...document.querySelectorAll('.tasks-group')].some(g=>g.textContent.includes('Studio')&&g.textContent.includes('357.1%')&&g.querySelector('.tasks-number.hot'))"));
    check('busy CPU is emphasised, running time and PID recede',await js("[...document.querySelectorAll('.tasks-number.hot')].some(c=>c.textContent==='346.2%')&&[...document.querySelectorAll('.tasks-number.meta')].some(c=>c.textContent==='31')"));
    for(const theme of ['dark','light']){await js(`import('/js/theme.js').then(m=>m.setThemePref('${theme}'))`);await sleep(100);await snap('task-manager-'+theme+'.png');}
    const before=scans;
    await js("document.querySelector('.tasks-refresh').click()");await sleep(150);
    check('manual refresh shares five-second backend cache',scans===before,scans);
    await js("choose('Project filter','AI Trading')");
    check('project filter works',await js("document.querySelector('.tasks-table').textContent.includes('fetch_options')&&!document.querySelector('.tasks-table').textContent.includes('score.py')"));
    await js("choose('Processes to show','other')");
    check('view switch marks the chosen option and disables agent filters',await js("document.querySelector('[data-value=\"other\"]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-value=\"agents\"]').getAttribute('aria-pressed')==='false'&&document.querySelector('[aria-label=\"Agent filter\"]').disabled"));
    check('other view shows Chrome without agent filter interference',await js("document.querySelector('.tasks-table').textContent.includes('Chrome')&&!document.querySelector('.tasks-table').textContent.includes('fetch_options')"));
    await js("choose('Processes to show','agents');choose('Project filter','');choose('Agent filter','video')");
    check('agent filter works',await js("document.querySelector('.tasks-table').textContent.includes('score.py')&&!document.querySelector('.tasks-table').textContent.includes('fetch_options')"));
    await js("document.querySelector('.tasks-stop').click()");
    check('stop first requires explicit confirmation and changes no processes',await js("!document.querySelector('.tasks-confirm').hidden&&document.querySelector('.tasks-confirm').textContent.includes('PID 31')")&&stops.length===0);
    await snap('task-manager-confirm.png');
    await js("document.querySelector('.tasks-confirm .tasks-btn').click()");check('cancel sends no stop',stops.length===0);
    await js("document.querySelector('.tasks-stop').click();document.querySelector('.tasks-stop-confirm').click()");await sleep(200);
    check('confirmed stop signals only chosen fake job tree',JSON.stringify(stops)===JSON.stringify([[32,'SIGTERM'],[31,'SIGTERM']]),stops);
    check('normal stop feedback is a request, not a false completion',await js("document.querySelector('.tasks-notice').textContent.includes('requested for 2 processes')"));
    now+=5000;await js("document.querySelector('.tasks-refresh').click()");await sleep(200);
    check('remaining process offers force stop after grace period',await js("document.querySelector('.tasks-stop').textContent.includes('Force stop')"));
    await js("document.querySelector('.tasks-stop').click()");
    check('force stop warns about unsaved work',await js("document.querySelector('.tasks-confirm').textContent.includes('Unsaved work')"));
    await js("document.querySelector('.tasks-stop-confirm').click()");await sleep(200);
    check('confirmed force stop uses SIGKILL on fake tree only',JSON.stringify(stops.slice(-2))===JSON.stringify([[32,'SIGKILL'],[31,'SIGKILL']]));
    await cmd('Emulation.setDeviceMetricsOverride',{width:420,height:760,deviceScaleFactor:1,mobile:false});await sleep(150);await snap('task-manager-narrow.png');
    check('narrow dialog fits the viewport with Stop reachable and no sideways scroll',await js("(()=>{const d=document.querySelector('.tasks-dialog').getBoundingClientRect(),s=document.querySelector('.tasks-scroll'),b=document.querySelector('.tasks-stop').getBoundingClientRect();return d.left>=0&&d.right<=innerWidth&&d.bottom<=innerHeight&&s.scrollWidth<=s.clientWidth&&b.right<=d.right})()"));
    await js("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))");
    const hiddenScans=scans;now+=6000;await sleep(5400);
    check('hidden browser pauses sampling',scans===hiddenScans,scans);
    await js("Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'))");await sleep(200);
    check('visibility return refreshes once',scans===hiddenScans+1,scans);
    await js("document.querySelector('.tasks-close').click()");
    const closedScans=scans;now+=6000;await sleep(5400);
    check('closing panel stops all polling',scans===closedScans,scans);
    // Delayed request from a closed instance must never update/restart a new instance.
    await js(`window.realFetch=fetch;window.releaseOld=null;window.delaying=true;window.fetch=(...a)=>a[0]==='/api/tasks'&&window.delaying?new Promise(r=>window.releaseOld=()=>r(new Response(JSON.stringify({processes:[],sampledAt:1,cpuCount:1}),{status:200}))):realFetch(...a);openTasks()`);
    await js("document.querySelector('.tasks-close').click();window.delaying=false;openTasks()");await sleep(200);
    await js('releaseOld()');await sleep(150);
    check('late reply from closed dialog cannot overwrite reopened table',await js("document.querySelector('.tasks-table').textContent.includes('score.py')"));
    await js(`document.querySelector('.tasks-close').click();window.fetch=async()=>new Response(JSON.stringify({sampledAt:Date.now(),cpuCount:18,processes:Array.from({length:1005},(_,i)=>({pid:10000+i,ppid:1,token:'bulk-'+i,command:'bulk-job-'+i,cpu:0,memory:1024,elapsed:'00:30',started:'Thu Oct 29 06:00:00 2026',sessionId:'bulk',session:'Bulk test',project:'Test',canStop:true,forceAllowed:false}))}),{status:200});openTasks()`);await sleep(150);
    check('large process tables render a bounded first page',await js("document.querySelectorAll('.tasks-table tbody tr').length===401&&document.querySelector('.tasks-pager').textContent.includes('Page 1 of 3')"));
    await js("document.querySelector('.tasks-pager button:last-child').click();document.querySelector('.tasks-pager button:last-child').click()");
    check('pagination makes every process reachable without huge DOM',await js("document.querySelector('.tasks-table').textContent.includes('bulk-job-1004')&&document.querySelectorAll('.tasks-table tbody tr').length===206"));
    await js("document.querySelector('.tasks-close').click();window.fetch=async()=>new Response('',{status:404});openTasks()");await sleep(150);
    check('old engine shows restart instruction without websocket churn',await js("document.querySelector('.tasks-state').textContent.includes('Restart the CliDeck engine')&&document.querySelector('.tasks-table').hidden"));
    await snap('task-manager-error.png');
    await js("window.fetch=async()=>new Response(JSON.stringify({sampledAt:Date.now(),cpuCount:8,processes:[]}),{status:200});document.querySelector('.tasks-state .tasks-btn').click()");await sleep(150);
    check('Try again recovers into the empty state',await js("document.querySelector('.tasks-state').textContent.includes('No processes match')&&!document.querySelector('.tasks-state button')&&document.querySelector('.tasks-stat strong').textContent==='0'"));
    await snap('task-manager-empty.png');
    check('no uncaught browser exceptions',errors.length===0,errors);
  } finally {
    cws?.close();if(chrome){chrome.kill();await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));}await server.close();
    console.log(`${passes} passed, ${fails} failed; captures ${out}`);process.exitCode=fails?1:0;
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

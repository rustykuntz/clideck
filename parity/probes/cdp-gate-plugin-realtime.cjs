// Isolated Chrome + actual Worker/host + two real WebRTC peers. Synthetic mic/audio only;
// no shared engine/browser, provider calls, credentials or user's microphone.
const fs = require('node:fs');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const WebSocket = require('ws');
const root = resolve(__dirname, '../..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = `export function activate(api) {
  let controller; const events = [], focus = [];
  api.onRealtimeAudioEvent(e => events.push(e)); api.onActiveSessionChange(e => focus.push(e));
  api.registerAction({id:'voice-indicator',label:'Voice Agent',icon:'waveform',iconOnly:true,pressed:true,placements:['terminal.primary'],run:()=>{}});
  for (const name of ['open','abort','answer','send','close','events']) api.registerAction({id:name,label:name,placements:['terminal.header'],run:ctx => {
    if(name==='open') { controller=new AbortController(); return api.openRealtimeAudio({sessionId:ctx.session.id,signal:controller.signal}); }
    if(name==='abort') {controller?.abort(); return true;}
    if(name==='answer') return api.setRealtimeAudioAnswer(ctx.id,ctx.sdp);
    if(name==='send') return api.sendRealtimeAudioData(ctx.id,ctx.data);
    if(name==='close') return api.closeRealtimeAudio(ctx.id);
    return {events,focus,capabilities:api.capabilities};
  }});
}`;
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><head><title>Isolated live audio gate</title></head><body><button id="plugin-actions"></button><button id="voice-mic"></button></body></html>'); }
  if (pathname === '/fixture-client.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(client); }
  const file = resolve(root, 'public', '.' + pathname);
  if (!file.startsWith(join(root, 'public') + '/') || !fs.existsSync(file)) { console.error('Fixture missing:', pathname); res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', /\.m?js$/.test(pathname) ? 'text/javascript' : 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
let chrome, ws, passes = 0;
const check = (name, value) => { if (!value) throw Error(name); passes++; console.log('PASS ' + name); };
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(join(tmpdir(), 'clideck-realtime-chrome-'));
  try {
    const binary = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    chrome = spawn(binary, ['--headless=new', '--disable-gpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => ws.on('open', resolve));
    let sequence = 0; const pending = new Map(), errors = [];
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
      if (m.method === 'Network.loadingFailed') console.error('Fixture network:', JSON.stringify(m.params));
      if (m.method === 'Log.entryAdded') console.error('Fixture browser:', m.params.entry.text);
      pending.get(m.id)?.(m); });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 20000);
      pending.set(id, m => { pending.delete(id); clearTimeout(timer); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const js = async expression => { const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
    const until = async expression => { for (let i = 0; i < 100; i++) { if (await js(expression)) return true; await sleep(50); } return false; };
    await cmd('Runtime.enable'); await cmd('Page.enable'); await cmd('Network.enable'); await cmd('Log.enable'); await cmd('Page.navigate', { url: base });
    await fetch(`http://127.0.0.1:${port}/json/activate/${target.id}`); await cmd('Page.bringToFront'); await sleep(200);
    await js(`(async()=>{
      window.mics=[]; window.players=[]; window.hostPeers=[];
      const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async o=>{const s=await gum(o);mics.push(s);if(window.delayPermission)await new Promise(r=>window.releasePermission=r);return s;};
      const play=HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play=function(){players.push(this);return play.call(this);};
      window.NativePeer=RTCPeerConnection; window.RTCPeerConnection=class extends NativePeer {constructor(...args){super(...args);hostPeers.push(this);}};
      window.store=(await import('/js/store.js')).store;
      const host=await import('/js/ui/plugin-host.js');window.registry=await import('/js/ui/action-registry.js');host.initPluginHost();
      (await import('/js/ui/plugin-primary-actions.js')).initPrimaryPluginActions();
      window.voiceButton=()=>document.querySelector('#terminal-primary-actions button');
      window.wave=()=>[...voiceButton().querySelectorAll('path')].map(p=>p.getAttribute('d')).join('|');
      window.barHeight=()=>Number(voiceButton().querySelectorAll('path')[2].getAttribute('d').split('v')[1]);
      for(const id of ['A','B'])store.applyEvent({type:'session.created',sessionId:id,name:id,provider:'codex',live:true});store.select('A');store.setConnected(true);
      store.applyEvent({type:'plugins',plugins:[{id:'live-test',name:'Live Test',version:'1',enabled:true,status:'ready',clientUrl:'/fixture-client.js',settings:[]}]});
      window.rpc=async(name,data={})=>{const list=await registry.resolveActions('terminal.header',{session:{id:store.activeId},...data});const a=list.find(a=>a.id===name);return a.invoke('run-action',a.id,a.context);};
    })()`);
    check('actual sandbox Worker registers on the real host', await until(`registry.hasActions('terminal.header')`));
    check('initial focus and host capability reach Worker', await until(`rpc('events').then(r=>r.capabilities.realtimeAudio===true&&r.focus.at(-1)?.session.id==='A'&&r.focus.at(-1).focused)`));
    await js(`rpc('open').then(value=>window.live=value)`);
    check('real microphone and gathered SDP cross only the host bridge', await js(`live.offerSdp.startsWith('v=0')&&mics.at(-1).getTracks()[0].readyState==='live'&&hostPeers.at(-1).iceGatheringState==='complete'`));
    await js(`(async()=>{
      window.remote=new NativePeer();window.remoteMessages=[];remote.ondatachannel=e=>{window.remoteChannel=e.channel;e.channel.onmessage=e=>{remoteMessages.push(e.data);remoteChannel.send('echo:'+e.data);};};
      window.ac=new AudioContext();const dst=ac.createMediaStreamDestination();window.tone=ac.createOscillator();window.remoteGain=ac.createGain();remoteGain.gain.value=0;tone.connect(remoteGain).connect(dst);tone.start();remote.addTrack(dst.stream.getAudioTracks()[0],dst.stream);
      await remote.setRemoteDescription({type:'offer',sdp:live.offerSdp});await remote.setLocalDescription(await remote.createAnswer());
      if(remote.iceGatheringState!=='complete')await new Promise(resolve=>remote.addEventListener('icegatheringstatechange',()=>{if(remote.iceGatheringState==='complete')resolve();}));
      await rpc('answer',{id:live.id,sdp:remote.localDescription.sdp});
    })()`);
    check('native WebRTC reaches channel-open connected state', await until(`rpc('events').then(r=>r.events.some(e=>e.id===live.id&&e.state==='connected'))`));
    await js(`rpc('send',{id:live.id,data:'hello'})`);
    check('native data channel round trip reaches only its Worker', await until(`rpc('events').then(r=>r.events.some(e=>e.id===live.id&&e.data==='echo:hello'))`));
    check('remote audio plays through the host', await until(`players.some(p=>p.srcObject&&!p.paused)`));
    check('native peer receives microphone packets', await until(`remote.getStats().then(s=>[...s.values()].some(v=>v.type==='inbound-rtp'&&v.kind==='audio'&&v.packetsReceived>0))`));
    check('connected header identifies listening', await until(`voiceButton()?.dataset.voiceState==='listening'`));
    const breathing = await js(`wave()`); await sleep(200);
    check('listening waveform breathes gently', breathing !== await js(`wave()`));
    await js(`remoteGain.gain.value=.03`);
    check('real received audio drives the speaking state', await until(`voiceButton()?.dataset.voiceState==='speaking'`));
    await sleep(250); const quiet = await js(`barHeight()`);
    await js(`remoteGain.gain.value=.2`); await sleep(450);
    check('waveform height responds to actual playback volume', await js(`barHeight()`) > quiet + 1);
    await js(`remoteGain.gain.value=0`);
    check('silence returns smoothly to listening', await until(`voiceButton()?.dataset.voiceState==='listening'`));
    await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(100);
    const reduced = await js(`wave()`); await sleep(200);
    check('reduced-motion preference keeps the active waveform still', reduced === await js(`wave()`));
    await cmd('Emulation.setEmulatedMedia', { features: [] }); await sleep(100);
    check('changing reduced-motion preference restores animation', reduced !== await js(`wave()`));
    await js(`store.select('B')`);
    check('session switch immediately ends capture, playback and peer connection', await js(`mics.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&players.every(p=>p.paused&&!p.srcObject)&&hostPeers.every(p=>p.connectionState==='closed')`));
    check('a different session never inherits speaking animation', await until(`voiceButton()?.dataset.voiceState==='paused'`));
    const pausedWave = await js(`wave()`); await sleep(200);
    check('paused waveform stays still', pausedWave === await js(`wave()`));
    check('stale answers reject after the switch', await js(`rpc('answer',{id:live.id,sdp:'v=0'}).then(()=>false,()=>true)`));
    await js(`store.select('A');window.before=hostPeers.length`); await sleep(150);
    check('returning focus never restarts the host automatically', await js(`hostPeers.length===before`));
    await js(`window.delayPermission=true;window.stoppedOpening='';rpc('open').then(()=>stoppedOpening='unexpected',e=>stoppedOpening=e.message);true`);
    check('test holds a real permission result before host receipt', await until(`typeof releasePermission==='function'`));
    await js(`rpc('abort')`);
    check('explicit Stop rejects before an opening ID exists', await until(`stoppedOpening&&stoppedOpening!=='unexpected'`));
    await js(`delayPermission=false;releasePermission()`);
    check('late microphone permission cannot revive cancelled opening', await until(`mics.every(s=>s.getTracks().every(t=>t.readyState==='ended'))`));
    await js(`rpc('open').then(value=>window.next=value)`);
    const background = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    await fetch(`http://127.0.0.1:${port}/json/activate/${background.id}`);
    check('actual browser focus/visibility loss closes live capture', await until(`mics.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&hostPeers.at(-1).connectionState==='closed'`));
    await fetch(`http://127.0.0.1:${port}/json/activate/${target.id}`); await until(`document.hasFocus()`);
    await js(`rpc('open').then(value=>{window.last=value;store.applyEvent({type:'plugins',plugins:[]});})`);
    check('plugin disable tears down its media without a backend restart', await js(`mics.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&hostPeers.at(-1).connectionState==='closed'`));
    check('no uncaught browser exceptions', errors.length === 0);
    await js(`remote.close();tone.stop();ac.close()`);
  } finally {
    ws?.close(); if (chrome) { chrome.kill(); await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve)); }
    await new Promise(resolve => server.close(resolve));
  }
  console.log(`${passes}/${passes} isolated Chrome realtime checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });

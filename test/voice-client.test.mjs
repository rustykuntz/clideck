import test from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../plugin-packages/voice-agent/client.js';
const tick = () => new Promise(r => setImmediate(r));
const focused = id => ({session:{id,name:id,provider:'codex'},focused:true,visible:true,connected:true});
function fixture(t, options={}) {
  const handlers=new Map(),actions=new Map(),sent=[],opens=[],closes=[],answers=[],workspaces=[];let focusFn,audioFn,settingsFn,enabled=options.enabled!==false;
  const api={capabilities:{realtimeAudio:options.capable!==false},registerWorkspace:def=>{workspaces.push(def);return()=>{};},registerAction:def=>{actions.set(def.id,def);return()=>actions.delete(def.id);},
    onMessage:(name,fn)=>{handlers.set(name,fn);return()=>handlers.delete(name);},onSettingsChange:fn=>{settingsFn=fn;return()=>{};},getSettings:()=>({values:{'talk-to-sessions':enabled}}),
    onActiveSessionChange:fn=>{focusFn=fn;fn(focused('one'));return()=>{};},onRealtimeAudioEvent:fn=>{audioFn=fn;return()=>{};},
    getActiveSession:async()=>({id:'one'}),toast(){},openWorkspace(){},openSettings:async()=>true,
    openRealtimeAudio:async value=>{opens.push(value);return options.open?options.open(value):{id:'media'+opens.length,offerSdp:'v=0 fixture'};},
    closeRealtimeAudio:async id=>{closes.push(id);return true;},
    setRealtimeAudioAnswer:async(id,sdp)=>{answers.push({id,sdp});queueMicrotask(()=>audioFn({id,sessionId:opens.at(-1).sessionId,type:'state',state:'connected'}));return true;},
    send:(event,data)=>{
      sent.push({event,data});if(event!=='browser')return;
      if(options.hold?.(data))return;
      let result=data.action==='setup'?{setup:{ready:options.missing!==true,missing:options.missing?['openai-key']:[],errors:[]},transcript:[]}:
        data.action==='start'?{connectionId:data.connectionId,sdp:'v=0 answer'}:{accepted:true};
      queueMicrotask(()=>handlers.get('browser-result')?.({requestId:data.requestId,ok:true,...result}));
    },
  };
  const cleanup=activate(api);t.after(cleanup);
  return {sent,opens,closes,answers,actions,workspaces,settings:value=>{enabled=value;settingsFn();},focus:v=>focusFn(v),audio:v=>audioFn(v),ui:async(action,sessionId='one')=>{await handlers.get('voice-ui')({action,sessionId});await tick();await tick();},
    emit:(name,value)=>handlers.get(name)?.(value),last:()=>sent.filter(m=>m.event==='voice-ui-state').at(-1)?.data};
}
test('an explicit start is needed; pause closes local media before awaiting the server',async t=>{
  const f=fixture(t,{hold:data=>data.action==='stop'});await tick();assert.equal(f.opens.length,0);
  await f.ui('start');assert.equal(f.opens.length,1);assert.equal(f.last().state,'listening');
  await f.ui('pause');assert.deepEqual(f.closes,['media1']);assert.equal(f.last().state,'paused');
});
test('late microphone permission after a focus switch cannot connect or send an SDP offer',async t=>{
  let finish;const f=fixture(t,{open:()=>new Promise(r=>{finish=r;})});await f.ui('start');
  f.focus(focused('two'));finish({id:'late',offerSdp:'v=0 late'});await tick();await tick();
  assert.equal(f.opens[0].signal.aborted,true);
  assert(f.closes.includes('late'));assert.equal(f.sent.filter(m=>m.event==='browser'&&m.data.action==='start').length,0);
});
test('only explicitly enabled sessions resume; switching never transfers media or stale speech',async t=>{
  const f=fixture(t);await f.ui('start');f.focus(focused('two'));await tick();assert.equal(f.opens.length,1);
  await f.ui('start','two');assert.equal(f.opens.length,2);assert.equal(f.last().sessionId,'two');
  f.emit('browser-state',{connectionId:'media1',sessionId:'one',state:'listening',transcript:[{text:'stale'}]});assert.equal(f.last().sessionId,'two');
  f.focus(focused('one'));await tick();await tick();assert.equal(f.opens.length,3);assert.equal(f.opens.at(-1).sessionId,'one');
});
test('cancel during server connection closes local media and ignores the late SDP answer',async t=>{
  const f=fixture(t,{hold:data=>data.action==='start'});await f.ui('start');const request=f.sent.find(m=>m.event==='browser'&&m.data.action==='start').data;
  await f.ui('pause');f.emit('browser-result',{requestId:request.requestId,ok:true,sdp:'v=0 late'});await tick();
  assert.equal(f.answers.length,0);assert(f.closes.includes('media1'));
});
test('double start and foreign workspace actions cannot open extra microphones',async t=>{
  const f=fixture(t);await Promise.all([f.ui('start'),f.ui('start')]);assert.equal(f.opens.length,1);
  await f.ui('start','two');assert.equal(f.opens.length,1);
});
test('setup errors and an old host never open the microphone',async t=>{
  const missing=fixture(t,{missing:true});await missing.ui('start');assert.equal(missing.opens.length,0);assert.match(missing.last().error,/API key/);
  const old=fixture(t,{capable:false});await tick();await old.ui('start');assert.equal(old.opens.length,0);assert.match(old.last().error,/Reload/);
});
test('manual pause persists across focus switches until the user resumes',async t=>{
  const f=fixture(t);await f.ui('start');await f.ui('pause');f.focus(focused('two'));f.focus(focused('one'));await tick();assert.equal(f.opens.length,1);
  await f.ui('start');assert.equal(f.opens.length,2);
});
test('header waveform toggles focused session voice directly; off setting hides it and rejects starts',async t=>{
  const f=fixture(t,{enabled:false}),ctx={session:{id:'one'}},off=f.actions.get('voice-off'),on=f.actions.get('voice-on');
  assert.equal(off.icon,'waveform');assert.equal(off.iconOnly,true);assert.equal(off.pressed,false);assert.equal(on.pressed,true);
  assert.equal(off.when(ctx),false);assert.equal(on.when(ctx),false);await f.ui('start');assert.equal(f.opens.length,0);
  f.settings(true);await tick();assert.equal(off.when(ctx),true);assert.equal(f.opens.length,0);
  off.run(ctx);await tick();await tick();assert.equal(f.opens.length,1);assert.equal(on.when(ctx),true);assert.equal(off.when(ctx),false);
  on.run(ctx);await tick();assert.equal(off.when(ctx),true);assert.deepEqual(f.closes,['media1']);
  f.focus(focused('two'));f.focus(focused('one'));await tick();assert.equal(f.opens.length,1);
});
test('disabling Talk to sessions aborts pending permission and clears all automatic resumes',async t=>{
  let finish;const f=fixture(t,{open:()=>new Promise(r=>{finish=r;})});await f.ui('start');
  f.settings(false);assert.equal(f.opens[0].signal.aborted,true);finish({id:'late',offerSdp:'v=0 late'});await tick();await tick();
  assert(f.closes.includes('late'));assert.equal(f.sent.filter(m=>m.event==='browser'&&m.data.action==='start').length,0);
  f.settings(true);f.focus(focused('two'));f.focus(focused('one'));await tick();assert.equal(f.opens.length,1);assert.equal(f.last().enabled,false);
});
test('confirmed provider expiry reconnects only the still-enabled focused session',async t=>{
  const f=fixture(t);await f.ui('start');
  f.emit('browser-state',{connectionId:'media1',sessionId:'one',state:'paused',reconnect:true});await tick();await tick();
  assert.equal(f.opens.length,2);assert.equal(f.last().state,'listening');
  f.focus(focused('two'));f.emit('browser-state',{connectionId:'media2',sessionId:'one',state:'paused',reconnect:true});await tick();
  assert.equal(f.opens.length,2);assert.equal(f.last().sessionId,'two');
});

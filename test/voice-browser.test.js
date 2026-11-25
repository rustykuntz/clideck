const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { BrowserVoice } = require('../plugin-packages/voice-agent/browser');
const { OpenAILive, setup } = require('../plugin-packages/voice-agent/openai');
const { readPluginManifest } = require('../src/plugin-manifest');
const config = { 'openai-key': 'sk-fixture-private', voice: 'cedar', instructions: 'Keep it short.' };
const start = { connectionId: 'connection1', browserId: 'browser1', sessionId: 'session1', sdp: 'v=0\r\no=fixture' };
const flush = () => new Promise(r => setImmediate(r));
function fixture(t, change = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'voice-browser-'));
  const events = [], submissions = [], released = [], controls = [], hangups = [], creates = [], errors = [];
  const handlers = new Map(); let now = 1000;
  const api = { dataDir: dir, capabilities: { sessionSteer: true, boundedTurns: true }, getSetting: key => config[key],
    getSession: async id => ({ sessionId: id, name: 'Research', provider: 'codex', status: 'idle' }),
    getTurns: async (...args) => { assert.deepEqual(args.slice(1), [4, 12000]); return [{ role: 'agent', text: 'A: review. B: build the prototype.' }]; },
    getRequests: async () => [], releaseRequest: async id => released.push(id),
    submitRequest: async (...args) => { submissions.push(args); return { state: 'sent', steered: true }; },
    reportError: async (...args) => errors.push(args), clearError: async () => {},
  };
  const provider = () => ({ createBrowser: async (...args) => { creates.push(args); if (change.create) return change.create(...args); return { session: { id: 'live-' + creates.length }, transport: { sdp: 'v=0\r\nanswer' } }; },
    hangup: async id => { hangups.push(id); if (change.hangup) return change.hangup(id); },
    attach: (id, callbacks) => { handlers.set(id, callbacks); return { ready: Promise.resolve(), close() {}, send(e) { controls.push(e); if (!change.noAck) queueMicrotask(() => callbacks.event({ type: e.type + 'ed', client_event_id: e.event_id })); } }; },
  });
  const options = { provider, tickMs: 0, ackMs: 20, finalizeMs: 5, now: () => now };
  const service = new BrowserVoice(api, options);
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const context = { reply: (name, data) => { events.push({ name, data }); return true; } };
  const emit = e => handlers.get(service.current.providerId).event(e);
  return { service, api, options, dir, creates, hangups, events, submissions, released, controls, errors, context, emit, advance: ms => { now += ms; },
    connect: async (data = start) => { await service.start(data, context); service.ready(data); return service.current; },
    delegate: async text => { emit({ type: 'session.input_transcript.delta', delta: text }); await service.delegate(service.current, 'delegation-one'); return service.current.record.operations.at(-1); } };
}

test('browser setup requires no phone account; create payload uses server config, bounded context and no recording', async () => {
  assert.equal(setup(config, 'browser').ready, true); assert.equal(setup(config).ready, false);
  assert.equal(setup({...config,'talk-to-sessions':false}, 'browser').ready, false);
  let payload;
  const p = new OpenAILive(config, { fetchImpl: async (_, options) => { payload = JSON.parse(options.body); return { ok: true, text: async () => '{}' }; } });
  await p.createBrowser(start.sdp, 'Recent captured context', [{ role: 'user', text: 'Do B.' }]);
  assert.equal(payload.transport.type, 'webrtc'); assert.equal(payload.session.audio.output.voice, 'cedar');
  assert.equal(payload.session.store, false); assert.equal(payload.session.delegation.type, 'client');
  assert.deepEqual(payload.session.client.data_channel.allowed_client_events, []);
  // Live uses ServerEventSelector objects here, unlike the client event string list.
  // https://developers.openai.com/api/reference/resources/live/methods/create
  assert.deepEqual(payload.session.client.data_channel.allowed_server_events,
    [{ type: 'session.started' }, { type: 'session.closed' }, { type: 'error' }]);
  assert.equal(payload.session.input[0].role, 'developer'); assert(!JSON.stringify(payload).includes(config['openai-key']));
  const manifest = readPluginManifest(join(__dirname, '../plugin-packages/voice-agent'));
  assert.equal(manifest.settings.find(s => s.key === 'sip-url').group, 'Phone calls (optional)');
  for (const option of manifest.settings.find(s => s.key === 'voice').options) {
    assert.equal(option.preview, `public/voices/${option.value}.mp3`);
    const audio = fs.readFileSync(join(__dirname, '../plugin-packages/voice-agent', option.preview));
    assert(audio.length > 4000, `${option.value} needs a playable sample`);
    assert.equal(audio.subarray(0,3).toString(), 'ID3');
  }
});
test('same connection is idempotent and a second browser cannot create another live session', async t => {
  const f = fixture(t);
  const [a,b] = await Promise.all([f.service.start(start, f.context), f.service.start(start, f.context)]);
  assert.deepEqual(a,b); assert.equal(f.creates.length, 1);
  await assert.rejects(f.service.start({ ...start, sdp: 'v=0 changed' }, f.context), /already used/);
  await assert.rejects(f.service.start({ ...start, connectionId: 'other', browserId: 'other' }, f.context), /already open/);
  assert.equal(f.service.owned({ ...start, browserId: 'other' }), null);
  assert(!fs.readFileSync(join(f.dir,'browser.json'),'utf8').includes(config['openai-key']));
});
test('native Claude sessions work and older engines cannot fall back to unbounded transcript reads', async t => {
  const f=fixture(t); f.api.getSession=async()=>({provider:'claude-code',name:'Claude'});
  f.api.capabilities.boundedTurns=false;
  await assert.rejects(f.service.start(start,f.context),/Restart CliDeck/);assert.equal(f.creates.length,0);
  f.api.capabilities.boundedTurns=true;await f.connect();assert.equal(f.creates.length,1);
});
test('pause while provider creates closes the eventual provider session without attaching audio', async t => {
  let finish; const f=fixture(t,{create:()=>new Promise(r=>{finish=r;})});
  const connecting=f.service.start(start,f.context); await flush();
  await f.service.stop(); finish({session:{id:'late'},transport:{sdp:'v=0 late'}});
  await assert.rejects(connecting,/paused/); assert.deepEqual(f.hangups,['late']); assert.equal(f.service.current,null);
});
test('Stop drains final provider usage after cutting voice without accepting further conversation work', async t => {
  const f = fixture(t); const run = await f.connect();
  f.emit({ type: 'session.usage.updated', usage: { seconds: 12 } }); f.advance(30000);
  const stop = f.service.stop();
  assert.equal(run.closed, true);
  f.emit({ type: 'session.input_transcript.delta', delta: 'Ignore this after stop' });
  f.emit({ type: 'session.closed', usage: { seconds: 30 }, reason: 'close_requested' });
  await stop;
  const usage = f.service.usage.report({ days: 0 });
  assert.equal(usage.totals.reportedSeconds, 30); assert.equal(usage.totals.estimatedSeconds, 0);
  assert(!run.record.history.some(t => t.text.includes('Ignore this')));
});
test('missing final usage stays provisional after bounded close', async t => {
  const f = fixture(t); await f.connect(); f.advance(90000); await f.service.stop();
  const usage = f.service.usage.report({ days: 0 });
  assert.equal(usage.totals.reportedSeconds, 0); assert.equal(usage.totals.estimatedSeconds, 90); assert.equal(usage.totals.active, 0);
});
test('late provider creation preserves failed closure for recovery after the browser has paused', async t => {
  let finish;const f=fixture(t,{create:()=>new Promise(r=>{finish=r;}),hangup:async()=>{throw Error('offline');}});
  const connecting=f.service.start(start,f.context);await flush();await f.service.stop();
  finish({session:{id:'late'},transport:{sdp:'v=0 late'}});await assert.rejects(connecting,/paused/);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir,'browser.json'))).connection.providerId,'late');
  assert.match(f.errors.at(-1)[2],/cancelled voice connection could not be closed/);
});
test('spoken choices retain the list, use stable guarded delivery, and duplicate delegation does not repeat work', async t => {
  const f=fixture(t); await f.connect();
  f.emit({type:'session.output_transcript.delta',delta:'A: review. B: build.'});
  const op=await f.delegate('Let’s do B.');
  await f.service.delegate(f.service.current,'repeat');
  assert.equal(f.submissions.length,1); assert.match(op.text,/A: review. B: build/);assert.match(op.text,/Let’s do B/);
  assert.deepEqual(f.submissions[0][3],{resume:true,steer:true});assert.equal(f.submissions[0][1],op.id);
  await f.service.stop();assert.equal(op.delivery,'sent');
});
test('waiting retries preserve exact text/options; uncertain delivery never retries', async t => {
  const f=fixture(t);let delivery='waiting'; f.api.submitRequest=async(...args)=>{f.submissions.push(args);return{state:delivery,message:'guard'};};
  await f.connect();const op=await f.delegate('Review it.');
  await f.service.tick();assert.deepEqual(f.submissions[0],f.submissions[1]);
  delivery='uncertain';await f.service.tick();const count=f.submissions.length;await f.service.tick();assert.equal(f.submissions.length,count);
  await f.service.reply({origin:'plugin:voice-agent',phase:'request.acknowledged',sessionId:start.sessionId,requestId:op.id});
  await f.service.tick();assert.equal(f.submissions.length,count);assert.equal(op.delivery,'acknowledged');
});
test('owned answers route only to original session; generic or wrong-owner replies are ignored', async t => {
  const f=fixture(t);f.api.submitRequest=async(...args)=>{f.submissions.push(args);return{state:'sent'};};
  await f.connect();const op=await f.delegate('What now?');
  await f.service.reply({origin:'desktop',phase:'agent.final',requestId:op.id,sessionId:start.sessionId,text:'wrong'});assert.equal(op.answer,undefined);
  await f.service.reply({origin:'plugin:voice-agent',phase:'agent.final',requestId:op.id,sessionId:'another',text:'wrong'});assert.equal(op.answer,undefined);
  await f.service.reply({origin:'plugin:voice-agent',phase:'agent.final',requestId:op.id,sessionId:start.sessionId,text:'The review passed.'});await f.service.current.queue;
  assert.equal(op.answer,'The review passed.');assert(f.controls.some(e=>e.type==='session.commentary.append'));
  await f.service.stop();await f.connect({...start,connectionId:'connection2',sessionId:'another'});
  const count=f.controls.length;await f.service.answer(start.sessionId,op.id,{text:'duplicate'});assert.equal(f.controls.length,count);
});
test('busy delivery uses explicit answers; completion survives focus loss and is supplied on return', async t => {
  const f=fixture(t);await f.connect();const op=await f.delegate('Build it.');await f.service.stop();
  await f.service.reply({origin:'plugin:voice-agent',phase:'agent.final',requestId:op.id,sessionId:start.sessionId,text:'unowned'});assert.equal(op.answer,undefined);
  await assert.rejects(f.service.answer('other',op.id,{text:'No'}),/does not belong/);
  await f.service.answer(start.sessionId,op.id,{text:'Built and tested.'});
  await f.connect({...start,connectionId:'connection2'});assert.match(f.creates.at(-1)[1],/Built and tested/);assert.equal(f.submissions.length,1);
});
test('expired browser lease closes media while pending session work remains', async t => {
  const f=fixture(t);await f.connect();const op=await f.delegate('Run the check.');f.advance(19000);await f.service.tick();
  assert.equal(f.service.current,null);assert.equal(op.delivery,'sent');assert.equal(f.hangups.length,1);
});
test('provider-confirmed closure stops browser voice without a second hangup or a false recovery error', async t => {
  const f=fixture(t,{hangup:async()=>{throw Error('already closed');}});await f.connect();
  f.emit({type:'session.closed'});await flush();
  assert.equal(f.service.current,null);assert.equal(f.hangups.length,0);assert.equal(f.errors.length,0);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir,'browser.json'))).connection,null);
});
test('focused voice keeps its lease beyond twenty minutes and renews only a confirmed provider expiry', async t => {
  const f=fixture(t);await f.connect();f.advance(21*60_000);f.service.heartbeat(start,f.context);await f.service.tick();
  assert(f.service.current);assert.equal(f.hangups.length,0);
  f.emit({type:'session.closed',reason:'expired'});await flush();assert.equal(f.service.current,null);
  assert.equal(f.events.at(-1).data.reconnect,true);assert.equal(f.hangups.length,0);
});
test('restart recovers saved answers and closes known media without repeating actions', async t => {
  const f=fixture(t);await f.connect();const op=await f.delegate('Check this.');
  const next=new BrowserVoice(f.api,f.options);t.after(()=>next.close());
  f.api.getRequests=async()=>[{id:op.id,sessionId:start.sessionId,state:'complete',answer:'Done.'}];
  await next.recover();assert.equal(next.records[0].operations[0].answer,'Done.');assert(f.hangups.length);assert.equal(f.submissions.length,1);
});
test('lost close receipt is retained for recovery and no new provider session starts until closure succeeds', async t => {
  let fail=true;const f=fixture(t,{hangup:async()=>{if(fail)throw Error('offline');}});
  await f.connect();await f.service.stop();assert.equal(JSON.parse(fs.readFileSync(join(f.dir,'browser.json'))).connection.providerId,'live-1');
  await assert.rejects(f.service.start({...start,connectionId:'connection2'},f.context),/offline/);assert.equal(f.creates.length,1);
  fail=false;await f.connect({...start,connectionId:'connection3'});assert.equal(f.creates.length,2);
});
test('corrupt saved receipts block new voice rather than discarding possible instructions', async t => {
  const f=fixture(t);fs.writeFileSync(join(f.dir,'browser.json'),'{bad');const broken=new BrowserVoice(f.api,f.options);t.after(()=>broken.close());
  await assert.rejects(broken.start(start,f.context),/could not be read/);assert.equal(f.creates.length,0);
});

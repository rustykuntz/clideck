import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
const { winFire, docFire } = installFakeDom();
let focused = true;
document.hasFocus = () => focused; document.visibilityState = "visible";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const peers = [], audios = [], streams = [], events = [], focuses = [];
let gates = {}, constraints;
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== fn)); }
  fire(type, value = {}) { this["on" + type]?.(value); for (const fn of this.listeners.get(type) || []) fn(value); }
}
function stream() {
  const track = new Events(); Object.assign(track, { kind: "audio", enabled: true, stopped: false, stop() { this.stopped = true; } });
  const result = { track, getTracks: () => [track], getAudioTracks: () => [track] }; streams.push(result); return result;
}
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia(options) {
  constraints = options; return gates.permission?.promise || Promise.resolve(stream());
} } } });
class Peer extends Events {
  constructor() { super(); peers.push(this); this.gates = { ...gates }; this.iceGatheringState = gates.ice ? "gathering" : "complete"; this.connectionState = "new"; this.tracks = []; }
  createDataChannel(label) {
    this.label = label;
    return this.channel = Object.assign(new Events(), { readyState: "connecting", bufferedAmount: 0, sent: [],
      send(value) { this.sent.push(value); }, close() { this.readyState = "closed"; } });
  }
  addTrack(track) { this.tracks.push(track); }
  async createOffer() { await this.gates.offer?.promise; return { type: "offer", sdp: "v=0\r\nlocal offer" }; }
  async setLocalDescription(value) { await this.gates.local?.promise; this.localDescription = value; }
  async setRemoteDescription(value) { await this.gates.answer?.promise; this.remoteDescription = value; }
  close() { this.connectionState = "closed"; }
}
globalThis.RTCPeerConnection = Peer;
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } };
class Audio extends Events {
  constructor() { super(); this.paused = true; this.duration = 2; this.currentTime = 0; this.gate = gates.play; audios.push(this); }
  async play() { await this.gate?.promise; this.paused = false; }
  pause() { this.paused = true; }
  removeAttribute() {} load() {}
}
globalThis.Audio = Audio;
URL.createObjectURL = () => "blob:test"; URL.revokeObjectURL = () => {};
const meters = []; let outputLevel = 0;
window.AudioContext = class { constructor() { meters.push(this); this.sampleRate = 16000; this.state = "running"; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
  createMediaStreamSource(stream) { this.stream = stream; return this.source = { connect() {}, disconnect() { this.disconnected = true; } }; }
  createAnalyser() { if (gates.meterFail) throw Error('meter unavailable'); return { getFloatTimeDomainData(samples) { samples.fill(outputLevel); }, disconnect() {} }; }
  async resume() {} async close() { this.state = 'closed'; } };
window.AudioWorkletNode = class { constructor() { this.port = { postMessage: () => this.port.onmessage?.({ data: { type: "flushed" } }) }; } connect() {} disconnect() {} };

const { store } = await import("../public/js/store.js");
const rtc = await import("../public/js/ui/plugin-realtime.js");
const { realtimeMediaOwner } = await import("../public/js/ui/plugin-media.js");
const { playPluginAudio, stopPluginAudio, audioOwner } = await import("../public/js/ui/plugin-audio.js");
const { startPluginMicrophone, stopPluginMicrophone } = await import("../public/js/ui/plugin-microphone.js");
const create = id => store.applyEvent({ type: "session.created", sessionId: id, name: id, provider: "codex", live: true });
create("A"); create("B"); store.select("A"); store.setConnected(true);
rtc.initPluginRealtime(value => focuses.push({ value, micStopped: streams.every(value => value.track.stopped), audioPaused: audios.every(value => value.paused) }));
let checks = 0;
function ok(name, value) { assert.ok(value, name); checks++; console.log("  ok   " + name); }
const open = () => rtc.openRealtimeAudio("voice", { sessionId: store.activeId }, event => events.push(event));
const remote = async () => { peers.at(-1).fire("track", { track: stream().track }); await tick(); return audios.at(-1); };
function reset() { rtc.stopPluginRealtimeAudio("voice"); gates = {}; focused = true; document.visibilityState = "visible"; create("A"); create("B"); store.setConnected(true); store.select("A"); winFire("focus"); }

ok("focus subscriptions receive the initial active session and browser state", focuses[0].value.session.id === "A" && focuses[0].value.focused && focuses[0].value.connected);
let connection = await open();
ok("offer uses host-owned processed microphone with no provider config", connection.offerSdp.includes("local offer") && constraints.audio.echoCancellation && !constraints.video && peers.at(-1).label === "events");
ok("live audio reserves playback as well as microphone", audioOwner() === "realtime" && realtimeMediaOwner() === "voice");
await assert.rejects(open(), /current audio|already in use/);
await assert.rejects(startPluginMicrophone("dictation", () => {}), /Stop live voice/);
await assert.rejects(playPluginAudio("speech", new ArrayBuffer(8)), /Stop live voice/);
ok("other live calls, dictation and clips cannot share a live reservation", true);
assert.throws(() => rtc.sendRealtimeAudioData("voice", connection.id, "{}"), /not ready/);
await assert.rejects(rtc.setRealtimeAudioAnswer("other", connection.id, "v=0"), /no longer available/);
ok("a different plugin cannot answer or close the owner's connection", rtc.closeRealtimeAudio("other", connection.id) === false);
await rtc.setRealtimeAudioAnswer("voice", connection.id, "v=0\r\nanswer");
await assert.rejects(rtc.setRealtimeAudioAnswer("voice", connection.id, "v=0"), /already received/);
const channel = peers.at(-1).channel; channel.readyState = "open"; channel.fire("open");
ok("connected is emitted only when the data channel opens", events.at(-1).state === "connected");
rtc.sendRealtimeAudioData("voice", connection.id, '{"test":1}'); channel.fire("message", { data: '{"reply":2}' });
ok("bounded text events carry exact connection and session identity", channel.sent[0] === '{"test":1}' && events.at(-1).data === '{"reply":2}' && events.at(-1).sessionId === "A" && events.at(-1).id === connection.id);
assert.throws(() => rtc.sendRealtimeAudioData("voice", connection.id, "😀".repeat(17000)), /64 KiB/);
channel.bufferedAmount = 256 * 1024;
assert.throws(() => rtc.sendRealtimeAudioData("voice", connection.id, "x"), /nothing was sent/);
ok("UTF-8 and buffered channel limits reject before sending", channel.sent.length === 1);

const audio = await remote(), oldData = channel.onmessage, pc = peers.at(-1), mic = pc.tracks[0];
const meter = meters.at(-1);
ok("listening reports zero output energy for silence", rtc.realtimeAudioActivity("voice", "A").state === "listening" && rtc.realtimeAudioActivity("voice", "A").level === 0);
outputLevel = .2;
ok("speech feedback measures only the remote stream and stays with its owner", Math.abs(rtc.realtimeAudioActivity("voice", "A").level - .2) < .001 && meter.stream === audio.srcObject && rtc.realtimeAudioActivity("other", "A").level === 0 && rtc.realtimeAudioActivity("voice", "B").level === 0);
audio.muted = true;
ok("muted playback never reports speaking", rtc.realtimeAudioActivity("voice", "A").level === 0); audio.muted = false;
store.select("B");
ok("focus loss disposes the audio meter and clears speaking synchronously", meter.state === "closed" && meter.source.disconnected && rtc.realtimeAudioActivity("voice", "A").level === 0);
outputLevel = 0;
ok("session switch stops tracks and playback synchronously before focus notification", mic.stopped && !mic.enabled && audio.paused && !audio.srcObject && focuses.at(-1).micStopped && focuses.at(-1).audioPaused && pc.connectionState === "closed");
const count = events.length; oldData({ data: "late" });
ok("late channel events are discarded and returning focus never auto-starts", events.length === count && (store.select("A"), !realtimeMediaOwner()));
await assert.rejects(rtc.setRealtimeAudioAnswer("voice", connection.id, "v=0"), /no longer available/);
ok("closed IDs cannot be reused", rtc.closeRealtimeAudio("voice", connection.id) === false);

for (const [name, leave] of [
  ["blur", () => { focused = false; winFire("blur"); }],
  ["hidden", () => { document.visibilityState = "hidden"; docFire("visibilitychange"); }],
  ["disconnect", () => store.setConnected(false)],
  ["session removal", () => store.applyEvent({ type: "session.closed", sessionId: "A" })],
  ["reset", () => store.reset()],
  ["pagehide", () => winFire("pagehide")],
  ["plugin teardown", () => rtc.stopPluginRealtimeAudio("voice")],
]) {
  reset(); await open(); const playing = await remote(), owner = peers.at(-1);
  leave(); ok(name + " cuts both media directions immediately", owner.tracks.every(track => track.stopped) && playing.paused && !playing.srcObject && !realtimeMediaOwner());
}

reset(); gates.permission = deferred();
let abortOpening = rtc.openRealtimeAudio("voice", { sessionId: "A" }, event => events.push(event), "runtime:open-1");
const abortPermission = gates.permission;
rtc.cancelRealtimeAudioOpen("voice", "runtime:open-1");
await assert.rejects(abortOpening, /closed/);
gates = {}; const afterAbort = await rtc.openRealtimeAudio("voice", { sessionId: "A" }, event => events.push(event), "runtime:open-2");
rtc.cancelRealtimeAudioOpen("voice", "runtime:open-1");
const abortedStream = stream(); abortPermission.resolve(abortedStream); await tick();
ok("Stop cancels a pending opening without an ID; stale cancellation cannot stop its replacement", abortedStream.track.stopped && realtimeMediaOwner() === "voice");
rtc.closeRealtimeAudio("voice", afterAbort.id);

reset(); gates.permission = deferred();
let opening = open(); const pending = gates.permission;
store.select("B");
await assert.rejects(opening, /closed/);
gates = {}; const next = await open(), newPeer = peers.at(-1);
const lateStream = stream(); pending.resolve(lateStream); await tick();
ok("pending permission rejects promptly; late grant stops without touching a newer session", lateStream.track.stopped && newPeer.connectionState !== "closed" && realtimeMediaOwner() === "voice");
rtc.closeRealtimeAudio("voice", next.id);

for (const stage of ["offer", "local", "ice", "answer"]) {
  reset(); const gate = deferred(); gates[stage] = stage === "ice" ? true : gate;
  opening = open();
  if (stage === "answer") { connection = await opening; opening = rtc.setRealtimeAudioAnswer("voice", connection.id, "v=0"); }
  await tick(); const owner = peers.at(-1); store.select("B");
  await assert.rejects(opening, /closed/);
  gate.resolve(); owner.iceGatheringState = "complete"; owner.fire("icegatheringstatechange"); await tick();
  ok("focus change during " + stage + " rejects stale work and releases all media", owner.connectionState === "closed" && owner.tracks.every(track => track.stopped) && !realtimeMediaOwner());
}

reset(); gates.ice = true; let offered = false;
opening = open().then(value => { offered = true; return value; }); await tick();
ok("offer waits for complete ICE rather than needing provider-specific trickle", !offered);
peers.at(-1).iceGatheringState = "complete"; peers.at(-1).fire("icegatheringstatechange"); connection = await opening;
rtc.closeRealtimeAudio("voice", connection.id);

reset(); gates.play = deferred(); connection = await open(); await remote();
const lateAudio = audios.at(-1), playGate = gates.play; store.select("B"); playGate.resolve(); await tick();
ok("a delayed play promise cannot resurrect old-session playback", lateAudio.paused && !lateAudio.srcObject && lateAudio.muted);
reset(); gates.play = deferred(); await open(); await remote(); gates.play.reject(new Error("autoplay blocked")); await tick();
ok("autoplay failure reports the exact error and releases the microphone", events.some(event => event.error === "autoplay blocked") && !realtimeMediaOwner() && peers.at(-1).tracks.every(track => track.stopped));
reset(); gates.meterFail = true; connection = await open(); await remote();
ok("an unavailable visual meter never prevents voice playback", !audios.at(-1).paused && realtimeMediaOwner() === "voice" && meters.at(-1).state === "closed");

for (const [name, fail] of [
  ["connection failure", pc => { pc.connectionState = "failed"; pc.fire("connectionstatechange"); }],
  ["microphone ended", pc => pc.tracks[0].fire("ended")],
  ["channel error", pc => pc.channel.fire("error")],
  ["binary data", pc => pc.channel.fire("message", { data: new ArrayBuffer(5) })],
  ["oversized incoming data", pc => pc.channel.fire("message", { data: "a".repeat(65537) })],
]) {
  reset(); await open(); fail(peers.at(-1));
  ok(name + " reports an error and closes cleanly", events.at(-2).type === "error" && events.at(-1).state === "closed" && !realtimeMediaOwner());
}

reset(); await playPluginAudio("speech", new ArrayBuffer(8));
await assert.rejects(open(), /Stop the current audio/); stopPluginAudio();
ok("existing clip playback cannot be taken over silently", true);
gates.permission = deferred(); const permission = gates.permission;
const dictation = startPluginMicrophone("dictation", () => {});
await assert.rejects(open(), /Stop the current microphone/);
await stopPluginMicrophone("dictation"); permission.resolve(stream());
await assert.rejects(dictation, /cancelled/); gates = {};
ok("a pending dictation permission also reserves the microphone", true);
focused = false; const calls = peers.length;
await assert.rejects(open(), /Focus this session/);
ok("unfocused calls fail before requesting microphone permission", peers.length === calls);
reset(); gates.permission = deferred(); opening = open(); gates.permission.reject(new Error("permission denied"));
await assert.rejects(opening, /permission denied/);
ok("permission errors release ownership and return to the caller", !realtimeMediaOwner() && events.at(-2).error === "permission denied");
reset();
console.log(`\n${checks}/${checks} realtime host checks passed`);

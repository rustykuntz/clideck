// Provider-neutral, host-owned WebRTC. Plugins exchange SDP and interpret channel data;
// only this module touches media, and focus invalidation cuts it before Worker notification.
import { store } from "../store.js";
import { audioOwner } from "./plugin-audio.js";
import { pluginMicrophoneOwner } from "./plugin-microphone.js";
import { reserveRealtimeMedia } from "./plugin-media.js";

const MAX_TEXT_BYTES = 64 * 1024, MAX_BUFFERED_BYTES = 256 * 1024;
const encoder = new TextEncoder();
let current = null, sequence = 0, initialized = false;
const activityListeners = new Set();
export function onRealtimeAudioActivityChange(fn) {
  activityListeners.add(fn); return () => activityListeners.delete(fn);
}

export function pluginSessionSnapshot(session) {
  if (!session) return null;
  return { id: session.id, name: session.name || "", provider: session.provider || "", cwd: session.cwd || "", projectId: session.projectId || null, live: session.live !== false, status: session.status || "", readAloud: session.readAloud === true };
}
export function activeSessionFocus() {
  return { session: pluginSessionSnapshot(store.active()), focused: document.hasFocus?.() === true,
    visible: document.visibilityState !== "hidden", connected: store.connected === true };
}
function eligible(sessionId) {
  const focus = activeSessionFocus();
  return focus.session?.id === sessionId && focus.focused && focus.visible && focus.connected;
}
function valid(record) { return current === record && !record.closed && eligible(record.sessionId); }
function emit(record, event) {
  if (event.type === "state") for (const fn of activityListeners) { try { fn(); } catch {} }
  try { record.onEvent({ id: record.id, sessionId: record.sessionId, ...event }); } catch {}
}
function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) { try { track.enabled = false; track.stop(); } catch {} }
}
function silence(audio) {
  if (!audio) return;
  try { audio.muted = true; audio.pause(); audio.srcObject = null; } catch {}
}
// Host-only visual feedback. Measure received speech, never microphone input;
// this branch does not feed the speakers or send samples across the plugin bridge.
function meterOutput(record) {
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    const context = record.meterContext = new Context();
    const source = record.meterSource = context.createMediaStreamSource(record.remoteStream);
    const analyser = record.analyser = context.createAnalyser();
    analyser.fftSize = 512;
    record.samples = new Float32Array(analyser.fftSize);
    source.connect(analyser);
    context.resume().catch(() => {});
  } catch { disposeMeter(record); } // A visual aid must never prevent a conversation.
}
function disposeMeter(record) {
  try { record.meterSource?.disconnect(); record.analyser?.disconnect(); } catch {}
  try { record.meterContext?.close()?.catch(() => {}); } catch {}
  record.meterContext = record.meterSource = record.analyser = record.samples = null;
}
export function realtimeAudioActivity(pluginId, sessionId) {
  const record = current;
  if (!record || record.pluginId !== pluginId || record.sessionId !== sessionId || !valid(record)) return { state: "paused", level: 0 };
  let level = 0;
  if (record.analyser && !record.audio?.paused && !record.audio?.muted && record.meterContext?.state === "running") {
    record.analyser.getFloatTimeDomainData(record.samples);
    level = Math.sqrt(record.samples.reduce((sum, sample) => sum + sample * sample, 0) / record.samples.length);
  }
  return { state: record.channel?.readyState === "open" ? "listening" : "connecting", level };
}
function close(record, error) {
  if (!record || record.closed) return false;
  record.closed = true;
  // Synchronous media cutoff comes first, even if permission, SDP or play() is pending.
  silence(record.audio); stopTracks(record.stream); stopTracks(record.remoteStream);
  disposeMeter(record);
  if (record.channel) {
    record.channel.onopen = record.channel.onmessage = record.channel.onclose = record.channel.onerror = null;
    try { record.channel.close(); } catch {}
  }
  if (record.pc) {
    record.pc.ontrack = record.pc.onconnectionstatechange = null;
    try { record.pc.close(); } catch {}
  }
  clearTimeout(record.timer);
  record.release();
  if (current === record) current = null;
  record.rejectClosed(new Error(error || "Live audio was closed."));
  if (error) emit(record, { type: "error", error: String(error).slice(0, 2000) });
  emit(record, { type: "state", state: "closed" });
  return true;
}
function assertCurrent(record) {
  if (!valid(record)) { close(record); throw new Error("Live audio is no longer active for this session."); }
}
async function wait(record, promise) {
  const value = await Promise.race([promise, record.whenClosed]);
  assertCurrent(record); return value;
}
function text(value, label) {
  if (typeof value !== "string" || !value.length || value.length > MAX_TEXT_BYTES || encoder.encode(value).byteLength > MAX_TEXT_BYTES) {
    throw new Error(`${label} must be nonempty text of at most 64 KiB.`);
  }
  return value;
}
function owned(pluginId, id) {
  const record = current;
  if (!record || record.pluginId !== pluginId || record.id !== id) throw new Error("Live audio connection is no longer available.");
  assertCurrent(record); return record;
}
function fail(record, error) { close(record, error?.message || String(error)); }

export function initPluginRealtime(onFocus) {
  if (initialized) return; initialized = true;
  let previous = "";
  const changed = () => {
    if (current && !eligible(current.sessionId)) close(current);
    const focus = activeSessionFocus(), signature = JSON.stringify(focus);
    if (signature !== previous) { previous = signature; onFocus(focus); }
  };
  for (const event of ["active", "session:update", "session:remove", "connection", "reset"]) store.on(event, changed);
  for (const event of ["focus", "blur"]) window.addEventListener(event, changed);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("pagehide", () => { if (current) close(current); });
  changed();
}

export async function openRealtimeAudio(pluginId, options, onEvent, openingKey) {
  const sessionId = options?.sessionId, channelLabel = options?.channelLabel ?? "events";
  if (typeof sessionId !== "string" || !sessionId || !eligible(sessionId)) throw new Error("Focus this session in a connected CliDeck window to start voice.");
  if (typeof channelLabel !== "string" || !channelLabel || encoder.encode(channelLabel).byteLength > 128) throw new Error("Live audio channel label must be 1–128 bytes.");
  if (typeof RTCPeerConnection !== "function" || !navigator.mediaDevices?.getUserMedia || typeof Audio !== "function") throw new Error("Live audio requires a browser with WebRTC and microphone access (localhost or HTTPS).");
  if (pluginMicrophoneOwner()) throw new Error("Stop the current microphone recording before starting voice.");
  if (audioOwner()) throw new Error("Stop the current audio playback before starting voice.");
  const release = reserveRealtimeMedia(pluginId);
  const record = { id: `rtc-${Date.now()}-${++sequence}`, pluginId, sessionId, onEvent, release, openingKey, closed: false };
  record.whenClosed = new Promise((_, reject) => { record.rejectClosed = reject; });
  record.whenClosed.catch(() => {});
  current = record;
  record.timer = setTimeout(() => close(record, "Live audio did not connect within 60 seconds."), 60_000);
  try {
    record.pc = new RTCPeerConnection();
    const pc = record.pc;
    pc.onconnectionstatechange = () => {
      if (record.closed) return;
      if (!valid(record)) return void close(record);
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) close(record, "Live audio connection ended.");
    };
    pc.ontrack = event => {
      if (!valid(record)) { stopTracks({ getTracks: () => [event.track] }); close(record); return; }
      if (event.track.kind !== "audio" || record.audio) { stopTracks({ getTracks: () => [event.track] }); close(record, "Unexpected live audio track."); return; }
      const audio = record.audio = new Audio();
      record.remoteStream = event.streams?.[0] || new MediaStream([event.track]);
      audio.srcObject = record.remoteStream; audio.playsInline = true;
      meterOutput(record);
      audio.onerror = () => { if (valid(record)) close(record, "Could not play live audio."); };
      Promise.resolve().then(() => { assertCurrent(record); return audio.play(); })
        .then(() => { if (!valid(record)) silence(audio); }, error => { silence(audio); if (!record.closed) fail(record, error); });
    };
    record.channel = pc.createDataChannel(channelLabel);
    const channel = record.channel;
    channel.onopen = () => {
      if (!valid(record)) return void close(record);
      clearTimeout(record.timer); emit(record, { type: "state", state: "connected" });
    };
    channel.onmessage = event => {
      if (!valid(record)) return void close(record);
      try { emit(record, { type: "data", data: text(event.data, "Live audio data") }); }
      catch (error) { fail(record, error); }
    };
    channel.onclose = () => close(record);
    channel.onerror = () => close(record, "Live audio data channel failed.");
    emit(record, { type: "state", state: "connecting" });
    const opening = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .then(stream => { if (!valid(record)) { stopTracks(stream); assertCurrent(record); } record.stream = stream; return stream; });
    record.stream = await wait(record, opening);
    for (const track of record.stream.getAudioTracks()) {
      pc.addTrack(track, record.stream);
      track.addEventListener("ended", () => { if (!record.closed) close(record, "The microphone stopped."); }, { once: true });
    }
    const offer = await wait(record, pc.createOffer());
    await wait(record, pc.setLocalDescription(offer));
    // One complete SDP exchange; no provider-specific trickle/signaling in the host.
    if (pc.iceGatheringState !== "complete") {
      let listener;
      try {
        await wait(record, new Promise(resolve => {
          listener = () => { if (pc.iceGatheringState === "complete") resolve(); };
          pc.addEventListener("icegatheringstatechange", listener); listener();
        }));
      } finally { pc.removeEventListener("icegatheringstatechange", listener); }
    }
    return { id: record.id, offerSdp: text(pc.localDescription?.sdp, "SDP offer") };
  } catch (error) { if (!record.closed) fail(record, error); throw error; }
}

export async function setRealtimeAudioAnswer(pluginId, id, sdp) {
  const record = owned(pluginId, id);
  text(sdp, "SDP answer");
  if (record.answering) throw new Error("Live audio already received an answer.");
  record.answering = true;
  try { await wait(record, record.pc.setRemoteDescription({ type: "answer", sdp })); return true; }
  catch (error) { if (!record.closed) fail(record, error); throw error; }
}
export function sendRealtimeAudioData(pluginId, id, data) {
  const record = owned(pluginId, id);
  text(data, "Live audio data");
  if (record.channel.readyState !== "open") throw new Error("Live audio data channel is not ready.");
  if (record.channel.bufferedAmount + encoder.encode(data).byteLength > MAX_BUFFERED_BYTES) throw new Error("Live audio data channel is busy; nothing was sent.");
  record.channel.send(data); return true;
}
export function closeRealtimeAudio(pluginId, id) {
  return current?.pluginId === pluginId && current.id === id ? close(current) : false;
}
export function stopPluginRealtimeAudio(pluginId) { if (current?.pluginId === pluginId) close(current); }
export function cancelRealtimeAudioOpen(pluginId, openingKey) {
  if (openingKey && current?.pluginId === pluginId && current.openingKey === openingKey) close(current);
}

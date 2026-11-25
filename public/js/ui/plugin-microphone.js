// One host-owned microphone channel for sandboxed plugin clients. The browser keeps permission, MediaStream,
// AudioContext and AudioWorklet in CliDeck's trusted window; the plugin Worker receives only transferred mono
// PCM16 chunks. A second plugin can never listen over the first one.
import { realtimeMediaOwner } from "./plugin-media.js";
const WORKLET_URL = "/js/plugin-microphone-worklet.js";
const INFO = Object.freeze({ sampleRate: 16000, channels: 1, format: "pcm-s16le" });
let current = null, pending = null;

function microphoneError(error) {
  if (error && error.name === "NotAllowedError") return new Error("Microphone permission was denied.");
  if (error && error.name === "NotFoundError") return new Error("No microphone is available.");
  if (error && error.name === "NotReadableError") return new Error("The microphone is already in use.");
  return new Error(error && error.message || "Microphone capture could not start.");
}
function stopTracks(stream) { for (const track of (stream && stream.getTracks && stream.getTracks()) || []) { try { track.stop(); } catch {} } }
async function dispose(record, state) {
  if (!record) return;
  if (record.disposing) return record.disposing;
  record.disposing = finishDispose(record, state);
  return record.disposing;
}
async function finishDispose(record, state) {
  // Deliver the final fraction of a 100 ms frame before acknowledging Stop.
  // A dead/suspended worklet must never prevent releasing the microphone.
  if (current === record && state === "stopped") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 200);
      record.flushed = () => { clearTimeout(timer); resolve(); };
      try { record.node.port.postMessage({ type: "flush" }); } catch { record.flushed(); }
    });
  }
  if (current === record) current = null;
  try { record.node.port.onmessage = null; record.node.disconnect(); } catch {}
  try { record.source.disconnect(); } catch {}
  stopTracks(record.stream);
  try { await record.context.close(); } catch {}
  try { record.onState({ state }); } catch {}
}

async function begin(pluginId, onData, onState) {
  const media = typeof navigator !== "undefined" && navigator.mediaDevices;
  const Context = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  const WorkletNode = typeof window !== "undefined" && window.AudioWorkletNode;
  if (!media || typeof media.getUserMedia !== "function") throw new Error("Microphone capture is unavailable in this browser.");
  if (!Context || !WorkletNode) throw new Error("AudioWorklet microphone capture is unavailable in this browser.");
  let stream = null, context = null, source = null, node = null, record = null;
  try {
    stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    context = new Context({ sampleRate: INFO.sampleRate, latencyHint: "interactive" });
    if (context.sampleRate !== INFO.sampleRate) throw new Error("This browser cannot provide 16 kHz microphone audio.");
    await context.audioWorklet.addModule(WORKLET_URL);
    source = context.createMediaStreamSource(stream);
    node = new WorkletNode(context, "clideck-pcm16", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    record = { pluginId, stream, context, source, node, onData, onState };
    node.port.onmessage = (event) => {
      if (current !== record) return;
      if (event.data?.type === "flushed") { record.flushed?.(); return; }
      const buffer = event.data && event.data.type === "pcm" ? event.data.buffer : null;
      if (buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.byteLength <= 64 * 1024) onData(buffer, INFO);
    };
    source.connect(node); node.connect(context.destination);
    for (const track of stream.getTracks()) track.addEventListener?.("ended", () => { if (current === record) dispose(record, "ended"); }, { once: true });
    current = record;
    if (context.state === "suspended" && context.resume) await context.resume();
    onState({ state: "listening" });
    return INFO;
  } catch (error) {
    if (current === record) current = null;
    try { node && node.disconnect(); } catch {} try { source && source.disconnect(); } catch {}
    stopTracks(stream); try { context && await context.close(); } catch {}
    throw microphoneError(error);
  }
}

export function startPluginMicrophone(pluginId, onData, onState = () => {}) {
  pluginId = String(pluginId || "");
  if (realtimeMediaOwner()) return Promise.reject(new Error("Stop live voice before starting another microphone recording."));
  if (current) return current.pluginId === pluginId ? Promise.resolve(INFO) : Promise.reject(new Error("The microphone is already in use by another plugin."));
  if (pending) return pending.pluginId === pluginId ? pending.promise : Promise.reject(new Error("The microphone is already being opened by another plugin."));
  const opening = { pluginId, cancelled: false, promise: null };
  const promise = begin(pluginId, typeof onData === "function" ? onData : () => {}, typeof onState === "function" ? onState : () => {})
    .then(async (info) => {
      if (!opening.cancelled) return info;
      if (current && current.pluginId === pluginId) await dispose(current, "stopped");
      throw new Error("Microphone capture was cancelled.");
    })
    .finally(() => { if (pending === opening) pending = null; });
  opening.promise = promise; pending = opening; return promise;
}

export async function stopPluginMicrophone(pluginId) {
  if (pending && (!pluginId || pending.pluginId === pluginId)) { pending.cancelled = true; return true; }
  if (!current || (pluginId && current.pluginId !== pluginId)) return false;
  const record = current; await dispose(record, "stopped"); return true;
}

export function pluginMicrophoneOwner() { return current?.pluginId || pending?.pluginId || ""; }

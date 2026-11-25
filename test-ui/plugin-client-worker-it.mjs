const sent = [];
globalThis.self = {
  location: { href: "http://127.0.0.1/js/plugin-client-worker.js?id=client-test" },
  postMessage(message, transfer) { sent.push({ message, transfer }); },
  close() {},
};
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }

await import("../public/js/plugin-client-worker.js?test=" + Date.now());
const source = `
  export function activate(api) {
    globalThis.__pluginClientApi = api;
    api.send("initial-settings", api.getSettings());
    api.onSettingsChange((next, previous) => api.send("settings-changed", { next, previous }));
  }
`;
const clientUrl = "data:text/javascript," + encodeURIComponent(source);
await self.onmessage({ data: { type: "init", clientUrl, capabilities: { realtimeAudio: true }, settings: { values: { voice: "warm" }, configured: { token: true } } } });
const initial = sent.find(({ message }) => message.type === "send" && message.event === "initial-settings")?.message.data;
ok("client getSettings returns the masked host snapshot at activation", initial?.values.voice === "warm" && initial?.configured.token === true);
ok("client activation completes inside the Worker", sent.some(({ message }) => message.type === "ready"));

await self.onmessage({ data: { type: "settings", settings: { values: { voice: "clear" }, configured: { token: false } } } });
const changed = sent.find(({ message }) => message.type === "send" && message.event === "settings-changed")?.message.data;
ok("onSettingsChange receives isolated next and previous snapshots", changed?.next.values.voice === "clear" && changed?.previous.values.voice === "warm" && changed.next.configured.token === false);

const beforeAudio = sent.length;
let tooLarge = "";
try { globalThis.__pluginClientApi.playAudio(new ArrayBuffer(64 * 1024 * 1024 + 1)); }
catch (error) { tooLarge = error.message; }
ok("oversized audio is rejected before ownership transfer", /exceeds 64 MB/.test(tooLarge) && sent.length === beforeAudio);

const toggled = globalThis.__pluginClientApi.toggleAudio();
const toggleRequest = sent.find(({ message }) => message.type === "request" && message.method === "toggle-audio")?.message;
await self.onmessage({ data: { type: "response", requestId: toggleRequest?.requestId, success: true, value: true } });
ok("client audio toggles use bounded host RPC", toggleRequest?.requestId && await toggled === true);

const viewerText = globalThis.__pluginClientApi.getViewerText("document-1");
const viewerTextRequest = sent.find(({ message }) => message.type === "request" && message.method === "get-viewer-text")?.message;
await self.onmessage({ data: { type: "response", requestId: viewerTextRequest?.requestId, success: true, value: "Rendered document" } });
ok("active viewer text carries the clicked document identity through requester RPC", viewerTextRequest?.requestId && viewerTextRequest.contentId === "document-1" && await viewerText === "Rendered document");

// The selection snapshot is how a plugin says WHERE it is reading from. The anchor is opaque to it: carried
// back verbatim into playAudio's readAlong, or into a cache key, and never parsed.
const snapshot = globalThis.__pluginClientApi.getTerminalSelectionSnapshot();
const snapshotRequest = sent.find(({ message }) => message.type === "request" && message.method === "get-terminal-selection-snapshot")?.message;
await self.onmessage({ data: { type: "response", requestId: snapshotRequest?.requestId, success: true, value: { sessionId: "S", text: "run the tests", anchor: "ra1.0.S.12.0.12.13" } } });
const selection = await snapshot;
ok("the terminal selection snapshot carries its text and an opaque cell anchor through requester RPC",
  snapshotRequest?.requestId && selection?.sessionId === "S" && selection.text === "run the tests" && selection.anchor === "ra1.0.S.12.0.12.13");

const activeViewerText = globalThis.__pluginClientApi.getActiveViewerText();
const activeViewerRequest = sent.find(({ message }) => message.type === "request" && message.method === "get-active-viewer-text")?.message;
await self.onmessage({ data: { type: "response", requestId: activeViewerRequest?.requestId, success: true, value: { id: "document-1", kind: "markdown", text: "Rendered document", selection: "Rendered" } } });
const activeViewer = await activeViewerText;
ok("hotkeys request active viewer identity, text and selection atomically", activeViewerRequest?.requestId && activeViewer?.id === "document-1" && activeViewer.kind === "markdown" && activeViewer.text === "Rendered document" && activeViewer.selection === "Rendered");

const picked = globalThis.__pluginClientApi.openPicker({ id: "mood", title: "Choose a mood", items: [{ id: "calm", glyph: "◌", label: "Calm" }] });
const pickerRequest = [...sent].reverse().find(({ message }) => message.type === "request" && message.method === "open-picker")?.message;
await self.onmessage({ data: { type: "response", requestId: pickerRequest?.requestId, success: true, value: "calm" } });
ok("declarative pickers cross the Worker boundary as bounded host RPC", pickerRequest?.options.items[0].label === "Calm" && await picked === "calm");

const micChunks = [], micStates = [], compositionActions = [];
globalThis.__pluginClientApi.onMicrophoneData((buffer, info) => micChunks.push({ buffer, info }));
globalThis.__pluginClientApi.onMicrophoneState((state) => micStates.push(state));
globalThis.__pluginClientApi.onTerminalCompositionAction((action) => compositionActions.push(action));
const started = globalThis.__pluginClientApi.startMicrophone();
const startRequest = [...sent].reverse().find(({ message }) => message.type === "request" && message.method === "start-microphone")?.message;
await self.onmessage({ data: { type: "response", requestId: startRequest?.requestId, success: true, value: { sampleRate: 16000, channels: 1, format: "pcm-s16le" } } });
ok("microphone startup is a bounded host request", (await started)?.format === "pcm-s16le");
const pcm = new ArrayBuffer(3200);
await self.onmessage({ data: { type: "microphone-data", buffer: pcm, info: { sampleRate: 16000, channels: 1, format: "pcm-s16le" } } });
await self.onmessage({ data: { type: "microphone-state", state: { state: "listening" } } });
ok("microphone data and state stay inside registered Worker callbacks", micChunks[0]?.buffer === pcm && micChunks[0]?.info.sampleRate === 16000 && micStates[0]?.state === "listening");

const opening = globalThis.__pluginClientApi.openTerminalComposition({ state: "listening", title: "Dictation" });
const openRequest = [...sent].reverse().find(({ message }) => message.type === "request" && message.method === "open-terminal-composition")?.message;
await self.onmessage({ data: { type: "response", requestId: openRequest?.requestId, success: true, value: { sessionId: "S" } } });
ok("composition opens through typed Worker RPC", (await opening)?.sessionId === "S" && openRequest.options.title === "Dictation");
globalThis.__pluginClientApi.updateTerminalComposition({ state: "ready", draft: "Hello" });
globalThis.__pluginClientApi.closeTerminalComposition();
await self.onmessage({ data: { type: "terminal-composition-action", action: { type: "send", sessionId: "S" } } });
ok("composition updates, close and actions preserve the compact contract", sent.some(({ message }) => message.type === "terminal-composition-update" && message.patch.draft === "Hello") && sent.some(({ message }) => message.type === "terminal-composition-close") && compositionActions[0]?.type === "send");

const committed = globalThis.__pluginClientApi.commitTerminalDraft("Hello", { sessionId: "S", submit: true });
const commitRequest = [...sent].reverse().find(({ message }) => message.type === "request" && message.method === "commit-terminal-draft")?.message;
await self.onmessage({ data: { type: "response", requestId: commitRequest?.requestId, success: true, value: true } });
ok("terminal draft commit carries explicit session and submit intent", await committed === true && commitRequest.text === "Hello" && commitRequest.options.sessionId === "S" && commitRequest.options.submit === true);

const api = globalThis.__pluginClientApi;
ok("realtime capability comes from the host and is frozen", api.capabilities.realtimeAudio === true && Object.isFrozen(api.capabilities));
for (const [method, args, rpc, response] of [
  ["openRealtimeAudio", [{ sessionId: "S", channelLabel: "voice" }], "open-realtime-audio", { id: "rtc-1", offerSdp: "v=0" }],
  ["setRealtimeAudioAnswer", ["rtc-1", "answer"], "set-realtime-audio-answer", true],
  ["sendRealtimeAudioData", ["rtc-1", "{}"], "send-realtime-audio-data", true],
  ["closeRealtimeAudio", ["rtc-1"], "close-realtime-audio", false],
  ["openSettings", [], "open-settings", true],
]) {
  const pending = api[method](...args), request = sent.at(-1).message;
  await self.onmessage({ data: { type: "response", requestId: request.requestId, success: true, value: response } });
  ok(method + " returns the host receipt through its own RPC", request.method === rpc && await pending === response && (method === "openSettings" ? !request.id : true));
}
const invalid = api.setRealtimeAudioAnswer("stale", "answer");
const request = sent.at(-1).message;
await self.onmessage({ data: { type: "response", requestId: request.requestId, success: false, error: "stale connection" } });
let rejected = false; try { await invalid; } catch (error) { rejected = error.message === "stale connection"; }
ok("stale/error receipts reject rather than report success", rejected);
const controller = new AbortController();
const cancelOpening = api.openRealtimeAudio({ sessionId: "S", signal: controller.signal });
const cancellableRequest = sent.at(-1).message; controller.abort();
ok("AbortSignal stays in Worker and cancellation targets exactly its pending request", !('signal' in cancellableRequest.options) && sent.at(-1).message.type === "cancel-realtime-open" && sent.at(-1).message.requestId === cancellableRequest.requestId);
await self.onmessage({ data: { type: "response", requestId: cancellableRequest.requestId, success: false, error: "closed" } });
try { await cancelOpening; } catch {}
const beforeAborted = sent.length;
try { await api.openRealtimeAudio({ sessionId: "S", signal: controller.signal }); } catch {}
ok("an already aborted start never asks the host to capture", sent.length === beforeAborted);
const focusEvents = [], realtimeEvents = [];
const removeFocus = api.onActiveSessionChange(value => focusEvents.push(value));
ok("first focus listener subscribes for an authoritative initial snapshot", sent.at(-1).message.type === "watch-active-session" && sent.at(-1).message.enabled);
let finishSlow;
const removeSlow = api.onRealtimeAudioEvent(() => new Promise(resolve => { finishSlow = resolve; }));
const removeRealtime = api.onRealtimeAudioEvent(value => realtimeEvents.push(value));
await self.onmessage({ data: { type: "realtime-audio", event: { id: "rtc-1", sessionId: "S", type: "data", data: "{}" } } });
await self.onmessage({ data: { type: "active-session", focus: { session: { id: "S" }, focused: false, visible: true, connected: true } } });
ok("pending async data handler cannot delay other handlers or focus loss", realtimeEvents.length === 1 && focusEvents[0]?.focused === false);
const second = [];
const removeSecond = api.onActiveSessionChange(value => { second.push(value); value.session.id = "mutated"; });
await Promise.resolve(); await Promise.resolve();
ok("later listener gets a cloned initial snapshot", second.length === 1 && focusEvents[0].session.id === "S");
finishSlow(); removeSlow(); removeRealtime(); removeSecond(); removeFocus();
ok("last focus unsubscribe tears down its host subscription", sent.at(-1).message.type === "watch-active-session" && sent.at(-1).message.enabled === false);
// Node treats this import-free Worker file as CommonJS and ignores query cache keys;
// a fresh module URL models the separate Worker that an old page would actually start.
const workerSource = await (await import("node:fs/promises")).readFile(new URL("../public/js/plugin-client-worker.js", import.meta.url), "utf8");
await import("data:text/javascript," + encodeURIComponent(workerSource));
await self.onmessage({ data: { type: "init", clientUrl } });
ok("new Worker on an old host never invents realtime support", globalThis.__pluginClientApi.capabilities.realtimeAudio === undefined);

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin client Worker checks passed`);

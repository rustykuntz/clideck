import { installFakeDom } from "./fakedom.mjs";
const { body } = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
const actionButton = document.createElement("button"); actionButton.id = "plugin-actions"; actionButton.hidden = true; body.append(actionButton);
const paneTabs = document.createElement("div"); paneTabs.id = "pane-tabs"; body.append(paneTabs);
const paneBody = document.createElement("div"); paneBody.id = "pane-body"; body.append(paneBody);
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; paneBody.append(termPanel);
globalThis.fetch = async (url) => ({ ok: true, text: async () => url === "/content/hotkey-doc" ? "Hotkey document" : "" });
const workers = [];
class FakeWorker {
  constructor(url) { this.url = url; this.sent = []; workers.push(this); this.onmessage = this.onerror = null; }
  emit(data) { this.onmessage && this.onmessage({ data }); }
  postMessage(message) {
    this.sent.push(message);
    if (message.type !== "invoke" || (message.method === "match-action" && message.id === "slow") || ["long-action", "stop-action"].includes(message.id)) return;
    setTimeout(() => this.emit({ type: "invoke-result", requestId: message.requestId, success: true, value: message.method === "match-action" ? true : null }), 0);
  }
  terminate() {}
}
globalThis.Worker = FakeWorker;
class FakeAudio {
  constructor() { this.paused = true; this.duration = 65; this.currentTime = 0; this._on = {}; }
  addEventListener(type, fn) { (this._on[type] || (this._on[type] = [])).push(fn); }
  _emit(type) { for (const fn of this._on[type] || []) fn(); }
  async play() { this.paused = false; this._emit("play"); }
  pause() { this.paused = true; this._emit("pause"); }
  removeAttribute() {} load() {}
}
globalThis.Audio = FakeAudio;
URL.createObjectURL = () => "blob:plugin-audio"; URL.revokeObjectURL = () => {};
const checks = [];
function ok(name, pass) { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); }
const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));
const clickTab = (name) => [...document.querySelectorAll(".cd-tab")].find((tab) => tab.textContent.includes(name))?._fire("click");
const plugin = (overrides = {}) => ({
  id: "safe-client", name: "Safe Client", version: "1.0.0", enabled: true, status: "ready",
  clientUrl: "/plugins/safe-client/client.js",
  settings: [{ key: "label", type: "text" }, { key: "token", type: "secret" }],
  values: { label: "First", token: "must-never-cross" }, configured: { token: true },
  viewers: [{ id: "preview", kind: "safe-client/preview", mime: "text/html" }],
  ...overrides,
});

const { store } = await import("../public/js/store.js");
const { initContentDock, presentInDock } = await import("../public/js/ui/content-dock.js");
const { initPluginHost, __runtimeCountForTest, pluginClientError, pluginActionContext } = await import("../public/js/ui/plugin-host.js");
const { resolveActions, runAction } = await import("../public/js/ui/action-registry.js");
const { viewerFor } = await import("../public/js/ui/viewer-registry.js");
const { closeMenu } = await import("../public/js/ui/menu.js");
initContentDock(); initPluginHost();
store.applyEvent({ type: "session.created", sessionId: "S", provider: "shell", name: "Shell", cwd: "/tmp", live: true });
store.applyEvent({ type: "plugins", plugins: [plugin()] });
ok("ready client starts one sandbox runtime", workers.length === 1 && __runtimeCountForTest() === 1);
const init = workers[0].sent.find((message) => message.type === "init");
ok("host Worker bootstrap never imports plugin code into the window", workers[0].url === "/js/plugin-client-worker.js?id=safe-client" && init?.clientUrl.startsWith("/plugins/safe-client/client.js?v="));
ok("client settings expose ordinary values and mask configured secrets", init?.settings.values.label === "First" && !("token" in init.settings.values) && init.settings.configured.token === true);
ok("browser host advertises its own realtime implementation", init.capabilities?.realtimeAudio === true);
workers[0].emit({ type: "watch-active-session", enabled: true });
ok("focus subscription sends its initial session without polling", workers[0].sent.at(-1)?.type === "active-session" && workers[0].sent.at(-1).focus.session.id === "S");
store.setConnected(true);
ok("connection changes reach subscribed Workers", workers[0].sent.at(-1)?.type === "active-session" && workers[0].sent.at(-1).focus.connected === true);
workers[0].emit({ type: "request", method: "open-realtime-audio", requestId: "unfocused-rtc", options: { sessionId: "S" } });
await tick();
ok("host refuses unfocused audio through the caller receipt", workers[0].sent.some(message => message.requestId === "unfocused-rtc" && message.type === "response" && !message.success && /Focus this session/.test(message.error)));

workers[0].emit({ type: "request", method: "get-viewer-text", requestId: "viewer-empty", contentId: "missing" });
await tick();
ok("viewer text is requester-only and empty when the terminal is active", workers[0].sent.some((message) => message.type === "response" && message.requestId === "viewer-empty" && message.success && message.value === ""));

presentInDock({ sessionId: "S", contentId: "hotkey-doc", kind: "text", name: "Hotkey.txt", url: "/content/hotkey-doc" });
await tick();
workers[0].emit({ type: "request", method: "get-active-viewer-text", requestId: "viewer-hotkey" });
await tick();
ok("hotkey requester receives one active viewer identity and rendered text snapshot", workers[0].sent.some((message) => message.type === "response" && message.requestId === "viewer-hotkey" && message.success && message.value?.id === "hotkey-doc" && message.value?.kind === "text" && message.value?.text === "Hotkey document" && message.value?.selection === ""));

presentInDock({ sessionId: "S", contentId: "doc-a", kind: "html", name: "A.html", url: "/content/doc-a" });
presentInDock({ sessionId: "S", contentId: "doc-b", kind: "html", name: "B.html", url: "/content/doc-b" });
workers[0].emit({ type: "request", method: "get-viewer-text", requestId: "viewer-stale", contentId: "doc-a" });
await tick();
ok("a click request for A cannot read B after the active tab changes", workers[0].sent.some((message) => message.type === "response" && message.requestId === "viewer-stale" && message.success && message.value === ""));

// Wiring only — the anchor itself needs real cells and is gated in parity/probes/cdp-gate-readalong.cjs.
// With no terminal there is no selection, and the host answers with null rather than a half-built snapshot.
workers[0].emit({ type: "request", method: "get-terminal-selection-snapshot", requestId: "selection-snapshot" }); await tick();
ok("a selection snapshot request is answered by the host, and is null when nothing is selected",
  workers[0].sent.some((message) => message.type === "response" && message.requestId === "selection-snapshot" && message.success && message.value === null));
ok("an action context carries an anchor field on the terminal and nothing on other surfaces",
  pluginActionContext("terminal", "run the tests").selection.anchor === "" && pluginActionContext("viewer", "x").selection.anchor === "");

workers[0].emit({ type: "request", method: "open-picker", requestId: "picker-choose", options: { id: "mood", title: "Choose a mood", items: [{ id: "calm", glyph: "<b>", label: "Calm" }, { id: "bold", glyph: "◆", label: "Bold" }] } });
await tick();
const pickerItem = document.querySelector('.pk-item[data-item-id="calm"]');
ok("Worker picker request opens one host-owned declarative surface", !!pickerItem && pickerItem.querySelector(".pk-glyph").textContent === "<b>" && !pickerItem.querySelector("b"));
pickerItem._fire("click"); await tick();
ok("picker choice returns through the originating request", workers[0].sent.some((message) => message.type === "response" && message.requestId === "picker-choose" && message.success && message.value === "calm"));

workers[0].emit({ type: "register-action", definition: { id: "inspect", label: "Inspect", placements: ["terminal.header", "terminal.context"], hasWhen: true, icon: "\u263a" } });
workers[0].emit({ type: "register-action", definition: { id: "glyph", label: "Glyph", placements: ["terminal.header"], icon: "★" } });
workers[0].emit({ type: "register-action", definition: { id: "slow", label: "Slow", placements: ["terminal.context"], hasWhen: true } });
workers[0].emit({ type: "register-action", definition: { id: "long-action", label: "Long action", placements: ["terminal.header"], icon: "waveform" } });
workers[0].emit({ type: "register-action", definition: { id: "stop-action", label: "Stopped action", placements: ["terminal.header"], icon: "no-such-icon" } });
await tick();
ok("worker registration reaches the host-owned header", actionButton.hidden === false);

// ── the plugin centre menu carries the plugin's own icon, resolved by the HOST ────────────────────
actionButton._fire("click"); await tick();
const pluginRows = [...document.querySelectorAll(".menu .menu-item")];
const rowFor = (label) => pluginRows.find((row) => row.querySelector(".menu-lb")?.textContent === label);
ok("the plugin menu opened with a row per header action", pluginRows.length === 4 && !!rowFor("Inspect") && !!rowFor("Long action") && !!rowFor("Glyph"));
ok("an iconed menu declares itself, so every row shares one label column",
  document.querySelector(".menu").classList.contains("menu-iconed") && pluginRows.every((row) => !!row.querySelector(".menu-ic")));
ok("an unnamed single-glyph icon renders as that glyph", rowFor("Glyph").querySelector(".menu-ic").textContent === "★");
const markOf = (label) => rowFor(label).querySelector(".menu-ic").firstElementChild.innerHTML;
ok("the recognized smile glyph renders as the deck's outline icon",
  /^<svg /.test(markOf("Inspect")) && /<circle /.test(markOf("Inspect")) && !rowFor("Inspect").querySelector(".menu-ic").textContent.includes("\u263a"));
ok("a named icon renders as one of the deck's own marks, never the literal word",
  /^<svg /.test(markOf("Long action")) && !/waveform/.test(rowFor("Long action").textContent));
ok("an unknown icon name degrades to the plugin mark rather than to text",
  /^<svg /.test(markOf("Stopped action")) && !/no-such-icon/.test(rowFor("Stopped action").textContent));
ok("the deck draws each named mark differently, so the icon still means something",
  markOf("Long action") !== markOf("Stopped action"));
ok("the row's label stays a plain text node beside the icon", rowFor("Inspect").querySelector(".menu-lb").textContent === "Inspect");
closeMenu(); await tick();
const started = Date.now(), actions = await resolveActions("terminal.context", { selection: { text: "x" } }), elapsed = Date.now() - started;
ok("a stalled plugin predicate is bounded without hiding healthy actions", actions.length === 1 && actions[0].id === "inspect" && elapsed >= 100 && elapsed < 260 && !pluginClientError("safe-client"));
const headerActions = await resolveActions("terminal.header", {});
let longSettled = false;
const longRun = runAction(headerActions.find((action) => action.id === "long-action")).then((value) => { longSettled = true; return value; });
const longRequest = [...workers[0].sent].reverse().find((message) => message.type === "invoke" && message.id === "long-action");
await tick(3100);
ok("semantic actions remain pending beyond three seconds", !!longRequest && !longSettled);
workers[0].emit({ type: "invoke-result", requestId: longRequest.requestId, success: true, value: "complete" });
ok("a long semantic action still resolves normally", await longRun === true);

workers[0].emit({ type: "register-workspace", definition: { id: "board", title: "Board", src: "/plugins/safe-client/public/app.html" } });
workers[0].emit({ type: "register-viewer", registrationId: "preview", definition: { id: "preview", kind: "safe-client/preview", title: "Preview", src: "/plugins/safe-client/public/viewer.html" } });
workers[0].emit({ type: "open-workspace", id: "board", options: {} });
await tick();
const frame = document.querySelector("iframe.plugin-workspace");
const frameMessages = []; frame.contentWindow = { postMessage: (message) => frameMessages.push(message) };
ok("workspace opens in the existing tab shell", !!frame && !paneTabs.hidden);
ok("workspace iframe is script-capable but opaque-origin sandboxed", frame?.getAttribute("sandbox") === "allow-scripts allow-forms allow-downloads" && !frame?.getAttribute("sandbox").includes("allow-same-origin"));
clickTab("Terminal");
ok("switching away keeps the plugin browsing context mounted", frame.parentNode === paneBody && frame.hidden === true);
clickTab("Board");
ok("switching back restores the exact same iframe", document.querySelector("iframe.plugin-workspace") === frame && frame.hidden === false);
store.applyEvent({ type: "plugin.message", pluginId: "safe-client", event: "pong", data: { ok: true }, requestId: "reply-7" });
ok("the retained frame keeps its message bridge", frameMessages.some((message) => message.type === "clideck.message" && message.data.event === "pong"));
ok("requester replies preserve their request identity at the Worker boundary", workers[0].sent.some((message) => message.type === "plugin-message" && message.requestId === "reply-7"));
ok("only manifest-declared viewer kinds can register", viewerFor("safe-client/preview")?.pluginId === "safe-client");
workers[0].emit({ type: "register-viewer", registrationId: "rogue", definition: { id: "rogue", kind: "safe-client/rogue", src: "/plugins/safe-client/public/viewer.html" } });
ok("undeclared client viewers are rejected", viewerFor("safe-client/rogue") === null && /not declared/.test(pluginClientError("safe-client")));

presentInDock({ sessionId: "S", contentId: "asset-1", kind: "safe-client/preview", name: "Preview asset", url: "/content/asset-1" });
await tick();
ok("persisted plugin content renders in its declared viewer", !!document.querySelector("iframe.plugin-viewer"));
store.applyEvent({ type: "plugins", plugins: [plugin({ values: { label: "Second", token: "still-private" } })] });
const settingsUpdate = workers[0].sent.find((message) => message.type === "settings");
ok("settings changes reach the live client without exposing secrets", settingsUpdate?.settings.values.label === "Second" && !("token" in settingsUpdate.settings.values));

workers[0].emit({ type: "play-audio", buffer: new ArrayBuffer(128), options: { mime: "audio/wav", title: "Local preview" } });
await tick();
const player = document.querySelector(".plugin-audio");
ok("plugin audio opens one visible host-owned player", player && player.hidden === false && /Local preview/.test(player.textContent));
workers[0].emit({ type: "request", method: "toggle-audio", requestId: "audio-toggle" }); await tick();
ok("plugin audio toggle pauses through requester RPC", workers[0].sent.some((message) => message.type === "response" && message.requestId === "audio-toggle" && message.success && message.value === true) && document.querySelector(".plugin-audio-play").getAttribute("aria-label") === "Play");
document.querySelector(".plugin-audio-play")._fire("click"); await tick();
ok("host player exposes pause and resume controls", document.querySelector(".plugin-audio-play").getAttribute("aria-label") === "Pause");

workers[0].emit({ type: "request", method: "open-terminal-composition", requestId: "composition-open", options: { state: "listening", title: "Local Dictation", canStop: true } });
await tick();
ok("Worker opens only the host-owned terminal composition", workers[0].sent.some((message) => message.type === "response" && message.requestId === "composition-open" && message.success && message.value.sessionId === "S") && document.querySelector(".plugin-composition")?.parentNode === termPanel);
workers[0].emit({ type: "terminal-composition-update", patch: { state: "ready", draft: "Ship the focused fix.", canSend: true } });
document.querySelector(".pc-send")._fire("click");
ok("composition actions return to the owning Worker", document.querySelector(".pc-draft").textContent === "Ship the focused fix." && workers[0].sent.some((message) => message.type === "terminal-composition-action" && message.action.type === "send" && message.action.sessionId === "S"));

workers[0].emit({ type: "request", method: "open-picker", requestId: "picker-teardown", options: { id: "teardown", title: "Tear down", items: [{ id: "one", glyph: "1", label: "One" }] } });
await tick();
const stopRun = runAction(headerActions.find((action) => action.id === "stop-action"));
await tick();
store.applyEvent({ type: "plugins", plugins: [plugin({ enabled: false, status: "disabled" })] });
await tick();
ok("disable removes runtime actions and client-owned workspaces", __runtimeCountForTest() === 0 && (await resolveActions("terminal.context", { selection: { text: "x" } })).length === 0 && ![...document.querySelectorAll(".cd-tab")].some((tab) => tab.textContent.includes("Board")));
ok("plugin teardown cancels its active picker", !document.querySelector(".pk-overlay") && workers[0].sent.some((message) => message.type === "response" && message.requestId === "picker-teardown" && message.success && message.value === null));
ok("runtime teardown rejects a still-pending semantic action", await stopRun === false);
ok("persisted custom content survives disable with an unavailable state", [...document.querySelectorAll(".cd-tab")].some((tab) => tab.textContent.includes("Preview asset")) && !!document.querySelector(".cd-error"));
ok("disable removes plugin viewer registrations, audio and composition", viewerFor("safe-client/preview") === null && player.hidden === true && !document.querySelector(".plugin-composition"));

store.applyEvent({ type: "plugins", plugins: [plugin({ values: { label: "Second", token: "private" } })] });
await tick();
workers[1].emit({ type: "register-viewer", registrationId: "preview", definition: { id: "preview", kind: "safe-client/preview", title: "Preview", src: "/plugins/safe-client/public/viewer.html" } });
await tick();
ok("re-enable rebuilds the preserved asset in its viewer", [...document.querySelectorAll(".cd-tab")].some((tab) => tab.textContent.includes("Preview asset")) && !!document.querySelector("iframe.plugin-viewer"));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin host checks passed`);

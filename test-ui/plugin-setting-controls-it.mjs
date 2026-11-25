import { installFakeDom, installFakeWs } from "./fakedom.mjs";

const dom = installFakeDom();
const { body } = dom;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: { writeText: async () => {} } } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn"]) { const el = document.createElement("button"); el.id = id; body.append(el); }

class FakeAudio {
  static instances = [];
  static failNext = false;
  constructor(url) { this.url = url; this.paused = true; this.pauseCalls = 0; this.loadCalls = 0; this.listeners = {}; FakeAudio.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
  play() { this.paused = false; if (FakeAudio.failNext) { FakeAudio.failNext = false; return Promise.reject(new Error("blocked")); } return Promise.resolve(); }
  pause() { this.paused = true; this.pauseCalls++; }
  removeAttribute() {}
  load() { this.loadCalls++; }
  emit(type) { for (const fn of this.listeners[type] || []) fn(); }
}
globalThis.Audio = FakeAudio;

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 8));
const key = (code, mods = {}) => ({ code, key: code.replace(/^Key/, "").toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { registerHotkey, unregisterAllForPlugin } = await import("../public/js/ui/hotkeys.js");
const { openSettings, openPluginSettings } = await import("../public/js/ui/settings.js");
connectWs(); await tick(); openSettings(); await tick();

const demo = {
  id: "voice-demo", name: "Voice Demo", version: "1.0.0", description: "Generic setting controls.", source: "user", enabled: true, status: "ready", error: "", commands: [], clientUrl: "", hasWorkspaceAssets: true,
  settings: [
    { key: "voice", label: "Voice", type: "select", default: "f1", options: [{ value: "f1", label: "Female One", preview: "public/previews/f1.wav" }, { value: "f2", label: "Female Two", preview: "public/previews/f2.wav" }] },
    { key: "mood", label: "Mood", type: "dynamic-select", default: "calm", options: [{ value: "calm", label: "Calm", preview: "/plugins/voice-demo/public/previews/calm.wav" }] },
    { key: "shortcut", label: "Speak shortcut", type: "shortcut", default: "" },
  ], values: { voice: "f1", mood: "calm", shortcut: "" }, configured: {},
};
const other = { id: "other", name: "Other", version: "1.0.0", description: "No controls.", source: "user", enabled: true, status: "ready", settings: [], values: {}, configured: {}, commands: [], clientUrl: "" };
store.applyEvent({ type: "plugins", plugins: [demo, other] });
[...document.querySelectorAll(".set-cat")].find((el) => el.textContent === "Plugins")._fire("click");
[...document.querySelectorAll(".plg-row-main")].find((el) => /Voice Demo/.test(el.textContent))._fire("click");

let previews = [...document.querySelectorAll(".plg-preview")];
ok("preview controls are generic, compact toggles with accessible labels", previews.length === 2 && previews[0].getAttribute("aria-pressed") === "false" && previews[0].getAttribute("aria-label") === "Play Female One preview");
previews[0]._fire("click");
ok("play becomes pause and resolves a plugin-relative asset", previews[0].classList.contains("playing") && previews[0].getAttribute("aria-pressed") === "true" && previews[0].getAttribute("aria-label") === "Pause Female One preview" && FakeAudio.instances[0].url === "/plugins/voice-demo/public/previews/f1.wav");
previews[1]._fire("click");
ok("starting a second preview stops and resets the first", FakeAudio.instances[0].paused && FakeAudio.instances[0].loadCalls === 1 && previews[0].getAttribute("aria-pressed") === "false" && previews[1].getAttribute("aria-pressed") === "true");
FakeAudio.instances[1].emit("ended");
ok("natural completion returns the toggle to play", previews[1].getAttribute("aria-pressed") === "false" && !previews[1].classList.contains("playing"));

const voice = document.querySelector("#plugin-setting-voice-demo-voice");
previews[0]._fire("click"); const selectedAudio = FakeAudio.instances.at(-1); voice.value = "f2"; voice._fire("change");
ok("reselecting a voice stops its active preview", selectedAudio.paused && previews[0].getAttribute("aria-label") === "Play Female Two preview");
previews[0]._fire("click"); const switchedAudio = FakeAudio.instances.at(-1); openPluginSettings("other");
ok("switching plugin details cleans up preview audio", switchedAudio.paused && switchedAudio.loadCalls === 1 && !document.querySelector(".plg-preview"));

openPluginSettings("voice-demo"); previews = [...document.querySelectorAll(".plg-preview")];
FakeAudio.failNext = true; previews[0]._fire("click"); await tick();
ok("a playback rejection never wedges the toggle", previews[0].getAttribute("aria-pressed") === "false" && !previews[0].classList.contains("playing"));

ws.clear(); registerHotkey("other-plugin", "Ctrl+Shift+P", () => {});
const recorder = document.querySelector(".plg-shortcut-record"); recorder._fire("click"); recorder._fire("keydown", key("KeyP", { metaKey: true, shiftKey: true })); await tick();
ok("the recorder exposes central-registry conflicts without saving", /Already used by other-plugin/.test(document.querySelector(".plg-shortcut-state").textContent) && !ws.last("plugin.settings.update"));
recorder._fire("keydown", key("KeyU", { metaKey: true, altKey: true })); await tick();
const saved = ws.last("plugin.settings.update");
ok("a free chord is normalized and saved", saved?.pluginId === "voice-demo" && saved.settings.shortcut === "Ctrl+Alt+KeyU" && document.querySelector(".plg-shortcut-keys").textContent === "⌘⌥U");
const clear = document.querySelector(".plg-shortcut-clear"); clear._fire("click"); await tick();
ok("shortcut clear is immediate and accessible", ws.last("plugin.settings.update")?.settings.shortcut === "" && clear.getAttribute("aria-label") === "Clear Speak shortcut keyboard shortcut");
unregisterAllForPlugin("other-plugin");

// ── a BARE function key ──────────────────────────────────────────────────────────────────────────────────
// Reported as "it will not take F5 without a modifier". A function key does not type, so a bare binding does
// not swallow ordinary input — which is why letters and digits still need a modifier. In this build F1-F12
// were already accepted and F13-F24 were not; an event carrying no usable `code` was refused as well.
const fkey = (code, extra = {}) => ({ code, key: code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra });
// ⚠️ A REFUSED key leaves the recorder still recording, so a blind click would toggle it OFF and the next
// keydown would be ignored while the previous refusal's message sat there looking like a pass. Arm it only
// when it is not already armed. (Three checks below "passed" that way before this was fixed.)
const record = (event) => {
  ws.clear();
  if (recorder.getAttribute("aria-pressed") !== "true") recorder._fire("click");
  recorder._fire("keydown", event);
};
const state = () => document.querySelector(".plg-shortcut-state").textContent;

record(fkey("F5")); await tick();
ok("a bare F5 is accepted and saved", ws.last("plugin.settings.update")?.settings.shortcut === "F5" && !/Add Control/.test(state()),
  `${JSON.stringify(ws.last("plugin.settings.update")?.settings?.shortcut)} · ${JSON.stringify(state())}`);
record(fkey("F1")); await tick();
ok("so is F1, the bottom of the range", ws.last("plugin.settings.update")?.settings.shortcut === "F1");
record(fkey("F24")); await tick();
ok("and F24, the top of it — the range is F1 to F24, not F1 to F12",
  ws.last("plugin.settings.update")?.settings.shortcut === "F24", JSON.stringify(state()));

// An event carrying no usable `code`, only `key`. For an F-key the two spellings are identical, so it can be
// recovered unambiguously. NOTE: this shape is constructed here, not observed from a real keyboard.
record({ code: "", key: "F5", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }); await tick();
ok("a function key that arrives with no `code` is still recognised, by its name",
  ws.last("plugin.settings.update")?.settings.shortcut === "F5", JSON.stringify(state()));
record({ code: "Unidentified", key: "F7", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }); await tick();
ok("and so is one the platform calls Unidentified", ws.last("plugin.settings.update")?.settings.shortcut === "F7");

// The line that must NOT move: ordinary typing keys still need a modifier, or a shortcut would eat them.
for (const bare of ["KeyA", "Digit4", "Space", "Enter", "Tab"]) {
  record(fkey(bare, { key: bare })); await tick();
  ok(`a bare ${bare} is still refused, with the reason`, /Add Control/.test(state()) && !ws.last("plugin.settings.update"),
    `${JSON.stringify(state())} · saved ${JSON.stringify(ws.last("plugin.settings.update")?.settings?.shortcut)}`);
}
// A `key` fallback must not become a general one: "a" is not a function key however it arrives.
record({ code: "", key: "a", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }); await tick();
ok("a letter with no `code` is refused too — the fallback is for function keys only", /Add Control/.test(state()) && !ws.last("plugin.settings.update"));

// Conflict detection has to keep working for the newly-allowed keys, or two plugins could claim F5.
registerHotkey("other-plugin", "F5", () => {});
record(fkey("F5")); await tick();
ok("a bare function key already taken is reported, not silently saved over",
  /Already used by other-plugin/.test(state()) && !ws.last("plugin.settings.update"), JSON.stringify(state()));
unregisterAllForPlugin("other-plugin");

// And the registry has to SPELL it the way the recorder saved it, or the shortcut saves and never fires.
let fired = 0;
registerHotkey("voice-demo", "F5", () => { fired += 1; });
const press = (extra) => dom.docFire("keydown", {
  key: "F5", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: document.body,
  preventDefault() {}, stopPropagation() {}, ...extra,
});
press({ code: "F5" });
ok("a saved bare function key actually FIRES through the central dispatcher", fired === 1, `fired ${fired}`);
press({ code: "" });
ok("including when it arrives without a usable `code`, which the recorder now accepts", fired === 2, `fired ${fired}`);
unregisterAllForPlugin("voice-demo");

previews[0]._fire("click"); const closingAudio = FakeAudio.instances.at(-1); document.querySelector(".set-x")._fire("click");
ok("closing Settings stops preview audio", closingAudio.paused && closingAudio.loadCalls === 1);

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} plugin setting control checks passed`);

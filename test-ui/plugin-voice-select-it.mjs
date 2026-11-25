// A preview-wrapped native select must save the SELECT value (not its surrounding preview shell), survive
// the engine inventory echo/reopen, and deliver the updated ordinary setting to the live plugin Worker.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";

const { body, winFire } = installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "", clipboard: {} } });
const ws = installFakeWs();
for (const id of ["settings-btn", "theme-btn", "plugin-actions"]) { const el = document.createElement("button"); el.id = id; body.append(el); }

const workers = [];
class FakeWorker {
  constructor() { this.sent = []; this.onmessage = this.onerror = null; workers.push(this); }
  postMessage(message) { this.sent.push(message); }
  terminate() {}
}
globalThis.Worker = FakeWorker;
// The stand-in has to be able to FAIL. The old one always resolved, so nothing here could tell a preview
// that played from one that silently did nothing — which is the whole of the missing-clip report.
const audios = [];
globalThis.Audio = class {
  constructor(src) { this.src = src; this.listeners = new Map(); this.paused = true; this.currentTime = 0; this.plays = 0; audios.push(this); }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  play() {
    this.plays++;
    if (globalThis.__previewFails) return Promise.reject(new Error('no source'));
    if (globalThis.__previewPending) return new Promise(resolve => { this.resolvePlay = () => { this.paused = false; resolve(); }; });
    this.paused = false; return Promise.resolve();
  }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() { this.currentTime = 0; }
};
globalThis.__previewFails = false;

const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));
const definition = {
  key: "voice", label: "Voice", type: "select", default: "female-1",
  options: [
    { value: "female-1", label: "Female 1", preview: "public/voices/female-1-preview.mp3" },
    { value: "female-2", label: "Female 2", preview: "public/voices/female-2-preview.mp3" },
  ],
};
const plugin = (voice) => ({
  id: "supertonic", name: "Supertonic Voice", version: "1.2.0", source: "bundled", enabled: true, status: "ready",
  settings: [definition], values: { voice }, configured: {}, commands: [], clientUrl: "/plugins/supertonic/client.js",
});

const { connectWs } = await import("../public/js/ws.js");
const { store } = await import("../public/js/store.js");
const { initPluginHost } = await import("../public/js/ui/plugin-host.js");
const { openPluginSettings } = await import("../public/js/ui/settings.js");
const { reserveRealtimeMedia } = await import("../public/js/ui/plugin-media.js");
connectWs(); await tick(); initPluginHost(); store.applyEvent({ type: "plugins", plugins: [plugin("female-1")] });
openPluginSettings("supertonic"); await tick();

let select = document.querySelector("#plugin-setting-supertonic-voice");
select.focus(); ws.clear(); select.value = "female-2"; select._fire("change");
const female2 = ws.last("plugin.settings.update");
ok("Female 2 stays selected and sends the real native control value", select.value === "female-2" && female2?.settings.voice === "female-2");

store.applyEvent({ type: "plugins", plugins: [plugin("female-2")] });
ok("the persisted echo keeps Female 2 visible and reaches the plugin", document.querySelector("#plugin-setting-supertonic-voice")?.value === "female-2" && workers[0].sent.some((message) => message.type === "settings" && message.settings.values.voice === "female-2"));
document.querySelector(".set-x")._fire("click"); await tick(180); openPluginSettings("supertonic"); await tick();
select = document.querySelector("#plugin-setting-supertonic-voice");
ok("Female 2 survives Settings close and reopen", select.value === "female-2");

select.focus(); ws.clear(); select.value = "female-1"; select._fire("change");
const female1 = ws.last("plugin.settings.update");
store.applyEvent({ type: "plugins", plugins: [plugin("female-1")] });
ok("switching back persists and reaches the plugin too", female1?.settings.voice === "female-1" && workers[0].sent.some((message) => message.type === "settings" && message.settings.values.voice === "female-1"));

// ── the voice PREVIEW ────────────────────────────────────────────────────────────────────────────────
// A 69-voice list is generated in a batch, so one clip missing is a real possibility, and a button that
// paints itself back to Play and says nothing is indistinguishable from a dead control.
select = document.querySelector("#plugin-setting-supertonic-voice");
const previewBtn = select.parentNode.querySelector(".plg-preview");
ok("the selected option offers a play button", !!previewBtn && previewBtn.hidden === false);

audios.length = 0; globalThis.__previewFails = false;
previewBtn._fire("click"); await tick();
ok("it plays the SELECTED option's clip, resolved under the plugin's own static path",
  audios.length === 1 && audios[0].src === "/plugins/supertonic/public/voices/female-1-preview.mp3");
ok("and it offers Pause while the selected sample plays",
  previewBtn.className.includes("playing") && previewBtn.getAttribute("aria-pressed") === "true" && previewBtn.getAttribute("aria-label") === "Pause Female 1 preview");
audios[0].currentTime = 1.25;
previewBtn._fire("click"); await tick();
ok("Pause silences the sample and preserves its playback position",
  audios[0].paused && audios[0].currentTime === 1.25 && !previewBtn.className.includes("playing") && previewBtn.getAttribute("aria-pressed") === "false");
previewBtn._fire("click"); await tick();
ok("Play resumes the same sample without another audio object or resetting its position",
  audios.length === 1 && audios[0].plays === 2 && !audios[0].paused && audios[0].currentTime === 1.25);
const first = audios[0]; select.value = 'female-2'; select._fire('change');
ok("changing voice immediately stops and releases the previous sample without autoplay",
  first.paused && first.src === '' && previewBtn.getAttribute('aria-label') === 'Play Female 2 preview' && audios.length === 1);
previewBtn._fire('click'); await tick(); first.listeners.get('ended')();
ok("an old sample's ended event cannot stop the new voice", !audios[1].paused && previewBtn.getAttribute('aria-pressed') === 'true');
audios[1].listeners.get('ended')();
ok("natural completion returns the control to Play", previewBtn.getAttribute('aria-pressed') === 'false');
select.value = 'female-1'; select._fire('change');
globalThis.__previewPending = true; previewBtn._fire('click'); const late = audios.at(-1);
select.value = 'female-2'; select._fire('change'); late.resolvePlay(); await tick();
ok("late loading completion cannot restart a voice after selection changes", late.paused && previewBtn.getAttribute('aria-label') === 'Play Female 2 preview');
previewBtn._fire('click'); const paused = audios.at(-1); previewBtn._fire('click'); paused.resolvePlay(); await tick();
ok("Pause while loading also prevents late playback", paused.paused && previewBtn.getAttribute('aria-pressed') === 'false');
globalThis.__previewPending = false; select.value = 'female-1'; select._fire('change');
previewBtn._fire('click'); await tick(); const unfocused = audios.at(-1); winFire('blur', {});
ok('leaving the browser stops and releases the sample', unfocused.paused && unfocused.src === '');
const release = reserveRealtimeMedia('voice-agent'), beforeBusy = audios.length;
previewBtn._fire('click'); await tick();
ok('a preview cannot play into an active voice conversation', audios.length === beforeBusy); release();

// The one that matters: a clip that cannot play must SAY so.
audios.length = 0; globalThis.__previewFails = true;
document.querySelectorAll(".toast").forEach((node) => node.remove());
previewBtn._fire("click"); await tick(40);
const toastText = [...document.querySelectorAll(".toast")].map((node) => node.textContent).join(" ");
ok("a preview that cannot play reports it instead of failing silently, and names the voice",
  /Female 1/.test(toastText) && /preview/i.test(toastText));
ok("and the button is left ready to try again, not stuck on Stop",
  !previewBtn.className.includes("playing") && previewBtn.getAttribute("aria-pressed") === "false");
globalThis.__previewFails = false;

// An option with no clip must hide the control rather than offer a button that does nothing.
definition.options = [{ value: "female-1", label: "Female 1" }, { value: "female-2", label: "Female 2", preview: "public/voices/female-2-preview.mp3" }];
document.querySelector(".set-x")._fire("click"); await tick(180);
store.applyEvent({ type: "plugins", plugins: [plugin("female-1")] });
openPluginSettings("supertonic"); await tick();
const bare = document.querySelector("#plugin-setting-supertonic-voice");
ok("an option with no clip hides the button rather than offering a dead one",
  bare.parentNode.querySelector(".plg-preview")?.hidden === true);
bare.value = "female-2"; bare._fire("change"); await tick();
ok("and choosing one that has a clip brings the button back",
  bare.parentNode.querySelector(".plg-preview")?.hidden === false);

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} Supertonic voice selection and preview checks passed`);
process.exit(process.exitCode || 0);

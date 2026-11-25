// Dictation is a generic plugin action: CliDeck owns the microphone/composition surfaces, while a plugin owns
// transcription. Read-aloud is the bundled Supertonic plugin's per-session auto-read toggle (read-aloud.js
// decides when a finished reply may sound).
import { store } from "../store.js";
import { setReadAloud } from "../ws.js";
import { resolveActions, runAction, onActionsChange } from "./action-registry.js";
import { pluginActionContext } from "./plugin-host.js";
import { pluginCompositionState, onPluginCompositionChange } from "./plugin-composition.js";
import { terminalFocusTarget } from "./terminal.js";
import { openMenu } from "./menu.js";
import { initPrimaryPluginActions } from "./plugin-primary-actions.js";

let micBtn = null, sayBtn = null, micActions = [], micPaintSeq = 0, micSessionSig = "";

export function initVoice() {
  initPrimaryPluginActions();
  micBtn = document.getElementById("voice-mic");
  sayBtn = document.getElementById("voice-say");
  if (micBtn) {
    micBtn.addEventListener("click", openVoiceAction);
    onActionsChange(paintMic); onPluginCompositionChange(paintMic);
    store.on("active", paintMic); store.on("session:update", (id) => {
      const session = store.active(), sig = session ? session.id + "|" + (session.live !== false) + "|" + (session.status || "") : "";
      if (id === store.activeId && sig !== micSessionSig) paintMic();
    });
    paintMic();
  }
  if (sayBtn) {
    sayBtn.addEventListener("click", toggleSay);
    store.on("plugins", paintSay); store.on("connection", paintSay); store.on("active", paintSay);
    store.on("session:update", (id) => { if (id === store.activeId) paintSay(); });
    paintSay();
  }
}

function supertonic() { return store.plugins.find((plugin) => plugin.id === "supertonic") || null; }
function paintSay() {
  if (!sayBtn) return;
  const plugin = supertonic(), ready = !!(plugin && plugin.enabled !== false && plugin.status === "ready");
  const session = store.active(), on = session?.readAloud === true;
  sayBtn.disabled = !store.pluginsLoaded || !plugin || !session || !store.connected;
  sayBtn.classList.toggle("v-unsupported", !ready);
  sayBtn.classList.toggle("on", on && ready);
  sayBtn.setAttribute("aria-disabled", String(sayBtn.disabled));
  sayBtn.setAttribute("aria-pressed", String(on && ready));
  sayBtn.title = !store.pluginsLoaded ? "Loading voice plugin…"
    : !plugin ? "Supertonic Voice is unavailable"
    : !session ? "Select a session to read its replies aloud"
    : !store.connected ? "Reconnecting…"
    : !ready ? "Open Supertonic Voice settings"
    : on ? "Reading this session’s replies aloud — click to turn off" : "Read this session’s replies aloud";
}

async function paintMic() {
  if (!micBtn) return;
  const seq = ++micPaintSeq;
  const session = store.active();
  micSessionSig = session ? session.id + "|" + (session.live !== false) + "|" + (session.status || "") : "";
  const actions = session && session.live !== false
    ? await resolveActions("terminal.voice", pluginActionContext("terminal", "")) : [];
  if (seq !== micPaintSeq) return;
  micActions = actions;
  const composition = pluginCompositionState();
  const active = composition && actions.some((action) => action.pluginId === composition.pluginId);
  micBtn.disabled = !actions.length;
  micBtn.classList.toggle("v-unsupported", !actions.length);
  micBtn.classList.toggle("on", !!active);
  micBtn.setAttribute("aria-disabled", String(!actions.length));
  micBtn.setAttribute("aria-pressed", String(!!active));
  if (actions.length > 1) { micBtn.setAttribute("aria-haspopup", "menu"); micBtn.setAttribute("aria-expanded", "false"); }
  else { micBtn.removeAttribute("aria-haspopup"); micBtn.removeAttribute("aria-expanded"); }
  micBtn.title = !actions.length ? "No dictation plugin available"
    : active ? "Voice input is active"
    : actions.length === 1 ? actions[0].label : "Choose a dictation plugin";
}

function openVoiceAction(event) {
  if (!micActions.length) return;
  if (micActions.length === 1) { runAction(micActions[0], micActions[0].context); return; }
  micBtn.setAttribute("aria-expanded", "true");
  openMenu(micBtn, micActions.map((action) => ({ label: action.label, onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } })), {
    align: "end", returnFocus: micBtn, pointerReturnFocus: terminalFocusTarget(), sourceEvent: event,
    onClose: () => micBtn && micBtn.setAttribute("aria-expanded", "false"),
  });
}

function toggleSay() {
  const plugin = supertonic();
  if (!plugin || plugin.enabled === false || plugin.status !== "ready") {
    import("./settings.js").then(({ openPluginSettings }) => openPluginSettings("supertonic"));
    return;
  }
  const session = store.active();
  if (session) setReadAloud(session.id, session.readAloud !== true);
}

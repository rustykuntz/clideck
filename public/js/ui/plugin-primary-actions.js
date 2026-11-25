// A small, labelled entry point for session plugins. CliDeck still owns markup and invocation context.
import { store } from "../store.js";
import { resolveActions, runAction, onActionsChange } from "./action-registry.js";
import { pluginActionContext } from "./plugin-host.js";
import { actionIcon } from "./action-icon.js";
import { realtimeAudioActivity, onRealtimeAudioActivityChange } from "./plugin-realtime.js";

let host = null, sequence = 0, scheduled = false, animations = [];
function clearButtons() {
  for (const stop of animations) stop();
  animations = []; host.replaceChildren();
}

function animateVoice(button, icon, action, sessionId) {
  const bars = [...icon.querySelectorAll("path")];
  if (bars.length !== 5 || typeof requestAnimationFrame !== "function") return () => {};
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let frame = 0, stopped = false, last = 0, energy = 0, phase = "";
  function draw(now = performance.now()) {
    if (stopped) return;
    const activity = realtimeAudioActivity(action.pluginId, sessionId);
    const dt = Math.min(100, Math.max(0, now - last)); last = now;
    const target = Math.min(1, Math.max(0, activity.level - .008) * 7);
    energy += (target - energy) * (1 - Math.exp(-dt / (target > energy ? 45 : 160)));
    if (activity.state !== "listening") energy = 0;
    const next = energy > .035 ? "speaking" : activity.state;
    if (next !== phase) {
      phase = next; button.dataset.voiceState = phase;
      const status = { speaking: "Speaking", listening: "Listening", connecting: "Connecting", paused: "Microphone off" }[phase];
      button.title = `${action.label} · ${status} · Click to stop`;
      button.setAttribute("aria-label", `${action.label} · ${status}`);
    }
    const still = motion?.matches || activity.state === "paused";
    for (let i = 0; i < bars.length; i++) {
      const base = [4, 8, 12, 8, 4][i];
      const breath = still ? 0 : .65 * Math.sin(now / 850 + i * .55);
      const height = still ? base : base + breath + energy * [5, 7, 6, 8, 5][i];
      bars[i].setAttribute("d", `M${4 + i * 4} ${(12 - height / 2).toFixed(2)}v${height.toFixed(2)}`);
    }
    if (!still) frame = requestAnimationFrame(draw);
  }
  const restart = () => { cancelAnimationFrame(frame); last = 0; draw(); };
  const off = onRealtimeAudioActivityChange(restart);
  for (const name of ["focus", "blur"]) window.addEventListener(name, restart);
  document.addEventListener("visibilitychange", restart);
  motion?.addEventListener?.("change", restart);
  draw();
  return () => {
    stopped = true; cancelAnimationFrame(frame); off();
    for (const name of ["focus", "blur"]) window.removeEventListener(name, restart);
    document.removeEventListener("visibilitychange", restart);
    motion?.removeEventListener?.("change", restart);
  };
}
export function initPrimaryPluginActions() {
  if (host) return;
  const anchor = document.getElementById("voice-mic");
  if (!anchor?.parentNode) return;
  host = document.createElement("span"); host.id = "terminal-primary-actions";
  host.style.cssText = "display:inline-flex;align-items:center;gap:6px;flex-shrink:0";
  anchor.parentNode.insertBefore(host, anchor);
  const refresh = () => { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; paint(); }); };
  onActionsChange(refresh);
  for (const event of ["active", "session:update", "plugins", "plugin:message", "connection"]) store.on(event, refresh);
  refresh();
}
async function paint() {
  const seq = ++sequence, sessionId = store.active()?.id;
  if (!sessionId || !store.connected) { clearButtons(); return; }
  const actions = await resolveActions("terminal.primary", pluginActionContext("terminal", ""));
  if (seq !== sequence || store.active()?.id !== sessionId) return;
  clearButtons();
  host.replaceChildren(...actions.map(action => {
    const button = document.createElement("button"); button.type = "button"; button.className = "plg-btn";
    button.title = action.description || action.label;
    button.setAttribute("aria-label", action.label);
    if (typeof action.pressed === "boolean") button.setAttribute("aria-pressed", String(action.pressed));
    if (action.iconOnly) {
      const icon = actionIcon(action.icon); icon.setAttribute("aria-hidden", "true");
      icon.style.cssText = "display:flex;width:18px;height:18px"; button.append(icon);
      button.style.cssText = "display:grid;place-items:center;width:32px;height:32px;padding:6px;border-radius:9px;"
        + (action.pressed ? "color:var(--accent);background:var(--accent-soft);border-color:var(--accent)" : "color:var(--dim);background:transparent;border-color:transparent");
      if (action.icon === "waveform" && action.pressed) animations.push(animateVoice(button, icon, action, sessionId));
    } else {
      button.textContent = action.label;
      button.style.cssText = "font-size:11px;min-height:29px;padding:5px 10px;white-space:nowrap;color:var(--accent);border-color:var(--border)";
    }
    button.addEventListener("click", () => {
      if (button.disabled || !store.connected || store.active()?.id !== sessionId) return;
      button.disabled = true;
      runAction(action, action.context).finally(() => { if (button.isConnected) button.disabled = false; });
    });
    return button;
  }));
}

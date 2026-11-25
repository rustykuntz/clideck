// Server owns checks and installation. The browser only offers explicit, online actions.
import { store } from "../store.js";
import { send } from "../ws.js";
import { h } from "../util.js";
import { toast } from "./toast.js";

const acknowledged = new Set();
let started = false, notice = null, requested = false, lastNoticeState = null;
const installable = s => s?.canInstall && s.latestVersion && (s.state === "available" || s.state === "error");
const busy = s => s && (s.state === "checking" || s.state === "installing");
function request(install) {
  const state = store.engineUpdate;
  if (!store.connected || !state || busy(state)) return;
  if (install && !installable(state)) return;
  if (install) acknowledged.add(state.latestVersion);
  requested = true;
  send({ type: install ? "engine.update.install" : "engine.update.check" });
  store.applyEvent({ ...state, state: install ? "installing" : "checking" });
}
function detail(s) {
  if (!store.connected) return "Reconnect to check for updates.";
  if (!s) return "Update status unavailable.";
  if (s.state === "checking") return "Checking for updates…";
  if (s.state === "current") return "CliDeck is up to date.";
  if (s.state === "available") return `Version ${s.latestVersion || "update"} available.${s.canInstall ? "" : " " + (s.instruction || "Update your CliDeck installation manually.")}`;
  if (s.state === "installing") return "Installing update… Your sessions keep running.";
  if (s.state === "installed") return "Update installed. Restart CliDeck when ready to use it.";
  return (s.error || "Could not check for updates. Try again.") + (s.instruction ? " " + s.instruction : "");
}
// The desktop app's "Check for Updates…" menu item: the same explicit check as the Settings button.
export function checkForUpdates() { request(false); }
export function updateControls() {
  const s = store.engineUpdate, root = h("div", "set-update");
  const status = h("div", "set-update-status"); status.setAttribute("role", "status"); status.textContent = detail(s); root.append(status);
  if (s?.state === "installed") return root;
  const install = installable(s);
  const button = h("button", "set-action"); button.type = "button";
  button.textContent = install ? (s.state === "error" ? "Retry update" : "Update") : busy(s) ? (s.state === "installing" ? "Installing…" : "Checking…") : "Check for updates";
  button.disabled = !store.connected || !s || busy(s);
  button.addEventListener("click", () => request(install)); root.append(button); return root;
}
export function initUpdates() {
  if (started) return; started = true;
  store.on("engine.update", s => {
    const key = JSON.stringify([s.state, s.currentVersion, s.latestVersion, s.canInstall, s.instruction, s.error]);
    if (key === lastNoticeState) return;
    lastNoticeState = key;
    if (s.state === "available") {
      requested = false;
      if (acknowledged.has(s.latestVersion)) { notice?.dismiss(); notice = null; return; }
      notice = toast.info({ id: "engine-update", title: "New version available", body: `CliDeck ${s.latestVersion || ""}`, duration: 0,
        onDismiss: () => acknowledged.add(s.latestVersion),
        action: { label: s.canInstall ? "Update" : "Details", onClick: () => {
          if (!store.connected || store.engineUpdate?.state !== "available" || store.engineUpdate.latestVersion !== s.latestVersion) return;
          acknowledged.add(s.latestVersion);
          if (s.canInstall) request(true);
          else import("./settings.js").then(m => m.openSettingsAt("general"));
        } } });
    } else {
      notice?.dismiss(); notice = null;
      if (s.state === "error" && (requested || installable(s))) notice = toast.error({ id: "engine-update", title: "Update failed", body: detail(s), duration: 0,
        action: installable(s) ? { label: "Retry update", onClick: () => request(true) } : undefined });
      if (s.state === "current" || s.state === "installed" || s.state === "error") requested = false;
      if (s.state === "installing" || s.state === "installed") {
        notice = toast.info({ id: "engine-update", title: s.state === "installed" ? "Update installed" : "Installing update", body: detail(s), duration: 0 });
      }
    }
  });
  store.on("connection", connected => { if (!connected) { notice?.dismiss(); notice = null; lastNoticeState = null; } });
}

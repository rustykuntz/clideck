// Sandboxed visual surface for plugin viewers/workspaces. The frame is an opaque origin (no
// allow-same-origin), matched by contentWindow rather than trusting event.origin, and receives only cloned
// context/theme/message envelopes.
import { store } from "../store.js";
import { sendPluginMessage } from "../ws.js";
import { resolvedTheme, onTheme } from "../theme.js";
import { toast } from "./toast.js";

const frames = new Set();              // {frame,pluginId,context,onClose}
let initialized = false;

function safeUrl(pluginId, source) {
  const base = "/plugins/" + encodeURIComponent(pluginId) + "/public/";
  let url;
  try { url = new URL(String(source || ""), (typeof location !== "undefined" && location.href) || "http://localhost/"); }
  catch { return ""; }
  return url.pathname.startsWith(base) ? url.pathname + url.search + url.hash : "";
}
function post(entry, type, data) {
  try { entry.frame.contentWindow && entry.frame.contentWindow.postMessage({ type, pluginId: entry.pluginId, data }, "*"); } catch {}
}
function initialize() {
  if (initialized) return; initialized = true;
  window.addEventListener("message", (event) => {
    const entry = [...frames].find((candidate) => candidate.frame.contentWindow === event.source);
    if (!entry) return;
    const message = event.data || {};
    if (message.type === "clideck.send" && typeof message.event === "string") sendPluginMessage(entry.pluginId, message.event, message.data);
    else if (message.type === "clideck.close" && entry.onClose) entry.onClose();
    else if (message.type === "clideck.toast") {
      const kind = ["success", "warn", "error"].includes(message.kind) ? message.kind : "info";
      toast[kind]({ title: String(message.title || "Plugin"), body: String(message.body || "") });
    } else if (message.type === "clideck.ready") {
      post(entry, "clideck.init", { context: entry.context, theme: resolvedTheme(), visible: entry.visible !== false });
    }
  });
  store.on("plugin:message", (message) => {
    for (const entry of frames) if (entry.pluginId === message.pluginId) post(entry, "clideck.message", { event: message.event, data: message.data });
  });
  onTheme((theme) => { for (const entry of frames) post(entry, "clideck.theme", { theme }); });
}

export function pluginFrame(pluginId, source, context, options = {}) {
  initialize();
  const src = safeUrl(pluginId, source);
  if (!src) throw new Error("Plugin visual URL must stay inside its public folder.");
  const frame = document.createElement("iframe");
  frame.className = options.className || "plugin-frame";
  frame.title = options.title || "Plugin";
  frame.src = src;
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const entry = { frame, pluginId, context: context || {}, onClose: options.onClose || null };
  frames.add(entry);
  frame._clideckPluginFrame = true;
  // ⚠️ VISIBILITY RIDES THE INIT, not only the transition. A tab hidden before its iframe finished loading
  // would otherwise have missed its one `false` and polled forever behind a tab nobody was looking at.
  frame.addEventListener("load", () => post(entry, "clideck.init", { context: entry.context, theme: resolvedTheme(), visible: entry.visible !== false }));
  return frame;
}

export function isPluginFrame(frame) { return !!(frame && frame._clideckPluginFrame); }

// ⚠️ A DOCUMENT TAB HIDES, IT DOES NOT UNMOUNT — an `<iframe>` re-inserted into the DOM RELOADS, which would
// throw away whatever the plugin had on screen. So a hidden workspace is still a live page with live timers,
// and a plugin that polls would keep polling forever behind a tab nobody is looking at. This is the only
// signal it gets: posted on the transition, never on every render, and only when it actually changes.
export function setPluginFrameVisible(frame, visible) {
  for (const entry of frames) {
    if (entry.frame !== frame) continue;
    if (entry.visible === visible) return;
    entry.visible = visible;
    post(entry, "clideck.visible", { visible });
    return;
  }
}
export function disposePluginFrame(frame) {
  for (const entry of frames) if (entry.frame === frame) { frames.delete(entry); return true; }
  return false;
}

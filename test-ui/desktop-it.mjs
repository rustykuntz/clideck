// IT — desktop app integration (public/js/ui/desktop.js) against a stub of the Electron bridge: detection only in
// the trusted top frame, chrome classes from shell state, menu actions routed to existing UI entry points, badge /
// tray counts, the engine overlay's states, native notifications and the plugin link path.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
globalThis.location = { host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100", href: "http://127.0.0.1:4100/" };
window.top = window;
window.outerWidth = 1200;
document.hasFocus = () => true;
globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => (name === "--dim" ? " #a1a4ad" : "") });
const opened = [];
window.open = (url) => { opened.push(url); return {}; };

const calls = [];
let stateCb = null, actionCb = null;
const bridge = {
  platform: "darwin",
  capabilities: { desktop: true, vibrancy: true },
  getState: () => Promise.resolve({ platform: "darwin", version: "2.6.0", engine: { state: "ready", url: "http://127.0.0.1:4100" },
    capabilities: { vibrancy: true }, preferences: { externalLinks: "browser", closeToTray: true, startAtLogin: false }, window: { focused: true, fullscreen: false } }),
  getPreferences: () => Promise.resolve({ externalLinks: "browser", closeToTray: true, startAtLogin: false }),
  setPreferences: (patch) => { calls.push(["setPreferences", patch]); return Promise.resolve(true); },
  openExternal: (url) => { calls.push(["openExternal", url]); return Promise.resolve(true); },
  showItemInFolder: (p) => { calls.push(["showItemInFolder", p]); return Promise.resolve(true); },
  notify: (n) => { calls.push(["notify", n]); return Promise.resolve(true); },
  setBadgeCount: (n) => { calls.push(["setBadgeCount", n]); return Promise.resolve(true); },
  setActivity: (a) => { calls.push(["setActivity", a]); return Promise.resolve(true); },
  setAppearance: (a) => { calls.push(["setAppearance", a]); return Promise.resolve(true); },
  retryEngine: () => { calls.push(["retryEngine"]); return Promise.resolve(true); },
  hideWindow: () => { calls.push(["hideWindow"]); return Promise.resolve(true); },
  quit: () => Promise.resolve(true),
  onState: (fn) => { stateCb = fn; return () => { stateCb = null; }; },
  onAction: (fn) => { actionCb = fn; return () => { actionCb = null; }; },
};
window.clideckDesktop = bridge;

for (const id of ["new-btn", "proj-btn", "th-history", "settings-btn"]) {
  const b = document.createElement("button"); b.id = id; b.click = () => b._fire("click"); document.body.appendChild(b);
}
const sidebar = document.createElement("aside"); sidebar.className = "sidebar"; document.body.appendChild(sidebar);
const list = document.createElement("div"); list.id = "list"; sidebar.appendChild(list);

const { store } = await import("../public/js/store.js");
const desktop = await import("../public/js/ui/desktop.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const last = (name) => [...calls].reverse().find((c) => c[0] === name);
const html = document.documentElement;

// detection: only the top frame of the trusted page sees the bridge
window.top = {};
ok("a framed page is never treated as the desktop app", desktop.isDesktop() === false);
window.top = window;
ok("the top frame with the bridge is the desktop app", desktop.isDesktop() === true);

const clicks = {};
for (const id of ["new-btn", "proj-btn", "th-history"]) document.getElementById(id).addEventListener("click", () => { clicks[id] = (clicks[id] || 0) + 1; });

desktop.initDesktop();
await tick();
ok("html is stamped desktop + platform", html.classList.contains("desktop") && html.dataset.platform === "darwin");
ok("shell state turns vibrancy on only when the shell reports it", html.classList.contains("dk-vibrancy"));
ok("appearance follows the theme preference (auto → system) with overlay colours", last("setAppearance")?.[1]?.mode === "system" && last("setAppearance")[1].overlay.symbolColor === "#a1a4ad");
ok("the sidebar toggle is mounted beside the window controls", !!document.getElementById("dk-sidebar-btn"));

stateCb({ engine: { state: "ready" }, capabilities: { vibrancy: false, titleBarOverlay: true }, window: { fullscreen: true, focused: false } });
ok("state pushes update full screen, overlay and focus classes", html.classList.contains("dk-fullscreen") && html.classList.contains("dk-wco") && !html.classList.contains("dk-vibrancy") && html.classList.contains("dk-blurred"));
stateCb({ engine: { state: "ready" }, capabilities: { vibrancy: true }, window: { fullscreen: false, focused: true } });

// sessions + counts
const created = (id, extra = {}) => store.applyEvent({ type: "session.created", sessionId: id, provider: "shell", name: id, cwd: "/w", live: true, pid: 1, ...extra });
for (const id of ["A", "B", "C"]) {
  created(id);
  const row = document.createElement("div"); row.className = "row"; row.dataset.id = id; row.scrollIntoView = () => {}; list.appendChild(row);
}
store.applyEvent({ type: "status", sessionId: "B", state: "working" });
await wait(300);
ok("tray activity counts working sessions", last("setActivity")?.[1]?.working === 1);
ok("dock badge carries the unread-session count", typeof last("setBadgeCount")?.[1] === "number");

// menu actions → existing entry points
store.select("A");
actionCb("next-session");
ok("Next Session selects the following visible row", store.activeId === "B");
actionCb("prev-session"); actionCb("prev-session");
ok("Previous Session wraps around", store.activeId === "C");
actionCb("session-1");
ok("Cmd+1 selects the first visible row", store.activeId === "A");
actionCb({ id: "focus-session", sessionId: "C" });
ok("a notification click focuses its session", store.activeId === "C");
actionCb({ id: "focus-session", sessionId: "gone" });
ok("a notification for a removed session leaves the selection alone", store.activeId === "C");
actionCb("new-session"); actionCb("new-project"); actionCb("history");
ok("New Session / New Project / History press the existing buttons", clicks["new-btn"] === 1 && clicks["proj-btn"] === 1 && clicks["th-history"] === 1);
actionCb("close-tab");
await tick();
ok("Close Tab with only the terminal showing hides the window (agents keep running)", !!last("hideWindow"));
actionCb("toggle-sidebar");
ok("Toggle Sidebar hides the sidebar, makes it inert and remembers it", html.classList.contains("dk-sidebar-hidden") && sidebar.inert === true && localStorage.getItem("clideck.desktop.sidebarHidden") === "1");
actionCb("toggle-sidebar");
ok("Toggle Sidebar again restores it", !html.classList.contains("dk-sidebar-hidden") && sidebar.inert === false && localStorage.getItem("clideck.desktop.sidebarHidden") === "0");
(await import("../public/js/ws.js")).connectWs(); await tick();   // the check is only sent online
store.setConnected(true);
const sentBefore = ws.sent.length;
store.applyEvent({ type: "engine.update", state: "current", currentVersion: "2.6.0" });
actionCb("check-updates");
await tick();
ok("Check for Updates opens Settings and asks the engine to check", !!document.querySelector(".set-overlay") && ws.sent.slice(sentBefore).some((m) => m && m.type === "engine.update.check"));
(await import("../public/js/ui/settings.js")).closeSettings();
await tick();
actionCb("next-unread");
await tick();
ok("Next Unread with nothing waiting says so in an info toast", /No session is waiting/.test(document.querySelector(".toast")?.textContent || ""));
actionCb("no-such-action");
ok("unknown actions are ignored", true);

// engine overlay
stateCb({ engine: { state: "reconnecting" } });
await tick();
const overlay = () => document.querySelector(".dk-engine");
ok("reconnecting covers the page with a waiting card and no buttons yet", !!overlay() && /Reconnecting/.test(overlay().querySelector(".dk-engine-title").textContent) && !overlay().querySelectorAll(".dk-engine-actions button").length);
stateCb({ engine: { state: "error", error: "spawn ENOENT", logPath: "/tmp/engine.log" } });
const buttons = () => [...overlay().querySelectorAll(".dk-engine-actions button")];
ok("error shows the detail, Start engine and Show logs", overlay().classList.contains("failed") && overlay().querySelector(".dk-engine-error").textContent === "spawn ENOENT" && buttons().map((b) => b.textContent).join("|") === "Start engine|Show logs");
const before = buttons()[0];
stateCb({ engine: { state: "error", error: "spawn ENOENT", logPath: "/tmp/engine.log" } });
ok("a repeated state push keeps the same buttons (no refocus churn)", buttons()[0] === before);
buttons()[0]._fire("click"); buttons()[1]._fire("click");
ok("the buttons call retryEngine and reveal the log", !!last("retryEngine") && last("showItemInFolder")?.[1] === "/tmp/engine.log");
stateCb({ engine: { state: "ready" } });
await wait(260);
ok("ready removes the overlay", !overlay());

// notifications + plugin links
ok("desktopNotify passes the session for click-to-focus", desktop.desktopNotify({ title: "t", body: "b", sessionId: "A" }) === true && last("notify")?.[1]?.sessionId === "A");
ok("plugin links refuse javascript:", desktop.openPluginLink("javascript:alert(1)") === false);
ok("plugin links refuse this app's own origin", desktop.openPluginLink("http://127.0.0.1:4100/api/x") === false);
ok("plugin https links go to the default browser through the shell", desktop.openPluginLink("https://example.com/a") === true && last("openExternal")?.[1] === "https://example.com/a" && !opened.length);
ok("plugin links are rate-limited", desktop.openPluginLink("https://example.com/b") === false);
await wait(1010);
ok("mailto is allowed after the window", desktop.openPluginLink("mailto:someone@example.com") === true);

const failed = checks.filter(([, pass]) => !pass);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);

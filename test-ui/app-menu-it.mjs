// UI IT — the sidebar footer's app menu: labelled entries for Prompts, Task Manager, Monitors (with an
// attention count + dot on the button), app-wide plugin tools, Manage plugins, and Theme. No session needed.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
const btn = document.createElement("button"); btn.id = "app-menu"; btn.setAttribute("aria-expanded", "false"); document.body.appendChild(btn);
const av = document.createElement("span"); av.className = "av"; btn.appendChild(av);
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ monitors: [] }) });

const { store } = await import("../public/js/store.js");
const { registerAction } = await import("../public/js/ui/action-registry.js");
const { initAppMenu } = await import("../public/js/ui/app-menu.js");
const { initMonitors } = await import("../public/js/ui/monitors.js");
const { initTaskManager } = await import("../public/js/ui/task-manager.js");

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const all = () => document.body._walk();
const items = () => all().filter((n) => n.classList?.contains("menu-item")).map((n) => n.textContent);
const pick = async (label) => { all().find((n) => n.classList?.contains("menu-item") && n.textContent.startsWith(label))._fire("click"); await sleep(); };
const openMenu = async () => { btn._fire("click", { detail: 1 }); await sleep(30); };

try {
  store.setConnected(true);
  initMonitors(); initTaskManager(); initAppMenu();
  ok("no session open: the menu still works", store.activeId == null);
  await openMenu();
  ok("labelled tools in order, Manage plugins, no mystery icons", JSON.stringify(items()) === JSON.stringify(["Prompt library", "Task Manager", "Monitors", "Manage plugins…"]), items());
  const seg = all().filter((n) => n.classList?.contains("tasks-seg-b")).map((b) => b.textContent);
  ok("Theme row with Auto / Light / Dark", seg.join("|") === "Auto|Light|Dark", seg);
  all().find((n) => n.classList?.contains("tasks-seg-b") && n.textContent === "Dark")._fire("click");
  ok("choosing a theme applies it right away", localStorage.getItem("clideck.theme") === "dark" && document.documentElement.getAttribute("data-theme") === "dark");
  await pick("Task Manager");
  ok("Task Manager opens from the menu", all().some((n) => n.classList?.contains("tasks-dialog") && n.getAttribute("aria-label") === "Task Manager"));
  all().filter((n) => n.classList?.contains("tasks-close")).at(-1)?._fire("click"); await sleep();

  store.applyEvent({ type: "monitors.updated", monitors: [{ id: "m", name: "x", state: "error" }, { id: "n", name: "y", state: "uncertain" }] }); await sleep();
  ok("a monitor needing attention puts a dot on the menu button", btn.classList.contains("has-alert") && /2 need attention/.test(btn.title));
  registerAction("telegram", { id: "open", label: "Telegram", icon: "send", placements: ["toolbar"] }, async () => {});
  registerAction("git-diff", { id: "open", label: "Git changes", placements: ["terminal.header"] }, async () => {});
  await openMenu();
  ok("Monitors item shows the count", items().includes("Monitors2"), items());
  ok("app-wide plugin tools appear; session-only ones do not", items().includes("Telegram") && !items().includes("Git changes"), items());
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

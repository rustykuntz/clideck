import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
document.documentElement.clientWidth = 1000; document.documentElement.clientHeight = 760;
const paneTabs = document.createElement("div"); paneTabs.id = "pane-tabs"; document.body.appendChild(paneTabs);
const paneBody = document.createElement("div"); paneBody.id = "pane-body"; document.body.appendChild(paneBody);
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; paneBody.appendChild(termPanel);
globalThis.fetch = () => Promise.resolve({ text: () => Promise.resolve("# Read me\n\nA useful document.") });

const { store } = await import("../public/js/store.js");
const { registerAction } = await import("../public/js/ui/action-registry.js");
const { initContentDock, presentInDock } = await import("../public/js/ui/content-dock.js");
const { closeMenu } = await import("../public/js/ui/menu.js");
const checks = [], calls = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

const unregister = registerAction("reader", {
  id: "read-document", label: "Read document aloud", icon: "≋",
  placements: ["viewer.header", "viewer.context"], hasWhen: true,
}, async (method, id, context) => {
  calls.push({ method, id, context });
  if (method === "match-action") return ["text", "markdown"].includes(context.content?.kind);
  return true;
});

store.applyEvent({ type: "session.created", sessionId: "S", provider: "shell", name: "Shell", cwd: "/tmp", live: true });
initContentDock();
presentInDock({ sessionId: "S", contentId: "doc-1", kind: "markdown", name: "notes.md", url: "/content/doc-1" });
await tick();

const toolbar = document.querySelector(".cd-viewer-actions"), button = document.querySelector(".cd-viewer-action");
ok("active document gets a compact trailing host toolbar", toolbar?.getAttribute("role") === "toolbar" && paneTabs.lastElementChild === toolbar);
ok("plain-text icon, tooltip and aria label stay host-owned", button?.textContent === "≋" && button.title === "Read document aloud" && button.getAttribute("aria-label") === "Read document aloud" && !button.querySelector("svg"));
button._fire("click"); await tick();
const run = calls.find((call) => call.method === "run-action");
ok("header action receives the active document context", run?.id === "read-document" && run.context.content.id === "doc-1" && run.context.content.kind === "markdown");

let prevented = false;
const viewer = document.querySelector(".cd-render");
viewer._fire("contextmenu", { shiftKey: false, clientX: 40, clientY: 50, preventDefault() { prevented = true; } });
ok("viewer predicate is primed at bind so the first right-click works", prevented && document.querySelector(".menu-item")?.textContent === "Read document aloud" && calls.some((call) => call.method === "match-action"));
closeMenu();
const anchor = document.createElement("a"); anchor.setAttribute("href", "https://example.com/"); viewer.appendChild(anchor);
prevented = false;
viewer._fire("contextmenu", { target: anchor, shiftKey: false, preventDefault() { prevented = true; } });
ok("document links keep the native browser menu even with plugin actions", !prevented && !document.querySelector(".menu"));

document.querySelector(".cd-tab-term")._fire("click"); await tick();
ok("document controls retire when the terminal becomes active", !document.querySelector(".cd-viewer-actions"));
unregister();

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} viewer action checks passed`);

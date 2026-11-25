// IT — the document tab's own menu, and the dismissal a sandboxed preview would otherwise defeat.
// The tab is where a document's IDENTITY lives, so its menu answers "what file is this?" — and answers
// honestly when there is no file, rather than copying a /content URL nobody can open.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
const mk = (tag, id, parent = document.body) => { const el = document.createElement(tag); el.id = id; parent.appendChild(el); return el; };
for (const id of ["pane-tabs", "pane-body", "term-panel", "rp", "term"]) mk("div", id);
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0" });

const { store } = await import("../public/js/store.js");
const { initContentDock, presentInDock } = await import("../public/js/ui/content-dock.js");
const { openMenu, isMenuOpen } = await import("../public/js/ui/menu.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };

let copied = "";
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t) => { copied = t; } } } });

store.applyEvent({ type: "session.created", sessionId: "S", provider: "shell", cwd: "/tmp", live: true, pid: 1 });
store.applyEvent({ type: "session.created", sessionId: "OTHER", provider: "shell", cwd: "/tmp", live: true, pid: 2 });
store.select('S');initContentDock();
presentInDock({sessionId:'OTHER',contentId:'other-doc',kind:'text',name:'Unrelated',url:'/content/other-doc'});
presentInDock({ sessionId: "S", contentId: "doc-file", kind: "markdown", name: "Plan.md", url: "/content/doc-file", sourcePath: "/Users/or/notes/Plan.md" });
presentInDock({ sessionId: "S", contentId: "doc-inline", kind: "markdown", name: "Reply", url: "/content/doc-inline" });

const tabs = [...document.querySelectorAll(".cd-tab")].filter((t) => !t.className.includes("cd-tab-term"));
ok("both documents have a tab", tabs.length === 2);

const menuFor = (tab) => { tab._fire("contextmenu", { clientX: 40, clientY: 20 }); return [...document.querySelectorAll(".menu-item")]; };
let items = menuFor(tabs[0]);
ok("right-clicking a tab opens a menu offering the file path", items.length === 4 && items[0].textContent.includes("Copy file path") && !items[0].disabled);
items[0]._fire("click");
await new Promise((r) => setTimeout(r, 0));
ok("choosing it copies the document's real source path, not its /content URL", copied === "/Users/or/notes/Plan.md");

copied = "";
items = menuFor(tabs[1]);
// A payload the agent sent inline has no file. Saying so is the point: a disabled row with a reason beats a
// row that quietly copies a URL, and beats a menu that changes shape between tabs.
ok("a preview with no file on disk still offers the row, disabled", items.length === 4 && items[0].disabled === true);
ok("and explains why, in the menu itself",
  [...document.querySelectorAll(".menu-cap")].some((n) => /no file on disk/i.test(n.textContent)));
items[0]._fire("click");
await new Promise((r) => setTimeout(r, 0));
ok("and copies nothing at all", copied === "");

ok("last tab disables close-to-right", items[2].disabled === true);
items = menuFor(tabs[0]);
ok("tab menu offers requested close actions in order", items.slice(1).map(n=>n.textContent).join('|') === 'Close this tab|Close tabs to the right|Close all tabs');
items[2]._fire('click');
ok("close-to-right keeps selected tab and terminal", document.querySelectorAll('.cd-tab').length === 2 && document.querySelector('.cd-tab-name').textContent.includes('Terminal'));
let remaining=[...document.querySelectorAll('.cd-tab')].find(t=>!t.className.includes('cd-tab-term'));
menuFor(remaining)[1]._fire('click');
ok("close-this keeps terminal", document.getElementById('pane-tabs').hidden && !document.getElementById('term-panel').hidden);
presentInDock({sessionId:'S',contentId:'fresh1',kind:'text',name:'One',url:'/content/fresh1'});
presentInDock({sessionId:'S',contentId:'fresh2',kind:'text',name:'Two',url:'/content/fresh2'});
remaining=[...document.querySelectorAll('.cd-tab')].find(t=>!t.className.includes('cd-tab-term'));
menuFor(remaining)[3]._fire('click');
ok("close-all removes documents and preserves terminal", document.getElementById('pane-tabs').hidden && !document.getElementById('term-panel').hidden);

store.select('OTHER');
ok("closing tabs leaves other session documents untouched", document.querySelectorAll('.cd-tab').length === 2 && [...document.querySelectorAll('.cd-tab')].some(tab => tab.textContent.includes('Unrelated')) && document.querySelector('.cd-tab.on').className.includes('cd-tab-term'));
store.select('S');

// ── a click inside a sandboxed preview never reaches this document ───────────────────────────────────────
const anchor = mk("button", "anchor");
openMenu(anchor, [{ label: "Read aloud", onSelect: (ctl) => ctl.close() }]);
ok("a menu is open over the document", isMenuOpen());
dom.docFire("mousedown", { target: document.body });
ok("an ordinary outside click still dismisses it", !isMenuOpen());

openMenu(anchor, [{ label: "Read aloud", onSelect: (ctl) => ctl.close() }]);
const frame = document.createElement("iframe");
document.body.appendChild(frame);
document.activeElement = frame;
dom.winFire("blur");
ok("focus landing inside a preview frame dismisses it too", !isMenuOpen());

openMenu(anchor, [{ label: "Read aloud", onSelect: (ctl) => ctl.close() }]);
document.activeElement = document.body;
dom.winFire("blur");
ok("but merely switching away from the window does not", isMenuOpen());

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} tab menu checks passed`);

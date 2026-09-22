// Real provider callbacks: only a primary-button release may activate a terminal link.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();

const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-meta", "th-name", "th-rename", "th-rename-msg", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn"]) add("div", id);
const context = add("div", "th-context"); context.hidden = true;
add("i", "th-context-fill", context); add("span", "th-context-value", context);
const last = add("div", "th-last"); last.hidden = true; add("span", "th-last-value", last);
document.getElementById("th-rename-msg").hidden = true;
globalThis.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

class FakeTerminal {
  constructor(options) {
    this.options = { ...options }; this.cols = options.cols; this.rows = options.rows; this.modes = { bracketedPasteMode: true };
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this._core = { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } }, viewport: { scrollBarWidth: 0 } };
    this.parser = { registerOscHandler() {} };
  }
  open(host) { const vp = add("div", "", host); vp.className = "xterm-viewport"; this.textarea = add("textarea", "", host); }
  attachCustomKeyEventHandler() {} onData() {} onScroll() {} onResize() { return { dispose() {} }; } registerLinkProvider() {} reset() {} clear() {}
  write(_data, done) { done?.(); } resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {} focus() {}
}
window.Terminal = FakeTerminal;

const { store } = await import("../public/js/store.js");
const { initTerminal, __termForTest, __linkProvidersForTest } = await import("../public/js/ui/terminal.js");

const { installFakeWs } = await import("./fakedom.mjs");
const ws = installFakeWs();
const { connectWs } = await import("../public/js/ws.js");
const paths = await import("../public/js/ui/paths.js");
connectWs(); await new Promise(r => setTimeout(r, 5));
initTerminal();
store.applyEvent({ type: "session.created", sessionId: "links", cwd: "/tmp", live: true, provider: "shell" });
store.select("links");
const term = __termForTest();
const text = "notes.md https://example.com/file.txt";
term.buffer.active.getLine = y => y === 0 ? { isWrapped: false, translateToString: () => text } : null;
term.buffer.active.length = 1;
paths.probe("links", [text]);
store.applyEvent({ type: "content.resolve.result", sessionId: "links", resolved: { "notes.md": "/tmp/notes.md" } });
const links = [];
for (const provider of __linkProvidersForTest()) provider.provideLinks(1, found => links.push(...found || []));
let opened = [];
window.open = (...args) => { opened.push(args); return { opener: null }; };
let failed = 0, passed = 0;
const ok = (name, yes) => { yes ? passed++ : failed++; console.log((yes ? "PASS " : "FAIL ") + name); };
ok("URL and existing document are both linked", links.length === 2);
for (const link of links) {
  const beforeFiles = ws.sent.filter(e => e.type === "content.open").length, beforeUrls = opened.length;
  for (const button of [1, 2]) link.activate({ button }, link.text);
  ok(link.text + " ignores middle/right releases", ws.sent.filter(e => e.type === "content.open").length === beforeFiles && opened.length === beforeUrls);
  link.activate({ button: 0 }, link.text);
  ok(link.text + " opens once on left release", ws.sent.filter(e => e.type === "content.open").length + opened.length === beforeFiles + beforeUrls + 1);
}
for (const link of links) {
  const mount = document.getElementById("term");
  const count = () => ws.sent.filter(e => e.type === "content.open").length + opened.length;
  const before = count();
  mount._fire("mousedown", { button: 0, ctrlKey: true });
  mount._fire("contextmenu", { button: 0, ctrlKey: true, shiftKey: true });
  link.activate({ button: 0, ctrlKey: true }, link.text);
  ok(link.text + " context-menu gesture cannot activate on primary release", count() === before);
  mount._fire("mousedown", { button: 0 });
  link.activate({ button: 0 }, link.text);
  ok(link.text + " next ordinary click is unaffected", count() === before + 1);
}
const osc = term.options.linkHandler;
const mount = document.getElementById("term");
const destination = "https://example.com/hidden-destination";
const prompts = []; let answer = true;
window.confirm = text => { prompts.push(text); return answer; };
const beforeOsc = opened.length;
for (const button of [1, 2]) osc.activate({ button }, destination);
ok("OSC8 middle/right releases do not prompt or open", prompts.length === 0 && opened.length === beforeOsc);
for (const shiftKey of [false, true]) {
  mount._fire("mousedown", { button: 0, ctrlKey: true });
  mount._fire("contextmenu", { button: 0, ctrlKey: true, shiftKey, preventDefault() {} });
  osc.activate({ button: 0, ctrlKey: true }, destination);
}
ok("OSC8 context gestures including native menu never prompt or open", prompts.length === 0 && opened.length === beforeOsc);
mount._fire("mousedown", { button: 0 });
answer = false; osc.activate({ button: 0 }, destination);
ok("OSC8 left-click still shows destination and respects Cancel", prompts[0].includes(destination) && opened.length === beforeOsc);
answer = true; osc.activate({ button: 0 }, destination);
ok("OSC8 confirmed left-click uses isolated browser opening", opened.length === beforeOsc + 1 && opened.at(-1).join("|") === destination + "|_blank|noopener,noreferrer");
ok("OSC8 non-HTTP protocols remain disabled by default", osc.allowNonHttpProtocols !== true);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

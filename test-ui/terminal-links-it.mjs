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
window.Unicode11Addon = { Unicode11Addon: class { activate(term) { term.unicode = { activeVersion: "6" }; } } };
FakeTerminal.prototype.loadAddon = function(addon) { addon.activate(this); };

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
// URL recognition: the browser's parser decides, so localhost/IPv4/IPv6/ports link; sentence punctuation does not.
const urlProvider = __linkProvidersForTest()[0];
const linksIn = (line) => {
  term.buffer.active.getLine = y => y === 0 ? { isWrapped: false, translateToString: () => line } : null;
  let found = [];
  urlProvider.provideLinks(1, result => { found = result || []; });
  return found.map(link => ({ text: link.text, start: link.range.start.x, end: link.range.end.x }));
};
const report = "The Screeners tab is ready: http://localhost:7345/#screeners.";
const reported = linksIn(report);
ok("exact report: localhost link with #fragment, final dot excluded",
  reported.length === 1 && reported[0].text === "http://localhost:7345/#screeners"
  && report.slice(reported[0].start - 1, reported[0].end) === "http://localhost:7345/#screeners");
ok("exact report without the final dot links too", linksIn("ready: http://localhost:7345/#screeners")[0]?.text === "http://localhost:7345/#screeners");
for (const [line, want] of [
  ["http://localhost", "http://localhost"], ["https://localhost:3000/app", "https://localhost:3000/app"],
  ["see https://example.com/a?b=1.", "https://example.com/a?b=1"], ["(https://example.com/x), then", "https://example.com/x"],
  ["at http://127.0.0.1:8080/health!", "http://127.0.0.1:8080/health"], ["ipv6 http://[::1]:8080/path.", "http://[::1]:8080/path"],
  ["bare ipv6 http://[::1].", "http://[::1]"], ["[http://example.com]", "http://example.com"], ["\"http://localhost:5173\"", "http://localhost:5173"],
]) ok(`links ${JSON.stringify(line)} as ${want}`, JSON.stringify(linksIn(line).map(l => l.text)) === JSON.stringify([want]));
for (const line of ["http://:8080/x", "http://localhost:99999", "http://localhost:abc/", "http://.", "http://", "http://[::1 broken", "ftp://example.com", "file:///etc/hosts", "javascript:alert(1)"])
  ok(`no link for ${JSON.stringify(line)}`, linksIn(line).length === 0);
const pair = "a http://localhost:1/x, b https://example.org.", two = linksIn(pair);
ok("two URLs on a line keep their own ranges", two.length === 2 && two.every(l => pair.slice(l.start - 1, l.end) === l.text) && two.map(l => l.text).join() === "http://localhost:1/x,https://example.org");
opened = [];
const localhostLink = linksIn(report);
urlProvider.provideLinks(1, result => { result[0].activate({ button: 0 }, result[0].text); });
ok("left click opens the exact localhost URL without the final dot", opened.length === 1 && opened[0].join("|") === "http://localhost:7345/#screeners|_blank|noopener,noreferrer" && localhostLink.length === 1);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

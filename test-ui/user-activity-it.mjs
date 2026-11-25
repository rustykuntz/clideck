// UI IT — typing guard. Trusted edits in the terminal textarea send an activity-only frame before xterm handles
// them; host insertions the person asked for carry userActivity; raw xterm data (incl. protocol replies) never does.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";

installFakeDom();
const ws = installFakeWs();
const el = (tag, id, parent = document.body) => {
  const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node;
};
for (const id of [
  "term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-name", "th-rename",
  "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn",
]) el("div", id);
globalThis.getComputedStyle = () => ({
  paddingLeft: "0", paddingRight: "0", paddingTop: "0", paddingBottom: "0",
});
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

let terminal;
class FakeTerminal {
  constructor(options) {
    terminal = this;
    this.options = { ...options };
    this.cols = options.cols; this.rows = options.rows;
    this.buffer = { active: { viewportY: 0, baseY: 0, getLine: () => null } };
    this.modes = { bracketedPasteMode: true };
    this._core = {
      _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } },
      viewport: { scrollBarWidth: 0 },
    };
  }
  open(host) {
    const viewport = document.createElement("div"); viewport.className = "xterm-viewport"; host.appendChild(viewport);
    this.textarea = document.createElement("textarea"); host.appendChild(this.textarea);
  }
  attachCustomKeyEventHandler() {}
  onData(fn) { this.dataHandler = fn; }
  onScroll() {}
  onResize() { return { dispose() {} }; }
  registerLinkProvider() {}
  reset() {}
  clear() {}
  write(_data, done) { if (done) done(); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  scrollToBottom() {}
  focus() { this.textarea.focus(); }
}
window.Terminal = FakeTerminal;
window.Unicode11Addon = { Unicode11Addon: class { activate(term) { term.unicode = { activeVersion: "6" }; } } };
FakeTerminal.prototype.loadAddon = function(addon) { addon.activate(this); };

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initTerminal, commitTerminalDraft } = await import("../public/js/ui/terminal.js");
const { pastePayload } = await import("../public/js/ui/paste.js");
const { pasteToTerminal } = await import("../public/js/ui/prompts.js");
const { openSessionMenu } = await import("../public/js/ui/session-menu.js");

let pass = 0, fail = 0;
const ok = (name, condition) => {
  if (condition) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inputs = () => ws.sent.filter((m) => m && m.type === "input");
const activityOnly = (m) => m && m.data === "" && m.userActivity === true && m.sessionId === "A";

try {
  initTerminal(); connectWs(); await sleep(5);
  const snapshot = (extra = {}) => ({ type: "session.created", sessionId: "A", provider: "claude-code", cwd: "/a", name: "alpha", live: true, pid: 1, bracketedPaste: true, ...extra });
  store.applyEvent(snapshot()); store.select("A"); await sleep(5);
  const mount = document.getElementById("term");
  const key = (key, extra = {}) => { ws.clear(); mount._fire("keydown", { type: "keydown", key, isTrusted: true, target: terminal.textarea, ...extra }); return inputs(); };

  let sent = key("a");
  ok("a trusted character key reports one activity-only frame", sent.length === 1 && activityOnly(sent[0]));
  for (const [name, k, extra] of [["Backspace", "Backspace"], ["Enter", "Enter"], ["history Up", "ArrowUp"], ["Ctrl+A line edit", "a", { ctrlKey: true }], ["Ctrl+C interrupt", "c", { ctrlKey: true }], ["Escape", "Escape"], ["Tab", "Tab"]])
    ok(name + " counts as editing", activityOnly(key(k, extra || {})[0]));
  for (const [name, k, extra] of [["lone Shift", "Shift"], ["lone Meta", "Meta"], ["F7 shortcut", "F7"], ["Cmd+C copy", "c", { metaKey: true }], ["Cmd+K clear", "k", { metaKey: true }], ["Ctrl+F search", "f", { ctrlKey: true }], ["IME keydown 229", "Process", { keyCode: 229 }], ["composing keydown", "a", { isComposing: true }]])
    ok(name + " sends nothing", key(k, extra || {}).length === 0);
  ok("untrusted (scripted) keydown sends nothing", key("a", { isTrusted: false }).length === 0);
  const search = document.createElement("input"); mount.appendChild(search);
  ok("typing in another field inside the terminal area (search) sends nothing", key("a", { target: search }).length === 0);

  ws.clear(); mount._fire("compositionupdate", { type: "compositionupdate", isTrusted: true, target: terminal.textarea });
  ok("each IME composition step reports activity before any data", activityOnly(inputs()[0]) && inputs().length === 1);
  ws.clear(); mount._fire("compositionend", { type: "compositionend", isTrusted: true, target: terminal.textarea });
  ok("IME commit reports activity", activityOnly(inputs()[0]));
  ws.clear(); mount._fire("beforeinput", { type: "beforeinput", inputType: "insertText", isTrusted: true, target: terminal.textarea });
  ok("native text insertion (dictation/accessibility) reports activity", inputs().length === 1 && activityOnly(inputs()[0]));
  ws.clear(); mount._fire("beforeinput", { type: "beforeinput", inputType: "insertCompositionText", isComposing: true, isTrusted: true, target: terminal.textarea });
  ok("composition beforeinput is left to the composition events", inputs().length === 0);
  ws.clear(); mount._fire("compositionupdate", { type: "compositionupdate", isTrusted: false, target: terminal.textarea });
  ok("untrusted composition sends nothing", inputs().length === 0);

  ws.clear(); terminal.dataHandler("x"); terminal.dataHandler("\x1b[12;40R"); terminal.dataHandler("\x1b[?62;c");
  ok("raw xterm data, including protocol replies, is never marked",
    inputs().length === 3 && inputs().every((m) => !("userActivity" in m)) && inputs()[1].data === "\x1b[12;40R" && inputs()[2].data === "\x1b[?62;c");
  ws.clear(); terminal.dataHandler("\x1b[I"); terminal.dataHandler("\x1b[O"); terminal.dataHandler("\x1b[O\x1b[I\x1b[O");
  ok("pure focus-in/out reports (single or concatenated) are not sent, so focus can't cancel a phone reply", inputs().length === 0);
  ws.clear(); terminal.dataHandler("\x1b[Ia"); terminal.dataHandler("\x1b[A"); terminal.dataHandler("\x1b[200~\x1b[I\x1b[201~");
  ok("keys, arrows and paste that merely contain a focus sequence still go through",
    inputs().map((m) => m.data).join("|") === "\x1b[Ia|\x1b[A|\x1b[200~\x1b[I\x1b[201~");

  ws.clear();
  mount._fire("paste", { type: "paste", isTrusted: true, target: terminal.textarea, clipboardData: { getData: () => "hello" } });
  ok("bracketed paste is one marked insertion", inputs().length === 1 && inputs()[0].data === pastePayload("hello") && inputs()[0].userActivity === true);
  store.applyEvent(snapshot({ bracketedPaste: false })); ws.clear();
  mount._fire("paste", { type: "paste", isTrusted: true, target: terminal.textarea, clipboardData: { getData: () => "raw" } });
  ok("plain paste left to xterm still reports activity first", inputs().length === 1 && activityOnly(inputs()[0]));
  store.applyEvent(snapshot());

  ws.clear();
  ok("plugin/voice draft commit is marked", commitTerminalDraft("draft", { sessionId: "A" }) && inputs()[0].userActivity === true && inputs()[0].data === pastePayload("draft"));
  ws.clear();
  ok("drop/upload/voice paste helper is marked", pasteToTerminal("/a/file.png") && inputs()[0].userActivity === true);

  const navigatorObject = globalThis.navigator || {};
  Object.defineProperty(navigatorObject, "clipboard", { configurable: true, value: { readText: async () => "menu text" } });
  if (!globalThis.navigator) globalThis.navigator = navigatorObject;
  ws.clear();
  openSessionMenu({ x: 1, y: 1 }, "A", { live: true });
  document.querySelectorAll(".menu-item")[1]._fire("click");
  await sleep(5);
  ok("menu Paste is marked at the actual insertion after the clipboard wait", inputs().length === 1 && inputs()[0].userActivity === true && inputs()[0].data === pastePayload("menu text"));

  store.applyEvent(snapshot({ live: false })); await sleep(5);
  ok("a dormant session gets no activity frames", key("a").length === 0);

  ok("no frame ever says userActivity:false", !ws.sent.some((m) => m && m.userActivity === false));
  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (error) {
  console.log("THREW", error && error.stack || error); fail++;
}
process.exit(fail === 0 ? 0 : 1);

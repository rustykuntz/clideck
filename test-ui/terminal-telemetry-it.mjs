// IT — optional provider context usage and the persisted/finalized agent clock in the real terminal header.
// Frequent same-state usage updates must mutate the telemetry nodes without rebuilding identity or status.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const add = (tag, id, parent = document.body) => { const node = document.createElement(tag); node.id = id; parent.appendChild(node); return node; };
for (const id of ["term", "term-head", "th-avatar", "th-chip", "th-copy", "th-meta", "th-model", "th-name", "th-rename", "rp", "rp-empty", "rp-empty-big", "rp-empty-sub", "scroll-btn"]) add("div", id);
const context = add("div", "th-context"); context.hidden = true;
add("i", "th-context-fill", context); add("span", "th-context-value", context);
const last = add("div", "th-last"); last.hidden = true; add("span", "th-last-value", last); const tip = add("div", "th-last-tip", last);
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
  scrollToBottom() {} focus() { this.textarea.focus(); }
}
window.Terminal = FakeTerminal;
window.Unicode11Addon = { Unicode11Addon: class { activate(term) { term.unicode = { activeVersion: "6" }; } } };
FakeTerminal.prototype.loadAddon = function(addon) { addon.activate(this); };

const { store } = await import("../public/js/store.js");
const { initTerminal } = await import("../public/js/ui/terminal.js");
const checks = [];
const ok = (name, pass) => { checks.push([name, !!pass]); console.log((pass ? "  ok   " : "  FAIL ") + name); };
const initialAt = new Date(2026, 7, 21, 18, 40).getTime();
const finalAt = new Date(2026, 7, 21, 19, 5).getTime();
const usage = (percent, estimated = true) => ({ usedTokens: 61200, windowTokens: 200000, percent, estimated, updatedAt: initialAt });
const localTime = (at) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
const tokenFormat = new Intl.NumberFormat();

initTerminal();
store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: true, pid: 4321, contextUsage: usage(31), lastAgentAt: initialAt });
const session = store.sessions.get("S");
ok("session snapshot stores normalized optional telemetry", session.contextUsage?.percent === 31 && session.contextUsage.estimated === true && session.lastAgentAt === initialAt);
ok("valid context renders one compact meter percentage", context.hidden === false && document.getElementById("th-context-value").textContent === "31%" && document.getElementById("th-context-fill").style.width === "31%");
ok("context tooltip and accessibility distinguish estimated usage", context.classList.contains("estimated") && context.title.includes(tokenFormat.format(61200) + " / " + tokenFormat.format(200000) + " tokens · Estimated") && /31 percent, estimated/.test(context.getAttribute("aria-label")));
ok("persisted last reply renders as the user's local wall-clock time", last.hidden === false && document.getElementById("th-last-value").textContent === localTime(initialAt));
ok("PID remains in the header", document.getElementById("th-meta").textContent === "pid 4321");
const steps = () => ["ctx-yellow", "ctx-orange", "ctx-red"].filter((c) => context.classList.contains(c)).join(",");
ok("31% context is the yellow step", steps() === "ctx-yellow");
for (const [percent, want] of [[24, ""], [25, "ctx-yellow"], [49, "ctx-yellow"], [50, "ctx-orange"], [69, "ctx-orange"], [70, "ctx-red"]]) {
  store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: usage(percent) });
  ok(`context ${percent}% → ${want || "calm (unchanged colour)"}`, steps() === want);
}

store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: usage(55) });
const avatarMark = document.getElementById("th-avatar").firstElementChild;
const statusMark = document.getElementById("th-chip").firstElementChild;
const contextNode = document.getElementById("th-context"), fillNode = document.getElementById("th-context-fill");
store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: usage(78, false) });
ok("same-state context frames update even when status is unchanged", store.sessions.get("S").contextUsage.percent === 78 && document.getElementById("th-context-value").textContent === "78%" && context.classList.contains("ctx-red") && !context.classList.contains("estimated"));
ok("frequent telemetry mutates stable nodes without rebuilding identity or status", avatarMark === document.getElementById("th-avatar").firstElementChild && statusMark === document.getElementById("th-chip").firstElementChild && contextNode === document.getElementById("th-context") && fillNode === document.getElementById("th-context-fill"));
ok("exact context is identified in its tooltip", /Exact/.test(context.title) && /78 percent, exact/.test(context.getAttribute("aria-label")));

store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: null });
ok("an explicit null hides unsupported context entirely", context.hidden === true && store.sessions.get("S").contextUsage === null);
store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: { usedTokens: -1, windowTokens: 0, percent: 500 } });
ok("invalid provider context remains hidden", context.hidden === true && store.sessions.get("S").contextUsage === null);

// ── the active model: a quiet caption, and never a guess ────────────────────────────────────────────────
const model = document.getElementById("th-model");
store.applyEvent({ type: "status", sessionId: "S", state: "idle", model: "claude-sonnet-4-5" });
ok("the model arrives on a status frame and reads as a caption", store.sessions.get("S").model === "claude-sonnet-4-5"
  && model.textContent === "claude-sonnet-4-5" && model.title === "Model: claude-sonnet-4-5");
store.applyEvent({ type: "status", sessionId: "S", state: "idle", model: null });
ok("a model the engine does not know shows NOTHING, and drops its tooltip with it",
  store.sessions.get("S").model === "" && model.textContent === "" && !model.getAttribute("title"));
store.applyEvent({ type: "status", sessionId: "S", state: "idle", model: "gpt-5-codex" });
ok("a later frame replaces it", store.sessions.get("S").model === "gpt-5-codex" && model.textContent === "gpt-5-codex");
store.applyEvent({ type: "status", sessionId: "S", state: "working" });
ok("and a frame carrying no model field at all leaves the last one standing", store.sessions.get("S").model === "gpt-5-codex");

// ── a restart is a NEW PROCESS: what the old one was doing must not survive it ───────────────────────────
store.applyEvent({ type: "status", sessionId: "S", state: "working", contextUsage: usage(64) });
store.applyEvent({ type: "menu", sessionId: "S", choices: ["1", "2"], context: "pick one" });
const before = store.sessions.get("S");
before.name = "Programmer"; before.muted = true;
ok("the session is mid-flight before the restart", before.status === "working" && before.workStartedAt > 0
  && before.contextUsage?.percent === 64 && before.menu.length === 2 && before.model === "gpt-5-codex");
store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: true, pid: 9876, muted: true });
const after = store.sessions.get("S");
ok("a new PID behind the same row clears status, menu, work clock, context and model",
  after.status === null && after.menu.length === 0 && after.menuContext === "" && after.workStartedAt === 0
  && after.contextUsage === null && after.model === "");
ok("and the header goes quiet with it", context.hidden === true && model.textContent === ""
  && document.getElementById("th-meta").textContent === "pid 9876");
ok("but the name the user gave it and the mute they set both survive", after.name === "Programmer" && after.muted === true);

store.applyEvent({ type: "status", sessionId: "S", state: "working", contextUsage: usage(20), model: "claude-opus-5" });
store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: true, pid: 9876 });
ok("an ordinary re-broadcast with the SAME pid is not a restart and clears nothing",
  store.sessions.get("S").status === "working" && store.sessions.get("S").contextUsage?.percent === 20
  && store.sessions.get("S").model === "claude-opus-5");
store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: false, pid: null });
ok("going dormant is a live transition, and clears the same stale state",
  store.sessions.get("S").status === null && store.sessions.get("S").contextUsage === null && store.sessions.get("S").model === "");
store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: usage(12), model: "claude-opus-5" });
store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: false, pid: null, restarted: true });
ok("and an explicit restarted:true clears it even when pid and live say nothing changed",
  store.sessions.get("S").status === null && store.sessions.get("S").contextUsage === null && store.sessions.get("S").model === "");

store.applyEvent({ type: "session.created", sessionId: "S", provider: "codex", name: "Programmer", cwd: "/tmp", live: true, pid: 4321, contextUsage: usage(31), lastAgentAt: initialAt, model: "claude-opus-5" });
ok("the snapshot's OWN values are applied after the reset, so the wire always wins",
  store.sessions.get("S").contextUsage?.percent === 31 && store.sessions.get("S").model === "claude-opus-5");

store.applyEvent({ type: "agent.update", sessionId: "S", text: "draft", at: finalAt });
ok("transient agent updates never alter the finalized-reply clock", store.sessions.get("S").lastAgentAt === initialAt && document.getElementById("th-last-value").textContent === localTime(initialAt));
store.applyEvent({ type: "agent.final", sessionId: "S", text: "done", at: finalAt });
ok("agent.final advances the stored and rendered local wall-clock time", store.sessions.get("S").lastAgentAt === finalAt && document.getElementById("th-last-value").textContent === localTime(finalAt));

// Prompt-cache warning: idle + a context to lose + older than the provider's cache window → red pill + card.
const MIN = 60000;
const reply = (sid, ago) => store.applyEvent({ type: "agent.final", sessionId: sid, text: "done", at: Date.now() - ago * MIN });
ok("a months-old Codex reply with context is cold", last.classList.contains("cold") && last.getAttribute("tabindex") === "0" && !last.title && last.getAttribute("aria-describedby") === "th-last-tip");
ok("the card names the provider window, the tokens at stake and /clear", /Codex/.test(tip.innerHTML) && /30 minutes/.test(tip.innerHTML) && /~61K/.test(tip.innerHTML) && /\/clear/.test(tip.innerHTML));
reply("S", 29);
ok("Codex 29 min → warm, native title back", !last.classList.contains("cold") && /Last finalized reply/.test(last.title) && tip.innerHTML === "");
reply("S", 31);
ok("Codex 31 min → cold", last.classList.contains("cold"));
store.applyEvent({ type: "status", sessionId: "S", state: "working" });
ok("working → not cold (the request is re-warming the cache)", !last.classList.contains("cold"));
store.applyEvent({ type: "status", sessionId: "S", state: "idle", contextUsage: null });
ok("/clear (engine drops contextUsage) → warning gone", !last.classList.contains("cold") && last.hidden === false);
store.applyEvent({ type: "session.created", sessionId: "C", provider: "claude-code", name: "Claude", cwd: "/tmp", live: true, pid: 99, contextUsage: usage(40), lastAgentAt: Date.now() - 45 * MIN });
store.applyEvent({ type: "status", sessionId: "C", state: "idle" });
store.select("C");
ok("Claude Code 45 min → warm (1 hour window)", store.activeId === "C" && !last.classList.contains("cold"));
reply("C", 61);
ok("Claude Code 61 min → cold, card says 1 hour", last.classList.contains("cold") && /Claude Code/.test(tip.innerHTML) && /1 hour/.test(tip.innerHTML));
store.applyEvent({ type: "status", sessionId: "C", state: "idle", contextUsage: null });   // leaves no pending re-check timer
store.applyEvent({ type: "session.created", sessionId: "G", provider: "gemini", name: "Gemini", cwd: "/tmp", live: true, pid: 98, contextUsage: usage(40), lastAgentAt: Date.now() - 5 * 60 * MIN });
store.applyEvent({ type: "status", sessionId: "G", state: "idle" });
store.select("G");
ok("Gemini 5 h → never warns (no documented cache window)", store.activeId === "G" && !last.classList.contains("cold") && /Last finalized reply/.test(last.title));

if (checks.some(([, pass]) => !pass)) process.exitCode = 1;
else console.log(`\n${checks.length}/${checks.length} terminal telemetry checks passed`);

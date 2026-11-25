// UI IT — Telegram plugin (plugin-packages/telegram): the client Worker's header actions against a fake host
// API, and the workspace page against a fake parent frame bridge. Server answers are faked per the contract
// ('request' → 'result' {requestId, ok, ...snapshot}; 'updated' broadcasts). No network, no Telegram.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const snap = (over = {}) => ({
  telegram: { connected: false, bot: null, topicsEnabled: false, paired: null, pairing: null, status: "off", error: "", ...(over.telegram || {}) },
  sessions: over.sessions || [], presence: { mode: "auto", away: false, supported: true, idleSeconds: 600, ...(over.presence || {}) },
});
const paired = { connected: true, bot: { id: 1, username: "deck_bot", name: "Deck" }, topicsEnabled: true, paired: { id: 7, name: "Or", username: "or_k" }, status: "ready" };

try {
  // ═════ Worker client ═════
  const { activate } = await import("../plugin-packages/telegram/client.js");
  const actions = new Map(), handlers = new Map(), sent = [], toasts = [], opened = [], workspaces = [];
  let unregistered = 0, server = (data) => ({ ok: true, ...snap() });
  const api = {
    registerWorkspace: (def) => { workspaces.push(def); return () => unregistered++; },
    registerAction: (def) => { actions.set(def.id, def); return () => { unregistered++; actions.delete(def.id); }; },
    openWorkspace: (id, options) => opened.push({ id, options }),
    onMessage: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event); },
    send: (event, data) => { sent.push({ event, data }); const reply = server(data); if (reply) setTimeout(() => handlers.get("result")?.({ requestId: data.requestId, ...reply }), 1); },
    toast: (kind, options) => toasts.push({ kind, ...options }),
  };
  const cleanup = activate(api); await sleep();
  const ctx = (id = "c1", provider = "claude") => ({ surface: "terminal", session: { id, provider } });
  const shows = (id, c = ctx()) => !!actions.get(id).when?.(c);
  ok("worker: registers the Telegram workspace and asks for status", workspaces[0]?.id === "setup" && workspaces[0].title === "Telegram" && sent[0]?.data.action === "status");
  ok("worker: setup is in the toolbar and on the plugin card (generic plugin.settings)", actions.get("open").placements.includes("toolbar") && actions.get("configure").placements.includes("plugin.settings"));
  ok("worker: nothing phone-related before Telegram is paired", !shows("phone-on") && !shows("phone-off") && !shows("away"));

  handlers.get("updated")(snap({ telegram: paired, sessions: [{ sessionId: "c1", enabled: false, supported: true }] }));
  ok("worker: paired → 'Send this session to my phone' and 'I’m away'", shows("phone-on") && !shows("phone-off") && shows("away") && !shows("back"));
  server = (data) => data.action === "phone" ? { ok: true, ...snap({ telegram: paired, sessions: [{ sessionId: "c1", enabled: true, topicId: 4, supported: true }] }) } : { ok: true, ...snap({ telegram: paired }) };
  await actions.get("phone-on").run(ctx());
  const phoneReq = sent.at(-1).data;
  ok("worker: turning on sends phone {sessionId, enabled:true}", phoneReq.action === "phone" && phoneReq.sessionId === "c1" && phoneReq.enabled === true);
  ok("worker: success is confirmed and the menu flips to Stop", toasts.at(-1).kind === "success" && shows("phone-off") && !shows("phone-on"));

  server = () => ({ ok: false, error: "topic_failed", message: "Couldn’t create the Telegram topic." });
  await actions.get("phone-off").run(ctx()); await sleep();
  ok("worker: a failure is an explicit error and the state does not change", toasts.at(-1).kind === "error" && /Couldn’t create the Telegram topic/.test(toasts.at(-1).body) && shows("phone-off"));

  const before = sent.length;
  handlers.get("updated")(snap({ telegram: paired, sessions: [{ sessionId: "sh", enabled: false, supported: false }] }));
  await actions.get("phone-on").run(ctx("sh", "shell"));
  ok("worker: unsupported session explains and sends nothing", sent.length === before && /Claude and Codex/.test(toasts.at(-1).body));

  server = (data) => ({ ok: true, ...snap({ telegram: paired, presence: { mode: data.mode, away: data.mode === "away" } }) });
  await actions.get("away").run(ctx()); await sleep();
  ok("worker: I’m away sends presence away, then offers I’m back", sent.at(-1).data.mode === "away" && shows("back") && !shows("away"));
  await actions.get("back").run(ctx()); await sleep();
  ok("worker: I’m back returns to Auto", sent.at(-1).data.mode === "auto");
  handlers.get("updated")(snap({ telegram: paired, presence: { mode: "away", away: true, supported: false } }));
  await actions.get("back").run(ctx()); await sleep();
  ok("worker: …or Here where Auto isn’t available", sent.at(-1).data.mode === "here");

  handlers.get("updated")(snap({ telegram: paired, sessions: [{ sessionId: "c1", enabled: true, supported: true, pending: { id: "p1", state: "uncertain" } }] }));
  ok("worker: an uncertain phone message adds 'Check a phone message…'", shows("check-pending"));
  actions.get("check-pending").run(ctx());
  ok("worker: it opens Telegram setup beside that session", opened.at(-1)?.id === "setup" && opened.at(-1).options.sessionId === "c1");
  actions.get("configure").run({ surface: "settings", session: null });
  ok("worker: Configure with no session explains instead of failing silently", opened.length === 1 && /Open a session first/.test(toasts.at(-1).body));
  handlers.get("result")({ requestId: "someone-else", ok: true, ...snap() });
  ok("worker: replies for other requests are ignored", shows("check-pending"));
  cleanup();
  ok("worker: deactivation removes every contribution", actions.size === 0 && unregistered === 8);

  // ═════ Workspace page ═════
  const root = document.createElement("main"); root.id = "root"; document.body.appendChild(root);
  const posts = []; let state = snap(), reply = null;
  const parent = { postMessage: (m) => { posts.push(m); if (m.type === "clideck.send") setTimeout(() => {
    const r = reply ? reply(m.data) : { ok: true, ...state };
    dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "result", data: { requestId: m.data.requestId, ...r } } } });
  }, 1); } };
  globalThis.parent = parent;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  new Function(readFileSync(new URL("../plugin-packages/telegram/public/app.js", import.meta.url), "utf8"))();
  const all = () => document.body._walk();
  const control = (name) => all().find((n) => n.dataset?.control === name);
  const text = () => root.textContent;
  const requests = () => posts.filter((m) => m.type === "clideck.send").map((m) => m.data);
  const lastReq = () => requests().at(-1);
  const init = (sessionId = "c1", theme = "light") => dom.winFire("message", { source: parent, data: { type: "clideck.init", data: { context: { surface: "workspace", sessionId }, theme } } });
  const updated = (s) => dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "updated", data: s } } });

  ok("page: says ready to the host", posts[0]?.type === "clideck.ready");
  dom.winFire("message", { source: {}, data: { type: "clideck.init", data: { context: {}, theme: "light" } } });
  ok("page: ignores messages that are not from its parent", requests().length === 0);
  init(); await sleep();
  ok("page: init asks for status and takes the host theme", lastReq()?.action === "status" && document.documentElement.getAttribute("data-theme") === "light");
  ok("page: setup steps + token field", /BotFather/.test(text()) && /Threaded Mode/.test(text()) && control("token")?.type === "password" && control("connect").disabled === true);
  all().find((n) => n.classList?.contains("ca-link") && n.textContent === "@BotFather")._fire("click");
  ok("page: links open through the host (sandbox has no popups)", posts.at(-1).type === "clideck.open" && posts.at(-1).url === "https://t.me/BotFather");
  const token = control("token"); token.value = "123:abc"; token._fire("input");
  reply = () => ({ ok: false, error: "bad_token", message: "Telegram rejected this token." });
  control("connect")._fire("click"); await sleep();
  ok("page: connect sends the token; a rejection shows why and keeps the draft", lastReq().action === "connect" && lastReq().token === "123:abc" && /Telegram rejected this token/.test(text()) && control("token").value === "123:abc");

  reply = null; state = snap({ telegram: { ...paired, paired: null, topicsEnabled: false } });
  control("connect")._fire("click"); await sleep();
  ok("page: connected, topics off → explained with Check again", /Topics are off/.test(text()) && !!control("recheck") && !control("token"));
  control("recheck")._fire("click"); await sleep();
  ok("page: Check again rechecks the saved token (connect with no token)", lastReq().action === "connect" && !("token" in lastReq()));

  state = snap({ telegram: { ...paired, paired: null, pairing: { url: "https://t.me/deck_bot?start=s3", expiresAt: now + 9 * 60000 } } });
  control("pair")._fire("click"); await sleep();
  ok("page: pairing link with Copy, Open, waiting and expiry", !!control("copy") && /Waiting for you to tap Start/.test(text()) && /expires in 9 min/.test(text()));
  control("open")._fire("click");
  ok("page: Open in Telegram goes through the host", posts.at(-1).type === "clideck.open" && posts.at(-1).url === "https://t.me/deck_bot?start=s3");
  updated(snap({ telegram: { ...paired, paired: null, pairing: { url: "x", expiresAt: now - 1 } } })); await sleep();
  ok("page: an expired link offers a new one", control("pair")?.textContent === "New link");

  state = snap({ telegram: paired, sessions: [
    { sessionId: "c2", name: "Strategy", enabled: true, topicId: 4, supported: true, pending: { id: "p9", state: "uncertain", message: "" } },
    { sessionId: "sh", name: "Shell", enabled: false, topicId: 5, supported: false },
  ] });
  updated(state); await sleep();
  ok("page: paired + Send test", /Paired with Or @or_k/.test(text()) && !!control("test"));
  ok("page: presence with the 10 min threshold and the desk-only rule", /after 10 min/.test(text()) && /Agent-to-agent asks and monitors stay here/.test(text()));
  const sw = (label) => all().find((n) => n.getAttribute?.("aria-label") === "Phone for " + label);
  ok("page: this tab’s session is listed even before it is on", !!sw("This session") && sw("This session").getAttribute("aria-checked") === "false");
  ok("page: unsupported session is disabled and explained", sw("Shell").disabled === true && /Claude and Codex/.test(text()));
  ok("page: Off stays available while a message is pending", sw("Strategy").disabled === false && /may not have reached/.test(text()));
  control("clear")._fire("click");
  ok("page: Clear pending asks first", !!control("clear-yes") && !requests().some((r) => r.action === "acknowledge"));
  control("clear-yes")._fire("click"); await sleep();
  ok("page: confirm sends acknowledge {id}", lastReq().action === "acknowledge" && lastReq().id === "p9");
  reply = () => ({ ok: false, message: "Telegram is not reachable." });
  sw("This session")._fire("click"); await sleep();
  ok("page: a failed switch shows the error and stays Off", lastReq().action === "phone" && lastReq().sessionId === "c1" && /not reachable/.test(text()) && sw("This session").getAttribute("aria-checked") === "false");
  reply = null;
  all().find((n) => n.dataset?.value === "away")._fire("click"); await sleep();
  ok("page: choosing Away sends presence", lastReq().action === "presence" && lastReq().mode === "away");
  control("disconnect")._fire("click");
  ok("page: Disconnect asks first", /Disconnect Telegram\?/.test(text()) && lastReq().action !== "disconnect");
  control("disconnect-yes")._fire("click"); await sleep();
  ok("page: confirm sends disconnect", lastReq().action === "disconnect");
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// UI IT — Chat apps plugin (plugin-packages/chat-apps): the client Worker against a fake host API, and the
// workspace page against a fake parent frame bridge. Server answers are faked per the contract
// ('request' → 'result' {requestId, ok, ...snapshot}; 'updated' broadcasts). No network, no WhatsApp.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const sessions = [
  { sessionId: "s1", name: "Contracts reviewer", projectName: "Legal", supported: true },
  { sessionId: "s2", name: "Inbox triage", projectName: "Personal", supported: true },
  { sessionId: "s3", name: "zsh", projectName: "Personal", supported: false },
];
const snap = (over = {}) => ({
  whatsapp: { status: "disconnected", error: "", account: null, qrDataUrl: null, ...(over.whatsapp || {}) },
  sessions: over.sessions || sessions, groups: over.groups || [], routes: over.routes || [], pending: over.pending || [],
});
const connected = { status: "connected", account: "+972 54 123 4567" };

try {
  // ═════ Worker client ═════
  const { activate } = await import("../plugin-packages/chat-apps/client.js");
  const actions = new Map(), handlers = new Map(), sent = [], opened = [], workspaces = [];
  let unregistered = 0;
  const api = {
    registerWorkspace: (def) => { workspaces.push(def); return () => unregistered++; },
    registerAction: (def) => { actions.set(def.id, def); return () => { unregistered++; actions.delete(def.id); }; },
    openWorkspace: (id, options) => opened.push({ id, options }),
    onMessage: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event); },
    send: (event, data) => { sent.push({ event, data }); setTimeout(() => handlers.get("result")?.({ requestId: data.requestId, ok: true, ...snap() }), 1); },
    toast: () => {},
  };
  const cleanup = activate(api); await sleep();
  ok("worker: registers the Chat apps workspace and asks for status", workspaces[0]?.id === "setup" && workspaces[0].src === "/plugins/chat-apps/public/index.html" && sent[0]?.data.action === "status");
  ok("worker: setup in the toolbar and on the plugin card", actions.get("open").placements.includes("toolbar") && actions.get("configure").placements.includes("plugin.settings"));
  actions.get("configure").run({ surface: "settings", session: null });
  ok("worker: Configure with no session opens the page in the main pane", opened.at(-1)?.id === "setup" && !opened.at(-1).options.sessionId);
  actions.get("open").run({ session: { id: "s1" } });
  ok("worker: with a session it opens beside it", opened.at(-1).options.sessionId === "s1");
  const ctx = (id) => ({ surface: "terminal", session: { id } });
  ok("worker: no pending message → no header check", !actions.get("check-pending").when(ctx("s1")));
  handlers.get("updated")(snap({ pending: [{ id: "p1", sessionId: "s1", state: "uncertain", message: "" }] }));
  ok("worker: a pending message shows 'Check a WhatsApp message…' on that agent only", actions.get("check-pending").when(ctx("s1")) && !actions.get("check-pending").when(ctx("s2")));
  cleanup();
  ok("worker: deactivation removes every contribution", actions.size === 0 && unregistered === 4);

  // ═════ Workspace page ═════
  const root = document.createElement("main"); root.id = "root"; document.body.appendChild(root);
  const posts = []; let state = snap(), reply = null;
  const parent = { postMessage: (m) => { posts.push(m); if (m.type === "clideck.send") setTimeout(() => {
    const r = reply ? reply(m.data) : { ok: true, ...state };
    dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "result", data: { requestId: m.data.requestId, ...r } } } });
  }, 1); } };
  globalThis.parent = parent;
  new Function(readFileSync(new URL("../plugin-packages/chat-apps/public/app.js", import.meta.url), "utf8"))();
  const all = () => document.body._walk();
  const control = (name) => all().find((n) => n.dataset?.control === name);
  const controls = (name) => all().filter((n) => n.dataset?.control === name);
  const text = () => root.textContent;
  const requests = () => posts.filter((m) => m.type === "clideck.send").map((m) => m.data);
  const lastReq = () => requests().at(-1);
  const init = () => dom.winFire("message", { source: parent, data: { type: "clideck.init", data: { context: { surface: "workspace", sessionId: "s2" }, theme: "light" } } });
  const updated = async (s) => { dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "updated", data: s } } }); await sleep(); };

  ok("page: says ready to the host", posts[0]?.type === "clideck.ready");
  init(); await sleep();
  ok("page: init asks for status and takes the host theme", lastReq()?.action === "status" && document.documentElement.getAttribute("data-theme") === "light");
  ok("page: disconnected → Connect WhatsApp, no groups yet", !!control("connect") && /Not connected/.test(text()) && !control("group"));
  ok("page: explains the prototype (own number, own-only groups, shows as you, notifications, unofficial)",
    /No extra SIM/.test(text()) && /only member/.test(text()) && /labelled with the agent’s name/.test(text()) && /Notifications aren’t guaranteed/.test(text()) && /unofficial/.test(text()));
  ok("page: no Telegram card yet", !/Telegram/.test(text()));

  state = snap({ whatsapp: { status: "preparing" } });
  control("connect")._fire("click"); await sleep();
  ok("page: connect returns at once; preparing shows progress and Cancel", lastReq().action === "connect" && /Getting WhatsApp ready/.test(text()) && !!control("cancel"));
  await updated(snap({ whatsapp: { status: "pairing", qrDataUrl: null } }));
  ok("page: pairing before the code exists says so", /Making a code/.test(text()) && !control("qr"));
  await updated(snap({ whatsapp: { status: "pairing", qrDataUrl: "data:image/png;base64,QR" } }));
  ok("page: QR code with the Linked devices steps", control("qr")?.src === "data:image/png;base64,QR" && /Linked devices/.test(text()) && /Waiting for your phone/.test(text()));
  ok("page: the QR never leaves the page (nothing posted carries it)", !posts.some((m) => JSON.stringify(m).includes("base64,QR")));
  await updated(snap({ whatsapp: { status: "error", error: "WhatsApp logged this device out." } }));
  ok("page: error shows the reason and Try again", /logged this device out/.test(text()) && control("connect")?.textContent === "Try again");

  const groups = [{ id: "g1", name: "Legal assistant" }, { id: "g2", name: "Personal assistant" }];
  const live = snap({ whatsapp: connected, groups });
  state = live; await updated(snap({ whatsapp: connected })); // the broadcast has no groups; the page's own refresh brings them
  ok("page: once connected it refreshes groups by itself", requests().some((r) => r.action === "groups") && /\+972 54 123 4567/.test(text()));
  ok("page: groups list the own-only groups", control("group")?._walk().filter((n) => n.tagName === "OPTION" && n.value).map((n) => n.textContent).join() === "Legal assistant,Personal assistant");
  const agentOptions = control("agent")._walk().filter((n) => n.tagName === "OPTION" && n.value);
  ok("page: agents are grouped by project; unsupported are disabled", control("agent")._walk().filter((n) => n.tagName === "OPTGROUP").map((n) => n.label).join() === "Legal,Personal" && agentOptions.find((o) => o.value === "s3").disabled === true);
  ok("page: the agent this tab sits beside is preselected; Connect waits for a group", control("agent").value === "s2" && control("bind").disabled === true);
  control("group").value = "g1"; control("group")._fire("change");
  ok("page: choosing a group enables Connect group", control("bind").disabled === false);
  state = snap({ whatsapp: connected, groups, routes: [{ groupId: "g1", name: "Legal assistant", sessionId: "s2", enabled: true }] });
  control("bind")._fire("click"); await sleep();
  ok("page: Connect group sends bind {groupId, sessionId} and confirms", lastReq().action === "bind" && lastReq().groupId === "g1" && lastReq().sessionId === "s2" && /now goes to Inbox triage/.test(text()));
  ok("page: the link lists group → agent · project; that group leaves the picker", /Legal assistant/.test(text()) && /· Personal/.test(text()) && !control("group")._walk().some((n) => n.value === "g1"));

  control("test")._fire("click"); await sleep();
  ok("page: Send test sends test {groupId}", lastReq().action === "test" && lastReq().groupId === "g1" && /Test sent/.test(text()));
  reply = () => ({ ok: false, message: "WhatsApp isn’t reachable." });
  control("test")._fire("click"); await sleep();
  ok("page: a failure is shown, the link stays", /isn’t reachable/.test(text()) && !!control("unbind"));
  reply = null;

  await updated(snap({ whatsapp: connected, groups, routes: state.routes, pending: [
    { id: "p1", sessionId: "s2", state: "uncertain", message: "" },
    { id: "p2", sessionId: "s1", state: "failed", message: "A message to Contracts reviewer failed." },
  ] }));
  ok("page: pending errors are visible — under their group, and for agents with no group", /may not have reached this agent/.test(text()) && /Contracts reviewer failed/.test(text()) && controls("clear").length === 2);
  controls("clear")[0]._fire("click");
  ok("page: Clear asks first and never resends", !!control("clear-yes") && !requests().some((r) => r.action === "acknowledge"));
  control("clear-yes")._fire("click"); await sleep();
  ok("page: confirm sends acknowledge {id}", lastReq().action === "acknowledge" && ["p1", "p2"].includes(lastReq().id));

  control("unbind")._fire("click");
  ok("page: Disconnect group asks first", !!control("unbind-yes") && lastReq().action !== "unbind");
  state = snap({ whatsapp: connected, groups });
  control("unbind-yes")._fire("click"); await sleep();
  ok("page: confirm sends unbind {groupId}", lastReq().action === "unbind" && lastReq().groupId === "g1" && /is disconnected/.test(text()));

  state = snap({ whatsapp: connected, groups: [] }); await updated(state);
  ok("page: no groups explains how to make one, with Refresh", /create a group with only you in it/.test(text()) && !!control("refresh"));
  control("refresh")._fire("click"); await sleep();
  ok("page: Refresh sends groups", lastReq().action === "groups");

  control("disconnect")._fire("click");
  ok("page: Disconnect WhatsApp asks first", /Disconnect WhatsApp\?/.test(text()) && lastReq().action !== "disconnect");
  control("disconnect-yes")._fire("click"); await sleep();
  ok("page: confirm sends disconnect", lastReq().action === "disconnect");
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

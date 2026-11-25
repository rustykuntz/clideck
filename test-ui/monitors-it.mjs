// UI IT — Monitors window. Drives the real monitors.js against a fake /api/monitors and the real store:
// snapshot from WS + GET on open, grouping/filters, plain-language rows, explicit actions with inline
// confirmations, errors kept visible, header attention dot. No polling, no real monitors.
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
document.visibilityState = "visible";
const trigger = document.createElement("button"); trigger.id = "monitors"; document.body.appendChild(trigger);
const now = Date.now(), min = 60000;
const base = (over) => ({ id: "x", name: "Monitor", sessionId: "s1", sessionName: "Strategy", projectName: "Trading", command: "wc -l data.csv", cwd: "/w", mode: "change",
  everyMs: 5 * min, at: null, once: false, resumeSession: false, paused: false, state: "watching", message: "", lastCheckAt: now - 2 * min, nextCheckAt: now + 3 * min,
  lastFiredAt: null, wakeCount: 0, lastFinding: "", pendingCount: 0, history: [], createdAt: now, ...over });
let monitors = [
  base({ id: "w", name: "New rows" , wakeCount: 4, lastFiredAt: now - 95 * min, message: "Baseline saved; watching for changes." }),
  base({ id: "e", name: "API health", state: "error", message: "Command exited with code 22", history: [{ at: now - 30 * min, status: "no change", message: "" }, { at: now - 9 * min, status: "error", message: "exit 22" }] }),
  base({ id: "p", name: "Backup done", sessionId: "s2", sessionName: "Video", projectName: "Studio", paused: true, state: "paused", everyMs: null, at: now + 9 * 3600000, once: true, nextCheckAt: null }),
  base({ id: "u", name: "Deploy status", sessionId: "s2", sessionName: "Video", projectName: "Studio", state: "uncertain", message: "Delivery was interrupted.", pendingCount: 1 }),
  base({ id: "c", name: "Tests green", sessionId: "gone", sessionName: "", projectName: "", state: "complete", once: true, nextCheckAt: null }),
  base({ id: "k", name: "Checking one", state: "checking" }),
];
const posts = []; let gets = 0, getReply = null, postReply = null, holdGet = null;
globalThis.fetch = async (url, init = {}) => {
  if (url !== "/api/monitors") throw new Error("unexpected " + url);
  if (!init.method) {
    gets++;
    if (init.cache !== "no-store") throw new Error("GET must be no-store");
    if (holdGet) await new Promise((r) => { holdGet.release = r; });
    const r = getReply || { status: 200, body: { monitors } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  }
  posts.push(JSON.parse(init.body));
  const r = postReply || { status: 200, body: { monitors } };
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};

const { store } = await import("../public/js/store.js");
const { initMonitors, schedule, ago, until } = await import("../public/js/ui/monitors.js");

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const all = () => document.body._walk();
const control = (name) => all().find((n) => n.dataset?.control === name);
const rows = () => all().filter((n) => n.classList?.contains("mon-row"));
const rowText = (id) => rows().find((r) => r.textContent.includes(monitors.find((m) => m.id === id).name))?.textContent || "";
const groups = () => all().filter((n) => n.classList?.contains("mon-group")).map((g) => g.textContent);
const notice = () => all().find((n) => n.classList?.contains("tasks-notice") && n.classList.contains("error"));
const stateText = () => { const s = all().find((n) => n.classList?.contains("tasks-state")); return s && !s.hidden ? s.textContent : ""; };
const seg = (value) => all().find((n) => n.dataset?.value === value);

try {
  ok("plain schedules", schedule({ everyMs: 5 * min }) === "every 5 min" && schedule({ everyMs: 30000 }) === "every 30 sec" && schedule({ everyMs: 3600000 }) === "every hour"
    && schedule({ everyMs: 86400000 }) === "every day" && schedule({}) === "manual" && schedule({ at: now + 60000 }, now).startsWith("once, today"));
  ok("relative times", ago(now - 10000, now) === "just now" && ago(now - 2 * min, now) === "2 min ago" && until(now + 3 * min, now) === "in 3 min" && until(now - 1000, now) === "due now");

  initMonitors();
  store.setConnected(true);
  store.applyEvent({ type: "monitors.updated", monitors });
  ok("header dot when a monitor needs the person (error/uncertain)", trigger.classList.contains("mon-alert") && trigger.title === "Monitors — 2 need attention");

  trigger._fire("click"); await sleep();
  ok("opening fetches once (no-store) and renders the broadcast snapshot", gets === 1 && rows().length === monitors.length);
  ok("grouped by project / session (A–Z), missing session last", JSON.stringify(groups().map((g) => g.replace(/\d+$/, ""))) === JSON.stringify(["Studio / Video", "Trading / Strategy", "Missing session · its session was deleted"]), groups());
  ok("row: name, state, schedule, next, wakes (none when zero)", /New rows/.test(rowText("w")) && /Watching/.test(rowText("w")) && /every 5 min/.test(rowText("w")) && !/checked 2 min ago/.test(rowText("w")) && /next in 3 min/.test(rowText("w")) && /4 wakes/.test(rowText("w")) && !/no wakes/.test(rowText("e")));
  ok("routine notes are not repeated under watching rows", !/Baseline saved/.test(rowText("w")));
  ok("waiting/error reason shown in plain words", /Command exited with code 22/.test(rowText("e")) && /Needs a look/.test(rowText("u")) && /1 waiting to deliver/.test(rowText("u")));
  ok("command stays hidden until expanded", !/wc -l data\.csv/.test(rowText("w")));
  ok("Check now disabled for paused/checking/complete/uncertain", control("check-p").disabled && control("check-k").disabled && control("check-c").disabled && control("check-u").disabled && !control("check-w").disabled);
  ok("paused shows Resume; others Pause; Done cannot pause", !!control("resume-p") && !control("pause-p") && control("pause-c").disabled);
  ok("Clear pending only for uncertain", !!control("acknowledge-u") && !control("acknowledge-e"));
  store.applyEvent({ type: "monitors.updated", monitors: monitors.map((m) => m.id === "u" ? { ...m, paused: true } : m) }); await sleep();
  ok("paused + needs a look: Resume waits until pending is cleared", control("resume-u").disabled && control("resume-u").title === "Clear the pending finding first");
  store.applyEvent({ type: "monitors.updated", monitors }); await sleep();
  ok("filter counts", /Needs attention2/.test(seg("attention").textContent) && /Paused1/.test(seg("paused").textContent));
  seg("attention")._fire("click"); await sleep();
  ok("Needs attention shows error, uncertain and waiting only", rows().length === 2 && /API health/.test(rows().map((r) => r.textContent).join()) && /Deploy status/.test(rows().map((r) => r.textContent).join()));
  seg("paused")._fire("click"); await sleep();
  ok("Paused shows paused only", rows().length === 1 && /Backup done/.test(rows()[0].textContent));
  seg("all")._fire("click"); await sleep();

  control("expand-e")._fire("click"); await sleep();
  const details = rowText("e");
  ok("expanded: command, folder, trigger, newest history first", /wc -l data\.csv/.test(details) && /\/w/.test(details) && /When the output changes/.test(details) && details.indexOf("exit 22") < details.indexOf("no change"));

  control("pause-w")._fire("click"); await sleep();
  ok("Pause sends exactly {action,id}", JSON.stringify(posts.at(-1)) === JSON.stringify({ action: "pause", id: "w" }));
  control("resume-p")._fire("click"); await sleep();
  control("check-w")._fire("click"); await sleep();
  ok("Resume and Check now send their actions", posts.slice(-2).map((p) => p.action + ":" + p.id).join() === "resume:p,check:w");
  const box = control("resume-session-e"); box.checked = true; box._fire("change"); await sleep();
  ok("resume-stopped-session opt-in uses configure", JSON.stringify(posts.at(-1)) === JSON.stringify({ action: "configure", id: "e", resumeSession: true }), posts.at(-1));

  const before = posts.length;
  control("remove-w")._fire("click"); await sleep();
  ok("Delete asks inline first", /Delete this monitor\?/.test(rowText("w")) && posts.length === before);
  control("cancel-w")._fire("click"); await sleep();
  ok("Cancel sends nothing and closes the confirmation", posts.length === before && !/Delete this monitor\?/.test(rowText("w")));
  control("remove-w")._fire("click"); await sleep(); control("confirm-w")._fire("click"); await sleep();
  ok("confirmed Delete sends remove", JSON.stringify(posts.at(-1)) === JSON.stringify({ action: "remove", id: "w" }));
  control("acknowledge-u")._fire("click"); await sleep();
  ok("Clear pending warns the text may already be there", /Text may already be in the session\. Clear this pending finding without sending it again\?/.test(rowText("u")) && posts.at(-1).action === "remove");
  control("confirm-u")._fire("click"); await sleep();
  ok("confirmed Clear pending sends acknowledge", JSON.stringify(posts.at(-1)) === JSON.stringify({ action: "acknowledge", id: "u" }));

  postReply = { status: 409, body: { error: "Monitor is checking." } };
  control("pause-e")._fire("click"); await sleep();
  ok("a refused action is shown and the snapshot kept", notice().textContent === "Monitor is checking." && !notice().hidden && rows().length === monitors.length, [notice().textContent, notice().hidden, control("pause-e")?.disabled, rows().length]);
  postReply = null;

  monitors = monitors.map((m) => m.id === "w" ? { ...m, state: "waiting", message: "You’re typing in this session." } : m);
  store.applyEvent({ type: "monitors.updated", monitors });
  ok("a broadcast while open re-renders", /You’re typing in this session/.test(rowText("w")));
  store.applyEvent({ type: "monitors.updated", monitors, error: "EACCES monitors.json" });
  ok("storage error is shown, nothing hidden", /can’t be read or saved: EACCES monitors\.json Nothing was reset\./.test(notice().textContent) && rows().length === monitors.length);
  ok("storage error also lights the header dot", trigger.classList.contains("mon-alert"));

  // A slow POST reply must not roll back a newer broadcast.
  const slowPost = globalThis.fetch; let releasePost;
  globalThis.fetch = (url, init = {}) => init.method ? new Promise((r) => { releasePost = () => r({ ok: true, status: 200, json: async () => ({ monitors: monitors.map((m) => m.id === "e" ? { ...m, name: "Stale reply" } : m) }) }); }) : slowPost(url, init);
  control("pause-e")._fire("click"); await sleep();
  store.applyEvent({ type: "monitors.updated", monitors: monitors.map((m) => m.id === "e" ? { ...m, name: "Fresh broadcast" } : m) }); await sleep();
  releasePost(); await sleep();
  ok("a late POST reply never overwrites a newer broadcast", rows().some((r) => /Fresh broadcast/.test(r.textContent)) && !rows().some((r) => /Stale reply/.test(r.textContent)));
  globalThis.fetch = slowPost;
  store.applyEvent({ type: "monitors.updated", monitors }); await sleep();

  // Disconnect: rows stay visible but every control freezes until the engine's snapshot arrives again.
  const sentBefore = posts.length;
  store.setConnected(false); await sleep();
  const offline = all().find((n) => n.classList?.contains("mon-offline"));
  ok("disconnect shows a reconnecting note and keeps the rows", offline && !offline.hidden && /Reconnecting/.test(offline.textContent) && rows().length === monitors.length);
  ok("disconnect freezes every action", ["check-w", "pause-w", "remove-w", "acknowledge-u"].every((c) => control(c).disabled));
  control("pause-w")._fire("click"); await sleep();
  ok("a frozen control sends nothing", posts.length === sentBefore);
  holdGet = {}; store.setConnected(true); await sleep();
  store.applyEvent({ type: "monitors.updated", monitors: monitors.map((m) => m.id === "w" ? { ...m, name: "After reconnect" } : m) }); await sleep();
  const reconnectGet = holdGet; holdGet = null; reconnectGet.release(); await sleep();
  ok("reconnect snapshot unfreezes; the GET sent before it does not roll it back", !control("pause-w").disabled && offline.hidden && rows().some((r) => /After reconnect/.test(r.textContent)));
  store.reset(); await sleep();
  ok("store reset (engine restart) freezes again", control("pause-w")?.disabled === true && !offline.hidden);
  store.setConnected(true); store.applyEvent({ type: "monitors.updated", monitors }); await sleep();

  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} }); await sleep();
  ok("Escape closes", !all().some((n) => n.classList?.contains("mon-dialog")));
  store.applyEvent({ type: "monitors.updated", monitors });   // must not touch a closed window

  // Fresh open: a broadcast that lands while GET is in flight wins over the older GET reply.
  holdGet = {}; trigger._fire("click"); await sleep();
  const newer = monitors.map((m) => m.id === "w" ? { ...m, name: "Newest name" } : m);
  store.applyEvent({ type: "monitors.updated", monitors: newer });
  holdGet.release(); holdGet = null; await sleep();
  ok("an older GET reply never overwrites a newer broadcast", rows().some((r) => /Newest name/.test(r.textContent)));
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} }); await sleep();

  store.reset();
  getReply = { status: 200, body: { monitors: [] } }; trigger._fire("click"); await sleep();
  ok("empty state suggests asking an agent", /No monitors yet\. Ask an agent to watch something for you/.test(stateText()));
  dom.docFire("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} }); await sleep();
  getReply = { status: 404, body: {} }; trigger._fire("click"); await sleep();
  ok("older engine: restart guidance with Try again, sessions unchanged", /Restart the CliDeck engine/.test(stateText()) && /Try again/.test(stateText()));
  ok("no header dot without a snapshot", !trigger.classList.contains("mon-alert"));
} catch (error) { fail++; console.log("THREW", error?.stack || error); }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

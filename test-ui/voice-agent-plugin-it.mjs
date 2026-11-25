// UI IT — Voice Agent plugin (plugin-packages/voice-agent): the client Worker's entry points against a fake host
// API, and the calls page against a fake parent frame bridge. Server answers follow the contract:
//   'request' {requestId, action:'status'}         → 'result' {requestId, ok, setup:{ready,missing}, calls:[…]}
//   'request' {requestId, action:'status', callId} → 'result' {requestId, ok, call:{…summary, transcript, delegations, usageSeconds,
//                                                    finalized, updateDelivery, truncated}}  (the shape server.js/calls.js send)
//   'request' {requestId, action:'stop', callId}   → 'result' {requestId, ok, call}
//   'updated' {callId} broadcasts only; the page asks again. No media, no dialing, no network.
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));

try {
  // Browser Worker lifecycle is covered in test/voice-client.test.mjs.
  // ═════ Calls page ═════
  const root = document.createElement("main"); root.id = "root"; document.body.appendChild(root);
  const liveRegion = document.createElement("div"); liveRegion.id = "live"; document.body.appendChild(liveRegion);
  // Long timers (polls, request deadlines) are held for the test to fire; short ones run for real.
  const timers = new Map(); let nextTimer = 1e6;
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { if (ms >= 1000) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; } return realSet(fn, ms, ...rest); };
  globalThis.clearTimeout = (id) => { if (timers.has(id)) timers.delete(id); else realClear(id); };
  const held = (ms) => [...timers.values()].filter((t) => t.ms === ms).length;
  const fireTimers = (ms) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };

  const now = Date.now();
  let setup = { ready: false, missing: ["openai-key", "sip-url", "twilio-account-sid"], errors: ["Caller number must include its country code (+ followed by digits)."] };
  let calls = [
    { id: "c-old", sessionId: "s9", destination: "+1 415 555 0100", state: "completed", createdAt: new Date(now - 3600e3).toISOString(), error: "" },
    { id: "c-live", sessionId: "s1", destination: "+1 415 555 0142", state: "active", createdAt: new Date(now - 120e3).toISOString(), error: "" },
    { id: "c-new", sessionId: "s9", destination: "+44 20 7946 0000", state: "failed", createdAt: now - 30e3, error: "The carrier rejected the number." },
  ];
  // Transcript entries are streaming fragments, as calls.js pushes them.
  const details = {
    "c-live": { transcript: [
        { speaker: "assistant", text: "Hi, this is the assistant", startMs: 1200, endMs: 2400 }, { speaker: "assistant", text: " calling about the deploy.", startMs: 2400, endMs: 4000 },
        { speaker: "caller", text: "Sure,", startMs: 4600, endMs: 5000 }, { speaker: "caller", text: " go ahead.", startMs: 5000, endMs: 5600 }],
      delegations: [{ id: "d1", state: "answered" }, { id: "d2", state: "superseded" }, { id: "d3", state: "pending" }], usageSeconds: 65, finalized: false, updateDelivery: "sent", truncated: false },
    "c-old": { transcript: [], delegations: [], usageSeconds: 0, finalized: true },
    "c-new": { transcript: [], delegations: [], usageSeconds: 0, finalized: true },
  };
  let hold = null, stopReply = null;
  const server = (data) => {
    if (data.action === "stop") return stopReply ? stopReply(data) : { ok: true, call: { ...calls.find((c) => c.id === data.callId), state: "ending" } };
    if (data.callId) return { ok: true, call: { ...calls.find((c) => c.id === data.callId), ...details[data.callId] } };
    return { ok: true, setup, calls };
  };
  const answer = (data, r = server(data)) => dom.winFire("message", { source: parent, data: { type: "clideck.message", data: { event: "result", data: { requestId: data.requestId, ...r } } } });
  const posts = [];
  const parent = { postMessage: (m) => { posts.push(m); if (m.type === "clideck.send") { if (hold) hold.push(m.data); else setTimeout(() => answer(m.data), 1); } } };
  globalThis.parent = parent;
  new Function(readFileSync(new URL("../plugin-packages/voice-agent/public/app.js", import.meta.url), "utf8"))();
  const all = () => document.body._walk();
  const control = (name) => all().find((n) => n.dataset?.control === name);
  const row = (id) => all().find((n) => n.dataset?.call === id && n.classList?.contains("va-call"));
  const text = () => root.textContent;
  const requests = () => posts.filter((m) => m.type === "clideck.send").map((m) => m.data);
  const chipsIn = (node) => node._walk().filter((n) => n.classList?.contains("plg-status")).map((n) => n.textContent);
  const msg = (type, data) => dom.winFire("message", { source: parent, data: { type, data } });
  const updated = (callId) => msg("clideck.message", { event: "updated", data: { callId } });

  ok("page: says ready to the host", posts[0]?.type === "clideck.ready");
  dom.winFire("message", { source: {}, data: { type: "clideck.init", data: { theme: "light", visible: true } } });
  ok("page: ignores messages that are not from its parent", requests().length === 0);

  msg("clideck.init", { context: { surface: "workspace", sessionId: "s1" }, theme: "light", visible: true });
  await sleep(20);
  ok("page: applies the host theme", document.documentElement.getAttribute("data-theme") === "light");
  ok("page: first asks for status without a call, then the chosen call", requests()[0]?.action === "status" && !requests()[0].callId && requests().some((r) => r.action === "status" && r.callId === "c-live"));
  ok("page: every request carries its own request ID", new Set(requests().map((r) => r.requestId)).size === requests().length && requests().every((r) => /^va-p-/.test(r.requestId)));

  // Setup still needed: where to go, which fields, no secrets and no dial UI here.
  ok("setup: header says Setup needed", chipsIn(root.querySelector(".va-head"))[0] === "Setup needed");
  ok("setup: points to Settings → Plugins → Voice Agent", /Settings → Plugins → Voice Agent/.test(text()) && /secrets are entered there, not on this page/.test(text()));
  ok("setup: missing keys use the Settings labels, unknown keys read as plain names", /OpenAI API key/.test(text()) && /Phone provider address/.test(text()) && /Twilio account SID/.test(text()) && !/openai-key|sip-url/.test(text()));
  ok("setup: the server's setup errors are shown as written", /Caller number must include its country code/.test(text()));
  ok("page: no start/dial controls yet", !/\bDial\b|Start a call|New call|Call now/i.test(text()) && !control("dial") && !control("start"));

  // List: newest first, this session's live call chosen by default.
  const order = all().filter((n) => n.classList?.contains("va-call")).map((n) => n.dataset.call);
  ok("list: newest call first", order.join() === "c-new,c-live,c-old", order);
  ok("list: a live call from this session is selected by default", row("c-live").getAttribute("aria-pressed") === "true" && row("c-new").getAttribute("aria-pressed") === "false");
  ok("list: rows show plain states and mark this session", chipsIn(row("c-live"))[0] === "Connected" && chipsIn(row("c-new"))[0] === "Failed" && chipsIn(row("c-old"))[0] === "Ended" && /This session/.test(row("c-live").textContent) && !/This session/.test(row("c-new").textContent));

  // Selected call: transcript, handoffs, call time, Hang up.
  const detail = () => root.querySelector("[data-detail]");
  const lines = () => all().filter((n) => n.classList?.contains("va-line")).map((n) => n.textContent);
  ok("detail: streaming fragments read as one turn per speaker, timed from its start", lines().length === 2 && lines()[0] === "Assistant0:01Hi, this is the assistant calling about the deploy." && lines()[1] === "Person0:05Sure, go ahead.", lines());
  ok("detail: call updates and the session's questions, in plain words", /Sent to the session/.test(detail().textContent) && /Call updatesDelivered/.test(detail().textContent) && /Question 1Answered/.test(detail().textContent) && /Question 2Replaced by a newer question/.test(detail().textContent) && /Question 3Waiting for an answer/.test(detail().textContent));
  ok("detail: call time from usageSeconds", /1:05 call time/.test(detail().textContent));
  ok("detail: Hang up offered while the call is live", control("hangup")?.disabled === false && /Hang up/.test(control("hangup").textContent));
  ok("page: says closing the tab doesn't end a call; no socket talk", /Closing this tab doesn’t end a call/.test(text()) && !/socket|websocket|disconnect.*ends/i.test(text()));
  ok("poll: visible + live → selected call every 1.5 s and the list every 4 s", held(1500) === 1 && held(4000) === 1);

  // Hang up: explicit stop, honest progress, the server decides when it ended.
  hold = [];
  control("hangup")._fire("click");
  const stopReq = hold.find((r) => r.action === "stop");
  ok("hang up: sends stop with the call ID", !!stopReq && stopReq.callId === "c-live");
  ok("hang up: shows progress and can't be pressed twice", control("hangup").disabled === true && /Hanging up…/.test(control("hangup").textContent));
  control("hangup")._fire("click");
  ok("hang up: a second press sends nothing", hold.filter((r) => r.action === "stop").length === 1);
  calls = calls.map((c) => (c.id === "c-live" ? { ...c, state: "stopping" } : c));
  const queued = hold; hold = null;
  for (const r of queued) answer(r);
  await sleep(20);
  ok("hang up: 'stopping' from the server keeps the call open, button says Ending…", control("hangup")?.disabled === true && /Ending…/.test(control("hangup").textContent) && chipsIn(detail())[0] === "Ending");
  // calls.js can end a call without final usage (state 'ended', finalized false): still over, not live.
  calls = calls.map((c) => (c.id === "c-live" ? { ...c, state: "ended" } : c));
  details["c-live"] = { ...details["c-live"], finalized: false, usageSeconds: 71 };
  updated("c-live"); await sleep(20);
  ok("hang up: only the server's 'ended' drops Hang up and shows Ended", !control("hangup") && chipsIn(detail())[0] === "Ended" && /1:11 call time/.test(detail().textContent));
  ok("poll: an ended call is no longer polled even before usage is final; the list still is", held(1500) === 0 && held(4000) === 1);
  ok("a11y: the state change is announced", /Ended/.test(liveRegion.textContent));

  // A failed Hang up is shown, and the button comes back.
  calls = calls.map((c) => (c.id === "c-live" ? { ...c, state: "uncertain", error: "Hangup was not confirmed." } : c));
  updated("c-live"); await sleep(20);
  stopReply = () => ({ ok: false, error: "The phone provider refused the request." });
  control("hangup")._fire("click"); await sleep(20);
  ok("uncertain: shown as Not confirmed with the server's error; Hang up still offered", chipsIn(detail())[0] === "Not confirmed" && /Hangup was not confirmed\./.test(detail().textContent));
  ok("hang up: an error is shown and Hang up is offered again", /Couldn’t hang up: The phone provider refused the request\./.test(detail().textContent) && control("hangup")?.disabled === false);
  stopReply = null;

  // Picking another call.
  const before = requests().length;
  row("c-new")._fire("click"); await sleep(20);
  ok("pick: the picked row is selected and its status requested", row("c-new").getAttribute("aria-pressed") === "true" && requests().slice(before).some((r) => r.action === "status" && r.callId === "c-new"));
  ok("pick: a failed call shows its error, says nothing was said, no Hang up", /The carrier rejected the number\./.test(detail().textContent) && /Nothing was said on this call/.test(detail().textContent) && !control("hangup"));
  calls = [...calls, { id: "c-newer", sessionId: "s1", destination: "+1 212 555 0199", state: "ringing", createdAt: now, error: "" }];
  details["c-newer"] = { transcript: [], delegations: [], usageSeconds: 0, finalized: false };
  updated("c-newer"); await sleep(20);
  ok("pick: a row the person picked stays selected when a new call arrives", row("c-new").getAttribute("aria-pressed") === "true" && chipsIn(row("c-newer"))[0] === "Ringing");

  // Request ID matching and errors.
  const shown = text();
  msg("clideck.message", { event: "result", data: { requestId: "someone-else-1", ok: true, setup: { ready: true, missing: [] }, calls: [] } });
  await sleep(5);
  ok("bridge: a reply for another page's request is ignored", text() === shown);
  setup = { ready: true, missing: [] };
  const realServer = server;
  hold = [];
  updated("x");
  const listReq = hold.find((r) => r.action === "status" && !r.callId);
  hold = null;
  answer(listReq, { ok: false, error: "Voice Agent is restarting." }); await sleep(20);
  ok("bridge: ok:false shows the server's message and keeps the last list", /Voice Agent is restarting\./.test(text()) && !!row("c-old"));
  fireTimers(4000); await sleep(20);
  ok("setup: ready → header Ready and the setup card is gone", chipsIn(root.querySelector(".va-head"))[0] === "Ready" && !/Finish setup/.test(text()) && !/Voice Agent is restarting/.test(text()));
  void realServer;

  // Visibility: no polling or refreshing while hidden; refresh at once when shown again.
  msg("clideck.visible", { visible: false });
  ok("visible: hidden → poll timers cleared", held(1500) === 0 && held(4000) === 0);
  const hiddenAt = requests().length;
  updated("c-live"); await sleep(20);
  ok("visible: hidden → broadcasts don't trigger requests", requests().length === hiddenAt);
  msg("clideck.visible", { visible: true }); await sleep(20);
  ok("visible: shown again → list and selected call refresh immediately", requests().slice(hiddenAt).some((r) => r.action === "status" && !r.callId) && requests().slice(hiddenAt).some((r) => r.callId === "c-new"));

  // Empty state.
  calls = []; setup = { ready: true, missing: [] };
  fireTimers(4000); await sleep(20);
  ok("empty: no calls yet, no Hang up, no tab hint", /No calls yet\. Calls placed by agents appear here\./.test(text()) && !control("hangup") && !/Closing this tab/.test(text()));

  // A request that never gets an answer.
  hold = [];
  fireTimers(4000);
  ok("bridge: each request has a 15 s answer deadline", held(15000) >= 1);
  fireTimers(15000); hold = null; await sleep(20);
  ok("bridge: no answer → says so without guessing why", /Voice Agent didn’t answer\. Check that CliDeck is connected/.test(text()));
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

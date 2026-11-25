// UI IT — stale-UI notice. Drives the real ui-version.js with a fake /api/ui-version: only a real, different
// build offers Refresh; failures never do; dismiss/new-build/back-to-loaded/restart-required/engine-install and
// disconnect rules hold; Refresh reloads the tab and nothing else.
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
let meta = "build-a";
const realQuery = document.querySelector;
document.querySelector = (sel) => sel === 'meta[name="clideck-ui-version"]' ? (meta == null ? null : { getAttribute: () => meta }) : realQuery(sel);
document.visibilityState = "visible";
let reloads = 0;
globalThis.location = { reload: () => { reloads++; } };

let reply = { version: "build-a", restartRequired: false }, fetches = 0, hold = null;
const respond = (r) => r instanceof Error ? Promise.reject(r) : Promise.resolve({ ok: r.status ? r.status < 400 : true, json: async () => { if (r.bad) throw new SyntaxError("bad"); return r.body ?? r; } });
globalThis.fetch = (url, init) => {
  fetches++;
  if (url !== "/api/ui-version" || init?.cache !== "no-store") throw new Error("unexpected fetch " + url);
  if (hold) return new Promise((resolve, reject) => { const h = hold; hold = null; h.resolve = resolve; h.signal = init.signal; if (!h.ignoreAbort) init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
  return respond(reply);
};

const { store } = await import("../public/js/store.js");
// An older engine stamps no meta tag: that page instance never listens or fetches at all.
meta = null;
(await import("../public/js/ui/ui-version.js?older-engine")).initUiVersion();
meta = "build-a";
const { initUiVersion } = await import("../public/js/ui/ui-version.js");

let pass = 0, fail = 0;
const ok = (name, condition, detail) => { if (condition) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const notice = () => document.getElementById("toast-ui-refresh");
const reconnect = async () => { store.setConnected(false); store.setConnected(true); await sleep(); };
const focus = async () => { await sleep(110); dom.winFire("focus"); await sleep(); };   // past the event throttle

try {
  store.setConnected(true); await sleep();
  ok("older engine (no meta tag): the feature stays off", fetches === 0);
  store.setConnected(false);
  initUiVersion({ everyMs: 60, gapMs: 100, timeoutMs: 200 });
  ok("no check before the engine is connected", fetches === 0);
  store.setConnected(true); await sleep();
  ok("connecting checks once; same build shows nothing", fetches === 1 && !notice());
  dom.winFire("focus"); await sleep();
  ok("focus right after a check is throttled", fetches === 1);

  for (const [name, value] of [["404 (older engine)", { status: 404 }], ["network failure", new Error("offline")], ["malformed JSON", { bad: true }],
    ["missing version", { restartRequired: false }], ["non-string version", { version: 42 }], ["empty version", { version: "  " }], ["oversized version", { version: "x".repeat(201) }]]) {
    reply = value; await focus();
    ok(name + " is never read as an update", !notice());
  }

  reply = { version: "build-b", restartRequired: false }; await focus();
  const card = notice();
  ok("a different build shows the sticky notice with the exact copy", card && card.textContent.includes("Updated CliDeck is ready") && card.textContent.includes("Refresh to load it. Your sessions keep running."));
  const buttons = card ? card.querySelectorAll(".toast-act") : [];
  ok("it offers Refresh and Dismiss, nothing else", buttons.length === 2 && buttons[0].textContent === "Refresh" && buttons[1].textContent === "Dismiss");
  ok("it never reloads on its own", reloads === 0);
  await focus();
  ok("the same build does not stack a second notice", document.querySelectorAll(".toast").filter((t) => t.id === "toast-ui-refresh").length === 1);

  buttons[0]._fire("click");
  ok("Refresh reloads this tab only", reloads === 1 && fetches > 0);

  reply = { version: "build-c", restartRequired: false }; await focus(); await sleep(320);
  notice().querySelectorAll(".toast-act")[1]._fire("click"); await sleep(320);
  await focus();
  ok("a dismissed build stays dismissed for the page's lifetime", !notice());
  reply = { version: "build-d", restartRequired: false }; await focus();
  ok("a newer build notifies again", !!notice());
  reply = { version: "build-c", restartRequired: false }; await focus(); await sleep(320);
  ok("disk returning to a dismissed build removes the notice for the newer one", !notice());
  reply = { version: "build-d", restartRequired: false }; await focus();
  store.setConnected(false); await sleep(320);
  ok("disconnect hides the notice (Refresh would hit an unreachable engine)", !notice());
  store.setConnected(true); await sleep();
  ok("reconnect restores an undismissed notice", !!notice());
  reply = { version: "build-a", restartRequired: false }; await focus(); await sleep(320);
  ok("disk back to the loaded build removes the notice", !notice());

  reply = { version: "build-e", restartRequired: true }; await focus();
  ok("restartRequired (new package under the old engine) never offers Refresh", !notice());

  store.applyEvent({ type: "engine.update", state: "installing" });
  reply = { version: "build-f", restartRequired: false }; await focus();
  ok("no notice while the engine is installing an update", !notice());
  store.applyEvent({ type: "engine.update", state: "installed" }); await focus();
  ok("…or installed and waiting for restart", !notice());
  const before = fetches;
  store.applyEvent({ type: "engine.update", state: "current" }); await sleep();
  ok("leaving installing/installed checks immediately", fetches === before + 1 && !!notice());

  reply = { version: "build-a", restartRequired: false }; await focus(); await sleep(320);
  hold = { ignoreAbort: true }; const held = hold; reply = { version: "build-g", restartRequired: false };
  await focus();
  store.setConnected(false); await sleep();
  held.resolve({ ok: true, json: async () => ({ version: "build-g" }) }); await sleep();
  ok("a reply that arrives after a disconnect is ignored", !notice());
  store.setConnected(true); await sleep();
  ok("reconnecting asks again and acts on the fresh reply", !!notice());

  reply = { version: "build-a", restartRequired: false }; await reconnect(); await sleep(320);
  hold = {}; const slow = hold; const c0 = fetches;
  await focus();
  for (const state of ["installing", "current", "installing", "current"]) store.applyEvent({ type: "engine.update", state });   // forced checks
  await sleep();
  ok("only one check is ever in flight", fetches === c0 + 1, fetches - c0);
  await sleep(220);
  ok("a stuck check is aborted by its deadline", slow.signal?.aborted === true);

  const c1 = fetches; document.visibilityState = "hidden"; dom.docFire("visibilitychange"); await sleep(150);
  ok("hidden tab: no slow-timer checks", fetches === c1);
  await focus();
  ok("hidden tab: focus does not check either", fetches === c1);
  document.visibilityState = "visible"; dom.docFire("visibilitychange"); await sleep();
  ok("returning to the tab checks", fetches === c1 + 1);
  await sleep(150);
  ok("while visible a slow timer keeps checking", fetches >= c1 + 2);
  store.setConnected(false); const c2 = fetches; await sleep(150);
  ok("disconnected: the timer stops", fetches === c2);
} catch (error) { fail++; console.log("THREW", error?.stack || error); }

console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

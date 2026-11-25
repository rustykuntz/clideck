// A preview that genuinely failed to draw is reported ONCE to the engine (content.renderFailed) so the agent
// that showed it hears about it. Never after close/replace; offline failures wait for the same content to be
// re-sent after reconnect. What the person sees is unchanged. Fake DOM + fake socket + stubbed fetch.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();
const main = document.createElement("div"); main.className = "main"; document.body.appendChild(main);
const mk = (id, cls) => { const e = document.createElement("div"); e.id = id; if (cls) e.className = cls; main.appendChild(e); return e; };
mk("pane-tabs", "pane-tabs"); const paneBody = mk("pane-body", "pane-body");
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; paneBody.appendChild(termPanel);

const later = {};
const PAYLOADS = {
  "/content/json-bad": { text: "{ nope" },
  "/content/json-ok": { text: "{\"a\":1}" },
  "/content/chart-500": { status: 500 },
  "/content/chart-empty": { json: { type: "bar", series: [] } },
  "/content/chart-ok": { json: { type: "bar", series: [{ name: "s", values: [1, 2] }] } },
  "/content/mmd": { text: "graph TD\n  A-->" },
  "/content/replayed": { text: "{ broken" },
  "/content/offline": { text: "{ broken" },
  "/content/offline-gone": { text: "{ broken" },
  "/content/other": { text: "{ broken" },
};
globalThis.fetch = (url) => {
  if (later[url]) return later[url].promise;
  const p = PAYLOADS[url] || { text: "" };
  return Promise.resolve({ ok: !p.status, status: p.status || 200, text: () => Promise.resolve(p.text || ""), json: () => Promise.resolve(p.json || {}) });
};
const deferred = (url) => { let resolve; const promise = new Promise((r) => { resolve = r; }); later[url] = { promise, resolve }; return later[url]; };
window.mermaid = { render: () => Promise.reject(new Error("Parse error on line 2")) };

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const show = (o) => store.applyEvent({ type: "content.show", sessionId: "A", reportErrors: true, ...o });
const reports = (id) => ws.sent.filter((m) => m && m.type === "content.renderFailed" && (!id || m.contentId === id));

try {
  connectWs(); await flush();
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  initContentViewer(); await flush();
  ok("connected", store.connected);

  show({ contentId: "json-ok", kind: "json", name: "ok.json", url: "/content/json-ok" });
  show({ contentId: "chart-ok", kind: "chart", name: "ok", url: "/content/chart-ok" }); await flush();
  ok("content that draws reports nothing", reports().length === 0);

  show({ contentId: "json-bad", kind: "json", name: "bad.json", url: "/content/json-bad" }); await flush();
  const json = reports("json-bad");
  ok("invalid JSON is reported once with the parse error", json.length === 1 && json[0].sessionId === "A" && /isn’t valid JSON: /.test(json[0].message));
  ok("the person still sees the existing invalid-JSON notice", !!document.querySelector("#pane-body .ct-json-error"));

  show({ contentId: "chart-500", kind: "chart", name: "c", url: "/content/chart-500" }); await flush();
  ok("a load failure is reported with its HTTP status", reports("chart-500")[0]?.message === "Couldn't load this chart preview: HTTP 500");
  ok("and the existing error stays on screen", /Couldn't load this content — HTTP 500/.test(document.querySelector("#pane-body .cd-error")?.textContent || ""));

  show({ contentId: "chart-empty", kind: "chart", name: "c", url: "/content/chart-empty" }); await flush();
  ok("a chart with nothing to draw is reported", reports("chart-empty")[0]?.message === "The chart has no series with values to draw.");

  show({ contentId: "mmd", kind: "mermaid", name: "d", url: "/content/mmd" }); await flush();
  ok("a Mermaid render error is reported", reports("mmd")[0]?.message === "Mermaid couldn’t draw this diagram: Parse error on line 2");
  ok("and the diagram source is still shown", /A-->/.test(document.querySelector("#pane-body .ct-mermaid-src")?.textContent || ""));

  show({ contentId: "img", kind: "image", name: "shot.png", url: "/content/img" }); await flush();
  const img = document.querySelector("#pane-body .cd-media img");
  img._fire("error"); img._fire("error"); await flush();
  ok("a broken image is reported once per content id", reports("img").length === 1 && reports("img")[0].message === "The image couldn't be loaded or decoded.");

  show({ contentId: "vid", kind: "video", name: "clip.mp4", url: "/content/vid" }); await flush();
  document.querySelector("#pane-body .cd-media video")._fire("error"); await flush();
  ok("a broken video is reported", reports("vid")[0]?.message === "The video couldn't be loaded or decoded.");

  show({ contentId: "plug", kind: "acme/board", name: "b", url: "/content/plug" }); await flush();
  ok("a plugin kind nothing can draw is reported", /No installed, enabled plugin can draw acme\/board/.test(reports("plug")[0]?.message || ""));

  show({ contentId: "replayed", kind: "json", name: "r", url: "/content/replayed", replay: true }); await flush();
  ok("a failure found while drawing a replayed frame is reported once", reports("replayed").length === 1);

  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
  store.applyEvent({ type: "content.show", sessionId: "B", reportErrors: true, contentId: "other", kind: "json", name: "o", url: "/content/other" }); await flush();
  ok("content for a session not on screen is not drawn, so nothing yet", reports("other").length === 0);
  store.select("B"); await flush();
  ok("switching to that session lands on its terminal, so still nothing", reports("other").length === 0);
  [...document.querySelectorAll(".cd-tab")].find((t) => t.dataset.itemId === "other")._fire("click"); await flush();
  ok("it reports when the person opens that document", reports("other").length === 1 && reports("other")[0].sessionId === "B");
  store.select("A"); await flush();

  const slow = deferred("/content/slow");
  show({ contentId: "slow", kind: "chart", name: "s", url: "/content/slow" }); await flush();
  show({ contentId: "fresh", kind: "chart", name: "s", url: "/content/chart-ok", replaces: "slow" }); await flush();
  slow.resolve({ ok: false, status: 404 }); await flush();
  ok("a late failure after the tab was replaced is not reported", reports("slow").length === 0 && reports("fresh").length === 0);

  const gone = deferred("/content/gone");
  show({ contentId: "gone", kind: "chart", name: "g", url: "/content/gone" }); await flush();
  store.applyEvent({ type: "content.closed", sessionId: "A", contentId: "gone" }); await flush();
  gone.resolve({ ok: false, status: 404 }); await flush();
  ok("a late failure after the tab was closed is not reported", reports("gone").length === 0);

  store.setConnected(false);
  show({ contentId: "offline-gone", kind: "json", name: "g", url: "/content/offline-gone" }); await flush();
  show({ contentId: "offline", kind: "json", name: "o", url: "/content/offline" }); await flush();
  ok("offline: nothing is sent", reports("offline").length === 0 && reports("offline-gone").length === 0);
  // Reconnect the way ws.js does: reset, connected, then the engine replays what is still current.
  store.reset(); store.setConnected(true);
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
  store.select("B"); await flush();               // A not on screen: delivery must not depend on redrawing
  ok("(A is not on screen)", store.activeId === "B");
  show({ contentId: "offline", kind: "json", name: "o", url: "/content/offline", replay: true }); await flush();
  ok("an offline failure is sent once when that same content is replayed", reports("offline").length === 1);
  ok("one that is no longer current is never sent", reports("offline-gone").length === 0);

  // Offline failure, then the replay comes from an engine without the capability: dropped, never sent.
  store.select("A"); await flush();
  store.setConnected(false);
  show({ contentId: "offline-old", kind: "json", name: "x", url: "/content/offline-gone" }); await flush();
  store.reset(); store.setConnected(true);
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  show({ contentId: "offline-old", kind: "json", name: "x", url: "/content/offline-gone", replay: true, reportErrors: undefined }); await flush();
  ok("a replay without reportErrors drops the waiting failure", reports("offline-old").length === 0);

  // Legacy engine / user-opened content: no flag → a failed preview sends nothing, connection stays up.
  const before = ws.sent.length;
  for (const [id, kind, url] of [["legacy-json", "json", "/content/json-bad"], ["legacy-chart", "chart", "/content/chart-500"], ["legacy-mmd", "mermaid", "/content/mmd"], ["legacy-plug", "acme/board", "/content/x"]]) {
    show({ contentId: id, kind, name: id, url, reportErrors: undefined }); await flush();
  }
  show({ contentId: "legacy-img", kind: "image", name: "i", url: "/content/i", reportErrors: false }); await flush();
  document.querySelector("#pane-body .cd-media img")._fire("error"); await flush();
  ok("without reportErrors no failure is ever sent", ws.sent.slice(before).every((m) => m.type !== "content.renderFailed"));
  ok("and the connection stays up", store.connected);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);

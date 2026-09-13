// Integration test — the content SURFACES (one tab per asset + the content dock). Drives the ACTUAL store +
// content-viewer + content-dock against the committed fake DOM, with a stubbed fetch for the dock's text/JSON
// kinds. Covers: EVERY renderable kind opening as a tab (images included — the glance lightbox is retired and
// its absence is asserted, because an asset with no tab is an asset the user cannot close); dock tabs +
// fetch-rendered bodies; replace-in-place; tab switch/close; other-session toast; per-session isolation.
import { installFakeDom } from "./fakedom.mjs";
const dom = installFakeDom();
// Content now opens as TABS IN THE MAIN PANE (VS Code model), so the mounts are the pane's strip + body, and
// the terminal is a permanent first tab that is hidden rather than unmounted.
const main = document.createElement("div"); main.className = "main"; document.body.appendChild(main);
const mk = (id, cls) => { const e = document.createElement("div"); e.id = id; if (cls) e.className = cls; main.appendChild(e); return e; };
const paneTabs = mk("pane-tabs", "pane-tabs"); const paneBody = mk("pane-body", "pane-body");
const termPanel = document.createElement("div"); termPanel.id = "term-panel"; paneBody.appendChild(termPanel);

// stubbed fetch: map url → payload; returns a Response-like with text()/json()
const PAYLOADS = {
  "/content/md1": { text: "# Hello\n\nsome **markdown**" },
  "/content/md2": { text: "# Updated\n\nreplaced body" },
  "/content/diff1": { text: "@@ -1 +1 @@\n-old\n+new" },
  "/content/chart1": { json: { type: "bar", series: [{ name: "s", values: [1, 2, 3] }] } },
  "/content/tr1": { json: { passed: 2, failed: 1, tests: [{ name: "x", status: "fail", message: "boom" }] } },
};
globalThis.fetch = (url) => { const p = PAYLOADS[url] || { text: "" }; return Promise.resolve({ text: () => Promise.resolve(p.text || ""), json: () => Promise.resolve(p.json || {}) }); };

const { store } = await import("../public/js/store.js");
const { initContentViewer } = await import("../public/js/ui/content-viewer.js");
const { __pendingClosesForTest } = await import("../public/js/ui/content-dock.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
// the strip is absent until a document is open; the Terminal tab is not a document tab
const dockVisible = () => !paneTabs.hidden;
const tabs = () => [...document.querySelectorAll(".cd-tab")].filter((t) => !t.className.includes("cd-tab-term"));
const termTabShown = () => !!document.querySelector(".cd-tab-term");
const termVisible = () => !termPanel.hidden;
const show = (o) => store.applyEvent({ type: "content.show", ...o });

try {
  store.applyEvent({ type: "session.created", sessionId: "A", cwd: "/a", name: "alpha", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "B", cwd: "/b", name: "beta", live: true, pid: 2 });
  initContentViewer();
  ok("A is the active session", store.activeId === "A");
  ok("no documents → no tab strip, terminal fills the pane", !dockVisible() && termVisible());

  // ── a one-shot image is a TAB like everything else ──────────────────────────────────────────────────
  // It used to be a modal glance that sent no content.close, so dismissing it stranded the asset: the engine
  // still held it against the session's budget while the user had no tab, no control and no way back.
  show({ sessionId: "A", contentId: "img1", kind: "image", name: "shot.png", url: "/content/img1" });
  await flush();
  ok("a one-shot image opens a tab, not a modal", dockVisible() && tabs().length === 1
    && tabs()[0].querySelector(".cd-tab-name").textContent === "shot.png");
  ok("the glance lightbox is gone, not merely unused", !document.querySelector(".lb-overlay"));
  ok("and the image is rendered in the pane body", !!document.querySelector("#pane-body .cd-media img"));
  // Closing that tab is what releases the asset — the whole reason it is a tab.
  document.querySelector(".cd-tab .cd-tab-x")._fire("click", { target: document.querySelector(".cd-tab .cd-tab-x") });
  await flush();
  ok("closing the image tab tells the engine to drop the asset",
    __pendingClosesForTest("A").includes("img1"));
  ok("and leaves the bare terminal behind", !dockVisible() && termVisible());

  // ── markdown for active session → dock opens, tab + fetched body ──
  show({ sessionId: "A", contentId: "md1", kind: "markdown", name: "notes.md", url: "/content/md1" });
  await flush();
  ok("markdown → tab strip appears, with a Terminal tab beside it", dockVisible() && termTabShown());
  ok("dock has one tab named notes.md", tabs().length === 1 && tabs()[0].querySelector(".cd-tab-name").textContent === "notes.md");
  ok("dock body rendered the markdown (heading)", !!document.querySelector("#pane-body .md h1") && document.querySelector("#pane-body .md h1").textContent === "Hello");

  const copied = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: async (text) => { copied.push(text); } },
  } });
  const copy = document.querySelector(".md-copy");
  ok("Copy is beside the view switch, with a tooltip and accessible name",
    copy?.parentNode === document.querySelector(".md-bar") && copy.title === "Copy Markdown"
    && copy.getAttribute("aria-label") === "Copy Markdown");
  copy._fire("click"); await flush();
  ok("Rendered view copies the complete fetched Markdown", copied.at(-1) === PAYLOADS["/content/md1"].text);
  document.querySelectorAll(".md-seg button")[1]._fire("click");
  copy._fire("click"); await flush();
  ok("Source view copies the same Markdown", copied.length === 2 && copied.at(-1) === PAYLOADS["/content/md1"].text);
  document.querySelectorAll(".md-seg button")[0]._fire("click");

  // ── replace-in-place (screenshot-loop analog): same session+tab, swapped body ──
  show({ sessionId: "A", contentId: "md1b", kind: "markdown", name: "notes.md", url: "/content/md2", replaces: "md1" });
  await flush();
  ok("replace kept a single tab", tabs().length === 1);
  ok("replace swapped the body in place", document.querySelector("#pane-body .md h1").textContent === "Updated");
  const updatedCopy = document.querySelector(".md-copy");
  updatedCopy._fire("click"); await flush();
  ok("replacing the preview copies the new source", copied.at(-1) === PAYLOADS["/content/md2"].text);
  ok("successful copy confirms success", document.querySelector("#toast-markdown-copy").classList.contains("t-success"));
  navigator.clipboard.writeText = async () => { throw new Error("Clipboard blocked"); };
  document.execCommand = () => false;
  updatedCopy._fire("click"); await flush();
  ok("failed clipboard and fallback report an error and allow retry",
    document.querySelector("#toast-markdown-copy").classList.contains("t-error") && !updatedCopy.disabled);
  // Later checks assert there are no unrelated notifications.
  document.querySelector("#toast-markdown-copy").remove();

  // ── a second kind → second tab; switching tabs swaps the body ──
  show({ sessionId: "A", contentId: "chart1", kind: "chart", name: "bars", url: "/content/chart1" });
  await flush();
  ok("second content → two tabs", tabs().length === 2);
  ok("active tab is the chart (rect bars present)", document.querySelectorAll("#pane-body rect.chart-bar").length === 3);
  // click the first (markdown) tab
  tabs()[0]._fire("click");   // the Terminal tab is first now, so target the DOCUMENT tabs await flush();
  ok("clicking a tab switches the body back to markdown", !!document.querySelector("#pane-body .md"));

  // ── close a tab; closing the last hides the dock ──
  document.querySelectorAll(".cd-tab .cd-tab-x")[0]._fire("click", { target: document.querySelector(".cd-tab .cd-tab-x") }); await flush();
  ok("closing a tab leaves one", tabs().length === 1);
  document.querySelector(".cd-tab .cd-tab-x")._fire("click", { target: document.querySelector(".cd-tab .cd-tab-x") }); await flush();
  ok("closing the last document restores the bare terminal", !dockVisible() && tabs().length === 0 && termVisible());

  // ── replay restores another session quietly; genuinely new content still notifies ──
  show({ sessionId: "B", contentId: "diff1", kind: "diff", name: "restored.diff", url: "/content/diff1", replay: true });
  await flush();
  ok("replayed other-session content restores without a toast", !document.querySelector(".toast"));
  store.select("B"); await flush();
  ok("switching to B reveals quietly restored content", dockVisible() && !!document.querySelector("#pane-body .diff"));
  store.select("A"); await flush();

  // ── other-session rich content → recorded + toast, no dock steal; switching reveals it ──
  show({ sessionId: "B", contentId: "tr1", kind: "testresults", name: "suite", url: "/content/tr1" });
  await flush();
  ok("other-session content does NOT open a tab here (A active)", !dockVisible());
  ok("other-session content raised a toast", !!document.querySelector(".toast"));
  store.select("B"); await flush();
  ok("switching to B reveals its recorded content in the dock", dockVisible() && !!document.querySelector("#pane-body .tr"));
  ok("B's test-results rendered (FAILED verdict)", document.querySelector("#pane-body .tr-verdict.fail") && document.querySelector("#pane-body .tr-verdict").textContent === "FAILED");
  // A video for the OTHER session used to exist only as a toast — click it or lose it, and the asset was
  // stranded either way. It is a tab in B now, whether or not the toast is ever touched.
  store.select("A"); await flush();
  show({ sessionId: "B", contentId: "vid1", kind: "video", name: "clip.mp4", url: "/content/vid1" });
  await flush();
  ok("other-session video does not steal the pane", !dockVisible());
  store.select("B"); await flush();
  ok("but it is waiting there as a tab", tabs().some((t) => t.querySelector(".cd-tab-name").textContent === "clip.mp4"));

  // ── a plugin's persisted content, replayed while its plugin is DISABLED ──────────────────────────────
  // Custom content outlives the plugin that made it, on purpose. Dropping the frame because nothing can draw
  // it left the engine holding an asset with no tab, so it counted against the session's budget and there was
  // no control anywhere that could release it. It gets a tab that says what happened, and a close button.
  store.select("A"); await flush();
  show({ sessionId: "A", contentId: "cust1", kind: "gone-tool/report", name: "weekly.report", url: "/content/cust1", replay: true });
  await flush();
  ok("content from a plugin that is not loaded still opens a tab", tabs().length === 1
    && tabs()[0].querySelector(".cd-tab-name").textContent === "weekly.report");
  ok("and the tab says why it cannot draw it, naming the kind",
    /gone-tool\/report/.test((document.querySelector("#pane-body .cd-error") || {}).textContent || ""));
  document.querySelector(".cd-tab .cd-tab-x")._fire("click", { target: document.querySelector(".cd-tab .cd-tab-x") });
  await flush();
  ok("closing it is what releases the asset", __pendingClosesForTest("A").includes("cust1") && tabs().length === 0);
  // A kind that is not a plugin kind at all is still refused — this is not a general "show me anything" path.
  show({ sessionId: "A", contentId: "junk1", kind: "not a kind", name: "junk", url: "/content/junk1" });
  await flush();
  ok("a malformed kind is still refused outright", tabs().length === 0);

  ok("per-session isolation: switching back to A shows no dock", (store.select("A"), true));
  await flush();
  ok("A has no content now → dock hidden", !dockVisible());

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);

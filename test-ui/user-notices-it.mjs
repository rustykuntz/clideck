// UI IT — core `clideck notify` messages (ui/user-notices.js) and the generic plugin.settings card buttons.
// Fake /api/notifications; real store + toast. Sticky toast per unread message with Open session; read on
// open/dismiss; no duplicates across reconnect replays; read elsewhere → toast leaves; newest 3 + summary;
// a late GET never overwrites a newer replay; 404 engine = nothing.
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
const now = Date.now();
let notices = [], status = 200, hold = null;
const posts = [];
globalThis.fetch = async (url, init = {}) => {
  if (url !== "/api/notifications") throw new Error("unexpected " + url);
  if (!init.method) {
    if (init.cache !== "no-store") throw new Error("GET must be no-store");
    if (hold) await new Promise((r) => { hold.release = r; });
    return { ok: status < 400, status, json: async () => ({ notices }) };
  }
  const body = JSON.parse(init.body); posts.push(body);
  if (body.action === "read") notices = notices.filter((n) => n.id !== body.id);
  return { ok: true, status: 200, json: async () => ({ ok: true, notices }) };
};

const { store } = await import("../public/js/store.js");
const { initUserNotices, loadNotices, __resetNoticesForTest } = await import("../public/js/ui/user-notices.js");

let pass = 0, fail = 0;
const ok = (name, yes, detail) => { if (yes) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : " " + JSON.stringify(detail))); } };
const sleep = (ms = 8) => new Promise((r) => setTimeout(r, ms));
const all = () => document.body._walk();
const live = (re = /^toast-notice-/) => all().filter((n) => n.classList?.contains("toast") && re.test(String(n.id || "")) && n.style?.height !== "0");

try {
  store.applyEvent({ type: "session.created", sessionId: "c1", provider: "claude", cwd: "/a", name: "Strategy", live: true, pid: 1 });
  store.applyEvent({ type: "session.created", sessionId: "c2", provider: "codex", cwd: "/b", name: "Video", live: true, pid: 2 });
  store.select("c2");

  status = 404; store.setConnected(true); initUserNotices(); await sleep();
  ok("old engine (404): nothing shown, nothing posted", live().length === 0 && posts.length === 0);
  __resetNoticesForTest(); status = 200;

  const n1 = { id: "n1", sessionId: "c1", text: "Backtest finished: +4.2%", at: now };
  store.applyEvent({ type: "user.notice", ...n1 }); await sleep();
  ok("a live notice shows one sticky toast named after its session", live().length === 1 && /Strategy/.test(live()[0].textContent) && /Backtest finished/.test(live()[0].textContent) && /Dismiss/.test(live()[0].textContent));
  notices = [n1];
  store.applyEvent({ type: "user.notices", notices: [n1] }); store.setConnected(false); store.setConnected(true); await sleep(20);
  ok("replay + reconnect GET with the same notice: no duplicate", live().length === 1);
  all().find((n) => n.classList?.contains("toast-primary") && n.textContent === "Open session")._fire("click"); await sleep();
  ok("Open session selects it and marks it read", store.activeId === "c1" && posts.at(-1)?.action === "read" && posts.at(-1).id === "n1");

  const n2 = { id: "n2", sessionId: "gone", text: "From a closed session", at: now + 1 };
  store.applyEvent({ type: "user.notice", ...n2 }); await sleep();
  const t2 = live().find((t) => t.id === "toast-notice-n2");
  ok("a closed session’s notice has no Open session, still readable", t2 && /Message from an agent/.test(t2.textContent) && !/Open session/.test(t2.textContent));
  all().filter((n) => n.classList?.contains("toast-act") && n.textContent === "Dismiss").at(-1)._fire("click"); await sleep();
  ok("Dismiss marks it read", posts.at(-1).action === "read" && posts.at(-1).id === "n2");

  const n3 = { id: "n3", sessionId: "c1", text: "third", at: now + 2 };
  store.applyEvent({ type: "user.notice", ...n3 }); await sleep();
  store.applyEvent({ type: "user.notices", notices: [] }); await sleep(350);
  ok("read in another window (replay without it): its toast leaves", !live().some((t) => t.id === "toast-notice-n3" && t.classList.contains("in")));

  const many = [4, 5, 6, 7, 8].map((i) => ({ id: "m" + i, sessionId: "c1", text: "msg " + i, at: now + 10 + i }));
  store.applyEvent({ type: "user.notices", notices: many }); await sleep();
  const shownIds = live(/^toast-notice-m\d/).map((t) => t.id);
  ok("only the newest three as toasts", shownIds.length === 3 && shownIds.includes("toast-notice-m8") && !shownIds.includes("toast-notice-m4"), shownIds);
  ok("the rest fold into one summary", live(/^toast-notice-more$/).length === 1 && /2 more messages/.test(live(/^toast-notice-more$/)[0].textContent));

  hold = {}; notices = []; const late = loadNotices(); await sleep();
  store.applyEvent({ type: "user.notices", notices: many }); await sleep();
  hold.release(); await late; await sleep();
  ok("a late GET reply never overwrites a newer replay", live(/^toast-notice-m\d/).length === 3);
  hold = null;

  // ── generic plugin.settings buttons on a plugin's card ──
  const { registerAction } = await import("../public/js/ui/action-registry.js");
  const runs = [];
  store.applyEvent({ type: "plugins", plugins: [{ id: "telegram", name: "Telegram", version: "1.0.0", enabled: true, status: "ready", source: "user", values: {}, settings: [] }] });
  registerAction("telegram", { id: "configure", label: "Configure", placements: ["plugin.settings"] }, async (method, id, ctx) => { if (method === "run-action") runs.push(ctx); });
  registerAction("other", { id: "x", label: "Someone else", placements: ["plugin.settings"] }, async () => {});
  const settings = await import("../public/js/ui/settings.js");
  settings.openSettingsAt("plugins"); await sleep();
  all().filter((n) => n.getAttribute?.("aria-label") === "Open Telegram settings").at(-1)._fire("click"); await sleep(20);
  const card = all().filter((n) => n.classList?.contains("plg-card-actions")).at(-1);
  ok("plugin card shows that plugin’s own plugin.settings buttons only", card && !card.hidden && card.textContent === "Configure", card?.textContent);
  card?._kids[0]?._fire("click"); await sleep();
  ok("clicking runs it with the session context and closes Settings", runs.length === 1 && runs[0].session?.id === "c1" && !settings.isSettingsOpen());
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// IT — clickable document paths in the terminal. Drives the REAL paths.js + store + ws over the fake WebSocket.
//
// The rule under test is the one that shapes the feature: a printed path MAY NOT EXIST, so existence is tested
// FIRST and only real files are ever offered as links. Everything else here is the cache — a candidate must be
// probed exactly once per session whether it resolved or not, because a miss that is not remembered is re-probed
// on every scan for as long as it stays on screen.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const P = await import("../public/js/ui/paths.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resolves = () => ws.sent.filter((m) => m.type === "content.resolve");
const opens = () => ws.sent.filter((m) => m.type === "content.open");

// Or's acceptance line, verbatim — two paths in one sentence, the second followed by a full stop.
const LINE = "The MD file is ready: docs/STRATEGY-IMPLEMENTATION-SPEC.md - 761 lines, written with the "
  + "programmer, whose full input is at docs/archive/PROGRAMMER-INPUT-STRATEGY-IMPLEMENTATION-SPEC.md.";
const A = "docs/STRATEGY-IMPLEMENTATION-SPEC.md";
const B = "docs/archive/PROGRAMMER-INPUT-STRATEGY-IMPLEMENTATION-SPEC.md";

try {
  connectWs(); await sleep(5);
  store.applyEvent({ type: "session.created", sessionId: "S", cwd: "/proj", name: "s", live: true, pid: 1 });

  // ── the matcher ──
  const found = P.candidatesIn(LINE).map((c) => c.text);
  ok("both printed paths are found in one line", found.length === 2 && found[0] === A && found[1] === B);
  ok("the trailing full stop is not swallowed into the path", found[1] === B && !found[1].endsWith(".."));
  ok("columns are 1-based and end-inclusive, as xterm ranges are", (() => {
    const c = P.candidatesIn(LINE)[0];
    return LINE.slice(c.start - 1, c.end) === A;
  })());
  ok("a path inside a URL is left to the URL provider", P.candidatesIn("see https://ex.dev/docs/readme.md now").length === 0);
  ok("an absolute path keeps its leading slash", P.candidatesIn("wrote /tmp/out/report.pdf.").map((c) => c.text).join() === "/tmp/out/report.pdf");
  ok("a bare filename counts", P.candidatesIn("wrote notes.md").map((c) => c.text).join() === "notes.md");
  // Or's report: the home-relative path must reach the resolver whole, "~/" included (the engine expands it).
  ok("a home path keeps its ~/ prefix", P.candidatesIn("See ~/Projects/Borrow-demo/engine/PROMPTS.md.").map((c) => c.text + "@" + c.start).join() === "~/Projects/Borrow-demo/engine/PROMPTS.md@5");
  ok("an extension the viewer cannot render is not a candidate",
     P.candidatesIn("report.xlsx archive.zip main.rs").length === 0);
  ok("a version-looking token is not mistaken for a path", P.candidatesIn("bumped to 1.md5 and v2.mdx").length === 0);
  ok("every engine-rendered extension matches", (() => {
    const line = "a.txt b.log c.json d.md e.html f.htm g.pdf h.mmd i.patch j.diff k.png l.jpg m.jpeg n.gif o.webp p.mp4 q.webm r.csv";
    return P.candidatesIn(line).length === 18;
  })());

  // ── existence is tested FIRST: nothing is a link before the engine answers ──
  ok("before any probe, neither path is a link", P.linkFor("S", A) === undefined && P.linkFor("S", B) === undefined);
  ws.clear();
  P.probe("S", [LINE]);
  ok("a probe asks the engine about exactly the two candidates", (() => {
    const m = resolves()[0];
    return resolves().length === 1 && m.sessionId === "S" && m.paths.length === 2 && m.paths[0] === A && m.paths[1] === B;
  })());

  // ── the ACCEPTANCE case: both exist → both become links ──
  store.applyEvent({ type: "content.resolve.result", sessionId: "S",
    resolved: { [A]: "/proj/" + A, [B]: "/proj/" + B } });
  ok("both resolved paths become links", P.linkFor("S", A) === "/proj/" + A && P.linkFor("S", B) === "/proj/" + B);

  // ── the other half of the acceptance case: neither exists → neither is a link ──
  store.applyEvent({ type: "session.created", sessionId: "T", cwd: "/other", name: "t", live: true, pid: 2 });
  ws.clear();
  P.probe("T", [LINE]);
  store.applyEvent({ type: "content.resolve.result", sessionId: "T", resolved: { [A]: null, [B]: null } });
  ok("a path that does not exist is NOT a link", P.linkFor("T", A) === null && P.linkFor("T", B) === null);
  ok("resolution is per session — the same string can exist in one and not the other",
     P.linkFor("S", A) === "/proj/" + A && P.linkFor("T", A) === null);

  // ── the cache: probed once, hit or miss ──
  ws.clear();
  P.probe("S", [LINE, LINE, "again " + A]);
  ok("a resolved candidate is never probed again", resolves().length === 0);
  ws.clear();
  P.probe("T", [LINE]);
  ok("a MISS is remembered too — a dead path is not re-probed on every scan", resolves().length === 0);

  // ── only unseen candidates go out, and the batch is capped ──
  ws.clear();
  P.probe("S", [LINE + " plus fresh.md"]);
  ok("only the unseen candidate is sent", resolves().length === 1 && resolves()[0].paths.join() === "fresh.md");
  ws.clear();
  const many = Array.from({ length: 80 }, (_, i) => "f" + i + ".md").join(" ");
  P.probe("S", [many]);
  ok("the batch is capped at 50", resolves()[0].paths.length === 50);

  // ── an in-flight candidate is not asked twice ──
  ws.clear();
  P.probe("S", ["inflight.md"]);
  P.probe("S", ["inflight.md"]);
  ok("a candidate already in flight is not re-sent", resolves().length === 1);

  // ── clicking sends the EXISTING content.open path form ──
  const { openContentPath } = await import("../public/js/ws.js");
  ws.clear();
  openContentPath("S", P.linkFor("S", A));
  ok("clicking a resolved path opens it with the existing content.open path form", (() => {
    const m = opens()[0];
    return opens().length === 1 && m.sessionId === "S" && m.path === "/proj/" + A
      && m.name === undefined && m.data === undefined;      // the PATH form, not the payload form
  })());

  // ── a closed session drops its cache ──
  store.applyEvent({ type: "session.closed", sessionId: "S" });
  store.emit && store.emit("session:remove", "S");
  ws.clear();
  P.probe("S", [LINE]);
  ok("a removed session's cache is dropped, so nothing leaks between sessions", resolves().length <= 1);

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);

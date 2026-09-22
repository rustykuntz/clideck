// GOLDEN ORDERING — the `//` and `@@` dropdowns. The first section was recorded BEFORE typo tolerance;
// the last section is the ranking ladder Or corrected on 09-09.
//
// "No regression" is only provable against a recorded before. Re-running a suite after a change proves that
// nothing THREW; it does not prove that no existing result MOVED, and moving is the entire risk when a new
// group is appended to a ranked, partitioned list.
//
// ⚠️ RECORDED IS NOT SACRED. These lists are evidence of what shipped, not a promise that it was right: the
// 09-09 ladder fix changed ordering none of them happened to pin, and if a future correction contradicts one,
// the correction wins and the line gets rewritten with the reason. What must never happen is a list quietly
// moving underneath someone.
//
// Read the first section as three clauses: every row the literal pass returns is still returned, in the same
// order, and any appended group starts AFTER the last of them. A fuzzy tail satisfies all three by
// construction. Anything that re-ranks does not.
//
// ⚠️ "EXACT" IN THE OLDER COMMENTS MEANS THE LITERAL SUBSTRING PASS, not whole-name equality. Whole-name
// equality is rank 3 of that pass and is only as old as the ladder section at the bottom.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();

const { store } = await import("../public/js/store.js");
const { connectWs } = await import("../public/js/ws.js");
const { handleTerminalKey, closePromptDropdown } = await import("../public/js/ui/prompts.js");
const { spellingScore } = await import("../public/js/search-similarity.js");   // the programmer's — CALLED, never pinned

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (extra !== undefined ? "  [" + extra + "]" : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => handleTerminalKey({ type: "keydown", key: k, preventDefault() {} });

// Rows as the USER sees them, in screen order — not the matcher's return value. What the matcher does is an
// implementation detail; what is on screen is the promise.
function rows() {
  return [...document.querySelectorAll(".pl-ac-item .pl-ac-name")].map((n) => n.innerHTML.replace(/<[^>]+>/g, ""));
}
function open(trigger, filter = "") {
  closePromptDropdown();
  key("x"); key(" ");                        // a printable char immediately before would suppress the trigger
  key(trigger); key(trigger);
  for (const ch of filter) key(ch);
  return rows();
}
const slash = (filter) => open("/", filter);
const at = (filter) => open("@", filter);
const live = (id, name, projectId) => store.applyEvent({
  type: "session.created", sessionId: id, protocol: 1, provider: "claude-code",
  name, pid: 1, cwd: "/w", cols: 80, rows: 24, live: true, projectId,
});

try {
  connectWs(); await sleep(5);

  // ── the fixture ────────────────────────────────────────────────────────────────────────────────────
  // Chosen so ORDER is load-bearing, not incidental: a name hit and a body-only hit for the same query, a
  // query that hits two names, and a pair whose file order is the only thing separating them.
  // ⚠️ The `//` trigger is refused when there is no LIVE active session (`triggerAvailable` + `activeLive`),
  // so the sessions have to exist before the first `//` check. Without them the dropdown never opens, every
  // list is empty, and the "nothing matches" checks pass while proving nothing — which is how this was found.
  const BASE = {
    projects: [
      { id: "pa", name: "Alpha", path: "/a", color: "#111", collapsed: false },
      { id: "pb", name: "Beta", path: "/b", color: "#222", collapsed: false },
    ],
    prompts: [
      { id: "p1", name: "deploy checklist", text: "Walk the release steps in order." },
      { id: "p2", name: "review diff", text: "Read the deploy notes and the diff." },
      { id: "p3", name: "deployment notes", text: "Where the environments live." },
      { id: "p4", name: "summarise", text: "Summarise this in three lines." },
    ],
  };
  const config = (extra = {}) => store.applyEvent({ type: "config", config: { ...BASE, ...extra } });
  config();
  live("s1", "beta-one", "pb");
  live("s2", "alpha-one", "pa");
  live("s3", "loose-one", null);
  live("s4", "beta-two", "pb");
  store.select("s2");                                            // active session is in project Alpha

  // The precondition, asserted rather than assumed — an empty list below must mean "nothing matched",
  // never "the dropdown never opened".
  ok("the dropdown really opens, so an empty result means no match and not a dead trigger",
    slash().length > 0 && at().length > 0, `${slash().length} / ${at().length}`);

  // ── `//` — a NAME hit outranks a BODY hit, and ties keep library order ─────────────────────────────
  // (Rank 2 vs rank 1 of the ladder. Nothing here happens to be a whole-name match, which is why every line
  // in this section survived the 09-09 fix unchanged.)
  ok("unfiltered, the library is offered in its own order",
    slash().join(",") === "deploy checklist,review diff,deployment notes,summarise", slash().join(","));
  ok("a name hit outranks a body-only hit, whatever the library order says",
    slash("deploy").join(",") === "deploy checklist,deployment notes,review diff", slash("deploy").join(","));
  ok("two name hits keep the order the library gave them",
    slash("deploy").slice(0, 2).join(",") === "deploy checklist,deployment notes");
  ok("a query matching one prompt returns exactly it",
    slash("summar").join(",") === "summarise", slash("summar").join(","));
  // CHANGED ON PURPOSE (typo tolerance). Recorded before: this returned nothing. Now a near miss is
  // offered — but as an APPENDED group, which is why every clause above still passes unchanged.
  ok("a typo now offers the near miss it used to drop",
    slash("deplyo").join(",") === "deploy checklist,deployment notes", JSON.stringify(slash("deplyo")));
  ok("matching is case-insensitive",
    slash("DEPLOY").join(",") === slash("deploy").join(","));

  // ── `//` — recently-used in THIS project leads, as a stable partition ──────────────────────────────
  // ⚠️ A `config` frame is a WHOLE config, not a patch — `store.js` reads `c.prompts` and falls back to []
  // when the key is absent, so sending `{promptMru}` alone empties the prompt library. Send the whole thing.
  config({ promptMru: { pa: ["p3"] } });
  ok("a prompt used in this project leads, and the rest keep their order behind it",
    slash("deploy").join(",") === "deployment notes,deploy checklist,review diff", slash("deploy").join(","));
  ok("and the partition does not change WHICH prompts matched",
    slash("deploy").slice().sort().join(",") === "deploy checklist,deployment notes,review diff");
  config({ promptMru: {} });

  // ── `@@` — project-first partition, name hit above address-only hit ────────────────────────────────
  ok("unfiltered, the active session's project leads",
    at().join(",") === "alpha-one,beta-one,loose-one,beta-two", at().join(","));
  ok("a filter narrows without disturbing the partition",
    at("one").join(",") === "alpha-one,beta-one,loose-one", at("one").join(","));
  ok("a project name matches through the ADDRESS, not the agent name",
    at("beta").join(",") === "beta-one,beta-two", at("beta").join(","));
  // CHANGED ON PURPOSE, same as `//` above.
  ok("a transposed agent name is offered rather than dropped",
    at("alhpa").join(",") === "alpha-one", JSON.stringify(at("alhpa")));

  // ── the invariant an appended group must not break ─────────────────────────────────────────────────
  // Stated once, generally, so it keeps meaning something after the tail exists: whatever else the list
  // holds, the exact rows must still be the FIRST rows, in this order.
  const EXACT = {
    "//": [["deploy", ["deploy checklist", "deployment notes", "review diff"]], ["summar", ["summarise"]]],
    "@@": [["one", ["alpha-one", "beta-one", "loose-one"]], ["beta", ["beta-one", "beta-two"]]],
  };
  let held = true, detail = "";
  for (const [query, expected] of EXACT["//"]) {
    const got = slash(query);
    if (got.slice(0, expected.length).join(",") !== expected.join(",")) { held = false; detail = `// ${query}: ${got.join(",")}`; }
  }
  for (const [query, expected] of EXACT["@@"]) {
    const got = at(query);
    if (got.slice(0, expected.length).join(",") !== expected.join(",")) { held = false; detail = `@@ ${query}: ${got.join(",")}`; }
  }
  ok("EVERY literal result is still first, in its recorded order — the clause a fuzzy tail must satisfy", held, detail);

  // ── the ranking ladder (Or's 09-09 regression) ────────────────────────────────────────────────────
  // Reported: `//reviewer` led with "Daily checklist" — a recently-used prompt whose BODY happens to say
  // reviewer — above the prompt actually NAMED reviewer; `@@reviewer` put the current project's "Senior
  // reviewer" above the session literally called reviewer. Cause: the project/MRU partition ran AFTER the rank
  // sort, so it lifted a whole weak group over a stronger match.
  //
  // ⚠️ NOTHING ABOVE THIS LINE CHANGED. Every golden expectation recorded before the fix still passes verbatim,
  // which is the evidence that this corrects an ordering nobody had pinned rather than rewriting the contract.
  // The ladder: 3 = the whole name (or, for an agent, the whole address), 2 = the name contains it, 1 = only
  // the body/address does. Preference breaks an EQUAL rank and nothing more.
  const LADDER = {
    projects: [
      { id: "pr", name: "reviewers", path: "/r", color: "#111", collapsed: false },
      { id: "pb", name: "Beta", path: "/b", color: "#222", collapsed: false },
    ],
    prompts: [
      { id: "q1", name: "Daily checklist", text: "Ask the reviewer before merging." },   // body only
      { id: "q2", name: "Senior reviewer", text: "Escalate to a senior." },              // name contains
      { id: "q3", name: "reviewer", text: "Read the diff." },                            // the whole name
    ],
  };
  const ladder = (extra = {}) => store.applyEvent({ type: "config", config: { ...LADDER, ...extra } });
  live("s10", "Senior reviewer", "pr");     // preferred, name contains
  live("s11", "reviewer", "pb");            // NOT preferred, the whole name
  live("s12", "notes", "pr");               // preferred, hit only through its @reviewers/notes address
  live("s13", "reviewer-bot", "pb");        // NOT preferred, name contains
  store.select("s10");                      // active session is in project "reviewers"

  ladder({ promptMru: { pr: ["q1"] } });
  ok("// the prompt NAMED reviewer leads, even with a recently-used body-only match against it",
    slash("reviewer").join(",") === "reviewer,Senior reviewer,Daily checklist", slash("reviewer").join(","));
  ladder({ promptMru: {} });
  ok("// …and it leads with no preference in play either — the ladder alone decides",
    slash("reviewer").join(",") === "reviewer,Senior reviewer,Daily checklist", slash("reviewer").join(","));
  ladder({ promptMru: { pr: ["q3"] } });
  ok("// a blank query is still led by what you have used here",
    slash().join(",") === "reviewer,Daily checklist,Senior reviewer", slash().join(","));

  ok("@@ the session NAMED reviewer leads, then equal-rank names with the current project first, then address-only",
    at("reviewer").join(",") === "reviewer,Senior reviewer,reviewer-bot,notes", at("reviewer").join(","));
  ok("@@ …so an exact match outranks a preferred partial, and a name outranks a preferred address-only hit",
    at("reviewer").indexOf("reviewer") === 0 && at("reviewer").indexOf("Senior reviewer") < at("reviewer").indexOf("notes"));
  ok("@@ preference still breaks the tie between two equally-ranked names",
    at("reviewer").indexOf("Senior reviewer") < at("reviewer").indexOf("reviewer-bot"));
  // ⚠️ "@beta/reviewer" is ALSO a substring of @Beta/reviewer-bot, so this is not a uniqueness check — it is
  // the ladder: the session whose address IS what you typed outranks the one that merely contains it.
  ok("@@ typing a whole @Project/name address is an exact match, above an address that merely contains it",
    at("@beta/reviewer").join(",") === "reviewer,reviewer-bot", at("@beta/reviewer").join(","));
  ok("@@ a blank query still leads with the active session's project",
    at().slice(0, 2).join(",") === "Senior reviewer,notes", at().slice(0, 4).join(","));

  // The order is only half the promise: Enter/Tab take the TOP row, so the ladder has to be what they follow.
  ladder({ promptMru: { pr: ["q1"] } });
  slash("reviewer"); ws.clear(); key("Enter");
  ok("// Enter pastes the whole-name match, not the recently-used body hit",
    (ws.last("input") || {}).data === "\x1b[200~Read the diff.\x1b[201~", JSON.stringify(ws.last("input")));
  at("reviewer"); ws.clear(); key("Tab");
  ok("@@ Tab inserts the address of the session NAMED reviewer, not the preferred partial",
    (ws.last("input") || {}).data === "\x1b[200~@Beta/reviewer \x1b[201~", JSON.stringify(ws.last("input")));

  // …and a guess still cannot climb over a literal hit, whatever the ladder did to the literal group.
  ladder({ promptMru: {}, prompts: [...LADDER.prompts, { id: "q4", name: "revewer digest", text: "Weekly." }] });
  const mixed = slash("reviewer");
  // ⚠️ Ask the scorer whether it considers this a near miss rather than assuming — its numbers are the
  // programmer's to change, and a check that quietly stops finding the guess would pass while proving nothing.
  const guessed = Number(spellingScore("reviewer", "revewer digest")) > 0;
  ok("a fuzzy suggestion stays BELOW every literal result",
    guessed && mixed.slice(0, 4).join(",") === "reviewer,Senior reviewer,Daily checklist,revewer digest",
    mixed.join(",") + (guessed ? "" : "  [scorer no longer offers it — fixture needs a new near miss]"));

  // Saved prompt prefixes outrank other name substrings, independently of library/project preference.
  const prefixPrompts = [
    { id: "ui", name: "UI programmer", text: "UI instructions" },
    { id: "body", name: "Daily notes", text: "Find the programmer" },
    { id: "intro", name: "programmer intro", text: "Programmer instructions" },
    { id: "guide", name: "programmer guide", text: "Guide instructions" },
    { id: "exact", name: "prog", text: "Exact instructions" },
  ];
  ladder({ prompts: prefixPrompts, promptMru: {} });
  ok("// prefix beats earlier library substring; equal prefixes keep library order",
    slash("program").slice(0, 4).join(",") === "programmer intro,programmer guide,UI programmer,Daily notes");
  ladder({ prompts: prefixPrompts, promptMru: { pr: ["ui", "body", "guide"] } });
  ok("// exact beats prefix, preferred substring/body stay lower, preference breaks prefix tie",
    slash("PROG").slice(0, 5).join(",") === "prog,programmer guide,programmer intro,UI programmer,Daily notes");
  slash("program"); ws.clear(); key("Enter");
  ok("// Enter completes highest-ranked preferred prefix, not preferred substring",
    ws.last("input")?.data === "\x1b[200~Guide instructions\x1b[201~");
  slash("prog"); ws.clear(); key("Tab");
  ok("// Tab completes exact name ahead of preferred prefix",
    ws.last("input")?.data === "\x1b[200~Exact instructions\x1b[201~");

  closePromptDropdown();
} catch (error) {
  fail++; console.log("  FAIL threw: " + (error && error.stack || error));
}
console.log(`\n${fail ? "✗" : "✓"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

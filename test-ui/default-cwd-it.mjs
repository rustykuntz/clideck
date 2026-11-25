// IT — the "Default working directory" setting (config.defaultCwd) is applied when a cwd is left blank. Drives
// the ACTUAL store + project-creator.js + ws.js over a fake WebSocket. Covers both fixes:
//  • new PROJECT with a blank folder → path falls back to defaultCwd; blank + empty defaultCwd → stays "";
//    an explicit path is unchanged.
//  • new SESSION (no project) with a blank cwd → session.create carries defaultCwd; explicit cwd unchanged;
//    empty defaultCwd → cwd omitted (engine default); a project session never takes the defaultCwd fallback.
import { installFakeDom, installFakeWs } from "./fakedom.mjs";
const dom = installFakeDom();
const ws = installFakeWs();
// sidebar scaffolding (same shape preview-it uses) so initSidebar runs and the REAL new-session picker can be driven
function mkEl(id) { const e = document.createElement("div"); e.id = id; return e; }
const list = mkEl("list"); list.appendChild(mkEl("list-empty")); document.body.appendChild(list);
for (const id of ["tab-all", "tab-unread", "search", "search-clear", "notify-btn", "prompts-btn", "settings-btn", "unread-cnt", "conn", "conn-text", "save-ind"]) document.body.appendChild(mkEl(id));
const sideHead = document.createElement("div"); sideHead.className = "side-head"; const nw = document.createElement("div"); nw.className = "new-wrap"; sideHead.appendChild(nw); document.body.appendChild(sideHead);
const newBtn = document.createElement("button"); newBtn.id = "new-btn"; document.body.appendChild(newBtn);
const anchor = document.createElement("button"); anchor.id = "proj-btn"; document.body.appendChild(anchor);

const { store } = await import("../public/js/store.js");
const { connectWs, createSession } = await import("../public/js/ws.js");
const { openProjectCreator, closeProjectCreator } = await import("../public/js/ui/project-creator.js");
const { initSidebar } = await import("../public/js/ui/sidebar.js");
const { closeMenu } = await import("../public/js/ui/menu.js");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setConfig = (o) => store.applyEvent({ type: "config", config: o });   // NB: resets store.projects to [] each time
const projByName = (n) => store.projects.find((p) => p.name === n) || null;
// open the real creator popover, fill it, click Create
function createProject(pathVal, nameVal) {
  openProjectCreator(anchor);
  document.querySelector(".pc-path").value = pathVal;
  document.querySelector(".pc-name").value = nameVal;
  document.querySelector(".pc-create")._fire("click");
}

try {
  connectWs(); await sleep(5);

  // ── new PROJECT ──
  setConfig({ defaultCwd: "/Users/rusty/work" });
  createProject("", "Alpha");
  ok("blank project folder → uses the configured defaultCwd", projByName("Alpha") && projByName("Alpha").path === "/Users/rusty/work");

  setConfig({ defaultCwd: "" });
  createProject("", "Beta");
  ok("blank folder + empty defaultCwd → path stays empty", projByName("Beta") && projByName("Beta").path === "");

  setConfig({ defaultCwd: "/Users/rusty/work" });
  createProject("/explicit/dir", "Gamma");
  ok("explicit folder → unchanged (defaultCwd ignored)", projByName("Gamma") && projByName("Gamma").path === "/explicit/dir");

  // ── the setting must be VISIBLE on open, not just consulted at create time (it read as "my setting is ignored") ──
  const openCreator = () => { openProjectCreator(anchor); return { path: document.querySelector(".pc-path"), name: document.querySelector(".pc-name") }; };
  setConfig({ defaultCwd: "/Users/rusty/work" });
  {
    const f = openCreator();
    ok("folder field is PREFILLED with defaultCwd (not blank)", f.path.value === "/Users/rusty/work");
    ok("name auto-fills from the prefill at build (no input event fires)", f.name.value === "work");
    await sleep(5);   // the focus/caret runs on a timeout
    ok("caret sits at the END so a subfolder can be appended", f.path.selectionStart === "/Users/rusty/work".length && f.path.selectionEnd === f.path.selectionStart);
    // the build-time autoName must NOT mark the name as user-edited, or typing a new path would stop re-deriving it
    f.path.value = "/other/place"; f.path._fire("input");
    ok("editing the path still re-derives the name", f.name.value === "place");
    // ...but once the USER edits the name, a later path change leaves it alone
    f.name.value = "Chosen"; f.name._fire("input");
    f.path.value = "/third/spot"; f.path._fire("input");
    ok("a user-edited name is not clobbered by a path change", f.name.value === "Chosen");
    closeProjectCreator();
  }
  {
    setConfig({ defaultCwd: "" });
    const f = openCreator();
    ok("empty defaultCwd → folder field blank (placeholder shows, no crash)", f.path.value === "");
    ok("empty defaultCwd → name stays blank", f.name.value === "");
    closeProjectCreator();
  }
  // prefilled-then-CLEARED still falls back, so the placeholder's "blank = default" promise holds
  setConfig({ defaultCwd: "/Users/rusty/work" });
  createProject("", "Delta");
  ok("clearing the prefill still falls back to defaultCwd", projByName("Delta") && projByName("Delta").path === "/Users/rusty/work");

  // ── new SESSION (ws.createSession) ──
  setConfig({ defaultCwd: "/Users/rusty/work" });
  ws.clear(); createSession("claude-code", "", "s1");                    // no project, blank cwd
  ok("blank cwd + no project → session.create carries defaultCwd", (() => { const m = ws.last("session.create"); return m && m.cwd === "/Users/rusty/work"; })());

  ws.clear(); createSession("claude-code", "/explicit", "s2");
  ok("explicit cwd → session.create unchanged", ws.last("session.create").cwd === "/explicit");

  setConfig({ defaultCwd: "" });
  ws.clear(); createSession("claude-code", "", "s3");
  ok("blank cwd + empty defaultCwd → cwd omitted (engine default)", !("cwd" in ws.last("session.create")));

  setConfig({ defaultCwd: "/Users/rusty/work" });
  ws.clear(); createSession("claude-code", "", "s4", "proj-x");          // project session, blank cwd
  ok("project session + blank cwd → NO defaultCwd fallback (project governs)", !("cwd" in ws.last("session.create")));

  // ══ NEW SESSION picker — same visibility rule as the project creator (sweep findings #1 + #2) ══
  initSidebar();
  const PROJ = { id: "p1", name: "Webapp", path: "/Users/rusty/Projects/webapp", color: "#888", collapsed: false };
  const openSessionPicker = () => {
    newBtn._fire("click", { currentTarget: newBtn });
    return { path: document.querySelector(".pv-path-input"), sel: document.querySelector(".pv-project-select"), cap: document.querySelectorAll(".pv-path")[0].children[0], browse: document.querySelector(".pv-browse") };
  };

  // #1 — the field must SHOW the configured default, not apply it silently at create
  setConfig({ defaultCwd: "/Users/rusty/work", projects: [PROJ] });
  {
    const f = openSessionPicker();
    ok("session picker: folder field PREFILLED with defaultCwd", f.path.value === "/Users/rusty/work");
    ok("session picker: folder row is VISIBLE on open", document.querySelectorAll(".pv-path")[0].hidden !== true);
    // #2 — choosing a project shows ITS folder read-only instead of hiding the row
    f.sel.value = PROJ.id; f.sel._fire("change");
    ok("project selected → row still visible (not hidden)", document.querySelectorAll(".pv-path")[0].hidden !== true);
    ok("project selected → shows the PROJECT's folder", f.path.value === PROJ.path);
    ok("project selected → read-only + Browse disabled", f.path.readOnly === true && f.browse.disabled === true);
    ok("project selected → caption attributes it to the project", /Project folder/.test(f.cap.textContent));
    ok("project selected → misleading 'blank = default' placeholder cleared", f.path.placeholder === "");
    // back to None restores the user's own editable path
    f.sel.value = "__none__"; f.sel._fire("change");
    ok("back to None → editable again", f.path.readOnly === false && f.browse.disabled === false);
    ok("back to None → the defaultCwd prefill is restored", f.path.value === "/Users/rusty/work");
    // a path the user typed survives a round-trip through a project selection
    f.path.value = "/typed/by/user"; f.path._fire("input");
    f.sel.value = PROJ.id; f.sel._fire("change");
    f.sel.value = "__none__"; f.sel._fire("change");
    ok("a user-typed path survives a project round-trip", f.path.value === "/typed/by/user");
    closeMenu();
  }
  // a conflict re-open must honour a DELIBERATELY CLEARED field rather than re-prefilling it
  {
    setConfig({ defaultCwd: "/Users/rusty/work", projects: [PROJ] });
    const f = openSessionPicker();
    f.path.value = ""; f.path._fire("input");                       // user clears it on purpose
    document.querySelector(".pv-opt")._fire("click");               // spawn → engine rejects the name below
    store.applyEvent({ type: "session.created", sessionId: "x1", provider: "claude-code", name: "dup", cwd: "", live: true, pid: 1,
      error: { code: "name_conflict", operation: "session.create", value: "dup", cwd: "", message: "taken" } });
    const f2 = { path: document.querySelector(".pv-path-input") };
    ok("conflict re-open keeps a deliberately cleared field cleared", f2.path.value === "");
    closeMenu();
  }

  // A deleted project folder must explain the failure and retain the attempted session.
  {
    setConfig({ projects: [PROJ] });
    store.applyEvent({ type: "session.created", sessionId: "existing", provider: "shell", name: "Existing", live: true, pid: 1 });
    store.select("existing");
    const f = openSessionPicker();
    f.sel.value = PROJ.id; f.sel._fire("change");
    document.querySelector(".pv-name-input").value = "Researcher";
    document.querySelector(".pv-opt")._fire("click");
    const message = `Project folder not found: ${PROJ.path}. It may have been moved or deleted. Restore it or choose an existing folder.`;
    store.applyEvent({ type: "session.create.result", success: false, code: "folder_not_found", cwd: PROJ.path, error: message });
    ok("missing folder reopens the picker with the project and name intact", document.querySelector(".pv-project-select")?.value === PROJ.id && document.querySelector(".pv-name-input")?.value === "Researcher");
    ok("missing folder explains the failed start inline", document.querySelector(".pv-error")?.textContent === message);
    ok("missing folder shows its own visible error, not Name taken", document.getElementById("toast-session-create")?.querySelector(".toast-t")?.textContent === "Folder not found");
    ok("failed start preserves the current session without adding a phantom row", store.sessions.size === 1 && store.activeId === "existing");
    store.applyEvent({ type: "session.created", sessionId: "remote", provider: "shell", name: "Remote", live: true, pid: 2 });
    ok("failed start disarms focus so another client's session is not selected", store.activeId === "existing");
    closeMenu();
  }

  console.log(`\n${fail === 0 ? "✓" : "✗"} ${pass} passed, ${fail} failed`);
} catch (e) { console.log("THREW", e && e.stack || e); fail++; }
process.exit(fail === 0 ? 0 : 1);

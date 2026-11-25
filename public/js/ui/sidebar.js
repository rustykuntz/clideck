// The persistent WhatsApp sidebar: search · All/Unread tabs · one collapsible group
// PER PROJECT (= session cwd) · one row per session (avatar + name + time + preview +
// status dot). Coral needs-you wins the eye; unread spends no hue (bold + neutral badge).
// Dormant (persisted) sessions group the same way and can be resumed or closed.
import { store } from "../store.js";
import { createSession, resumeSession, renameSession, closeSession, openProject, updateConfig, deleteProject, checkAvailability } from "../ws.js";
import { sessionFace, PROVIDER_LIST, DEFAULT_PROVIDER } from "../providers-ui.js";
import { esc, firstLine, relTime, relTimeShort, shortId, h, basename, projectLabels, inlineRename, copyText, askAddress, PROJECT_COLORS, SESSION_NAME_MAX, limitSessionName } from "../util.js";
import { openSessionMenu } from "./session-menu.js";
import { terminalFocusTarget, terminalSelection } from "./terminal.js";
import { openMenu, closeMenu } from "./menu.js";
import { toast } from "./toast.js";
import { initNotificationToggle } from "./notification-toggle.js";
import { openFolderPicker } from "./folder-picker.js";
import { openPromptLibrary } from "./prompts.js";
import { openProjectCreator } from "./project-creator.js";
import { initDrag, wasDragging } from "./drag.js";
import { startBounce } from "./bounce.js";
import { openSettings } from "./settings.js";
import { AGENT_PRESETS, providerHealth } from "../agent-presets.js";
import { hasActions, resolveActions, runAction } from "./action-registry.js";

const CHEVRON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const PENCIL_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const CHECK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const MUTE_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
const FOLDER_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const DOTS_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
const ARROW_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"/><path d="M12 5l7 7-7 7"/></svg>';   // E2: 'Resume →' affordance
const RENAME_HINT = "Enter to save · Esc to cancel";

// Creator leftovers (§L / v1 creator.js:7-23,100-123): a calm random default name when none is typed,
// and the last-used provider remembered so it floats to the front of the picker next time.
const ADJECTIVES = ["Blue", "Amber", "Coral", "Sage", "Golden", "Silver", "Crimson", "Teal", "Rose", "Jade", "Copper", "Ivory", "Mint", "Violet", "Slate", "Rusty"];
const ANIMALS = ["Panda", "Falcon", "Fox", "Wolf", "Owl", "Tiger", "Otter", "Eagle", "Dolphin", "Lynx", "Hawk", "Raven", "Heron", "Panther", "Crane", "Bison"];
function randomName() { return ADJECTIVES[Math.random() * ADJECTIVES.length | 0] + " " + ANIMALS[Math.random() * ANIMALS.length | 0]; }
const MRU_KEY = "clideck.mru-provider";
function mruProvider() { try { return localStorage.getItem(MRU_KEY); } catch { return null; } }
function providerOrder() {   // last-used floats to the front (v1 creator.js:117-121)
  const hidden = new Set(store.hiddenProviders);
  const list = PROVIDER_LIST.filter((provider) => !hidden.has(provider.id));
  const mru = mruProvider();
  if (mru) { const i = list.findIndex((p) => p.id === mru); if (i > 0) list.unshift(...list.splice(i, 1)); }
  return list;
}
function primaryAgent() {
  const provider = providerOrder()[0];
  if (provider) return { provider: provider.id, commandId: null };
  const command = store.commands.find((entry) => entry.enabled !== false);
  return command ? { provider: null, commandId: command.id } : null;
}

const rows = new Map();     // id  -> { root, presence, name, nameText, copyBtn, time, preview, badge, actions, groupKey }
const groups = new Map();   // groupKey -> { root, head, name, count, dot, rowsEl, ids:Set, kind:'project'|'cwd', cwd, projectId, seq }
let listEl = null;
let renamingId = null, rowRenameHandle = null;   // the session row (if any) with an inline rename open
let renamingProjectId = null;                    // the project header (if any) mid-rename — guard so a config echo won't clobber it
let groupSeq = 0;                                 // creation order for cwd groups (project groups sort by config order)
const collapsed = loadCollapsed();   // Set<groupKey> — client-local collapse UX (localStorage)

// A session groups under its project when it has one, else under its cwd. The key namespaces the two so a
// project id can never collide with a cwd. Empty project groups (no sessions yet) still render as drop targets.
// A session groups under its project (live OR dormant); else an ungrouped DORMANT session collects in the
// bottom "Previous Sessions" section (§E); else (live, project-less) under its cwd. Liveness is part of the key,
// so a resume (dormant→live) / sleep flip naturally re-parents the row through the normal move machinery.
function groupKeyOf(s) {
  if (s && s.projectId) return "p:" + s.projectId;
  if (s && s.live === false) return "prev";
  return "c:" + ((s && s.cwd) || "");
}
function projectById(id) { return store.projects.find((p) => p.id === id) || null; }

export function initSidebar() {
  listEl = document.getElementById("list");

  initGlobalPicker();
  document.getElementById("tab-all").onclick = () => setFilter("all");
  document.getElementById("tab-unread").onclick = () => setFilter("unread");
  const searchInput = document.getElementById("search");
  const searchClear = document.getElementById("search-clear");
  searchInput.addEventListener("input", (e) => { store.setSearch(e.target.value); searchClear.classList.toggle("show", e.target.value.length > 0); });
  searchClear.addEventListener("click", () => { searchInput.value = ""; store.setSearch(""); searchClear.classList.remove("show"); searchInput.focus(); });

  store.on("session:add", addRow);
  store.on("session:remove", removeRow);
  store.on("session:update", renderRow);
  store.on("active", () => { for (const id of rows.keys()) renderRow(id); });
  store.on("chrome", renderChrome);
  store.on("config", renderIdentity);
  store.on("connection", renderChrome);
  store.on("filter", applyFilters);
  store.on("reset", clearAll);
  store.on("saved", flashSave);
  store.on("project:openResult", onOpenResult);
  // Live transcript search (v1 app.js:206-214): while a query is active, a new turn that changes a row's
  // match re-applies the filter — one row on an append, all rows on a bulk cache (re)load on connect.
  store.on("transcript:append", renderRow);   // a finalized agent turn updates the row preview (+ re-filters search)
  store.on("transcripts", () => { if (store.search.trim()) applyFilters(); });
  store.on("session:output", onOutput);   // E3: while searching, re-filter rows as output streams (preview no longer reads output)
  initNotificationToggle();
  const promptsBtn = document.getElementById("prompts-btn");   // the library now lives in the footer app menu
  if (promptsBtn) promptsBtn.onclick = (e) => { e.stopPropagation(); openPromptLibrary(); };
  // engine rejected a rename (race / cross-client) — re-surface the in-row editor with the rejected name + error.
  store.on("session:renameRejected", (id, name) => startRowRename(id, { value: name, error: "That name is already taken — choose another." }));
  // engine rejected a create (duplicate name) — re-open the new-session picker with the typed values + inline error.
  store.on("session:createRejected", onCreateRejected);
  // engine rejected a move (name collision in the target project, or the project vanished) — the row stays put.
  store.on("session:setProjectRejected", onSetProjectRejected);
  // a restart respawn failed — the store already flipped the row dormant; surface why.
  store.on("session:restartFailed", (id, msg) => toast.error({ id: "restart:" + id, title: "Restart failed", body: msg || "The session could not be restarted." }));
  // config.projects changed (create / rename / recolour / reorder / delete cascade) → reconcile project groups.
  store.on("config", reconcileProjects);
  store.on("config", () => { refreshFaces(); if (pickerRefresh) pickerRefresh(); });   // faces + picker visibility follow config immediately
  document.getElementById("proj-btn").onclick = (e) => {
    e.stopPropagation();
    openProjectCreator(e.currentTarget, { pointerReturnFocus: terminalFocusTarget(), sourceEvent: e });
  };
  document.getElementById("settings-btn").onclick = (e) => { e.stopPropagation(); openSettings(); };
  store.on("availability", () => { if (pickerRefresh) pickerRefresh(); });   // agent health changed while the picker is open → re-render its rows
  store.on("stale", renderEngineBanner);   // outdated/unreachable engine → a self-explaining banner (ws.js drives it)
  initDrag(listEl);   // session→project / project reorder drag-and-drop

  reconcileProjects();
  renderChrome();
  // Dormant rows age too — their slot is a real timestamp now, not the word "asleep", so it must keep up.
  setInterval(() => { for (const [id, r] of rows) { const s = store.sessions.get(id); if (!s) continue;
    r.time.textContent = s.live === false ? (s.lastActive ? relTime(s.lastActive) : "") : relTimeShort(s.lastActivity); } }, 30000);
}

function setFilter(f) { store.setFilter(f); }

// ── groups: one per PROJECT (config order) + one per ungrouped cwd ───────────────
// Project groups are driven by config.projects (they render even when empty, as drop targets, and are never
// auto-removed on empty). Cwd groups are driven by sessions (created lazily, removed when their last row leaves).
function createGroup(key, kind, meta) {
  const isPrev = kind === "previous";
  const root = h("div", "project" + (kind === "project" ? " is-project" : isPrev ? " is-previous" : ""));
  root.dataset.groupKey = key;
  if (kind === "project") root.dataset.projectId = meta.projectId;
  const head = h("div", "group-head");
  const chev = h("span", "chev");
  const dot = h("span", "group-dot");        // colour dot — CSS shows it only for project groups
  const name = h("div", "group-name");
  if (isPrev) name.textContent = "Previous Sessions";   // §E: set like sibling groups (textContent); CSS uppercases it
  const count = h("span", "group-count", "0");
  const actions = h("div", "g-actions");
  const folderBtn = h("button", "g-icon", FOLDER_ICON); folderBtn.type = "button";
  folderBtn.title = "Open folder"; folderBtn.setAttribute("aria-label", "Open folder");
  const gmenuBtn = h("button", "g-icon", DOTS_ICON); gmenuBtn.type = "button"; gmenuBtn.title = kind === "project" ? "Project actions" : isPrev ? "Dormant actions" : "Group actions";
  gmenuBtn.setAttribute("aria-haspopup", "menu"); gmenuBtn.setAttribute("aria-label", gmenuBtn.title); gmenuBtn.setAttribute("aria-expanded", "false");
  const wrap = h("div", "new-wrap");
  const plus = h("button", "new-btn sm", "+"); plus.title = "New session here";
  wrap.appendChild(plus);
  if (isPrev) actions.append(gmenuBtn);                 // no folder / + on the graveyard — just Clear dormant
  else actions.append(folderBtn, gmenuBtn, wrap);
  head.append(chev, dot, name, count, actions);
  const rowsEl = h("div", "rows");
  root.append(head, rowsEl);
  const g = { root, head, name, count, dot, rowsEl, ids: new Set(), kind, cwd: meta.cwd || "", projectId: meta.projectId || null, seq: groupSeq++ };
  // click a header → collapse, unless it started a drag or hit a control
  head.onclick = (e) => { if (actions.contains(e.target) || wasDragging()) return; toggleCollapse(key); };
  plus.onclick = (e) => {
    e.stopPropagation();
    if (pickerHandle && pickerCtx && pickerCtx.anchor === plus) { hidePicker(); return; }
    openPicker(plus, plusMode(g), { sourceEvent: e });
  };
  folderBtn.onclick = (e) => { e.stopPropagation(); openProject(g.kind === "project" ? (projectById(g.projectId) || {}).path || "" : g.cwd); };
  gmenuBtn.onclick = (e) => { e.stopPropagation(); toggleGroupMenu(key, gmenuBtn, e); };
  if (kind === "project") name.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); startProjectRename(g.projectId); });
  groups.set(key, g);
  // Previous Sessions always sits last: prev inserts before the empty slot; every other group inserts above prev.
  const prevG = !isPrev && groups.get("prev");
  listEl.insertBefore(root, prevG ? prevG.root : document.getElementById("list-empty"));
  if (kind === "cwd" && collapsed.has(key)) { head.classList.add("collapsed"); rowsEl.classList.add("collapsed"); }   // project collapse comes from config (ensureProjectGroup)
  return g;
}
// What the group's + button spawns: a project group → into that project (cwd = its path); a cwd group → its cwd.
function plusMode(g) {
  if (g.kind === "project") { const p = projectById(g.projectId); return { cwd: (p && p.path) || undefined, projectId: g.projectId }; }
  return { cwd: g.cwd };
}
function ensureGroupFor(s) {
  const key = groupKeyOf(s);
  const existing = groups.get(key);
  if (existing) return existing;
  if (key === "prev") return createGroup("prev", "previous", {});   // §E: ungrouped dormant → Previous Sessions
  if (!s.projectId) return ensureCwdGroup(s.cwd || "");
  const p = projectById(s.projectId);
  return p ? ensureProjectGroup(p) : createGroup(key, "project", { projectId: s.projectId });   // config not in yet → reconcile fills meta
}
function ensureCwdGroup(cwd) {
  const key = "c:" + cwd;
  const g = groups.get(key) || createGroup(key, "cwd", { cwd });
  relabelGroups();
  return g;
}
function ensureProjectGroup(p) {                 // create if missing + refresh its meta (name/colour/path/collapse)
  const key = "p:" + p.id;
  const g = groups.get(key) || createGroup(key, "project", { projectId: p.id });
  g.dot.style.background = p.color || PROJECT_COLORS[0];
  if (renamingProjectId !== p.id) { g.name.textContent = p.name || "Project"; g.name.title = p.path || "(no folder)"; }
  const isCollapsed = !!p.collapsed;             // project collapse lives in config (v1 parity; syncs across clients)
  g.head.classList.toggle("collapsed", isCollapsed);
  g.rowsEl.classList.toggle("collapsed", isCollapsed);
  sortGroupRows(g);
  return g;
}
// A project keeps the order its sessions were dragged into (config project.sessionOrder, so every client agrees).
// Sessions it doesn't list yet — new ones — follow in arrival order. Only moves rows when the order changed.
function sortGroupRows(g) {
  if (g.kind !== "project") return;
  const order = (projectById(g.projectId) || {}).sessionOrder;
  if (!Array.isArray(order) || !order.length) return;
  const rank = new Map(order.map((id, i) => [id, i]));
  const current = [...g.rowsEl.children].filter((n) => n.dataset && n.dataset.id);
  const sorted = current.map((n, i) => [n, rank.has(n.dataset.id) ? rank.get(n.dataset.id) : order.length + i]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  if (sorted.every((n, i) => n === current[i])) return;
  for (const n of sorted) g.rowsEl.appendChild(n);
}
function removeGroupIfEmpty(key) {               // cwd + Previous groups — project groups persist as drop targets
  const g = groups.get(key);
  if (!g || (g.kind !== "cwd" && g.kind !== "previous") || g.ids.size) return;
  g.root.remove(); groups.delete(key); if (g.kind === "cwd") relabelGroups();
}
function forceRemoveGroup(key) {                 // a deleted project — its sessions are already closed by the cascade
  const g = groups.get(key); if (!g) return;
  for (const id of [...g.ids]) { const r = rows.get(id); if (r) { r.root.remove(); rows.delete(id); } }
  g.root.remove(); groups.delete(key);
}
function relabelGroups() {
  const cwds = [...groups.values()].filter((g) => g.kind === "cwd").map((g) => g.cwd);
  const labels = projectLabels(cwds);
  for (const g of groups.values()) if (g.kind === "cwd") { g.name.textContent = labels.get(g.cwd) || basename(g.cwd); g.name.title = g.cwd || "(default)"; }
}
// config.projects changed (create / rename / recolour / reorder / delete) → reconcile the project groups.
function reconcileProjects() {
  const projects = store.projects;
  const wanted = new Set(projects.map((p) => "p:" + p.id));
  for (const [key, g] of [...groups]) if (g.kind === "project" && !wanted.has(key)) forceRemoveGroup(key);
  for (const p of projects) ensureProjectGroup(p);
  reorderGroups();
  applyFilters();
}
// DOM order: project groups in config order, then cwd groups in creation order — both before the empty slot.
function reorderGroups() {
  const anchor = document.getElementById("list-empty");
  for (const p of store.projects) { const g = groups.get("p:" + p.id); if (g) listEl.insertBefore(g.root, anchor); }
  for (const g of [...groups.values()].filter((x) => x.kind === "cwd").sort((a, b) => a.seq - b.seq)) listEl.insertBefore(g.root, anchor);
  const prev = groups.get("prev"); if (prev) listEl.insertBefore(prev.root, anchor);   // §E: Previous Sessions always last
}
function toggleCollapse(key) {
  const g = groups.get(key); if (!g) return;
  const now = !g.head.classList.contains("collapsed");
  g.head.classList.toggle("collapsed", now);
  g.rowsEl.classList.toggle("collapsed", now);
  if (g.kind === "project") {   // v1 parity: project collapse persists to config (syncs across clients)
    const next = store.projects.map((p) => (p.id === g.projectId ? { ...p, collapsed: now } : p));
    store.setProjects(next); updateConfig({ projects: next });
  } else {                       // cwd groups are a v2-only concept → keep their collapse local (localStorage)
    if (now) collapsed.add(key); else collapsed.delete(key);
    saveCollapsed(collapsed);
  }
}
function loadCollapsed() { try { return new Set(JSON.parse(localStorage.getItem("clideck.collapsed") || "[]")); } catch { return new Set(); } }
function saveCollapsed(set) { try { localStorage.setItem("clideck.collapsed", JSON.stringify([...set])); } catch {} }

// ── group menus + dormant operations (keyed by groupKey; project groups get the full Color/Rename/Delete set) ──
function groupLabel(key) { const g = groups.get(key); return (g && g.name.textContent) || "group"; }
function dormantIdsIn(key) {
  const g = groups.get(key); if (!g) return [];
  return [...g.ids].filter((id) => { const s = store.sessions.get(id); return s && s.live === false; });
}
// The dormant-ops trio, shared by cwd and project menus.
function dormantItems(key) {
  const n = dormantIdsIn(key).length;
  return [
    { label: "Start all dormant", disabled: !n, onSelect: (c) => { c.close(); startAllDormant(key); } },
    { label: "Clear dormant", danger: true, disabled: !n, onSelect: (c) => c.replace(clearConfirmItems(key)) },
  ];
}
function cwdMenuItems(key) {
  const g = groups.get(key);
  return [
    { label: "Open folder", onSelect: (c) => { c.close(); openProject(g ? g.cwd : ""); } },
    { separator: true },
    ...dormantItems(key),
  ];
}
// Previous Sessions (§E): just the dormant-clear flow (a count-confirm) — the graveyard has no folder/spawn.
function previousMenuItems(key) {
  const n = dormantIdsIn(key).length;
  return [
    { label: "Clear dormant", danger: true, disabled: !n, onSelect: (c) => c.replace(clearConfirmItems(key)) },
  ];
}
// A live colour strip + Rename + folder/dormant ops + a confirming Delete (engine cascades the sessions).
function projectMenuItems(key) {
  const g = groups.get(key); const p = g && projectById(g.projectId);
  if (!p) return cwdMenuItems(key);
  return [
    { render: (ctl) => swatchStrip(p, ctl) },
    { separator: true },
    { label: "Rename", onSelect: (c) => { c.close(); startProjectRename(p.id); } },
    { label: "Open folder", disabled: !p.path, onSelect: (c) => { c.close(); openProject(p.path); } },
    ...dormantItems(key),
    { separator: true },
    { label: "Delete project", danger: true, onSelect: (c) => c.replace(projectDeleteConfirm(key)) },
  ];
}
function swatchStrip(p, ctl) {
  const wrap = h("div", "gm-swatches");
  for (const c of PROJECT_COLORS) {
    const b = h("button", "gm-swatch" + (p.color === c ? " sel" : "")); b.type = "button";
    b.style.background = c; b.title = c; b.setAttribute("aria-label", "Set project colour " + c);
    b.addEventListener("click", () => { setProjectColor(p.id, c); ctl.close(); });
    wrap.appendChild(b);
  }
  return wrap;
}
function projectDeleteConfirm(key) {
  const g = groups.get(key); const p = g && projectById(g.projectId);
  const active = p ? [...store.sessions.values()].filter((s) => s.projectId === p.id && s.live !== false).length : 0;
  const warn = active ? `Delete "${p.name}"? Closes ${active} active session${active === 1 ? "" : "s"}.` : (p ? `Delete project "${p.name}"?` : "Delete project?");
  return [
    { label: warn, caption: true },
    { label: "Cancel", onSelect: (c) => c.replace(projectMenuItems(key)) },
    { label: "Delete project", danger: true, onSelect: (c) => { c.close(); if (p) deleteProject(p.id); } },
  ];
}
function clearConfirmItems(key) {
  const n = dormantIdsIn(key).length;
  const g = groups.get(key), back = g && g.kind === "project" ? projectMenuItems : g && g.kind === "previous" ? previousMenuItems : cwdMenuItems;
  return [
    { label: `Clear ${n} dormant session${n === 1 ? "" : "s"}?`, caption: true },
    { label: "Cancel", onSelect: (c) => c.replace(back(key)) },
    { label: "Clear", danger: true, onSelect: (c) => { c.close(); clearDormant(key); } },
  ];
}
function actionItems(actions) {
  return actions.map((action) => ({ label: action.label, onSelect: (ctl) => { ctl.close(); runAction(action, action.context); } }));
}
function sessionContext(s, surface, selection = "") {
  const project = s && s.projectId ? projectById(s.projectId) : null;
  return { surface, selection: { text: String(selection || ""), surface }, session: s ? { id: s.id, name: s.name || "", provider: s.provider || "", cwd: s.cwd || "", projectId: s.projectId || null, live: s.live !== false, status: s.status || "" } : null, project };
}
async function toggleGroupMenu(key, btn, sourceEvent) {
  if (btn.getAttribute("aria-expanded") === "true") { closeMenu(); return; }
  const g = groups.get(key); if (!g) return;
  btn.setAttribute("aria-expanded", "true");
  let items = g.kind === "project" ? projectMenuItems(key) : g.kind === "previous" ? previousMenuItems(key) : cwdMenuItems(key);
  if (g.kind === "project" && hasActions("project.menu")) {
    const project = projectById(g.projectId);
    const actions = await resolveActions("project.menu", { surface: "project", selection: { text: "", surface: "project" }, session: null, project });
    if (btn.getAttribute("aria-expanded") !== "true" || groups.get(key) !== g) return;
    if (actions.length) items = [...actionItems(actions), { separator: true }, ...items];
  }
  openMenu(btn, items, {
    align: "end", returnFocus: btn, pointerReturnFocus: terminalFocusTarget(), sourceEvent,
    onClose: () => btn.setAttribute("aria-expanded", "false"),
  });
}

// Optimistic project mutations (recolour / rename) — write the new array locally (instant re-render via the
// config listener) then persist; the engine echoes {type:'config'} to re-affirm.
function setProjectColor(id, color) {
  const next = store.projects.map((p) => (p.id === id ? { ...p, color } : p));
  store.setProjects(next); updateConfig({ projects: next });
}
function startProjectRename(id) {
  const g = groups.get("p:" + id), p = projectById(id);
  if (!g || !p || renamingProjectId === id) return;
  renamingProjectId = id;
  g.head.classList.add("renaming");
  inlineRename(g.name, {
    value: p.name || "", placeholder: "Project name",
    onCommit: (name) => { const next = store.projects.map((x) => (x.id === id ? { ...x, name } : x)); store.setProjects(next); updateConfig({ projects: next }); },
    onEnd: () => { renamingProjectId = null; g.head.classList.remove("renaming"); const cur = projectById(id); if (cur) ensureProjectGroup(cur); },
  });
}

// Resume every dormant session in the group, staggered 1s so the engine isn't hit all at once; one same-id
// toast tracks progress and auto-dismisses on the last one. Ids that woke up meanwhile are skipped (v1 app.js:628-637).
function startAllDormant(key) {
  const ids = dormantIdsIn(key);
  if (!ids.length) return;
  const label = groupLabel(key), total = ids.length, tid = "start-all:" + key;
  let done = 0;
  const progress = () => toast.info({ id: tid, title: "Resuming " + label, body: done + " / " + total + " resumed", duration: done >= total ? 2600 : 0 });
  progress();
  ids.forEach((id, i) => setTimeout(() => {
    const s = store.sessions.get(id);
    if (s && s.live === false) resumeSession(id);     // skip anything that woke up in the meantime
    done++; progress();
  }, i * 1000));
}
function clearDormant(key) {
  const ids = dormantIdsIn(key);
  if (!ids.length) return;
  ids.forEach((id) => closeSession(id));              // engine removes the persisted entry → session.closed (v1 app.js:729-758)
  toast.info({ id: "clear:" + key, title: "Cleared", body: ids.length + " dormant session" + (ids.length === 1 ? "" : "s") + " removed" });
}
// Open-folder result is requester-only: on failure the engine flags fallback:'copy' → copy the path + toast (v1 app.js:294-318).
function onOpenResult(res) {
  if (!res || res.success) return;                    // success = the OS opened it; the folder appearing is the feedback
  copyText(res.cwd || "");
  toast.info({ id: "open-folder", title: "Path copied", body: "`" + (res.cwd || "") + "`", markdown: true });
}
// A session move was refused (name collision in the target project, or the project vanished). The engine
// re-broadcast the UNCHANGED snapshot, so the row never moved — surface the reason and leave it be.
function onSetProjectRejected(id, err) {
  const s = store.sessions.get(id);
  const msg = err && err.code === "unknown_project"
    ? (err.message || "That project no longer exists.")
    : `A session named "${(err && err.value) || (s && s.name) || shortId(id)}" already exists in that project.`;
  toast.error({ id: "setproject:" + id, title: "Couldn't move session", body: msg });
}

// ── rows ───────────────────────────────────────────────────────────────────────
// Row name markup — the avatar already identifies a named session's provider, so don't repeat it.
// Unnamed legacy sessions keep provider · shortId as a useful fallback.
// Used by addRow AND renderRow so a rename (store update) refreshes the row in place.
function rowNameHtml(s, id) {
  const p = sessionFace(s);   // §A: custom-command sessions read their command label
  return s.name
    ? esc(limitSessionName(s.name))
    : esc(p.label) + ' <span>· ' + esc(shortId(id)) + "</span>";
}
// Rebuild a row's avatar mark/tint when its face changes (config.commands loaded after the row, or an icon edit).
function applyFace(r, s) {
  const f = sessionFace(s);
  if (r.faceSig === f.sig) return;
  r.faceSig = f.sig;
  r.avatar.className = "avatar " + f.cls;
  r.avatar.replaceChildren(f.mark(), r.presence);   // keep the same presence node (renderRow drives its state)
}
function refreshFaces() { for (const [id, r] of rows) { const s = store.sessions.get(id); if (s) applyFace(r, s); } }
// ▾ per-session menu (Copy/Paste · Rename · Copy @address · Restart · Delete). Second click on the same
// ▾ closes it; aria-expanded doubles as the open flag. Copy needs the live terminal selection (only the
// active session has one); Rename opens the in-row editor.
async function toggleRowMenu(id, btn, sourceEvent) {
  if (btn.getAttribute("aria-expanded") === "true") { closeMenu(); return; }
  btn.setAttribute("aria-expanded", "true");
  const s = store.sessions.get(id);
  const selection = id === store.activeId ? terminalSelection() : "";
  const actions = s && hasActions("session.menu") ? await resolveActions("session.menu", sessionContext(s, "session", selection)) : [];
  if (btn.getAttribute("aria-expanded") !== "true" || store.sessions.get(id) !== s) return;
  openSessionMenu(btn, id, {
    align: "end",
    returnFocus: btn,
    pointerReturnFocus: terminalFocusTarget(),
    sourceEvent,
    selection,
    live: !s || s.live !== false,
    muted: !!(s && s.muted),
    pluginItems: actionItems(actions),
    onRename: () => startRowRename(id),
    onClose: () => btn.setAttribute("aria-expanded", "false"),
  });
}

// In-row inline rename (double-click name, or ▾ Rename). Shares inlineRename with the header, so
// Enter/Esc/blur/empty-revert + live per-project duplicate validation behave identically. The rose error
// (and a calm hint while valid) shows in the preview slot; renderRow is guarded so it won't clobber the edit.
function startRowRename(id, prefill) {
  if (renamingId === id) return;
  if (renamingId != null) endRowRename();
  const s = store.sessions.get(id), r = rows.get(id);
  if (!s || !r) return;
  renamingId = id;
  r.root.classList.add("renaming");
  rowRenameHandle = inlineRename(r.nameText, {
    value: limitSessionName((prefill && prefill.value) || s.name || ""),
    placeholder: "Name",
    maxLength: SESSION_NAME_MAX,
    initialError: prefill && prefill.error,
    validate: (name) => (store.isNameTaken({ cwd: s.cwd, projectId: s.projectId }, name, id) ? "This name is already taken in this project" : null),
    showError: (msg) => { r.ptext.textContent = msg || RENAME_HINT; r.preview.classList.toggle("rename-error", !!msg); },
    onCommit: (name) => renameSession(id, name),
    onEnd: () => { renamingId = null; rowRenameHandle = null; r.root.classList.remove("renaming"); r.preview.classList.remove("rename-error"); renderRow(id); },
  });
}
function endRowRename() { if (rowRenameHandle) rowRenameHandle.end(); }

// Row copy-ask-address (v1 terminals.js:52-66): copies exactly what /ask resolves (name || full id),
// with a premium in-place confirmation — the icon morphs to a sage check for a beat.
async function copyRowAddress(id, btn) {
  const s = store.sessions.get(id); if (!s) return;
  const addr = askAddress(s, store.projects);   // @Project/name, or @cwd-group/name for ad-hoc sessions
  if (!(await copyText(addr))) return;
  btn.classList.add("copied"); btn.innerHTML = CHECK_ICON;   // inline sage-check stays; the toast composes with it
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = COPY_ICON; }, 1100);
  toast.success({ title: "Ask target copied", body: "`" + addr + "`", markdown: true, id: "copy-address" });
}
function addRow(id) {
  const s = store.sessions.get(id); if (!s) return;
  const key = groupKeyOf(s);
  const g = ensureGroupFor(s);
  const f = sessionFace(s);   // §A: provider mark, or a custom command's icon
  const root = h("div", "row"); root.dataset.id = id;
  root.onclick = () => { if (wasDragging()) return; store.select(id); };   // a drop must not also select
  const avatar = h("div", "avatar " + f.cls); avatar.appendChild(f.mark());
  const presence = h("span", "presence off"); avatar.appendChild(presence);
  const name = h("div", "r-name");
  const nameText = h("span", "r-name-text", rowNameHtml(s, id));
  const copyBtn = h("button", "r-name-btn r-copy-btn", COPY_ICON); copyBtn.type = "button";
  copyBtn.title = "Copy ask address"; copyBtn.setAttribute("aria-label", "Copy ask address");
  copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  copyBtn.addEventListener("click", (e) => { e.stopPropagation(); copyRowAddress(id, copyBtn); });
  const renameBtn = h("button", "r-name-btn r-rename-btn", PENCIL_ICON); renameBtn.type = "button";
  renameBtn.title = "Rename session"; renameBtn.setAttribute("aria-label", "Rename session");
  renameBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  renameBtn.addEventListener("click", (e) => { e.stopPropagation(); startRowRename(id); });
  nameText.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); startRowRename(id); });   // v1 app.js:480-485
  const muteIcon = h("span", "r-mute", MUTE_ICON); muteIcon.title = "Muted — no idle sound/notification";
  name.append(nameText, muteIcon, copyBtn, renameBtn);
  const time = h("div", "r-time", "now");
  const preview = h("div", "r-preview");
  const bounce = h("span", "r-bounce");            // working animation slot (empty ⇒ collapsed); ptext owns the ellipsis
  const ptext = h("span", "r-ptext", "starting…");
  preview.append(bounce, ptext);
  const badge = h("div", "r-badge", ""); badge.style.display = "none";
  const actions = h("div", "r-actions"); actions.style.display = "none";   // dormant-only: Resume (delete lives in the ▾ menu)
  const resume = h("button", "r-resume-btn", "Resume" + ARROW_ICON); resume.title = "Resume this session";
  resume.onclick = (e) => { e.stopPropagation(); store.select(id); resumeSession(id); };
  actions.append(resume);
  const menuBtn = h("button", "r-menu-btn", CHEVRON); menuBtn.type = "button"; menuBtn.title = "Session menu";
  menuBtn.setAttribute("aria-haspopup", "menu"); menuBtn.setAttribute("aria-label", "Session menu"); menuBtn.setAttribute("aria-expanded", "false");
  menuBtn.addEventListener("mousedown", (e) => e.stopPropagation());                    // don't select the row / trip outside-close
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleRowMenu(id, menuBtn, e); });
  root.append(avatar, name, time, preview, badge, actions, menuBtn);
  g.rowsEl.appendChild(root);
  g.ids.add(id);
  sortGroupRows(g);
  rows.set(id, { root, avatar, presence, name, nameText, copyBtn, time, preview, bounce, ptext, badge, actions, groupKey: key, faceSig: f.sig, stopBounce: null });
  root.classList.toggle("muted", !!s.muted);
  g.count.textContent = g.ids.size;
  renderRow(id);
}
// Mount/unmount the working animation for a row. Idempotent — a re-render while already working keeps the
// balls bouncing (restarting them every session:update would freeze the animation into a stutter).
function setBounce(r, on) {
  if (on === !!r.stopBounce) return;
  if (on) r.stopBounce = startBounce(r.bounce);
  else { r.stopBounce(); r.stopBounce = null; }
}

function removeRow(id) {
  const r = rows.get(id); if (!r) return;
  setBounce(r, false);            // release the frame — a removed row must never keep ticking
  r.root.remove(); rows.delete(id);
  const g = groups.get(r.groupKey);
  if (g) { g.ids.delete(id); g.count.textContent = g.ids.size; removeGroupIfEmpty(r.groupKey); }
}
// A session moved project (setProject re-broadcast) → reparent its row into the right group in place.
function moveRowToGroup(id) {
  const r = rows.get(id), s = store.sessions.get(id);
  if (!r || !s) return;
  const newKey = groupKeyOf(s);
  if (r.groupKey === newKey) return;
  const oldKey = r.groupKey;
  const g = ensureGroupFor(s);
  g.rowsEl.appendChild(r.root); g.ids.add(id); g.count.textContent = g.ids.size;
  sortGroupRows(g);
  r.groupKey = newKey;
  const og = groups.get(oldKey);
  if (og) { og.ids.delete(id); og.count.textContent = og.ids.size; removeGroupIfEmpty(oldKey); }
}
function clearAll() {
  for (const r of rows.values()) setBounce(r, false);   // a reconnect wipe must not orphan running animations
  for (const g of groups.values()) g.root.remove();
  groups.clear(); rows.clear(); groupSeq = 0;
}

// A session's cwd as a compact path (home → ~), or "". The calm, stable subtitle for a row with no agent
// message (shells, dormant) — used instead of the live terminal tail, which the user's typing can corrupt.
function cwdPath(s) { return (s.cwd || "").replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "~"); }

function renderRow(id) {
  const r = rows.get(id); const s = store.sessions.get(id);
  if (!r || !s) return;
  if (r.groupKey !== groupKeyOf(s)) moveRowToGroup(id);     // project changed (setProject) / live↔dormant → reparent in place
  applyFace(r, s);                                          // §A: refresh the avatar if the command icon resolved/changed
  const editing = renamingId === id;                        // an inline rename is open on this row
  if (!editing) {
    r.nameText.innerHTML = rowNameHtml(s, id);               // refresh name so a rename / rebroadcast shows up
    r.nameText.title = s.name || sessionFace(s).label;
  }
  const dormant = s.live === false;
  r.root.classList.toggle("dormant", dormant);
  r.root.classList.toggle("active", store.activeId === id);
  r.root.classList.toggle("muted", !!s.muted);
  if (dormant) {   // asleep: zzz presence, last transcript line, Resume — no state signals
    if (r.presence.className !== "presence sleep") r.presence.className = "presence sleep";
    r.root.classList.remove("needs", "working", "is-idle", "unread");
    setBounce(r, false);   // asleep never animates
    if (!editing) { r.ptext.textContent = firstLine(s.lastAgentMessage) || firstLine(s.latestAgent) || cwdPath(s) || "Asleep — history preserved"; r.preview.classList.remove("live"); }
    r.badge.style.display = "none";
    r.actions.style.display = "";
    // "asleep" restated what the row already says (dimmed, zzz dot, Resume). The slot above Resume now
    // carries when the session was last active — and stays EMPTY rather than lying if the engine sent no
    // stamp, because a client-stamped time would read "now" for a session that has slept for a week.
    r.time.textContent = s.lastActive ? relTime(s.lastActive) : "";
    applyVisibility(id);
    return;
  }
  r.actions.style.display = "none";
  const pres = "presence " + (s.closed ? "off" : s.attention ? "attention" : s.status === "working" ? "working" : "idle");
  if (r.presence.className !== pres) r.presence.className = pres;   // guard: don't restart the pulse
  r.root.classList.toggle("needs", s.attention);
  r.root.classList.toggle("working", !s.attention && s.status === "working");
  r.root.classList.toggle("is-idle", !s.attention && s.status !== "working");
  r.root.classList.toggle("unread", s.unread > 0 && !s.attention);
  if (!editing) {   // preview slot is on loan to the rename hint/error while editing
    let prev, live = false;
    // Preview source is the agent's message, never the live terminal tail — so deletes/pastes/keystrokes at the
    // prompt can't corrupt what the panel shows. Working → the live agent line; idle → the finalized last message.
    if (s.attention) prev = firstLine(s.menuContext) || "Waiting on your approval";
    else if (s.status === "working") { prev = firstLine(s.latestAgent) || firstLine(s.lastAgentMessage) || "working…"; live = true; }
    else prev = firstLine(s.lastAgentMessage) || firstLine(s.latestAgent) || cwdPath(s) || (s.status ? "ready" : "starting…");
    r.ptext.textContent = prev; r.preview.classList.toggle("live", live);
  }
  // The balls ARE the working signal (v1's language). Not while needs-you (that's blocked, not thinking) and
  // not mid-rename, when the preview slot is on loan to the hint/error.
  setBounce(r, !editing && !s.attention && s.status === "working");
  if (s.unread > 0 && !s.attention) { r.badge.style.display = ""; r.badge.textContent = s.unread > 9 ? "9+" : String(s.unread); }
  else r.badge.style.display = "none";
  r.time.textContent = relTimeShort(s.lastActivity);
  applyVisibility(id);
}

// Raw output NO LONGER drives the row preview — that made the panel show the user's own typing/deletes/pastes
// (the terminal tail is a live editing surface). The preview now comes only from the agent's message (renderRow).
// This handler is E3-only: while a search query is active, streaming output may change a row's match, so re-test
// its visibility (coalesced so a burst of chunks costs one pass).
const searchDirty = new Set();
let outTimer = null;
function onOutput(id) {
  if (!store.search.trim()) return;
  const r = rows.get(id), s = store.sessions.get(id);
  if (!r || !s || s.live === false) return;
  searchDirty.add(id);
  if (!outTimer) outTimer = setTimeout(flushOut, 120);
}
function flushOut() {
  outTimer = null;
  for (const id of searchDirty) applyVisibility(id);   // re-test the row against the active query (incl. output haystack)
  searchDirty.clear();
}

// ── search / filter across groups ────────────────────────────────────────────
function rowMatches(id) {
  const s = store.sessions.get(id); if (!s) return false;
  const q = store.search.trim().toLowerCase();
  const g = groups.get(groupKeyOf(s));
  const label = g ? g.name.textContent : "";   // project name or cwd label — both searchable
  const hay = (sessionFace(s).terms + " " + shortId(id) + " " + (s.name || "") + " " + label + " " + (s.cwd || "") + " " + firstLine(s.latestAgent) + " " + firstLine(s.menuContext)).toLowerCase();
  // transcript text (already lowercased + capped in the store) makes past turns findable — live AND dormant (v1 terminals.js:1329-1349)
  // outputSearchText adds the ANSI-stripped raw output tail so shell sessions + mid-turn agent output are searchable too (E3, v1 parity)
  const okSearch = !q || hay.includes(q) || store.transcriptText(id).includes(q) || store.outputSearchText(id).includes(q);
  const okFilter = store.filter === "all" || s.unread > 0;
  return okSearch && okFilter;
}
function applyVisibility(id) {
  const r = rows.get(id); const s = store.sessions.get(id);
  if (!r || !s) return;
  r.root.style.display = rowMatches(id) ? "" : "none";
  const g = groups.get(groupKeyOf(s)); if (g) updateGroupVisibility(g);
}
function updateGroupVisibility(g) {
  let vis = 0; for (const id of g.ids) if (rowMatches(id)) vis++;
  if (g.kind === "project" && !g.ids.size) {   // empty project group stays visible as a drop target (hidden under Unread / a non-matching search)
    const q = store.search.trim().toLowerCase();
    const nameHit = !q || (g.name.textContent + " " + (g.name.title || "")).toLowerCase().includes(q);
    g.root.style.display = (store.filter === "all" && nameHit) ? "" : "none";
    return;
  }
  g.root.style.display = vis ? "" : "none";
}
function applyFilters() {
  for (const id of rows.keys()) { const r = rows.get(id); if (r) r.root.style.display = rowMatches(id) ? "" : "none"; }
  for (const g of groups.values()) updateGroupVisibility(g);
  renderTabs();
}

function renderTabs() {
  document.getElementById("tab-all").classList.toggle("on", store.filter === "all");
  document.getElementById("tab-unread").classList.toggle("on", store.filter === "unread");
}

// Save indicator (v1 app.js:1141-1167): brief spinner → sage tick flash on sessions.saved; no-op offline,
// rose flash on a save error. The engine-status home is the footer, next to the conn dot.
let saveT = null;
function flashSave(ok, err) {
  const el = document.getElementById("save-ind");
  if (!el || !store.connected) return;                    // no-op while offline (conn dot already shows it)
  clearTimeout(saveT);
  el.className = "save-ind saving";
  el.title = "Saving sessions…";
  saveT = setTimeout(() => {
    el.className = "save-ind " + (ok ? "saved" : "error");
    el.title = ok ? "Sessions saved" : "Save failed" + (err ? " — " + err : "");
    saveT = setTimeout(() => { el.className = "save-ind"; }, ok ? 2400 : 4200);
  }, 420);
}

// The stale/outdated-engine banner (item 7): shown when ws.js gives up on a churning socket. The last UI stays
// rendered underneath; the banner explains what to do. Cleared when a healthy connection is re-established.
function renderEngineBanner(on, msg) {
  const b = document.getElementById("engine-banner"); if (!b) return;
  b.hidden = !on;
  if (on) { const t = document.getElementById("engine-banner-text"); if (t) t.textContent = msg; }
}

// ⚠️ THIS WAS Or'S OWN NAME, HARDCODED IN index.html, AND NOTHING EVER REPAINTED IT — every user of a released
// build would have read "Or · local" in their own sidebar. Found in the 09-10 release check. The name is the
// About me profile's when the user has given one, and "You" until then: this footer is a label, not a claim
// about identity, so an unfilled profile gets a neutral word rather than a blank gap.
function renderIdentity() {
  const foot = document.querySelector(".side-foot");
  const who = foot && foot.querySelector(".who"), av = foot && foot.querySelector(".av");
  if (!who || !av) return;
  const name = String((store.about && store.about.name) || "").trim() || "You";
  // "· local" is about the engine, not the person; it is the part that steps aside on a narrow sidebar.
  const where = document.createElement("span"); where.className = "who-where"; where.textContent = " · local";
  who.replaceChildren(document.createTextNode(name), where);
  av.textContent = name.slice(0, 1).toLowerCase();
}

function renderChrome() {
  const total = store.sessions.size;
  const unread = store.unreadSessions();
  const cnt = document.getElementById("unread-cnt");
  cnt.textContent = unread; cnt.classList.toggle("zero", unread === 0);
  renderTabs();
  const le = document.getElementById("list-empty");
  if (!store.connected) { le.style.display = ""; le.textContent = "Engine offline — reconnecting…"; }
  else if (!total) { le.style.display = ""; le.textContent = "No sessions yet. Press + to start one."; }
  else le.style.display = "none";
  document.getElementById("conn").classList.toggle("down", !store.connected);
  // One word each side, and the SAME word the product already uses for the thing being reported — a session is
  // live or dormant, the engine is live or offline. "engine live" also restated the subject the dot already
  // stands for, in a footer whose whole job is to be glanceable.
  document.getElementById("conn-text").textContent = store.connected ? "live" : "offline";
  const si = document.getElementById("save-ind");   // §E: offline → a calm 'queued' affordance + tooltip (pairs with the send-queue)
  if (si) {
    if (!store.connected) { clearTimeout(saveT); si.className = "save-ind offline"; si.title = "Engine offline. Changes queue until it reconnects."; }
    else if (si.classList.contains("offline")) { si.className = "save-ind"; si.title = "Sessions saved"; }
  }
}

// ── new-session picker (shared): global + follows v1's project → name → agent flow. Choosing "None"
// exposes an ad-hoc working directory; a project selection always uses that project's configured path.
// A project group's own + stays shorter because its project/cwd are already known.
let pickerHandle = null;    // open menu handle (null when closed)
let pickerCtx = null;       // { anchor, mode } of the open picker — for same-button toggle + reject re-open
let pickerRefresh = null;   // re-renders the open picker's provider rows on an availability change (else null)
let pendingCreate = null;   // last submitted create — kept so a name-conflict reject can re-open with its values + error
const NO_PROJECT = "__none__";
const PATH_PLACEHOLDER = "path/to/folder — blank = default";

// Provider options in MRU order — the recently-used one floats to the front tagged "recent"; the engine
// default keeps its "default" tag. Rebuilt on each open so it tracks the latest MRU. onSpawn(provider, commandId).
function renderProviderOpts(box, onSpawn) {
  box.replaceChildren();
  const mru = mruProvider();
  const avail = store.availability;
  let count = 0;
  for (const p of providerOrder()) {
    const health = providerHealth(p.id, avail && avail.providers.get(p.id));   // §L: dim missing/outdated agents
    const missing = health.state === "missing" || health.state === "outdated";
    const opt = h("div", "pv-opt " + p.cls + (missing ? " pv-missing" : ""));
    const mini = h("div", "mini"); mini.appendChild(p.mark()); opt.appendChild(mini);
    opt.appendChild(h("div", "lbl", esc(p.label) + "<small>" + esc(p.id) + "</small>"));
    if (missing) {   // not spawnable — offer the install/update command instead (v1 creator.js:68-96)
      const add = h("button", "pv-add", health.state === "outdated" ? "Update" : "Add"); add.type = "button";
      add.title = health.installCmd || "";
      add.addEventListener("mousedown", (e) => e.stopPropagation());
      add.addEventListener("click", (e) => { e.stopPropagation(); showInstallToast(p.label, health.installCmd); });
      opt.appendChild(add);
    } else {
      if (mru && p.id === mru) opt.appendChild(h("div", "def recent", "recent"));
      else if (p.id === DEFAULT_PROVIDER) opt.appendChild(h("div", "def", "default"));
      opt.onclick = () => onSpawn(p.id);
    }
    box.appendChild(opt); count++;
  }
  // Custom agents (config.commands) — enabled ones are spawnable straight from the picker, via commandId (§A/§M).
  for (const cmd of store.commands) {
    if (cmd.enabled === false) continue;
    const face = sessionFace({ commandId: cmd.id, commandLabel: cmd.label });
    const opt = h("div", "pv-opt " + face.cls);
    const mini = h("div", "mini"); mini.appendChild(face.mark()); opt.appendChild(mini);
    opt.appendChild(h("div", "lbl", esc(cmd.label || "Custom") + "<small>" + esc(cmd.command || "") + "</small>"));
    opt.onclick = () => onSpawn(null, cmd.id);
    box.appendChild(opt); count++;
  }
  if (!count) box.appendChild(h("div", "pv-empty", "No agents are shown. Enable one in Settings → CLI Agents."));
}
function showInstallToast(label, cmd) {
  if (!cmd) { toast.info({ id: "install", title: label, body: "This agent isn't installed." }); return; }
  toast.info({ id: "install", title: "Add " + label, body: "Run this to install:\n\n`" + cmd + "`", markdown: true, duration: 0 });
}

// The picker body = menu.js's single render() item, so its inputs receive typing/Enter and only Escape /
// outside-click / scroll dismiss it. opts: { errorMsg, rawName, rawPath, projectChoice, focusName }.
function buildPickerForm(ctl, mode, opts = {}) {
  const projectMode = !!(mode && mode.projectMode);
  const form = h("div", "pv-form" + (projectMode ? " pv-global" : ""));
  let projectSelect = null, pathInput = null, pathWrap = null;
  if (projectMode) {
    form.appendChild(h("div", "cap pv-title", "Start new session"));
    const projectWrap = h("div", "pv-project");
    projectWrap.appendChild(h("div", "cap", "Project"));
    projectSelect = h("select", "pv-project-select");
    const placeholder = h("option"); placeholder.value = ""; placeholder.textContent = "Select project"; placeholder.disabled = true;
    projectSelect.appendChild(placeholder);
    for (const p of [...store.projects].sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }))) {
      const opt = h("option"); opt.value = p.id; opt.textContent = p.name || basename(p.path) || "Project";
      projectSelect.appendChild(opt);
    }
    const none = h("option"); none.value = NO_PROJECT; none.textContent = "None (outside project hierarchy)";
    projectSelect.appendChild(none);
    projectSelect.value = opts.projectChoice || "";
    projectWrap.appendChild(projectSelect);
    form.appendChild(projectWrap);

    pathWrap = h("div", "pv-path");
    const pathCap = h("div", "cap", "Working directory");
    pathWrap.appendChild(pathCap);
    const pathRow = h("div", "pv-path-row");
    pathInput = h("input", "pv-path-input"); pathInput.placeholder = PATH_PLACEHOLDER; pathInput.spellcheck = false; pathInput.autocomplete = "off";
    // The configured Default working directory is VISIBLE here rather than applied silently at create time
    // (same fix as the project creator, fe7eeb4). A name-conflict re-open passes rawPath explicitly — possibly ""
    // — so honour it: a field the user deliberately cleared must stay cleared instead of re-prefilling.
    let ownPath = opts.rawPath != null ? opts.rawPath : (store.defaultCwd || "");
    pathInput.value = ownPath;
    pathInput.addEventListener("input", () => { if (!pathInput.readOnly) ownPath = pathInput.value; });
    const browseBtn = h("button", "pv-browse", FOLDER_ICON); browseBtn.type = "button"; browseBtn.title = "Browse folders"; browseBtn.setAttribute("aria-label", "Browse folders");
    browseBtn.addEventListener("click", (e) => {
      e.stopPropagation();   // folder picker flags body.cd-modal-open → this popover stays open behind it (menu.js modal-guard)
      openFolderPicker(pathInput.value.trim(), (p) => { pathInput.value = p; ownPath = p; }, () => setTimeout(() => pathInput.focus(), 0));
    });
    pathRow.append(pathInput, browseBtn);
    pathWrap.appendChild(pathRow);
    form.appendChild(pathWrap);
    // The row is never hidden: the user must always see WHERE the session will spawn. Picking a project shows that
    // project's folder read-only (spawnFromPicker uses project.path, so this only surfaces what already happens);
    // going back to None restores the user's own editable path.
    const syncPathRow = () => {
      const pid = projectSelect.value;
      const proj = pid && pid !== NO_PROJECT ? store.projects.find((p) => p.id === pid) : null;
      pathInput.readOnly = !!proj;
      pathInput.value = proj ? (proj.path || "") : ownPath;
      pathInput.placeholder = proj ? "" : PATH_PLACEHOLDER;   // "blank = default" is a lie for a project's fixed folder
      pathInput.title = proj ? "Set by the project — the session spawns in the project's folder" : "";
      pathCap.textContent = proj ? "Project folder" : "Working directory";   // short enough to stay on one line; matches the creator's caption
      browseBtn.disabled = !!proj;
    };
    syncPathRow();
    projectSelect.addEventListener("change", () => {
      syncPathRow();
      setTimeout(() => {
        const el = projectSelect.value === NO_PROJECT ? pathInput : nameInput;
        el.focus();
        if (el === pathInput && el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);   // append to the default, don't retype it
      }, 0);
    });
  }
  const nameWrap = h("div", "pv-name");
  nameWrap.appendChild(h("div", "cap", "Session name"));
  const nameInput = h("input", "pv-name-input"); nameInput.placeholder = "Name (optional)"; nameInput.spellcheck = false; nameInput.autocomplete = "off"; nameInput.maxLength = SESSION_NAME_MAX;
  nameInput.value = limitSessionName(opts.rawName || "");
  nameWrap.appendChild(nameInput);
  form.appendChild(nameWrap);
  const errEl = h("div", "pv-error"); errEl.textContent = opts.errorMsg || ""; errEl.style.display = opts.errorMsg ? "" : "none";   // rose inline error (v1 creator.js:232)
  form.appendChild(errEl);
  form.appendChild(h("div", "cap pv-cap", "Agent"));
  const optsEl = h("div", "pv-opts");
  form.appendChild(optsEl);

  const fields = { projectSelect, pathInput, nameInput, errEl };
  const onSpawn = (provider, commandId) => spawnFromPicker(ctl, mode, fields, provider, commandId);
  renderProviderOpts(optsEl, onSpawn);
  pickerRefresh = () => renderProviderOpts(optsEl, onSpawn);   // live-refresh on availability change while open
  for (const inp of [pathInput, nameInput].filter(Boolean)) {
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const choice = primaryAgent();
      if (choice) spawnFromPicker(ctl, mode, fields, choice.provider, choice.commandId);
      else { fields.errEl.textContent = "Show an agent in Settings → CLI Agents first."; fields.errEl.style.display = ""; }
    });
  }
  const focusEl = opts.focusName ? nameInput : (projectMode ? projectSelect : nameInput);
  setTimeout(() => { focusEl.focus(); if (opts.focusName) nameInput.select(); }, 0);
  return form;
}

function spawnFromPicker(ctl, mode, fields, provider, commandId) {
  const projectMode = !!(mode && mode.projectMode);
  let cwd = mode ? mode.cwd : undefined;
  let projectId = mode && mode.projectId;
  let projectChoice = "";
  if (projectMode) {
    projectChoice = fields.projectSelect.value;
    if (!projectChoice) {
      fields.errEl.textContent = "Choose a project, or choose None for an ad-hoc folder.";
      fields.errEl.style.display = "";
      fields.projectSelect.focus();
      return;
    }
    if (projectChoice === NO_PROJECT) {
      cwd = fields.pathInput.value.trim() || undefined;
      projectId = null;
    } else {
      const project = projectById(projectChoice);
      if (!project) {
        fields.errEl.textContent = "That project no longer exists.";
        fields.errEl.style.display = "";
        fields.projectSelect.focus();
        return;
      }
      cwd = project.path || undefined;
      projectId = project.id;
    }
  }
  const name = limitSessionName(fields.nameInput.value.trim()) || randomName();   // §L: a calm "Adjective Animal" default when none typed
  const anchor = pickerCtx && pickerCtx.anchor;
  createSession(provider, cwd, name, projectId, commandId);   // project group's + spawns straight into it
  if (provider) { try { localStorage.setItem(MRU_KEY, provider); } catch {} }   // §L: MRU tracks built-ins only
  pendingCreate = { anchor, mode, cwd: cwd || "", provider, commandId, rawName: fields.nameInput.value, rawPath: fields.pathInput ? fields.pathInput.value : "", projectChoice };
  ctl.close();   // success closes; a name-conflict re-opens via onCreateRejected
}
// Re-open a rejected create with its inputs intact. Name conflicts are broadcast;
// startup failures are sent only to the requesting client.
function onCreateRejected(msg, err) {
  const p = pendingCreate; if (!p) return;
  const nameConflict = err?.code === "name_conflict";
  if (nameConflict && String(err.cwd || "") !== String(p.cwd)) return;
  pendingCreate = null;
  toast.error({ title: nameConflict ? "Name taken" : err?.code === "folder_not_found" ? "Folder not found" : "Couldn't start session", body: msg,
    id: nameConflict ? "name-conflict" : "session-create", ...(nameConflict ? {} : { duration: 0 }) });
  if (!p.anchor || !p.anchor.isConnected) return;               // its + button is gone (group removed) — nothing to re-anchor
  openPicker(p.anchor, p.mode, { errorMsg: msg, rawName: p.rawName, rawPath: p.rawPath, projectChoice: p.projectChoice, focusName: nameConflict });
}
function openPicker(anchor, mode, opts = {}) {
  pendingCreate = null;
  checkAvailability();   // refresh agent health so missing/outdated render dimmed (§L)
  pickerCtx = { anchor, mode };
  pickerHandle = openMenu(anchor, [{ render: (ctl) => buildPickerForm(ctl, mode, opts) }], {
    align: "end", className: "menu-form", returnFocus: anchor,
    pointerReturnFocus: terminalFocusTarget(), sourceEvent: opts.sourceEvent,
    onClose: () => { pickerHandle = null; pickerCtx = null; pickerRefresh = null; },
  });
}
function hidePicker() { if (pickerHandle) pickerHandle.close(); }
function initGlobalPicker() {
  document.getElementById("new-btn").onclick = (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (pickerHandle && pickerCtx && pickerCtx.anchor === btn) { hidePicker(); return; }   // same + → toggle off
    openPicker(btn, { projectMode: true }, { sourceEvent: e });
  };
}

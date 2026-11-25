// Drag & drop for the sidebar (ported from v1 drag.js). Two gestures share one pointer pipeline:
//   • session row  → drop inside a PROJECT group: move to it and/or place it between its rows (order persists)
//   • project head → reorder among the other projects (an insertion line shows the drop slot)
// A 5px threshold separates a drag from a click; pointer-capture keeps the gesture even off-list; a ghost
// follows the pointer; holding it near the list's top/bottom edge (or past it) auto-scrolls the list so projects
// out of view can still be reached; and after a real drag the follow-up click is suppressed so a drop never
// selects/collapses.
// The store/config drive the actual re-render — drag only fires the intent (setSessionProject / config.update).
import { store } from "../store.js";
import { setSessionProject, updateConfig } from "../ws.js";

const DRAG_THRESHOLD = 5;
const EDGE = 48;            // px band inside the list's top/bottom edge where a drag starts auto-scrolling
const MAX_STEP = 18;        // px per frame at the very edge (and anywhere past it)
let listRef = null;         // the scrolling sidebar list
let ds = null;              // active drag state (or a pending one below threshold)
let suppressClick = false;  // set on a real drag end → the very next click is swallowed

// The sidebar's row/header click handlers call this first: true (once) right after a drag, so the drop
// doesn't also select the row or toggle the group.
export function wasDragging() {
  if (suppressClick) { suppressClick = false; return true; }
  return false;
}

export function initDrag(listEl) {
  listRef = listEl;
  listEl.addEventListener("pointerdown", onDown);
  listEl.addEventListener("pointermove", onMove);
  listEl.addEventListener("pointerup", onUp);
  listEl.addEventListener("pointercancel", onCancel);
}

function onDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest("button") || e.target.closest("input")) return;   // controls never start a drag

  // Project drag — grab by the project header (only when there's another project to reorder against). The
  // whole group dims, but the ghost is just the header so a tall project doesn't drag a giant card around.
  const head = e.target.closest(".project.is-project > .group-head");
  if (head) {
    if (document.querySelectorAll(".project.is-project").length <= 1) return;
    const group = head.closest(".project");
    beginPending("project", group, head, e, { projectId: group.dataset.projectId });
    return;
  }
  // Session drag — grab by the row.
  const row = e.target.closest(".row[data-id]");
  if (row) beginPending("session", row, row, e, { id: row.dataset.id });
}

function beginPending(mode, dragRow, ghostSrc, e, extra) {
  const rect = ghostSrc.getBoundingClientRect();
  ds = { mode, row: dragRow, ghostSrc, startX: e.clientX, startY: e.clientY, offsetY: e.clientY - rect.top,
    ghost: null, active: false, dropTarget: null, pointerId: e.pointerId, ...extra };
}

function onMove(e) {
  if (!ds) return;
  if (!ds.active) {
    if (Math.abs(e.clientX - ds.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - ds.startY) < DRAG_THRESHOLD) return;
    try { ds.row.setPointerCapture(ds.pointerId); } catch {}
    startDrag();
  }
  ds.x = e.clientX; ds.y = e.clientY;
  ds.ghost.style.top = (e.clientY - ds.offsetY) + "px";
  updateDropTarget();
}

function updateDropTarget() {
  if (ds.mode === "project") updateProjectDropTarget(ds.y);
  else updateSessionDropTarget(ds.x, ds.y);
}

// One frame loop for the whole drag: near an edge it scrolls (faster the deeper in), and whenever the list has
// scrolled — by this or by the wheel — the drop target is re-measured, since the groups moved under a still pointer.
function autoScroll() {
  if (!ds || !ds.active) return;
  const r = listRef.getBoundingClientRect();
  if (r.height > 0) {
    const edge = Math.min(EDGE, r.height / 4);
    const depth = ds.y < r.top + edge ? ds.y - (r.top + edge) : ds.y > r.bottom - edge ? ds.y - (r.bottom - edge) : 0;
    if (depth) listRef.scrollTop += Math.sign(depth) * Math.ceil(MAX_STEP * Math.min(1, Math.abs(depth) / edge));
    if (listRef.scrollTop !== ds.scrollTop) { ds.scrollTop = listRef.scrollTop; updateDropTarget(); }
  }
  ds.raf = requestAnimationFrame(autoScroll);
}

function onUp() {
  if (!ds) return;
  if (ds.active) endDrag();
  ds = null;
}
function onCancel() {
  if (ds && ds.active) cleanup();
  ds = null;
}

function startDrag() {
  ds.active = true;
  ds.row.classList.add("dragging");
  const r = ds.ghostSrc.getBoundingClientRect();
  const ghost = ds.ghostSrc.cloneNode(true);
  ghost.classList.add("drag-ghost"); ghost.classList.remove("dragging");
  ghost.style.top = (ds.startY - ds.offsetY) + "px";
  ghost.style.left = r.left + "px";
  ghost.style.width = r.width + "px";
  document.body.appendChild(ghost);
  ds.ghost = ghost;
  ds.scrollTop = listRef.scrollTop;
  ds.raf = requestAnimationFrame(autoScroll);
  if (ds.mode === "session") document.querySelectorAll(".project.is-project > .group-head").forEach((h) => h.classList.add("drop-target"));   // NOT 'drop-zone' — that's the file-drop veil (inset:0/opacity:0) and would make the headers vanish
}

// The whole project group is a drop target, while the compact header carries the visual highlight. Inside an
// open project an insertion line also marks the slot between its rows, so a session can be placed — within its
// own project (reorder) or as it moves into another one. The line is absolutely positioned in the rows box so it
// never shifts the rows it is measured against. Dropping outside an explicit project is a no-op: a drag must
// never silently manufacture a cwd group.
function updateSessionDropTarget(x, y) {
  document.querySelectorAll(".drop-highlight").forEach((el) => el.classList.remove("drop-highlight"));
  clearDropLine();
  ds.dropTarget = null;
  for (const group of document.querySelectorAll(".project.is-project")) {
    const rect = group.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const head = group.querySelector(":scope > .group-head");
      const rowsEl = group.querySelector(":scope > .rows");
      const same = group.dataset.projectId === (store.sessions.get(ds.id) || {}).projectId;
      const visible = rowsEl && !rowsEl.classList.contains("collapsed")
        ? [...rowsEl.querySelectorAll(":scope > .row[data-id]")].filter((r) => r.style.display !== "none") : [];
      let i = visible.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if (i < 0) i = visible.length;
      const before = visible[i] || null;
      // Back where it already is: nothing to do (its own project), so no line and no target.
      if (same && (before === ds.row || visible[i - 1] === ds.row)) return;
      if (same && !visible.length) return;
      if (!same) head.classList.add("drop-highlight");
      ds.dropTarget = { type: "project", projectId: group.dataset.projectId, beforeId: before ? before.dataset.id : null, placed: visible.length > 0 };
      if (visible.length) {
        const line = document.createElement("div");
        line.className = "session-drop-line";
        const ref = before || visible[visible.length - 1];
        line.style.top = (before ? ref.offsetTop - 2 : ref.offsetTop + ref.offsetHeight + 1) + "px";
        rowsEl.appendChild(line);
      }
      return;
    }
  }
}

// A project drops between other projects — the insertion line marks the slot (skips the two no-op slots).
function updateProjectDropTarget(y) {
  clearDropLine();
  ds.dropTarget = null;
  const groups = [...document.querySelectorAll(".project.is-project")];
  const dragIdx = groups.indexOf(ds.row);
  for (let i = 0; i <= groups.length; i++) {
    const prev = i > 0 ? groups[i - 1].getBoundingClientRect().bottom : -Infinity;
    const next = i < groups.length ? groups[i].getBoundingClientRect().top : Infinity;
    if (y >= prev && y < next) {
      if (i === dragIdx || i === dragIdx + 1) return;   // dropping back where it already is
      ds.dropTarget = { type: "reorder", insertBefore: i };
      const line = document.createElement("div");
      line.className = "project-drop-line";
      const ref = groups[i] || null;
      if (ref) ref.parentNode.insertBefore(line, ref);
      else groups[groups.length - 1].after(line);
      return;
    }
  }
}

function endDrag() {
  const target = ds.dropTarget;
  suppressClick = true;
  cleanup();
  if (!target) return;
  if (ds.mode === "session") {
    const s = store.sessions.get(ds.id);
    if (!s || target.type !== "project") return;
    if (target.placed) placeSession(ds.id, target.projectId, target.beforeId);
    if (s.projectId !== target.projectId) setSessionProject(ds.id, target.projectId);
  } else if (ds.mode === "project" && target.type === "reorder") {
    const projects = store.projects.slice();
    const from = projects.findIndex((p) => p.id === ds.projectId);
    if (from < 0) return;
    const [moved] = projects.splice(from, 1);
    let to = target.insertBefore;
    if (to > from) to -= 1;                              // indices shift after the removal
    projects.splice(to, 0, moved);
    store.setProjects(projects);                        // optimistic re-order → the sidebar re-sorts instantly
    updateConfig({ projects });                         // persist (engine echoes {type:'config'})
  }
}

// Saves the session's slot as the project's sessionOrder (config, so it persists and every client agrees):
// the project's current row order with this session moved before `beforeId` (or to the end).
function placeSession(id, projectId, beforeId) {
  const group = document.querySelector('.project.is-project[data-project-id="' + CSS.escape(projectId) + '"]');
  const ids = group ? [...group.querySelectorAll(":scope > .rows > .row[data-id]")].map((r) => r.dataset.id).filter((x) => x !== id) : [];
  const at = beforeId ? ids.indexOf(beforeId) : -1;
  ids.splice(at < 0 ? ids.length : at, 0, id);
  const projects = store.projects.map((p) => p.id === projectId ? { ...p, sessionOrder: ids }
    : Array.isArray(p.sessionOrder) && p.sessionOrder.includes(id) ? { ...p, sessionOrder: p.sessionOrder.filter((x) => x !== id) } : p);
  store.setProjects(projects);                        // optimistic: the sidebar re-sorts at once
  updateConfig({ projects });
}

function cleanup() {
  cancelAnimationFrame(ds.raf);
  if (ds.row) ds.row.classList.remove("dragging");
  if (ds.ghost) ds.ghost.remove();
  document.querySelectorAll(".drop-highlight, .drop-target").forEach((el) => el.classList.remove("drop-highlight", "drop-target"));
  clearDropLine();
}
function clearDropLine() { document.querySelectorAll(".project-drop-line, .session-drop-line").forEach((el) => el.remove()); }

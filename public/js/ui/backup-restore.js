// Backup combines server data with known browser preferences; Restore selects whole saved items.
import { h } from "../util.js";
import { store } from "../store.js";
import { send } from "../ws.js";
import { toast } from "./toast.js";

const KEYS = { "clideck.ctrlVPaste": "behavior", "clideck.theme": "appearance", "clideck.sidebarW": "appearance", "clideck.collapsed": "appearance", "clideck.mru-provider": "agents" };
const pickerKey = /^clideck\.picker\.[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}\.recent$/;
const sectionFor = (key) => KEYS[key] || (pickerKey.test(key) ? "plugins" : null);
let active = null, transferBusy = false;
export const isRestoreOpen = () => !!active;
export const isBackupBusy = () => transferBusy;

export function collectBrowserPrefs() {
  const prefs = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (sectionFor(key)) prefs[key] = localStorage.getItem(key);
  }
  return prefs;
}

export function applyBrowserPrefs(prefs, sections) {
  const selected = new Set(sections);
  for (const key of Object.keys(collectBrowserPrefs())) {
    if (selected.has(sectionFor(key))) localStorage.removeItem(key);
  }
  for (const [key, value] of Object.entries(prefs || {})) {
    if (selected.has(sectionFor(key)) && typeof value === "string") localStorage.setItem(key, value);
  }
}

// A reply on the SAME socket follows every flushed config write. Unrelated broadcasts cannot satisfy it.
export function savedConfigBarrier() {
  if (!store.connected) return Promise.reject(new Error("Reconnect before backing up or restoring."));
  return new Promise((resolve, reject) => {
    const requestId = "backup-" + crypto.randomUUID();
    const off = store.on("config", (event) => {
      if (event?.requestId !== requestId) return;
      clearTimeout(timer); off(); resolve();
    });
    const timer = setTimeout(() => { off(); reject(new Error("Settings could not be confirmed saved. Please try again.")); }, 8000);
    send({ type: "config.get", requestId });
  });
}

async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(typeof detail.error === "string" ? detail.error : "The engine answered " + response.status + ".");
  }
  return response;
}

export function backupControls(beforeTransfer) {
  const controls = h("div", "backup-actions");
  const backup = h("button", "set-action", "Backup"); backup.type = "button";
  const restore = h("button", "set-action", "Restore"); restore.type = "button";
  const file = h("input"); file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
  file.setAttribute("aria-label", "Choose a backup file");
  backup.addEventListener("click", async () => {
    if (transferBusy) return;
    transferBusy = true; backup.disabled = true; backup.textContent = "Backing up…";
    try {
      await beforeTransfer(); await savedConfigBarrier();
      const response = await post("/api/session/backup", { browser: collectBrowserPrefs() });
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") || "")?.[1] || "clideck-backup.json";
      const url = URL.createObjectURL(blob), link = h("a");
      link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) { toast.error({ title: "Backup failed", body: error.message }); }
    finally { transferBusy = false; backup.disabled = false; backup.textContent = "Backup"; }
  });
  restore.addEventListener("click", () => { if (!transferBusy && !active) { file.value = ""; file.click(); } });
  file.addEventListener("change", () => { if (file.files?.[0] && !active && !transferBusy) openRestore(file.files[0], beforeTransfer, restore); });
  controls.append(backup, restore, file);
  return controls;
}

function button(label, cls, action) {
  const b = h("button", cls); b.type = "button"; b.textContent = label; b.addEventListener("click", action); return b;
}
function label(text, cls) { const el = h("div", cls); el.textContent = text; return el; }

export async function openRestore(file, beforeTransfer = async () => {}, opener = document.activeElement) {
  if (active) return;
  const overlay = h("div", "fp-overlay restore-overlay");
  const modal = h("div", "fp-modal restore-modal");
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "restore-title");
  const title = label("Restore backup", "fp-title"); title.id = "restore-title";
  const head = h("div", "fp-head");
  const closeButton = button("×", "fp-x", closeRestore); closeButton.setAttribute("aria-label", "Close restore");
  head.append(title, closeButton);
  const info = label(file.name, "restore-file");
  const note = label("Choose what to restore. Project files and native agent conversations are not included.", "restore-note");
  const body = h("div", "restore-body"); body.append(label("Reading backup…", "restore-status"));
  const error = label("", "restore-error"); error.hidden = true; error.setAttribute("role", "alert");
  const foot = h("div", "fp-foot");
  const count = label("", "restore-count"); count.setAttribute("aria-live", "polite");
  const cancel = button("Cancel", "fp-cancel", closeRestore);
  const submit = button("Restore selected", "fp-select", restoreSelected); submit.disabled = true;
  foot.append(count, cancel, submit); modal.append(head, info, note, body, error, foot); overlay.append(modal);
  const state = { overlay, modal, body, info, error, submit, cancel, closeButton, count, opener, beforeTransfer, roots: [], busy: false, backup: null };
  active = state;
  overlay.addEventListener("mousedown", (event) => { event.stopPropagation(); if (event.target === overlay) closeRestore(); });
  overlay.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay); document.body.classList.add("cd-modal-open");
  requestAnimationFrame(() => { if (active === state) overlay.classList.add("show"); });
  cancel.focus();
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error("Backup is too large (maximum 8 MB).");
    const backup = JSON.parse(await file.text());
    const preview = await (await post("/api/session/restore/preview", { backup })).json();
    if (active !== state) return;
    state.backup = backup;
    const date = new Date(preview.createdAt);
    info.textContent = file.name + (Number.isNaN(date.getTime()) ? "" : " · " + date.toLocaleDateString());
    buildChoices(state, preview);
  } catch (err) {
    if (active !== state) return;
    body.replaceChildren();
    showError(state, err instanceof SyntaxError ? "This file is not valid backup JSON." : err.message);
  }
}

function buildChoices(state, preview) {
  const leaf = (kind, value) => ({ kind, id: value.id, name: value.label || value.name || value.provider || "Unnamed session", detail: value.path || value.cwd || "", exists: value.exists, selected: true, children: [] });
  const settings = { name: "Settings", children: (preview.settings || []).map(s => leaf("settings", s)), expanded: true };
  const projects = { name: "Projects", expanded: true, children: (preview.projects || []).map(p => ({ ...leaf("projects", p), children: (p.sessions || []).map(s => leaf("sessions", s)) })) };
  if (preview.sessions?.length) projects.children.push({ name: "Other sessions", children: preview.sessions.map(s => leaf("sessions", s)), expanded: true });
  state.roots = [settings, projects].filter(n => n.children.length);
  state.body.replaceChildren();
  for (const root of state.roots) state.body.append(renderChoice(root, state));
  for (const warning of preview.warnings || []) state.body.append(label(warning, "restore-warning"));
  if (!state.roots.length) state.body.append(label("Nothing to restore in this backup.", "restore-status"));
  paintSelection(state);
}

const descendants = (node) => [...(node.kind ? [node] : []), ...node.children.flatMap(descendants)];
function renderChoice(node, state) {
  const group = h("div", "restore-group");
  const row = h("div", "restore-row");
  const nested = h("div", "restore-children"); nested.hidden = !node.expanded;
  if (node.children.length) {
    const expand = button("", "restore-expand", () => { node.expanded = !node.expanded; nested.hidden = !node.expanded; expand.setAttribute("aria-expanded", String(node.expanded)); });
    expand.setAttribute("aria-label", "Expand " + node.name); expand.setAttribute("aria-expanded", String(!!node.expanded));
    expand.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 5 7 7-7 7"/></svg>';
    row.append(expand);
  } else row.append(h("span", "restore-indent"));
  const checkLabel = h("label", "restore-choice");
  const check = h("input"); check.type = "checkbox"; check.checked = true;
  check.setAttribute("aria-label", node.name); node.check = check;
  check.addEventListener("change", () => { for (const item of descendants(node)) item.selected = check.checked; paintSelection(state); });
  const copy = h("span", "restore-label");
  const name = h("span"); name.textContent = node.name; copy.append(name);
  if (node.detail) { const path = h("span", "restore-path"); path.textContent = node.detail; path.title = node.detail; copy.append(path); }
  checkLabel.append(check, copy); row.append(checkLabel);
  if (node.exists) row.append(label("Already here — kept", "restore-kept"));
  else if (node.children.length) row.append(label(String(node.children.length), "restore-total"));
  for (const child of node.children) nested.append(renderChoice(child, state));
  group.append(row, nested); return group;
}

function selection(state) {
  const result = { settings: [], projects: [], sessions: [] };
  for (const item of state.roots.flatMap(descendants)) if (item.selected) result[item.kind].push(item.id);
  return result;
}
function paintSelection(state) {
  const walk = (node) => {
    const items = descendants(node), selected = items.filter(n => n.selected).length;
    node.check.checked = selected === items.length;
    node.check.indeterminate = selected > 0 && selected < items.length;
    for (const child of node.children) walk(child);
  };
  for (const root of state.roots) walk(root);
  const n = Object.values(selection(state)).reduce((sum, ids) => sum + ids.length, 0);
  state.count.textContent = n + " selected"; state.submit.disabled = !n || state.busy;
}
function showError(state, message) { state.error.textContent = message; state.error.hidden = false; }
async function restoreSelected() {
  const state = active;
  if (!state || state.busy || state.submit.disabled) return;
  if (state.committed) { location.reload(); return; }
  state.busy = true; state.error.hidden = true; state.submit.disabled = true; state.submit.textContent = "Restoring…";
  state.body.inert = true; state.cancel.disabled = true; state.closeButton.disabled = true;
  try {
    await state.beforeTransfer(); await savedConfigBarrier();
    const selected = selection(state);
    const result = await (await post("/api/session/restore", { backup: state.backup, selection: selected })).json();
    // The server has committed. Do not leave an enabled Restore button if local preference writes fail.
    state.committed = true;
    applyBrowserPrefs(result.browser, selected.settings);
    if (result.warnings?.length) {
      state.body.replaceChildren(label("Restore complete", "restore-status"), ...result.warnings.map(w => label(w, "restore-warning")));
      state.count.textContent = "";
      state.submit.textContent = "Done"; state.submit.disabled = false;
    } else location.reload();
  } catch (error) {
    if (state.committed) {
      showError(state, "Data was restored, but browser preferences could not be applied. Reload to continue.");
      state.submit.textContent = "Reload"; state.submit.disabled = false;
    } else {
      showError(state, error.message); state.submit.textContent = "Restore selected";
    }
  } finally {
    state.busy = false; state.body.inert = !!state.committed; state.cancel.disabled = false; state.closeButton.disabled = false;
    if (!state.committed) paintSelection(state);
  }
}
function closeRestore() {
  const state = active; if (!state || state.busy) return;
  active = null; document.removeEventListener("keydown", onKey, true);
  state.overlay.remove(); document.body.classList.remove("cd-modal-open");
  if (state.committed) { location.reload(); return; }
  if (document.body.contains(state.opener)) state.opener.focus();
  else document.querySelector('[data-sec="data"] button:last-of-type')?.focus();
}
function onKey(event) {
  if (!active) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRestore(); }
  if (event.key === "Tab") {
    const controls = [...active.modal.querySelectorAll("button,input")].filter(n => !n.disabled && !n.closest("[hidden]") && !n.closest("[inert]"));
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !active.modal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !active.modal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
}

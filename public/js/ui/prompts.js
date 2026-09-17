// Prompt Library (v2 parity for v1 prompts.js). Two surfaces over one store:
//   1. a modal you manage saved prompts in (add/edit/delete/filter, click to paste), and
//   2. the crown-jewel `//` terminal trigger — type // in any LIVE terminal to search + paste.
// Storage = config.prompts [{id,name,text}] in the server config store; config.update round-trips it
// and the engine echoes {type:'config'} back, so every client stays in sync. store.setPrompts() is an
// optimistic local write so both surfaces re-render instantly (the echo re-affirms the same array).
import { store } from "../store.js";
import { send, updateConfig } from "../ws.js";
import { esc, askAddress, shortId, basename } from "../util.js";
import { toast } from "./toast.js";
import { pastePayload } from "./paste.js";
import { spellingScore } from "../search-similarity.js";

// ── prompt data (single source = store.prompts) ────────────────────────────────
function getPrompts() { return store.prompts || []; }
let uidn = 0;
function uid() { try { return crypto.randomUUID(); } catch { return "p" + Date.now().toString(36) + (uidn++).toString(36); } }

function commitPrompts(next) {
  store.setPrompts(next);            // optimistic → both surfaces re-render this frame
  updateConfig({ prompts: next });   // persist + broadcast to every client (top-level shallow-merge keeps notify)
}
function addPrompt(name, text) { commitPrompts([...getPrompts(), { id: uid(), name, text }]); }
function editPrompt(id, name, text) { commitPrompts(getPrompts().map((p) => (p.id === id ? { ...p, name, text } : p))); }
function deletePrompt(id) {
  const p = getPrompts().find((x) => x.id === id);
  commitPrompts(getPrompts().filter((x) => x.id !== id));
  if (p) toast.info({ id: "prompt-del", title: "Prompt deleted", body: "`" + p.name + "`", markdown: true });
}

// The one ranking ladder, shared with searchAgents: 3 = you typed the WHOLE name, 2 = the name contains it,
// 1 = only the body does. Ties keep the order the caller handed in — which is where project/MRU preference
// lives, so preference breaks an equal rank and can never lift a weak match over a strong one.
//
// ⚠️ THAT ORDER OF OPERATIONS IS THE FIX, and reversing it is the bug (Or, 09-09): `//reviewer` offered
// "Daily checklist" — a recently-used prompt whose BODY happens to say reviewer — above the prompt actually
// named "reviewer", because the preference partition ran AFTER the rank sort and moved the whole preferred
// group to the top. Partition the INPUT, rank the result. Never partition a ranked list.
const RANK_EXACT = 3, RANK_NAME = 2, RANK_BODY = 1;
function searchPrompts(prompts, filter) {
  const q = (filter || "").toLowerCase().trim();
  if (!q) return prompts;
  return prompts
    .map((p, i) => ({ p, i, rank: promptRank(p, q) }))
    .filter((m) => m.rank)
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map((m) => m.p);
}
function promptRank(p, q) {
  const name = String(p.name || "").toLowerCase();
  return name === q ? RANK_EXACT : name.includes(q) ? RANK_NAME : String(p.text || "").toLowerCase().includes(q) ? RANK_BODY : 0;
}

// ── paste into the active terminal + refocus ───────────────────────────────────
let focusTerminal = () => {};
export function registerTerminalFocus(fn) { focusTerminal = typeof fn === "function" ? fn : (() => {}); }
function activeLive() { const s = store.active(); return !!s && s.live !== false; }

// {{session_name}} / {{project_name}} are filled from the active session AT PASTE TIME (§13b②). Unknown
// braces are left verbatim — the regex only matches the two documented keys, so a prompt is never mangled.
// ⚠️ {{session_name}} is the FULL address (Or, 09-09) — the same one @@ mentions and Copy address use.
function fillPlaceholders(text) {
  const s = store.active();
  if (!s) return text;
  const proj = s.projectId ? (store.projects || []).find((p) => p.id === s.projectId) : null;
  const vals = {
    session_name: askAddress(s, store.projects),
    project_name: (proj && proj.name) || (s.cwd ? basename(s.cwd) : ""),   // project, else the working-folder name
  };
  return text.replace(/\{\{\s*(session_name|project_name)\s*\}\}/g, (_, k) => vals[k]);
}

// Prompts have no project field, so "project-first" is learned from USE: the ids you've pasted while working in
// this project sort ahead of the rest. It partitions the LIBRARY, before any ranking — see searchPrompts.
// Rides config unknown-keys (like sessionThemes/notify), so no prompt schema change and no engine work.
const MRU_MAX = 12;
function mruKey() { const s = store.active(); return (s && s.projectId) || "__none__"; }
function rememberPrompt(id) {
  if (!id) return;
  const map = { ...(store.promptMru || {}) };
  const prev = Array.isArray(map[mruKey()]) ? map[mruKey()].filter((x) => x !== id) : [];
  map[mruKey()] = [id, ...prev].slice(0, MRU_MAX);
  store.setPromptMru(map);                 // optimistic → the dropdown re-ranks next open
  updateConfig({ promptMru: map });        // persist + broadcast
}
function projectFirstPrompts(list) {
  const used = (store.promptMru || {})[mruKey()];
  if (!Array.isArray(used) || !used.length) return list;
  const mine = [], rest = [];
  for (const p of list) (used.includes(p.id) ? mine : rest).push(p);
  return mine.concat(rest);
}

function pastePrompt(text) {
  const s = store.active();
  if (!s || s.live === false) return;                         // no live PTY (nothing selected / dormant read-only)
  send({ type: "input", sessionId: s.id, data: pastePayload(fillPlaceholders(text)) });
  focusTerminal();
}

// ── agent mentions (@@) — active sessions as insertable @Project/name addresses (§13b①) ─────────
// Built from the live session list on demand; address = exactly what /ask resolves (askAddress), so a
// mention names the same target the row menu's "Copy @address" would.
function getAgents() {
  const out = [];
  for (const s of store.sessions.values()) {
    out.push({ id: s.id, name: (s.name || "").trim() || shortId(s.id), address: askAddress(s, store.projects), projectId: s.projectId || null });
  }
  return out;
}
// You almost always mean someone on the project you're already in, so offer those first. This partitions the
// AGENT LIST, before any ranking: whatever order it establishes (list order for an empty query, preference)
// is preserved inside each group. An ad-hoc active session (no project) groups with the other ad-hoc sessions,
// so "the ones like me" leads either way. No separator row — every entry's sub-line already reads @Project/name.
function projectFirst(list) {
  const active = store.active();
  const pid = (active && active.projectId) || null;
  const mine = [], rest = [];
  for (const a of list) (a.projectId === pid ? mine : rest).push(a);
  return mine.concat(rest);
}
// searchPrompts' ladder over a session's name and its full @Project/name address: 3 = you typed one of them
// whole, 2 = the name contains it, 1 = only the address does. The project partition is applied to the INPUT,
// so it survives as the tie-break inside each rank instead of re-ordering a ranked list.
function searchAgents(filter) {
  const q = (filter || "").toLowerCase().trim();
  const all = projectFirst(getAgents());
  if (!q) return all;
  return all
    .map((a, i) => ({ a, i, rank: agentRank(a, q) }))
    .filter((m) => m.rank)
    .sort((x, y) => y.rank - x.rank || x.i - y.i)
    .map((m) => m.a);
}
function agentRank(a, q) {
  const name = String(a.name || "").toLowerCase(), address = String(a.address || "").toLowerCase();
  return name === q || address === q ? RANK_EXACT : name.includes(q) ? RANK_NAME : address.includes(q) ? RANK_BODY : 0;
}
// Bracketed paste wraps the mention so the receiving agent treats the leading @ as literal pasted text and
// does NOT re-open Claude/Codex's native @ file-mention picker (v1 prompts.js:282-293).
function insertMention(address) {
  const s = store.active();
  if (!s || s.live === false) return;
  send({ type: "input", sessionId: s.id, data: pastePayload(address + " ") });
  focusTerminal();
}

// Shared literal paste — R2 file-drop paths and voice-recognized text reuse this input+refocus pipeline.
// Bracketed by default so the text lands literally and is NOT auto-run (the user presses Enter).
export function pasteToTerminal(text, bracketed = true) {
  const s = store.active();
  if (!s || s.live === false || text == null) return false;
  send({ type: "input", sessionId: s.id, data: bracketed ? pastePayload(text) : String(text) });
  focusTerminal();
  return true;
}

function node(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }

const NEW_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const EDIT_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>';
const DEL_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const SEARCH_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>';
const HELP_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.7 2.4-2.7 3.4"/><path d="M12 17.5v.01"/></svg>';

// Concise usage card (§13b③) — documents the two terminal triggers + the paste-time placeholders. All-static
// markup (no user data), so innerHTML is safe here.
function buildHelpCard() {
  const card = node("div", "pl-help");
  card.innerHTML =
    '<div class="pl-help-sec"><div class="pl-help-h">Terminal triggers</div>' +
      '<div class="pl-help-row"><kbd>//</kbd><span>In any live terminal, type <b>//</b> and a few letters to search &amp; paste a saved prompt.</span></div>' +
      '<div class="pl-help-row"><kbd>@@</kbd><span>Type <b>@@</b> to mention another agent — inserts its <code>@project/name</code> address.</span></div></div>' +
    '<div class="pl-help-sec"><div class="pl-help-h">Placeholders <span class="pl-help-dim">— filled from the active session when a prompt is pasted</span></div>' +
      '<div class="pl-help-row"><code>{{session_name}}</code><span>the session\'s full ask address — <code>@Project/name</code>, the same one <b>@@</b> inserts</span></div>' +
      '<div class="pl-help-row"><code>{{project_name}}</code><span>its project (or working-folder) name</span></div></div>';
  return card;
}
function toggleHelp() {
  if (!els) return;
  if (els.helpHost.firstChild) els.helpHost.replaceChildren();   // toggle off
  else els.helpHost.appendChild(buildHelpCard());
}

// ── library modal ──────────────────────────────────────────────────────────────
let overlay = null, els = null, offConfig = null, filterVal = "";

export function openPromptLibrary() {
  if (overlay) { close(); return; }          // toggle off
  filterVal = "";
  build();
  document.addEventListener("keydown", onKey, true);
  offConfig = store.on("config", renderList);   // optimistic write / another client's change → re-render
  renderList();
  requestAnimationFrame(() => { if (overlay) overlay.classList.add("show"); if (els) els.filter.focus(); });
}

function build() {
  overlay = node("div", "pl-overlay");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });   // backdrop click closes
  const modal = node("div", "pl-modal");

  const head = node("div", "pl-head");
  const title = node("div", "pl-title", "Prompts");
  head.appendChild(title);
  const help = node("button", "pl-help-btn"); help.type = "button"; help.title = "Usage & placeholders"; help.setAttribute("aria-label", "Prompt usage help");
  help.innerHTML = HELP_ICON; help.addEventListener("click", toggleHelp);
  const newBtn = node("button", "pl-newbtn"); newBtn.type = "button";
  newBtn.innerHTML = NEW_ICON + "<span>New prompt</span>";
  newBtn.addEventListener("click", () => openEditor());
  const x = node("button", "pl-x"); x.type = "button"; x.setAttribute("aria-label", "Close");
  x.innerHTML = DEL_ICON; x.addEventListener("click", close);
  head.append(help, newBtn, x);

  const filterRow = node("div", "pl-filterrow");
  filterRow.innerHTML = SEARCH_ICON;
  const filter = node("input", "pl-filter"); filter.placeholder = "Filter prompts…"; filter.spellcheck = false; filter.autocomplete = "off";
  filter.addEventListener("input", () => { filterVal = filter.value; renderList(); });
  filter.addEventListener("keydown", (e) => { if (e.key === "Escape" && filter.value) { e.stopPropagation(); filter.value = ""; filterVal = ""; renderList(); } });
  filterRow.appendChild(filter);

  const hint = node("div", "pl-hint");
  hint.innerHTML = '<kbd>//</kbd><span>Type <b>//</b> in any terminal to search &amp; paste</span>';

  const helpHost = node("div", "pl-helphost");
  const editorHost = node("div", "pl-editorhost");
  const list = node("div", "pl-list");

  modal.append(head, filterRow, hint, helpHost, editorHost, list);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  els = { modal, title, filter, helpHost, editorHost, list };
}

function renderList() {
  if (!els) return;
  const prompts = getPrompts();
  const filtered = searchPrompts(prompts, filterVal);
  els.list.replaceChildren();
  if (!prompts.length) {
    const e = node("div", "pl-empty");
    e.append(node("p", "pl-empty-big", "Saved prompts"));
    const sub = node("p", "pl-empty-sub");
    sub.innerHTML = 'Save project introductions, links and instructions here, then type <kbd>//</kbd> in any terminal to find and reuse them.';
    e.append(sub);
    els.list.appendChild(e);
    return;
  }
  if (!filtered.length) {
    els.list.appendChild(node("div", "pl-nomatch", 'No prompts matching “' + filterVal.trim() + '”'));
    return;
  }
  const q = filterVal.toLowerCase().trim();
  for (const p of filtered) {
    const row = node("div", "pl-row");
    const main = node("div", "pl-row-main");
    const nm = node("div", "pl-name"); nm.innerHTML = highlight(p.name, q);
    const tx = node("div", "pl-text"); tx.innerHTML = highlight(p.text, q);
    main.append(nm, tx);
    const actions = node("div", "pl-row-actions");
    const edit = node("button", "pl-edit"); edit.type = "button"; edit.title = "Edit"; edit.setAttribute("aria-label", "Edit prompt"); edit.innerHTML = EDIT_ICON;
    const del = node("button", "pl-del"); del.type = "button"; del.title = "Delete"; del.setAttribute("aria-label", "Delete prompt"); del.innerHTML = DEL_ICON;
    edit.addEventListener("click", (e) => { e.stopPropagation(); openEditor(p.id); });
    del.addEventListener("click", (e) => { e.stopPropagation(); deletePrompt(p.id); });
    actions.append(edit, del);
    row.append(main, actions);
    row.addEventListener("click", () => { rememberPrompt(p.id); pastePrompt(p.text); close(); });   // click to paste into the active terminal + close
    els.list.appendChild(row);
  }
}

// Inline add/edit editor, injected above the list (v1 prompts.js:145-194). Toggles off if reopened on the
// same trigger. Name maxlen 60; Save/Add requires both fields; Esc discards; Ctrl/Cmd+Enter saves.
//
// Editing is a MODE, not a card squeezed in above the list: `.editing` gives the modal a settled height and
// hands the leftover to the editor, so the text box grows to the window instead of showing a long prompt
// through a five-line slot, and Save/Cancel sit at the bottom of a bounded card where they cannot be pushed
// out of reach. The list (and the filter that searches it) step aside while you edit — they were what the
// editor had to fight for space against.
function openEditor(id) {
  if (!els) return;
  if (els.editorHost.firstChild) { closeEditor(); if (id == null) return; }   // toggle add off
  const existing = id != null ? getPrompts().find((p) => p.id === id) : null;
  els.helpHost.replaceChildren();            // help + editor are two cards after the same space; only one opens
  els.modal.classList.add("editing");
  els.title.textContent = existing ? "Edit prompt" : "New prompt";

  const card = node("div", "pl-editor");
  const name = node("input", "pl-ed-name"); name.maxLength = 60; name.placeholder = "Prompt name"; name.spellcheck = false; name.autocomplete = "off"; name.value = existing ? existing.name : "";
  const text = node("textarea", "pl-ed-text"); text.placeholder = "What would you like your agent to do?\n\nTip: use {{session_name}} for its full @project/name address, or {{project_name}} for the project name. We\u2019ll fill them in when you use the prompt."; text.spellcheck = false; text.value = existing ? existing.text : "";
  const actions = node("div", "pl-ed-actions");
  const save = node("button", "pl-ed-save", existing ? "Save" : "Add"); save.type = "button";
  const cancel = node("button", "pl-ed-cancel", "Cancel"); cancel.type = "button";
  actions.append(save, cancel);
  card.append(name, text, actions);
  els.editorHost.replaceChildren(card);

  const doSave = () => {
    const nm = name.value.trim(), tx = text.value.trim();
    if (!nm || !tx) { (nm ? text : name).focus(); return; }   // both required; nudge the empty field
    if (existing) editPrompt(existing.id, nm, tx); else addPrompt(nm, tx);
    closeEditor();                                            // config emit re-renders the list
  };
  save.addEventListener("click", doSave);
  cancel.addEventListener("click", closeEditor);
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } });
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSave(); } });
  name.focus();
}
function closeEditor() {
  if (!els || !els.editorHost.firstChild) return;
  els.editorHost.replaceChildren();
  els.modal.classList.remove("editing");
  els.title.textContent = "Prompts";
}

function onKey(e) {
  if (e.key !== "Escape") return;
  if (els && els.editorHost.firstChild) { e.stopPropagation(); closeEditor(); return; }   // editor first, then modal
  close();
}

function close() {
  if (!overlay) return;
  document.removeEventListener("keydown", onKey, true);
  if (offConfig) { offConfig(); offConfig = null; }
  const ov = overlay;
  overlay = null; els = null;
  ov.classList.remove("show");
  setTimeout(() => ov.remove(), 180);
}

// ── the `//` + `@@` terminal triggers + autocomplete dropdown (v1 prompts.js:206-531) ────
let acBuffer = "", acActive = false, acDropdown = null, acSelected = 0, acMatches = [], acOutside = null, acMode = "prompt";
let acSimilarFrom = -1;                                   // index the "Similar matches" group starts at, or -1
let lastTriggerTime = 0, lastTriggerKey = "", lastKeyWasPrintable = false;

// ── typo tolerance: an APPENDED tail, never a re-rank ──────────────────────────────────────────────
// The LITERAL pipeline above runs first and this scores only the items it REJECTED, so a literal result can
// never be displaced, reordered or duplicated by the tail — true by construction, not by a filter someone has
// to keep correct later. `test-ui/picker-order-it.mjs` records that order.
//
// ⚠️ NEVER PROMPT BODIES. A row shows `truncate(m.text, 80)`, so a near-match 2000 characters into a body
// renders a row whose visible text contains nothing like what was typed. A result the user cannot see the
// reason for reads as a WRONG result, not a lenient one. Names and addresses only.
const SIMILAR_MAX = 5;
const SIMILAR_MIN_QUERY = 4;
// CLOSENESS IS THE PROMISE HERE, so score sorts first and project/MRU only breaks an equal score — the same
// shape as the literal group above since 09-09, where rank decides and preference breaks a tie. (It used to be
// the opposite there: preference partitioned the whole ranked list, which is the bug Or reported.) Ties beyond
// that keep list order, so two equally close guesses cannot shuffle between keystrokes. Capped last: the cap
// means "the five closest".
function similarTail(all, exact, query, fields, preferred) {
  if (query.length < SIMILAR_MIN_QUERY) return [];
  // ⚠️ DEDUPE BY id, NEVER BY IDENTITY. `getAgents()` builds a fresh object per call, so the exact list and
  // this list hold DIFFERENT objects for the same agent; an identity Set would let every exact hit through
  // again as a "similar" one. Prompts happen to be the same objects — one rule for both, so it cannot rot.
  const taken = new Set(exact.map((item) => item.id));
  const scored = [];
  all.forEach((item, i) => {
    if (taken.has(item.id)) return;
    let best = 0;
    for (const field of fields) {
      const value = field(item);
      if (typeof value !== "string" || !value) continue;
      const score = Number(spellingScore(query, value));
      if (score > best) best = score;
    }
    if (best > 0) scored.push({ item, best, i, mine: preferred(item) ? 0 : 1 });
  });
  scored.sort((a, b) => b.best - a.best || a.mine - b.mine || a.i - b.i);
  return scored.slice(0, SIMILAR_MAX).map((m) => m.item);
}
// The two "belongs to what I am working on" rules the exact pass partitions by, restated as predicates so
// the tail can use them as a TIE-BREAK instead. Same rule, different strength.
function agentIsMine(agent) {
  const active = store.active();
  return agent.projectId === ((active && active.projectId) || null);
}
function promptIsMine(prompt) {
  const used = (store.promptMru || {})[mruKey()];
  return Array.isArray(used) && used.includes(prompt.id);
}

// One dropdown, two modes — // searches your prompt library, @@ mentions an active agent. Each mode owns
// its match source, how a row renders, and what completing it does (paste text vs. insert an @address).
// `matches()` returns the exact list; `similar()` returns the appended tail, which is drawn under a label
// and is never mixed into the group above it.
const MODES = {
  prompt: {
    label: "Prompts", prefix: "//", empty: "No matching prompts", hint: 'Type <kbd>//</kbd> to search your prompt library',
    matches: () => searchPrompts(projectFirstPrompts(getPrompts()), acBuffer),
    similar: (exact) => similarTail(getPrompts(), exact, acBuffer.trim().toLowerCase(),
      [(p) => p.name], promptIsMine),
    main: (m) => m.name, sub: (m) => truncate(m.text, 80),
    complete: (m) => { rememberPrompt(m.id); pastePrompt(m.text); },
  },
  agent: {
    label: "Agents", prefix: "@@", empty: "No matching agents", hint: 'Type <kbd>@@</kbd> to mention an agent',
    matches: () => searchAgents(acBuffer),
    similar: (exact) => similarTail(getAgents(), exact, acBuffer.trim().toLowerCase(),
      [(a) => a.name, (a) => a.address], agentIsMine),
    main: (m) => m.name, sub: (m) => m.address,
    complete: (m) => insertMention(m.address),
  },
};
const TRIGGER_MODES = { "/": "prompt", "@": "agent" };
// @ is typed with a modifier (Shift, or AltGr on many layouts), so these keydowns interleave with the two @
// of @@ — they must NOT reset trigger history or the "printable char before" guard (v1.31.30 fix class).
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);
function triggerAvailable(m) { return m === "agent" ? store.sessions.size > 0 : getPrompts().length > 0; }

// Called from terminal.js's attachCustomKeyEventHandler on every keydown. Returns true = let xterm handle
// the key (pass-through), false = swallow it. The first '/' ALWAYS passes through instantly (zero lag); a
// second '/' within 300ms erases it and opens the dropdown, which then captures every key until it closes.
export function handleTerminalKey(e) {
  if (e.type !== "keydown") return true;

  if (acActive) {
    if (e.key === "Escape") { e.preventDefault(); closePromptDropdown(); return false; }
    if (e.key === "ArrowUp") { e.preventDefault(); acSelected = Math.max(0, acSelected - 1); renderAc(); return false; }
    if (e.key === "ArrowDown") { e.preventDefault(); acSelected = Math.min(acMatches.length - 1, acSelected + 1); renderAc(); return false; }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const m = acMatches[acSelected];
      const cfg = MODES[acMode];
      closePromptDropdown();
      if (m) cfg.complete(m);
      return false;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      if (acBuffer.length > 0) { acBuffer = acBuffer.slice(0, -1); acSelected = 0; renderAc(); } else closePromptDropdown();
      return false;
    }
    // Reset the selection on every query change: `acSelected` names a POSITION, not an item, and a query
    // change can reorder the list. Going back to the first result keeps Enter following the search.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); acBuffer += e.key; acSelected = 0; renderAc(); return false; }
    e.preventDefault(); return false;                         // block modifiers / function keys while open
  }

  // Modifier-only keydowns must not disturb trigger history — a Shift keydown fires between the two @ of @@,
  // and resetting state here broke @@ across keyboard layouts (v1.31.30 fix class).
  if (MODIFIER_KEYS.has(e.key)) return true;

  // Treat AltGr-produced chars (e.g. @ on many EU layouts, a Ctrl+Alt combo) as normal input, not a shortcut,
  // so // and @@ trigger regardless of layout.
  const altGraph = typeof e.getModifierState === "function" && e.getModifierState("AltGraph");
  const isChar = e.key.length === 1 && !e.metaKey && (!e.ctrlKey || altGraph) && (!e.altKey || altGraph);

  // Trigger: first char passes through instantly (zero lag); a matching second within 300ms erases it and
  // opens the menu — // for prompts, @@ for agent mentions. Suppress when a non-whitespace char preceded the
  // first (so s//, a@@, :// never fire, but 'space //' does).
  const trigMode = TRIGGER_MODES[e.key];
  if (trigMode && isChar && triggerAvailable(trigMode) && activeLive()) {
    const now = Date.now();
    if (e.key === lastTriggerKey && now - lastTriggerTime < 300) {
      lastTriggerTime = 0; lastTriggerKey = ""; lastKeyWasPrintable = false;
      e.preventDefault();
      const s = store.active();
      if (s && s.live !== false) send({ type: "input", sessionId: s.id, data: "\x7f" });   // erase the first trigger char
      acMode = trigMode;
      openPromptDropdown();
      return false;
    }
    if (!lastKeyWasPrintable) { lastTriggerTime = now; lastTriggerKey = e.key; }   // arm only if prior key wasn't printable
    lastKeyWasPrintable = true;                               // the trigger char is itself non-whitespace → keeps s///, a@@@ suppressed
    return true;
  }

  lastTriggerTime = 0; lastTriggerKey = "";
  lastKeyWasPrintable = isChar && e.key.trim() !== "";
  return true;
}

function openPromptDropdown() {
  closePromptDropdown();
  acBuffer = ""; acSelected = 0; acSimilarFrom = -1;
  acDropdown = node("div", "pl-ac");
  acDropdown.style.visibility = "hidden";
  document.body.appendChild(acDropdown);
  renderAc();
  positionAc();
  acDropdown.style.visibility = "";
  acActive = true;
  acOutside = (e) => { if (acDropdown && !acDropdown.contains(e.target)) closePromptDropdown(); };
  document.addEventListener("mousedown", acOutside, true);   // safety: a click anywhere else closes it
}

function renderAc() {
  if (!acDropdown) return;
  const cfg = MODES[acMode];
  const exact = cfg.matches();
  const similar = cfg.similar ? cfg.similar(exact) : [];
  // ONE flat list, so Enter and the arrows index exactly what they always did. `acSimilarFrom` is where the
  // guesses begin, and the label is drawn as a separate node that is NOT a `.pl-ac-item` — a heading that
  // could be selected and pasted would be worse than no heading.
  acMatches = exact.concat(similar);
  acSimilarFrom = similar.length ? exact.length : -1;
  acSelected = Math.min(acSelected, Math.max(0, acMatches.length - 1));
  const q = acBuffer.toLowerCase();
  acDropdown.replaceChildren();
  if (!acMatches.length) {
    acDropdown.appendChild(node("div", "pl-ac-empty", cfg.empty));
    const hint = node("div", "pl-ac-hint"); hint.innerHTML = cfg.hint;
    acDropdown.appendChild(hint);
    return;
  }
  const head = node("div", "pl-ac-head");
  head.append(node("span", "pl-ac-label", cfg.label), node("span", "pl-ac-query", cfg.prefix + acBuffer));
  const list = node("div", "pl-ac-list");
  acMatches.forEach((p, i) => {
    if (i === acSimilarFrom) list.appendChild(node("div", "pl-ac-group", "Similar matches"));
    const item = node("div", "pl-ac-item" + (i === acSelected ? " sel" : "") + (acSimilarFrom >= 0 && i >= acSimilarFrom ? " similar" : ""));
    const nm = node("div", "pl-ac-name"); nm.innerHTML = highlight(cfg.main(p), q);
    const tx = node("div", "pl-ac-text"); tx.innerHTML = highlight(cfg.sub(p), q);
    item.append(nm, tx);
    item.addEventListener("mousedown", (e) => { e.preventDefault(); closePromptDropdown(); cfg.complete(p); });
    list.appendChild(item);
  });
  const foot = node("div", "pl-ac-foot");
  const verb = acMode === "agent" ? "mention" : "paste";
  foot.innerHTML = '<span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> ' + verb + '</span><span><kbd>esc</kbd> cancel</span>';
  acDropdown.append(head, list, foot);
}

// Bottom-anchored just right of the sidebar, viewport-clamped (v1 prompts.js:225-239). Pure-visual: skips
// cleanly in a headless/fake-DOM env (no window metrics), so the state machine stays testable.
function positionAc() {
  if (!acDropdown || typeof window === "undefined" || !window.innerHeight) return;
  let rect = { right: 60 };
  try { const sb = document.querySelector && document.querySelector(".sidebar"); if (sb) rect = sb.getBoundingClientRect(); } catch {}
  const gap = 10, W = 344, h = acDropdown.offsetHeight || 200;
  let left = rect.right + 24, top = window.innerHeight - h - gap;
  if (left + W > window.innerWidth - gap) left = window.innerWidth - W - gap;
  if (left < gap) left = gap;
  if (top < gap) top = gap;
  acDropdown.style.left = left + "px";
  acDropdown.style.top = top + "px";
}

export function closePromptDropdown() {
  acActive = false; acBuffer = ""; acSelected = 0; acMatches = []; acSimilarFrom = -1;
  if (acOutside) { document.removeEventListener("mousedown", acOutside, true); acOutside = null; }
  if (acDropdown) { acDropdown.remove(); acDropdown = null; }
}

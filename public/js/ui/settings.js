// The Settings surface (§M) — a full-screen overlay opened from the sidebar-footer gear. A left category nav
// (General / CLI Agents / Notifications / Appearance) + a content pane + a version footer. Built structurally
// (createElement) so it's introspectable. Config keys ride the store's config projections; custom-agent edits
// save 500ms-debounced (no config.update flood); availability drives the per-agent health.
import { store } from "../store.js";
import { h, esc } from "../util.js";
import { updateConfig, checkAvailability, refreshPlugins, installPlugin, removePlugin, openPluginFolder, setPluginEnabled, updatePluginSettings } from "../ws.js";
import { openFolderPicker } from "./folder-picker.js";
import { openMenu, closeMenu, isMenuOpen } from "./menu.js";
import { providerOf, PROVIDER_LIST } from "../providers-ui.js";
import { AGENT_PRESETS, providerHealth } from "../agent-presets.js";
import { allThemes, getTheme, defaultThemeId, setDefaultTheme } from "../terminal-themes.js";
import { previewHtml } from "./theme-picker.js";
import { themePref, setThemePref, onThemePref, THEME_PREFS, THEME_LABELS } from "../theme.js";
import { getPrefs, setPref, onPrefs, enableBrowser, notifyPermission, previewSound, SOUND_OPTS, DISPATCH_OPTS, MINWORK_OPTS } from "../notify.js";
import { pluginClientError, onPluginHostChange } from "./plugin-host.js";
import { backupControls, isRestoreOpen, isBackupBusy } from "./backup-restore.js";
import { hotkeyComboFromEvent, hotkeyConflict, hotkeyCodeFromEvent, isFunctionKey } from "./hotkeys.js";

const CLOSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const FOLDER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const TERMINAL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l3 3-3 3"/><path d="M12 16h5"/></svg>';
const CATS = [
  { id: "general", label: "General" },
  { id: "agents", label: "CLI Agents" },
  { id: "plugins", label: "Plugins" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
];

let overlay = null, els = null, cat = "general", offs = [];
let cmds = null;                 // working copy of config.commands while the Agents panel is open (edits don't touch the store)
const providerSwitches = new Map(); // providerId -> live switch; config echoes sync without rebuilding command edits
const providerArgInputs = new Map(); // providerId -> {input,warning}; echoes sync without collapsing Advanced
let providerArgsOpen = false;
let unsaved = false;
let selectedPlugin = null, pluginQuery = "", pluginTrust = false, pluginNotice = null, pluginBusy = null;
const quietSettingRequests = new Set();
const IS_MAC = /Mac|iPhone|iPad/i.test((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");

const genId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function openSettings() {
  if (overlay) { close(); return; }
  build();
  offs.push(store.on("availability", () => { if (cat === "agents") renderBody(); }));
  offs.push(store.on("plugins", () => {
    if (cat !== "plugins") return;
    const active = document.activeElement;
    if (active && overlay && overlay.contains(active) && active.closest && active.closest(".plg-setting")) return; // a settings echo must not steal typing focus
    renderBody();
  }));
  offs.push(store.on("plugin:result", onPluginResult));
  offs.push(onPluginHostChange(() => { if (cat === "plugins") renderBody(); }));
  offs.push(onThemePref(() => { if (cat === "appearance") renderNav(); }));
  offs.push(onPrefs(() => { if (cat === "notifications") renderBody(); }));
  offs.push(store.on("config", () => {
    renderFooter();
    if (isBackupBusy() || isRestoreOpen()) return;
    if (cat === "agents") { syncProviderControls(); return; }   // agents keeps its in-flight edits
    // A debounced About me save comes back as a config echo. Rebuilding the pane under a caret would drop the
    // user mid-word, so an echo that lands while they are still typing in that section is a no-op for the body.
    const active = document.activeElement;
    if (cat === "general" && active && active.closest && active.closest('[data-sec="about"]')) return;
    renderBody();
  }));
  checkAvailability();
  document.addEventListener("keydown", onKey, true);
  render();
  requestAnimationFrame(() => overlay && overlay.classList.add("show"));
}

// Open (or switch) Settings AT a category. ⚠️ Not openSettings(): that one TOGGLES, so calling it to reach a
// pane would close Settings for anyone who already had it open.
export function openSettingsAt(category) {
  const wanted = CATS.some((c) => c.id === category) ? category : "general";
  if (!overlay) { cat = wanted; openSettings(); return; }
  if (cat !== wanted) { flushSettingsEdits(); cmds = null; cat = wanted; render(); }
}
export function closeSettings() { close(); }
export function isSettingsOpen() { return !!overlay; }
// The element for a tagged section, or null when Settings is shut or that pane is not rendered.
export function settingsSection(key) { return overlay ? overlay.querySelector('[data-sec="' + key + '"]') : null; }

function build() {
  overlay = h("div", "set-overlay");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  const modal = h("div", "set-modal");
  const nav = h("aside", "set-nav");
  const navTitle = h("div", "set-nav-title", "Settings");
  const navList = h("div", "set-nav-list");
  const footer = h("div", "set-version");
  nav.append(navTitle, navList, footer);
  const main = h("section", "set-main");
  const head = h("div", "set-head");
  const title = h("div", "set-title", "");
  const x = h("button", "set-x", CLOSE); x.type = "button"; x.setAttribute("aria-label", "Close settings"); x.addEventListener("click", close);
  head.append(title, x);
  const body = h("div", "set-body");
  main.append(head, body);
  modal.append(nav, main);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  els = { navList, footer, title, body };
}

function render() { renderNav(); renderBody(); renderFooter(); }

function renderNav() {
  els.navList.replaceChildren();
  for (const c of CATS) {
    const b = h("button", "set-cat" + (c.id === cat ? " on" : "")); b.type = "button"; b.textContent = c.label;
    b.addEventListener("click", () => { if (cat !== c.id) { flushSettingsEdits(); cmds = null; cat = c.id; render(); } });
    els.navList.appendChild(b);
  }
}

function renderFooter() {
  const v = store.engineVersion;
  els.footer.replaceChildren(
    h("div", "set-ver-name", "CliDeck v2"),
    h("div", "set-ver-eng", v ? "engine " + esc(v) : "engine version unavailable"),
  );
}

function renderBody() {
  if (!els) return;
  stopPluginPreview(); // every surface/detail rebuild retires controls that own media
  els.title.textContent = (CATS.find((c) => c.id === cat) || {}).label || "Settings";
  els.body.replaceChildren();
  if (cat === "general") renderGeneral();
  else if (cat === "agents") renderAgents();
  else if (cat === "plugins") renderPlugins();
  else if (cat === "notifications") renderNotifications();
  else if (cat === "appearance") renderAppearance();
}

// ── shared bits ─────────────────────────────────────────────────────────────
function switchEl(on, onToggle) {
  const b = h("button", "set-switch" + (on ? " on" : "")); b.type = "button";
  b.setAttribute("role", "switch"); b.setAttribute("aria-checked", on ? "true" : "false");
  b.addEventListener("click", () => { const now = !b.classList.contains("on"); b.classList.toggle("on", now); b.setAttribute("aria-checked", now ? "true" : "false"); onToggle(now); });
  return b;
}
function toggleRow(title, sub, on, onToggle) {
  const r = h("div", "set-row");
  const lbl = h("div", "set-row-lbl"); lbl.append(h("div", "set-row-t", title)); if (sub) lbl.append(h("div", "set-row-s", sub));
  r.append(lbl, switchEl(on, onToggle));
  return r;
}
// `key` is a STABLE handle on the section, independent of its wording — the tour spotlights regions by key, and
// a copy edit must not silently unanchor a stop. Untagged sections keep working exactly as before.
// `note` rides ON the heading rather than in a paragraph under the fields. The tour used to spend a whole stop
// saying who About me is shared with; four words beside the title say it where the question is actually asked.
function section(title, key, note) {
  const s = h("div", "set-section");
  if (key) s.setAttribute("data-sec", key);
  const head = h("div", "set-sec-h", title);
  if (note) head.append(h("span", "set-sec-note", note));
  s.appendChild(head);
  return s;
}
// ── General ─────────────────────────────────────────────────────────────────
function renderGeneral() {
  renderAboutMe();

  const sec = section("Defaults", "defaults");
  const field = h("div", "set-field");
  field.append(h("label", "set-field-l", "Default working directory"));
  const row = h("div", "set-path-row");
  const input = h("input", "set-input mono"); input.value = cwdDraft == null ? (store.defaultCwd || "") : cwdDraft; input.placeholder = "/Users/you/projects — blank = engine default"; input.spellcheck = false; input.autocomplete = "off";
  const browse = h("button", "set-browse", FOLDER); browse.type = "button"; browse.title = "Browse folders"; browse.setAttribute("aria-label", "Browse folders");
  input.addEventListener("input", () => { cwdDraft = input.value; clearTimeout(cwdTimer); cwdTimer = setTimeout(flushCwd, 500); });
  browse.addEventListener("click", () => openFolderPicker(input.value.trim(), (p) => { input.value = p; cwdDraft = p; flushCwd(); }));
  row.append(input, browse); field.append(row);
  field.append(h("div", "set-hint", "New sessions start here unless you pick another folder."));
  sec.append(field);
  els.body.append(sec);

  const beh = section("Behavior", "behavior");
  beh.append(toggleRow("Confirm before closing a session", "When off, Delete closes immediately — no confirm step.", store.confirmClose !== false, (on) => updateConfig({ confirmClose: on })));
  els.body.append(beh);

  // Say what is in the file, in the row. A backup nobody understands the scope of is a backup nobody trusts.
  const data = section("Backup & restore", "data");
  const backupRow = h("div", "set-row backup-row");
  const backupLabel = h("div", "set-row-lbl");
  backupLabel.append(h("div", "set-row-t", "Workspace backup"),
    h("div", "set-row-s", "Settings, projects and sessions. Project files and native agent conversations are not included."));
  backupRow.append(backupLabel, backupControls(prepareBackup));
  data.append(backupRow);
  els.body.append(data);

  const started = section("Getting started", "started");
  started.append(buttonRow("Take the tour",
    "A short tour of CliDeck. Tips you have already dismissed stay dismissed.",
    "Start", () => import("./tour.js").then(({ startTour }) => startTour({ replay: true }))));
  els.body.append(started);
}

// ── About me ────────────────────────────────────────────────────────────────
// Three optional fields shared with an agent when a session starts. Or cut the long "shared with …" disclosure
// (09-09): the pane reads as a profile, not a consent form. What stays is the one line the user cannot infer —
// which agents will silently IGNORE what they type here.
//
// ⚠️ BLANK MEANS NOT SHARED, so every control must be able to EXPRESS blank. That is why the time zone is a
// select whose first option is a real "Not shared" rather than the detected zone: a select always has a value,
// and seeding it with the detected one would share a zone nobody chose.
const ABOUT_NAME_MAX = 80;
const ABOUT_NOTES_MAX = 500;
const NOTES_MAX_H = 178;            // ~8 lines of the box's own type — past that it scrolls rather than pushing the pane around
// Agents with no channel to receive a profile at startup. Naming them is not pedantry: a user who fills this
// in and then watches a shell ignore it concludes the whole feature is broken.
const ABOUT_NO_CHANNEL = new Set(["shell", "antigravity"]);
// Fields the user has TOUCHED while Settings has been open, by key. A config echo (their own debounced save
// coming back, or another tab's edit) and a category round-trip both rebuild this pane from the store — and
// would type over them. The draft wins until Settings closes; untouched fields still repaint from the store.
let aboutDirty = {};
let aboutTimer = null;

function renderAboutMe() {
  const about = store.about || {};
  const sec = section("About me", "about", "shared with supported agents");
  const stored = (key) => (typeof about[key] === "string" ? about[key] : "");
  const shown = (key) => (key in aboutDirty ? aboutDirty[key] : stored(key));
  const fields = {};
  const touch = (key, value) => { aboutDirty[key] = value; };
  const saveAbout = () => { clearTimeout(aboutTimer); aboutTimer = setTimeout(saveAboutNow, 500); };

  const nameField = h("div", "set-field");
  nameField.append(h("label", "set-field-l", "Preferred name"));
  const name = h("input", "set-input"); name.value = shown("name");
  name.placeholder = "How agents should address you"; name.maxLength = ABOUT_NAME_MAX; name.autocomplete = "off"; name.spellcheck = false;
  name.addEventListener("input", () => { touch("name", name.value); saveAbout(); });
  nameField.append(name); fields.name = name;

  const zoneField = h("div", "set-field");
  zoneField.append(h("label", "set-field-l", "Time zone"));
  const zone = h("select", "set-select set-wide");
  const current = shown("timeZone");
  const zones = supportedZones();
  const list = (current && !zones.includes(current) ? [current, ...zones] : zones).slice().sort(byCity);   // keep an unknown stored zone selectable
  zone.appendChild(option("", "Not shared"));
  for (const z of list) zone.appendChild(option(z, zoneLabel(z)));
  zone.value = current;
  zone.addEventListener("change", () => { touch("timeZone", zone.value); saveAboutNow(); paintZoneHint(); });
  zoneField.append(zone); fields.timeZone = zone;
  const zoneHint = h("div", "set-hint set-tz");
  zoneField.append(zoneHint);

  const notesField = h("div", "set-field");
  const notesHead = h("div", "set-field-head");
  notesHead.append(h("label", "set-field-l", "Anything else worth knowing"));
  const count = h("span", "set-count");
  notesHead.append(count);
  const notes = h("textarea", "set-input set-textarea");
  notes.value = shown("notes");
  notes.placeholder = "How you like to work, the stack you are on, a house style to follow…";
  notes.maxLength = ABOUT_NOTES_MAX; notes.rows = 1; notes.spellcheck = true;
  notes.addEventListener("input", () => { touch("notes", notes.value); paintCount(); autosizeNotes(); saveAbout(); });
  notesField.append(notesHead, notes); fields.notes = notes;

  sec.append(nameField, zoneField, notesField);
  sec.append(h("div", "set-hint", "Not shared with " + noChannelNames("or") + "."));
  els.body.append(sec);

  function saveAboutNow() { clearTimeout(aboutTimer); aboutTimer = null; sendAboutPatch(); }
  function paintCount() {
    const used = String(notes.value || "").length;
    count.textContent = used ? used + " / " + ABOUT_NOTES_MAX : "";
    count.classList.toggle("full", used >= ABOUT_NOTES_MAX);
  }
  // The detected zone is a SUGGESTION, never a default — it appears as something to click, and doing nothing
  // leaves the field unshared.
  function paintZoneHint() {
    const detected = detectedZone();
    zoneHint.replaceChildren();
    if (!detected || zone.value === detected) { zoneHint.hidden = true; return; }
    zoneHint.hidden = false;
    zoneHint.append(document.createTextNode("Detected: " + detected + " · "));
    const use = h("button", "set-link", "use it"); use.type = "button";
    // ⚠️ Filling the field IS an edit. Without marking it dirty the draft still held whatever was chosen
    // before, and the next rebuild or flush quietly put that back — the click looked like it worked and had not.
    use.addEventListener("click", () => { zone.value = detected; touch("timeZone", detected); saveAboutNow(); paintZoneHint(); });
    zoneHint.append(use);
  }
  // An empty box is one line; it grows with what is typed and stops at NOTES_MAX_H, after which it scrolls.
  // ⚠️ Height must be cleared BEFORE reading scrollHeight, or a shrinking box keeps the tallest height it ever
  // had. `offsetHeight - clientHeight` adds the borders back, because everything here is border-box.
  function autosizeNotes() {
    if (!(notes.scrollHeight > 0)) return;   // no layout (headless): rows=1 is already the right shape
    notes.style.height = "auto";
    const chrome = (notes.offsetHeight || 0) - (notes.clientHeight || 0);
    notes.style.height = Math.min(notes.scrollHeight + chrome, NOTES_MAX_H) + "px";
  }
  paintCount(); paintZoneHint(); autosizeNotes();
}

// Derived from the provider list rather than written out, so adding an agent cannot leave this copy lying.
function joinNames(list, joiner = "and") { return list.length < 2 ? (list[0] || "") : list.slice(0, -1).join(", ") + " " + joiner + " " + list[list.length - 1]; }
function noChannelNames(joiner) { return joinNames([...PROVIDER_LIST.filter((p) => ABOUT_NO_CHANNEL.has(p.id)).map((p) => p.label), "custom commands"], joiner); }

function option(value, label) { const o = h("option", ""); o.value = value; o.textContent = label; return o; }
// ⚠️ A native select's type-ahead matches the START of an option's label, and nobody hunting for Bangkok types
// "Asia" first — they type "b". So the label LEADS with the city and the list is ordered by it; the IANA id is
// still the value, and still shown, because the zone hint and the stored profile both speak in ids.
function zoneCity(zone) { return String(zone).split("/").pop().replace(/_/g, " "); }
function zoneLabel(zone) { const city = zoneCity(zone); return city === zone ? zone : city + " — " + zone; }
function byCity(a, b) { return zoneCity(a).localeCompare(zoneCity(b)) || String(a).localeCompare(String(b)); }
function supportedZones() {
  try { return typeof Intl !== "undefined" && typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { return []; }
}
function detectedZone() {
  try { return (Intl.DateTimeFormat().resolvedOptions().timeZone) || ""; } catch { return ""; }
}

// actionRow's sibling for a control that runs something in-app rather than fetching a file.
function buttonRow(title, sub, label, onClick) {
  const r = h("div", "set-row");
  const lbl = h("div", "set-row-lbl"); lbl.append(h("div", "set-row-t", title)); if (sub) lbl.append(h("div", "set-row-s", sub));
  const action = h("button", "set-action"); action.type = "button"; action.textContent = label;
  action.addEventListener("click", onClick);
  r.append(lbl, action); return r;
}

// ── CLI Agents ──────────────────────────────────────────────────────────────
function renderAgents() {
  if (!cmds) cmds = JSON.parse(JSON.stringify(store.commands || []));
  const avail = store.availability;
  const hidden = new Set(store.hiddenProviders);
  providerSwitches.clear(); providerArgInputs.clear();

  // Built-ins remain engine-owned; this one preference controls only whether each appears in New Session.
  const built = section("Built-in agents", "builtin");
  for (const p of PROVIDER_LIST) {
    const entry = avail && avail.providers.get(p.id);
    const health = providerHealth(p.id, entry);
    const row = h("div", "set-agent-row" + (health.state === "missing" || health.state === "outdated" ? " dim" : ""));
    const icon = h("div", "set-agent-ic " + p.cls); icon.appendChild(p.mark());
    const meta = h("div", "set-agent-meta");
    meta.append(h("div", "set-agent-name", esc(p.label)));
    const cmd = (AGENT_PRESETS[p.id] || {}).command || p.id;
    meta.append(h("div", "set-agent-sub mono", esc(cmd)));
    const actions = h("div", "set-agent-actions"); actions.appendChild(healthChip(health));
    const visibility = h("div", "set-agent-toggle"); visibility.appendChild(h("span", null, "Show in New Session"));
    const toggle = switchEl(!hidden.has(p.id), (shown) => setProviderShown(p.id, shown));
    toggle.setAttribute("aria-label", "Show " + p.label + " in New Session");
    toggle.title = "Show " + p.label + " in New Session";
    providerSwitches.set(p.id, toggle); visibility.appendChild(toggle); actions.appendChild(visibility);
    row.append(icon, meta, actions);
    built.append(row);
  }
  built.append(providerArgsPanel());
  els.body.append(built);

  // custom commands — EDITABLE cards on config.commands[]
  const custom = section("Custom agents");
  const head = custom.querySelector(".set-sec-h");
  const add = h("button", "set-add", "+ Add agent"); add.type = "button";
  add.addEventListener("click", (e) => { e.stopPropagation(); openAddMenu(add); });
  const headWrap = h("div", "set-sec-head"); head.replaceWith(headWrap); headWrap.append(h("div", "set-sec-h", "Custom agents"), add);
  if (!cmds.length) custom.append(h("div", "set-empty", "No custom agents yet. Add one to run your own CLI or override a built-in."));
  cmds.forEach((c, i) => custom.append(agentCard(c, i, avail)));
  els.body.append(custom);
  if (unsaved) els.body.append(h("div", "set-unsaved", "Some agents are incomplete (need a name and command) — not saved yet."));
}

function setProviderShown(providerId, shown) {
  const next = new Set(store.hiddenProviders);
  if (shown) next.delete(providerId); else next.add(providerId);
  const ids = [...next];
  store.setHiddenProviders(ids);              // optimistic: Settings + any open picker update now
  updateConfig({ hiddenProviders: ids });     // engine echo/reload re-affirms through the same store key
}
function syncProviderControls() {
  const hidden = new Set(store.hiddenProviders);
  for (const [id, toggle] of providerSwitches) {
    const shown = !hidden.has(id);
    toggle.classList.toggle("on", shown); toggle.setAttribute("aria-checked", shown ? "true" : "false");
  }
  for (const [id, field] of providerArgInputs) {
    if (document.activeElement !== field.input) field.input.value = String(store.providerArgs[id] || "");
    paintProviderArgWarning(field.input, field.warning);
  }
}

const BYPASS_FLAGS = new Set(["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--yolo"]);
function hasPermissionBypass(value) {
  return String(value || "").trim().split(/\s+/).some((token) => BYPASS_FLAGS.has(token.replace(/^["']|["']$/g, "").toLowerCase()));
}
function paintProviderArgWarning(input, warning) {
  const show = hasPermissionBypass(input.value);
  warning.hidden = !show;
  input.classList.toggle("warn", show);
}
function saveProviderArgs(providerId, value) {
  const next = { ...store.providerArgs }, cleaned = String(value || "").trim();
  if (cleaned) next[providerId] = cleaned; else delete next[providerId];
  store.setProviderArgs(next);                // optimistic; engine echo/reload reaffirms the same map
  updateConfig({ providerArgs: next });
}
function providerArgsPanel() {
  const shell = h("div", "set-agent-advanced");
  const button = h("button", "set-agent-advanced-toggle"); button.type = "button";
  const copy = h("span", "set-agent-advanced-copy"); copy.append(h("strong", null, "Extra launch arguments"), h("small", null, "Optional · advanced"));
  const chevron = h("span", "set-agent-advanced-chevron", '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 10 4 4 4-4"/></svg>');
  button.append(copy, chevron);
  const body = h("div", "set-agent-advanced-body");
  const note = h("div", "set-agent-args-note"); note.textContent = "Applies on the next create, resume, or restart. Running sessions are not changed."; body.appendChild(note);
  for (const provider of PROVIDER_LIST) {
    const row = h("div", "set-agent-arg-row");
    const label = h("label", "set-agent-arg-label"); label.setAttribute("for", "provider-args-" + provider.id);
    label.append(h("strong", null, esc(provider.label)), h("small", "mono", esc((AGENT_PRESETS[provider.id] || {}).command || provider.id)));
    const field = h("div", "set-agent-arg-field");
    const input = h("input", "set-input mono set-agent-arg-input"); input.id = "provider-args-" + provider.id; input.value = String(store.providerArgs[provider.id] || ""); input.placeholder = "No extra arguments"; input.spellcheck = false; input.autocomplete = "off";
    const warning = h("div", "set-agent-arg-warning"); warning.id = input.id + "-warning"; warning.setAttribute("role", "status"); warning.textContent = "This bypasses the agent’s permission checks. Use only in folders you trust."; input.setAttribute("aria-describedby", warning.id);
    let timer = null;
    const persist = () => { clearTimeout(timer); timer = null; saveProviderArgs(provider.id, input.value); };
    input.addEventListener("input", () => { paintProviderArgWarning(input, warning); clearTimeout(timer); timer = setTimeout(persist, 400); });
    input.addEventListener("change", persist);
    providerArgInputs.set(provider.id, { input, warning }); paintProviderArgWarning(input, warning);
    field.append(input, warning); row.append(label, field); body.appendChild(row);
  }
  const paint = () => { body.hidden = !providerArgsOpen; button.classList.toggle("open", providerArgsOpen); button.setAttribute("aria-expanded", String(providerArgsOpen)); };
  button.addEventListener("click", () => { providerArgsOpen = !providerArgsOpen; paint(); });
  shell.append(button, body); paint(); return shell;
}

function healthChip(health) {
  if (health.state === "ok") { const c = h("div", "set-chip ok"); c.textContent = health.version ? "✓ " + trimVer(health.version) : "✓ ready"; return c; }
  if (health.state === "missing") { const w = h("div", "set-chip-wrap"); w.append(h("div", "set-chip miss", "not installed"), installBtn("Add", health.installCmd)); return w; }
  if (health.state === "outdated") { const w = h("div", "set-chip-wrap"); w.append(h("div", "set-chip old", "update — need " + health.minVersion + "+"), installBtn("Update", health.installCmd)); return w; }
  return h("div", "set-chip unknown", "checking…");
}
function trimVer(s) { const m = String(s).match(/\d+\.\d+\.\d+/); return m ? m[0] : String(s).slice(0, 24); }
function installBtn(label, installCmd) {
  const b = h("button", "set-install", label); b.type = "button"; b.disabled = !installCmd;
  if (installCmd) b.title = installCmd;
  b.addEventListener("click", () => showInstall(label, installCmd));
  return b;
}
function showInstall(label, installCmd) {
  if (!installCmd) return;
  // relies on the toast module lazily; import at call to avoid a cycle
  import("./toast.js").then(({ toast }) => toast.info({ id: "install", title: label + " agent", body: "Run this to install:\n\n`" + installCmd + "`", markdown: true, duration: 0 }));
}

function agentCard(c, i, avail) {
  const card = h("div", "set-card");
  const head = h("div", "set-card-head");
  const iconBtn = h("button", "set-card-ic"); iconBtn.type = "button"; iconBtn.title = "Change icon"; renderIconMark(iconBtn, c.icon);
  iconBtn.addEventListener("click", (e) => { e.stopPropagation(); openIconMenu(iconBtn, i); });
  const name = h("input", "set-card-name"); name.value = c.label || ""; name.placeholder = "Agent name"; name.spellcheck = false;
  name.addEventListener("input", () => { cmds[i].label = name.value; scheduleSave(); });
  const on = switchEl(c.enabled !== false, (v) => { cmds[i].enabled = v; scheduleSave(); });
  const delSlot = h("div", "set-del-slot"); delSlot.appendChild(delBtn(i, delSlot));
  head.append(iconBtn, name, h("div", "set-card-on", "On"), on, delSlot);
  card.append(head);

  const cmd = h("input", "set-input mono"); cmd.value = c.command || ""; cmd.placeholder = "e.g. claude, codex, /bin/zsh"; cmd.spellcheck = false;
  cmd.addEventListener("input", () => { cmds[i].command = cmd.value; scheduleSave(); });
  card.append(labeled("Command", cmd));

  // AI-agent + resume
  const agentRow = toggleRow("AI agent", "Enables session-resume support.", !!c.isAgent, (v) => { cmds[i].isAgent = v; if (!v) { cmds[i].canResume = false; } scheduleSave(); renderBody(); });
  card.append(agentRow);
  if (c.isAgent) {
    const resume = h("div", "set-resume");
    resume.append(toggleRow("Supports resume", "", !!c.canResume, (v) => { cmds[i].canResume = v; scheduleSave(); renderBody(); }));
    if (c.canResume) {
      const rc = h("input", "set-input mono"); rc.value = c.resumeCommand || ""; rc.placeholder = "e.g. claude --resume {{sessionId}}"; rc.spellcheck = false;
      rc.addEventListener("input", () => { cmds[i].resumeCommand = rc.value; scheduleSave(); });
      resume.append(labeled("Resume command — {{sessionId}} is substituted", rc));
      const sp = h("input", "set-input mono"); sp.value = c.sessionIdPattern || ""; sp.placeholder = "session-id regex (optional)"; sp.spellcheck = false;
      sp.addEventListener("input", () => { cmds[i].sessionIdPattern = sp.value; scheduleSave(); });
      resume.append(labeled("Session-id pattern", sp));
    }
    card.append(resume);
  }

  const env = h("textarea", "set-input mono set-env"); env.value = envText(c.env); env.rows = 2; env.placeholder = "KEY=value (one per line; invalid lines ignored)"; env.spellcheck = false;
  env.addEventListener("input", () => { cmds[i].env = parseEnv(env.value); scheduleSave(); });
  card.append(labeled("Environment", env));

  const entry = avail && avail.commands.get(c.id);
  if (entry) card.append(commandHealth(entry));
  return card;
}
function labeled(label, control) { const f = h("div", "set-field"); f.append(h("label", "set-field-l", label), control); return f; }
function commandHealth(entry) {
  const c = h("div", "set-card-health");
  if (entry.available === false) { c.className += " miss"; c.textContent = entry.error || "Not installed"; }
  else { c.className += " ok"; c.textContent = entry.version ? "✓ " + trimVer(entry.version) : "✓ found"; }
  return c;
}
function delBtn(i, slot) {
  const b = h("button", "set-del", CLOSE); b.type = "button"; b.title = "Remove agent"; b.setAttribute("aria-label", "Remove agent");
  b.addEventListener("click", () => {
    const confirm = h("div", "set-del-confirm");
    const q = h("button", "set-del-yes", "Delete?"); q.type = "button";
    const no = h("button", "set-del-no", "✕"); no.type = "button"; no.title = "Cancel";
    q.addEventListener("click", () => { cmds.splice(i, 1); renderBody(); saveNow(); });
    no.addEventListener("click", () => { slot.replaceChildren(delBtn(i, slot)); });
    confirm.append(q, no); slot.replaceChildren(confirm);
  });
  return b;
}

// icon menu — the 6 provider marks + a terminal glyph
function renderIconMark(iconBtn, icon) {
  iconBtn.replaceChildren();
  if (icon && PROVIDER_LIST.some((x) => x.id === icon)) iconBtn.appendChild(providerOf(icon).mark());
  else iconBtn.innerHTML = TERMINAL;
}
// icon picker — a menu.js popover (13c) hosting the 4-column icon grid, so it shares Escape / outside-click /
// scroll dismissal with every other menu instead of hand-rolling an outside-click-only listener.
let iconHandle = null;
function openIconMenu(anchor, i) {
  if (iconHandle) { iconHandle.close(); return; }   // toggle off on the same trigger
  const grid = h("div", "set-icon-menu");
  const pick = (icon) => { cmds[i].icon = icon; renderBody(); saveNow(); if (iconHandle) iconHandle.close(); };
  const term = h("button", "set-icon-cell", TERMINAL); term.type = "button"; term.title = "Terminal"; term.addEventListener("click", () => pick("terminal"));
  grid.append(term);
  for (const p of PROVIDER_LIST) { const cell = h("button", "set-icon-cell " + p.cls); cell.type = "button"; cell.title = p.label; cell.appendChild(p.mark()); cell.addEventListener("click", () => pick(p.id)); grid.append(cell); }
  iconHandle = openMenu(anchor, [{ render: () => grid }], { align: "start", className: "menu-form", returnFocus: anchor, onClose: () => { iconHandle = null; } });
}

// add-agent menu — the 6 presets (seed a custom command) + Custom (blank). Also a menu.js popover.
let addHandle = null;
function openAddMenu(anchor) {
  if (addHandle) { addHandle.close(); return; }   // toggle off
  const listEl = h("div", "set-add-menu");
  const item = (label, markEl, onPick) => { const b = h("button", "set-add-item"); b.type = "button"; const ic = h("span", "set-add-ic"); if (markEl) ic.appendChild(markEl); b.append(ic, h("span", null, label)); b.addEventListener("click", () => { onPick(); if (addHandle) addHandle.close(); }); return b; };
  for (const p of PROVIDER_LIST) listEl.append(item(p.label, p.mark(), () => addCommand(p.id)));
  listEl.append(h("div", "set-add-sep"));
  listEl.append(item("Custom", null, () => addCommand(null)));
  addHandle = openMenu(anchor, [{ render: () => listEl }], { align: "end", className: "menu-form", returnFocus: anchor, onClose: () => { addHandle = null; } });
}
function addCommand(presetId) {
  const p = presetId ? AGENT_PRESETS[presetId] : null;
  cmds.push({
    id: genId(),
    label: presetId ? providerOf(presetId).label : "",
    icon: presetId || "terminal",
    command: (p && p.command) || "",
    enabled: true, isAgent: presetId !== "shell" && !!presetId, canResume: false,
    env: {}, resumeCommand: null, sessionIdPattern: null,
  });
  renderBody(); saveNow();
}

// ── save (500ms-debounced for typing, immediate for structural changes) ──────
function serialize() {
  return (cmds || []).map((c) => ({
    id: c.id, label: String(c.label || "").trim(), icon: c.icon || "terminal",
    command: String(c.command || "").trim(),
    enabled: c.enabled !== false, isAgent: !!c.isAgent, canResume: !!(c.isAgent && c.canResume),
    env: c.env && typeof c.env === "object" ? c.env : {},
    resumeCommand: c.isAgent && c.canResume && c.resumeCommand ? String(c.resumeCommand) : null,
    sessionIdPattern: c.isAgent && c.canResume && c.sessionIdPattern ? String(c.sessionIdPattern) : null,
  }));
}
function allValid(list) { return list.every((c) => c.label && c.command && /^[A-Za-z0-9_-]{1,100}$/.test(c.id)); }
// A hand-rolled debounce (not util.debounce) so teardown can FLUSH a pending edit before nulling cmds.
let saveTimer = null;
let cwdTimer = null, cwdDraft = null;
const pendingPluginEdits = new Map();
function flushCwd() {
  clearTimeout(cwdTimer); cwdTimer = null;
  if (cwdDraft == null) return;
  const value = cwdDraft.trim(); cwdDraft = null;
  updateConfig({ defaultCwd: value });
}
function flushSettingsEdits() {
  flushSave(); flushAbout(); flushCwd();
  for (const commit of [...pendingPluginEdits.values()]) commit();
}
async function prepareBackup() {
  flushSettingsEdits();
  if (unsaved) throw new Error("Finish or correct your CLI agent edits before continuing.");
  const waiting = new Set(quietSettingRequests);
  if (pluginBusy?.requestId) waiting.add(pluginBusy.requestId);
  if (!waiting.size) return;
  await new Promise((resolve, reject) => {
    const off = store.on("plugin:result", (result) => {
      if (!waiting.delete(result.requestId)) return;
      if (!result.success) { clearTimeout(timer); off(); reject(new Error(result.error || "A plugin setting could not be saved.")); }
      else if (!waiting.size) { clearTimeout(timer); off(); resolve(); }
    });
    const timer = setTimeout(() => { off(); reject(new Error("Plugin settings are still saving. Please try again.")); }, 8000);
  });
}

// A pending About me edit must reach the engine before the pane that holds it goes away — the same reason
// flushSave exists for command edits. Nothing to flush unless a field was actually touched.
function flushAbout() {
  if (aboutTimer == null) return;
  clearTimeout(aboutTimer); aboutTimer = null;
  sendAboutPatch();
}

// ONLY the fields this pane was asked to change. A blank one is still sent — clearing a field is a decision,
// and the engine reads blank as "drop it" — but a field nobody touched must not ride along, or this tab
// overwrites another tab's edit of it with a value nobody asked to change.
const ABOUT_CAPS = { name: ABOUT_NAME_MAX, notes: ABOUT_NOTES_MAX };
function sendAboutPatch() {
  const about = {};
  for (const key of Object.keys(aboutDirty)) {
    const value = String(aboutDirty[key] == null ? "" : aboutDirty[key]);
    about[key] = key in ABOUT_CAPS ? value.trim().slice(0, ABOUT_CAPS[key]) : value;
  }
  if (Object.keys(about).length) updateConfig({ about });
}

function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); }
function flushSave() { if (saveTimer != null) saveNow(); }   // persist a pending debounced edit BEFORE cmds is nulled
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (cmds == null) return;   // teardown raced the debounce — NEVER serialize a null cmds to [] (would wipe every command)
  const list = serialize();
  if (!allValid(list)) { unsaved = true; return; }   // an incomplete card — keep editing, don't reject the whole patch
  unsaved = false;
  updateConfig({ commands: list });
}

// ── Plugins ─────────────────────────────────────────────────────────────────
const PLUGIN_ICON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg>';
const BACK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M19 12H5m6-6-6 6 6 6"/></svg>';
const RELOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';
const OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const PREVIEW_PLAY = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 8 5-8 5z"/></svg>';
const PREVIEW_STOP = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.5"/></svg>';
let pluginPreview = null;

function previewOption(select, definition) {
  return (definition.options || []).find((option) => String(option.value) === String(select.value));
}
function previewUrl(plugin, source) {
  const path = String(source || "").trim();
  if (!path) return "";
  if (/^(?:https?:)?\/\//i.test(path) || path[0] === "/") return path;
  return "/plugins/" + encodeURIComponent(plugin.id) + "/" + path.replace(/^\.\//, "");
}
function paintPreviewButton(button, option, playing) {
  const name = String(option && option.label || "voice");
  button.classList.toggle("playing", playing);
  button.innerHTML = playing ? PREVIEW_STOP : PREVIEW_PLAY;
  button.setAttribute("aria-pressed", playing ? "true" : "false");
  button.setAttribute("aria-label", (playing ? "Stop " : "Play ") + name + " preview");
  button.title = (playing ? "Stop " : "Play ") + name + " preview";
}
function stopPluginPreview() {
  const active = pluginPreview; pluginPreview = null;
  if (!active) return;
  try { active.audio.pause(); active.audio.removeAttribute("src"); active.audio.load(); } catch {}
  paintPreviewButton(active.button, active.option, false);
}
function togglePluginPreview(plugin, definition, select, button) {
  if (pluginPreview && pluginPreview.button === button) { stopPluginPreview(); return; }
  stopPluginPreview();
  const option = previewOption(select, definition), url = previewUrl(plugin, option && option.preview);
  if (!url) return;
  let audio;
  try { audio = new Audio(url); } catch { paintPreviewButton(button, option, false); return; }
  const active = { audio, button, option }; pluginPreview = active;
  paintPreviewButton(button, option, true);
  const finish = () => { if (pluginPreview === active) stopPluginPreview(); };
  // A preview that cannot play must SAY so. The button paints itself back to Play either way, and on a
  // missing or unplayable file that is indistinguishable from a dead control — which is what a user reports
  // when one clip in a long voice list did not ship. Only the failure paths speak; a clip that simply
  // finished is its own confirmation.
  const failed = () => {
    if (pluginPreview !== active) return;
    finish();
    import("./toast.js").then(({ toast }) => toast.error({
      title: plugin.name || plugin.id,
      body: "Couldn't play the " + String(option && option.label || "voice") + " preview.",
    }));
  };
  audio.addEventListener("ended", finish, { once: true });
  audio.addEventListener("error", failed, { once: true });
  try { Promise.resolve(audio.play()).catch(failed); } catch { failed(); }
}

function pluginById(id) { return store.plugins.find((plugin) => plugin.id === id) || null; }
function statusOf(plugin) {
  const client = pluginClientError(plugin.id);
  if (client) return { state: "failed", label: "client failed", error: client };
  const state = String(plugin.status || (plugin.enabled ? "loading" : "disabled"));
  return { state, label: ({ ready: "ready", disabled: "disabled", loading: "loading", failed: "failed", incompatible: "incompatible" })[state] || state, error: plugin.error || "" };
}
function pluginMark(plugin) {
  const mark = h("div", "plg-icon");
  const icon = String(plugin.icon || "").trim();
  if (icon && icon.length <= 4 && !/[<>]/.test(icon)) mark.textContent = icon;
  else { mark.innerHTML = PLUGIN_ICON; mark.dataset.letter = String(plugin.name || plugin.id || "P").slice(0, 1).toUpperCase(); }
  return mark;
}
function actionButton(label, cls, icon, fn) {
  const button = h("button", cls || "plg-btn"); button.type = "button"; button.disabled = !store.connected || !!pluginBusy;
  if (icon) button.innerHTML = icon + "<span>" + esc(label) + "</span>"; else button.textContent = label;
  button.addEventListener("click", fn); return button;
}
function setPluginBusy(operation, requestId, pluginId) { pluginBusy = { operation, requestId, pluginId: pluginId || "" }; pluginNotice = null; renderBody(); }
function savePluginSetting(pluginId, key, value) {
  // Setting edits save quietly: replacing the whole detail form on each debounced keystroke would move focus.
  quietSettingRequests.add(updatePluginSettings(pluginId, { [key]: value }));
}
function onPluginResult(result) {
  if (result && result.requestId && quietSettingRequests.delete(result.requestId)) {
    if (!result.success) { pluginNotice = { ok: false, text: result.error || "The setting could not be saved." }; if (cat === "plugins") renderBody(); }
    return;
  }
  if (!result || !pluginBusy) return;
  const sameRequest = result.requestId && result.requestId === pluginBusy.requestId;
  const sameLegacyOperation = !result.requestId && result.operation === pluginBusy.operation;
  if (!sameRequest && !sameLegacyOperation) return;
  const operation = pluginBusy.operation; pluginBusy = null;
  if (result.success) {
    if (operation === "install" && result.pluginId) selectedPlugin = result.pluginId;
    if (operation === "remove") selectedPlugin = null;
    pluginNotice = { ok: true, text: ({ install: "Plugin installed and ready.", remove: "Plugin removed.", setEnabled: "Plugin state updated.", settings: "Settings saved.", refresh: "Plugin folders refreshed.", openFolder: "Plugin folder opened." })[operation] || "Done." };
  } else pluginNotice = { ok: false, text: result.error || "The plugin operation failed." };
  if (cat === "plugins") renderBody();
}

function renderPlugins() {
  const selected = selectedPlugin && pluginById(selectedPlugin);
  if (selected) { renderPluginDetail(selected); return; }
  selectedPlugin = null;
  const hero = h("div", "plg-head");
  const intro = h("div", "plg-intro"); intro.append(h("div", "plg-kicker", "Local extensions"), h("div", "plg-copy", "Add viewers, tools and full workspaces without changing CliDeck."));
  const install = actionButton("Install plugin", "plg-primary", "+", () => { pluginTrust = true; renderBody(); });
  hero.append(intro, install); els.body.append(hero);

  if (pluginTrust) {
    const trust = h("div", "plg-trust");
    const shield = h("div", "plg-trust-ic", PLUGIN_ICON);
    const copy = h("div", "plg-trust-copy"); copy.append(h("div", "plg-trust-title", "Install trusted local code"), h("div", "plg-trust-sub", "Plugins run with your filesystem and network access, just like a CLI tool. CliDeck validates and copies the folder; it never runs an installer."));
    const acts = h("div", "plg-trust-actions");
    const choose = actionButton("Choose plugin folder", "plg-primary", FOLDER, () => openFolderPicker(store.defaultCwd || "/", (path) => setPluginBusy("install", installPlugin(path))));
    const cancel = h("button", "plg-quiet", "Cancel"); cancel.type = "button"; cancel.onclick = () => { pluginTrust = false; renderBody(); };
    acts.append(cancel, choose); trust.append(shield, copy, acts); els.body.append(trust);
  }

  const tools = h("div", "plg-tools");
  const search = h("div", "plg-search"); search.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  const input = h("input"); input.type = "search"; input.placeholder = "Search plugins"; input.value = pluginQuery; input.setAttribute("aria-label", "Search plugins"); search.append(input);
  const open = actionButton("Open folder", "plg-tool", OPEN, () => setPluginBusy("openFolder", openPluginFolder()));
  const refresh = actionButton("Refresh", "plg-tool", RELOAD, () => setPluginBusy("refresh", refreshPlugins()));
  tools.append(search, open, refresh); els.body.append(tools);
  if (pluginNotice) els.body.append(pluginNoticeEl());
  if (!store.connected) { els.body.append(stateCard("offline", "Engine offline", "Plugin management will return when CliDeck reconnects.")); return; }
  if (!store.pluginsLoaded) { els.body.append(pluginLoading()); return; }
  if (!store.plugins.length) { els.body.append(stateCard("empty", "No plugins installed", "Choose a trusted plugin folder, or copy one into CliDeck’s plugin folder and refresh.")); return; }
  const list = h("div", "plg-list"); for (const plugin of store.plugins) list.append(pluginRow(plugin));
  const noMatches = stateCard("empty", "No matching plugins", "Try a name, ID or capability."); noMatches.hidden = true;
  const filter = () => {
    pluginQuery = input.value; const query = pluginQuery.trim().toLowerCase(); let visible = 0;
    for (const row of list.children) { const show = !query || String(row.dataset.search || "").includes(query); row.hidden = !show; if (show) visible++; }
    list.hidden = visible === 0; noMatches.hidden = visible !== 0;
  };
  input.addEventListener("input", filter);
  els.body.append(list, noMatches); filter();
}

function pluginLoading() { const wrap = h("div", "plg-skeleton"); for (let i = 0; i < 3; i++) wrap.append(h("div", "plg-sk-row", '<i></i><span></span><b></b>')); return wrap; }
function stateCard(kind, title, text) { const state = h("div", "plg-state " + kind); state.append(h("div", "plg-state-ic", PLUGIN_ICON), h("div", "plg-state-title", title), h("div", "plg-state-sub", text)); return state; }
function pluginNoticeEl() { const notice = h("div", "plg-notice " + (pluginNotice.ok ? "ok" : "bad")); notice.setAttribute("role", pluginNotice.ok ? "status" : "alert"); notice.textContent = pluginNotice.text; return notice; }
function pluginRow(plugin) {
  const status = statusOf(plugin), row = h("div", "plg-row " + status.state);
  row.dataset.search = [plugin.name, plugin.id, plugin.description].map((value) => String(value || "").toLowerCase()).join("\0");
  const open = h("button", "plg-row-main"); open.type = "button"; open.setAttribute("aria-label", "Open " + plugin.name + " settings"); open.onclick = () => { selectedPlugin = plugin.id; pluginNotice = null; renderBody(); };
  const meta = h("div", "plg-meta");
  const line = h("div", "plg-name-line"); line.append(h("span", "plg-name", esc(plugin.name)), h("span", "plg-version", "v" + esc(plugin.version || "—")));
  meta.append(line, h("div", "plg-desc", esc(plugin.description || plugin.id)));
  open.append(pluginMark(plugin), meta);
  const right = h("div", "plg-row-right"); right.append(statusChip(status));
  const sw = switchEl(plugin.enabled !== false, (enabled) => { setPluginBusy("setEnabled", setPluginEnabled(plugin.id, enabled), plugin.id); });
  sw.disabled = !store.connected || !!pluginBusy || status.state === "incompatible"; sw.setAttribute("aria-label", (plugin.enabled ? "Disable " : "Enable ") + plugin.name);
  right.append(sw); row.append(open, right); return row;
}
function statusChip(status) { const chip = h("span", "plg-status " + status.state); if (status.state === "loading") chip.append(h("i", "plg-spinner")); chip.append(h("span", null, esc(status.label))); return chip; }

function renderPluginDetail(plugin) {
  const status = statusOf(plugin);
  const top = h("div", "plg-detail-head");
  const back = h("button", "plg-back", BACK); back.type = "button"; back.setAttribute("aria-label", "Back to plugins"); back.onclick = () => { selectedPlugin = null; pluginNotice = null; renderBody(); };
  const ident = h("div", "plg-detail-ident"); ident.append(pluginMark(plugin));
  const names = h("div"); names.append(h("div", "plg-detail-name", esc(plugin.name)), h("div", "plg-detail-id mono", esc(plugin.id) + " · v" + esc(plugin.version || "—")));
  ident.append(names); top.append(back, ident, statusChip(status)); els.body.append(top);
  if (plugin.description) els.body.append(h("p", "plg-detail-desc", esc(plugin.description)));
  if (pluginNotice) els.body.append(pluginNoticeEl());
  if (status.error) {
    const failure = h("div", "plg-failure"); failure.setAttribute("role", "alert"); failure.append(h("div", "plg-failure-title", status.state === "incompatible" ? "This plugin is incompatible" : "This plugin could not start"), h("div", "plg-failure-copy", esc(status.error)));
    els.body.append(failure);
  }
  const control = section("Plugin state");
  const sw = toggleRow("Enabled", plugin.source === "bundled" ? "Bundled with CliDeck; disabling removes its contributions." : "Stops the plugin and removes its actions, viewers and hotkeys.", plugin.enabled !== false, (enabled) => setPluginBusy("setEnabled", setPluginEnabled(plugin.id, enabled), plugin.id));
  const toggle = sw.querySelector(".set-switch"); if (toggle) toggle.disabled = !!pluginBusy || status.state === "incompatible" || !store.connected;
  control.append(sw); els.body.append(control);
  renderPluginSettingFields(plugin);
  if (Array.isArray(plugin.commands) && plugin.commands.length) {
    const commands = section("Agent commands");
    for (const command of plugin.commands) { const row = h("div", "plg-command"); row.append(h("code", null, "clideck " + esc(command.usage || (plugin.id + "/" + command.name))), h("span", null, esc(command.description))); commands.append(row); }
    els.body.append(commands);
  }
  const danger = section("Management");
  const actions = h("div", "plg-manage"); actions.append(actionButton("Open plugins folder", "plg-btn", OPEN, () => setPluginBusy("openFolder", openPluginFolder())));
  if (plugin.source === "user") {
    const remove = h("button", "plg-remove", "Remove plugin"); remove.type = "button"; remove.disabled = !!pluginBusy || !store.connected;
    remove.onclick = () => showRemoveConfirm(actions, plugin); actions.append(remove);
  } else actions.append(h("span", "plg-bundled", "Bundled plugin · cannot be removed"));
  danger.append(actions); els.body.append(danger);
}
function showRemoveConfirm(host, plugin) {
  const confirm = h("div", "plg-remove-confirm"); confirm.append(h("span", null, "Remove “" + esc(plugin.name) + "”?"));
  const cancel = h("button", "plg-quiet", "Cancel"); cancel.type = "button"; cancel.onclick = () => renderBody();
  const yes = h("button", "plg-remove", "Remove"); yes.type = "button"; yes.onclick = () => setPluginBusy("remove", removePlugin(plugin.id), plugin.id);
  confirm.append(cancel, yes); host.replaceChildren(confirm);
}
function renderPluginSettingFields(plugin) {
  if (!Array.isArray(plugin.settings) || !plugin.settings.length) return;
  const sec = section("Settings");
  for (const definition of plugin.settings) sec.append(pluginSetting(plugin, definition));
  els.body.append(sec);
}
function pluginSetting(plugin, definition) {
  const value = plugin.values && Object.hasOwn(plugin.values, definition.key) ? plugin.values[definition.key] : definition.default;
  const row = h("div", "plg-setting" + (definition.type === "textarea" ? " tall" : ""));
  const label = h("label", "plg-setting-label"); label.append(h("span", null, esc(definition.label)));
  if (definition.description) label.append(h("small", null, esc(definition.description)));
  const save = (next) => savePluginSetting(plugin.id, definition.key, next);
  let input;
  if (definition.type === "toggle") {
    input = switchEl(!!value, save); input.setAttribute("aria-label", definition.label); label.setAttribute("for", ""); row.append(label, input); return row;
  }
  if (definition.type === "shortcut") { label.setAttribute("for", ""); row.append(label, shortcutControl(plugin, definition, value, save)); return row; }
  if (definition.type === "textarea") { input = h("textarea", "set-input plg-textarea"); input.rows = 4; input.value = String(value == null ? "" : value); }
  else if (definition.type === "select" || definition.type === "dynamic-select") {
    input = h("select", "set-select plg-select"); for (const option of definition.options || []) { const op = h("option"); op.value = option.value; op.textContent = option.label; op.selected = option.value === value; input.append(op); } input.value = String(value == null ? "" : value);
  } else { input = h("input", "set-input" + (definition.type === "path" ? " mono" : "")); input.type = definition.type === "secret" ? "password" : definition.type === "number" ? "number" : definition.type === "color" ? "color" : "text"; if (definition.type !== "secret") input.value = String(value == null ? "" : value); if (definition.min != null) input.min = definition.min; if (definition.max != null) input.max = definition.max; }
  input.id = "plugin-setting-" + plugin.id + "-" + definition.key; label.setAttribute("for", input.id);
  if (definition.type === "secret") input.placeholder = plugin.configured && plugin.configured[definition.key] ? "Saved — type to replace" : "Not configured";
  const control = input; // wrappers add preview/browse chrome later; values always belong to the native control
  const commit = () => { let next = control.value; if (definition.type === "number") { next = Number(next); if (!Number.isFinite(next)) return; } if (definition.type === "secret" && !next) return; save(next); };
  if (["select", "dynamic-select", "number", "color"].includes(definition.type)) input.addEventListener("change", () => { stopPluginPreview(); commit(); });
  else {
    let timer = null;
    const flush = () => { clearTimeout(timer); pendingPluginEdits.delete(control); commit(); };
    input.addEventListener("input", () => { clearTimeout(timer); pendingPluginEdits.set(control, flush); timer = setTimeout(flush, 450); });
  }
  if (definition.type === "secret" && plugin.configured && plugin.configured[definition.key]) {
    const wrap = h("div", "plg-secret"); const clear = h("button", "plg-clear", "Clear saved secret"); clear.type = "button";
    clear.setAttribute("aria-label", "Clear " + definition.label); clear.onclick = () => { input.value = ""; input.placeholder = "Not configured"; clear.disabled = true; clear.textContent = "Cleared"; save(""); };
    wrap.append(input, clear); input = wrap;
  }
  if (definition.type === "path") {
    const wrap = h("div", "plg-path"); const browse = h("button", "set-browse", FOLDER); browse.type = "button"; browse.title = "Browse folders"; browse.setAttribute("aria-label", "Browse " + definition.label); browse.onclick = () => openFolderPicker(input.value || store.defaultCwd || "/", (path) => { input.value = path; save(path); }); wrap.append(input, browse); input = wrap;
  }
  if ((definition.type === "select" || definition.type === "dynamic-select") && (definition.options || []).some((option) => option.preview)) {
    const select = input, wrap = h("div", "plg-select-wrap");
    const preview = h("button", "plg-preview"); preview.type = "button";
    const refresh = () => { const option = previewOption(select, definition), available = !!(option && option.preview); preview.hidden = !available; if (available) paintPreviewButton(preview, option, false); };
    preview.addEventListener("click", () => togglePluginPreview(plugin, definition, select, preview));
    select.addEventListener("change", refresh); refresh(); wrap.append(select, preview); input = wrap;
  }
  row.append(label, input); return row;
}

function shortcutText(combo) {
  if (!combo) return "Not set";
  return String(combo).split("+").map((part) => {
    if (part === "Ctrl") return IS_MAC ? "⌘" : "Ctrl";
    if (part === "Alt") return IS_MAC ? "⌥" : "Alt";
    if (part === "Shift") return IS_MAC ? "⇧" : "Shift";
    return part.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, "");
  }).join(IS_MAC ? "" : " + ");
}
function shortcutControl(plugin, definition, initial, save) {
  let value = String(initial || ""), recording = false;
  const wrap = h("div", "plg-shortcut");
  const record = h("button", "plg-shortcut-record"); record.type = "button"; record.dataset.hotkeyRecorder = "true";
  const keys = h("kbd", "plg-shortcut-keys"); const state = h("span", "plg-shortcut-state"); state.setAttribute("aria-live", "polite");
  const clear = h("button", "plg-shortcut-clear", CLOSE); clear.type = "button";
  const paint = (message = "", error = false) => {
    record.classList.toggle("recording", recording); record.setAttribute("aria-pressed", recording ? "true" : "false");
    record.setAttribute("aria-label", (recording ? "Press " : "Record ") + definition.label + " keyboard shortcut");
    record.title = recording ? "Press a shortcut · Escape to cancel" : "Record keyboard shortcut";
    keys.textContent = recording ? "Press keys…" : shortcutText(value); keys.classList.toggle("empty", !value && !recording);
    state.textContent = message; state.classList.toggle("error", error);
    clear.hidden = !value || recording;
  };
  record.addEventListener("click", () => { recording = !recording; paint(); });
  record.addEventListener("keydown", (event) => {
    if (!recording) return;
    event.preventDefault(); event.stopPropagation();
    if (event.code === "Escape") { recording = false; paint("Recording cancelled"); return; }
    if (/^(?:Control|Meta|Alt|Shift)(?:Left|Right)$/.test(event.code || "")) return;
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    // A bare FUNCTION key is allowed; anything else needs a modifier, or the shortcut would swallow ordinary
    // typing. The set and the spelling both come from hotkeys.js, which is what the dispatcher keys the
    // registry on — a recorder with its own idea of either would save a shortcut that never fires.
    if (!hasModifier && !isFunctionKey(hotkeyCodeFromEvent(event))) { paint("Add Control, Command, or Alt", true); return; }
    const next = hotkeyComboFromEvent(event), conflict = hotkeyConflict(next, plugin.id);
    if (conflict) { paint("Already used by " + conflict.pluginId, true); return; }
    value = next; recording = false; paint(); save(value);
  });
  clear.setAttribute("aria-label", "Clear " + definition.label + " keyboard shortcut"); clear.title = "Clear keyboard shortcut";
  clear.addEventListener("click", () => { value = ""; recording = false; paint("Shortcut cleared"); save(""); record.focus(); });
  record.append(keys); wrap.append(record, clear, state); paint(); return wrap;
}

// ── Notifications (reuses notify.js — single source of truth) ────────────────
function renderNotifications() {
  const prefs = getPrefs();
  const master = section("Delivery", "delivery");
  master.append(toggleRow("Notifications", "Pause or restore all automatic sounds and browser alerts.", !!prefs.enabled, (v) => setPref("enabled", v)));
  if (!prefs.enabled) master.append(h("div", "set-hint", "Delivery is paused. Your preferences below stay saved."));
  els.body.append(master);
  const sec = section("Idle & dispatch");
  const soundRow = toggleRow("Idle sound", "Beep when an agent finishes working.", !!prefs.sound, (v) => setPref("sound", v));
  sec.append(soundRow);
  sec.append(selectRow("Sound", SOUND_OPTS, "id", prefs.pick, (v) => setPref("pick", v), () => previewSound("sound")));
  sec.append(selectRow("Minimum work before alerting", MINWORK_OPTS, "v", prefs.minWorkSec, (v) => setPref("minWorkSec", Number(v))));
  sec.append(toggleRow("Browser alerts", "A desktop notification when the tab is hidden.", !!prefs.browser, (v) => { if (v) enableBrowser(); else setPref("browser", false); }));
  const perm = notifyPermission();
  if (perm === "denied") sec.append(h("div", "set-hint warn", "Notifications are blocked — enable them for this site in your browser settings."));
  else if (perm === "unsupported") sec.append(h("div", "set-hint", "This browser doesn't support notifications."));
  sec.append(toggleRow("Dispatch sound", "Cue when /ask sends work into a session.", !!prefs.dispatch, (v) => setPref("dispatch", v)));
  sec.append(selectRow("Dispatch sound", DISPATCH_OPTS, "id", prefs.dispatchPick, (v) => setPref("dispatchPick", v), () => previewSound("dispatch")));
  els.body.append(sec);
}
function selectRow(label, opts, keyField, cur, onChange, onPreview) {
  const r = h("div", "set-row");
  r.append(h("div", "set-row-lbl", label));
  const wrap = h("div", "set-sel-wrap");
  const sel = h("select", "set-select");
  for (const o of opts) { const op = h("option"); op.value = String(o[keyField]); op.textContent = o.label; if (String(o[keyField]) === String(cur)) op.selected = true; sel.appendChild(op); }
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.append(sel);
  if (onPreview) { const prev = h("button", "set-prev", "▶"); prev.type = "button"; prev.title = "Preview"; prev.addEventListener("click", onPreview); wrap.append(prev); }
  r.append(wrap);
  return r;
}

// ── Appearance ──────────────────────────────────────────────────────────────
function renderAppearance() {
  const mode = section("App mode");
  const seg = h("div", "set-seg");
  for (const p of THEME_PREFS) {
    const b = h("button", "set-seg-b" + (themePref() === p ? " on" : "")); b.type = "button"; b.textContent = THEME_LABELS[p].split(" ")[0];
    b.addEventListener("click", () => { setThemePref(p); renderBody(); });
    seg.append(b);
  }
  mode.append(seg, h("div", "set-hint", "Auto follows your system. The active app mode picks the matching default terminal theme below."));
  els.body.append(mode);

  for (const m of ["dark", "light"]) {
    const sec = section(m === "dark" ? "Default dark-mode terminal theme" : "Default light-mode terminal theme");
    const curId = defaultThemeId(m);
    const big = h("div", "set-theme-big"); paintBig(big, curId);
    sec.append(big);
    const grid = h("div", "set-theme-grid");
    for (const t of allThemes().filter((x) => x.mode === m)) {
      const card = h("button", "set-theme-card" + (t.id === curId ? " sel" : "")); card.type = "button"; card.title = t.name; card.style.setProperty("--tc", t.accent);
      card.innerHTML = '<div class="set-theme-mini" style="background:' + t.theme.background + ';color:' + t.theme.foreground + '">' + previewHtml(t.theme) + '</div><div class="set-theme-name">' + esc(t.name) + "</div>";
      card.addEventListener("click", () => { setDefaultTheme(m, t.id); renderBody(); });
      grid.append(card);
    }
    sec.append(grid);
    els.body.append(sec);
  }
}
function paintBig(el, id) { const t = getTheme(id); el.innerHTML = '<div class="set-theme-preview" style="background:' + t.theme.background + ';color:' + t.theme.foreground + '">' + previewHtml(t.theme) + '</div><div class="set-theme-cur">Current: <b>' + esc(t.name) + "</b></div>"; }

// ── lifecycle ────────────────────────────────────────────────────────────────
function onKey(e) { if (e.key === "Escape") { if (isRestoreOpen()) return; const recorder = e.target && e.target.closest && e.target.closest("[data-hotkey-recorder]"); if ((recorder && recorder.getAttribute("aria-pressed") === "true") || isMenuOpen() || document.body.classList.contains("tour-active")) return; close(); } }   // an active recorder/sub-menu/tour owns Escape before Settings
function close() {
  if (!overlay) return;
  stopPluginPreview();
  flushSettingsEdits(); // Save drafts before their controls are removed.
  document.removeEventListener("keydown", onKey, true);
  offs.forEach((off) => off()); offs = [];
  closeMenu();   // close any open icon/add sub-menu popover
  const ov = overlay; overlay = null; els = null; cmds = null; unsaved = false; cat = "general"; providerSwitches.clear(); providerArgInputs.clear(); providerArgsOpen = false;
  selectedPlugin = null; pluginQuery = ""; pluginTrust = false; pluginNotice = null; pluginBusy = null;
  quietSettingRequests.clear();
  aboutDirty = {};
  ov.classList.remove("show");
  setTimeout(() => ov.remove(), 160);
}

export function openPluginSettings(pluginId) {
  cat = "plugins"; selectedPlugin = String(pluginId || ""); pluginNotice = null;
  if (!overlay) openSettings(); else render();
}

function envText(env) { return Object.entries(env || {}).map(([k, v]) => k + "=" + (v == null ? "" : v)).join("\n"); }
function parseEnv(text) {
  const env = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;   // drop invalid lines (v1 settings.js:179-191)
    env[k] = line.slice(i + 1).trim();
  }
  return env;
}

// Host-owned declarative picker for plugin Workers. Plugins supply bounded text data only; CliDeck owns
// validation, markup, search, focus, keyboard navigation and the per-plugin recent history.
import { h } from "../util.js";

const MAX_ITEMS = 256;
const MAX_RECENT = 16;
const SEARCH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
const CLOSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
let active = null;

const safeHostId = (value) => /^[a-z][a-z0-9-]{0,62}$/.test(String(value || ""));
const text = (value, max) => String(value == null ? "" : value).trim().slice(0, max);

function normalize(pluginId, options) {
  if (!safeHostId(pluginId) || !options || typeof options !== "object") throw new Error("Invalid picker request.");
  const id = text(options.id, 63), title = text(options.title, 120);
  if (!safeHostId(id) || !title) throw new Error("Picker id and title are required.");
  if (!Array.isArray(options.items) || options.items.length > MAX_ITEMS) throw new Error("Picker items must contain at most 256 entries.");
  const seen = new Set();
  const items = options.items.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid picker item.");
    const itemId = text(raw.id, 128), label = text(raw.label, 120);
    if (!itemId || !label || seen.has(itemId)) throw new Error("Picker item ids and labels must be unique and non-empty.");
    if (raw.keywords != null && !Array.isArray(raw.keywords)) throw new Error("Picker item keywords must be an array.");
    seen.add(itemId);
    return {
      id: itemId,
      glyph: text(raw.glyph, 32) || "•",
      label,
      keywords: (raw.keywords || []).slice(0, 16).map((word) => text(word, 64)).filter(Boolean),
      group: text(raw.group, 64),
    };
  });
  const recentLimit = options.recentLimit == null ? 8 : Math.max(0, Math.min(MAX_RECENT, Number.isInteger(options.recentLimit) ? options.recentLimit : 8));
  return { pluginId, id, title, placeholder: text(options.placeholder, 120) || "Search", items, recentLimit };
}

function recentKey(def) { return `clideck.picker.${def.pluginId}.${def.id}.recent`; }
function readRecent(def) {
  if (!def.recentLimit) return [];
  try {
    const ids = JSON.parse(localStorage.getItem(recentKey(def)) || "[]");
    return Array.isArray(ids) ? ids.filter((id) => def.items.some((item) => item.id === id)).slice(0, def.recentLimit) : [];
  } catch { return []; }
}
function saveRecent(def, id) {
  if (!def.recentLimit) return;
  try { localStorage.setItem(recentKey(def), JSON.stringify([id, ...readRecent(def).filter((value) => value !== id)].slice(0, def.recentLimit))); } catch {}
}

function itemButton(item, choose) {
  const button = h("button", "pk-item"); button.type = "button"; button.dataset.itemId = item.id;
  button.setAttribute("role", "gridcell"); button.title = item.label;
  const glyph = h("span", "pk-glyph"); glyph.textContent = item.glyph; glyph.setAttribute("aria-hidden", "true");
  const label = h("span", "pk-label"); label.textContent = item.label;
  button.append(glyph, label); button.addEventListener("click", () => choose(item.id));
  return button;
}

export function openPluginPicker(pluginId, options) {
  const def = normalize(pluginId, options);
  if (active) active.finish(null);
  const previousFocus = document.activeElement;
  let resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const overlay = h("div", "pk-overlay");
  const modal = h("div", "pk-modal"); modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true");
  const head = h("div", "pk-head");
  const mark = h("span", "pk-mark"); mark.setAttribute("aria-hidden", "true");
  const heading = h("div", "pk-heading");
  const title = h("h2", "pk-title"); title.id = "pk-title"; title.textContent = def.title; modal.setAttribute("aria-labelledby", title.id);
  const count = h("span", "pk-count"); count.textContent = `${def.items.length} choices`;
  heading.append(title, count);
  const x = h("button", "pk-close", CLOSE); x.type = "button"; x.title = "Close"; x.setAttribute("aria-label", "Close picker");
  head.append(mark, heading, x);
  const search = h("label", "pk-search"); search.innerHTML = SEARCH;
  const input = h("input", "pk-input"); input.type = "search"; input.placeholder = def.placeholder; input.autocomplete = "off"; input.spellcheck = false; input.setAttribute("aria-label", def.placeholder);
  search.appendChild(input);
  const chips = h("div", "pk-chips"); chips.setAttribute("aria-label", "Categories");
  const results = h("div", "pk-results");
  const footer = h("div", "pk-foot", '<span><kbd>↑↓←→</kbd> Navigate</span><span><kbd>↵</kbd> Choose</span><span><kbd>esc</kbd> Close</span>');
  modal.append(head, search, chips, results, footer); overlay.appendChild(modal); document.body.appendChild(overlay);

  let group = "", visibleButtons = [];
  const groups = [...new Set(def.items.map((item) => item.group).filter(Boolean))];
  const recentItems = () => readRecent(def).map((id) => def.items.find((item) => item.id === id)).filter(Boolean);
  const finish = (value) => {
    if (!active || active.overlay !== overlay) return;
    document.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("cd-modal-open");
    overlay.remove(); active = null;
    if (value != null) saveRecent(def, value);
    if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
    resolveResult(value);
  };
  const choose = (id) => finish(id);

  function renderChips() {
    chips.replaceChildren();
    for (const name of ["", ...groups]) {
      const chip = h("button", "pk-chip" + (name === group ? " on" : "")); chip.type = "button";
      chip.textContent = name || "All"; chip.setAttribute("aria-pressed", String(name === group));
      chip.addEventListener("click", () => { group = name; renderChips(); renderResults(); input.focus(); });
      chips.appendChild(chip);
    }
  }
  function matches(item, query) {
    if (group && item.group !== group) return false;
    if (!query) return true;
    return [item.label, item.glyph, item.group, ...item.keywords].join(" ").toLocaleLowerCase().includes(query);
  }
  function grid(items, cls, label) {
    const node = h("div", "pk-grid" + (cls ? " " + cls : "")); node.setAttribute("role", "grid"); node.setAttribute("aria-label", label);
    for (const item of items) node.appendChild(itemButton(item, choose));
    return node;
  }
  function renderResults() {
    const query = input.value.trim().toLocaleLowerCase();
    const filtered = def.items.filter((item) => matches(item, query));
    results.replaceChildren();
    const recent = !query && !group ? recentItems() : [];
    if (recent.length) {
      const section = h("section", "pk-recent");
      const label = h("div", "pk-section-label", "Recent");
      section.append(label, grid(recent, "pk-grid-recent", "Recent choices")); results.appendChild(section);
    }
    if (filtered.length) results.appendChild(grid(filtered, "", "Choices"));
    else {
      const empty = h("div", "pk-empty");
      const big = h("strong", null, "No matches");
      const small = h("span"); small.textContent = "Try another word or category.";
      empty.append(big, small); results.appendChild(empty);
    }
    visibleButtons = [...results.querySelectorAll(".pk-item")];
    count.textContent = query || group ? `${filtered.length} of ${def.items.length}` : `${def.items.length} choices`;
  }
  function moveGrid(event, delta) {
    if (!visibleButtons.length) return;
    const index = visibleButtons.indexOf(document.activeElement);
    if (index < 0) { visibleButtons[0].focus(); return; }
    let next = index + delta;
    if (Math.abs(delta) > 1) {
      const from = visibleButtons[index].getBoundingClientRect();
      const direction = Math.sign(delta);
      const candidates = visibleButtons.map((button, i) => ({ button, i, rect: button.getBoundingClientRect() }))
        .filter(({ i, rect }) => i !== index && direction * (rect.top - from.top) > 2)
        .sort((a, b) => Math.abs(a.rect.left - from.left) - Math.abs(b.rect.left - from.left) || Math.abs(a.rect.top - from.top) - Math.abs(b.rect.top - from.top));
      if (candidates.length) next = candidates[0].i;
      else next = index + delta;
    }
    next = Math.max(0, Math.min(visibleButtons.length - 1, next));
    visibleButtons[next].focus(); visibleButtons[next].scrollIntoView?.({ block: "nearest" }); event.preventDefault();
  }
  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); return; }
    const item = document.activeElement && document.activeElement.closest && document.activeElement.closest(".pk-item");
    if (document.activeElement === input && event.key === "ArrowDown") { event.preventDefault(); visibleButtons[0]?.focus(); return; }
    if (!item) return;
    if (event.key === "ArrowRight") moveGrid(event, 1);
    else if (event.key === "ArrowLeft") moveGrid(event, -1);
    else if (event.key === "ArrowDown") moveGrid(event, 6);
    else if (event.key === "ArrowUp") {
      const before = document.activeElement; moveGrid(event, -6); if (document.activeElement === before && visibleButtons.indexOf(before) < 6) input.focus();
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(item.dataset.itemId); }
  }

  input.addEventListener("input", renderResults);
  x.addEventListener("click", () => finish(null));
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) finish(null); });
  document.addEventListener("keydown", onKey, true);
  document.body.classList.add("cd-modal-open");
  renderChips(); renderResults();
  active = { pluginId, overlay, finish };
  requestAnimationFrame(() => {
    if (active?.overlay !== overlay) return;
    overlay.classList.add("show");
    (results.querySelector(".pk-recent .pk-item") || input).focus();
  });
  return promise;
}

export function closePluginPicker(pluginId) {
  if (!active || (pluginId && active.pluginId !== pluginId)) return false;
  active.finish(null); return true;
}

export function __activePickerForTest() { return active; }

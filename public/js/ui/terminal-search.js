import { SearchAddon } from "../../vendor/addon-search.mjs";
import { store } from "../store.js";
import { h } from "../util.js";

const LIMIT = 1000;
const decorations = {
  matchBorder: "#b88b45", activeMatchBorder: "#f5c96b",
  matchOverviewRuler: "#b88b45", activeMatchColorOverviewRuler: "#f5c96b",
};
const icon = path => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

// Search owns only the retained xterm buffer. It never sends terminal input or
// changes saved history. Keep its field outside #term's clipboard/input handlers.
// The desktop app's Find menu item lands here: its native accelerator can take Cmd+F before the page sees it.
let openSearch = null;
export function openTerminalSearch() { if (openSearch) openSearch(); }

export function initTerminalSearch(term) {
  const panel = document.getElementById("term-panel");
  if (!panel) return;
  let addon = null, timer = null, composing = false;
  const bar = h("div", "term-search"); bar.hidden = true;
  bar.setAttribute("role", "search"); bar.setAttribute("aria-label", "Search terminal scrollback");
  const row = h("div", "term-search-row");
  const input = h("input", "term-search-input"); input.type = "text"; input.maxLength = 256;
  input.placeholder = "Find in terminal…"; input.spellcheck = false;
  input.setAttribute("aria-label", "Find in terminal");
  const count = h("span", "term-search-count"); count.setAttribute("role", "status");
  const button = (label, path, click) => {
    const node = h("button", "term-search-button", icon(path)); node.type = "button";
    node.title = label; node.setAttribute("aria-label", label); node.onclick = click;
    return node;
  };
  const previous = button("Previous match (Shift+Enter)", "M6 14l6-6 6 6", () => find(true));
  const next = button("Next match (Enter)", "M6 10l6 6 6-6", () => find());
  const close = button("Close search (Escape)", "M6 6l12 12M18 6L6 18", () => dismiss(true));
  const hint = h("div", "term-search-hint"); hint.textContent = "Searches retained terminal history";
  row.append(input, count, previous, next, close); bar.append(row, hint); panel.append(bar);

  function find(backward = false, incremental = false) {
    clearTimeout(timer); timer = null;
    if (bar.hidden || composing) return;
    const query = input.value;
    previous.disabled = next.disabled = !query;
    if (!query) {
      addon.clearDecorations(); term.clearSelection(); count.textContent = "";
      hint.textContent = "Searches retained terminal history"; return;
    }
    addon[backward ? "findPrevious" : "findNext"](query, { regex: false, caseSensitive: false, incremental, decorations });
  }
  function dismiss(restoreFocus = false) {
    if (bar.hidden) return;
    const ownedFocus = bar.contains(document.activeElement);
    clearTimeout(timer); timer = null; composing = false;
    bar.hidden = true;
    // Dispose cancels the addon's pending output-refresh timer as well as highlights.
    addon.dispose(); addon = null; term.clearSelection();
    if (restoreFocus && ownedFocus && !panel.hidden) term.focus();
  }
  openSearch = () => { if (!panel.hidden && store.active()) open(); };
  function open() {
    if (!addon) {
      addon = new SearchAddon({ highlightLimit: LIMIT }); term.loadAddon(addon);
      addon.onDidChangeResults(({ resultIndex, resultCount }) => {
        count.textContent = resultCount >= LIMIT ? `${LIMIT}+` : !resultCount ? "No matches"
          : resultIndex < 0 ? `${resultCount} matches` : `${resultIndex + 1} / ${resultCount}`;
        hint.textContent = resultCount >= LIMIT ? "First 1,000 matches highlighted · Keep typing to narrow" : "Searches retained terminal history";
      });
    }
    bar.hidden = false; input.focus(); input.select(); find(false, true);
  }
  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (!composing) timer = setTimeout(() => find(false, true), 120);
  });
  input.addEventListener("compositionstart", () => { composing = true; clearTimeout(timer); });
  input.addEventListener("compositionend", () => { composing = false; find(false, true); });
  document.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229 || composing || panel.hidden || !store.active()) return;
    const inBar = bar.contains(event.target);
    const inTerminal = term.element?.contains(event.target);
    const findKey = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f";
    if (findKey && (inTerminal || inBar)) {
      event.preventDefault(); event.stopImmediatePropagation(); open();
    } else if (inBar && (event.key === "Escape" || (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey))) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Escape") dismiss(true);
      else if (event.target === input) find(event.shiftKey);
      else event.target.click();
    }
  }, true);
  store.on("active", () => dismiss());
  store.on("reset", () => dismiss());
}

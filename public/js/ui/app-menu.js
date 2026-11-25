// The sidebar footer's app menu: everything app-wide that is not an everyday toggle, with words instead of a row
// of guessable icons. Tools you open (Prompts, Task Manager, Monitors), plugin tools + Manage plugins, and Theme.
// Works with no session open. A Monitors problem puts a dot on the button and a count on the item.
import { store } from "../store.js";
import { openMenu, closeMenu } from "./menu.js";
import { openPromptLibrary } from "./prompts.js";
import { openTaskManager } from "./task-manager.js";
import { openMonitors, monitorsNeedingAttention } from "./monitors.js";
import { appPluginMenuItems } from "./plugin-host.js";
import { themePref, setThemePref, THEME_PREFS, THEME_LABELS } from "../theme.js";

const icon = (path) => { const s = document.createElement("span"); s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + path + "</svg>"; return s; };
const ICONS = {
  prompts: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h8"/><path d="M7 13h5"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 16v-4m5 4V7m5 9v-6"/>',
  monitors: '<circle cx="12" cy="12" r="9"/><path d="M12 7a5 5 0 1 0 5 5"/><path d="M12 12l5.5-5.5"/>',
  plugins: '<path d="M9.5 4.5a2 2 0 1 1 4 0V6H17a1 1 0 0 1 1 1v3.5h1.5a2 2 0 1 1 0 4H18V18a1 1 0 0 1-1 1h-3.5v-1.5a2 2 0 1 0-4 0V19H6a1 1 0 0 1-1-1v-3.5h1.5a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1h3.5z"/>',
};
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let button = null;
function paint() {
  if (!button) return;
  const alerts = monitorsNeedingAttention();
  button.classList.toggle("has-alert", alerts > 0);
  button.title = alerts ? `Monitors — ${alerts} need${alerts === 1 ? "s" : ""} attention` : "Prompts, Task Manager, Monitors, plugins and theme";
}

function themeRow() {
  const row = document.createElement("div"); row.className = "app-theme";
  const label = document.createElement("span"); label.className = "app-theme-l"; label.textContent = "Theme";
  const seg = document.createElement("div"); seg.className = "tasks-seg app-theme-seg"; seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Theme");
  const paintSeg = () => { for (const b of seg.children) b.setAttribute("aria-pressed", String(b.dataset.value === themePref())); };
  for (const pref of THEME_PREFS) {
    const b = document.createElement("button"); b.type = "button"; b.className = "tasks-seg-b"; b.dataset.value = pref;
    b.textContent = { auto: "Auto", light: "Light", dark: "Dark" }[pref] || pref;
    b.title = THEME_LABELS[pref] || pref;
    b.addEventListener("click", () => { setThemePref(pref); paintSeg(); });
    seg.append(b);
  }
  paintSeg(); row.append(label, seg); return row;
}

async function open(event) {
  const alerts = monitorsNeedingAttention();
  const plugins = await appPluginMenuItems();
  // Close the menu first (focus returns to this button), then open the window: it takes focus and hands it
  // back to the button when it closes. The other order let the closing menu pull focus out of the window.
  const then = (fn) => (ctl) => { ctl.close(); fn(); };
  const items = [
    { label: "Prompt library", icon: icon(ICONS.prompts), onSelect: then(() => openPromptLibrary()) },
    { label: "Task Manager", icon: icon(ICONS.tasks), onSelect: then(() => openTaskManager()) },
    alerts
      ? { html: `<span class="mi-label">Monitors</span><span class="mi-badge" title="Need attention">${esc(alerts)}</span>`, icon: icon(ICONS.monitors), onSelect: then(() => openMonitors()) }
      : { label: "Monitors", icon: icon(ICONS.monitors), onSelect: then(() => openMonitors()) },
    { separator: true },
    ...plugins,
    { label: "Manage plugins…", icon: icon(ICONS.plugins), onSelect: then(() => import("./settings.js").then((m) => m.openSettingsAt("plugins"))) },
    { separator: true },
    { render: () => themeRow() },
  ];
  button.setAttribute("aria-expanded", "true");
  openMenu(button, items, { align: "start", returnFocus: button, sourceEvent: event, className: "app-menu", onClose: () => button.setAttribute("aria-expanded", "false") });
}

export function initAppMenu() {
  button = document.getElementById("app-menu");
  if (!button) return;
  button.addEventListener("click", (event) => { if (button.getAttribute("aria-expanded") === "true") closeMenu(); else open(event); });
  store.on("monitors", paint); paint();
}

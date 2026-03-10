import { state, send } from './state.js';
import { applyTheme } from './profiles.js';

const LIGHT_THEMES = new Set(['github-light', 'solarized-light', 'catppuccin-latte', 'one-light', 'rose-pine-dawn']);
const DARK_DEFAULTS = new Set(['catppuccin-mocha', 'solarized-dark', 'dracula', 'default']);
const LIGHT_DEFAULT = 'github-light';
const DARK_DEFAULT = 'catppuccin-mocha';

export function isLightTheme(id) { return LIGHT_THEMES.has(id); }

function isDarkDefault(id) { return DARK_DEFAULTS.has(id); }

export function getMode() {
  return state.cfg.colorMode || 'dark';
}

export function modeDefault(mode) {
  return mode === 'light' ? LIGHT_DEFAULT : DARK_DEFAULT;
}

export function applyMode(mode) {
  document.documentElement.classList.toggle('light', mode === 'light');
}

export function toggleMode() {
  // Guard: don't send config before the real config has arrived from backend
  if (!state.cfg.commands.length) return;

  const next = getMode() === 'dark' ? 'light' : 'dark';
  state.cfg.colorMode = next;
  applyMode(next);

  const newDefault = modeDefault(next);
  const isGoingLight = next === 'light';

  // Switch terminals that are on a mode-default theme
  for (const [id, entry] of state.terms) {
    const shouldSwitch = isGoingLight ? isDarkDefault(entry.themeId) : isLightTheme(entry.themeId);
    if (shouldSwitch) {
      // Use setSessionTheme via app.js to avoid circular import
      // setSessionTheme handles polarity detection and restart banner
      document.dispatchEvent(new CustomEvent('clideck-theme-switch', { detail: { id, themeId: newDefault } }));
    }
  }

  // Update default theme so new sessions follow the mode
  const shouldSwitchDefault = isGoingLight ? isDarkDefault(state.cfg.defaultTheme) : isLightTheme(state.cfg.defaultTheme);
  if (shouldSwitchDefault) state.cfg.defaultTheme = newDefault;

  send({ type: 'config.update', config: state.cfg });
}

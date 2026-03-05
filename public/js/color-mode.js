import { state, send } from './state.js';
import { applyTheme } from './profiles.js';

const DARK_DEFAULTS = new Set(['solarized-dark', 'dracula', 'default']);
const LIGHT_DEFAULT = 'github-light';
const DARK_DEFAULT = 'solarized-dark';

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
    const shouldSwitch = isGoingLight ? isDarkDefault(entry.themeId) : entry.themeId === LIGHT_DEFAULT;
    if (shouldSwitch) {
      entry.themeId = newDefault;
      applyTheme(entry.term, newDefault);
      send({ type: 'session.theme', id, themeId: newDefault });
    }
  }

  // Update default theme so new sessions follow the mode
  const shouldSwitchDefault = isGoingLight ? isDarkDefault(state.cfg.defaultTheme) : state.cfg.defaultTheme === LIGHT_DEFAULT;
  if (shouldSwitchDefault) state.cfg.defaultTheme = newDefault;

  send({ type: 'config.update', config: state.cfg });
}

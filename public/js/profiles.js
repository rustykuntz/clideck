import { state } from './state.js';

export function resolveTheme(profileId) {
  const profile = state.cfg.profiles.find(p => p.id === profileId);
  const themeId = profile?.themeId || 'default';
  const preset = state.themes.find(t => t.id === themeId);
  return preset?.theme || { background: '#020617', foreground: '#e2e8f0' };
}

export function resolveAccent(profileId) {
  const profile = state.cfg.profiles.find(p => p.id === profileId);
  return profile?.accentColor || '#3b82f6';
}

export function applyTheme(term, profileId) {
  term.options.theme = resolveTheme(profileId);
}

// Generate a small inline HTML color strip previewing a theme's key colors
export function themePreviewColors(themeId) {
  const preset = state.themes.find(t => t.id === themeId);
  if (!preset) return [];
  const t = preset.theme;
  return [t.background, t.foreground, t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan];
}

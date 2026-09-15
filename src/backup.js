const { existsSync } = require('fs');
const { isValidConfigPatch, isValidProject } = require('./config-store');
const { validateSettingValue } = require('./plugin-manifest');

const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const SECTIONS = {
  about: ['About me', ['about']],
  defaults: ['Defaults', ['defaultCwd']],
  behavior: ['Behavior', ['confirmClose']],
  agents: ['CLI Agents', ['commands', 'providerArgs', 'hiddenProviders']],
  plugins: ['Plugins', ['plugins']],
  notifications: ['Notifications', ['notify']],
  appearance: ['Appearance', ['theme', 'customThemes']],
  prompts: ['Saved prompts', ['prompts', 'promptMru']],
  onboarding: ['Getting started', ['onboarding']],
};
const DEFAULTS = {
  about: {}, defaultCwd: '', confirmClose: true, commands: [], providerArgs: {},
  hiddenProviders: [], plugins: {}, notify: {}, theme: {}, customThemes: [],
  prompts: [], promptMru: {}, onboarding: {},
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 4096) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const id = (v) => text(v, 100) && /^[A-Za-z0-9_-]+$/.test(v)
  && !['__proto__', 'constructor', 'prototype'].includes(v);
const copy = (v) => JSON.parse(JSON.stringify(v));
function requireValid(ok, message = 'This backup contains invalid data.') {
  if (!ok) throw new Error(message);
}
function safeJson(value) {
  // Imported JSON is data, including when later merged into ordinary JS objects.
  const serialized = JSON.stringify(value);
  requireValid(serialized && Buffer.byteLength(serialized) <= MAX_BACKUP_BYTES, 'Backup is too large (maximum 8 MB).');
  JSON.parse(serialized, (key, v) => {
    requireValid(!['__proto__', 'constructor', 'prototype'].includes(key));
    return v;
  });
}
function browserSection(key) {
  if (['clideck.theme', 'clideck.sidebarW', 'clideck.collapsed'].includes(key)) return 'appearance';
  if (key === 'clideck.mru-provider') return 'agents';
  if (/^clideck\.picker\.[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}\.recent$/.test(key)) return 'plugins';
  return '';
}
function browserPrefs(value = {}) {
  requireValid(object(value));
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (!browserSection(key)) continue;
    requireValid(text(v, 32 * 1024), 'Invalid browser preference in backup.');
    if (key === 'clideck.theme') requireValid(['auto', 'dark', 'light'].includes(v));
    else if (key === 'clideck.sidebarW') requireValid(Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= 10000);
    else if (key === 'clideck.collapsed' || key.endsWith('.recent')) {
      let parsed;
      try { parsed = JSON.parse(v); } catch { throw new Error('Invalid browser preference in backup.'); }
      requireValid(Array.isArray(parsed) && parsed.every((item) => text(item)));
    }
    result[key] = v;
  }
  return result;
}
function sessionDefinition(v) {
  requireValid(object(v) && id(v.id) && id(v.provider) && text(v.cwd) && v.cwd.length > 0,
    'Invalid session in backup.');
  const out = { id: v.id, provider: v.provider, cwd: v.cwd };
  for (const key of ['name', 'resumeHandle', 'transcriptPath', 'commandLabel', 'createdAt', 'lastActive']) {
    if (v[key] !== undefined) {
      requireValid(text(v[key]));
      out[key] = v[key];
    }
  }
  for (const key of ['commandId', 'projectId']) {
    if (v[key] !== undefined && v[key] !== null) requireValid(id(v[key]));
    if (v[key] !== undefined) out[key] = v[key];
  }
  for (const key of ['cols', 'rows', 'lastAgentAt']) {
    if (v[key] !== undefined) {
      requireValid(typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0);
      if (key !== 'lastAgentAt') requireValid(Number.isInteger(v[key]) && v[key] > 0 && v[key] <= 1000);
      out[key] = v[key];
    }
  }
  if (v.muted !== undefined) { requireValid(typeof v.muted === 'boolean'); out.muted = v.muted; }
  // Assets, terminal output and final replies are not configuration and are not imported.
  return out;
}
function uniqueList(list, validator) {
  requireValid(Array.isArray(list) && list.length <= 10000 && list.every(validator));
  requireValid(new Set(list.map((v) => v.id)).size === list.length, 'Duplicate IDs in backup.');
}
function validTheme(value) {
  // These colors also enter the existing HTML theme previews. Accept color data,
  // never HTML, CSS declarations, URLs or objects that stringify into markup.
  const color = (v) => text(v, 200) && /^(?:#[a-f\d]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([\d.e%+,\s/\-]+\))$/i.test(v);
  return object(value) && id(value.id) && text(value.name, 200) && object(value.theme)
    && Object.values(value.theme).every(color)
    && (value.accent === undefined || color(value.accent))
    && (value.mode === undefined || ['light', 'dark'].includes(value.mode));
}
function validateSection(section, value) {
  requireValid(object(value) && object(value.config) && object(value.browser));
  const keys = SECTIONS[section][1];
  requireValid(Object.keys(value.config).every((key) => keys.includes(key)) && isValidConfigPatch(value.config));
  const c = value.config;
  for (const key of ['notify', 'theme', 'plugins', 'promptMru']) if (c[key] !== undefined) requireValid(object(c[key]));
  for (const key of ['customThemes', 'hiddenProviders']) if (c[key] !== undefined) requireValid(Array.isArray(c[key]));
  if (c.confirmClose !== undefined) requireValid(typeof c.confirmClose === 'boolean');
  if (c.hiddenProviders) requireValid(c.hiddenProviders.every(id));
  if (c.promptMru) requireValid(Object.values(c.promptMru).every((v) => Array.isArray(v) && v.every((name) => text(name, 200))));
  if (c.prompts) requireValid(c.prompts.every((v) => id(v.id) && text(v.name, 200) && text(v.text, 64 * 1024)));
  if (c.customThemes) requireValid(c.customThemes.every(validTheme), 'Invalid custom theme colors in backup.');
  for (const [key, v] of Object.entries(c.theme || {})) requireValid(['lightDefault', 'darkDefault'].includes(key) && text(v, 100));
  for (const [key, v] of Object.entries(c.notify || {})) {
    requireValid(['enabled', 'sound', 'browser', 'dispatch'].includes(key) ? typeof v === 'boolean'
      : key === 'minWorkSec' ? Number.isFinite(v) && v >= 0
        : ['pick', 'dispatchPick'].includes(key) && text(v, 200));
  }
  for (const [key, v] of Object.entries(c.plugins || {})) {
    requireValid(id(key) && object(v) && typeof v.enabled === 'boolean' && object(v.settings));
  }
  const browser = browserPrefs(value.browser);
  requireValid(Object.keys(value.browser).every((key) => browserSection(key) === section));
  return { config: copy(c), browser };
}

function createBackup(server, browser = {}) {
  const config = server.configStore.get();
  // Only installed plugins' declared, non-secret settings belong in a portable file.
  config.plugins = Object.fromEntries(server.pluginManager.snapshot().map((p) => [p.id, {
    enabled: p.enabled, settings: p.values,
  }]));
  const prefs = browserPrefs(browser);
  const settings = Object.fromEntries(Object.entries(SECTIONS).map(([key, [, fields]]) => [key, {
    config: Object.fromEntries(fields.map((field) => [field, config[field] ?? DEFAULTS[field]])),
    browser: Object.fromEntries(Object.entries(prefs).filter(([name]) => browserSection(name) === key)),
  }]));
  const backup = {
    format: 'clideck-backup', version: 1, createdAt: new Date().toISOString(), settings,
    projects: config.projects || [], sessions: server.persistence.list().map(sessionDefinition),
    sessionThemes: config.sessionThemes || {},
  };
  parseBackup(backup); // Never offer a file that our restore cannot read.
  return backup;
}

function parseBackup(input) {
  safeJson(input);
  requireValid(object(input) && ['clideck-backup', 'clideck-session-backup'].includes(input.format)
    && input.version === 1, 'Choose a CliDeck backup file (version 1).');
  uniqueList(input.projects, isValidProject);
  uniqueList(input.sessions, (v) => { sessionDefinition(v); return true; });
  const settings = {};
  if (input.format === 'clideck-backup') {
    requireValid(object(input.settings));
    for (const [key, value] of Object.entries(input.settings)) {
      requireValid(Object.hasOwn(SECTIONS, key), 'Unknown settings section in backup.');
      settings[key] = validateSection(key, value);
    }
  }
  const sessionThemes = input.sessionThemes || {};
  requireValid(object(sessionThemes) && Object.entries(sessionThemes).every(([key, value]) => id(key) && text(value, 100)));
  return {
    createdAt: text(input.createdAt, 100) ? input.createdAt : '', settings,
    projects: copy(input.projects), sessions: input.sessions.map(sessionDefinition), sessionThemes: copy(sessionThemes),
  };
}

function pluginPatch(server, incoming, warnings) {
  const plugins = copy(server.configStore.get().plugins || {});
  for (const [key, value] of Object.entries(incoming || {})) {
    const record = server.pluginManager.records.get(key);
    if (!record) { warnings.push(`Plugin ${key} is not installed; its settings were skipped.`); continue; }
    const settings = { ...record.settings };
    for (const [name, v] of Object.entries(value.settings)) {
      const definition = record.manifest.settings.find((d) => d.key === name);
      if (!definition || definition.type === 'secret') continue;
      requireValid(validateSettingValue(definition, v), `Invalid ${record.manifest.name} setting: ${name}.`);
      settings[name] = v;
    }
    plugins[key] = { ...plugins[key], enabled: value.enabled, settings };
  }
  return plugins;
}

function previewBackup(server, input) {
  const backup = parseBackup(input);
  const existing = server.configStore.get().projects || [];
  const warnings = [];
  pluginPatch(server, backup.settings.plugins?.config.plugins, warnings);
  const describe = (s) => ({ id: s.id, name: s.name || s.provider, provider: s.provider,
    cwd: s.cwd, exists: server.persistence.has(s.id) });
  const projectIds = new Set(backup.projects.map((p) => p.id));
  const missingPaths = new Set([...backup.projects.map((p) => p.path), ...backup.sessions.map((s) => s.cwd)]
    .filter((path) => path && !existsSync(path)));
  if (missingPaths.size) warnings.push(`${missingPaths.size} saved folder${missingPaths.size === 1 ? ' is' : 's are'} not on this machine. Paths will be kept as saved.`);
  return {
    createdAt: backup.createdAt,
    settings: Object.keys(backup.settings).map((key) => ({ id: key, label: SECTIONS[key][0] })),
    projects: backup.projects.map((p) => ({ ...p, exists: existing.some((v) => v.id === p.id),
      sessions: backup.sessions.filter((s) => s.projectId === p.id).map(describe) })),
    sessions: backup.sessions.filter((s) => !projectIds.has(s.projectId)).map(describe), warnings,
  };
}

function restoreBackup(server, input, selection) {
  const backup = parseBackup(input);
  requireValid(object(selection), 'Choose what to restore.');
  for (const key of ['settings', 'projects', 'sessions']) {
    requireValid(Array.isArray(selection[key]) && selection[key].every((v) => text(v, 100)));
    const available = key === 'settings' ? Object.keys(backup.settings) : backup[key].map((v) => v.id);
    requireValid(selection[key].every((v) => available.includes(v)), 'Selection is not in this backup.');
  }
  requireValid(Object.values(selection).some((v) => Array.isArray(v) && v.length), 'Choose what to restore.');
  const before = server.configStore.get();
  const config = copy(before);
  const browser = {};
  const warnings = [];
  for (const key of new Set(selection.settings)) {
    const section = backup.settings[key];
    const patch = section.config;
    Object.assign(browser, section.browser);
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'plugins') config.plugins = pluginPatch(server, value, warnings);
      else if (['commands', 'prompts', 'customThemes'].includes(field)) {
        const merged = new Map((config[field] || []).map((v) => [v.id, v]));
        for (const v of value) merged.set(v.id, v);
        config[field] = [...merged.values()];
      } else config[field] = copy(value);
    }
  }
  const sessions = backup.sessions.filter((s) => selection.sessions.includes(s.id) && !server.persistence.has(s.id));
  const projectIds = new Set([...selection.projects, ...sessions.map((s) => s.projectId)]);
  const projects = backup.projects.filter((p) => projectIds.has(p.id) && !(config.projects || []).some((v) => v.id === p.id));
  config.projects = [...(config.projects || []), ...projects];
  // A session's custom command and custom terminal theme are dependencies, not extra checkboxes.
  for (const session of sessions) {
    if (session.projectId && !config.projects.some((p) => p.id === session.projectId)) session.projectId = null;
    if (session.commandId && !(config.commands || []).some((c) => c.id === session.commandId)) {
      const command = backup.settings.agents?.config.commands?.find((c) => c.id === session.commandId);
      if (command) config.commands = [...(config.commands || []), command];
      else warnings.push(`The CLI agent for ${session.name || session.id} is missing. This session was restored stopped and cannot resume until its command is available.`);
    }
    const theme = backup.sessionThemes[session.id];
    if (theme) {
      config.sessionThemes = { ...(config.sessionThemes || {}), [session.id]: theme };
      const custom = backup.settings.appearance?.config.customThemes?.find((v) => v.id === theme);
      if (custom && !(config.customThemes || []).some((v) => v.id === theme)) config.customThemes = [...(config.customThemes || []), custom];
    }
  }
  requireValid(isValidConfigPatch(config), 'Selected data exceeds the settings limit or contains invalid settings.');
  // No awaits between these writes: websocket edits cannot interleave. Roll config back
  // if the registry write fails; importMissing itself restores its in-memory map.
  server.configStore.replace(config);
  let added;
  try { added = server.persistence.importMissing(sessions); }
  catch (error) {
    server.configStore.replace(before);
    throw error;
  }
  server.broadcastConfig(config);
  for (const entry of added) server.broadcast(server.dormantSnapshot(entry));
  return {
    restored: { projects: projects.length, sessions: added.length, settings: new Set(selection.settings).size },
    skipped: new Set(selection.sessions).size - added.length
      + backup.projects.filter((p) => selection.projects.includes(p.id) && before.projects?.some((v) => v.id === p.id)).length,
    browser, warnings,
  };
}

module.exports = { MAX_BACKUP_BYTES, createBackup, parseBackup, previewBackup, restoreBackup };

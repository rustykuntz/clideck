const { readdirSync, readFileSync, existsSync, mkdirSync, cpSync } = require('fs');
const { join, sep } = require('path');
const { DATA_DIR } = require('./paths');

const PLUGINS_DIR = join(DATA_DIR, 'plugins');
mkdirSync(PLUGINS_DIR, { recursive: true });

// Seed bundled plugins — copy if missing, update if bundled version is newer
const BUNDLED_DIR = join(__dirname, 'plugins');
if (existsSync(BUNDLED_DIR)) {
  for (const entry of readdirSync(BUNDLED_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = join(PLUGINS_DIR, entry.name);
    if (!existsSync(target)) {
      cpSync(join(BUNDLED_DIR, entry.name), target, { recursive: true });
      console.log(`[plugin] seeded ${entry.name}`);
    } else {
      try {
        const bundledManifest = JSON.parse(readFileSync(join(BUNDLED_DIR, entry.name, 'clideck-plugin.json'), 'utf8'));
        const installedManifestFile = existsSync(join(target, 'clideck-plugin.json')) ? join(target, 'clideck-plugin.json') : join(target, 'termix-plugin.json');
        const installedManifest = JSON.parse(readFileSync(installedManifestFile, 'utf8'));
        if (bundledManifest.version !== installedManifest.version) {
          cpSync(join(BUNDLED_DIR, entry.name), target, { recursive: true });
          console.log(`[plugin] updated ${entry.name} ${installedManifest.version} → ${bundledManifest.version}`);
        }
      } catch {}
    }
  }
}

const plugins = new Map();
const inputHooks = [];
const outputHooks = [];
const statusHooks = [];
const sessionStatus = new Map(); // sessionId → boolean (dedup multi-client reports)
const frontendHandlers = new Map();
let broadcastFn = null;
let sessionsFn = null;
let getConfigFn = null;
let saveConfigFn = null;
const settingsChangeHandlers = new Map(); // pluginId → [fn]

function removeHooks(pluginId) {
  for (const arr of [inputHooks, outputHooks, statusHooks]) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].pluginId === pluginId) arr.splice(i, 1);
    }
  }
  for (const key of frontendHandlers.keys()) {
    if (key.startsWith(`plugin.${pluginId}.`)) frontendHandlers.delete(key);
  }
  settingsChangeHandlers.delete(pluginId);
}

function init(broadcast, getSessions, getConfig, saveConfig) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
  getConfigFn = getConfig;
  saveConfigFn = saveConfig;

  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PLUGINS_DIR, entry.name);
    const entryFile = join(dir, 'index.js');
    if (!existsSync(entryFile)) continue;

    let manifest = { id: entry.name, name: entry.name, version: '0.0.0' };
    const manifestFile = existsSync(join(dir, 'clideck-plugin.json')) ? join(dir, 'clideck-plugin.json') : join(dir, 'termix-plugin.json');
    if (existsSync(manifestFile)) {
      try { manifest = { ...manifest, ...JSON.parse(readFileSync(manifestFile, 'utf8')) }; }
      catch (e) { console.error(`[plugin:${entry.name}] bad manifest: ${e.message}`); continue; }
    }
    // Validate settings shape
    if (manifest.settings != null) {
      if (!Array.isArray(manifest.settings)) {
        console.error(`[plugin:${entry.name}] manifest.settings must be an array, ignoring`);
        manifest.settings = [];
      } else {
        manifest.settings = manifest.settings.filter(s =>
          s && typeof s === 'object' && typeof s.key === 'string' && s.key
        );
      }
    }

    if (plugins.has(manifest.id)) {
      console.error(`[plugin:${manifest.id}] duplicate ID, skipping ${dir}`);
      continue;
    }

    const state = { manifest, dir, shutdownFns: [], actions: [] };
    plugins.set(manifest.id, state);

    try {
      const mod = require(entryFile);
      if (typeof mod.init === 'function') mod.init(buildApi(manifest.id, dir, state));
      console.log(`[plugin] ${manifest.name} v${manifest.version}`);
    } catch (e) {
      console.error(`[plugin:${manifest.id}] init failed: ${e.message}`);
      removeHooks(manifest.id);
      plugins.delete(manifest.id);
    }
  }
}

function buildApi(pluginId, pluginDir, state) {
  return {
    version: 1,
    pluginId,
    pluginDir,

    onSessionInput(fn) { inputHooks.push({ pluginId, fn }); },
    onSessionOutput(fn) { outputHooks.push({ pluginId, fn }); },
    onStatusChange(fn) { statusHooks.push({ pluginId, fn }); },

    sendToFrontend(event, data = {}) {
      broadcastFn?.({ ...data, type: `plugin.${pluginId}.${event}` });
    },
    onFrontendMessage(event, fn) {
      frontendHandlers.set(`plugin.${pluginId}.${event}`, fn);
    },

    getSession(id) {
      const s = sessionsFn?.()?.get(id);
      if (!s) return null;
      return { id, name: s.name, cwd: s.cwd, commandId: s.commandId, themeId: s.themeId, projectId: s.projectId };
    },
    getSessions() {
      const sessions = sessionsFn?.();
      if (!sessions) return [];
      return [...sessions].map(([id, s]) => ({
        id, name: s.name, cwd: s.cwd, commandId: s.commandId, themeId: s.themeId, projectId: s.projectId,
      }));
    },

    addToolbarAction(opts) { state.actions.push({ ...opts, pluginId, slot: 'toolbar' }); },

    getSetting(key) {
      const cfg = getConfigFn?.();
      const defaults = {};
      for (const s of state.manifest.settings || []) defaults[s.key] = s.default;
      return cfg?.pluginSettings?.[pluginId]?.[key] ?? defaults[key];
    },
    getSettings() {
      const cfg = getConfigFn?.();
      const result = {};
      for (const s of state.manifest.settings || []) result[s.key] = s.default;
      return { ...result, ...cfg?.pluginSettings?.[pluginId] };
    },
    onSettingsChange(fn) {
      if (!settingsChangeHandlers.has(pluginId)) settingsChangeHandlers.set(pluginId, []);
      settingsChangeHandlers.get(pluginId).push(fn);
    },

    onShutdown(fn) { state.shutdownFns.push(fn); },
    log(msg) { console.log(`[plugin:${pluginId}] ${msg}`); },
  };
}

function transformInput(id, data) {
  if (!inputHooks.length) return data;
  let result = data;
  for (const h of inputHooks) {
    try {
      const out = h.fn(id, result);
      if (typeof out === 'string') result = out;
    } catch (e) { console.error(`[plugin:${h.pluginId}] input error: ${e.message}`); }
  }
  return result;
}

function notifyOutput(id, data) {
  for (const h of outputHooks) {
    try { h.fn(id, data); }
    catch (e) { console.error(`[plugin:${h.pluginId}] output error: ${e.message}`); }
  }
}

function notifyStatus(id, working) {
  if (sessionStatus.get(id) === working) return;
  sessionStatus.set(id, working);
  for (const h of statusHooks) {
    try { h.fn(id, working); }
    catch (e) { console.error(`[plugin:${h.pluginId}] status error: ${e.message}`); }
  }
}

function updateSetting(pluginId, key, value) {
  // Validate plugin exists (also prevents __proto__ pollution — Map lookup returns undefined)
  const plugin = plugins.get(pluginId);
  if (!plugin) return;
  // Validate key is declared in manifest
  const settingDef = (plugin.manifest.settings || []).find(s => s.key === key);
  if (!settingDef) return;
  // Type-coerce/validate value against manifest type
  const coerced = coerceSetting(settingDef, value);
  if (coerced === undefined) return;

  const cfg = getConfigFn?.();
  if (!cfg) return;
  if (!cfg.pluginSettings) cfg.pluginSettings = Object.create(null);
  if (!cfg.pluginSettings[pluginId]) cfg.pluginSettings[pluginId] = Object.create(null);
  cfg.pluginSettings[pluginId][key] = coerced;
  saveConfigFn?.(cfg);
  const fns = settingsChangeHandlers.get(pluginId) || [];
  for (const fn of fns) {
    try { fn(key, coerced); }
    catch (e) { console.error(`[plugin:${pluginId}] settings handler error: ${e.message}`); }
  }
}

function coerceSetting(def, value) {
  switch (def.type) {
    case 'toggle': return !!value;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      if (def.min != null && n < def.min) return undefined;
      if (def.max != null && n > def.max) return undefined;
      return n;
    }
    case 'select': {
      const opts = (def.options || []).map(o => String(typeof o === 'object' ? o.value : o));
      const s = String(value);
      return opts.includes(s) ? s : undefined;
    }
    default: return String(value);
  }
}

function handleMessage(msg) {
  const fn = frontendHandlers.get(msg.type);
  if (!fn) return false;
  try { fn(msg); }
  catch (e) { console.error(`[plugin] handler error for ${msg.type}: ${e.message}`); }
  return true;
}

function getInfo() {
  const cfg = getConfigFn?.();
  return [...plugins.values()].map(p => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    settings: p.manifest.settings || [],
    settingValues: cfg?.pluginSettings?.[p.manifest.id] || {},
    actions: p.actions,
    hasClient: existsSync(join(p.dir, 'client.js')),
  }));
}

function resolveFile(urlPath) {
  const m = urlPath.match(/^\/plugins\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, id, rest] = m;
  const plugin = plugins.get(id);
  if (!plugin) return null;
  let file, allowed;
  if (rest === 'client.js') {
    file = join(plugin.dir, 'client.js');
    allowed = plugin.dir;
  } else {
    allowed = join(plugin.dir, 'public');
    file = join(allowed, rest);
  }
  if (!file.startsWith(allowed + sep)) return null;
  if (!existsSync(file)) return null;
  return file;
}

function shutdown() {
  for (const [id, p] of plugins) {
    for (const fn of p.shutdownFns) {
      try { fn(); }
      catch (e) { console.error(`[plugin:${id}] shutdown error: ${e.message}`); }
    }
  }
}

function clearStatus(id) { sessionStatus.delete(id); }

module.exports = {
  init, shutdown,
  transformInput, notifyOutput, notifyStatus, clearStatus,
  handleMessage, updateSetting, getInfo, resolveFile,
};

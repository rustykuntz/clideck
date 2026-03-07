const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const os = require('os');
const { DATA_DIR } = require('./paths');
const { defaultShell, binName } = require('./utils');

const CONFIG_PATH = join(DATA_DIR, 'config.json');

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
    },
  ],
  confirmClose: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  defaultTheme: 'catppuccin-mocha',
  defaultShell,
  prompts: [],
  projects: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;

function matchPreset(cmd) {
  const bin = binName(cmd.command);
  return PRESETS.find(p => binName(p.command) === bin);
}

function migrate(cfg) {
  // Migrate profiles → defaultTheme
  if (cfg.profiles && !cfg.defaultTheme) {
    const defProfile = cfg.profiles.find(p => p.id === cfg.defaultProfile) || cfg.profiles[0];
    cfg.defaultTheme = defProfile?.themeId || 'default';
  }
  delete cfg.profiles;
  delete cfg.defaultProfile;
  if (!cfg.defaultTheme || cfg.defaultTheme === 'solarized-dark') cfg.defaultTheme = 'catppuccin-mocha';
  // Backfill and sync fields from presets
  for (const cmd of cfg.commands) {
    const preset = matchPreset(cmd);
    // Icon always syncs from preset — the preset is the source of truth for logos
    if (preset) cmd.icon = preset.icon;
    else if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    // Claude Code telemetry is built-in, always on
    if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
  }
  // Auto-add any shipped presets not yet in the commands list
  for (const preset of PRESETS) {
    const exists = cfg.commands.some(c => matchPreset(c)?.presetId === preset.presetId);
    if (!exists) {
      cfg.commands.push({
        id: crypto.randomUUID(), label: preset.name, icon: preset.icon,
        command: preset.command, enabled: true, defaultPath: '',
        isAgent: preset.isAgent, canResume: preset.canResume,
        resumeCommand: preset.resumeCommand, sessionIdPattern: preset.sessionIdPattern,
        outputMarker: preset.outputMarker || null,
      });
    }
  }
  if (!cfg.projects) cfg.projects = [];
  return cfg;
}

function load() {
  if (!existsSync(CONFIG_PATH)) return deepCopy(DEFAULTS);
  try {
    return migrate({ ...deepCopy(DEFAULTS), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) });
  } catch { return deepCopy(DEFAULTS); }
}

function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { load, save };

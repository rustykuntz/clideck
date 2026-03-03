const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const CONFIG_PATH = join(__dirname, 'config.json');

const DEFAULTS = {
  defaultPath: process.env.HOME || '/tmp',
  commands: [
    {
      id: '1', label: 'Shell', icon: '⚫', command: '/bin/zsh', enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
    },
  ],
  confirmClose: true,
  defaultProfile: 'default',
  profiles: [
    { id: 'default', name: 'Default', themeId: 'default', accentColor: '#3b82f6' },
  ],
  prompts: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));

function matchPreset(cmd) {
  const bin = cmd.command.split('/').pop().split(' ')[0];
  return PRESETS.find(p => p.command.split('/').pop() === bin);
}

function migrate(cfg) {
  if (!cfg.profiles || cfg.profiles.length === 0) {
    cfg.profiles = deepCopy(DEFAULTS.profiles);
  }
  if (!cfg.defaultProfile) {
    cfg.defaultProfile = 'default';
  }
  // Backfill missing fields on existing commands
  for (const cmd of cfg.commands) {
    const preset = matchPreset(cmd);
    if (cmd.icon === undefined)             cmd.icon = preset?.icon || '⚫';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
  }
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

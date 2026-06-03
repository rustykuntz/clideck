const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const os = require('os');
const { DATA_DIR } = require('./paths');
const { defaultShell, binName } = require('./utils');

const CONFIG_PATH = join(DATA_DIR, 'config.json');

const STARTER_PROMPTS = [
  {
    id: 'starter-prompt-update-documentation',
    name: 'Update documentation',
    text: 'Our docs needs to be updated based on the latest diff changes. Please review the latest changes and udpate the docs accordingly. List the changes you did in concise points in your response. Thanks.',
  },
  {
    id: 'starter-prompt-investigate-codebase',
    name: 'Investigate codebase',
    text: `Learn the codebase and investigate it for:
- Critical issues
- Serious logical issues
- Things you dont understand why they are there
- Redundent code
- Ugly workarounds / plasters / band-aids

list your fidings please.`,
  },
  {
    id: 'starter-prompt-reviewer-findings',
    name: 'Reviewer findings',
    text: 'Here are the reviewer findings, if you find that any are valid and relevant, please fix with pure solutions, simple approaches, never apply workarounds / plasters.\nWhen finish, list what you fix and how:',
  },
];

const STARTER_ROLES = [
  {
    id: 'starter-role-programmer',
    name: 'Programmer',
    instructions: `You are the main programmer of this project.
Do you not apply workarounds or bandaids, prefer pure solutions.
NEVER use plan tool/mode, start to build immediatly and ask questions along the way if any.
Check if any external findings are valid before applying changes, the reviewer doesnt always updated with the full scope.
When you done with changes, list concisely what you did.

Learn the project quickly if exist. Go over the structure, code and functionality.
Let me know when you are ready.`,
  },
  {
    id: 'starter-role-reviewer',
    name: 'Reviewer',
    instructions: `You are the code reviewer in this project.
Your task is check the coder output and list critical / logical design flow issues, ugly workarounds or functionalty you just dont understand why its there. Do not waste time and list insignificunt findings.

If you didnt find anything, response with no findings.

You never write code!.

Quickly learn the project if exist. Go over the structure, code and functionality and let me know when you are ready.`,
  },
  {
    id: 'starter-role-product-manager',
    name: 'Product manager',
    instructions: `You are the product manager of this project, you should understand why we do what we do and what is the best way to do it. You dont care about technical limitations or directions, the only thing matter to you is the user UI/UX and how this agents team will ship a top notch, professional deliveries.
Do not allow the team to round angles and skip small stuff that will basly impact the user.

You never write code!
You dont use your plan tool/mode - instead you are planning immediatly as you go.

Go over the project if exist and understand from the code, documentations and readme what is it and why we do it.

Let me know when you are ready`,
  },
];

const DEFAULTS = {
  defaultPath: join(os.homedir(), 'Documents'),
  commands: [
    {
      id: '1', label: 'Shell', icon: 'terminal', command: defaultShell, enabled: true,
      defaultPath: '', isAgent: false, canResume: false, resumeCommand: null, sessionIdPattern: null,
    },
  ],
  confirmClose: true,
  notifyIdle: true,
  notifySoundEnabled: true,
  notifySound: 'soft-beep',
  notifyMinWork: 0,
  defaultTheme: 'catppuccin-mocha',
  // Phase 9 — terminal display sizing. xterm font-size in px; range 8..32
  // (clamped client-side via clampFontSize). 13 matches the historical
  // hardcoded value in public/js/terminals.js. See SPEC.md AC 1-4 and
  // CONTEXT.md D-02 / D-05.
  terminalFontSize: 13,
  // Phase 9 — sidebar drag-resize. Sidebar width in px; range
  // [280, min(640, 50vw)] (clamped client-side via clampSidebarWidth).
  // 354 matches the historical `w-[354px]` Tailwind class on
  // #sidebar so a fresh config produces the same layout as v1.31.10.
  // See SPEC.md AC 5-10 and CONTEXT.md D-05 / D-08.
  sidebarWidth: 354,
  defaultShell,
  prompts: [],
  roles: [],
  projects: [],
};

function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

const PRESETS = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;
function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
const EXPOSED_PRESETS = PRESETS.filter(isPresetEnabled);

function matchPreset(cmd) {
  const bin = binName(cmd.command);
  return PRESETS.find(p => binName(p.command) === bin);
}

function firstCommandToken(command) {
  const raw = String(command || '').trim();
  const m = raw.match(/^(['"])(.*?)\1|^(\S+)/);
  return m ? (m[2] || m[3] || '') : '';
}

function commandPathMissing(command) {
  const token = firstCommandToken(command);
  return !token || (token.startsWith('/') && !existsSync(token));
}

function isShellCommand(cmd, preset) {
  return preset?.presetId === 'shell'
    || cmd.presetId === 'shell'
    || (!cmd.isAgent && !cmd.presetId && String(cmd.label || '').toLowerCase() === 'shell');
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
    let preset = cmd.presetId ? PRESETS.find(p => p.presetId === cmd.presetId) : matchPreset(cmd);
    if (isShellCommand(cmd, preset)) {
      preset = PRESETS.find(p => p.presetId === 'shell') || preset;
      cmd.presetId = 'shell';
      cmd.label = cmd.label || 'Shell';
    }
    if (preset?.presetId === 'shell' && commandPathMissing(cmd.command)) {
      cmd.command = defaultShell;
    }
    // Stamp presetId for reliable lookup
    if (preset && !cmd.presetId) cmd.presetId = preset.presetId;
    // Icon always syncs from preset — the preset is the source of truth for logos
    if (preset) cmd.icon = preset.icon;
    else if (!cmd.icon) cmd.icon = 'terminal';
    if (cmd.isAgent === undefined)          cmd.isAgent = preset?.isAgent ?? false;
    if (cmd.canResume === undefined)        cmd.canResume = preset?.canResume ?? false;
    if (cmd.resumeCommand === undefined)    cmd.resumeCommand = preset?.resumeCommand || null;
    if (cmd.sessionIdPattern === undefined) cmd.sessionIdPattern = preset?.sessionIdPattern || null;
    if (cmd.outputMarker === undefined)     cmd.outputMarker = preset?.outputMarker || null;
    // Claude Code telemetry is built-in, always on
    if (preset?.telemetryEnabled === true) cmd.telemetryEnabled = true;
    else if (preset?.presetId === 'claude-code') cmd.telemetryEnabled = true;
    else if (cmd.telemetryEnabled === undefined) cmd.telemetryEnabled = false;
    if (cmd.telemetryStatus === undefined)  cmd.telemetryStatus = null;
    // Sync bridge config from preset
    if (preset?.bridge) cmd.bridge = preset.bridge;
    // Codex: keep shipped default commands aligned with the current preset.
    // Only rewrite the known default strings so custom Codex commands stay intact.
    if (preset?.presetId === 'codex') {
      if (cmd.command === 'codex' || cmd.command === 'codex --no-alt-screen') cmd.command = preset.command;
      if (cmd.resumeCommand === 'codex resume {{sessionId}}' || cmd.resumeCommand === 'codex resume {{sessionId}} --no-alt-screen') {
        cmd.resumeCommand = preset.resumeCommand;
      }
    }
  }
  // Auto-add any shipped presets not yet in the commands list
  for (const preset of EXPOSED_PRESETS) {
    const exists = cfg.commands.some(c => c.presetId === preset.presetId || matchPreset(c)?.presetId === preset.presetId);
    if (!exists) {
      cfg.commands.push({
        id: crypto.randomUUID(), presetId: preset.presetId, label: preset.name, icon: preset.icon,
        command: preset.command, enabled: true, defaultPath: '',
        isAgent: preset.isAgent, canResume: preset.canResume,
        resumeCommand: preset.resumeCommand, sessionIdPattern: preset.sessionIdPattern,
        outputMarker: preset.outputMarker || null,
      });
    }
  }
  if (!cfg.projects) cfg.projects = [];
  if (!cfg.roles) cfg.roles = [];
  return cfg;
}

function load() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      ...deepCopy(DEFAULTS),
      prompts: deepCopy(STARTER_PROMPTS),
      roles: deepCopy(STARTER_ROLES),
    };
  }
  try {
    return migrate({ ...deepCopy(DEFAULTS), ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) });
  } catch { return deepCopy(DEFAULTS); }
}

function save(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

module.exports = { load, save };

const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { randomUUID } = require('crypto');
const { tmpdir } = require('os');
const { dirname, join } = require('path');

function systemSettingsPath() {
  if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) {
    return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/GeminiCli/settings.json';
  }
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  return '/etc/gemini-cli/settings.json';
}

function hookCommand(port, sessionId, route, guidePath = '', serverUrl = '') {
  const node = process.execPath.replace(/\\/g, '/');
  const script = join(__dirname, 'gemini-hook.js').replace(/\\/g, '/');
  return `"${node}" "${script}" ${port} ${sessionId} ${route}`
    + (guidePath || serverUrl ? ` ${JSON.stringify(guidePath)}` : '')
    + (serverUrl ? ` ${JSON.stringify(serverUrl)}` : '');
}

function withoutCliDeckHooks(definitions = []) {
  return definitions.filter((definition) => !definition.hooks?.some((hook) => (
    hook.name?.startsWith('clideck-')
    || hook.command?.includes('gemini-hook.js')
  )));
}

function createGeminiSettings(port, sessionId, sourcePath = systemSettingsPath(), agentGuide = '', serverUrl = '') {
  let settings = {};
  try {
    if (sourcePath && existsSync(sourcePath)) {
      settings = JSON.parse(readFileSync(sourcePath, 'utf8'));
    }
  } catch {}

  const suffix = `${process.pid}-${randomUUID()}`;
  const path = join(tmpdir(), `clideck-next-gemini-${suffix}.json`);
  const guidePath = agentGuide ? join(tmpdir(), `clideck-next-gemini-guide-${suffix}.md`) : '';
  if (guidePath) writeFileSync(guidePath, agentGuide, { mode: 0o600 });
  const hooks = { ...(settings.hooks || {}) };
  const addHook = (event, route) => {
    hooks[event] = [
      ...withoutCliDeckHooks(hooks[event]),
      {
        matcher: '*',
        hooks: [{
          type: 'command',
          command: hookCommand(port, sessionId, route, guidePath, serverUrl),
          name: `clideck-next-${route}`,
          timeout: 5000,
        }],
      },
    ];
  };
  addHook('SessionStart', 'session-start');
  addHook('BeforeAgent', 'start');
  addHook('AfterAgent', 'stop');
  addHook('BeforeTool', 'menu');
  addHook('SessionEnd', 'session-end');
  settings.hooks = hooks;
  const disabled = new Set(settings.hooksConfig?.disabled || []);
  disabled.add('clideck-start');
  disabled.add('clideck-stop');
  disabled.add('clideck-menu');
  settings.hooksConfig = {
    ...(settings.hooksConfig || {}),
    enabled: true,
    notifications: false,
    disabled: [...disabled],
  };

  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return {
    path,
    guidePath,
    defaultsPath: process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
      || join(dirname(sourcePath), 'system-defaults.json'),
  };
}

function removeGeminiSettings(settings) {
  try {
    unlinkSync(settings.path);
  } catch {}
  if (settings.guidePath) {
    try {
      unlinkSync(settings.guidePath);
    } catch {}
  }
}

module.exports = { createGeminiSettings, removeGeminiSettings };

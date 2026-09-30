const { join } = require('path');
const {
  AGENT_SESSION_GUIDE,
  hasCodexDeveloperInstructions,
} = require('./agent-session-guide');

function hookGroup(command, timeout = 5, commandWindows = command) {
  return `[{ hooks = [{ type = "command", command = ${JSON.stringify(command)}, commandWindows = ${JSON.stringify(commandWindows)}, timeout = ${timeout} }] }]`;
}

function createCodexLaunch({
  command = 'codex',
  codexHome,
  port,
  bypassHookTrust = false,
  resumeHandle,
  agentGuide,
  extraArgs = [],
  hookToken = '',
}) {
  const node = process.execPath.replace(/\\/g, '/');
  const script = join(__dirname, 'codex-hook.js').replace(/\\/g, '/');
  const windowsScript = join(__dirname, 'codex-hook.js');
  // Codex trusts the exact hook definition. Keep launch-specific values in the
  // child environment so restarting a session does not change all four hashes.
  const hookCommand = (route) => `"${node}" "${script}" ${route}`;
  // Codex evaluates commandWindows in PowerShell, where quoted executable
  // paths need the call operator to execute instead of becoming bare strings.
  const windowsHookCommand = (route) => `& "${process.execPath}" "${windowsScript}" ${route}`;
  const hook = (route, timeout = 5) => hookGroup(
    hookCommand(route), timeout, windowsHookCommand(route),
  );
  const args = [
    '--enable',
    'hooks',
    // Each CliDeck PTY needs its own inherited CLIDECK_* hook environment.
    // The shared Codex daemon runs hooks in the daemon's environment instead.
    '-c',
    'features.daemon_auto_start=false',
    // The global legacy notifier can exceed Windows process limits when it
    // serializes a large turn. CliDeck has its own status hooks, so suppress it
    // in managed Codex processes.
    '-c',
    'notify=[]',
    '-c',
    `hooks.UserPromptSubmit=${hook('start')}`,
    '-c',
    `hooks.Stop=${hook('stop')}`,
    '-c',
    `hooks.SessionStart=${hook('session-start')}`,
    '-c',
    `hooks.Interrupt=${hook('idle', 3)}`,
  ];
  if (!hasCodexDeveloperInstructions(command, extraArgs)) {
    args.push('-c', `developer_instructions=${JSON.stringify(agentGuide || AGENT_SESSION_GUIDE)}`);
  }
  if (resumeHandle) args.push('resume', resumeHandle);
  if (bypassHookTrust) args.unshift('--dangerously-bypass-hook-trust');
  return {
    command,
    args,
    env: {
      ...(codexHome && { CODEX_HOME: codexHome }),
      CLIDECK_PORT: String(port),
      CLIDECK_HOOK_TOKEN: hookToken,
    },
  };
}

module.exports = { createCodexLaunch };

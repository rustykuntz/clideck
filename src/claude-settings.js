const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { randomUUID } = require('crypto');

function createClaudeSettings(port, sessionId, serverUrl = '') {
  const node = process.execPath.replace(/\\/g, '/');
  const script = join(__dirname, 'claude-hook.js').replace(/\\/g, '/');
  const hook = (route) => ({
    hooks: [{
      type: 'command',
      command: `"${node}" "${script}" ${port} ${sessionId} ${route}` + (serverUrl ? ` ${JSON.stringify(serverUrl)}` : ''),
      timeout: 5,
    }],
  });
  const settings = {
    theme: 'auto',
    statusLine: {
      type: 'command',
      command: `"${node}" "${script}" ${port} ${sessionId} context` + (serverUrl ? ` ${JSON.stringify(serverUrl)}` : ''),
    },
    hooks: {
      UserPromptSubmit: [hook('start')],
      Stop: [hook('stop')],
      SessionStart: [hook('session-start')],
      SessionEnd: [hook('session-end')],
      PreToolUse: [hook('menu')],
      Notification: [{ matcher: 'idle_prompt', ...hook('idle') }],
    },
  };
  const path = join(tmpdir(), `clideck-next-${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function removeClaudeSettings(path) {
  try {
    unlinkSync(path);
  } catch {}
}

module.exports = { createClaudeSettings, removeClaudeSettings };

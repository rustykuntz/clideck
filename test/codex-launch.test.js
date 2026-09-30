const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexLaunch } = require('../src/codex-launch');

test('Codex launch configures Windows-safe hooks for resumable CliDeck sessions', () => {
  const launch = createCodexLaunch({
    port: 4000,
    hookToken: 'launch-token',
  });

  assert.equal(launch.args.includes('features.daemon_auto_start=false'), true);
  assert.equal(launch.args.includes('notify=[]'), true);

  const config = launch.args.join('\n');
  assert.match(config, /hooks\.SessionStart=/);
  assert.match(config, /commandWindows = "&/);
  assert.match(config, /codex-hook\.js.*session-start/);
  assert.match(config, /codex-hook\.js.*start/);
});

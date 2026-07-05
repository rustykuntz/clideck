// Regression test for the claude-code settings.json hook writer: it must
// never write a 'StopFailure' key. That event name doesn't exist in Claude
// Code's hook schema, and writing it makes Claude Code's settings.json parser
// reject the *entire* file ("Invalid key in record"), silently breaking
// hooks, hints, and permissions.
//
//   node tests/providers/telemetry-config.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyTelemetryConfig } = require('../../handlers');

const preset = { presetId: 'claude-code' };

function withTmpConfigDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clideck-telemetry-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readSettings(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
}

let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}  ${e.message}`);
  }
}

check('applyTelemetryConfig never writes a StopFailure key', () => {
  withTmpConfigDir((dir) => {
    const cmd = { env: { CLAUDE_CONFIG_DIR: dir } };
    const result = applyTelemetryConfig(preset, cmd);
    assert(result.success, `expected success, got: ${result.message}`);
    const settings = readSettings(dir);
    assert(!('StopFailure' in settings.hooks), 'StopFailure key should not be written');
    assert(Array.isArray(settings.hooks.Stop) && settings.hooks.Stop.length > 0, 'Stop hook should be installed');
  });
});

check('applyTelemetryConfig is idempotent (second run reports already configured)', () => {
  withTmpConfigDir((dir) => {
    const cmd = { env: { CLAUDE_CONFIG_DIR: dir } };
    applyTelemetryConfig(preset, cmd);
    const second = applyTelemetryConfig(preset, cmd);
    assert(second.success, `expected success, got: ${second.message}`);
    assert.strictEqual(second.message, 'Already configured');
  });
});

check('a pre-existing stray StopFailure key is stripped by a re-run', () => {
  withTmpConfigDir((dir) => {
    const configPath = path.join(dir, 'settings.json');
    fs.writeFileSync(configPath, JSON.stringify({
      hooks: {
        StopFailure: [{ hooks: [{ type: 'command', command: 'node /some/old/claude-hook.js 1234 stop' }] }],
      },
    }));
    const cmd = { env: { CLAUDE_CONFIG_DIR: dir } };
    const result = applyTelemetryConfig(preset, cmd);
    assert(result.success, `expected success, got: ${result.message}`);
    const settings = readSettings(dir);
    assert(!('StopFailure' in settings.hooks), 'stray StopFailure key should have been stripped');
  });
});

console.log('');
process.exit(failed ? 1 : 0);

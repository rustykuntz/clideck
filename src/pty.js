const { chmodSync, statSync } = require('fs');
const { dirname, join } = require('path');
const pty = require('node-pty');

let helperChecked = false;

function sanitizeProviderEnv(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => {
    const name = key.toUpperCase();
    return name !== 'CLAUDECODE'
      && name !== 'CLAUDE_EFFORT'
      && !name.startsWith('CLAUDE_CODE_');
  }));
}

function ensureHelperExecutable() {
  if (helperChecked || process.platform !== 'darwin') return;
  helperChecked = true;
  const packageDirectory = dirname(require.resolve('node-pty/package.json'));
  const helper = join(
    packageDirectory,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  const mode = statSync(helper).mode & 0o777;
  if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
}

function spawn(file, args, options) {
  ensureHelperExecutable();
  return pty.spawn(file, args, {
    ...options,
    ...(options?.env && { env: sanitizeProviderEnv(options.env) }),
  });
}

module.exports = { sanitizeProviderEnv, spawn };

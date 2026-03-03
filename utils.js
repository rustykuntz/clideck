const { chmodSync, statSync, readdirSync } = require('fs');
const { dirname, join } = require('path');

function ensurePtyHelper() {
  if (process.platform === 'win32') return;
  try {
    const pkgDir = dirname(require.resolve('node-pty/package.json'));
    const helper = join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const mode = statSync(helper).mode & 0o777;
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o111);
  } catch {}
}

function parseCommand(str) {
  const parts = [];
  let current = '';
  let inQuote = null;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : ['/bin/zsh'];
}

function resolveValidDir(dir) {
  try {
    if (dir && statSync(dir).isDirectory()) return dir;
  } catch {}
  return process.env.HOME || '/tmp';
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { ensurePtyHelper, parseCommand, resolveValidDir, listDirs };

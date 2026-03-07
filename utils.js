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
  return parts.length ? parts : [defaultShell];
}

function resolveValidDir(dir) {
  try {
    if (dir && statSync(dir).isDirectory()) return dir;
  } catch {}
  return require('os').homedir();
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

const defaultShell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/zsh';

function binName(command) {
  const m = command.match(/^(['"])(.*?)\1/);
  const exec = m ? m[2] : command;
  return exec.split(/[\\/]/).pop().split(/\s/)[0].replace(/\.(exe|cmd)$/i, '');
}

module.exports = { ensurePtyHelper, parseCommand, resolveValidDir, listDirs, defaultShell, binName };

const { chmodSync, existsSync, statSync, readdirSync } = require('fs');
const path = require('path');
const { dirname, join } = path;

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
  if (!parts.length) return [defaultShell];
  // On Windows, node-pty can't resolve non-.exe commands via PATH (e.g. claude, codex).
  // Wrap through cmd.exe /c so Windows handles PATHEXT resolution natively.
  if (process.platform === 'win32' && !parts[0].match(/\.(exe|com)$/i) && !/^[a-z]:\\/i.test(parts[0])) {
    return [process.env.COMSPEC || 'cmd.exe', '/c', ...parts];
  }
  return parts;
}

function resolveValidDir(dir) {
  try {
    if (dir && statSync(dir).isDirectory()) return dir;
  } catch {}
  return require('os').homedir();
}

// validateCwdPath — gate for the mkdir-cwd WS handler. Pure-helper, no I/O.
// Rejects empty, relative, or `..`-containing paths so a malicious or typo'd
// client can't ask the server to mkdirSync `..\\escape` and walk out of the
// intended directory. See SPEC §86 AC 8 and PLAN Task 1.
//
// Returns { ok:true, path: <trimmed input> } on success
//      or { ok:false, error: 'empty' | 'not-absolute' | 'parent-traversal' } on failure.
function validateCwdPath(p) {
  if (p == null) return { ok: false, error: 'empty' };
  const trimmed = String(p).trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  if (!path.isAbsolute(trimmed)) return { ok: false, error: 'not-absolute' };
  // Split on both forward- and back-slashes so the rule catches `..` regardless
  // of which separator the client used. Empty segments (trailing separator,
  // double separator) are not flagged — only literal `..` segments are.
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some(seg => seg === '..')) return { ok: false, error: 'parent-traversal' };
  return { ok: true, path: trimmed };
}

function listDirs(path, showHidden) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(d => d.isDirectory() && (showHidden || !d.name.startsWith('.')))
      .map(d => d.name)
      .sort();
  } catch (e) {
    return { error: e.message };
  }
}

function resolveDefaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean);
  return candidates.find(shell => existsSync(shell)) || '/bin/sh';
}

const defaultShell = resolveDefaultShell();

function binName(command) {
  const m = command.match(/^(['"])(.*?)\1/);
  const exec = m ? m[2] : command;
  return exec.split(/[\\/]/).pop().split(/\s/)[0].replace(/\.(exe|cmd)$/i, '');
}

module.exports = { ensurePtyHelper, parseCommand, resolveValidDir, validateCwdPath, listDirs, defaultShell, binName };

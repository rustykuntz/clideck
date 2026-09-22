const fs = require('fs');
const { homedir } = require('os');
const { join, resolve, dirname, basename } = require('path');
const { randomUUID } = require('crypto');

const ROUTES = {
  'claude-code': { UserPromptSubmit: 'start', Stop: 'stop', SessionStart: 'session-start',
    SessionEnd: 'session-end', PreToolUse: 'menu', Notification: 'idle' },
  codex: { UserPromptSubmit: 'start', Stop: 'stop' },
};

function isLegacyHook(hook, provider, route) {
  if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
  // This is the exact command form written by v1, not a substring search through
  // user commands. The v2 helper has a different argument contract and location.
  const match = hook.command.match(/^"([^"\r\n]+)" "([^"\r\n]+)" (\d+) ([a-z-]+)$/);
  if (!match || match[4] !== route || Number(match[3]) < 1 || Number(match[3]) > 65535) return false;
  const node = match[1].replace(/\\/g, '/');
  const script = match[2].replace(/\\/g, '/');
  const helper = provider === 'codex' ? 'codex-hook.js' : 'claude-hook.js';
  return /(?:^|\/)node(?:\.exe)?$/.test(node)
    && script.endsWith(`/bin/${helper}`);
}

function cleanedHooks(document, provider) {
  const hooks = document?.hooks;
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)))) {
    throw new Error('invalid settings shape');
  }
  if (!hooks) return 0;
  let removed = 0;
  for (const [event, route] of Object.entries(ROUTES[provider])) {
    if (hooks[event] === undefined) continue;
    if (!Array.isArray(hooks[event])) throw new Error(`invalid ${event} hooks`);
    const groups = [];
    for (const group of hooks[event]) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        throw new Error(`invalid ${event} hook group`);
      }
      if (event === 'Notification' && group.matcher !== 'idle_prompt') { groups.push(group); continue; }
      const kept = group.hooks.filter(hook => !isLegacyHook(hook, provider, route));
      const count = group.hooks.length - kept.length;
      removed += count;
      if (!count || kept.length) groups.push(count ? { ...group, hooks: kept } : group);
    }
    if (groups.length || !hooks[event].length) hooks[event] = groups;
    else delete hooks[event];
  }
  return removed;
}

// Run for every native launch, including already-migrated v2 users and custom
// profile homes. No migration marker: an unchanged file needs no write or backup.
function migrateLegacyHooks(provider, env, cwd, warn = message => process.stderr.write(`${message}\n`)) {
  if (!ROUTES[provider]) return null;
  const home = env.HOME || env.USERPROFILE || homedir();
  const profile = provider === 'codex' ? env.CODEX_HOME || join(home, '.codex')
    : env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const path = resolve(cwd, profile, provider === 'codex' ? 'hooks.json' : 'settings.json');
  let temporary;
  try {
    // Follow a configured symlink while preserving the link itself.
    let destination;
    try { destination = fs.realpathSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const stat = fs.statSync(destination);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('settings file is not a regular file under 1 MiB');
    const original = fs.readFileSync(destination, 'utf8');
    const document = JSON.parse(original);
    const removed = cleanedHooks(document, provider);
    if (!removed) return null;
    const backup = `${destination}.clideck-v1-backup-${randomUUID()}`;
    fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    temporary = join(dirname(destination), `.${basename(destination)}.clideck-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: stat.mode & 0o777 });
    fs.chmodSync(temporary, stat.mode & 0o777);
    // Do not overwrite an edit made while preparing the migration.
    if (fs.readFileSync(destination, 'utf8') !== original) throw new Error('settings changed during migration; retry on next launch');
    fs.renameSync(temporary, destination);
    temporary = null;
    return { path, backup, removed };
  } catch (error) {
    warn(`CliDeck could not migrate old hooks in ${path}: ${error.message}. Original settings were left unchanged.`);
    return null;
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
}

module.exports = { migrateLegacyHooks };

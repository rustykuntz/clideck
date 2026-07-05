const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } = require('fs');
const { join, dirname } = require('path');
const { execFileSync, execFile } = require('child_process');
const os = require('os');
const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const { listDirs, binName, defaultShell } = require('./utils');
const { presetForCommand: findPresetForCommand } = require('./preset-utils');
const { PORT } = require('./runtime');
for (const p of presets) if (p.presetId === 'shell') p.command = defaultShell;
function isPresetEnabled(preset) {
  if (!preset?.enabledIfEnv) return true;
  const value = String(process.env[preset.enabledIfEnv] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
function clientPresets() {
  return presets.filter(isPresetEnabled);
}
function filterClientCommands(commands) {
  const allowedPresetIds = new Set(clientPresets().map(p => p.presetId));
  const knownPresetIds = new Set(presets.map(p => p.presetId));
  return (commands || []).filter(cmd => {
    if (cmd.presetId && !allowedPresetIds.has(cmd.presetId) && knownPresetIds.has(cmd.presetId)) return false;
    const preset = cmd.presetId ? presets.find(p => p.presetId === cmd.presetId) : null;
    return !(preset?.available === false && String(cmd.command || '').trim() === String(preset.command || '').trim());
  });
}
const transcript = require('./transcript');
const plugins = require('./plugin-loader');
const { upsertCodexConfig, validateCodexConfigToml } = require('./codex-config');
const { installCodexHooks, removeCodexHooks, codexHooksHealthy } = require('./codex-hooks');

const opencodePluginDir = join(
  process.platform === 'win32' ? (process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming')) : join(os.homedir(), '.config'),
  'opencode', 'plugins'
);
// Resolve opencode preset paths for current platform
for (const p of presets) {
  if (p.presetId !== 'opencode') continue;
  const bridgePath = join(opencodePluginDir, 'clideck-bridge.js');
  if (p.pluginPath) p.pluginPath = bridgePath;
  if (p.pluginSetup) {
    const copyCmd = process.platform === 'win32'
      ? `copy opencode-plugin\\clideck-bridge.js "${opencodePluginDir}\\"`
      : `cp opencode-plugin/clideck-bridge.js ${opencodePluginDir}/`;
    p.pluginSetup = `Install the CliDeck bridge plugin to enable real-time status and resume.\n\n${copyCmd}`;
  }
}

// Check for clideck-remote updates (cached, once per hour)
let remoteUpdateCache = null;
let remoteUpdateCheckedAt = 0;
const REMOTE_UPDATE_INTERVAL = 3600000;

function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function parseVersion(text) {
  const m = String(text || '').match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : '';
}

function getInstalledVersion(bin) {
  try { return parseVersion(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
  try { return parseVersion(execFileSync(bin, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); } catch {}
  return '';
}

function presetForCommand(cmd) {
  return findPresetForCommand(cmd, presets);
}

function rawCommandEnv(cmd) {
  return cmd?.env && typeof cmd.env === 'object' && !Array.isArray(cmd.env) ? cmd.env : {};
}

function expandHomePath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(os.homedir(), text.slice(2));
  return text;
}

function configRootFor(preset, cmd) {
  const env = rawCommandEnv(cmd);
  if (preset?.presetId === 'claude-code') return expandHomePath(env.CLAUDE_CONFIG_DIR) || join(os.homedir(), '.claude');
  if (preset?.presetId === 'codex') return expandHomePath(env.CODEX_HOME) || join(os.homedir(), '.codex');
  if (preset?.presetId === 'gemini-cli') return join(expandHomePath(env.GEMINI_CLI_HOME) || os.homedir(), '.gemini');
  if (preset?.presetId === 'pi') return expandHomePath(env.PI_CODING_AGENT_DIR) || join(os.homedir(), '.pi', 'agent');
  return os.homedir();
}

function checkRemoteUpdate(ws, force = false) {
  const now = Date.now();
  if (!force && remoteUpdateCache && now - remoteUpdateCheckedAt < REMOTE_UPDATE_INTERVAL) {
    ws.send(JSON.stringify({ type: 'remote.update', checked: true, ...remoteUpdateCache }));
    return;
  }
  const shellOpt = process.platform === 'win32';
  require('child_process').execFile('npm', ['list', '-g', 'clideck-remote', '--json', '--depth=0'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
    let installed;
    try { installed = JSON.parse(stdout).dependencies['clideck-remote'].version; }
    catch {
      ws.send(JSON.stringify({ type: 'remote.update', available: false, checked: false }));
      return;
    }
    require('child_process').execFile('npm', ['view', 'clideck-remote', 'version'], { shell: shellOpt, timeout: 10000 }, (err2, stdout2) => {
      if (err2) {
        ws.send(JSON.stringify({ type: 'remote.update', installed, available: false, checked: false }));
        return;
      }
      const latest = stdout2.trim();
      remoteUpdateCache = { installed, latest, available: compareVersions(latest, installed) > 0 };
      remoteUpdateCheckedAt = now;
      ws.send(JSON.stringify({ type: 'remote.update', checked: true, ...remoteUpdateCache }));
    });
  });
}

// Check which agent binaries are available on PATH
const whichCmd = process.platform === 'win32' ? 'where' : 'which';
function checkAvailability() {
  for (const p of presets) {
    if (!isPresetEnabled(p)) continue;
    if (p.presetId === 'shell') { p.available = true; p.version = ''; p.versionOk = true; p.health = { ok: true }; continue; }
    const bin = binName(p.command);
    try {
      execFileSync(whichCmd, [bin], { stdio: 'ignore' });
      p.available = true;
      p.version = getInstalledVersion(bin);
      p.versionOk = !p.minVersion || (p.version && compareVersions(p.version, p.minVersion) >= 0);
      p.health = p.versionOk ? { ok: true } : { ok: false, reason: `Update required (${p.minVersion}+)` };
    } catch {
      p.available = false;
      p.version = '';
      p.versionOk = true;
      p.health = { ok: false, reason: 'Not installed' };
    }
  }
}
checkAvailability();

let cfg = config.load();
if (detectTelemetryConfig(cfg)) config.save(cfg);

function extractQuotedPath(command, needle) {
  if (!command || !needle) return '';
  const parts = String(command).match(/"([^"]+)"/g) || [];
  for (const part of parts) {
    const value = part.slice(1, -1);
    if (value.includes(needle)) return value;
  }
  return '';
}

function hasExistingHook(arr, hookFile, route) {
  return !!arr?.some(h => h.hooks?.some(x => {
    if (!x.command?.includes(hookFile) || !x.command?.includes(` ${route}`)) return false;
    const hookPath = extractQuotedPath(x.command, hookFile);
    if (!hookPath || !existsSync(hookPath)) return false;
    const command = String(x.command).replace(/\\/g, '/');
    const normalizedPath = hookPath.replace(/\\/g, '/');
    const quotedIdx = command.indexOf(`"${normalizedPath}"`);
    if (quotedIdx < 0) return false;
    const suffix = command.slice(quotedIdx + normalizedPath.length + 2).trim().split(/\s+/);
    return suffix[0] === String(PORT) && suffix[1] === route;
  }));
}

function hasAnyExistingHook(hooks, hookFile) {
  return Object.values(hooks || {}).some(arr => arr?.some(h => h.hooks?.some(x => {
    if (!x.command?.includes(hookFile)) return false;
    const hookPath = extractQuotedPath(x.command, hookFile);
    return !!hookPath && existsSync(hookPath);
  })));
}

function codexHooksFeatureEnabled(content) {
  let inFeatures = false;
  for (const line of String(content || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inFeatures = trimmed === '[features]';
      continue;
    }
    if (inFeatures && /^\s*hooks\s*=\s*true\s*$/.test(line)) return true;
  }
  return false;
}

function codexConfigLooksHealthy(content, port, codexHome) {
  if (!content.includes('[otel]') || !content.includes(`localhost:${port}`)) return false;
  const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
  if (!codexHooksFeatureEnabled(content)) return false;
  if (!codexHooksHealthy(codexHome, codexHookPath, port)) return false;
  const notifyLine = content.match(/^\s*notify\s*=\s*\[(.+)\]\s*$/m)?.[1] || '';
  if (!notifyLine.includes('notify-helper')) return false;
  const quoted = [...notifyLine.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const helperPath = quoted.find(v => v.includes('notify-helper'));
  return !!helperPath && existsSync(helperPath);
}

function opencodeBridgeLooksHealthy() {
  const bridgePath = join(opencodePluginDir, 'clideck-bridge.js');
  if (!existsSync(bridgePath)) return false;
  try {
    const content = readFileSync(bridgePath, 'utf8');
    return content.includes('/opencode-events')
      && content.includes('CLIDECK_URL')
      && content.includes('CLIDECK_PORT');
  } catch {
    return false;
  }
}

function piBridgePath(cmd) {
  return join(configRootFor({ presetId: 'pi' }, cmd), 'extensions', 'clideck-bridge.ts');
}

function piBridgeLooksHealthy(cmd) {
  const bridgePath = piBridgePath(cmd);
  if (!existsSync(bridgePath)) return false;
  try {
    const content = readFileSync(bridgePath, 'utf8');
    return content.includes('/hook/pi')
      && content.includes('CLIDECK_SESSION_ID')
      && content.includes('sessionManager.getSessionId');
  } catch {
    return false;
  }
}

function detectTelemetryConfig(c) {
  const port = String(PORT);
  let changed = false;
  const attemptedRepairs = new Set();

  for (let pass = 0; pass < 2; pass++) {
    let repairedAny = false;
    for (const cmd of c.commands || []) {
      const preset = presetForCommand(cmd);
      if (!preset) continue;
      let detected = false;
      let reason = '';
      let repairAllowed = cmd.telemetrySetupConsent === true;
      if (preset.presetId === 'claude-code') {
        try {
          const s = JSON.parse(readFileSync(join(configRootFor(preset, cmd), 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          repairAllowed = repairAllowed || hasAnyExistingHook(hooks, 'claude-hook.js');
          detected = hasExistingHook(hooks.UserPromptSubmit, 'claude-hook.js', 'start')
                  && hasExistingHook(hooks.Stop, 'claude-hook.js', 'stop')
                  && hasExistingHook(hooks.SessionStart, 'claude-hook.js', 'session-start')
                  && hasExistingHook(hooks.SessionEnd, 'claude-hook.js', 'session-end')
                  && hasExistingHook(hooks.PreToolUse, 'claude-hook.js', 'menu')
                  && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && hasExistingHook([h], 'claude-hook.js', 'idle'));
          if (detected && cmd.telemetrySetupConsent !== true) {
            cmd.telemetrySetupConsent = true;
            changed = true;
          }
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'codex') {
        try {
          const codexHome = configRootFor(preset, cmd);
          const content = readFileSync(join(codexHome, 'config.toml'), 'utf8');
          detected = codexConfigLooksHealthy(content, port, codexHome);
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'gemini-cli') {
        try {
          const s = JSON.parse(readFileSync(join(configRootFor(preset, cmd), 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          detected = hasExistingHook(hooks.BeforeAgent, 'gemini-hook.js', 'start')
                  && hasExistingHook(hooks.AfterAgent, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.SessionEnd, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.BeforeTool, 'gemini-hook.js', 'menu');
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'opencode') {
        detected = opencodeBridgeLooksHealthy();
        if (!detected) reason = 'Needs re-patch';
      } else if (preset.presetId === 'pi') {
        detected = piBridgeLooksHealthy(cmd);
        if (!detected) reason = 'Needs re-patch';
      } else { continue; }
      if (preset.available && preset.minVersion && !preset.versionOk) {
        detected = false;
        reason = `Update required (${preset.minVersion}+)`;
      } else if (!detected && cmd.telemetryEnabled && repairAllowed && preset.telemetryAutoSetup && preset.available && preset.versionOk && !attemptedRepairs.has(cmd.id || preset.presetId)) {
        attemptedRepairs.add(cmd.id || preset.presetId);
        const repaired = applyTelemetryConfig(preset, cmd);
        if (repaired.success) {
          repairedAny = true;
          continue;
        }
      }
      const nextEnabled = detected || (!!cmd.telemetryEnabled && !reason.startsWith('Update required'));
      const nextStatus = detected ? { ok: true } : { ok: false, error: reason || 'Needs setup' };
      if (cmd.telemetryEnabled !== nextEnabled || JSON.stringify(cmd.telemetryStatus || null) !== JSON.stringify(nextStatus)) {
        cmd.telemetryEnabled = nextEnabled;
        cmd.telemetryStatus = nextStatus;
        changed = true;
      }
      preset.health = detected ? { ok: true } : { ok: false, reason: reason || 'Needs setup' };
    }
    if (!repairedAny) break;
  }
  if (changed) console.log('Config: synced telemetry/plugin state from detected config files');
  return changed;
}

const appVersion = require('./package.json').version;

function configForClient() {
  return { ...cfg, commands: filterClientCommands(cfg.commands), pluginsDir: plugins.PLUGINS_DIR, version: appVersion };
}

function remoteCliEnv() {
  return { ...process.env, CLIDECK_PORT: String(PORT) };
}

function remoteVoiceCapabilityError() {
  const voicePlugin = plugins.getInfo().find(p => p.id === 'voice-input' && p.installed);
  return voicePlugin
    ? 'Restart CliDeck so the Voice Input plugin update can finish loading.'
    : 'Install the Voice Input plugin in CliDeck first.';
}

function onConnection(ws) {
  sessions.clients.add(ws);

  ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
  ws.send(JSON.stringify({ type: 'themes', themes }));
  ws.send(JSON.stringify({ type: 'presets', presets: clientPresets() }));
  ws.send(JSON.stringify({ type: 'sessions', list: sessions.list() }));
  ws.send(JSON.stringify({ type: 'sessions.resumable', list: sessions.getResumable(cfg) }));
  ws.send(JSON.stringify({ type: 'transcript.cache', cache: transcript.getCache() }));
  ws.send(JSON.stringify({ type: 'plugins', list: plugins.getInfo() }));
  ws.send(JSON.stringify({ type: 'pills', list: plugins.getPills() }));
  sessions.sendBuffers(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create':          sessions.create(msg, ws, cfg); break;
      case 'session.resume':  sessions.resume(msg, ws, cfg); break;
      case 'session.restart': console.log('[handler] session.restart', msg.id); sessions.restart(msg, ws, cfg); break;
      case 'input':                sessions.input(msg); break;
      case 'session.statusReport':
        if (sessions.getSessions().has(msg.id)) {
          sessions.broadcast({ type: 'session.status', id: msg.id, working: !!msg.working, source: 'client' });
        }
        break;
      case 'terminal.buffer': {
        const transcript = require('./transcript');
        const sess = sessions.getSessions().get(msg.id);
        if (sess) {
          const rawChoices = transcript.detectMenu(msg.lines, sess.presetId);
          let choices = rawChoices;
          // Codex: only trust menu detection if last OTEL event was response.completed
          if (choices && sess.presetId === 'codex') {
            const last = require('./telemetry-receiver').getLastEvent(msg.id);
            if (!last.startsWith('codex.sse_event:response.completed')) {
              choices = null;
            }
          }
          if (choices && sess.presetId === 'claude-code' && msg.menuVersion && (sess._menuConsumedVersion || 0) >= msg.menuVersion) {
            choices = null;
          }
          let key = choices ? JSON.stringify(choices) : '';
          // Claude can keep rendering the same approval menu briefly after Enter.
          // Once that exact menu was approved, ignore repeated detections of the
          // same signature until the next real turn starts.
          if (choices && sess.presetId === 'claude-code' && key === (sess._resolvedMenuKey || '')) {
            choices = null;
            key = '';
          }
          const candidateLines = (choices || (rawChoices && sess.presetId === 'claude-code'))
            ? transcript.stripMenu(msg.lines, sess.presetId)
            : msg.lines;
          transcript.updateAgentCandidate(msg.id, sess.presetId, candidateLines);
          if (!sess.working && sess._finalizeOnIdle) {
            sess._finalizeOnIdle = false;
            transcript.commitAgentCandidate(msg.id, sess.presetId);
          }
          // Auto-approve: send Enter immediately when menu detected
          if (choices && plugins.shouldAutoApproveMenu(msg.id)) {
            setTimeout(() => sessions.input({ id: msg.id, data: '\r' }), 500);
          }
          if (choices) transcript.commitAgentCandidate(msg.id, sess.presetId);
          if (key !== (sess._menuKey || '')) {
            sess._menuKey = key;
            sess._menuStartsWork = !(sess.presetId === 'claude-code' && !msg.menuVersion);
            sessions.broadcast({ type: 'session.menu', id: msg.id, choices: choices || [] });
            if (choices) {
              if (sess.presetId === 'claude-code' && msg.menuVersion) sess._menuActiveVersion = msg.menuVersion;
              plugins.notifyMenu(msg.id, choices);
              if (sess.presetId === 'codex') require('./telemetry-receiver').cancelCodexMenuPoll(msg.id);
              sessions.broadcast({ type: 'session.status', id: msg.id, working: false, source: 'menu' });
            }
          }
        }
        break;
      }
      case 'resize':               sessions.resize(msg); break;
      case 'rename':          sessions.rename(msg); break;
      case 'close':           sessions.close(msg, cfg); break;

      case 'config.get':
        ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
        break;

      case 'checkAvailability':
        checkAvailability();
        if (detectTelemetryConfig(cfg)) config.save(cfg);
        ws.send(JSON.stringify({ type: 'presets', presets: clientPresets() }));
        ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
        break;

      case 'config.update':
        delete msg.config.pluginsDir;
        delete msg.config.version;
        cfg = { ...cfg, ...msg.config };
        detectTelemetryConfig(cfg);
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;

      case 'session.theme': {
        const ok = sessions.setTheme(msg.id, msg.themeId);
        if (ok) sessions.broadcast({ type: 'session.theme', id: msg.id, themeId: msg.themeId });
        break;
      }

      case 'telemetry.autosetup': {
        const targetCmd = msg.commandId ? cfg.commands.find(c => c.id === msg.commandId) : null;
        const preset = targetCmd ? presetForCommand(targetCmd) : presets.find(p => p.presetId === msg.presetId);
        if (!preset?.telemetryAutoSetup) break;
        if (preset.available === false) {
          ws.send(JSON.stringify({
            type: 'telemetry.autosetup.result',
            presetId: preset.presetId,
            commandId: msg.commandId || null,
            success: false,
            output: `${preset.name} is not installed`,
          }));
          break;
        }
        const result = applyTelemetryConfig(preset, targetCmd);
        for (const cmd of cfg.commands) {
          if (targetCmd ? cmd.id === targetCmd.id : presetForCommand(cmd)?.presetId === preset.presetId) {
            cmd.telemetryEnabled = result.success;
            cmd.telemetryStatus = result.success ? { ok: true } : { ok: false, error: result.message };
            if (result.success) cmd.telemetrySetupConsent = true;
            // Enable the agent when setup succeeds, disable if it fails
            if (result.success) cmd.enabled = true;
          }
        }
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        ws.send(JSON.stringify({
          type: 'telemetry.autosetup.result',
          presetId: preset.presetId,
          commandId: msg.commandId || null,
          success: result.success,
          output: result.message,
        }));
        break;
      }

      case 'telemetry.configure': {
        const targetCmd = msg.commandId ? cfg.commands.find(c => c.id === msg.commandId) : null;
        const preset = targetCmd ? presetForCommand(targetCmd) : presets.find(p => p.presetId === msg.presetId);
        if (!preset) break;
        const enable = !!msg.enable;
        let result;
        if (enable) {
          result = applyTelemetryConfig(preset, targetCmd);
        } else {
          result = removeTelemetryConfig(preset, targetCmd);
        }
        // Update all matching commands in config
        for (const cmd of cfg.commands) {
          if (targetCmd ? cmd.id === targetCmd.id : presetForCommand(cmd)?.presetId === preset.presetId) {
            cmd.telemetryEnabled = enable && result.success;
            cmd.telemetrySetupConsent = enable && result.success;
            cmd.telemetryStatus = enable
              ? (result.success ? { ok: true } : { ok: false, error: result.message })
              : null;
          }
        }
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;
      }

      case 'session.mute': {
        const ok = sessions.setMute(msg.id, msg.muted);
        if (ok) sessions.broadcast({ type: 'session.mute', id: msg.id, muted: !!msg.muted });
        break;
      }

      case 'session.setProject': {
        const result = sessions.setProject(msg.id, msg.projectId);
        if (result?.ok) sessions.broadcast({ type: 'session.setProject', id: msg.id, projectId: msg.projectId });
        else if (result?.error) ws.send(JSON.stringify({ type: 'error', message: result.error }));
        break;
      }

      // Client reports latest preview text — stored in memory, persisted by auto-save
      case 'session.setPreview':
        sessions.setPreview(msg.id, msg.text, msg.timestamp);
        break;

      case 'project.delete': {
        const proj = cfg.projects?.find(p => p.id === msg.id);
        if (!proj) break;
        // Kill all sessions in this project
        for (const s of sessions.list()) {
          if (s.projectId === msg.id) sessions.close({ id: s.id }, cfg);
        }
        cfg.projects = cfg.projects.filter(p => p.id !== msg.id);
        config.save(cfg);
        plugins.notifyConfig(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;
      }

      case 'project.openPath': {
        const proj = cfg.projects?.find(p => p.id === msg.id);
        if (!proj?.path) {
          ws.send(JSON.stringify({ type: 'project.openPath.result', id: msg.id, success: false, error: 'Project path is not set' }));
          break;
        }
        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
          ws.send(JSON.stringify({ type: 'project.openPath.result', id: msg.id, success: false, headless: true, path: proj.path }));
          break;
        }
        const cmd = process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
        execFile(cmd, [proj.path], { shell: process.platform === 'win32' }, (err) => {
          ws.send(JSON.stringify({
            type: 'project.openPath.result',
            id: msg.id,
            success: !err,
            error: err ? err.message : '',
          }));
        });
        break;
      }

      case 'dirs.list': {
        const target = msg.path || cfg.defaultPath;
        const result = listDirs(target, !!msg.showHidden);
        const entries = Array.isArray(result) ? result : [];
        const error = result.error || undefined;
        ws.send(JSON.stringify({ type: 'dirs', path: target, entries, error }));
        break;
      }

      case 'dirs.mkdir': {
        const name = (msg.name || '').trim();
        if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: false, error: 'Invalid folder name' }));
          break;
        }
        const dirPath = join(msg.parent, name);
        try {
          mkdirSync(dirPath);
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: true, path: dirPath }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'dirs.mkdir', success: false, error: e.message }));
        }
        break;
      }

      case 'plugin.settings.update':
        plugins.updateSetting(msg.pluginId, msg.key, msg.value);
        sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        break;

      case 'plugin.install': {
        ws.send(JSON.stringify({ type: 'plugin.install.progress', pluginId: msg.pluginId }));
        plugins.installPlugin(msg.pluginId, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'plugin.install.result', pluginId: msg.pluginId, success: false, error: err.message }));
          } else {
            sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
            ws.send(JSON.stringify({ type: 'plugin.install.result', pluginId: msg.pluginId, success: true }));
          }
        });
        break;
      }
      case 'plugin.delete': {
        const result = plugins.removePlugin(msg.pluginId);
        if (result.success) {
          sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        } else {
          ws.send(JSON.stringify({ type: 'plugin.delete.error', pluginId: msg.pluginId, error: result.message }));
        }
        break;
      }

      case 'pill.getLogs':
        ws.send(JSON.stringify({ type: 'pill.logs', id: msg.id, logs: plugins.getPillLogs(msg.id) }));
        break;

      case 'remote.status': {
        let installed = false;
        try { execFileSync(whichCmd, ['clideck-remote'], { stdio: 'ignore' }); installed = true; } catch {}
        if (!installed) { ws.send(JSON.stringify({ type: 'remote.status', installed: false })); break; }
        require('child_process').execFile('clideck-remote', ['status', '--json'], { timeout: 5000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.status', installed: true, ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); }
        });
        checkRemoteUpdate(ws, !!msg.forceUpdate);
        break;
      }

      case 'remote.pair': {
        require('child_process').execFile('clideck-remote', ['pair', '--json'], { timeout: 15000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.error', error: err.message })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.paired', ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.error', error: 'Invalid response from clideck-remote' })); }
        });
        break;
      }

      case 'remote.unpair': {
        require('child_process').execFile('clideck-remote', ['unpair', '--json'], { timeout: 5000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'remote.error', error: err.message }));
          } else {
            sessions.broadcast({ type: 'remote.unpaired' });
          }
        });
        break;
      }

      case 'remote.getHistory': {
        ws.send(JSON.stringify({ type: 'remote.history', id: msg.id, turns: transcript.getTurns(msg.id, 20, 'end') }));
        break;
      }

      case 'remote.voice.transcribe': {
        const requestId = String(msg.requestId || '');
        const replyError = (error) => ws.send(JSON.stringify({ type: 'remote.voice.error', requestId, error }));
        if (!plugins.hasCapability('voice-input', 'transcribeAudio')) {
          replyError(remoteVoiceCapabilityError());
          break;
        }
        if (typeof msg.audio !== 'string' || !msg.audio) {
          replyError('No audio received.');
          break;
        }
        plugins.invoke('voice-input', 'transcribeAudio', { audio: msg.audio })
          .then(result => ws.send(JSON.stringify({ type: 'remote.voice.result', requestId, ...result })))
          .catch(e => replyError(e.message || 'Voice transcription failed.'));
        break;
      }

      case 'remote.voice.send': {
        const requestId = String(msg.requestId || '');
        const id = String(msg.id || '');
        const replyError = (error) => ws.send(JSON.stringify({ type: 'remote.voice.error', requestId, error }));
        if (!plugins.hasCapability('voice-input', 'transcribeAudio')) {
          replyError(remoteVoiceCapabilityError());
          break;
        }
        if (!id || !sessions.getSessions().has(id)) {
          replyError('Session is not available.');
          break;
        }
        if (typeof msg.audio !== 'string' || !msg.audio) {
          replyError('No audio received.');
          break;
        }
        plugins.invoke('voice-input', 'transcribeAudio', { audio: msg.audio })
          .then(result => {
            const text = String(result?.text || '').trim();
            if (!text) {
              ws.send(JSON.stringify({ type: 'remote.voice.sent', requestId, id, skipped: true }));
              return;
            }
            sessions.input({ id, data: text });
            setTimeout(() => sessions.input({ id, data: '\r' }), 150);
            ws.send(JSON.stringify({ type: 'remote.voice.sent', requestId, id, text }));
          })
          .catch(e => replyError(e.message || 'Voice transcription failed.'));
        break;
      }

      case 'remote.install': {
        const update = !!msg.update;
        const restartAfterUpdate = !!msg.restart;
        const proc = require('child_process').spawn('npm', ['install', '-g', 'clideck-remote'], {
          shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.on('close', code => {
          remoteUpdateCache = null;
          if (code !== 0 || !update || !restartAfterUpdate) {
            ws.send(JSON.stringify({ type: 'remote.install.done', success: code === 0, update, restarted: false }));
            return;
          }
          require('child_process').execFile('clideck-remote', ['restart', '--json'], { timeout: 10000, shell: process.platform === 'win32', env: remoteCliEnv() }, (err, stdout) => {
            if (err) {
              ws.send(JSON.stringify({ type: 'remote.install.done', success: false, update, error: err.message }));
              return;
            }
            let restart = null;
            try { restart = JSON.parse(stdout); } catch {}
            ws.send(JSON.stringify({ type: 'remote.install.done', success: true, update, restart }));
          });
        });
        break;
      }

      default:
        if (msg.type?.startsWith('plugin.')) plugins.handleMessage(msg);
        break;
    }
  });

  ws.on('close', () => sessions.clients.delete(ws));
}

// Deterministic telemetry config writers per agent — no AI, no YOLO
function applyTelemetryConfig(preset, cmd = null) {
  const port = String(PORT);

  try {
    if (preset.presetId === 'claude-code') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      const hooks = settings.hooks || {};
      // StopFailure isn't a real Claude Code hook event; a previous version of this
      // installer wrote it, which makes Claude Code reject the whole settings.json.
      // Scrub it from anyone who already has it, on every run.
      const hadStopFailure = 'StopFailure' in hooks;
      delete hooks.StopFailure;
      const hookCmd = (route) => `"${process.execPath.replace(/\\/g, '/')}" "${join(__dirname, 'bin', 'claude-hook.js').replace(/\\/g, '/')}" ${port} ${route}`;
      const clideckHook = (route) => ({ hooks: [{ type: 'command', command: hookCmd(route) }] });
      const hasClideck = (arr, path) => arr?.some(h => h.hooks?.some(x => x.command === hookCmd(path)));
      if (!hadStopFailure
          && hasClideck(hooks.UserPromptSubmit, 'start')
          && hasClideck(hooks.Stop, 'stop')
          && hasClideck(hooks.SessionStart, 'session-start')
          && hasClideck(hooks.SessionEnd, 'session-end')
          && hasClideck(hooks.PreToolUse, 'menu')
          && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && h.hooks?.some(x => x.command === hookCmd('idle')))) {
        return { success: true, message: 'Already configured' };
      }
      const stripOld = (arr) => (arr || []).filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
      hooks.UserPromptSubmit = stripOld(hooks.UserPromptSubmit);
      hooks.Stop = stripOld(hooks.Stop);
      hooks.SessionStart = stripOld(hooks.SessionStart);
      hooks.SessionEnd = stripOld(hooks.SessionEnd);
      hooks.PreToolUse = stripOld(hooks.PreToolUse);
      hooks.Notification = stripOld(hooks.Notification);
      if (!hasClideck(hooks.UserPromptSubmit, 'start')) hooks.UserPromptSubmit = [...(hooks.UserPromptSubmit || []), clideckHook('start')];
      if (!hasClideck(hooks.Stop, 'stop')) hooks.Stop = [...(hooks.Stop || []), clideckHook('stop')];
      if (!hasClideck(hooks.SessionStart, 'session-start')) hooks.SessionStart = [...(hooks.SessionStart || []), clideckHook('session-start')];
      if (!hasClideck(hooks.SessionEnd, 'session-end')) hooks.SessionEnd = [...(hooks.SessionEnd || []), clideckHook('session-end')];
      if (!hasClideck(hooks.Notification, 'idle')) hooks.Notification = [...(hooks.Notification || []), { matcher: 'idle_prompt', ...clideckHook('idle') }];
      if (!hasClideck(hooks.PreToolUse, 'menu')) hooks.PreToolUse = [...(hooks.PreToolUse || []), clideckHook('menu')];
      settings.hooks = hooks;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Added hooks to ${configPath} — Claude will ask for one-time approval` };
    }

    if (preset.presetId === 'codex') {
      const codexHome = configRootFor(preset, cmd);
      const configPath = join(codexHome, 'config.toml');
      let content = '';
      if (existsSync(configPath)) content = readFileSync(configPath, 'utf8');
      const hasOtel = content.includes('[otel]');
      const hasCurrentOtel = content.includes(`localhost:${port}`);
      const hasNotify = /^\s*notify\s*=.*notify-helper/m.test(content);
      const hasWrongOtel = content.includes(`endpoint = "http://localhost:${port}/v1/logs"`);
      const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
      const hasHooks = codexHooksFeatureEnabled(content) && codexHooksHealthy(codexHome, codexHookPath, port);
      if (hasOtel && hasCurrentOtel && hasNotify && !hasWrongOtel && hasHooks) {
        return { success: true, message: 'Already configured' };
      }
      const notifyHelperPath = join(__dirname, 'bin', 'notify-helper.js').replace(/\\/g, '/');
      const nextContent = upsertCodexConfig(content, process.execPath.replace(/\\/g, '/'), notifyHelperPath, port);
      const valid = validateCodexConfigToml(nextContent);
      if (!valid.ok) return { success: false, message: valid.error };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, nextContent);
      installCodexHooks(codexHome, process.execPath.replace(/\\/g, '/'), codexHookPath, port);
      return { success: true, message: 'Configured. If Codex shows "2 hooks need review", open /hooks and approve the CliDeck hooks once.' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      const hooks = settings.hooks || {};
      const helperPath = join(__dirname, 'bin', 'gemini-hook.js').replace(/\\/g, '/');
      const nodePath = process.execPath.replace(/\\/g, '/');
      const hookCmd = (route) => `"${nodePath}" "${helperPath}" ${port} ${route}`;
      const geminiHook = (route) => ({
        matcher: '*',
        hooks: [{ type: 'command', command: hookCmd(route), name: `clideck-${route}`, timeout: 5000 }],
      });
      const has = (arr, route) => arr?.some(h => h.hooks?.some(x => x.command === hookCmd(route)));
      if (has(hooks.BeforeAgent, 'start') && has(hooks.AfterAgent, 'stop') && has(hooks.SessionEnd, 'stop') && has(hooks.BeforeTool, 'menu')) {
        return { success: true, message: 'Already configured' };
      }
      const stripOld = (arr) => (arr || []).filter(h => !h.hooks?.some(x => x.command?.includes('gemini-hook.js')));
      hooks.BeforeAgent = stripOld(hooks.BeforeAgent);
      hooks.AfterAgent = stripOld(hooks.AfterAgent);
      hooks.SessionEnd = stripOld(hooks.SessionEnd);
      hooks.BeforeTool = stripOld(hooks.BeforeTool);
      if (!has(hooks.BeforeAgent, 'start')) hooks.BeforeAgent = [...(hooks.BeforeAgent || []), geminiHook('start')];
      if (!has(hooks.AfterAgent, 'stop')) hooks.AfterAgent = [...(hooks.AfterAgent || []), geminiHook('stop')];
      if (!has(hooks.SessionEnd, 'stop')) hooks.SessionEnd = [...(hooks.SessionEnd || []), geminiHook('stop')];
      if (!has(hooks.BeforeTool, 'menu')) hooks.BeforeTool = [...(hooks.BeforeTool || []), geminiHook('menu')];
      settings.hooks = hooks;
      if (settings.telemetry?.target === 'local' && /localhost:\d+/.test(String(settings.telemetry?.otlpEndpoint || ''))) delete settings.telemetry;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Added CliDeck hooks to ${configPath}` };
    }

    if (preset.presetId === 'opencode') {
      const src = join(__dirname, 'opencode-plugin', 'clideck-bridge.js');
      mkdirSync(opencodePluginDir, { recursive: true });
      copyFileSync(src, join(opencodePluginDir, 'clideck-bridge.js'));
      // Remove old termix-bridge.js if present
      const old = join(opencodePluginDir, 'termix-bridge.js');
      if (existsSync(old)) try { unlinkSync(old); } catch {}
      return { success: true, message: `Installed bridge plugin to ${opencodePluginDir}` };
    }

    if (preset.presetId === 'pi') {
      const src = join(__dirname, 'pi-extension', 'clideck-bridge.ts');
      const dest = piBridgePath(cmd);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      return { success: true, message: `Installed Pi extension to ${dest}` };
    }

    return { success: false, message: `No auto-setup for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function removeTelemetryConfig(preset, cmd = null) {
  try {
    if (preset.presetId === 'claude-code') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      if (!settings.hooks) return { success: true, message: 'No hooks to remove' };
      for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Notification', 'PreToolUse']) {
        const arr = settings.hooks[event];
        if (!arr) continue;
        settings.hooks[event] = arr.filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Removed CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'codex') {
      const codexHome = configRootFor(preset, cmd);
      const configPath = join(codexHome, 'config.toml');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let content = readFileSync(configPath, 'utf8');
      content = content.replace(/\n?\[otel\][^\[]*/, '');
      content = content.replace(/\n?notify\s*=\s*\[.*?notify-helper.*?\]\s*/g, '');
      content = content.replace(/\n?codex_hooks\s*=\s*(true|false)\s*/g, '\n');
      writeFileSync(configPath, content.trimEnd() + '\n');
      removeCodexHooks(codexHome);
      return { success: true, message: `Removed otel + CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(configRootFor(preset, cmd), 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      for (const event of ['BeforeAgent', 'AfterAgent', 'SessionEnd', 'BeforeTool']) {
        const arr = settings.hooks?.[event];
        if (!arr) continue;
        settings.hooks[event] = arr.filter(h => !h.hooks?.some(x => x.command?.includes('gemini-hook.js')));
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
      if (settings.telemetry?.target === 'local' && /localhost:\d+/.test(String(settings.telemetry?.otlpEndpoint || ''))) delete settings.telemetry;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: `Removed CliDeck hooks from ${configPath}` };
    }

    if (preset.presetId === 'opencode') {
      try { unlinkSync(join(opencodePluginDir, 'clideck-bridge.js')); } catch {}
      try { unlinkSync(join(opencodePluginDir, 'termix-bridge.js')); } catch {}
      return { success: true, message: 'Removed bridge plugin' };
    }

    if (preset.presetId === 'pi') {
      try { unlinkSync(piBridgePath(cmd)); } catch {}
      return { success: true, message: 'Removed Pi extension' };
    }

    return { success: false, message: `No removal logic for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getConfig() { return cfg; }

module.exports = { onConnection, getConfig, applyTelemetryConfig, removeTelemetryConfig };

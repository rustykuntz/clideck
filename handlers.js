const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } = require('fs');
const { join, dirname } = require('path');
const { execFileSync } = require('child_process');
const os = require('os');
const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const { listDirs, binName, defaultShell } = require('./utils');
for (const p of presets) if (p.presetId === 'shell') p.command = defaultShell;
const transcript = require('./transcript');
const plugins = require('./plugin-loader');

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

function checkRemoteUpdate(ws) {
  const now = Date.now();
  if (remoteUpdateCache && now - remoteUpdateCheckedAt < REMOTE_UPDATE_INTERVAL) {
    if (remoteUpdateCache.available) ws.send(JSON.stringify({ type: 'remote.update', ...remoteUpdateCache }));
    return;
  }
  const shellOpt = process.platform === 'win32';
  require('child_process').execFile('npm', ['list', '-g', 'clideck-remote', '--json', '--depth=0'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
    let installed;
    try { installed = JSON.parse(stdout).dependencies['clideck-remote'].version; } catch { return; }
    require('child_process').execFile('npm', ['view', 'clideck-remote', 'version'], { shell: shellOpt, timeout: 10000 }, (err2, stdout2) => {
      if (err2) return;
      const latest = stdout2.trim();
      remoteUpdateCache = { installed, latest, available: latest !== installed };
      remoteUpdateCheckedAt = now;
      if (remoteUpdateCache.available) ws.send(JSON.stringify({ type: 'remote.update', ...remoteUpdateCache }));
    });
  });
}

// Check which agent binaries are available on PATH
const whichCmd = process.platform === 'win32' ? 'where' : 'which';
function checkAvailability() {
  for (const p of presets) {
    if (p.presetId === 'shell') { p.available = true; continue; }
    try { execFileSync(whichCmd, [binName(p.command)], { stdio: 'ignore' }); p.available = true; }
    catch { p.available = false; }
  }
}
checkAvailability();

let cfg = config.load();
if (detectTelemetryConfig(cfg)) config.save(cfg);

function detectTelemetryConfig(c) {
  const home = os.homedir();
  const port = '4000';
  let changed = false;
  for (const cmd of c.commands || []) {
    const bin = binName(cmd.command);
    const preset = presets.find(p => binName(p.command) === bin);
    if (!preset) continue;
    let detected = false;
    if (preset.presetId === 'claude-code') {
      detected = true;
    } else if (preset.presetId === 'codex') {
      try {
        const content = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
        detected = content.includes('[otel]') && content.includes(`localhost:${port}`);
      } catch {}
    } else if (preset.presetId === 'gemini-cli') {
      try {
        const s = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
        detected = !!s.telemetry?.enabled && (s.telemetry?.otlpEndpoint || '').includes(`localhost:${port}`);
      } catch {}
    } else if (preset.presetId === 'opencode') {
      detected = existsSync(join(opencodePluginDir, 'clideck-bridge.js')) || existsSync(join(opencodePluginDir, 'termix-bridge.js'));
    } else { continue; }
    if (detected !== !!cmd.telemetryEnabled) {
      cmd.telemetryEnabled = detected;
      cmd.telemetryStatus = detected ? { ok: true } : null;
      changed = true;
    }
  }
  if (changed) console.log('Config: synced telemetry/plugin state from detected config files');
  return changed;
}

const appVersion = require('./package.json').version;

function configForClient() {
  return { ...cfg, pluginsDir: plugins.PLUGINS_DIR, version: appVersion };
}

function onConnection(ws) {
  sessions.clients.add(ws);

  ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
  ws.send(JSON.stringify({ type: 'themes', themes }));
  ws.send(JSON.stringify({ type: 'presets', presets }));
  ws.send(JSON.stringify({ type: 'sessions', list: sessions.list() }));
  ws.send(JSON.stringify({ type: 'sessions.resumable', list: sessions.getResumable(cfg) }));
  ws.send(JSON.stringify({ type: 'transcript.cache', cache: transcript.getCache() }));
  ws.send(JSON.stringify({ type: 'plugins', list: plugins.getInfo() }));
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
          sessions.broadcast({ type: 'session.status', id: msg.id, working: !!msg.working });
          plugins.notifyStatus(msg.id, !!msg.working);
        }
        break;
      case 'terminal.buffer': {
        require('./transcript').storeBuffer(msg.id, msg.lines);
        sessions.broadcast({ type: 'screen.updated', id: msg.id });
        const sess = sessions.getSessions().get(msg.id);
        if (sess) {
          const choices = require('./transcript').detectMenu(msg.lines, sess.presetId);
          const key = choices ? JSON.stringify(choices) : '';
          if (key !== (sess._menuKey || '')) {
            sess._menuKey = key;
            sessions.broadcast({ type: 'session.menu', id: msg.id, choices: choices || [] });
            if (choices) sessions.broadcast({ type: 'session.status', id: msg.id, working: false, source: 'menu' });
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
        ws.send(JSON.stringify({ type: 'presets', presets }));
        break;

      case 'config.update':
        delete msg.config.pluginsDir;
        delete msg.config.version;
        cfg = { ...cfg, ...msg.config };
        detectTelemetryConfig(cfg);
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;

      case 'session.theme': {
        const ok = sessions.setTheme(msg.id, msg.themeId);
        if (ok) sessions.broadcast({ type: 'session.theme', id: msg.id, themeId: msg.themeId });
        break;
      }

      case 'telemetry.autosetup': {
        const preset = presets.find(p => p.presetId === msg.presetId);
        if (!preset?.telemetryAutoSetup) break;
        // Only allow if caller has a live session using this preset's command
        const liveSessions = sessions.list();
        const hasLive = liveSessions.some(s => {
          const cmd = cfg.commands.find(c => c.id === s.commandId);
          return cmd && binName(cmd.command) === binName(preset.command);
        });
        if (!hasLive) break;
        const result = applyTelemetryConfig(preset);
        // Persist telemetry state in config
        for (const cmd of cfg.commands) {
          if (binName(cmd.command) === binName(preset.command)) {
            cmd.telemetryEnabled = result.success;
            cmd.telemetryStatus = result.success ? { ok: true } : { ok: false, error: result.message };
          }
        }
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        ws.send(JSON.stringify({
          type: 'telemetry.autosetup.result',
          presetId: msg.presetId,
          success: result.success,
          output: result.message,
        }));
        break;
      }

      case 'telemetry.configure': {
        const preset = presets.find(p => p.presetId === msg.presetId);
        if (!preset) break;
        const enable = !!msg.enable;
        let result;
        if (enable) {
          result = applyTelemetryConfig(preset);
        } else {
          result = removeTelemetryConfig(preset);
        }
        // Update all matching commands in config
        for (const cmd of cfg.commands) {
          if (binName(cmd.command) === binName(preset.command)) {
            cmd.telemetryEnabled = enable && result.success;
            cmd.telemetryStatus = enable
              ? (result.success ? { ok: true } : { ok: false, error: result.message })
              : null;
          }
        }
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;
      }

      case 'session.mute': {
        const ok = sessions.setMute(msg.id, msg.muted);
        if (ok) sessions.broadcast({ type: 'session.mute', id: msg.id, muted: !!msg.muted });
        break;
      }

      case 'session.setProject': {
        const ok = sessions.setProject(msg.id, msg.projectId);
        if (ok) sessions.broadcast({ type: 'session.setProject', id: msg.id, projectId: msg.projectId });
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
        sessions.broadcast({ type: 'config', config: configForClient() });
        break;
      }

      case 'dirs.list': {
        const target = msg.path || cfg.defaultPath;
        const result = listDirs(target);
        const entries = Array.isArray(result) ? result : [];
        const error = result.error || undefined;
        ws.send(JSON.stringify({ type: 'dirs', path: target, entries, error }));
        break;
      }

      case 'plugin.settings.update':
        plugins.updateSetting(msg.pluginId, msg.key, msg.value);
        sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        break;

      case 'plugin.delete': {
        const result = plugins.removePlugin(msg.pluginId);
        if (result.success) {
          sessions.broadcast({ type: 'plugins', list: plugins.getInfo() });
        } else {
          ws.send(JSON.stringify({ type: 'plugin.delete.error', pluginId: msg.pluginId, error: result.message }));
        }
        break;
      }

      case 'remote.status': {
        let installed = false;
        try { execFileSync(whichCmd, ['clideck-remote'], { stdio: 'ignore' }); installed = true; } catch {}
        if (!installed) { ws.send(JSON.stringify({ type: 'remote.status', installed: false })); break; }
        require('child_process').execFile('clideck-remote', ['status', '--json'], { timeout: 5000, shell: process.platform === 'win32' }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.status', installed: true, ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); }
        });
        checkRemoteUpdate(ws);
        break;
      }

      case 'remote.pair': {
        require('child_process').execFile('clideck-remote', ['pair', '--json'], { timeout: 15000, shell: process.platform === 'win32' }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.error', error: err.message })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.paired', ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.error', error: 'Invalid response from clideck-remote' })); }
        });
        break;
      }

      case 'remote.unpair': {
        require('child_process').execFile('clideck-remote', ['unpair', '--json'], { timeout: 5000, shell: process.platform === 'win32' }, (err) => {
          if (err) {
            ws.send(JSON.stringify({ type: 'remote.error', error: err.message }));
          } else {
            sessions.broadcast({ type: 'remote.unpaired' });
          }
        });
        break;
      }

      case 'remote.getHistory': {
        const turns = transcript.getScreenTurns(msg.id, sessions.getSessions().get(msg.id)?.presetId);
        ws.send(JSON.stringify({ type: 'remote.history', id: msg.id, turns: turns || [] }));
        break;
      }

      case 'remote.install': {
        const proc = require('child_process').spawn('npm', ['install', '-g', 'clideck-remote'], {
          shell: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stdout.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.stderr.on('data', d => ws.send(JSON.stringify({ type: 'remote.install.progress', text: d.toString() })));
        proc.on('close', code => {
          remoteUpdateCache = null;
          ws.send(JSON.stringify({ type: 'remote.install.done', success: code === 0 }));
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
function applyTelemetryConfig(preset) {
  const port = '4000';
  const home = os.homedir();

  try {
    if (preset.presetId === 'codex') {
      const configPath = join(home, '.codex', 'config.toml');
      let content = '';
      if (existsSync(configPath)) content = readFileSync(configPath, 'utf8');
      if (content.includes('[otel]')) return { success: true, message: 'Already configured' };
      const section = `\n[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:${port}/v1/logs", protocol = "json" } }\n`;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, content.trimEnd() + '\n' + section);
      return { success: true, message: 'Added [otel] section to ~/.codex/config.toml' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(home, '.gemini', 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      if (settings.telemetry?.enabled && settings.telemetry?.otlpEndpoint) {
        return { success: true, message: 'Already configured' };
      }
      settings.telemetry = {
        ...settings.telemetry,
        enabled: true,
        target: 'local',
        otlpEndpoint: `http://localhost:${port}/v1/logs`,
        otlpProtocol: 'http',
        logPrompts: true,
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: 'Added telemetry section to ~/.gemini/settings.json' };
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

    return { success: false, message: `No auto-setup for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function removeTelemetryConfig(preset) {
  const home = os.homedir();

  try {
    if (preset.presetId === 'codex') {
      const configPath = join(home, '.codex', 'config.toml');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let content = readFileSync(configPath, 'utf8');
      // Remove [otel] section and everything until the next section or EOF
      content = content.replace(/\n?\[otel\][^\[]*/, '');
      writeFileSync(configPath, content.trimEnd() + '\n');
      return { success: true, message: 'Removed [otel] section from ~/.codex/config.toml' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(home, '.gemini', 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      delete settings.telemetry;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: 'Removed telemetry section from ~/.gemini/settings.json' };
    }

    if (preset.presetId === 'opencode') {
      try { unlinkSync(join(opencodePluginDir, 'clideck-bridge.js')); } catch {}
      try { unlinkSync(join(opencodePluginDir, 'termix-bridge.js')); } catch {}
      return { success: true, message: 'Removed bridge plugin' };
    }

    return { success: false, message: `No removal logic for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getConfig() { return cfg; }

module.exports = { onConnection, getConfig };

const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { join, dirname } = require('path');
const os = require('os');
const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const { listDirs, binName, defaultShell } = require('./utils');
for (const p of presets) if (p.presetId === 'shell') p.command = defaultShell;
const transcript = require('./transcript');

let cfg = config.load();

function onConnection(ws) {
  sessions.clients.add(ws);

  ws.send(JSON.stringify({ type: 'config', config: cfg }));
  ws.send(JSON.stringify({ type: 'themes', themes }));
  ws.send(JSON.stringify({ type: 'presets', presets }));
  ws.send(JSON.stringify({ type: 'sessions', list: sessions.list() }));
  ws.send(JSON.stringify({ type: 'sessions.resumable', list: sessions.getResumable() }));
  ws.send(JSON.stringify({ type: 'transcript.cache', cache: transcript.getCache() }));
  sessions.sendBuffers(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create':          sessions.create(msg, ws, cfg); break;
      case 'session.resume':  sessions.resume(msg, ws, cfg); break;
      case 'session.restart': console.log('[handler] session.restart', msg.id); sessions.restart(msg, ws, cfg); break;
      case 'input':           sessions.input(msg); break;
      case 'resize':          sessions.resize(msg); break;
      case 'rename':          sessions.rename(msg); break;
      case 'close':           sessions.close(msg); break;

      case 'config.get':
        ws.send(JSON.stringify({ type: 'config', config: cfg }));
        break;

      case 'config.update':
        cfg = { ...cfg, ...msg.config };
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: cfg });
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
        sessions.broadcast({ type: 'config', config: cfg });
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
        sessions.broadcast({ type: 'config', config: cfg });
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

      case 'project.delete': {
        const proj = cfg.projects?.find(p => p.id === msg.id);
        if (!proj) break;
        // Kill all sessions in this project
        for (const s of sessions.list()) {
          if (s.projectId === msg.id) sessions.close({ id: s.id });
        }
        cfg.projects = cfg.projects.filter(p => p.id !== msg.id);
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: cfg });
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

    return { success: false, message: `No removal logic for ${preset.presetId}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function getConfig() { return cfg; }

module.exports = { onConnection, getConfig };

const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } = require('fs');
const { join, dirname } = require('path');
const { execFileSync, execFile } = require('child_process');
const os = require('os');
const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = JSON.parse(readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const { listDirs, binName, defaultShell, validateCwdPath } = require('./utils');
const { PORT, BOOT_ID } = require('./runtime');
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
  return (commands || []).filter(cmd => !cmd.presetId || allowedPresetIds.has(cmd.presetId));
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
  try { return parseVersion(execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })); } catch {}
  try { return parseVersion(execFileSync(bin, ['-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })); } catch {}
  return '';
}

function checkRemoteUpdate(ws) {
  const now = Date.now();
  if (remoteUpdateCache && now - remoteUpdateCheckedAt < REMOTE_UPDATE_INTERVAL) {
    ws.send(JSON.stringify({ type: 'remote.update', checked: true, ...remoteUpdateCache }));
    return;
  }
  const shellOpt = process.platform === 'win32';
  require('child_process').execFile('npm', ['list', '-g', 'clideck-remote', '--json', '--depth=0'], { shell: shellOpt, windowsHide: true, timeout: 10000 }, (err, stdout) => {
    let installed;
    try { installed = JSON.parse(stdout).dependencies['clideck-remote'].version; }
    catch {
      ws.send(JSON.stringify({ type: 'remote.update', available: false, checked: false }));
      return;
    }
    require('child_process').execFile('npm', ['view', 'clideck-remote', 'version'], { shell: shellOpt, windowsHide: true, timeout: 10000 }, (err2, stdout2) => {
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
      execFileSync(whichCmd, [bin], { stdio: 'ignore', windowsHide: true });
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
    return !!hookPath && existsSync(hookPath);
  }));
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

function codexConfigLooksHealthy(content, port) {
  if (!content.includes('[otel]') || !content.includes(`localhost:${port}`)) return false;
  const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
  if (!codexHooksFeatureEnabled(content)) return false;
  if (!codexHooksHealthy(os.homedir(), codexHookPath, port)) return false;
  const notifyLine = content.match(/^\s*notify\s*=\s*\[(.+)\]\s*$/m)?.[1] || '';
  if (!notifyLine.includes('notify-helper')) return false;
  const quoted = [...notifyLine.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const helperPath = quoted.find(v => v.includes('notify-helper'));
  return !!helperPath && existsSync(helperPath);
}

function detectTelemetryConfig(c) {
  const home = os.homedir();
  const port = String(PORT);
  let changed = false;
  const attemptedRepairs = new Set();

  for (let pass = 0; pass < 2; pass++) {
    let repairedAny = false;
    for (const cmd of c.commands || []) {
      const bin = binName(cmd.command);
      const preset = presets.find(p => binName(p.command) === bin);
      if (!preset) continue;
      let detected = false;
      let reason = '';
      if (preset.presetId === 'claude-code') {
        try {
          const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          detected = hasExistingHook(hooks.UserPromptSubmit, 'claude-hook.js', 'start')
                  && hasExistingHook(hooks.Stop, 'claude-hook.js', 'stop')
                  && hasExistingHook(hooks.StopFailure, 'claude-hook.js', 'stop')
                  && hasExistingHook(hooks.PreToolUse, 'claude-hook.js', 'menu')
                  && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && hasExistingHook([h], 'claude-hook.js', 'idle'));
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'codex') {
        try {
          const content = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
          detected = codexConfigLooksHealthy(content, port);
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'gemini-cli') {
        try {
          const s = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
          const hooks = s.hooks || {};
          detected = hasExistingHook(hooks.BeforeAgent, 'gemini-hook.js', 'start')
                  && hasExistingHook(hooks.AfterAgent, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.SessionEnd, 'gemini-hook.js', 'stop')
                  && hasExistingHook(hooks.BeforeTool, 'gemini-hook.js', 'menu');
          if (!detected) reason = 'Needs re-patch';
        } catch {}
      } else if (preset.presetId === 'opencode') {
        detected = existsSync(join(opencodePluginDir, 'clideck-bridge.js')) || existsSync(join(opencodePluginDir, 'termix-bridge.js'));
        if (!detected) reason = 'Needs re-patch';
      } else { continue; }
      if (preset.available && preset.minVersion && !preset.versionOk) {
        detected = false;
        reason = `Update required (${preset.minVersion}+)`;
      } else if (!detected && cmd.telemetryEnabled && preset.telemetryAutoSetup && preset.available && preset.versionOk && !attemptedRepairs.has(preset.presetId)) {
        attemptedRepairs.add(preset.presetId);
        const repaired = applyTelemetryConfig(preset);
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
  return { ...cfg, commands: filterClientCommands(cfg.commands), pluginsDir: plugins.PLUGINS_DIR, version: appVersion, overlayVersion: overlayVersionInfo(), bootId: BOOT_ID, hostDir: process.env.CLIDECK_HOST_DIR || null };
}

// Overlay version data shipped to the browser: timestamp renders as the
// connection-badge text, sha + message + dirty surface as a hover tooltip.
// Returns null when the image wasn't stamped (defaults are `dev`), so the
// upstream clideck app stays clean of overlay-specific rendering when run
// without the clideck-docker-lance overlay.
function overlayVersionInfo() {
  const ts = process.env.OVERLAY_TIMESTAMP;
  if (!ts || ts === 'dev') return null;
  return {
    timestamp: ts,
    sha:       process.env.OVERLAY_SHA     || null,
    message:   process.env.OVERLAY_MESSAGE || null,
    dirty:     process.env.OVERLAY_DIRTY === '1',
  };
}

function remoteCliEnv() {
  return { ...process.env, CLIDECK_PORT: String(PORT) };
}

function onConnection(ws) {
  sessions.clients.add(ws);

  // Heartbeat: detect dead TCP sockets (NAT/proxy/laptop-sleep) so the server
  // doesn't keep streaming output into the void and so the client gets a
  // prompt close event to trigger reconnect. Also responds to app-level
  // {type:'ping'} from the client with {type:'pong'} so the client can
  // detect a hung server even when the OS still considers the TCP socket
  // alive.
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== 1) return;
    if (!ws.isAlive) {
      try { ws.terminate(); } catch { /* noop */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* noop */ }
  }, 20000);
  ws.on('close', () => clearInterval(heartbeat));

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
      case 'ping':
        try { ws.send(JSON.stringify({ type: 'pong', t: msg.t })); } catch { /* noop */ }
        break;
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
          transcript.updateAgentCandidate(msg.id, sess.presetId, msg.lines);
          if (!sess.working && sess._finalizeOnIdle) {
            sess._finalizeOnIdle = false;
            // if (sess.presetId === 'claude-code') {
            //   console.log(`[claude] terminal.buffer finalize session=${msg.id.slice(0,8)} lines=${msg.lines?.length || 0}`);
            // }
            transcript.commitAgentCandidate(msg.id, sess.presetId);
          }
          let choices = require('./transcript').detectMenu(msg.lines, sess.presetId);
          // Codex: only trust menu detection if last OTEL event was response.completed
          if (choices && sess.presetId === 'codex') {
            const last = require('./telemetry-receiver').getLastEvent(msg.id);
            if (!last.startsWith('codex.sse_event:response.completed')) {
              // console.log(`[codex] menu rejected — lastEvent=${last} session=${msg.id.slice(0,8)}`);
              choices = null;
            } else {
              // console.log(`[codex] menu accepted session=${msg.id.slice(0,8)}`);
            }
          }
          if (choices && sess.presetId === 'claude-code' && msg.menuVersion && (sess._menuConsumedVersion || 0) >= msg.menuVersion) {
            // console.log(`[claude] menu ignored stale version=${msg.menuVersion} consumed=${sess._menuConsumedVersion || 0} session=${msg.id.slice(0,8)}`);
            choices = null;
          }
          let key = choices ? JSON.stringify(choices) : '';
          // Claude can keep rendering the same approval menu briefly after Enter.
          // Once that exact menu was approved, ignore repeated detections of the
          // same signature until the next real turn starts.
          if (choices && sess.presetId === 'claude-code' && key === (sess._resolvedMenuKey || '')) {
            // console.log(`[claude] menu ignored resolved key session=${msg.id.slice(0,8)}`);
            choices = null;
            key = '';
          }
          // Auto-approve: send Enter immediately when menu detected
          if (choices && plugins.shouldAutoApproveMenu(msg.id)) {
            setTimeout(() => sessions.input({ id: msg.id, data: '\r' }), 500);
          }
          if (key !== (sess._menuKey || '')) {
            sess._menuKey = key;
            sessions.broadcast({ type: 'session.menu', id: msg.id, choices: choices || [] });
            if (choices) {
              if (sess.presetId === 'claude-code' && msg.menuVersion) sess._menuActiveVersion = msg.menuVersion;
              // if (sess.presetId === 'claude-code') {
              //   console.log(`[claude] menu detected session=${msg.id.slice(0,8)} choices=${choices.length} version=${msg.menuVersion || 0}`);
              // }
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
      case 'resumable.rename': sessions.renameResumable(msg, cfg); break;
      case 'close':           sessions.close(msg, cfg); break;

      case 'config.get':
        ws.send(JSON.stringify({ type: 'config', config: configForClient() }));
        break;

      case 'checkAvailability':
        checkAvailability();
        if (detectTelemetryConfig(cfg)) config.save(cfg);
        ws.send(JSON.stringify({ type: 'presets', presets: clientPresets() }));
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
        const result = applyTelemetryConfig(preset);
        for (const cmd of cfg.commands) {
          if (binName(cmd.command) === binName(preset.command)) {
            cmd.telemetryEnabled = result.success;
            cmd.telemetryStatus = result.success ? { ok: true } : { ok: false, error: result.message };
            // Enable the agent when setup succeeds, disable if it fails
            if (result.success) cmd.enabled = true;
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

      // Drag-to-reorder dropped a session into a new sidebar position.
      // Client sends the full id sequence post-drop; server reorders the
      // in-memory Map + resumable list and broadcasts so other clients sync.
      case 'session.reorder':
        sessions.reorderSessions(msg.ids, cfg);
        break;

      // User-triggered pause — same end state as a natural PTY exit but
      // initiated from the active-session context menu. Refuses cleanly
      // when no sessionToken has been captured (silent degrade to delete
      // would lose user data and is explicitly forbidden by the SPEC).
      case 'session.pause':
        sessions.pause(msg, ws, cfg);
        break;

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
        const cmd = process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
        execFile(cmd, [proj.path], { shell: process.platform === 'win32', windowsHide: true }, (err) => {
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

      case 'dirs.listSubdirs': {
        // Bulk project import: list immediate subdirectories of `path` and
        // flag the ones already used by a configured project so the client
        // can dim them in the picker. Comparison is case-insensitive on
        // Windows (drive letters and the like).
        const target = msg.path || cfg.defaultPath;
        const result = listDirs(target, !!msg.showHidden);
        const names = Array.isArray(result) ? result : [];
        const error = result.error || undefined;
        const norm = (p) => {
          if (!p) return '';
          let s = p.replace(/\//g, '\\').replace(/\\+$/, '');
          if (process.platform === 'win32') s = s.toLowerCase();
          return s;
        };
        const projectPaths = new Set(
          (cfg.projects || [])
            .map(p => norm(p?.path))
            .filter(Boolean),
        );
        const sep = target.includes('\\') ? '\\' : '/';
        const base = target.endsWith(sep) ? target : target + sep;
        const entries = names.map(name => {
          const full = base + name;
          return { name, full, isProject: projectPaths.has(norm(full)) };
        });
        ws.send(JSON.stringify({ type: 'dirs.subdirs', path: target, entries, error }));
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

      // Phase 10 creator pre-flight check. Pure stat — no side effects.
      // Client uses { exists, isDirectory, error } to decide whether to
      // pop the create-or-cancel modal. ENOENT is the "doesn't exist
      // yet" branch and is mapped to error:null so the client can
      // distinguish it from a true error (EACCES/EPERM).
      case 'check-cwd': {
        const raw = typeof msg.path === 'string' ? msg.path : '';
        const trimmed = raw.trim();
        if (!trimmed) {
          ws.send(JSON.stringify({
            type: 'check-cwd-result',
            path: msg.path,
            exists: false,
            isDirectory: false,
            error: 'invalid-input',
          }));
          break;
        }
        try {
          // require('fs').statSync (rather than the top-of-module
          // destructured binding) so unit tests can spy on the EACCES
          // branch. Behaviour is identical; require caches.
          const s = require('fs').statSync(trimmed);
          ws.send(JSON.stringify({
            type: 'check-cwd-result',
            path: trimmed,
            exists: true,
            isDirectory: s.isDirectory(),
            error: null,
          }));
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            // Doesn't exist — normal branch, not an error. Includes
            // dangling symlinks (statSync follows the link and raises
            // ENOENT on the missing target). Per SPEC §61.
            ws.send(JSON.stringify({
              type: 'check-cwd-result',
              path: trimmed,
              exists: false,
              isDirectory: false,
              error: null,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'check-cwd-result',
              path: trimmed,
              exists: false,
              isDirectory: false,
              error: e && e.code ? e.code : (e && e.message) || 'error',
            }));
          }
        }
        break;
      }

      // Phase 10 creator pre-flight mkdir. Recursive, gated by the
      // validateCwdPath helper so a typo'd or malicious client can't
      // ask the server to mkdirSync '..\\escape'. R2: on mkdirSync
      // failure (EACCES, EPERM, EROFS) the handler returns ok:false
      // and the client surfaces a one-button error modal — NO session
      // is created.
      case 'mkdir-cwd': {
        const v = validateCwdPath(msg.path);
        if (!v.ok) {
          ws.send(JSON.stringify({
            type: 'mkdir-cwd-result',
            path: msg.path,
            ok: false,
            error: v.error,
          }));
          break;
        }
        try {
          // Call through require('fs').mkdirSync (rather than the
          // destructured top-of-module binding) so unit tests can spy on
          // it without also intercepting the data-dir bootstrap mkdir in
          // paths.js. This is purely a testability seam — behaviour is
          // identical because require caches.
          require('fs').mkdirSync(v.path, { recursive: true });
          ws.send(JSON.stringify({
            type: 'mkdir-cwd-result',
            path: v.path,
            ok: true,
            error: null,
          }));
        } catch (e) {
          ws.send(JSON.stringify({
            type: 'mkdir-cwd-result',
            path: v.path,
            ok: false,
            error: e && e.code ? e.code : (e && e.message) || 'error',
          }));
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
        try { execFileSync(whichCmd, ['clideck-remote'], { stdio: 'ignore', windowsHide: true }); installed = true; } catch {}
        if (!installed) { ws.send(JSON.stringify({ type: 'remote.status', installed: false })); break; }
        require('child_process').execFile('clideck-remote', ['status', '--json'], { timeout: 5000, shell: process.platform === 'win32', windowsHide: true, env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.status', installed: true, ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.status', installed: true })); }
        });
        checkRemoteUpdate(ws);
        break;
      }

      case 'remote.pair': {
        require('child_process').execFile('clideck-remote', ['pair', '--json'], { timeout: 15000, shell: process.platform === 'win32', windowsHide: true, env: remoteCliEnv() }, (err, stdout) => {
          if (err) { ws.send(JSON.stringify({ type: 'remote.error', error: err.message })); return; }
          try { ws.send(JSON.stringify({ type: 'remote.paired', ...JSON.parse(stdout) })); }
          catch { ws.send(JSON.stringify({ type: 'remote.error', error: 'Invalid response from clideck-remote' })); }
        });
        break;
      }

      case 'remote.unpair': {
        require('child_process').execFile('clideck-remote', ['unpair', '--json'], { timeout: 5000, shell: process.platform === 'win32', windowsHide: true, env: remoteCliEnv() }, (err) => {
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

      case 'remote.install': {
        const proc = require('child_process').spawn('npm', ['install', '-g', 'clideck-remote'], {
          shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
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
  const port = String(PORT);
  const home = os.homedir();

  try {
    if (preset.presetId === 'claude-code') {
      const configPath = join(home, '.claude', 'settings.json');
      let settings = {};
      if (existsSync(configPath)) {
        try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      }
      const hooks = settings.hooks || {};
      const hookCmd = (route) => `"${process.execPath.replace(/\\/g, '/')}" "${join(__dirname, 'bin', 'claude-hook.js').replace(/\\/g, '/')}" ${port} ${route}`;
      const clideckHook = (route) => ({ hooks: [{ type: 'command', command: hookCmd(route) }] });
      const hasClideck = (arr, path) => arr?.some(h => h.hooks?.some(x => x.command === hookCmd(path)));
      if (hasClideck(hooks.UserPromptSubmit, 'start') && hasClideck(hooks.Stop, 'stop') && hasClideck(hooks.StopFailure, 'stop') && hasClideck(hooks.PreToolUse, 'menu') && hooks.Notification?.some(h => h.matcher === 'idle_prompt' && h.hooks?.some(x => x.command === hookCmd('idle')))) {
        return { success: true, message: 'Already configured' };
      }
      const stripOld = (arr) => (arr || []).filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
      hooks.UserPromptSubmit = stripOld(hooks.UserPromptSubmit);
      hooks.Stop = stripOld(hooks.Stop);
      hooks.StopFailure = stripOld(hooks.StopFailure);
      hooks.PreToolUse = stripOld(hooks.PreToolUse);
      hooks.Notification = stripOld(hooks.Notification);
      if (!hasClideck(hooks.UserPromptSubmit, 'start')) hooks.UserPromptSubmit = [...(hooks.UserPromptSubmit || []), clideckHook('start')];
      if (!hasClideck(hooks.Stop, 'stop')) hooks.Stop = [...(hooks.Stop || []), clideckHook('stop')];
      if (!hasClideck(hooks.StopFailure, 'stop')) hooks.StopFailure = [...(hooks.StopFailure || []), clideckHook('stop')];
      if (!hasClideck(hooks.Notification, 'idle')) hooks.Notification = [...(hooks.Notification || []), { matcher: 'idle_prompt', ...clideckHook('idle') }];
      if (!hasClideck(hooks.PreToolUse, 'menu')) hooks.PreToolUse = [...(hooks.PreToolUse || []), clideckHook('menu')];
      settings.hooks = hooks;
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: 'Added hooks to ~/.claude/settings.json — Claude will ask for one-time approval' };
    }

    if (preset.presetId === 'codex') {
      const configPath = join(home, '.codex', 'config.toml');
      let content = '';
      if (existsSync(configPath)) content = readFileSync(configPath, 'utf8');
      const hasOtel = content.includes('[otel]');
      const hasCurrentOtel = content.includes(`localhost:${port}`);
      const hasNotify = /^\s*notify\s*=.*notify-helper/m.test(content);
      const hasWrongOtel = content.includes(`endpoint = "http://localhost:${port}/v1/logs"`);
      const codexHookPath = join(__dirname, 'bin', 'codex-hook.js').replace(/\\/g, '/');
      const hasHooks = codexHooksFeatureEnabled(content) && codexHooksHealthy(home, codexHookPath, port);
      if (hasOtel && hasCurrentOtel && hasNotify && !hasWrongOtel && hasHooks) {
        return { success: true, message: 'Already configured' };
      }
      const notifyHelperPath = join(__dirname, 'bin', 'notify-helper.js').replace(/\\/g, '/');
      const nextContent = upsertCodexConfig(content, process.execPath.replace(/\\/g, '/'), notifyHelperPath, port);
      const valid = validateCodexConfigToml(nextContent);
      if (!valid.ok) return { success: false, message: valid.error };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, nextContent);
      installCodexHooks(home, process.execPath.replace(/\\/g, '/'), codexHookPath, port);
      return { success: true, message: 'Configured. If Codex shows "2 hooks need review", open /hooks and approve the CliDeck hooks once.' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(home, '.gemini', 'settings.json');
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
      return { success: true, message: 'Added CliDeck hooks to ~/.gemini/settings.json' };
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
    if (preset.presetId === 'claude-code') {
      const configPath = join(home, '.claude', 'settings.json');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let settings = {};
      try { settings = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
      if (!settings.hooks) return { success: true, message: 'No hooks to remove' };
      for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PreToolUse']) {
        const arr = settings.hooks[event];
        if (!arr) continue;
        settings.hooks[event] = arr.filter(h => !h.hooks?.some(x => x.url?.includes('/hook/claude/') || x.command?.includes('claude-hook.js')));
        if (!settings.hooks[event].length) delete settings.hooks[event];
      }
      if (!Object.keys(settings.hooks).length) delete settings.hooks;
      writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n');
      return { success: true, message: 'Removed CliDeck hooks from ~/.claude/settings.json' };
    }

    if (preset.presetId === 'codex') {
      const configPath = join(home, '.codex', 'config.toml');
      if (!existsSync(configPath)) return { success: true, message: 'No config file to clean' };
      let content = readFileSync(configPath, 'utf8');
      content = content.replace(/\n?\[otel\][^\[]*/, '');
      content = content.replace(/\n?notify\s*=\s*\[.*?notify-helper.*?\]\s*/g, '');
      content = content.replace(/\n?codex_hooks\s*=\s*(true|false)\s*/g, '\n');
      writeFileSync(configPath, content.trimEnd() + '\n');
      removeCodexHooks(home);
      return { success: true, message: 'Removed otel + CliDeck hooks from ~/.codex config' };
    }

    if (preset.presetId === 'gemini-cli') {
      const configPath = join(home, '.gemini', 'settings.json');
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
      return { success: true, message: 'Removed CliDeck hooks from ~/.gemini/settings.json' };
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

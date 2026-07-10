const pty = require('node-pty');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');
const { parseCommand, resolveValidDir, defaultShell, binName } = require('./utils');
const activity = require('./activity');
const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const opencodeBridge = require('./opencode-bridge');
const piBridge = require('./pi-bridge');
const plugins = require('./plugin-loader');
const { presetForCommand } = require('./preset-utils');
const { lineageOf } = require('./lineage');
const { stripAnsi } = require('./ansi-utils');
const { withCliDeckGuide } = require('./agent-session-guide');

const THEMES = require('./themes');
const MAX_BUFFER = 2 * 1024 * 1024;
const { PORT, localUrl } = require('./runtime');
const PRESETS = JSON.parse(require('fs').readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
for (const p of PRESETS) if (p.presetId === 'shell') p.command = defaultShell;
const { DATA_DIR } = require('./paths');
const SAVED_PATH = join(DATA_DIR, 'sessions.json');
const sessions = new Map();
const clients = new Set();

// Persisted sessions awaiting resume (loaded on startup, cleared as they're resumed)
let resumable = [];

const broadcastListeners = [];

function addBroadcastListener(fn) {
  broadcastListeners.push(fn);
  return () => {
    const idx = broadcastListeners.indexOf(fn);
    if (idx >= 0) broadcastListeners.splice(idx, 1);
  };
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(raw);
  if (msg.type === 'session.status') {
    // Status broadcasts currently also apply the local state transition. This is
    // intentional for now but couples transport with session state; if this area
    // changes, split it into a dedicated setSessionStatus() transition first.
    const s = sessions.get(msg.id);
    if (s) {
      s.working = !!msg.working;
      if (msg.working && msg.source === 'hook') {
        s._resolvedMenuKey = '';
      }
      // Codex approval flows can pause on a menu and then continue into a normal
      // reply; keep idle finalization enabled there so the completed post-menu
      // answer is not lost. Other agents still suppress transcript finalization on menu.
      s._finalizeOnIdle = !msg.working && msg.source !== 'esc' && (msg.source !== 'menu' || s.presetId === 'codex');
      // if (s.presetId === 'claude-code') {
      //   console.log(`[claude] broadcast status session=${msg.id.slice(0,8)} working=${!!msg.working} source=${msg.source} finalizeOnIdle=${!!s._finalizeOnIdle}`);
      // }
      // if (s.presetId === 'codex') console.log(`[codex] status session=${msg.id.slice(0,8)} working=${!!msg.working} source=${msg.source}`);
    }
    plugins.notifyStatus(msg.id, msg.working, msg.source);
  }
  for (const fn of broadcastListeners) try { fn(msg); } catch {}
}

// --- Spawn a PTY and wire up a session ---

function matchPreset(cmd) { return presetForCommand(cmd, PRESETS); }

function commandEnv(cmd) {
  const env = {};
  if (!cmd?.env || typeof cmd.env !== 'object' || Array.isArray(cmd.env)) return env;
  for (const [key, value] of Object.entries(cmd.env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(value ?? '');
  }
  return env;
}

function buildTelemetryEnv(id, cmd) {
  const preset = matchPreset(cmd);
  const telemetryEnabled = cmd.telemetryEnabled ?? (preset?.presetId === 'claude-code');
  const env = { CLIDECK_SESSION_ID: id, CLIDECK_PORT: String(PORT), CLIDECK_URL: localUrl() };
  if (!preset?.telemetryEnv || !telemetryEnabled) return env;
  for (const [k, v] of Object.entries(preset.telemetryEnv)) {
    env[k] = v.replace('{{port}}', String(PORT));
  }
  // Tag events with our session ID so the receiver can map them
  const existing = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  env.OTEL_RESOURCE_ATTRIBUTES = (existing ? existing + ',' : '') + `clideck.session_id=${id}`;
  return env;
}

function isLightTheme(themeId) {
  const t = THEMES.find(th => th.id === themeId);
  if (!t) return false;
  const bg = t.theme.background;
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function spawnSession(id, cmd, parts, cwd, name, themeId, commandId, savedToken, projectId, cols, rows) {
  const preset = matchPreset(cmd);
  const launchParts = withCliDeckGuide(parts, preset?.presetId);
  const telemetryEnv = buildTelemetryEnv(id, cmd);
  const colorEnv = isLightTheme(themeId) ? { COLORFGBG: '0;15' } : { COLORFGBG: '15;0' };
  const extraEnv = commandEnv(cmd);
  let term;
  try {
    term = pty.spawn(launchParts[0], launchParts.slice(1), {
      name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd,
      env: { ...process.env, ...extraEnv, ...telemetryEnv, ...colorEnv },
    });
  } catch (e) {
    return e;
  }

  const sessionIdRe = cmd.sessionIdPattern ? new RegExp(cmd.sessionIdPattern, 'i') : null;
  const session = { name, themeId, commandId, cwd, pty: term, chunks: [], chunksSize: 0, sessionToken: savedToken || null, projectId: projectId || null, presetId: preset?.presetId || 'shell', working: undefined };
  sessions.set(id, session);
  transcript.setFinalizeOnIdle(id, ['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi', 'clideck-agent'].includes(lineageOf(session.presetId)) ? session.presetId : null);

  // Always watch telemetry-backed agents so OTLP fallback matching can attach
  // early events to this session even when the agent omits clideck.session_id.
  // The receiver itself decides whether to surface a setup prompt.
  if (preset?.telemetryEnv) telemetry.watchSession(id, binName(cmd.command));
  if (preset?.bridge === 'opencode') opencodeBridge.watchSession(id, cwd);

  term.onData((data) => {
    session.chunks.push(data);
    session.chunksSize += data.length;
    while (session.chunksSize > MAX_BUFFER && session.chunks.length > 1) {
      session.chunksSize -= session.chunks.shift().length;
    }
    // Capture session ID from output
    if (sessionIdRe && !session.sessionToken) {
      const joined = session.chunks.join('');
      const match = joined.match(sessionIdRe) || stripAnsi(joined).match(sessionIdRe);
      if (match) {
        session.sessionToken = match[1];
        console.log(`Session ${id.slice(0, 8)}: captured token via output regex: ${match[1].slice(0, 12)}…`);
      }
    }
    activity.trackOut(id, data);
    transcript.trackOutput(id, data);
    plugins.notifyOutput(id, data);
    broadcast({ type: 'output', id, data });
  });

  term.onExit(() => {
    // Skip cleanup if this PTY was replaced by a restart
    const s = sessions.get(id);
    if (s?.pty !== term) return;
    activity.clear(id);
    telemetry.clear(id);
    opencodeBridge.clear(id);
    piBridge.clear(id);
    plugins.clearStatus(id);
    // If resumable and token captured, move to resumable list (keep transcript for search)
    if (!s.ephemeral && cmd.canResume && cmd.resumeCommand && s.sessionToken) {
      resumable.push({
        id, name: s.name, commandId: s.commandId, presetId: s.presetId || 'shell', cwd: s.cwd,
        themeId: s.themeId, sessionToken: s.sessionToken, projectId: s.projectId, muted: !!s.muted,
        lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
        savedAt: new Date().toISOString(),
      });
      console.log(`Session ${id.slice(0, 8)}: moved to resumable on exit (token: ${s.sessionToken.slice(0, 12)}…)`);
    } else {
      transcript.clear(id);
    }
    sessions.delete(id);
    broadcast({ type: 'closed', id });
    if (!s.ephemeral && cmd.canResume && s.sessionToken) {
      broadcast({ type: 'sessions.resumable', list: getResumable() });
    }
  });

  return null;
}

// --- Create a new session ---

function normalizeSessionName(name) {
  return String(name || '').trim().toLowerCase();
}

function sessionNameExistsInScope(name, projectId, exceptId = null) {
  const wanted = normalizeSessionName(name);
  if (!wanted) return false;
  const scope = projectId || null;
  for (const [id, s] of sessions) {
    if (id === exceptId) continue;
    if ((s.projectId || null) !== scope) continue;
    if (normalizeSessionName(s.name) === wanted) return true;
  }
  return false;
}

function create(msg, ws, cfg) {
  const id = crypto.randomUUID();
  const cmd = cfg.commands.find(c => c.id === msg.commandId)
    || cfg.commands[0]
    || { label: 'Shell', command: defaultShell };
  const parts = parseCommand(cmd.command);
  const cwd = resolveValidDir(msg.cwd || cmd.defaultPath || cfg.defaultPath);
  const themeId = msg.themeId || cfg.defaultTheme || 'default';
  const name = msg.name || cmd.label;

  const projectId = msg.projectId || null;
  if (sessionNameExistsInScope(name, projectId)) {
    ws.send(JSON.stringify({ type: 'error', message: `Agent name "${name}" is already taken in this project.` }));
    return;
  }
  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id, null, projectId, msg.cols, msg.rows);
  if (err) {
    console.error('Failed to spawn pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  const createdPresetId = matchPreset(cmd)?.presetId || 'shell';
  const installId = msg.installId || undefined;
  broadcast({ type: 'created', id, name, themeId, commandId: cmd.id, presetId: createdPresetId, projectId, installId });

  // Immediate setup notification if config not detected
  const preset = matchPreset(cmd);
  if (preset && (preset.telemetrySetup || preset.bridge) && !(cmd.telemetryEnabled && cmd.telemetryStatus?.ok)) {
    broadcast({ type: 'session.needsSetup', id });
  }
}

// --- Programmatic session creation (for plugins / internal use) ---

function createProgrammatic(opts, cfg) {
  const id = crypto.randomUUID();
  let cmd;
  if (opts.presetId) cmd = cfg.commands.find(c => c.presetId === opts.presetId);
  else if (opts.commandId) cmd = cfg.commands.find(c => c.id === opts.commandId);
  if (!cmd) return { error: 'Command not found' };

  const parts = parseCommand(cmd.command);
  const cwd = resolveValidDir(opts.cwd || cmd.defaultPath || cfg.defaultPath);
  const themeId = opts.themeId || cfg.defaultTheme || 'default';
  const name = opts.name || cmd.label;
  const projectId = opts.projectId || null;
  if (sessionNameExistsInScope(name, projectId)) {
    return { error: `Agent name "${name}" is already taken in this project.` };
  }

  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id, null, projectId);
  if (err) return { error: err.message };

  const s = sessions.get(id);
  if (s && opts.ephemeral) s.ephemeral = true;

  const presetId = matchPreset(cmd)?.presetId || 'shell';
  broadcast({ type: 'created', id, name, themeId, commandId: cmd.id, presetId, projectId });
  return { id };
}

// --- Resume a persisted session ---

function resume(msg, ws, cfg) {
  const saved = resumable.find(s => s.id === msg.id);
  if (!saved) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found in resumable list' }));
    return;
  }

  const cmd = cfg.commands.find(c => c.id === saved.commandId);
  if (!cmd || !cmd.canResume || !cmd.resumeCommand) {
    ws.send(JSON.stringify({ type: 'error', message: 'Command does not support resume' }));
    return;
  }

  // Build the resume command, substituting {{sessionId}} if present
  let resumeStr = cmd.resumeCommand;
  if (resumeStr.includes('{{sessionId}}')) {
    if (!saved.sessionToken) {
      ws.send(JSON.stringify({ type: 'error', message: 'No session ID captured — cannot resume' }));
      return;
    }
    resumeStr = resumeStr.replace('{{sessionId}}', saved.sessionToken);
  }

  const parts = parseCommand(resumeStr);
  const cwd = resolveValidDir(saved.cwd || cfg.defaultPath);
  const id = saved.id;

  const err = spawnSession(id, cmd, parts, cwd, saved.name, saved.themeId || saved.profileId || 'default', saved.commandId, saved.sessionToken, saved.projectId);
  if (err) {
    console.error('Failed to resume pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  const s = sessions.get(id);
  if (s) {
    if (saved.muted) s.muted = true;
  }

  // Remove from resumable list and notify all clients
  resumable = resumable.filter(s => s.id !== id);
  broadcast({ type: 'sessions.resumable', list: getResumable(cfg) });

  const resumePresetId = matchPreset(cmd)?.presetId || saved.presetId || 'shell';
  broadcast({ type: 'created', id, name: saved.name, themeId: saved.themeId || saved.profileId || 'default', commandId: saved.commandId, presetId: resumePresetId, projectId: saved.projectId || null, muted: !!saved.muted, resumed: true, lastPreview: saved.lastPreview || '' });
}

// --- Standard session operations ---

function writeSessionInput(id, data) {
  transcript.trackInput(id, data);
  sessions.get(id)?.pty.write(data);
}

function input(msg) {
  const data = plugins.transformInput(msg.id, msg.data);
  activity.trackIn(msg.id, data.length);
  const s = sessions.get(msg.id);
  if (!s) return;
  // Menu choice selected → back to working (Enter or digit keys only)
  if (s._menuKey && !s.working && (data === '\r' || /^[1-9]$/.test(data))) {
    // Approval/denial menus can leave a transient tool line as the latest
    // parsed candidate; clear it before the next real reply starts.
    transcript.clearAgentCandidate(msg.id);
    s.pty.write(data);
    // Autopilot may need to retry the same approval menu if the first Enter
    // does not actually take, so only suppress same-menu re-detection for
    // manual flows.
    if (!plugins.shouldAutoApproveMenu(msg.id)) s._resolvedMenuKey = s._menuKey;
    if (s._menuActiveVersion) s._menuConsumedVersion = s._menuActiveVersion;
    const menuStartsWork = s._menuStartsWork !== false;
    s._menuKey = '';
    s._menuStartsWork = undefined;
    broadcast({ type: 'session.menu', id: msg.id, choices: [] });
    if (menuStartsWork) {
      broadcast({ type: 'session.status', id: msg.id, working: true, source: 'menu-input' });
    }
    return;
  }
  writeSessionInput(msg.id, data);
  if (data === '\x1b' && s.working) {
    transcript.clearAgentCandidate(msg.id);
    broadcast({ type: 'session.status', id: msg.id, working: false, source: 'esc' });
  }
}
function resize(msg) { sessions.get(msg.id)?.pty.resize(msg.cols, msg.rows); }

function rename(msg) {
  const s = sessions.get(msg.id);
  if (!s) return;
  const name = String(msg.name || '').trim();
  if (!name) return;
  if (sessionNameExistsInScope(name, s.projectId, msg.id)) {
    broadcast({ type: 'session.renameRejected', id: msg.id, name: s.name, message: `Agent name "${name}" is already taken in this project.` });
    return;
  }
  s.name = name;
  broadcast({ type: 'renamed', id: msg.id, name });
}

function setTheme(id, themeId) {
  const s = sessions.get(id);
  if (s) { s.themeId = themeId; return true; }
  return false;
}

function setMute(id, muted) {
  const s = sessions.get(id);
  if (s) { s.muted = !!muted; return true; }
  return false;
}

function close(msg, cfg) {
  const s = sessions.get(msg.id);
  if (s) { s.pty.kill(); telemetry.clear(msg.id); opencodeBridge.clear(msg.id); piBridge.clear(msg.id); transcript.clear(msg.id); plugins.clearStatus(msg.id); sessions.delete(msg.id); broadcast({ type: 'closed', id: msg.id }); }
  // Also remove from resumable list if present
  const before = resumable.length;
  resumable = resumable.filter(r => r.id !== msg.id);
  if (resumable.length !== before) broadcast({ type: 'sessions.resumable', list: getResumable(cfg) });
}

// Restart a live session's PTY with updated env (e.g. after polarity flip).
// Uses resume command if available, otherwise re-launches the original command.
function restart(msg, ws, cfg) {
  const id = msg.id;
  // console.log('[restart] received', { id, themeId: msg.themeId });
  const s = sessions.get(id);
  if (!s) { ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'not found' })); return; }
  const cmd = cfg.commands.find(c => c.id === s.commandId);
  if (!cmd) { ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'command missing' })); return; }

  const themeId = msg.themeId || s.themeId;
  const canResume = cmd.canResume && cmd.resumeCommand && s.sessionToken;

  let parts;
  if (canResume) {
    parts = parseCommand(cmd.resumeCommand.replace('{{sessionId}}', s.sessionToken));
  } else {
    parts = parseCommand(cmd.command);
  }

  const savedToken = s.sessionToken;
  const { name, cwd, commandId, projectId, muted, lastPreview, lastActivityAt } = s;

  activity.clear(id);
  telemetry.clear(id);
  opencodeBridge.clear(id);
  piBridge.clear(id);
  transcript.clear(id);

  s.pty.kill();
  sessions.delete(id);

  const err = spawnSession(id, cmd, parts, cwd, name, themeId, commandId, savedToken, projectId, msg.cols, msg.rows);
  if (err) {
    console.error('[restart] spawn failed:', err.message);
    broadcast({ type: 'session.restarted', id, error: err.message });
    return;
  }

  const next = sessions.get(id);
  if (next) {
    next.muted = !!muted;
    next.lastPreview = lastPreview || '';
    next.lastActivityAt = lastActivityAt || null;
  }

  broadcast({ type: 'session.restarted', id, resumed: !!canResume });
}

function list() {
  return [...sessions].map(([id, s]) => ({
    id, name: s.name, themeId: s.themeId, commandId: s.commandId, presetId: s.presetId || 'shell', projectId: s.projectId, muted: !!s.muted,
    working: !!s.working,
    // Last preview text for sidebar display on reconnect
    lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
    menu: s._menuKey ? JSON.parse(s._menuKey) : undefined,
  }));
}

// Store the latest preview text from the client (persisted by auto-save)
function setPreview(id, text, timestamp) {
  const s = sessions.get(id);
  if (!s) return false;
  s.lastPreview = (text || '').slice(0, 200);
  s.lastActivityAt = timestamp || new Date().toISOString();
  return true;
}

function setProject(id, projectId) {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  const nextProjectId = projectId || null;
  if (sessionNameExistsInScope(s.name, nextProjectId, id)) {
    return { ok: false, error: `Agent name "${s.name}" is already taken in this project.` };
  }
  s.projectId = nextProjectId;
  return { ok: true };
}

function getResumable(cfg) {
  if (!cfg) return resumable;
  return resumable.map(s => {
    if (s.presetId) return s;
    const cmd = (cfg.commands || []).find(c => c.id === s.commandId);
    if (!cmd) return { ...s, presetId: 'shell' };
    const preset = matchPreset(cmd);
    return { ...s, presetId: preset?.presetId || 'shell' };
  });
}

function sendBuffers(ws) {
  for (const [id, s] of sessions) {
    if (s.chunks.length) {
      const data = s.chunks.join('');
      ws.send(JSON.stringify({ type: 'output', id, data, replay: true }));
      continue;
    }
    if (['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi', 'clideck-agent'].includes(lineageOf(s.presetId)) && !s.working) {
      const text = transcript.getReplayText(id, s.presetId);
      if (text) {
        ws.send(JSON.stringify({ type: 'session.history', id, text, replay: true }));
        continue;
      }
    }
  }
}

// --- Persistence: save on shutdown, load on startup ---

function saveSessions(cfg) {
  // Only persist live sessions that are actually resumable
  let skippedNoToken = 0;
  const live = [...sessions]
    .filter(([, s]) => {
      if (s.ephemeral) return false;
      const cmd = cfg.commands.find(c => c.id === s.commandId);
      if (!cmd?.canResume || !cmd.resumeCommand) return false;
      // If resume needs a session ID, we must have captured one
      if (cmd.resumeCommand.includes('{{sessionId}}') && !s.sessionToken) {
        skippedNoToken++;
        return false;
      }
      return true;
    })
    .map(([id, s]) => ({
      id, name: s.name, commandId: s.commandId, presetId: s.presetId || 'shell', cwd: s.cwd,
      themeId: s.themeId, sessionToken: s.sessionToken, projectId: s.projectId, muted: !!s.muted,
      lastPreview: s.lastPreview || '', lastActivityAt: s.lastActivityAt || null,
      savedAt: new Date().toISOString(),
    }));

  // Merge with still-pending resumables that were never resumed
  const liveIds = new Set(live.map(s => s.id));
  const pending = resumable.filter(s => !liveIds.has(s.id));
  const data = [...live, ...pending];

  writeFileSync(SAVED_PATH, JSON.stringify(data, null, 2));
  if (skippedNoToken > 0 && skippedNoToken !== lastSkippedNoTokenWarn) {
    console.warn(`Skipped ${skippedNoToken} resumable session(s): no session token captured`);
  }
  lastSkippedNoTokenWarn = skippedNoToken || null;
  return data.length;
}

function loadSessions() {
  if (!existsSync(SAVED_PATH)) return;
  try {
    resumable = JSON.parse(readFileSync(SAVED_PATH, 'utf8'));
    console.log(`Loaded ${resumable.length} resumable session(s)`);
  } catch { resumable = []; }
}

let autoSaveInterval = null;
let getConfigFn = null;
let lastSkippedNoTokenWarn = null;

function startAutoSave(getConfig) {
  getConfigFn = getConfig;
  if (autoSaveInterval) return;
  autoSaveInterval = setInterval(() => {
    const cfg = getConfigFn?.();
    if (!cfg) return;
    try {
      const count = saveSessions(cfg);
      if (count > 0) broadcast({ type: 'sessions.saved' });
    } catch (e) {
      console.error('Auto-save failed:', e.message);
    }
  }, 30000);
}

function shutdown(cfg) {
  clearInterval(autoSaveInterval);
  saveSessions(cfg);
  for (const [, s] of sessions) {
    try { s.pty.kill(); } catch {}
  }
}

module.exports = {
  clients, broadcast, addBroadcastListener, getSessions: () => sessions,
  create, createProgrammatic, resume, restart, input, resize, rename, setTheme, setMute, setProject, setPreview, close,
  list, getResumable, sendBuffers,
  loadSessions, startAutoSave, shutdown,
};

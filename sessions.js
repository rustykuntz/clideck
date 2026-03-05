const pty = require('node-pty');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { parseCommand, resolveValidDir } = require('./utils');
const stats = require('./stats'); // TEMPORARY
const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const opencodeBridge = require('./opencode-bridge');

const THEMES = require('./themes');
const MAX_BUFFER = 200 * 1024;
const PORT = 4000;
const PRESETS = JSON.parse(require('fs').readFileSync(join(__dirname, 'agent-presets.json'), 'utf8'));
const SAVED_PATH = join(__dirname, 'sessions.json');
const sessions = new Map();
const clients = new Set();

// Persisted sessions awaiting resume (loaded on startup, cleared as they're resumed)
let resumable = [];

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const c of clients) c.send(raw);
}

// --- Spawn a PTY and wire up a session ---

function buildTelemetryEnv(id, cmd) {
  const bin = cmd.command.split('/').pop().split(' ')[0];
  const preset = PRESETS.find(p => p.command.split('/').pop() === bin);
  if (!preset?.telemetryEnv || !cmd.telemetryEnabled) return {};
  const env = {};
  for (const [k, v] of Object.entries(preset.telemetryEnv)) {
    env[k] = v.replace('{{port}}', String(PORT));
  }
  // Tag events with our session ID so the receiver can map them
  const existing = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  env.OTEL_RESOURCE_ATTRIBUTES = (existing ? existing + ',' : '') + `termix.session_id=${id}`;
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
  const telemetryEnv = buildTelemetryEnv(id, cmd);
  const colorEnv = isLightTheme(themeId) ? { COLORFGBG: '0;15' } : { COLORFGBG: '15;0' };
  let term;
  try {
    term = pty.spawn(parts[0], parts.slice(1), {
      name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd,
      env: { ...process.env, ...telemetryEnv, ...colorEnv },
    });
  } catch (e) {
    return e;
  }

  const sessionIdRe = cmd.sessionIdPattern ? new RegExp(cmd.sessionIdPattern) : null;
  const session = { name, themeId, commandId, cwd, pty: term, chunks: [], chunksSize: 0, sessionToken: savedToken || null, projectId: projectId || null };
  sessions.set(id, session);

  // Watch for telemetry — if config isn't set up, frontend will prompt
  const bin = cmd.command.split('/').pop().split(' ')[0];
  const preset = PRESETS.find(p => p.command.split('/').pop() === bin);
  if (preset?.telemetrySetup && cmd.telemetryEnabled) telemetry.watchSession(id);
  if (preset?.bridge === 'opencode') opencodeBridge.watchSession(id, cwd);

  term.onData((data) => {
    session.chunks.push(data);
    session.chunksSize += data.length;
    while (session.chunksSize > MAX_BUFFER && session.chunks.length > 1) {
      session.chunksSize -= session.chunks.shift().length;
    }
    // Capture session ID from output
    if (sessionIdRe && !session.sessionToken) {
      const match = session.chunks.join('').match(sessionIdRe);
      if (match) session.sessionToken = match[1];
    }
    stats.trackOut(id, data); // TEMPORARY
    transcript.trackOutput(id, data);
    broadcast({ type: 'output', id, data });
  });

  term.onExit(() => {
    // Skip cleanup if this PTY was replaced by a restart
    if (sessions.get(id)?.pty !== term) return;
    stats.clear(id); // TEMPORARY
    telemetry.clear(id);
    opencodeBridge.clear(id);
    transcript.clear(id);
    sessions.delete(id);
    broadcast({ type: 'closed', id });
  });

  return null;
}

// --- Create a new session ---

function create(msg, ws, cfg) {
  const id = crypto.randomUUID();
  const cmd = cfg.commands.find(c => c.id === msg.commandId)
    || cfg.commands[0]
    || { label: 'Shell', command: '/bin/zsh' };
  const parts = parseCommand(cmd.command);
  const cwd = resolveValidDir(msg.cwd || cmd.defaultPath || cfg.defaultPath);
  const themeId = msg.themeId || cfg.defaultTheme || 'default';
  const name = msg.name || cmd.label;

  const projectId = msg.projectId || null;
  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id, null, projectId, msg.cols, msg.rows);
  if (err) {
    console.error('Failed to spawn pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  broadcast({ type: 'created', id, name, themeId, commandId: cmd.id, projectId });
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

  // Remove from resumable list and notify all clients
  resumable = resumable.filter(s => s.id !== id);
  broadcast({ type: 'sessions.resumable', list: resumable });

  broadcast({ type: 'created', id, name: saved.name, themeId: saved.themeId || saved.profileId || 'default', commandId: saved.commandId, projectId: saved.projectId || null, resumed: true });
}

// --- Standard session operations ---

function input(msg) {
  stats.trackIn(msg.id, msg.data.length); // TEMPORARY
  transcript.trackInput(msg.id, msg.data);
  sessions.get(msg.id)?.pty.write(msg.data);
}
function resize(msg) { sessions.get(msg.id)?.pty.resize(msg.cols, msg.rows); }

function rename(msg) {
  const s = sessions.get(msg.id);
  if (s) { s.name = msg.name; broadcast({ type: 'renamed', id: msg.id, name: msg.name }); }
}

function setTheme(id, themeId) {
  const s = sessions.get(id);
  if (s) { s.themeId = themeId; return true; }
  return false;
}

function close(msg) {
  const s = sessions.get(msg.id);
  if (s) { s.pty.kill(); telemetry.clear(msg.id); transcript.clear(msg.id); sessions.delete(msg.id); broadcast({ type: 'closed', id: msg.id }); }
  // Also remove from resumable list if present
  const before = resumable.length;
  resumable = resumable.filter(r => r.id !== msg.id);
  if (resumable.length !== before) broadcast({ type: 'sessions.resumable', list: resumable });
}

// Restart a live session's PTY with updated env (e.g. after polarity flip).
// Uses resume command if available, otherwise re-launches the original command.
function restart(msg, ws, cfg) {
  const id = msg.id;
  console.log('[restart] received', { id, themeId: msg.themeId });
  const s = sessions.get(id);
  if (!s) { console.log('[restart] FAIL: session not found'); ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'not found' })); return; }
  const cmd = cfg.commands.find(c => c.id === s.commandId);
  if (!cmd) { console.log('[restart] FAIL: command not found, commandId=', s.commandId); ws.send(JSON.stringify({ type: 'session.restarted', id, error: 'command missing' })); return; }

  const themeId = msg.themeId || s.themeId;
  const canResume = cmd.canResume && cmd.resumeCommand && s.sessionToken;
  console.log('[restart] canResume=', canResume, 'token=', s.sessionToken?.slice(0,12), 'cmd=', cmd.command);

  let parts;
  if (canResume) {
    parts = parseCommand(cmd.resumeCommand.replace('{{sessionId}}', s.sessionToken));
  } else {
    parts = parseCommand(cmd.command);
  }
  console.log('[restart] parts=', parts);

  const savedToken = s.sessionToken;
  const { name, cwd, commandId, projectId } = s;

  stats.clear(id);
  telemetry.clear(id);
  opencodeBridge.clear(id);
  transcript.clear(id);

  console.log('[restart] killing old pty');
  s.pty.kill();
  sessions.delete(id);

  console.log('[restart] spawning new pty, themeId=', themeId, 'cwd=', cwd);
  const err = spawnSession(id, cmd, parts, cwd, name, themeId, commandId, savedToken, projectId, msg.cols, msg.rows);
  if (err) {
    console.error('[restart] FAIL spawn:', err.message);
    broadcast({ type: 'session.restarted', id, error: err.message });
    return;
  }

  console.log('[restart] SUCCESS, broadcasting session.restarted');
  broadcast({ type: 'session.restarted', id, resumed: !!canResume });
}

function list() {
  return [...sessions].map(([id, s]) => ({
    id, name: s.name, themeId: s.themeId, commandId: s.commandId, projectId: s.projectId,
  }));
}

function setProject(id, projectId) {
  const s = sessions.get(id);
  if (s) { s.projectId = projectId || null; return true; }
  return false;
}

function getResumable() { return resumable; }

function sendBuffers(ws) {
  for (const [id, s] of sessions) {
    if (s.chunks.length) ws.send(JSON.stringify({ type: 'output', id, data: s.chunks.join('') }));
  }
}

// --- Persistence: save on shutdown, load on startup ---

function saveSessions(cfg) {
  // Only persist live sessions that are actually resumable
  const live = [...sessions]
    .filter(([, s]) => {
      const cmd = cfg.commands.find(c => c.id === s.commandId);
      if (!cmd?.canResume || !cmd.resumeCommand) return false;
      // If resume needs a session ID, we must have captured one
      if (cmd.resumeCommand.includes('{{sessionId}}') && !s.sessionToken) return false;
      return true;
    })
    .map(([id, s]) => ({
      id, name: s.name, commandId: s.commandId, cwd: s.cwd,
      themeId: s.themeId, sessionToken: s.sessionToken, projectId: s.projectId,
      savedAt: new Date().toISOString(),
    }));

  // Merge with still-pending resumables that were never resumed
  const liveIds = new Set(live.map(s => s.id));
  const pending = resumable.filter(s => !liveIds.has(s.id));
  const data = [...live, ...pending];

  writeFileSync(SAVED_PATH, JSON.stringify(data, null, 2));
  console.log(`Saved ${data.length} session(s) to ${SAVED_PATH} (${live.length} live, ${pending.length} pending)`);
}

function loadSessions() {
  if (!existsSync(SAVED_PATH)) return;
  try {
    resumable = JSON.parse(readFileSync(SAVED_PATH, 'utf8'));
    console.log(`Loaded ${resumable.length} resumable session(s)`);
  } catch { resumable = []; }
}

function shutdown(cfg) {
  saveSessions(cfg);
  for (const [, s] of sessions) {
    try { s.pty.kill(); } catch {}
  }
}

module.exports = {
  clients, broadcast, getSessions: () => sessions,
  create, resume, restart, input, resize, rename, setTheme, setProject, close,
  list, getResumable, sendBuffers,
  loadSessions, shutdown,
};

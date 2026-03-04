const pty = require('node-pty');
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');
const { parseCommand, resolveValidDir } = require('./utils');
const stats = require('./stats'); // TEMPORARY
const transcript = require('./transcript');

const MAX_BUFFER = 200 * 1024;
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

function spawnSession(id, cmd, parts, cwd, name, themeId, commandId) {
  let term;
  try {
    term = pty.spawn(parts[0], parts.slice(1), {
      name: 'xterm-256color', cols: 80, rows: 24, cwd, env: process.env,
    });
  } catch (e) {
    return e;
  }

  const sessionIdRe = cmd.sessionIdPattern ? new RegExp(cmd.sessionIdPattern) : null;
  const session = { name, themeId, commandId, cwd, pty: term, buffer: '', sessionToken: null };
  sessions.set(id, session);

  term.onData((data) => {
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER);
    // Capture session ID from output
    if (sessionIdRe && !session.sessionToken) {
      const match = session.buffer.match(sessionIdRe);
      if (match) session.sessionToken = match[1];
    }
    stats.trackOut(id, data); // TEMPORARY
    transcript.trackOutput(id, data);
    broadcast({ type: 'output', id, data });
  });

  term.onExit(() => {
    stats.clear(id); // TEMPORARY
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

  const err = spawnSession(id, cmd, parts, cwd, name, themeId, cmd.id);
  if (err) {
    console.error('Failed to spawn pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  broadcast({ type: 'created', id, name, themeId, commandId: cmd.id });
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

  const err = spawnSession(id, cmd, parts, cwd, saved.name, saved.themeId || saved.profileId || 'default', saved.commandId);
  if (err) {
    console.error('Failed to resume pty:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return;
  }

  // Remove from resumable list and notify all clients
  resumable = resumable.filter(s => s.id !== id);
  broadcast({ type: 'sessions.resumable', list: resumable });

  broadcast({ type: 'created', id, name: saved.name, themeId: saved.themeId || saved.profileId || 'default', commandId: saved.commandId, resumed: true });
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
  if (s) { s.pty.kill(); transcript.clear(msg.id); sessions.delete(msg.id); broadcast({ type: 'closed', id: msg.id }); }
}

function list() {
  return [...sessions].map(([id, s]) => ({
    id, name: s.name, themeId: s.themeId, commandId: s.commandId,
  }));
}

function getResumable() { return resumable; }

function sendBuffers(ws) {
  for (const [id, s] of sessions) {
    if (s.buffer) ws.send(JSON.stringify({ type: 'output', id, data: s.buffer }));
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
      themeId: s.themeId, sessionToken: s.sessionToken,
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
  create, resume, input, resize, rename, setTheme, close,
  list, getResumable, sendBuffers,
  loadSessions, shutdown,
};

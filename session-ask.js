const transcript = require('./transcript');
const { sendJson, isSameHost, sameProject, projectName, sessionAddress } = require('./http-util');

const MAX_BODY = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error('Request too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function jsonError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizeTimeout(ms) {
  const n = Number(ms || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(n), MAX_TIMEOUT_MS);
}

function parseScopedTarget(target) {
  const text = String(target || '').trim();
  if (!text.startsWith('@')) return null;
  const slash = text.indexOf('/');
  if (slash <= 1 || slash === text.length - 1) {
    throw jsonError('Cross-project target must use @project/session');
  }
  return { project: text.slice(1, slash).trim(), session: text.slice(slash + 1).trim() };
}

function resolveProject(projects, nameOrId) {
  const text = String(nameOrId || '').trim();
  const byId = projects.filter(p => p.id === text);
  if (byId.length === 1) return byId[0];
  const exact = projects.filter(p => p.name === text);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw jsonError(`Multiple projects named "${text}". Use the project id.`, 409);
  const lower = text.toLowerCase();
  const insensitive = projects.filter(p => String(p.name || '').toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];
  if (insensitive.length > 1) throw jsonError(`Multiple projects named "${text}". Use the project id.`, 409);
  throw jsonError(`No project named "${text}"`, 404);
}

function findInProject(candidates, target, projectLabel) {
  const byId = candidates.filter(([id]) => id === target);
  if (byId.length === 1) return byId[0];

  const exact = candidates.filter(([, s]) => s.name === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw jsonError(`Multiple sessions named "${target}" in ${projectLabel}. Use the session id.`);

  const lower = target.toLowerCase();
  const insensitive = candidates.filter(([, s]) => String(s.name || '').toLowerCase() === lower);
  if (insensitive.length === 1) return insensitive[0];
  if (insensitive.length > 1) throw jsonError(`Multiple sessions named "${target}" in ${projectLabel}. Use the session id.`);
  throw jsonError(`No session named "${target}" in ${projectLabel}`, 404);
}

function findTarget(sessions, callerId, caller, target, cfg = {}) {
  const trimmed = String(target || '').trim();
  if (!trimmed) throw jsonError('Target session is required');
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  const scoped = parseScopedTarget(trimmed);

  if (scoped) {
    const project = resolveProject(projects, scoped.project);
    const projectSessions = [...sessions]
      .filter(([id, s]) => id !== callerId && (s.projectId || null) === project.id);
    return findInProject(projectSessions, scoped.session, `project "${project.name || project.id}"`);
  }

  const byId = sessions.get(trimmed);
  if (byId) {
    if (trimmed === callerId) throw jsonError('Target session cannot be the caller session');
    if (!sameProject(caller, byId)) throw jsonError('Target session is not in the caller project', 404);
    return [trimmed, byId];
  }

  const sameProjectSessions = [...sessions]
    .filter(([id, s]) => id !== callerId && sameProject(caller, s));
  return findInProject(sameProjectSessions, trimmed, `project "${projectName(projects, caller.projectId)}"`);
}

function latestAgentTextSince(sessionId, sinceTs) {
  const entries = transcript.getEntriesSince(sessionId, sinceTs)
    .filter(e => e.role === 'agent' && String(e.text || '').trim());
  return entries.length ? entries[entries.length - 1].text : '';
}

function previewTextSince(session, sinceTs) {
  const text = String(session?.lastPreview || '').trim();
  if (!text) return '';
  const ts = Date.parse(session.lastActivityAt || '');
  return Number.isFinite(ts) && ts >= sinceTs ? text : '';
}

function latestAnswerTextSince(sessions, sessionId, sinceTs) {
  return latestAgentTextSince(sessionId, sinceTs)
    || previewTextSince(sessions.get(sessionId), sinceTs);
}

function askSubmitDelay(message) {
  const len = String(message || '').length;
  return Math.min(2500, Math.max(500, 300 + Math.ceil(len / 80) * 100));
}

function submitAskInput(sessionsApi, targetId, message) {
  const sessions = sessionsApi.getSessions();
  const timers = [];

  const payload = `\n\n${message}`;
  sessionsApi.input({ id: targetId, data: `${BRACKETED_PASTE_START}${payload}${BRACKETED_PASTE_END}` });
  const delay = askSubmitDelay(message);
  timers.push(setTimeout(() => sessionsApi.input({ id: targetId, data: '\r' }), delay));
  timers.push(setTimeout(() => {
    const target = sessions.get(targetId);
    if (target && !target.working) sessionsApi.input({ id: targetId, data: '\r' });
  }, delay + 1500));

  return () => timers.forEach(clearTimeout);
}

function waitForAnswer({ sessionsApi, targetId, sinceTs, timeoutMs }) {
  const sessions = sessionsApi.getSessions();
  const target = sessions.get(targetId);
  let sawWorking = !!target?.working;
  let settled = false;
  let quietTimer = null;
  let removeListener = null;
  let timeout = null;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (quietTimer) clearTimeout(quietTimer);
      if (removeListener) removeListener();
    };
    const finish = () => {
      if (settled) return;
      const response = latestAnswerTextSince(sessions, targetId, sinceTs);
      if (!response) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(jsonError('Timed out waiting for target session response', 504));
    }, timeoutMs);

    removeListener = sessionsApi.addBroadcastListener((msg) => {
      if (msg.id !== targetId) return;
      if (msg.type === 'session.status') {
        if (msg.working) {
          sawWorking = true;
          return;
        }
        if (sawWorking) {
          sessionsApi.broadcast({ type: 'terminal.capture', id: targetId });
          setTimeout(finish, 700);
        }
      } else if (msg.type === 'output') {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if (!sessions.get(targetId)?.working) {
            sessionsApi.broadcast({ type: 'terminal.capture', id: targetId });
            setTimeout(finish, 700);
          }
        }, 2500);
      }
    });
  });
}

async function askSession(payload, sessionsApi, cfg = {}) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(payload.callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) throw jsonError('Caller session is not active', 404);

  const [targetId, target] = findTarget(sessions, callerId, caller, payload.target, cfg);
  if (target.working) {
    throw jsonError(`Target agent "${target.name}" is busy right now. CliDeck ask only sends to idle agents and does not queue requests because the context can become stale. If you need this specific agent, try again later or set a reminder to retry. You can also ask another idle agent.`, 409);
  }

  const message = String(payload.message || '').trim();
  if (!message) throw jsonError('Message is required');

  const timeoutMs = normalizeTimeout(payload.timeoutMs);
  const sinceTs = Date.now();
  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  const injected = `[CliDeck ask from ${sessionAddress(caller, callerId, projects)}]\n\n${message}`;

  console.log(`[ask] ${caller.name || callerId.slice(0, 8)} -> ${target.name || targetId.slice(0, 8)} (${timeoutMs}ms timeout)`);
  const cancelSubmit = submitAskInput(sessionsApi, targetId, injected);
  sessionsApi.broadcast({
    type: 'session.dispatch',
    fromId: callerId,
    fromName: caller.name || callerId.slice(0, 8),
    toId: targetId,
    toName: target.name || targetId.slice(0, 8),
  });

  const response = await waitForAnswer({ sessionsApi, targetId, sinceTs, timeoutMs }).finally(cancelSubmit);
  console.log(`[ask] completed ${target.name || targetId.slice(0, 8)} -> ${caller.name || callerId.slice(0, 8)}`);
  return { targetSessionId: targetId, targetName: target.name, response };
}

async function handleHttp(req, res, sessionsApi, getConfig = () => ({})) {
  try {
    if (!isSameHost(req)) throw jsonError('CliDeck ask only accepts same-host requests', 403);
    const payload = await readJson(req);
    const result = await askSession(payload, sessionsApi, getConfig() || {});
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck ask failed' });
  }
}

module.exports = { handleHttp, askSession, askSubmitDelay };

const { sendJson, isSameHost, sameProject, projectName, sessionAddress } = require('./http-util');

function agentRow(id, s, callerId, projects) {
  const project = projectName(projects, s.projectId);
  return {
    id,
    name: s.name || id.slice(0, 8),
    preset: s.presetId || 'shell',
    projectId: s.projectId || null,
    project,
    address: sessionAddress(s, id, projects),
    working: !!s.working,
    lastPreview: s.lastPreview || '',
    lastActivityAt: s.lastActivityAt || null,
    caller: id === callerId,
  };
}

function listProjectAgents(callerSessionId, sessionsApi, cfg = {}, all = false) {
  const sessions = sessionsApi.getSessions();
  const callerId = String(callerSessionId || '').trim();
  const caller = sessions.get(callerId);
  if (!caller) {
    const err = new Error('Caller session is not active');
    err.status = 404;
    throw err;
  }

  const projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  return [...sessions]
    .filter(([, s]) => all || sameProject(caller, s))
    .map(([id, s]) => agentRow(id, s, callerId, projects));
}

async function handleHttp(req, res, sessionsApi, getConfig = () => ({})) {
  try {
    if (!isSameHost(req)) {
      const err = new Error('CliDeck agents only accepts same-host requests');
      err.status = 403;
      throw err;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    const agents = listProjectAgents(url.searchParams.get('callerSessionId'), sessionsApi, getConfig() || {}, all);
    sendJson(res, 200, { agents });
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message || 'CliDeck agents failed' });
  }
}

module.exports = { handleHttp, listProjectAgents };

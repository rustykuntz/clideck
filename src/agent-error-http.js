const { isLoopbackAddress, isAllowedWebSocketOrigin } = require('./security');
const { resolveLiveCaller } = require('./session-agents');

async function handleAgentErrorHttp(server, req, res, readJson, sendJson) {
  if (String(req.url || '').split('?')[0] !== '/api/session/errors') return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, server.host)
    || req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { error: 'Error notices are local to CliDeck.' }); return true;
  }
  try {
    if (!['GET', 'POST'].includes(req.method)) { sendJson(res, 405, { error: 'Method not allowed.' }); return true; }
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { error: 'Expected JSON.' }); return true;
    }
    const body = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams)
      : await readJson(req, 4096);
    if (!body || Object.keys(body).some(key => !['callerSessionId', ...(req.method === 'POST' ? ['action', 'id'] : [])].includes(key))) throw Error('Invalid error notice request.');
    const caller = resolveLiveCaller(server.persistence.list(), server.sessions, body.callerSessionId);
    if (!caller) throw Error('Inspect error notices from inside a live CliDeck session.');
    if (req.method === 'POST') {
      if (body.action !== 'acknowledge' || typeof body.id !== 'string' || body.id.length > 300) throw Error('Use acknowledge with an uncertain notice ID.');
      if (body.id.startsWith('plugin-request:')) await server.pluginRequests.acknowledgeForSession(caller.entry.id, body.id);
      else server.agentErrors.acknowledge(caller.entry.id, body.id);
    }
    sendJson(res, 200, { notices: [...server.agentErrors.list(caller.entry.id), ...(server.pluginRequests?.errorNotices(caller.entry.id) || [])],
      ...(server.agentErrors.error && { error: server.agentErrors.error }) });
  } catch (error) { sendJson(res, 400, { error: error.message }); }
  return true;
}

module.exports = { handleAgentErrorHttp };

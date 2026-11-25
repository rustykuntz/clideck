const { isLoopbackAddress, isAllowedWebSocketOrigin } = require('./security');
const { resolveAskTarget } = require('./ask');
const { resolveLiveCaller } = require('./session-agents');
const { getProvider } = require('./providers');

function scheduledAt(value, now = Date.now()) {
  if (typeof value !== 'string') throw new Error('Use --at HH:mm or an ISO date with a timezone offset.');
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const [hour, minute] = value.split(':').map(Number), next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (+next <= now) next.setDate(next.getDate() + 1);
    return +next;
  }
  const at = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(at) || at <= now) {
    throw new Error('Use a future ISO date with timezone offset, or HH:mm in the engine’s local timezone.');
  }
  return at;
}

// The HTTP shell stays outside the scheduler, so runner/delivery tests need no
// network or providers. A local CLI and the browser use the same control API.
async function handleMonitorHttp(server, req, res, readJson, sendJson) {
  const pathname = String(req.url || '').split('?')[0];
  if (pathname !== '/api/monitors') return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, server.host)
    || req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { error: 'Monitor controls are local to CliDeck.' }); return true;
  }
  if (req.method === 'GET') { sendJson(res, 200, server.monitors.snapshot()); return true; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }); return true; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    sendJson(res, 415, { error: 'Expected JSON.' }); return true;
  }
  try {
    const body = await readJson(req, 12 * 1024);
    if (body.action === 'read') {
      const caller = resolveLiveCaller(server.persistence.list(), server.sessions, body.callerSessionId);
      if (!caller || typeof body.id !== 'string' || !body.id) throw new Error('Read an event by ID from its receiving session.');
      sendJson(res, 200, server.monitors.readEvent(body.id, caller.entry.id));
    } else if (body.action === 'add') {
      if (Object.keys(body).some(k => !['action', 'callerSessionId', 'target', 'name', 'command', 'everyMs', 'at', 'once', 'resumeSession', 'mode', 'cwd'].includes(k))) throw new Error('Unknown monitor option.');
      if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Monitors currently support macOS and Linux.');
      const entries = server.persistence.list();
      const caller = resolveLiveCaller(entries, server.sessions, body.callerSessionId);
      if (!caller) throw new Error('Create monitors from inside a live CliDeck session.');
      const resolved = body.target ? resolveAskTarget(entries, String(body.target), {
        caller: caller.entry, projects: server.configStore.get().projects || [],
      }) : { entry: caller.entry };
      if (resolved.error) throw new Error(resolved.message || resolved.error);
      if (!getProvider(resolved.entry.provider)?.supportsAsk) throw new Error('Target agent does not support monitor messages.');
      const at = body.at === undefined ? null : scheduledAt(body.at);
      const id = server.monitors.add({
        name: body.name || String(body.command || '').slice(0, 100), command: body.command,
        sessionId: resolved.entry.id, creatorSessionId: caller.entry.id, cwd: body.cwd || caller.entry.cwd,
        mode: body.mode ?? 'change', everyMs: body.everyMs ?? (at === null ? 300_000 : null), at,
        once: body.once ?? false, resumeSession: body.resumeSession ?? false,
      });
      sendJson(res, 200, { ...server.monitors.snapshot(), id });
    } else sendJson(res, 200, await server.monitors.act(body));
  } catch (error) { sendJson(res, 400, { error: error.message }); }
  return true;
}

module.exports = { handleMonitorHttp, scheduledAt };

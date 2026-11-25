const { isAllowedWebSocketOrigin, isLoopbackAddress } = require('./security');
const { resolveLiveCaller } = require('./session-agents');

const MAX_COMMAND_INPUT = 1024 * 1024;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('request too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

class PluginHttp {
  constructor(options) {
    this.host = options.host;
    this.manager = options.manager;
    this.persistence = options.persistence;
    this.sessions = options.sessions;
  }

  allowed(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return false;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return false;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' }); return false;
    }
    return true;
  }

  async handle(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/plugins') {
      if (this.allowed(req, res)) sendJson(res, 200, { ok: true,
        plugins: new URL(req.url, 'http://localhost').searchParams.get('all') === 'true' ? this.manager.catalog() : this.manager.snapshot() });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/plugins/info') {
      if (this.allowed(req, res)) {
        try { sendJson(res, 200, { ok: true, plugin: this.manager.info(new URL(req.url, 'http://localhost').searchParams.get('id') || '') }); }
        catch (error) { sendJson(res, 404, { ok: false, error: 'unknown_plugin', message: error.message }); }
      }
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/plugins/manage') {
      if (this.allowed(req, res)) await this.manage(req, res);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/plugins/install') {
      await this.install(req, res);
      return true;
    }
    const command = req.method === 'POST'
      ? pathname.match(/^\/api\/plugins\/command\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/)
      : null;
    if (!command) return false;
    await this.runCommand(req, res, command[1], command[2]);
    return true;
  }

  async install(req, res) {
    if (!this.allowed(req, res)) return;
    let request;
    try { request = await readJson(req); } catch { request = null; }
    if (!request || Object.keys(request).some(key => !['path', 'id'].includes(key))
      || (request.id !== undefined ? typeof request.id !== 'string' || request.path !== undefined
        : typeof request.path !== 'string' || !request.path.trim() || request.path.length > 4096 || request.path.includes('\0'))) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', message: 'Provide a plugin folder.' });
      return;
    }
    try {
      const record = request.id !== undefined ? await this.manager.installAvailable(request.id) : await this.manager.install(request.path);
      sendJson(res, 200, { ok: true, pluginId: record.manifest.id });
    } catch (error) {
      sendJson(res, error.code === 'plugin_exists' ? 409 : 400, {
        ok: false,
        error: error.code || 'plugin_install_failed',
        message: error.message,
      });
    }
  }

  async manage(req, res) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { ok: false, error: 'Expected JSON.' }); return;
    }
    try {
      const request = await readJson(req);
      if (!request || typeof request.id !== 'string' || !['enable', 'disable', 'settings'].includes(request.action)
        || Object.keys(request).some(key => !['action', 'id', ...(request.action === 'settings' ? ['values'] : [])].includes(key))) throw Error('Invalid plugin control.');
      const changed = request.action === 'settings'
        ? await this.manager.updateSettings(request.id, request.values)
        : await this.manager.setEnabled(request.id, request.action === 'enable');
      if (!changed) throw Error('Plugin not found or settings are invalid.');
      const plugin = this.manager.snapshot().find(row => row.id === request.id);
      if (request.action === 'enable' && plugin.status !== 'ready') throw Error(plugin.error || 'Plugin did not become ready.');
      sendJson(res, 200, { ok: true, plugin });
    } catch (error) { sendJson(res, 400, { ok: false, error: 'plugin_control_failed', message: error.message }); }
  }

  async runCommand(req, res, pluginId, command) {
    if (!this.allowed(req, res)) return;
    let request;
    try { request = await readJson(req, MAX_COMMAND_INPUT + 64 * 1024); } catch { request = null; }
    const valid = request && typeof request === 'object' && !Array.isArray(request)
      && typeof request.sessionId === 'string' && request.sessionId.length <= 200
      && Array.isArray(request.args) && request.args.length <= 100
      && request.args.every((arg) => typeof arg === 'string'
        && arg.length <= 16 * 1024 && !arg.includes('\0'))
      && typeof request.stdin === 'string' && request.stdin.length <= MAX_COMMAND_INPUT;
    if (!valid) {
      sendJson(res, 400, { ok: false, error: 'invalid_request', message: 'Invalid plugin command.' });
      return;
    }
    const caller = resolveLiveCaller(this.persistence.list(), this.sessions, request.sessionId);
    if (!caller) {
      sendJson(res, 404, {
        ok: false, error: 'unknown_session', message: 'Caller session is not active.',
      });
      return;
    }
    try {
      const result = await this.manager.runCommand(pluginId, command, {
        sessionId: caller.entry.id,
        args: request.args,
        stdin: request.stdin,
        timeoutMs: request.timeoutMs,
      });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, error.code === 'plugin_command_unavailable' ? 404 : 500, {
        ok: false,
        error: error.code || 'plugin_command_failed',
        message: error.message,
      });
    }
  }
}

module.exports = { PluginHttp };

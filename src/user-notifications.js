const fs = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { isLoopbackAddress, isAllowedWebSocketOrigin } = require('./security');
const { resolveLiveCaller } = require('./session-agents');

class UserNotifications {
  constructor({ dataDir, onChange = () => {}, now = Date.now }) {
    this.path = join(dataDir, 'notifications.json'); this.onChange = onChange; this.now = now;
    this.rows = []; this.error = ''; this.limits = new Map();
    try {
      if (fs.statSync(this.path).size > 1024 * 1024) throw Error('too large');
      const value = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!Array.isArray(value) || value.length > 50 || value.some(row => typeof row.id !== 'string'
        || typeof row.sessionId !== 'string' || typeof row.text !== 'string' || row.text.length > 4000 || !Number.isSafeInteger(row.at))) throw Error('invalid');
      this.rows = value;
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Cannot read notifications.json. The original file was left unchanged.'; }
  }
  snapshot() { return { notices: this.rows.map(row => ({ ...row })), ...(this.error && { error: this.error }) }; }
  save() {
    if (this.error) throw Error(this.error);
    const path = `${this.path}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(path, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.rows)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(path, this.path);
    } catch {
      try { fs.unlinkSync(path); } catch {}
      this.error = 'Cannot save the notification. Check CliDeck storage before trying again.'; throw Error(this.error);
    }
    this.onChange({ type: 'user.notices', ...this.snapshot() });
  }
  add(sessionId, text, origin = 'agent') {
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw Error('Use a short notification of 1–4000 characters.');
    const times = (this.limits.get(sessionId) || []).filter(at => at > this.now() - 60_000);
    if (times.length >= 10) throw Error('This session sent 10 notifications in a minute. Combine updates and try later.');
    this.limits.set(sessionId, [...times, this.now()]);
    const row = { id: randomUUID(), sessionId, text: text.trim(), at: this.now(), origin };
    this.rows.push(row); this.rows = this.rows.slice(-50); this.save();
    this.onChange({ type: 'user.notice', ...row }); return row;
  }
  read(id) {
    if (typeof id !== 'string') throw Error('Expected a notification ID.');
    if (!this.rows.some(row => row.id === id)) return;
    this.rows = this.rows.filter(row => row.id !== id); this.save();
  }
}

async function handleNotificationHttp(server, req, res, readJson, sendJson) {
  const path = String(req.url || '').split('?')[0];
  if (!['/api/notifications', '/api/session/notify'].includes(path)) return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!isLoopbackAddress(req.socket?.remoteAddress)
    || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, server.host)
    || req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 403, { error: 'Notifications are local to CliDeck.' }); return true;
  }
  if (path === '/api/notifications' && req.method === 'GET') { sendJson(res, 200, server.notifications.snapshot()); return true; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed.' }); return true; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { sendJson(res, 415, { error: 'Expected JSON.' }); return true; }
  try {
    const body = await readJson(req, 24 * 1024);
    if (path === '/api/session/notify') {
      if (!body || Object.keys(body).some(key => !['callerSessionId', 'text'].includes(key))) throw Error('Invalid notification request.');
      const caller = resolveLiveCaller(server.persistence.list(), server.sessions, body.callerSessionId);
      if (!caller) throw Error('Send notifications from inside a live CliDeck session.');
      const notice = server.notifications.add(caller.entry.id, body.text);
      sendJson(res, 200, { ok: true, id: notice.id, message: 'Notification saved in CliDeck. Connected plugins may also deliver it.' });
    } else {
      if (!body || body.action !== 'read' || Object.keys(body).some(key => !['action', 'id'].includes(key))) throw Error('Use read with a notification ID.');
      server.notifications.read(body.id); sendJson(res, 200, { ok: true, ...server.notifications.snapshot() });
    }
  } catch (error) { sendJson(res, 400, { error: error.message }); }
  return true;
}

module.exports = { UserNotifications, handleNotificationHttp };

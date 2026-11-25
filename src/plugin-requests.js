const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createSessionDelivery } = require('./session-delivery');
const { getProvider } = require('./providers');
const short = value => String(value || '').slice(0, 2000);

// A plugin can restart independently of the engine. This small receipt ledger
// makes retrying the same request safe and keeps uncertain pastes blocking all
// automatic senders, even when the originating plugin has been disabled.
class PluginRequests {
  constructor(server) {
    this.server = server; this.path = join(server.persistence.dataDir, 'plugin-requests.json');
    this.rows = []; this.active = new Map(); this.error = ''; this.deliver = createSessionDelivery(server);
    try {
      if (fs.statSync(this.path).size > 16 * 1024 * 1024) throw Error('too large');
      const value = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (!Array.isArray(value) || value.length > 1000 || value.some(row => !row.pending || typeof row.id !== 'string'
        || typeof row.pluginId !== 'string' || typeof row.sessionId !== 'string'
        || !['pending', 'delivering', 'sent', 'working', 'complete', 'uncertain'].includes(row.state))) throw Error('invalid');
      this.rows = value;
      for (const row of this.rows) {
        if (row.state === 'delivering') { row.state = row.pending.phase = 'uncertain'; row.message = 'Engine restarted during submission. Inspect the session and acknowledge without resending.'; }
        else if (['sent', 'working'].includes(row.state)) { row.state = 'complete'; row.message = 'Engine restarted before a reply was captured. The request was not resent.'; }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.error = `Cannot read plugin-requests.json. Plugin submissions are stopped; the original file was left unchanged. Inspect and repair or restore ${this.path}, then restart CliDeck. Never delete uncertain receipts just to retry a prompt.`; }
  }
  save() {
    if (this.error) throw Error(this.error);
    const path = `${this.path}.${process.pid}.tmp`;
    try {
      const data = JSON.stringify(this.rows);
      if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw Error('too large');
      const fd = fs.openSync(path, 'w', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(path, this.path);
    } catch {
      try { fs.unlinkSync(path); } catch {}
      this.error = 'Cannot save plugin request receipts. Plugin submissions are stopped.';
      for (const job of this.active.values()) job.controller.abort();
      throw Error(this.error);
    }
  }
  uncertain(sessionId) { return this.rows.find(row => row.sessionId === sessionId && row.state === 'uncertain'); }
  errorNotices(sessionId) {
    const rows = this.rows.filter(row => row.sessionId === sessionId && row.state === 'uncertain').map(row => ({
      id: `plugin-request:${row.pluginId}:${row.id}`, operation: `plugin ${row.pluginId}`, state: 'uncertain',
      message: row.message, details: 'Inspect the session before acknowledging. This clears the hold without resending, even if the originating plugin is disabled or removed.',
    }));
    if (this.error) rows.push({ id: 'plugin-request-store', operation: 'Plugin request storage', state: 'error', message: this.error,
      details: 'Repair the private receipt store and restart. Unrelated monitors and error notices continue using their own delivery records.' });
    return rows;
  }
  async acknowledgeForSession(sessionId, id) {
    const row = this.rows.find(row => row.sessionId === sessionId && row.state === 'uncertain' && id === `plugin-request:${row.pluginId}:${row.id}`);
    if (!row) throw Error('No uncertain plugin request with that ID belongs to this session.');
    return this.release(row.pluginId, row.id, true);
  }
  list(pluginId) {
    if (this.error) throw Error(this.error);
    return this.rows.filter(row => row.pluginId === pluginId).map(({ hash, pending, ...row }) => ({ ...row }));
  }
  async submit(pluginId, sessionId, id, text, options = {}) {
    if (this.error) throw Error(this.error);
    if (this.server.closing || !this.server.httpServer.listening) return { state: 'waiting', message: 'CliDeck is starting or stopping.' };
    if (typeof sessionId !== 'string' || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)
      || typeof text !== 'string' || !text.trim() || text.length > 16000 || !options || typeof options !== 'object'
      || Object.keys(options).some(key => !['resume', 'steer'].includes(key))
      || ['resume', 'steer'].some(key => options[key] !== undefined && typeof options[key] !== 'boolean')) throw Error('Invalid plugin request.');
    const entry = this.server.persistence.get(sessionId);
    if (!entry || !getProvider(entry.provider)?.userText) return { state: 'error', message: 'This session does not provide native prompt receipts. Use a Claude or Codex session.' };
    const hash = createHash('sha256').update(text).digest('hex'), key = `${pluginId}:${id}`;
    let row = this.rows.find(row => row.pluginId === pluginId && row.id === id);
    if (row && (row.sessionId !== sessionId || row.hash !== hash)) throw Error('Request ID already belongs to a different prompt.');
    if (row && (Boolean(row.resumeSession) !== (options.resume === true) || Boolean(row.steer) !== (options.steer === true))) {
      throw Error('Request ID already belongs to different delivery options.');
    }
    if (this.active.has(key)) return { state: 'waiting', message: 'This request is already being submitted.' };
    if (row && row.state !== 'pending') return { state: row.state === 'working' || row.state === 'complete' ? row.resultState || 'sent' : row.state,
      message: row.message, ...(row.steered && { steered: true }) };
    if (!row) {
      if (this.rows.length >= 1000) throw Error('Plugin receipt storage is full. Release completed requests before submitting more.');
      row = { pluginId, id, sessionId, hash, origin: `plugin:${pluginId}`, resumeSession: options.resume === true, steer: options.steer === true,
        state: 'pending', pending: { phase: 'pending' }, message: '', at: Date.now() };
      this.rows.push(row); this.save();
    }
    const controller = new AbortController(); let committed = false;
    const checkpoint = patch => { Object.assign(row.pending, patch); this.save(); };
    const commit = () => {
      if (controller.signal.aborted || this.server.closing) throw Error('Plugin request was cancelled.');
      row.state = 'delivering'; checkpoint({ phase: 'delivering' }); committed = true;
    };
    const job = { controller, pluginId, promise: null }; this.active.set(key, job);
    job.promise = (async () => {
      let result;
      try { result = await this.deliver(row, { commit, checkpoint, signal: controller.signal, message: text }); }
      catch (error) { result = { state: committed ? 'uncertain' : 'error', message: error.message }; }
      if (result.state === 'uncertain' || committed && result.state !== 'sent') row.state = row.pending.phase = 'uncertain';
      else if (result.state === 'sent') {
        row.resultState = 'sent';
        if (result.steered) { row.steered = true; row.state = 'complete'; row.message = short(result.message); }
        else if (row.state === 'delivering') row.state = 'sent';
      }
      else if (result.state === 'error') { row.state = 'complete'; row.resultState = 'error'; row.message = short(result.message); }
      if (row.state !== 'complete') row.message = short(result.message);
      this.save(); return result;
    })();
    try { return await job.promise; } finally { this.active.delete(key); }
  }
  reply(event) {
    if (!event.origin?.startsWith('plugin:') || this.error) return;
    const pluginId = event.origin.slice(7), row = this.rows.find(row => row.pluginId === pluginId && row.id === event.requestId);
    if (!row || row.sessionId !== event.sessionId || ['uncertain', 'complete'].includes(row.state)) return;
    if (event.type === 'turn.started') row.state = 'working';
    else if (event.type === 'agent.final') { row.state = 'complete'; row.answer = String(event.text || '').slice(0, 64_000); row.message = ''; }
    else if (event.type === 'turn.ended') { row.state = 'complete'; row.message = short(event.reason); }
    else return;
    this.save();
  }
  async release(pluginId, id, acknowledge = false) {
    const row = this.rows.find(row => row.pluginId === pluginId && row.id === id);
    if (!row) return true;
    const active = this.active.get(`${pluginId}:${id}`);
    if (active) { active.controller.abort(); await active.promise?.catch(() => {}); }
    if (row.state === 'uncertain' && !acknowledge) return false;
    const session = this.server.sessions.get(row.sessionId);
    if (session?.replyOwner?.origin === `plugin:${pluginId}` && session.replyOwner.requestId === id) session.endReply('The originating plugin stopped waiting for this reply.');
    this.rows = this.rows.filter(value => value !== row); this.save();
    if (acknowledge) this.server.pluginManager.emitCoreEvent?.({ type: 'session.reply', phase: 'request.acknowledged',
      sessionId: row.sessionId, requestId: row.id, origin: row.origin });
    return true;
  }
  cancel(pluginId, id) {
    const row = this.rows.find(row => row.pluginId === pluginId && row.id === id);
    const session = row && this.server.sessions.get(row.sessionId);
    if (!row || row.state !== 'working' || session?.replyOwner?.origin !== `plugin:${pluginId}`
      || session.replyOwner.requestId !== id || session.status !== 'working' || session.menu?.length || !session.provider.interruptInput) return false;
    session.writeInput(session.provider.interruptInput); return true;
  }
  stopPlugin(pluginId) {
    for (const job of this.active.values()) if (job.pluginId === pluginId) job.controller.abort();
    for (const row of this.rows) if (row.pluginId === pluginId && ['sent', 'working'].includes(row.state)) {
      const session = this.server.sessions.get(row.sessionId);
      if (session?.replyOwner?.requestId === row.id && session.replyOwner.origin === row.origin) session.endReply('The plugin stopped before collecting this reply.');
      row.state = 'complete'; row.message = 'The plugin stopped before collecting this reply. Work may still be running in CliDeck.';
    }
    if (!this.error) { try { this.save(); } catch {} }
  }
  removeSession(sessionId) {
    for (const row of this.rows) if (row.sessionId === sessionId) this.active.get(`${row.pluginId}:${row.id}`)?.controller.abort();
    if (!this.rows.some(row => row.sessionId === sessionId)) return;
    this.rows = this.rows.filter(row => row.sessionId !== sessionId);
    if (!this.error) { try { this.save(); } catch {} }
  }
  async close() {
    for (const job of this.active.values()) job.controller.abort();
    await Promise.allSettled([...this.active.values()].map(job => job.promise));
  }
}

module.exports = { PluginRequests };

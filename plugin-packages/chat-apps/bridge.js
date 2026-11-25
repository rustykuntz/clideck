const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { WhatsApp } = require('./whatsapp');

const SUPPORTED = new Set(['claude-code', 'codex']);
const INPUT_CHANGED = 'Input changed in CliDeck. Check the conversation there.';
const fresh = () => ({ version: 1, routes: [], requests: [], outbox: [], sent: [], seen: [], notices: [] });
const messageKey = (group, id) => createHash('sha256').update(group + ':' + id).digest('hex');
// Convert Markdown bold outside code; WhatsApp uses single asterisks.
const whatsappText = text => String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  .map((part, index) => index % 2 ? part : part.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')).join('');
const comparableText = text => whatsappText(text).replace(/\*([^*\n]+)\*/g, '$1')
  .replace(/^\s*[-*•–]\s+/gm, '- ').replace(/\s+/g, ' ').trim();

class ChatBridge {
  constructor(api, { transport, now = Date.now, timers = true } = {}) {
    Object.assign(this, { api, now, timers });
    this.file = path.join(api.dataDir, 'chat-apps.json');
    this.state = fresh(); this.sessions = []; this.groups = []; this.error = '';
    this.closed = false; this.connectedAt = Infinity; this.incoming = Promise.resolve();
    // Only follow a turn while this worker has continuously observed its boundaries.
    this.following = new Map();
    fs.mkdirSync(api.dataDir, { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw Error('too large');
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version !== 1 || ['routes', 'requests', 'outbox', 'seen', 'notices'].some(key => !Array.isArray(state[key]))
        || state.routes.length > 100 || state.requests.length > 100 || state.outbox.length > 100) throw Error('invalid state');
      this.state = state;
      this.state.sent ||= [];
      for (const row of state.requests) if (row.state === 'submitting') {
        row.state = 'uncertain'; row.message = 'CliDeck stopped during submission. Inspect the agent before clearing this message; it will not be resent.';
      }
      for (const row of state.outbox) if (row.state === 'sending') {
        row.state = 'uncertain'; row.message = 'WhatsApp delivery was interrupted. Check the group before clearing; this reply will not be resent.';
      }
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Cannot read Chat apps storage. The original file was preserved; repair it before reconnecting.'; }
    this.whatsapp = transport || new WhatsApp({ dataDir: api.dataDir,
      onChange: status => {
        this.connectedAt = status.status === 'connected' ? Math.floor(this.now() / 1000) : Infinity;
        this.changed();
      },
      onMessages: event => {
        this.incoming = this.incoming.then(() => this.receive(event)).catch(error => this.fail(error));
      },
      getMessage: key => {
        const row = [...this.state.outbox, ...this.state.sent].find(row => row.messageId === key.id && row.groupId === key.remoteJid);
        return row ? row.message || { conversation: row.text } : undefined;
      },
    });
  }
  fail(error) { this.error = error.message || String(error); this.changed(); }
  save() {
    if (this.error) throw Error(this.error);
    const temporary = this.file + '.tmp';
    try {
      const json = JSON.stringify(this.state);
      if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw Error('full');
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
    } catch { this.error = 'Cannot save Chat apps storage. Routing has stopped to avoid repeating messages.'; this.changed(); throw Error(this.error); }
    this.changed();
  }
  async refresh() {
    const [sessions, projects] = await Promise.all([this.api.getSessions(), this.api.getProjects()]);
    this.sessions = sessions.map(s => ({ sessionId: s.sessionId, name: s.name || s.sessionId,
      projectName: projects.find(p => p.id === s.projectId)?.name || '', supported: SUPPORTED.has(s.provider) }));
  }
  label(id) {
    const s = this.sessions.find(s => s.sessionId === id);
    return s ? [s.projectName, s.name].filter(Boolean).join(' · ') : 'Deleted agent';
  }
  snapshot({ privatePairing = true } = {}) {
    const whatsapp = this.whatsapp.snapshot();
    if (!privatePairing) whatsapp.qrDataUrl = null;
    if (this.error) { whatsapp.status = 'error'; whatsapp.error = this.error; }
    return { whatsapp, sessions: this.sessions, groups: this.groups, routes: this.state.routes,
      pending: [...this.state.requests, ...this.state.outbox].filter(row => row.state === 'uncertain')
        .map(row => ({ id: row.id, sessionId: row.sessionId, state: row.state, message: row.message })) };
  }
  changed() { if (!this.closed && this.whatsapp) this.api.sendToClients('updated', this.snapshot()); }
  route(groupId, sessionId) {
    return this.state.routes.find(route => route.groupId === groupId && (!sessionId || route.sessionId === sessionId));
  }
  async start() {
    await this.refresh();
    if (this.error) return;
    await this.whatsapp.start();
    if (this.timers) this.timer = setInterval(() => this.tick().catch(error => this.fail(error)), 1500);
  }
  async act({ action, ...args }) {
    if (action === 'status') { await this.refresh(); return this.snapshot(); }
    if (this.error) throw Error(this.error);
    if (action === 'connect') this.whatsapp.connect();
    else if (action === 'disconnect') {
      this.state.routes = []; this.groups = []; this.save();
      await this.whatsapp.disconnect();
      await this.discardUnrouted();
    } else if (action === 'groups') this.groups = await this.whatsapp.groups();
    else if (action === 'bind') {
      await this.refresh();
      const session = this.sessions.find(s => s.sessionId === args.sessionId);
      if (!session?.supported) throw Error('Choose a Claude or Codex agent.');
      if (this.state.routes.some(r => r.groupId === args.groupId || r.sessionId === args.sessionId)) throw Error('This group or agent is already connected. Disconnect its current link first.');
      if (this.state.routes.length >= 100) throw Error('You can connect up to 100 groups.');
      const group = await this.whatsapp.verifyGroup(args.groupId);
      // A one-to-one link is checked again after the network request.
      if (this.state.routes.some(r => r.groupId === args.groupId || r.sessionId === args.sessionId)) throw Error('This group or agent was just connected. Refresh the list.');
      this.state.routes.push({ groupId: args.groupId, name: group.subject || 'Unnamed group', sessionId: args.sessionId,
        enabled: true, since: Math.floor(this.now() / 1000), revision: randomUUID() });
      this.save();
    } else if (action === 'unbind') {
      this.state.routes = this.state.routes.filter(r => r.groupId !== args.groupId); this.save();
      await this.discardUnrouted();
    } else if (action === 'test') {
      const route = this.route(args.groupId);
      if (!route) throw Error('Connect this group to an agent first.');
      await this.whatsapp.verifyGroup(route.groupId);
      const ids = this.queue(route, 'Connected. Write a new text message here to talk to this agent.');
      await this.working;
      await this.tick();
      const remaining = this.state.outbox.find(row => ids.includes(row.id));
      if (remaining) throw Error(remaining.message || 'The test is queued but has not been sent. Check the connection before sending another.');
    } else if (action === 'acknowledge') {
      const request = this.state.requests.find(row => row.id === args.id && row.state === 'uncertain');
      const outgoing = this.state.outbox.find(row => row.id === args.id && row.state === 'uncertain');
      if (!request && !outgoing) throw Error('No uncertain message with that ID.');
      if (request) { await this.api.acknowledgeRequest(request.id); this.state.requests = this.state.requests.filter(row => row !== request); }
      if (outgoing) this.state.outbox = this.state.outbox.filter(row => row !== outgoing);
      this.save();
    } else throw Error('Unknown Chat apps action.');
    this.changed(); return this.snapshot();
  }
  remember(key) { this.state.seen.push(key); this.state.seen = this.state.seen.slice(-5000); }
  async receive(event) {
    if (this.closed || this.error || this.whatsapp.status !== 'connected' || event.type !== 'notify') return;
    for (const message of event.messages || []) {
      const key = message.key, route = key && this.route(key.remoteJid);
      if (!route || key.fromMe !== true || !key.id) continue;
      const id = messageKey(key.remoteJid, key.id), timestamp = Number(message.messageTimestamp);
      if (this.state.seen.includes(id) || !Number.isFinite(timestamp)
        || timestamp < Math.max(route.since, this.connectedAt) || timestamp > this.now() / 1000 + 60) continue;
      // Record before any asynchronous operation; our own send IDs are saved before sending too.
      this.remember(id); this.save();
      try { await this.whatsapp.verifyGroup(route.groupId); }
      catch (error) { await this.api.notifyUser(route.sessionId, error.message); continue; }
      if (this.route(route.groupId) !== route || this.closed) continue;
      const body = message.message;
      const text = body?.conversation ?? body?.extendedTextMessage?.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
        this.queue(route, 'Send a text message of up to 16,000 characters. Voice notes and files are not supported yet.'); continue;
      }
      if (this.state.requests.some(row => row.sessionId === route.sessionId)) {
        this.queue(route, 'This agent already has a WhatsApp message pending. Wait for its reply, or check it in CliDeck.'); continue;
      }
      if (this.state.requests.length >= 100) { this.queue(route, 'Too many pending messages. Please try later.'); continue; }
      this.state.requests.push({ id: 'wa-' + id, groupId: route.groupId, sessionId: route.sessionId,
        revision: route.revision, text, state: 'queued', at: this.now() });
      this.save();
    }
  }
  allowed(row) { return this.route(row.groupId, row.sessionId)?.revision === row.revision; }
  observeTurn(event) {
    const sessionId = event.sessionId;
    if (event.type === 'session.reply') {
      if (event.phase === 'turn.started') this.following.delete(sessionId);
      if (event.phase !== 'turn.ended' || event.reason !== INPUT_CHANGED
        || event.origin !== 'plugin:' + this.api.id) return;
      const row = this.state.requests.find(r => r.id === event.requestId && r.sessionId === sessionId);
      if (row && row.state !== 'uncertain' && this.allowed(row)) this.following.set(sessionId, row);
      return;
    }
    const row = this.following.get(sessionId);
    if (!row && event.type === 'agent.final') {
      const pending = this.state.requests.find(r => r.sessionId === sessionId && ['submitting', 'sent'].includes(r.state));
      if (pending) { pending.sawFinal = true; this.save(); }
    }
    if (!row || (event.type === 'status' && event.state !== 'idle')) return;
    this.following.delete(sessionId);
    // A draft or terminal report can end the delivery receipt without starting
    // another turn. Accept only its canonical final before any new prompt or idle.
    if (event.type === 'agent.final' && this.allowed(row) && this.state.requests.includes(row)) {
      row.confirmedFinal = String(event.text || '').slice(0, 64000);
      this.save();
    }
  }
  queue(route, text, kind = '', replaceIds = []) {
    if (!this.allowed({ ...route })) return [];
    const body = whatsappText(text || 'No reply text.').slice(0, 64000);
    const replacements = replaceIds.map(id => [...this.state.outbox, ...this.state.sent].find(item => item.id === id));
    const canReplace = replacements.length === Math.ceil(body.length / 12000)
      && replacements.every(item => item && (!item.state || item.state === 'pending'));
    if (this.state.outbox.length + Math.ceil(body.length / 12000) > 100) throw Error('WhatsApp reply storage is full. Clear pending deliveries before continuing.');
    // Persist the ID before sending, so a synchronous fromMe echo cannot become a prompt.
    const messageId = this.whatsapp.messageId();
    const label = `[CliDeck · ${this.label(route.sessionId)}]\n${kind ? `*${kind}*\n` : ''}`;
    const ids = [];
    for (let offset = 0; offset < body.length; offset += 12000) {
      const previous = canReplace && replacements[offset / 12000];
      const messageText = label + body.slice(offset, offset + 12000);
      if (previous?.state === 'pending') {
        previous.text = messageText; ids.push(previous.id); continue;
      }
      const outgoingId = offset ? this.whatsapp.messageId() : messageId;
      this.remember(messageKey(route.groupId, outgoingId));
      const id = randomUUID(); ids.push(id);
      this.state.outbox.push({ id, messageId: outgoingId, groupId: route.groupId, sessionId: route.sessionId,
        revision: route.revision, text: messageText, state: 'pending',
        ...(previous && { editMessageId: previous.messageId }) });
    }
    this.save(); return ids;
  }
  async finish(row, text, kind = 'Status') {
    const route = this.route(row.groupId, row.sessionId);
    if (route?.revision === row.revision && text) {
      // A request saved by an older plugin may already have a delivered preview.
      const repeatsProgress = kind === 'Final response' && row.lastProgressText
        && comparableText(text) === comparableText(row.lastProgressText);
      this.queue(route, text, kind, repeatsProgress ? row.lastProgressIds : []);
    }
    this.state.requests = this.state.requests.filter(item => item !== row); this.save();
    await this.api.releaseRequest(row.id);
  }
  async discardUnrouted() {
    for (const row of [...this.state.requests]) if (!this.allowed(row) && row.state !== 'uncertain') {
      const released = await this.api.releaseRequest(row.id);
      if (released) this.state.requests = this.state.requests.filter(item => item !== row);
      else { row.state = 'uncertain'; row.message = 'Inspect the agent before clearing this interrupted submission.'; }
    }
    this.state.outbox = this.state.outbox.filter(row => this.allowed(row)); this.save();
  }
  async tick() {
    if (this.closed || this.error || this.working) return;
    this.working = this.work();
    try { await this.working; } finally { this.working = null; }
  }
  async work() {
    const receipts = this.state.requests.length ? await this.api.getRequests() : [];
    for (const row of [...this.state.requests]) {
      if (this.closed) return;
      const receipt = receipts.find(receipt => receipt.id === row.id);
      if (receipt?.state === 'complete') {
        const inputChanged = receipt.message === INPUT_CHANGED;
        if (inputChanged && this.following.get(row.sessionId) === row) continue;
        const answer = receipt.answer || (inputChanged && row.confirmedFinal);
        const message = inputChanged
          ? 'WhatsApp stopped tracking this request. Open the agent’s chat in CliDeck to follow up.'
          : receipt.message;
        await this.finish(row, answer || message || 'No reply was captured. Check the agent in CliDeck.', answer ? 'Final response' : 'Status'); continue;
      }
      if (receipt?.state === 'uncertain') { row.state = 'uncertain'; row.message = receipt.message; this.save(); continue; }
      if (!this.allowed(row)) continue;
      if (receipt?.state === 'working') {
        if (row.state !== 'working' && this.whatsapp.status === 'connected') {
          row.state = 'working';
          if (row.lastProgressText) this.save(); // Older requests already announced progress.
          else this.queue(this.route(row.groupId, row.sessionId), 'The agent is working on your request.', 'Status');
        }
        continue;
      }
      if (receipt?.state === 'sent') {
        if (row.sawFinal) await this.finish(row, 'The agent finished a turn, but CliDeck could not match it to this message. Check the agent’s chat in CliDeck.');
        else if (row.state !== 'sent') { row.state = 'sent'; this.save(); }
        continue;
      }
      if (row.state !== 'queued') continue;
      if (this.now() - row.at > 3600000) { await this.finish(row, 'This message expired while waiting for the agent. Send a new message when ready.'); continue; }
      if (this.whatsapp.status !== 'connected') continue;
      if (row.nextAt > this.now()) continue;
      row.nextAt = this.now() + 10000;
      try { await this.whatsapp.verifyGroup(row.groupId); }
      catch (error) {
        if (row.message !== error.message) { row.message = error.message; this.save(); await this.api.notifyUser(row.sessionId, error.message); }
        continue;
      }
      if (!this.allowed(row) || this.closed) continue;
      row.state = 'submitting'; this.save();
      let result;
      try { result = await this.api.submitRequest(row.sessionId, row.id, row.text, { resume: true }); }
      catch { result = { state: 'uncertain', message: 'Delivery could not be confirmed. Inspect the agent before clearing; do not resend blindly.' }; }
      if (!this.state.requests.includes(row)) continue;
      if (result.state === 'error') await this.finish(row, result.message || 'The agent could not receive this message.');
      else { row.state = result.state === 'waiting' ? 'queued' : result.state === 'sent' ? 'sent' : 'uncertain'; row.message = result.message || ''; this.save(); }
    }
    for (const row of [...this.state.outbox]) {
      if (this.closed || this.whatsapp.status !== 'connected') return;
      if (row.state !== 'pending' || !this.allowed(row)) continue;
      try { await this.whatsapp.verifyGroup(row.groupId); }
      catch (error) { row.state = 'uncertain'; row.message = error.message; this.save(); await this.api.notifyUser(row.sessionId, error.message); continue; }
      if (!this.allowed(row) || this.closed) continue;
      row.state = 'sending'; this.save();
      try {
        const sent = await this.whatsapp.send(row.groupId, row.text, row.messageId, row.editMessageId);
        if (row.editMessageId) {
          const original = this.state.sent.find(item => item.groupId === row.groupId && item.messageId === row.editMessageId);
          if (original) { original.text = row.text; original.message = { conversation: row.text }; }
        }
        this.state.sent.push({ id: row.id, groupId: row.groupId, messageId: row.messageId, text: row.text,
          ...(sent?.message && { message: sent.message }) });
        this.state.sent = this.state.sent.slice(-100);
        this.state.outbox = this.state.outbox.filter(item => item !== row); this.save();
      } catch {
        row.state = 'uncertain'; row.message = 'WhatsApp delivery could not be confirmed. Check the group before clearing; this reply will not be resent.';
        this.save(); await this.api.notifyUser(row.sessionId, row.message);
      }
    }
  }
  async notice(event) {
    if (this.closed || this.error || event.origin === 'plugin:' + this.api.id || this.state.notices.includes(event.id)) return;
    const route = this.state.routes.find(route => route.sessionId === event.sessionId);
    if (!route) return;
    this.state.notices.push(event.id); this.state.notices = this.state.notices.slice(-1000);
    this.queue(route, event.text);
  }
  async close() { this.closed = true; clearInterval(this.timer); await this.whatsapp.close(); await this.incoming; await this.working; }
}
module.exports = { ChatBridge, messageKey };

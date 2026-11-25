const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { loadRuntime } = require('./runtime');

const normalized = jid => String(jid || '').replace(/:\d+(?=@)/, '');
class WhatsApp {
  constructor({ dataDir, onChange, onMessages, getMessage, runtime = loadRuntime }) {
    Object.assign(this, { dataDir, onChange, onMessages, getMessage, runtime });
    this.authDir = path.join(dataDir, 'whatsapp-auth');
    this.status = 'disconnected'; this.error = ''; this.qrDataUrl = null;
    this.socket = null; this.generation = 0; this.retry = 0; this.closed = false;
  }
  snapshot() { return { status: this.status, error: this.error, account: this.socket?.user?.name || null, qrDataUrl: this.qrDataUrl }; }
  changed(status, error = '') { this.status = status; this.error = error; this.onChange(this.snapshot()); }
  ownIds() { return [this.socket?.user?.id, this.socket?.user?.lid].filter(Boolean).map(normalized); }
  isPrivateGroup(group) {
    return group?.id?.endsWith('@g.us') && group.participants?.length === 1
      && [group.participants[0].id, group.participants[0].phoneNumber, group.participants[0].lid]
        .some(id => id && this.ownIds().includes(normalized(id)));
  }
  async start() { if (fs.existsSync(path.join(this.authDir, 'creds.json'))) this.connect(); }
  connect() {
    if (['preparing', 'connecting', 'pairing', 'connected'].includes(this.status)) return;
    this.closed = false; this.retry = 0; this.begin();
  }
  begin() {
    clearTimeout(this.reconnectTimer);
    const generation = ++this.generation;
    this.qrDataUrl = null; this.changed('preparing');
    this.connectJob = this.open(generation).catch(() => {
      if (generation === this.generation && !this.closed) this.changed('error', 'WhatsApp could not connect. Check your network and try Connect again.');
    });
  }
  async open(generation) {
    const { baileys: b, qrcode, logger } = await this.runtime(this.dataDir);
    if (generation !== this.generation || this.closed) return;
    this.baileys = b;
    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.authDir, 0o700);
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authDir);
    if (generation !== this.generation || this.closed) return;
    this.changed('connecting');
    const socket = b.default({ auth: state, logger, browser: b.Browsers.macOS('Desktop'),
      connectTimeoutMs: 20000, defaultQueryTimeoutMs: 20000,
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: jid => !jid.endsWith('@g.us'),
      getMessage: key => this.getMessage(key),
      cachedGroupMetadata: async jid => {
        const cached = this.groupCache?.get(jid);
        return cached && Date.now() - cached.at < 30000 ? cached.value : undefined;
      },
    });
    this.socket = socket; this.groupCache = new Map();
    const current = () => generation === this.generation && !this.closed;
    socket.ev.on('creds.update', () => {
      if (current()) this.authWrite = (this.authWrite || Promise.resolve()).then(saveCreds)
        .catch(() => { if (current()) { this.changed('error', 'Cannot save WhatsApp connection credentials.'); this.stopSocket(); } });
    });
    socket.ev.on('connection.update', update => {
      if (!current()) return;
      if (update.qr) {
        qrcode.toDataURL(update.qr, { margin: 2, width: 280 }).then(url => {
          if (current() && this.status !== 'connected') { this.qrDataUrl = url; this.changed('pairing'); }
        }).catch(() => { if (current()) this.changed('error', 'Could not display the WhatsApp QR code.'); });
      }
      if (update.connection === 'open') { this.retry = 0; this.qrDataUrl = null; this.changed('connected'); }
      if (update.connection === 'close') {
        this.qrDataUrl = null; this.socket = null;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === b.DisconnectReason.loggedOut) {
          this.changed('error', 'WhatsApp unlinked this device. Disconnect here, then Connect and scan again.'); return;
        }
        if (++this.retry > 5) { this.changed('error', 'WhatsApp disconnected. Choose Connect to try again.'); return; }
        this.changed('connecting');
        this.reconnectTimer = setTimeout(() => { if (current()) this.begin(); }, code === b.DisconnectReason.restartRequired ? 500 : Math.min(30000, this.retry * 3000));
      }
    });
    socket.ev.on('messages.upsert', event => { if (current()) this.onMessages(event); });
    socket.ev.on('group-participants.update', event => this.groupCache.delete(event.id));
    socket.ev.on('groups.update', events => events.forEach(event => this.groupCache.delete(event.id)));
  }
  async groups() {
    if (this.status !== 'connected') throw Error('Connect WhatsApp first.');
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.values(groups).filter(group => this.isPrivateGroup(group)).map(group => ({ id: group.id, name: group.subject || 'Unnamed group' }));
  }
  async verifyGroup(id) {
    if (this.status !== 'connected' || !this.socket) throw Error('WhatsApp is disconnected.');
    if (typeof id !== 'string' || !/^[\d-]+@g\.us$/.test(id)) throw Error('Choose a WhatsApp group from the list.');
    const group = await this.socket.groupMetadata(id);
    this.groupCache.set(id, { at: Date.now(), value: group });
    if (!this.isPrivateGroup(group)) throw Error('This group must contain only you. Its agent connection is paused while other people are members.');
    return group;
  }
  messageId() { return '3EB0' + randomBytes(18).toString('hex').toUpperCase(); }
  async send(groupId, text, messageId, editMessageId) {
    if (!this.socket || this.status !== 'connected') throw Error('WhatsApp is disconnected.');
    return this.socket.sendMessage(groupId, { text,
      ...(editMessageId && { edit: { remoteJid: groupId, id: editMessageId, fromMe: true } }),
    }, { messageId });
  }
  stopSocket() {
    ++this.generation; clearTimeout(this.reconnectTimer);
    this.socket?.end(new Error('Chat apps connection closed.')); this.socket = null; this.qrDataUrl = null;
  }
  async disconnect() {
    this.closed = true; clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    ++this.generation; this.socket = null; this.qrDataUrl = null;
    try { await socket?.logout(); } catch {} finally { socket?.end(new Error('Disconnected by user')); }
    await this.connectJob; await this.authWrite;
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.changed('disconnected');
  }
  async close() { this.closed = true; this.stopSocket(); await this.connectJob; await this.authWrite; }
}
module.exports = { WhatsApp };

const fs = require('node:fs');
const { join } = require('node:path');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { Telegram, messageParts } = require('./telegram');
const { Presence } = require('./presence');

const SUPPORTED = new Set(['claude-code', 'codex']);
const clean = (value, max = 2000) => String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').slice(0, max);
const fresh = () => ({ version: 1, token: '', bot: null, paired: null, pairing: null, offset: 0,
  topics: {}, inbox: [], outbox: [], notices: [], seenNotices: [], mode: 'auto' });
const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// One bot, one paired person, one topic per session. The persisted inbox owns
// terminal delivery; only a matching native prompt receipt can own its answer.
class ChatApps {
  constructor({ dataDir, entries, deliver, describe, reportError = () => {}, clearError = () => {},
    releaseRequest = async () => true, acknowledgeRequest = async () => true, cancelRequest = async () => false,
    getRequests = async () => [], notifyUser = async () => {}, readNotification = async () => {},
    onChange = () => {}, now = Date.now, telegram = token => new Telegram(token), presenceProbe,
    timers = { setTimeout, clearTimeout }, polling = true }) {
    this.path = join(dataDir, 'telegram.json'); this.entries = entries;
    this.deliver = deliver; this.describe = describe; this.reportError = reportError; this.clearError = clearError;
    this.releaseRequest = releaseRequest; this.acknowledgeRequest = acknowledgeRequest; this.cancelRequest = cancelRequest;
    this.getRequests = getRequests; this.notifyUser = notifyUser; this.readNotification = readNotification;
    this.onChange = onChange; this.now = now; this.makeTelegram = telegram; this.timers = timers; this.polling = polling;
    this.state = fresh(); this.error = ''; this.connectionError = ''; this.started = false; this.generation = 0;
    this.pollTimer = null; this.workTimer = null; this.pollJob = null; this.workJob = null; this.controlBusy = false;
    this.connection = new AbortController(); this.drafts = new Map(); this.load();
    this.client = this.state.token ? this.makeTelegram(this.state.token) : null;
    this.presence = new Presence({ mode: this.state.mode, probe: presenceProbe, timers, onChange: () => this.changed() });
  }

  load() {
    try {
      if (fs.statSync(this.path).size > 8 * 1024 * 1024) throw Error('too large');
      const value = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (value.version !== 1 || typeof value.token !== 'string' || !Number.isSafeInteger(value.offset) || value.offset < 0
        || !value.topics || typeof value.topics !== 'object' || Array.isArray(value.topics)
        || !Array.isArray(value.inbox) || value.inbox.length > 100 || !Array.isArray(value.outbox) || value.outbox.length > 200
        || !Array.isArray(value.notices) || value.notices.length > 50 || !['auto', 'here', 'away'].includes(value.mode)
        || Object.values(value.topics).some(topic => typeof topic.enabled !== 'boolean' || !Number.isSafeInteger(topic.revision))
        || value.inbox.some(row => typeof row.id !== 'string' || typeof row.sessionId !== 'string'
          || !['queued', 'submitting', 'submitted', 'working', 'uncertain'].includes(row.phase) || !row.pending)
        || value.outbox.some(row => typeof row.id !== 'string' || !['pending', 'sending'].includes(row.phase))) throw Error('invalid format');
      this.state = value;
      this.state.seenNotices ||= [];
      this.state.pairing = null; // Pairing links expire across engine restarts.
      for (const topic of Object.values(value.topics)) if (topic.setup === 'creating') {
        topic.setup = 'uncertain'; topic.enabled = false;
        topic.error = 'Topic creation was interrupted. Inspect Telegram, then clear pending before creating another topic.';
      }
      for (const row of value.inbox) {
        if (row.phase === 'submitting') {
          row.phase = row.pending.phase = 'uncertain';
          row.message = 'CliDeck restarted during submission. Inspect the session, then clear pending without resending.';
        } else if (['submitted', 'working'].includes(row.phase)) {
          row.phase = 'queued'; row.restarted = true;
        }
      }
      // Telegram sendMessage has no idempotency key. Retrying a network-uncertain
      // reply can duplicate text, but never repeats the agent's work.
      for (const row of value.outbox) row.phase = 'pending';
    } catch (error) {
      if (error.code !== 'ENOENT') this.error = 'Cannot read telegram.json. Phone is stopped; the original file was left unchanged.';
    }
  }

  save() {
    if (this.error) throw Error(this.error);
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      const data = JSON.stringify(this.state);
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw Error('storage full');
      const fd = fs.openSync(temp, 'w', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.path);
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      this.error = 'Cannot save telegram.json. Phone is stopped to avoid losing or repeating requests.';
      this.connection.abort(); this.workJob?.controller.abort(); this.changed(); throw Error(this.error);
    }
    this.changed();
  }

  snapshot() {
    const s = this.state, pairing = s.pairing && s.pairing.expiresAt > this.now() ? s.pairing : null;
    return { telegram: { connected: Boolean(s.token && s.bot), bot: s.bot,
      topicsEnabled: s.bot?.topicsEnabled === true, paired: s.paired,
      pairing: pairing ? { url: `https://t.me/${s.bot.username}?start=${pairing.code}`, expiresAt: pairing.expiresAt } : null,
      status: this.error || this.connectionError ? 'error' : s.paired ? 'paired' : s.token ? 'connected' : 'disconnected',
      error: this.error || this.connectionError },
      sessions: this.entries().map(entry => {
        const topic = s.topics[entry.id], uncertain = this.uncertainSubmission(entry.id);
        return { sessionId: entry.id, name: entry.name || entry.id, supported: SUPPORTED.has(entry.provider), enabled: Boolean(topic?.enabled),
          topicId: topic?.id || null, error: topic?.error || '',
          ...(uncertain ? { pending: { id: uncertain.id, state: 'uncertain', message: uncertain.message } }
            : topic?.setup === 'uncertain' ? { pending: { id: `topic:${entry.id}`, state: 'uncertain', message: topic.error } } : {}) };
      }), presence: this.presence?.snapshot() || { mode: s.mode, away: false, supported: false, idleSeconds: 600 },
      notices: s.notices.map(row => ({ ...row })) };
  }

  changed() { try { this.onChange({ type: 'chat-apps.updated', ...this.snapshot() }); } catch {} }
  uncertainSubmission(sessionId) { return this.state.inbox.find(row => row.sessionId === sessionId && row.phase === 'uncertain'); }
  entry(id) { return this.entries().find(entry => entry.id === id); }
  title(id, enabled) { return clean(`${this.describe(id)}${enabled ? '' : ' · Off'}`, 128); }

  async start() {
    this.started = true;
    if (this.error) return;
    const receipts = await this.getRequests();
    for (const row of [...this.state.inbox]) {
      const receipt = receipts.find(receipt => receipt.id === row.id);
      if (!receipt && row.phase === 'uncertain') this.finish(row, 'The pending request was cleared in CliDeck without resending.');
      else if (receipt?.state === 'complete') {
        if (receipt.answer) this.queueReply(row.sessionId, receipt.answer, 'reply');
        this.finish(row, receipt.answer ? '' : receipt.message || 'The plugin restarted before collecting the reply. Check CliDeck; your request was not resent.');
      } else if (receipt?.state === 'uncertain' || row.phase === 'uncertain') {
        row.phase = row.pending.phase = 'uncertain'; row.message = receipt?.message || row.message;
        this.queueText(row.sessionId, row.message, 'system');
      } else if (row.restarted) this.finish(row, 'CliDeck restarted before the reply was captured. Check the session in CliDeck; your request was not resent.');
    }
    for (const receipt of receipts) if (!this.state.inbox.some(row => row.id === receipt.id) && receipt.state !== 'uncertain') await this.releaseRequest(receipt.id);
    this.save(); this.refreshPresence();
    if (this.state.paired) await this.presence.check();
    this.schedulePoll(); this.scheduleWork();
  }

  refreshPresence() { this.presence.enable(this.started && Boolean(this.state.token && this.state.paired)); }

  async act(body) {
    if (this.error) throw Error(this.error);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Expected a Chat apps action.');
    const fields = { connect: ['token'], pair: [], test: [], disconnect: [], phone: ['sessionId', 'enabled'],
      presence: ['mode'], 'notice-read': ['id'], acknowledge: ['id'] };
    if (!fields[body.action] || Object.keys(body).some(key => key !== 'action' && !fields[body.action].includes(key))) throw Error('Invalid Chat apps action.');
    if (body.action === 'disconnect') this.disconnect();
    else if (body.action === 'presence') {
      this.presence.setMode(body.mode); this.state.mode = body.mode; this.save();
    } else if (body.action === 'notice-read') {
      if (typeof body.id !== 'string') throw Error('Expected notice ID.');
      this.state.notices = this.state.notices.filter(row => row.id !== body.id); this.save();
    } else if (body.action === 'acknowledge') await this.acknowledge(body.id);
    else if (body.action === 'phone' && body.enabled === false) await this.setPhone(body.sessionId, false);
    else {
      if (this.controlBusy) throw Error('Another Chat apps change is still running. Try again shortly.');
      this.controlBusy = true;
      try {
        if (body.action === 'connect') await this.connect(body.token);
        else if (body.action === 'pair') this.pair();
        else if (body.action === 'test') {
          if (!this.state.paired) throw Error('Pair your phone first.');
          const generation = this.generation;
          await this.client.call('sendMessage', { chat_id: this.state.paired.id, text: 'CliDeck is connected. Turn Phone on for a session to talk to it here.' }, { signal: this.connection.signal });
          if (generation !== this.generation) throw Error('Connection changed while sending the test.');
        } else await this.setPhone(body.sessionId, body.enabled);
      } finally { this.controlBusy = false; }
    }
    return { ok: true, ...this.snapshot() };
  }

  async connect(token) {
    if (token === undefined) token = this.state.token;
    if (typeof token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token)) throw Error('Paste the bot token from BotFather.');
    if (this.state.token && token !== this.state.token) throw Error('Disconnect the current bot before connecting another one.');
    const generation = this.generation, client = this.makeTelegram(token);
    const me = await client.call('getMe', {}, { signal: this.connection.signal });
    const webhook = await client.call('getWebhookInfo', {}, { signal: this.connection.signal });
    if (generation !== this.generation) throw Error('Connection cancelled.');
    if (webhook.url) throw Error('This bot already uses a webhook. Use a dedicated bot or remove its webhook before connecting.');
    if (!me?.is_bot || !Number.isSafeInteger(me.id) || !/^[A-Za-z0-9_]+$/.test(me.username || '')) throw Error('Telegram did not return a valid bot identity.');
    this.state.token = token; this.state.bot = { id: me.id, username: me.username, name: clean(me.first_name, 200), topicsEnabled: me.has_topics_enabled === true };
    this.client = client; this.connectionError = ''; this.save(); this.refreshPresence(); this.schedulePoll();
  }

  pair() {
    if (!this.client) throw Error('Connect a Telegram bot first.');
    if (!this.state.bot.topicsEnabled) throw Error('Enable topics for this bot in BotFather, then choose Check again.');
    if (this.state.paired) throw Error('This bot is already paired. Disconnect first to change the paired account.');
    if (this.state.pairing?.expiresAt > this.now()) return;
    this.state.pairing = { code: randomBytes(24).toString('base64url'), createdAt: this.now(), expiresAt: this.now() + 300_000 };
    this.save(); this.schedulePoll();
  }

  disconnect() {
    this.generation++; this.connection.abort(); this.connection = new AbortController();
    this.workJob?.controller.abort(); this.timers.clearTimeout(this.pollTimer); this.pollTimer = null;
    for (const row of this.state.outbox) this.deliveryError(row, 'Phone disconnected before delivery completed.');
    for (const row of this.state.inbox) this.releaseRequest(row.id).catch(() => {});
    const uncertain = this.state.inbox.filter(row => ['submitting', 'uncertain'].includes(row.phase));
    for (const row of uncertain) { row.phase = row.pending.phase = 'uncertain'; row.message = 'Phone disconnected during submission. Inspect the session, then clear pending without resending.'; }
    this.state = { ...fresh(), mode: this.state.mode, notices: this.state.notices, inbox: uncertain };
    this.client = null; this.connectionError = ''; this.drafts.clear(); this.save(); this.refreshPresence();
  }

  async setPhone(sessionId, enabled) {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') throw Error('Choose a session and turn Phone on or off.');
    const entry = this.entry(sessionId);
    if (!entry) throw Error('Session no longer exists.');
    if (enabled && !SUPPORTED.has(entry.provider)) throw Error('Phone currently supports Claude and Codex, which identify the request owning each reply.');
    if (enabled && (!this.state.paired || !this.state.bot?.topicsEnabled)) throw Error('Connect Telegram, enable bot topics, and pair your phone first.');
    const topic = this.state.topics[sessionId] ||= { id: null, enabled: false, revision: 0, error: '' };
    if (enabled && topic.setup === 'uncertain') throw Error(topic.error);
    if (topic.id && topic.enabled === enabled) return;
    const revision = ++topic.revision, generation = this.generation;
    if (!enabled) {
      topic.enabled = false;
      if (this.workJob?.sessionId === sessionId) this.workJob.controller.abort();
      for (const row of [...this.state.inbox]) if (row.sessionId === sessionId) {
        this.releaseRequest(row.id).catch(() => {});
        if (row.phase === 'submitting') { row.phase = row.pending.phase = 'uncertain'; row.message = 'Phone turned off during submission. Inspect the session, then clear pending without resending.'; }
        else if (row.phase !== 'uncertain') this.state.inbox.splice(this.state.inbox.indexOf(row), 1);
      }
      this.state.outbox = this.state.outbox.filter(row => {
        if (row.sessionId !== sessionId) return true;
        this.deliveryError(row, 'Phone turned off before delivery completed.'); return false;
      });
    } else if (!topic.id) {
      topic.setup = 'creating'; topic.error = ''; this.save();
      try {
        const result = await this.client.call('createForumTopic', { chat_id: this.state.paired.id, name: this.title(sessionId, true) }, { signal: this.connection.signal });
        if (generation !== this.generation || this.state.topics[sessionId] !== topic) throw Error('Connection changed while creating the topic.');
        if (!Number.isSafeInteger(result?.message_thread_id) || result.message_thread_id <= 0) throw Error('Telegram did not return a topic ID.');
        topic.id = result.message_thread_id; topic.setup = '';
      } catch (error) {
        if (generation === this.generation && this.state.topics[sessionId] === topic) {
          topic.enabled = false; topic.setup = error.uncertain ? 'uncertain' : '';
          topic.error = clean(error.message); this.save();
        }
        throw error;
      }
    }
    if (topic.revision === revision) { topic.enabled = enabled; if (enabled) topic.enabledAt = this.now(); }
    topic.error = ''; topic.name = this.title(sessionId, topic.enabled);
    if (topic.id) {
      this.queue({ sessionId, revision: topic.revision, method: 'editForumTopic', body: { name: topic.name }, source: 'system', allowOff: true });
      this.queueText(sessionId, topic.enabled ? `Write here to talk to ${this.describe(sessionId)}.` : 'Turned off in CliDeck. This thread keeps its history; messages here will not reach the session.', 'system', true);
    }
    this.save(); this.scheduleWork();
  }

  async acknowledge(id) {
    if (typeof id !== 'string') throw Error('Expected pending ID.');
    const row = this.state.inbox.find(row => row.id === id && row.phase === 'uncertain');
    if (row) { await this.acknowledgeRequest(id); this.state.inbox = this.state.inbox.filter(value => value !== row); }
    else {
      const topic = id.startsWith('topic:') && this.state.topics[id.slice(6)];
      if (!topic || topic.setup !== 'uncertain') throw Error('There is no uncertain delivery to clear.');
      topic.setup = ''; topic.error = '';
    }
    this.save(); this.scheduleWork();
  }

  queue({ sessionId = '', revision, method = 'sendMessage', body, source = 'system', allowOff = false }) {
    if (!this.state.paired || !this.client) return null;
    if (this.state.outbox.length >= 200) throw Error('Phone delivery queue is full. Check Chat apps before sending more.');
    const topic = this.state.topics[sessionId];
    const row = { id: randomUUID(), sessionId, revision: revision ?? topic?.revision, method,
      body: { chat_id: this.state.paired.id, ...(topic?.id && { message_thread_id: topic.id }), ...body },
      source, allowOff, phase: 'pending', attempts: 0, nextAt: this.now() };
    this.state.outbox.push(row); return row;
  }

  queueText(sessionId, text, source, allowOff = false) {
    const parts = messageParts(clean(text, 64_000));
    const row = this.queue({ sessionId, source, allowOff, body: { text: parts[0] } });
    if (row && parts.length > 1) { row.parts = parts; row.part = 0; }
    return row;
  }

  localNotice(sessionId, text) {
    this.notifyUser(sessionId, clean(text, 4000)).catch(error => { this.connectionError = clean(error.message); this.changed(); });
  }

  acceptNotification(notice) {
    const topic = this.state.topics[notice.sessionId];
    if (notice.origin === 'plugin:telegram' || this.state.seenNotices.includes(notice.id) || !topic?.enabled
      || notice.at < topic.enabledAt || !this.presence.snapshot().away || !this.state.paired) return;
    const row = this.queueText(notice.sessionId, notice.text, 'notify');
    if (!row) return;
    row.noticeId = notice.id; this.state.seenNotices.push(notice.id); this.state.seenNotices = this.state.seenNotices.slice(-100);
    this.save(); this.scheduleWork();
  }

  schedulePoll(delay = 0) {
    if (!this.started || !this.polling || !this.client || this.error || this.pollJob || this.pollTimer !== null) return;
    this.pollTimer = this.timers.setTimeout(() => { this.pollTimer = null; this.poll().catch(() => {}); }, delay); this.pollTimer?.unref?.();
  }

  async poll() {
    if (!this.started || !this.client || this.error || this.pollJob) return;
    const generation = this.generation, client = this.client; let retry = 0;
    const topics = new Map(Object.entries(this.state.topics).map(([id, topic]) => [id, topic.revision]));
    const job = (async () => {
      try {
        const updates = await client.call('getUpdates', { offset: this.state.offset, timeout: 25, limit: 50,
          allowed_updates: ['message', 'stopped_message_generation'] }, { signal: this.connection.signal, timeoutMs: 35_000 });
        if (generation !== this.generation || !this.started) return;
        if (!Array.isArray(updates)) throw Error('Telegram returned invalid updates.');
        if (this.connectionError) { this.connectionError = ''; this.changed(); }
        for (const update of updates) this.receive(update, topics);
        if (!updates.length) retry = 500; // Bound unexpected immediate empty responses.
      } catch (error) {
        if (generation !== this.generation || !this.started || this.error) return;
        this.connectionError = clean(error.message); this.changed(); retry = Math.max(5000, (error.retryAfter || 0) * 1000);
      }
    })();
    this.pollJob = job;
    try { await job; } finally { this.pollJob = null; this.schedulePoll(retry); }
  }

  receive(update, topics = null) {
    if (this.error || !Number.isSafeInteger(update?.update_id) || update.update_id < this.state.offset) return;
    const message = update.message, paired = this.state.paired;
    // Save the accepted request and the cursor in the same write before the next
    // poll acknowledges it to Telegram. Stranger updates consume no resources.
    this.state.offset = update.update_id + 1;
    if (update.stopped_message_generation) {
      const stop = update.stopped_message_generation;
      this.save();
      if (paired && stop.chat?.type === 'private' && stop.chat.id === paired.id) this.stopDraft(stop).catch(() => {});
      return;
    }
    if (!message || message.chat?.type !== 'private' || message.from?.is_bot
      || !Number.isSafeInteger(message.from?.id) || message.chat.id !== message.from.id) { this.save(); return; }
    if (!paired) {
      const pair = this.state.pairing, code = typeof message.text === 'string' && /^\/start ([A-Za-z0-9_-]+)$/.exec(message.text)?.[1];
      if (pair && pair.expiresAt > this.now() && message.date * 1000 >= pair.createdAt - 1000 && equalSecret(code, pair.code)) {
        this.state.paired = { id: message.from.id, name: clean([message.from.first_name, message.from.last_name].filter(Boolean).join(' '), 200), username: clean(message.from.username, 100) };
        this.state.pairing = null;
        this.queueText('', 'Paired with CliDeck. Turn Phone on for a session in CliDeck, then write in its thread.', 'system', true);
        this.refreshPresence();
      }
      this.save(); this.scheduleWork(); return;
    }
    if (message.from.id !== paired.id) { this.save(); return; }
    const mapping = Object.entries(this.state.topics).find(([, topic]) => topic.id === message.message_thread_id);
    const [sessionId, topic] = mapping || [];
    if (!sessionId) this.queueText('', 'Choose a session thread. Turn Phone on for that session in CliDeck to create one.', 'system', true);
    else if (!topic.enabled || !this.entry(sessionId)) this.queueText(sessionId, 'Phone is off for this session. Turn it on in CliDeck to send messages.', 'system', true);
    else if (topics && topics.get(sessionId) !== topic.revision || sessionId && message.date * 1000 < Math.floor((topic.enabledAt || 0) / 1000) * 1000) {
      this.queueText(sessionId, 'Phone settings changed while this message was arriving. Send it again to use the current session settings.', 'system');
    }
    else if (typeof message.text !== 'string' || !message.text.trim()) this.queueText(sessionId, 'Send text for now; voice, photos and files are not supported yet.', 'system');
    else if (this.state.inbox.some(row => row.sessionId === sessionId)) this.queueText(sessionId, 'This session already has a phone request pending. Wait for its reply, or use Stop while it is working.', 'system');
    else if (this.state.inbox.length >= 100) this.queueText(sessionId, 'CliDeck has too many pending phone requests. Try again later.', 'system');
    else {
      this.state.inbox.push({ id: randomUUID(), updateId: update.update_id, sessionId, revision: topic.revision,
        text: clean(message.text, 8000), phase: 'queued', pending: { phase: 'pending' }, resumeSession: true, origin: 'phone',
        at: this.now(), nextAt: this.now(), expiresAt: this.now() + 3600_000, draftId: update.update_id + 1, draftAt: 0, message: '' });
    }
    this.save(); this.scheduleWork();
  }

  allowed(row) {
    if (!this.client || !this.state.paired || row.body?.chat_id !== undefined && row.body.chat_id !== this.state.paired.id) return false;
    if (!row.sessionId) return true;
    const topic = this.state.topics[row.sessionId];
    return Boolean(topic && topic.revision === row.revision && (row.allowOff || topic.enabled && this.entry(row.sessionId)));
  }

  finish(row, message) {
    if (!this.state.inbox.includes(row)) return;
    if (message && this.allowed(row)) this.queueText(row.sessionId, message, 'reply');
    this.state.inbox.splice(this.state.inbox.indexOf(row), 1); this.drafts.delete(row.id);
    this.save(); this.releaseRequest(row.id).catch(() => {}); this.scheduleWork();
  }

  sessionEvent(session, event) {
    if (this.error || !this.started) return;
    try {
      const row = this.state.inbox.find(row => row.id === event.requestId && row.sessionId === session.id);
      if (row && event.origin === 'plugin:telegram' && event.type === 'request.acknowledged') {
        this.finish(row, 'The pending request was cleared in CliDeck without resending.'); return;
      }
      if (event.origin === 'desktop') {
        if (event.type === 'agent.final' && this.presence.snapshot().away && this.state.topics[session.id]?.enabled) {
          this.queueReply(session.id, event.text, 'desktop'); this.save(); this.scheduleWork();
        }
        return;
      }
      if (!row || event.origin !== 'plugin:telegram' || !this.allowed(row) || row.phase === 'uncertain') return;
      if (event.type === 'turn.started') { row.phase = 'working'; row.draftAt = 0; this.save(); this.scheduleWork(); }
      else if (event.type === 'agent.final') { this.queueReply(session.id, event.text, 'reply'); this.finish(row); }
      else if (event.type === 'agent.update') { this.drafts.set(row.id, clean(event.text, 4000)); this.scheduleWork(); }
      else if (event.type === 'menu' && event.choices?.length) {
        if (!row.needsApproval) { row.needsApproval = true; this.queueText(session.id, 'The agent needs your attention in CliDeck. Open its session to answer the prompt.', 'system'); this.save(); this.scheduleWork(); }
      } else if (event.type === 'menu') row.needsApproval = false;
      else if (event.type === 'turn.ended') this.finish(row, event.reason || 'The turn ended without a reply.');
    } catch (error) { this.connectionError = clean(error.message); this.changed(); }
  }

  queueReply(sessionId, text, source) {
    const parts = messageParts(clean(text, 64_000));
    const row = this.queueText(sessionId, parts[0], source);
    if (row) { row.parts = parts; row.part = 0; }
  }

  sessionClosed(sessionId) {
    for (const row of [...this.state.inbox]) if (row.sessionId === sessionId && ['working', 'submitted'].includes(row.phase)) {
      this.finish(row, 'The session stopped before its reply was captured. Check it in CliDeck.');
    }
  }

  reconcile() {
    if (this.error) return;
    let changed = false;
    for (const row of [...this.state.inbox]) if (!this.entry(row.sessionId)) {
      this.state.inbox.splice(this.state.inbox.indexOf(row), 1); this.releaseRequest(row.id).catch(() => {}); changed = true;
    }
    for (const [id, topic] of Object.entries(this.state.topics)) {
      if (!this.entry(id) && topic.enabled) {
        topic.enabled = false; topic.revision++; changed = true;
        if (this.workJob?.sessionId === id) this.workJob.controller.abort();
      }
      const name = this.title(id, topic.enabled);
      if (topic.id && name !== topic.name) {
        topic.name = name; this.queue({ sessionId: id, body: { name }, method: 'editForumTopic', source: 'system', allowOff: true }); changed = true;
      }
    }
    if (changed) { this.save(); this.scheduleWork(); }
  }

  async stopDraft(stop) {
    const row = this.state.inbox.find(row => row.draftId === stop.draft_id && this.state.topics[row.sessionId]?.id === stop.message_thread_id);
    if (!row || !this.allowed(row) || row.phase !== 'working' || row.needsApproval) return;
    await this.cancelRequest(row.id);
  }

  deliveryError(row, message) {
    if (!row.sessionId || row.source === 'system') return;
    try { Promise.resolve(this.reportError({ key: `phone:${row.id}`, sessionId: row.sessionId, operation: 'phone delivery',
      text: `Telegram delivery failed: ${clean(message)}\nOpen the Telegram plugin to repair the connection. The agent request was not resent.` })).catch(() => {}); } catch {}
  }

  scheduleWork(delay = 0) {
    if (!this.started || this.error || this.workJob) return;
    this.timers.clearTimeout(this.workTimer); this.workTimer = null;
    const due = [ ...this.state.outbox.map(row => row.nextAt), ...this.state.inbox.filter(row => row.phase !== 'uncertain')
      .map(row => row.phase === 'queued' ? row.nextAt : Math.min(row.expiresAt, row.phase === 'submitted' ? row.submittedAt + 90_000 : row.draftAt + 20_000)) ];
    if (!due.length) return;
    this.workTimer = this.timers.setTimeout(() => { this.workTimer = null; this.work().catch(() => {}); },
      Math.max(delay, 0, Math.min(...due) - this.now())); this.workTimer?.unref?.();
  }

  async work() {
    if (!this.started || this.error || this.workJob) return;
    const controller = new AbortController(), generation = this.generation;
    const job = { controller, sessionId: '', promise: null }; this.workJob = job;
    job.promise = (async () => {
      for (const row of [...this.state.inbox]) {
        if (row.phase === 'uncertain') continue;
        if (!this.allowed(row)) { this.finish(row); continue; }
        if (row.expiresAt <= this.now()) { this.finish(row, 'No reply was captured within an hour. Check the session in CliDeck; work may still be running.'); continue; }
        if (row.phase === 'submitted' && row.submittedAt + 90_000 <= this.now()) {
          this.finish(row, 'The message was submitted, but its native receipt was not observed. Check the session in CliDeck; it was not resent.'); continue;
        }
      }
      const outgoing = this.state.outbox.find(row => row.nextAt <= this.now());
      if (outgoing) { job.sessionId = outgoing.sessionId; await this.send(outgoing, controller.signal, generation); return; }
      const row = this.state.inbox.find(row => row.phase === 'queued' && row.nextAt <= this.now());
      if (row) {
        job.sessionId = row.sessionId;
        row.phase = 'submitting'; row.pending.phase = 'delivering'; this.save();
        let result;
        try { result = await this.deliver(row, { signal: controller.signal,
          message: `[CliDeck phone request ${row.id}]\n${row.text}` }); }
        catch (error) { result = { state: 'uncertain', message: error.message }; }
        if (!this.state.inbox.includes(row) || this.error) return;
        if (row.phase === 'uncertain') { this.save(); return; }
        if (result.state === 'sent') {
          if (row.phase !== 'working') row.phase = 'submitted';
          row.submittedAt = this.now(); this.save();
        } else if (result.state === 'uncertain') {
          row.phase = row.pending.phase = 'uncertain'; row.message = clean(result.message);
          this.queueText(row.sessionId, 'Submission could not be confirmed. Inspect the session, then clear pending in the Telegram plugin setup; nothing will be resent automatically.', 'system'); this.save();
        } else if (result.state === 'error') this.finish(row, clean(result.message));
        else {
          row.phase = 'queued'; row.pending.phase = 'pending';
          row.nextAt = this.now() + 10_000;
          if (!row.waitingNotice) {
            row.waitingNotice = true; this.queueText(row.sessionId, `Waiting for the session. ${clean(result.message)}`, 'system'); this.save();
          }
        }
        return;
      }
      const draft = this.state.inbox.find(row => row.phase === 'working' && row.draftAt + 20_000 <= this.now());
      if (draft && this.allowed(draft)) {
        job.sessionId = draft.sessionId; draft.draftAt = this.now();
        try {
          await this.client.call('sendMessageDraft', { chat_id: this.state.paired.id, message_thread_id: this.state.topics[draft.sessionId].id,
            draft_id: draft.draftId, text: this.drafts.get(draft.id) || '',
            can_stop: !draft.needsApproval }, { signal: controller.signal });
        } catch (error) {
          // Drafts are optional; the durable final still uses sendMessage.
          if (!controller.signal.aborted) { this.connectionError = clean(error.message); this.changed(); }
        }
      }
    })();
    try { await job.promise; } finally { this.workJob = null; this.scheduleWork(); }
  }

  async send(row, signal, generation) {
    if (!this.allowed(row)) { this.state.outbox.splice(this.state.outbox.indexOf(row), 1); this.save(); return; }
    row.phase = 'sending'; this.save();
    try {
      await this.client.call(row.method, row.body, { signal });
      if (generation !== this.generation || !this.state.outbox.includes(row) || this.error) return;
      if (row.parts && row.part + 1 < row.parts.length) {
        row.part++; row.body.text = row.parts[row.part]; row.phase = 'pending'; row.nextAt = this.now() + 1000;
      } else {
        this.state.outbox.splice(this.state.outbox.indexOf(row), 1);
        if (row.noticeId) this.readNotification(row.noticeId).catch(() => {});
      }
      try { Promise.resolve(this.clearError(`phone:${row.id}`)).catch(() => {}); } catch {}
      this.connectionError = ''; this.save();
    } catch (error) {
      if (generation !== this.generation || !this.state.outbox.includes(row) || this.error) return;
      row.attempts++; row.phase = 'pending'; this.connectionError = clean(error.message); this.deliveryError(row, error.message);
      if ((!error.uncertain && !error.retryAfter && error.code >= 400 && error.code < 500) || row.attempts >= 5) {
        this.state.outbox.splice(this.state.outbox.indexOf(row), 1);
        const topic = this.state.topics[row.sessionId]; if (topic) topic.error = clean(error.message);
        this.localNotice(row.sessionId, `Telegram delivery failed: ${clean(error.message)}${row.body.text ? `\n\n${row.body.text}` : ''}`);
      } else row.nextAt = this.now() + Math.max(5000 * 2 ** Math.min(row.attempts - 1, 5), (error.retryAfter || 0) * 1000);
      this.save();
    }
  }

  async close() {
    this.started = false; this.connection.abort(); this.workJob?.controller.abort();
    this.timers.clearTimeout(this.pollTimer); this.timers.clearTimeout(this.workTimer);
    this.pollTimer = this.workTimer = null;
    await Promise.allSettled([this.pollJob, this.workJob?.promise, this.presence.close()]);
  }
}

module.exports = { ChatApps, SUPPORTED };

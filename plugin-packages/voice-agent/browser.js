const { randomUUID, createHash } = require('node:crypto');
const { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { OpenAILive, configuration, setup, safeError } = require('./openai');
const { VoiceUsage } = require('./usage');

const MAX_CONTEXT = 12000, MAX_HISTORY = 8000, LEASE_MS = 18000;
const token = value => typeof value === 'string' && /^[\w:-]{1,160}$/.test(value);
const bounded = (value, size) => String(value || '').slice(-size);
function trimHistory(history) {
  while (history.length > 16 || history.reduce((n, t) => n + t.text.length, 0) > MAX_HISTORY) {
    if (history.length === 1) { history[0].text = bounded(history[0].text, MAX_HISTORY); break; }
    history.shift();
  }
}
function parts(value) {
  const result = []; let part = '';
  // <= 500 UTF-8 bytes is deliberately conservative for the API's 500-token append limit.
  for (const char of String(value)) {
    if (Buffer.byteLength(part + char) > 480) { result.push(part); part = ''; }
    part += char;
  }
  if (part) result.push(part); return result;
}

// Browser audio is ephemeral. User instructions and their delivery receipts survive focus changes.
// There is one listening browser at a time; session history and results never move between sessions.
class BrowserVoice {
  constructor(api, options = {}) {
    this.api = api; this.options = options; this.now = options.now || Date.now;
    this.usage = options.usage || new VoiceUsage(api, options);
    this.file = join(api.dataDir, 'browser.json'); this.records = []; this.current = null;
    this.attempts = new Map(); this.sending = new Set(); this.stopped = false; this.storageError = '';
    mkdirSync(api.dataDir, { recursive: true, mode: 0o700 });
    try {
      if (existsSync(this.file)) {
        const raw = readFileSync(this.file, 'utf8'); if (raw.length > 2 * 1024 * 1024) throw Error('oversized');
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > 50
          || data.records.some(r => !token(r.sessionId) || !Array.isArray(r.history) || !Array.isArray(r.operations))) throw Error('invalid');
        this.records = data.records; this.orphan = data.connection;
      }
    } catch { this.storageError = 'Saved voice requests could not be read. Keep browser.json for recovery before starting another conversation.'; }
    this.timer = options.tickMs === 0 ? null : setInterval(() => this.tick().catch(() => {}), options.tickMs || 2000);
    this.timer?.unref?.();
  }
  provider() { const config = configuration(this.api); return this.options.provider ? this.options.provider(config) : new OpenAILive(config); }
  save() {
    if (this.storageError) throw Error(this.storageError);
    const r = this.orphan || this.current;
    const data = { version: 1, records: this.records,
      connection: r ? { id: r.id, sessionId: r.sessionId, providerId: r.providerId || '', state: r.state } : null };
    const tmp = this.file + '.tmp';
    try { writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); renameSync(tmp, this.file); }
    catch { this.storageError = 'Voice request history could not be saved. Check free disk space before continuing.'; throw Error(this.storageError); }
  }
  record(sessionId) {
    let row = this.records.find(r => r.sessionId === sessionId);
    if (!row) {
      if (this.records.length >= 50) {
        const index = this.records.findIndex(r => r.operations.every(op => ['complete', 'error', 'acknowledged'].includes(op.delivery)));
        if (index < 0) throw Error('Too many sessions have unfinished voice requests. Finish those requests first.');
        this.records.splice(index, 1);
      }
      row = { sessionId, history: [], operations: [], updatedAt: this.now() }; this.records.push(row);
    }
    return row;
  }
  fault(sessionId, id, error) {
    const text = safeError(error, configuration(this.api));
    this.api.reportError(sessionId, `browser:${id}`, text).catch(() => {}); return text;
  }
  clear(id) { this.api.clearError(`browser:${id}`).catch(() => {}); }
  async recover() {
    if (this.storageError) return;
    if (this.orphan?.providerId) {
      try { await this.provider().hangup(this.orphan.providerId); }
      catch (error) { this.storageError = this.fault(this.orphan.sessionId, this.orphan.id, `Previous voice connection could not be closed: ${safeError(error)}`); return; }
    }
    this.orphan = null;
    const receipts = await this.api.getRequests();
    for (const row of this.records) for (const op of row.operations) {
      const receipt = receipts.find(r => r.id === op.id && r.sessionId === row.sessionId);
      if (!receipt) {
        if (op.delivery === 'sending') op.delivery = 'uncertain';
        continue;
      }
      if (receipt.answer && !op.answer) { op.answer = bounded(receipt.answer, MAX_CONTEXT); op.delivery = 'complete'; }
      else if (receipt.state === 'uncertain') op.delivery = 'uncertain';
      else if (receipt.steered) { op.delivery = 'sent'; op.steered = true; }
      else if (receipt.state === 'complete' && op.delivery !== 'complete') { op.delivery = 'awaiting'; op.message = receipt.message || 'The session is still the source of truth for this request.'; }
      else if (['sent', 'working'].includes(receipt.state)) op.delivery = 'sent';
      this.save();
      if (op.answer || receipt.steered) await this.api.releaseRequest(op.id);
    }
    this.save();
  }
  state(sessionId) {
    const row = this.records.find(r => r.sessionId === sessionId), run = this.current?.sessionId === sessionId ? this.current : null;
    return { sessionId, state: run?.state || 'off', error: run?.error || '',
      transcript: row?.history.slice(-8) || [],
      request: row?.operations.length ? this.operationState(row.operations.at(-1)) : null };
  }
  operationState(op) { return { id: op.id, state: op.delivery, message: op.message || '', answer: op.answer || '' }; }
  publish(run = this.current) {
    if (run) run.reply('browser-state', { connectionId: run.id, ...this.state(run.sessionId) });
  }
  owned(data) {
    const run = this.current;
    if (!run || run.id !== data.connectionId || run.browserId !== data.browserId) return null;
    return run;
  }
  async start(data, context) {
    if (this.stopped || this.storageError) throw Error(this.storageError || 'Voice Agent is stopping.');
    if (!token(data.connectionId) || !token(data.browserId) || !token(data.sessionId)
      || typeof data.sdp !== 'string' || !data.sdp.startsWith('v=0') || Buffer.byteLength(data.sdp) > 65536) throw Error('The browser could not prepare a voice connection. Reload CliDeck and try again.');
    const hash = createHash('sha256').update(JSON.stringify([data.sessionId, data.browserId, data.sdp])).digest('hex');
    const previous = this.attempts.get(data.connectionId);
    if (previous) { if (previous.hash !== hash) throw Error('This voice connection was already used. Start a new conversation.'); return previous.promise; }
    if (this.current) throw Error('Voice is already open in another session or window. Stop it there before starting here.');
    if (this.api.capabilities?.sessionSteer !== true || this.api.capabilities?.boundedTurns !== true) throw Error('Restart CliDeck to finish updating voice support.');
    const configured = setup(configuration(this.api), 'browser');
    if (!configured.ready) throw Error(configured.errors[0] || 'Add your OpenAI API key in Voice settings first.');
    const run = { id: data.connectionId, browserId: data.browserId, sessionId: data.sessionId, reply: context.reply,
      state: 'connecting', createdAt: this.now(), lastHeartbeat: this.now(), providerId: '', provider: this.provider(),
      controller: new AbortController(), seen: new Set(), pending: new Map(), inputRevision: 0, delegatedRevision: 0, queue: Promise.resolve() };
    this.current = run;
    const promise = this.create(run, data.sdp);
    this.attempts.set(run.id, { hash, promise });
    while (this.attempts.size > 30) this.attempts.delete(this.attempts.keys().next().value);
    return promise;
  }
  async create(run, sdp) {
    try {
      if (this.orphan?.providerId) {
        await run.provider.hangup(this.orphan.providerId); this.orphan = null; this.save();
      }
      const session = await this.api.getSession(run.sessionId);
      if (!session || !['claude-code', 'codex'].includes(session.provider)) throw Error('Voice currently works with Claude and Codex sessions. Choose one of those sessions first.');
      if (run.closed) throw Error('Voice was paused before connecting.');
      run.record = this.record(run.sessionId); this.save();
      const turns = await this.api.getTurns(run.sessionId, 4, MAX_CONTEXT);
      const recent = bounded(turns.map(t => `${t.role}: ${t.text}`).join('\n'), MAX_CONTEXT);
      const operations = run.record.operations.slice(-4).map(op => ({ requestId: op.id, state: op.delivery, result: bounded(op.answer, 1600) }));
      const context = `Session: ${session.name || session.provider}. Current status: ${session.status || (session.live ? 'open' : 'saved')}.
Captured recent conversation (may be incomplete; ask the session agent if needed):\n${recent || 'No captured conversation yet.'}
Voice requests already submitted; do not repeat their actions:\n${JSON.stringify(operations)}`;
      if (run.closed) throw Error('Voice was paused before connecting.');
      run.usageId = `browser:${run.browserId}:${run.id}`;
      this.usage.start(run.usageId, run.sessionId, session.name, 'browser');
      const created = await run.provider.createBrowser(sdp, context, run.record.history, run.controller.signal);
      run.providerId = created.session?.id;
      if (run.providerId) this.usage.created(run.usageId);
      if (!run.providerId || typeof created.transport?.sdp !== 'string') throw Error('OpenAI did not return a usable voice connection.');
      if (run.closed || this.current !== run) {
        this.usage.end(run.usageId);
        try { await run.provider.hangup(run.providerId); }
        catch (error) {
          this.orphan = { id: run.id, sessionId: run.sessionId, providerId: run.providerId, state: 'uncertain' };
          this.save(); this.fault(run.sessionId, run.id, `The cancelled voice connection could not be closed: ${safeError(error)}`);
        }
        throw Error('Voice was paused before connecting.');
      }
      this.save();
      run.connection = run.provider.attach(run.providerId, {
        event: event => this.event(run, event),
        disconnected: reason => { if (!run.closed) this.fail(run, reason); },
      });
      await run.connection.ready;
      if (run.closed || this.current !== run) throw Error('Voice was paused before connecting.');
      this.clear(run.id); this.publish(run);
      return { connectionId: run.id, sdp: created.transport.sdp };
    } catch (error) {
      if (!run.providerId) this.usage.end(run.usageId, error.definite === true);
      if (!run.closed) { this.fault(run.sessionId, run.id, error); await this.stop(run, 'error', safeError(error, configuration(this.api))); }
      throw error;
    }
  }
  ready(data) {
    const run = this.owned(data); if (!run || run.closed) return false;
    run.state = 'listening'; run.lastHeartbeat = this.now(); this.publish(run);
    return true;
  }
  heartbeat(data, context) {
    const run = this.owned(data); if (!run) return false;
    run.lastHeartbeat = this.now(); run.reply = context.reply; this.publish(run); return true;
  }
  event(run, event) {
    // Final metering still belongs to this exact run after Stop cuts local audio.
    this.usage.event(run.usageId, event);
    if (event?.type === 'session.closed') { run.providerClosed = true; run.resolveFinalUsage?.(); }
    if (run.closed || this.current !== run || !event || typeof event !== 'object') return;
    if (event.event_id) { if (run.seen.has(event.event_id)) return; run.seen.add(event.event_id); if (run.seen.size > 3000) run.seen.delete(run.seen.values().next().value); }
    const clientId = event.client_event_id || event.error?.client_event_id;
    const pending = run.pending.get(clientId);
    if (pending && (event.type === pending.type || event.type === 'error')) {
      run.pending.delete(clientId); clearTimeout(pending.timer);
      if (event.type === 'error') pending.reject(Error(safeError(event.error?.message || 'OpenAI rejected the voice update.'))); else pending.resolve(true);
    }
    if (['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type) && typeof event.delta === 'string') {
      const role = event.type.includes('input_') ? 'user' : 'assistant';
      if (role === 'user') run.inputRevision++;
      const history = run.record.history;
      if (history.at(-1)?.role === role) history.at(-1).text += event.delta.slice(0, 4000);
      else history.push({ role, text: event.delta.slice(0, 4000) });
      trimHistory(history); run.record.updatedAt = this.now();
      clearTimeout(run.flush); run.flush = setTimeout(() => { try { this.save(); this.publish(run); } catch (error) { this.fail(run, error); } }, 150);
    } else if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      clearTimeout(run.delegateTimer);
      run.delegateTimer = setTimeout(() => this.delegate(run, event.delegation.id).catch(error => this.fail(run, error)), 250);
    } else if (event.type === 'session.closed') {
      run.providerClosed = true;
      const expired = event.reason === 'expired';
      this.stop(run, 'paused', expired ? 'Refreshing the voice connection.' : 'Voice connection ended. Press Resume voice when you are ready.', expired).catch(() => {});
    } else if (event.type === 'error' && !pending) this.fail(run, event.error?.message || 'OpenAI voice connection failed.');
  }
  async delegate(run, delegationId) {
    if (run.closed || this.current !== run || typeof delegationId !== 'string' || !delegationId || delegationId.length > 512) return;
    if (!run.inputRevision || run.inputRevision <= run.delegatedRevision) return;
    const row = run.record;
    if (row.operations.filter(op => !['complete', 'error', 'acknowledged'].includes(op.delivery)).length >= 12) throw Error('Several voice requests are still waiting. Let the session catch up before asking it to do more.');
    while (row.operations.length >= 20) {
      const index = row.operations.findIndex(op => ['complete', 'error', 'acknowledged'].includes(op.delivery));
      if (index < 0) break; row.operations.splice(index, 1);
    }
    const id = randomUUID();
    const text = `[Voice request ${id} from the user in this CliDeck session]\n`
      + 'The user is speaking to you through Voice Agent. Handle their latest request with the same permissions and clarification rules as typed chat. The recent spoken exchange below includes referents such as point B; do not repeat earlier work.\n'
      + 'Reply briefly for speech. For progress or a final answer, use clideck voice-agent/reply ' + id + ' --stdin with {"text":"Concise verified result","kind":"answer"} (kind "progress" for an update). This explicit reply also works while you are busy. Normal attributable final replies are a fallback.\n'
      + 'Recent spoken exchange (speech recognition can be imperfect):\n' + JSON.stringify(row.history.slice(-6));
    const op = { id, text, delivery: 'waiting', connectionId: run.id, delegationId, createdAt: this.now() };
    row.operations.push(op); run.delegatedRevision = run.inputRevision; this.save(); this.publish(run);
    await this.deliver(row, op);
  }
  async deliver(row, op) {
    if (this.stopped || this.sending.has(op.id) || !['waiting', 'sending'].includes(op.delivery)) return;
    this.sending.add(op.id);
    try {
      op.delivery = 'sending'; this.save();
      const result = await this.api.submitRequest(row.sessionId, op.id, op.text, { resume: true, steer: true });
      if (!op.answer) { op.delivery = result.state; op.steered = result.steered === true; op.message = result.state === 'waiting' ? 'Waiting until the session can receive your request.' : result.message || ''; }
      this.save();
      if (result.steered) await this.api.releaseRequest(op.id);
      if (['uncertain', 'error'].includes(result.state)) this.fault(row.sessionId, op.id, `Voice request delivery ${result.state}: ${result.message}`);
      if (result.state === 'sent') {
        this.clear(op.id);
        const run = this.current;
        if (run?.sessionId === row.sessionId && !run.closed) this.enqueue(run, () => this.append(run, 'thinking', 'Your request has been delivered to the session agent. Wait for verified results; do not invent progress.', null));
      }
    } catch (error) { op.delivery = 'uncertain'; op.message = this.fault(row.sessionId, op.id, error); try { this.save(); } catch {} }
    finally { this.sending.delete(op.id); this.publish(); }
  }
  findOperation(id, sessionId) {
    for (const row of this.records) {
      const op = row.operations.find(o => o.id === id);
      if (op && (!sessionId || row.sessionId === sessionId)) return { row, op };
    }
    throw Error('That voice request does not belong to this session.');
  }
  async answer(sessionId, id, data) {
    const { row, op } = this.findOperation(id, sessionId);
    const text = String(data?.text || '').trim(), kind = data?.kind || 'answer';
    if (!text || text.length > MAX_CONTEXT || !['answer', 'progress'].includes(kind)) throw Error('Provide text (up to 12,000 characters) and kind answer or progress.');
    if (op.answer) return { accepted: true, alreadyAnswered: true, spoken: false };
    if (kind === 'answer') { op.answer = text; op.delivery = 'complete'; } else op.message = text;
    this.save(); this.clear(id);
    if (kind === 'answer') await this.api.releaseRequest(id);
    const run = this.current;
    if (run?.sessionId === sessionId && run.state === 'listening' && !run.closed) {
      const speak = row.operations.at(-1)?.id === id;
      this.enqueue(run, async () => {
        const delegation = run.id === op.connectionId ? op.delegationId : null;
        for (const chunk of parts(`Verified session agent ${kind}: ${text}`)) await this.append(run, 'thinking', chunk, delegation);
        if (speak) await this.append(run, 'commentary', kind === 'progress' ? 'Give a brief update using the verified progress just supplied. Do not claim completion.' : 'Answer the user concisely using the verified result just supplied. Usually one or two short sentences; do not read the full result.', delegation);
      });
    }
    this.publish(); return { accepted: true, spoken: false };
  }
  async reply(event) {
    if (event.origin !== 'plugin:voice-agent' || !event.requestId) return;
    let found; try { found = this.findOperation(event.requestId, event.sessionId); } catch { return; }
    const { op } = found;
    if (event.phase === 'request.acknowledged' && op.delivery === 'uncertain') {
      op.delivery = 'acknowledged'; op.message = 'Delivery was inspected. The request will not be sent again.'; this.save(); this.clear(op.id); this.publish();
    } else if (event.phase === 'agent.final' && !op.steered && event.text) await this.answer(event.sessionId, op.id, { text: bounded(event.text, MAX_CONTEXT) });
    else if (event.phase === 'turn.ended' && !op.answer && !op.steered) { op.delivery = 'awaiting'; op.message = 'Your session is still handling this request. Its next voice reply will appear here.'; this.save(); this.publish(); }
  }
  enqueue(run, fn) {
    run.queue = run.queue.then(() => { if (!run.closed && this.current === run) return fn(); }).catch(error => { if (!run.closed) this.fail(run, error); });
  }
  append(run, kind, content, delegationId) {
    if (run.closed || this.current !== run) return Promise.reject(Error('Voice is paused.'));
    const id = randomUUID(), type = `session.${kind}.append`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(Error('OpenAI did not confirm the voice update. It was not resent.')); }, this.options.ackMs || 8000);
      run.pending.set(id, { type: type + 'ed', resolve, reject, timer });
      try { run.connection.send({ type, event_id: id, content, delegation_id: delegationId }); }
      catch (error) { run.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  fail(run, error) {
    this.fault(run.sessionId, run.id, error);
    this.stop(run, 'error', safeError(error, configuration(this.api))).catch(() => {});
  }
  async stop(run = this.current, state = 'paused', error = '', reconnect = false) {
    if (!run || run.closed) return false;
    run.closed = true; run.state = state; run.error = error;
    clearTimeout(run.flush); clearTimeout(run.delegateTimer); run.controller.abort();
    for (const p of run.pending.values()) { clearTimeout(p.timer); p.reject(Error('Voice paused.')); } run.pending.clear();
    run.reply('browser-state', { connectionId: run.id, sessionId: run.sessionId, state, error, reconnect });
    const finalized = new Promise(resolve => { run.resolveFinalUsage = resolve; });
    let finalTimer;
    try {
      if (run.providerId && !run.providerClosed) await run.provider.hangup(run.providerId);
      if (run.connection && !run.providerClosed) await Promise.race([finalized, new Promise(resolve => { finalTimer = setTimeout(resolve, this.options.finalizeMs ?? 1500); })]);
    }
    catch (e) {
      this.orphan = { id: run.id, sessionId: run.sessionId, providerId: run.providerId, state: 'uncertain' };
      this.fault(run.sessionId, run.id, `Voice disconnected, but OpenAI did not confirm closure: ${safeError(e)}`);
    }
    finally { clearTimeout(finalTimer); run.resolveFinalUsage = null; this.usage.end(run.usageId); run.connection?.close(); if (this.current === run) this.current = null; try { this.save(); } catch {} }
    return true;
  }
  async tick() {
    const run = this.current;
    if (run && this.now() - run.lastHeartbeat > LEASE_MS) {
      await this.stop(run, 'paused', 'Voice paused. Press Resume voice to continue.');
    }
    for (const row of this.records) for (const op of row.operations) if (op.delivery === 'waiting') await this.deliver(row, op);
  }
  async close() { this.stopped = true; clearInterval(this.timer); await this.stop(); }
}
module.exports = { BrowserVoice, parts, trimHistory };

const fs = require('node:fs');
const { join, isAbsolute } = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { runMonitorCommand, MAX_OUTPUT } = require('./monitor-runner');

const MAX_MONITORS = 100, MAX_SEEN = 4000, MAX_STORE = 32 * 1024 * 1024;
const MAX_EVENTS = 100;
const MIN_INTERVAL = 30_000, MAX_INTERVAL = 30 * 86400_000, RETRY = 10_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const short = value => String(value || '').slice(0, 2000);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0');
const number = value => Number.isSafeInteger(value) && value >= 0;
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

function repairCommand(m) {
  const args = ['clideck monitor add', '--name', quote(m.name), '--run', quote(m.command), '--cwd', quote(m.cwd),
    '--mode', quote(m.mode), '--wake', quote(m.sessionId)];
  if (m.at !== null) args.push('--at', quote(new Date(m.at).toISOString()));
  else args.push('--every', quote(`${m.everyMs / 1000}s`));
  if (m.once) args.push('--once');
  if (m.resumeSession) args.push('--resume-session');
  return args.join(' ');
}

function definition(value) {
  if (!value || !text(value.name, 200) || !text(value.command, 4096)
    || !text(value.sessionId, 200) || !text(value.cwd, 4096) || !isAbsolute(value.cwd)
    || (value.creatorSessionId !== undefined && !text(value.creatorSessionId, 200))
    || !['change', 'items', 'until-success'].includes(value.mode)
    || typeof value.once !== 'boolean' || typeof value.resumeSession !== 'boolean') throw new Error('Invalid monitor definition.');
  if (value.at !== null) {
    if (!number(value.at) || value.everyMs !== null) throw new Error('Choose one interval or scheduled time.');
  } else if (!number(value.everyMs) || value.everyMs < MIN_INTERVAL || value.everyMs > MAX_INTERVAL) {
    throw new Error('Use an interval from 30 seconds to 30 days.');
  }
  return { ...Object.fromEntries(['name', 'command', 'sessionId', 'cwd', 'mode', 'everyMs', 'at', 'once', 'resumeSession'].map(k => [k, value[k]])),
    creatorSessionId: value.creatorSessionId || value.sessionId };
}

// Pure comparison: command errors never advance the baseline. New-item mode
// requires stable IDs; retaining only an output hash cannot deduplicate emails.
function inspectResult(m, result) {
  if (m.mode === 'until-success' && result.code === 1) return { message: 'Condition not met yet.' };
  if (result.code !== 0) throw new Error(`Command exited ${result.code}: ${short(result.stderr) || 'no error output'}`);
  const output = String(result.stdout);
  if (Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('Check output exceeded 64 KiB.');
  if (m.mode === 'until-success' || m.at !== null) {
    return { finding: output || 'Scheduled check completed successfully.', message: 'Check succeeded.' };
  }
  if (m.mode === 'items') {
    let items;
    try { items = JSON.parse(output); } catch { throw new Error('Items mode requires a JSON array with a stable id on every item.'); }
    if (!Array.isArray(items) || items.length > MAX_SEEN) throw new Error('Items mode requires a JSON array of at most 4000 items.');
    const ids = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || !((typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 1024)
          || Number.isSafeInteger(item.id))) throw new Error('Each JSON item needs a nonempty string or integer id.');
      return hash(JSON.stringify(item.id));
    });
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate item IDs in command output.');
    const seen = new Set(m.seen), fresh = items.filter((_, i) => !seen.has(ids[i]));
    ids.forEach(id => seen.add(id));
    if (seen.size > MAX_SEEN) throw new Error('This monitor has remembered 4000 items. Narrow or replace it; IDs were not forgotten.');
    return { seen: [...seen], baseline: true,
      finding: m.baseline && fresh.length ? JSON.stringify(fresh, null, 2) : null,
      message: m.baseline ? (fresh.length ? `${fresh.length} new item${fresh.length === 1 ? '' : 's'}.` : 'No new items.') : 'Baseline saved; watching for new items.' };
  }
  const digest = hash(output);
  return { digest, baseline: true, finding: m.baseline && digest !== m.digest ? output || '(Output is now empty.)' : null,
    message: m.baseline ? (digest !== m.digest ? 'Output changed.' : 'No change.') : 'Baseline saved; watching for changes.' };
}

class Monitors {
  constructor({ dataDir, now = Date.now, run = runMonitorCommand, deliver, describe = () => ({}),
    environment = () => process.env, targetExists = () => true, onChange = () => {},
    reportError = () => {}, clearError = () => {}, timers = { setTimeout, clearTimeout } }) {
    this.path = join(dataDir, 'monitors.json');
    this.now = now; this.run = run; this.deliver = deliver; this.describe = describe;
    this.environment = environment; this.onChange = onChange; this.timers = timers;
    this.targetExists = targetExists;
    // Error feedback cannot change monitor execution or prevent its removal.
    this.reportError = value => { try { return reportError(value); } catch { return false; } };
    this.clearError = key => { try { clearError(key); } catch {} };
    this.events = []; this.rows = []; this.error = ''; this.timer = null; this.active = null; this.started = false;
    this.load();
  }

  load() {
    try {
      if (fs.statSync(this.path).size > MAX_STORE) throw new Error('file too large');
      const saved = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.monitors) || saved.monitors.length > MAX_MONITORS) throw new Error('invalid format');
      const events = saved.events ?? [];
      if (!Array.isArray(events) || events.length > MAX_EVENTS || events.some(e =>
        !e || !text(e.id, 100) || !text(e.monitorId, 100) || typeof e.text !== 'string' || e.text.length > MAX_OUTPUT * 2)) throw new Error('invalid monitor events');
      const ids = new Set();
      for (const m of saved.monitors) {
        m.creatorSessionId = definition(m).creatorSessionId;
        if (!text(m.id, 100) || ids.has(m.id) || typeof m.paused !== 'boolean'
          || !number(m.createdAt) || !number(m.wakeCount) || typeof m.baseline !== 'boolean'
          || !Array.isArray(m.seen) || m.seen.length > MAX_SEEN || m.seen.some(id => !/^[a-f0-9]{64}$/.test(id))
          || !Array.isArray(m.history) || m.history.length > 20
          || !['watching', 'checking', 'waiting', 'paused', 'error', 'complete', 'uncertain'].includes(m.state)
          || ![m.lastCheckAt, m.nextCheckAt, m.lastFiredAt].every(v => v === null || number(v))
          || (m.pending && (!text(m.pending.id, 100) || typeof m.pending.text !== 'string' || m.pending.text.length > MAX_OUTPUT * 2
            || !['pending', 'delivering', 'uncertain'].includes(m.pending.phase)))) throw new Error('invalid monitor record');
        ids.add(m.id);
        if (m.pending?.phase === 'delivering') {
          m.pending.phase = 'uncertain'; m.state = 'uncertain';
          m.message = 'CliDeck restarted during delivery. Check the session, then clear pending; nothing will be resent automatically.';
        } else if (m.state === 'checking') { m.state = 'watching'; m.nextCheckAt = this.now(); }
        this.rows.push(m);
      }
      this.events = events;
    } catch (error) {
      this.rows = [];
      if (error.code !== 'ENOENT') this.error = 'Cannot read monitors.json. Monitoring is paused; the original file was left unchanged.';
    }
  }

  snapshot() {
    return { monitors: this.rows.map(m => {
      const { seen, digest, baseline, pending, failures, deliveryAt, ...publicRow } = m;
      return { ...publicRow, ...this.describe(m.sessionId), pendingCount: pending ? 1 : 0 };
    }), ...(this.error && { error: this.error }) };
  }

  notify() { try { this.onChange({ type: 'monitors.updated', ...this.snapshot() }); } catch {} }

  save() {
    if (this.error) throw new Error(this.error);
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      const saved = { version: 1, monitors: this.rows, events: this.events };
      let data = JSON.stringify(saved);
      let size = Buffer.byteLength(data);
      if (size > MAX_STORE) {
        // Give pending findings and monitor state priority over delivered events.
        while (size > MAX_STORE && this.events.length) {
          size -= Buffer.byteLength(JSON.stringify(this.events.pop())) + (this.events.length ? 1 : 0);
        }
        if (size > MAX_STORE) throw new Error('monitor storage limit');
        data = JSON.stringify(saved);
      }
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.path);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      this.error = 'Cannot save monitors.json. Monitoring is paused to avoid losing or repeating findings.';
      this.active?.controller.abort();
      this.notify();
      throw new Error(this.error);
    }
    this.notify();
  }

  history(m, status, message) {
    m.history.unshift({ at: this.now(), status, message: short(message) });
    m.history.length = Math.min(20, m.history.length);
  }

  readEvent(id, sessionId) {
    if (this.error) throw new Error(this.error);
    const archived = this.events.find(event => event.id === id);
    const monitor = this.rows.find(m => m.sessionId === sessionId && (m.pending?.id === id || m.id === archived?.monitorId));
    if (!monitor) throw new Error('Monitor event unavailable in this session.');
    return { id, monitorId: monitor.id, name: monitor.name, source: 'Untrusted monitor command output',
      output: monitor.pending?.id === id ? monitor.pending.text : archived.text };
  }

  finishEvent(m) {
    this.events.unshift({ id: m.pending.id, monitorId: m.id, text: m.pending.text });
    if (this.events.length > MAX_EVENTS) this.events.pop();
    m.pending = null;
  }

  reportFailure(m, stage, message) {
    const sessionId = m.creatorSessionId || m.sessionId;
    const recipe = repairCommand(m);
    this.reportError({ key: `monitor:${m.id}:${stage}`, sessionId, operation: `monitor ${stage}`,
      resumeSession: sessionId === m.sessionId && m.resumeSession,
      text: `Monitor: ${JSON.stringify(m.name)}\nMonitor ID: ${m.id}\n`
        + `Error: ${message}\nPause: clideck monitor pause ${quote(m.id)}\nRemove: clideck monitor remove ${quote(m.id)}\n`
        + (recipe.length < 8000 ? `Original add command: ${recipe}\n` : 'The original add command exceeds the notice limit. Get the full original configuration with clideck monitor list --json.\n')
        + 'Fix the command or configuration before recreating it. Check existing monitors first.'
        + (m.at !== null ? ' The original --at time has passed; choose a future time for the replacement.' : '') });
  }

  add(value) {
    if (this.error) throw new Error(this.error);
    if (this.rows.length >= MAX_MONITORS) throw new Error('At most 100 monitors may be saved.');
    const d = definition(value), now = this.now();
    if (d.at !== null && d.at <= now) throw new Error('Scheduled time must be in the future.');
    const m = { ...d, id: randomUUID(), createdAt: now, paused: false, state: 'watching',
      message: d.at === null ? 'Waiting for first check.' : 'Waiting for scheduled time.',
      lastCheckAt: null, nextCheckAt: d.at ?? now, lastFiredAt: null, wakeCount: 0,
      lastFinding: '', history: [], seen: [], baseline: false, digest: '', pending: null, failures: 0, deliveryAt: 0 };
    this.rows.push(m); this.save(); this.schedule(); return m.id;
  }

  act(body) {
    if (this.error) throw new Error(this.error);
    if (!body || !['pause', 'resume', 'remove', 'check', 'configure', 'acknowledge'].includes(body.action)
      || typeof body.id !== 'string' || Object.keys(body).some(k => !['action', 'id', ...(body.action === 'configure' ? ['resumeSession'] : [])].includes(k))) throw new Error('Invalid monitor action.');
    const m = this.rows.find(row => row.id === body.id);
    if (!m) throw new Error('Monitor not found.');
    if (body.action === 'remove') {
      if (this.active?.id === m.id) this.active.controller.abort();
      this.rows = this.rows.filter(row => row !== m);
      this.events = this.events.filter(event => event.monitorId !== m.id);
      for (const stage of ['check', 'delivery', 'target']) this.clearError(`monitor:${m.id}:${stage}`);
    } else if (body.action === 'pause') {
      m.paused = true;
      if (this.active?.id === m.id && !m.pending) this.active.controller.abort();
      m.state = m.pending?.phase === 'uncertain' ? 'uncertain' : 'paused';
      if (m.state !== 'uncertain') m.message = 'Paused by you.';
    } else if (body.action === 'configure') {
      if (typeof body.resumeSession !== 'boolean') throw new Error('resumeSession must be true or false.');
      m.resumeSession = body.resumeSession;
      m.deliveryAt = this.now();
    } else if (body.action === 'acknowledge') {
      if (m.pending?.phase !== 'uncertain') throw new Error('There is no uncertain delivery to clear.');
      this.finishEvent(m); m.state = m.once || m.at !== null || m.mode === 'until-success' ? 'complete' : m.paused ? 'paused' : 'watching';
      m.nextCheckAt = m.state === 'complete' ? null : this.now() + m.everyMs;
      m.message = 'Pending finding cleared without resending.';
      this.history(m, 'cleared', m.message);
    } else {
      if (m.pending?.phase === 'uncertain' || m.state === 'complete' || this.active?.id === m.id) throw new Error('This monitor cannot be checked or resumed in its current state.');
      if (body.action === 'check' && m.paused) throw new Error('Resume the monitor first.');
      if (body.action === 'resume') m.paused = false;
      m.nextCheckAt = this.now(); m.deliveryAt = this.now();
      m.state = m.pending ? 'waiting' : 'watching'; m.message = 'Check requested.';
    }
    this.save(); this.schedule(); return this.snapshot();
  }

  start() { this.started = true; this.schedule(); }

  sessionReady(id) {
    for (const m of this.rows) if (m.sessionId === id && m.pending?.phase === 'pending') m.deliveryAt = this.now();
    this.schedule();
  }

  due(m) {
    if (m.paused || ['complete', 'uncertain'].includes(m.state) || m.pending?.phase === 'uncertain') return Infinity;
    return m.pending ? m.deliveryAt || 0 : m.nextCheckAt ?? Infinity;
  }

  schedule() {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || this.error || this.active) return;
    const next = Math.min(...this.rows.map(m => this.due(m)));
    if (!Number.isFinite(next)) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.tick().catch(() => {}); }, Math.min(2147483647, Math.max(0, next - this.now())));
    this.timer?.unref?.();
  }

  async tick() {
    if (!this.started || this.error || this.active) return;
    const m = this.rows.filter(m => this.due(m) <= this.now()).sort((a, b) => this.due(a) - this.due(b))[0];
    if (!m) { this.schedule(); return; }
    const controller = new AbortController();
    const job = { id: m.id, controller, promise: null };
    this.active = job;
    job.promise = this.perform(m, controller.signal);
    try { await job.promise; } finally { this.active = null; this.schedule(); }
  }

  async perform(m, signal) {
    const retained = () => this.rows.includes(m) && !this.error;
    try {
      if (!this.targetExists(m.sessionId)) {
        m.paused = true; m.state = 'error'; m.nextCheckAt = null;
        m.message = 'Target session was deleted; this monitor is paused. Remove it or restore the session.';
        this.history(m, 'error', m.message); this.save(); this.reportFailure(m, 'target', m.message); return;
      }
      if (!m.pending) {
        m.state = 'checking'; m.message = 'Checking…'; this.save();
        const result = await this.run({ command: m.command, cwd: m.cwd, env: this.environment(m), signal });
        if (!retained() || signal.aborted || m.paused) return;
        const update = inspectResult(m, result);
        if (update.finding && Buffer.byteLength(update.finding) > MAX_OUTPUT * 2) throw new Error('Finding is too large; narrow the command output.');
        m.lastCheckAt = this.now(); m.failures = 0;
        this.clearError(`monitor:${m.id}:check`);
        for (const key of ['seen', 'baseline', 'digest']) if (update[key] !== undefined) m[key] = update[key];
        m.message = update.message; m.state = 'watching';
        m.nextCheckAt = this.now() + (m.everyMs || RETRY);
        this.history(m, 'checked', m.message);
        if (update.finding !== null && update.finding !== undefined) {
          m.lastFinding = update.finding.slice(0, 8000);
          m.pending = { id: randomBytes(6).toString('hex'), text: update.finding, summary: update.message, phase: 'pending' };
          m.deliveryAt = this.now(); m.nextCheckAt = null; m.state = 'waiting';
        }
        this.save();
      }
      if (!m.pending || m.paused || !retained()) return;
      const previousState = m.state, previousMessage = m.message;
      let committed = false;
      const checkpoint = patch => { Object.assign(m.pending, patch); this.save(); };
      const commit = () => {
        if (!retained() || m.paused || signal.aborted || !this.started) throw new Error('Delivery cancelled.');
        checkpoint({ phase: 'delivering' }); committed = true;
      };
      let result;
      try { result = await this.deliver(m, { commit, checkpoint, signal }); }
      catch (error) { result = { state: committed ? 'uncertain' : 'error', message: error.message }; }
      if (!retained()) return;
      m.message = short(result.message); m.deliveryAt = this.now() + Math.max(RETRY, Math.min(300_000, result.retryAfterMs || RETRY));
      if (result.state === 'sent') {
        this.clearError(`monitor:${m.id}:delivery`);
        this.finishEvent(m); m.wakeCount++; m.lastFiredAt = this.now();
        m.state = m.once || m.at !== null || m.mode === 'until-success' ? 'complete' : m.paused ? 'paused' : 'watching';
        m.nextCheckAt = m.state === 'complete' ? null : this.now() + m.everyMs;
        this.history(m, 'delivered', m.message);
      } else if (result.state === 'uncertain' || (committed && result.state !== 'sent')) {
        m.pending.phase = 'uncertain'; m.state = 'uncertain'; this.history(m, 'uncertain', m.message);
        // The target may still contain an unsubmitted paste. Never append an
        // error prompt there; only a separate creator can safely receive it.
        if (m.creatorSessionId !== m.sessionId) {
          this.reportFailure(m, 'delivery', `${m.message} Do not resend automatically; inspect the target session first.`);
        }
      } else {
        m.state = m.paused ? 'paused' : result.state === 'error' ? 'error' : 'waiting';
        if (result.state === 'error') {
          m.deliveryAt = this.now() + 60_000;
          this.reportFailure(m, 'delivery', m.message);
        }
        // The retry deadline is only scheduling state. An unchanged waiting/error
        // result needs no disk write or browser broadcast, even after hours idle.
        if (m.state === previousState && m.message === previousMessage) return;
      }
      this.save();
    } catch (error) {
      if (!retained()) return;
      if (signal.aborted || m.paused) { m.state = m.paused ? 'paused' : 'watching'; }
      else {
        m.state = 'error'; m.message = short(error.message); m.lastCheckAt = this.now();
        m.failures++;
        m.nextCheckAt = this.now() + (m.failures === 1 ? 30_000
          : Math.min(3600_000, Math.max(m.everyMs || RETRY, 30_000) * 2 ** Math.min(m.failures - 1, 7)));
        this.history(m, 'error', m.message);
        if (m.failures >= 2) this.reportFailure(m, 'check', m.message);
      }
      this.save();
    }
  }

  close() {
    this.started = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.active?.controller.abort();
    return this.active?.promise?.catch(() => {});
  }
}

module.exports = { Monitors, inspectResult, definition, repairCommand, MIN_INTERVAL, MAX_INTERVAL };

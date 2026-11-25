const fs = require('node:fs');
const { join } = require('node:path');

// Snapshot the rate per connection: future rate changes must not rewrite history.
const RATE = { provider: 'OpenAI', model: 'gpt-live-1', usdPerMinute: .05, checkedAt: '2026-11-12',
  source: 'https://developers.openai.com/api/docs/pricing' };
const seconds = n => Number.isFinite(n) && n >= 0;

class VoiceUsage {
  constructor(api, { now = Date.now } = {}) {
    this.api = api; this.now = now; this.file = join(api.dataDir, 'usage.json'); this.error = '';
    this.data = { version: 1, since: now(), rows: [] };
    fs.mkdirSync(api.dataDir, { recursive: true, mode: 0o700 });
    try {
      if (fs.existsSync(this.file)) {
        if (fs.statSync(this.file).size > 16 * 1024 * 1024) throw Error('oversized');
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.rows) || saved.rows.some(r => typeof r.id !== 'string' || !Number.isFinite(r.startedAt))) throw Error('invalid');
        this.data = saved;
        // Never keep a timer running across an engine outage or invent final usage.
        for (const row of this.data.rows) if (!row.endedAt) { row.endedAt = row.seenAt; row.interrupted = true; }
      }
    } catch { this.error = 'Saved voice usage could not be read. Preserve usage.json before starting another voice conversation.'; }
    this.rows = new Map(this.data.rows.map(row => [row.id, row]));
  }
  save(sessionId) {
    if (this.error) return false;
    try {
      const value = JSON.stringify(this.data);
      if (Buffer.byteLength(value) > 16 * 1024 * 1024) throw Error('full');
      fs.writeFileSync(this.file + '.tmp', value, { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); return true;
    } catch {
      this.error = 'Voice usage could not be saved. Totals may be incomplete; check the plugin data directory.';
      this.api.reportError(sessionId, 'voice-usage-storage', this.error).catch(() => {}); return false;
    }
  }
  start(id, sessionId, name, kind) {
    if (this.error) throw Object.assign(Error(this.error), { definite: true });
    if (this.rows.has(id)) return;
    const row = { id, sessionId, name: String(name || sessionId).slice(0, 160), kind, ...RATE,
      startedAt: this.now(), seenAt: this.now(), endedAt: null, created: false, seconds: null, finalized: false };
    this.data.rows.push(row); this.rows.set(id, row);
    if (!this.save(sessionId)) throw Object.assign(Error(this.error), { definite: true });
  }
  created(id) { const row = this.rows.get(id); if (row) { row.created = true; row.seenAt = this.now(); this.save(row.sessionId); } }
  event(id, event) {
    const row = this.rows.get(id);
    if (!row || row.finalized || !['session.usage.updated', 'session.closed'].includes(event?.type)) return;
    const final = event.type === 'session.closed';
    if (seconds(event.usage?.seconds)) {
      // Cumulative snapshots replace the previous value; stale updates cannot add cost.
      row.seconds = final ? event.usage.seconds : Math.max(row.seconds || 0, event.usage.seconds);
      row.created = true; row.finalized = final;
    }
    row.seenAt = this.now(); if (final) row.endedAt = this.now(); this.save(row.sessionId);
  }
  end(id, definiteFailure = false) {
    const row = this.rows.get(id); if (!row || row.finalized) return;
    row.endedAt ||= this.now(); row.seenAt = this.now();
    if (definiteFailure && !row.created) { row.seconds = 0; row.finalized = true; }
    this.save(row.sessionId);
  }
  report({ days = 30, timeZone = 'UTC', sessionId = '' } = {}) {
    if (![7, 30, 90, 0].includes(days)) throw Error('Choose 7, 30, 90 days or all time.');
    if (typeof timeZone !== 'string' || timeZone.length > 100 || typeof sessionId !== 'string' || sessionId.length > 160) throw Error('Invalid usage filter.');
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const day = at => fmt.format(at), now = this.now(), today = day(now);
    const from = days ? new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10) : '0000-00-00';
    const buckets = new Map(), sessions = new Map(), kinds = new Map(), boundaries = new Map();
    const total = () => ({ seconds: 0, usd: 0, reportedSeconds: 0, estimatedSeconds: 0 });
    const totals = total(), unknown = new Set(), active = new Set(), connections = new Set();
    const availableSessions = new Map();
    for (const row of this.data.rows) {
      availableSessions.set(row.sessionId, { id: row.sessionId, name: row.name });
      if (sessionId && row.sessionId !== sessionId) continue;
      const end = row.endedAt ?? now, span = Math.max(1, end - row.startedAt);
      const duration = row.finalized ? row.seconds : row.created
        ? Math.max(row.seconds || 0, (end - row.startedAt) / 1000, row.kind === 'browser' ? 15 : 0) : null;
      // Allocate connections spanning midnight proportionally to time in each local day.
      for (let cursor = row.startedAt; cursor < row.startedAt + span;) {
        const key = day(cursor);
        if (!boundaries.has(key)) {
          let lo = cursor, hi = cursor + 27 * 3600000;
          while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (day(mid) === key) lo = mid; else hi = mid; }
          boundaries.set(key, hi);
        }
        const until = Math.min(row.startedAt + span, boundaries.get(key));
        if (key >= from && key <= today) {
          connections.add(row.id); if (!row.endedAt) active.add(row.id);
          if (duration === null) unknown.add(row.id);
          const n = (duration || 0) * (until - cursor) / span, usd = n / 60 * row.usdPerMinute;
          if (!buckets.has(key)) buckets.set(key, { day: key, ...total() });
          if (!sessions.has(row.sessionId)) sessions.set(row.sessionId, { id: row.sessionId, name: row.name, ...total() });
          sessions.get(row.sessionId).name = row.name;
          if (!kinds.has(row.kind)) kinds.set(row.kind, { kind: row.kind, ...total() });
          for (const item of [totals, buckets.get(key), sessions.get(row.sessionId), kinds.get(row.kind)]) {
            item.seconds += n; item.usd += usd; item[row.finalized ? 'reportedSeconds' : 'estimatedSeconds'] += n;
          }
        }
        cursor = until;
      }
    }
    return { since: this.data.since, updatedAt: now, timeZone, days, sessionId, rate: RATE, error: this.error,
      totals: { ...totals, connections: connections.size, active: active.size, unknown: unknown.size },
      daily: [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day)),
      sessions: [...sessions.values()].sort((a, b) => b.usd - a.usd),
      breakdown: [...kinds.values()], availableSessions: [...availableSessions.values()] };
  }
}
module.exports = { VoiceUsage, RATE };

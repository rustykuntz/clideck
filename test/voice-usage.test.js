const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { VoiceUsage } = require('../plugin-packages/voice-agent/usage');
function fixture(t, at = '2026-11-12T10:00:00Z') {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'voice-usage-')); let time = Date.parse(at);
  const api = { dataDir, reportError: async () => {} }, now = () => time;
  const usage = new VoiceUsage(api, { now });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { usage, api, now, advance: n => { time += n; }, report: filters => usage.report({ days: 0, timeZone: 'UTC', ...filters }) };
}
const approx = (a, b) => assert(Math.abs(a - b) < .000001, `${a} != ${b}`);
test('cumulative reports, duplicate finals and stale events never double bill', t => {
  const f = fixture(t), u = f.usage; u.start('a', 'session', 'My session', 'browser'); u.created('a');
  for (const n of [12, 15, 15, 10]) u.event('a', { type: 'session.usage.updated', usage: { seconds: n } });
  assert.equal(u.rows.get('a').seconds, 15);
  f.advance(90000); u.event('a', { type: 'session.closed', usage: { seconds: 90 } });
  u.event('a', { type: 'session.closed', usage: { seconds: 90 } }); u.event('a', { type: 'session.usage.updated', usage: { seconds: 999 } });
  const r = f.report(); approx(r.totals.seconds, 90); approx(r.totals.usd, .075); assert.equal(r.totals.connections, 1); assert.equal(r.totals.estimatedSeconds, 0);
  assert.equal(fs.statSync(join(f.api.dataDir, 'usage.json')).mode & 0o777, 0o600);
});
test('WebRTC initialization is provisional and is not added twice to final duration', t => {
  const f = fixture(t); f.usage.start('a', 's', 'Session', 'browser'); f.usage.created('a'); f.advance(3000);
  approx(f.report().totals.seconds, 15); approx(f.report().totals.usd, .0125);
  f.usage.event('a', { type: 'session.closed', usage: { seconds: 3 } });
  approx(f.report().totals.seconds, 3); approx(f.report().totals.usd, .0025);
});
test('each reconnect is counted once while session totals survive restart', t => {
  const f = fixture(t);
  for (const id of ['one', 'two']) { f.usage.start(id, 's', 'Work', 'browser'); f.usage.start(id, 's', 'Work', 'browser'); f.advance(60000); f.usage.event(id, { type: 'session.closed', usage: { seconds: 60 } }); }
  const reloaded = new VoiceUsage(f.api, { now: f.now }).report();
  assert.equal(reloaded.totals.connections, 2); assert.equal(reloaded.sessions.length, 1); approx(reloaded.totals.usd, .1);
});
test('restart never runs an interrupted timer through the outage', t => {
  const f = fixture(t); f.usage.start('a', 's', 'Work', 'browser'); f.usage.created('a'); f.advance(20000);
  f.usage.event('a', { type: 'session.usage.updated', usage: { seconds: 20 } }); f.advance(86400000);
  const restored = new VoiceUsage(f.api, { now: f.now }).report({ days: 0 });
  approx(restored.totals.seconds, 20); assert.equal(restored.totals.active, 0); assert.equal(restored.totals.reportedSeconds, 0);
});
test('midnight splits measured duration and cost in the viewer timezone', t => {
  const f = fixture(t, '2026-11-12T16:59:30Z'); f.usage.start('a', 's', 'Evening', 'browser'); f.usage.created('a');
  f.advance(120000); f.usage.event('a', { type: 'session.closed', usage: { seconds: 120 } });
  const r = f.report({ timeZone: 'Asia/Bangkok' });
  assert.deepEqual(r.daily.map(d => d.day), ['2026-11-12', '2026-11-13']);
  approx(r.daily[0].seconds, 30); approx(r.daily[1].seconds, 90); approx(r.daily.reduce((n,d) => n+d.usd, 0), r.totals.usd);
});
test('day boundaries handle daylight saving and period/session filters', t => {
  const f = fixture(t, '2026-11-01T03:59:00Z'); f.usage.start('a', 's1', 'One', 'phone'); f.usage.created('a');
  f.advance(26 * 3600000); f.usage.event('a', { type: 'session.closed', usage: { seconds: 2600 } });
  const r = f.report({ timeZone: 'America/New_York' });
  assert.deepEqual(r.daily.map(d => d.day), ['2026-10-31', '2026-11-01', '2026-11-02']); approx(r.daily[1].seconds, 2500);
  f.advance(31 * 86400000); assert.equal(f.report({ days: 30 }).totals.connections, 0); assert.equal(f.report({ sessionId: 'other' }).totals.usd, 0);
  assert.throws(() => f.report({ days: 999 })); assert.throws(() => f.report({ timeZone: 'invalid' }));
});
test('browser and phone cost breakdown reconciles, unknown creation is never free usage', t => {
  const f = fixture(t);
  for (const kind of ['browser', 'phone']) { f.usage.start(kind, kind, kind, kind); f.advance(60000); f.usage.event(kind, { type: 'session.closed', usage: { seconds: 60 } }); }
  f.usage.start('unknown', 's', 'Unknown', 'browser'); f.usage.end('unknown');
  const r = f.report(); approx(r.totals.usd, .1); approx(r.breakdown.reduce((n,b) => n+b.usd, 0), .1); assert.equal(r.totals.unknown, 1);
  const payload = JSON.stringify(r); assert(!payload.includes('transcript')); assert(!payload.includes('providerId'));
});
test('historical prices are frozen and unreadable history is not overwritten', t => {
  const f = fixture(t); f.usage.start('old', 's', 'Old', 'phone'); f.usage.rows.get('old').usdPerMinute = .02;
  f.advance(60000); f.usage.event('old', { type: 'session.closed', usage: { seconds: 60 } }); approx(f.report().totals.usd, .02);
  fs.writeFileSync(join(f.api.dataDir, 'usage.json'), 'broken'); const bad = new VoiceUsage(f.api, { now: f.now });
  assert.throws(() => bad.start('new', 's', 'New', 'browser'), /could not be read/);
  assert.equal(fs.readFileSync(join(f.api.dataDir, 'usage.json'), 'utf8'), 'broken'); assert.match(bad.report().error, /could not be read/);
});

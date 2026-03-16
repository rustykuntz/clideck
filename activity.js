// Per-session I/O tracking and burst detection.
// Broadcasts rate + burst data so the frontend can derive working/idle status.

let interval = null;
const net = {};    // id → byte counters
const stream = {}; // id → burst timing

function ensure(id) {
  if (!net[id]) net[id] = { in: 0, out: 0, prevIn: 0, prevOut: 0 };
  if (!stream[id]) stream[id] = { lastOutAt: 0, burstStart: 0 };
}

function trackIn(id, bytes) {
  ensure(id);
  net[id].in += bytes;
}

function trackOut(id, data) {
  ensure(id);
  const now = Date.now();
  const s = stream[id];
  net[id].out += data.length;
  if (now - s.lastOutAt > 2000) s.burstStart = now;
  s.lastOutAt = now;
}

function start(sessions, broadcast) {
  if (interval) return;
  interval = setInterval(() => {
    if (!sessions.size) return;
    const now = Date.now();
    const stats = {};
    for (const [id] of sessions) {
      ensure(id);
      const n = net[id];
      const s = stream[id];
      const rawRateOut = n.out - n.prevOut;
      const rawRateIn = n.in - n.prevIn;
      n.prevOut = n.out;
      n.prevIn = n.in;
      const silence = s.lastOutAt ? now - s.lastOutAt : 0;
      const burstMs = s.burstStart && silence < 2000 ? now - s.burstStart : 0;
      stats[id] = { rawRateOut, rawRateIn, burstMs };
    }
    if (Object.keys(stats).length) broadcast({ type: 'stats', stats });
  }, 1000);
}

function stop() {
  clearInterval(interval);
  interval = null;
}

function isActive(id) {
  const s = stream[id];
  return s ? (Date.now() - s.lastOutAt < 2000) : false;
}

function lastOutputAt(id) { return stream[id]?.lastOutAt || 0; }

function clear(id) { delete net[id]; delete stream[id]; }

module.exports = { start, stop, trackIn, trackOut, isActive, lastOutputAt, clear };

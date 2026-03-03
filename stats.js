// TEMPORARY: Process stats overlay — remove this file when done experimenting
const { execFile } = require('child_process');

let interval = null;
const net = {};    // id → byte counters
const stream = {}; // id → timing & content tracking

const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;

function ensure(id) {
  if (!net[id]) net[id] = { in: 0, out: 0, prevIn: 0, prevOut: 0 };
  if (!stream[id]) stream[id] = { lastOutAt: 0, burstStart: 0, chunks: 0, burstBytes: 0, lastLine: '' };
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

  // Burst detection: if gap > 2s, new burst
  if (now - s.lastOutAt > 2000) {
    s.burstStart = now;
    s.chunks = 0;
    s.burstBytes = 0;
  }
  s.lastOutAt = now;
  s.chunks++;
  s.burstBytes += data.length;

  // Extract last meaningful line
  const clean = data.replace(ANSI_RE, '').replace(/[^\x20-\x7E\n]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length) s.lastLine = lines[lines.length - 1].slice(0, 80);
}

function fmt(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function start(sessions, broadcast) {
  if (interval) return;

  interval = setInterval(() => {
    if (!sessions.size) return;

    const idByPgid = {};
    for (const [id, s] of sessions) {
      const pid = s.pty.pid;
      if (pid) idByPgid[pid] = id;
    }

    execFile('ps', ['ax', '-o', 'pgid=,pcpu=,rss='], (err, stdout) => {
      if (err) return;
      const now = Date.now();
      const totals = {};
      for (const line of stdout.trim().split('\n')) {
        const [pgid, cpu, rss] = line.trim().split(/\s+/);
        const id = idByPgid[+pgid];
        if (!id) continue;
        if (!totals[id]) totals[id] = { cpu: 0, memMB: 0 };
        totals[id].cpu += parseFloat(cpu);
        totals[id].memMB += +rss;
      }
      for (const [id, t] of Object.entries(totals)) {
        t.memMB = Math.round(t.memMB / 1024);
        const n = net[id];
        if (n) {
          t.netIn = fmt(n.in);
          t.netOut = fmt(n.out);
          t.rawRateOut = n.out - n.prevOut;
          t.rawRateIn = n.in - n.prevIn;
          t.rateIn = fmt(t.rawRateIn) + '/s';
          t.rateOut = fmt(t.rawRateOut) + '/s';
          n.prevIn = n.in;
          n.prevOut = n.out;
        }
        const s = stream[id];
        if (s) {
          const silence = s.lastOutAt ? now - s.lastOutAt : 0;
          const burstDur = s.burstStart && silence < 2000 ? now - s.burstStart : 0;
          t.silenceMs = silence;
          t.silence = silence >= 1000 ? (silence / 1000).toFixed(1) + 's' : silence + 'ms';
          t.burstMs = burstDur;
          t.burst = burstDur >= 1000 ? (burstDur / 1000).toFixed(1) + 's' : burstDur + 'ms';
          t.chunks = s.chunks;
          t.avgChunk = s.chunks ? Math.round(s.burstBytes / s.chunks) : 0;
          t.lastLine = s.lastLine;
        }
      }
      if (Object.keys(totals).length) broadcast({ type: 'stats', stats: totals });
    });
  }, 1000);
}

function stop() {
  clearInterval(interval);
  interval = null;
}

function clear(id) { delete net[id]; delete stream[id]; }

module.exports = { start, stop, trackIn, trackOut, clear };

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const IDLE_SECONDS = 600;

async function macPresence() {
  if (process.platform !== 'darwin') return { supported: false, away: false };
  const [hid, root] = await Promise.all([
    exec('/usr/sbin/ioreg', ['-r', '-c', 'IOHIDSystem', '-d', '1'], { timeout: 2000, maxBuffer: 1024 * 1024 }),
    exec('/usr/sbin/ioreg', ['-n', 'Root', '-d', '1'], { timeout: 2000, maxBuffer: 1024 * 1024 }),
  ]);
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid.stdout);
  if (!idle) return { supported: false, away: false };
  const consoleLine = root.stdout.split('\n').find(line => line.includes('"IOConsoleUsers"')) || '';
  const consoleUser = consoleLine.split(/},\s*{/).find(row => /"kCGSSessionOnConsoleKey"\s*=\s*Yes/.test(row));
  const locked = Boolean(consoleUser && /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(consoleUser));
  return { supported: true, away: locked || Number(idle[1]) / 1e9 >= IDLE_SECONDS };
}

class Presence {
  constructor({ mode = 'auto', probe = macPresence, onChange = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
    this.mode = mode; this.probe = probe; this.onChange = onChange; this.timers = timers;
    this.observed = { supported: false, away: false }; this.enabled = false; this.timer = null; this.checking = null;
  }
  snapshot() { return { mode: this.mode, away: this.mode === 'away' || (this.mode === 'auto' && this.observed.away),
    supported: this.observed.supported, idleSeconds: IDLE_SECONDS }; }
  setMode(mode) {
    if (!['auto', 'here', 'away'].includes(mode)) throw Error('Use Auto, Here or Away.');
    this.mode = mode; this.onChange();
  }
  enable(value) {
    if (this.enabled === value) return;
    this.enabled = value;
    if (value) this.check();
    else { this.timers.clearTimeout(this.timer); this.timer = null; }
  }
  async check() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const before = JSON.stringify(this.snapshot());
      try { this.observed = await this.probe(); } catch { this.observed = { supported: false, away: false }; }
      if (before !== JSON.stringify(this.snapshot())) this.onChange();
    })();
    try { await this.checking; } finally {
      this.checking = null;
      if (this.enabled) {
        this.timers.clearTimeout(this.timer);
        this.timer = this.timers.setTimeout(() => this.check(), 30_000); this.timer?.unref?.();
      }
    }
  }
  close() { this.enable(false); return this.checking; }
}

module.exports = { Presence, macPresence, IDLE_SECONDS };

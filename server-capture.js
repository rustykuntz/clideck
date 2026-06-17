const transcript = require('./transcript');
const builder = require('./transcript-normalizer');
const parser = require('./transcript-parser');

const ENABLED = process.env.CLIDECK_SERVER_CAPTURE === '1';
const AGENT_PRESETS = new Set(['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi', 'clideck-agent']);
const MAX_HISTORY_LINES = Math.max(200, Number(process.env.CLIDECK_SERVER_CAPTURE_LINES || 2000));

const captures = new Map();
const candidates = new Map();

function nparam(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function setChar(line, idx, ch) {
  const chars = Array.from(line || '');
  while (chars.length < idx) chars.push(' ');
  chars[idx] = ch;
  return chars.join('');
}

class ScreenCapture {
  constructor(cols, rows) {
    this.cols = Math.max(20, Number(cols || 80));
    this.rows = Math.max(5, Number(rows || 24));
    this.x = 0;
    this.y = 0;
    this.history = [];
    this.screen = Array.from({ length: this.rows }, () => '');
    this.state = 'normal';
    this.seq = '';
    this.oscEsc = false;
  }

  resize(cols, rows) {
    this.cols = Math.max(20, Number(cols || this.cols));
    const nextRows = Math.max(5, Number(rows || this.rows));
    while (this.screen.length > nextRows) this.history.push(this.screen.shift() || '');
    while (this.screen.length < nextRows) this.screen.push('');
    this.rows = nextRows;
    this.y = Math.min(this.y, this.rows - 1);
    this.x = Math.min(this.x, this.cols - 1);
    this.trimHistory();
  }

  trimHistory() {
    if (this.history.length > MAX_HISTORY_LINES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_LINES);
    }
  }

  scroll(n = 1) {
    for (let i = 0; i < n; i++) {
      this.history.push(this.screen.shift() || '');
      this.screen.push('');
    }
    this.y = this.rows - 1;
    this.trimHistory();
  }

  newline() {
    if (this.y >= this.rows - 1) this.scroll(1);
    else this.y++;
  }

  put(ch) {
    if (this.x >= this.cols) {
      this.x = 0;
      this.newline();
    }
    this.screen[this.y] = setChar(this.screen[this.y], this.x, ch);
    this.x++;
  }

  eraseLine(mode) {
    const line = this.screen[this.y] || '';
    if (mode === 2) {
      this.screen[this.y] = '';
    } else if (mode === 1) {
      this.screen[this.y] = ' '.repeat(this.x) + line.slice(this.x);
    } else {
      this.screen[this.y] = line.slice(0, this.x);
    }
  }

  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.history = [];
      this.screen = Array.from({ length: this.rows }, () => '');
      this.x = 0;
      this.y = 0;
      return;
    }
    if (mode === 1) {
      for (let i = 0; i < this.y; i++) this.screen[i] = '';
      this.screen[this.y] = (this.screen[this.y] || '').slice(this.x);
      return;
    }
    this.eraseLine(0);
    for (let i = this.y + 1; i < this.rows; i++) this.screen[i] = '';
  }

  handleCsi(seq) {
    const final = seq[seq.length - 1];
    const raw = seq.slice(0, -1).replace(/[?=]/g, '');
    const parts = raw.split(';').filter(Boolean);
    const a = nparam(parts[0], 1);
    const b = nparam(parts[1], 1);
    if (final === 'A') this.y = Math.max(0, this.y - a);
    else if (final === 'B') this.y = Math.min(this.rows - 1, this.y + a);
    else if (final === 'C') this.x = Math.min(this.cols - 1, this.x + a);
    else if (final === 'D') this.x = Math.max(0, this.x - a);
    else if (final === 'G') this.x = Math.min(this.cols - 1, Math.max(0, a - 1));
    else if (final === 'H' || final === 'f') {
      this.y = Math.min(this.rows - 1, Math.max(0, a - 1));
      this.x = Math.min(this.cols - 1, Math.max(0, b - 1));
    } else if (final === 'K') this.eraseLine(Number(parts[0] || 0));
    else if (final === 'J') this.eraseDisplay(Number(parts[0] || 0));
    else if (final === 'S') this.scroll(a);
  }

  write(data) {
    for (const ch of Array.from(String(data || ''))) {
      if (this.state === 'osc') {
        if (ch === '\x07') { this.state = 'normal'; this.oscEsc = false; continue; }
        if (this.oscEsc && ch === '\\') { this.state = 'normal'; this.oscEsc = false; continue; }
        this.oscEsc = ch === '\x1b';
        continue;
      }
      if (this.state === 'csi') {
        this.seq += ch;
        if (ch >= '@' && ch <= '~') {
          this.handleCsi(this.seq);
          this.seq = '';
          this.state = 'normal';
        }
        continue;
      }
      if (this.state === 'esc') {
        if (ch === '[') { this.state = 'csi'; this.seq = ''; continue; }
        if (ch === ']') { this.state = 'osc'; this.oscEsc = false; continue; }
        this.state = 'normal';
        continue;
      }

      if (ch === '\x1b') { this.state = 'esc'; continue; }
      if (ch === '\r') { this.x = 0; continue; }
      if (ch === '\n') { this.newline(); continue; }
      if (ch === '\b' || ch === '\x7f') { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === '\t') {
        const next = Math.min(this.cols, this.x + (8 - (this.x % 8)));
        while (this.x < next) this.put(' ');
        continue;
      }
      if (ch >= ' ') this.put(ch);
    }
  }

  lines() {
    const all = [...this.history, ...this.screen].map(l => String(l || '').replace(/[ \t]+$/g, ''));
    while (all.length && !all[all.length - 1].trim()) all.pop();
    return all.slice(-MAX_HISTORY_LINES);
  }
}

function ensure(id, presetId, cols, rows) {
  if (!ENABLED || !AGENT_PRESETS.has(presetId)) return null;
  let cap = captures.get(id);
  if (!cap) {
    cap = new ScreenCapture(cols, rows);
    captures.set(id, cap);
  }
  return cap;
}

function create(id, presetId, cols, rows) {
  ensure(id, presetId, cols, rows);
}

function latestAgentText(presetId, lines, users) {
  const turns = parser.parseTurns(presetId, lines, users);
  const last = turns?.length ? turns[turns.length - 1] : parser.parseLastAgentOnly(presetId, lines);
  if (last?.role !== 'agent') return '';
  return builder.cleanAgentText(presetId, last.text);
}

function updateCandidate(id, presetId, lines, users) {
  const text = latestAgentText(presetId, lines, users);
  if (text) candidates.set(id, text);
  return text;
}

function update(id, presetId, data, cols, rows) {
  const cap = ensure(id, presetId, cols, rows);
  if (!cap) return null;
  cap.write(data);
  const lines = cap.lines();
  updateCandidate(id, presetId, lines, transcript.getUserTexts(id));
  return lines;
}

function resize(id, cols, rows) {
  captures.get(id)?.resize(cols, rows);
}

function commit(id, presetId) {
  if (!ENABLED || !captures.has(id)) return false;
  const text = candidates.get(id);
  if (!text) return false;
  transcript.commitExternalAgentText(id, presetId, text);
  return true;
}

function getLines(id) {
  return captures.get(id)?.lines() || [];
}

function getCandidate(id) {
  return candidates.get(id) || '';
}

function clear(id) {
  captures.delete(id);
  candidates.delete(id);
}

module.exports = { enabled: ENABLED, create, update, updateCandidate, resize, commit, getLines, getCandidate, clear, ScreenCapture, latestAgentText };

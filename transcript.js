const { appendFile, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } = require('fs');
const { join, basename } = require('path');
const { DATA_DIR } = require('./paths');

const DIR = join(DATA_DIR, 'transcripts');
const ANSI_RE = /\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.|\r|\x07/g;
const MAX_CACHE = 50 * 1024;

const inputBuf = {};
const outputBuf = {};
const cache = {};
const prefixes = {};
const userTexts = {}; // sessionId → [text, ...] — user prompts for parser matching
let broadcast = null;
let notifyPlugin = null;

function init(bc, validIds, pluginNotify) {
  broadcast = bc;
  notifyPlugin = pluginNotify || null;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  // Clean up orphaned .screen files (no matching .jsonl or session)
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.screen'))) {
    const id = basename(file, '.screen');
    if (!existsSync(fpath(id)) && (!validIds || !validIds.has(id))) { try { unlinkSync(join(DIR, file)); } catch {} }
  }
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl');
    if (validIds && !validIds.has(id)) { try { unlinkSync(join(DIR, file)); } catch {} continue; }
    try {
      const lines = readFileSync(join(DIR, file), 'utf8').trim().split('\n');
      cache[id] = lines.map(l => { try { return JSON.parse(l).text; } catch { return ''; } }).join('\n');
      if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
    } catch {}
  }
}

function fpath(id) { return join(DIR, `${id}.jsonl`); }
function setPrefix(id, prefix) { prefixes[id] = prefix; }

function store(id, role, text) {
  const prefix = prefixes[id] || '';
  appendFile(fpath(id), JSON.stringify({ ts: Date.now(), role, text, ...(prefix && { prefix }) }) + '\n', () => {});
  if (!cache[id]) cache[id] = '';
  cache[id] += '\n' + text;
  if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
  if (broadcast) broadcast({ type: 'transcript.append', id, role, text });
  if (notifyPlugin) notifyPlugin(id, role, text);
}

function trackInput(id, data) {
  if (!inputBuf[id]) inputBuf[id] = { text: '', esc: false, osc: false };
  const buf = inputBuf[id];
  for (const ch of data) {
    // OSC sequence: ESC ] ... (terminated by BEL or ESC \)
    if (buf.osc) {
      if (ch === '\x07') { buf.osc = false; continue; }                    // BEL terminator
      if (ch === '\\' && buf.escPending) { buf.osc = false; buf.escPending = false; continue; } // ESC \ terminator
      buf.escPending = (ch === '\x1b');
      continue;
    }
    if (ch === '\x1b') { buf.esc = true; continue; }
    if (buf.esc) {
      buf.esc = false;
      if (ch === ']') { buf.osc = true; continue; }                        // Start OSC
      if (ch === '[') { buf.csi = true; continue; }                        // Start CSI
      continue;                                                            // Simple ESC + char
    }
    // CSI sequence: ESC [ ... (terminated by letter or ~)
    if (buf.csi) {
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '~') buf.csi = false;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const line = buf.text.trim();
      if (line) { store(id, 'user', line); if (!userTexts[id]) userTexts[id] = []; userTexts[id].push(line); }
      buf.text = '';
    } else if (ch === '\x7f' || ch === '\x08') {
      const chars = Array.from(buf.text);
      chars.pop();
      buf.text = chars.join('');
    } else if (ch >= ' ') {
      buf.text += ch;
    }
  }
}

// Server-side fallback: captures raw PTY output (noisy but always available)
function trackOutput(id, data) {
  if (!outputBuf[id]) outputBuf[id] = { text: '', timer: null };
  const buf = outputBuf[id];
  buf.text += data;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(id), 300);
}

function flush(id) {
  const buf = outputBuf[id];
  if (!buf?.text) return;
  const clean = buf.text.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  buf.text = '';
  if (lines.length) store(id, 'agent', lines.join('\n'));
}

// Browser-side clean snapshot: overwrites a per-session file with the full
// xterm buffer as rendered by the browser. No diffing, no JSONL — just the
// clean screen content. Mobile reads this for "last agent message".
function storeBuffer(id, lines) {
  const isChrome = t => !t
    || /^[─━═\u2500-\u257f]+$/.test(t)                    // box-drawing horizontal lines
    || /^[▀▄█▌▐░▒▓╭╮╰╯│╔╗╚╝║]+$/.test(t)                 // block elements, box corners, vertical bars
    || (/[█▀▄▌▐░▒▓]/.test(t) && /^[█▀▄▌▐░▒▓\s]+$/.test(t)) // ASCII art (blocks + whitespace, e.g. logos)
    || /^[❯>$%#]\s*$/.test(t)                              // bare prompt markers
    || /^(esc to interrupt|\? for shortcuts)$/i.test(t);   // Claude Code chrome
  const filtered = lines.filter(l => !isChrome(l.trim()));
  while (filtered.length && !filtered[filtered.length - 1].trim()) filtered.pop();
  const screenPath = join(DIR, `${id}.screen`);
  if (filtered.length) writeFileSync(screenPath, filtered.join('\n'));
  else try { unlinkSync(screenPath); } catch {}
}

// Read the clean screen snapshot for a session (if available).
function getScreen(id) {
  const file = join(DIR, `${id}.screen`);
  if (!existsSync(file)) return null;
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

// Per-agent screen parsers. Each returns [{role, text}] from .screen content.
const agentParsers = {
  'claude-code': (lines, id) => {
    const known = userTexts[id]?.length ? new Set(userTexts[id]) : null;
    const turns = [];
    let current = null;
    for (const line of lines) {
      const agent = line.match(/^(?:[│ ]\s*)?[⏺•●]\s(.*)$/);
      if (agent) {
        if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
        current = { role: 'agent', text: agent[1] };
        continue;
      }
      const userM = line.match(/^(?:[│ ]\s*)?[❯›]\s(.*)$/);
      if (userM && (known ? known.has(userM[1].trim()) : true)) {
        if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
        current = { role: 'user', text: userM[1] };
        continue;
      }
      if (!current) continue;
      let cont = line;
      if (cont.startsWith('│ ')) cont = cont.slice(2);
      else if (cont.startsWith('  ')) cont = cont.slice(2);
      current.text += '\n' + cont;
    }
    if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
    return turns.length >= 2 ? turns : null;
  },
  'codex': (lines, id) => {
    const known = userTexts[id]?.length ? new Set(userTexts[id]) : null;
    const turns = [];
    let current = null;
    for (const line of lines) {
      const agent = line.match(/^(?:│\s*)?•\s(.*)$/);
      if (agent) {
        if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
        current = { role: 'agent', text: agent[1] };
        continue;
      }
      const userM = line.match(/^(?:│\s*)?›\s(.*)$/);
      if (userM && (known ? known.has(userM[1].trim()) : true)) {
        if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
        current = { role: 'user', text: userM[1] };
        continue;
      }
      if (!current) continue;
      let cont = line;
      if (cont.startsWith('│ ')) cont = cont.slice(2);
      else if (cont.startsWith('  ')) cont = cont.slice(2);
      current.text += '\n' + cont;
    }
    if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
    return turns.length >= 2 ? turns : null;
  },
  'gemini-cli': (lines, id) => {
    const known = userTexts[id]?.length ? new Set(userTexts[id]) : null;
    const geminiChrome = t => {
      const s = t.trim();
      return /^shift\+tab to accept/i.test(s)
        || /^(Type your message|@path\/to\/)/i.test(s)
        || /^(\/\w+ |no sandbox|\/model )/i.test(s)
        || /^[~\/\\].*\(main[*]?\)\s*$/i.test(s)
        || /^(Logged in with|Plan:|Tips for getting started)/i.test(s)
        || /^\d+\.\s+(Ask questions|Be specific|Create GEMINI)/i.test(s)
        || /^ℹ\s/.test(s);
    };
    const turns = [];
    let current = null;
    for (const line of lines) {
      if (geminiChrome(line)) continue;
      const isAgent = line.startsWith('✦ ');
      const userM = line.startsWith(' > ') ? line.slice(3) : null;
      const isUser = userM && (known ? known.has(userM.trim()) : true);
      if (isUser || isAgent) {
        if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
        current = { role: isUser ? 'user' : 'agent', text: isUser ? userM : line.slice(2) };
        continue;
      }
      if (!current) continue;
      current.text += '\n' + line;
    }
    if (current) { current.text = current.text.replace(/\n+$/, ''); turns.push(current); }
    return turns.length >= 2 ? turns : null;
  },
};

// Fallback anchor parser for agents without a dedicated parser.
// Uses JSONL user inputs to find prompt lines in the screen.
function anchorParse(id, lines) {
  const file = fpath(id);
  if (!existsSync(file)) return null;
  const users = [];
  try {
    for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
      try { const e = JSON.parse(l); if (e.role === 'user') users.push(e.text); } catch {}
    }
  } catch { return null; }
  if (!users.length) return null;

  const isPrompt = (line, text) => { const t = line.trim(); return t.endsWith(text) && t.length - text.length <= 6; };

  const lastUser = users[users.length - 1];
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isPrompt(lines[i], lastUser)) { lastIdx = i; break; }
  }
  if (lastIdx < 0) return null;

  const anchors = [{ idx: lastIdx, text: lastUser }];
  for (let u = users.length - 2; u >= 0 && anchors.length < 3; u--) {
    for (let i = anchors[anchors.length - 1].idx - 1; i >= 0; i--) {
      if (isPrompt(lines[i], users[u])) { anchors.push({ idx: i, text: users[u] }); break; }
    }
  }
  anchors.reverse();

  const turns = [];
  for (let p = 0; p < anchors.length; p++) {
    turns.push({ role: 'user', text: anchors[p].text });
    const start = anchors[p].idx + 1;
    const end = p + 1 < anchors.length ? anchors[p + 1].idx : lines.length;
    const agentLines = lines.slice(start, end).filter(l => l.trim());
    if (agentLines.length) turns.push({ role: 'agent', text: agentLines.join('\n') });
  }
  if (turns.length < 2 || turns[turns.length - 1].role !== 'agent') return null;
  return turns;
}

// For consecutive agent turns, keep only the last one (strips tool output, keeps conversational response).
function collapseAgentTurns(turns) {
  if (!turns?.length) return turns;
  const result = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'agent' && i + 1 < turns.length && turns[i + 1].role === 'agent') continue;
    result.push(turns[i]);
  }
  return result;
}

// Parse .screen into structured turns — use agent-specific parser if available, else anchor fallback.
// opts.raw: if true, preserve trailing user turn (needed by autopilot for freshness checks).
function getScreenTurns(id, agent, opts) {
  const screen = getScreen(id);
  if (!screen) return null;
  const lines = screen.split('\n');
  const parser = agentParsers[agent];
  const turns = collapseAgentTurns(parser ? parser(lines, id) : anchorParse(id, lines));
  // Drop trailing user turn — it's the empty prompt or unanswered input
  if (!opts?.raw && turns?.length && turns[turns.length - 1].role === 'user') turns.pop();
  return turns?.length >= 2 ? turns : null;
}

function getLastTurns(id, n) {
  n = n || 4;
  const file = fpath(id);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const turns = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (turns.length && turns[turns.length - 1].role === entry.role) {
        turns[turns.length - 1].text = entry.text + '\n' + turns[turns.length - 1].text;
      } else {
        turns.push({ role: entry.role, text: entry.text });
        if (turns.length >= n) break;
      }
    }
    return turns.reverse();
  } catch { return []; }
}

function getCache() { return { ...cache }; }

function clear(id) {
  flush(id);
  delete inputBuf[id];
  if (outputBuf[id]) {
    clearTimeout(outputBuf[id].timer);
    delete outputBuf[id];
  }
  delete cache[id];
  delete prefixes[id];
  delete userTexts[id];
  try { unlinkSync(join(DIR, `${id}.screen`)); } catch {}
}

// Detect interactive menus from raw screen lines. Returns [{value, label, selected}] or null.
// Finds the footer line, then walks upward collecting only the contiguous menu block.
const MENU_MARKERS = { 'claude-code': /[❯›]/, codex: /[›❯]/, 'gemini-cli': /●/ };
const MENU_CHOICE_RE = /^\s*(?:[│❯›●•]\s+)*(\d+)\.\s+(.+)$/;
function detectMenu(lines, presetId) {
  const marker = MENU_MARKERS[presetId];
  if (!marker) return null;
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\besc\b|\(esc\)/i.test(lines[i])) { footerIdx = MENU_CHOICE_RE.test(lines[i]) ? i + 1 : i; break; }
  }
  if (footerIdx < 0) return null;
  const choices = [];
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (!lines[i].trim() || /^[│\s]+$/.test(lines[i])) continue;
    const m = lines[i].match(MENU_CHOICE_RE);
    if (!m) break;
    if (choices.length && +m[1] >= +choices[0].value) break;
    choices.unshift({ value: m[1], label: m[2].trim(), selected: marker.test(lines[i]) });
  }
  if (!choices.some(c => c.selected)) return null;
  return choices.length ? choices : null;
}

module.exports = { init, trackInput, trackOutput, storeBuffer, getScreen, getScreenTurns, getLastTurns, getCache, clear, setPrefix, detectMenu };

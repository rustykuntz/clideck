const { appendFile, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } = require('fs');
const { join, basename } = require('path');
const { DATA_DIR } = require('./paths');
const builder = require('./transcript-normalizer');
const parser = require('./transcript-parser');
const candidate = require('./transcript-candidate');
const { stripAnsi } = require('./ansi-utils');
const { lineageOf } = require('./lineage');

const DIR = join(DATA_DIR, 'transcripts');
const MAX_CACHE = 50 * 1024;
const LEGACY_SUFFIXES = ['-parsed.jsonl', '.screen'];

const inputBuf = {};
const outputBuf = {};
const cache = {};
const prefixes = {};
const entriesById = {};
const userTexts = {}; // sessionId → [text, ...] — user prompts for parser matching
const finalizePreset = {};
const lastAgentText = {};
let broadcast = null;
let notifyPlugin = null;

function tlog(id, msg) {
  // console.log(`[transcript:${id.slice(0,8)}] ${msg}`);
}

function clog(id, msg) {
  if (finalizePreset[id] !== 'claude-code') return;
  // console.log(`[claude:transcript:${id.slice(0,8)}] ${msg}`);
}

function init(bc, validIds, pluginNotify) {
  broadcast = bc;
  notifyPlugin = pluginNotify || null;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  for (const file of readdirSync(DIR).filter(f => LEGACY_SUFFIXES.some(s => f.endsWith(s)))) {
    try { unlinkSync(join(DIR, file)); } catch {}
  }
  for (const file of readdirSync(DIR).filter(f => f.endsWith('.jsonl'))) {
    const id = basename(file, '.jsonl');
    if (validIds && !validIds.has(id)) { try { unlinkSync(join(DIR, file)); } catch {} continue; }
    try {
      const lines = readFileSync(join(DIR, file), 'utf8').trim().split('\n').filter(Boolean);
      entriesById[id] = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      cache[id] = entriesById[id].map(e => e.text).join('\n');
      if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
    } catch {}
  }
}

function fpath(id) { return join(DIR, `${id}.jsonl`); }
function setPrefix(id, prefix) { prefixes[id] = prefix; }
function setFinalizeOnIdle(id, presetId) {
  if (!presetId) { delete finalizePreset[id]; return; }
  presetId = lineageOf(presetId);  // agy → claude-code: reuse claude's finalize/parse path
  finalizePreset[id] = presetId;
  entriesById[id] = builder.compactEntries(entriesById[id], presetId);
}

function rewrite(id) {
  const entries = entriesById[id] || [];
  writeFileSync(fpath(id), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  cache[id] = entries.map(e => e.text).join('\n');
  if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
  tlog(id, `rewrite entries=${entries.length} last=${entries.length ? entries[entries.length - 1].role : 'none'}`);
  clog(id, `rewrite entries=${entries.length} last=${entries.length ? entries[entries.length - 1].role : 'none'}`);
}

function store(id, role, text) {
  const prefix = prefixes[id] || '';
  if (finalizePreset[id]) {
    if (!entriesById[id]) entriesById[id] = [];
    const entry = { ts: Date.now(), role, text, ...(prefix && { prefix }) };
    tlog(id, `store role=${role} finalize=${finalizePreset[id]} raw=${JSON.stringify(String(text).slice(0, 160))}`);
    builder.addEntry(entriesById[id], entry, finalizePreset[id]);
    rewrite(id);
  } else {
    tlog(id, `store role=${role} append raw=${JSON.stringify(String(text).slice(0, 160))}`);
    appendFile(fpath(id), JSON.stringify({ ts: Date.now(), role, text, ...(prefix && { prefix }) }) + '\n', () => {});
    if (!cache[id]) cache[id] = '';
    cache[id] += '\n' + text;
    if (cache[id].length > MAX_CACHE) cache[id] = cache[id].slice(-MAX_CACHE);
  }
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
      if (line) {
        delete lastAgentText[id];
        candidate.clear(id);
        store(id, 'user', line);
        if (!userTexts[id]) userTexts[id] = [];
        userTexts[id].push(line);
      }
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

function recordInjectedInput(id, text) {
  delete lastAgentText[id];
  candidate.clear(id);
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    store(id, 'user', line);
    if (!userTexts[id]) userTexts[id] = [];
    userTexts[id].push(line);
  }
}

// Server-side fallback: captures raw PTY output (noisy but always available)
function trackOutput(id, data) {
  if (finalizePreset[id]) return;
  if (!outputBuf[id]) outputBuf[id] = { text: '', timer: null };
  const buf = outputBuf[id];
  buf.text += data;
  clearTimeout(buf.timer);
  buf.timer = setTimeout(() => flush(id), 300);
}

function flush(id) {
  const buf = outputBuf[id];
  if (!buf?.text) return;
  const clean = stripAnsi(buf.text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  buf.text = '';
  if (lines.length) store(id, 'agent', lines.join('\n'));
}

function parseTurnsFromLines(id, agent, lines, opts) {
  const turns = parser.parseTurns(agent, lines, getUsers(id));
  if (!opts?.raw && turns?.length && turns[turns.length - 1].role === 'user') turns.pop();
  tlog(id, `parse agent=${agent} lines=${lines?.length || 0} turns=${turns?.map(t => t.role).join(',') || 'none'}`);
  return turns?.length >= 2 ? turns : null;
}

function updateAgentCandidate(id, presetId, lines) {
  candidate.update(id, presetId, lines, getUsers(id));
}

function commitAgentCandidate(id, presetId) {
  if (!finalizePreset[id]) return;
  const text = candidate.get(id);
  if (!text) { tlog(id, 'candidate commit skip empty'); clog(id, 'candidate commit skip empty'); return; }
  if (text === lastAgentText[id]) { tlog(id, 'candidate commit skip duplicate'); clog(id, 'candidate commit skip duplicate'); return; }
  lastAgentText[id] = text;
  store(id, 'agent', text);
}

function clearAgentCandidate(id) {
  candidate.clear(id);
}

function getUsers(id) {
  if (userTexts[id]?.length) return userTexts[id];
  return (entriesById[id] || []).filter(e => e.role === 'user').map(e => e.text);
}

function readEntries(id) {
  const file = fpath(id);
  if (!existsSync(file)) return [];
  try {
    const cached = entriesById[id];
    if (Array.isArray(cached) && cached.length) return cached;
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function getEntriesSince(id, ts) {
  return readEntries(id).filter(e => Number(e.ts || 0) >= ts);
}

function foldTurns(entries, n, order) {
  const turns = [];
  const fromStart = order === 'start';
  const list = fromStart ? entries : [...entries].reverse();
  for (const entry of list) {
    if (turns.length && turns[turns.length - 1].role === entry.role) {
      if (fromStart) turns[turns.length - 1].text += '\n' + entry.text;
      else turns[turns.length - 1].text = entry.text + '\n' + turns[turns.length - 1].text;
    } else {
      turns.push({ role: entry.role, text: entry.text });
      if (turns.length >= n) break;
    }
  }
  return fromStart ? turns : turns.reverse();
}

function getTurns(id, n, order) {
  n = n || 4;
  return foldTurns(readEntries(id), n, order || 'end');
}

function getCache() { return { ...cache }; }

function hasSettledReplay(entries) {
  return entries?.some(e => e.role === 'agent') && entries[entries.length - 1]?.role === 'agent';
}

function getReplayText(id, presetId) {
  presetId = lineageOf(presetId);  // agy renders claude-style ❯/⏺ markers
  const entries = builder.compactEntries(entriesById[id], presetId);
  if (!hasSettledReplay(entries)) return '';
  const marks = {
    'claude-code': { user: '❯', agent: '⏺' },
    codex: { user: '›', agent: '•' },
    'gemini-cli': { user: '>', agent: '✦' },
    opencode: { user: '›', agent: '•' },
    pi: { user: '›', agent: '•' },
  }[presetId] || { user: '›', agent: '•' };
  return entries.map(e => `${e.role === 'user' ? marks.user : marks.agent} ${e.text}`).join('\n\n');
}

function clear(id) {
  flush(id);
  delete inputBuf[id];
  if (outputBuf[id]) {
    clearTimeout(outputBuf[id].timer);
    delete outputBuf[id];
  }
  delete cache[id];
  delete entriesById[id];
  delete prefixes[id];
  delete userTexts[id];
  delete lastAgentText[id];
  delete finalizePreset[id];
  candidate.clear(id);
}

// Detect interactive menus from raw screen lines. Returns [{value, label, selected}] or null.
// Finds the footer line, then walks upward collecting only the contiguous menu block.
const MENU_MARKERS = { 'claude-code': /[❯›]/, codex: /[›❯]/, 'gemini-cli': /●/ };
const MENU_CHOICE_RE = /^\s*(?:[│❯›●•]\s+)*(\d+)\.\s+(.+)$/;
const MENU_TOP_RE = /^\s*[╭┌┏╔].*[╮┐┓╗]\s*$/;
const MENU_BOTTOM_RE = /^\s*[╰└┗╚].*[╯┘┛╝]\s*$/;
const MENU_RULE_RE = /^\s*[─━═-]{5,}\s*$/;
const TURN_MARKERS = {
  'claude-code': /^(?:[│ ]\s*)?[⏺•●❯›]\s/,
  codex: /^(?:│\s*)?[•›]\s/,
  'gemini-cli': /^(?:✦| > )/,
};

function cleanMenuLabel(text) {
  return String(text || '').replace(/[│┃║]\s*$/u, '').trim();
}

function detectMenuBlock(lines, presetId) {
  presetId = lineageOf(presetId);  // agy uses claude-style ❯/› menu chrome
  const marker = MENU_MARKERS[presetId];
  if (!marker) return null;
  // Only scan the bottom 40 lines — menus are always near the visible area
  const scanStart = Math.max(0, lines.length - 40);
  let footerLineIdx = -1;
  for (let i = lines.length - 1; i >= scanStart; i--) {
    if (/\besc\b|\(esc\)/i.test(lines[i])) { footerLineIdx = i; break; }
  }
  if (footerLineIdx < 0) return null;
  const choices = [];
  let firstChoiceIdx = -1;
  const searchFrom = MENU_CHOICE_RE.test(lines[footerLineIdx]) ? footerLineIdx : footerLineIdx - 1;
  for (let i = searchFrom; i >= scanStart; i--) {
    if (!lines[i].trim() || /^[│\s]+$/.test(lines[i])) continue;
    if (MENU_RULE_RE.test(lines[i]) || MENU_BOTTOM_RE.test(lines[i])) continue;
    const m = lines[i].match(MENU_CHOICE_RE);
    if (!m) { if (choices.length && /^\s{2,}\S/.test(lines[i])) continue; break; }
    if (choices.length && +m[1] >= +choices[0].value) break;
    choices.unshift({ value: m[1], label: cleanMenuLabel(m[2]), selected: marker.test(lines[i]) });
    firstChoiceIdx = i;
  }
  if (!choices.some(c => c.selected)) return null;
  if (!choices.length) return null;
  let startIdx = firstChoiceIdx;
  const turnMarker = TURN_MARKERS[presetId];
  for (let i = startIdx - 1; i >= scanStart; i--) {
    if (turnMarker?.test(lines[i])) break;
    if (lines[i].trim()) startIdx = i;
    if (MENU_TOP_RE.test(lines[i])) { startIdx = i; break; }
  }
  let endIdx = footerLineIdx;
  if (MENU_CHOICE_RE.test(lines[footerLineIdx])) {
    for (let i = footerLineIdx + 1; i < Math.min(lines.length, footerLineIdx + 6); i++) {
      if (MENU_BOTTOM_RE.test(lines[i])) { endIdx = i; break; }
    }
  }
  return { choices, startIdx, endIdx };
}

function detectMenu(lines, presetId) {
  return detectMenuBlock(lines, presetId)?.choices || null;
}

function stripMenu(lines, presetId) {
  const block = detectMenuBlock(lines, presetId);
  if (!block) return lines;
  return lines.filter((_, i) => i < block.startIdx || i > block.endIdx);
}

module.exports = { init, trackInput, recordInjectedInput, trackOutput, updateAgentCandidate, commitAgentCandidate, clearAgentCandidate, parseTurnsFromLines, getTurns, getEntriesSince, getCache, getReplayText, clear, setPrefix, setFinalizeOnIdle, detectMenu, stripMenu };

const builder = require('./transcript-normalizer');
const parser = require('./transcript-parser');
const { lineageOf } = require('./lineage');

const candidateText = {};

function isTransientChrome(presetId, text) {
  presetId = lineageOf(presetId);
  if (presetId === 'codex') {
    return /^Working \(/.test(text) || /^esc to interrupt$/i.test(text);
  }
  if (presetId === 'claude-code') {
    return /^(esc to interrupt|\? for shortcuts)$/i.test(text);
  }
  return false;
}

function parseLatestAgent(presetId, lines, users) {
  const turns = parser.parseTurns(presetId, lines, users);
  return turns?.length ? turns[turns.length - 1] : parser.parseLastAgentOnly(presetId, lines);
}

function update(id, presetId, lines, users) {
  const last = parseLatestAgent(presetId, lines, users);
  const text = last?.role === 'agent' ? builder.cleanAgentText(presetId, last.text) : '';
  if (!text || isTransientChrome(presetId, text)) return '';
  candidateText[id] = text;
  return text;
}

function get(id) {
  return candidateText[id] || '';
}

function clear(id) {
  delete candidateText[id];
}

module.exports = { update, get, clear };

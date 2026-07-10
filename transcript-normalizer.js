const { lineageOf } = require('./lineage');

function cleanAgentText(presetId, text) {
  presetId = lineageOf(presetId);
  let out = String(text || '').split('\n').map(l => l.replace(/[ \t]+$/g, '')).join('\n').trim();
  out = out.replace(/\n\n─{5,}\s*$/u, '').trim();
  if (presetId === 'codex' || presetId === 'claude-code') {
    const cut = Math.max(out.lastIndexOf('›'), out.lastIndexOf('❯'));
    if (cut !== -1) out = out.slice(0, cut).trim();
  }
  if (presetId === 'gemini-cli') {
    const cut = out.lastIndexOf('\n >');
    if (cut !== -1) out = out.slice(0, cut).trim();
    out = out.replace(/\n\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]?\s*Executing Hook:[\s\S]*$/, '').trim();
  }
  if (presetId === 'claude-code') {
    out = out.replace(/\n\s*.*\(running stop hook\)[\s\S]*$/, '').trim();
    out = out.replace(/\n\s*\?\s*for shortcuts[\s\S]*$/, '').trim();
    out = out.replace(/\n\s*esc to interrupt[\s\S]*$/, '').trim();
    out = out.replace(/\n\n\s*[✻✢✣✤✥✦✧][\s\S]*$/, '').trim();
    out = out.replace(/\n\n─{5,}[\s\S]*$/, '').trim();
  }
  return out;
}

function normalizeEntry(entry, presetId) {
  const text = entry.role === 'agent'
    ? cleanAgentText(presetId, entry.text)
    : String(entry.text || '').trim();
  return text ? { ...entry, text } : null;
}

function addEntry(entries, entry, presetId) {
  const next = normalizeEntry(entry, presetId);
  if (!next) return entries;
  const prev = entries[entries.length - 1];
  if (prev && prev.role === 'user' && next.role === 'user') {
    prev.text += '\n' + next.text;
    prev.ts = next.ts;
    return entries;
  }
  if (prev && prev.role === 'agent' && next.role === 'agent') {
    prev.text = next.text;
    prev.ts = next.ts;
    return entries;
  }
  entries.push(next);
  return entries;
}

function compactEntries(entries, presetId) {
  const out = [];
  for (const entry of entries || []) addEntry(out, entry, presetId);
  return out;
}

module.exports = { addEntry, compactEntries, cleanAgentText };

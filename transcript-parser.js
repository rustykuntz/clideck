const { lineageOf } = require('./lineage');

function parseTurns(presetId, lines, users) {
  presetId = lineageOf(presetId);
  const parser = parsers[presetId];
  return collapseAgentTurns(parser ? parser(lines, users) : anchorParse(lines, users));
}

function parseLastAgentOnly(presetId, lines) {
  presetId = lineageOf(presetId);
  if (presetId === 'claude-code') return parseLastClaudeAgentOnly(lines);
  const turns = collapseAgentTurns((parsers[presetId] || (() => null))(lines, null));
  if (!turns?.length) return null;
  const last = [...turns].reverse().find(t => t.role === 'agent');
  return last || null;
}

function parseLastClaudeAgentOnly(lines) {
  const userPromptRe = /^(?:[│ ]\s*)?[❯›]\s(.*)$/;
  const agentRe = /^(?:[│ ]\s*)?[⏺•●]\s(.*)$/;
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (userPromptRe.test(lines[i])) { promptIdx = i; break; }
  }
  const upperBound = promptIdx >= 0 ? promptIdx : lines.length;
  let start = -1;
  for (let i = upperBound - 1; i >= 0; i--) {
    if (agentRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const first = lines[start].match(agentRe);
  const turn = { role: 'agent', text: first[1] };
  for (let i = start + 1; i < upperBound; i++) {
    if (userPromptRe.test(lines[i]) || agentRe.test(lines[i])) break;
    let cont = lines[i];
    if (cont.startsWith('│ ')) cont = cont.slice(2);
    else if (cont.startsWith('  ')) cont = cont.slice(2);
    turn.text += '\n' + cont;
  }
  turn.text = turn.text.replace(/\n+$/, '');
  return turn;
}

const parsers = {
  'claude-code': (lines, users) => {
    const known = users?.length ? new Set(users) : null;
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
  codex: (lines, users) => {
    const known = users?.length ? new Set(users) : null;
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
  'gemini-cli': (lines, users) => {
    const known = users?.length ? new Set(users) : null;
    const isChrome = t => {
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
      if (isChrome(line)) continue;
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

function anchorParse(lines, users) {
  if (!users?.length) return null;
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
  return turns.length >= 2 && turns[turns.length - 1].role === 'agent' ? turns : null;
}

function collapseAgentTurns(turns) {
  if (!turns?.length) return turns;
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === 'agent' && i + 1 < turns.length && turns[i + 1].role === 'agent') continue;
    out.push(turns[i]);
  }
  return out;
}

module.exports = { parseTurns, parseLastAgentOnly };

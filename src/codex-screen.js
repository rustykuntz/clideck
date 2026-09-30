const { createMenuParser } = require('./menu-screen');

const USER_PROMPT_RE = /^(?:│\s*)?›\s(.*)$/;
const AGENT_RE = /^(?:│\s*)?•\s(.*)$/;
const menu = createMenuParser({
  selectionMarker: /[›❯]/,
  turnMarker: /^(?:│\s*)?[•›]\s/,
});

function cleanAgentText(text) {
  let output = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  const prompt = Math.max(output.lastIndexOf('›'), output.lastIndexOf('❯'));
  if (prompt !== -1) output = output.slice(0, prompt).trim();
  output = output.replace(/(?:^|\n)\s*Working \([^\n]*esc to interrupt[\s\S]*$/i, '').trim();
  output = output.replace(/\n+\s*\S+\s+(?:minimal|low|medium|high|xhigh|default)\s+·\s+[~/][^\n]*$/i, '').trim();
  output = output.replace(/\n\s*─{5,}[\s\S]*$/, '').trim();
  return output;
}

function latestAgentText(lines, userPrompts = []) {
  const knownPrompts = userPrompts.length ? new Set(userPrompts) : null;
  const turns = [];
  let current = null;
  const pushCurrent = () => {
    if (!current) return;
    current.text = current.text.replace(/\n+$/, '');
    turns.push(current);
  };

  for (const line of lines) {
    const agent = line.match(AGENT_RE);
    if (agent) {
      pushCurrent();
      current = { role: 'agent', text: agent[1] };
      continue;
    }
    const user = line.match(USER_PROMPT_RE);
    if (user && (!knownPrompts || knownPrompts.has(user[1].trim()))) {
      pushCurrent();
      current = { role: 'user', text: user[1] };
      continue;
    }
    if (!current) continue;
    let continuation = line;
    if (continuation.startsWith('│ ') || continuation.startsWith('  ')) {
      continuation = continuation.slice(2);
    }
    current.text += `\n${continuation}`;
  }
  pushCurrent();

  const latest = [...turns].reverse().find((turn) => turn.role === 'agent');
  if (!latest) return '';
  const text = cleanAgentText(latest.text);
  if (/^(?:Working\b|You have \d+ usage limit resets?|(?:Booting|Starting) MCP server)/i.test(text)) {
    return '';
  }
  return text;
}

function hasInputPrompt(lines) {
  return lines.slice(-8).some((line) => /^\s*›(?:\s|\u00a0|$)/u.test(line));
}

function hasSettledPrompt(lines) {
  const tail = lines.slice(-12);
  return hasInputPrompt(tail) && !tail.some((line) => /esc to interrupt/i.test(line));
}

function hasInputCommand(lines, command) {
  const expected = String(command || '').trim();
  const prompt = lines.slice(-8).findLast(line => /^\s*›(?:\s|$)/u.test(line));
  return !!prompt && prompt.replace(/^\s*›\s*/u, '').trim() === expected;
}

function startupModel(lines) {
  const banner = lines.findIndex((line) => /^\s*│\s*>_ OpenAI Codex \(v[^)]+\)\s*│\s*$/.test(line));
  if (banner >= 0) {
    for (const line of lines.slice(banner + 1, banner + 4)) {
      const match = line.match(/^\s*│\s*model:\s+(\S+)(?:\s+(?:minimal|low|medium|high|xhigh|default))?\s+\/model to change\s*│\s*$/);
      if (match && !/^loading(?:\.{3}|…)?$/i.test(match[1])) return match[1];
    }
  }
  // Codex 0.159 moved the selected model to the footer prompt line.
  for (const line of lines.slice(-12)) {
    const match = line.match(/^\s*(\S+)\s+(?:minimal|low|medium|high|xhigh|default)\s+·\s+[~/][^\n]*$/i);
    if (match && !/^loading(?:\.{3}|…)?$/i.test(match[1])) return match[1].toLowerCase();
  }
  return '';
}

module.exports = {
  cleanAgentText,
  latestAgentText,
  detectMenu: menu.detectMenu,
  detectMenuDetails: menu.detectMenuDetails,
  stripMenu: menu.stripMenu,
  hasInputPrompt,
  hasSettledPrompt,
  hasInputCommand,
  startupModel,
};

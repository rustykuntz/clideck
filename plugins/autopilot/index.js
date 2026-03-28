'use strict';

const { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const crypto = require('crypto');

const DATA_DIR = join(require('os').homedir(), '.clideck', 'autopilot');

// --- State ---
const projects = new Map();   // projectId → Project
const tokenUsage = new Map(); // projectId → { input, output }
const menuPending = new Set(); // sessionIds with a menu awaiting auto-approve
let api = null;
let piAi = null;

function enabled() { return api.getSetting('enabled') !== false; }
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64); }

function outputId(text) {
  const normalized = (text || '').trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// --- pi-ai (lazy, ESM) ---

async function ai() {
  if (piAi) return piAi;
  piAi = await import(api.resolve('@mariozechner/pi-ai'));
  return piAi;
}

// --- KB (routing history) ---

function kbPath(pid) { return join(DATA_DIR, `${safeId(pid)}.jsonl`); }

function appendKB(pid, entry) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(kbPath(pid), JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
}

function readKB(pid, n) {
  const p = kbPath(pid);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return n ? entries.slice(-n) : entries;
  } catch { return []; }
}

// --- Token usage ---

function usagePath() { return join(DATA_DIR, 'usage.json'); }

function loadUsage() {
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(usagePath(), 'utf8')))) {
      tokenUsage.set(k, v);
    }
  } catch {}
}

function saveUsage() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(Object.fromEntries(tokenUsage)));
}

function addTokens(pid, usage) {
  if (!usage) return;
  const u = tokenUsage.get(pid) || { input: 0, output: 0 };
  u.input += usage.input || 0;
  u.output += usage.output || 0;
  tokenUsage.set(pid, u);
  saveUsage();
  api.sendToFrontend('tokens', { projectId: pid, ...u });
}

// --- Consumed state (persisted per-project: role → boolean) ---

function captureIdleOutput(id, pid, proj) {
  if (!projects.has(pid)) return;
  if (proj.status.get(id)) return;
  const w = proj.workers.get(id);
  if (w) {
    const turns = api.getScreenTurns(id, w.presetId, { raw: true });
    if (turns?.length && turns[turns.length - 1].role === 'agent') {
      const out = turns[turns.length - 1].text.trim().slice(0, 8000);
      const oid = outputId(out);
      const prev = proj.lastOutput.get(id);
      const isNew = !prev || prev.outputId !== oid;
      proj.lastOutput.set(id, { text: out, capturedAt: Date.now(), outputId: oid });
      appendKB(pid, { from: w.role, msg: out.slice(0, 4000), outputId: oid });
      // Clear waitingOn when the awaited role delivers new output
      if (isNew && proj.waitingOn?.toLowerCase() === w.role.toLowerCase()) {
        proj.waitingOn = null;
        proj.staleSince = null;
      }
    }
  }
  if (proj.paused) return;
  const allIdle = [...proj.workers.keys()].every(sid => !proj.status.get(sid));
  if (allIdle) {
    // Track staleness: if no new output arrived since last consult, mark stale
    if (proj.lastAction && !proj.staleSince) {
      const anyNew = [...proj.lastOutput.values()].some(o => o.capturedAt > proj.lastAction.at);
      if (!anyNew) proj.staleSince = Date.now();
    }
    triggerConsult(pid, proj);
  }
}

function resetProjectState(pid) {
  try { unlinkSync(kbPath(pid)); } catch {}
}

// --- Debug logging ---

const LOGS_DIR = join(DATA_DIR, 'logs');
const debugCounters = new Map(); // pid → turn counter

function debugLog(pid, label, content) {
  if (api.getSetting('debugging') !== true) return;
  mkdirSync(LOGS_DIR, { recursive: true });
  const n = (debugCounters.get(pid) || 0) + 1;
  debugCounters.set(pid, n);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(LOGS_DIR, `${safeId(pid)}_${String(n).padStart(3, '0')}_${label}_${ts}.md`);
  writeFileSync(file, content);
}

function resetDebugLogs(pid) {
  debugCounters.set(pid, 0);
}

// --- Helpers ---

function projectFor(sid) {
  for (const [pid, proj] of projects) {
    if (proj.workers.has(sid)) return [pid, proj];
  }
  // Auto-discover: session may belong to a project with active autopilot
  if (!projects.size) return [null, null];
  const sess = api.getSessions().find(s => s.id === sid);
  if (!sess?.projectId || !sess.roleName || !projects.has(sess.projectId)) return [null, null];
  const pid = sess.projectId;
  const proj = projects.get(pid);
  const err = refreshWorkers(pid, proj);
  if (err) {
    api.sendToFrontend('notify', { projectId: pid, reason: `${err} — autopilot stopped` });
    stop(pid);
    return [null, null];
  }
  return proj.workers.has(sid) ? [pid, proj] : [null, null];
}

function workerByRole(proj, role) {
  for (const [sid, w] of proj.workers) {
    if (w.role.toLowerCase() === role.toLowerCase()) return sid;
  }
  return null;
}

function discoverWorkers(pid) {
  const workers = new Map();
  const status = new Map();
  for (const s of api.getSessions().filter(s => s.projectId === pid && s.roleName)) {
    workers.set(s.id, { role: s.roleName, name: s.name, presetId: s.presetId });
    // Sessions start idle. Status is tracked by notifyStatus() on every
    // working/idle transition. If s.working is undefined, no transition was
    // ever recorded — the session has been idle since creation.
    status.set(s.id, s.working === true);
  }
  return { workers, status };
}

// Returns null on success, or an error string (caller must stop autopilot).
function refreshWorkers(pid, proj) {
  const live = new Map();
  const liveStatus = new Map();
  for (const s of api.getSessions().filter(s => s.projectId === pid && s.roleName)) {
    live.set(s.id, { role: s.roleName, name: s.name, presetId: s.presetId });
    liveStatus.set(s.id, s.working === true);
  }
  // Remove dead sessions
  for (const sid of [...proj.workers.keys()]) {
    if (!live.has(sid)) {
      proj.workers.delete(sid);
      proj.status.delete(sid);
      proj.lastOutput.delete(sid);
      api.setAutoApproveMenu(sid, false);
    }
  }
  // Add new sessions
  for (const [sid, w] of live) {
    if (!proj.workers.has(sid)) {
      const roleKey = w.role.toLowerCase();
      if ([...proj.workers.values()].some(x => x.role.toLowerCase() === roleKey)) {
        return `Duplicate role "${w.role}"`;
      }
      proj.workers.set(sid, w);
      proj.status.set(sid, liveStatus.get(sid));
      api.setAutoApproveMenu(sid, true);
      // Seed output for idle new workers from .screen
      if (!liveStatus.get(sid)) {
        const turns = api.getScreenTurns(sid, w.presetId, { raw: true });
        if (turns?.length && turns[turns.length - 1].role === 'agent') {
          const text = turns[turns.length - 1].text.trim().slice(0, 8000);
          proj.lastOutput.set(sid, { text, capturedAt: Date.now(), outputId: outputId(text) });
        }
      }
    }
  }
  return null;
}

// --- Model management ---

function filterModels(all) {
  // pi-ai model objects have no alias/canonical metadata — the display name is
  // the only signal. Canonical models get "(latest)" appended, dated snapshots
  // get "(YYYY-MM-DD)". We drop qualified variants when the clean base exists.
  const baseNames = new Set();
  for (const m of all) {
    const base = m.name.replace(/\s*\((?:latest|\d{4}-\d{2}-\d{2})\)$/, '');
    if (base !== m.name) baseNames.add(base);
  }
  const filtered = all.filter(m => {
    // Drop "(latest)" and "(date)" variants when the clean base name exists as another model
    const qualifier = m.name.match(/\s*\((latest|\d{4}-\d{2}-\d{2})\)$/);
    if (!qualifier) return !baseNames.has(m.name) || true; // clean name — always keep
    const base = m.name.replace(qualifier[0], '');
    // Keep (latest) variant only if no clean base exists
    if (qualifier[1] === 'latest') return !all.find(x => x.name === base);
    // Drop dated variants
    return false;
  });
  return filtered
    .sort((a, b) => a.cost.input - b.cost.input)
    .map(m => ({ value: m.id, label: `${m.name.replace(/\s*\(latest\)$/, '')}  ($${m.cost.input}/M)` }));
}

async function loadModelsForProvider(provider) {
  try {
    const m = await ai();
    const options = filterModels(m.getModels(provider));
    // Set options first so setSetting can validate against the new list
    api.setSettingOptions('model', options);
    const current = api.getSetting('model');
    if (options.length && !options.find(o => o.value === current)) {
      api.setSetting('model', options[0].value);
    }
  } catch (e) {
    api.log(`Failed to load models for ${provider}: ${e.message}`);
  }
}

// --- Provider helpers ---

function toolChoiceForProvider(provider) {
  // Anthropic, Google, Mistral use "any"; OpenAI-compatible (openai, groq, openrouter, xai, cerebras) use "required"
  return ({ anthropic: 'any', google: 'any', mistral: 'any' })[provider] || 'required';
}

// --- LLM tools ---

function buildTools(Type) {
  return [
    {
      name: 'route',
      description: 'Forward one agent\'s output to another idle agent. The system copies the output verbatim — you only choose who sends and who receives.',
      parameters: Type.Object({
        from: Type.String({ description: 'Source agent role name (prefer [LATEST] agent)' }),
        to: Type.String({ description: 'Target agent role name (must be IDLE)' }),
      }),
    },
    {
      name: 'notify_user',
      description: 'Notify the user and stop autopilot. Use light markdown. Keep it concise (2-5 sentences). Use when: workflow is complete, human input is needed, or agents are stuck.',
      parameters: Type.Object({
        reason: Type.String({ description: 'Short message to user (2-3 sentences max)' }),
      }),
    },
  ];
}

// --- System prompt ---

const PROMPT_TEMPLATE = readFileSync(join(__dirname, 'prompt.md'), 'utf8');

function buildPrompt(proj, pid) {
  const pList = api.getProjects();
  const p = pList.find(x => x.id === pid);
  const projectName = p ? `${p.name}${p.path ? ` (${p.path})` : ''}` : pid;

  const roles = api.getRoles();
  const agentProfiles = [];
  for (const [sid, w] of proj.workers) {
    const busy = proj.status.get(sid);
    const role = roles.find(r => r.name === w.role);
    const desc = role?.instructions || '(no role description)';
    agentProfiles.push(`${w.role} [${busy ? 'WORKING' : 'IDLE'}]\n  Role: ${desc}`);
  }

  let prompt = PROMPT_TEMPLATE
    .replace('{{projectName}}', projectName)
    .replace('{{agents}}', agentProfiles.join('\n\n'));

  return prompt;
}

function buildStateContext(proj, pid) {
  const fmtTs = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    return `${Math.round(sec / 60)}m ago`;
  };

  const lines = ['CURRENT STATE'];

  // Per-worker state
  const lastActionAt = proj.lastAction?.at || 0;
  for (const [sid, w] of proj.workers) {
    const stored = proj.lastOutput.get(sid);
    const oid = stored?.outputId || null;
    const capturedAt = stored?.capturedAt || 0;
    const isNew = capturedAt > lastActionAt;
    const status = proj.status.get(sid) ? 'WORKING' : 'IDLE';
    let line = `  ${w.role}: ${status}`;
    if (oid) line += ` | output #${oid} captured ${fmtAgo(capturedAt)}${isNew ? ' (NEW)' : ''}`;
    else line += ' | no output';
    lines.push(line);
  }

  // Handoff summary from KB: which outputs were routed where
  const kb = readKB(pid, 30);
  const handoffs = new Map(); // outputId → { from, routedTo: Set }
  for (const e of kb) {
    if (e.from && e.to && e.outputId) {
      if (!handoffs.has(e.outputId)) handoffs.set(e.outputId, { from: e.from, routedTo: new Set() });
      handoffs.get(e.outputId).routedTo.add(e.to);
    }
  }
  if (handoffs.size) {
    lines.push('');
    lines.push('HANDOFF LOG');
    for (const [oid, h] of handoffs) {
      lines.push(`  #${oid} from ${h.from} → routed to: ${[...h.routedTo].join(', ')}`);
    }
  }

  // Project-level routing state
  lines.push('');
  lines.push('ROUTING STATE');
  if (proj.lastAction) {
    lines.push(`  Last route: ${proj.lastAction.from} → ${proj.lastAction.to} (output #${proj.lastAction.outputId}, ${fmtAgo(proj.lastAction.at)})`);
  } else {
    lines.push('  No routes yet');
  }
  if (proj.waitingOn) lines.push(`  Waiting on: ${proj.waitingOn}`);
  if (proj.staleSince) lines.push(`  Stale since: ${fmtAgo(proj.staleSince)} (no new output since last route)`);

  // Recent routing history (compact, last 15)
  const recent = kb.slice(-15);
  if (recent.length) {
    lines.push('');
    lines.push('RECENT HISTORY');
    for (const e of recent) {
      const t = fmtTs(e.ts);
      if (e.from && e.to) lines.push(`  ${t} ${e.from} → ${e.to} (#${e.outputId || '?'})`);
      else if (e.from) lines.push(`  ${t} [${e.from}] output captured (#${e.outputId || '?'})`);
    }
  }

  return lines.join('\n');
}

// --- Core: consult LLM ---

async function consult(pid, proj) {
  if (proj.pending || proj.paused || !projects.has(pid)) return;
  const pillId = `autopilot-${pid}`;
  const refreshErr = refreshWorkers(pid, proj);
  if (refreshErr) {
    api.sendToFrontend('notify', { projectId: pid, reason: `${refreshErr} — autopilot stopped` });
    stop(pid);
    return;
  }
  // Re-check all-idle after refresh — new workers may be busy
  if (![...proj.workers.keys()].every(sid => !proj.status.get(sid))) return;

  let m;
  try { m = await ai(); } catch (e) {
    api.sendToFrontend('notify', { projectId: pid, reason: `Failed to load AI library: ${e.message}` });
    stop(pid);
    return;
  }

  const provider = api.getSetting('provider') || 'anthropic';
  const modelId = api.getSetting('model') || 'claude-haiku-4-5';
  const apiKey = api.getSetting('apiKey') || m.getEnvApiKey(provider) || '';

  if (!apiKey) {
    proj.paused = true;
    proj.pauseReason = 'config';
    api.sendToFrontend('error', { msg: `No API key for ${provider}. Set in Autopilot settings or via env var.` });
    api.sendToFrontend('paused', { projectId: pid, question: 'API key missing — configure in plugin settings' });
    api.updateSessionPill(pillId, { working: false, statusText: 'Paused — no API key' });
    api.appendPillLog(pillId, 'Paused: API key missing');
    return;
  }

  let model;
  try { model = m.getModel(provider, modelId); } catch (e) {
    api.sendToFrontend('notify', { projectId: pid, reason: `Model "${modelId}" not found — autopilot stopped` });
    stop(pid);
    return;
  }

  // Build structured state context
  const stateContext = buildStateContext(proj, pid);

  // Build agent output section
  const lastActionAt = proj.lastAction?.at || 0;
  const entries = [];
  for (const [sid, w] of proj.workers) {
    const stored = proj.lastOutput.get(sid);
    let text = stored?.text || null;
    let capturedAt = stored?.capturedAt || 0;
    let oid = stored?.outputId || null;
    if (!text) {
      const turns = api.getScreenTurns(sid, w.presetId, { raw: true });
      if (turns?.length) {
        const last = [...turns].reverse().find(t => t.role === 'agent');
        if (last) { text = last.text.trim().slice(0, 8000); capturedAt = capturedAt || Date.now(); oid = outputId(text); }
      }
    }
    entries.push({ sid, role: w.role, text, capturedAt, outputId: oid });
  }
  entries.sort((a, b) => a.capturedAt - b.capturedAt);

  const outputParts = entries.map(e => {
    const isNew = e.capturedAt > lastActionAt;
    const tag = isNew ? ' — NEW' : '';
    const idTag = e.outputId ? ` (#${e.outputId})` : '';
    return `[${e.role}${tag}${idTag}]:\n${e.text ? e.text.slice(0, 2000) : '(no output captured)'}`;
  });

  const sections = [stateContext, ''];
  if (outputParts.length) {
    sections.push('AGENT OUTPUTS');
    sections.push(outputParts.join('\n\n'));
  } else {
    sections.push('No output from any agent yet.');
  }
  sections.push('\nDecide what to route next.');

  const ctx = {
    systemPrompt: buildPrompt(proj, pid),
    messages: [{
      role: 'user',
      content: sections.join('\n'),
      timestamp: Date.now(),
    }],
    tools: buildTools(m.Type),
  };

  debugLog(pid, 'turn', [
    `# Router Turn — ${new Date().toISOString()}`,
    `Model: ${modelId} (${provider})`,
    '',
    '## System Prompt',
    ctx.systemPrompt,
    '',
    '## User Message',
    ctx.messages[0].content,
  ].join('\n'));

  api.updateSessionPill(pillId, { working: true, statusText: 'Consulting router...' });
  api.appendPillLog(pillId, `Consulting ${modelId}`);
  // api.log(`[consult] model=${modelId} workers=${[...proj.workers.values()].map(w => w.role).join(',')}`);
  // api.log(`[consult] hasOutput=${[...proj.workers].filter(([sid]) => proj.lastOutput.has(sid)).map(([,w]) => w.role).join(',') || 'none'}`);

  const MAX_HINTS = 3;
  const HINT_DELAYS = [0, 3000, 6000];
  const delay = ms => new Promise(r => setTimeout(r, ms));

  proj.pending = true;
  const opts = { apiKey, reasoning: 'minimal', toolChoice: toolChoiceForProvider(provider) };
  try {
    for (let attempt = 0; attempt < MAX_HINTS; attempt++) {
      if (attempt > 0) await delay(HINT_DELAYS[attempt] || 6000);

      const res = await m.complete(model, ctx, opts);
      addTokens(pid, res.usage);

      const tc = res.content?.find(b => b.type === 'toolCall');
      const textContent = res.content?.find(b => b.type === 'text')?.text || '';
      debugLog(pid, `response_${attempt + 1}`, [
        `# Response — attempt ${attempt + 1}/${MAX_HINTS}`,
        `Tokens: in=${res.usage?.input || 0} out=${res.usage?.output || 0}`,
        '',
        tc ? `## Tool Call: ${tc.name}\n\`\`\`json\n${JSON.stringify(tc.arguments, null, 2)}\n\`\`\`` : '## No tool call',
        textContent ? `\n## Text\n${textContent}` : '',
      ].join('\n'));

      if (!tc) {
        ctx.messages.push(
          { role: 'assistant', content: textContent, timestamp: Date.now() },
          { role: 'user', content: 'You must call one of the provided tools: route(from, to) or notify_user(reason). Do not reply with text.', timestamp: Date.now() },
        );
        continue;
      }

      const error = executeAction(pid, proj, tc.name, tc.arguments, pillId);
      if (error === null) { proj.pending = false; return; }

      // api.log(`[consult] action error — hinting: ${error}`);
      ctx.messages.push(res, {
        role: 'toolResult', toolCallId: tc.id, toolName: tc.name,
        content: [{ type: 'text', text: error }], isError: true, timestamp: Date.now(),
      });
    }

    proj.pending = false;
    api.sendToFrontend('notify', { projectId: pid, reason: 'Model failed after multiple hints — autopilot stopped' });
    stop(pid);
  } catch (e) {
    proj.pending = false;
    api.log(`LLM error: ${e.message}`);
    api.sendToFrontend('notify', { projectId: pid, reason: `Model error: ${e.message}` });
    stop(pid);
  }
}

function triggerConsult(pid, proj) {
  if (!projects.has(pid) || proj.paused || proj.pending) return;
  consult(pid, proj);
}

// --- Action execution (returns error string or null on success) ---

function executeAction(pid, proj, action, args, pillId) {
  const roles = [...proj.workers.values()].map(w => w.role);
  switch (action) {
    case 'route': {
      const src = workerByRole(proj, args.from);
      const dst = workerByRole(proj, args.to);
      if (!dst) return `No agent with role "${args.to}". Available roles: ${roles.join(', ')}`;
      if (src === dst) return 'Cannot route agent to itself';
      if (proj.status.get(dst)) return `"${args.to}" is currently working — pick an idle agent`;
      const stored = src ? proj.lastOutput.get(src) : null;
      let out = stored?.text || null;
      let oid = stored?.outputId || null;
      if (!out && src) {
        const w = proj.workers.get(src);
        if (w) {
          const turns = api.getScreenTurns(src, w.presetId, { raw: true });
          if (turns?.length && turns[turns.length - 1].role === 'agent') {
            out = turns[turns.length - 1].text.trim().slice(0, 8000);
            oid = outputId(out);
          }
        }
      }
      if (!out) return `"${args.from}" has no output to route`;

      // Repeat guard: block same outputId → same target unless new output was captured in between
      const la = proj.lastAction;
      if (la && oid && la.outputId === oid && la.to.toLowerCase() === args.to.toLowerCase()) {
        const anyNewSince = [...proj.lastOutput.values()].some(o => o.capturedAt > la.at);
        if (!anyNewSince) {
          return `Output #${oid} was already routed to "${args.to}" and no new output has been captured since. Pick a different target or call notify_user if stuck.`;
        }
      }

      const dstRole = proj.workers.get(dst)?.role || args.to;
      const header = [
        `[Autopilot route${oid ? ` | output #${oid}` : ''}]`,
        `[Team: ${roles.join(', ')}]`,
        `[You are: ${dstRole}]`,
        `[From: ${args.from}]`,
        '[Do not spawn internal agents.]',
      ].join('\n');
      const payload = `${header}\n\n${out}`;
      api.inputToSession(dst, payload);
      setTimeout(() => api.inputToSession(dst, '\r'), 150);
      const now = Date.now();
      appendKB(pid, { from: args.from, to: args.to, msg: out.slice(0, 4000), outputId: oid });
      proj.lastAction = { outputId: oid, from: args.from, to: args.to, at: now };
      proj.waitingOn = args.to;
      proj.staleSince = null;
      api.sendToFrontend('routed', { projectId: pid, from: args.from, to: args.to });
      if (pillId) {
        api.updateSessionPill(pillId, { working: false, statusText: `${args.from} → ${args.to}` });
        api.appendPillLog(pillId, `Routed ${args.from} → ${args.to}`);
      }
      return null;
    }
    case 'notify_user': {
      if (pillId) {
        api.appendPillLog(pillId, `Notify: ${args.reason}`);
        api.updateSessionPill(pillId, { working: false, statusText: 'Finished' });
      }
      const pList = api.getProjects();
      const projName = pList.find(x => x.id === pid)?.name || 'Project';
      api.sendToFrontend('notify', { projectId: pid, reason: args.reason, projectName: projName });
      // api.log(`Notify + stop: ${args.reason}`);
      stop(pid, true); // keepPill=true
      return null;
    }
    default:
      return `Unknown tool "${action}". You must use route(from, to) or notify_user(reason).`;
  }
}

// --- Lifecycle ---

function start(pid) {
  if (projects.has(pid)) return { error: 'Already running' };
  if (!enabled()) return { error: 'Autopilot disabled' };

  const { workers, status } = discoverWorkers(pid);
  if (workers.size < 1) return { error: 'No agents with roles in this project' };

  const roles = new Set();
  for (const [, w] of workers) {
    const key = w.role.toLowerCase();
    if (roles.has(key)) return { error: `Duplicate role "${w.role}"` };
    roles.add(key);
  }

  resetProjectState(pid);
  resetDebugLogs(pid);

  const proj = {
    workers,
    status,
    lastOutput: new Map(),
    paused: false,
    pauseReason: null,
    pending: false,
    lastAction: null,    // { outputId, from, to, at }
    waitingOn: null,     // role name we expect new output from
    staleSince: null,    // timestamp when we started waiting without progress
  };
  projects.set(pid, proj);

  // Flag all workers for core menu auto-approve
  for (const [sid] of workers) api.setAutoApproveMenu(sid, true);

  // Seed lastOutput from .screen for idle workers
  for (const [sid, w] of workers) {
    if (status.get(sid)) continue;
    const turns = api.getScreenTurns(sid, w.presetId, { raw: true });
    if (!turns?.length || turns[turns.length - 1].role !== 'agent') continue;
    const text = turns[turns.length - 1].text.trim().slice(0, 8000);
    proj.lastOutput.set(sid, { text, capturedAt: Date.now(), outputId: outputId(text) });
  }

  // api.log(`Started: ${pid}, ${workers.size} workers`);
  api.sendToFrontend('started', { projectId: pid });
  const pillId = `autopilot-${pid}`;
  api.addSessionPill({ id: pillId, title: 'Autopilot', projectId: pid });
  api.appendPillLog(pillId, `Started with ${workers.size} workers: ${[...workers.values()].map(w => w.role).join(', ')}`);

  // Only consult if all workers are already idle
  const allIdle = [...workers.keys()].every(sid => !status.get(sid));
  if (allIdle) setTimeout(() => triggerConsult(pid, proj), 3000);

  return { ok: true };
}

function stop(pid, keepPill) {
  const proj = projects.get(pid);
  if (!proj) return;
  for (const [sid] of proj.workers) api.setAutoApproveMenu(sid, false);
  projects.delete(pid);
  // api.log(`Stopped: ${pid}`);
  api.sendToFrontend('stopped', { projectId: pid });
  const pillId = `autopilot-${pid}`;
  if (keepPill) {
    api.appendPillLog(pillId, 'Completed');
  } else {
    api.appendPillLog(pillId, 'Stopped');
    api.removeSessionPill(pillId);
  }
}

// --- Plugin init ---

module.exports.init = function (pluginApi) {
  api = pluginApi;
  loadUsage();

  api.addProjectAction({
    id: 'autopilot-toggle',
    title: 'Autopilot',
    icon: '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  });

  // Toggle on/off
  api.onFrontendMessage('autopilot-toggle', (msg) => {
    if (projects.has(msg.projectId)) {
      stop(msg.projectId);
    } else {
      // Remove lingering pill from a previous finished run
      api.removeSessionPill(`autopilot-${msg.projectId}`);
      const r = start(msg.projectId);
      if (r.error) api.sendToFrontend('error', { msg: r.error });
    }
  });

  // Menu detected on an autopilot worker — flag it so idle is suppressed until auto-approve completes
  api.onMenuDetected((id, choices) => {
    if (!choices?.length) return;
    const [pid] = projectFor(id);
    if (pid) menuPending.add(id);
  });

  // Status change — the main routing trigger (only when ALL workers are idle)
  api.onStatusChange((id, working, source) => {
    if (!enabled()) return;
    const [pid, proj] = projectFor(id);
    if (!pid) return;
    const w = proj.workers.get(id);
    const role = w?.role || id.slice(0, 8);

    if (working) { menuPending.delete(id); }

    if (!working && menuPending.has(id)) {
      menuPending.delete(id);
      // api.log(`[status] ${role} → IDLE (menu pending — suppressed)`);
      return;
    }
    proj.status.set(id, working);
    const pillId = `autopilot-${pid}`;

    if (working) {
      api.appendPillLog(pillId, `${role} → working`);
      api.updateSessionPill(pillId, { working: false, statusText: `Waiting on ${role}` });
      // api.log(`[status] ${role} → WORKING`);
      return;
    }
    if (!proj.workers.has(id)) return;

    api.appendPillLog(pillId, `${role} → idle`);
    setTimeout(() => captureIdleOutput(id, pid, proj), 5000);
  });

  // Frontend queries
  api.onFrontendMessage('getStatus', (msg) => {
    const proj = projects.get(msg.projectId);
    const tokens = tokenUsage.get(msg.projectId);
    api.sendToFrontend('status', {
      projectId: msg.projectId,
      active: !!proj,
      paused: proj?.paused || false,
      tokens: tokens || null,
    });
  });

  api.onFrontendMessage('sync', () => {
    for (const [pid] of projects) {
      api.sendToFrontend('status', { projectId: pid, active: true });
    }
  });

  api.onFrontendMessage('getTokens', (msg) => {
    const u = tokenUsage.get(msg.projectId);
    api.sendToFrontend('tokens', { projectId: msg.projectId, ...(u || { input: 0, output: 0 }) });
  });

  // Clear config pauses when user fixes settings; refresh model list on provider change
  api.onSettingsChange((key) => {
    if (key === 'apiKey' || key === 'provider' || key === 'model') {
      for (const [pid, proj] of projects) {
        if (proj.paused && proj.pauseReason === 'config') {
          proj.paused = false;
          proj.pauseReason = null;
          api.sendToFrontend('resumed', { projectId: pid });
          const allIdle = [...proj.workers.keys()].every(sid => !proj.status.get(sid));
          if (allIdle) triggerConsult(pid, proj);
        }
      }
    }
    if (key === 'provider') loadModelsForProvider(api.getSetting('provider'));
  });

  // Load model options on startup
  loadModelsForProvider(api.getSetting('provider') || 'anthropic');

  api.onShutdown(() => {
    for (const [pid] of projects) stop(pid);
    saveUsage();
  });
};

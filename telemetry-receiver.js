// Minimal OTLP HTTP/JSON log receiver.
// CLI agents export telemetry events here; we capture agent session IDs
// (for resume) and detect whether telemetry is configured (setup prompts).

const ioActivity = require('./activity');
const activity = new Map(); // sessionId → has received events
const pendingSetup = new Map(); // sessionId → timer (waiting for first event)
const pendingIdle = new Map(); // sessionId → timer (PTY silence → idle)
const escPendingIdle = new Map(); // sessionId → timer (Esc interrupt → confirm idle after output silence)
const escSuppressUntil = new Map(); // sessionId → ts (briefly ignore telemetry reassertions after Esc)
let broadcastFn = null;
let sessionsFn = null;

function init(broadcast, getSessions) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
}

// Flatten OTLP attribute arrays into plain objects
function parseAttrs(attrs) {
  const out = {};
  if (!attrs) return out;
  for (const a of attrs) {
    const v = a.value;
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '';
  }
  return out;
}

// Express-compatible handler for POST /v1/logs
function handleLogs(req, res) {
  const body = req.body;
  if (!body?.resourceLogs) return res.writeHead(200).end('{}');

  for (const rl of body.resourceLogs) {
    const resAttrs = parseAttrs(rl.resource?.attributes);
    const sessionId = resAttrs['clideck.session_id'];

    // service.name values: claude-code, codex_cli_rs, gemini-cli
    const serviceName = resAttrs['service.name'] || 'unknown';
    let resolvedId = sessionId;

    // Fallback: if agent doesn't include clideck.session_id (e.g. Gemini ignores
    // OTEL_RESOURCE_ATTRIBUTES), match by finding a pending session for this agent
    if (!resolvedId) {
      for (const [id, pending] of pendingSetup) {
        const sess = sessionsFn?.()?.get(id);
        if (!sess) continue;
        // Match: no activity yet, and agent type matches
        if (!activity.has(id) && pending.bin && serviceName.includes(pending.bin)) { resolvedId = id; break; }
      }
      if (resolvedId) {
        console.log(`Telemetry: matched ${serviceName} to session ${resolvedId.slice(0, 8)} (no clideck.session_id — fallback match)`);
      } else {
        continue;
      }
    }

    // Any log record for this session means telemetry is working
    const firstEvent = !activity.has(resolvedId);
    cancelPendingSetup(resolvedId);
    activity.set(resolvedId, true);

    const sess = sessionsFn?.()?.get(resolvedId);
    const agent = resAttrs['service.name'] || sess?.name || resolvedId.slice(0, 8);

    if (firstEvent) console.log(`Telemetry: first event from ${agent} (${resolvedId.slice(0, 8)})`);

    // Process each log record — capture session ID for resume
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const attrs = parseAttrs(lr.attributes);
        const eventName = attrs['event.name'];

        // Debug telemetry logs — uncomment as needed, do not delete
        // if (serviceName === 'claude-code' && eventName) console.log(`[telemetry:claude] ${eventName}`);
        // if (serviceName === 'codex_cli_rs' && eventName) console.log(`[telemetry:codex] ${eventName} session=${resolvedId.slice(0,8)} working=${sessionsFn?.()?.get(resolvedId)?.working}`);
        // if (serviceName === 'gemini-cli' && eventName) console.log(`[telemetry:gemini] ${eventName}`);

        // Status: user_prompt → working + start PTY silence monitor for idle
        const startEvents = new Set(['user_prompt', 'gemini_cli.user_prompt', 'codex.user_prompt']);
        if (startEvents.has(eventName)) {
          cancelPendingIdle(resolvedId);
          broadcastFn?.({ type: 'session.status', id: resolvedId, working: true, source: 'telemetry' });
          startPendingIdle(resolvedId, serviceName);
        }

        const agentSessionId = attrs['session.id'] || attrs['conversation.id'];
        if (agentSessionId && sess) {
          // Prefer interactive session ID (Gemini sends non-interactive init events first)
          const dominated = sess.sessionToken && attrs['interactive'] === true;
          if (!sess.sessionToken || dominated) {
            sess.sessionToken = agentSessionId;
            console.log(`Telemetry: captured session ID ${agentSessionId} for ${agent} (${resolvedId.slice(0, 8)})`);
          }
        }
      }
    }

  }

  res.writeHead(200).end('{}');
}

// Watch a newly spawned session — if no telemetry arrives, notify frontend
function watchSession(sessionId, bin) {
  if (pendingSetup.has(sessionId)) return;
  const timer = setTimeout(() => {
    pendingSetup.delete(sessionId);
    // Don't fire if telemetry arrived between timer start and now
    if (!activity.has(sessionId)) {
      broadcastFn?.({ type: 'session.needsSetup', id: sessionId });
    }
  }, 10000);
  pendingSetup.set(sessionId, { timer, bin });
}

function cancelPendingSetup(sessionId) {
  const pending = pendingSetup.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSetup.delete(sessionId);
  }
}

// PTY activity monitor: 2s silent → idle, 2s active or user_prompt → working.
// Agent working indicators in PTY output.
const CLAUDE_WORKING_RE = /[✳✽✢✻·]|Working…|thinking/;
const CODEX_WORKING_RE = /Working|•/;

function startPendingIdle(id, agent) {
  if (pendingIdle.has(id)) return; // already monitoring
  const isClaude = agent === 'claude-code';
  const isCodex = agent === 'codex_cli_rs';
  let isIdle = false;
  let activeStart = 0;
  const check = setInterval(() => {
    const lastOut = ioActivity.lastOutputAt(id);
    const lastIn = ioActivity.lastInputAt(id);
    // Ignore echo: if last output is within 100ms of last input, treat as silent
    const agentOut = (lastIn && lastOut - lastIn >= 0 && lastOut - lastIn < 100) ? 0 : lastOut;
    let silent = (Date.now() - agentOut) >= 2000;
    // Agent override: if recent output has spinner/working chars, not silent
    if (silent && (Date.now() - lastOut) < 2000) {
      const chunk = ioActivity.lastChunk(id);
      if (isClaude && CLAUDE_WORKING_RE.test(chunk)) silent = false;
      if (isCodex && CODEX_WORKING_RE.test(chunk)) silent = false;
    }
    if (silent && !isIdle) {
      isIdle = true;
      activeStart = 0;
      broadcastFn?.({ type: 'session.status', id, working: false, source: 'telemetry' });
    } else if (!silent && isIdle) {
      if (!activeStart) activeStart = Date.now();
      if (Date.now() - activeStart >= 2000) {
        isIdle = false;
        broadcastFn?.({ type: 'session.status', id, working: true, source: 'telemetry' });
      }
    } else if (!silent) {
      activeStart = 0;
    }
  }, 250);
  pendingIdle.set(id, check);
}

function cancelPendingIdle(id) {
  const timer = pendingIdle.get(id);
  if (timer) { clearInterval(timer); pendingIdle.delete(id); }
}

function startEscIdle(id) {
  cancelEscIdle(id);
  const started = Date.now();
  const ignoreUntil = started + 500;
  console.log(`[escIdle] start session=${id.slice(0,8)}`);
  const check = setInterval(() => {
    const lastOut = ioActivity.lastOutputAt(id);
    const silence = Date.now() - Math.max(ignoreUntil, lastOut);
    const elapsed = Date.now() - started;
    if (elapsed > 10000) {
      console.log(`[escIdle] timeout session=${id.slice(0,8)} silence=${silence}ms`);
      cancelEscIdle(id);
      return;
    }
    if (silence >= 2000) {
      console.log(`[escIdle] idle session=${id.slice(0,8)} silence=${silence}ms`);
      escSuppressUntil.set(id, Date.now() + 2000);
      cancelEscIdle(id);
      broadcastFn?.({ type: 'session.status', id, working: false, source: 'esc' });
    }
  }, 250);
  escPendingIdle.set(id, check);
}

function cancelEscIdle(id) {
  const timer = escPendingIdle.get(id);
  if (timer) { clearInterval(timer); escPendingIdle.delete(id); }
}

function clear(id) {
  activity.delete(id);
  cancelPendingIdle(id);
  cancelEscIdle(id);
  escSuppressUntil.delete(id);
  const pending = pendingSetup.get(id);
  if (pending) { clearTimeout(pending.timer); pendingSetup.delete(id); }
}

// Returns true if we've received telemetry events for this session
function hasEvents(id) {
  return activity.has(id);
}

module.exports = { init, handleLogs, clear, hasEvents, watchSession, startPendingIdle, startEscIdle };

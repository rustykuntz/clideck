// OpenCode bridge — receives events from the CliDeck OpenCode plugin
// via HTTP POST to /opencode-events.
// Routes events to the correct CliDeck session by OpenCode session ID.

// sessionId → { opencodeSessionId, cwd }
const watchers = new Map();

let broadcastFn = null;
let sessionsFn = null;

function init(broadcast, getSessions) {
  broadcastFn = broadcast;
  sessionsFn = getSessions;
}

function watchSession(sessionId, cwd) {
  if (watchers.has(sessionId)) return;
  watchers.set(sessionId, { opencodeSessionId: null, cwd });
}

function findByOcId(ocSid) {
  for (const [sessionId, w] of watchers) {
    if (w.opencodeSessionId === ocSid) return sessionId;
  }
  return null;
}

function findUnclaimed(directory) {
  let fallback = null;
  for (const [sessionId, w] of watchers) {
    if (w.opencodeSessionId) continue;
    if (directory && w.cwd && directory.startsWith(w.cwd)) return sessionId;
    if (!fallback) fallback = sessionId;
  }
  return fallback;
}

// Extract OpenCode session ID from any event shape
function extractOcSid(p) {
  return p.sessionID
    || p.sessionId
    || p.info?.id
    || p.info?.sessionID
    || p.info?.sessionId
    || p.part?.sessionID
    || p.part?.sessionId
    || p.message?.sessionID
    || p.message?.sessionId
    || p.session?.id
    || null;
}

function extractDirectory(p) {
  return p.info?.directory || p.directory || p.info?.path?.cwd || p.path?.cwd || null;
}

function claim(sessionId, ocSid) {
  const w = watchers.get(sessionId);
  if (!w) return;
  w.opencodeSessionId = ocSid;
  const sess = sessionsFn?.()?.get(sessionId);
  if (sess && !sess.sessionToken) sess.sessionToken = ocSid;
}

function unclaimedIds() {
  const ids = [];
  for (const [sessionId, w] of watchers) {
    if (!w.opencodeSessionId) ids.push(sessionId);
  }
  return ids;
}

function handleEvent(payload) {
  if (!payload || !payload.event) return;

  const ocSid = extractOcSid(payload);
  let sessionId = ocSid ? findByOcId(ocSid) : null;

  // Claim unclaimed watcher on session.created or session.updated
  if (!sessionId && ocSid && (payload.event === 'session.created' || payload.event === 'session.updated')) {
    sessionId = findUnclaimed(extractDirectory(payload));
    if (sessionId) claim(sessionId, ocSid);
  }

  // Fallback: if there's exactly one unclaimed OpenCode watcher, attach first seen session ID.
  // This recovers when session.created/session.updated isn't delivered in-order.
  if (!sessionId && ocSid) {
    const unclaimed = unclaimedIds();
    if (unclaimed.length === 1) {
      sessionId = unclaimed[0];
      claim(sessionId, ocSid);
    }
  }

  if (!sessionId) return;

  // session.status → busy/idle
  if (payload.event === 'session.status') {
    const t = payload.status?.type;
    if (t === 'busy') broadcastFn?.({ type: 'session.status', id: sessionId, working: true });
    else if (t === 'idle') broadcastFn?.({ type: 'session.status', id: sessionId, working: false });
  }

  // session.idle
  if (payload.event === 'session.idle') {
    broadcastFn?.({ type: 'session.status', id: sessionId, working: false });
  }

  // message.part.updated with type=text → preview
  if (payload.event === 'message.part.updated') {
    const part = payload.part || {};
    const text = typeof part.text === 'string'
      ? part.text
      : (typeof payload.delta === 'string' ? payload.delta : '');
    const isTextual = part.type === 'text' || part.type === 'reasoning' || !!text;
    if (isTextual && text) {
      broadcastFn?.({ type: 'session.preview', id: sessionId, text: text.slice(0, 200) });
    }
  }

  // message.updated fallback preview (for payloads that don't emit text part updates)
  if (payload.event === 'message.updated') {
    const parts = payload.info?.parts;
    if (Array.isArray(parts)) {
      const latest = [...parts].reverse().find(p =>
        typeof p?.text === 'string' && (p.type === 'text' || p.type === 'reasoning')
      );
      if (latest?.text) {
        broadcastFn?.({ type: 'session.preview', id: sessionId, text: latest.text.slice(0, 200) });
      }
    }
  }

  // session.updated → capture title, ensure token
  if (payload.event === 'session.updated') {
    const sess = sessionsFn?.()?.get(sessionId);
    if (sess) {
      if (!sess.sessionToken) sess.sessionToken = ocSid;
      if (payload.info?.title) sess.title = payload.info.title;
    }
  }
}

function clear(sessionId) {
  watchers.delete(sessionId);
}

module.exports = { init, watchSession, handleEvent, clear };

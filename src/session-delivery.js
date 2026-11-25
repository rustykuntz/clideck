const { availableAskSession, availableSteerSession } = require('./ask');
const { getProvider } = require('./providers');

// Reuse ask's availability gates and the same paste/submission transaction. A
// background message needs submission confirmation, not a waiter for the agent's final reply.
function createSessionDelivery(server, now = Date.now) {
  return async (delivery, { commit, checkpoint, signal, message }) => {
    const entry = server.persistence.get(delivery.sessionId);
    if (!entry) return { state: 'error', message: 'Target session was deleted. The message cannot be delivered.' };
    if (!getProvider(entry.provider)?.supportsAsk) return { state: 'error', message: 'This agent does not support background messages.' };
    let session = server.sessions.get(entry.id);
    if (!session || session.closed) {
      if (!delivery.resumeSession) return { state: 'waiting', retryAfterMs: 60_000, message: 'Session stopped. Resume it, or enable “Resume stopped session”.' };
      if (!entry.resumeHandle) return { state: 'error', message: 'No saved conversation to resume. Open the session manually first.' };
      if (delivery.pending.resumeAttemptAt) return { state: 'error', message: 'Automatic resume did not stay open. Open the session manually; another resume will not be attempted for this finding.' };
      checkpoint({ resumeAttemptAt: now(), resumeHandle: entry.resumeHandle });
      session = server.resumeSession(entry.id);
      if (!session) return { state: 'error', message: 'Could not resume the saved session. Open it manually.' };
    }
    if (delivery.pending.resumeHandle && server.persistence.get(entry.id)?.resumeHandle !== delivery.pending.resumeHandle) {
      return { state: 'uncertain', message: 'The resumed conversation changed. Check the session before clearing this finding.' };
    }
    if (!session.status) return { state: 'waiting', message: delivery.pending.resumeAttemptAt && now() - delivery.pending.resumeAttemptAt > 90_000
      ? 'Session has not become ready. Check its terminal for login or startup prompts.' : 'Waiting for the session to finish starting.' };
    const uncertainMonitor = server.monitors?.rows?.find(m => m.sessionId === entry.id && m.pending?.phase === 'uncertain');
    const uncertainError = [...(server.agentErrors?.records?.values() || [])].find(row => row.sessionId === entry.id && row.pending.phase === 'uncertain');
    const uncertainPlugin = server.pluginRequests?.uncertain(entry.id);
    if (uncertainPlugin) return { state: 'waiting', retryAfterMs: 60_000,
      message: `A plugin submission is uncertain. Inspect this session, then clear it without resending: clideck errors acknowledge plugin-request:${uncertainPlugin.pluginId}:${uncertainPlugin.id}` };
    if (uncertainMonitor || uncertainError) return { state: 'waiting', retryAfterMs: 60_000,
      message: 'An earlier submission is uncertain. Inspect the session before clearing it without resend: '
        + (uncertainMonitor ? `clideck monitor acknowledge ${uncertainMonitor.id}` : `clideck errors acknowledge ${uncertainError.pending.id}`) };
    let available = availableAskSession(entry, server.sessions, server.askCoordinator);
    let steered = false;
    if (delivery.steer === true && available.error === 'busy') {
      available = availableSteerSession(entry, server.sessions, server.askCoordinator);
      steered = !available.error;
    }
    if (available.error) return { state: 'waiting', message: available.error === 'user_typing'
      ? 'You’re typing in this session; the message is saved for later.' : 'Session is busy or showing a prompt; the message is saved for later.' };
    if (signal.aborted || server.closing) return { state: 'waiting', message: 'Delivery paused while CliDeck stops.' };
    commit(); // Persist the delivery intent before any bytes are inserted.
    message = message.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,
      char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
    let completion;
    if (steered) {
      // Steering ends prior reply ownership and never claims the busy turn's
      // answer. The plugin must correlate any response through its own command.
      completion = server.askCoordinator.steer(session, message);
    } else {
      if (!session.sendPrompt(message, { origin: delivery.origin || 'agent', requestId: delivery.id })) return { state: 'uncertain', message: 'Submission could not be confirmed. Inspect the session, then clear pending without resending.' };
      completion = session.pendingSubmission?.completion;
    }
    const hasReceipt = Boolean(session.pendingSubmission?.completion);
    if (!completion) return { state: 'uncertain', message: 'No submission receipt was available. Check the session before clearing pending.' };
    const result = await new Promise(resolve => {
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value);
      };
      const abort = () => finish({ ok: false });
      const timer = setTimeout(() => finish({ ok: false }), 15_000);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      completion.then(finish, () => finish({ ok: false }));
      if (signal.aborted) abort();
    });
    if (!result.ok) return { state: 'uncertain', message: result.message || 'Delivery was interrupted or not confirmed. Text may already be inserted; check the session, then clear pending.' };
    if (!hasReceipt) return { state: 'uncertain', message: 'No submission receipt was available. Check the session before clearing pending.' };
    if (steered) return { state: 'sent', steered: true, message: 'Message steered into the active turn (delivery only). No reply belongs to this request; use an explicit plugin reply command.' };
    return { state: 'sent', message: 'Message delivered to the session.' };
  };
}

module.exports = { createSessionDelivery };

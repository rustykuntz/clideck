// Telegram — client half. Runs in the sandboxed client Worker: no DOM. It keeps the server's snapshot, puts
// the quick controls in the terminal header's plugin menu (this session's Phone switch, I'm away / I'm back,
// a pending-message check) and opens the Telegram workspace page (public/index.html) for setup. Disabling the
// plugin removes every one of these; CliDeck core has no Telegram UI of its own.
//
// Server contract: send 'request' {requestId, action, ...} → reply 'result' {requestId, ok, ...snapshot,
// error, message}; broadcast 'updated' {...snapshot}. The snapshot never carries the bot token.
const WORKSPACE = 'setup';
const UNSUPPORTED = 'Phone works with Claude and Codex sessions for now.';
const TIMEOUT_MS = 20_000;

let snapshot = null;
let seq = 0;
const pending = new Map();

function adopt(data) {
  if (!data || typeof data !== 'object' || !data.telegram) return;
  snapshot = {
    telegram: data.telegram || {},
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    presence: data.presence && typeof data.presence === 'object' ? data.presence : {},
  };
}
const ready = () => !!(snapshot?.telegram?.connected && snapshot.telegram.paired);
const entryFor = (id) => snapshot?.sessions.find((s) => s.sessionId === id) || null;
const sessionOf = (context) => context?.session || null;
// The server decides which agents Phone supports; only its explicit `supported:false` stops us early.
const supported = (session) => entryFor(session?.id)?.supported !== false;
const uncertain = (entry) => entry?.pending?.state === 'uncertain' && entry.pending.id;

export function activate(api) {
  const request = (action, fields = {}) => new Promise((resolve, reject) => {
    const requestId = `tg-w-${Date.now().toString(36)}-${++seq}`;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Telegram didn’t answer in time. Try again.')); }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });
    api.send('request', { requestId, action, ...fields });
  });
  const fail = (error) => api.toast('error', { title: 'Telegram', body: error?.message || String(error) });
  const openSetup = (context) => {
    const session = sessionOf(context);
    if (!session?.id) { api.toast('info', { title: 'Telegram', body: 'Open a session first. Telegram setup opens beside it.' }); return; }
    api.openWorkspace(WORKSPACE, { sessionId: session.id });
  };

  const cleanups = [
    api.onMessage('updated', adopt),
    api.onMessage('result', (data) => {
      const waiting = pending.get(data?.requestId);
      if (!waiting) return; // a reply for the workspace page, or one that already timed out
      pending.delete(data.requestId); clearTimeout(waiting.timer);
      if (data.ok === false) waiting.reject(new Error(data.message || 'Telegram couldn’t do that.'));
      else { adopt(data); waiting.resolve(data); }
    }),
    api.registerWorkspace({ id: WORKSPACE, title: 'Telegram', src: '/plugins/telegram/public/index.html' }),
    api.registerAction({
      id: 'phone-on', label: 'Send this session to my phone', icon: 'phone',
      description: 'Its replies and your phone messages go through its own Telegram topic.',
      placements: ['terminal.header'],
      when: (context) => !!sessionOf(context) && ready() && !entryFor(sessionOf(context).id)?.enabled,
      run: async (context) => {
        const session = sessionOf(context);
        if (!supported(session)) { api.toast('info', { title: 'Telegram', body: UNSUPPORTED }); return; }
        try {
          await request('phone', { sessionId: session.id, enabled: true });
          api.toast('success', { title: 'Telegram', body: 'Phone on. This session has its own topic in Telegram.' });
        } catch (error) { fail(error); }
      },
    }),
    api.registerAction({
      id: 'phone-off', label: 'Stop sending to my phone', icon: 'phone',
      description: 'Its Telegram topic stays, marked Off.',
      placements: ['terminal.header'],
      when: (context) => !!sessionOf(context) && !!entryFor(sessionOf(context).id)?.enabled,
      run: (context) => request('phone', { sessionId: sessionOf(context).id, enabled: false })
        .then(() => api.toast('success', { title: 'Telegram', body: 'Phone off for this session.' }), fail),
    }),
    api.registerAction({
      id: 'check-pending', label: 'Check a phone message…', icon: 'phone',
      description: 'A phone message may not have reached this session completely.',
      placements: ['terminal.header'],
      when: (context) => !!uncertain(entryFor(sessionOf(context)?.id)),
      run: openSetup,
    }),
    api.registerAction({
      id: 'away', label: 'I’m away from the desk', icon: 'send',
      description: 'Replies to what you asked at the desk in Phone sessions also go to Telegram.',
      placements: ['terminal.header'],
      when: () => ready() && snapshot.presence.away !== true,
      run: () => request('presence', { mode: 'away' }).catch(fail),
    }),
    api.registerAction({
      id: 'back', label: 'I’m back at the desk', icon: 'send',
      placements: ['terminal.header'],
      // Back to Auto where it works, so the next idle stretch is noticed again; Here otherwise.
      when: () => ready() && snapshot.presence.away === true,
      run: () => request('presence', { mode: snapshot.presence.supported === false ? 'here' : 'auto' }).catch(fail),
    }),
    api.registerAction({
      id: 'open', label: 'Telegram', icon: 'send',
      description: 'Connect a bot, pair your phone and choose when replies go to Telegram.',
      placements: ['toolbar'],
      run: openSetup,
    }),
    api.registerAction({
      id: 'configure', label: 'Configure', icon: 'send',
      description: 'Open Telegram setup beside the current session.',
      placements: ['plugin.settings'],
      run: openSetup,
    }),
  ];
  request('status').catch(() => {});

  return () => {
    for (const cleanup of cleanups) cleanup?.();
    for (const waiting of pending.values()) clearTimeout(waiting.timer);
    pending.clear();
    snapshot = null;
  };
}

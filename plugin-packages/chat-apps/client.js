// Chat apps — client half. Runs in the sandboxed client Worker: no DOM. It opens the Chat apps page
// (public/index.html) from the app menu and the plugin's Settings card, and — when a chat message may not have
// reached an agent completely — adds "Check a WhatsApp message…" to that agent's header. Disabling the plugin
// removes every one of these; CliDeck core has no chat-app UI of its own.
//
// Server contract: send 'request' {requestId, action, ...} → reply 'result' {requestId, ok, ...snapshot, message};
// broadcast 'updated' {...snapshot}. Snapshot: {whatsapp, sessions, groups, routes, pending}.
const WORKSPACE = 'setup';
const TIMEOUT_MS = 20_000;

let pendingItems = [];
let seq = 0;
const waiting = new Map();

function adopt(data) {
  if (!data || typeof data !== 'object' || !data.whatsapp) return;
  pendingItems = Array.isArray(data.pending) ? data.pending : [];
}
const pendingFor = (sessionId) => !!sessionId && pendingItems.some((p) => p && p.sessionId === sessionId && p.id);

export function activate(api) {
  const request = (action, fields = {}) => new Promise((resolve, reject) => {
    const requestId = `ca-w-${Date.now().toString(36)}-${++seq}`;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('Chat apps didn’t answer in time.')); }, TIMEOUT_MS);
    waiting.set(requestId, { resolve, reject, timer });
    api.send('request', { requestId, action, ...fields });
  });
  // Setup needs no session: with one selected the page opens beside it; with none, the host shows it in the main pane.
  const open = (context) => {
    const sessionId = context?.session?.id;
    api.openWorkspace(WORKSPACE, sessionId ? { sessionId } : {});
  };

  const cleanups = [
    api.onMessage('updated', adopt),
    api.onMessage('result', (data) => {
      const entry = waiting.get(data?.requestId);
      if (!entry) return; // a reply for the workspace page, or one that already timed out
      waiting.delete(data.requestId); clearTimeout(entry.timer);
      if (data.ok === false) entry.reject(new Error(data.message || 'Chat apps couldn’t do that.'));
      else { adopt(data); entry.resolve(data); }
    }),
    api.registerWorkspace({ id: WORKSPACE, title: 'Chat apps', src: '/plugins/chat-apps/public/index.html' }),
    api.registerAction({
      id: 'open', label: 'Chat apps', icon: 'phone',
      description: 'Talk to your agents from WhatsApp groups on your phone.',
      placements: ['toolbar'],
      run: open,
    }),
    api.registerAction({
      id: 'configure', label: 'Configure', icon: 'phone',
      description: 'Connect WhatsApp and choose which agent answers in each group.',
      placements: ['plugin.settings'],
      run: open,
    }),
    api.registerAction({
      id: 'check-pending', label: 'Check a WhatsApp message…', icon: 'phone',
      description: 'A WhatsApp message may not have reached this agent completely.',
      placements: ['terminal.header'],
      when: (context) => pendingFor(context?.session?.id),
      run: open,
    }),
  ];
  request('status').catch(() => {});

  return () => {
    for (const cleanup of cleanups) cleanup?.();
    for (const entry of waiting.values()) clearTimeout(entry.timer);
    waiting.clear();
    pendingItems = [];
  };
}

const { ChatApps } = require('./phone');

function setupState(snapshot) {
  const t = snapshot.telegram;
  const next = !t.connected ? { step: 'connect', message: 'Create a bot with /newbot in BotFather. Paste its token in the Telegram plugin setup, or provide it on stdin to clideck telegram/setup connect.', url: 'https://t.me/BotFather' }
    : !t.topicsEnabled ? { step: 'topics', message: 'Enable private topics for this bot in BotFather, then run clideck telegram/setup connect to check again.', url: 'https://t.me/BotFather' }
    : !t.paired ? { step: 'pair', message: t.pairing ? 'Open the pairing link in your Telegram account and tap Start, then run clideck telegram/setup status.' : 'Run clideck telegram/setup pair and ask the user to open the returned link and tap Start.', ...(t.pairing && { url: t.pairing.url }) }
    : { step: 'ready', message: 'Run clideck telegram/setup test, then clideck telegram/phone on in a session you want to use from your phone.' };
  return { ...snapshot, next };
}

async function activate(api, options = {}) {
  if (['submitRequest', 'getRequests', 'releaseRequest', 'acknowledgeRequest', 'cancelRequest', 'reportError', 'notifyUser', 'getNotifications']
    .some(method => typeof api[method] !== 'function')) throw Error('Telegram requires the updated CliDeck plugin session API. Update and restart the engine, then enable this plugin.');
  let entries = [], projects = [], closing = false;
  const refresh = async () => {
    [entries, projects] = await Promise.all([api.getSessions(), api.getProjects()]);
    entries = entries.map(entry => ({ ...entry, id: entry.sessionId }));
  };
  await refresh();
  const app = new ChatApps({ dataDir: api.dataDir, entries: () => entries,
    describe: id => {
      const entry = entries.find(entry => entry.id === id);
      if (!entry) return 'Deleted session';
      const project = projects.find(project => project.id === entry.projectId)?.name
        || String(entry.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'No project';
      return `${project} · ${entry.name || id}`;
    },
    deliver: async (row, context) => {
      const abort = () => api.releaseRequest(row.id).catch(() => {});
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) return { state: 'waiting', message: 'Phone delivery cancelled.' };
      try { return await api.submitRequest(row.sessionId, row.id, context.message, { resume: true }); }
      finally { context.signal.removeEventListener('abort', abort); }
    },
    getRequests: () => api.getRequests(), releaseRequest: id => api.releaseRequest(id),
    acknowledgeRequest: id => api.acknowledgeRequest(id), cancelRequest: id => api.cancelRequest(id),
    reportError: row => api.reportError(row.sessionId, row.key, row.text), clearError: key => api.clearError(key),
    notifyUser: (id, text) => api.notifyUser(id, text), readNotification: id => api.readNotification(id),
    onChange: event => { if (!closing) api.sendToClients('updated', event); }, ...options,
  });
  api.onEvent(['session.created', 'session.closed', 'config'], async event => {
    if (closing) return;
    await refresh();
    if (event.type === 'session.closed') app.sessionClosed(event.sessionId);
    app.reconcile();
  });
  api.onEvent('session.reply', event => {
    if (!closing) app.sessionEvent({ id: event.sessionId }, { ...event, type: event.phase });
  });
  api.onEvent('user.notice', event => { if (!closing) app.acceptNotification(event); });
  api.onShutdown(async () => { closing = true; await app.close(); });
  api.onClientMessage('request', async (data, context) => {
    if (!data || typeof data.requestId !== 'string' || data.requestId.length > 200) return;
    const { requestId, action, ...args } = data;
    try {
      await refresh();
      const result = action === 'status' ? { ok: true, ...app.snapshot() } : await app.act({ action, ...args });
      context.reply('result', { requestId, ...result });
    } catch (error) { context.reply('result', { requestId, ok: false, error: error.message, message: error.message }); }
  });
  const command = handler => async context => {
    try { await refresh(); return { stdout: JSON.stringify(await handler(context), null, 2) + '\n' }; }
    catch (error) { return { stderr: `Telegram: ${error.message}\n`, exitCode: 1 }; }
  };
  api.registerCommand('setup', command(async ({ args, stdin }) => {
    if (args.length > 1 || !['status', 'connect', 'pair', 'test', 'disconnect'].includes(args[0] || 'status')) throw Error('Use telegram/setup status|connect|pair|test|disconnect. Provide the token only on stdin or in the setup window.');
    const action = args[0] || 'status';
    if (action !== 'status') await app.act({ action, ...(action === 'connect' && stdin.trim() && { token: stdin.trim() }) });
    return { ok: true, ...setupState(app.snapshot()) };
  }));
  api.registerCommand('phone', command(async ({ args, sessionId }) => {
    const [action = 'status', id = sessionId, ...extra] = args;
    if (extra.length || !['status', 'on', 'off'].includes(action)) throw Error('Use telegram/phone status|on|off [session-id].');
    if (action !== 'status') await app.act({ action: 'phone', sessionId: id, enabled: action === 'on' });
    const session = app.snapshot().sessions.find(session => session.sessionId === id);
    if (!session) throw Error('Session no longer exists.');
    return { ok: true, session };
  }));
  api.registerCommand('away', command(async ({ args }) => {
    if (args.length > 1) throw Error('Use telegram/away auto|here|away.');
    if (args.length) await app.act({ action: 'presence', mode: args[0] });
    return { ok: true, presence: app.snapshot().presence };
  }));
  api.registerCommand('pending', command(async ({ args }) => {
    if (args.length && (args.length !== 2 || args[0] !== 'acknowledge')) throw Error('Use telegram/pending [acknowledge <id>]. Inspect the terminal first; this never resends.');
    if (args.length) await app.act({ action: 'acknowledge', id: args[1] });
    return { ok: true, pending: app.snapshot().sessions.filter(session => session.pending) };
  }));
  await app.start();
  for (const notice of await api.getNotifications()) app.acceptNotification(notice);
  return app;
}

module.exports = { activate, setupState };

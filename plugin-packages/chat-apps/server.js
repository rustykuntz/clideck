const { ChatBridge } = require('./bridge');

async function activate(api, options = {}) {
  const bridge = new ChatBridge(api, options);
  api.onShutdown(() => bridge.close());
  api.onEvent(['session.created', 'session.closed', 'config'], async () => { await bridge.refresh(); bridge.changed(); });
  api.onEvent('user.notice', event => bridge.notice(event));
  api.onEvent(['session.reply', 'turn.user', 'agent.final', 'status', 'session.closed', 'session.created'], event => bridge.observeTurn(event));
  api.onClientMessage('request', async (data, context) => {
    if (!data || typeof data.requestId !== 'string' || data.requestId.length > 200) return;
    const { requestId, ...action } = data;
    try { context.reply('result', { requestId, ok: true, ...await bridge.act(action) }); }
    catch (error) { context.reply('result', { requestId, ok: false, message: error.message }); }
  });
  api.registerCommand('whatsapp', async ({ args, sessionId }) => {
    try {
      const [action = 'status', first, second, ...extra] = args;
      const count = { status: 0, pending: 0, connect: 0, disconnect: 0, groups: 0, bind: 2, unbind: 1, test: 1, acknowledge: 1 }[action];
      if (count === undefined || extra.length || args.length - 1 > count || count === 1 && !first || action === 'bind' && !first) throw Error('Use chat-apps/whatsapp status|connect|disconnect|groups|bind <group-id> [session-id]|unbind <group-id>|test <group-id>|pending|acknowledge <request-id>.');
      await bridge.act({ action: action === 'pending' ? 'status' : action,
        ...(action === 'bind' && { groupId: first, sessionId: second || sessionId }),
        ...(['unbind', 'test'].includes(action) && { groupId: first }), ...(action === 'acknowledge' && { id: first }) });
      return { stdout: JSON.stringify({ ok: true, ...bridge.snapshot({ privatePairing: false }),
        next: 'Open Chat apps → Configure to scan the QR code and link each private group to its agent.' }, null, 2) + '\n' };
    } catch (error) { return { stderr: `Chat apps: ${error.message}\n`, exitCode: 1 }; }
  });
  await bridge.start();
  return bridge;
}
module.exports = { activate };

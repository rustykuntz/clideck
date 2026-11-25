// Google Workspace — client half. Runs in the sandboxed client Worker: no DOM. It only opens the account /
// status page (public/index.html) from the app menu ("toolbar") and from the plugin's Settings card. Setup needs
// no session: with one selected the page opens as a tab beside it; with none, the host shows it in the main pane.
// The page talks to the server itself; there is nothing to keep here and nothing to poll. The one server event it
// follows is 'connection-requested' {sessionId}, which opens the page beside that agent. Disabling the plugin
// removes every entry and the page.
const WORKSPACE = 'account';

export function activate(api) {
  const open = (context) => {
    const sessionId = context?.session?.id;
    api.openWorkspace(WORKSPACE, sessionId ? { sessionId } : {});
  };
  const cleanups = [
    // An agent asked to connect a Google account: bring up the page beside that agent so the person can approve it.
    // This only shows the request; nothing is signed in until the person approves on the page.
    api.onMessage('connection-requested', (data) => open({ session: data && typeof data.sessionId === 'string' ? { id: data.sessionId } : null })),
    api.registerWorkspace({ id: WORKSPACE, title: 'Google Workspace', src: '/plugins/google/public/index.html' }),
    api.registerAction({
      id: 'open', label: 'Google Workspace',
      description: 'Connect Google accounts and choose what your agents can use.',
      placements: ['toolbar'],
      run: open,
    }),
    api.registerAction({
      id: 'configure', label: 'Configure',
      description: 'Connect Google accounts and choose what your agents can use.',
      placements: ['plugin.settings'],
      run: open,
    }),
  ];
  return () => { for (const cleanup of cleanups) cleanup?.(); };
}

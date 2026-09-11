// Git Changes — client half. Runs in the sandboxed client Worker, so there is no DOM here: all this does is
// put an action in the terminal header and hand the real surface to a workspace page under public/.
//
// The page is where everything happens, deliberately. A workspace tab is a same-session document tab, so the
// diff sits BESIDE the terminal it belongs to rather than replacing it, and it survives switching tabs
// because the dock hides rather than unmounts.
export function activate(api) {
  const workspace = api.registerWorkspace({
    id: 'changes',
    title: 'Git changes',
    src: '/plugins/git-diff/public/index.html',
  });

  const action = api.registerAction({
    id: 'open',
    label: 'Git changes',
    icon: '⑂',
    description: 'See what has changed in this session’s folder.',
    placements: ['terminal.header'],
    // ⚠️ The session is NESTED in the action context (`pluginActionContext` builds `{surface, selection,
    // session, project}`), and a workspace is per-session, so opening one without an id would land it on
    // whatever happened to be active instead of the session whose header was clicked.
    run: (context) => api.openWorkspace('changes', { sessionId: context && context.session && context.session.id }),
  });

  return () => { action(); workspace(); };
}

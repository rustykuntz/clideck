# Suggestion for CliDeck core: expose the session process id to plugins

## What this asks for

Add the session's pty process id to the two session projections the plugin API hands out, in
`plugin-loader.js`:

```js
// getSession(id), currently line 219
return { id, name: s.name, cwd: s.cwd, pid: s.pty?.pid || 0, commandId: s.commandId,
         presetId: s.presetId || 'shell', themeId: s.themeId, projectId: s.projectId,
         working: state.startsWith('1:') };

// getSessions(), currently line 225
return [...sessions].map(([id, s]) => ({
  id, name: s.name, cwd: s.cwd, pid: s.pty?.pid || 0, commandId: s.commandId,
  presetId: s.presetId || 'shell', themeId: s.themeId, projectId: s.projectId,
  working: (sessionStatus.get(id) || '').startsWith('1:'),
}));
```

Two lines. No behaviour change for existing plugins, and nothing new is computed: `pty.pid` is
already on the session object created in `sessions.js:119`.

## Why a plugin needs it

`cwd` in the projection is the folder a session was **spawned** in, fixed at creation
(`sessions.js:205`, `:242`, `:287`). It is not where the session is now. An agent that runs
`cd` into a subdirectory, or into a git worktree, leaves `cwd` pointing at the original folder,
and a plugin has no way to notice.

That gap is visible in the Git Diff plugin. A session started in a repository's main checkout,
whose agent then moved into a linked worktree, would show the diff of the main checkout: usually
empty, and confusing, because the terminal clearly shows work happening somewhere else.

With a pid, a plugin can read the real working directory. On Linux that is
`readlink /proc/<pid>/cwd`, which is cheap and needs no privileges for a process owned by the
same user. macOS has no `/proc`, so a plugin there would fall back to the spawn folder or shell
out to `lsof`. The point is that the pid is the only missing piece; everything after it is the
plugin's problem.

## Other uses this would unlock

- Resource display: read `/proc/<pid>/stat` or run `ps` for CPU and memory per session, so a
  plugin could show which agent is actually busy.
- Liveness beyond the status heuristic: `process.kill(pid, 0)` answers whether the process is
  still there, independent of the output-based working/idle detection in `plugin-loader.js`.
- Process inspection: which command a session is really running now, from
  `/proc/<pid>/comm` or `cmdline`, rather than the configured `commandId`.
- Targeted signals: a plugin could send `SIGINT` to a specific session rather than writing
  `\x03` into the terminal and hoping the foreground process takes it.

## Why not just reach for it another way

A plugin can already get the pid without any core change, and that is the argument for adding
it. Because `sessions.js` is loaded in the same process before plugins initialise, a plugin can
scan `require.cache` for it and call `getSessions()` to reach the live session map, `pty`
object included:

```js
for (const mod of Object.values(require.cache)) {
  if (mod.filename.endsWith('/sessions.js') && typeof mod.exports.getSessions === 'function') {
    const pid = mod.exports.getSessions().get(sessionId)?.pty?.pid;
  }
}
```

That works today. The Git Diff plugin deliberately does **not** do it, and the feature stays
switched off instead, because the technique is worth discouraging: it bypasses the projection
the API exists to provide, it hands a plugin the whole `pty` object rather than one field, and
it breaks silently on any rename, bundling change or move to ESM. A plugin author who wants
this badly enough will reach for it anyway. Exposing one integer through the API removes the
incentive and keeps the boundary meaningful.

## Security note

The pid is only useful to code already running inside the CliDeck server process, which can
call `process.kill` or read `/proc` regardless. Plugins are trusted code, installed
deliberately from disk, and already receive `inputToSession`, `createSession` and
`closeSession`. Adding a pid grants no capability that is not already reachable.

## Compatibility

Additive. Existing plugins ignore the extra field. `0` is a reasonable value for a session with
no live pty, so a plugin can treat falsy as "unavailable" without special cases, which is what
Git Diff does:

```js
function ptyPid(session) {
  return session && Number.isInteger(session.pid) && session.pid > 0 ? session.pid : 0;
}
```

Today that always returns `0`, the live folder lookup is skipped, and the plugin uses the spawn
folder. If this change lands, the feature starts working with no edit to the plugin.

## Status

Proposed, not applied. The change is not made locally because patching `plugin-loader.js` in a
fork means carrying a diff against a file upstream also edits. CONTRIBUTING.md points feature
ideas at a **Show & Tell** Discussion, so that is where this goes, alongside the plugin itself.

# Build a CliDeck plugin

A plugin is one self-contained folder. You do not need CliDeck source code,
global packages, or an install script.

```text
my-plugin/
  clideck-plugin.json
  server.js       optional trusted Node backend
  client.js       optional browser integration
  public/         optional viewer/app/model assets
```

Start with the manifest:

```json
{
  "id": "browse-web",
  "name": "Browse Web",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Fetch and inspect web pages from a CliDeck session.",
  "commands": [{
    "name": "browse",
    "description": "Browse a URL and return readable text.",
    "usage": "browse-web/browse <url>"
  }],
  "settings": [{
    "key": "timeout",
    "label": "Timeout (seconds)",
    "type": "number",
    "default": 30,
    "min": 1,
    "max": 120
  }]
}
```

The folder name must exactly equal the lowercase plugin `id`. IDs, display
names, commands, and settings keys are unique. Validate before installation:

```bash
clideck plugin validate ./browse-web
clideck plugin install ./browse-web
```

Installing validates and atomically copies the folder into the engine's plugin
directory. It never runs npm. Bundle any dependencies you require. Manual copy
into `<dataDir>/plugins/` followed by Refresh Plugins is equivalent.

The optional manifest boolean `enabledByDefault` controls initial activation
(defaults to `true`). Use `false` to require the user to enable the plugin first.
A saved enabled/disabled choice always takes precedence, just as saved setting
values take precedence over setting defaults.

## Backend

`server.js` exports one activation function. Errors are contained in the
plugin's supervised worker.

```js
exports.activate = async (api) => {
  api.registerCommand('browse', async ({ args, stdin, sessionId }) => {
    const url = args[0] || stdin.trim();
    const response = await fetch(url);
    return { stdout: await response.text(), exitCode: response.ok ? 0 : 1 };
  });

  api.onEvent('agent.final', (event) => {
    api.log('final from', event.sessionId);
  });

  api.onClientMessage('refresh', (data) => {
    api.sendToClients('refreshed', data);
  });

  api.onShutdown(async () => {});
};
```

The backend API is defined in [plugin-sdk/index.d.ts](plugin-sdk/index.d.ts).
It exposes canonical events, cloned session/project snapshots, transcript
turns, normal session prompt/input/lifecycle paths, validated settings,
namespaced client messages, commands, logging, and a private data directory.
Do not read core persistence files or parse raw terminal screens.

A custom document viewer declares its durable kind and MIME pair in the
manifest, registers its sandboxed renderer from `client.js`, and publishes
payloads from the backend through the existing content lifecycle:

```json
{ "viewers": [{ "id": "report", "mime": "application/json" }] }
```

```js
await api.showContent(sessionId, {
  kind: 'browse-web/report',
  mime: 'application/json',
  name: 'Web report',
  data: JSON.stringify(report),
});
```

The payload is capped at 10MB, spills into the session's asset storage, and
inherits replace-by-name, refresh/restart replay, close, and session deletion.
V1 custom content is payload-only; plugins do not gain arbitrary file serving.

Every agent command is invoked as:

```bash
clideck browse-web/browse https://example.com
```

Root commands such as `ask`, `show`, and `agents` cannot be claimed by a
plugin. Enabled commands are advertised through `clideck plugins`, dynamic
`clideck --help`, and the system guide injected into spawned agents.

## Client

`client.js` exports `activate(api)`. It runs in a dedicated Worker, never in the
CliDeck window. The host API registers actions, viewers, workspace tabs,
hotkeys, namespaced messages, toasts, and bounded audio playback. CliDeck
renders its own menus, tabs, focus, loading and error states; plugins do not
query or mutate host DOM. `getSettings()` and `onSettingsChange()` expose
`{ values, configured }` to client-only plugins. Secret values are never sent
to the browser; their `configured` flag only says whether one is stored.

```js
export async function activate(api) {
  api.registerAction({
    id: 'read-selection',
    label: 'Read aloud',
    placements: ['terminal.context', 'viewer.context'],
    when: (context) => Boolean(context.selection?.text),
    run: (context) => speak(context.selection.text),
  });

  return () => stopEverything();
}
```

An unrestricted visual application registers a workspace tab backed by a
sandboxed page under `public/`. A custom viewer registers the namespaced
kind/MIME pair declared in its manifest and renders inside the existing
document-tab shell.
Registrations are automatically removed when the plugin is disabled or fails.

For example, a workspace can open from the terminal actions menu:

```js
api.registerWorkspace({ id: 'changes', title: 'Git changes', src: '/plugins/git-diff/public/index.html' });
api.registerAction({
  id: 'open', label: 'Git changes', placements: ['terminal.header'],
  run: (context) => api.openWorkspace('changes', { sessionId: context.session.id }),
});
```

The page sends `parent.postMessage({ type: 'clideck.ready' }, '*')` and receives
`clideck.init` with `data.context`, `data.theme`, and `data.visible`. To contact
its backend, it sends `{ type: 'clideck.send', event: 'diff-request', data: {...} }`.
Backend `context.reply('diff-result', data)` returns as `clideck.message`, with
`data.event` and `data.data`. Accept messages only from `parent`. Replies reach
that browser's frames for the plugin, so use a unique request ID for each page
and accept only matching replies. The client Worker instead uses `api.send()`
and `api.onMessage()`.

Setting keys and plugin event names use lowercase letters, digits, and hyphens;
dots and camelCase are invalid. A page receives `clideck.visible` when its tab is
shown or hidden, and `clideck.theme` when the theme changes. Pause polling while
hidden; tabs remain mounted. Git Changes provides a complete workspace example.

Generated audio crosses the Worker boundary as an `ArrayBuffer` and is played
by one host-owned player through `playAudio()`; `stopAudio()` only stops that
plugin's clip. This keeps playback controls accessible and consistent without
giving plugin code DOM access. Audio may include a bounded `readAlong` timeline:
the terminal session, the exact text that was spoken, and source ranges paired
with audio start/end times. Ranges may overlap, so a sliding window is expressed
simply as one cue per advance; the current cue is the last one to have started.
Mark an inexact clock with `timing: 'estimated'` and the host draws a softer mark
with no hard edge.

`getTerminalSelectionSnapshot()` returns the terminal selection together with an
opaque `anchor` for the cells it occupies (also on `context.selection.anchor`).
Carry it back verbatim as `readAlong.anchor` and the host resolves the spoken
text against exactly those cells instead of the freshest copy on screen, which is
what keeps a repeated phrase from lighting the wrong occurrence. The token is
derived rather than allocated, so an unchanged selection always spells the same
string and it is safe to use in a cache key.

The host owns highlighting throughout and may ignore the hint: an anchor it can
no longer trust, or source text the buffer no longer holds, produces no
highlight rather than an approximate one.

`readAlong.surface` may also be `viewer`, which marks a document tab instead of
the terminal. That form needs `contentId` — a tab can change under a long read —
and takes `sourceOffset`, the index of this clip's text inside the string
`getActiveViewerText()` returned. With the offset the host verifies that exact
slice and never searches, so repeated content cannot map to the wrong copy;
without it, text that occurs more than once is refused.

`sourceOffset` means something weaker on the **terminal**, and it is worth
knowing which you are getting. There it is an index into the raw text of the
**anchored selection**, and only a hint: the host still searches the selected
cells and, among equal matches, takes the one nearest that point — the selection
string and the screen are not the same spelling, so it places a batch of a long
read without claiming the two are identical. **Without an `anchor` it is ignored
entirely**, because an auto-read's offset counts from the start of the reply and
the scrollback it is searched against knows nothing about that; there the host
takes the most recent match, which is the copy just printed.

A long reading is a run of clips rather than one enormous clip. Give every clip
of one read the same `options.sequence` and play them with
`playAudioAndWait()`, which resolves `true` on a natural end and `false` on
stop, replacement, unload or error. The host keeps the transport — and its Stop
— on screen between parts, and once the user stops that read, the next clip
carrying the same id resolves `false` immediately and plays nothing, including
one that was still being prepared. So the whole sequencer is a loop, with no
queue in the host and no timers on either side; call `stopAudio()` after the
last part.

## Trust and compatibility

Backend plugins are arbitrary local code with the user's filesystem and network
authority. Install only code you trust. Worker isolation protects CliDeck from
accidental crashes; it is not a malicious-code sandbox.

The current API version is `1`. Require only capabilities you use and ignore
unknown additive fields. A plugin requiring another API version is shown as
incompatible and never loaded. See [PLUGINS-DESIGN.md](PLUGINS-DESIGN.md) for
the product boundary and lifecycle rules.

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

Every plugin shipped in `plugins/` or `plugin-packages/` appears in Settings and
`clideck plugins`, including disabled plugins. Google Workspace and Telegram
ship disabled; enable them with their switch or `clideck plugin enable <id>`.
Listing a disabled plugin never activates its code. Earlier user-installed
copies retain their code, settings and activation state; removing such a copy
reveals the shipped version, disabled, while keeping its settings and data.

Third-party plugins install from an unpacked folder using Settings or
`clideck plugin install ./my-plugin`. `clideck plugins --all` also lists any
packages added since the last refresh. `clideck plugin info <id>` returns the
description, commands, redacted settings and bounded README setup instructions.

Make commands agent-friendly: include a status/setup command that returns the
current state and next step, reuse the same handlers as your UI, and report
failures through nonzero exit codes. A command that presents a pairing link has
not completed pairing. Secrets belong on stdin or in a secret setup control,
never command arguments or command output. Agents may enable/disable a plugin
or apply validated settings using `clideck plugin settings <id> --stdin`.

The optional manifest boolean `enabledByDefault` controls initial activation
(defaults to `true`). Use `false` to require the user to enable the plugin first.
A saved enabled/disabled choice always takes precedence, just as saved setting
values take precedence over setting defaults.

A setting may include a nonempty `group` label (up to 80 characters). Settings
with the same label appear together in a collapsed, labelled section below the
ungrouped fields. Use this for optional or advanced configuration; keep the
required first-use fields ungrouped.

If copying succeeds but activation fails, installation returns an error with the
reason and leaves the installed folder available for repair. It never reports a
failed activation as a successful ready plugin.

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

For a short recap, use `getTurns(sessionId, 4, 12000)` when
`api.capabilities?.boundedTurns === true`. The optional third argument caps the
total returned text at 1–64,000 UTF-16 characters; core reads at most 1 MiB from
the transcript tail. It returns the same `{role: 'user'|'agent', text}` array,
merges adjacent same-role entries and keeps the newest text (the first turn can
start mid-message). This is captured user/final-answer text, not full model
context or live reasoning. Missing history returns `[]`; if no complete record
fits in the read budget, the request fails explicitly. Omitting
the argument preserves the existing behavior. Older engines do not enforce it:
check the running engine capability before relying on the bound.

Return failures to the initiating command: throw an error or return a nonzero
`exitCode` with diagnostic `stderr`. Await asynchronous work, including browser
receipts, before completing the handler; broadcasting a client event is not a
completion receipt. CLI commands may wait up to one hour, and plugins should use
their own shorter deadline and return an explicit error if it expires.
`sendPrompt` resolves only after submission is confirmed; interrupted delivery
rejects because text may already be present. Never blindly resend it. Observable
preview failures after `showContent` are reported to that content's session.

For a request originating outside CliDeck, use `submitRequest(sessionId,
requestId, text, {resume: true})` with a stable unique ID. It returns `waiting`,
`sent`, `uncertain` or `error` and shares the normal busy/typing/menu guards.
Resume requires the same saved native conversation; a fresh session is never
silently substituted. Receipts persist before any paste, deduplicate retries,
and remain in core if the plugin is disabled. `getRequests()` recovers receipts
and completed answers after a worker restart. Release a completed request only
after saving its answer/delivery state; acknowledge uncertainty only after the
user/agent has inspected the terminal, never as a retry mechanism.

With `api.capabilities?.sessionSteer === true`, `{steer: true}` also permits
delivery to a working session through the existing steering path. Idle sessions
still receive a normal request with native reply ownership. Busy delivery returns
`{state: 'sent', steered: true, message}` and stores a `complete` receipt with
`steered: true`: this confirms delivery only, not completed agent work. It ends
any previous reply ownership and does not capture an answer or allow
`cancelRequest` to stop that turn. Use an explicit plugin reply command with your
own operation/delegation ID when a response is needed. Typing, menus, a paste in
progress and uncertain deliveries still block steering. `waiting` is not an
automatic queue; retry with the same request ID, session, text and options.
Changing an ID's prompt or delivery options is rejected, including after restart.

Subscribe to `session.reply` for request-owned replies. It carries `sessionId`,
`requestId`, `origin` (`plugin:<id>` or `desktop`) and `phase` (`turn.started`,
`agent.update`, `agent.final`, `menu`, `turn.ended`, `request.acknowledged`), plus the corresponding text,
choices or reason. Ownership begins at the submitted prompt's native echo,
available for Claude and Codex. A later request, steering, input or interruption
ends ownership. Never route a generic `agent.final` as the next external answer.
`cancelRequest(id)` interrupts only that plugin's exact owned active turn;
`releaseRequest(id)` stops waiting without stopping ongoing agent work.

Use `reportError(sessionId, key, text)` for later failures, and `clearError(key)`
after recovery. Keys are namespaced to the plugin and deduplicate failures.
`notifyUser(sessionId, text)` stores a local user notification. The agent-facing
equivalent is `clideck notify "<short message>"`. `user.notice` events and
`getNotifications()` let delivery plugins forward notices; `readNotification(id)`
marks successful delivery read. A plugin's own notices have `origin: plugin:<id>`
so it can avoid forwarding its delivery errors back into itself.

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

`toolbar` actions appear in the sidebar's app menu; `terminal.header` actions
appear in the session's **More for this session** menu.
`terminal.primary` puts a prominent action directly in the session header;
reserve it for the plugin's main session control, with a matching Stop action
while active. Set `iconOnly: true` for a compact icon control (its `label` remains
the accessible name) and `pressed: true | false` for a toggle's highlighted and
`aria-pressed` state. `terminal.voice` remains the dictation microphone affordance.
Actions may also use `plugin.settings` placement to add a Configure button to
their own Settings card. `openWorkspace(id)` uses the active session when one is
selected; otherwise it opens in the main pane without creating an agent session.
That frame receives an empty session ID and must not assume a calling agent.
Selecting a session hides the app workspace; Close or disabling its plugin
disposes it. An explicitly supplied deleted/invalid session ID is refused.
A sandboxed workspace can open an HTTP, HTTPS or mailto link through
`parent.postMessage({type:'clideck.open', url}, '*')`; the host validates and
rate-limits it, refuses links back to the app's own origin, and never grants the frame general popup
access. Disabling a plugin removes its registered controls and workspace assets.

`api.openSettings()` opens only the calling plugin's Settings card and returns
its success receipt; it does not accept another plugin's ID.

### Desktop integration and browser fallback

The same client plugin works in the browser and desktop app. Check
`api.capabilities.desktop === true` for desktop-specific presentation; it is absent
in the browser. Backend plugins continue to run in ordinary Node workers with the
same SDK, settings and private data directories.

- `await api.notify({ title, body, sessionId? })` requests a notification and returns
  whether the host accepted it. It follows the person's notification settings and
  allows at most one notification per second per plugin. Desktop delivery uses a
  native notification; its click focuses the app and optional session. Browser
  delivery uses the existing browser-notification permission.
- `await api.openExternal(url)` opens an HTTP, HTTPS or mailto URL through the same
  validated, rate-limited host path as workspace `clideck.open` links. Plugin links
  always open in the system browser from the desktop app. Ordinary app web links
  follow Settings → Desktop app → Open web links; Google authorization always
  opens in the system browser. Browser links use `noopener`.

These are host capabilities, not access to Electron or Node from plugin UI code.
Client Workers and sandboxed workspace/viewer frames retain their existing
isolation. Older clients may not expose these methods; feature-detect them before
calling when supporting older CliDeck releases.

### Live browser audio and focus

Check `api.capabilities?.realtimeAudio === true`, supplied by the running browser
host. A newer Worker loaded by an old page does not advertise support. The host
also requires browser WebRTC/microphone support and localhost or HTTPS; denied
permission, blocked playback and failed connections return explicit errors.

Subscribe to `onActiveSessionChange(handler)` for an initial snapshot and later
changes: `{session, focused, visible, connected}`. Focus means the browser window
has document focus, not that a particular input owns the caret. The host cuts
live capture/playback synchronously before notifying the Worker on session
switch, focus/visibility loss, disconnection, session removal or teardown.
Returning focus never restarts media. A plugin may start a fresh connection for
an explicitly enabled, currently focused session; discard old session replies
and pending signaling. Do not cancel the underlying agent's work on focus loss.

```js
const { id, offerSdp } = await api.openRealtimeAudio({
  sessionId, channelLabel: 'events', // label optional, 1–128 UTF-8 bytes
  signal: openingController.signal, // optional AbortController owned by the Worker
});
// Exchange SDP through the plugin backend; standard provider keys stay there.
await api.setRealtimeAudioAnswer(id, answerSdp);
// Wait for onRealtimeAudioEvent({type:'state', state:'connected', id, sessionId}).
await api.sendRealtimeAudioData(id, JSON.stringify(providerEvent));
await api.closeRealtimeAudio(id);
```

`onRealtimeAudioEvent(handler)` supplies `{id, sessionId, type, state?, data?,
error?}`. States are `connecting`, `connected` (data channel open), and `closed`;
data is opaque text, never provider-interpreted by core. Subscribe before opening
and match connection/session IDs. SDP and each data message are capped at 64 KiB
UTF-8; outbound buffered data is capped at 256 KiB. Invalid or stale answer/send
calls reject; closing an already closed/unowned ID returns `false`. No automatic
retry or buffering is performed. A connection must open its data channel within
60 seconds, including permission and signaling; late permission/SDP/playback
cannot revive a cancelled connection.
Abort the opening controller when Stop is pressed while permission or SDP is
pending: no connection ID is available yet. The signal stays in the Worker;
core cancels only that exact opening request. Once the promise resolves, use
`closeRealtimeAudio(id)` to stop the established connection.

The host owns `MediaStream`, `RTCPeerConnection`, a gathered SDP offer and remote
audio. Plugins own signaling, providers, voice/instructions and browser claims;
use targeted backend `context.reply` for SDP, not broadcast `sendToClients`.
Only one live media reservation exists per page, including while opening. Live
audio refuses active dictation or clip playback, and blocks new dictation/clips
until closed. No iframe permissions or provider-specific core state are added.

Existing `startMicrophone()`, `stopMicrophone()`, `onMicrophoneData()` and
`onMicrophoneState()` expose host-captured mono 16 kHz PCM16 in 100 ms chunks for
dictation. They are separate from the focus-bound WebRTC connection; plugin
Workers and workspace frames never receive its media objects.

Generated audio crosses the Worker boundary as an `ArrayBuffer` and is played
by one host-owned player through `playAudio()`; `stopAudio()` only stops that
plugin's clip. This keeps playback controls accessible and consistent without
giving plugin code DOM access. An optional `playbackRate` (1, 1.1, 1.25 or 1.5)
sets the player's speed when a new reading starts; later parts of the same
reading keep any speed the listener picked, and other values are ignored.
Audio may include a bounded `readAlong` timeline:
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
unknown additive fields. Backend `api.capabilities` is frozen and supplied by the
running engine; older engines may omit it. Installing an updated plugin does not
upgrade the engine: check `api.capabilities?.sessionSteer === true` before relying
on busy-session steering. A plugin requiring another API version is shown as
incompatible and never loaded. See [PLUGINS-DESIGN.md](PLUGINS-DESIGN.md) for
the product boundary and lifecycle rules.

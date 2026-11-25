# CliDeck Desktop

The Electron application lives beside the existing engine. Browser and CLI use
continue to work; there is one plugin SDK and one session store, not a desktop fork.

## Development

Use Node 24 LTS, then install and start the desktop package:

```sh
npm --prefix desktop ci
npm --prefix desktop start
```

By default the app attaches to the engine owning `~/.clideck-next/server.lock`.
If none is running, it starts the existing engine on its previous loopback port,
or an available port if that port is occupied. Browser-local presentation settings
are backed up in the desktop profile and restored before loading a changed origin.
Installed providers, project settings, session history and plugin data stay in
their existing locations. Closing **or quitting the desktop client leaves the
engine and agents running**. Reopening attaches to them. Start-at-login is opt-in.

For development or tests, use isolated directories:

```sh
CLIDECK_DESKTOP_DATA_DIR=/tmp/clideck-desktop-demo/data \
CLIDECK_DESKTOP_PROFILE=/tmp/clideck-desktop-demo/profile \
npm --prefix desktop start
```

When invoking Electron directly, also set `CLIDECK_DESKTOP_NODE` to an absolute
Node executable path. The npm start command supplies its Node path automatically.
Tests must clean up only their own engine PID, recorded in the isolated
`data/server.lock`; never stop the user's shared engine.

## Build

```sh
npm --prefix desktop run build:dir
npm --prefix desktop run build
```

Build on the target OS and architecture. The preparation script copies only the
engine's npm package allowlist, installs its locked production dependencies with
the build's ordinary Node runtime, and bundles that same Node executable. Native
modules therefore use Node's ABI, not Electron's. The generated runtime manifest
records the Node version, platform, architecture and content digest.

Packaged engines are copied once into a versioned directory in the desktop
profile. This path survives replacement of the app bundle. An already-running
engine is reused even after installing a newer desktop app; restart the engine
only when its sessions can be interrupted. Old runtime caches are deliberately
retained because live agents and plugins may still reference them.

Output goes to `desktop/dist/`: macOS DMG/ZIP, Windows NSIS, Linux AppImage/deb.
Signing/notarization use electron-builder's standard credentials. For an unsigned
local build set `CSC_IDENTITY_AUTO_DISCOVERY=false`. Signed distribution and an
automatic desktop update feed require release configuration; this development
package does not publish anything or auto-replace a running engine. Bundled engines
cannot run the npm self-installer.

## Desktop contract

The trusted top-level CliDeck window and startup screen receive
`window.clideckDesktop`. Plugin frames, document previews and external browser
windows have no Node integration or desktop bridge privileges.

- `getState()` and `onState(callback)` expose engine state, window state,
  preferences, platform, version and supported native capabilities.
- `getPreferences()` / `setPreferences(patch)` manage only desktop settings:
  `externalLinks` (`browser` or `app`), `closeToTray`, `startAtLogin`.
- `openExternal(url)` always uses the system browser. Ordinary `window.open`
  follows the link preference; Google OAuth and authorization URLs always use the
  system browser. Embedded external pages have a separate sandboxed session.
- `notify({title,body,sessionId?})`, `showItemInFolder(path)`,
  `setBadgeCount(count)` and `setActivity({working,waiting})` provide host-controlled
  OS integration. Notification clicks focus the app and requested session.
- `registerShortcut({id,accelerator})` / `unregisterShortcut(id)` are bounded
  host-level APIs. Shortcut actions arrive as `{id:'shortcut',shortcutId}`.
- `setAppearance({mode,overlay?})`, `hideWindow()`, `retryEngine()` and `quit()`
  support native window behavior and recovery. Retrying never replaces a live
  engine or automatically restarts agents.
- `onAction(callback)` emits native menu IDs or a notification's
  `{id:'focus-session',sessionId}`. Subscriptions return an unsubscribe function.

Engine logs live at `<desktop profile>/logs/engine.log`. UI/plugin state uses the
same engine protocol in the browser and desktop clients. Native plugin features
must go through the existing host SDK rather than granting plugin frames Node or
Electron access.

## Verification

`npm --prefix desktop test` covers native URL boundaries, settings, runtime
retention, engine reuse, real PTY operation and survival after launcher exit.
The UI tests cover the desktop bridge and browser fallback. Release validation
must also exercise a packaged app on each supported OS, including native helper
execution, copy/paste, external sign-in return and close/reopen session continuity.

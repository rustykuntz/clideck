# Server-side capture experiment

This branch keeps normal CliDeck behavior unchanged. The experimental path is
disabled unless the server is started with:

```bash
CLIDECK_SERVER_CAPTURE=1 node server.js
```

## Goal

Move enough terminal understanding to the server so transcripts, latest agent
answers, menu detection, `clideck ask`, mobile remote, and Autopilot can keep
working even when no desktop browser tab is open.

## Current scope

- Server keeps a lightweight terminal screen/history model from raw PTY output.
- Server derives an independent latest-agent candidate from that screen model.
- On idle, server can commit that candidate to the transcript without waiting
  for browser `terminal.buffer`.
- Server can detect menus from its own screen lines and broadcast `session.menu`.
- Browser/xterm capture still exists and remains the default path.

## Important limits

- This is not a replacement for xterm. The UI still needs xterm for real
  terminal interaction, raw shell sessions, slash menus, approval menus, and
  keyboard behavior.
- The server screen model is intentionally small. It handles common cursor
  movement, line erase, screen erase, wrapping, and scrollback, but it is not a
  complete terminal emulator.
- Claude server-detected menus are surfaced, but they are not treated as a
  work-start signal because the server path does not yet know browser
  `menuVersion`. This avoids confusing startup/resume/compact menus with real
  approval menus.

## Checks

```bash
npm run smoke:capture
npm run smoke:menu
```

For real provider testing with this path enabled:

```bash
CLIDECK_SERVER_CAPTURE=1 npm run smoke:providers -- --provider claude
```

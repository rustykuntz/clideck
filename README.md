# Termix

Termix is a local web UI for running, organizing, and resuming multiple CLI-based coding agent sessions in one place.
At first glance it feels like a cleaner terminal organizer. The real advantage is telemetry: Termix can tell when each agent is working, idle, or waiting for input.

## What It Does

- Runs real PTY sessions through `node-pty`
- Mirrors terminal output in the browser with xterm.js
- Lets you launch multiple CLI tools from one dashboard
- Supports named sessions, command presets, themes, and basic resume metadata
- Ingests local telemetry events to power live agent status
- Persists app config locally

## Current Features

- Smart `+` launcher for configured CLI commands
- Telemetry-powered status dots (`working`, `idle`, `waiting for input`)
- Latest-message preview in the session list so you can scan progress fast
- Telemetry setup prompts and auto-config for supported agents
- Settings panel for:
  - default working directory
  - command list
  - terminal themes
  - close confirmation
- Folder picker for selecting the default path
- Tailwind-based UI
- Session persistence metadata for resumable agents
- Built-in agent presets (`Claude Code`, `Codex`, `Gemini CLI`, `Shell`)

## Tech Stack

- Node.js
- `node-pty`
- `ws`
- `xterm.js`
- Tailwind CSS

## Run Locally

```bash
npm install
npm run build:css
npm start
```

Then open:

```text
http://localhost:4000
```

## Config Files

- `config.json` — user settings and active command configuration
- `agent-presets.json` — built-in CLI agent preset definitions
- `sessions.json` — persisted resumable session metadata written on shutdown

## Main Files

- `server.js` — HTTP server + WebSocket bootstrap
- `handlers.js` — WebSocket message routing
- `sessions.js` — PTY lifecycle + session persistence logic
- `telemetry-receiver.js` — local OTLP log receiver + session activity detection
- `config.js` — config load/save + migration
- `themes.js` — built-in terminal theme presets
- `public/` — frontend UI

## Why Telemetry Matters

Telemetry is the feature that makes Termix indispensable, not just nice-to-have.
In the demo/screenshot, the status dots and latest-message preview do most of the UX heavy lifting: you instantly know who is actively working, who is idle, and where attention is needed.

## Notes

- Termix manages terminal sessions locally on your machine.
- If the Node server stops, live PTY processes stop too.
- Resume support depends on the configured CLI agent and its resume command pattern.

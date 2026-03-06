# Termix

A local web UI for running, organizing, and resuming multiple CLI-based coding agent sessions in one place.
Think Slack for your terminal — a thin coordination layer over your existing tools, not a replacement.

The real advantage is telemetry: Termix knows when each agent is working, idle, or waiting for input.
Status dots, latest-message previews, and browser notifications let you manage many agents at a glance.

## Run Locally

```bash
npm install
npm run build:css
npm start
```

Then open `http://localhost:4000`

## Features

### Session Management
- Real PTY sessions via `node-pty`, rendered in-browser with xterm.js
- Smart `+` launcher with agent preset buttons (MRU ordering, Shell always last)
- Named sessions with random fun placeholders (Color + Animal combos)
- Session resume — persisted to `sessions.json` on shutdown, resume button in sidebar
- Session restart with resume token preservation (e.g. after theme polarity flip)
- Close confirmation modal (toggleable)

### Agent Intelligence
- Built-in presets: **Claude Code**, **Codex**, **Gemini CLI**, **OpenCode**, **Shell**
- Per-agent output markers (⏺ Claude, • Codex, ✦ Gemini, │ OpenCode) for last-message preview
- Working/idle detection via stats-based heuristics (output rate, burst tracking)
- OpenCode plugin bridge for real-time status and preview via `/opencode-events`

### Telemetry
- OTLP HTTP/JSON receiver at `POST /v1/logs`
- Env var injection for supported agents so sessions emit logs to Termix
- Session ID capture from telemetry for resume support
- Setup detection — toast prompt when telemetry isn't configured
- Auto-setup for Codex (`~/.codex/config.toml`) and Gemini CLI (`~/.gemini/settings.json`)
- Per-agent telemetry enable/disable in settings

### Notifications
- Browser notifications when an agent transitions from working to idle
- Notification includes session name, project, and latest message preview
- Minimum work-time filter to reduce noise
- Only fires when the Termix tab is not in focus

### Projects
- Lightweight grouping layer above sessions
- Project creation with name, folder path, and accent color (8 colors)
- Drag-to-organize — drag sessions between project groups
- Collapsible project groups with session counts
- Project context menu: rename, color pick, delete (with confirmation)
- Resumable sessions grouped under their project

### Search & Filter
- Sidebar search matches session name + backend transcript content
- All / Unread tab filtering with unread count badge
- Unread dot on sessions with new output (clears on select)

### Themes & Appearance
- 15 built-in terminal themes (10 dark, 5 light)
  - Dark: Midnight, Dracula, Nord, Catppuccin Mocha, Solarized Dark, One Dark, Monokai, Tokyo Night, GitHub Dark, Gruvbox Dark
  - Light: GitHub Light, Solarized Light, Catppuccin Latte, One Light, Rose Pine Dawn
- Light/dark color mode toggle — auto-switches terminal themes to match
- Per-session theme switching via context menu
- Custom themes via `custom-themes.json`
- Restart banner when switching theme polarity (dark/light)

### Transcript Store
- Per-session JSONL files in `data/transcripts/`
- User input: buffered with backspace support, committed on Enter
- Agent output: 300ms debounced, ANSI-stripped, meaningful lines only
- Powers sidebar search and filter

### Settings
- Default working directory with folder picker
- CLI agent command list management
- Default terminal theme
- Close confirmation toggle
- Notification preferences + browser permission status
- Stats overlay toggle (debug)

## Tech Stack

- Node.js + `node-pty` + `ws` (backend)
- xterm.js + Tailwind CSS v3 (frontend)
- ES modules, no bundler

## Project Structure

### Backend
| File | Purpose |
|------|---------|
| `server.js` | HTTP server, WebSocket bootstrap, OTLP endpoint |
| `handlers.js` | WebSocket message routing, config CRUD, telemetry auto-setup |
| `sessions.js` | PTY lifecycle, resume, restart, persistence |
| `config.js` | Config load/save with migration, preset backfill |
| `telemetry-receiver.js` | OTLP log receiver, session ID capture, setup detection |
| `opencode-bridge.js` | OpenCode plugin event bridge (status, preview, session ID) |
| `transcript.js` | Per-session JSONL transcript store with search cache |
| `stats.js` | Process stats + working/idle heuristics (temporary) |
| `themes.js` | 15 built-in terminal themes + custom theme loader |
| `utils.js` | Shared helpers (parseCommand, resolveValidDir, listDirs) |

### Frontend (`public/js/`)
| File | Purpose |
|------|---------|
| `app.js` | App bootstrap, WebSocket routing, telemetry toast, project UI |
| `state.js` | Shared client state (ws, terms, config, themes, presets) |
| `terminals.js` | Terminal add/remove/select, context menu, preview, status |
| `creator.js` | Inline session creator with agent preset buttons |
| `settings.js` | Settings panel rendering, theme dropdown, save logic |
| `nav.js` | Left navigation rail panel switching |
| `drag.js` | Drag-to-organize sessions between project groups |
| `color-mode.js` | Light/dark mode toggle with auto theme switching |
| `profiles.js` | Theme resolution and accent color helpers |
| `confirm.js` | Close confirmation modal |
| `folder-picker.js` | Directory browser modal |
| `utils.js` | Small helpers (esc, debounce, agentIcon) |

### Config Files
| File | Purpose |
|------|---------|
| `config.json` | User settings and active command configuration |
| `agent-presets.json` | Built-in CLI agent preset definitions |
| `sessions.json` | Persisted resumable session metadata (written on shutdown) |

## Architecture Notes

- **Telemetry** is the primary path for session ID capture (resume). Regex-based PTY output matching is a fallback for agents without telemetry.
- **Stats heuristics** are the source of truth for working/idle detection. Telemetry does not drive working/idle.
- Termix manages terminal sessions locally. If the Node server stops, live PTY processes stop too.
- Resume support depends on the agent and its resume command pattern.

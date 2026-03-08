# Termix

One screen for all your AI coding agents.

![Termix dashboard](assets/termix-themes.jpg)

You're running Claude Code, Codex, and Gemini CLI in separate terminals. You switch between them constantly, forget which one finished, and lose sessions when you close the lid. Termix puts them all on one screen with live status, so you always know what's happening.

Termix is a local dashboard that runs all your CLI agents in one browser tab. It tracks which agents are working, which are idle, and notifies you when they need attention. Everything runs on your machine — nothing leaves localhost.

## Quick Start

```bash
npm install -g termix-cli
termix
```

Open [http://localhost:4000](http://localhost:4000). Click **+**, pick an agent, start working.

Or run directly without installing:

```bash
npx termix-cli
```

## What You Get

- **Live status** — see which agents are working and which are done, without checking each terminal
- **Session resume** — close Termix, reopen it tomorrow, resume your Claude Code conversation where you left off
- **Notifications** — browser and sound alerts the moment an agent finishes or needs input
- **Message previews** — latest output from each agent, right in the sidebar
- **Projects** — group sessions by project with drag-and-drop
- **Search** — find any session by name or scroll back through transcript content
- **Plugins** — ships with Voice Input and Trim Clip. Build your own with the plugin API
- **15 themes** — dark and light built-in, plus custom theme support
- **Zero interference** — native PTY terminals, your keystrokes go straight to the agent, nothing in between

## Supported Agents

Termix auto-detects whether each agent is working or idle:

| Agent | Status detection | Setup |
|-------|-----------------|-------|
| **Claude Code** | Automatic | Nothing to configure |
| **Codex** | Automatic | One-click setup in Termix |
| **Gemini CLI** | Automatic | One-click setup in Termix |
| **OpenCode** | Via plugin bridge | One-click setup in Termix |
| **Shell** | I/O activity only | None |

Claude Code works out of the box. Other agents need a one-time configuration that Termix walks you through.

## How It Works

Each agent runs in a native terminal (PTY). Termix receives lightweight status signals from agents via OpenTelemetry — it sees *that* an agent is working, not *what* it's working on. Your prompts and responses are never read or stored by Termix.

OpenTelemetry runs locally between the agent and Termix. No data is collected, transmitted, or stored outside your machine.

## Platform Support

Tested on **macOS** and **Windows**. Works in any modern browser. Linux: untested — if you try it, open an issue and let us know.

## Documentation

Full setup guides, agent configuration, and plugin development:

**[Documentation](https://termix-a68d5bb0.mintlify.app/)**

## License

MIT

# Termix

One screen for all your AI coding agents.

Termix is a local terminal dashboard that lets you run, monitor, and manage multiple CLI agents from a single browser tab. It knows when each agent is working, idle, or waiting for input — without interfering with how you use them.

## Quick Start

```bash
npm install -g termix-cli
termix
```

Or run directly without installing:

```bash
npx termix-cli
```

Open [http://localhost:4000](http://localhost:4000). Click **+**, pick an agent, start working.

## Supported Agents

- **Claude Code** — telemetry works automatically, zero setup
- **Codex** — one-click telemetry configuration
- **Gemini CLI** — one-click telemetry configuration
- **OpenCode** — plugin bridge for local and cloud models
- **Shell** — plain terminal, no agent features

## Key Features

- **Live status** — see which agents are working and which are idle, at a glance
- **Message previews** — latest output from each agent, right in the sidebar
- **Notifications** — browser + sound alerts when an agent finishes working
- **Session resume** — shut down, come back later, pick up where you left off
- **Projects** — group sessions by project with drag-and-drop
- **Search** — find sessions by name or transcript content
- **15 themes** — dark and light, plus custom theme support
- **Zero interference** — real PTY terminals, nothing between you and the agent

## How It Works

Each agent runs in a real terminal. Termix receives lightweight telemetry signals (OpenTelemetry) from the agents locally — this is how it knows what's happening without reading your prompts or the agent's responses. All data stays on your machine.

## Documentation

Full setup guides, agent configuration, and feature docs:

**[Documentation](https://termix-a68d5bb0.mintlify.app/)**

## License

MIT

# clideck

A local workspace for CLI agents.

Run Claude Code, Codex, Gemini CLI, OpenCode, Pi, and shell sessions in one browser
window. Group them into projects, follow their progress, and pick up conversations
where you left off. Each session is the agent's actual terminal, with its own
tools, configuration, and account.

![CliDeck's terminal workspace with three projects and six agent sessions](public/clideck-workspace.png)

*Projects and sessions on the left; the selected agent's terminal on the right.*

## Quick start

Requires **Node.js 22.12+** and an installed agent CLI.

```sh
npm install -g clideck@2
clideck
```

Open **http://127.0.0.1:4000**, create a project, and add sessions. Mix providers
as needed. You can also run `npx clideck@2`.

## Working with sessions

The interface works like a WhatsApp conversation list: message previews, unread
counts, and activity times let you follow many sessions while working in one.

- **Projects.** Group sessions by working folder; drag them between projects.
- **Live status.** See who is working, idle, or needs your attention. Browser and
  sound notifications let you know when work finishes.
- **Resume and history.** Reopen saved sessions, read earlier conversations, and
  see when stopped sessions were last used. Export session backups for recovery.
- **Search.** Find sessions and search their conversation text. Filter to unread
  sessions when catching up.
- **Saved prompts.** Type `//` to reuse a prompt. `{{session_name}}` and
  `{{project_name}}` fill in the current context.
- **Controls.** Light and dark themes and configurable shortcuts.

## View the output

Read documents and inspect results in tabs beside the terminal:

- Markdown, plain text, logs, JSON, HTML, and PDFs.
- Images (PNG, JPEG, GIF, WebP) and video (MP4, WebM).
- Mermaid diagrams, diffs, charts, and test results.

Drop a file onto the tab strip, or ask an agent to show it:

```sh
clideck show report.md
clideck show demo.html
clideck show walkthrough.mp4
```

![A Markdown report open in a CliDeck preview tab beside its terminal tab](public/clideck-output.png)

## Plugins

- **Git Changes** — inspect edits, branches, and worktree comparisons.
- **Supertonic Voice** — listen to replies or selected text. Voice models download during setup.
- **Emoji** — emoji support in the terminal.
- **Smart Dictation** — optional voice input for prompts.

You can also build plugins with the [plugin SDK](PLUGIN-SDK.md).

## Work as a team

**CliDeck Ask** lets agents send requests to other sessions and receive their
replies, including across providers. You set the direction and review the results.

In an FPS project, you flag enemy voices that don't fit. The character programmer
asks the sound agent for replacements and adds them to the game for you to try.

In a LoRA project, you flag poor results in darker scenes. The training manager
asks the dataset agent for better examples, retrains, and shows you the comparison.

Type `@@` to find sessions such as `@game/sound`. Agents find teammates with
`clideck agents` and contact them with `clideck ask`.

![A request from Codex arriving in another session's Claude Code terminal through CliDeck Ask](public/clideck-ask.png)

*A real exchange: Codex asks Claude Code for a review, then uses the reply to fix an issue.*

## Local setup

```sh
clideck --port 4200
clideck --data-dir /path/to/clideck-data
clideck --help
```

`CLIDECK_PORT` or `PORT` also sets the port. CliDeck binds to localhost and stores
its data in `~/.clideck-next` by default. Agent CLIs use their own network connections.

For development: `npm ci`, `npm test`, then `npm start`.

## Coming from v1

The latest v2 imports legacy sessions, projects, and saved prompts automatically.
Read [the upgrade notes](UPGRADING.md) before updating; see
[session backup and recovery](SESSION-BACKUP.md) for restoring saved work.

Autopilot was removed because agents already have sub-agents; mobile control was
removed because harnesses provide their own remote access.

## License

[MIT](LICENSE)

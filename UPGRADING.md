# Upgrading to CliDeck 2

Use **CliDeck 2.1.0 or newer** when upgrading from v1. Install with
`npm install -g clideck`, stop the old CliDeck process, then run `clideck` again.
Updating npm does not replace a process that is already running.

Requires Node.js 22.12 or newer. The default address is **http://127.0.0.1:4000**.
`--port` takes precedence over `CLIDECK_PORT`, then `PORT`, then the default.

## Your sessions come with you

On startup, CliDeck imports saved v1 sessions, projects, prompts, command settings,
and conversation transcripts from `~/.clideck` into `~/.clideck-next`. Sessions
appear stopped in the sidebar; resume the ones you need. Native conversation
histories stay with the original agent CLIs.

Version 2.1.0 also fixes imported sessions opening a fresh conversation when
CliDeck did not have a cached transcript location. The fix applies to sessions
already imported by 2.0.1; the import does not need to run again.

This also works if you already opened 2.0.0 and saw an empty workspace. Existing
v2 sessions and settings are preserved, and legacy entries are added once.
V1 files remain untouched. A copy of existing v2 settings and registry files is
kept in `~/.clideck-next/before-v1-migration` before the import.

The import runs only for the default v2 data directory. An explicit separate
`--data-dir` stays isolated. Do not point v2 directly at `~/.clideck`: the formats
differ. If old data cannot be read, startup reports the problem without silently
replacing it with an empty workspace.

## Removed features

- **Autopilot:** today's agents already have sub-agents. CliDeck focuses on agents
  working with you and across providers through the CLI.
- **Mobile control:** harnesses provide remote access themselves.
- **LAN binding:** v2 is localhost-only.
- **Legacy plugins:** v2 uses its new plugin SDK; old plugin settings are not imported.

For backups and recovery, see [SESSION-BACKUP.md](SESSION-BACKUP.md).

To return to v1, stop v2, run `npm install -g clideck@1.33.1`, and start CliDeck.
V1 continues using its original data. New v2 work is not copied back to v1.

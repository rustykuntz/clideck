# Upgrading to CliDeck 2

Use **CliDeck 2.1.0 or newer** when upgrading from v1. Install with
`npm install -g clideck`, stop the old CliDeck process, then run `clideck` again.
Updating npm does not replace a process that is already running.

Requires Node.js 22.12 or newer. The default address is **http://127.0.0.1:4000**.
`--port` takes precedence over `CLIDECK_PORT`, then `PORT`, then the default.

## Plugins and phone messaging in 2.7.0

**Google Workspace sign-in warning.** Google is still reviewing the permissions requested by CliDeck’s built-in Google Workspace connection. You may see “Google hasn’t verified this app” during sign-in.

Restart the updated engine and refresh browsers to use the new plugin APIs.
Every shipped plugin now appears in Settings and `clideck plugins`, including
disabled ones. Google Workspace and Telegram start disabled. `plugin info`,
`enable`, `disable` and `settings` let agents
inspect and configure plugins through the same engine controls as the UI.

Enable Telegram in Settings or with `clideck plugin enable telegram`;
it does not contact Telegram until connected.
`clideck telegram/setup status` explains the remaining setup steps. It requires
a BotFather bot with private topics, pairing in Telegram, and an awake computer.
It initially supports Claude and Codex native request receipts. Disabling it
removes its controls and stops Telegram work. Local `clideck notify` notifications
continue without any chat plugin. Uncertain plugin requests can be inspected and
acknowledged through `clideck errors` even after plugin removal.

## Monitors in 2.7.0

Monitors require the updated engine and a browser refresh. They are off until a
session creates one with `clideck monitor add`; no existing session or command is
automatically enrolled. Open the Monitors button beside Task Manager to manage
them. Checks survive agent stops and engine restarts, but do not run while the
engine is stopped or the computer sleeps. Resuming stopped agents is opt-in per
monitor. AI conditions are not included; phone messaging is a separate optional
plugin. Check failures now alert after two consecutive failures (the first retries
after 30 seconds), once per breakage until recovery. Repair notices include the
original add command; correct it before recreating the monitor.

Agent-initiated command failures now return to their caller, including plugin
activation and interrupted prompt submission. Background monitor and preview
errors notify their initiating session through the existing typing/busy guards.
Refresh every browser tab to load preview feedback and the speech receipt protocol;
agent speech commands now wait for actual playback completion or a reported error.

## Version 2.6

After updating, restart CliDeck when you are ready and refresh the browser.
Task Manager needs the new engine as well as the new interface. Open its
bar-chart button beside Plugins to inspect running jobs on macOS or Linux.

The new browser and engine also protect active terminal typing from incoming
`ask` and `--steer` messages. Protection expires four seconds after the last edit
or paste, even if a draft remains. If typing interrupts an incoming message after
its text was pasted, CliDeck cancels its automatic Enter and tells the sender
delivery was interrupted; the inserted text stays in the terminal for you to review.

Supertonic adds eight voices with previews. Mike now displays as Mika and keeps
your saved selection. Dov has been removed; an existing Dov selection falls back
to Female 2. Female 1 and Female 2 retain their original profiles.

Automatic reading now belongs to each session. Use its header speaker button;
the old global setting is retired and sessions start with reading off. Completed
replies wait until their session is selected in a visible browser tab. Only the
latest waiting reply per session is kept, in memory; refreshing or reconnecting clears it.
Voice selection stays shared. Tables, fenced code/diagrams and display formulas
are skipped with a short spoken cue, while ordinary prose and lists are read.

## Update notices

Once this browser-refresh notice is installed and loaded, an older open interface
shows **Updated CliDeck is ready** with a **Refresh** button when newer UI files
are available. It stays until dismissed; it never reloads automatically. Refresh
reloads only the browser tab and leaves agent processes running. Save any unsaved
dialog edits first. The check runs only in a connected, visible tab, at low frequency
and when returning to the app. An engine that still needs restarting does not offer
Refresh as a substitute for that restart.

CliDeck checks for updates in the background when the engine starts and periodically
while it runs. When a newer version is available, the app shows a small notification
with an **Update** button. You can also check from Settings. Failed checks retry
automatically and Settings shows when the registry could not be reached.

For a recognized global npm installation, **Update** installs the advertised version
into that installation. Running agent sessions stay open. When installation finishes,
restart CliDeck when you are ready, then resume your sessions. The running engine
version in Settings does not change until that restart. Updates are never installed
without clicking **Update**.

Source checkouts and installations that cannot be safely identified show manual
instructions instead. Permission or installation failures are reported with a terminal
command to finish the update. Interactive terminal startup also prints an update notice.

Older releases without an update checker need one manual upgrade:
`npm install -g clideck@latest`, then stop and start CliDeck.

## Old agent hooks

Before launching or resuming Claude Code or Codex, CliDeck removes obsolete v1
CliDeck command hooks from that agent's profile. This also applies if you already
upgraded to v2. Profiles selected through `CLAUDE_CONFIG_DIR` or `CODEX_HOME` are
handled separately using the session's launch environment.

Only recognized v1 hook registrations are removed. Other hooks and settings stay
in place. The original file is saved beside it as a private
`.clideck-v1-backup-…` file before replacement. Symlinks are preserved. If a file
cannot be parsed or safely updated, CliDeck leaves it unchanged and prints a
warning. Current v2 hooks are supplied automatically for the new agent process;
already-running processes must be restarted to load the corrected configuration.

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

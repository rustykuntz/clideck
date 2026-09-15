# Backup and restore

Open **Settings → General → Backup & restore**. **Backup** downloads one dated JSON
file with your settings, projects and session definitions, including stopped sessions.
It also includes this browser's appearance preferences and recent picker choices.

Choose **Restore**, open the file, and tick what you want to bring back. Everything
starts selected. You can restore all settings, individual settings sections, whole
projects, or individual sessions. A session brings its project and any required
custom command or terminal theme with it.

Existing projects and sessions are kept when their IDs match. Missing sessions are
added stopped, ready to resume when you choose. Selected settings are applied;
saved prompts, custom commands and custom themes are merged by ID, keeping unrelated
entries. Older session-only CliDeck backups can also be restored here.

The file contains configuration and native resume references. It does not copy
project files, agent conversations, terminal scrollback or viewer files. Working
directories stay as saved; moving to another machine still requires those folders
and the providers' own history to continue existing conversations. Plugins must
already be installed. Plugin secrets and provider login files are not included;
custom commands and their environment values are, so keep the backup private.
Browser notification and microphone permissions remain under the browser's control.

## Automatic recovery

CliDeck writes `sessions.json` atomically and keeps its previous valid snapshot as
`sessions.backup.json` in its data directory (normally `~/.clideck-next`). The first
save seeds both copies. If the registry is missing or invalid, startup uses a valid
recovery copy and retains the invalid file as `sessions.json.corrupt-<timestamp>`.

If neither copy is usable, startup stops with a recovery message. It does not start
with an empty registry and overwrite the saved state. Startup also preserves
unrecognized transcript and viewer-payload files, since they may be newer than the
recovered registry. Explicit session/content deletion still removes its own data.

Avoid editing the registry while CliDeck is running: the engine owns it and saves
over external edits. Use Restore for downloaded backups.

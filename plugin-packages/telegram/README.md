# Telegram

Talk to Claude and Codex sessions from one paired Telegram account. Each session
has its own private topic. The computer must be awake and CliDeck must be running.
No public port or hosted CliDeck service is used. Telegram carries the messages.

## Agent setup

Only enable or configure plugins when the user requests or approves it.

1. `clideck plugins` lists Telegram even when it is disabled.
2. `clideck plugin info telegram` describes its setup and commands.
3. Telegram ships with CliDeck, disabled. Turn it on in **Settings → Plugins**
   or run `clideck plugin enable telegram`.
4. `clideck telegram/setup status` returns structured state and the next step.
5. The user creates a bot using `/newbot` in https://t.me/BotFather and enables
   private topics for that bot. Use a dedicated bot; CliDeck will not take over
   another application's webhook or long-polling connection.
6. The user can paste the token in the Telegram plugin's setup window. To set it
   programmatically, pass it on stdin to `clideck telegram/setup connect` from a
   secret store or private file. Never put the token in command arguments, chat,
   source control, or logs. With no stdin, `connect` rechecks the saved token.
7. `clideck telegram/setup pair` returns a short-lived link. The user opens it in
   Telegram and taps Start. Only the paired numeric account ID is accepted.
   Re-run `status` to confirm pairing; presenting the link is not confirmation.
8. `clideck telegram/setup test` sends a test, then `clideck telegram/phone on`
   enables the calling session. An explicit session ID is optional.

All plugin commands return JSON state or a nonzero exit with the error. `status`
never returns the token. The token lives in the plugin's private data folder,
outside session history, agent instructions and CliDeck backups.

## Use

- A message in a session topic safely resumes its saved conversation if stopped.
  Busy sessions wait; login/approval prompts must be handled in CliDeck.
- A phone request receives its own reply. A request submitted in CliDeck is also
  copied to the phone when away and that session has Phone on. Peer-agent asks
  and monitor completions are not automatically forwarded.
- For background results that matter, use `clideck notify "<short message>"`.
  Notifications remain available in CliDeck; this plugin also delivers them
  when away and Phone is on. Successful phone delivery marks that notice read.
- `clideck telegram/away auto|here|away` controls away routing. Auto checks Mac
  input idle time (10 minutes) and available lock state; use Here/Away on other
  platforms. A hidden browser tab alone does not mean away.
- Phone off stops routing in both directions and keeps the topic/history.
  Private topics remain typeable in Telegram; messages receive an off notice.
  Turning Phone on reuses the same topic. Disabling the plugin removes its UI
  and stops polling/delivery; existing agent work continues locally.
- An uncertain terminal paste is never automatically resent. Inspect the session,
  then `clideck telegram/pending acknowledge <id>` releases it without resending.
  Network-uncertain Telegram replies may appear twice after a retry; agent work
  is not executed twice. Delivery failures return to the initiating session.
- Streaming uses the current owned reply only. Stop can interrupt that exact
  turn; it cannot stop another session or a later request. Voice/files come later.

`clideck telegram/setup disconnect` forgets the bot token and pairing. Install
and enable are separate from connecting an account; the plugin does not contact
Telegram until configured.

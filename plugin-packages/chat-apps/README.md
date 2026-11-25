# Chat apps

One optional plugin for connecting messaging apps to CliDeck agents. This first
prototype supports WhatsApp through your existing account. Telegram will join
this plugin in the next phase; the earlier standalone Telegram implementation
has not been migrated yet.

## Set up WhatsApp

1. Enable **Chat apps** in Settings → Plugins, then choose **Configure**.
2. Choose **Connect WhatsApp**. The first connection downloads the pinned local
   WhatsApp library using npm. Node.js/npm and internet access are required.
3. On your phone, open WhatsApp → Settings → Linked devices → Link a device, then
   scan the QR code shown inside CliDeck.
4. Choose a group where you are the only member, choose its agent, and connect
   them. For example, connect “Personal assistant” to your personal assistant
   and “Legal assistant” to your legal agent. Each group and agent has one link.
5. Use **Send test**, then write a new text message in that WhatsApp group.

No new SIM, phone number or WhatsApp business account is required. Replies are
sent as your existing account and labelled with the project and agent name.
Because they are your own outgoing messages, phone notification behaviour is
not guaranteed; a separate notification service is not included in this prototype.

The connection uses the independent [Baileys](https://github.com/WhiskeySockets/Baileys)
library, not Meta's official Business API. WhatsApp changes may break it and
account restrictions are possible. This is an opt-in prototype.

## Behaviour

- Only selected groups containing just you can route messages. Adding another
  participant pauses routing for that group until it contains only you again.
- Only new text messages received while connected are accepted. Historical sync,
  offline backlog, other people's messages and CliDeck's own replies do not start
  agent work. Voice notes, files and calls are not supported yet.
- Claude and Codex agents use CliDeck's existing request receipts, busy/typing
  guards and safe resume. One pending WhatsApp request per agent; queued requests
  wait up to an hour. No new conversation is silently substituted.
- Completed answers appear as **Final response**. Delivery and interruption
  messages appear as **Status**. A confirmed working request gets one status
  message. Further mid-turn messages require an explicit agent
  notice. Terminal previews stay in CliDeck.
- Answers return only to the group that submitted the request. Unrelated peer
  replies are never forwarded. Explicit `clideck notify` notices from linked
  agents also go to their groups; ordinary desk replies are not mirrored yet.
- Disconnecting a group stops its routing without deleting chat history or
  stopping agent work. Disconnecting WhatsApp unlinks the device and clears all
  group links. Disabling the plugin stops its connection; enabling can reconnect
  using saved credentials.
- Uncertain submissions or outgoing deliveries are held for inspection, never
  automatically resent. Clear them in Configure only after checking the agent
  or WhatsApp group. Clearing does not repeat the message.

Connection credentials and bounded request state stay in the plugin's private
data directory. They are not exposed in CLI status, source control or previews.
The QR is a temporary login credential and is shown only in the local setup UI.
Linking is account-level access even though CliDeck's routing is restricted to
the selected groups. The computer must stay awake and CliDeck must be running.

## Agent commands

```sh
clideck plugin enable chat-apps
clideck chat-apps/whatsapp status
clideck chat-apps/whatsapp connect
clideck chat-apps/whatsapp groups
clideck chat-apps/whatsapp bind <group-id> [session-id]
clideck chat-apps/whatsapp test <group-id>
clideck chat-apps/whatsapp unbind <group-id>
clideck chat-apps/whatsapp pending
clideck chat-apps/whatsapp acknowledge <request-id>
clideck chat-apps/whatsapp disconnect
```

`bind` defaults to the calling agent. Always obtain the user's requested group
and agent; never guess a destination or route unrelated chats. The user must scan
the pairing QR themselves. Agent status deliberately omits the QR credential.

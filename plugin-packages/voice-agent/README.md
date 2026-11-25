# Voice Agent (experimental)

Talk to your existing Claude or Codex session using OpenAI GPT-Live. Ask for a
short recap, discuss the next step, or tell the session agent what to do. The
voice model handles the conversation; your session agent keeps its tools,
context and normal permissions. Telephone calls are an optional extra.

## Talk to a session

1. Enable **Voice Agent** in Settings > Plugins. Turn on **Talk to sessions**, add
   your OpenAI API key, and choose a voice.
   Use the play/pause button beside **Voice** to hear a short sample. Changing
   voices stops the previous sample. Previews work without an API key or microphone.
2. Open a Claude or Codex session and click the **Voice Agent** waveform icon in
   its header. It starts the conversation directly. Allow microphone access when
   your browser asks. Click the icon again to turn it off.
3. Try “What’s the recap?” or “What should we do next?” The screen says
   **Microphone on** only when the connection is ready. The header icon is
   highlighted while voice is enabled for this session. It breathes gently while
   listening and follows the agent's speech volume while talking. It becomes
   still when you leave the session and respects reduced-motion preferences.
4. **Pause microphone** pauses the conversation. **Stop voice** turns voice off
   for this session. Neither stops work already requested from the session agent.

Turning off **Talk to sessions** removes the header icon and stops any active
session voice. Turning it on restores the icon without opening a microphone.
Use **Voice controls** in plugin settings to open the conversation screen.

Switching sessions or leaving the browser immediately stops microphone capture
and speaker playback. Returning resumes only sessions where you explicitly
enabled voice; a manual pause waits for **Resume voice**. Reloading the browser
turns voice off. Only one browser can own voice at a time. Voice stays enabled
until you turn it off. If OpenAI confirms its session time limit has expired,
CliDeck reconnects only while that session remains enabled and focused.
Keeping a connection open uses
OpenAI voice time even while nobody speaks.

Browser voice needs no telephone number or phone provider. The browser must be
on HTTPS or localhost. OpenAI API billing is separate from a ChatGPT subscription.
Use **Check connection** to verify model access without opening the microphone.
Phone settings and advanced conversation instructions are collapsed in Settings.
**Initial instructions** is the voice agent's custom system prompt: use it to
set language, tone, pace and personality. CliDeck adds its session and delegation
rules alongside it. Changes apply the next time you start voice.

The voice model receives a bounded recent excerpt of the session, not the entire
conversation. It asks the session agent when more context or fresh facts are
needed. Spoken requests include recent voice context, so “do B” includes the
options you heard. Delivery waits when you are typing or a session menu is open;
uncertain delivery is never automatically repeated.

The backend keeps short text history and request receipts in `browser.json`,
mode 0600. It stores no microphone audio and requests no OpenAI session recording.
Audio travels directly between your browser and OpenAI; the API key stays on
the CliDeck backend. Old engines must be restarted for the bounded context
capability; reload the browser for the host audio capability.

## Usage & cost

Open **Usage & cost** from the plugin's settings, session plugin menu or voice
controls. The page shows voice minutes, estimated USD cost, daily activity and
per-session totals. Filter by 7, 30, 90 days or all time, and by session. Click a
chart bar for that day's time and cost; expand Daily totals for the full period.

Usage is kept locally in `usage.json` without audio, transcripts or API keys.
Tracking starts with this version; earlier conversations and maintainer sample
generation are not reconstructed. Each reconnect is a separate connection.
OpenAI's cumulative duration updates replace previous values, and a final
`session.closed` report confirms duration. Missing final reports stay provisional;
unconfirmed creations are identified separately, with unknown cost excluded.
An engine outage does not silently keep a local timer running.

GPT-Live's published rate is **$0.05/minute**, billed per second (checked
2026-11-12). Each connection retains its rate so future price changes do not
rewrite history. Browser initialization provisionally includes 15 seconds;
final reported duration replaces the estimate without adding 15 seconds again.
Silence and waiting count while connected. Costs are estimates, not an invoice:
session-agent models, tools, phone-carrier charges and taxes are not included.
Days use the viewer's timezone; connections crossing midnight are split by time.
See [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[usage accounting](https://developers.openai.com/api/docs/guides/voice-latency-cost).

## Replying to spoken requests

The session agent can send a concise result using
`clideck voice-agent/reply REQUEST_ID --stdin` with
`{"kind":"answer","text":"The review passed. The next step is to run the demo."}`.
Use `kind: "progress"` for a confirmed update. Request-owned final replies are
also accepted; arbitrary agent output is never treated as a voice reply.
Replies survive focus changes, stay with their original session, and cannot
restart a microphone. A delivered result does not prove the user heard it.

SIP is the standard connection between the voice service and a telephone carrier.
The carrier connects to ordinary phone numbers and charges for those calls.
It is needed for telephone calls only; a browser conversation with your CliDeck
session needs no telephone carrier.

## Optional telephone setup

The same Voice Agent settings control phone conversations:

- OpenAI API key with access to `gpt-live-1`.
- **Voice**: choose a built-in OpenAI voice. The selection applies to new calls;
  OpenAI cannot change the voice of a running conversation.
- **Initial instructions**: language, pace, personality and how concise to be.
  These preferences accompany the session agent's task, facts and permission
  limits; they do not replace the call brief. Leave the default for concise,
  natural conversation. Changes apply to new calls.

For telephone calls, also configure:

- Your carrier's encrypted outbound SIP address, such as
  `sips:your-trunk.pstn.twilio.com:5061`.
- SIP digest username/password (not your carrier dashboard password).
- A caller number your carrier owns or has verified, including country code.

Enable TLS/SRTP on the trunk and the intended destination country with your
carrier. Twilio Elastic SIP Trunking is the first proposed carrier; actual
interoperability has not yet been tested. Use a funded account: trial accounts
can restrict destinations. Keys are stored locally and hidden from the browser;
this is not encrypted-at-rest storage. OpenAI receives the SIP credentials to
connect the call. No public webhook is needed for this outbound flow.

```sh
clideck voice-agent/setup
clideck voice-agent/setup check
```

`setup` only reads configuration. `check` verifies OpenAI model access without
dialing; it does not establish SIP connectivity or credit availability. If the
running engine lacks `capabilities.sessionSteer`, install the updated CliDeck
build and restart it. Installing the plugin alone does not update a running
engine. Start refuses to dial without this capability.

## Call commands

After the user authorizes the specific destination and task, send a JSON brief
on stdin to `clideck voice-agent/start --stdin`:

```json
{
  "requestId": "my-test-001",
  "destination": "+14155550123",
  "objective": "Introduce yourself as an AI assistant and explain this voice test. Ask the participant for a question for the supervising agent.",
  "context": "The participant expects this test call.",
  "limits": "A conversation test only. No purchases or account changes.",
  "maxSeconds": 120
}
```

Use the actual authorized phone number. This example is not a destination to
dial. Choose a unique requestId for a new call; reuse the same ID and brief when
retrying. Start returns a call ID after connecting its control socket; it does
not mean the phone answered. Ambiguous failures block another call from that
session instead of automatically redialing.

```sh
clideck voice-agent/status
clideck voice-agent/status CALL_ID
clideck voice-agent/steer CALL_ID --stdin
clideck voice-agent/key CALL_ID '#'
clideck voice-agent/stop CALL_ID
```

Steer reads `{"kind":"instruction","text":"Ask which document is missing."}`
from stdin. `kind: "context"` supplies facts without requesting immediate
speech. To answer a pending question, use
`{"kind":"answer","delegationId":"ID_FROM_STATUS","text":"Verified answer."}`.
Keep text under 500 UTF-8 bytes. A newer delegation supersedes the prior pending
question; stale answers are rejected. Returned `accepted` confirms receipt,
not that the person heard or the model followed the direction. Directions and
context sent to the voice model are not a secrecy boundary.

The agent must deliberately send facts to the call. Ordinary agent output is
never automatically spoken. Transcript excerpts are untrusted phone content,
not authorization to run tools. Commands can control only their initiating
session's calls. The desktop call panel lets the user inspect and hang up any
call. Key sends one DTMF key and waits for its receipt.

## Updates, recovery and limits

Progress uses CliDeck's durable request delivery with `steer: true`. The plugin
coalesces transcripts, immediately marks lifecycle/decision changes for
delivery, and respects user typing and menus. Updates may therefore wait.
Calls continue while the supervisor works. The call panel shows delivery state.
If delivery is uncertain, inspect the terminal and use the normal CliDeck error
acknowledgment. Acknowledgment skips that possibly delivered update, never
replays it. Subsequent progress can then be delivered.

Keep CliDeck running and the computer awake. The requested duration (15–600
seconds, default 120) is enforced by a local timer, not a crash-proof carrier
limit. Control loss attempts a remote hangup. Plugin shutdown and restart
explicitly end known calls; a sudden crash or sleep can prevent cleanup, so use
the carrier's call controls when necessary. A failed hangup remains uncertain
and can be retried explicitly with `stop`. Never automatically redial an
uncertain creation; inspect OpenAI/carrier history first.

`finalized: true` means OpenAI delivered its final session event and usage.
Successful hangup without that event can end a call with `finalized: false`;
final usage is unconfirmed. Carrier charges and model/tool usage are separate.

Call records, bounded transcript excerpts and request receipts live in the
plugin's private `calls.json` (mode 0600). Audio is not recorded. History is
limited to 100 calls; transcript truncation is exposed in status. Archive the
store only with the plugin disabled and every call resolved. The plugin does
not delete history to hide unresolved calls. It never persists API/SIP secrets
in call records. Other trusted local plugins have the user's filesystem access.

## Development

Run `node --test test/voice-agent.test.js` from the CliDeck repo. Tests use fake
providers and an isolated engine; they do not place real calls. UI tests run with
`node test-ui/voice-agent-plugin-it.mjs`.

`vendor/ws` is the MIT-licensed ws 8.21.0 package, copied from the repo's existing
dependency with its LICENSE. It is bundled so installing the plugin never needs
npm. Call logic is in `calls.js`, OpenAI transport in `openai.js`, command/UI
routing in `server.js`. The plugin does not use a terminal-input workaround.

API references: [OpenAI SIP](https://developers.openai.com/api/docs/guides/voice-sip),
[sideband controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live),
[client delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[Twilio SIP setup](https://www.twilio.com/docs/sip-trunking).

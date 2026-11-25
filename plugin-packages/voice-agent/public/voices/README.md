# Voice samples

AI-generated samples created with OpenAI `gpt-live-1`, using each selected
built-in voice, on November 12, 2026. Every sample says:

> Hi, I'm your voice assistant. What would you like to do next?

These are short, bundled previews. Playing them requires no API key, microphone
or live connection. Actual conversations also follow the user's initial
instructions and may sound different in pace, tone or language.

Generated through the [official Live primary WebSocket API](https://developers.openai.com/api/reference/resources/live/primary-websocket),
with recording storage disabled. PCM output was trimmed, loudness-normalized
and encoded as mono 24 kHz MP3 at 64 kbps. No user speech or session context was
included. The opt-in maintainer tool is
`parity/probes/generate-voice-previews.cjs --generate [voice...]`; it uses billable
API sessions and skips existing files.

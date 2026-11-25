# Supertonic Voice for CliDeck

This bundled plugin reads agent replies or selected text with Supertonic 3. Inference runs locally inside the isolated plugin worker; no text is sent to a speech API.

Enabled by default, with **Female 2**, **F5** for reading the selection, **English**,
**12 quality steps**, and **English technical** text normalization. Automatic reading
of completed replies is **off for each session**. The speaker button in the session
header controls that session only; voice and pronunciation choices remain shared.

An enabled session reads its completed reply while selected in a visible browser tab.
Replies from other sessions wait until you open them. Only the latest waiting reply
per session is retained, in browser memory; refreshing or reconnecting clears waiting replies.
Switching away or turning the switch off stops automatic playback. A reply still
being prepared waits for your return; one already playing is not restarted.
Manual reading takes priority. Existing global auto-read preferences are retired;
enable the sessions you want using their header buttons.

Choose **Default playback speed** in the plugin settings: 1×, 1.1×, 1.25× or 1.5×.
Each new reading starts at that speed; changing the player speed applies to the
current reading, including its later chunks.

Markdown tables, fenced code/diagrams and display formulas are replaced by short
“see it in the conversation” cues. Image and link markup gets a similar cue;
headings, lists, inline code and other prose keep their readable words. Skipping
large blocks happens before speech chunking; prose read-along keeps its original
source offsets. This recognizes common Markdown and terminal box tables, rather
than every possible document layout.

The immutable Supertonic model and ONNX WebAssembly runtime download on first use (about 400 MB combined). CliDeck stores the model in the browser cache for later sessions. WebGPU is preferred, with a WASM fallback. Choose a voice, preview it, or set a conflict-safe selection shortcut in Settings > Plugins > Supertonic Voice. Repeating the shortcut for the same text pauses or resumes the cached clip; changed text is synthesized once. English technical normalization programmatically expands numbers, money, dates, time, decimals, and ordinals before applying the vocabulary lexicon.

The voices are Female 1 (Tifa), Female 2 (Emma), Yara, Mika, Chun-Li, Jake,
Kabbi, Lilly, Lola, Myers, Nikki and Transi. Female 1 and Female 2 retain their
existing profiles and settings. Mike now displays as Mika; saved selections
continue working. Dov has been removed; a saved Dov selection falls back to
Female 2. Preview clips are local MP3s and do not load the speech model.

Supertonic supports **Mac and Ubuntu** through the same browser runtime. Use a
current Chrome/Chromium browser; if WebGPU is unavailable (including on Ubuntu),
it retries on the CPU through WebAssembly. No CUDA, NVIDIA graphics card, Python,
or Mac-only native helper is required. First use needs internet access for the
runtime and model downloads. Synthesis happens on the computer running the browser,
even when the CliDeck server runs elsewhere. CPU speed depends on that computer.

English normalization describes recognized file paths by their extension: documents,
photos, videos, audio, spreadsheets, presentations, archives, code and data files.
For example, `docs/report.md` becomes “the document path is in our conversation”;
`images/photo.jpg` becomes “the photo path is in our conversation”. Unknown types
use “the file path is in our conversation”. URLs keep “the URL in our conversation”.
Paths still require a directory and a file extension (or dotfile); bare filenames
and extensionless paths stay literal. Turning normalization off disables these replacements.
Signed amounts keep their meaning: `-$1.30M` is read as “minus one point three million
dollars,” and `+$0.11M` as “plus zero point one one million dollars.” A leading sign
must touch the currency symbol, so spaced ranges such as `$5 - $10` stay ranges.
Without a currency symbol, attached uppercase `K`/`M` expands only immediately
after `made`, `make`, `makes` or `making`, and in its comma/and/or list of amounts.
For example, `made +1.82M, +0.41M and −0.42M` keeps each sign and reads each `M`
as “million”; `make 0.41K` reads “make zero point four one thousand”. No currency
is added. Spaced/lowercase units and amounts outside that immediate list keep
their existing normalization.
Named English dates accept full or abbreviated months, either day/month order,
ordinal suffixes, and optional years. `11 Oct` and `October 11` both read as
“October eleventh”; `Sep 22–Nov 6` reads as “September twenty second to November
sixth”. Shared-month ranges such as `11–13 Oct` and `Oct 11–13` also work.
Calendar validation uses the year when supplied; without one, February 29 is allowed.

Read-along uses an estimated three-word window that advances one source word at a time. Estimates
are weighted by normalized speech (so `365` gets the time of "three hundred sixty five") and reset at each
generated audio chunk. They are a reading guide, not measured word timestamps. Source spans survive number,
date, acronym, URL and file-path replacements; language-aware segmentation handles text without spaces.
The host follows the audio clock and owns the terminal highlight. Selection anchors identify the selected
occurrence when the same text appears more than once. Terminal rendering differences or unavailable source
text can still leave a window unhighlighted; playback continues.

Long readings play in bounded batches (up to 1,200 source characters), preparing only the next batch while
the current one plays. Stop cancels the remaining reading, including during preparation between batches.
The player seeks within the current batch, not across the entire document. Short readings retain their
replay cache; long readings do not retain all generated audio. There is no reader-specific 8,000-character
limit; the existing document, plugin-message and per-clip audio safety limits still apply.

Headings and paragraph boundaries retain blank lines in the extracted text. Generated speech is preserved;
estimated read-along positions never insert silence into it, since an estimate can land inside a word.
The existing 300 ms pauses between generated chunks remain. Coarse model-sized chunks still apply to
long text, including long unpunctuated passages.

Agents can request speech with:

```bash
clideck supertonic/speak "Read this aloud"
```

The command waits until one CliDeck window showing the agent's session has read the whole text:
"Read aloud in CliDeck." on success, or an error (exit code 1) when no window shows the session,
synthesis or playback fails, the browser blocks audio, the reading is stopped or replaced, the window
goes away, or it takes longer than 55 minutes.

Supertonic sample code is MIT licensed. The model is OpenRAIL-M licensed. Upstream announced that its repository will be archived after July 2026, so this integration pins the last published Supertonic 3 model revision rather than tracking a moving endpoint. See `THIRD-PARTY-NOTICES.md`.

Additional voice profiles are trained locally with the recovered community cloner. See [VOICE-CLONING.md](VOICE-CLONING.md) for preparation, training, preview, and import steps.

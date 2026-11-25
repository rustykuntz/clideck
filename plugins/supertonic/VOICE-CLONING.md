# Adding a local voice

CliDeck reads Supertonic 3 voice profiles; a recording must first be converted
into a profile. The community converter used for the bundled voices is
[supertonic3-voice-clone](https://github.com/saurabhv749/supertonic3-voice-clone).

1. Prepare a reference WAV with `prepare_reference.py`, passing the original
   clips in order. It writes 16 kHz mono audio plus a source inventory and never
   overwrites the original recordings.
2. Run `train_style.py --name <name> --target-wav-path <reference.wav>
   --reference-style auto --num-steps 500`. Run from the cloner checkout root.
   The output is `logs/<name>/<name>.json`.
3. Generate a listening preview with `generate.py --style <profile.json>
   --text '<preview sentence>' --lang en`. The WAV appears in `samples/`.
4. Copy the profile to this plugin's `public/voices/<id>.json`. Encode the WAV
   as `public/voices/<id>-preview.mp3` with FFmpeg. Keep existing voice IDs stable.
5. Add the profile URL to `VOICE_STYLE_URLS` in `client.js` and its named option
   and preview path to the voice setting in `clideck-plugin.json`. Update the
   plugin version and validate with `clideck plugin validate plugins/supertonic`.

Profiles must contain finite float32 tensors with dimensions `[1,50,256]` for
`style_ttl` and `[1,8,16]` for `style_dp`. Keep source metadata accurate; it is
provenance, not an inference setting. Listen to actual generated audio to judge
the voice; the training loss alone cannot establish listening quality.

Reload the plugin inventory (Settings or an engine restart) after adding voice
options, and refresh the browser to load the updated client. Source recordings
and the training environment are not shipped inside CliDeck.

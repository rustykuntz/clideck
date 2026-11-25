// Maintainer-only asset generation. Explicitly opt in: node .../generate-voice-previews.cjs --generate [voice...]
// Uses billable GPT-Live sessions; playback of the resulting bundled samples never uses the API.
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { OpenAILive, safeError } = require('../../plugin-packages/voice-agent/openai');
const manifest = require('../../plugin-packages/voice-agent/clideck-plugin.json');
const directory = resolve(__dirname, '../../plugin-packages/voice-agent/public/voices');
const phrase = "Hi, I'm your voice assistant. What would you like to do next?";
if (process.argv[2] !== '--generate') throw Error('Use --generate to explicitly enable billable sample generation.');
const names = manifest.settings.find(s => s.key === 'voice').options.map(o => o.value);
const selected = process.argv.slice(3);
if (selected.some(v => !names.includes(v))) throw Error('Unknown voice.');
const saved = process.env.OPENAI_API_KEY ? {} : JSON.parse(fs.readFileSync(join(process.env.CLIDECK_DATA_DIR || require('../../src/persistence').DEFAULT_DATA_DIR, 'config.json'), 'utf8')).plugins?.['voice-agent']?.settings;
const config = { 'openai-key': process.env.OPENAI_API_KEY || saved?.['openai-key'] };
if (!config['openai-key']) throw Error('Configure an OpenAI key in Voice Agent settings first.');
const provider = new OpenAILive(config);
fs.mkdirSync(directory, { recursive: true });
async function generate(voice) {
  const target = join(directory, voice + '.mp3');
  if (fs.existsSync(target)) return;
  const chunks = []; let transcript = '', id, finalized = false, closing = false, failure, timer, pump, closeTimer;
  const socket = new WebSocket('wss://api.openai.com/v1/live/sessions', {
    headers: { Authorization: 'Bearer ' + config['openai-key'] }, handshakeTimeout: 8000,
  });
  const send = event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
  const close = () => {
    if (closing) return; closing = true; clearInterval(pump);
    send({ type: 'session.close' }); closeTimer = setTimeout(() => socket.terminate(), 5000);
  };
  await new Promise(resolve => {
    timer = setTimeout(() => { failure = 'Preview timed out'; close(); }, 20000);
    socket.on('open', () => send({ type: 'session.start', session: {
      model: 'gpt-live-1', store: false, audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice } },
      delegation: { type: 'client' },
      instructions: 'Speak only the provided voice sample, once, in a warm and natural voice. Do not add an introduction or other words. Then stay silent.',
    } }));
    socket.on('message', raw => {
      const event = JSON.parse(raw);
      if (event.type === 'session.started') {
        id = event.session.id;
        send({ type: 'session.commentary.append', delegation_id: null, content: 'Say exactly: ' + phrase });
        pump = setInterval(() => send({ type: 'session.input_audio.append', audio: Buffer.alloc(4800).toString('base64') }), 100);
        clearTimeout(timer); timer = setTimeout(close, 10000);
      } else if (event.type === 'session.output_audio.delta') chunks.push(Buffer.from(event.delta, 'base64'));
      else if (event.type === 'session.output_transcript.delta') transcript += event.delta;
      else if (event.type === 'session.closed') { finalized = true; socket.close(); }
      else if (event.type === 'error') { failure = safeError(event.error?.message, config); close(); }
    });
    socket.on('error', error => { failure = safeError(error, config); });
    socket.on('close', resolve);
  });
  clearTimeout(timer); clearTimeout(closeTimer); clearInterval(pump);
  if (!finalized && id) await provider.hangup(id);
  if (failure) throw Error(voice + ': ' + failure);
  const normalize = s => s.toLowerCase().replace(/[^a-z]/g, '');
  if (!chunks.length || normalize(transcript) !== normalize(phrase)) throw Error(voice + ': unexpected sample transcript: ' + transcript);
  const temp = fs.mkdtempSync(join(tmpdir(), 'clideck-voice-preview-'));
  try {
    const pcm = join(temp, 'sample.pcm'); fs.writeFileSync(pcm, Buffer.concat(chunks));
    const trim = 'silenceremove=start_periods=1:start_duration=0.01:start_threshold=-45dB';
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm,
      '-af', `${trim},areverse,${trim},areverse,apad=pad_dur=0.12,loudnorm=I=-18:TP=-2:LRA=11`,
      '-ar', '24000', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '64k', target]);
    console.log('Created ' + voice);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const queue = (selected.length ? selected : names).slice();
Promise.allSettled(Array.from({ length: 3 }, async () => { while (queue.length) await generate(queue.shift()); })).then(results => {
  for (const r of results) if (r.status === 'rejected') { console.error(safeError(r.reason, config)); process.exitCode = 1; }
});

const MODEL_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';
const MODEL_ROOT = `https://huggingface.co/Supertone/supertonic-3/resolve/${MODEL_REVISION}`;
const MODEL_FILES = Object.freeze([
  'tts.json', 'unicode_indexer.json', 'duration_predictor.onnx',
  'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx',
]);
const CACHE_NAME = `clideck-supertonic-${MODEL_REVISION}`;
const LEXICON_URL = new URL('./public/tts_normalization_lexicon.txt', import.meta.url);
const VOICE_STYLE_URLS = Object.freeze({
  'female-1': new URL('./public/voices/female-1.json', import.meta.url),
  'female-2': new URL('./public/voices/female-2.json', import.meta.url),
  yara: new URL('./public/voices/yara.json', import.meta.url),
  mike: new URL('./public/voices/mike.json', import.meta.url),
  'chun-li': new URL('./public/voices/chun-li.json', import.meta.url),
  jake: new URL('./public/voices/jake.json', import.meta.url),
  kabbi: new URL('./public/voices/kabbi.json', import.meta.url),
  lilly: new URL('./public/voices/lilly.json', import.meta.url),
  lola: new URL('./public/voices/lola.json', import.meta.url),
  myers: new URL('./public/voices/myers.json', import.meta.url),
  nikki: new URL('./public/voices/nikki.json', import.meta.url),
  transi: new URL('./public/voices/transi.json', import.meta.url),
});
const PLAYBACK_CHARS = 1_200;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_WAV_SAMPLES = Math.floor((MAX_AUDIO_BYTES - 44) / 2);
const DEFAULTS = Object.freeze({
  voice: 'female-2', shortcut: 'F5', language: 'en', normalization: 'english', quality: 12,
  playbackRate: 1,
});

const CLAIM_REPLY_MS = 4_000;
const ALIVE_MS = 20_000;
const STOPPED_EARLY = 'Playback was stopped or replaced before it finished.';

const playbackRate = value => [1, 1.1, 1.25, 1.5].includes(Number(value)) ? Number(value) : 1;

let preferences = { ...DEFAULTS };
let runtimePromise = null;
let lexiconPromise = null;
let reading = null;
let synthesisQueue = Promise.resolve();
let sequence = 0;
let speechCache = null;

async function normalizedText(text, normalization) {
  const normalizer = await import('./public/tts-normalizer.js');
  if (normalization !== 'english') return normalizer.normalizeTextWithRanges(text, [], 'off');
  if (!lexiconPromise) {
    lexiconPromise = fetch(LEXICON_URL).then((response) => {
      if (!response.ok) throw new Error('Could not load the speech lexicon.');
      return response.text();
    }).then(source => normalizer.parseLexicon(source)).catch(() => null);
  }
  const lexicon = await lexiconPromise;
  return normalizer.normalizeTextWithRanges(text, lexicon || [], lexicon ? normalization : 'off');
}

function progress(api, body, kind = 'info') {
  api.toast(kind, {
    id: 'supertonic-progress',
    title: 'Supertonic Voice',
    body,
    duration: kind === 'success' ? 3500 : 0,
  });
}

async function cachedUrl(path) {
  const remote = `${MODEL_ROOT}/${path}`;
  if (typeof caches === 'undefined') return { url: remote, release() {} };
  const cache = await caches.open(CACHE_NAME);
  let response = await cache.match(remote);
  if (!response) {
    const download = await fetch(remote);
    if (!download.ok) throw new Error(`Could not download ${path.split('/').pop()}.`);
    try {
      await cache.put(remote, download);
      response = await cache.match(remote);
    } catch {
      return { url: remote, release() {} };
    }
  }
  const url = URL.createObjectURL(await response.blob());
  return { url, release: () => URL.revokeObjectURL(url) };
}

async function modelAssets() {
  const loaded = [];
  const assets = {};
  try {
    for (let index = 0; index < MODEL_FILES.length; index += 1) {
      const name = MODEL_FILES[index];
      const asset = await cachedUrl(`onnx/${name}`);
      loaded.push(asset);
      assets[name] = asset.url;
    }
    return { assets, release: () => loaded.forEach((asset) => asset.release()) };
  } catch (error) {
    loaded.forEach((asset) => asset.release());
    throw error;
  }
}

async function runtime(api) {
  if (!runtimePromise) {
    progress(api, 'Loading the private voice model (~380 MB on first use)…');
    runtimePromise = import('./public/helper.js').then(async (helper) => {
      let result;
      const local = await modelAssets();
      try {
        try {
          result = await helper.loadTextToSpeech(`${MODEL_ROOT}/onnx`, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all',
          }, null, local.assets);
          result.backend = 'WebGPU';
        } catch {
          result = await helper.loadTextToSpeech(`${MODEL_ROOT}/onnx`, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
          }, null, local.assets);
          result.backend = 'WASM';
        }
      } finally {
        local.release();
      }
      progress(api, `Voice model ready with ${result.backend}.`, 'success');
      return { helper, ...result, styles: new Map() };
    }).catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }
  return runtimePromise;
}

async function voiceStyle(engine, voice) {
  const id = Object.hasOwn(VOICE_STYLE_URLS, voice) ? voice : DEFAULTS.voice;
  if (!engine.styles.has(id)) {
    engine.styles.set(id, engine.helper.loadVoiceStyle([VOICE_STYLE_URLS[id].href]));
  }
  return engine.styles.get(id);
}

function speechKey(text, settings) {
  return JSON.stringify([
    text, settings.voice, settings.language,
    settings.normalization, settings.quality,
  ]);
}

function targetKey(target) {
  return JSON.stringify([target?.surface, target?.sessionId, target?.contentId, target?.anchor,
    target?.sourceOffset ?? (target?.surface === 'terminal' ? 0 : null)]);
}

function audioOptions(cache) {
  const target = cache.target;
  return {
    mime: 'audio/wav',
    title: 'Supertonic Voice',
    text: cache.sourceText,
    playbackRate: cache.playbackRate || 1,
    ...(cache.autoToken ? { autoToken: cache.autoToken } : {}),
    ...(target?.surface && target.sessionId ? {
      readAlong: {
        ...target,
        sessionId: target.sessionId,
        sourceText: cache.sourceText,
        cues: cache.cues,
        timing: 'estimated',
        ...(target.anchor ? { anchor: target.anchor } : {}),
      },
    } : {}),
  };
}

function playCached(api, target) {
  if (!speechCache) return false;
  speechCache.target = target;
  speechCache.playbackRate = playbackRate(preferences.playbackRate);
  api.playAudio(speechCache.wav.slice(0), audioOptions(speechCache));
  return true;
}

async function toggleCached(api, key = '', target) {
  if (key && speechCache?.key !== key) return false;
  if (key && targetKey(target) !== targetKey(speechCache?.target)) return playCached(api, target);
  try {
    if (await api.toggleAudio?.()) return true;
  } catch {}
  return playCached(api, key ? target : speechCache?.target);
}

async function synthesize(engine, sourceText, settings, style, cancelled = () => false) {
  const { estimateReadAlongCues } = await import('./public/read-along-timing.js');
  const sampleRate = engine.textToSpeech.sampleRate;
  const silenceSamples = Math.floor(0.3 * sampleRate);
  const maxLen = settings.language === 'ko' || settings.language === 'ja' ? 120 : 300;
  const chunks = engine.helper.chunkTextRanges(sourceText, maxLen);
  const parts = [];
  const cues = [];
  let sampleCount = 0;
  for (const chunk of chunks) {
    if (cancelled()) throw new Error('Reading cancelled.');
    const source = sourceText.slice(chunk.start, chunk.end);
    const normalized = await normalizedText(source, settings.normalization);
    if (!normalized.text.trim()) continue;
    const gap = parts.length ? silenceSamples : 0;
    const result = await engine.textToSpeech.call(
      normalized.text,
      settings.language,
      style,
      settings.quality,
      1,
      0.3,
      null,
      MAX_WAV_SAMPLES - sampleCount - gap,
    );
    if (cancelled()) throw new Error('Reading cancelled.');
    const length = Math.min(result.wav.length, Math.floor(sampleRate * result.duration[0]));
    if (sampleCount + gap + length > MAX_WAV_SAMPLES) {
      throw new Error('Speech is too long for the CliDeck audio player.');
    }
    if (gap) { parts.push(new Float32Array(gap)); sampleCount += gap; }
    const start = sampleCount / sampleRate;
    // Read-along timing is approximate. Keep it out of the waveform: inserting
    // silence at an estimated paragraph boundary can split a spoken word.
    parts.push(Float32Array.from(result.wav.slice(0, length)));
    sampleCount += length;
    const estimated = estimateReadAlongCues(source, normalized, start,
      sampleCount / sampleRate, chunk.start, settings.language);
    cues.push(...(estimated.length ? estimated : [{
      start, end: sampleCount / sampleRate, textStart: chunk.start, textEnd: chunk.end,
    }]));
  }

  const audio = new Float32Array(sampleCount);
  let offset = 0;
  for (const part of parts) { audio.set(part, offset); offset += part.length; }
  return { audio, cues };
}

function playbackError(error) {
  const message = error?.message || String(error);
  return /NotAllowed|not allowed|interact|gesture/i.test(message)
    ? 'The browser blocked audio. Click anywhere in the CliDeck window, then try again.'
    : message;
}

// `report` is set only for an agent's speak request: answered once, 'finished' only after the last clip
// played to its natural end.
async function speak(api, rawText, target, autoToken = '', report = null) {
  const raw = String(rawText || '');
  const sourceText = raw.trim();
  if (!sourceText) return false;
  if (target?.surface === 'terminal' || Number.isInteger(target?.sourceOffset)) {
    target = { ...target, sourceOffset: (target.sourceOffset || 0) + raw.indexOf(sourceText) };
  }
  const settings = {
    voice: preferences.voice,
    language: preferences.language,
    normalization: preferences.normalization,
    quality: Math.round(preferences.quality),
    playbackRate: playbackRate(preferences.playbackRate),
  };
  const key = speechKey(sourceText, settings);
  if (autoToken && reading && !reading.autoToken) return false;
  // Toggling a cached clip is for people. An agent asking again always gets a fresh reading.
  if (!autoToken && !report && reading?.key === key && targetKey(reading.target) === targetKey(target)) {
    try { if (await api.toggleAudio?.()) return true; } catch {}
    return false;
  }
  if (reading) { reading = null; api.stopAudio?.(); }
  if (!autoToken && !report && speechCache?.key === key) return toggleCached(api, key, target);
  const job = {
    key, target, autoToken, requestId: report?.requestId || '', sequence: `supertonic-${Date.now()}-${++sequence}`,
  };
  reading = job;
  const cancelled = () => reading !== job;
  try {
    const engine = await runtime(api);
    if (cancelled()) return false;
    const style = await voiceStyle(engine, settings.voice);
    if (typeof api.playAudio !== 'function') throw new Error('This CliDeck build does not provide plugin audio playback.');
    const { speechBlocks } = await import('./public/speech-blocks.js');
    if (cancelled()) return false;
    const parts = speechBlocks(sourceText).flatMap(block => block.notice ? [block]
      : engine.helper.chunkTextRanges(sourceText.slice(block.start, block.end), PLAYBACK_CHARS)
        .map(part => ({ start: block.start + part.start, end: block.start + part.end })));
    if (!parts.length) return false;
    const long = parts.length > 1;
    if ((long || autoToken || report) && typeof api.playAudioAndWait !== 'function') throw new Error('Refresh CliDeck to enable automatic and long-document reading.');
    const prepare = (part) => {
      const task = synthesisQueue.then(async () => {
        if (cancelled()) return null;
        const text = part.notice || sourceText.slice(part.start, part.end);
        const result = await synthesize(engine, text, settings, style, cancelled);
        return {
          key, sourceText: text, cues: result.cues, autoToken, playbackRate: settings.playbackRate,
          wav: engine.helper.writeWavFile(result.audio, engine.textToSpeech.sampleRate),
          target: !part.notice && target && {
            ...target,
            ...((Number.isInteger(target.sourceOffset) || target.surface === 'terminal')
              && { sourceOffset: (target.sourceOffset || 0) + part.start }),
          },
        };
      });
      // Prefetch errors are observed immediately, even while the previous clip is paused for hours.
      synthesisQueue = task.catch(() => {});
      return task.then(value => ({ value }), error => ({ error }));
    };
    speechCache = null;
    let pending = prepare(parts[0]);
    for (let index = 0; index < parts.length; index++) {
      const result = await pending;
      if (cancelled()) return false;
      if (result.error) throw result.error;
      const clip = result.value;
      if (!long && !autoToken && !report) {
        speechCache = { ...clip, wav: clip.wav.slice(0) };
        api.playAudio(clip.wav, audioOptions(clip));
        return true;
      }
      // At most the playing clip and ONE prepared clip; never accumulate a document's audio in memory.
      if (index + 1 < parts.length) pending = prepare(parts[index + 1]);
      job.playing = true; // from here the plugin's audio belongs to this reading
      if (!await api.playAudioAndWait(clip.wav, { ...audioOptions(clip), sequence: job.sequence })) return false;
    }
    if (cancelled()) return false;
    api.stopAudio?.();
    report?.('finished');
    return true;
  } catch (error) {
    if (!cancelled()) {
      const message = playbackError(error);
      api.stopAudio?.();
      progress(api, message, 'error');
      report?.('failed', message);
    }
    return false;
  } finally {
    if (!cancelled()) reading = null;
  }
}

async function readDocument(api, context) {
  const content = context?.content;
  if (!['html', 'markdown', 'text'].includes(content?.kind)) return false;
  try {
    const viewer = await api.getActiveViewerText();
    if (viewer?.id !== content.id) return false;
    warnTruncated(api, viewer.truncated);
    return speak(api, viewer.text, {
      surface: 'viewer', sessionId: viewer.sessionId || context.session?.id, contentId: content.id, sourceOffset: 0,
    });
  } catch (error) {
    progress(api, error?.message || String(error), 'error');
    return false;
  }
}

function warnTruncated(api, truncated) {
  if (truncated) api.toast('info', {
    title: 'Supertonic Voice',
    body: 'This exceeds the preview text limit. Only the available beginning will be read.',
    duration: 10000,
  });
}

export async function activate(api) {
  const cleanups = [];
  let removeHotkey = null;
  let currentAutoToken = '';
  // The host already supplied saved settings at worker creation. A waiting
  // reply may arrive before the asynchronous server settings reply.
  const initial = api.getSettings?.()?.values || {};
  preferences = { ...DEFAULTS, ...initial, playbackRate: playbackRate(initial['playback-rate']) };
  const bindHotkey = () => {
    removeHotkey?.(); removeHotkey = null;
    if (!preferences.shortcut) return;
    removeHotkey = api.registerHotkey(preferences.shortcut, async () => {
      const viewer = await api.getActiveViewerText();
      if (viewer) {
        const selected = Boolean(String(viewer.selection || '').trim());
        const text = selected ? viewer.selection : viewer.text;
        if (!String(text || '').trim()) {
          api.toast('info', { title: 'Supertonic Voice', body: 'This document has no readable text.' });
          return;
        }
        warnTruncated(api, selected ? viewer.selectionTruncated : viewer.truncated);
        const session = await api.getActiveSession();
        await speak(api, text, {
          surface: 'viewer', sessionId: viewer.sessionId || session?.id, contentId: viewer.id,
          ...(!selected ? { sourceOffset: 0 }
            : Number.isInteger(viewer.selectionOffset) && viewer.selectionOffset >= 0 ? { sourceOffset: viewer.selectionOffset } : {}),
        });
        return;
      }
      // A refreshed worker can run beside an older page host. Anchoring is optional: a rejected host
      // request must fall back to the established selection API rather than abort the reader shortcut.
      let snapshot = null;
      try { snapshot = await api.getTerminalSelectionSnapshot?.(); } catch {}
      const selection = snapshot?.text ?? await api.getTerminalSelection();
      if (!String(selection || '').trim()) {
        if (await toggleCached(api)) return;
        api.toast('info', { title: 'Supertonic Voice', body: 'Select terminal text to read aloud.' });
        return;
      }
      const session = await api.getActiveSession();
      await speak(api, selection, {
        surface: 'terminal', sessionId: snapshot?.sessionId || session?.id, anchor: snapshot?.anchor,
      });
    });
  };
  cleanups.push(api.onMessage('settings', (value) => {
    preferences = { ...DEFAULTS, ...(value || {}) };
    bindHotkey();
  }));
  // Conversation hosts can prepare speech before the first reply arrives.
  cleanups.push(api.onMessage('warmup', async () => {
    try {
      const engine = await runtime(api);
      await voiceStyle(engine, preferences.voice);
      api.send('voice-ready', { ready: true });
    } catch (error) { api.send('voice-ready', { ready: false, error: playbackError(error) }); }
  }));
  // Agent speak requests: only a browser showing the caller's session asks to play it, and only
  // the one the server picks does. The result goes back to the waiting `supertonic/speak` command.
  const claims = new Map();
  cleanups.push(api.onMessage('speak-claim', (value) => {
    const settle = claims.get(value?.requestId);
    if (settle) settle(value.granted === true && typeof value.claim === 'string' ? value.claim : '');
  }));
  const claimAgentRequest = requestId => new Promise((resolve) => {
    const timer = setTimeout(() => settle(''), CLAIM_REPLY_MS);
    const settle = (claim) => { clearTimeout(timer); claims.delete(requestId); resolve(claim); };
    claims.set(requestId, settle);
    api.send('speak-claim', { requestId });
  });
  const agentSpeak = async (value) => {
    const session = await api.getActiveSession();
    if (value.sessionId && value.sessionId !== session?.id) return;
    const claim = await claimAgentRequest(value.requestId);
    if (!claim) return;
    let answered = false;
    const report = (status, message = '') => {
      if (answered) return;
      answered = true;
      api.send('speak-result', {
        requestId: value.requestId, claim, status, ...(message ? { message: String(message).slice(0, 300) } : {}),
      });
    };
    report.requestId = value.requestId;
    const alive = setInterval(() => api.send('speak-alive', { requestId: value.requestId, claim }), ALIVE_MS);
    try {
      if (!await speak(api, value.text, { surface: 'terminal', sessionId: value.sessionId }, '', report)) {
        report('failed', STOPPED_EARLY);
      }
    } catch (error) {
      report('failed', error?.message || String(error));
    } finally {
      clearInterval(alive);
    }
  };
  cleanups.push(api.onMessage('speak-request', (value) => {
    if (typeof value?.requestId === 'string' && value.requestId) return agentSpeak(value);
  }));
  cleanups.push(api.onMessage('speak', async (value) => {
    const automatic = value?.source === 'auto';
    const token = automatic && typeof value.token === 'string' ? value.token : '';
    if (automatic && !token) return; // Old global auto-read events must not bypass session opt-in.
    if (automatic) currentAutoToken = token;
    let status = 'failed';
    try {
      const session = await api.getActiveSession();
      if (value?.sessionId && value.sessionId !== session?.id) return;
      if (automatic && (currentAutoToken !== token || session?.readAloud !== true)) return;
      if (automatic && reading && !reading.autoToken) { status = 'deferred'; return; }
      const played = await speak(api, value?.text, { surface: 'terminal', sessionId: value?.sessionId }, token);
      status = played ? 'finished' : reading && !reading.autoToken ? 'deferred' : 'failed';
    } finally {
      if (automatic && currentAutoToken === token) api.send('auto-read-result', { token, status });
    }
  }));
  cleanups.push(api.onMessage('speak-cancel', value => {
    // The server gave up on this agent request: end it, and stop the audio only if it is this reading's.
    if (value?.requestId) {
      if (reading?.requestId === value.requestId) {
        const job = reading;
        reading = null;
        if (job.playing) api.stopAudio?.();
      }
      return;
    }
    if (value?.token === currentAutoToken) currentAutoToken = '';
    if (value?.token && reading?.autoToken === value.token) reading = null;
    // The host stops only this token's audio; never stop a newer manual read here.
  }));
  cleanups.push(api.registerAction({
    id: 'read-selection',
    label: 'Read selection aloud',
    icon: 'waveform',
    description: 'Speak the selected text locally with Supertonic.',
    placements: ['terminal.context', 'viewer.context'],
    when: (context) => Boolean(context?.selection?.text?.trim()),
    run: (context) => speak(api, context?.selection?.text, context?.surface === 'terminal'
      ? { surface: 'terminal', sessionId: context?.session?.id, anchor: context?.selection?.anchor }
      : {
        surface: 'viewer', sessionId: context?.session?.id, contentId: context?.content?.id,
        ...(Number.isInteger(context?.selection?.offset) && context.selection.offset >= 0 ? { sourceOffset: context.selection.offset } : {}),
      }),
  }));
  cleanups.push(api.registerAction({
    id: 'read-document',
    label: 'Read document aloud',
    icon: '≋',
    description: 'Speak this text, Markdown, or HTML document locally with Supertonic.',
    placements: ['viewer.context'],
    when: (context) => ['html', 'markdown', 'text'].includes(context?.content?.kind),
    run: (context) => readDocument(api, context),
  }));
  api.send('ready', null);
  return () => {
    removeHotkey?.();
    reading = null;
    speechCache = null;
    for (const cleanup of cleanups) cleanup?.();
    api.stopAudio?.();
  };
}

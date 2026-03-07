let settings = { enabled: false, backend: 'openai', hotkey: 'F4' };
let recordingState = null; // { startTime, mediaRecorder, stream, cancelled, sessionId }
let activeToast = null;
let btnEl = null;
let _api = null;

function toast(message, type, persistent) {
  if (activeToast) activeToast.dismiss();
  activeToast = _api.toast(message, { type, duration: persistent ? 0 : 2000, id: 'voice-input' });
  return activeToast;
}

// --- Audio: decode to 16kHz mono Float32 PCM (no ffmpeg needed) ---

async function decodeToPcm16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const decoded = await ctx.decodeAudioData(buf);
  const numSamples = Math.round(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, numSamples, 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const resampled = await offline.startRendering();
  ctx.close();
  return resampled.getChannelData(0); // Float32Array, 16kHz mono
}

function float32ToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

// --- Button state ---

function updateButton() {
  if (!btnEl) return;
  if (recordingState) {
    btnEl.style.color = '#ef4444';
    btnEl.title = 'Stop recording (or press ' + (settings.hotkey || 'F4') + ')';
  } else {
    btnEl.style.color = '';
    btnEl.title = 'Voice Input (' + (settings.hotkey || 'F4') + ')';
  }
}

// --- Recording ---

async function startRecording() {
  if (!_api || recordingState) return;
  const sessionId = _api.getActiveSessionId();
  if (!sessionId) { toast('No active terminal', 'error'); return; }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

    const chunks = [];
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const state = recordingState;
      recordingState = null;
      updateButton();
      if (activeToast) activeToast.dismiss();

      if (!state || state.cancelled) {
        toast('CANCELLED', 'error');
        return;
      }

      const duration = (Date.now() - state.startTime) / 1000;
      if (duration < 0.4) {
        toast('Too short', 'error');
        return;
      }

      toast('Transcribing...', 'info', true);

      try {
        const blob = new Blob(chunks, { type: mr.mimeType });
        const pcm = await decodeToPcm16k(blob);
        const b64 = float32ToBase64(pcm);
        _api.send('transcribe', { audio: b64, sessionId: state.sessionId });
      } catch (e) {
        toast('Audio decode failed', 'error');
      }
    };

    mr.start(100);
    recordingState = { startTime: Date.now(), mediaRecorder: mr, stream, cancelled: false, sessionId };
    updateButton();
    toast('REC \u25cf', 'error', true);
  } catch (e) {
    toast('Mic: ' + e.message, 'error');
  }
}

function stopRecording() {
  if (recordingState) recordingState.mediaRecorder.stop();
}

function cancelRecording() {
  if (!recordingState) return;
  recordingState.cancelled = true;
  recordingState.mediaRecorder.stop();
}

// --- Hotkey ---

function onKeyDown(e) {
  if (!settings.enabled) return;
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
  if (inInput && !e.key.startsWith('F')) return;

  if (e.key === 'Escape' && recordingState) {
    e.preventDefault();
    e.stopPropagation();
    cancelRecording();
    return;
  }

  const hotkey = (settings.hotkey || 'F4').trim();
  if (e.key === hotkey) {
    e.preventDefault();
    e.stopPropagation();
    if (!recordingState) startRecording();
    else stopRecording();
  }
}

// --- Init ---

export function init(api) {
  _api = api;

  document.addEventListener('keydown', onKeyDown, true);

  api.onMessage('settings', msg => {
    settings = { ...settings, ...msg };
    if (btnEl) btnEl.style.display = settings.enabled ? '' : 'none';
  });

  api.onMessage('status', msg => {
    if (msg.setup) toast(msg.setup, 'info', true);
    else if (msg.workerReady) toast('Voice Input ready', 'success');
  });

  api.onMessage('result', msg => {
    if (activeToast) { activeToast.dismiss(); activeToast = null; }
    if (msg.skipped || !msg.text) return;
    const sid = msg.sessionId || _api.getActiveSessionId();
    if (!sid) return;
    api.writeToSession(sid, msg.text + ' ');
    document.querySelector('.term-wrap.active textarea')?.focus();
  });

  api.onMessage('error', msg => {
    toast(msg.error || 'Error', 'error');
  });

  api.send('getSettings');

  btnEl = api.addToolbarButton({
    title: 'Voice Input (F4)',
    icon: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    onClick() {
      if (!settings.enabled) { toast('Voice Input is disabled', 'error'); return; }
      if (!recordingState) startRecording();
      else stopRecording();
    },
  });

  btnEl.addEventListener('mousedown', e => e.preventDefault());
  if (!settings.enabled && btnEl) btnEl.style.display = 'none';
}

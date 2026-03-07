let settings = { enabled: false, backend: 'openai', hotkey: 'F4' };
let recordingState = null; // { startTime, mediaRecorder, stream, cancelled, sessionId }
let activeToast = null;
let btnEl = null;
let _api = null;

// --- Toast (matches global_asr overlay style) ---

function showToast(message, color, persistent) {
  dismissToast(activeToast);
  const toast = document.createElement('div');
  toast.className = 'voice-input-toast';
  const bg = color === 'red' ? 'rgba(239,68,68,0.9)' : 'rgba(16,185,129,0.9)';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: '9999',
    padding: '10px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
    color: '#fff', background: bg, backdropFilter: 'blur(8px)',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    opacity: '0', transform: 'translateY(8px)',
    transition: 'opacity 0.2s ease, transform 0.2s ease',
    fontFamily: 'system-ui, sans-serif',
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
  if (!persistent) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      setTimeout(() => toast.remove(), 200);
    }, 2000);
  }
  return toast;
}

function dismissToast(toast) {
  if (!toast || !toast.parentNode) return;
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(8px)';
  setTimeout(() => toast.remove(), 200);
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
  if (!sessionId) { activeToast = showToast('No active terminal', 'red'); return; }

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
      dismissToast(activeToast);

      if (!state || state.cancelled) {
        activeToast = showToast('CANCELLED', 'red');
        return;
      }

      const duration = (Date.now() - state.startTime) / 1000;
      if (duration < 0.4) {
        activeToast = showToast('Too short', 'red');
        return;
      }

      activeToast = showToast('Transcribing...', 'green', true);

      try {
        const blob = new Blob(chunks, { type: mr.mimeType });
        const pcm = await decodeToPcm16k(blob);
        const b64 = float32ToBase64(pcm);
        _api.send('transcribe', { audio: b64, sessionId: state.sessionId });
      } catch (e) {
        dismissToast(activeToast);
        activeToast = showToast('Audio decode failed', 'red');
      }
    };

    mr.start(100);
    recordingState = { startTime: Date.now(), mediaRecorder: mr, stream, cancelled: false, sessionId };
    updateButton();
    activeToast = showToast('REC \u25cf', 'red', true);
  } catch (e) {
    activeToast = showToast('Mic: ' + e.message, 'red');
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
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

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

  api.onMessage('result', msg => {
    dismissToast(activeToast);
    activeToast = null;
    if (msg.skipped || !msg.text) return;
    const sid = msg.sessionId || _api.getActiveSessionId();
    if (!sid) return;
    api.writeToSession(sid, msg.text + ' ');
  });

  api.onMessage('error', msg => {
    dismissToast(activeToast);
    activeToast = showToast(msg.error || 'Error', 'red');
  });

  api.send('getSettings');

  btnEl = api.addToolbarButton({
    title: 'Voice Input (F4)',
    icon: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>',
    onClick() {
      if (!settings.enabled) { activeToast = showToast('Voice Input is disabled', 'red'); return; }
      if (!recordingState) startRecording();
      else stopRecording();
    },
  });

  if (!settings.enabled && btnEl) btnEl.style.display = 'none';
}

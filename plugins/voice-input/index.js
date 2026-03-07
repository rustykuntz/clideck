const { spawn } = require('child_process');
const { join } = require('path');
const { readFileSync, existsSync, statSync } = require('fs');

module.exports = {
  init(api) {
    let worker = null;
    let workerReady = false;
    const pending = new Map();
    let nextId = 0;
    let replacements = [];
    let replMtime = null;

    // --- Python virtual environment ---

    const pyDir = join(api.pluginDir, 'python');
    const venvDir = join(pyDir, '.venv');
    const venvPy = process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python3');

    function localDeps() {
      if (process.platform === 'darwin') return ['numpy', 'mlx', 'tiktoken', 'huggingface_hub'];
      return ['numpy', 'faster-whisper'];
    }

    function checkImport() {
      return process.platform === 'darwin'
        ? 'import numpy, mlx, tiktoken, huggingface_hub'
        : 'import numpy, faster_whisper';
    }

    function run(cmd, args) {
      return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        p.stderr.on('data', d => { err += d; });
        p.on('close', code => code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`)));
      });
    }

    function findPython() {
      const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
      for (const cmd of candidates) {
        try { require('child_process').execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return cmd; } catch {}
      }
      throw new Error('Python not found. Install Python 3 and ensure it is in your PATH.');
    }

    async function ensureEnv() {
      if (!existsSync(venvDir)) {
        api.sendToFrontend('status', { setup: 'Creating Python environment…' });
        api.log('creating venv');
        await run(findPython(), ['-m', 'venv', venvDir]);
      }
      try {
        await run(venvPy, ['-c', checkImport()]);
      } catch {
        const deps = localDeps();
        api.sendToFrontend('status', { setup: `Installing dependencies (${deps.join(', ')})…` });
        api.log(`pip install: ${deps.join(', ')}`);
        await run(venvPy, ['-m', 'pip', 'install', '--quiet', ...deps]);
      }
    }

    // --- Text replacements (same format as global_asr) ---

    function loadReplacements() {
      const fp = api.getSetting('replacementsFile');
      if (!fp || !existsSync(fp)) { replacements = []; replMtime = null; return; }
      try {
        const mt = statSync(fp).mtimeMs;
        if (replMtime === mt) return;
        const rules = [];
        for (const raw of readFileSync(fp, 'utf8').split('\n')) {
          const line = raw.trim();
          if (!line || line.startsWith('#') || !line.includes('=>')) continue;
          const [srcRaw, ...rest] = line.split('=>');
          const right = rest.join('=>').split('|');
          const src = srcRaw.trim().replace(/^['"]|['"]$/g, '');
          const tgt = (right[0] || '').trim().replace(/^['"]|['"]$/g, '');
          if (!src) continue;
          let flags = 'g';
          for (const o of right.slice(1)) {
            const t = o.trim().toLowerCase();
            if (t === 'all' || t === 'match_all' || t.includes('mode=all')) flags = 'gi';
          }
          const esc = src.split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
          rules.push({ re: new RegExp(`(?<!\\w)${esc}(?!\\w)`, flags), tgt });
        }
        replacements = rules;
        replMtime = mt;
      } catch (e) { api.log(`replacements: ${e.message}`); }
    }

    function applyReplacements(text) {
      if (!text) return text;
      loadReplacements();
      for (const { re, tgt } of replacements) text = text.replace(re, tgt);
      return text;
    }

    // --- Text cleaning (ported from global_asr) ---

    function cleanText(text) {
      text = text.replace(/\s*Продолжение следует\.{3}.*$/i, '').replace(/\s*Thank you[.!]*\s*$/i, '').trim();
      const l = text.toLowerCase();
      const gLen = ['clears throat', 'cough', 'ahem'].reduce((s, p) => s + (l.split(p).length - 1) * p.length, 0);
      const hLen = (l.split('hmm').length - 1) * 3;
      if (text.length > 0 && hLen / text.length > 0.6) return '';
      if (text.length > 0 && gLen / text.length > 0.5) return '';
      return text;
    }

    function processText(raw) {
      const cleaned = cleanText(raw);
      if (!cleaned || cleaned.toLowerCase() === 'you') return null;
      return applyReplacements(cleaned);
    }

    // --- Python worker (local backend) ---

    function spawnWorker() {
      if (worker) return;
      const script = join(api.pluginDir, 'python', 'worker.py');
      if (!existsSync(script)) { api.log('worker.py not found'); return; }

      worker = spawn(venvPy, ['-u', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: pyDir,
      });

      let buf = '';
      worker.stdout.on('data', d => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 'init') { api.log('worker started'); continue; }
            const cb = pending.get(msg.id);
            if (cb) { pending.delete(msg.id); cb(msg); }
          } catch { /* ignore parse errors */ }
        }
      });

      worker.stderr.on('data', d => {
        const t = d.toString().trim();
        if (t) api.log(`py: ${t}`);
      });

      worker.on('close', code => {
        api.log(`worker exited (${code})`);
        worker = null;
        workerReady = false;
        for (const [, cb] of pending) cb({ error: 'Worker exited' });
        pending.clear();
      });
    }

    function workerCmd(action, data = {}) {
      return new Promise((resolve, reject) => {
        if (!worker) { reject(new Error('No worker')); return; }
        const id = String(++nextId);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, 120000);
        pending.set(id, msg => {
          clearTimeout(timer);
          msg.error ? reject(new Error(msg.error)) : resolve(msg);
        });
        worker.stdin.write(JSON.stringify({ id, action, ...data }) + '\n');
      });
    }

    function killWorker() {
      if (!worker) return;
      try { worker.kill(); } catch {}
      worker = null;
      workerReady = false;
    }

    // --- PCM to WAV (for OpenAI upload) ---

    function pcmToWav(pcmB64) {
      const raw = Buffer.from(pcmB64, 'base64');
      const numSamples = raw.length / 4; // float32 = 4 bytes
      const pcm16 = Buffer.alloc(numSamples * 2);
      for (let i = 0; i < numSamples; i++) {
        const f = Math.max(-1, Math.min(1, raw.readFloatLE(i * 4)));
        pcm16.writeInt16LE(Math.round(f * 32767), i * 2);
      }
      const dataLen = pcm16.length;
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + dataLen, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);   // PCM
      header.writeUInt16LE(1, 22);   // mono
      header.writeUInt32LE(16000, 24); // sample rate
      header.writeUInt32LE(32000, 28); // byte rate
      header.writeUInt16LE(2, 32);   // block align
      header.writeUInt16LE(16, 34);  // bits per sample
      header.write('data', 36);
      header.writeUInt32LE(dataLen, 40);
      return Buffer.concat([header, pcm16]);
    }

    // --- OpenAI transcription (pure Node.js) ---

    async function transcribeOpenAI(pcmB64) {
      const apiKey = api.getSetting('openaiApiKey');
      if (!apiKey) throw new Error('OpenAI API key not configured');

      const lang = api.getSetting('language');
      const wav = pcmToWav(pcmB64);
      const boundary = '----B' + Date.now().toString(36) + Math.random().toString(36).slice(2);

      const fields = [['model', 'whisper-1'], ['response_format', 'verbose_json']];
      if (lang && lang !== 'auto') fields.push(['language', lang]);

      let pre = '';
      for (const [k, v] of fields) {
        pre += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
      }
      pre += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
      const post = `\r\n--${boundary}--\r\n`;

      const body = Buffer.concat([Buffer.from(pre), wav, Buffer.from(post)]);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return { text: data.text || '', language: data.language || 'unknown', avg_logprob: null };
    }

    // --- Message handlers ---

    api.onFrontendMessage('transcribe', async (msg) => {
      const backend = api.getSetting('backend');
      try {
        let result;
        if (backend === 'local') {
          if (!worker) { api.sendToFrontend('error', { error: 'Local model not running. Enable plugin with local backend to start.' }); return; }
          result = await workerCmd('transcribe', {
            audio: msg.audio,
            lang: api.getSetting('language') || 'auto',
          });
        } else {
          result = await transcribeOpenAI(msg.audio);
        }

        const text = processText(result.text || '');
        if (!text) {
          api.sendToFrontend('result', { text: '', skipped: true, sessionId: msg.sessionId });
          return;
        }
        api.sendToFrontend('result', { text, language: result.language, inferenceTime: result.inference_time, sessionId: msg.sessionId });
      } catch (e) {
        api.log(`transcribe: ${e.message}`);
        api.sendToFrontend('error', { error: e.message });
      }
    });

    api.onFrontendMessage('getSettings', () => {
      api.sendToFrontend('settings', api.getSettings());
    });

    api.onFrontendMessage('getStatus', () => {
      api.sendToFrontend('status', {
        backend: api.getSetting('backend'),
        workerRunning: !!worker,
        workerReady,
      });
    });

    api.onSettingsChange(() => {
      api.sendToFrontend('settings', api.getSettings());
      const enabled = api.getSetting('enabled');
      const backend = api.getSetting('backend');
      if (enabled && backend === 'local') {
        if (!worker) startLocal();
      } else {
        killWorker();
      }
    });

    async function warmup() {
      if (!worker) return;
      try {
        const result = await workerCmd('warmup');
        workerReady = result.status === 'ready';
        api.sendToFrontend('status', { backend: 'local', workerRunning: true, workerReady });
        api.log(workerReady ? 'local model ready' : 'warmup failed');
      } catch (e) {
        api.log(`warmup: ${e.message}`);
        api.sendToFrontend('error', { error: `Model warmup failed: ${e.message}` });
      }
    }

    function wantsLocal() {
      return api.getSetting('enabled') && api.getSetting('backend') === 'local';
    }

    let setupLock = null;
    async function startLocal() {
      if (setupLock) return setupLock;
      setupLock = (async () => {
        try {
          await ensureEnv();
          if (!wantsLocal()) return;
          spawnWorker();
          warmup();
        } catch (e) {
          api.log(`env setup failed: ${e.message}`);
          api.sendToFrontend('error', { error: `Python setup failed: ${e.message}` });
        } finally {
          setupLock = null;
        }
      })();
      return setupLock;
    }

    // --- Init ---

    if (api.getSetting('enabled') && api.getSetting('backend') === 'local') {
      startLocal();
    }

    api.onShutdown(() => killWorker());
  },
};

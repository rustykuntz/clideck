// Agent `supertonic/speak` waits for one browser's real answer. Fake engine, fake audio: no model
// download, no real speech.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const { pathToFileURL } = require('url');
const { ConfigStore } = require('../src/config-store');
const { PluginManager } = require('../src/plugin-manager');

const PLUGIN_ROOT = resolve(__dirname, '../plugins');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(read, predicate, timeout = 2000) {
  const started = Date.now();
  for (;;) {
    const value = read().find(predicate);
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('Timed out.');
    await sleep(5);
  }
}

// A fresh module instance per browser; the suffix only seeds the fake engine (test-only).
let instance = 0;
async function loadClient() {
  const path = join(PLUGIN_ROOT, 'supertonic', 'client.js');
  const source = readFileSync(path, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
    .replaceAll("import('./public/", `import('${pathToFileURL(join(PLUGIN_ROOT, 'supertonic', 'public')).href}/`)
    + '\nexport function __seedEngine(engine) { runtimePromise = Promise.resolve(engine); }\n'
    + `// instance ${++instance}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function fakeEngine({ failOn = '', delay = 0 } = {}) {
  return {
    helper: {
      // '|' splits a reading into playback parts, so multi-clip reads are easy to build.
      chunkTextRanges: (text) => {
        const ranges = []; let start = 0;
        for (const part of text.split('|')) { ranges.push({ start, end: start + part.length }); start += part.length + 1; }
        return ranges;
      },
      writeWavFile: () => new ArrayBuffer(64),
      loadVoiceStyle: async () => ({}),
    },
    textToSpeech: {
      sampleRate: 10,
      call: async (text) => {
        if (delay) await sleep(delay);
        if (failOn && text.includes(failOn)) throw new Error('WebGPU device lost.');
        return { wav: new Float32Array(10), duration: [1] };
      },
    },
    styles: new Map(),
  };
}

// A browser: plugin client + the host audio API. `audio`: plays (ends after 20 ms) | stall | blocked | stopped.
async function browser(manager, { session = 'one', engine = fakeEngine(), audio = 'plays' } = {}) {
  const handlers = new Map();
  const played = [];
  const toasts = [];
  let stops = 0;
  let current = null; // the clip "playing" now; stopAudio ends it like the host does
  const mod = await loadClient();
  mod.__seedEngine(engine);
  const deliver = (event) => handlers.get(event.event)?.(event.data);
  const api = {
    getSettings: () => ({ values: { normalization: 'off', shortcut: '' } }),
    onMessage: (event, fn) => { handlers.set(event, fn); return () => handlers.delete(event); },
    registerAction: () => () => {},
    registerHotkey: () => () => {},
    getActiveSession: async () => (session ? { id: session } : null),
    send: (event, data) => manager.clientMessage('supertonic', event, data, { requestId: 'r', reply: deliver }),
    toast: (kind, options) => toasts.push({ kind, options }),
    stopAudio: () => { stops += 1; const end = current; current = null; end?.(false); },
    playAudio: () => played.push('fire-and-forget'),
    playAudioAndWait: (buffer, options) => {
      played.push(options.text);
      if (audio === 'blocked') return Promise.reject(new Error("NotAllowedError: play() failed because the user didn't interact with the document first."));
      if (audio === 'stopped') return Promise.resolve(false);
      return new Promise((resolve) => {
        const previous = current; current = resolve; previous?.(false);
        if (audio === 'plays') setTimeout(() => { if (current === resolve) { current = null; resolve(true); } }, 20);
      });
    },
  };
  await mod.activate(api);
  return { deliver, played, toasts, stops: () => stops };
}

async function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-supertonic-agent-'));
  const browsers = [];
  const events = [];
  const manager = new PluginManager({
    dataDir, bundledDir: PLUGIN_ROOT, configStore: new ConfigStore({ dataDir }),
    onClientEvent: (event) => { events.push(event); browsers.forEach((b) => b.deliver(event)); },
    log: () => {},
  });
  t.after(() => manager.close());
  await manager.start();
  const add = async (options) => { const b = await browser(manager, options); browsers.push(b); return b; };
  const speak = (text = 'hello there', sessionId = 'one') => manager.runCommand('supertonic', 'speak', { args: [text], sessionId, timeoutMs: 60_000 });
  const lastRequest = () => events.filter((e) => e.event === 'speak-request').at(-1)?.data;
  return { manager, add, speak, events, lastRequest };
}

const FAILED = (stderr) => ({ stdout: '', stderr, exitCode: 1 });

test('one of two browsers showing the session reads it to the end; the answer comes after the last clip', async (t) => {
  const { add, speak, events } = await setup(t);
  const a = await add();
  const b = await add();
  const other = await add({ session: 'two' });
  const result = await speak('first part|second part');
  assert.deepEqual(result, { stdout: 'Read aloud in CliDeck.\n', stderr: '', exitCode: 0 });
  const reader = a.played.length ? a : b;
  assert.deepEqual(reader.played, ['first part', 'second part'], 'every clip played before success');
  assert.equal(a.played.length && b.played.length, 0, 'exactly one browser plays');
  assert.equal(other.played.length, 0, 'a browser on another session never plays');
  assert.equal(events.some((e) => e.event === 'speak'), false, 'older clients (which only know "speak") never get it');
});

test('no browser showing the session is an error, and nothing plays', async (t) => {
  const { add, speak } = await setup(t);
  const other = await add({ session: 'two' });
  const started = Date.now();
  const result = await speak();
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /No open CliDeck window is showing this session/);
  assert.ok(Date.now() - started < 6500, 'bounded wait');
  assert.equal(other.played.length, 0);
});

test('a synthesis failure returns its error', async (t) => {
  const { add, speak } = await setup(t);
  const b = await add({ engine: fakeEngine({ failOn: 'hello' }) });
  assert.deepEqual(await speak(), FAILED('Supertonic: WebGPU device lost.\n'));
  assert.equal(b.toasts.at(-1).kind, 'error', 'the person still sees the error');
});

test('a failure in a later chunk, after the first clip played, is still an error', async (t) => {
  const { add, speak } = await setup(t);
  const b = await add({ engine: fakeEngine({ failOn: 'second' }) });
  assert.deepEqual(await speak('first part|second part'), FAILED('Supertonic: WebGPU device lost.\n'));
  assert.deepEqual(b.played, ['first part']);
});

test('blocked autoplay is explained to the agent and the person', async (t) => {
  const { add, speak } = await setup(t);
  const b = await add({ audio: 'blocked' });
  const result = await speak();
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /browser blocked audio/);
  assert.match(b.toasts.at(-1).options.body, /browser blocked audio/);
});

test('a stalled first clip never becomes success; cancelling it stops only its own audio', async (t) => {
  const { add, speak, lastRequest } = await setup(t);
  const b = await add({ audio: 'stall' });
  let settled = false;
  const pending = speak().then((r) => { settled = true; return r; });
  await sleep(1500);
  assert.equal(settled, false, 'still waiting while the clip has not finished');
  const stopsBefore = b.stops();
  // What the server sends when it gives up (deadline / window went quiet).
  b.deliver({ event: 'speak-cancel', data: { requestId: lastRequest().requestId } });
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /stopped or replaced before it finished/);
  assert.equal(b.stops(), stopsBefore + 1, 'its own playback was stopped');
});

test('cancelling during synthesis never stops audio that is not this reading', async (t) => {
  const { add, speak, lastRequest } = await setup(t);
  const b = await add({ engine: fakeEngine({ delay: 200 }) });
  const pending = speak();
  await sleep(60);
  b.deliver({ event: 'speak-cancel', data: { requestId: 'someone-else' } });
  b.deliver({ event: 'speak-cancel', data: { requestId: lastRequest().requestId } });
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(b.stops(), 0, 'nothing of ours was playing, so nothing was stopped');
  assert.equal(b.played.length, 0, 'and it never plays late');
});

test('playback stopped by the person is an error', async (t) => {
  const { add, speak } = await setup(t);
  await add({ audio: 'stopped' });
  const result = await speak();
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /stopped or replaced before it finished/);
});

test('a newer reading replacing the request is an error, not a success', async (t) => {
  const { add, speak } = await setup(t);
  await add({ engine: fakeEngine({ delay: 150 }) });
  const first = speak('first text');
  await sleep(40);
  const second = speak('second text');
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.exitCode, 1);
  assert.match(one.stderr, /stopped or replaced/);
  assert.equal(two.exitCode, 0);
});

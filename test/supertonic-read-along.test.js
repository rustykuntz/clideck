const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '../plugins/supertonic');
const lexiconSource = readFileSync(resolve(root, 'public/tts_normalization_lexicon.txt'), 'utf8');
async function modules() {
  const normalizer = await import('../plugins/supertonic/public/tts-normalizer.js');
  const timing = await import('../plugins/supertonic/public/read-along-timing.js');
  return { ...normalizer, ...timing, entries: normalizer.parseLexicon(lexiconSource) };
}

async function clientForTest() {
  const path = resolve(root, 'client.js');
  const source = readFileSync(path, 'utf8')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
    .replace(/import\('(.\/[^']+)'\)/g, (_, relative) => `import(${JSON.stringify(pathToFileURL(resolve(root, relative)).href)})`);
  return import(`data:text/javascript;base64,${Buffer.from(source + `
    export { synthesize, speak };
    export function setEngineForTest(engine) { runtimePromise = Promise.resolve(engine); }
  `).toString('base64')}`);
}

test('read-along traces the existing normalization without changing spoken text', async () => {
  const { normalizeText, normalizeTextWithRanges, entries } = await modules();
  for (const source of [
    'Item 365 is now your live question about the copy icon',
    'since 08-26, from 1/99, at 9:05 PM; wait 2 days or 250ms.',
    '€1.01; $897k; 42nd; 3.1415; 2026-08-26. API >= 365.',
    'Sep 22–Nov 6; 11 Oct, October 11th, and 11–13 Oct 2026.',
    'We made +1.82M, +0.41M and −0.42M; we make 0.41K.',
    'Read https://example.com/docs?q=1 and ./reports/result.pdf:761.',
    '“READY”—e.g. HTML… foo_bar a*b issue#12 😀 日本語',
    'First.  Second!\nThird.\n\nLast.', '',
  ]) {
    for (const language of ['english', 'off']) {
      const mapped = normalizeTextWithRanges(source, entries, language);
      assert.equal(mapped.text, normalizeText(source, entries, language));
      assert.equal(mapped.ranges.length, mapped.text.length);
      for (const range of mapped.ranges) {
        assert.ok(range.start >= 0 && range.end > range.start && range.end <= source.length);
      }
    }
  }
  const source = 'Item 365 is ready';
  const mapped = normalizeTextWithRanges(source, entries);
  const start = mapped.text.indexOf('three'), end = mapped.text.indexOf(' is');
  assert.ok(mapped.ranges.slice(start, end).every(range => source.slice(range.start, range.end) === '365'));
});

async function readerHarness() {
  const client = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  const spoken = [], playback = [], toasts = [], actions = [], messages = new Map(), hotkeys = new Map();
  let stops = 0;
  client.setEngineForTest({
    styles: new Map([['female-2', {}]]),
    helper: { chunkTextRanges, writeWavFile: () => new ArrayBuffer(16) },
    textToSpeech: { sampleRate: 100, call: async text => {
      spoken.push(text);
      return { wav: new Float32Array(100), duration: [1] };
    } },
  });
  const api = {
    onMessage: (name, fn) => { messages.set(name, fn); return () => {}; },
    registerAction: action => { actions.push(action); return () => {}; },
    registerHotkey: (key, handler) => { hotkeys.set(key, handler); return () => {}; },
    getActiveSession: async () => ({ id: 'one' }),
    send() {},
    toast: (_kind, options) => toasts.push(options),
    playAudio: (_wav, options) => playback.push(options),
    playAudioAndWait: async (_wav, options) => { playback.push(options); return true; },
    stopAudio: () => { stops++; },
  };
  const cleanup = await client.activate(api);
  messages.get('settings')({ normalization: 'off' });
  return { ...client, api, spoken, playback, toasts, actions, messages, hotkeys, cleanup, stops: () => stops };
}

test('document actions and F5 use snapshot identity, selection offsets and explicit truncation warnings', async (t) => {
  const h = await readerHarness(); t.after(h.cleanup);
  h.api.getActiveViewerText = async () => ({
    id: 'doc', sessionId: 'one', kind: 'markdown', text: 'Full document',
    selection: 'Repeated phrase', selectionOffset: 45, truncated: true,
  });
  const action = h.actions.find(action => action.id === 'read-document');
  assert.equal(await action.run({ content: { id: 'other', kind: 'markdown' } }), false);
  assert.equal(h.playback.length, 0, 'a tab switch must not read a different document');
  await action.run({ content: { id: 'doc', kind: 'markdown' }, session: { id: 'one' } });
  assert.equal(h.playback[0].readAlong.sourceOffset, 0);
  assert.equal(h.playback[0].readAlong.sourceText, 'Full document');
  assert.match(h.toasts[0].body, /Only the available beginning/);
  h.messages.get('settings')({ normalization: 'off', shortcut: 'F5' });
  await h.hotkeys.get('F5')();
  assert.equal(h.playback[1].readAlong.sourceText, 'Repeated phrase');
  assert.equal(h.playback[1].readAlong.sourceOffset, 45);
  assert.equal(h.toasts.length, 1, 'an intact selection does not warn about an unselected document tail');
  await h.actions.find(action => action.id === 'read-selection').run({
    surface: 'viewer', content: { id: 'doc', kind: 'markdown' }, session: { id: 'one' },
    selection: { text: '  Repeated phrase  ', offset: 80 },
  });
  assert.equal(h.playback[2].readAlong.sourceOffset, 82);
  assert.equal(h.spoken.length, 2, 'same phrase at a new position reuses audio, not the old target');
});

test('long documents play every bounded batch with exact document offsets, not an 8000-character rejection', async (t) => {
  const h = await readerHarness(); t.after(h.cleanup);
  const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} has words to read.`).join('\n\n');
  const target = { surface: 'viewer', sessionId: 'one', contentId: 'doc', sourceOffset: 75 };
  assert.equal(await h.speak(h.api, text, target), true);
  assert.ok(h.playback.length > 7);
  assert.equal(h.toasts.length, 0);
  assert.equal(new Set(h.playback.map(clip => clip.sequence)).size, 1);
  let previousEnd = 0;
  for (const clip of h.playback) {
    const metadata = clip.readAlong;
    assert.equal(metadata.contentId, 'doc');
    assert.ok(clip.text.length <= 1200);
    const start = metadata.sourceOffset - 75;
    assert.equal(text.slice(previousEnd, start).trim(), '');
    assert.equal(text.slice(start, start + clip.text.length), clip.text);
    assert.ok(metadata.cues.every(cue => cue.textStart >= 0 && cue.textEnd <= clip.text.length));
    previousEnd = start + clip.text.length;
  }
  assert.equal(text.slice(previousEnd).trim(), '');
  assert.ok(h.spoken.every(text => text.length <= 300));
  assert.equal(h.stops(), 1); // release the transport retained between parts
});

test('long reading prefetches at most one batch and discards it after Stop', async (t) => {
  const h = await readerHarness(); t.after(h.cleanup);
  let finish;
  h.api.playAudioAndWait = (_wav, options) => {
    h.playback.push(options);
    return new Promise(resolve => { finish = resolve; });
  };
  const run = h.speak(h.api, 'word '.repeat(4000), { surface: 'terminal', sessionId: 'one', anchor: 'selected' });
  for (let i = 0; i < 30 && !finish; i++) await new Promise(setImmediate);
  assert.equal(typeof finish, 'function');
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  assert.equal(h.playback.length, 1);
  assert.ok(h.spoken.length <= 8, 'only current and next 1200-character batches synthesized');
  finish(false);
  assert.equal(await run, false);
  assert.equal(h.playback.length, 1);
  assert.equal(h.toasts.length, 0);
});

test('a different reading replaces a long one, and cleanup cannot revive prefetched audio', async (t) => {
  const h = await readerHarness(); t.after(h.cleanup);
  let finish;
  h.api.playAudioAndWait = (_wav, options) => {
    h.playback.push(options);
    return new Promise(resolve => { finish = resolve; });
  };
  h.api.stopAudio = () => finish?.(false);
  const first = h.speak(h.api, 'Long output. '.repeat(1000), { surface: 'terminal', sessionId: 'one' });
  for (let i = 0; i < 30 && !finish; i++) await new Promise(setImmediate);
  assert.equal(await h.speak(h.api, 'New selection', { surface: 'terminal', sessionId: 'one', anchor: 'new' }), true);
  assert.equal(await first, false);
  assert.equal(h.playback.at(-1).readAlong.sourceText, 'New selection');
  assert.equal(h.playback.at(-1).readAlong.anchor, 'new');
  assert.equal(h.toasts.length, 0);
});

test('cached speech reanchors across terminal and viewer selections and changed text gets fresh cues', async (t) => {
  const h = await readerHarness(); t.after(h.cleanup);
  await h.speak(h.api, 'First selection', { surface: 'terminal', sessionId: 'one', anchor: 'first' });
  await h.speak(h.api, 'Second selection', { surface: 'terminal', sessionId: 'one', anchor: 'second' });
  assert.equal(h.playback[1].readAlong.anchor, 'second');
  assert.equal(h.playback[1].readAlong.sourceText, 'Second selection');
  await h.speak(h.api, 'Second selection', { surface: 'viewer', sessionId: 'one', contentId: 'md', sourceOffset: 40 });
  assert.equal(h.spoken.length, 2);
  assert.equal(h.playback[2].readAlong.surface, 'viewer');
  assert.equal(h.playback[2].readAlong.contentId, 'md');
  assert.equal(h.playback[2].readAlong.sourceOffset, 40);
  assert.equal(h.playback[2].readAlong.anchor, undefined);
  await h.speak(h.api, '  Indented selection  ', { surface: 'terminal', sessionId: 'one', anchor: 'indented' });
  assert.equal(h.playback[3].readAlong.sourceOffset, 2);
  assert.equal(h.playback[3].readAlong.sourceText, 'Indented selection');
});

test('Markdown tables, code and diagrams are spoken as notices with original prose offsets', async t => {
  const h = await readerHarness(); t.after(h.cleanup);
  const table = '| Name | Value |\n| --- | --- |\n' + '| secret-cell | 999 |\n'.repeat(250);
  const source = `# Summary\n\nFirst paragraph.\n\n${table}\nAfter the table.\n\n\`\`\`mermaid\ngraph TD; Hidden --> Diagram\n\`\`\`\n\n\`\`\`python\nsecret_code()\n\`\`\`\n\nLast paragraph.`;
  assert(await h.speak(h.api, source, { surface: 'terminal', sessionId: 'one', sourceOffset: 10 }));
  const spoken = h.spoken.join('\n');
  assert.match(spoken, /See the table in the conversation/);
  assert.match(spoken, /See the diagram in the conversation/);
  assert.match(spoken, /See the code block in the conversation/);
  assert.doesNotMatch(spoken, /secret-cell|999|Hidden|secret_code|# Summary/);
  assert.match(spoken, /Summary/); assert.match(spoken, /Last paragraph/);
  const last = h.playback.at(-1).readAlong;
  assert.equal(last.sourceOffset, source.indexOf('Last paragraph.') + 10);
  assert.equal(last.sourceText, 'Last paragraph.');
  for (const clip of h.playback.filter(clip => clip.text.startsWith('See the'))) {
    assert.equal(clip.readAlong, undefined, 'synthetic notices must not falsely highlight prose');
  }
});

test('automatic speech requires session opt-in and token, and repeated equal replies play afresh', async t => {
  const h = await readerHarness(); t.after(h.cleanup);
  h.api.getActiveSession = async () => ({ id: 'one', readAloud: false });
  const deliver = token => h.messages.get('speak')({ source: 'auto', sessionId: 'one', text: 'Same answer', token });
  await deliver('off'); assert.equal(h.playback.length, 0);
  h.api.getActiveSession = async () => ({ id: 'one', readAloud: true });
  await deliver(undefined); assert.equal(h.playback.length, 0, 'old global broadcasts are ignored');
  let toggles = 0; h.api.toggleAudio = async () => { toggles++; return true; };
  await deliver('first'); await deliver('second');
  assert.equal(h.playback.length, 2); assert.equal(toggles, 0);
  assert.deepEqual(h.playback.map(clip => clip.autoToken), ['first', 'second']);
  assert.equal(h.spoken.length, 2);
});

test('the first automatic reply uses host-supplied settings before the server settings reply', async t => {
  const h = await readerHarness(); h.cleanup();
  h.api.getSettings = () => ({ values: { normalization: 'off', quality: 7, 'playback-rate': '1.25' } });
  h.api.getActiveSession = async () => ({ id: 'one', readAloud: true });
  const cleanup = await h.activate(h.api); t.after(cleanup);
  await h.messages.get('speak')({ source: 'auto', sessionId: 'one', text: 'Keep 123 literal.', token: 'early' });
  assert.equal(h.spoken.at(-1), 'Keep 123 literal.');
  assert.equal(h.playback.at(-1).playbackRate, 1.25);
});

test('saved playback speed reaches fresh and cached reading without resynthesizing identical speech', async t => {
  const h = await readerHarness(); t.after(h.cleanup);
  h.messages.get('settings')({ normalization: 'off', playbackRate: 1.1 });
  await h.speak(h.api, 'Cached text', { surface: 'terminal', sessionId: 'one' });
  assert.equal(h.playback.at(-1).playbackRate, 1.1);
  h.messages.get('settings')({ normalization: 'off', playbackRate: 1.5 });
  await h.speak(h.api, 'Cached text', { surface: 'terminal', sessionId: 'one' });
  assert.equal(h.playback.at(-1).playbackRate, 1.5); assert.equal(h.spoken.length, 1);
  h.messages.get('settings')({ normalization: 'off', playbackRate: 99 });
  await h.speak(h.api, 'New text', { surface: 'terminal', sessionId: 'one' });
  assert.equal(h.playback.at(-1).playbackRate, 1);
});

test('automatic speech cancellation covers awaited focus lookup and in-flight synthesis', async t => {
  const h = await readerHarness(); t.after(h.cleanup);
  let focus;
  h.api.getActiveSession = () => new Promise(resolve => { focus = resolve; });
  const before = h.messages.get('speak')({ source: 'auto', sessionId: 'one', text: 'Before lookup', token: 'before' });
  h.messages.get('speak-cancel')({ token: 'before' });
  focus({ id: 'one', readAloud: true }); await before;
  assert.equal(h.playback.length, 0);
  let finish;
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  h.setEngineForTest({ styles: new Map([['female-2', {}]]), helper: { chunkTextRanges, writeWavFile: () => new ArrayBuffer(16) },
    textToSpeech: { sampleRate: 100, call: () => new Promise(resolve => { finish = resolve; }) } });
  h.api.getActiveSession = async () => ({ id: 'one', readAloud: true });
  const during = h.messages.get('speak')({ source: 'auto', sessionId: 'one', text: 'During synthesis', token: 'during' });
  for (let i = 0; i < 30 && !finish; i++) await new Promise(setImmediate);
  assert.equal(typeof finish, 'function');
  h.messages.get('speak-cancel')({ token: 'during' });
  finish({ wav: new Float32Array(100), duration: [1] }); await during;
  assert.equal(h.playback.length, 0); assert.equal(h.toasts.length, 0);
});

test('an automatic reply cannot cancel manual speech being prepared', async t => {
  const h = await readerHarness(); t.after(h.cleanup);
  let finish;
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  h.setEngineForTest({ styles: new Map([['female-2', {}]]), helper: { chunkTextRanges, writeWavFile: () => new ArrayBuffer(16) },
    textToSpeech: { sampleRate: 100, call: () => new Promise(resolve => { finish = resolve; }) } });
  const manual = h.speak(h.api, 'Manual selection', { surface: 'terminal', sessionId: 'one' });
  for (let i = 0; i < 30 && !finish; i++) await new Promise(setImmediate);
  h.api.getActiveSession = async () => ({ id: 'one', readAloud: true });
  await h.messages.get('speak')({ source: 'auto', sessionId: 'one', text: 'Automatic', token: 'auto' });
  assert.equal(h.stops(), 0);
  finish({ wav: new Float32Array(100), duration: [1] }); await manual;
  assert.equal(h.playback[0].readAlong.sourceText, 'Manual selection');
  assert.equal(h.playback[0].autoToken, undefined);
});

test('headings and paragraphs never splice silence into either female voice waveform', async () => {
  const { synthesize } = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  for (const voice of ['female-1', 'female-2']) {
    const source = '# Reading clearly\n\nEvery word should remain uninterrupted.\n\nThe next paragraph continues.';
    const style = JSON.parse(readFileSync(resolve(root, `public/voices/${voice}.json`), 'utf8'));
    const raw = Float32Array.from({ length: 4200 }, (_, i) => 0.2 * Math.sin(i * 0.13));
    const original = raw.slice();
    let calls = 0;
    const result = await synthesize({
      helper: { chunkTextRanges },
      textToSpeech: { sampleRate: 1000, call: async (_text, _lang, passedStyle) => {
        calls++;
        assert.equal(passedStyle, style);
        return { wav: raw, duration: [4] };
      } },
    }, source, { voice, normalization: 'off', language: 'na', quality: 9 }, style);
    assert.equal(calls, 1, 'headings do not create extra inference jobs');
    assert.deepEqual(result.audio, raw.slice(0, 4000), `${voice}: preserve every model sample within its duration`);
    assert.deepEqual(raw, original, 'model output is not mutated');
    assert.equal(result.cues[0].start, 0);
    assert.equal(result.cues.at(-1).end, 4, 'highlighting ends with the unmodified audio');
  }
});

test('multiple generated chunks retain only the existing 300 ms gaps and aligned cues', async () => {
  const { synthesize } = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  const source = 'A sentence with words to read. '.repeat(24);
  const chunks = chunkTextRanges(source, 300);
  assert.ok(chunks.length > 1);
  let calls = 0;
  const limits = [];
  const result = await synthesize({
    helper: { chunkTextRanges },
    textToSpeech: { sampleRate: 1000, call: async (...args) => {
      limits.push(args[7]);
      return { wav: new Float32Array(1000).fill(++calls / 10), duration: [1] };
    } },
  }, source, { normalization: 'off', language: 'na', quality: 9 }, {});
  assert.equal(calls, chunks.length);
  assert.equal(result.audio.length, calls * 1000 + (calls - 1) * 300);
  for (let index = 0; index < calls; index++) {
    const offset = index * 1300;
    assert.deepEqual(result.audio.slice(offset, offset + 1000), new Float32Array(1000).fill((index + 1) / 10));
    if (index) assert.ok(result.audio.slice(offset - 300, offset).every(sample => sample === 0));
    const firstCue = result.cues.find(cue => cue.textStart >= chunks[index].start);
    assert.equal(firstCue.start, offset / 1000);
    assert.equal(limits[index], limits[0] - offset, 'sample budget includes prior audio and the next gap');
  }
  assert.equal(result.cues.at(-1).end, result.audio.length / 1000);
});

test('every bundled lexicon replacement retains valid source spans, including inserted letters', async () => {
  const { normalizeText, normalizeTextWithRanges, estimateReadAlongCues, entries } = await modules();
  for (const entry of entries) {
    const source = `Before ${entry.input} after 365.`;
    const mapped = normalizeTextWithRanges(source, entries);
    assert.equal(mapped.text, normalizeText(source, entries), entry.input);
    assert.equal(mapped.text.length, mapped.ranges.length, entry.input);
    assert.ok(mapped.ranges.every(range => range.start >= 0 && range.end > range.start
      && range.end <= source.length), entry.input);
    assert.ok(estimateReadAlongCues(source, mapped, 0, 5).every(cue => Number.isFinite(cue.start)
      && cue.end > cue.start), entry.input);
  }
});

test('estimated window advances one original word and spends longer on expanded numbers', async () => {
  const { normalizeTextWithRanges, estimateReadAlongCues, entries } = await modules();
  const source = 'Item 3 is now your live question about the copy icon';
  const cues = estimateReadAlongCues(source, normalizeTextWithRanges(source, entries), 2, 12);
  assert.deepEqual(cues.slice(0, 4).map(cue => source.slice(cue.textStart, cue.textEnd)),
    ['Item 3 is', '3 is now', 'is now your', 'now your live']);
  assert.equal(cues[0].start, 2);
  assert.equal(cues.at(-1).end, 12);
  assert.equal(source.slice(cues.at(-1).textStart, cues.at(-1).textEnd), 'icon');
  for (let i = 1; i < cues.length; i++) assert.equal(cues[i].start, cues[i - 1].end);
  const longer = source.replace('3', '365');
  const expanded = estimateReadAlongCues(longer, normalizeTextWithRanges(longer, entries), 2, 12);
  assert.ok(expanded[1].end - expanded[1].start > 3 * (cues[1].end - cues[1].start));
  assert.equal(longer.slice(expanded[1].textStart, expanded[1].textEnd), '365 is now');
});

test('URL weight follows its spoken replacement, not the length of the displayed address', async () => {
  const { normalizeTextWithRanges, estimateReadAlongCues, entries } = await modules();
  const sources = ['Read https://example.com/a now.', `Read https://example.com/${'long-path/'.repeat(40)} now.`];
  const timelines = sources.map(source => estimateReadAlongCues(source,
    normalizeTextWithRanges(source, entries), 0, 8));
  assert.deepEqual(timelines[0].map(c => [c.start, c.end]), timelines[1].map(c => [c.start, c.end]));
});

test('timing retains source offsets, punctuation pauses, operators and languages without spaces', async () => {
  const { normalizeTextWithRanges, estimateReadAlongCues, sourceWords, entries } = await modules();
  const source = 'First.  Second!\nThird API >= 365';
  const cues = estimateReadAlongCues(source, normalizeTextWithRanges(source, entries), 20, 30, 50);
  assert.equal(cues[0].textStart, 50);
  assert.equal(cues[1].textStart, 58);
  assert.equal(cues.at(-1).textEnd, 50 + source.length);
  assert.ok(cues.some(c => source.slice(c.textStart - 50, c.textEnd - 50) === '>= 365'));
  for (const [text, language] of [['今日は良い天気です', 'ja'], ['你好世界今天很好', 'zh']]) {
    assert.ok(sourceWords(text, language).length > 1);
    const timeline = estimateReadAlongCues(text, normalizeTextWithRanges(text, [], 'off'), 0, 5, 0, language);
    assert.ok(timeline.every(c => c.end > c.start && c.textEnd <= text.length));
    assert.equal(timeline.at(-1).end, 5);
  }
});

test('synthesis emits normalized estimated windows anchored to generated sample boundaries', async (t) => {
  const { synthesize } = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => lexiconSource });
  t.after(() => { global.fetch = previousFetch; });
  const spoken = [];
  const engine = {
    helper: { chunkTextRanges },
    textToSpeech: { sampleRate: 100, call: async text => {
      spoken.push(text);
      const seconds = spoken.length === 1 ? 4 : 2;
      return { wav: new Float32Array(seconds * 100), duration: [seconds] };
    } },
  };
  const text = 'Item 365 is ready.  It works!\n\nNext reply here.';
  const result = await synthesize(engine, text, { language: 'en', normalization: 'english', quality: 9 }, {});
  assert.deepEqual(spoken, ['Item three hundred sixty five is ready.  It works!\n\nNext reply here.']);
  assert.equal(result.audio.length, 400); // One inference, preserved without guessed silence.
  assert.equal(result.cues[0].start, 0);
  const next = result.cues.findIndex(c => c.textStart === text.indexOf('Next'));
  assert.ok(next > 0 && result.cues[next].start > 0);
  assert.equal(result.cues.at(-1).end, 4);
  assert.equal(text.slice(result.cues[1].textStart, result.cues[1].textEnd), '365 is ready.');
});

test('selection anchors survive synthesis and identical text elsewhere reuses audio at the new occurrence', async () => {
  const { activate, setEngineForTest } = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  let inferences = 0, toggles = 0, shortcut;
  let snapshot = { text: 'Item 365 is ready', sessionId: 'one', anchor: 'first-occurrence' };
  const messages = new Map(), actions = [], playback = [];
  setEngineForTest({
    styles: new Map([['female-2', {}]]),
    helper: { chunkTextRanges, writeWavFile: () => new ArrayBuffer(16) },
    textToSpeech: { sampleRate: 100, call: async () => {
      inferences++;
      return { wav: new Float32Array(400), duration: [4] };
    } },
  });
  const cleanup = await activate({
    onMessage: (name, handler) => { messages.set(name, handler); return () => {}; },
    registerAction: action => { actions.push(action); return () => {}; },
    registerHotkey: (_key, handler) => { shortcut = handler; return () => {}; },
    getActiveViewerText: async () => null,
    getTerminalSelectionSnapshot: async () => snapshot,
    getTerminalSelection: async () => { throw new Error('Snapshot must be used atomically'); },
    getActiveSession: async () => ({ id: 'one' }),
    playAudio: (_wav, options) => playback.push(options),
    toggleAudio: async () => { toggles++; return true; },
    send: () => {}, toast: () => {}, stopAudio: () => {},
  });
  messages.get('settings')({ shortcut: 'F5', normalization: 'off' });
  await shortcut();
  assert.equal(playback[0].readAlong.anchor, 'first-occurrence');
  assert.equal(playback[0].readAlong.timing, 'estimated');
  await shortcut();
  assert.equal(toggles, 1);
  assert.equal(playback.length, 1);
  snapshot = { ...snapshot, anchor: 'second-occurrence' };
  await shortcut();
  assert.equal(inferences, 1);
  assert.equal(playback[1].readAlong.anchor, 'second-occurrence');
  await actions.find(action => action.id === 'read-selection').run({
    surface: 'terminal', session: { id: 'one' },
    selection: { text: snapshot.text, anchor: 'context-occurrence' },
  });
  assert.equal(playback[2].readAlong.anchor, 'context-occurrence');
  cleanup();
});

test('F5 still reads and toggles when a newer worker asks an older host for selection anchors', async () => {
  const { activate, setEngineForTest } = await clientForTest();
  const { chunkTextRanges } = await import('../plugins/supertonic/public/text-chunks.js');
  let shortcut, inferences = 0, selections = 0, toggles = 0;
  const messages = new Map(), playback = [];
  setEngineForTest({
    styles: new Map([['female-2', {}]]),
    helper: { chunkTextRanges, writeWavFile: () => new ArrayBuffer(16) },
    textToSpeech: { sampleRate: 100, call: async () => {
      inferences++;
      return { wav: new Float32Array(200), duration: [2] };
    } },
  });
  const api = {
    onMessage: (name, handler) => { messages.set(name, handler); return () => {}; },
    registerAction: () => () => {},
    registerHotkey: (_key, handler) => { shortcut = handler; return () => {}; },
    getActiveViewerText: async () => null,
    getTerminalSelectionSnapshot: async () => { throw new Error('Unknown host request.'); },
    getTerminalSelection: async () => { selections++; return 'Read this selection'; },
    getActiveSession: async () => ({ id: 'one' }),
    playAudio: (_wav, options) => playback.push(options),
    toggleAudio: async () => { toggles++; return true; },
    send: () => {}, toast: () => {}, stopAudio: () => {},
  };
  const cleanup = await activate(api);
  messages.get('settings')({ shortcut: 'F5', normalization: 'off' });
  await assert.doesNotReject(() => shortcut());
  assert.equal(selections, 1);
  assert.equal(playback[0].readAlong.sourceText, 'Read this selection');
  assert.equal(playback[0].readAlong.sessionId, 'one');
  assert.equal(playback[0].readAlong.anchor, undefined);
  await assert.doesNotReject(() => shortcut());
  assert.equal(toggles, 1);
  delete api.getTerminalSelectionSnapshot; // An older worker also remains supported.
  await assert.doesNotReject(() => shortcut());
  assert.equal(toggles, 2);
  assert.equal(inferences, 1);
  cleanup();
});

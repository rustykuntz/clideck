// Isolate the data dir before anything resolves ~/.clideck (paths.js mkdirs at require time).
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
process.env.HOME = mkdtempSync(join(tmpdir(), 'clideck-transcript-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const transcript = require('../transcript');

// flush() runs on a 300ms debounce after the last chunk.
const afterFlush = () => new Promise(r => setTimeout(r, 450));

test('a short agent reply is captured', async () => {
  transcript.init(() => {}, new Set(), null);
  transcript.trackOutput('sess-ok', 'ok\n');
  await afterFlush();
  assert.match(transcript.getCache()['sess-ok'] || '', /ok/,
    'a two-character reply like "ok" must reach the transcript, or `clideck ask` returns nothing');
});

test('a longer reply is still captured', async () => {
  transcript.trackOutput('sess-long', 'here is a full sentence\n');
  await afterFlush();
  assert.match(transcript.getCache()['sess-long'] || '', /full sentence/);
});

test('single-character terminal noise is still dropped', async () => {
  transcript.trackOutput('sess-noise', 'x\n>\n');
  await afterFlush();
  assert.equal(transcript.getCache()['sess-noise'], undefined,
    'lines of one character remain filtered as terminal noise');
});

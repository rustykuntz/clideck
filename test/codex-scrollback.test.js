const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');

const helper = import('../public/js/terminal-scrollback.js');
const write = (term, text) => new Promise((resolve) => term.write(text, resolve));
const lines = (term) => Array.from({ length: term.buffer.active.length }, (_, i) =>
  term.buffer.active.getLine(i).translateToString(true));
const visible = (term) => lines(term).slice(term.buffer.active.baseY);
const cursor = (term) => [term.buffer.active.cursorX, term.buffer.active.cursorY];
const reply = Array.from({ length: 26 }, (_, i) => `\x1b[${i + 1};1HANSWER-${String(i + 1).padStart(2, '0')}`).join('');
// Control sequence observed in a real Codex stream as its input area grew. The
// words are synthetic; no private conversation is needed to reproduce the loss.
const growInput = '\x1b[1;26r\x1b[10S\x1b[r\x1b[17;1H\x1b[J\x1b[17;1HINPUT GROWS';

async function terminal(t, options = {}, fixed = true) {
  const term = new Terminal({ cols: 132, rows: 33, scrollback: 1000, allowProposedApi: true, ...options });
  if (fixed) (await helper).installScrollbackPreservation(term);
  t.after(() => term.dispose());
  return term;
}

test('Codex growing input preserves every reply line while leaving the screen and cursor unchanged', async (t) => {
  const stock = await terminal(t, {}, false), fixed = await terminal(t);
  for (const term of [stock, fixed]) {
    await write(term, reply + '\x1b[27;1HINPUT');
    await write(term, growInput);
  }
  // The unfixed library displays the same current screen but throws away rows 1–10.
  assert.deepEqual(visible(fixed), visible(stock));
  assert.deepEqual(cursor(fixed), cursor(stock));
  assert.equal(lines(stock).filter((s) => s.startsWith('ANSWER-')).length, 16);
  assert.equal(lines(fixed).filter((s) => s.startsWith('ANSWER-')).length, 26);
  assert.equal(fixed.buffer.active.baseY, 10);
  assert.deepEqual(lines(fixed).slice(0, 10), Array.from({ length: 10 }, (_, i) => `ANSWER-${String(i + 1).padStart(2, '0')}`));
});

test('chunked output and reset/replay retain the same reply without duplicating it', async (t) => {
  const term = await terminal(t);
  const data = reply + growInput;
  for (const chunk of [data.slice(0, reply.length + 3), data.slice(reply.length + 3, reply.length + 10), data.slice(reply.length + 10)]) await write(term, chunk);
  const first = lines(term);
  term.reset();
  await write(term, data);
  assert.deepEqual(lines(term), first);
  for (let i = 1; i <= 26; i++) assert.equal(lines(term).filter((s) => s === `ANSWER-${String(i).padStart(2, '0')}`).length, 1);
});

test('scrolling preserves markers, a scrolled-up viewport, cursor and rows below the region', async (t) => {
  const term = await terminal(t);
  await write(term, Array.from({ length: 70 }, (_, i) => `HISTORY-${i}\r\n`).join(''));
  await write(term, reply + '\x1b[30;1HCOMPOSER\x1b[4;8H');
  const marker = term.registerMarker(0), originalMarker = marker.line;
  term.scrollToLine(5);
  const viewport = term.buffer.active.viewportY;
  const topLine = term.buffer.active.getLine(viewport).translateToString(true);
  const below = visible(term).slice(26), position = cursor(term), base = term.buffer.active.baseY;
  await write(term, '\x1b[1;26r\x1b[4;8H\x1b[10S');
  assert.equal(term.buffer.active.baseY, base + 10);
  assert.equal(term.buffer.active.viewportY, viewport);
  assert.equal(term.buffer.active.getLine(viewport).translateToString(true), topLine);
  assert.equal(marker.isDisposed, false);
  assert.equal(marker.line, originalMarker);
  assert.deepEqual(visible(term).slice(26), below);
  assert.deepEqual(cursor(term), position);
});

test('alternate buffers and scroll regions below the top retain stock terminal behavior', async (t) => {
  for (const alternate of [false, true]) {
    const stock = await terminal(t, {}, false), fixed = await terminal(t);
    const data = (alternate ? '\x1b[?1049h' : '') + reply
      + (alternate ? '\x1b[1;26r' : '\x1b[4;26r') + '\x1b[12;8H\x1b[10S';
    for (const term of [stock, fixed]) await write(term, data);
    assert.deepEqual(lines(fixed), lines(stock));
    assert.deepEqual(cursor(fixed), cursor(stock));
    assert.equal(fixed.buffer.active.baseY, 0);
  }
});

test('saved cursor in the input area stays at its screen position after scrolling, including a full history buffer', async (t) => {
  for (const scrollback of [5, 1000]) {
    for (const [save, restore] of [['\x1b7', '\x1b8'], ['\x1b[s', '\x1b[u']]) {
      const stock = await terminal(t, { scrollback }, false), fixed = await terminal(t, { scrollback });
      const data = reply + '\x1b[30;8H' + save + '\x1b[1;26r\x1b[10S\x1b[r' + restore + 'TYPED';
      for (const term of [stock, fixed]) await write(term, data);
      assert.deepEqual(cursor(fixed), cursor(stock));
      assert.deepEqual(visible(fixed), visible(stock));
      assert.equal(visible(fixed)[29].includes('TYPED'), true);
    }
  }
});

test('scroll-up keeps erase colors, defaults counts, bounds large counts and respects the history limit', async (t) => {
  const term = await terminal(t, { scrollback: 5 });
  await write(term, reply + '\x1b[1;26r\x1b[41m\x1b[S');
  assert.equal(term.buffer.active.baseY, 1);
  assert.equal(term.buffer.active.getLine(term.buffer.active.baseY + 25).getCell(0).getBgColor(), 1);
  await write(term, '\x1b[0S');
  assert.equal(term.buffer.active.baseY, 2);
  await write(term, '\x1b[2147483647S');
  assert.equal(term.buffer.active.baseY, 5);
  assert.equal(term.buffer.active.length, 38);
  assert.equal(visible(term).slice(0, 26).every((s) => s === ''), true);
});

test('an explicit scrollback clear still clears history', async (t) => {
  const term = await terminal(t);
  await write(term, reply + growInput);
  assert.equal(term.buffer.active.baseY, 10);
  await write(term, '\x1b[3J');
  assert.equal(term.buffer.active.baseY, 0);
});

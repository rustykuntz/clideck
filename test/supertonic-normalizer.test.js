const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const { resolve } = require('path');

const MODULE = '../plugins/supertonic/public/tts-normalizer.js';
const CHUNKS = '../plugins/supertonic/public/text-chunks.js';
const LEXICON = resolve(__dirname, '../plugins/supertonic/public/tts_normalization_lexicon.txt');

test('Supertonic lexicon normalizes technical English in one boundary-aware pass', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.ok(entries.length > 450);
  assert.equal(
    normalizeText('a) GPU >= 2 GB; b) AI != AGI; z) 50%.', entries),
    'A G P U greater than or equal to two gigabytes; B A I does not equal A G I; Z fifty percent.',
  );
  assert.equal(normalizeText('x->y, x>=2, and x>1', entries), 'x to y, x greater than or equal to two, and x greater than one');
  assert.equal(normalizeText('SAIL uses an AI API at example.com', entries), 'SAIL uses an A I A P I at example dot com');
  assert.equal(normalizeText('“READY”—e.g. HTML…', entries), '"ready"-for example H T M L...');
});

test('Supertonic programmatically speaks numbers, money, dates, and time', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(
    normalizeText('333; 5,543; $5643; $5,543; $12.50; $0.05.', entries),
    'three hundred thirty three; five thousand five hundred forty three; five thousand six hundred forty three dollars; five thousand five hundred forty three dollars; twelve dollars and fifty cents; five cents.',
  );
  assert.equal(
    normalizeText('2026-08-26, 08/26/2026, and 26/08/2026 at 9:05 PM.', entries),
    'August twenty sixth, twenty twenty six, August twenty sixth, twenty twenty six, and August twenty sixth, twenty twenty six at nine oh five P M.',
  );
  assert.equal(
    normalizeText('3.1415, 42nd, €1.01, £2.50, and ¥500.', entries),
    'three point one four one five, forty second, one euro and one cent, two pounds and fifty pence, and five hundred yen.',
  );
  assert.equal(normalizeText('(0.09–0.30)', entries), '(zero point zero nine-zero point thirty)');
  assert.equal(
    normalizeText('Retry every 10s, wait 250ms, then stop after 1.5h or 2 days.', entries),
    'Retry every ten seconds, wait two hundred fifty milliseconds, then stop after one point five hours or two days.',
  );
  assert.equal(
    normalizeText('$897k; €1.5m; £2b; ¥3.2t; ₽5k; ₹1.25m; ₩4b; ₪2k; ฿3m.', entries),
    'eight hundred ninety seven thousand dollars; one point five million euros; two billion pounds; three point two trillion yen; five thousand rubles; one point two five million rupees; four billion won; two thousand shekels; three million baht.',
  );
  assert.equal(
    normalizeText('₽1.01; ₹2.50; ₩500; ₪1.01; ฿2.50.', entries),
    'one ruble and one kopek; two rupees and fifty paise; five hundred won; one shekel and one agora; two baht and fifty satang.',
  );
  assert.equal(
    normalizeText('since 08-26, from 1/99, and since 2025-12; but during 08-26.', entries),
    'since August twenty twenty six, from January nineteen ninety nine, and since December twenty twenty five; but during 08-26.',
  );
});

test('Supertonic speaks attached and spaced time shortcuts with decimal values', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const space of ['', ' ', '\u00a0']) {
    const source = `measured 4.2${space}s edit it took 0.61${space}s.`;
    const expected = 'measured four point two seconds edit it took zero point six one seconds.';
    assert.equal(normalizeText(source, entries), expected);
    const mapped = normalizeTextWithRanges(source, entries);
    assert.equal(mapped.text, expected);
    assert.equal(mapped.ranges.length, expected.length);
    const at = mapped.text.indexOf('four');
    const spans = mapped.ranges.slice(at, at + 'four point two seconds'.length);
    const start = source.indexOf('4.2'), end = start + `4.2${space}s`.length;
    assert.ok(spans.every(range => range.start >= start && range.end <= end && range.start < range.end));
    assert.equal(Math.min(...spans.map(range => range.start)), start);
    assert.equal(Math.max(...spans.map(range => range.end)), end);
    assert.equal(normalizeText(source, entries, 'off'), source);
  }
  assert.equal(normalizeText('1 s; 250 ms; 2 m; 1.5 h; 2 d; 3 w.', entries),
    'one second; two hundred fifty milliseconds; two minutes; one point five hours; two days; three weeks.');
  assert.equal(normalizeText('4.2 speed', entries), 'four point two speed');
});

test('Supertonic keeps terminal wrapping out of technical normalization', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(
    normalizeText('Record id 42\nThen fetch ids.\n\nDone!', entries),
    'Record I D forty two\nThen fetch I Ds.\n\nDone!',
  );
});

test('Supertonic speaks named dates in either order with ordinals, abbreviations, and years', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const source of ['11 Oct', '11 october', 'october 11', 'oct 11', 'Oct. 11', '11th of OCTOBER', 'october\u00a011']) {
    assert.equal(normalizeText(source, entries), 'October eleventh', source);
  }
  for (const [source, expected] of [
    ['We meet on Sept. 22, 2026.', 'We meet on September twenty second, twenty twenty six.'],
    ['11 October 2026', 'October eleventh, twenty twenty six'],
    ['January 01,2001', 'January first, two thousand one'],
    ['29 Feb 2024', 'February twenty ninth, twenty twenty four'],
    ['Feb 29', 'February twenty ninth'],
    ['Dec 31, 1999', 'December thirty first, nineteen ninety nine'],
    ['Meet on 11 Oct. Next, lunch.', 'Meet on October eleventh. Next, lunch.'],
  ]) assert.equal(normalizeText(source, entries), expected, source);
  for (const [index, month] of ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].entries()) {
    for (const name of [month, month.slice(0, 3), month.slice(0, 3).toUpperCase() + '.']) {
      assert.equal(normalizeText(`${name} 1`, entries), `${month} first`, `${index + 1}: ${name}`);
    }
  }
});

test('Supertonic reads date ranges with both months or one shared month', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [source, expected] of [
    ['Sep 22–Nov 6', 'September twenty second to November sixth'],
    ['22 September - 6 November', 'September twenty second to November sixth'],
    ['Sep. 22—6 Nov.', 'September twenty second to November sixth.'],
    ['11–13 Oct', 'October eleventh to October thirteenth'],
    ['Oct 11-13', 'October eleventh to October thirteenth'],
    ['October 11th through 13th, 2026', 'October eleventh to October thirteenth, twenty twenty six'],
    ['11 to 13 October 2026', 'October eleventh to October thirteenth, twenty twenty six'],
    ['Dec 30, 2026–Jan 2, 2027', 'December thirtieth, twenty twenty six to January second, twenty twenty seven'],
    ['Feb 29–Jan 1, 2025', 'February twenty ninth to January first, twenty twenty five'],
    ['Feb 28–29, 2024', 'February twenty eighth to February twenty ninth, twenty twenty four'],
  ]) assert.equal(normalizeText(source, entries), expected, source);
});

test('named dates do not invent calendar dates from invalid dates, identifiers, or separate lines', async () => {
  const { normalizeEnglishPatterns, normalizeText } = await import(MODULE);
  for (const source of ['Feb 30', '31 April', 'Feb 29, 2025', 'Feb 28–29, 2025', '29 Feb–1 Mar, 2025', 'Oct 00', 'May 2026']) {
    assert.doesNotMatch(normalizeEnglishPatterns(source), /first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirtieth/, source);
  }
  for (const source of ['build_Oct 11x', 'x11 Oct', 'Oct 11.txt', '/11 Oct/path', 'Oct\n11', '11\nOct']) {
    assert.doesNotMatch(normalizeEnglishPatterns(source), /October|eleventh/, source);
  }
  assert.equal(normalizeEnglishPatterns('11\n\nOctober'), 'eleven\n\nOctober');
  const source = 'Sep 22–Nov 6; 11 October 2026';
  assert.equal(normalizeText(source, [], 'off'), source);
  assert.equal(normalizeText(source, [], 'french'), source);
});

test('spoken dates and ranges keep read-along spans inside their original text', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const date of ['Sep 22–Nov 6', '11 Oct', '11–13 Oct 2026', 'Oct 11-13', 'Dec 30, 2026–Jan 2, 2027']) {
    const source = `Before ${date}; after.`;
    const mapped = normalizeTextWithRanges(source, entries);
    const spoken = normalizeText(date, entries);
    assert.equal(mapped.text, `Before ${spoken}; after.`);
    assert.equal(mapped.ranges.length, mapped.text.length);
    const dateRanges = mapped.ranges.slice(7, 7 + spoken.length);
    assert.ok(dateRanges.every(range => range.start >= 7 && range.end <= 7 + date.length && range.start < range.end));
    assert.equal(Math.min(...dateRanges.map(range => range.start)), 7);
    assert.equal(Math.max(...dateRanges.map(range => range.end)), 7 + date.length);
    assert.equal(mapped.ranges.at(-1).end, source.length);
  }
});

test('signed money and numbers keep their sign without changing ranges or hyphenated text', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon, normalizeEnglishPatterns } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  const source = 'rule went from -$1.30M to +$0.11M.';
  const expected = 'rule went from minus one point three million dollars to plus zero point one one million dollars.';
  assert.equal(normalizeText(source, entries), expected);
  for (const [text, spoken] of [
    ['−$1.30M', 'minus one point three million dollars'],
    ['$-1.30M', 'minus one point three million dollars'],
    ['-$12.50', 'minus twelve dollars and fifty cents'],
    ['-€2k', 'minus two thousand euros'],
    ['+$0.00', 'plus zero dollars'],
    ['-3.5%', 'minus three point five percent'],
    ['(-2), +5, −0.25', '(minus two), plus five, minus zero point two five'],
  ]) assert.equal(normalizeText(text, entries), spoken, text);
  for (const text of ['1-3', '2026-10-30', 'state-of-the-art', 'x-2', '$1-$2', '$5 - $10', '- $20 per month']) {
    assert.doesNotMatch(normalizeEnglishPatterns(text), /minus/, text);
  }
  assert.equal(normalizeEnglishPatterns('-$5 - $6'), 'minus five dollars - six dollars');
  assert.equal(normalizeText(source, entries, 'off'), source);
  const mapped = normalizeTextWithRanges(source, entries);
  assert.equal(mapped.text, expected); assert.equal(mapped.ranges.length, expected.length);
  for (const range of mapped.ranges) assert(range.start >= 0 && range.end > range.start && range.end <= source.length);
  const at = mapped.text.indexOf('minus');
  assert(mapped.ranges.slice(at, at + 5).every(range => source.slice(range.start, range.end).includes('-')));
});

test('earnings cues expand attached K/M amounts and preserve the signs across a list', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [source, expected] of [
    ['made +1.82M, +0.41M and −0.42M ', 'made plus one point eight two million, plus zero point four one million and minus zero point four two million '],
    ['We make 0.41K and -0.42K.', 'We make zero point four one thousand and minus zero point four two thousand.'],
    ['MADE 1.00M,0.10K, and +2K', 'MADE one million,zero point one thousand, and plus two thousand'],
    ['She makes 1M or 2M.', 'She makes one million or two million.'],
    ['Making 1M & 0.5K', 'Making one million and zero point five thousand'],
    ['made +$1.82M, +0.41M and -€0.42M', 'made plus one point eight two million dollars, plus zero point four one million and minus zero point four two million euros'],
  ]) assert.equal(normalizeText(source, entries), expected, source);
});

test('earnings context does not reinterpret measurements, file names, or later unrelated amounts', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const source of [
    '+1.82M, 0.41K', 'made 1.82 m of rope', 'make 0.41 K', 'made 1.82m', 'make 0.41k',
    'made a 1.82M pole', 'remade 1M', 'hand-made 1M', 'made 0.41KB and 1.82MB',
    'made 1.82M.csv', 'made 1.82M/s', 'made +-1M', 'made\n1M',
  ]) assert.doesNotMatch(normalizeText(source, entries), /million|thousand/, source);
  for (const source of [
    'made 1M. Size is 0.41M', 'made 1M; 0.41K', 'made 1M\nand 0.41M',
    'made 1M, measured 0.41M and 0.42K', 'made 1M, 2m and 0.41M',
  ]) {
    const spoken = normalizeText(source, entries);
    assert.equal((spoken.match(/million|thousand/g) || []).length, 1, source);
    assert.match(spoken, /0\.41[KM]/, source);
  }
  assert.equal(normalizeText('made one item; then make 0.41K', entries), 'made one item; then make zero point four one thousand');
  const source = 'made +1.82M, +0.41M and −0.42M; make 0.41K';
  for (const language of ['off', 'french']) assert.equal(normalizeText(source, entries, language), source);
});

test('each expanded earnings amount keeps its own read-along source span', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  const source = 'We made +1.82M, +0.41M and −0.42M; we make 0.41K.';
  const mapped = normalizeTextWithRanges(source, entries);
  assert.equal(mapped.text, normalizeText(source, entries));
  assert.equal(mapped.ranges.length, mapped.text.length);
  for (const [amount, words] of [
    ['+1.82M', 'plus one point eight two million'], ['+0.41M', 'plus zero point four one million'],
    ['−0.42M', 'minus zero point four two million'], ['0.41K', 'zero point four one thousand'],
  ]) {
    const start = source.indexOf(amount), at = mapped.text.indexOf(words);
    assert(at >= 0);
    assert.ok(mapped.ranges.slice(at, at + words.length).every(range => range.start === start && range.end === start + amount.length), amount);
  }
  const and = mapped.text.indexOf('and');
  assert.equal(mapped.ranges[and].start, source.indexOf('and'));
});

test('Supertonic speaks version components as whole numbers separated by point', async () => {
  const { normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [source, expected] of [
    ['1.11.0', 'one point eleven point zero'],
    ['Update to 1.11.0.', 'Update to one point eleven point zero.'],
    ['v2.0.1 and V10.20.300', 'version two point zero point one and version ten point twenty point three hundred'],
    ['v1.11', 'version one point eleven'],
    ['1.11.0-beta', 'one point eleven point zero-beta'],
    ['1.02.0', 'one point zero two point zero'],
  ]) {
    assert.equal(normalizeText(source, entries), expected);
    const mapped = normalizeTextWithRanges(source, entries);
    assert.equal(mapped.text, expected);
    assert.equal(mapped.ranges.length, expected.length);
    assert.ok(mapped.ranges.every(range => range.start >= 0 && range.end <= source.length && range.start < range.end));
  }
  const mapped = normalizeTextWithRanges('1.11.0', entries);
  assert.ok(mapped.ranges.every(range => range.start === 0 && range.end === 6));
  assert.equal(normalizeText('1.11.0', entries, 'off'), '1.11.0');
});

test('Supertonic number parsing leaves addresses, identifiers, and invalid dates intact', async () => {
  const { normalizeEnglishPatterns } = await import(MODULE);
  assert.equal(
    normalizeEnglishPatterns('127.0.0.1 abc333 2026-02-30 13/13/2026 2026-08-26T12:34:56Z $1.234'),
    '127.0.0.1 abc333 2026-02-30 13/13/2026 2026-08-26T12:34:56Z $1.234',
  );
  const references = '192.168.1.11 abc1.11.0 1.11.0.example /1.11.0/v2.0.1 1.11.0.js';
  assert.equal(normalizeEnglishPatterns(references), references);
  assert.equal(normalizeEnglishPatterns('08-26 from 13-26 from 08-26-30'), '08-26 from 13-26 from 08-26-30');
  assert.equal(normalizeEnglishPatterns('12:34:56'), 'twelve thirty four and fifty six seconds');
});

test('Supertonic replaces strong URLs and file paths without guessing', async () => {
  const { normalizeSpokenReferences, normalizeText, parseLexicon } = await import(MODULE);
  assert.equal(
    normalizeSpokenReferences('Open http://127.0.0.1:4100, then docs/archive/STRATEGY-FINDINGS-entry-explanation-threads-v1.md.'),
    'Open the URL in our conversation, then the document path is in our conversation.',
  );
  assert.equal(
    normalizeSpokenReferences('See https://example.com/docs?q=1 and ./reports/result.pdf:761; or www.example.org/help.'),
    'See the URL in our conversation and the document path is in our conversation; or the URL in our conversation.',
  );
  assert.equal(
    normalizeSpokenReferences('Keep 1/2, 08/26/2026, v2.0.1, and/or, API v1/users, example.com, user@example.com, and http://.'),
    'Keep 1/2, 08/26/2026, v2.0.1, and/or, API v1/users, example.com, user@example.com, and http://.',
  );
  assert.equal(normalizeSpokenReferences('docs/file.md', 'off'), 'docs/file.md');
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  assert.equal(normalizeText('Read docs/file.md', entries), 'Read the document path is in our conversation');
  assert.equal(normalizeText('Keep\nline break', entries, 'off'), 'Keep\nline break');
});

test('Supertonic describes file paths by type and preserves URL precedence and punctuation', async () => {
  const { normalizeSpokenReferences, normalizeText, normalizeTextWithRanges, parseLexicon } = await import(MODULE);
  const entries = parseLexicon(readFileSync(LEXICON, 'utf8'));
  for (const [path, type] of [
    ['docs/CLOSE-20260908-first-day-under-the-screener-v1.md', 'document'],
    ['docs/notes.txt', 'document'], ['docs/draft.doc', 'document'],
    ['docs/final.docx', 'document'], ['./reports/result.PDF:761:2', 'document'],
    ['~/Photos/holiday.jpg', 'photo'], ['/tmp/screenshot.jpeg', 'photo'],
    ['images/צילום.PNG', 'photo'], ['images/animation.webp', 'photo'],
    ['clips/demo.mp4', 'video'], ['clips/demo.MOV', 'video'],
    ['recordings/voice.wav', 'audio'], ['music/song.mp3', 'audio'],
    ['reports/budget.xlsx', 'spreadsheet'], ['reports/data.csv', 'spreadsheet'],
    ['slides/intro.pptx', 'presentation'], ['backups/release.tar.gz', 'archive'],
    ['src/app.js:12', 'code file'], ['config/settings.json', 'data file'],
    ['output/model.gguf', 'file'], ['config/.env', 'file'], ['config/.md', 'file'],
  ]) {
    const expected = `the ${type} path is in our conversation`;
    assert.equal(normalizeSpokenReferences(`See (${path}), then continue.`), `See (${expected}), then continue.`, path);
    assert.equal(normalizeText(path, entries), expected, path);
    const mapped = normalizeTextWithRanges(path, entries);
    assert.equal(mapped.text, expected, path);
    assert.equal(mapped.ranges.length, expected.length, path);
    assert.ok(mapped.ranges.every(range => range.start >= 0 && range.start < range.end && range.end <= path.length), path);
    assert.equal(Math.min(...mapped.ranges.map(range => range.start)), 0, path);
    assert.equal(Math.max(...mapped.ranges.map(range => range.end)), path.length, path);
    assert.equal(normalizeSpokenReferences(path, 'off'), path);
    assert.equal(normalizeSpokenReferences(path, 'french'), path);
  }
  assert.equal(normalizeSpokenReferences('https://example.com/report.pdf and www.example.com/photo.png'),
    'the URL in our conversation and the URL in our conversation');
  const literal = 'example.md user@example.jpg 1/2 08/26/2026 v1/users docs/README';
  assert.equal(normalizeSpokenReferences(literal), literal);
});

test('Supertonic lexicon parser ignores malformed rows and keeps languages isolated', async () => {
  const { normalizeText, parseLexicon } = await import(MODULE);
  const entries = parseLexicon([
    '# comment',
    'API | A P I | english',
    'API | ah pee eye | french',
    'broken row',
  ].join('\n'));
  assert.equal(entries.length, 2);
  assert.equal(normalizeText('API', entries, 'english'), 'A P I');
  assert.equal(normalizeText('API', entries, 'french'), 'ah pee eye');
  assert.equal(normalizeText('API', entries, 'off'), 'API');
});

test('Supertonic coarse chunks retain exact displayed source ranges', async () => {
  const { chunkText, chunkTextRanges } = await import(CHUNKS);
  const source = '  One short.  Two longer sentence!\n\nThird paragraph.  ';
  assert.deepEqual(chunkTextRanges(source, 24), [
    { start: 2, end: 12, text: 'One short.' },
    { start: 14, end: 34, text: 'Two longer sentence!' },
    { start: 36, end: 52, text: 'Third paragraph.' },
  ]);
  assert.deepEqual(chunkText(source, 24), ['One short.', 'Two longer sentence!', 'Third paragraph.']);
  assert.deepEqual(chunkText('First. Second! Third?', 300), ['First. Second! Third?']);
  assert.deepEqual(chunkText('Title\n\nBody text.', 300), ['Title\n\nBody text.']);
  for (const source of ['word '.repeat(3000), 'x'.repeat(8001), '😀'.repeat(1000)]) {
    const chunks = chunkTextRanges(source, 301);
    assert.ok(chunks.every(chunk => chunk.text.length <= 301));
    assert.equal(chunks.map(chunk => chunk.text).join('').replace(/\s/g, ''), source.replace(/\s/g, ''));
    assert.ok(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.text)));
  }
});

const WORD = /[\p{L}\p{N}_]/u;
const SMALL = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion'];
const MONTHS = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_NAME = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember|t)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE_SPACE = '[^\\S\\r\\n]';
const DATE_DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const DATE_YEAR = `(?:(?:${DATE_SPACE}*,${DATE_SPACE}*|${DATE_SPACE}+)\\d{4})?`;
const NAMED_DATE = `(?:${MONTH_NAME}${DATE_SPACE}+${DATE_DAY}|${DATE_DAY}${DATE_SPACE}+(?:of${DATE_SPACE}+)?${MONTH_NAME})${DATE_YEAR}`;
const DATE_RANGE = `${DATE_SPACE}*(?:[-–—]|to\\b|through\\b)${DATE_SPACE}*`;
// Match whole ranges before single dates, including a month shared at either end.
// Horizontal space avoids joining unrelated lines, and boundaries exclude identifiers/paths.
const NAMED_DATES = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\-])(?:(${NAMED_DATE})(?:${DATE_RANGE}(${NAMED_DATE}|${DATE_DAY}${DATE_YEAR}))?|(${DATE_DAY})${DATE_RANGE}(${NAMED_DATE}))(?![\\p{L}\\p{N}_/\\\\]|\\.[\\p{L}\\p{N}_]|-[\\p{L}\\p{N}_])`, 'giu');
const MONTH_TOKEN = new RegExp(MONTH_NAME, 'i');
const ORDINALS = new Map([
  ['one', 'first'], ['two', 'second'], ['three', 'third'], ['four', 'fourth'],
  ['five', 'fifth'], ['six', 'sixth'], ['seven', 'seventh'], ['eight', 'eighth'],
  ['nine', 'ninth'], ['ten', 'tenth'], ['eleven', 'eleventh'], ['twelve', 'twelfth'],
  ['hundred', 'hundredth'], ['thousand', 'thousandth'], ['million', 'millionth'],
  ['billion', 'billionth'], ['trillion', 'trillionth'],
]);
const NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)';
const CURRENCY_SYMBOLS = '$€£¥₽₹₩₪฿';
const CURRENCIES = new Map([
  ['$', { major: ['dollar', 'dollars'], minor: ['cent', 'cents'] }],
  ['€', { major: ['euro', 'euros'], minor: ['cent', 'cents'] }],
  ['£', { major: ['pound', 'pounds'], minor: ['penny', 'pence'] }],
  ['¥', { major: ['yen', 'yen'] }],
  ['₽', { major: ['ruble', 'rubles'], minor: ['kopek', 'kopeks'] }],
  ['₹', { major: ['rupee', 'rupees'], minor: ['paisa', 'paise'] }],
  ['₩', { major: ['won', 'won'] }],
  ['₪', { major: ['shekel', 'shekels'], minor: ['agora', 'agorot'] }],
  ['฿', { major: ['baht', 'baht'], minor: ['satang', 'satang'] }],
]);
const MONEY_SCALES = { k: 'thousand', m: 'million', b: 'billion', t: 'trillion' };
const REFERENCE_PHRASES = {
  english: {
    url: 'the URL in our conversation',
    file: 'the file path is in our conversation',
    document: 'the document path is in our conversation',
    photo: 'the photo path is in our conversation',
    video: 'the video path is in our conversation',
    audio: 'the audio path is in our conversation',
    spreadsheet: 'the spreadsheet path is in our conversation',
    presentation: 'the presentation path is in our conversation',
    archive: 'the archive path is in our conversation',
    code: 'the code file path is in our conversation',
    data: 'the data file path is in our conversation',
  },
};
const FILE_TYPES = new Map(Object.entries({
  document: 'md markdown mdx txt text doc docx pdf rtf odt pages epub tex rst',
  photo: 'jpg jpeg png gif webp avif heic heif bmp tif tiff svg ico raw dng',
  video: 'mp4 mov m4v webm mkv avi wmv flv mpg mpeg ogv 3gp',
  audio: 'mp3 wav m4a aac flac ogg opus aiff aif wma mid midi',
  spreadsheet: 'csv tsv xls xlsx xlsm ods numbers',
  presentation: 'ppt pptx pps ppsx odp key',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst',
  code: 'js jsx ts tsx mjs cjs py rb go rs java c h cpp hpp cs swift kt sh bash zsh html htm css scss sql',
  data: 'json jsonl ndjson yaml yml xml toml ini db sqlite sqlite3 parquet',
}).flatMap(([type, extensions]) => extensions.split(' ').map(extension => [extension, type])));
const URL_TOKEN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
const PATH_TOKEN = /(?<![\p{L}\p{N}_])(?:~\/|\.{1,2}\/|\/)?(?:[^\s<>"'`()\[\]{},;:]+\/)+[^\s<>"'`()\[\]{},;:]+(?::\d+(?::\d+)?)?/gu;

function isWord(character) {
  return Boolean(character && WORD.test(character));
}

function trailingPunctuation(token) {
  const match = String(token).match(/[.,;!?\])}]+$/);
  return match ? [token.slice(0, -match[0].length), match[0]] : [token, ''];
}

function isUrl(value) {
  try {
    const url = new URL(value.startsWith('www.') ? `http://${value}` : value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isFilePath(value) {
  const path = value.replace(/:\d+(?::\d+)?$/, '');
  const name = path.split('/').at(-1) || '';
  // Requiring both a directory component and a file-shaped basename avoids dates, fractions, extensionless routes,
  // prose such as "and/or", version strings, and bare domains. Extensionless paths stay literal by design.
  return path.includes('/')
    && (/^\.[\p{L}\p{N}_-]+$/u.test(name) || /\.[\p{L}][\p{L}\p{N}]{0,15}$/u.test(name));
}

function fileType(value) {
  const name = value.replace(/:\d+(?::\d+)?$/, '').split('/').at(-1);
  // Dotfiles are generic files, even when their name happens to be an extension.
  const extension = name.lastIndexOf('.') > 0 ? name.split('.').at(-1).toLowerCase() : '';
  return FILE_TYPES.get(extension) || 'file';
}

const replaceText = (text, pattern, replacement) => text.replace(pattern, replacement);

export function normalizeSpokenReferences(source, language = 'english', replace = replaceText) {
  const phrases = REFERENCE_PHRASES[String(language).toLowerCase()];
  if (!phrases) return String(source || '');
  let text = replace(String(source || ''), URL_TOKEN, (token) => {
    const [value, trailing] = trailingPunctuation(token);
    return isUrl(value) ? `${phrases.url}${trailing}` : token;
  });
  text = replace(text, PATH_TOKEN, (token) => {
    const [value, trailing] = trailingPunctuation(token);
    return isFilePath(value) ? `${phrases[fileType(value)]}${trailing}` : token;
  });
  return text;
}

function underThousand(value) {
  const words = [];
  if (value >= 100) {
    words.push(SMALL[Math.floor(value / 100)], 'hundred');
    value %= 100;
  }
  if (value >= 20) {
    words.push(TENS[Math.floor(value / 10)]);
    value %= 10;
  }
  if (value) words.push(SMALL[value]);
  return words.join(' ');
}

function digitsSpoken(value) {
  return [...value].map((digit) => SMALL[Number(digit)]).join(' ');
}

function cardinal(value) {
  const digits = String(value).replaceAll(',', '');
  if (!/^\d+$/.test(digits)) return String(value);
  if (digits.length > 1 && digits[0] === '0') return digitsSpoken(digits);
  const trimmed = digits.replace(/^0+/, '') || '0';
  if (trimmed === '0') return SMALL[0];
  if (trimmed.length > SCALES.length * 3) return digitsSpoken(trimmed);
  const groups = [];
  for (let end = trimmed.length, scale = 0; end > 0; end -= 3, scale += 1) {
    const part = Number(trimmed.slice(Math.max(0, end - 3), end));
    if (part) groups.unshift(`${underThousand(part)}${SCALES[scale] ? ` ${SCALES[scale]}` : ''}`);
  }
  return groups.join(' ');
}

function ordinal(value) {
  const words = cardinal(value).split(' ');
  const last = words.at(-1);
  words[words.length - 1] = ORDINALS.get(last)
    || (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.join(' ');
}

function yearWords(value) {
  const year = Number(value);
  if (year >= 2010 && year <= 2099) return `twenty ${cardinal(year - 2000)}`;
  if (year >= 1900 && year <= 1999) {
    const tail = year - 1900;
    return tail ? `nineteen ${cardinal(tail)}` : 'nineteen hundred';
  }
  return cardinal(value);
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function dateWords(year, month, day, original) {
  if (!validDate(year, month, day)) return original;
  return `${MONTHS[month]} ${ordinal(day)}, ${yearWords(year)}`;
}

function namedDateParts(text) {
  const month = text.match(MONTH_TOKEN)?.[0].slice(0, 3).toLowerCase();
  const year = text.match(/\b\d{4}$/);
  return {
    month: month ? MONTHS.findIndex(name => name.toLowerCase().startsWith(month)) : 0,
    day: Number(text.match(/\d+/)[0]),
    year: year ? Number(year[0]) : null,
  };
}

function namedDateWords(original, first, last, firstDay, lastDate) {
  const start = namedDateParts(first || firstDay);
  const end = last || lastDate ? namedDateParts(last || lastDate) : null;
  if (!start.month) start.month = end.month;
  if (end && !end.month) end.month = start.month;
  // With no year, allow February 29. A supplied range year applies to both ends;
  // December–January can cross into the adjacent year without saying an invented year.
  const startYear = start.year ?? (end?.year != null ? end.year - Number(start.month > end.month) : 2000);
  const endYear = end?.year ?? (start.year != null && end ? start.year + Number(end.month < start.month) : 2000);
  if (!validDate(startYear, start.month, start.day)
    || (end && !validDate(endYear, end.month, end.day))) return original;
  const speak = date => `${MONTHS[date.month]} ${ordinal(date.day)}${date.year != null ? `, ${yearWords(date.year)}` : ''}`;
  return speak(start) + (end ? ` to ${speak(end)}` : '') + (original.endsWith('.') ? '.' : '');
}

function monthYearWords(month, year, original) {
  const fullYear = String(year).length === 2
    ? (Number(year) < 70 ? 2000 : 1900) + Number(year)
    : Number(year);
  if (month < 1 || month > 12 || fullYear < 1900 || fullYear > 2099) return original;
  return `${MONTHS[month]} ${yearWords(fullYear)}`;
}

function scaledWords(value, scale) {
  return `${decimalWords(value.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'))} ${MONEY_SCALES[scale.toLowerCase()]}`;
}

function moneyWords(symbol, value, scale = '') {
  const currency = CURRENCIES.get(symbol);
  if (!currency) return `${symbol}${value}${scale}`;
  if (scale) return `${scaledWords(value, scale)} ${currency.major[1]}`;
  const [wholeRaw, fraction = ''] = value.replaceAll(',', '').split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  if (!currency.minor) return `${decimalWords(value)} ${currency.major[Number(value) === 1 ? 0 : 1]}`;
  const cents = fraction ? Number(fraction.padEnd(2, '0')) : 0;
  const parts = [];
  if (whole !== '0' || !cents) parts.push(`${cardinal(whole)} ${currency.major[whole === '1' ? 0 : 1]}`);
  if (cents) parts.push(`${cardinal(cents)} ${currency.minor[cents === 1 ? 0 : 1]}`);
  return parts.join(' and ');
}

const DURATION_UNITS = new Map([
  ['ms', ['millisecond', 'milliseconds']],
  ['msec', ['millisecond', 'milliseconds']],
  ['msecs', ['millisecond', 'milliseconds']],
  ['millisecond', ['millisecond', 'milliseconds']],
  ['milliseconds', ['millisecond', 'milliseconds']],
  ['s', ['second', 'seconds']],
  ['sec', ['second', 'seconds']],
  ['secs', ['second', 'seconds']],
  ['second', ['second', 'seconds']],
  ['seconds', ['second', 'seconds']],
  ['m', ['minute', 'minutes']],
  ['min', ['minute', 'minutes']],
  ['mins', ['minute', 'minutes']],
  ['minute', ['minute', 'minutes']],
  ['minutes', ['minute', 'minutes']],
  ['h', ['hour', 'hours']],
  ['hr', ['hour', 'hours']],
  ['hrs', ['hour', 'hours']],
  ['hour', ['hour', 'hours']],
  ['hours', ['hour', 'hours']],
  ['d', ['day', 'days']],
  ['day', ['day', 'days']],
  ['days', ['day', 'days']],
  ['w', ['week', 'weeks']],
  ['wk', ['week', 'weeks']],
  ['wks', ['week', 'weeks']],
  ['week', ['week', 'weeks']],
  ['weeks', ['week', 'weeks']],
]);

function decimalWords(value) {
  const [whole, fraction] = String(value).replaceAll(',', '').split('.');
  const spokenFraction = /^[1-9]0$/.test(fraction || '') ? cardinal(fraction) : digitsSpoken(fraction || '');
  return fraction ? `${cardinal(whole)} point ${spokenFraction}` : cardinal(whole);
}

function durationWords(value, unit) {
  const forms = DURATION_UNITS.get(unit.toLowerCase());
  if (!forms) return `${value}${unit}`;
  return `${decimalWords(value)} ${Number(String(value).replaceAll(',', '')) === 1 ? forms[0] : forms[1]}`;
}

const signWords = sign => sign === '+' ? 'plus ' : sign ? 'minus ' : '';
function signedMoney(original, before, symbol, after, value, scale = '') {
  if (before && after) return original; // Ambiguous double signs stay literal.
  return signWords(before || after) + moneyWords(symbol, value, scale);
}

export function normalizeEnglishPatterns(source, replace = replaceText) {
  let text = String(source || '');
  text = replace(text, NAMED_DATES, namedDateWords);
  // Bare three-part versions and explicit v-prefixed versions use whole-number
  // components. Keep unlabelled four-part addresses and ordinary decimals intact.
  text = replace(text, /(?<![\p{L}\p{N}_.,:/\\$€£¥₽₹₩₪฿-])(?:(v)(\d+(?:\.\d+)+)|(\d+\.\d+\.\d+))(?![\p{L}\p{N}_]|[.,:/\\]\d|\.[\p{L}_])/giu,
    (_original, prefix, explicit, bare) => `${prefix ? 'version ' : ''}${(explicit || bare).split('.').map(cardinal).join(' point ')}`);
  text = replace(text, /\b(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g,
    (original, year, month, day) => dateWords(Number(year), Number(month), Number(day), original));
  text = replace(text, /\b(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|[12]\d|3[01])\/(\d{4})\b/g,
    (original, first, second, year) => {
      let month = Number(first), day = Number(second);
      if (month > 12 && day <= 12) [month, day] = [day, month];
      return dateWords(Number(year), month, day, original);
    });
  text = replace(text, /\b(since|from)\s+(0?[1-9]|1[0-2])[-/](\d{2}|\d{4})\b(?![-/]\d)/gi,
    (original, cue, month, year) => `${cue} ${monthYearWords(Number(month), year, original.slice(cue.length + 1))}`);
  text = replace(text, /\b(since|from)\s+(\d{4})[-/](0?[1-9]|1[0-2])\b(?![-/]\d)/gi,
    (original, cue, year, month) => `${cue} ${monthYearWords(Number(month), year, original.slice(cue.length + 1))}`);
  // Bare K/M need an earnings cue, not just a nearby number. Carry that cue only
  // through the adjoining amount list; spaced/lowercase units remain unchanged.
  let earningsEnd = -1;
  text = replace(text, new RegExp(`(?<![\\p{L}\\p{N}_./\\\\+−${CURRENCY_SYMBOLS}-])([+−-]?)([${CURRENCY_SYMBOLS}]?)([+−-]?)(${NUMBER}(?:\\.\\d+)?)([KM])(?![\\p{L}\\p{N}_]|[./\\\\][\\p{L}\\p{N}_])`, 'gu'),
    (original, before, symbol, after, value, scale, offset, input) => {
      if (before && after) return original;
      const cue = /(?<![\p{L}\p{N}_-])(?:made|makes?|making)[^\S\r\n]+$/iu.test(input.slice(0, offset));
      const list = earningsEnd >= 0 && /^[^\S\r\n]*(?:,[^\S\r\n]*(?:(?:and|or)[^\S\r\n]*)?|(?:and|or|&)[^\S\r\n]*)$/iu.test(input.slice(earningsEnd, offset));
      if (!cue && !list) return original;
      earningsEnd = offset + original.length;
      // Explicit currencies use the existing money rules below; they can still
      // introduce the next bare amount in the same earnings list.
      return symbol ? original : signWords(before || after) + scaledWords(value, scale);
    });
  // A leading sign must touch the currency: "$5 - $10" is a range, not a loss.
  const currencyPrefix = `(?:(?<![\\p{L}\\p{N}_])([+−-]))?([${CURRENCY_SYMBOLS}])\\s*([+−-]?)\\s*`;
  text = replace(text, new RegExp(`${currencyPrefix}(${NUMBER}(?:\\.\\d+)?)([kmbt])(?![\\p{L}\\p{N}_]|[.,]\\d)`, 'giu'), signedMoney);
  text = replace(text, new RegExp(`${currencyPrefix}(${NUMBER}(?:\\.\\d{1,2})?)(?![\\p{L}\\p{N}_]|[.,]\\d)`, 'gu'),
    (original, before, symbol, after, value) => signedMoney(original, before, symbol, after, value));
  text = replace(text, /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\s*([ap])\.?m\.?)?\b/gi,
    (original, hourText, minuteText, secondText, meridiem) => {
      let hour = Number(hourText);
      if (meridiem && (hour < 1 || hour > 12)) return original;
      if (meridiem) hour %= 12 || 12;
      const minute = Number(minuteText);
      const minuteWords = minute === 0 ? "o'clock" : minute < 10 ? `oh ${cardinal(minute)}` : cardinal(minute);
      const seconds = secondText === undefined ? '' : ` and ${cardinal(Number(secondText))} seconds`;
      return `${cardinal(hour)} ${minuteWords}${seconds}${meridiem ? ` ${meridiem.toUpperCase()} M` : ''}`;
    });
  text = replace(text, new RegExp(`\\b(${NUMBER}(?:\\.\\d+)?)[^\\S\\r\\n]*(ms|s|m|h|d|w)\\b`, 'g'),
    (_original, value, unit) => durationWords(value, unit));
  text = replace(text, new RegExp(`\\b(${NUMBER}(?:\\.\\d+)?)\\s*(milliseconds?|msecs?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?)\\b`, 'giu'),
    (_original, value, unit) => durationWords(value, unit));
  text = replace(text, new RegExp(`(?<![\\p{L}\\p{N}_.,:/\\\\+−${CURRENCY_SYMBOLS}-])([+−-])(${NUMBER}(?:\\.\\d+)?)(?![\\p{L}\\p{N}_]|[.,:/\\\\-]\\d)`, 'gu'),
    (_original, sign, value) => signWords(sign) + decimalWords(value));
  text = replace(text, new RegExp(`(?<![\\p{L}\\p{N}_.,:/\\-${CURRENCY_SYMBOLS}])(${NUMBER})\\.(\\d+)(?![\\p{L}\\p{N}_]|[.,:/\\-]\\d)`, 'gu'),
    (_original, whole, fraction) => decimalWords(`${whole}.${fraction}`));
  text = replace(text, /(?<![\p{L}\p{N}_.,])(\d+)(?:st|nd|rd|th)\b/giu,
    (_original, value) => ordinal(value));
  text = replace(text, new RegExp(`(?<![\\p{L}\\p{N}_.,:/\\-${CURRENCY_SYMBOLS}])(${NUMBER})(?![\\p{L}\\p{N}_]|[.,:/\\-]\\d)`, 'gu'),
    (_original, value) => cardinal(value));
  return text;
}

export function parseLexicon(source) {
  const entries = new Map();
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('|').map((field) => field.trim());
    if (fields.length !== 3 || !fields[0] || !fields[1] || !fields[2]) continue;
    const entry = { input: fields[0], replacement: fields[1], language: fields[2].toLowerCase() };
    entries.set(`${entry.language}\0${entry.input}`, entry);
  }
  return [...entries.values()];
}

function bucketsFor(entries, language) {
  const buckets = new Map();
  for (const entry of entries) {
    if (entry.language !== language) continue;
    const first = entry.input[0];
    if (!buckets.has(first)) buckets.set(first, []);
    buckets.get(first).push(entry);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => right.input.length - left.input.length);
  }
  return buckets;
}

function normalize(source, entries, language, trace) {
  source = String(source || '');
  const normalizedLanguage = String(language).toLowerCase();
  const replace = trace?.replace || replaceText;
  // Preserve words and meaningful inline code; remove only presentation syntax.
  let prose = replace(source, /!\[[^\]\n]*\]\([^\n)]*\)/g, () => 'See the image in the conversation.');
  prose = replace(prose, /\[([^\]\n]+)\]\((?:[^\s()]|\([^\n()]*\))+\)/g,
    (_match, label) => `${label} (see the link in the conversation)`);
  prose = replace(prose, /^ {0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?)/gm, () => '');
  prose = replace(prose, /^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/gm, () => '');
  prose = replace(prose, /(`+)([^`\n]+)\1/g, (_match, _ticks, text) => text);
  prose = replace(prose, /(\*\*|__|~~)(\S(?:[^\n]*?\S)?)\1/g, (_match, _marks, text) => text);
  prose = replace(prose, /(?<![\p{L}\p{N}_])([*_])(\S(?:[^\n]*?\S)?)\1(?![\p{L}\p{N}_])/gu, (_match, _mark, text) => text);
  const references = normalizeSpokenReferences(prose, normalizedLanguage, trace?.replace);
  const text = normalizedLanguage === 'english'
    ? normalizeEnglishPatterns(references, trace?.replace)
    : references;
  const buckets = bucketsFor(entries || [], normalizedLanguage);
  let output = '';
  const ranges = [];
  const append = (value, start, end) => {
    output += value;
    if (trace) ranges.push(...trace.project(value, start, end, text.slice(start, end)));
  };
  for (let index = 0; index < text.length;) {
    let matched = null;
    const candidates = buckets.get(text[index]) || [];
    for (const entry of candidates) {
      if (!text.startsWith(entry.input, index)) continue;
      const before = index > 0 ? text[index - 1] : '';
      const after = text[index + entry.input.length] || '';
      if (isWord(entry.input[0]) && isWord(before)) continue;
      if (isWord(entry.input.at(-1)) && isWord(after)) continue;
      matched = entry;
      break;
    }
    if (!matched) {
      append(text[index], index, index + 1);
      index += 1;
      continue;
    }
    const before = output.at(-1) || '';
    const after = text[index + matched.input.length] || '';
    const replacement = (isWord(before) && isWord(matched.replacement[0]) ? ' ' : '')
      + matched.replacement + (isWord(matched.replacement.at(-1)) && isWord(after) ? ' ' : '');
    append(replacement, index, index + matched.input.length);
    index += matched.input.length;
  }
  return trace ? { text: output, ranges } : output;
}

// Trace the SAME replacements used for speech, rather than normalizing words independently (which loses
// context such as "since 08-26", "9:05 PM", or "2 days"). Each spoken UTF-16 unit retains its source span.
export function normalizeTextWithRanges(source, entries = [], language = 'english') {
  source = String(source || '');
  let ranges = Array.from({ length: source.length }, (_, start) => ({ start, end: start + 1 }));
  const trace = {
    project(value, start, end, original = '') {
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(value.length, original.length) && value[prefix] === original[prefix]) prefix++;
      while (suffix < Math.min(value.length, original.length) - prefix
        && value[value.length - suffix - 1] === original[original.length - suffix - 1]) suffix++;
      const middle = value.length - prefix - suffix;
      const middleStart = Math.min(start + prefix, end - 1);
      const span = middle ? {
        start: ranges[middleStart].start,
        // Pure insertions (AI -> A I, vs -> versus) belong to an adjacent source character.
        end: ranges[Math.max(middleStart, end - suffix - 1)].end,
      } : null;
      return [...ranges.slice(start, start + prefix), ...new Array(middle).fill(span),
        ...(suffix ? ranges.slice(end - suffix, end) : [])];
    },
    replace(text, pattern, replacement) {
      const next = [];
      let cursor = 0;
      const result = text.replace(pattern, (...args) => {
        const match = args[0], offset = args.at(-2);
        const value = replacement(...args);
        next.push(...ranges.slice(cursor, offset));
        next.push(...(value === match ? ranges.slice(offset, offset + match.length)
          : trace.project(value, offset, offset + match.length, match)));
        cursor = offset + match.length;
        return value;
      });
      next.push(...ranges.slice(cursor));
      ranges = next;
      return result;
    },
  };
  return normalize(source, entries, language, trace);
}

export function normalizeText(source, entries, language = 'english') {
  return normalize(source, entries, language);
}

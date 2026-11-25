const {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} = require('fs');
const { basename, join } = require('path');
const { open } = require('fs/promises');
const { ensurePrivateDataDir } = require('./private-data-dir');

const DEFAULT_CACHE_LIMIT = 50 * 1024;
const PAGE_READ_SIZE = 64 * 1024;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_SEARCH_LINE_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_PAGE_BYTES = 4 * 1024 * 1024;

// Search reads the saved file, not the short sidebar cache. Scan backwards in
// bounded async reads, keeping only one line and the matching page in memory.
async function* searchLines(handle, end, signal) {
  let position = end;
  let parts = [], bytes = 0, terminated = false;
  const add = piece => {
    if (!terminated || !piece.length) return;
    bytes += piece.length;
    if (bytes > MAX_SEARCH_LINE_BYTES) throw new Error('A saved message is too large to search safely.');
    parts.push(piece);
  };
  while (position > 0) {
    signal?.throwIfAborted();
    const length = Math.min(PAGE_READ_SIZE, position);
    position -= length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead !== length) throw new Error('Saved conversation changed while searching. Try again.');
    let finish = length;
    for (let index = length - 1; index >= 0; index--) {
      if (buffer[index] !== 10) continue;
      add(buffer.subarray(index + 1, finish));
      if (terminated && bytes) yield { offset: position + index + 1, raw: Buffer.concat(parts.reverse(), bytes) };
      parts = []; bytes = 0; terminated = true;
      finish = index;
    }
    add(buffer.subarray(0, finish));
  }
  if (terminated && bytes) yield { offset: 0, raw: Buffer.concat(parts.reverse(), bytes) };
}

function tailUtf8(value, limit) {
  const buffer = Buffer.from(String(value || ''));
  if (buffer.length <= limit) return buffer.toString('utf8');
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function parseEntries(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return (entry?.role === 'user' || entry?.role === 'agent')
          && typeof entry.text === 'string' ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function parsePageBuffer(buffer, offset, beginsAtLine) {
  let start = 0;
  if (!beginsAtLine) {
    const newline = buffer.indexOf(10);
    if (newline < 0) return [];
    start = newline + 1;
  }
  const records = [];
  for (let end = start; end < buffer.length; end += 1) {
    if (buffer[end] !== 10) continue;
    if (end > start) {
      try {
        const entry = JSON.parse(buffer.subarray(start, end).toString('utf8'));
        if ((entry?.role === 'user' || entry?.role === 'agent')
          && typeof entry.text === 'string') {
          records.push({ offset: offset + start, entry });
        }
      } catch {}
    }
    start = end + 1;
  }
  return records;
}

function readBackward(path, end, enough, maxBytes = Infinity) {
  const fd = openSync(path, 'r');
  let position = end;
  let buffer = Buffer.alloc(0);
  let records = [];
  let readBytes = 0;
  try {
    while (position > 0 && readBytes < maxBytes && !enough(records)) {
      const length = Math.min(PAGE_READ_SIZE, position, maxBytes - readBytes);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = readSync(fd, chunk, 0, length, position);
      readBytes += read;
      if (read !== length) throw new Error('Saved conversation changed while reading. Try again.');
      buffer = Buffer.concat([chunk.subarray(0, read), buffer]);
      let beginsAtLine = position === 0;
      if (!beginsAtLine && readBytes < maxBytes) {
        const previous = Buffer.allocUnsafe(1);
        const previousRead = readSync(fd, previous, 0, 1, position - 1);
        readBytes += previousRead;
        beginsAtLine = previousRead === 1 && previous[0] === 10;
      }
      records = parsePageBuffer(buffer, position, beginsAtLine);
    }
  } finally {
    closeSync(fd);
  }
  return { position, records };
}

function entriesTextBytes(records) {
  return records.reduce((total, { entry }, index) => (
    total + Buffer.byteLength(entry.text) + (index ? 1 : 0)
  ), 0);
}

class TranscriptStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('TranscriptStore requires a dataDir.');
    this.directory = join(options.dataDir, 'transcripts');
    this.cacheLimit = Math.max(1, Number(options.cacheLimit || DEFAULT_CACHE_LIMIT));
    this.now = options.now || (() => Date.now());
    this.cache = new Map();
    ensurePrivateDataDir(options.dataDir);
    mkdirSync(this.directory, { recursive: true });
    this.load(options.validIds);
  }

  path(sessionId) {
    const id = String(sessionId || '');
    return SAFE_SESSION_ID.test(id) ? join(this.directory, `${id}.jsonl`) : null;
  }

  load(validIds) {
    const known = validIds ? new Set(validIds) : null;
    for (const file of readdirSync(this.directory).filter((name) => name.endsWith('.jsonl'))) {
      const id = basename(file, '.jsonl');
      const path = join(this.directory, file);
      if (!SAFE_SESSION_ID.test(id) || (known && !known.has(id))) {
        // A recovered registry can be older than these files. Only explicit session
        // deletion may remove them; startup must preserve recovery material.
        continue;
      }
      try {
        const size = statSync(path).size;
        const { records } = readBackward(
          path,
          size,
          (values) => entriesTextBytes(values) >= this.cacheLimit,
        );
        const text = records.map(({ entry }) => entry.text).join('\n');
        if (text) this.cache.set(id, tailUtf8(text, this.cacheLimit));
      } catch {}
    }
  }

  append(sessionId, role, text, timestamp) {
    const path = this.path(sessionId);
    const value = String(text || '').trim();
    if (!path || (role !== 'user' && role !== 'agent') || !value) return null;
    const entry = { ts: Number(timestamp) || this.now(), role, text: value };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    const previous = this.cache.get(String(sessionId)) || '';
    this.cache.set(
      String(sessionId),
      tailUtf8(`${previous}${previous ? '\n' : ''}${value}`, this.cacheLimit),
    );
    return entry;
  }

  getCache() {
    return Object.fromEntries(this.cache);
  }

  getTurns(sessionId, count = 20, maxChars) {
    const path = this.path(sessionId);
    if (!path) return [];
    const limit = Math.max(1, Math.floor(Number(count) || 20));
    if (maxChars !== undefined && (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 64_000)) {
      throw new Error('maxChars must be an integer from 1 to 64000.');
    }
    let entries;
    if (maxChars === undefined) entries = parseEntries(path);
    else {
      if (!existsSync(path)) return [];
      const size = statSync(path).size;
      const { records } = readBackward(path, size, values => {
        let chars = 0, groups = 0, role;
        for (let i = values.length - 1; i >= 0; i--) {
          const entry = values[i].entry;
          chars += entry.text.length + (role === entry.role ? 1 : 0);
          if (role !== entry.role) groups++;
          role = entry.role;
          if (chars >= maxChars || groups > limit) return true;
        }
        return false;
      }, 1024 * 1024);
      if (size && !records.length) throw new Error('The latest conversation entry exceeds the bounded context read or is incomplete.');
      entries = records.map(record => record.entry);
    }
    const turns = [];
    for (const entry of entries) {
      const previous = turns.at(-1);
      if (previous?.role === entry.role) previous.text += `\n${entry.text}`;
      else turns.push({ role: entry.role, text: entry.text });
    }
    const result = turns.slice(-limit);
    if (maxChars === undefined) return result;
    // Keep the newest text, never split a UTF-16 surrogate pair at the boundary.
    let remaining = maxChars;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].text.length > remaining) {
        result[i].text = remaining ? result[i].text.slice(-remaining) : '';
        if (/^[\uDC00-\uDFFF]/.test(result[i].text)) result[i].text = result[i].text.slice(1);
      }
      remaining -= result[i].text.length;
    }
    return result.filter(turn => turn.text);
  }

  getPage(sessionId, before, count = 30) {
    const path = this.path(sessionId);
    if (!path || !existsSync(path)) return { turns: [], cursor: null, hasMore: false };
    const size = statSync(path).size;
    const end = before === undefined ? size : Math.min(size, Math.max(0, Math.floor(before)));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(count) || 30)));
    if (!end) return { turns: [], cursor: null, hasMore: false };

    const { position, records } = readBackward(
      path,
      end,
      (values) => values.length >= limit,
    );

    const page = records.slice(-limit);
    const hasMore = page.length > 0 && (records.length > page.length || position > 0);
    return {
      turns: page.map(({ entry }) => entry),
      cursor: hasMore ? page[0].offset : null,
      hasMore,
    };
  }

  async searchPage(sessionId, query, before, count = 30, signal) {
    const path = this.path(sessionId);
    const needle = String(query || '').trim();
    const empty = { turns: [], cursor: null, hasMore: false };
    if (!path || !needle) return empty;
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    let handle;
    try {
      signal?.throwIfAborted();
      try { handle = await open(path, 'r'); }
      catch (error) { if (error.code === 'ENOENT') return empty; throw error; }
      const { size } = await handle.stat();
      const end = before === undefined ? size : Math.min(size, Math.max(0, Math.floor(before)));
      const limit = Math.min(100, Math.max(1, Math.floor(Number(count) || 30)));
      const matches = [];
      let bytes = 0;
      for await (const line of searchLines(handle, end, signal)) {
        signal?.throwIfAborted();
        let entry;
        try { entry = JSON.parse(line.raw.toString('utf8')); } catch { continue; }
        if (!['user', 'agent'].includes(entry?.role) || typeof entry.text !== 'string'
          || !pattern.test(entry.text)) continue;
        const entryBytes = Buffer.byteLength(JSON.stringify(entry));
        if (matches.length && (matches.length === limit || bytes + entryBytes > MAX_SEARCH_PAGE_BYTES)) {
          return { turns: matches.map(item => item.entry).reverse(), cursor: matches.at(-1).offset, hasMore: true };
        }
        if (entryBytes > MAX_SEARCH_PAGE_BYTES) throw new Error('A matching message is too large to display in search.');
        matches.push({ entry, offset: line.offset }); bytes += entryBytes;
      }
      return { turns: matches.map(item => item.entry).reverse(), cursor: null, hasMore: false };
    } finally { await handle?.close(); }
  }

  delete(sessionId) {
    const path = this.path(sessionId);
    if (!path) return false;
    const existed = existsSync(path);
    rmSync(path, { force: true });
    this.cache.delete(String(sessionId));
    return existed;
  }
}

module.exports = { DEFAULT_CACHE_LIMIT, TranscriptStore, tailUtf8 };

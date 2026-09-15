const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { homedir } = require('os');
const { isAbsolute, join } = require('path');
const { ensurePrivateDataDir } = require('./private-data-dir');

const DEFAULT_DATA_DIR = join(homedir(), '.clideck-next');
const DEFAULT_HISTORY_LIMIT = 2 * 1024 * 1024;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_SESSION_ASSETS = 20;

function validDimension(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeAssets(value) {
  const assets = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return assets;
  for (const [key, raw] of Object.entries(value).slice(0, MAX_SESSION_ASSETS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = String(raw.id || key);
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const path = typeof raw.path === 'string' ? raw.path : '';
    const mime = typeof raw.mime === 'string' ? raw.mime.trim().toLowerCase() : '';
    if (!SAFE_SESSION_ID.test(id) || id !== key || !kind || kind.length > 160
      || !name || name.length > 255 || name.includes('\0')) continue;
    if (path && isAbsolute(path) && !path.includes('\0')) {
      assets[id] = {
        id,
        kind,
        name,
        path,
        ...(mime && { mime }),
        ...(raw.scope === 'user' && { scope: 'user' }),
      };
    } else if (raw.payload === true) {
      assets[id] = { id, kind, name, payload: true, ...(mime && { mime }) };
    }
  }
  return assets;
}

function cloneEntry(entry) {
  const clone = { ...entry };
  if (entry.assets) {
    clone.assets = Object.fromEntries(Object.entries(entry.assets).map(([id, asset]) => [
      id,
      { ...asset },
    ]));
  }
  return clone;
}

function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || !SAFE_SESSION_ID.test(String(value.id || ''))) return null;
  if (!value.provider || !value.cwd) return null;
  const assets = normalizeAssets(value.assets);
  return {
    id: String(value.id),
    provider: String(value.provider),
    name: typeof value.name === 'string' ? value.name.trim() : '',
    cwd: String(value.cwd),
    cols: validDimension(value.cols, 120),
    rows: validDimension(value.rows, 40),
    muted: value.muted === true,
    ...(Object.keys(assets).length && { assets }),
    createdAt: value.createdAt || new Date().toISOString(),
    lastActive: value.lastActive || value.createdAt || new Date().toISOString(),
    ...(value.lastFinal && { lastFinal: String(value.lastFinal) }),
    ...(Number(value.lastAgentAt) > 0 && { lastAgentAt: Number(value.lastAgentAt) }),
    ...(value.resumeHandle && { resumeHandle: String(value.resumeHandle) }),
    ...(value.transcriptPath && { transcriptPath: String(value.transcriptPath) }),
    ...(value.commandId && { commandId: String(value.commandId) }),
    ...(value.commandLabel && { commandLabel: String(value.commandLabel) }),
    ...(Object.prototype.hasOwnProperty.call(value, 'projectId') && {
      projectId: value.projectId ? String(value.projectId) : null,
    }),
  };
}

function readRegistry(path) {
  const text = readFileSync(path, 'utf8');
  const values = JSON.parse(text);
  if (!Array.isArray(values)) throw new Error('Session registry must be an array.');
  const entries = values.map(normalizeEntry);
  if (entries.some((entry) => !entry) || new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error('Session registry contains invalid or duplicate sessions.');
  }
  return { text, entries };
}

function writeRegistry(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}

class ByteTail {
  constructor(limit, initial = Buffer.alloc(0)) {
    this.limit = limit;
    this.chunks = [];
    this.length = 0;
    this.append(initial);
  }

  append(value) {
    let buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''));
    if (!buffer.length) return;
    if (buffer.length >= this.limit) {
      this.chunks = [Buffer.from(buffer.subarray(buffer.length - this.limit))];
      this.length = this.limit;
      return;
    }
    this.chunks.push(buffer);
    this.length += buffer.length;
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.limit) {
      this.length -= this.chunks.shift().length;
    }
    if (this.length > this.limit) {
      const overflow = this.length - this.limit;
      this.chunks[0] = Buffer.from(this.chunks[0].subarray(overflow));
      this.length = this.limit;
    }
  }

  buffer() {
    return Buffer.concat(this.chunks, this.length);
  }

  toString() {
    const buffer = this.buffer();
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
  }
}

class SessionPersistence {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this.historyDir = join(this.dataDir, 'history');
    this.registryPath = join(this.dataDir, 'sessions.json');
    this.backupPath = join(this.dataDir, 'sessions.backup.json');
    this.lastRegistry = '';
    this.historyLimit = Math.max(1, Number(options.historyLimit || DEFAULT_HISTORY_LIMIT));
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 250));
    this.now = options.now || (() => new Date().toISOString());
    this.entries = new Map();
    this.history = new Map();
    this.historyTimers = new Map();
    this.registryTimer = null;
    this.closed = false;
    ensurePrivateDataDir(this.dataDir);
    mkdirSync(this.historyDir, { recursive: true });
    this.loadRegistry();
  }

  loadRegistry() {
    let registry;
    try {
      registry = readRegistry(this.registryPath);
    } catch {
      try {
        registry = readRegistry(this.backupPath);
      } catch {
        const hasSavedData = ['history', 'transcripts', 'assets'].some((name) => {
          try { return readdirSync(join(this.dataDir, name)).length > 0; } catch { return false; }
        });
        if (!existsSync(this.registryPath) && !existsSync(this.backupPath) && !hasSavedData) return;
        throw new Error(`Cannot read session registry or recovery copy in ${this.dataDir}. Saved data was left untouched; restore sessions.json from a backup before restarting.`);
      }
      if (existsSync(this.registryPath)) {
        renameSync(this.registryPath, `${this.registryPath}.corrupt-${Date.now()}`);
      }
      writeRegistry(this.registryPath, registry.text);
      console.warn('Recovered CliDeck sessions from sessions.backup.json.');
    }
    this.lastRegistry = registry.text;
    for (const entry of registry.entries) this.entries.set(entry.id, entry);
  }

  list() {
    return [...this.entries.values()].map(cloneEntry);
  }

  get(id) {
    const entry = this.entries.get(String(id));
    return entry ? cloneEntry(entry) : null;
  }

  has(id) {
    return this.entries.has(String(id));
  }

  historyPath(id) {
    if (!SAFE_SESSION_ID.test(String(id || ''))) return null;
    return join(this.historyDir, `${id}.raw`);
  }

  saveRegistry() {
    if (this.closed) return;
    clearTimeout(this.registryTimer);
    this.registryTimer = null;
    const text = `${JSON.stringify(this.list(), null, 2)}\n`;
    if (text === this.lastRegistry && existsSync(this.backupPath)) return;
    writeRegistry(this.backupPath, this.lastRegistry || text);
    writeRegistry(this.registryPath, text);
    this.lastRegistry = text;
  }

  scheduleRegistry() {
    if (this.closed) return;
    clearTimeout(this.registryTimer);
    this.registryTimer = setTimeout(() => this.saveRegistry(), this.debounceMs);
    this.registryTimer.unref?.();
  }

  // Restore definitions only. Never register over a session: register clears its history.
  importMissing(values) {
    const entries = values.map(normalizeEntry);
    if (entries.some((entry) => !entry)) throw new Error('Invalid sessions in backup.');
    const added = entries.filter((entry) => !this.entries.has(entry.id));
    for (const entry of added) this.entries.set(entry.id, entry);
    try {
      this.saveRegistry();
    } catch (error) {
      for (const entry of added) this.entries.delete(entry.id);
      throw error;
    }
    return added.map(cloneEntry);
  }

  register(session) {
    const timestamp = this.now();
    const entry = {
      id: session.id,
      provider: session.provider.id,
      name: session.name || '',
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      muted: session.muted === true,
      createdAt: timestamp,
      lastActive: timestamp,
      ...(session.commandId && {
        commandId: session.commandId,
        commandLabel: session.commandLabel || '',
      }),
      ...(Object.prototype.hasOwnProperty.call(session, 'projectId') && {
        projectId: session.projectId || null,
      }),
    };
    this.entries.set(entry.id, entry);
    this.history.set(entry.id, new ByteTail(this.historyLimit));
    const path = this.historyPath(entry.id);
    if (path) rmSync(path, { force: true });
    this.saveRegistry();
    return { ...entry };
  }

  update(id, fields, immediate = false) {
    if (this.closed) return;
    const entry = this.entries.get(String(id));
    if (!entry) return;
    Object.assign(entry, fields);
    if (immediate) this.saveRegistry();
    else this.scheduleRegistry();
  }

  setAssets(id, assets) {
    if (this.closed) return;
    const entry = this.entries.get(String(id));
    if (!entry) return;
    const normalized = normalizeAssets(assets);
    if (Object.keys(normalized).length) entry.assets = normalized;
    else delete entry.assets;
    this.saveRegistry();
  }

  touch(id, fields = {}) {
    this.update(id, { ...fields, lastActive: this.now() });
  }

  recordFinal(id, text, timestamp = Date.now()) {
    const value = String(text || '').trim();
    if (value) this.touch(id, {
      lastFinal: value,
      lastAgentAt: Number(timestamp) || Date.now(),
    });
  }

  recordResumeMetadata(id, metadata = {}) {
    const entry = this.entries.get(String(id));
    if (!entry) return;
    const resumeHandle = String(metadata.handle || '').trim();
    const transcriptPath = String(metadata.transcriptPath || '').trim();
    if (!resumeHandle && !transcriptPath) return;
    if ((!resumeHandle || entry.resumeHandle === resumeHandle)
      && (!transcriptPath || entry.transcriptPath === transcriptPath)) return;
    this.update(id, {
      ...(resumeHandle && { resumeHandle }),
      ...(transcriptPath && { transcriptPath }),
      lastActive: this.now(),
    }, true);
  }

  readHistory(id) {
    const key = String(id);
    if (this.history.has(key)) return this.history.get(key);
    const path = this.historyPath(key);
    let buffer = Buffer.alloc(0);
    try {
      if (path && existsSync(path)) buffer = readFileSync(path);
    } catch {}
    const tail = new ByteTail(this.historyLimit, buffer);
    this.history.set(key, tail);
    return tail;
  }

  historyTail(id) {
    return this.readHistory(id).toString();
  }

  appendHistory(id, data) {
    if (this.closed || !this.entries.has(String(id))) return;
    const key = String(id);
    this.readHistory(key).append(data);
    this.touch(key);
    clearTimeout(this.historyTimers.get(key));
    const timer = setTimeout(() => this.flushHistory(key), this.debounceMs);
    timer.unref?.();
    this.historyTimers.set(key, timer);
  }

  flushHistory(id) {
    if (this.closed) return;
    const key = String(id);
    clearTimeout(this.historyTimers.get(key));
    this.historyTimers.delete(key);
    const path = this.historyPath(key);
    const history = this.history.get(key);
    if (!path || !history) return;
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, history.buffer());
    renameSync(temporary, path);
  }

  markClosed(session) {
    this.update(session.id, {
      cols: session.cols,
      rows: session.rows,
      lastActive: this.now(),
    }, true);
    this.flushHistory(session.id);
  }

  remove(id) {
    if (this.closed) return false;
    const key = String(id);
    if (!this.entries.delete(key)) return false;
    clearTimeout(this.historyTimers.get(key));
    this.historyTimers.delete(key);
    this.history.delete(key);
    const path = this.historyPath(key);
    if (path) rmSync(path, { force: true });
    this.saveRegistry();
    return true;
  }

  flush() {
    if (this.closed) return;
    this.saveRegistry();
    for (const id of this.history.keys()) this.flushHistory(id);
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    clearTimeout(this.registryTimer);
    for (const timer of this.historyTimers.values()) clearTimeout(timer);
    this.historyTimers.clear();
  }
}

module.exports = {
  DEFAULT_DATA_DIR,
  DEFAULT_HISTORY_LIMIT,
  SessionPersistence,
};

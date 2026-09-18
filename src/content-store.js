const { randomUUID } = require('crypto');
const {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('fs');
const { lstat, realpath, stat } = require('fs/promises');
const {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} = require('path');

const CONTENT_TYPES = new Map([
  ['.png', { kind: 'image', mime: 'image/png' }],
  ['.jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['.jpeg', { kind: 'image', mime: 'image/jpeg' }],
  ['.gif', { kind: 'image', mime: 'image/gif' }],
  ['.webp', { kind: 'image', mime: 'image/webp' }],
  ['.mp4', { kind: 'video', mime: 'video/mp4' }],
  ['.webm', { kind: 'video', mime: 'video/webm' }],
  ['.html', { kind: 'html', mime: 'text/html' }],
  ['.htm', { kind: 'html', mime: 'text/html' }],
  ['.md', { kind: 'markdown', mime: 'text/markdown' }],
  ['.txt', { kind: 'text', mime: 'text/plain' }],
  ['.log', { kind: 'text', mime: 'text/plain' }],
  ['.json', { kind: 'json', mime: 'application/json' }],
  ['.pdf', { kind: 'pdf', mime: 'application/pdf' }],
  ['.mmd', { kind: 'mermaid', mime: 'text/plain' }],
  ['.patch', { kind: 'diff', mime: 'text/plain' }],
  ['.diff', { kind: 'diff', mime: 'text/plain' }],
]);
const FILE_KIND_TYPES = new Map([
  ['html', { kind: 'html', mime: 'text/html' }],
  ['markdown', { kind: 'markdown', mime: 'text/markdown' }],
  ['text', { kind: 'text', mime: 'text/plain' }],
  ['json', { kind: 'json', mime: 'application/json' }],
  ['pdf', { kind: 'pdf', mime: 'application/pdf' }],
  ['mermaid', { kind: 'mermaid', mime: 'text/plain' }],
  ['diff', { kind: 'diff', mime: 'text/plain' }],
]);
const PAYLOAD_TYPES = new Map([
  ...FILE_KIND_TYPES,
  ['chart', { kind: 'chart', mime: 'application/json' }],
  ['testresults', { kind: 'testresults', mime: 'application/json' }],
]);
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_OPEN_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_ASSETS = 20;
const MAX_RESOLVE_PATHS = 50;
const RESOLVE_TIMEOUT_MS = 1000;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const PLUGIN_KIND_RE = /^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

class ContentError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isInside(root, file) {
  const path = relative(root, file);
  return Boolean(path)
    && path !== '..'
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

function requestedKind(kind) {
  return typeof kind === 'string' ? kind.trim().toLowerCase() : '';
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0) {
    throw new ContentError('invalid_request', 'Content data must be base64.', 400);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    if (!((code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || code === 43 || code === 47)) {
      throw new ContentError('invalid_request', 'Content data must be base64.', 400);
    }
  }
  return Buffer.from(value, 'base64');
}

function within(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fileType(path, kind) {
  const detected = CONTENT_TYPES.get(extname(path).toLowerCase());
  const override = requestedKind(kind);
  if (!override) {
    if (detected) return detected;
    throw new ContentError('unsupported_type', 'Unsupported content file type.', 415);
  }
  if ((override === 'image' || override === 'video')
    && detected?.kind === override) return detected;
  const type = FILE_KIND_TYPES.get(override);
  if (!type) {
    throw new ContentError('unsupported_type', 'Unsupported content kind.', 415);
  }
  return type;
}

function validateFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) {
    throw new ContentError('invalid_request', 'Content path must be absolute.', 400);
  }
}

async function resolveFilePath(filePath, kind) {
  validateFilePath(filePath);
  let path;
  try {
    path = await realpath(filePath);
  } catch {
    throw new ContentError('not_found', 'Content file was not found.', 404);
  }
  const info = await stat(path);
  if (!info.isFile()) {
    throw new ContentError('not_found', 'Content file was not found.', 404);
  }
  const type = fileType(path, kind);
  return { path, name: basename(path), ...type };
}

async function resolveContentPath(cwd, filePath, kind) {
  validateFilePath(filePath);
  let root;
  try {
    root = await realpath(cwd);
  } catch {
    throw new ContentError(
      'invalid_cwd',
      'Session working directory is unavailable.',
      409,
    );
  }
  const content = await resolveFilePath(filePath, kind);
  if (!isInside(root, content.path)) {
    throw new ContentError(
      'outside_scope',
      'Content file is outside the session working directory.',
      403,
    );
  }
  return content;
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value || '').trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

class ContentStore {
  constructor(options = {}) {
    this.createId = options.createId || randomUUID;
    this.maxPerSession = Math.max(1, Number(options.maxPerSession || MAX_SESSION_ASSETS));
    this.assetsDir = options.dataDir ? join(options.dataDir, 'assets') : '';
    this.entries = new Map();
    this.names = new Map();
    this.sessions = new Map();
    if (this.assetsDir) mkdirSync(this.assetsDir, { recursive: true, mode: 0o700 });
  }

  async add(sessionId, cwd, filePath, kind) {
    return this.addFile(sessionId, cwd, filePath, kind);
  }

  async addFile(sessionId, cwd, filePath, kind) {
    const content = await resolveContentPath(cwd, filePath, kind);
    return this.store(sessionId, { ...content, cwd, source: 'file' });
  }

  async addOpenFile(sessionId, filePath) {
    const content = await resolveFilePath(filePath);
    return this.store(sessionId, { ...content, source: 'file', scope: 'user' });
  }

  async resolvePaths(cwd, candidates) {
    return Object.fromEntries(await Promise.all(
      candidates.slice(0, MAX_RESOLVE_PATHS).map(async (candidate) => {
        const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
        const resolved = await within(
          resolveFilePath(path).then((content) => content.path).catch(() => null),
          RESOLVE_TIMEOUT_MS,
        );
        return [candidate, resolved];
      }),
    ));
  }

  addOpenPayload(sessionId, encoded, kind, name) {
    if (typeof name !== 'string' || !name.trim()
      || name.length > 255 || name.includes('\0')) {
      throw new ContentError('invalid_request', 'Content name is required.', 400);
    }
    const requested = requestedKind(kind);
    const type = requested === 'image' || requested === 'video'
      ? fileType(name, requested)
      : PAYLOAD_TYPES.get(requested);
    if (!type) throw new ContentError('unsupported_type', 'Unsupported content kind.', 415);
    const binary = requested === 'image' || requested === 'video' || requested === 'pdf';
    const data = binary ? decodeBase64(encoded) : Buffer.from(encoded, 'utf8');
    if (data.length > MAX_OPEN_CONTENT_BYTES) {
      throw new ContentError(
        'too_large',
        'Content exceeds the 10MB dragged-file limit.',
        413,
      );
    }
    return this.store(sessionId, {
      data,
      name: name.trim(),
      source: 'payload',
      ...type,
    });
  }

  async addImage(sessionId, cwd, filePath) {
    const content = await resolveContentPath(cwd, filePath);
    if (content.kind !== 'image') {
      throw new ContentError('unsupported_type', 'Annotation requires an image file.', 415);
    }
    return this.store(sessionId, { ...content, cwd, source: 'file' }, false);
  }

  addPayload(sessionId, payload, kind, name) {
    if (typeof payload !== 'string') {
      throw new ContentError('invalid_request', 'Content payload must be text.', 400);
    }
    if (typeof name !== 'string' || !name.trim()
      || name.length > 255 || name.includes('\0')) {
      throw new ContentError('invalid_request', 'Content name is required.', 400);
    }
    const type = PAYLOAD_TYPES.get(requestedKind(kind));
    if (!type) {
      throw new ContentError('unsupported_type', 'Unsupported payload kind.', 415);
    }
    const data = Buffer.from(payload, 'utf8');
    if (data.length > MAX_CONTENT_BYTES) {
      throw new ContentError(
        'too_large',
        'Content payload exceeds the 2MB limit.',
        413,
      );
    }
    return this.store(sessionId, {
      data,
      name: name.trim(),
      source: 'payload',
      ...type,
    });
  }

  addPluginPayload(sessionId, payload, kind, name, mime) {
    if (typeof name !== 'string' || !name.trim()
      || name.length > 255 || name.includes('\0')
      || !PLUGIN_KIND_RE.test(String(kind || ''))
      || !MIME_RE.test(String(mime || '').toLowerCase())) {
      throw new ContentError('invalid_request', 'Plugin content metadata is invalid.', 400);
    }
    let data;
    if (typeof payload === 'string') data = Buffer.from(payload, 'utf8');
    else if (payload instanceof ArrayBuffer) data = Buffer.from(payload);
    else if (ArrayBuffer.isView(payload)) {
      data = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    } else throw new ContentError('invalid_request', 'Plugin content data is invalid.', 400);
    if (data.length > MAX_OPEN_CONTENT_BYTES) {
      throw new ContentError('too_large', 'Plugin content exceeds the 10MB limit.', 413);
    }
    return this.store(sessionId, {
      data: Buffer.from(data),
      kind,
      mime: mime.toLowerCase(),
      name: name.trim(),
      source: 'payload',
    });
  }

  store(sessionId, content, persistent = true) {
    const sessionKey = String(sessionId);
    let sessionEntries = this.sessions.get(sessionKey);
    if (!sessionEntries) {
      sessionEntries = new Set();
      this.sessions.set(sessionKey, sessionEntries);
    }
    let sessionNames = this.names.get(sessionKey);
    if (!sessionNames) {
      sessionNames = new Map();
      this.names.set(sessionKey, sessionNames);
    }
    const replaces = persistent ? sessionNames.get(content.name) : undefined;
    const count = persistent ? sessionNames.size : sessionEntries.size - sessionNames.size;
    if (!replaces && count >= this.maxPerSession) {
      throw new ContentError(
        'too_many',
        persistent
          ? `A session can keep at most ${this.maxPerSession} open preview tabs. Close a preview tab and try again.`
          : `A session can keep at most ${this.maxPerSession} pending image annotations.`,
        409,
      );
    }
    const contentId = this.createId();
    const entry = {
      ...content,
      sessionId: sessionKey,
      persistent,
    };
    if (entry.source === 'payload' && this.assetsDir) {
      this.writePayload(sessionKey, contentId, entry.data);
    }
    if (replaces) this.remove(sessionKey, replaces);
    this.sessions.set(sessionKey, sessionEntries);
    this.names.set(sessionKey, sessionNames);
    this.entries.set(contentId, entry);
    sessionEntries.add(contentId);
    if (persistent) sessionNames.set(content.name, contentId);
    return this.event(contentId, entry, replaces);
  }

  get(contentId) {
    return this.entries.get(String(contentId || '')) || null;
  }

  event(contentId, content, replaces) {
    return {
      sessionId: content.sessionId,
      contentId,
      kind: content.kind,
      name: content.name,
      url: `/content/${contentId}`,
      ...(content.source === 'file' && { sourcePath: content.path }),
      ...(replaces && { replaces }),
    };
  }

  payloadPath(sessionId, contentId) {
    if (!this.assetsDir || !SAFE_ID.test(sessionId) || !SAFE_ID.test(contentId)) return '';
    return join(this.assetsDir, sessionId, `${contentId}.content`);
  }

  writePayload(sessionId, contentId, data) {
    const path = this.payloadPath(sessionId, contentId);
    if (!path) throw new ContentError('invalid_request', 'Invalid content identity.', 400);
    mkdirSync(join(this.assetsDir, sessionId), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  metadata(sessionId) {
    const assets = {};
    for (const contentId of this.sessions.get(String(sessionId)) || []) {
      const content = this.entries.get(contentId);
      if (!content?.persistent) continue;
      assets[contentId] = {
        id: contentId,
        kind: content.kind,
        name: content.name,
        mime: content.mime,
        ...(content.source === 'file' ? {
          path: content.path,
          ...(content.scope === 'user' && { scope: 'user' }),
        } : { payload: true }),
      };
    }
    return assets;
  }

  remove(sessionId, contentId) {
    const sessionKey = String(sessionId || '');
    const id = String(contentId || '');
    const content = this.entries.get(id);
    if (!content || content.sessionId !== sessionKey) return false;
    this.entries.delete(id);
    const sessionEntries = this.sessions.get(sessionKey);
    sessionEntries?.delete(id);
    if (!sessionEntries?.size) this.sessions.delete(sessionKey);
    const sessionNames = this.names.get(sessionKey);
    if (sessionNames?.get(content.name) === id) sessionNames.delete(content.name);
    if (!sessionNames?.size) this.names.delete(sessionKey);
    if (content.source === 'payload') {
      const path = this.payloadPath(sessionKey, id);
      if (path) rmSync(path, { force: true });
    }
    return true;
  }

  removeSession(sessionId) {
    const sessionKey = String(sessionId || '');
    for (const contentId of [...(this.sessions.get(sessionKey) || [])]) {
      this.remove(sessionKey, contentId);
    }
    if (this.assetsDir && SAFE_ID.test(sessionKey)) {
      rmSync(join(this.assetsDir, sessionKey), { recursive: true, force: true });
    }
  }

  restoreSessions(sessionEntries) {
    const repaired = new Map();
    for (const session of sessionEntries) {
      const expected = JSON.stringify(session.assets || {});
      this.restoreSession(session.id, session.cwd, session.assets || {});
      const actual = this.metadata(session.id);
      if (JSON.stringify(actual) !== expected) repaired.set(session.id, actual);
    }
    return repaired;
  }

  restoreSession(sessionId, cwd, assets) {
    for (const [contentId, asset] of Object.entries(assets).slice(0, this.maxPerSession)) {
      try {
        let content;
        if (asset.path) {
          const type = fileType(asset.path, asset.kind);
          content = {
            ...type,
            name: asset.name,
            path: asset.path,
            source: 'file',
            ...(asset.scope === 'user' ? { scope: 'user' } : { cwd }),
          };
        } else {
          const type = PAYLOAD_TYPES.get(requestedKind(asset.kind))
            || (PLUGIN_KIND_RE.test(asset.kind) && MIME_RE.test(String(asset.mime || ''))
              ? { kind: asset.kind, mime: asset.mime }
              : null);
          const path = this.payloadPath(String(sessionId), contentId);
          if (!type || !path || !existsSync(path)) continue;
          const info = lstatSync(path);
          if (!info.isFile() || info.size > MAX_OPEN_CONTENT_BYTES) continue;
          const data = readFileSync(path);
          content = { ...type, name: asset.name, data, source: 'payload' };
        }
        this.restore(contentId, String(sessionId), content);
      } catch {}
    }
  }

  restore(contentId, sessionId, content) {
    if (!SAFE_ID.test(contentId) || this.entries.has(contentId)) return;
    let sessionEntries = this.sessions.get(sessionId);
    if (!sessionEntries) {
      sessionEntries = new Set();
      this.sessions.set(sessionId, sessionEntries);
    }
    let sessionNames = this.names.get(sessionId);
    if (!sessionNames) {
      sessionNames = new Map();
      this.names.set(sessionId, sessionNames);
    }
    const replaces = sessionNames.get(content.name);
    if (replaces) this.remove(sessionId, replaces);
    this.sessions.set(sessionId, sessionEntries);
    this.names.set(sessionId, sessionNames);
    this.entries.set(contentId, {
      ...content,
      sessionId,
      persistent: true,
    });
    sessionEntries.add(contentId);
    sessionNames.set(content.name, contentId);
  }

  async getServable(contentId) {
    const content = this.get(contentId);
    if (!content) return null;
    if (content.source !== 'file') return content;
    try {
      const resolved = content.scope === 'user'
        ? await resolveFilePath(content.path, content.kind)
        : await resolveContentPath(content.cwd, content.path, content.kind);
      return { ...content, path: resolved.path, mime: resolved.mime };
    } catch {
      return null;
    }
  }

  async replay(sessionId) {
    const sessionKey = String(sessionId || '');
    const events = [];
    let changed = false;
    for (const contentId of [...(this.sessions.get(sessionKey) || [])]) {
      const content = await this.getServable(contentId);
      if (!content) {
        this.remove(sessionKey, contentId);
        changed = true;
      } else if (content.persistent) {
        events.push(this.event(contentId, content));
      }
    }
    return { events, changed };
  }
}

async function serveContent(req, res, content) {
  const data = Buffer.isBuffer(content.data) ? content.data : null;
  let served = content;
  let size = data?.length;
  if (!data) {
    let info;
    try {
      const resolved = content.scope === 'user'
        ? await resolveFilePath(content.path, content.kind)
        : await resolveContentPath(content.cwd, content.path, content.kind);
      served = { ...content, path: resolved.path, mime: resolved.mime };
      info = await lstat(served.path);
    } catch {
      res.writeHead(404).end();
      return false;
    }
    if (!info.isFile()) {
      res.writeHead(404).end();
      return false;
    }
    size = info.size;
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': served.mime,
    'X-Content-Type-Options': 'nosniff',
    // Keep HTML isolated even when its asset URL is opened directly.
    ...(served.mime === 'text/html' && { 'Content-Security-Policy': 'sandbox allow-scripts' }),
  };
  let range = null;
  if (req.headers.range !== undefined) {
    range = parseRange(req.headers.range, size);
    if (!range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return true;
    }
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = Math.max(0, end - start + 1);
  res.writeHead(range ? 206 : 200, {
    ...headers,
    'Content-Length': length,
    ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  });
  if (!length) {
    res.end();
    return true;
  }
  if (data) {
    res.end(data.subarray(start, end + 1));
    return true;
  }
  const stream = createReadStream(served.path, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

module.exports = {
  ContentError,
  ContentStore,
  MAX_CONTENT_BYTES,
  MAX_OPEN_CONTENT_BYTES,
  MAX_RESOLVE_PATHS,
  MAX_SESSION_ASSETS,
  serveContent,
};

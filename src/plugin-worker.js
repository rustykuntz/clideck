const { parentPort, workerData } = require('worker_threads');
const { pathToFileURL } = require('url');
const {
  CORE_PLUGIN_EVENT_SET,
  serializePluginValue,
} = require('./plugin-contract');

const eventHandlers = [];
const clientHandlers = new Map();
const commandHandlers = new Map();
const settingsHandlers = new Set();
const shutdownHandlers = new Set();
const coreCalls = new Map();
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const MAX_PLUGIN_CONTENT_BYTES = 10 * 1024 * 1024;
let settings = { ...(workerData.settings || {}) };
let stopped = false;

function post(message) {
  if (!stopped) parentPort.postMessage(message);
}

function safeName(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
}

function callCore(method, args = []) {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolveCall, rejectCall) => {
    coreCalls.set(requestId, { resolve: resolveCall, reject: rejectCall });
    post({ type: 'core-call', requestId, method, args });
  });
}

function byteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return -1;
}

function boundedText(value) {
  const text = String(value == null ? '' : value);
  if (Buffer.byteLength(text) <= MAX_COMMAND_OUTPUT_BYTES) return text;
  const suffix = '\n[output truncated]\n';
  const limit = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(suffix);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= limit) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low) + suffix;
}

function commandResult(value) {
  if (typeof value === 'string') return boundedText(value);
  if (value == null) return value;
  return {
    stdout: boundedText(value.stdout),
    stderr: boundedText(value.stderr),
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : 0,
  };
}

async function invoke(handler, ...args) {
  try {
    return await handler(...args);
  } catch (error) {
    post({
      type: 'log',
      level: 'error',
      message: error?.stack || error?.message || String(error),
    });
    return undefined;
  }
}

const api = Object.freeze({
  apiVersion: workerData.apiVersion,
  capabilities: Object.freeze({ ...workerData.capabilities }),
  engineVersion: workerData.engineVersion,
  id: workerData.id,
  dir: workerData.dir,
  dataDir: workerData.dataDir,
  log(...values) {
    post({ type: 'log', level: 'info', message: values.map(String).join(' ') });
  },
  onEvent(types, handler) {
    const wanted = new Set(Array.isArray(types) ? types : [types]);
    if (typeof handler !== 'function' || !wanted.size
      || [...wanted].some((type) => !CORE_PLUGIN_EVENT_SET.has(type))) {
      throw new TypeError('onEvent requires canonical CliDeck event names and a handler.');
    }
    eventHandlers.push({ wanted, handler });
    post({ type: 'subscriptions', events: [...new Set(eventHandlers.flatMap((entry) => [...entry.wanted]))] });
    return () => {
      const index = eventHandlers.findIndex((entry) => entry.handler === handler);
      if (index >= 0) eventHandlers.splice(index, 1);
      post({ type: 'subscriptions', events: [...new Set(eventHandlers.flatMap((entry) => [...entry.wanted]))] });
    };
  },
  onClientMessage(event, handler) {
    if (!safeName(event) || typeof handler !== 'function') {
      throw new TypeError('onClientMessage requires a safe event name and handler.');
    }
    clientHandlers.set(event, handler);
    return () => clientHandlers.delete(event);
  },
  registerCommand(name, handler) {
    if (!safeName(name) || typeof handler !== 'function') {
      throw new TypeError('registerCommand requires a safe name and handler.');
    }
    commandHandlers.set(name, handler);
    return () => commandHandlers.delete(name);
  },
  sendToClients(event, data) {
    if (!safeName(event)) throw new TypeError('Plugin event name is invalid.');
    post({ type: 'client-event', event, json: serializePluginValue(data ?? null) });
  },
  getSetting(key) {
    return settings[key];
  },
  getSettings() {
    return structuredClone(settings);
  },
  onSettingsChange(handler) {
    if (typeof handler !== 'function') throw new TypeError('Expected a settings handler.');
    settingsHandlers.add(handler);
    return () => settingsHandlers.delete(handler);
  },
  onShutdown(handler) {
    if (typeof handler !== 'function') throw new TypeError('Expected a shutdown handler.');
    shutdownHandlers.add(handler);
    return () => shutdownHandlers.delete(handler);
  },
  getSession(id) { return callCore('getSession', [id]); },
  getSessions() { return callCore('getSessions'); },
  getProjects() { return callCore('getProjects'); },
  getTurns(id, count = 20, maxChars) { return callCore('getTurns', [id, count, maxChars]); },
  sendPrompt(id, text) { return callCore('sendPrompt', [id, text]); },
  submitRequest(id, requestId, text, options = {}) { return callCore('submitRequest', [id, requestId, text, options]); },
  getRequests() { return callCore('getRequests'); },
  releaseRequest(id) { return callCore('releaseRequest', [id]); },
  acknowledgeRequest(id) { return callCore('acknowledgeRequest', [id]); },
  cancelRequest(id) { return callCore('cancelRequest', [id]); },
  reportError(sessionId, key, text) { return callCore('reportError', [sessionId, key, text]); },
  clearError(key) { return callCore('clearError', [key]); },
  notifyUser(sessionId, text) { return callCore('notifyUser', [sessionId, text]); },
  getNotifications() { return callCore('getNotifications'); },
  readNotification(id) { return callCore('readNotification', [id]); },
  writeInput(id, data) { return callCore('writeInput', [id, data]); },
  createSession(options) { return callCore('createSession', [options]); },
  closeSession(id) { return callCore('closeSession', [id]); },
  showContent(id, content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)
      || typeof content.kind !== 'string' || typeof content.name !== 'string'
      || typeof content.mime !== 'string') {
      throw new TypeError('showContent requires kind, name, mime, and data.');
    }
    const size = byteLength(content.data);
    if (size < 0 || size > MAX_PLUGIN_CONTENT_BYTES) {
      throw new RangeError('Plugin content exceeds the 10MB limit.');
    }
    return callCore('showContent', [id, content]);
  },
});

async function activate() {
  const module = await import(`${pathToFileURL(workerData.entry).href}?worker=${Date.now()}`);
  const start = module.activate || module.init || module.default;
  if (typeof start !== 'function') {
    throw new Error('server.js must export activate(api), init(api), or a default function.');
  }
  await start(api);
  const declared = new Set(workerData.commands || []);
  const missing = [...declared].filter((name) => !commandHandlers.has(name));
  const undeclared = [...commandHandlers.keys()].filter((name) => !declared.has(name));
  if (missing.length) throw new Error(`Missing command handlers: ${missing.join(', ')}`);
  if (undeclared.length) throw new Error(`Undeclared command handlers: ${undeclared.join(', ')}`);
  post({ type: 'ready' });
}

parentPort.on('message', async (message) => {
  if (!message || stopped) return;
  if (message.type === 'event') {
    for (const entry of eventHandlers) {
      if (entry.wanted.has(message.event?.type)) invoke(entry.handler, message.event);
    }
    return;
  }
  if (message.type === 'core-result') {
    const pending = coreCalls.get(message.requestId);
    if (!pending) return;
    coreCalls.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || 'CliDeck operation failed.'));
    return;
  }
  if (message.type === 'client-message') {
    const handler = clientHandlers.get(message.event);
    if (handler) {
      const replyToken = String(message.context?.replyToken || '');
      const context = Object.freeze({
        requestId: String(message.context?.requestId || ''),
        reply(event, data) {
          if (!replyToken) return false;
          if (!safeName(event)) throw new TypeError('Plugin reply event name is invalid.');
          post({
            type: 'client-reply',
            replyToken,
            event,
            json: serializePluginValue(data ?? null),
          });
          return true;
        },
      });
      invoke(handler, message.data, context);
    }
    return;
  }
  if (message.type === 'settings') {
    const previous = settings;
    settings = { ...(message.settings || {}) };
    for (const handler of settingsHandlers) invoke(handler, structuredClone(settings), previous);
    return;
  }
  if (message.type === 'command') {
    const handler = commandHandlers.get(message.command);
    if (!handler) {
      post({ type: 'command-result', requestId: message.requestId, ok: false, error: 'Unknown plugin command.' });
      return;
    }
    try {
      const result = await handler({
        args: Array.isArray(message.args) ? message.args.slice() : [],
        stdin: String(message.stdin || ''),
        sessionId: String(message.sessionId || ''),
      });
      post({
        type: 'command-result', requestId: message.requestId, ok: true,
        result: commandResult(result),
      });
    } catch (error) {
      post({
        type: 'command-result',
        requestId: message.requestId,
        ok: false,
        error: error?.message || String(error),
      });
    }
    return;
  }
  if (message.type === 'shutdown') {
    stopped = true;
    await Promise.allSettled([...shutdownHandlers].map((handler) => handler()));
    parentPort.postMessage({ type: 'stopped' });
  }
});

activate().catch((error) => {
  post({ type: 'failed', error: error?.stack || error?.message || String(error) });
});

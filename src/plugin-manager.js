const {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} = require('fs');
const { randomUUID } = require('crypto');
const { basename, join, resolve, sep } = require('path');
const { Worker } = require('worker_threads');
const { ensurePrivateDataDir } = require('./private-data-dir');
const {
  PLUGIN_API_VERSION,
  PLUGIN_ID_RE,
  PluginManifestError,
  defaultSettings,
  readPluginManifest,
  validateSettingValue,
} = require('./plugin-manifest');
const {
  CORE_PLUGIN_EVENT_SET,
  MAX_PLUGIN_MESSAGE_BYTES,
  serializePluginValue,
} = require('./plugin-contract');

const MAX_PLUGIN_FILES = 20_000;
const MAX_PLUGIN_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_RESULT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const LOAD_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 1_500;
const CLIENT_REPLY_TTL_MS = 10 * 60 * 1000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedText(value, max = MAX_COMMAND_RESULT) {
  const text = String(value == null ? '' : value);
  return Buffer.byteLength(text) <= max ? text : `${text.slice(0, max)}\n[output truncated]\n`;
}

function pluginState(config, id) {
  const plugins = config?.plugins;
  const value = plugins && typeof plugins === 'object' && !Array.isArray(plugins)
    ? plugins[id] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function folderEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function inspectCopyTree(root) {
  let files = 0;
  let bytes = 0;
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const error = new Error('Plugin packages cannot contain symbolic links.');
      error.code = 'plugin_symlink';
      throw error;
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!info.isFile()) {
      const error = new Error('Plugin packages may contain only files and folders.');
      error.code = 'plugin_file_type';
      throw error;
    }
    files += 1;
    bytes += info.size;
    if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) {
      const error = new Error('Plugin package exceeds the installation limit.');
      error.code = 'plugin_too_large';
      throw error;
    }
  };
  visit(root);
}

class PluginManager {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('PluginManager requires a dataDir.');
    this.dataDir = options.dataDir;
    this.pluginsDir = join(this.dataDir, 'plugins');
    this.pluginDataDir = join(this.dataDir, 'plugin-data');
    this.bundledDir = options.bundledDir || resolve(__dirname, '../plugins');
    this.configStore = options.configStore;
    this.engineVersion = options.engineVersion || '';
    this.onChange = options.onChange || (() => {});
    this.onClientEvent = options.onClientEvent || (() => {});
    this.onCoreCall = options.onCoreCall || (async () => {
      throw new Error('Core plugin operations are unavailable.');
    });
    this.log = options.log || ((level, id, message) => {
      const method = level === 'error' ? 'error' : 'log';
      console[method](`[plugin:${id}] ${message}`);
    });
    this.records = new Map();
    this.started = false;
    ensurePrivateDataDir(this.dataDir);
    mkdirSync(this.pluginsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.pluginDataDir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.pluginsDir, 0o700); } catch {}
    try { chmodSync(this.pluginDataDir, 0o700); } catch {}
  }

  config() {
    return this.configStore?.get?.() || {};
  }

  persistState(id, patch) {
    if (!this.configStore) return;
    const config = this.config();
    const plugins = config.plugins && typeof config.plugins === 'object'
      && !Array.isArray(config.plugins) ? clone(config.plugins) : {};
    plugins[id] = { ...pluginState(config, id), ...clone(patch) };
    this.configStore.update({ plugins });
  }

  candidate(directory, source) {
    try {
      return { manifest: readPluginManifest(directory), directory: realpathSync(directory), source };
    } catch (error) {
      const folder = basename(directory).toLowerCase();
      if (!PLUGIN_ID_RE.test(folder)) return null;
      return {
        manifest: {
          id: folder,
          name: basename(directory),
          version: '',
          apiVersion: 0,
          description: '',
          icon: '',
          commands: [],
          viewers: [],
          settings: [],
          directory,
          hasServer: false,
          hasClient: false,
          hasPublic: false,
        },
        directory,
        source,
        error: error instanceof PluginManifestError ? error.message : 'Could not read this plugin.',
      };
    }
  }

  discover() {
    const candidates = [
      ...folderEntries(this.bundledDir).map((dir) => this.candidate(dir, 'bundled')),
      ...folderEntries(this.pluginsDir).map((dir) => this.candidate(dir, 'user')),
    ].filter(Boolean);
    const ids = new Set();
    const names = new Set();
    return candidates.map((candidate) => {
      const id = candidate.manifest.id.toLowerCase();
      const name = candidate.manifest.name.trim().toLowerCase();
      let duplicate = '';
      if (ids.has(id)) duplicate = `Plugin ID "${candidate.manifest.id}" is already installed.`;
      else if (names.has(name)) duplicate = `Plugin name "${candidate.manifest.name}" is already installed.`;
      if (!duplicate) {
        ids.add(id);
        names.add(name);
      }
      return { ...candidate, duplicate };
    });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    for (const candidate of this.discover()) {
      const record = this.makeRecord(candidate);
      if (this.records.has(record.manifest.id)) {
        this.log('error', record.manifest.id, record.error || 'Duplicate plugin ignored.');
        continue;
      }
      this.records.set(record.manifest.id, record);
      await this.load(record);
    }
  }

  makeRecord(candidate) {
    const stored = pluginState(this.config(), candidate.manifest.id);
    const enabled = typeof stored.enabled === 'boolean'
      ? stored.enabled : candidate.manifest.enabledByDefault !== false;
    return {
      ...candidate,
      enabled,
      settings: defaultSettings(candidate.manifest, stored.settings),
      status: enabled ? 'loading' : 'disabled',
      error: candidate.error || candidate.duplicate || '',
      subscriptions: new Set(),
      worker: null,
      pending: new Map(),
      clientReplies: new Map(),
      intentionalStop: false,
    };
  }

  async load(record) {
    if (!record.enabled) {
      record.status = 'disabled';
      return;
    }
    if (record.error) {
      record.status = 'failed';
      return;
    }
    if (record.manifest.apiVersion !== PLUGIN_API_VERSION) {
      record.status = 'incompatible';
      record.error = `Requires plugin API ${record.manifest.apiVersion}; this engine provides ${PLUGIN_API_VERSION}.`;
      return;
    }
    if (!record.manifest.hasServer) {
      record.status = 'ready';
      return;
    }
    record.status = 'loading';
    const dataDir = join(this.pluginDataDir, record.manifest.id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const worker = new Worker(join(__dirname, 'plugin-worker.js'), {
      workerData: {
        apiVersion: PLUGIN_API_VERSION,
        engineVersion: this.engineVersion,
        id: record.manifest.id,
        dir: record.directory,
        dataDir,
        entry: join(record.directory, 'server.js'),
        settings: record.settings,
        commands: record.manifest.commands.map((command) => command.name),
      },
    });
    record.worker = worker;
    record.intentionalStop = false;
    const loaded = new Promise((resolveLoad) => {
      const timer = setTimeout(() => resolveLoad({ ok: false, error: 'Plugin load timed out.' }), LOAD_TIMEOUT_MS);
      timer.unref?.();
      const done = (result) => {
        clearTimeout(timer);
        resolveLoad(result);
      };
      worker.on('message', (message) => {
        if (message?.type === 'ready') done({ ok: true });
        else if (message?.type === 'failed') done({ ok: false, error: message.error });
        this.handleWorkerMessage(record, message);
      });
      worker.once('error', (error) => done({ ok: false, error: error.message }));
      worker.once('exit', (code) => {
        if (!record.intentionalStop && record.status !== 'failed') {
          record.status = 'failed';
          record.error = `Plugin worker exited (${code}).`;
          this.rejectPending(record, record.error);
          this.emitChange();
        }
      });
    });
    const result = await loaded;
    if (result.ok) {
      record.status = 'ready';
      record.error = '';
    } else {
      record.status = 'failed';
      record.error = String(result.error || 'Plugin failed to load.').split('\n')[0];
      record.intentionalStop = true;
      await worker.terminate().catch(() => {});
      record.worker = null;
    }
  }

  handleWorkerMessage(record, message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'subscriptions') {
      const events = Array.isArray(message.events) ? message.events : [];
      if (events.some((event) => !CORE_PLUGIN_EVENT_SET.has(event))) {
        this.log('error', record.manifest.id, 'Rejected a non-canonical event subscription.');
        return;
      }
      record.subscriptions = new Set(events);
    } else if (message.type === 'client-event') {
      const event = this.workerClientEvent(record, message);
      if (event) this.onClientEvent(event);
    } else if (message.type === 'client-reply') {
      const pending = record.clientReplies.get(message.replyToken);
      const event = pending && this.workerClientEvent(record, message, pending.requestId);
      if (event) pending.reply(event);
    } else if (message.type === 'command-result') {
      const pending = record.pending.get(message.requestId);
      if (!pending) return;
      record.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Plugin command failed.'));
    } else if (message.type === 'log') {
      this.log(message.level, record.manifest.id, message.message);
    } else if (message.type === 'core-call') {
      Promise.resolve().then(() => this.onCoreCall(
        record.manifest.id,
        message.method,
        Array.isArray(message.args) ? message.args : [],
      )).then(
        (result) => record.worker?.postMessage({
          type: 'core-result', requestId: message.requestId, ok: true, result,
        }),
        (error) => record.worker?.postMessage({
          type: 'core-result',
          requestId: message.requestId,
          ok: false,
          error: error?.message || String(error),
        }),
      );
    }
  }

  workerClientEvent(record, message, requestId = '') {
    if (typeof message.event !== 'string' || !PLUGIN_ID_RE.test(message.event)
      || typeof message.json !== 'string'
      || Buffer.byteLength(message.json) > MAX_PLUGIN_MESSAGE_BYTES) {
      this.log('error', record.manifest.id, 'Rejected an invalid plugin client message.');
      return null;
    }
    try {
      const data = JSON.parse(message.json);
      serializePluginValue(data);
      return {
        type: 'plugin.message',
        pluginId: record.manifest.id,
        event: message.event,
        data,
        ...(requestId && { requestId }),
      };
    } catch {
      this.log('error', record.manifest.id, 'Rejected a non-JSON plugin client message.');
      return null;
    }
  }

  rejectPending(record, reason) {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    record.pending.clear();
  }

  emitChange() {
    this.onChange(this.snapshot());
  }

  snapshot() {
    return [...this.records.values()].map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      version: record.manifest.version,
      apiVersion: record.manifest.apiVersion,
      description: record.manifest.description,
      icon: record.manifest.icon,
      source: record.source,
      enabled: record.enabled,
      status: record.status,
      error: record.error,
      commands: clone(record.manifest.commands),
      viewers: clone(record.manifest.viewers),
      settings: clone(record.manifest.settings.map((setting) => (
        setting.type === 'secret' ? { ...setting, default: undefined } : setting
      ))),
      values: clone(Object.fromEntries(Object.entries(record.settings).filter(([key]) => (
        record.manifest.settings.find((setting) => setting.key === key)?.type !== 'secret'
      )))),
      configured: Object.fromEntries(record.manifest.settings
        .filter((setting) => setting.type === 'secret')
        .map((setting) => [setting.key, Boolean(record.settings[setting.key])])),
      clientUrl: record.manifest.hasClient ? `/plugins/${record.manifest.id}/client.js` : '',
      hasWorkspaceAssets: record.manifest.hasPublic,
    }));
  }

  publicCommands() {
    return this.snapshot()
      .filter((plugin) => plugin.enabled && plugin.status === 'ready')
      .flatMap((plugin) => plugin.commands.map((command) => ({
        pluginId: plugin.id,
        pluginName: plugin.name,
        ...command,
      })));
  }

  viewerType(pluginId, kind, mime) {
    const record = this.records.get(String(pluginId || ''));
    if (!record || !record.enabled || record.error) return null;
    const wantedKind = String(kind || '');
    const wantedMime = String(mime || '').toLowerCase();
    return record.manifest.viewers.find((viewer) => (
      viewer.kind === wantedKind && viewer.mime === wantedMime
    )) || null;
  }

  emitCoreEvent(event) {
    for (const record of this.records.values()) {
      if (record.status === 'ready' && record.worker && record.subscriptions.has(event.type)) {
        record.worker.postMessage({ type: 'event', event });
      }
    }
  }

  clientMessage(pluginId, event, data, context = {}) {
    const record = this.records.get(pluginId);
    if (!record || record.status !== 'ready' || !record.worker) return false;
    let replyToken = '';
    if (typeof context.reply === 'function') {
      replyToken = randomUUID();
      const timer = setTimeout(() => record.clientReplies.delete(replyToken), CLIENT_REPLY_TTL_MS);
      timer.unref?.();
      record.clientReplies.set(replyToken, {
        requestId: String(context.requestId || ''),
        reply: context.reply,
        timer,
      });
    }
    record.worker.postMessage({
      type: 'client-message',
      event,
      data,
      context: { requestId: String(context.requestId || ''), replyToken },
    });
    return true;
  }

  async runCommand(pluginId, command, request = {}) {
    const record = this.records.get(pluginId);
    if (!record || record.status !== 'ready' || !record.worker
      || !record.manifest.commands.some((entry) => entry.name === command)) {
      const error = new Error('Plugin command is unavailable.');
      error.code = 'plugin_command_unavailable';
      throw error;
    }
    const requestId = randomUUID();
    const result = await new Promise((resolveCommand, rejectCommand) => {
      const timeoutMs = Math.min(COMMAND_TIMEOUT_MS, Math.max(1000, Number(request.timeoutMs || 60_000)));
      const timer = setTimeout(() => {
        record.pending.delete(requestId);
        const error = new Error('Plugin command timed out.');
        error.code = 'plugin_command_timeout';
        rejectCommand(error);
      }, timeoutMs);
      timer.unref?.();
      record.pending.set(requestId, { resolve: resolveCommand, reject: rejectCommand, timer });
      record.worker.postMessage({
        type: 'command',
        requestId,
        command,
        args: request.args || [],
        stdin: request.stdin || '',
        sessionId: request.sessionId || '',
      });
    });
    if (typeof result === 'string' || result == null) {
      return { stdout: boundedText(result || ''), stderr: '', exitCode: 0 };
    }
    return {
      stdout: boundedText(result.stdout || ''),
      stderr: boundedText(result.stderr || ''),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : 0,
    };
  }

  async setEnabled(id, enabled) {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.enabled === enabled) return true;
    record.enabled = enabled;
    this.persistState(id, { enabled });
    if (enabled) await this.load(record);
    else {
      await this.stopRecord(record);
      record.status = 'disabled';
      record.error = '';
    }
    this.emitChange();
    return true;
  }

  async updateSettings(id, patch) {
    const record = this.records.get(id);
    if (!record || !patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    const definitions = new Map(record.manifest.settings.map((entry) => [entry.key, entry]));
    for (const [key, value] of Object.entries(patch)) {
      if (!validateSettingValue(definitions.get(key), value)) return false;
    }
    record.settings = { ...record.settings, ...clone(patch) };
    this.persistState(id, { settings: record.settings });
    if (record.worker) record.worker.postMessage({ type: 'settings', settings: record.settings });
    this.emitChange();
    return true;
  }

  async refresh() {
    const seen = new Set();
    for (const candidate of this.discover()) {
      const id = candidate.manifest.id;
      seen.add(id);
      if (this.records.has(id)) continue;
      const record = this.makeRecord(candidate);
      this.records.set(id, record);
      await this.load(record);
    }
    for (const [id, record] of [...this.records]) {
      if (record.source === 'user' && !seen.has(id)) {
        await this.stopRecord(record);
        this.records.delete(id);
      }
    }
    this.emitChange();
    return this.snapshot();
  }

  // The restore has already persisted its validated settings in one config write.
  async applySavedSettings() {
    const saved = this.config().plugins || {};
    for (const [id, record] of this.records) {
      if (!saved[id]) continue;
      record.settings = defaultSettings(record.manifest, saved[id].settings);
      if (record.worker) record.worker.postMessage({ type: 'settings', settings: record.settings });
      if (typeof saved[id].enabled !== 'boolean' || record.enabled === saved[id].enabled) continue;
      record.enabled = saved[id].enabled;
      if (record.enabled) await this.load(record);
      else {
        await this.stopRecord(record);
        record.status = 'disabled';
        record.error = '';
      }
    }
    this.emitChange();
  }

  async install(sourcePath) {
    let source;
    try {
      source = realpathSync(sourcePath);
    } catch {
      const error = new Error('Plugin folder does not exist.');
      error.code = 'plugin_not_found';
      throw error;
    }
    const manifest = readPluginManifest(source);
    if (this.records.has(manifest.id)
      || [...this.records.values()].some((record) => (
        record.manifest.name.toLowerCase() === manifest.name.toLowerCase()
      ))) {
      const error = new Error(`Plugin "${manifest.name}" is already installed.`);
      error.code = 'plugin_exists';
      throw error;
    }
    inspectCopyTree(source);
    const temporary = join(this.pluginsDir, `.install-${process.pid}-${randomUUID()}`);
    const destination = join(this.pluginsDir, manifest.id);
    if (existsSync(destination)) {
      const error = new Error(`Plugin "${manifest.name}" is already installed.`);
      error.code = 'plugin_exists';
      throw error;
    }
    try {
      cpSync(source, temporary, { recursive: true, errorOnExist: true });
      readPluginManifest(temporary, { requireFolderName: false });
      renameSync(temporary, destination);
      chmodSync(destination, 0o700);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    await this.refresh();
    return this.records.get(manifest.id);
  }

  async remove(id) {
    const record = this.records.get(id);
    if (!record || record.source !== 'user') return false;
    await this.stopRecord(record);
    rmSync(record.directory, { recursive: true, force: true });
    this.records.delete(id);
    this.emitChange();
    return true;
  }

  assetPath(id, relativePath) {
    const record = this.records.get(id);
    if (!record || !record.enabled || record.status !== 'ready') return null;
    const client = relativePath === 'client.js';
    const root = client ? record.directory : join(record.directory, 'public');
    const path = resolve(root, client ? 'client.js' : relativePath.replace(/^public\//, ''));
    let real;
    try {
      real = realpathSync(path);
      if (!statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    const canonicalRoot = realpathSync(root);
    if (real !== canonicalRoot && !real.startsWith(`${canonicalRoot}${sep}`)) return null;
    return real;
  }

  async stopRecord(record) {
    if (!record.worker) return;
    const worker = record.worker;
    record.intentionalStop = true;
    record.worker = null;
    this.rejectPending(record, 'Plugin stopped.');
    for (const pending of record.clientReplies.values()) clearTimeout(pending.timer);
    record.clientReplies.clear();
    await Promise.race([
      new Promise((resolveStop) => {
        const onMessage = (message) => {
          if (message?.type === 'stopped') {
            worker.off('message', onMessage);
            resolveStop();
          }
        };
        worker.on('message', onMessage);
        worker.postMessage({ type: 'shutdown' });
      }),
      new Promise((resolveStop) => {
        const timer = setTimeout(resolveStop, STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    await worker.terminate().catch(() => {});
  }

  async close() {
    await Promise.all([...this.records.values()].map((record) => this.stopRecord(record)));
  }
}

module.exports = {
  MAX_PLUGIN_BYTES,
  MAX_PLUGIN_FILES,
  PluginManager,
};

const http = require('http');
const { serverUrl } = require('./hook-url');
const { existsSync } = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const { AgentSession } = require('./session');
const {
  AskCoordinator,
  availableAskSession,
  availableSteerSession,
  listAskTargets,
  parseAskRequest,
  resolveAskTarget,
} = require('./ask');
const {
  MAX_CONTROL_BYTES,
  MAX_CONTROL_TEXT,
  hasValidControlFields,
  isKnownControlType,
} = require('./control');
const { ConfigStore } = require('./config-store');
const {
  ContentError,
  ContentStore,
  MAX_CONTENT_BYTES,
  MAX_RESOLVE_PATHS,
  serveContent,
} = require('./content-store');
const { listDirectories, makeDirectory } = require('./directories');
const { DEFAULT_DATA_DIR, SessionPersistence } = require('./persistence');
const { openProjectPath } = require('./project-open');
const { hasProjectId, sameSessionScope, sessionAddress } = require('./project-scope');
const {
  PromptCoordinator,
  parseAnnotateRequest,
  parsePromptRequest,
} = require('./prompt-coordinator');
const { getProvider, listProviders } = require('./providers');
const { isAllowedWebSocketOrigin, isLoopbackAddress, isLoopbackHost } = require('./security');
const { listSessionAgents, resolveLiveCaller } = require('./session-agents');
const { servePluginStatic, serveStatic } = require('./static');
const { ServerLock } = require('./server-lock');
const { alreadyRunningLine, startupBanner } = require('./startup');
const { TranscriptStore } = require('./transcript-store');
const { MAX_UPLOAD_BYTES, UploadError, saveUpload } = require('./upload');
const { checkCommandAvailability } = require('./availability');
const { ENGINE_BUILD_VERSION } = require('./build-version');
const { createCustomCommandProvider, parseCommand } = require('./custom-command');
const { PluginManager } = require('./plugin-manager');
const { createAgentSessionGuide } = require('./agent-session-guide');
const { PluginHttp } = require('./plugin-http');
const { MAX_BACKUP_BYTES, createBackup, previewBackup, restoreBackup } = require('./backup');

const HOOK_ROUTE_RE = /^\/hooks\/([^/]+)\/(start|stop|idle|session-start|session-end|menu|context)$/;
const MAX_SHOW_REQUEST_BYTES = MAX_CONTENT_BYTES * 6 + 16 * 1024;

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        tooLarge = true;
        body = '';
        reject(new Error('Request too large.'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendPromptResult(res, result) {
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  const timeout = result.error === 'timeout';
  sendJson(res, timeout ? 504 : 409, {
    ...result,
    message: timeout
      ? 'Prompt timed out.'
      : 'Session closed before the prompt was answered.',
  });
}

class HeadlessServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port ?? 4000);
    this.cwd = options.cwd || process.cwd();
    this.commands = {
      'claude-code': options.command || 'claude',
      ...(options.commands || {}),
    };
    this.providerOptions = options.providerOptions || {};
    this.availabilityService = options.availabilityService || checkCommandAvailability;
    this.directoryService = options.directoryService || { listDirectories, makeDirectory };
    this.openProjectPath = options.openProjectPath || openProjectPath;
    this.autoSaveMs = Math.max(0, Number(options.autoSaveMs ?? 30_000));
    this.now = options.now || (() => new Date().toISOString());
    this.autoSaveTimer = null;
    this.serverLock = options.serverLock || null;
    this.sessions = new Map();
    // Persistence and the CLI lock create the directory; capture first use before either does.
    const dataDir = options.dataDir || options.persistence?.dataDir || DEFAULT_DATA_DIR;
    const freshInstall = options.freshInstall ?? !existsSync(dataDir);
    this.persistence = options.persistence || new SessionPersistence({
      dataDir: options.dataDir,
      debounceMs: options.persistenceDebounceMs,
    });
    this.configStore = options.configStore || new ConfigStore({
      dataDir: options.dataDir || this.persistence.dataDir,
      freshInstall,
    });
    this.transcriptStore = options.transcriptStore || new TranscriptStore({
      dataDir: options.dataDir || this.persistence.dataDir,
      validIds: this.persistence.list().map((entry) => entry.id),
    });
    this.contentStore = options.contentStore || new ContentStore({
      dataDir: this.persistence.dataDir,
    });
    if (typeof this.contentStore.restoreSessions === 'function') {
      const repaired = this.contentStore.restoreSessions(this.persistence.list());
      for (const [sessionId, assets] of repaired) {
        this.persistence.setAssets(sessionId, assets);
      }
    }
    this.clients = new Set();
    this.pluginManager = options.pluginManager || new PluginManager({
      dataDir: this.persistence.dataDir,
      configStore: this.configStore,
      engineVersion: ENGINE_BUILD_VERSION,
      bundledDir: options.bundledPluginsDir,
      onChange: (plugins) => this.broadcast({ type: 'plugins', plugins }),
      onClientEvent: (event) => this.broadcast(event),
      onCoreCall: (pluginId, method, args) => this.pluginCoreCall(pluginId, method, args),
    });
    this.pluginHttp = new PluginHttp({
      host: this.host,
      manager: this.pluginManager,
      persistence: this.persistence,
      sessions: this.sessions,
    });
    this.askCoordinator = options.askCoordinator
      || new AskCoordinator((event) => this.broadcast(event));
    this.promptCoordinator = options.promptCoordinator
      || new PromptCoordinator((event) => this.broadcast(event));
    this.closing = false;
    this.closePromise = null;
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.webSocketServer = new WebSocketServer({
      server: this.httpServer,
      maxPayload: MAX_CONTROL_BYTES,
      verifyClient: ({ origin, req }) => (
        isAllowedWebSocketOrigin(origin, req.headers.host, this.host)
      ),
    });
    this.webSocketServer.on('connection', (socket) => this.handleConnection(socket));
  }

  async listen() {
    await this.pluginManager.start();
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off('error', reject);
        this.port = this.httpServer.address().port;
        this.startAutoSave();
        resolve(this.address());
      });
    });
  }

  address() {
    return {
      host: this.host,
      port: this.port,
      url: serverUrl(this.host, this.port).replace(/^http:/, 'ws:'),
      httpUrl: serverUrl(this.host, this.port),
    };
  }

  broadcast(event) {
    this.pluginManager?.emitCoreEvent?.(event);
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  startAutoSave() {
    if (this.autoSaveTimer || !this.autoSaveMs) return;
    this.autoSaveTimer = setInterval(() => this.saveState('auto'), this.autoSaveMs);
    this.autoSaveTimer.unref?.();
  }

  saveState(reason) {
    const count = this.persistence.list().length;
    if (!count) return null;
    let event;
    try {
      this.persistence.flush();
      event = {
        type: 'sessions.saved',
        success: true,
        reason,
        savedAt: this.now(),
        count,
      };
    } catch (error) {
      event = {
        type: 'sessions.saved',
        success: false,
        reason,
        savedAt: this.now(),
        count,
        error: error.message,
      };
    }
    this.broadcast(event);
    return event;
  }

  persistAssets(sessionId) {
    if (this.persistence.has(sessionId)) {
      this.persistence.setAssets(sessionId, this.contentStore.metadata(sessionId));
    }
  }

  publishContent(sessionId, content) {
    try {
      this.persistAssets(sessionId);
      this.broadcast({ type: 'content.show', ...content });
      return content;
    } catch (error) {
      this.contentStore.remove(sessionId, content.contentId);
      this.persistAssets(sessionId);
      throw error;
    }
  }

  async openContent(message) {
    const entry = this.persistence.get(message.sessionId);
    if (!entry) return false;
    try {
      const content = message.path
        ? await this.contentStore.addOpenFile(entry.id, message.path)
        : this.contentStore.addOpenPayload(
          entry.id,
          message.data,
          message.kind,
          message.name,
        );
      this.publishContent(entry.id, content);
      return true;
    } catch (error) {
      const known = error instanceof ContentError;
      this.broadcastSessionError(entry.id, {
        code: known ? error.code : 'content_failed',
        operation: 'content.open',
        ...(message.path ? { path: message.path } : { name: message.name }),
        message: known ? error.message : 'Could not open this content.',
      });
      return false;
    }
  }

  async resolveContent(message, socket) {
    const entry = this.persistence.get(message.sessionId);
    const candidates = message.paths.slice(0, MAX_RESOLVE_PATHS);
    const resolved = entry
      ? await this.contentStore.resolvePaths(entry.cwd, candidates)
      : Object.fromEntries(candidates.map((candidate) => [candidate, null]));
    this.sendControlResult(socket, {
      type: 'content.resolve.result',
      sessionId: message.sessionId,
      resolved,
    });
  }

  removeSessionState(sessionId) {
    this.contentStore.removeSession(sessionId);
    return this.persistence.remove(sessionId);
  }

  createSession(message = {}) {
    const customCommand = message.commandId
      ? this.getCustomCommand(message.commandId)
      : null;
    const provider = customCommand
      ? createCustomCommandProvider(customCommand)
      : getProvider(message.provider || 'claude-code');
    if (message.commandId && !customCommand) return null;
    if (!provider) return null;
    const cwd = message.cwd || this.cwd;
    const projectSpecified = Object.prototype.hasOwnProperty.call(message, 'projectId');
    if (projectSpecified && message.projectId && !this.getProject(message.projectId)) return null;
    const scope = {
      cwd,
      ...(projectSpecified && { projectId: message.projectId || null }),
    };
    const conflict = this.findNameConflict(message.name, scope);
    if (conflict) {
      this.broadcastSessionError(conflict.id, this.nameConflictError(
        'session.create',
        message.name,
        scope,
        conflict.id,
      ));
      return false;
    }
    return this.startSession({
      provider,
      name: message.name,
      providerOptions: this.providerLaunchOptions(provider.id),
      command: customCommand?.command || this.commands[provider.id],
      commandId: customCommand?.id,
      commandLabel: customCommand?.label,
      cwd,
      cols: message.cols,
      rows: message.rows,
      port: this.port,
      theme: message.theme,
      ...(projectSpecified && { projectId: message.projectId || null }),
    }, true);
  }

  resumeSession(sessionId, theme) {
    const id = String(sessionId || '');
    if (this.sessions.has(id)) return null;
    const entry = this.persistence.get(id);
    if (!entry) return null;
    const customCommand = entry.commandId ? this.getCustomCommand(entry.commandId) : null;
    const provider = customCommand
      ? createCustomCommandProvider(customCommand)
      : getProvider(entry.provider);
    if (entry.commandId && !customCommand) {
      this.broadcastSessionError(id, { code: 'command_unavailable', operation: 'session.resume',
        message: 'This session’s CLI agent command is missing or disabled. Restore its CLI Agents settings or enable the command in Settings.' });
      return null;
    }
    if (!provider) return null;
    const { providerOptions } = this.resumeLaunch(provider, entry);
    return this.startSession({
      id: entry.id,
      provider,
      name: entry.name,
      providerOptions,
      command: customCommand?.command || this.commands[provider.id],
      commandId: entry.commandId,
      commandLabel: entry.commandLabel || customCommand?.label,
      cwd: entry.cwd,
      cols: entry.cols,
      rows: entry.rows,
      port: this.port,
      theme,
      muted: entry.muted,
      lastAgentAt: entry.lastAgentAt,
      contextTranscriptPath: entry.transcriptPath,
      ...(hasProjectId(entry) && { projectId: entry.projectId }),
    }, false);
  }

  resumeLaunch(provider, entry) {
    const providerOptions = this.providerLaunchOptions(provider.id);
    delete providerOptions.resumeHandle;
    // Native CLIs resolve their own conversation IDs. A missing cached transcript
    // path (notably after a v1 import) must never silently turn Resume into New.
    const resumed = Boolean(entry.resumeHandle
      && (provider.id !== 'custom-command' || provider.canResume));
    if (resumed) providerOptions.resumeHandle = entry.resumeHandle;
    return { providerOptions, resumed };
  }

  providerLaunchOptions(providerId) {
    const config = this.configStore.get();
    const configured = config.providerArgs;
    const providerArgs = configured && typeof configured === 'object'
      ? parseCommand(configured[providerId] || '')
      : [];
    const defaults = this.providerOptions[providerId] || {};
    const extraArgs = [
      ...(Array.isArray(defaults.extraArgs) ? defaults.extraArgs : []),
      ...providerArgs,
    ];
    return {
      ...defaults,
      ...(extraArgs.length && { extraArgs }),
      agentGuide: createAgentSessionGuide(this.pluginManager.publicCommands(), config.about),
    };
  }

  pluginCoreCall(pluginId, method, args) {
    if (method === 'getSession') return this.sessionSnapshot(String(args[0] || ''));
    if (method === 'getSessions') {
      return this.persistence.list().map((entry) => this.sessionSnapshot(entry.id)).filter(Boolean);
    }
    if (method === 'getProjects') return this.configStore.get().projects;
    if (method === 'getTurns') {
      const count = Math.min(100, Math.max(1, Number(args[1] || 20)));
      return this.transcriptStore.getTurns(String(args[0] || ''), count);
    }
    if (method === 'sendPrompt') {
      const id = String(args[0] || '');
      const text = String(args[1] || '');
      if (!text.trim() || text.length > MAX_CONTROL_TEXT) throw new Error('Prompt is invalid.');
      const entry = this.persistence.get(id);
      const available = entry
        ? availableAskSession(entry, this.sessions, this.askCoordinator)
        : { error: 'unknown_session' };
      if (available.error) throw new Error(`Session is unavailable (${available.error}).`);
      available.session.sendPrompt(text);
      return true;
    }
    if (method === 'writeInput') {
      const session = this.targetSession({ sessionId: String(args[0] || '') });
      const data = String(args[1] || '');
      if (!session || data.length > MAX_CONTROL_TEXT) throw new Error('Session input is invalid.');
      session.writeInput(data);
      return true;
    }
    if (method === 'createSession') {
      const message = { type: 'session.create', ...(args[0] || {}) };
      if (!hasValidControlFields(message)) throw new Error('Session options are invalid.');
      const session = this.createSession(message);
      if (!session || session === false) throw new Error('Could not create the session.');
      return session.snapshot();
    }
    if (method === 'closeSession') {
      const id = String(args[0] || '');
      const session = this.targetSession({ sessionId: id });
      if (session) {
        session.deleteTranscriptOnClose = true;
        session.removePersistenceOnClose = true;
        session.close();
        return true;
      }
      if (!this.removeSessionState(id)) return false;
      this.transcriptStore.delete(id);
      this.broadcast({ type: 'session.closed', sessionId: id, exitCode: null, signal: null });
      return true;
    }
    if (method === 'showContent') {
      const sessionId = String(args[0] || '');
      const request = args[1];
      const entry = this.persistence.get(sessionId);
      if (!entry || !request || typeof request !== 'object') {
        throw new Error('Plugin content session is unavailable.');
      }
      const viewer = this.pluginManager.viewerType(pluginId, request.kind, request.mime);
      if (!viewer) throw new Error('Plugin content viewer is not declared.');
      const content = this.contentStore.addPluginPayload(
        sessionId,
        request.data,
        viewer.kind,
        request.name,
        viewer.mime,
      );
      return this.publishContent(sessionId, content);
    }
    throw new Error(`Unknown core plugin operation: ${method}`);
  }

  async restartSession(message) {
    const id = String(message.sessionId || '');
    const session = this.sessions.get(id);
    if (!session || session.closed) {
      if (this.persistence.has(id)) {
        this.broadcastSessionError(id, {
          code: 'session_not_live',
          operation: 'session.restart',
          message: 'Only a live session can be restarted.',
        });
      }
      return null;
    }
    if (session.restarting) {
      this.broadcastSessionError(id, {
        code: 'restart_in_progress',
        operation: 'session.restart',
        message: 'This session is already restarting.',
      });
      return null;
    }

    const entry = this.persistence.get(id);
    const { providerOptions, resumed } = this.resumeLaunch(session.provider, entry || {});
    const options = {
      id,
      provider: session.provider,
      name: session.name,
      providerOptions,
      command: session.command,
      commandId: session.commandId,
      commandLabel: session.commandLabel,
      cwd: session.cwd,
      cols: message.cols || session.cols,
      rows: message.rows || session.rows,
      port: this.port,
      theme: message.theme,
      muted: session.muted,
      lastAgentAt: session.lastAgentAt,
      contextTranscriptPath: entry?.transcriptPath,
      ...(hasProjectId(session) && { projectId: session.projectId }),
    };

    this.persistence.flushHistory(id);
    this.promptCoordinator.cancelSession(id);
    await session.stopForRestart();
    try {
      const restarted = this.startSession(
        options,
        false,
        { restarted: true, resumed },
        true,
      );
      this.persistence.update(id, { cols: restarted.cols, rows: restarted.rows }, true);
      return restarted;
    } catch (error) {
      this.broadcastSessionError(id, {
        code: 'restart_failed',
        operation: 'session.restart',
        message: error.message,
      });
      return null;
    }
  }

  startSession(options, register, createdFields = {}, throwOnError = false) {
    const session = new AgentSession({ ...options, serverUrl: this.address().httpUrl });
    this.sessions.set(session.id, session);
    if (register) this.persistence.register(session);
    const onEvent = (event) => {
      if (event.type === 'session.closed' && event.restarting) return;
      let outbound = event;
      if (event.type === 'output') this.persistence.appendHistory(session.id, event.data);
      else if (event.type === 'turn.user') this.storeTranscriptEntry(session.id, 'user', event.text);
      else if (event.type === 'agent.final') {
        this.persistence.recordFinal(session.id, event.text, event.at);
        this.storeTranscriptEntry(session.id, 'agent', event.text, event.at);
      } else if (event.type === 'session.closed') {
        this.promptCoordinator.cancelSession(session.id);
        if (session.removePersistenceOnClose) this.removeSessionState(session.id);
        else this.persistence.markClosed(session);
        if (session.deleteTranscriptOnClose) this.transcriptStore.delete(session.id);
        if (this.sessions.get(event.sessionId) === session) this.sessions.delete(event.sessionId);
        const entry = this.persistence.get(session.id);
        if (entry) outbound = this.dormantSnapshot(entry);
      } else if (event.type !== 'session.created') {
        this.persistence.touch(session.id);
      }
      this.broadcast(outbound);
    };
    session.on('event', onEvent);
    session.on('resume-metadata', (metadata) => {
      this.persistence.recordResumeMetadata(session.id, metadata);
    });
    try {
      session.start(createdFields);
    } catch (error) {
      this.sessions.delete(session.id);
      if (register) this.removeSessionState(session.id);
      if (!register && !throwOnError) return null;
      throw error;
    }
    return session;
  }

  storeTranscriptEntry(sessionId, role, text, timestamp) {
    const entry = this.transcriptStore.append(sessionId, role, text, timestamp);
    if (!entry) return null;
    this.broadcast({ type: 'transcript.append', id: sessionId, role, text: entry.text });
    return entry;
  }

  findNameConflict(name, scope, exceptId = '') {
    const wanted = String(name || '').trim().toLowerCase();
    if (!wanted) return null;
    return this.persistence.list().find((entry) => entry.id !== exceptId
      && sameSessionScope(entry, scope)
      && entry.name.trim().toLowerCase() === wanted) || null;
  }

  nameConflictError(operation, name, scope, conflictSessionId) {
    const value = String(name || '').trim();
    return {
      code: 'name_conflict',
      operation,
      field: 'name',
      value,
      cwd: scope.cwd,
      ...(hasProjectId(scope) && { projectId: scope.projectId }),
      conflictSessionId,
      message: `Session name "${value}" is already taken in this project.`,
    };
  }

  sessionSnapshot(id) {
    const session = this.sessions.get(String(id));
    if (session && !session.closed) return session.snapshot();
    const entry = this.persistence.get(id);
    return entry ? this.dormantSnapshot(entry) : null;
  }

  broadcastSessionError(id, error) {
    const snapshot = this.sessionSnapshot(id);
    if (snapshot) this.broadcast({ ...snapshot, error });
  }

  targetSession(message) {
    const session = this.sessions.get(String(message.sessionId || ''));
    if (session && !session.closed) return session;
    return null;
  }

  dormantSnapshot(entry) {
    return {
      type: 'session.created',
      sessionId: entry.id,
      protocol: 1,
      provider: entry.provider,
      name: entry.name,
      pid: null,
      cwd: entry.cwd,
      cols: entry.cols,
      rows: entry.rows,
      muted: entry.muted === true,
      live: false,
      lastActive: entry.lastActive,
      bracketedPaste: false,
      projectId: entry.projectId ?? null,
      ...(entry.lastAgentAt && { lastAgentAt: entry.lastAgentAt }),
      ...(entry.commandId && {
        commandId: entry.commandId,
        label: entry.commandLabel || '',
      }),
    };
  }

  getCustomCommand(id) {
    return this.configStore.get().commands.find((command) => (
      command.id === id && command.enabled
    )) || null;
  }

  getProject(id) {
    return this.configStore.get().projects.find((project) => project.id === id) || null;
  }

  setSessionProject(sessionId, projectId) {
    const id = String(sessionId || '');
    const entry = this.persistence.get(id);
    if (!entry) return false;
    const nextProjectId = projectId || null;
    if (nextProjectId && !this.getProject(nextProjectId)) {
      this.broadcastSessionError(id, {
        code: 'unknown_project',
        operation: 'session.setProject',
        projectId: nextProjectId,
        message: 'The selected project does not exist.',
      });
      return false;
    }
    const scope = { cwd: entry.cwd, projectId: nextProjectId };
    const conflict = this.findNameConflict(entry.name, scope, id);
    if (conflict) {
      this.broadcastSessionError(id, this.nameConflictError(
        'session.setProject',
        entry.name,
        scope,
        conflict.id,
      ));
      return false;
    }
    const session = this.sessions.get(id);
    if (session && !session.closed) session.projectId = nextProjectId;
    this.persistence.update(id, { projectId: nextProjectId }, true);
    this.broadcast(session && !session.closed
      ? session.snapshot()
      : this.dormantSnapshot({ ...entry, projectId: nextProjectId }));
    return true;
  }

  async deleteProject(id) {
    const project = this.getProject(id);
    if (!project) return false;
    const entries = this.persistence.list().filter((entry) => entry.projectId === id);
    const live = [];
    for (const entry of entries) {
      const session = this.sessions.get(entry.id);
      if (!session || session.closed) {
        if (session?.closed) this.sessions.delete(entry.id);
        if (this.removeSessionState(entry.id)) {
          this.transcriptStore.delete(entry.id);
          this.broadcast({
            type: 'session.closed', sessionId: entry.id, exitCode: null, signal: null,
          });
        }
        continue;
      }
      session.removePersistenceOnClose = true;
      session.deleteTranscriptOnClose = true;
      live.push({ entry, session, closed: session.waitForClose?.() || Promise.resolve() });
      session.close();
    }
    await Promise.all(live.map(({ closed }) => closed));
    for (const { entry, session } of live) {
      if (this.removeSessionState(entry.id)) {
        this.transcriptStore.delete(entry.id);
        this.broadcast({
          type: 'session.closed', sessionId: entry.id, exitCode: null, signal: null,
        });
      }
      if (session.closed) this.sessions.delete(entry.id);
    }
    const projects = this.configStore.get().projects.filter((value) => value.id !== id);
    this.broadcastConfig(this.configStore.update({ projects }));
    return true;
  }

  async checkAvailability(socket) {
    const providers = await Promise.all(listProviders().map(async (provider) => ({
      id: provider.id,
      ...await this.availabilityService(this.commands[provider.id] || provider.command),
    })));
    const commands = await Promise.all(this.configStore.get().commands.map(async (command) => ({
      id: command.id,
      label: command.label,
      enabled: command.enabled,
      ...await this.availabilityService(command.command, { env: command.env }),
    })));
    this.sendControlResult(socket, {
      type: 'availability.result', success: true, providers, commands,
    });
  }

  setSessionMute(sessionId, muted) {
    const id = String(sessionId || '');
    const entry = this.persistence.get(id);
    if (!entry) return false;
    const value = muted === true;
    const session = this.sessions.get(id);
    if (session && !session.closed) session.muted = value;
    this.persistence.update(id, { muted: value }, true);
    this.broadcast(session && !session.closed
      ? session.snapshot()
      : this.dormantSnapshot({ ...entry, muted: value }));
    return true;
  }

  sendControlResult(socket, event) {
    if (socket.readyState !== undefined && socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {}
  }

  async openProject(cwd, socket) {
    const known = this.persistence.list().some((entry) => entry.cwd === cwd);
    if (!known) {
      this.sendControlResult(socket, {
        type: 'project.open.result',
        cwd,
        success: false,
        code: 'unknown_cwd',
        error: 'This project folder is not known to CliDeck.',
        fallback: 'copy',
      });
      return;
    }
    const result = await this.openProjectPath(cwd);
    this.sendControlResult(socket, {
      type: 'project.open.result',
      cwd,
      ...result,
      ...(!result.success && { fallback: 'copy' }),
    });
  }

  async listDirectory(message, socket) {
    try {
      const result = await this.directoryService.listDirectories(
        message.path,
        message.showHidden,
      );
      this.sendControlResult(socket, {
        type: 'dirs.list.result',
        path: message.path,
        success: true,
        ...result,
      });
    } catch (error) {
      this.sendControlResult(socket, {
        type: 'dirs.list.result',
        path: message.path,
        success: false,
        entries: [],
        code: error.code || 'list_failed',
        error: error.message,
      });
    }
  }

  async createDirectory(message, socket) {
    try {
      const result = await this.directoryService.makeDirectory(message.parent, message.name);
      this.sendControlResult(socket, {
        type: 'dirs.mkdir.result',
        parent: message.parent,
        name: message.name,
        success: true,
        ...result,
      });
    } catch (error) {
      this.sendControlResult(socket, {
        type: 'dirs.mkdir.result',
        parent: message.parent,
        name: message.name,
        success: false,
        code: error.code || 'mkdir_failed',
        error: error.message,
      });
    }
  }

  sendConfig(socket, requestId = '') {
    this.sendControlResult(socket, {
      type: 'config', config: this.configForClient(this.configStore.get()),
      ...(typeof requestId === 'string' && requestId && { requestId }),
    });
  }

  configForClient(config) {
    const client = { ...config, version: ENGINE_BUILD_VERSION };
    delete client.plugins;
    return client;
  }

  broadcastConfig(config) {
    this.broadcast({ type: 'config', config: this.configForClient(config) });
  }

  updateConfig(config, socket) {
    try {
      const patch = { ...config };
      delete patch.version;
      if (Object.prototype.hasOwnProperty.call(patch, 'plugins')) {
        const error = new Error('Plugin settings must use plugin.settings.update.');
        error.code = 'reserved_config_key';
        throw error;
      }
      this.broadcastConfig(this.configStore.update(patch));
    } catch (error) {
      this.sendControlResult(socket, {
        type: 'config.update.result',
        success: false,
        code: error.code || 'config_write_failed',
        error: error.message,
      });
    }
  }

  pluginResult(socket, operation, success, fields = {}, requestId = '') {
    this.sendControlResult(socket, {
      type: 'plugin.result', operation, success, ...fields,
      ...(requestId && { requestId }),
    });
  }

  async managePlugin(message, socket) {
    try {
      if (message.type === 'plugins.refresh') {
        await this.pluginManager.refresh();
        this.pluginResult(socket, 'refresh', true, {}, message.requestId);
        return;
      }
      if (message.type === 'plugin.install') {
        const record = await this.pluginManager.install(message.path);
        this.pluginResult(socket, 'install', true, {
          pluginId: record.manifest.id,
        }, message.requestId);
        return;
      }
      if (message.type === 'plugin.remove') {
        const removed = await this.pluginManager.remove(message.pluginId);
        this.pluginResult(socket, 'remove', removed, {
          pluginId: message.pluginId,
          ...(!removed && { code: 'plugin_not_found', error: 'Plugin is not removable.' }),
        }, message.requestId);
        return;
      }
      if (message.type === 'plugin.setEnabled') {
        const changed = await this.pluginManager.setEnabled(message.pluginId, message.enabled);
        this.pluginResult(socket, 'setEnabled', changed, {
          pluginId: message.pluginId,
          ...(!changed && { code: 'plugin_not_found', error: 'Plugin is not installed.' }),
        }, message.requestId);
        return;
      }
      if (message.type === 'plugin.settings.update') {
        const changed = await this.pluginManager.updateSettings(message.pluginId, message.settings);
        this.pluginResult(socket, 'settings', changed, {
          pluginId: message.pluginId,
          ...(!changed && { code: 'invalid_plugin_settings', error: 'Plugin settings are invalid.' }),
        }, message.requestId);
      }
    } catch (error) {
      this.pluginResult(socket, message.type.split('.').pop(), false, {
        pluginId: message.pluginId,
        code: error.code || 'plugin_failed',
        error: error.message,
      }, message.requestId);
    }
  }

  async openPluginFolder(socket, requestId = '') {
    const result = await this.openProjectPath(this.pluginManager.pluginsDir);
    this.pluginResult(socket, 'openFolder', result.success, {
      path: this.pluginManager.pluginsDir,
      ...(!result.success && { code: result.code || 'open_failed', error: result.error }),
    }, requestId);
  }

  renameSession(sessionId, name) {
    const id = String(sessionId);
    const value = name.trim();
    const session = this.sessions.get(id);
    const entry = this.persistence.get(id);
    const scope = session || entry;
    if (!scope?.cwd) return false;
    const conflict = this.findNameConflict(value, scope, id);
    if (conflict) {
      this.broadcastSessionError(id, this.nameConflictError(
        'session.rename',
        value,
        scope,
        conflict.id,
      ));
      return false;
    }
    if (session && !session.closed) {
      session.name = value;
      this.persistence.update(id, { name: value }, true);
      this.broadcast(session.snapshot());
      return true;
    }
    if (!entry) return false;
    entry.name = value;
    this.persistence.update(id, { name: value }, true);
    this.broadcast(this.dormantSnapshot(entry));
    return true;
  }

  handleConnection(socket) {
    if (this.closing) {
      socket.close();
      return;
    }
    this.clients.add(socket);
    for (const entry of this.persistence.list()) {
      const session = this.sessions.get(entry.id);
      if (session && !session.closed) this.replayLiveSession(socket, session);
      else this.replayDormantSession(socket, entry);
    }
    socket.send(JSON.stringify({ type: 'plugins', plugins: this.pluginManager.snapshot() }));
    socket.send(JSON.stringify({ type: 'transcript.cache', cache: this.transcriptStore.getCache() }));

    socket.on('message', (raw) => {
      if (this.closing) return;
      try {
        this.handleControl(socket, raw);
      } catch {
        socket.close(1011, 'control failed');
      }
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  handleControl(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      socket.close(1003, 'invalid JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || typeof message.type !== 'string') {
      socket.close(1003, 'invalid control fields');
      return;
    }
    if (!isKnownControlType(message.type)) {
      socket.close(1003, 'unknown control message');
      return;
    }
    if (!hasValidControlFields(message)) {
      if (message.type === 'config.update') {
        this.sendControlResult(socket, {
          type: 'config.update.result',
          success: false,
          code: 'invalid_config',
          error: 'Invalid config update.',
        });
        return;
      }
      socket.close(1003, 'invalid control fields');
      return;
    }
    if (message.type === 'session.create') {
      if (this.createSession(message) === null) socket.close(1003, 'unknown provider');
      return;
    }
    if (message.type === 'session.resume') {
      this.resumeSession(message.sessionId, message.theme);
      return;
    }
    if (message.type === 'session.rename') {
      this.renameSession(message.sessionId, message.name);
      return;
    }
    if (message.type === 'session.restart') {
      this.restartSession(message).catch((error) => {
        this.broadcastSessionError(message.sessionId, {
          code: 'restart_failed',
          operation: 'session.restart',
          message: error.message,
        });
      });
      return;
    }
    if (message.type === 'session.mute') {
      this.setSessionMute(message.sessionId, message.muted);
      return;
    }
    if (message.type === 'session.setProject') {
      this.setSessionProject(message.sessionId, message.projectId);
      return;
    }
    if (message.type === 'project.delete') {
      this.deleteProject(message.id).catch(() => {});
      return;
    }
    if (message.type === 'project.open') {
      this.openProject(message.cwd, socket).catch((error) => {
        this.sendControlResult(socket, {
          type: 'project.open.result',
          cwd: message.cwd,
          success: false,
          code: 'open_failed',
          error: error.message,
          fallback: 'copy',
        });
      });
      return;
    }
    if (message.type === 'dirs.list') {
      this.listDirectory(message, socket);
      return;
    }
    if (message.type === 'dirs.mkdir') {
      this.createDirectory(message, socket);
      return;
    }
    if (message.type === 'config.get') {
      this.sendConfig(socket, message.requestId);
      return;
    }
    if (message.type === 'config.update') {
      this.updateConfig(message.config, socket);
      return;
    }
    if (message.type === 'checkAvailability') {
      this.checkAvailability(socket).catch((error) => {
        this.sendControlResult(socket, {
          type: 'availability.result',
          success: false,
          error: error.message,
          providers: [],
          commands: [],
        });
      });
      return;
    }
    if (message.type === 'plugins.refresh' || message.type === 'plugin.install'
      || message.type === 'plugin.remove' || message.type === 'plugin.setEnabled'
      || message.type === 'plugin.settings.update') {
      this.managePlugin(message, socket);
      return;
    }
    if (message.type === 'plugin.openFolder') {
      this.openPluginFolder(socket, message.requestId).catch((error) => this.pluginResult(socket, 'openFolder', false, {
        code: 'open_failed', error: error.message,
      }, message.requestId));
      return;
    }
    if (message.type === 'plugin.message') {
      const accepted = this.pluginManager.clientMessage(
        message.pluginId,
        message.event,
        message.data,
        {
          requestId: message.requestId,
          reply: (event) => this.sendControlResult(socket, event),
        },
      );
      if (!accepted) {
        this.pluginResult(socket, 'message', false, {
          pluginId: message.pluginId,
          code: 'plugin_unavailable',
          error: 'Plugin is unavailable.',
        }, message.requestId);
      } else {
        this.pluginResult(socket, 'message', true, {
          pluginId: message.pluginId,
        }, message.requestId);
      }
      return;
    }
    if (message.type === 'prompt.answer') {
      this.promptCoordinator.answer(message.promptId, message.value);
      return;
    }
    if (message.type === 'transcript.page') {
      if (!this.persistence.has(message.sessionId)) {
        this.sendControlResult(socket, {
          type: 'transcript.page.result',
          sessionId: message.sessionId,
          before: message.before ?? null,
          success: false,
          error: 'Unknown session.',
        });
        return;
      }
      this.sendControlResult(socket, {
      type: 'transcript.page.result',
        sessionId: message.sessionId,
        before: message.before ?? null,
        success: true,
        ...this.transcriptStore.getPage(message.sessionId, message.before, message.limit),
      });
      return;
    }
    if (message.type === 'content.open') {
      this.openContent(message).catch(() => {});
      return;
    }
    if (message.type === 'content.resolve') {
      this.resolveContent(message, socket).catch(() => {
        this.sendControlResult(socket, {
          type: 'content.resolve.result',
          sessionId: message.sessionId,
          resolved: {},
        });
      });
      return;
    }
    if (message.type === 'content.close') {
      const removed = this.contentStore.remove(message.sessionId, message.contentId);
      if (removed) {
        this.persistAssets(message.sessionId);
      }
      this.broadcast({
        type: 'content.closed',
        sessionId: message.sessionId,
        contentId: message.contentId,
      });
      return;
    }

    const session = this.targetSession(message);
    if (!session) {
      if (message.type === 'session.close' && this.removeSessionState(message.sessionId)) {
        this.transcriptStore.delete(message.sessionId);
        this.broadcast({
          type: 'session.closed',
          sessionId: message.sessionId,
          exitCode: null,
          signal: null,
        });
      }
      return;
    }
    if (message.type === 'prompt') session.sendPrompt(message.text);
    else if (message.type === 'input') session.writeInput(message.data);
    else if (message.type === 'resize') {
      session.resize(message.cols, message.rows);
      this.persistence.touch(session.id, { cols: session.cols, rows: session.rows });
    } else if (message.type === 'session.close') {
      session.deleteTranscriptOnClose = true;
      session.removePersistenceOnClose = true;
      session.close();
    }
    if (message.type === 'prompt' || message.type === 'input') this.persistence.touch(session.id);
  }

  replayLiveSession(socket, session) {
    socket.send(JSON.stringify(session.snapshot()));
    const history = this.persistence.historyTail(session.id);
    if (history) socket.send(JSON.stringify({ type: 'output', sessionId: session.id, data: history, replay: true }));
    this.replayContent(socket, session.id).catch(() => {});
    if (session.status) {
      socket.send(JSON.stringify({
        type: 'status',
        sessionId: session.id,
        state: session.status,
        ...(session.contextUsage !== undefined && { contextUsage: session.contextUsage }),
      }));
    }
    if (session.latestUpdate) {
      socket.send(JSON.stringify({
        type: 'agent.update',
        sessionId: session.id,
        text: session.latestUpdate,
      }));
    }
    if (session.menu.length) {
      socket.send(JSON.stringify({
        type: 'menu',
        sessionId: session.id,
        choices: session.menu,
        context: session.menuContext,
      }));
    }
  }

  replayDormantSession(socket, entry) {
    socket.send(JSON.stringify(this.dormantSnapshot(entry)));
    if (entry.lastFinal) {
      socket.send(JSON.stringify({ type: 'agent.update', sessionId: entry.id, text: entry.lastFinal }));
    }
    const history = this.persistence.historyTail(entry.id);
    if (history) socket.send(JSON.stringify({ type: 'output', sessionId: entry.id, data: history, replay: true }));
    this.replayContent(socket, entry.id).catch(() => {});
  }

  async replayContent(socket, sessionId) {
    const { events, changed } = await this.contentStore.replay(sessionId);
    if (changed) this.persistAssets(sessionId);
    if (socket.readyState !== WebSocket.OPEN) return;
    for (const event of events) {
      const content = this.contentStore.get(event.contentId);
      if (!content || content.sessionId !== String(sessionId)) continue;
      socket.send(JSON.stringify({ type: 'content.show', ...event, replay: true }));
    }
  }

  async handleHttp(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method === 'POST' && ['/api/session/backup', '/api/session/restore/preview', '/api/session/restore'].includes(pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!isLoopbackAddress(req.socket?.remoteAddress)
        || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, { error: 'local_only' });
        return;
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        sendJson(res, 415, { error: 'Send a JSON backup.' });
        return;
      }
      try {
        const body = await readJson(req, MAX_BACKUP_BYTES + 64 * 1024);
        if (pathname === '/api/session/backup') {
          const backup = createBackup(this, body.browser);
          res.setHeader('Content-Disposition', `attachment; filename="clideck-backup-${backup.createdAt.replace(/[:.]/g, '-')}.json"`);
          sendJson(res, 200, backup);
        } else if (pathname.endsWith('/preview')) {
          sendJson(res, 200, previewBackup(this, body.backup));
        } else {
          if (this.restoringBackup) { sendJson(res, 409, { error: 'A restore is already in progress.' }); return; }
          this.restoringBackup = true;
          try {
            const result = restoreBackup(this, body.backup, body.selection);
            if (body.selection.settings.includes('plugins')) {
              try { await this.pluginManager.applySavedSettings(); }
              catch { result.warnings.push('Plugin settings were saved. Restart CliDeck to apply them.'); }
            }
            sendJson(res, 200, result);
          } finally { this.restoringBackup = false; }
        }
      } catch (error) {
        sendJson(res, 400, { error: error instanceof SyntaxError ? 'This file is not valid JSON.' : error.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/backup') {
      if (!isLoopbackAddress(req.socket?.remoteAddress)
        || !isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)
        || req.headers['sec-fetch-site'] === 'cross-site') {
        sendJson(res, 403, { error: 'local_only' });
        return;
      }
      const createdAt = new Date().toISOString();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="clideck-sessions-${createdAt.replace(/[:.]/g, '-')}.json"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify({
        format: 'clideck-session-backup', version: 1, createdAt,
        sessions: this.persistence.list(),
        projects: this.configStore.get().projects || [],
      }, null, 2));
      return;
    }
    if (await this.pluginHttp.handle(req, res, pathname)) return;
    if (req.method === 'POST' && (pathname === '/ask' || pathname === '/api/session/ask')) {
      await this.handleAsk(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/prompt') {
      await this.handlePrompt(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/annotate') {
      await this.handleAnnotate(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/show') {
      await this.handleShow(req, res);
      return;
    }
    if (req.method === 'PUT' && pathname === '/upload') {
      await this.handleUpload(req, res);
      return;
    }
    const contentMatch = req.method === 'GET'
      ? pathname.match(/^\/content\/([A-Za-z0-9_-]+)$/)
      : null;
    if (contentMatch) {
      await this.handleContent(req, res, contentMatch[1]);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/session/agents') {
      this.handleAgents(req, res);
      return;
    }
    if (req.method === 'GET') {
      if (await servePluginStatic(req, res, this.pluginManager)) return;
      await serveStatic(req, res);
      return;
    }

    const match = req.method === 'POST' ? req.url.match(HOOK_ROUTE_RE) : null;
    const session = match ? this.sessions.get(match[1]) : null;
    if (!match || !session) {
      res.writeHead(404).end();
      return;
    }

    // A restarted terminal reuses its CliDeck ID; hooks from the old process do not.
    if (session.provider.id === 'codex' && req.headers['x-clideck-launch'] !== session.hookToken) {
      res.writeHead(204).end();
      return;
    }

    try {
      const payload = await readJson(req);
      // Clear the previous conversation before attaching this hook's new
      // transcript, or the clear handler would stop the new context monitor.
      session.handleHook(match[2], payload);
      const resumeMetadata = session.provider.resumeMetadata?.(payload);
      if (resumeMetadata) {
        session.recordResumeMetadata(resumeMetadata);
        this.persistence.recordResumeMetadata(session.id, resumeMetadata);
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  }

  async handleAsk(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return;
    }
    let request;
    try {
      request = parseAskRequest(await readJson(req, MAX_CONTROL_TEXT + 1024));
    } catch {
      request = null;
    }
    if (!request) {
      sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return;
    }

    const entries = this.persistence.list();
    const caller = request.callerSessionId
      ? resolveLiveCaller(entries, this.sessions, request.callerSessionId) : null;
    if (request.callerSessionId && !caller) {
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_caller',
        message: 'Caller session is not active.',
      });
      return;
    }
    const candidates = caller
      ? entries.filter((entry) => entry.id !== caller.entry.id)
      : entries;
    const projects = this.configStore.get().projects;
    const resolved = resolveAskTarget(candidates, request.target, {
      caller: caller?.entry,
      projects,
    });
    const targets = listAskTargets(candidates, this.sessions, projects);
    if (resolved.error === 'unknown_target' || resolved.error === 'unknown_project') {
      sendJson(res, 404, {
        ok: false, error: resolved.error, message: resolved.message, targets,
      });
      return;
    }
    if (resolved.error) {
      sendJson(res, 409, {
        ok: false,
        error: resolved.error,
        candidateIds: resolved.candidateIds,
        candidateProjectIds: resolved.candidateProjectIds,
        message: resolved.message,
        targets,
      });
      return;
    }
    const available = request.steer
      ? availableSteerSession(resolved.entry, this.sessions, this.askCoordinator)
      : availableAskSession(resolved.entry, this.sessions, this.askCoordinator);
    if (available.error) {
      sendJson(res, 409, {
        ok: false,
        error: available.error,
        ...(available.error === 'busy' && available.steerable && {
          message: 'Target session is working. Re-run with --steer to inject this message now.',
        }),
      });
      return;
    }

    const source = caller ? { fromId: caller.entry.id, fromName: caller.entry.name || '' } : undefined;
    const text = caller
      ? `[CliDeck ${request.steer ? 'steer' : 'ask'} from ${sessionAddress(caller.entry, projects)}]\n\n${request.text}`
      : request.text;
    if (request.steer) {
      const result = this.askCoordinator.steer(available.session, text, source);
      sendJson(res, result.ok ? 200 : 409, result);
      return;
    }
    const result = await this.askCoordinator.ask(
      available.session,
      text,
      request.timeoutMs,
      source,
    );
    const statusCode = result.ok ? 200
      : result.error === 'timeout' ? 504
        : ['busy', 'unavailable', 'target_closed'].includes(result.error) ? 409 : 500;
    sendJson(res, statusCode, result);
  }

  async handlePrompt(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return;
    }
    let request;
    try {
      request = parsePromptRequest(await readJson(req));
    } catch {
      request = null;
    }
    if (!request) {
      sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return;
    }
    const caller = resolveLiveCaller(
      this.persistence.list(),
      this.sessions,
      request.sessionId,
    );
    if (!caller) {
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_session',
        message: 'Caller session is not active.',
      });
      return;
    }
    sendPromptResult(res, await this.promptCoordinator.prompt(
      caller.entry.id,
      { question: request.question, options: request.options },
      request.timeoutMs,
    ));
  }

  async handleAnnotate(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return;
    }
    let request;
    try {
      request = parseAnnotateRequest(await readJson(req));
    } catch {
      request = null;
    }
    if (!request) {
      sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return;
    }
    const caller = resolveLiveCaller(
      this.persistence.list(),
      this.sessions,
      request.sessionId,
    );
    if (!caller) {
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_session',
        message: 'Caller session is not active.',
      });
      return;
    }
    let content;
    try {
      content = await this.contentStore.addImage(
        caller.entry.id,
        caller.entry.cwd,
        request.path,
      );
      sendPromptResult(res, await this.promptCoordinator.prompt(
        caller.entry.id,
        {
          annotate: {
            contentId: content.contentId,
            url: content.url,
            name: content.name,
          },
        },
        request.timeoutMs,
      ));
    } catch (error) {
      const known = error instanceof ContentError;
      sendJson(res, known ? error.status : 500, {
        ok: false,
        error: known ? error.code : 'annotate_failed',
        message: known ? error.message : 'Could not annotate this image.',
      });
    } finally {
      if (content) this.contentStore.remove(caller.entry.id, content.contentId);
    }
  }

  async handleUpload(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      req.resume();
      sendJson(res, 400, { ok: false, error: 'invalid_request' });
      return;
    }
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    const name = url.searchParams.get('name');
    const caller = resolveLiveCaller(this.persistence.list(), this.sessions, sessionId);
    if (!caller) {
      req.resume();
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_session',
        message: 'Caller session is not active.',
      });
      return;
    }
    const declaredSize = Number(req.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_UPLOAD_BYTES) {
      req.resume();
      sendJson(res, 413, {
        ok: false,
        error: 'too_large',
        message: 'Upload exceeds the 100MB limit.',
      });
      return;
    }
    try {
      const upload = await saveUpload(req, caller.entry.cwd, name);
      const event = { type: 'upload.done', sessionId: caller.entry.id, ...upload };
      this.broadcast(event);
      sendJson(res, 200, { ok: true, path: upload.path, name: upload.name });
    } catch (error) {
      req.resume();
      const known = error instanceof UploadError;
      sendJson(res, known ? error.status : 500, {
        ok: false,
        error: known ? error.code : 'upload_failed',
        message: known ? error.message : 'Could not save this upload.',
      });
    }
  }

  async handleShow(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      sendJson(res, 403, { ok: false, error: 'origin_forbidden' });
      return;
    }

    let request;
    try {
      request = await readJson(req, MAX_SHOW_REQUEST_BYTES);
    } catch (error) {
      if (error.message === 'request too large') {
        sendJson(res, 413, {
          ok: false,
          error: 'too_large',
          message: 'Content payload exceeds the 2MB limit.',
        });
        return;
      }
      request = null;
    }
    const validBase = request && typeof request === 'object' && !Array.isArray(request)
      && typeof request.sessionId === 'string' && request.sessionId.trim()
      && request.sessionId.length <= 200 && !request.sessionId.includes('\0');
    const hasPath = typeof request?.path === 'string';
    const hasPayload = typeof request?.payload === 'string';
    const validPath = hasPath && request.path.trim()
      && request.path.length <= 4096 && !request.path.includes('\0');
    const validKind = request?.kind === undefined
      || (typeof request.kind === 'string' && request.kind.trim()
        && request.kind.length <= 32 && !request.kind.includes('\0'));
    const validPayload = hasPayload
      && typeof request.kind === 'string' && request.kind.trim()
      && typeof request.name === 'string' && request.name.trim()
      && request.name.length <= 255 && !request.name.includes('\0');
    if (!validBase || hasPath === hasPayload || !validKind
      || (hasPath ? !validPath : !validPayload)) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_request',
        message: 'Provide one content path, or a named and typed payload.',
      });
      return;
    }

    const caller = resolveLiveCaller(
      this.persistence.list(),
      this.sessions,
      request.sessionId,
    );
    if (!caller) {
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_session',
        message: 'Caller session is not active.',
      });
      return;
    }

    try {
      const content = hasPayload
        ? this.contentStore.addPayload(
          caller.entry.id,
          request.payload,
          request.kind,
          request.name,
        )
        : await this.contentStore.addFile(
          caller.entry.id,
          caller.entry.cwd,
          request.path,
          request.kind,
        );
      this.publishContent(caller.entry.id, content);
      sendJson(res, 200, { ok: true, ...content });
    } catch (error) {
      const known = error instanceof ContentError;
      sendJson(res, known ? error.status : 500, {
        ok: false,
        error: known ? error.code : 'content_failed',
        message: known ? error.message : 'Could not show this content.',
      });
    }
  }

  async handleContent(req, res, contentId) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    if (!isAllowedWebSocketOrigin(req.headers.origin, req.headers.host, this.host)) {
      res.writeHead(403).end();
      return;
    }
    const content = this.contentStore.get(contentId);
    if (!content) {
      res.writeHead(404).end();
      return;
    }
    const served = await serveContent(req, res, content);
    if (!served && content.persistent) {
      this.contentStore.remove(content.sessionId, contentId);
      this.persistAssets(content.sessionId);
    }
  }

  handleAgents(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'local_only' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const callerSessionId = String(url.searchParams.get('callerSessionId') || '').trim();
    if (!callerSessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'missing_caller',
        message: 'CLIDECK_SESSION_ID is required.',
      });
      return;
    }
    const entries = this.persistence.list();
    const caller = resolveLiveCaller(entries, this.sessions, callerSessionId);
    if (!caller) {
      sendJson(res, 404, {
        ok: false,
        error: 'unknown_caller',
        message: 'Caller session is not active.',
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      agents: listSessionAgents(
        entries,
        this.sessions,
        this.askCoordinator,
        caller,
        this.configStore.get().projects,
        { all: url.searchParams.get('all') === 'true' },
      ),
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.autoSaveTimer);
    this.autoSaveTimer = null;
    this.closePromise = (async () => {
      try {
        const sessions = [...this.sessions.values()];
        const closed = sessions.map((session) => session.waitForClose?.() || Promise.resolve());
        for (const session of sessions) session.close();
        await Promise.all(closed);
        await this.pluginManager.close();
        this.saveState('shutdown');
        for (const client of this.clients) client.close();
        await new Promise((resolve) => {
          this.webSocketServer.close(() => this.httpServer.close(resolve));
        });
      } finally {
        try {
          this.persistence.close();
        } finally {
          this.serverLock?.release();
        }
      }
    })();
    return this.closePromise;
  }
}

function parseArgs(argv, env = process.env) {
  const options = {};
  const flags = { '--port': 'port', '--host': 'host', '--cwd': 'cwd', '--command': 'command', '--data-dir': 'dataDir' };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, ...inline] = argv[index].split('=');
    if (!flags[flag]) throw new Error(`Unknown option: ${flag}`);
    const value = inline.length ? inline.join('=') : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    options[flags[flag]] = value;
  }
  const port = options.port ?? (env.CLIDECK_PORT || env.PORT);
  if (port !== undefined) {
    if (!/^\d+$/.test(port) || Number(port) > 65535) {
      throw new Error('Port must be an integer from 0 to 65535.');
    }
    options.port = Number(port);
  }
  return options;
}

function createShutdown(server, exit = (code) => process.exit(code)) {
  let shutdownPromise = null;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = server.close().then(
      () => exit(0),
      () => exit(1),
    );
    return shutdownPromise;
  };
}

function installShutdownHandlers(server, runtime = process) {
  const shutdown = createShutdown(server, (code) => runtime.exit(code));
  runtime.once('SIGINT', shutdown);
  runtime.once('SIGTERM', shutdown);
  return shutdown;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  const host = options.host || '127.0.0.1';
  const port = Number(options.port ?? 4000);
  if (!isLoopbackHost(host)) {
    throw new Error(`CliDeck v2 is localhost-only; refusing non-loopback host "${host}".`);
  }
  const freshInstall = !existsSync(options.dataDir || DEFAULT_DATA_DIR);
  const lock = new ServerLock({ dataDir: options.dataDir || DEFAULT_DATA_DIR });
  const acquired = lock.acquire({ host, port, url: serverUrl(host, port) });
  if (!acquired.ok) {
    const url = acquired.lock?.url || serverUrl(host, acquired.lock?.port || port);
    console.log(alreadyRunningLine(url, process.stdout.isTTY));
    return { alreadyRunning: true, lock: acquired.lock };
  }

  let server;
  let address;
  try {
    if (!options.dataDir || require('path').resolve(options.dataDir) === DEFAULT_DATA_DIR) {
      const migrated = require('./legacy-migration').migrateLegacy({ dataDir: options.dataDir || DEFAULT_DATA_DIR });
      if (migrated) console.log(`Imported ${migrated.sessions} legacy CliDeck sessions. Resume them from the sidebar.`);
    }
    server = new HeadlessServer({ ...options, serverLock: lock, freshInstall });
    address = await server.listen();
  } catch (error) {
    server?.persistence.close();
    lock.release();
    throw error;
  }
  lock.update({ host: address.host, port: address.port, url: address.httpUrl });
  console.log(startupBanner({
    version: ENGINE_BUILD_VERSION, url: address.httpUrl, isTTY: process.stdout.isTTY,
  }));
  installShutdownHandlers(server);
  return { server, address, lock };
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  HeadlessServer,
  createShutdown,
  installShutdownHandlers,
  main,
  parseArgs,
};

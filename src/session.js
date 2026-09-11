const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { delimiter, join } = require('path');
const pty = require('./pty');
const { Screen } = require('./screen');
const { hasNonemptyFile, waitForNonemptyFile } = require('./transcript-file');
const { augmentedPath } = require('./custom-command');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const TRANSCRIPT_READY_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 1500;
const OUTPUT_BATCH_MS = 100;
const COLORFGBG_BY_THEME = {
  light: '0;15',
  dark: '15;0',
};

function sessionEnvironment(launchEnv, sessionId, port, colorfgbg, serverUrl = `http://127.0.0.1:${port}`) {
  return {
    ...process.env,
    ...launchEnv,
    PATH: [join(__dirname, 'bin'), augmentedPath(launchEnv?.PATH || process.env.PATH)].join(delimiter),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLIDECK_NEXT_SESSION_ID: sessionId,
    CLIDECK_SESSION_ID: sessionId,
    CLIDECK_PORT: String(port),
    CLIDECK_URL: serverUrl,
    ...(colorfgbg && { COLORFGBG: colorfgbg }),
  };
}

class AgentSession extends EventEmitter {
  constructor(options) {
    super();
    this.provider = options.provider;
    if (!this.provider) throw new Error('provider is required');
    this.id = options.id || randomUUID();
    this.name = typeof options.name === 'string' ? options.name.trim() : '';
    this.command = options.command || this.provider.command;
    this.commandId = options.commandId || '';
    this.commandLabel = options.commandLabel || '';
    if (Object.prototype.hasOwnProperty.call(options, 'projectId')) {
      this.projectId = options.projectId || null;
    }
    this.cwd = options.cwd || process.cwd();
    this.cols = Number(options.cols || 120);
    this.rows = Number(options.rows || 40);
    this.port = options.port;
    this.serverUrl = options.serverUrl || `http://127.0.0.1:${this.port}`;
    this.muted = options.muted === true;
    this.lastAgentAt = Number(options.lastAgentAt) || null;
    this.now = options.now || Date.now;
    this.colorfgbg = COLORFGBG_BY_THEME[options.theme];
    this.screen = new Screen(this.cols, this.rows);
    this.userPrompts = [];
    this.status = null;
    this.menu = [];
    this.menuContext = '';
    this.menuKey = JSON.stringify({ choices: [], context: '' });
    this.turnOpen = false;
    this.pendingFinal = false;
    this.pendingFinalText = '';
    this.baselineCandidate = '';
    this.lastUpdate = '';
    this.latestUpdate = '';
    this.closed = false;
    this.sessionStarted = !this.provider.requiresSessionStart;
    this.submitTimer = null;
    this.submitRetryTimer = null;
    this.promptSubmitDelay = options.promptSubmitDelay
      || ((length) => Math.min(1500, Math.max(250, 200 + Math.ceil(length / 100) * 75)));
    this.submitRetryMs = Number(options.submitRetryMs ?? 1500);
    this.activityTimer = null;
    this.outputBuffer = '';
    this.outputTimer = null;
    this.lastOutputFlushAt = 0;
    this.screenBuffer = '';
    this.terminalModeBuffer = '';
    this.terminalModeTail = '';
    this.bracketedPasteMode = false;
    this.outputBatchMs = Number(options.outputBatchMs ?? OUTPUT_BATCH_MS);
    this.closeKillTimer = null;
    this.launchOptions = options.providerOptions || {};
    this.launchCleanup = () => {};
    this.terminal = null;
    this.closeRequested = false;
    this.closeSubmitted = false;
    this.resumeTranscriptPath = '';
    this.contextUsage = undefined;
    this.model = null;
    this.hookToken = randomUUID();
    this.activeHookTurn = '';
    this.completedHookTurns = new Set();
    this.contextTranscriptPath = String(options.contextTranscriptPath || '');
    this.stopContextMonitor = () => {};
    this.resumeHandle = String(this.launchOptions.resumeHandle || '');
    this.resumeOutput = '';
    this.transcriptWaitMs = Number(options.transcriptWaitMs ?? TRANSCRIPT_READY_TIMEOUT_MS);
    this.closeGraceMs = Number(options.closeGraceMs ?? CLOSE_GRACE_MS);
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  start(createdFields = {}) {
    const launch = this.provider.createLaunch({
      ...this.launchOptions,
      command: this.command,
      cwd: this.cwd,
      port: this.port,
      serverUrl: this.serverUrl,
      sessionId: this.id,
      hookToken: this.hookToken,
    });
    const extraArgs = Array.isArray(this.launchOptions.extraArgs)
      ? this.launchOptions.extraArgs.filter((value) => typeof value === 'string')
      : [];
    this.launchCleanup = launch.cleanup || (() => {});
    try {
      this.terminal = pty.spawn(launch.command, [...extraArgs, ...(launch.args || [])], {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: sessionEnvironment(launch.env, this.id, this.port, this.colorfgbg, this.serverUrl),
      });
    } catch (error) {
      this.launchCleanup();
      throw error;
    }

    this.terminal.onData((data) => this.handleOutput(data));
    this.terminal.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal));
    this.attachContextMonitor(this.contextTranscriptPath);
    this.emitProtocol('session.created', {
      protocol: 1,
      provider: this.provider.id,
      name: this.name,
      pid: this.terminal.pid,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      muted: this.muted,
      live: true,
      bracketedPaste: this.bracketedPasteMode,
      projectId: this.projectId ?? null,
      ...(this.lastAgentAt && { lastAgentAt: this.lastAgentAt }),
      ...(this.contextUsage !== undefined && { contextUsage: this.contextUsage }),
      ...(this.commandId && { commandId: this.commandId, label: this.commandLabel }),
      ...createdFields,
    });
  }

  emitProtocol(type, fields = {}) {
    if (type !== 'output') this.flushPending();
    this.emit('event', { type, sessionId: this.id, ...fields });
  }

  queueOutput(data, includeScreen) {
    this.outputBuffer += data;
    this.terminalModeBuffer += data;
    if (includeScreen) this.screenBuffer += data;
    if (this.outputTimer) return;
    const delay = this.outputBatchMs - (Date.now() - this.lastOutputFlushAt);
    if (delay <= 0) {
      this.flushPending();
      return;
    }
    this.outputTimer = setTimeout(() => this.flushPending(), delay);
    this.outputTimer.unref?.();
  }

  flushPending() {
    const hadOutput = Boolean(this.outputBuffer);
    this.flushOutput();
    this.flushTerminalModes();
    this.flushScreen();
    if (hadOutput) this.lastOutputFlushAt = Date.now();
  }

  flushOutput() {
    clearTimeout(this.outputTimer);
    this.outputTimer = null;
    if (!this.outputBuffer) return;
    const data = this.outputBuffer;
    this.outputBuffer = '';
    this.emit('event', { type: 'output', sessionId: this.id, data });
  }

  flushScreen() {
    if (!this.screenBuffer) return;
    const data = this.screenBuffer;
    this.screenBuffer = '';
    this.screen.write(data);
    this.analyzeScreen();
    this.settlePendingFinal();
    this.submitCloseIfReady();
  }

  flushTerminalModes() {
    if (!this.terminalModeBuffer) return;
    const previous = this.bracketedPasteMode;
    const data = `${this.terminalModeTail}${this.terminalModeBuffer}`;
    this.terminalModeBuffer = '';
    for (const match of data.matchAll(/\x1b(?:\[\?([0-9;]*)([hl])|c)/g)) {
      if (match[0] === '\x1bc') this.bracketedPasteMode = false;
      else if (match[1].split(';').includes('2004')) this.bracketedPasteMode = match[2] === 'h';
    }
    this.terminalModeTail = data.slice(-64);
    if (this.bracketedPasteMode !== previous) this.emit('event', this.snapshot());
  }

  emitAgentUpdate(text) {
    this.latestUpdate = text;
    this.emitProtocol('agent.update', { text });
  }

  setStatus(state) {
    if (state !== 'working' && state !== 'idle') return;
    if (state === 'working') clearTimeout(this.submitRetryTimer);
    if (this.status === state) return;
    this.status = state;
    this.emitProtocol('status', {
      state,
      model: this.model,
      ...(this.contextUsage !== undefined && { contextUsage: this.contextUsage }),
    });
  }

  setContextUsage(usage) {
    if (usage !== null && (!usage || typeof usage !== 'object')) return;
    const previous = this.contextUsage;
    const signature = (value) => value === null ? 'null' : value && [
      value.usedTokens, value.windowTokens, value.percent, value.estimated,
    ].join(':');
    if (signature(previous) === signature(usage)) return;
    this.contextUsage = usage;
    if (this.status) this.emitProtocol('status', { state: this.status, contextUsage: usage });
  }

  setModel(value) {
    if (typeof value !== 'string' || !value.trim()) return;
    const model = value.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
    if (model === this.model) return;
    this.model = model;
    if (this.status) this.emitProtocol('status', { state: this.status, model });
  }

  attachContextMonitor(path) {
    const value = String(path || '').trim();
    if (!value || !this.provider.watchContextUsage || value === this.contextTranscriptPathActive) return;
    this.stopContextMonitor();
    this.contextTranscriptPathActive = value;
    this.stopContextMonitor = this.provider.watchContextUsage(
      value,
      (usage) => this.setContextUsage(usage),
    );
  }

  currentCandidate() {
    if (!this.provider.screen) return '';
    const { latestAgentText, stripMenu } = this.provider.screen;
    const lines = this.menu.length ? stripMenu(this.screen.lines()) : this.screen.lines();
    return latestAgentText(lines, this.userPrompts);
  }

  analyzeScreen() {
    if (!this.provider.screen) return;
    const { detectMenuDetails, latestAgentText, stripMenu, hasInputPrompt } = this.provider.screen;
    const lines = this.screen.lines();
    // Codex starts its native hooks lazily on the first prompt. Its branded
    // startup banner can supply the initial model; subsequent hooks own updates.
    if (!this.model) this.setModel(this.provider.screen.startupModel?.(lines));
    const menu = detectMenuDetails(lines);
    const menuKey = JSON.stringify(menu);
    if (menuKey !== this.menuKey) {
      this.menu = menu.choices;
      this.menuContext = menu.context;
      this.menuKey = menuKey;
      this.emitProtocol('menu', {
        choices: menu.choices,
        ...(menu.choices.length && { context: menu.context }),
      });
      if (menu.choices.length) this.setStatus('idle');
    }

    if (this.sessionStarted && this.status === null && hasInputPrompt(lines)) {
      this.setStatus('idle');
    }

    if (!this.turnOpen) return;
    if (this.provider.streamsAgentTextFromScreen === false) return;
    const candidate = latestAgentText(menu.choices.length ? stripMenu(lines) : lines, this.userPrompts);
    if (!candidate || candidate === this.baselineCandidate || candidate === this.lastUpdate) return;
    this.lastUpdate = candidate;
    this.emitAgentUpdate(candidate);
  }

  handleOutput(data) {
    this.queueOutput(data, Boolean(this.provider.screen));
    if (!this.resumeHandle && this.provider.captureResumeHandle) {
      this.resumeOutput = `${this.resumeOutput}${data}`.slice(-64 * 1024);
      const handle = this.provider.captureResumeHandle(this.resumeOutput);
      if (handle) {
        this.resumeHandle = handle;
        this.emit('resume-metadata', { handle });
      }
    }
    if (this.provider.statusFromActivity) {
      this.setStatus('working');
      clearTimeout(this.activityTimer);
      this.activityTimer = setTimeout(() => {
        this.flushPending();
        if (this.provider.finalizeOnActivityIdle && !this.menu.length) this.finalizeTurn();
        this.setStatus('idle');
      }, this.provider.activityIdleMs);
      return;
    }
    if (this.closeRequested) this.flushScreen();
  }

  submitCloseIfReady() {
    if (!this.closeRequested || this.closeSubmitted || !this.provider.closeSubmit) return;
    const input = this.provider.closeSubmit(this.screen.lines());
    if (!input) return;
    this.closeSubmitted = true;
    this.terminal?.write(input);
  }

  beginTurn() {
    if (!this.turnOpen) this.baselineCandidate = this.currentCandidate();
    this.pendingFinal = false;
    this.pendingFinalText = '';
    this.turnOpen = true;
    this.lastUpdate = '';
  }

  finalizeTurn() {
    if (!this.turnOpen) return;
    const hasCanonicalFinal = Boolean(this.pendingFinalText);
    const candidate = this.pendingFinalText
      || (this.provider.screenFinalFallback === false ? '' : this.currentCandidate());
    if (candidate && (hasCanonicalFinal || candidate !== this.baselineCandidate)) {
      if (candidate !== this.lastUpdate) {
        this.lastUpdate = candidate;
        this.emitAgentUpdate(candidate);
      }
      const at = this.now();
      this.lastAgentAt = at;
      this.emitProtocol('agent.final', { text: candidate, at });
    }
    this.turnOpen = false;
    this.baselineCandidate = candidate;
    this.lastUpdate = '';
    this.pendingFinalText = '';
  }

  finishTurn() {
    this.pendingFinal = false;
    this.finalizeTurn();
    this.setStatus('idle');
  }

  cancelTurn() {
    this.pendingFinal = false;
    this.pendingFinalText = '';
    this.turnOpen = false;
    this.lastUpdate = '';
    this.setStatus('idle');
  }

  settlePendingFinal() {
    if (!this.pendingFinal || !this.provider.screen.hasSettledPrompt(this.screen.lines())) return;
    this.finishTurn();
  }

  handleHook(route, payload = {}) {
    this.flushScreen();
    const turnId = this.provider.id === 'codex' && typeof payload.turn_id === 'string' ? payload.turn_id : '';
    if (turnId && this.completedHookTurns.has(turnId)) return;
    if (turnId && route === 'start' && turnId === this.activeHookTurn) return;
    if (turnId && (route === 'stop' || route === 'idle') && this.activeHookTurn && turnId !== this.activeHookTurn) return;
    this.setModel(this.provider.model?.(payload));
    if (route === 'context') {
      const usage = this.provider.contextUsage?.(payload);
      if (usage !== undefined) this.setContextUsage(usage);
      return;
    }
    if (route === 'start') {
      if (turnId) this.activeHookTurn = turnId;
      this.beginTurn();
      this.setStatus('working');
      return;
    }
    if (route === 'stop') {
      this.completeHookTurn(turnId);
      this.pendingFinalText = this.provider.finalText?.(payload) || '';
      this.analyzeScreen();
      if (this.provider.finalizeOnStop) {
        this.finishTurn();
        return;
      }
      this.pendingFinal = true;
      this.settlePendingFinal();
      return;
    }
    if (route === 'idle' || route === 'session-end') {
      this.completeHookTurn(turnId);
      this.analyzeScreen();
      this.finishTurn();
      return;
    }
    if (route === 'session-start') {
      const source = String(payload.source || '').toLowerCase();
      if (source === 'clear') {
        this.stopContextMonitor();
        this.contextTranscriptPathActive = '';
        this.setContextUsage(null);
        this.cancelTurn();
      }
      if (source !== 'compact') {
        this.sessionStarted = true;
        this.analyzeScreen();
        if (this.provider.id === 'codex' && !this.turnOpen) this.setStatus('idle');
      }
      return;
    }
    if (route === 'menu') this.analyzeScreen();
  }

  completeHookTurn(turnId) {
    if (!turnId) return;
    this.completedHookTurns.add(turnId);
    if (this.completedHookTurns.size > 32) this.completedHookTurns.delete(this.completedHookTurns.values().next().value);
    if (this.activeHookTurn === turnId) this.activeHookTurn = '';
  }

  sendPrompt(text) {
    const prompt = String(text || '').trim();
    if (!prompt || !this.terminal || this.closed) return false;
    this.flushScreen();
    this.baselineCandidate = this.currentCandidate();
    this.pendingFinal = false;
    this.pendingFinalText = '';
    this.turnOpen = true;
    this.lastUpdate = '';
    this.submitPrompt(prompt, true);
    return true;
  }

  steerPrompt(text) {
    const prompt = String(text || '').trim();
    if (!prompt || !this.terminal || this.closed) return false;
    this.flushScreen();
    if (this.menu.length) return false;
    this.submitPrompt(prompt, false);
    return true;
  }

  submitPrompt(prompt, retryWhenIdle) {
    this.userPrompts.push(prompt);
    this.emitProtocol('turn.user', { text: prompt });
    this.terminal.write(`${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`);
    const delay = this.promptSubmitDelay(prompt.length);
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    clearTimeout(this.activityTimer);
    this.submitTimer = setTimeout(() => {
      if (!this.closed) this.terminal.write('\r');
    }, delay);
    if (retryWhenIdle) {
      this.submitRetryTimer = setTimeout(() => {
        if (!this.closed && this.status === 'idle') this.terminal.write('\r');
      }, delay + this.submitRetryMs);
    }
  }

  writeInput(data) {
    if (!this.terminal || this.closed) return;
    this.flushScreen();
    const input = String(data || '');
    // Codex delays its native clear hook until the next prompt. Invalidate the
    // old reading on submission; only a native hook may bind the new rollout.
    if (this.provider.id === 'codex' && !this.menu.length
      && (input === '\r' || input === '\n')
      && this.provider.screen.hasInputCommand(this.screen.lines(), '/clear')) {
      this.stopContextMonitor();
      this.contextTranscriptPathActive = '';
      this.setContextUsage(null);
    }
    if (this.provider.turnFromInput && !this.turnOpen && !this.menu.length
      && (input === '\r' || input === '\n')) {
      this.beginTurn();
      this.setStatus('working');
    }
    if (this.menu.length && this.userPrompts.length && /[\r\n0-9]/.test(input)) {
      this.beginTurn();
      this.setStatus('working');
    }
    this.terminal.write(input);
    if (this.status === 'working' && input === this.provider.interruptInput) {
      this.cancelTurn();
    }
  }

  resize(cols, rows) {
    if (!this.terminal || this.closed) return;
    this.flushScreen();
    const nextCols = Math.max(20, Number(cols || this.cols));
    const nextRows = Math.max(5, Number(rows || this.rows));
    // Even an unchanged PTY resize can make Codex clear its scrollback.
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.terminal.resize(this.cols, this.rows);
    this.screen.resize(this.cols, this.rows);
  }

  snapshot() {
    return {
      type: 'session.created',
      sessionId: this.id,
      protocol: 1,
      provider: this.provider.id,
      name: this.name,
      pid: this.terminal?.pid,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      muted: this.muted,
      live: true,
      model: this.model,
      bracketedPaste: this.bracketedPasteMode,
      projectId: this.projectId ?? null,
      ...(this.lastAgentAt && { lastAgentAt: this.lastAgentAt }),
      ...(this.contextUsage !== undefined && { contextUsage: this.contextUsage }),
      ...(this.commandId && { commandId: this.commandId, label: this.commandLabel }),
    };
  }

  recordResumeMetadata(metadata = {}) {
    const path = String(metadata.transcriptPath || '').trim();
    if (path) {
      this.resumeTranscriptPath = path;
      this.attachContextMonitor(path);
    }
  }

  requestExit() {
    if (!this.terminal) {
      this.handleExit(null, null);
      return;
    }
    try {
      if (!this.provider.closeInput) {
        this.killTerminal();
        return;
      }
      this.terminal.write(this.provider.closeInput);
      clearTimeout(this.closeKillTimer);
      this.closeKillTimer = setTimeout(() => this.killTerminal(), this.closeGraceMs);
      this.closeKillTimer.unref?.();
    } catch {
      this.killTerminal();
    }
  }

  killTerminal() {
    clearTimeout(this.closeKillTimer);
    this.closeKillTimer = null;
    this.stopContextMonitor();
    this.stopContextMonitor = () => {};
    if (!this.terminal) {
      this.handleExit(null, null);
      return;
    }
    try {
      this.terminal.kill();
    } catch {
      this.handleExit(null, null);
    }
  }

  close() {
    if (this.closed || this.closeRequested) return;
    this.closeRequested = true;
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    const pendingTranscript = this.provider.requiresResumeTranscript
      && this.userPrompts.length > 0
      && this.resumeTranscriptPath
      && !hasNonemptyFile(this.resumeTranscriptPath);
    if (!pendingTranscript) {
      this.requestExit();
      return;
    }
    waitForNonemptyFile(this.resumeTranscriptPath, this.transcriptWaitMs).then((ready) => {
      if (this.closed) return;
      if (ready) this.requestExit();
      else this.killTerminal();
    });
  }

  stopForRestart() {
    if (this.closed) return this.closedPromise;
    this.restarting = true;
    this.closeRequested = true;
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    clearTimeout(this.activityTimer);
    this.killTerminal();
    return this.closedPromise;
  }

  waitForClose() {
    return this.closedPromise;
  }

  handleExit(exitCode, signal) {
    if (this.closed) return;
    this.flushScreen();
    this.closed = true;
    clearTimeout(this.outputTimer);
    this.outputTimer = null;
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    clearTimeout(this.activityTimer);
    clearTimeout(this.closeKillTimer);
    this.closeKillTimer = null;
    this.stopContextMonitor();
    this.stopContextMonitor = () => {};
    if (!this.restarting) this.finalizeTurn();
    this.launchCleanup();
    this.emitProtocol('session.closed', {
      exitCode,
      signal,
      ...(this.restarting && { restarting: true }),
    });
    this.resolveClosed();
  }
}

module.exports = { AgentSession, sessionEnvironment };

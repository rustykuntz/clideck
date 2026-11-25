const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { delimiter, join } = require('path');
const pty = require('./pty');
const { Screen } = require('./screen');
const { migrateLegacyHooks } = require('./legacy-hooks');
const { hasNonemptyFile, waitForNonemptyFile } = require('./transcript-file');
const { augmentedPath } = require('./custom-command');
const { nativeProfile } = require('./session-archive');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const TRANSCRIPT_READY_TIMEOUT_MS = 5000;
const CLOSE_GRACE_MS = 1500;
const OUTPUT_BATCH_MS = 100;
const USER_ACTIVITY_GRACE_MS = 4000;
// xterm sends focus/device/cursor/colour reports through the same onData path as
// keystrokes. They still belong on the PTY, but cannot take ownership of a turn.
const TERMINAL_REPORT = /^(?:\x1b\[(?:[IO]|\??\d+;\d+R|[?>][\d;]*c|0n|\?[\d;]+u)|\x1b\](?:4;\d+|10|11|12);rgb:[\da-f/]+(?:\x07|\x1b\\))+$/i;
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
    this.readAloud = options.readAloud === true;
    this.lastAgentAt = Number(options.lastAgentAt) || null;
    this.now = options.now || Date.now;
    this.userActivityUntil = 0;
    this.pendingSubmission = null;
    this.colorfgbg = COLORFGBG_BY_THEME[options.theme];
    this.screen = new Screen(this.cols, this.rows);
    this.userPrompts = [];
    this.pendingPromptEchoes = [];
    this.replyOwner = null;
    this.rawInputOrigin = '';
    this.recordedPromptIds = new Set();
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
    this.observedCodexTurn = '';
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
    const env = sessionEnvironment(launch.env, this.id, this.port, this.colorfgbg, this.serverUrl);
    // Keep only the transcript boundary, never the environment/credentials.
    this.archiveProfileRoot = nativeProfile(this.provider.id, env, this.cwd);
    migrateLegacyHooks(this.provider.id, env, this.cwd);
    try {
      this.terminal = pty.spawn(launch.command, [...extraArgs, ...(launch.args || [])], {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env,
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
      readAloud: this.readAloud,
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
    if (this.replyOwner && ['agent.update', 'agent.final', 'menu'].includes(type)) {
      this.emit('reply', { type, sessionId: this.id, ...this.replyOwner, ...fields });
    }
    this.emit('event', { type, sessionId: this.id, ...fields });
  }

  endReply(reason) {
    const owner = this.replyOwner;
    this.replyOwner = null;
    if (owner) this.emit('reply', { type: 'turn.ended', sessionId: this.id, ...owner, reason });
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
    if (state === 'working') {
      clearTimeout(this.submitRetryTimer);
      this.submitRetryTimer = null;
      if (this.pendingSubmission?.submitted) this.pendingSubmission = null;
    }
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
    const stop = this.provider.watchContextUsage(
      value,
      (usage) => this.setContextUsage(usage),
      { onReset: () => { this.observedCodexTurn = ''; }, onTurn: (event) => {
        if (!this.closed && !this.closeRequested && this.contextTranscriptPathActive === value) {
          this.handleCodexTurn(event);
        }
      } },
    );
    this.stopContextMonitor = () => {
      this.observedCodexTurn = '';
      stop();
    };
  }

  handleCodexTurn(event) {
    if (this.provider.id !== 'codex' || !event?.turn_id) return;
    if (event.type === 'task_started') {
      if (this.completedHookTurns.has(event.turn_id)) return;
      this.observedCodexTurn = event.turn_id;
      this.handleHook('start', { turn_id: event.turn_id });
    } else if (event.turn_id === this.activeHookTurn) {
      if (event.type === 'task_complete') {
        this.handleHook('stop', {
          turn_id: event.turn_id,
          last_assistant_message: event.last_agent_message,
        });
      } else if (event.type === 'turn_aborted') {
        this.completeHookTurn(event.turn_id);
        this.cancelTurn(); // An interrupted turn must not announce a stale final.
      }
    }
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
    this.endReply('The turn ended without a text reply.');
    this.turnOpen = false;
    this.baselineCandidate = candidate;
    this.lastUpdate = '';
    this.pendingFinalText = '';
  }

  finishTurn() {
    this.pendingPromptEchoes = [];
    this.pendingFinal = false;
    this.finalizeTurn();
    this.setStatus('idle');
  }

  cancelTurn() {
    this.endReply('The agent was interrupted.');
    this.pendingPromptEchoes = [];
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
    // Once a native continuation identifies the current turn, an untagged late
    // hook cannot safely finish it. The matching rollout completion still can.
    if (this.provider.id === 'codex' && this.observedCodexTurn && !turnId
        && (route === 'stop' || route === 'idle')) return;
    if (turnId && this.completedHookTurns.has(turnId)) return;
    // Codex can submit several prompts (including steering) within one turn.
    // Record those before the duplicate-start lifecycle guard.
    if (route === 'start') this.recordNativePrompt(payload);
    if (turnId && route === 'start' && turnId === this.activeHookTurn) return;
    if (turnId && (route === 'stop' || route === 'idle') && this.activeHookTurn && turnId !== this.activeHookTurn) return;
    this.setModel(this.provider.model?.(payload));
    if (route === 'context') {
      const usage = this.provider.contextUsage?.(payload);
      if (usage !== undefined) this.setContextUsage(usage);
      return;
    }
    if (route === 'start') {
      if (this.replyOwner?.nativeTurnId && turnId && this.replyOwner.nativeTurnId !== turnId) this.endReply('A different native turn started.');
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
      if (route === 'session-end') this.observedCodexTurn = '';
      this.completeHookTurn(turnId);
      this.analyzeScreen();
      this.finishTurn();
      return;
    }
    if (route === 'session-start') {
      const source = String(payload.source || '').toLowerCase();
      if (source === 'clear') {
        this.observedCodexTurn = '';
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
    if (this.observedCodexTurn === turnId) this.observedCodexTurn = '';
  }

  recordNativePrompt(payload) {
    const text = this.provider.userText?.(payload);
    if (!text) return;
    const id = this.provider.id === 'claude-code' && typeof payload.prompt_id === 'string'
      ? payload.prompt_id : '';
    if (id && this.recordedPromptIds.has(id)) return;
    if (id) {
      this.recordedPromptIds.add(id);
      if (this.recordedPromptIds.size > 64) this.recordedPromptIds.delete(this.recordedPromptIds.values().next().value);
    }
    // Consume each expected echo once. Never deduplicate user text
    // against conversation history: repeated identical messages are valid.
    const match = this.pendingPromptEchoes.findIndex(expected => expected.text === text
      || this.provider.promptEchoMatches?.(expected.text, text));
    if (match !== -1) {
      const [expected] = this.pendingPromptEchoes.splice(match, 1);
      // A native prompt echo after Enter, not a paste or the next completion,
      // identifies the request whose answer may leave this machine.
      this.endReply('Another request took over this turn.');
      if (expected.submitted && this.now() - expected.at < 90_000 && expected.origin !== 'agent') {
        this.replyOwner = { requestId: expected.requestId, origin: expected.origin,
          nativeTurnId: typeof payload.turn_id === 'string' ? payload.turn_id : '' };
        this.emit('reply', { type: 'turn.started', sessionId: this.id, ...this.replyOwner });
      }
      return;
    }
    this.endReply('Another request took over this turn.');
    if (this.rawInputOrigin === 'desktop') {
      this.replyOwner = { requestId: randomUUID(), origin: 'desktop',
        nativeTurnId: typeof payload.turn_id === 'string' ? payload.turn_id : '' };
      this.emit('reply', { type: 'turn.started', sessionId: this.id, ...this.replyOwner });
    }
    this.rawInputOrigin = '';
    this.emitProtocol('turn.user', { text });
  }

  isUserTyping() {
    return this.now() < this.userActivityUntil;
  }

  isSubmitting() {
    return Boolean(this.pendingSubmission && !this.pendingSubmission.submitted);
  }

  markUserActivity() {
    if (this.closed || !this.terminal) return;
    this.userActivityUntil = this.now() + USER_ACTIVITY_GRACE_MS;
    // Human edits also win after an automatic paste but before its delayed CR.
    // Never clear/reconstruct the native draft; tell the sender text was inserted.
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    this.submitTimer = this.submitRetryTimer = null;
    const pending = this.pendingSubmission;
    this.pendingSubmission = null;
    if (pending && !pending.submitted) {
      // This paste may now be edited or discarded, so it is no longer an
      // expected native submission. Do not let it block later echo matching.
      if (this.pendingPromptEchoes.at(-1) === pending.echo) this.pendingPromptEchoes.pop();
      if (pending.newTurn && this.status === 'idle') this.turnOpen = false;
      pending.resolve({ ok: false, error: 'delivery_interrupted', message:
        'The user started typing during delivery. Text was already inserted, but automatic submission was cancelled. Check the terminal before retrying.' });
    }
  }

  sendPrompt(text, { fromUser = false, origin = 'agent', requestId = randomUUID() } = {}) {
    const prompt = String(text || '').trim();
    if (!prompt || !this.terminal || this.closed) return false;
    if (fromUser) this.markUserActivity();
    else if (this.isUserTyping() || this.isSubmitting()) return false;
    this.endReply('Another request took over this turn.');
    this.flushScreen();
    this.baselineCandidate = this.currentCandidate();
    this.pendingFinal = false;
    this.pendingFinalText = '';
    this.turnOpen = true;
    this.lastUpdate = '';
    this.submitPrompt(prompt, true, { origin: fromUser ? 'desktop' : origin, requestId });
    return true;
  }

  steerPrompt(text) {
    const prompt = String(text || '').trim();
    if (!prompt || !this.terminal || this.closed || this.isUserTyping() || this.isSubmitting()) return false;
    this.flushScreen();
    if (this.menu.length) return false;
    this.endReply('Another request was steered into this turn. Check the conversation in CliDeck.');
    this.submitPrompt(prompt, false);
    return true;
  }

  submitPrompt(prompt, retryWhenIdle, { origin = 'agent', requestId = randomUUID() } = {}) {
    this.rawInputOrigin = '';
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const echo = { text: prompt, origin, requestId, at: this.now(), submitted: false };
    const pending = { completion, resolve, prompt, echo, submitted: false, newTurn: retryWhenIdle };
    this.pendingSubmission = pending;
    this.userPrompts.push(prompt);
    if (this.provider.userText) {
      this.pendingPromptEchoes.push(echo);
      if (this.pendingPromptEchoes.length > 32) this.pendingPromptEchoes.shift();
    }
    this.emitProtocol('turn.user', { text: prompt });
    this.terminal.write(`${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`);
    const delay = this.promptSubmitDelay(prompt.length);
    clearTimeout(this.submitTimer);
    clearTimeout(this.submitRetryTimer);
    this.submitTimer = this.submitRetryTimer = null;
    clearTimeout(this.activityTimer);
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null;
      if (!this.closed && this.pendingSubmission === pending) {
        pending.submitted = true;
        echo.submitted = true;
        this.terminal.write('\r');
        pending.resolve({ ok: true });
        if (!this.submitRetryTimer) this.pendingSubmission = null;
      }
    }, delay);
    if (retryWhenIdle) {
      this.submitRetryTimer = setTimeout(() => {
        this.submitRetryTimer = null;
        if (this.pendingSubmission !== pending) return;
        if (!this.closed && this.status === 'idle') this.terminal.write('\r');
        this.pendingSubmission = null;
      }, delay + this.submitRetryMs);
    }
  }

  writeInput(data, { fromUser = false } = {}) {
    if (!this.terminal || this.closed) return;
    this.flushScreen();
    const input = String(data || '');
    if (input && !this.menu.length && !TERMINAL_REPORT.test(input)) {
      this.rawInputOrigin = fromUser ? 'desktop' : 'agent';
      if (input !== this.provider.interruptInput) this.endReply('Input changed in CliDeck. Check the conversation there.');
    }
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
    // Menu approval continues the current turn, regardless of how it was submitted.
    if (this.menu.length && this.turnOpen && /[\r\n0-9]/.test(input)) {
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
      readAloud: this.readAloud,
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
    this.pendingSubmission?.resolve({ ok: false, error: 'target_closed' });
    this.pendingSubmission = null;
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
    this.pendingSubmission?.resolve({ ok: false, error: 'target_closed' });
    this.pendingSubmission = null;
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
    this.endReply('The session stopped before its reply was captured.');
    this.flushScreen();
    this.closed = true;
    this.pendingSubmission?.resolve({ ok: false, error: 'target_closed' });
    this.pendingSubmission = null;
    this.pendingPromptEchoes = [];
    this.recordedPromptIds.clear();
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

export type PluginEventType =
  | 'session.created' | 'session.closed' | 'turn.user' | 'agent.final'
  | 'status' | 'menu' | 'content.show' | 'config' | 'output' | 'session.reply' | 'user.notice';

export interface PluginEvent {
  type: PluginEventType;
  sessionId?: string;
  [key: string]: unknown;
}

export interface SessionSnapshot {
  type: 'session.created';
  sessionId: string;
  provider: string;
  name: string;
  cwd: string;
  live: boolean;
  projectId?: string | null;
  [key: string]: unknown;
}

export interface Turn {
  role: 'user' | 'agent';
  text: string;
}

export interface PluginClientSessionSnapshot {
  id: string;
  provider: string;
  name: string;
  cwd: string;
  live: boolean;
  status: string;
  projectId?: string | null;
}

export interface PluginCommandContext {
  args: string[];
  stdin: string;
  sessionId: string;
}

export type PluginCommandResult = string | void | {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export interface PluginContent {
  kind: string;
  mime: string;
  name: string;
  data: string | Uint8Array | ArrayBuffer;
}

export interface PluginServerApi {
  readonly apiVersion: 1;
  /** Supplied by the running engine. Older engines may omit this object. */
  readonly capabilities?: Readonly<{ sessionSteer?: boolean; boundedTurns?: boolean }>;
  readonly engineVersion: string;
  readonly id: string;
  readonly dir: string;
  readonly dataDir: string;
  log(...values: unknown[]): void;
  onEvent(types: PluginEventType | PluginEventType[], handler: (event: PluginEvent) => unknown): () => void;
  onClientMessage(event: string, handler: (
    data: unknown,
    context: { readonly requestId: string; reply(event: string, data?: unknown): boolean },
  ) => unknown): () => void;
  sendToClients(event: string, data?: unknown): void;
  registerCommand(name: string, handler: (context: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>): () => void;
  getSetting(key: string): unknown;
  getSettings(): Record<string, unknown>;
  onSettingsChange(handler: (settings: Record<string, unknown>, previous: Record<string, unknown>) => unknown): () => void;
  onShutdown(handler: () => unknown): () => void;
  getSession(id: string): Promise<SessionSnapshot | null>;
  getSessions(): Promise<SessionSnapshot[]>;
  getProjects(): Promise<object[]>;
  /** maxChars (1..64000) bounds total returned text and reads at most 1 MiB from the tail.
   * Requires capabilities.boundedTurns. Keeps newest text; the first turn may be clipped. */
  getTurns(id: string, count?: number, maxChars?: number): Promise<Turn[]>;
  /** Resolves after confirmed submission; rejects on refusal/interruption. Do not blindly resend. */
  sendPrompt(id: string, text: string): Promise<boolean>;
  /** Stable IDs require identical session/text/options. steer permits busy delivery only; it never owns that turn's reply. */
  submitRequest(sessionId: string, requestId: string, text: string, options?: { resume?: boolean; steer?: boolean }): Promise<{ state: 'waiting' | 'sent' | 'uncertain' | 'error'; message: string; steered?: boolean }>;
  getRequests(): Promise<Array<{ id: string; sessionId: string; state: string; answer?: string; message: string; steered?: boolean }>>;
  /** Releases a finished request; returns false for uncertain submission. Never stops unrelated agent work. */
  releaseRequest(id: string): Promise<boolean>;
  /** After inspecting the terminal, clear uncertain submission without resending. */
  acknowledgeRequest(id: string): Promise<boolean>;
  cancelRequest(id: string): Promise<boolean>;
  reportError(sessionId: string, key: string, text: string): Promise<unknown>;
  clearError(key: string): Promise<boolean>;
  notifyUser(sessionId: string, text: string): Promise<{ id: string; sessionId: string; text: string; at: number }>;
  getNotifications(): Promise<Array<{ id: string; sessionId: string; text: string; at: number }>>;
  readNotification(id: string): Promise<boolean>;
  writeInput(id: string, data: string): Promise<boolean>;
  createSession(options: object): Promise<SessionSnapshot>;
  closeSession(id: string): Promise<boolean>;
  showContent(id: string, content: PluginContent): Promise<{
    sessionId: string;
    contentId: string;
    kind: string;
    name: string;
    url: string;
    replaces?: string;
  }>;
}

export interface PluginActionContext {
  /** Present for actions rendered on a plugin's Settings card. */
  plugin?: { id: string };
  /** `anchor` is an opaque host token for WHERE a terminal selection sits. Carry it back verbatim
   *  (`playAudio`'s `readAlong.anchor`, a cache key); never parse it. Empty off the terminal surface. */
  selection?: { text: string; surface?: string; anchor?: string };
  session?: PluginClientSessionSnapshot;
  project?: object;
  tab?: object;
  content?: object;
}

export interface PluginAction {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  /** terminal.primary can show the icon alone; label remains its accessible name. */
  iconOnly?: boolean;
  /** Optional toggle state for terminal.primary, exposed as aria-pressed. */
  pressed?: boolean;
  placements: Array<'terminal.context' | 'viewer.context' | 'terminal.header' | 'terminal.primary' | 'terminal.voice' | 'viewer.header' | 'session.menu' | 'project.menu' | 'toolbar' | 'plugin.settings'>;
  when?: (context: PluginActionContext) => boolean;
  run(context: PluginActionContext): unknown;
}

export interface PluginPickerItem {
  id: string;
  glyph: string;
  label: string;
  keywords?: string[];
  group?: string;
}

export interface PluginPickerOptions {
  id: string;
  title: string;
  placeholder?: string;
  items: PluginPickerItem[];
  recentLimit?: number;
}

export interface PluginActiveViewerText {
  id: string;
  kind: string;
  text: string;
  selection: string;
}

export interface PluginTerminalSelectionSnapshot {
  sessionId: string;
  text: string;
  /** Opaque; empty when the host cannot place the selection. */
  anchor: string;
}

export interface PluginClientSettings {
  values: Record<string, unknown>;
  configured: Record<string, boolean>;
}

export interface PluginClientApi {
  readonly id: string;
  /** Supplied by the browser host; older hosts omit capabilities. */
  readonly capabilities?: Readonly<{ realtimeAudio?: boolean }>;
  /** Opens this plugin's Settings card, never an arbitrary plugin. */
  openSettings(): Promise<boolean>;
  onActiveSessionChange(handler: (focus: PluginSessionFocus) => unknown): () => void;
  /** signal cancels a pending opening, before an id is returned. After opening, close by id. */
  openRealtimeAudio(options: { sessionId: string; channelLabel?: string; signal?: AbortSignal }): Promise<{ id: string; offerSdp: string }>;
  setRealtimeAudioAnswer(id: string, sdp: string): Promise<boolean>;
  sendRealtimeAudioData(id: string, data: string): Promise<boolean>;
  closeRealtimeAudio(id: string): Promise<boolean>;
  onRealtimeAudioEvent(handler: (event: PluginRealtimeAudioEvent) => unknown): () => void;
  send(event: string, data?: unknown): void;
  onMessage(event: string, handler: (data: unknown) => unknown): () => void;
  registerAction(action: PluginAction): () => void;
  registerHotkey(combo: string, handler: (event: { key: string; code: string }) => unknown): () => void;
  registerViewer(definition: object): () => void;
  registerWorkspace(definition: object): () => void;
  openWorkspace(id: string, options?: object): void;
  getSettings(): PluginClientSettings;
  onSettingsChange(handler: (
    settings: PluginClientSettings,
    previous: PluginClientSettings,
  ) => unknown): () => void;
  getActiveSession(): Promise<PluginClientSessionSnapshot | null>;
  getTerminalSelection(): Promise<string>;
  /** The terminal selection plus an opaque `anchor` for the cells it occupies. The token is derived, not
   *  allocated: the same selection over an unchanged buffer always yields the same string, so it is safe to
   *  key a cache on. `null` when nothing is selected. */
  getTerminalSelectionSnapshot(): Promise<PluginTerminalSelectionSnapshot | null>;
  getActiveViewerText(): Promise<PluginActiveViewerText | null>;
  getViewerText(contentId: string): Promise<string>;
  commitTerminalDraft(text: string, options?: {
    sessionId?: string;
    submit?: boolean;
  }): Promise<boolean>;
  openPicker(options: PluginPickerOptions): Promise<string | null>;
  toast(kind: 'info' | 'success' | 'warn' | 'error', options: {
    id?: string;
    title?: string;
    body: string;
    duration?: number;
  }): void;
  playAudio(buffer: ArrayBuffer, options?: PluginAudioOptions): void;
  /** The same clip, answered when it is over: `true` for a natural end, `false` for stop, replacement,
   *  unload or error. Give every clip of one long read the same `options.sequence` and the host keeps the
   *  transport — and its Stop — on screen between parts; once the user stops that read, the next clip
   *  carrying the same id resolves `false` immediately and plays nothing, including one that was still being
   *  prepared when they stopped. Call `stopAudio()` after the last part to put the transport away. */
  playAudioAndWait(buffer: ArrayBuffer, options?: PluginAudioOptions): Promise<boolean>;
  stopAudio(): void;
  startMicrophone(): Promise<PluginMicrophoneInfo>;
  stopMicrophone(): Promise<boolean>;
  onMicrophoneData(handler: (buffer: ArrayBuffer, info: PluginMicrophoneInfo) => unknown): () => void;
  onMicrophoneState(handler: (state: { state: 'listening' | 'stopped' | 'ended' }) => unknown): () => void;
}

export interface PluginSessionFocus {
  session: PluginClientSessionSnapshot | null;
  focused: boolean;
  visible: boolean;
  connected: boolean;
}

export interface PluginRealtimeAudioEvent {
  id: string;
  sessionId: string;
  type: 'state' | 'data' | 'error';
  /** connected means the data channel is open and sendRealtimeAudioData may be used. */
  state?: 'connecting' | 'connected' | 'closed';
  data?: string;
  error?: string;
}

export interface PluginMicrophoneInfo {
  sampleRate: 16000;
  channels: 1;
  format: 'pcm-s16le';
}

export interface PluginAudioOptions {
  mime?: string;
  title?: string;
  text?: string;
  /** Ties the clips of ONE long read together. Mint a fresh id per read; the host remembers only the most
   *  recently cancelled one, which is all that can matter when every read has its own. */
  sequence?: string;
  readAlong?: PluginReadAlong;
}

/** A reading the host may follow on screen. The host owns the highlight and may decline the whole payload:
 *  text it cannot find, an anchor it cannot trust or a document that has moved on all produce no mark rather
 *  than an approximate one. */
export interface PluginReadAlong {
  /** `terminal` marks cells in the session's terminal. `viewer` marks a document tab — markdown and text
   *  directly, HTML through the host's own preview bridge. */
  surface: 'terminal' | 'viewer';
  sessionId: string;
  /** Required for `viewer`: a tab can change under a long read, and the session alone does not say which
   *  document was read. */
  contentId?: string;
  /** Exactly the text this clip speaks. */
  sourceText: string;
  /** Where `sourceText` starts inside the text the host handed you. The two surfaces treat it differently:
   *
   *  `viewer` — the index into the string `getActiveViewerText()` returned. The host verifies THAT EXACT
   *  SLICE and never searches, so repeated content cannot map to the wrong copy; without it a repeated
   *  string is refused outright.
   *
   *  `terminal` — the index into the raw text of the ANCHORED selection, and only a HINT: the host still
   *  searches, and among equal matches takes the one nearest the offset. The two spellings are not the same
   *  string (the screen holds what the renderer printed), so it places a batch without claiming to be exact.
   *  **Ignored entirely when there is no `anchor`** — an auto-read's offset counts from the start of the
   *  reply, which the scrollback knows nothing about; there the host takes the most recent match. */
  sourceOffset?: number;
  /** How much the clock is worth. `estimated` draws a softer mark with no hard edge. Default `measured`. */
  timing?: 'estimated' | 'measured';
  /** An opaque anchor from `getTerminalSelectionSnapshot()` or `context.selection.anchor`. The host resolves
   *  the text against those exact cells; an anchor it cannot trust is REFUSED, not fallen back from, so a
   *  repeated phrase can never light the wrong copy. Terminal only. */
  anchor?: string;
  /** Ordered by `start`, which never goes backwards; ranges may overlap freely, which is how a sliding
   *  window is expressed. `end` is validated but not used to choose the current cue — that is simply the
   *  last one to have started, so the mark holds through a gap instead of blinking off. Offsets are relative
   *  to `sourceText`. */
  cues: Array<{ start: number; end: number; textStart: number; textEnd: number }>;
}

export type ActivateServer = (api: PluginServerApi) => void | Promise<void>;
export type ActivateClient = (api: PluginClientApi) => void | (() => void) | Promise<void | (() => void)>;

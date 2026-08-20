// Git Diff client — toolbar button plus a diff overlay for the active session's folder.
// The server does the git work and the diff2html rendering; this file frames it and handles state.

const ICON = '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7"/><path d="M18 11.5c0 3.5-3 4.5-6 4.5"/><path d="M15.5 9H8.5"/></svg>';
const EXPAND_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2H2v4M10 14h4v-4M14 6V2h-4M2 10v4h4"/></svg>';
const COMPRESS_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h4V2M14 10h-4v4M10 2v4h4M6 14v-4H2"/></svg>';
const COLLAPSE_THRESHOLD = 10; // more files than this and they start collapsed
const TAG = Math.random().toString(36).slice(2, 8); // distinguishes this tab's requests

let api = null;
let settings = {};
let btnEl = null;
let currentHotkey = null;
let stylesRequested = false;
let appliedTheme = '';
let highlighterPromise = null;

let overlay = null;
let el = {};
let sessionId = null;
let scope = 'uncommitted';
let layout = 'side-by-side';
let maximised = false;                  // remembered across opens while the tab stays open
let folder = '';                        // folder being diffed; '' means the session's own folder
const folderBySession = new Map();      // remembers the choice while the tab stays open
let pendingRequest = null;
let pendingTimer = null;                // clears a request that never came back
let pendingPatchRequest = null;
let requestSeq = 0;
let pollTimer = null;
let collapsed = new Set();
let collapseKey = '';
let lastReply = null;

// --- setup ---

export function init(pluginApi) {
  api = pluginApi;

  api.onMessage('settings', (msg) => {
    const previous = settings;
    settings = msg || {};
    if (btnEl) btnEl.style.display = settings.enabled === false ? 'none' : '';
    if (settings.enabled === false) close();
    bindHotkey(settings.hotkey || 'F9');
    // A theme change only needs a different stylesheet. Turning highlighting on or off changes
    // what the server permits, so the diff is re-rendered to pick that up.
    const themeChanged = stylesRequested && settings.highlightTheme !== previous.highlightTheme;
    const toggled = stylesRequested && settings.syntaxHighlight !== previous.syntaxHighlight;
    if (themeChanged || toggled) api.send('getStyles');
    if (overlay && !overlay.hidden) {
      startPolling();
      if (toggled) { lastReply = null; request('diff'); }
    }
  });
  api.onMessage('styles', (msg) => injectStyles(msg || {}));
  api.onMessage('diff', onDiffReply);
  api.onMessage('patch', onPatchReply);

  api.send('getSettings');

  btnEl = api.addToolbarButton({ title: 'Git Diff', icon: ICON, onClick: toggle });
}

function bindHotkey(hotkey) {
  if (hotkey === currentHotkey) return;
  const previous = currentHotkey;
  if (previous) api.unregisterHotkey(previous);
  if (api.registerHotkey(hotkey, toggle)) {
    currentHotkey = hotkey;
    return;
  }
  if (previous && api.registerHotkey(previous, toggle)) {
    api.toast(`Hotkey "${hotkey}" is taken, keeping "${previous}"`, { type: 'warn' });
  } else {
    currentHotkey = null;
    api.toast(`Hotkey "${hotkey}" is unavailable`, { type: 'warn' });
  }
}

// diff2html's stylesheet and the highlight.js theme both arrive over the WebSocket, so there
// is no copy of either on disk to go stale.
function injectStyles(msg) {
  if (msg.css) setStyleBlock('gd-d2h-styles', msg.css);
  // Replaced rather than skipped, because the theme can change in settings.
  if (typeof msg.hljsCss === 'string') {
    setStyleBlock('gd-hljs-styles', msg.hljsCss);
    appliedTheme = msg.theme || '';
  }
}

// diff2html's own browser bundle, which brings highlight.js with it. Loaded on first open
// rather than at page load, since it is only needed once a diff is on screen. The server
// copies it into the plugin's public/ folder, so the browser caches it like any other script.
function loadHighlighter() {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = new Promise((resolve) => {
    if (window.Diff2HtmlUI) { resolve(true); return; }
    const script = document.createElement('script');
    script.src = '/plugins/git-diff/vendor/diff2html-ui.min.js';
    script.onload = () => resolve(!!window.Diff2HtmlUI);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return highlighterPromise;
}

// Highlighting is diff2html's job, not ours: its Diff2HtmlUI walks the rendered lines and
// merges highlight.js output with the word-level ins/del markers it produced itself.
async function highlightRendered() {
  if (!(await loadHighlighter())) return;
  if (!overlay || overlay.hidden) return;
  try {
    new window.Diff2HtmlUI(el.body).highlightCode();
  } catch (e) {
    console.error('[git-diff] highlighting failed:', e);
  }
}

function setStyleBlock(id, css) {
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function ensureChrome() {
  if (!document.getElementById('gd-chrome-styles')) {
    const link = document.createElement('link');
    link.id = 'gd-chrome-styles';
    link.rel = 'stylesheet';
    // resolveFile() maps this straight into the plugin's public/ folder, so no "public" segment.
    link.href = '/plugins/git-diff/git-diff.css';
    document.head.appendChild(link);
  }
  if (!stylesRequested) {
    stylesRequested = true;
    api.send('getStyles');
  }
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.className = 'gd-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="gd-panel">
      <div class="gd-head">
        <div class="gd-head-row">
          <span class="gd-icon">${ICON}</span>
          <span class="gd-session"></span>
          <span class="gd-branch"></span>
          <select class="gd-folder" title="Folder to diff"></select>
          <button class="gd-btn gd-icon-btn gd-full" title="Maximise">${EXPAND_ICON}</button>
          <button class="gd-btn gd-icon-btn gd-close" title="Close (Esc)">&#10005;</button>
        </div>
        <div class="gd-head-row gd-controls">
          <div class="gd-seg" data-group="scope">
            <button type="button" data-value="uncommitted">Uncommitted</button>
            <button type="button" data-value="base">vs base</button>
          </div>
          <div class="gd-seg" data-group="layout">
            <button type="button" data-value="side-by-side">Split</button>
            <button type="button" data-value="line-by-line">Unified</button>
          </div>
          <span class="gd-summary"></span>
          <span class="gd-spacer"></span>
          <button class="gd-btn gd-files" type="button">Hide files</button>
          <button class="gd-btn gd-collapse" type="button">Collapse all</button>
          <button class="gd-btn gd-copy" type="button">Copy patch</button>
          <button class="gd-btn gd-refresh" type="button">Refresh</button>
        </div>
      </div>
      <div class="gd-note" hidden></div>
      <div class="gd-body"></div>
    </div>`;
  document.body.appendChild(overlay);

  el = {
    session: overlay.querySelector('.gd-session'),
    branch: overlay.querySelector('.gd-branch'),
    folder: overlay.querySelector('.gd-folder'),
    summary: overlay.querySelector('.gd-summary'),
    note: overlay.querySelector('.gd-note'),
    body: overlay.querySelector('.gd-body'),
    scope: overlay.querySelector('.gd-seg[data-group="scope"]'),
    layout: overlay.querySelector('.gd-seg[data-group="layout"]'),
    full: overlay.querySelector('.gd-full'),
    files: overlay.querySelector('.gd-files'),
    collapse: overlay.querySelector('.gd-collapse'),
    copy: overlay.querySelector('.gd-copy'),
    refresh: overlay.querySelector('.gd-refresh'),
  };

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.gd-close').addEventListener('click', close);
  el.full.addEventListener('click', toggleMaximised);
  el.refresh.addEventListener('click', () => request('diff'));
  el.copy.addEventListener('click', copyPatch);
  el.files.addEventListener('click', toggleFileList);
  el.collapse.addEventListener('click', toggleCollapseAll);

  el.folder.addEventListener('change', () => {
    const value = el.folder.value;
    if (value === '__browse__' || !value) {
      el.folder.value = folder || '';   // resync; '' means no matching option
      if (value === '__browse__') browseForFolder();
      return;
    }
    setFolder(value);
  });

  el.scope.addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (!value || value === scope) return;
    scope = value;
    request('diff');
  });
  el.layout.addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (!value || value === layout) return;
    layout = value;
    request('render'); // served from the server's cache, no new git call
  });

  // Collapse a file by clicking its header, ignoring clicks on the links inside it.
  el.body.addEventListener('click', (e) => {
    const header = e.target.closest('.d2h-file-header');
    if (!header || e.target.closest('a, .d2h-file-collapse')) return;
    const wrapper = header.closest('.d2h-file-wrapper');
    const path = wrapper?.querySelector('.d2h-file-name')?.textContent?.trim();
    if (!wrapper || !path) return;
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    wrapper.classList.toggle('gd-collapsed', collapsed.has(path));
    updateCollapseButton();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) { e.stopPropagation(); close(); }
  }, true);
}

// --- maximise ---

// Fills the browser window rather than using the Fullscreen API, so the browser's own
// chrome stays put and toasts and the folder picker keep working normally.
function toggleMaximised() {
  setMaximised(!maximised);
}

function setMaximised(on) {
  maximised = on;
  overlay.classList.toggle('gd-max', on);
  el.full.innerHTML = on ? COMPRESS_ICON : EXPAND_ICON;
  el.full.title = on ? 'Restore size' : 'Maximise';
}

// --- open / close ---

function toggle() {
  if (overlay && !overlay.hidden) close();
  else open();
}

function open() {
  if (settings.enabled === false) return;
  const active = api.getActiveSessionId();
  if (!active) { api.toast('Select a session first', { type: 'warn' }); return; }

  ensureChrome();
  sessionId = active;
  folder = folderBySession.get(active) || '';   // '' lets the server use the session folder
  scope = settings.defaultScope === 'base' ? 'base' : 'uncommitted';
  layout = settings.defaultLayout === 'line-by-line' ? 'line-by-line' : 'side-by-side';
  collapsed = new Set();
  collapseKey = '';
  lastReply = null;
  overlay.hidden = false;
  el.session.textContent = '';
  el.branch.textContent = '';
  el.summary.textContent = '';
  syncSegments();
  setMaximised(maximised);
  request('diff');
  startPolling();
}

function close() {
  stopPolling();
  pendingRequest = null;
  clearPending();
  if (overlay) {
    overlay.hidden = true;
    el.body.innerHTML = '';
  }
}

function startPolling() {
  stopPolling();
  const seconds = Number(settings.pollSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  pollTimer = setInterval(() => {
    if (!overlay || overlay.hidden) return;
    if (document.hidden) return;      // nobody is looking
    if (pendingRequest) return;       // previous request still out
    request('diff', { quiet: true });
  }, seconds * 1000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// --- requests ---

function request(kind, opts = {}) {
  if (!sessionId) return;
  pendingRequest = `${TAG}-${++requestSeq}`;
  if (!opts.quiet) {
    el.refresh.classList.add('gd-busy');
    if (!lastReply) el.body.innerHTML = '<div class="gd-state">Running git…</div>';
  }
  // Polling skips a tick while a request is out, so a reply that never arrives would stop the
  // panel refreshing for good. The server's git timeout is 15 seconds; this gives it 20.
  clearPending();
  pendingTimer = setTimeout(() => {
    pendingRequest = null;
    pendingTimer = null;
    el.refresh.classList.remove('gd-busy');
  }, 20000);
  api.send(kind, { requestId: pendingRequest, sessionId, scope, layout, folder });
}

function clearPending() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}

// --- folder selection ---

function setFolder(path) {
  if (!path || path === folder) return;
  folder = path;
  folderBySession.set(sessionId, path);
  collapseKey = '';   // different folder, so previous collapse state is meaningless
  lastReply = null;
  request('diff');
}

async function browseForFolder() {
  const start = folder || lastReply?.cwd || '';
  try {
    // The app's own picker, same module instance the rest of the UI uses, so its
    // directory-listing replies are routed for us.
    const { openFolderPicker } = await import('/js/folder-picker.js');
    openFolderPicker(start, (chosen) => { if (chosen) setFolder(chosen); });
  } catch {
    api.toast('Folder picker unavailable in this CliDeck version', { type: 'warn' });
  }
}

function shortenPath(path) {
  const home = lastReply?.home || '';
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function optionLabel(choice, repoRoot) {
  const path = shortenPath(choice.path);
  if (choice.kind === 'session') return `${path}  (session start folder)`;
  if (choice.kind === 'worktree' || choice.kind === 'current-worktree') {
    const here = choice.path === repoRoot ? ', current' : '';
    return choice.label ? `${path}  (worktree: ${choice.label}${here})` : `${path}  (worktree${here})`;
  }
  return path;
}

function renderFolderSelect(msg) {
  let choices = msg.folders || [];
  // A server that predates the folder selector sends no choices. Fall back to the folder it
  // did report so the control shows something real rather than looking broken.
  if (!choices.length) {
    const path = msg.folder || msg.repoRoot || msg.cwd || '';
    if (path) choices = [{ path, label: 'Session folder', kind: 'session' }];
  }
  const selected = msg.folder || choices[0]?.path || '';
  el.folder.innerHTML = choices.map((c) =>
    `<option value="${escapeHtml(c.path)}"${c.path === selected ? ' selected' : ''}>${escapeHtml(optionLabel(c, msg.repoRoot))}</option>`
  ).join('') + '<option value="__browse__">Choose another folder…</option>';
  el.folder.value = selected;
  el.folder.title = selected;
  // Keep local state aligned with what the server actually used.
  folder = selected;
  if (sessionId && selected) folderBySession.set(sessionId, selected);
}

function onDiffReply(msg) {
  if (!overlay || overlay.hidden) return;
  if (msg.requestId !== pendingRequest) return; // stale or another tab's reply
  pendingRequest = null;
  clearPending();
  el.refresh.classList.remove('gd-busy');

  if (!msg.ok) { renderError(msg); return; }
  lastReply = msg;
  renderDiff(msg);
}

// The patch copied is the one behind the diff on screen, named by the key that diff arrived with.
// Asking by session alone would get whatever was cached for it last, which is another folder's
// patch whenever a second tab is open on the session.
function copyPatch() {
  if (!sessionId) return;
  const patchKey = lastReply?.patchKey;
  if (!patchKey) { api.toast('Nothing to copy yet, refresh first', { type: 'warn' }); return; }
  pendingPatchRequest = `${TAG}-patch-${++requestSeq}`;
  api.send('getPatch', { requestId: pendingPatchRequest, sessionId, patchKey });
}

async function onPatchReply(msg) {
  if (msg.requestId !== pendingPatchRequest) return;
  pendingPatchRequest = null;
  // Stale means the diff was dropped from the server's cache, which is different from a diff with
  // nothing in it: one needs a refresh, the other has nothing to give.
  if (msg.code === 'stale') { api.toast('That diff is no longer cached, refresh and copy again', { type: 'warn' }); return; }
  if (!msg.patch) { api.toast('No patch to copy', { type: 'warn' }); return; }
  try {
    await navigator.clipboard.writeText(msg.patch);
    api.toast(`Copied ${msg.patch.length.toLocaleString()} chars of patch`, { type: 'success' });
  } catch {
    api.toast('Clipboard access denied — allow it in browser site settings', { type: 'error' });
  }
}

// --- rendering ---

function syncSegments() {
  for (const [group, value] of [[el.scope, scope], [el.layout, layout]]) {
    for (const btn of group.querySelectorAll('button')) {
      btn.classList.toggle('gd-on', btn.dataset.value === value);
    }
  }
}

function renderError(msg) {
  const hints = {
    'not-a-repo': 'This session\'s folder is not inside a git repository.',
    'no-git': 'git was not found on PATH of the CliDeck server process.',
    'no-session': 'That session is no longer running.',
    timeout: 'git took longer than 15 seconds and was stopped.',
    'unfilterable-config': 'This folder\'s git configuration would run a command that cannot be switched off.',
    'config-unreadable': 'This folder\'s git configuration could not be read, so the commands it may name cannot be switched off.',
  };
  stopPolling();
  el.summary.textContent = '';
  el.note.hidden = true;
  renderFolderSelect(msg);   // keep the selector usable, or a bad choice is a dead end
  el.body.innerHTML = `<div class="gd-state gd-error">
    <div class="gd-error-title">${escapeHtml(hints[msg.code] || 'git failed')}</div>
    ${msg.message ? `<pre class="gd-error-detail">${escapeHtml(msg.message)}</pre>` : ''}
    ${msg.code === 'unfilterable-config' ? unfilterableActions(msg) : ''}
  </div>`;
}

// Every other command a folder's config names is switched off per invocation. A filter driver is
// switched off by name, so a name git would read as something else leaves nothing to do but name
// the driver and stop.
function unfilterableActions(msg) {
  const drivers = (msg.drivers || []).map((d) => `<li>${escapeHtml(d)}</li>`).join('');
  return `${drivers ? `<ul class="gd-error-keys">${drivers}</ul>` : ''}
    <p class="gd-error-note">Pick another folder.</p>`;
}

function renderDiff(msg) {
  el.session.textContent = msg.sessionName || 'session';
  el.branch.textContent = msg.branch || '';
  renderFolderSelect(msg);

  const baseButton = el.scope.querySelector('button[data-value="base"]');
  if (baseButton) baseButton.textContent = msg.baseLabel && scope === 'base' ? `vs ${msg.baseLabel}` : 'vs base';
  syncSegments();

  const { files = 0, additions = 0, deletions = 0 } = msg.totals || {};
  el.summary.innerHTML = files
    ? `${files} file${files === 1 ? '' : 's'} <span class="gd-add">+${additions}</span> <span class="gd-del">−${deletions}</span>`
    : '';

  const notes = [];
  if (msg.folderRejected) notes.push('That folder no longer exists, so the session folder is shown instead.');
  if (msg.folder && msg.repoRoot && msg.folder !== msg.repoRoot) notes.push(`Showing the whole repository at ${msg.repoRoot}, which contains the selected folder.`);
  if (msg.baseFallback) notes.push('No base branch found to compare against, showing uncommitted changes instead.');
  else if (msg.baseIsHead && msg.scope === 'base') notes.push(`No commits ahead of ${msg.baseLabel}, so this shows the same uncommitted changes.`);
  const oversized = (msg.files || []).filter((f) => f.oversizedBytes);
  if (oversized.length) {
    notes.push(`${oversized.length} untracked file${oversized.length === 1 ? '' : 's'} too large to render: ${oversized.map((f) => `${f.path} (${formatBytes(f.oversizedBytes)})`).join(', ')}`);
  }
  // Paths the server would not read: fifos, sockets, device nodes, directories.
  const skipped = msg.skippedEntries || [];
  if (skipped.length) {
    notes.push(`${skipped.length} untracked entr${skipped.length === 1 ? 'y' : 'ies'} skipped, not a regular file: ${skipped.map((s) => `${s.path} (${s.kind})`).join(', ')}`);
  }
  // A file left out for line length is text, so it must not read as "binary" in the panel.
  const longLines = (msg.files || []).filter((f) => f.longestLine);
  if (longLines.length) {
    const limit = Number(msg.maxLineChars || 0).toLocaleString();
    notes.push(`${longLines.length} file${longLines.length === 1 ? '' : 's'} shown without contents, lines over ${limit} characters: ${longLines.map((f) => `${f.path} (${f.longestLine.toLocaleString()})`).join(', ')}`);
  }
  if (msg.untrackedTruncated) {
    const { files, reason } = msg.untrackedTruncated;
    notes.push(`${files} untracked file${files === 1 ? '' : 's'} not shown, past the scan ${reason === 'bytes' ? 'size' : 'file count'} budget.`);
  }
  if (msg.baseBranchInvalid) notes.push('The Base Branch setting is not a valid ref name, so it was ignored.');
  el.note.hidden = notes.length === 0;
  el.note.textContent = notes.join(' ');

  // Reset collapse state when the session or scope changes, not on every poll.
  const key = `${msg.sessionId}|${msg.scope}`;
  const freshView = key !== collapseKey;
  if (freshView) {
    collapseKey = key;
    collapsed = new Set();
  }

  const scrollTop = el.body.scrollTop;
  if (!files) {
    el.body.innerHTML = '<div class="gd-state">No changes.</div>';
  } else if (msg.tooBig) {
    el.body.innerHTML = renderFileListOnly(msg);
  } else {
    el.body.innerHTML = msg.html || '';
    // Collapse keys come from the rendered headings, not the server's paths: diff2html shows a
    // rename as "src/{old.js → new.js}", which never matches the path in msg.files.
    if (freshView && files > COLLAPSE_THRESHOLD) collapsed = new Set(renderedFileNames());
    applyCollapsed();
    if (msg.highlight) highlightRendered();
  }
  el.body.scrollTop = scrollTop;
  updateCollapseButton();
  updateFileListButton();
}

// Used when the diff is too large to render: the file list still tells you what moved.
function renderFileListOnly(msg) {
  const rows = (msg.files || []).map((f) => `<li class="gd-big-row">
      <span class="gd-big-path">${escapeHtml(f.isRename ? `${f.oldPath} → ${f.path}` : f.path)}</span>
      <span class="gd-big-stats"><span class="gd-add">+${f.additions}</span> <span class="gd-del">−${f.deletions}</span></span>
    </li>`).join('');
  const total = (msg.totals.additions + msg.totals.deletions).toLocaleString();
  // Two different limits land here: too many changed lines, or a patch too large to parse at
  // all. Only the first one is a setting the user can raise.
  const why = msg.tooBig?.reason === 'bytes'
    ? `The patch is ${formatBytes(msg.tooBig.bytes)}, too large to render. Use Copy patch to get it.`
    : `${total} changed lines, over the ${Number(msg.maxChanges).toLocaleString()} line limit. Raise "Max Changed Lines" in the plugin settings, or use Copy patch.`;
  return `<div class="gd-state gd-toobig">
      <div class="gd-error-title">Diff too large to render</div>
      <p>${why}</p>
    </div>
    <ul class="gd-big-list">${rows}</ul>`;
}

function renderedFileNames() {
  return [...el.body.querySelectorAll('.d2h-file-wrapper .d2h-file-name')]
    .map((n) => n.textContent.trim())
    .filter(Boolean);
}

function applyCollapsed() {
  for (const wrapper of el.body.querySelectorAll('.d2h-file-wrapper')) {
    const name = wrapper.querySelector('.d2h-file-name')?.textContent?.trim();
    wrapper.classList.toggle('gd-collapsed', !!name && collapsed.has(name));
  }
}

function toggleCollapseAll() {
  const wrappers = [...el.body.querySelectorAll('.d2h-file-wrapper')];
  if (!wrappers.length) return;
  const expandAll = wrappers.every((w) => w.classList.contains('gd-collapsed'));
  collapsed = expandAll ? new Set() : new Set(renderedFileNames());
  applyCollapsed();
  updateCollapseButton();
}

function updateCollapseButton() {
  const wrappers = [...el.body.querySelectorAll('.d2h-file-wrapper')];
  el.collapse.disabled = wrappers.length === 0;
  const allCollapsed = wrappers.length > 0 && wrappers.every((w) => w.classList.contains('gd-collapsed'));
  el.collapse.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
}

// diff2html's own hide/show links need the diff2html-ui bundle, which is not loaded, so the
// header button drives the file list instead and those links stay hidden by our CSS.
function toggleFileList() {
  const list = el.body.querySelector('.d2h-file-list-wrapper');
  if (!list) return;
  list.classList.toggle('gd-hidden');
  updateFileListButton();
}

function updateFileListButton() {
  const list = el.body.querySelector('.d2h-file-list-wrapper');
  el.files.disabled = !list;
  el.files.textContent = list && list.classList.contains('gd-hidden') ? 'Show files' : 'Hide files';
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

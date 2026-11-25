const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, nativeTheme,
  Notification, globalShortcut, session, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Engine, packagedRuntime } = require('./lib/engine.cjs');
const { Preferences, validatePreferences } = require('./lib/preferences.cjs');
const { UiState } = require('./lib/ui-state.cjs');
const { externalUrl, externalDestination, trustedDocument, assertFilePath, sameDocument } = require('./lib/policy.cjs');

app.setName('CliDeck');
if (process.env.CLIDECK_DESKTOP_PROFILE) app.setPath('userData', path.resolve(process.env.CLIDECK_DESKTOP_PROFILE));
const profile = app.getPath('userData');
const dataDir = path.resolve(process.env.CLIDECK_DESKTOP_DATA_DIR || path.join(os.homedir(), '.clideck-next'));
const startupUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
const preferences = new Preferences(profile);
const uiState = new UiState(profile, dataDir);
let win = null, tray = null, quitting = false, healthTimer = null, boundsTimer = null;
let engineUrl = '', startupReady = false, lastExternalAt = 0, activity = { working: 0, waiting: 0 };
const shortcuts = new Map();
const capabilities = Object.freeze({ desktop: true, notifications: true, badge: true,
  externalLinks: true, revealFile: true, globalShortcuts: true,
  vibrancy: process.platform === 'darwin', titleBarOverlay: process.platform === 'win32' });

const engine = new Engine({ dataDir, profile,
  runtime: async () => {
    if (app.isPackaged) return packagedRuntime(process.resourcesPath, profile);
    const node = process.env.CLIDECK_DESKTOP_NODE || process.env.npm_node_execpath;
    if (!node || !fs.existsSync(node)) throw new Error('Start development with npm start, or set CLIDECK_DESKTOP_NODE to a Node executable.');
    return { node, root: path.resolve(__dirname, '..') };
  },
  onState: state => {
    if (state.state === 'ready') {
      engineUrl = state.url;
      if (startupReady && win && !win.isDestroyed() && !sameDocument(win.webContents.getURL(), state.url)) {
        // A crashed engine can return on a different port. Its old origin cannot
        // reconnect there; only then navigate to the new engine's page.
        void win.loadURL(state.url).catch(error => showError(error));
      }
    }
    publishState();
  },
});

function snapshot() {
  return { platform: process.platform, version: app.getVersion(), capabilities,
    preferences: { ...preferences.value }, engine: { ...engine.state },
    window: { focused: Boolean(win?.isFocused()), fullscreen: Boolean(win?.isFullScreen()), maximized: Boolean(win?.isMaximized()) } };
}
function send(channel, value) {
  if (win && !win.isDestroyed() && trustedDocument(win.webContents.getURL(), engineUrl, startupUrl)) win.webContents.send(channel, value);
}
function publishState() { send('clideck:state', snapshot()); }
function action(id) { showWindow(); send('clideck:action', id); }
function showError(error) {
  engine.publish({ state: 'error', error: error.message || String(error) });
  if (win && !win.isDestroyed() && !trustedDocument(win.webContents.getURL(), engineUrl, startupUrl)) void win.loadURL(startupUrl);
}

function secureSession(target, allowMicrophone) {
  target.setPermissionCheckHandler((contents, permission, origin, details) => {
    const host = allowMicrophone && contents === win?.webContents
      && origin === new URL(engineUrl || 'http://127.0.0.1').origin;
    return Boolean(host && (permission === 'clipboard-sanitized-write'
      || (permission === 'media' && details?.mediaType === 'audio')));
  });
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const host = allowMicrophone && contents === win?.webContents
      && trustedDocument(details?.requestingUrl || contents.getURL(), engineUrl, startupUrl);
    callback(Boolean(host && (permission === 'clipboard-sanitized-write'
      || (permission === 'clipboard-read' && details?.userGesture)
      || (permission === 'media' && details?.mediaTypes?.length && details.mediaTypes.every(type => type === 'audio')))));
  });
}

async function systemLink(raw) { return shell.openExternal(externalUrl(raw).href); }
async function openLink(raw) {
  const url = externalUrl(raw);
  if (Date.now() - lastExternalAt < 350) return;
  lastExternalAt = Date.now();
  if (externalDestination(url.href, preferences.value.externalLinks) === 'browser') return systemLink(url.href);
  const browser = new BrowserWindow({ title: url.hostname, width: 1120, height: 800, show: false,
    autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: 'persist:external-web', webviewTag: false } });
  secureSession(browser.webContents.session, false);
  browser.webContents.setWindowOpenHandler(({ url: next }) => { void systemLink(next).catch(() => {}); return { action: 'deny' }; });
  for (const event of ['will-navigate', 'will-redirect']) browser.webContents.on(event, (ev, next) => {
    try {
      if (externalDestination(next, 'app') === 'browser') { ev.preventDefault(); void systemLink(next).catch(() => {}); }
    } catch { ev.preventDefault(); }
  });
  browser.once('ready-to-show', () => browser.show());
  await browser.loadURL(url.href);
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
  preferences.bounds = win.getNormalBounds(); preferences.save();
}
function createWindow() {
  startupReady = false;
  let bounds = preferences.bounds;
  if (bounds && !screen.getAllDisplays().some(display => {
    const r = display.workArea;
    return bounds.x < r.x + r.width && bounds.x + bounds.width > r.x && bounds.y < r.y + r.height && bounds.y + bounds.height > r.y;
  })) bounds = null;
  const mac = process.platform === 'darwin', windows = process.platform === 'win32';
  win = new BrowserWindow({ width: 1440, height: 960, ...(bounds || {}), minWidth: 760, minHeight: 520,
    title: 'CliDeck', show: false, backgroundColor: mac ? '#00000000' : '#151517',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    ...(mac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 },
      vibrancy: 'sidebar', visualEffectState: 'followWindow', transparent: true } : {}),
    ...(windows ? { titleBarStyle: 'hidden', titleBarOverlay: { height: 54, color: '#151517', symbolColor: '#eeeeee' } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, backgroundThrottling: false, spellcheck: false,
      partition: 'persist:clideck' },
  });
  secureSession(win.webContents.session, true);
  win.webContents.setWindowOpenHandler(({ url }) => { void openLink(url).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (trustedDocument(url, engineUrl, startupUrl)) return;
    event.preventDefault(); void openLink(url).catch(() => {});
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('did-finish-load', publishState);
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3 || !isMainFrame || url === startupUrl || !trustedDocument(url, engineUrl, startupUrl)) return;
    engine.publish({ state: 'error', error: `Could not connect to the engine (${description}). Your saved sessions are preserved.` });
    void win.loadURL(startupUrl).catch(error => console.error(error.message));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) { engine.publish({ state: 'error', error: `The window stopped (${details.reason}). Your engine is still running.` }); void win.loadURL(startupUrl); }
  });
  win.on('close', event => {
    saveBounds();
    if (!quitting && preferences.value.closeToTray) { event.preventDefault(); win.hide(); publishState(); }
  });
  win.on('closed', () => { win = null; });
  for (const event of ['focus', 'blur', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) win.on(event, publishState);
  for (const event of ['move', 'resize']) win.on(event, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 250); });
  win.once('ready-to-show', () => win?.show());
  void win.loadURL(startupUrl).then(() => {
    startupReady = true;
    if (engine.state.state === 'ready' && win && !win.isDestroyed()) return win.loadURL(engine.state.url);
  }).catch(showError);
  return win;
}
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore(); win.show(); win.focus();
}

function menuItem(label, accelerator, id) { return { label, accelerator, click: () => action(id) }; }
function setupMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'CliDeck', submenu: [{ role: 'about' }, menuItem('Settings…', 'CmdOrCtrl+,', 'settings'),
      menuItem('Check for Updates…', undefined, 'check-updates'), { type: 'separator' },
      ...(mac ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : []),
      { label: 'Quit CliDeck', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { label: 'File', submenu: [menuItem('New Session', 'CmdOrCtrl+N', 'new-session'),
      menuItem('New Project', 'CmdOrCtrl+Shift+N', 'new-project'), { type: 'separator' },
      menuItem('Close Tab', 'CmdOrCtrl+W', 'close-tab'), { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => win?.close() }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [menuItem('Toggle Sidebar', mac ? 'Ctrl+Command+S' : 'Ctrl+Shift+S', 'toggle-sidebar'),
      menuItem('Find', 'CmdOrCtrl+F', 'find'), menuItem('Conversation History', 'CmdOrCtrl+Y', 'history'),
      { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Go', submenu: [menuItem('Next Session', 'Ctrl+Tab', 'next-session'), menuItem('Previous Session', 'Ctrl+Shift+Tab', 'prev-session'),
      menuItem('Next Unread', 'CmdOrCtrl+J', 'next-unread'), { type: 'separator' },
      ...Array.from({ length: 9 }, (_, i) => menuItem(`Session ${i + 1}`, `CmdOrCtrl+${i + 1}`, `session-${i + 1}`))] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'CliDeck Help', click: () => { void systemLink('https://clideck.dev'); } },
      { label: 'Report an Issue', click: () => { void systemLink('https://github.com/rustykuntz/clideck/issues'); } },
      { label: 'Show Logs', click: () => shell.showItemInFolder(engine.state.logPath) },
    ] },
  ]));
}
function updateTray() {
  tray?.setToolTip('CliDeck');
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `${activity.working} working · ${activity.waiting} waiting`, enabled: false },
    { label: 'Open CliDeck', click: showWindow }, { label: 'New Session', click: () => action('new-session') },
    { type: 'separator' }, { label: 'Quit CliDeck', click: () => app.quit() },
  ]));
}
function setupTray() {
  const iconPath = path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  let image = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') image.setTemplateImage(true);
  else image = image.resize({ width: 20, height: 20 });
  tray = new Tray(image); tray.on('click', showWindow); updateTray();
}

function requireHost(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame
    || !trustedDocument(event.senderFrame.url, engineUrl, startupUrl)) throw new Error('Desktop access is restricted to the CliDeck window.');
}
function count(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1000000) throw new Error('Invalid count.');
  return value;
}
function setupBridge() {
  ipcMain.on('clideck:bootstrap', event => {
    try {
      requireHost(event);
      const url = new URL(event.senderFrame.url);
      event.returnValue = { allowed: true, restore: url.protocol === 'http:' ? uiState.restore(url.origin) : null };
    } catch { event.returnValue = { allowed: false }; }
  });
  ipcMain.on('clideck:ui-state', (event, entries) => {
    try {
      requireHost(event);
      const url = new URL(event.senderFrame.url);
      if (url.protocol === 'http:') uiState.save(url.origin, entries);
    } catch (error) { console.error(`Desktop UI preferences: ${error.message}`); }
  });
  const methods = {
    getState: snapshot, getPreferences: () => ({ ...preferences.value }),
    setPreferences: patch => {
      validatePreferences(patch);
      if ('startAtLogin' in patch) {
        if (process.platform === 'linux') throw new Error('Start at login is configured through your desktop environment on Linux.');
        app.setLoginItemSettings({ openAtLogin: patch.startAtLogin });
      }
      preferences.update(patch); publishState(); return { ...preferences.value };
    },
    openExternal: systemLink,
    showItemInFolder: value => shell.showItemInFolder(assertFilePath(value)),
    notify: value => {
      if (!value || typeof value.title !== 'string' || typeof value.body !== 'string'
        || value.title.length > 200 || value.body.length > 4000
        || (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length > 200))) throw new Error('Invalid notification.');
      if (!Notification.isSupported()) return false;
      const notice = new Notification({ title: value.title, body: value.body });
      notice.on('click', () => action(value.sessionId ? { id: 'focus-session', sessionId: value.sessionId } : 'show-window'));
      notice.show(); return true;
    },
    setBadgeCount: value => { app.setBadgeCount(count(value)); return true; },
    setActivity: value => { activity = { working: count(value?.working), waiting: count(value?.waiting) }; updateTray(); return true; },
    setAppearance: value => {
      const mode = typeof value === 'string' ? value : value?.mode;
      if (!['light', 'dark', 'system'].includes(mode)) throw new Error('Invalid appearance.');
      nativeTheme.themeSource = mode;
      if (process.platform === 'win32' && value.overlay) {
        if (![value.overlay.color, value.overlay.symbolColor].every(c => /^#(?:[a-f0-9]{6}|[a-f0-9]{8})$/i.test(c))) throw new Error('Invalid title bar colors.');
        win?.setTitleBarOverlay({ ...value.overlay, height: 54 });
      }
      return true;
    },
    retryEngine: () => engine.start(), hideWindow: () => { win?.hide(); publishState(); },
    quit: () => { setImmediate(() => app.quit()); return true; },
    registerShortcut: value => {
      if (!value || !/^[a-zA-Z0-9:._-]{1,160}$/.test(value.id) || typeof value.accelerator !== 'string'
        || value.accelerator.length > 100 || shortcuts.size >= 32 || shortcuts.has(value.id)) throw new Error('Invalid or duplicate shortcut.');
      if (!globalShortcut.register(value.accelerator, () => action({ id: 'shortcut', shortcutId: value.id }))) throw new Error('This shortcut is already in use.');
      shortcuts.set(value.id, value.accelerator); return true;
    },
    unregisterShortcut: id => { const accelerator = shortcuts.get(id); if (accelerator) globalShortcut.unregister(accelerator); shortcuts.delete(id); return true; },
  };
  ipcMain.handle('clideck:desktop', (event, method, ...args) => {
    requireHost(event);
    if (!Object.hasOwn(methods, method)) throw new Error('Unknown desktop operation.');
    return methods[method](...args);
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (app.isReady()) showWindow(); });
  app.on('activate', () => { if (app.isReady()) showWindow(); });
  app.on('window-all-closed', () => { if (!preferences.value.closeToTray) app.quit(); });
  app.on('before-quit', () => { quitting = true; clearInterval(healthTimer); clearTimeout(boundsTimer); saveBounds(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: 'CliDeck', applicationVersion: app.getVersion(), copyright: 'Or Kuntzman' });
    setupBridge(); setupMenu(); setupTray(); createWindow();
    void engine.start();
    healthTimer = setInterval(() => { void engine.check(); }, 10000);
    healthTimer.unref();
  }).catch(error => { console.error(error.message); app.quit(); });
}

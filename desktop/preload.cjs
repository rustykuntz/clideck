const { contextBridge, ipcRenderer } = require('electron');

const bootstrap = process.isMainFrame ? ipcRenderer.sendSync('clideck:bootstrap') : null;
if (bootstrap?.allowed) {
  if (location.protocol === 'http:') {
    if (bootstrap.restore) {
      localStorage.clear();
      for (const [key, value] of Object.entries(bootstrap.restore)) localStorage.setItem(key, value);
    }
    let previous = '';
    const save = () => {
      const entries = Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
      const serialized = JSON.stringify(entries);
      if (serialized !== previous) { previous = serialized; ipcRenderer.send('clideck:ui-state', entries); }
    };
    // No writes when idle. The unload snapshot also covers engine navigation,
    // so the next origin restores before its first application script executes.
    const timer = setInterval(save, 2000);
    window.addEventListener('beforeunload', () => { clearInterval(timer); save(); });
    save();
  }
  const invoke = method => (...args) => ipcRenderer.invoke('clideck:desktop', method, ...args);
  const subscribe = channel => callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
  contextBridge.exposeInMainWorld('clideckDesktop', {
    platform: process.platform,
    capabilities: { desktop: true, notifications: true, badge: true, externalLinks: true,
      revealFile: true, globalShortcuts: true, vibrancy: process.platform === 'darwin', titleBarOverlay: process.platform === 'win32' },
    getState: invoke('getState'), getPreferences: invoke('getPreferences'), setPreferences: invoke('setPreferences'),
    openExternal: invoke('openExternal'), showItemInFolder: invoke('showItemInFolder'), notify: invoke('notify'),
    setBadgeCount: invoke('setBadgeCount'), setActivity: invoke('setActivity'), setAppearance: invoke('setAppearance'),
    retryEngine: invoke('retryEngine'), quit: invoke('quit'), hideWindow: invoke('hideWindow'),
    registerShortcut: invoke('registerShortcut'), unregisterShortcut: invoke('unregisterShortcut'),
    onState: subscribe('clideck:state'), onAction: subscribe('clideck:action'),
  });
}

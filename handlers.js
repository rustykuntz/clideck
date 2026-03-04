const config = require('./config');
const sessions = require('./sessions');
const themes = require('./themes');
const presets = require('./agent-presets.json');
const { listDirs } = require('./utils');
const transcript = require('./transcript');

let cfg = config.load();

function onConnection(ws) {
  sessions.clients.add(ws);

  ws.send(JSON.stringify({ type: 'config', config: cfg }));
  ws.send(JSON.stringify({ type: 'themes', themes }));
  ws.send(JSON.stringify({ type: 'presets', presets }));
  ws.send(JSON.stringify({ type: 'sessions', list: sessions.list() }));
  ws.send(JSON.stringify({ type: 'sessions.resumable', list: sessions.getResumable() }));
  ws.send(JSON.stringify({ type: 'transcript.cache', cache: transcript.getCache() }));
  sessions.sendBuffers(ws);

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.type) {
      case 'create':          sessions.create(msg, ws, cfg); break;
      case 'session.resume':  sessions.resume(msg, ws, cfg); break;
      case 'input':           sessions.input(msg); break;
      case 'resize':          sessions.resize(msg); break;
      case 'rename':          sessions.rename(msg); break;
      case 'close':           sessions.close(msg); break;

      case 'config.get':
        ws.send(JSON.stringify({ type: 'config', config: cfg }));
        break;

      case 'config.update':
        cfg = { ...cfg, ...msg.config };
        config.save(cfg);
        sessions.broadcast({ type: 'config', config: cfg });
        break;

      case 'session.theme': {
        const ok = sessions.setTheme(msg.id, msg.themeId);
        if (ok) sessions.broadcast({ type: 'session.theme', id: msg.id, themeId: msg.themeId });
        break;
      }

      case 'dirs.list': {
        const target = msg.path || cfg.defaultPath;
        const result = listDirs(target);
        const entries = Array.isArray(result) ? result : [];
        const error = result.error || undefined;
        ws.send(JSON.stringify({ type: 'dirs', path: target, entries, error }));
        break;
      }
    }
  });

  ws.on('close', () => sessions.clients.delete(ws));
}

function getConfig() { return cfg; }

module.exports = { onConnection, getConfig };

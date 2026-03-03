const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');
const { onConnection } = require('./handlers');
const sessions = require('./sessions');

ensurePtyHelper();
sessions.loadSessions();

const PORT = 4000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ALIASES = {
  '/xterm.css':    join(__dirname, 'node_modules/xterm/css/xterm.css'),
  '/xterm.js':     join(__dirname, 'node_modules/xterm/lib/xterm.js'),
  '/addon-fit.js': join(__dirname, 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const filePath = ALIASES[req.url]
    || resolve(PUBLIC_ROOT, (req.url === '/' ? 'index.html' : req.url).replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_ROOT) && !ALIASES[req.url]) return res.writeHead(403).end();
  if (!existsSync(filePath)) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch { res.writeHead(500).end(); }
});

const wss = new WebSocketServer({ server });
wss.on('connection', onConnection);

// TEMPORARY: stats overlay
const stats = require('./stats');
stats.start(sessions.getSessions(), sessions.broadcast);

// Graceful shutdown: persist sessions before exit
const { getConfig } = require('./handlers');
function onShutdown() {
  stats.stop();
  sessions.shutdown(getConfig());
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

server.listen(PORT, () => console.log(`Terminal UI → http://localhost:${PORT}`));

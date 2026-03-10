const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');
const { onConnection } = require('./handlers');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const plugins = require('./plugin-loader');

ensurePtyHelper();
sessions.loadSessions();
transcript.init(sessions.broadcast, new Set(sessions.getResumable().map(s => s.id)));
telemetry.init(sessions.broadcast, sessions.getSessions);
require('./opencode-bridge').init(sessions.broadcast, sessions.getSessions);
const config = require('./config');
plugins.init(sessions.broadcast, sessions.getSessions, () => require('./handlers').getConfig(), (cfg) => config.save(cfg));

const PORT = 4000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const ALIASES = {
  '/xterm.css':    join(__dirname, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/xterm.js':     join(__dirname, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/addon-fit.js': join(__dirname, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');

const server = http.createServer((req, res) => {
  // OTLP telemetry endpoint — receives JSON from CLI agents
  // Some agents (Gemini) POST to / instead of /v1/logs
  if (req.method === 'POST' && (req.url === '/v1/logs' || req.url === '/')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); return; }
    });
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      try { req.body = JSON.parse(body); } catch {
        console.log(`OTLP: failed to parse body (content-type: ${contentType}, ${body.length} bytes)`);
        req.body = null;
      }
      telemetry.handleLogs(req, res);
    });
    return;
  }

  // OpenCode plugin bridge events
  if (req.method === 'POST' && req.url === '/opencode-events') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { require('./opencode-bridge').handleEvent(JSON.parse(body)); } catch (e) { console.error('[opencode-bridge] handleEvent error:', e); }
      res.writeHead(200).end('{}');
    });
    return;
  }

  // DEBUG: log any POST (agents might use /v1/traces, /v1/metrics, or other paths)
  if (req.method === 'POST') {
    console.log(`OTLP: received POST ${req.url} (not handled)`);
    return res.writeHead(200).end('{}');
  }

  // Plugin static files (/plugins/<id>/client.js, /plugins/<id>/public/*)
  if (req.url.startsWith('/plugins/')) {
    const pluginFile = plugins.resolveFile(req.url);
    if (pluginFile) {
      res.writeHead(200, { 'Content-Type': MIME[extname(pluginFile)] || 'application/javascript' });
      return res.end(readFileSync(pluginFile));
    }
    return res.writeHead(404).end();
  }

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

const activity = require('./activity');
activity.start(sessions.getSessions(), sessions.broadcast);
sessions.startAutoSave(() => require('./handlers').getConfig());

// Graceful shutdown: persist sessions before exit
const { getConfig } = require('./handlers');
function onShutdown() {
  plugins.shutdown();
  activity.stop();
  sessions.shutdown(getConfig());
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

server.listen(PORT, '127.0.0.1', () => {
  const v = require('./package.json').version;
  const url = `http://localhost:${PORT}`;
  console.log(`
\x1b[38;5;141m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;141m   ██████╗\x1b[38;5;105m██╗     \x1b[38;5;69m██╗\x1b[38;5;33m██████╗ \x1b[38;5;38m███████╗\x1b[38;5;44m ██████╗\x1b[38;5;50m██╗  ██╗\x1b[0m
\x1b[38;5;141m  ██╔════╝\x1b[38;5;105m██║     \x1b[38;5;69m██║\x1b[38;5;33m██╔══██╗\x1b[38;5;38m██╔════╝\x1b[38;5;44m██╔════╝\x1b[38;5;50m██║ ██╔╝\x1b[0m
\x1b[38;5;141m  ██║     \x1b[38;5;105m██║     \x1b[38;5;69m██║\x1b[38;5;33m██║  ██║\x1b[38;5;38m█████╗  \x1b[38;5;44m██║     \x1b[38;5;50m█████╔╝ \x1b[0m
\x1b[38;5;141m  ██║     \x1b[38;5;105m██║     \x1b[38;5;69m██║\x1b[38;5;33m██║  ██║\x1b[38;5;38m██╔══╝  \x1b[38;5;44m██║     \x1b[38;5;50m██╔═██╗ \x1b[0m
\x1b[38;5;141m  ╚██████╗\x1b[38;5;105m███████╗\x1b[38;5;69m██║\x1b[38;5;33m██████╔╝\x1b[38;5;38m███████╗\x1b[38;5;44m╚██████╗\x1b[38;5;50m██║  ██╗\x1b[0m
\x1b[38;5;141m   ╚═════╝\x1b[38;5;105m╚══════╝\x1b[38;5;69m╚═╝\x1b[38;5;33m╚═════╝ \x1b[38;5;38m╚══════╝\x1b[38;5;44m ╚═════╝\x1b[38;5;50m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;141m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${v}\x1b[0m

\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${url}\x1b[0m
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m
`);
});

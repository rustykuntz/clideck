const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');

// --- Self-update check (runs before server starts) ---
const currentVersion = require('./package.json').version;
const { execFile, execSync } = require('child_process');
const shellOpt = process.platform === 'win32';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4000;

function readCliOption(name) {
  const args = process.argv.slice(2);
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) {
      const value = args[i + 1];
      if (value && !value.startsWith('--')) return value;
      return null;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

function resolveHost() {
  const host = readCliOption('host') || process.env.CLIDECK_HOST || DEFAULT_HOST;
  return host.trim() || DEFAULT_HOST;
}

function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::';
}

function formatUrl(host, port) {
  if (host.includes(':') && !host.startsWith('[')) return `http://[${host}]:${port}`;
  return `http://${host}:${port}`;
}

function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function getReadyUrls(host, port) {
  if (host === '127.0.0.1' || host === '::1') return { localUrl: `http://localhost:${port}` };
  if (isWildcardHost(host)) {
    const lanAddress = getLanAddress();
    return {
      localUrl: `http://localhost:${port}`,
      lanUrl: lanAddress ? formatUrl(lanAddress, port) : null,
    };
  }
  return { localUrl: formatUrl(host, port) };
}

function checkSelfUpdate() {
  return new Promise(ok => {
    // Skip in non-interactive or local dev contexts
    if (!process.stdin.isTTY || !process.stdout.isTTY) return ok();
    if (!__dirname.includes(join('node_modules', 'clideck'))) return ok();
    execFile('npm', ['view', 'clideck', 'version'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
      if (err) return ok();
      const latest = stdout.trim();
      if (!latest || latest === currentVersion) return ok();
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n\x1b[38;5;105m  Update available:\x1b[0m \x1b[38;5;245m${currentVersion}\x1b[0m → \x1b[38;5;44m${latest}\x1b[0m\n\n  \x1b[38;5;252mUpdate now? [Y/n]\x1b[0m `, answer => {
        rl.close();
        if (answer.trim().toLowerCase() === 'n') return ok();
        console.log('\n  \x1b[38;5;245mUpdating...\x1b[0m\n');
        try {
          execSync('npm install -g clideck', { stdio: 'inherit', shell: true });
          console.log('\n  \x1b[38;5;44mUpdated to v' + latest + '. Restarting...\x1b[0m\n');
          const { spawn } = require('child_process');
          spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', shell: shellOpt }).on('close', code => process.exit(code));
          return;
        } catch {
          console.log('\n  \x1b[38;5;196mUpdate failed.\x1b[0m Continuing with v' + currentVersion + '.\n');
          ok();
        }
      });
    });
  });
}

checkSelfUpdate().then(() => {

const { onConnection } = require('./handlers');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const plugins = require('./plugin-loader');

ensurePtyHelper();
sessions.loadSessions();
transcript.init(sessions.broadcast, new Set(sessions.getResumable().map(s => s.id)), (...args) => plugins.notifyTranscript(...args));
telemetry.init(sessions.broadcast, sessions.getSessions);
require('./opencode-bridge').init(sessions.broadcast, sessions.getSessions);
const config = require('./config');
plugins.init(sessions.broadcast, sessions.getSessions, () => require('./handlers').getConfig(), (cfg) => config.save(cfg));

const PORT = DEFAULT_PORT;
const HOST = resolveHost();
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

server.listen(PORT, HOST, () => {
  const v = require('./package.json').version;
  const { localUrl, lanUrl } = getReadyUrls(HOST, PORT);
  const accessLine = lanUrl ? `\x1b[38;5;252m  ▸ Local \x1b[38;5;44m${localUrl}\x1b[0m\n\x1b[38;5;252m  ▸ LAN   \x1b[38;5;44m${lanUrl}\x1b[0m`
    : `\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${localUrl}\x1b[0m`;
  const bindLine = HOST !== DEFAULT_HOST
    ? `\n\x1b[38;5;245m  ▸ Listening on \x1b[38;5;252m${HOST}\x1b[0m`
    : '';
  console.log(`
\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;239m   ██████╗\x1b[38;5;242m██╗     \x1b[38;5;245m██╗\x1b[38;5;105m██████╗ \x1b[38;5;141m███████╗\x1b[38;5;147m ██████╗\x1b[38;5;183m██╗  ██╗\x1b[0m
\x1b[38;5;239m  ██╔════╝\x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██╔══██╗\x1b[38;5;141m██╔════╝\x1b[38;5;147m██╔════╝\x1b[38;5;183m██║ ██╔╝\x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m█████╗  \x1b[38;5;147m██║     \x1b[38;5;183m█████╔╝ \x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m██╔══╝  \x1b[38;5;147m██║     \x1b[38;5;183m██╔═██╗ \x1b[0m
\x1b[38;5;239m  ╚██████╗\x1b[38;5;242m███████╗\x1b[38;5;245m██║\x1b[38;5;105m██████╔╝\x1b[38;5;141m███████╗\x1b[38;5;147m╚██████╗\x1b[38;5;183m██║  ██╗\x1b[0m
\x1b[38;5;239m   ╚═════╝\x1b[38;5;242m╚══════╝\x1b[38;5;245m╚═╝\x1b[38;5;105m╚═════╝ \x1b[38;5;141m╚══════╝\x1b[38;5;147m ╚═════╝\x1b[38;5;183m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${v}\x1b[0m

\x1b[0m${accessLine}${bindLine}
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m
`);
});

}); // checkSelfUpdate

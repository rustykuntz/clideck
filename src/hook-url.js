const http = require('http');
const https = require('https');

function serverUrl(host, port) {
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

function resolveHookUrl(path, port, rawUrl = process.env.CLIDECK_URL) {
  let base = serverUrl('127.0.0.1', port);
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') base = parsed;
  } catch {}
  return new URL(path, base);
}

function requestHook(path, port, options, rawUrl) {
  const target = resolveHookUrl(path, port, rawUrl);
  const request = (target.protocol === 'https:' ? https : http).request(target, options);
  request.on('timeout', () => request.destroy());
  return request;
}

module.exports = { serverUrl, resolveHookUrl, requestHook };

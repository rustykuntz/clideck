const http = require('http');
const https = require('https');

function resolveHookUrl(path, port, rawUrl = process.env.CLIDECK_URL) {
  const fallback = new URL(`http://localhost:${port}`);
  let base = fallback;

  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') base = parsed;
    } catch {}
  }

  return new URL(path, base);
}

function requestHook(path, port, options) {
  const target = resolveHookUrl(path, port);
  const client = target.protocol === 'https:' ? https : http;
  return client.request(target, options);
}

module.exports = { resolveHookUrl, requestHook };

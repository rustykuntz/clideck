const { createReadStream } = require('fs');
const { readFile, stat } = require('fs/promises');
const { dirname, extname, resolve, sep } = require('path');

const PUBLIC_DIR = resolve(__dirname, '../public');
const XTERM_JS = require.resolve('@xterm/xterm');
const MERMAID_JS = resolve(
  dirname(require.resolve('mermaid/package.json')),
  'dist/mermaid.min.js',
);
const VENDOR_FILES = new Map([
  ['/vendor/xterm.js', XTERM_JS],
  ['/vendor/addon-unicode11.js', require.resolve('@xterm/addon-unicode11')],
  ['/vendor/xterm.css', resolve(dirname(XTERM_JS), '../css/xterm.css')],
  ['/vendor/mermaid.js', MERMAID_JS],
]);
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.onnx', 'application/octet-stream'],
  ['.bin', 'application/octet-stream'],
  ['.woff2', 'font/woff2'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.pdf', 'application/pdf'],
  ['.svg', 'image/svg+xml'],
]);

function publicFile(pathname) {
  const relativePath = pathname === '/' ? 'index.html' : `.${pathname}`;
  const filePath = resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${sep}`)) return null;
  return filePath;
}

async function serveStatic(req, res, { uiVersion } = {}) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const filePath = VENDOR_FILES.get(pathname) || publicFile(pathname);
  const contentType = filePath && CONTENT_TYPES.get(extname(filePath));
  if (!filePath || !contentType) {
    res.writeHead(404).end();
    return;
  }

  try {
    let body = await readFile(filePath);
    if (filePath === resolve(PUBLIC_DIR, 'index.html') && uiVersion) {
      try {
        // Capture the page's own identity; reconnect config is not its baseline.
        const { version } = await uiVersion({ fresh: true });
        if (typeof version === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(version)) {
          body = body.toString('utf8').replace('<head>', `<head>\n<meta name="clideck-ui-version" content="${version}">`);
        }
      } catch { /* Version discovery must never prevent the interface loading. */ }
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}

async function servePluginStatic(req, res, pluginManager) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  const match = pathname.match(/^\/plugins\/([a-z][a-z0-9-]{0,62})\/(client\.js|public\/.+)$/);
  if (!match) return false;
  const filePath = pluginManager?.assetPath(match[1], match[2]);
  const contentType = filePath && CONTENT_TYPES.get(extname(filePath));
  if (!filePath || !contentType) {
    res.writeHead(404).end();
    return true;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file.');
    if (!info.size && !req.headers.range) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        'Content-Length': 0,
      }).end();
      return true;
    }
    const range = req.headers.range && String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = info.size - 1;
    if (req.headers.range) {
      if (!range || (!range[1] && !range[2])) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return true;
      }
      if (!range[1]) start = Math.max(0, info.size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2]) end = Number(range[2]);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start >= info.size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return true;
      }
      end = Math.min(end, info.size - 1);
    }
    const partial = Boolean(req.headers.range);
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(partial && { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
    });
    createReadStream(filePath, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(404).end();
    else res.destroy();
  }
  return true;
}

module.exports = { CONTENT_TYPES, servePluginStatic, serveStatic };

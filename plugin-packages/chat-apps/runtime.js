const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Optional dependencies live with this plugin's private data, never in the engine
// or a signed desktop bundle. Installed only when the user chooses Connect.
async function loadRuntime(dataDir) {
  const lock = fs.readFileSync(path.join(__dirname, 'runtime/package-lock.json'));
  const digest = createHash('sha256').update(lock).digest('hex').slice(0, 16);
  const dir = path.join(dataDir, 'runtime-' + digest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ready = path.join(dir, '.ready');
  if (!fs.existsSync(ready)) {
    fs.copyFileSync(path.join(__dirname, 'runtime/package.json'), path.join(dir, 'package.json'));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), lock);
    try {
      await promisify(execFile)('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: dir, timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    } catch { throw Error('Could not install WhatsApp support. Check your internet connection and that Node.js/npm is available, then Connect again.'); }
  }
  const requireRuntime = createRequire(path.join(dir, 'package.json'));
  const baileys = await import(pathToFileURL(requireRuntime.resolve('@whiskeysockets/baileys')).href);
  const qrcode = requireRuntime('qrcode');
  const logger = requireRuntime('pino')({ level: 'silent' });
  fs.writeFileSync(ready, 'ready\n', { mode: 0o600 });
  return { baileys, qrcode, logger };
}
module.exports = { loadRuntime };

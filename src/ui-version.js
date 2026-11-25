const fs = require('fs/promises');
const { join, relative, extname, resolve } = require('path');
const { createHash } = require('crypto');
const { version: RUNNING_VERSION } = require('../package.json');

const UI_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json']);

// Only application assets, never session data or a recursive node_modules scan.
// Content identity avoids notices on unchanged reinstalls and mere file touches.
function createUiVersion({ root = resolve(__dirname, '..'), runningVersion = RUNNING_VERSION,
  now = Date.now, cacheMs = 30_000 } = {}) {
  let cached = null, signature = '', checkedAt = -Infinity, pending = null;

  async function filesIn(directory) {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await filesIn(path));
      else if (entry.isFile() && UI_EXTENSIONS.has(extname(entry.name))) files.push(path);
    }
    return files;
  }

  async function manifest() {
    const files = [join(root, 'package.json'), ...await filesIn(join(root, 'public'))].sort();
    const stats = await Promise.all(files.map(path => fs.stat(path)));
    return { files, signature: JSON.stringify(files.map((path, i) => {
      const s = stats[i];
      return [relative(root, path), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
    })) };
  }

  async function read() {
    const before = await manifest();
    if (!cached || before.signature !== signature) {
      const hash = createHash('sha256');
      let diskVersion;
      for (const path of before.files) {
        const body = await fs.readFile(path);
        hash.update(relative(root, path)).update('\0').update(String(body.length)).update('\0').update(body);
        if (path === join(root, 'package.json')) diskVersion = JSON.parse(body).version;
      }
      if (typeof diskVersion !== 'string' || !diskVersion) throw new Error('UI package version unavailable.');
      // A package replacement/edit in progress must not advertise a partial build.
      if ((await manifest()).signature !== before.signature) throw new Error('UI files are changing.');
      cached = { version: hash.digest('hex'), restartRequired: diskVersion !== runningVersion };
      signature = before.signature;
    }
    checkedAt = now();
    return { ...cached };
  }

  return function uiVersion({ fresh = false } = {}) {
    if (pending) return pending;
    if (!fresh && cached && now() - checkedAt < cacheMs) return Promise.resolve({ ...cached });
    pending = read().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createUiVersion };

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({ externalLinks: 'browser', closeToTray: true, startAtLogin: false });

function validatePreferences(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid desktop settings.');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'externalLinks' && ['browser', 'app'].includes(value)) continue;
    if (['closeToTray', 'startAtLogin'].includes(key) && typeof value === 'boolean') continue;
    throw new Error(`Invalid desktop setting: ${key}`);
  }
  return patch;
}

class Preferences {
  constructor(directory) {
    this.path = path.join(directory, 'desktop.json');
    this.value = { ...DEFAULTS }; this.bounds = null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.path, 'utf8'));
      this.value = { ...DEFAULTS, ...validatePreferences(saved.preferences) };
      if (saved.bounds && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(saved.bounds[k]))) this.bounds = saved.bounds;
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = 'Desktop settings could not be read; defaults are in use.';
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + `.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ preferences: this.value, bounds: this.bounds }), { mode: 0o600 });
    fs.renameSync(temporary, this.path);
  }
  update(patch) { this.value = { ...this.value, ...validatePreferences(patch) }; this.save(); return { ...this.value }; }
}
module.exports = { Preferences, DEFAULTS, validatePreferences };

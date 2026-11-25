const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// The engine owns chats/config. This small backup only preserves browser-local
// presentation preferences when a busy port forces a new loopback origin.
class UiState {
  constructor(profile, dataDir) {
    this.path = path.join(profile, `ui-state-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}.json`);
    try { this.saved = JSON.parse(fs.readFileSync(this.path, 'utf8')); } catch { this.saved = null; }
  }
  restore(origin) { return this.saved?.origin !== origin ? this.saved?.entries || null : null; }
  save(origin, entries) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)
      || Object.values(entries).some(value => typeof value !== 'string')) throw new Error('Invalid UI state.');
    const body = JSON.stringify({ origin, entries });
    if (Buffer.byteLength(body) > 5 * 1024 * 1024) throw new Error('UI state exceeds the browser storage limit.');
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + `.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 }); fs.renameSync(temporary, this.path);
    this.saved = { origin, entries };
  }
}
module.exports = { UiState };

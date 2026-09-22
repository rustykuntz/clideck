'use strict';
// Bounded update check for the nonblocking startup notice.
//
// checkForUpdate({ currentVersion }) resolves to the newest stable semver on
// the registry that is a newer release than currentVersion, or null. A
// prerelease current is superseded by the stable release of its own core
// (semver: 2.4.0-beta.1 < 2.4.0); a stable current is never told to update to
// an equal or older version. Every
// failure mode (network, DNS, timeout, non-200, oversized body, invalid JSON,
// invalid versions, equal/older/prerelease latest) becomes null: the check
// never rejects and never hangs startup. The deadline timer is unref'd so it
// cannot keep the process alive.
//
// No dependencies, no shell, no npm install, no auto-install or restart —
// callers decide whether and how to display an upgrade hint. Production
// callers pass the package.json version as currentVersion, not a git label.

const https = require('https');

const DEFAULT_URL = 'https://registry.npmjs.org/clideck/latest';
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_MAX_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
    core: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

// Registry prereleases never qualify. Release cores are compared first; when
// the cores are equal, the stable release wins only against a prerelease
// current (2.4.0-beta.1 -> 2.4.0 counts, 2.4.0 -> 2.4.0 does not).
function isNewerRelease(current, latest) {
  if (latest.major !== current.major) return latest.major > current.major;
  if (latest.minor !== current.minor) return latest.minor > current.minor;
  if (latest.patch !== current.patch) return latest.patch > current.patch;
  return current.prerelease !== '';
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function withDeadline(promise, timeoutMs) {
  return new Promise((resolveWith, rejectWith) => {
    const timer = setTimeout(
      () => rejectWith(new Error('Update check timed out.')),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolveWith(value); },
      (error) => { clearTimeout(timer); rejectWith(error); },
    );
  });
}

function httpsGetBody(url, timeoutMs, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    let settled = false;
    let timer = null;
    let request = null;
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectBody(error);
      else resolveBody(body);
    };
    timer = setTimeout(() => {
      const error = new Error('Update check timed out.');
      if (request) request.destroy(error);
      finish(error);
    }, timeoutMs);
    timer.unref?.();
    request = https.get(url, {
      headers: { accept: 'application/json', 'user-agent': 'clideck-update-check' },
    }, (response) => {
      response.on('error', finish);
      response.on('aborted', () => finish(new Error('Update check response aborted.')));
      if (response.statusCode !== 200) {
        response.destroy();
        request.destroy();
        finish(new Error(`Update check got HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy();
          finish(new Error('Update check response exceeded the size bound.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
    });
    request.on('error', finish);
  });
}

async function checkForUpdate(options = {}) {
  try {
    const current = parseSemver(options.currentVersion);
    if (!current) return null;
    const timeoutMs = boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    const maxBytes = boundedNumber(options.maxBytes, DEFAULT_MAX_BYTES, 1024, MAX_MAX_BYTES);
    const url = typeof options.url === 'string' && options.url ? options.url : DEFAULT_URL;
    const fetchBody = typeof options.transport === 'function'
      ? options.transport
      : (requestUrl) => httpsGetBody(requestUrl, timeoutMs, maxBytes);
    const body = await withDeadline(
      Promise.resolve().then(() => fetchBody(url, { timeoutMs, maxBytes })),
      timeoutMs,
    );
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > maxBytes) return null;
    const payload = JSON.parse(body);
    const latest = parseSemver(payload && typeof payload === 'object' ? payload.version : undefined);
    if (!latest || latest.prerelease) return null;
    return isNewerRelease(current, latest) ? latest.core : null;
  } catch {
    return null;
  }
}

module.exports = {
  checkForUpdate,
  parseSemver,
};

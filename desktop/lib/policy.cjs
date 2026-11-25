const { isAbsolute } = require('node:path');

function externalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20]/.test(raw)) throw new Error('Invalid link.');
  const url = new URL(raw);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported link.');
  return url;
}
function externalDestination(raw, preference) {
  const url = externalUrl(raw);
  const auth = url.hostname === 'accounts.google.com' || /(?:^|\/)(?:oauth\d?|authorize|authorization)(?:\/|$)/i.test(url.pathname);
  return preference === 'app' && url.protocol !== 'mailto:' && !auth ? 'app' : 'browser';
}
function localEngineUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
function trustedDocument(raw, engineUrl, startupUrl) {
  if (raw === startupUrl) return true;
  try {
    const url = new URL(raw);
    return engineUrl && url.origin === new URL(engineUrl).origin && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}
function assertFilePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) throw new Error('An absolute file path is required.');
  return value;
}
function sameDocument(left, right) {
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}
module.exports = { externalUrl, externalDestination, localEngineUrl, trustedDocument, assertFilePath, sameDocument };

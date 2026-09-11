const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const { join } = require('path');
const { mkdtempSync, rmSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { resolveHookUrl } = require('../src/hook-url');
const { HeadlessServer } = require('../src/server');
const { sessionEnvironment } = require('../src/session');
const { createClaudeSettings, removeClaudeSettings } = require('../src/claude-settings');
const { createGeminiSettings, removeGeminiSettings } = require('../src/gemini-settings');

test('hook URLs accept HTTP/HTTPS and fall back for missing or invalid URLs', () => {
  for (const url of ['', 'bad', 'ftp://example.test']) {
    assert.equal(resolveHookUrl('/hooks/test/start', 4000, url).href, 'http://127.0.0.1:4000/hooks/test/start');
  }
  assert.equal(resolveHookUrl('/hooks/test/start', 4000, 'https://example.test:444/base').href, 'https://example.test:444/hooks/test/start');
});

test('all native hooks reach an IPv6 listener and Claude/Gemini retain argv-only operation', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    req.resume(); req.on('end', () => res.end('{}'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
  const port = server.address().port;
  const url = `http://[::1]:${port}`;
  const cases = [
    ['claude', [String(port), 'session', 'start'], { CLIDECK_URL: url }],
    ['gemini', [String(port), 'session', 'start'], { CLIDECK_URL: url }],
    ['codex', ['start'], { CLIDECK_URL: url, CLIDECK_PORT: String(port), CLIDECK_NEXT_SESSION_ID: 'session' }],
    ['claude', [String(port), 'session', 'start', url], {}],
    ['gemini', [String(port), 'session', 'start', '', url], {}],
  ];
  try {
    for (const [name, args, env] of cases) {
      const child = spawn(process.execPath, [join(__dirname, `../src/${name}-hook.js`), ...args], { env, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.end('{}');
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0);
    }
    assert.deepEqual(received, Array(5).fill('/hooks/session/start'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('engine URLs and generated hook settings preserve the actual IPv6 address', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-hook-address-'));
  const server = new HeadlessServer({ host: '::1', port: 0, dataDir });
  let claude, gemini;
  try {
    const address = await server.listen();
    assert.equal(new URL(address.httpUrl).hostname, '[::1]');
    assert.equal(new URL(address.url).protocol, 'ws:');
    assert.equal(sessionEnvironment({}, 'session', address.port, '', address.httpUrl).CLIDECK_URL, address.httpUrl);
    claude = createClaudeSettings(address.port, 'session', address.httpUrl);
    gemini = createGeminiSettings(address.port, 'session', join(dataDir, 'absent.json'), '', address.httpUrl);
    assert.ok(readFileSync(claude, 'utf8').includes(address.httpUrl));
    assert.ok(readFileSync(gemini.path, 'utf8').includes(address.httpUrl));
  } finally {
    if (claude) removeClaudeSettings(claude);
    if (gemini) removeGeminiSettings(gemini);
    await server.close(); rmSync(dataDir, { recursive: true, force: true });
  }
});

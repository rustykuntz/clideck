const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { spawn } = require('child_process');
const { join } = require('path');

const { resolveHookUrl } = require('../bin/hook-url');

const BIN_DIR = join(__dirname, '..', 'bin');
const HOST = '127.0.0.2';

function runHelper(file, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(BIN_DIR, file), ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code}: ${stderr}`));
    });
    child.stdin.end(input || '');
  });
}

function waitForRequest(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for hook request')), 3000);
    server.once('request', (req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        clearTimeout(timer);
        res.writeHead(200, { Connection: 'close' });
        res.end('{}');
        resolve({ path: req.url, body });
      });
    });
  });
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('resolves valid CLIDECK_URL values and falls back for absent or invalid values', () => {
  assert.equal(resolveHookUrl('/hook/test', 4000, '').href, 'http://localhost:4000/hook/test');
  assert.equal(resolveHookUrl('/hook/test', 4000, 'not a URL').href, 'http://localhost:4000/hook/test');
  assert.equal(resolveHookUrl('/hook/test', 4000, 'ftp://example.test:21').href, 'http://localhost:4000/hook/test');
  assert.equal(resolveHookUrl('/hook/test', 4000, 'http://127.0.0.2:4555/base').href, 'http://127.0.0.2:4555/hook/test');
  assert.equal(resolveHookUrl('/hook/test', 4000, 'https://example.test/base').href, 'https://example.test/hook/test');
  assert.equal(resolveHookUrl('/hook/test', 4000, 'http://[::1]:4555').href, 'http://[::1]:4555/hook/test');
});

test('all lifecycle helpers post through CLIDECK_URL', async () => {
  const server = http.createServer();
  let fallbackRequests = 0;
  const fallbackServer = http.createServer((req, res) => {
    fallbackRequests++;
    res.writeHead(200, { Connection: 'close' });
    res.end('{}');
  });
  const port = await listen(server, HOST);
  const fallbackPort = await listen(fallbackServer, '127.0.0.1');
  const payload = JSON.stringify({ session_id: 'agent-session' });
  const env = {
    CLIDECK_URL: `http://${HOST}:${port}`,
    CLIDECK_SESSION_ID: 'clideck-session',
  };
  const cases = [
    { file: 'claude-hook.js', args: [String(fallbackPort), 'start'], input: payload, path: '/hook/claude/start' },
    { file: 'gemini-hook.js', args: [String(fallbackPort), 'start'], input: payload, path: '/hook/gemini/start' },
    { file: 'codex-hook.js', args: [String(fallbackPort), 'start'], input: payload, path: '/hook/codex/start' },
    { file: 'notify-helper.js', args: [String(fallbackPort), payload], input: '', path: '/hook/codex/stop' },
  ];

  try {
    for (const item of cases) {
      const [request] = await Promise.all([
        waitForRequest(server),
        runHelper(item.file, item.args, item.input, env),
      ]);
      assert.equal(request.path, item.path, item.file);
      assert.equal(JSON.parse(request.body).clideck_id, 'clideck-session', item.file);
    }
    assert.equal(fallbackRequests, 0);
  } finally {
    await Promise.all([close(server), close(fallbackServer)]);
  }
});

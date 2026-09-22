const test = require('node:test');
const assert = require('node:assert/strict');

const { checkForUpdate, parseSemver } = require('../src/update-check');

// Transport fixtures exercise registry handling without external network access.

const registryBody = (version) => JSON.stringify({ name: 'clideck', version });

test('returns a strictly newer stable version', async () => {
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('2.4.0'),
  }), '2.4.0');
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('10.0.7'),
  }), '10.0.7');
});

test('ignores equal and older registry versions', async () => {
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('2.3.1'),
  }), null);
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('2.3.0'),
  }), null);
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('1.99.99'),
  }), null);
});

test('never treats a prerelease registry version as an update', async () => {
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('2.4.0-beta.1'),
  }), null);
  assert.equal(await checkForUpdate({
    currentVersion: '2.3.1',
    transport: async () => registryBody('2.4.0-rc.1+build.5'),
  }), null);
});

test('stable release of the same core supersedes a prerelease current', async () => {
  assert.equal(await checkForUpdate({
    currentVersion: '1.1.0-beta.2',
    transport: async () => registryBody('1.1.0'),
  }), '1.1.0');
  assert.equal(await checkForUpdate({
    currentVersion: '1.0.0-beta.1',
    transport: async () => registryBody('1.0.0'),
  }), '1.0.0');
  assert.equal(await checkForUpdate({
    currentVersion: '1.1.0-beta.2',
    transport: async () => registryBody('1.2.0'),
  }), '1.2.0');
});

test('tolerates v prefixes and whitespace around versions', async () => {
  assert.equal(await checkForUpdate({
    currentVersion: 'v2.3.1',
    transport: async () => registryBody(' 2.4.0 '),
  }), '2.4.0');
});

test('network and payload failures become null, never rejections', async () => {
  const cases = [
    { transport: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } },
    { transport: async () => '<html>gateway timeout</html>' },
    { transport: async () => JSON.stringify({ name: 'clideck' }) },
    { transport: async () => JSON.stringify({ version: 42 }) },
    { transport: async () => 'not json at all' },
    { transport: async () => ({ version: '9.9.9' }) },
    { transport: async () => registryBody('2.4.0'), maxBytes: 1024, body: 'x'.repeat(5000) },
  ];
  for (const options of cases) {
    const transport = options.transport;
    const body = options.body;
    let called = false;
    const result = await checkForUpdate({
      currentVersion: '2.3.1',
      ...options,
      transport: async () => { called = true; return body === undefined ? transport() : body; },
    });
    assert.equal(called, true);
    assert.equal(result, null, JSON.stringify(options));
  }
});

test('slow transports are bounded by the deadline and resolve null', async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const startedAt = Date.now();
  const result = await checkForUpdate({
    currentVersion: '2.3.1',
    timeoutMs: 20,
    transport: () => new Promise(() => {}),
  });
  assert.equal(result, null);
  assert.ok(Date.now() - startedAt < 2000, 'deadline should resolve well before a test timeout');
});

test('rejecting-after-deadline transports stay handled', async () => {
  const result = await checkForUpdate({
    currentVersion: '2.3.1',
    timeoutMs: 10,
    transport: () => new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 50);
    }),
  });
  assert.equal(result, null);
});

test('invalid or missing currentVersion resolves null without a request', async () => {
  for (const currentVersion of [undefined, null, '', '   ', 'git-label-abc', '1.2', '1.2.3.4', 42]) {
    let requested = false;
    const result = await checkForUpdate({
      currentVersion,
      transport: async () => { requested = true; return registryBody('9.9.9'); },
    });
    assert.equal(result, null, String(currentVersion));
    assert.equal(requested, false, `no request expected for ${String(currentVersion)}`);
  }
});

test('transport receives the endpoint url and the applied bounds', async () => {
  let seen;
  await checkForUpdate({
    currentVersion: '2.3.1',
    url: 'http://127.0.0.1:0/clideck/latest',
    timeoutMs: 250,
    maxBytes: 4096,
    transport: async (url, bounds) => {
      seen = { url, bounds };
      return registryBody('2.4.0');
    },
  });
  assert.equal(seen.url, 'http://127.0.0.1:0/clideck/latest');
  assert.deepEqual(seen.bounds, { timeoutMs: 250, maxBytes: 4096 });
});

test('parseSemver exposes the release core and prerelease flag', () => {
  assert.deepEqual(parseSemver('v2.3.1'), { major: 2, minor: 3, patch: 1, prerelease: '', core: '2.3.1' });
  assert.equal(parseSemver('2.4.0-beta.1').prerelease, 'beta.1');
  assert.equal(parseSemver('2.4'), null);
  assert.equal(parseSemver(42), null);
});


test('injected payload limit counts UTF-8 bytes', async () => {
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0', maxBytes: 1024,
    transport: async () => JSON.stringify({ version: '2.0.0', extra: '🚀'.repeat(300) }),
  }), null);
});

function mockResponse(t, statusCode, send) {
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  const response = new PassThrough();
  response.statusCode = statusCode;
  const request = new EventEmitter();
  request.destroy = () => { request.destroyed = true; response.destroy(); };
  t.mock.method(require('node:https'), 'get', (url, options, callback) => {
    queueMicrotask(() => { callback(response); send?.(response); });
    return request;
  });
  return { response, request };
}

test('HTTP rejection destroys response immediately and handles subsequent errors', async (t) => {
  const { response } = mockResponse(t, 503);
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0' }), null);
  assert.equal(response.destroyed, true);
  assert.ok(response.listenerCount('error') > 0);
  response.emit('error', new Error('late stream error'));
});

test('default HTTPS transport reads successful response', async (t) => {
  mockResponse(t, 200, response => response.end(registryBody('2.0.0')));
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0' }), '2.0.0');
});

test('default HTTPS transport bounds body and handles stream errors', async (t) => {
  const { request } = mockResponse(t, 200, response => response.end('x'.repeat(2048)));
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0', maxBytes: 1024 }), null);
  assert.equal(request.destroyed, true);
});

test('default HTTPS transport handles aborted responses', async (t) => {
  mockResponse(t, 200, response => response.emit('aborted'));
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  assert.equal(await checkForUpdate({ currentVersion: '1.0.0', timeoutMs: 30 }), null);
});

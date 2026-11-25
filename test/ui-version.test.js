const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { createUiVersion } = require('../src/ui-version');
const { HeadlessServer } = require('../src/server');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'clideck-ui-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'public/js'), { recursive: true });
  mkdirSync(join(root, 'public/css'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'clideck', version: '2.6.0' }));
  writeFileSync(join(root, 'public/index.html'), '<html><head></head><body></body></html>');
  writeFileSync(join(root, 'public/js/app.js'), 'old interface');
  writeFileSync(join(root, 'public/css/app.css'), 'body { color: black }');
  return root;
}

test('UI identity follows actual assets, including same-version source edits and add/remove', async t => {
  const root = fixture(t), get = createUiVersion({ root, runningVersion: '2.6.0' });
  const first = await get();
  assert.match(first.version, /^[a-f0-9]{64}$/);
  assert.equal(first.restartRequired, false);
  utimesSync(join(root, 'public/js/app.js'), new Date(1), new Date(1));
  assert.deepEqual(await get({ fresh: true }), first, 'touching unchanged files does not nag');
  writeFileSync(join(root, 'public/js/app.js'), 'new interface');
  const edited = await get({ fresh: true });
  assert.notEqual(edited.version, first.version);
  assert.equal(edited.restartRequired, false);
  writeFileSync(join(root, 'public/js/new.js'), 'new module');
  assert.notEqual((await get({ fresh: true })).version, edited.version);
  rmSync(join(root, 'public/js/new.js'));
  assert.deepEqual(await get({ fresh: true }), edited);
  writeFileSync(join(root, 'public/css/app.css'), 'body { color: white }');
  assert.notEqual((await get({ fresh: true })).version, edited.version);
});

test('UI checks are cached/coalesced, while a fresh document gets the current identity', async t => {
  const root = fixture(t); let now = 0;
  const get = createUiVersion({ root, runningVersion: '2.6.0', now: () => now });
  const pending = get();
  assert.equal(get(), pending, 'concurrent callers share one scan');
  const first = await pending;
  writeFileSync(join(root, 'public/js/app.js'), 'updated');
  now = 29_999;
  assert.deepEqual(await get(), first);
  now = 30_000;
  const second = await get();
  assert.notEqual(second.version, first.version);
  writeFileSync(join(root, 'public/js/app.js'), 'updated again');
  assert.notEqual((await get({ fresh: true })).version, second.version);
});

test('package replacement reports engine restart required without relying on cached require', async t => {
  const root = fixture(t), get = createUiVersion({ root, runningVersion: '2.6.0' });
  const old = await get();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'clideck', version: '2.7.0' }));
  const updated = await get({ fresh: true });
  assert.notEqual(updated.version, old.version);
  assert.equal(updated.restartRequired, true);
  const restarted = await createUiVersion({ root, runningVersion: '2.7.0' })();
  assert.equal(restarted.version, updated.version);
  assert.equal(restarted.restartRequired, false);
});

test('user data and documentation never affect UI identity; failed discovery can recover', async t => {
  const root = fixture(t), get = createUiVersion({ root, runningVersion: '2.6.0' });
  const first = await get();
  writeFileSync(join(root, 'sessions.json'), 'private data');
  writeFileSync(join(root, 'README.md'), 'documentation');
  assert.deepEqual(await get({ fresh: true }), first);
  writeFileSync(join(root, 'package.json'), '{install interrupted');
  await assert.rejects(get({ fresh: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'clideck', version: '2.6.0' }));
  assert.deepEqual(await get({ fresh: true }), first);
});

test('served HTML stamps its baseline; checks are uncached and never change session state', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-ui-version-http-'));
  let value = { version: 'ui-first', restartRequired: false }, fail = false;
  const calls = [];
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0,
    uiVersion: async options => { calls.push(options); if (fail) throw new Error('replacing files'); return value; } });
  t.after(async () => { try { await server.close(); } finally { rmSync(dataDir, { recursive: true, force: true }); } });
  const { httpUrl } = await server.listen();
  const before = server.persistence.list();
  for (const route of ['/', '/index.html']) {
    const page = await fetch(httpUrl + route);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(await page.text(), /<meta name="clideck-ui-version" content="ui-first">/);
    assert.deepEqual(calls.at(-1), { fresh: true });
  }
  value = { version: 'ui-next', restartRequired: false };
  const latest = await fetch(httpUrl + '/api/ui-version');
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await latest.json(), value);
  const js = await fetch(httpUrl + '/js/app.js');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  assert.equal(js.status, 200);
  assert.deepEqual(server.persistence.list(), before);
  fail = true;
  const unavailable = await fetch(httpUrl + '/api/ui-version');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  const page = await fetch(httpUrl + '/');
  assert.equal(page.status, 200, 'optional check failure must not break the app');
  assert.doesNotMatch(await page.text(), /name="clideck-ui-version"/);
  fail = false; value = { version: '"><script>alert(1)</script>', restartRequired: false };
  assert.doesNotMatch(await (await fetch(httpUrl + '/')).text(), /<script>alert\(1\)/);
});

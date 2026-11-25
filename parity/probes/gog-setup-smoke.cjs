#!/usr/bin/env node
// Real gog metadata/credential protocol, with fake credentials in a disposable
// profile. No browser, Google requests, existing accounts or system changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRunner } = require('../../plugin-packages/google/runner');
const { createSetup } = require('../../plugin-packages/google/setup');

(async () => {
  const binary = process.argv[2];
  if (!binary || !isAbsolute(binary)) throw Error('Pass the absolute path to the gog binary to test.');
  const root = fs.mkdtempSync(join(tmpdir(), 'clideck-gog-setup-smoke-'));
  const runner = createRunner({ env: { ...process.env, GOG_HOME: root, GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: randomBytes(32).toString('hex'), DBUS_SESSION_BUS_ADDRESS: 'disabled:' } });
  const setup = createSetup({ execute: (args, options) => runner.run(binary, args, options) });
  try {
    const initial = await setup.read();
    assert.equal(initial.error, ''); assert.deepEqual(initial.clients, []);
    assert(initial.services.some(service => service.id === 'gmail'));
    console.log('PASS real service discovery and empty connection list');
    await setup.action({ action: 'credentials-save', client: 'clideck-test', json: JSON.stringify({ installed: {
      client_id: 'clideck-test.apps.googleusercontent.com', client_secret: 'NOT_A_REAL_GOOGLE_SECRET',
    } }) });
    const stored = setup.snapshot();
    assert.deepEqual(stored.clients, [{ name: 'clideck-test' }]);
    assert(!JSON.stringify(stored).includes('NOT_A_REAL_GOOGLE_SECRET'));
    console.log('PASS real Desktop client import through stdin and safe metadata');
    const plan = await runner.run(binary, ['--json', '--no-input', '--client', 'clideck-test', '--readonly', '--dry-run',
      'auth', 'add', 'fake@example.com', '--services', 'gmail', '--force-consent', '--listen-addr=127.0.0.1:0', '--timeout=5m']);
    assert.equal(plan.exitCode, 0, plan.stderr);
    assert(plan.stdout.includes('gmail.readonly'));
    console.log('PASS real sign-in arguments accepted in dry-run (no sign-in started)');
    await setup.action({ action: 'credentials-remove', client: 'clideck-test' });
    assert.deepEqual(setup.snapshot().clients, []);
    console.log('PASS real removal of only the fake test connection');
  } finally {
    await setup.close(); await runner.close(); fs.rmSync(root, { recursive: true, force: true });
    assert(!fs.existsSync(root));
    console.log('PASS temporary profile removed');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

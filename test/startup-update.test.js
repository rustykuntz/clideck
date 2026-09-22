const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyUpdate } = require('../src/startup');

test('startup notice uses package versions and installed/source-specific instructions', async () => {
  for (const sourceCheckout of [false, true]) {
    const messages = [];
    await notifyUpdate({ currentVersion: '2.1.1', sourceCheckout,
      output: { isTTY: true, write: s => messages.push(s) },
      check: async options => { assert.deepEqual(options, { currentVersion: '2.1.1' }); return '2.3.1'; },
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /2\.1\.1 → 2\.3\.1/);
    assert.match(messages[0], sourceCheckout ? /Update your source checkout/ : /npm install -g clideck/);
    assert.match(messages[0], /restart CliDeck/);
  }
});

test('noninteractive, up-to-date and offline starts remain quiet', async () => {
  let checked = false;
  const messages = [];
  const output = { isTTY: false, write: s => messages.push(s) };
  await notifyUpdate({ currentVersion: '2.3.1', output, check: async () => { checked = true; } });
  assert.equal(checked, false);
  output.isTTY = true;
  await notifyUpdate({ currentVersion: '2.3.1', output, check: async () => null });
  await notifyUpdate({ currentVersion: '2.3.1', output, check: async () => { throw new Error('offline'); } });
  assert.deepEqual(messages, []);
});

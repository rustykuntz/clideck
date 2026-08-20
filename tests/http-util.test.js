const test = require('node:test');
const assert = require('node:assert/strict');
const { isSameHost } = require('../http-util');

function request(remoteAddress, localAddress) {
  return { socket: { remoteAddress, localAddress } };
}

test('accepts loopback and same-interface requests from this host', () => {
  assert.equal(isSameHost(request('127.0.0.1', '127.0.0.1')), true);
  assert.equal(isSameHost(request('::1', '::1')), true);
  assert.equal(isSameHost(request('::ffff:127.0.0.1', '::ffff:192.0.2.10')), true);
  assert.equal(isSameHost(request('192.0.2.10', '192.0.2.10')), true);
  assert.equal(isSameHost(request('::ffff:192.0.2.10', '192.0.2.10')), true);
  assert.equal(isSameHost(request('2001:db8::10', '2001:db8::10')), true);
});

test('rejects requests from another host or an incomplete socket', () => {
  assert.equal(isSameHost(request('192.0.2.11', '192.0.2.10')), false);
  assert.equal(isSameHost(request('2001:db8::11', '2001:db8::10')), false);
  assert.equal(isSameHost(request('', '192.0.2.10')), false);
  assert.equal(isSameHost(request('192.0.2.10', '')), false);
});

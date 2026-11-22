'use strict';
const assert = require('node:assert/strict');
const { isValidWireGuardPrivateKey } = require('./lib/wireguard-key');

assert.equal(isValidWireGuardPrivateKey(Buffer.alloc(32, 7).toString('base64')), true);
assert.equal(isValidWireGuardPrivateKey(''), false);
assert.equal(isValidWireGuardPrivateKey('WG-testkey'), false);
assert.equal(isValidWireGuardPrivateKey(Buffer.alloc(16, 7).toString('base64')), false);
assert.equal(isValidWireGuardPrivateKey(Buffer.alloc(33, 7).toString('base64')), false);
assert.equal(isValidWireGuardPrivateKey(123), false);

console.log('WireGuard private-key validation tests passed.');

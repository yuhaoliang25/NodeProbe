'use strict';
const assert = require('node:assert/strict');
const { reportedProxyIndexToArrayIndex } = require('./lib/mihomo-index');

assert.equal(reportedProxyIndexToArrayIndex(0, 10), 0);
assert.equal(reportedProxyIndexToArrayIndex(618, 923), 618);
assert.equal(reportedProxyIndexToArrayIndex('519', 923), 519);
assert.throws(() => reportedProxyIndexToArrayIndex(-1, 10), /out of range/);
assert.throws(() => reportedProxyIndexToArrayIndex(10, 10), /out of range/);
assert.throws(() => reportedProxyIndexToArrayIndex('x', 10), /out of range/);

console.log('Mihomo proxy index tests passed.');

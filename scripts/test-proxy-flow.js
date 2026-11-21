'use strict';
const assert = require('node:assert/strict');
const { normalizeProxyFlow } = require('./lib/proxy-flow');

{
  const proxy = { type: 'vless', flow: 'xtls-rprx-vision' };
  assert.equal(normalizeProxyFlow(proxy).valid, true);
  assert.equal(proxy.flow, 'xtls-rprx-vision');
}
{
  const proxy = { type: 'vless', flow: 'xtls-rprx-direct' };
  const result = normalizeProxyFlow(proxy);
  assert.equal(result.valid, false);
  assert.match(result.reason, /unsupported VLESS flow/);
}
{
  const proxy = { type: 'vless', flow: 'xtls-rprx-splice' };
  assert.equal(normalizeProxyFlow(proxy).valid, false);
}
{
  const proxy = { type: 'trojan', flow: 'xtls-rprx-direct' };
  assert.equal(normalizeProxyFlow(proxy).valid, true);
  assert.equal(Object.hasOwn(proxy, 'flow'), false);
}
{
  const proxy = { type: 'ss', flow: 'xtls-rprx-direct' };
  assert.equal(normalizeProxyFlow(proxy).valid, true);
  assert.equal(Object.hasOwn(proxy, 'flow'), false);
}
{
  const proxy = { type: 'vless', flow: '' };
  assert.equal(normalizeProxyFlow(proxy).valid, true);
  assert.equal(Object.hasOwn(proxy, 'flow'), false);
}
console.log('Proxy flow validation tests passed.');

'use strict';

function normalizeProxyFlow(proxy) {
  const type = String(proxy?.type || '').toLowerCase();
  if (proxy?.flow === undefined || proxy.flow === null || String(proxy.flow).trim() === '') {
    if (proxy && Object.prototype.hasOwnProperty.call(proxy, 'flow')) delete proxy.flow;
    return { valid: true, changed: false };
  }

  const originalFlow = proxy.flow;
  const flow = String(originalFlow).trim();
  if (type !== 'vless') {
    delete proxy.flow;
    return { valid: true, changed: true, reason: 'flow is only supported for VLESS proxies' };
  }

  if (flow === 'xtls-rprx-vision') {
    proxy.flow = flow;
    return { valid: true, changed: flow !== originalFlow };
  }

  return {
    valid: false,
    changed: false,
    reason: `unsupported VLESS flow: ${flow}`
  };
}

module.exports = { normalizeProxyFlow };

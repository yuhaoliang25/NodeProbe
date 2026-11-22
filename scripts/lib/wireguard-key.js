'use strict';
// Temporary trigger marker for the WireGuard malformed-key regression run.

function isValidWireGuardPrivateKey(value) {
  if (typeof value !== 'string') return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

module.exports = { isValidWireGuardPrivateKey };

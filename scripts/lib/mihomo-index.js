'use strict';

function reportedProxyIndexToArrayIndex(reportedIndex, proxyCount) {
  const index = Number(reportedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= proxyCount) {
    throw new Error(`Mihomo reported proxy index out of range: ${reportedIndex} (proxy count: ${proxyCount})`);
  }
  // Mihomo's "proxy N" diagnostic uses a zero-based index.
  return index;
}

module.exports = { reportedProxyIndexToArrayIndex };

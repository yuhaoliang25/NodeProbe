'use strict';

function reportedProxyIndexToArrayIndex(reportedIndex, proxyCount) {
  const index = Number(reportedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= proxyCount) {
    throw new Error(`Mihomo reported proxy index out of range: ${reportedIndex} (proxy count: ${proxyCount})`);
  }
  // Mihomo's "proxy N" diagnostic uses a zero-based index.
// Regression trigger marker: index 618 must resolve to array element 618.
  return index;
}

module.exports = { reportedProxyIndexToArrayIndex };

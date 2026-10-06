'use strict';

/**
 * Time-based evidence decay.
 *
 * A probe's influence depends on elapsed time, not on how many probes happened
 * since it. Half-life H means an observation H old has half the weight of a
 * current observation.
 */
function timeDecayWeight(atMs, observationAt, halfLifeMs) {
  const t = Date.parse(observationAt || '');
  if (!Number.isFinite(t) || t > atMs) return 0;
  return Math.pow(0.5, Math.max(0, atMs - t) / halfLifeMs);
}

function timeDecayedEvidence(observations, atMs, halfLifeMs, successPredicate = x => x.success === true) {
  let totalWeight = 0;
  let successWeight = 0;
  let squaredWeight = 0;

  for (const observation of Array.isArray(observations) ? observations : []) {
    const weight = timeDecayWeight(atMs, observation?.at, halfLifeMs);
    if (weight <= 0) continue;
    totalWeight += weight;
    squaredWeight += weight * weight;
    if (successPredicate(observation)) successWeight += weight;
  }

  return {
    weightedTotal: totalWeight,
    weightedSuccesses: successWeight,
    weightedFailures: Math.max(0, totalWeight - successWeight),
    rate: totalWeight > 0 ? successWeight / totalWeight : 0,
    effectiveObservations: squaredWeight > 0 ? (totalWeight * totalWeight) / squaredWeight : 0,
  };
}

function timeDecayedRate(observations, atMs, halfLifeMs, successPredicate) {
  return timeDecayedEvidence(observations, atMs, halfLifeMs, successPredicate).rate;
}

module.exports = {
  timeDecayWeight,
  timeDecayedEvidence,
  timeDecayedRate,
};

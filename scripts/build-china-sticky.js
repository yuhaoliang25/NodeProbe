#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const net = require('net');

const ASSET_FILE = process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json';
const STATE_FILE = process.env.CHINA_STICKY_STATE_FILE || 'data/china-sticky.json';
const OUTPUT_FILE = process.env.CHINA_STICKY_FILE || 'subscriptions/sticky.yaml';

const MIN_OBSERVATIONS = Math.max(1, Number(process.env.CHINA_STICKY_MIN_OBSERVATIONS || 5));
const MIN_RECENT_RATE = Math.max(0, Math.min(1, Number(process.env.CHINA_STICKY_MIN_RECENT_RATE || 0.90)));
const PROTECT_FAILURE_STREAK = Math.max(1, Number(process.env.CHINA_STICKY_PROTECT_FAILURE_STREAK || 2));
const MAX_PROTECTED_AGE_MS = Math.max(1, Number(process.env.CHINA_STICKY_MAX_PROTECTED_AGE_MS || 36 * 60 * 60 * 1000));
const DECAY_HALF_LIFE_MS = Math.max(1, Number(process.env.CHINA_STICKY_DECAY_HALF_LIFE_MS || 72 * 60 * 60 * 1000));
// Continuity is deliberately only a tiny tie-breaker: reliability/freshness
// remain the primary reasons to select a sticky node. When the incumbent is
// replaced, a candidate with a nearby literal IP gets a small advantage.
// This is useful for IP-sensitive services without turning IP proximity into
// a substitute for health evidence.
const IP_CONTINUITY_WEIGHT = Math.max(
  0,
  Number(process.env.CHINA_STICKY_IP_CONTINUITY_WEIGHT || 0.002),
);

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recent(node) {
  return Array.isArray(node?.observations) ? node.observations.slice(-10) : [];
}

function rate(observations) {
  return observations.length
    ? observations.filter(x => x.success === true).length / observations.length
    : 0;
}

// Wilson lower bound: a conservative estimate of long-run reliability.
// It rewards accumulated evidence rather than letting a 5/5 node outrank a
// heavily observed 99%-reliable veteran solely because of a perfect short sample.
function wilsonLowerBound(successes, total, z = 1.96) {
  if (!total) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function timeDecayWeight(atMs, observationAt) {
  const t = Date.parse(observationAt || '');
  if (!Number.isFinite(t) || t > atMs) return 0;
  return Math.pow(0.5, Math.max(0, atMs - t) / DECAY_HALF_LIFE_MS);
}

function timeDecayedEvidence(node, atMs) {
  const observations = Array.isArray(node?.observations) ? node.observations : [];
  let weightedTotal = 0;
  let weightedSuccesses = 0;
  let squaredWeightTotal = 0;

  for (const observation of observations) {
    const weight = timeDecayWeight(atMs, observation.at);
    if (weight <= 0) continue;
    weightedTotal += weight;
    squaredWeightTotal += weight * weight;
    if (observation.success === true) weightedSuccesses += weight;
  }

  const weightedFailures = Math.max(0, weightedTotal - weightedSuccesses);
  const effectiveObservations = squaredWeightTotal > 0
    ? (weightedTotal * weightedTotal) / squaredWeightTotal
    : 0;
  const decayedRate = weightedTotal > 0 ? weightedSuccesses / weightedTotal : 0;
  const lowerBound = effectiveObservations > 0
    ? wilsonLowerBound(weightedSuccesses, effectiveObservations)
    : 0;

  return {
    decayedRate,
    lowerBound,
    effectiveObservations,
    weightedTotal,
    weightedSuccesses,
    weightedFailures,
  };
}

function stabilityRank(node, atMs) {
  const total = Number(node.observedRuns) || 0;
  const successes = Number(node.successes) || 0;
  const recentObservations = recent(node);
  const decayed = timeDecayedEvidence(node, atMs);
  const recentRate = rate(recentObservations);
  const latencyValues = recentObservations
    .map(x => Number(x.latencyMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const p95 = latencyValues.length
    ? latencyValues[Math.min(latencyValues.length - 1, Math.ceil(latencyValues.length * 0.95) - 1)]
    : Number.POSITIVE_INFINITY;

  return {
    lowerBound: decayed.lowerBound,
    recentRate,
    decayedRate: decayed.decayedRate,
    effectiveObservations: decayed.effectiveObservations,
    lifetimeRate: total ? successes / total : 0,
    observedRuns: total,
    p95LatencyMs: p95,
  };
}

function eligible(node, atMs) {
  if (!node || node.state !== 'TRUSTED' || !node.proxy) return false;
  if (Number(node.observedRuns) < MIN_OBSERVATIONS) return false;
  const decayed = timeDecayedEvidence(node, atMs);
  if (decayed.effectiveObservations < MIN_OBSERVATIONS) return false;
  if (decayed.decayedRate < MIN_RECENT_RATE) return false;
  if (Number(node.failureStreak || 0) !== 0) return false;
  return true;
}

function compare(a, b, atMs, referenceServer = null) {
  const ar = continuityAdjustedScore(a, atMs, referenceServer);
  const br = continuityAdjustedScore(b, atMs, referenceServer);
  return (
    (br.lowerBound + br.continuityBonus) -
    (ar.lowerBound + ar.continuityBonus)
  ) ||
    br.decayedRate - ar.decayedRate ||
    br.recentRate - ar.recentRate ||
    br.observedRuns - ar.observedRuns ||
    ar.p95LatencyMs - br.p95LatencyMs ||
    String(a.endpointId).localeCompare(String(b.endpointId));
}

function latestFailed(node) {
  const observations = Array.isArray(node?.observations) ? node.observations : [];
  const latest = observations[observations.length - 1];
  return Boolean(latest && latest.success !== true);
}

function isFreshEnough(node, atMs) {
  const lastProbe = Date.parse(node?.lastProbeAt || node?.lastObservedAt || '');
  return Number.isFinite(lastProbe) && atMs - lastProbe <= MAX_PROTECTED_AGE_MS;
}

function canProtectCurrent(node, atMs) {
  if (!node || !node.proxy) return false;
  if (Number(node.observedRuns) < MIN_OBSERVATIONS) return false;
  if (timeDecayedEvidence(node, atMs).effectiveObservations < MIN_OBSERVATIONS) return false;
  if (node.state !== 'TRUSTED') return false;
  if (Number(node.failureStreak || 0) >= PROTECT_FAILURE_STREAK) return false;
  if (!isFreshEnough(node, atMs)) return false;
  return true;
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return null;
  // YAML Mihomo configs may use bracketed IPv6 literals.
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  return net.isIP(ip) ? ip : null;
}

function ipDistanceScore(candidateIp, referenceIp) {
  const a = normalizeIp(candidateIp);
  const b = normalizeIp(referenceIp);
  if (!a || !b) return 0;
  const versionA = net.isIP(a);
  const versionB = net.isIP(b);
  if (versionA !== versionB) return 0;

  if (versionA === 4) {
    const toBigInt = ip => ip.split('.').reduce((value, octet) => (
      (value << 8n) + BigInt(Number(octet))
    ), 0n);
    const distance = toBigInt(a) >= toBigInt(b)
      ? toBigInt(a) - toBigInt(b)
      : toBigInt(b) - toBigInt(a);
    const max = 4294967295n;
    return Number(max - distance) / Number(max);
  }

  // IPv6 is handled with BigInt to avoid precision loss. The score is still
  // normalized to [0, 1], so the same tiny continuity weight applies.
  function ipv6ToBigInt(ip) {
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
    const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    return groups.reduce((value, group) => (
      (value << 16n) + BigInt(parseInt(group, 16) || 0)
    ), 0n);
  }

  const ai = ipv6ToBigInt(a);
  const bi = ipv6ToBigInt(b);
  const distance = ai >= bi ? ai - bi : bi - ai;
  const max = (1n << 128n) - 1n;
  const similarity = max - distance;
  return Number(similarity) / Number(max);
}

function continuityAdjustedScore(node, atMs, referenceServer) {
  const rank = stabilityRank(node, atMs);
  const continuity = ipDistanceScore(node.proxy?.server, referenceServer);
  return {
    ...rank,
    continuity,
    continuityBonus: continuity * IP_CONTINUITY_WEIGHT,
  };
}

function createState() {
  return {
    version: 1,
    endpointId: null,
    selectedAt: null,
    switchedAt: null,
    switchReason: null,
    retiredEndpointIds: [],
  };
}

function main() {
  const assets = loadJson(ASSET_FILE, { nodes: {} });
  let state = loadJson(STATE_FILE, createState());
  if (!state || typeof state !== 'object') state = createState();
  // Keep the legacy field for state-file compatibility, but it is no longer
  // used as a permanent blacklist. A transient failure must not permanently
  // remove an otherwise healthy China asset from future sticky selection.
  if (!Array.isArray(state.retiredEndpointIds)) state.retiredEndpointIds = [];

  const nodes = Object.values(assets.nodes || {});
  const atMs = Date.now();
  const byId = new Map(nodes.filter(x => x?.endpointId).map(x => [x.endpointId, x]));
  const current = state.endpointId ? byId.get(state.endpointId) : null;
  const continuityReferenceServer =
    current?.proxy?.server ||
    state.lastSelectedServer ||
    null;
  const eligibleNodes = nodes
    .filter(node => eligible(node, atMs))
    .sort((a, b) => compare(a, b, atMs, continuityReferenceServer));

  let selected = null;
  let reason = 'initial-selection';

  // Sticky means sticky: never replace a healthy incumbent merely because a
  // newly observed node has a better score.
  if (current && canProtectCurrent(current, atMs)) {
    selected = current;
    reason = Number(current.failureStreak || 0) > 0
      ? 'retain-current-after-single-failure'
      : 'retain-current';
  } else {
    if (current?.endpointId) {
      reason = Number(current.failureStreak || 0) >= PROTECT_FAILURE_STREAK
        ? 'current-consecutive-failures'
        : !isFreshEnough(current, atMs)
          ? 'current-stale-probe'
          : latestFailed(current)
            ? 'current-failed-or-timeout'
            : 'current-no-longer-eligible';
    }

    // Do not permanently blacklist the previous incumbent. It remains in the
    // normal eligible pool and may become sticky again after recovery.
    selected = eligibleNodes[0] || null;
  }

  if (selected) {
    if (state.endpointId !== selected.endpointId) {
      state.endpointId = selected.endpointId;
      const timestamp = new Date().toISOString();
      state.selectedAt ||= timestamp;
      state.switchedAt = timestamp;
      state.switchReason = reason;
    }
    state.lastSelectedServer = selected.proxy?.server || state.lastSelectedServer || null;
  } else {
    state.endpointId = null;
    state.switchReason = reason;
  }

  state.generatedAt = new Date().toISOString();
  state.candidateCount = eligibleNodes.length;
  state.decayHalfLifeMs = DECAY_HALF_LIFE_MS;
  state.retiredCount = 0;

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');

  const proxies = selected ? [selected.proxy] : [];
  fs.writeFileSync(OUTPUT_FILE, yaml.dump({ proxies }, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: true,
    quotingType: "'",
  }));

  console.log(JSON.stringify({
    selected: selected ? {
      endpointId: selected.endpointId,
      name: selected.proxy?.name || null,
      state: selected.state,
      observedRuns: selected.observedRuns,
      lifetimeSuccessRate: stabilityRank(selected, atMs).lifetimeRate,
      recentSuccessRate: stabilityRank(selected, atMs).recentRate,
      timeDecayedSuccessRate: stabilityRank(selected, atMs).decayedRate,
      effectiveObservations: stabilityRank(selected, atMs).effectiveObservations,
      continuityReferenceServer,
      continuityScore: ipDistanceScore(selected.proxy?.server, continuityReferenceServer),
      continuityBonus: ipDistanceScore(selected.proxy?.server, continuityReferenceServer) * IP_CONTINUITY_WEIGHT,
    } : null,
    candidateCount: eligibleNodes.length,
    reason,
    output: OUTPUT_FILE,
    stateFile: STATE_FILE,
  }, null, 2));
}

main();

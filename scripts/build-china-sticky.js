#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ASSET_FILE = process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json';
const STATE_FILE = process.env.CHINA_STICKY_STATE_FILE || 'data/china-sticky.json';
const OUTPUT_FILE = process.env.CHINA_STICKY_FILE || 'subscriptions/sticky.yaml';

const MIN_OBSERVATIONS = Math.max(1, Number(process.env.CHINA_STICKY_MIN_OBSERVATIONS || 5));
const MIN_RECENT_RATE = Math.max(0, Math.min(1, Number(process.env.CHINA_STICKY_MIN_RECENT_RATE || 0.90)));

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

function stabilityRank(node) {
  const total = Number(node.observedRuns) || 0;
  const successes = Number(node.successes) || 0;
  const recentObservations = recent(node);
  const recentRate = rate(recentObservations);
  const lowerBound = wilsonLowerBound(successes, total);
  const latencyValues = recentObservations
    .map(x => Number(x.latencyMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const p95 = latencyValues.length
    ? latencyValues[Math.min(latencyValues.length - 1, Math.ceil(latencyValues.length * 0.95) - 1)]
    : Number.POSITIVE_INFINITY;

  return {
    lowerBound,
    recentRate,
    lifetimeRate: total ? successes / total : 0,
    observedRuns: total,
    p95LatencyMs: p95,
  };
}

function eligible(node) {
  if (!node || node.state !== 'TRUSTED' || !node.proxy) return false;
  if (Number(node.observedRuns) < MIN_OBSERVATIONS) return false;
  if (rate(recent(node)) < MIN_RECENT_RATE) return false;
  if (Number(node.failureStreak || 0) !== 0) return false;
  return true;
}

function compare(a, b) {
  const ar = stabilityRank(a);
  const br = stabilityRank(b);
  return br.lowerBound - ar.lowerBound ||
    br.lifetimeRate - ar.lifetimeRate ||
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
  const byId = new Map(nodes.filter(x => x?.endpointId).map(x => [x.endpointId, x]));
  const eligibleNodes = nodes.filter(eligible).sort(compare);
  const current = state.endpointId ? byId.get(state.endpointId) : null;

  let selected = null;
  let reason = 'initial-selection';

  // Sticky means sticky: never replace a healthy incumbent merely because a
  // newly observed node has a better score.
  if (current && eligible(current) && !latestFailed(current)) {
    selected = current;
    reason = 'retain-current';
  } else {
    if (current?.endpointId) {
      reason = latestFailed(current) ? 'current-failed-or-timeout' : 'current-no-longer-eligible';
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
  } else {
    state.endpointId = null;
    state.switchReason = reason;
  }

  state.generatedAt = new Date().toISOString();
  state.candidateCount = eligibleNodes.length;
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
      lifetimeSuccessRate: stabilityRank(selected).lifetimeRate,
      recentSuccessRate: stabilityRank(selected).recentRate,
    } : null,
    candidateCount: eligibleNodes.length,
    reason,
    output: OUTPUT_FILE,
    stateFile: STATE_FILE,
  }, null, 2));
}

main();

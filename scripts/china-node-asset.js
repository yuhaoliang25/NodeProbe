#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const CONFIG = {
  stableFile: process.env.CHINA_STABLE_FILE || 'subscriptions/stable.yaml',
  stateFile: process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json',
  maxNodesPerRun: Number(process.env.CHINA_MAX_NODES || 30),
  veteranRetestMs: 24 * 60 * 60 * 1000,
  failedRetryMs: 2 * 60 * 60 * 1000,
  recentWindow: 10,
};

function now() {
  return new Date().toISOString();
}

function endpointIdentity(p) {
  const t = String(p.type || '').toLowerCase();
  const auth = t === 'shadowsocks'
    ? [p.cipher || '', p.password || '']
    : t === 'vmess' || t === 'vless'
      ? [p.uuid || '']
      : [p.password || ''];
  const transport = p.network || 'tcp';
  const tls = p.tls ? 'tls' : 'plain';
  const sni = p.sni || '';
  const reality = p['reality-opts'] || {};
  const ws = p['ws-opts'] || {};
  const grpc = p['grpc-opts'] || {};
  const transportOpts = {
    wsPath: ws.path || '',
    wsHost: ws.headers?.Host || '',
    grpcService: grpc['grpc-service-name'] || '',
  };
  return crypto.createHash('sha256').update(JSON.stringify([
    t, String(p.server).toLowerCase(), Number(p.port), auth,
    transport, transportOpts, tls, sni, p.flow || '',
    reality['public-key'] || '', reality['short-id'] || '',
  ])).digest('hex').slice(0, 16);
}

function loadStable() {
  const doc = yaml.load(fs.readFileSync(CONFIG.stableFile, 'utf8'));
  if (!Array.isArray(doc?.proxies)) throw new Error('stable.yaml has no proxies array');

  const byId = new Map();
  for (const proxy of doc.proxies) {
    if (!proxy || !proxy.server || !proxy.port || !proxy.type) continue;
    const endpointId = endpointIdentity(proxy);
    if (!byId.has(endpointId)) {
      byId.set(endpointId, { endpointId, proxy, globalStableObservedAt: now() });
    }
  }
  return [...byId.values()];
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
  } catch {
    return { version: 1, generatedAt: null, nodes: {} };
  }
}

function recentRate(node) {
  const observations = Array.isArray(node.observations) ? node.observations : [];
  const recent = observations.slice(-CONFIG.recentWindow);
  if (!recent.length) return null;
  return recent.filter(x => x.success).length / recent.length;
}

function deriveState(node) {
  const rate = recentRate(node);
  if (node.successes === 0) return 'NEW';
  if (node.failureStreak >= 6) return 'UNTRUSTED';
  if (node.state === 'TRUSTED' && (node.failureStreak >= 2 || (rate != null && rate < 0.70))) {
    return 'DEGRADED';
  }
  if (node.observedRuns >= 5 && rate != null && rate >= 0.90 && node.failureStreak === 0) {
    return 'TRUSTED';
  }
  if (node.successStreak >= 1) return 'PROBATION';
  return node.state === 'DEGRADED' ? 'DEGRADED' : 'PROBATION';
}

function updateNode(node, observation) {
  const at = observation.at;
  node.firstObservedAt ||= at;
  node.lastObservedAt = at;
  node.lastProbeAt = at;
  node.observedRuns += 1;
  node.observations.push({
    at,
    success: Boolean(observation.success),
    latencyMs: observation.latencyMs == null ? null : Number(observation.latencyMs),
    error: observation.error || null,
    probeEnvironment: observation.probeEnvironment || 'china-default',
  });
  if (node.observations.length > 50) node.observations = node.observations.slice(-50);

  if (observation.success) {
    node.successes += 1;
    node.recentSuccesses += 1;
    node.successStreak += 1;
    node.failureStreak = 0;
    node.lastSuccessAt = at;
  } else {
    node.failures += 1;
    node.recentFailures += 1;
    node.failureStreak += 1;
    node.successStreak = 0;
    node.lastFailureAt = at;
  }

  const recent = node.observations.slice(-CONFIG.recentWindow);
  node.recentSuccesses = recent.filter(x => x.success).length;
  node.recentFailures = recent.filter(x => !x.success).length;
  node.state = deriveState(node);

  if (node.state === 'UNTRUSTED') {
    node.deadSince ||= at;
    node.recheckLevel = Math.max(1, Number(node.recheckLevel || 0));
  } else if (node.state === 'TRUSTED' || node.state === 'PROBATION') {
    node.deadSince = null;
    node.recheckLevel = 0;
  }
  return node;
}

function isDue(node, atMs) {
  if (!node.lastProbeAt) return true;
  const last = Date.parse(node.lastProbeAt);
  if (!Number.isFinite(last)) return true;
  if (node.state === 'TRUSTED') return atMs - last >= CONFIG.veteranRetestMs;
  if (node.state === 'DEGRADED' || node.state === 'UNTRUSTED') {
    return atMs - last >= CONFIG.failedRetryMs;
  }
  return true;
}

function scoreCandidate(node, category, atMs) {
  let score = 0;
  if (category === 'new') score += 1000;
  if (category === 'relay') score += 800;
  if (category === 'veteran') score += 700;
  if (category === 'failed') score += 600;
  if (node.lastProbeAt) {
    const ageHours = Math.max(0, (atMs - Date.parse(node.lastProbeAt)) / 3600000);
    score += Math.min(500, ageHours * 10);
  }
  return score;
}

function buildCandidates(stable, state, atMs) {
  const stableIds = new Set(stable.map(x => x.endpointId));
  const candidates = [];

  for (const item of stable) {
    const old = state.nodes[item.endpointId];
    if (!old) {
      candidates.push({ ...item, category: 'new', score: 1000 });
      continue;
    }

    if (!isDue(old, atMs)) continue;

    let category = 'new';
    if (old.state === 'TRUSTED') category = old.observedRuns >= 10 ? 'veteran' : 'relay';
    else if (old.state === 'DEGRADED' || old.state === 'UNTRUSTED') category = 'failed';

    candidates.push({
      ...item,
      category,
      score: scoreCandidate(old, category, atMs),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, CONFIG.maxNodesPerRun);
}

function admitOrGet(state, item, at) {
  const old = state.nodes[item.endpointId];
  if (old) {
    old.globalStableObservedAt = at;
    old.proxy = item.proxy;
    return old;
  }

  return {
    endpointId: item.endpointId,
    firstObservedAt: at,
    lastObservedAt: at,
    observedRuns: 0,
    successes: 0,
    failures: 0,
    recentSuccesses: 0,
    recentFailures: 0,
    successStreak: 0,
    failureStreak: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastProbeAt: null,
    state: 'NEW',
    deadSince: null,
    recheckLevel: 0,
    nextProbeAt: at,
    globalStableObservedAt: at,
    observations: [],
    proxy: item.proxy,
  };
}

function main() {
  const stable = loadStable();
  const state = loadState();
  const at = now();
  const candidates = buildCandidates(stable, state, Date.parse(at));

  for (const item of candidates) {
    const node = admitOrGet(state, item, at);
    // Selection only. Actual China observation is deliberately a separate step.
    state.nodes[item.endpointId] = node;
  }

  state.generatedAt = at;
  state.lastCandidateRunAt = at;
  state.lastCandidateCount = candidates.length;
  state.currentStableCount = stable.length;
  state.currentStableIds = stable.map(x => x.endpointId);

  fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2) + '\n');

  console.log(JSON.stringify({
    stable: stable.length,
    candidates: candidates.length,
    categories: candidates.reduce((m, x) => {
      m[x.category] = (m[x.category] || 0) + 1;
      return m;
    }, {}),
    stateFile: CONFIG.stateFile,
  }, null, 2));
}

main();

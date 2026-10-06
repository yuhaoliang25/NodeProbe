#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const CONFIG = {
  stableFile: process.env.CHINA_STABLE_FILE || 'subscriptions/stable.yaml',
  stateFile: process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json',
  candidateFile: process.env.CHINA_CANDIDATE_FILE || 'data/china-probe-candidates.json',
  chatgptFile: process.env.CHINA_CHATGPT_FILE || 'subscriptions/chatgpt.yaml',
  maxNodesPerRun: Number(process.env.CHINA_MAX_NODES || 300),
  veteranRetestMs: 24 * 60 * 60 * 1000,
  failedRetryMs: 2 * 60 * 60 * 1000,
  recentWindow: 10,
  observationRetention: 50,
  forgottenAfterFailures: 3,
  forgottenRetryMs: 7 * 24 * 60 * 60 * 1000,
};

function now() {
  return new Date().toISOString();
}

/**
 * This deliberately mirrors NodeProbe's endpoint identity semantics.
 * The identity is only a correspondence key; it never transfers Global trust.
 */
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
    t,
    String(p.server).toLowerCase(),
    Number(p.port),
    auth,
    transport,
    transportOpts,
    tls,
    sni,
    p.flow || '',
    reality['public-key'] || '',
    reality['short-id'] || '',
  ])).digest('hex').slice(0, 16);
}

function loadStable() {
  const doc = yaml.load(fs.readFileSync(CONFIG.stableFile, 'utf8'));
  if (!Array.isArray(doc?.proxies)) {
    throw new Error('stable.yaml has no proxies array');
  }

  const byId = new Map();
  for (const proxy of doc.proxies) {
    if (!proxy || !proxy.server || !proxy.port || !proxy.type) continue;

    const endpointId = endpointIdentity(proxy);
    if (!byId.has(endpointId)) {
      byId.set(endpointId, { endpointId, proxy });
    }
  }

  return [...byId.values()];
}

function loadChatGPTIncumbents() {
  if (!fs.existsSync(CONFIG.chatgptFile)) return [];
  const doc = yaml.load(fs.readFileSync(CONFIG.chatgptFile, 'utf8'));
  if (!Array.isArray(doc?.proxies)) return [];

  const byId = new Map();
  for (const proxy of doc.proxies) {
    if (!proxy || !proxy.server || !proxy.port || !proxy.type) continue;
    const endpointId = endpointIdentity(proxy);
    if (!byId.has(endpointId)) byId.set(endpointId, { endpointId, proxy });
  }
  return [...byId.values()];
}

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) {
    return { version: 1, generatedAt: null, nodes: {} };
  }
  const state = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
  if (!state || typeof state !== 'object' || !state.nodes || typeof state.nodes !== 'object') {
    throw new Error('China asset state is invalid: '+CONFIG.stateFile);
  }

  // Migrate the pre-exit terminology in persisted observations. This is a
  // schema rename only: the observation values and lifecycle counters remain
  // unchanged.
  for (const node of Object.values(state.nodes)) {
    if (!node || !Array.isArray(node.observations)) continue;
    for (const observation of node.observations) {
      if (observation && observation.exitSuccess == null && observation.directSuccess != null) {
        observation.exitSuccess = Boolean(observation.directSuccess);
      }
      if (observation && Object.prototype.hasOwnProperty.call(observation, 'directSuccess')) {
        delete observation.directSuccess;
      }
    }
  }

  return state;
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
  if (node.state === 'FORGOTTEN') return 'FORGOTTEN';

  // Persistent China evidence drives lifecycle. A trusted node should not
  // fall back to PROBATION after a single transient failure.
  if (node.failureStreak >= 6) return 'UNTRUSTED';

  if (
    node.state === 'TRUSTED' &&
    (node.failureStreak >= 2 || (rate != null && rate < 0.70))
  ) {
    return 'DEGRADED';
  }

  if (
    node.observedRuns >= 5 &&
    rate != null &&
    rate >= 0.90 &&
    node.failureStreak === 0
  ) {
    return 'TRUSTED';
  }

  if (node.state === 'DEGRADED') {
    // Degraded nodes need a short fresh recovery streak before they re-enter
    // probation. This prevents one success from erasing degraded status while
    // still allowing sustained recovery.
    if (node.successStreak >= 3) return 'PROBATION';
    return 'DEGRADED';
  }

  if (node.successStreak >= 1) return 'PROBATION';

  return 'PROBATION';
}

function nextProbeAt(node, atMs) {
  if (node.state === 'TRUSTED') {
    return new Date(atMs + CONFIG.veteranRetestMs).toISOString();
  }
  if (node.state === 'DEGRADED' || node.state === 'UNTRUSTED') {
    return new Date(atMs + CONFIG.failedRetryMs).toISOString();
  }
  if (node.state === 'FORGOTTEN') {
    return new Date(atMs + CONFIG.forgottenRetryMs).toISOString();
  }
  return new Date(atMs).toISOString();
}

function createAsset(endpointId, at, proxy = null) {
  return {
    endpointId,
    proxy,
    firstObservedAt: at,
    lastObservedAt: null,
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
    observations: [],
  };
}

function updateNode(node, observation) {
  const at = observation.at || now();

  if (observation.proxy) {
    node.proxy = observation.proxy;
  }

  node.lastObservedAt = at;
  node.lastProbeAt = at;
  node.observedRuns += 1;

  node.observations.push({
    at,
    success: Boolean(observation.success),
    latencyMs: observation.latencyMs == null ? null : Number(observation.latencyMs),
    error: observation.error || null,
    probeEnvironment: observation.probeEnvironment || 'china-default',
    reachabilitySuccess: observation.reachabilitySuccess == null ? null : Boolean(observation.reachabilitySuccess),
    reachabilityLatencyMs: observation.reachabilityLatencyMs == null ? null : Number(observation.reachabilityLatencyMs),
    exitSuccess: observation.exitSuccess == null ? null : Boolean(observation.exitSuccess),
    stabilityEligible: observation.stabilityEligible == null ? null : Boolean(observation.stabilityEligible),
    chatgptEligible: observation.chatgptEligible == null ? null : Boolean(observation.chatgptEligible),
    chatgptSuccessRate: observation.chatgptSuccessRate == null ? null : Number(observation.chatgptSuccessRate),
    chatgptAttempts: Array.isArray(observation.chatgptAttempts) ? observation.chatgptAttempts : [],
  });

  if (node.observations.length > CONFIG.observationRetention) {
    node.observations = node.observations.slice(-CONFIG.observationRetention);
  }

  if (observation.success) {
    node.successes += 1;
    node.successStreak += 1;
    node.failureStreak = 0;
    node.lastSuccessAt = at;
  } else {
    node.failures += 1;
    node.failureStreak += 1;
    node.successStreak = 0;
    node.lastFailureAt = at;
  }

  const recent = node.observations.slice(-CONFIG.recentWindow);
  node.recentSuccesses = recent.filter(x => x.success).length;
  node.recentFailures = recent.filter(x => !x.success).length;

  const wasForgotten = node.state === 'FORGOTTEN';
  const wasUntrusted = node.state === 'UNTRUSTED';
  if ((wasForgotten || wasUntrusted) && observation.success) {
    // Recovery from a failed state must rebuild evidence. One successful
    // recheck must not immediately inherit enough historical rate to become
    // TRUSTED.
    node.state = 'PROBATION';
  } else {
    node.state = deriveState(node);
  }

  if (node.state === 'UNTRUSTED') {
    node.deadSince ||= at;
    node.recheckLevel = Math.max(1, node.failureStreak - 5);
    if (node.recheckLevel >= CONFIG.forgottenAfterFailures) {
      node.state = 'FORGOTTEN';
    }
  } else if (node.state === 'TRUSTED' || node.state === 'PROBATION') {
    node.deadSince = null;
    node.recheckLevel = 0;
  }

  node.nextProbeAt = nextProbeAt(node, Date.parse(at));
  return node;
}

function isDue(node, atMs) {
  // nextProbeAt is the persisted scheduling decision. Do not reconstruct the
  // schedule from lastProbeAt here, because lifecycle transitions may change
  // the next interval independently of the previous observation time.
  if (node.nextProbeAt) {
    const next = Date.parse(node.nextProbeAt);
    if (Number.isFinite(next)) return atMs >= next;
  }

  // Backward-compatible fallback for older state files that predate
  // nextProbeAt. Once such a node is updated, updateNode() writes the
  // persisted schedule again.
  if (!node.lastProbeAt) return true;

  const last = Date.parse(node.lastProbeAt);
  if (!Number.isFinite(last)) return true;

  if (node.state === 'TRUSTED') {
    return atMs - last >= CONFIG.veteranRetestMs;
  }

  if (node.state === 'DEGRADED' || node.state === 'UNTRUSTED') {
    return atMs - last >= CONFIG.failedRetryMs;
  }

  if (node.state === 'FORGOTTEN') {
    return atMs - last >= CONFIG.forgottenRetryMs;
  }

  return true;
}

function scoreCandidate(node, category, atMs) {
  let score = 0;

  if (category === 'new') score += 1000;
  if (category === 'trusted-recheck') score += 800;
  if (category === 'veteran') score += 700;
  if (category === 'failed') score += 600;
  if (category === 'forgotten') score += 500;

  if (node.lastProbeAt) {
    const ageHours = Math.max(
      0,
      (atMs - Date.parse(node.lastProbeAt)) / 3600000,
    );
    score += Math.min(500, ageHours * 10);
  }

  return score;
}

function buildCandidates(stable, state, atMs) {
  const candidates = [];
  const chatgptIncumbents = loadChatGPTIncumbents();

  // The ChatGPT subscription is its own maintained pool. Its current members
  // are forced into every China probe cycle so a healthy incumbent is retested
  // even when ordinary asset scheduling says it is not due yet. This prevents
  // ordinary Elite ranking from silently dropping a proven ChatGPT path.
  for (const item of chatgptIncumbents) {
    const old = state.nodes[item.endpointId];
    candidates.push({
      endpointId: item.endpointId,
      proxy: old?.proxy || item.proxy,
      category: 'chatgpt-incumbent',
      score: 2000,
    });
  }
  // Stable is an exploration feed: it can introduce new endpoints and refresh
  // the current proxy definition for known endpoints. It is not the authority
  // for China asset membership or maintenance scheduling.
  for (const item of stable) {
    const old = state.nodes[item.endpointId];
    if (old) {
      old.proxy = item.proxy;
    }
  }

  // Maintenance is driven entirely by the persistent China asset pool.
  // A known node remains eligible for re-probing even when it disappears from
  // the latest Global Stable feed.
  for (const old of Object.values(state.nodes || {})) {
    if (!old?.endpointId || !old?.proxy || !isDue(old, atMs)) continue;

    let category = 'probation-recheck';
    if (old.state === 'TRUSTED') {
      category = old.observedRuns >= 10 ? 'veteran' : 'trusted-recheck';
    } else if (old.state === 'DEGRADED' || old.state === 'UNTRUSTED') {
      category = 'failed';
    } else if (old.state === 'FORGOTTEN') {
      category = 'forgotten';
    }

    candidates.push({
      endpointId: old.endpointId,
      proxy: old.proxy,
      category,
      score: scoreCandidate(old, category, atMs),
    });
  }

  // Exploration is the only part that depends on the current Stable feed.
  for (const item of stable) {
    if (state.nodes[item.endpointId]) continue;
    candidates.push({
      endpointId: item.endpointId,
      proxy: item.proxy,
      category: 'new',
      score: 1000,
    });
  }

  const deduped = new Map();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.endpointId);
    if (!existing || candidate.score > existing.score) {
      deduped.set(candidate.endpointId, candidate);
    }
  }

  const unique = [...deduped.values()];
  const chatgptIncumbentIds = new Set(
    chatgptIncumbents.map(item => item.endpointId),
  );
  const chatgptIncumbentsSelected = unique
    .filter(candidate => candidate.category === 'chatgpt-incumbent')
    .sort((a, b) => b.score - a.score);

  const maintenance = unique
    .filter(candidate =>
      candidate.category !== 'new' &&
      candidate.category !== 'chatgpt-incumbent'
    )
    .sort((a, b) => b.score - a.score);
  const exploration = unique
    .filter(candidate => candidate.category === 'new')
    .sort((a, b) => b.score - a.score);

  // Maintenance remains the dominant workload, but it must not permanently
  // starve either recovery or exploration. The quotas below are upper bounds:
  // when a category has fewer candidates than its quota, the unused capacity
  // is filled by the other categories in priority order.
  //
  // With the default 300-node run this yields roughly:
  //   60% ordinary maintenance
  //   30% failed/forgotten recovery
  //   10% new exploration
  //
  // Recovery therefore stays below the 33% ceiling while Stable discovery
  // retains a small continuous lane. Existing assets still account for at
  // least 90% of a fully populated run.
  const recovery = maintenance.filter(
    candidate => candidate.category === 'failed' || candidate.category === 'forgotten',
  );
  const ordinaryMaintenance = maintenance.filter(
    candidate => candidate.category !== 'failed' && candidate.category !== 'forgotten',
  );

  const recoveryLimit = Math.max(1, Math.floor(CONFIG.maxNodesPerRun * 0.30));
  const explorationLimit = Math.max(1, Math.floor(CONFIG.maxNodesPerRun * 0.10));
  const ordinaryLimit = Math.max(
    1,
    CONFIG.maxNodesPerRun - recoveryLimit - explorationLimit,
  );

  const incumbentLimit = Math.min(
    Math.max(0, CONFIG.maxNodesPerRun),
    chatgptIncumbentsSelected.length,
  );
  const selectedIncumbents = chatgptIncumbentsSelected.slice(0, incumbentLimit);
  const remainingCapacity = Math.max(
    0,
    CONFIG.maxNodesPerRun - selectedIncumbents.length,
  );

  const selectedOrdinary = ordinaryMaintenance.slice(0, Math.min(ordinaryLimit, remainingCapacity));
  const selectedRecovery = recovery.slice(0, Math.min(recoveryLimit, Math.max(0, remainingCapacity - selectedOrdinary.length)));
  const selectedExploration = exploration.slice(0, Math.min(explorationLimit, Math.max(0, remainingCapacity - selectedOrdinary.length - selectedRecovery.length)));

  const selected = [
    ...selectedIncumbents,
    ...selectedOrdinary,
    ...selectedRecovery,
    ...selectedExploration,
  ];

  // Quotas are only reservations. If one lane is under-populated, use the
  // remaining capacity rather than deliberately probing fewer nodes.
  if (selected.length < CONFIG.maxNodesPerRun) {
    const selectedIds = new Set(selected.map(candidate => candidate.endpointId));
    const remainder = [
      ...ordinaryMaintenance,
      ...recovery,
      ...exploration,
    ].filter(candidate =>
      !selectedIds.has(candidate.endpointId) &&
      !chatgptIncumbentIds.has(candidate.endpointId)
    );

    selected.push(...remainder.slice(0, CONFIG.maxNodesPerRun - selected.length));
  }

  return selected;
}
function saveState(state) {
  fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2) + '\n');
}

function saveCandidates(candidates, at) {
  fs.mkdirSync(path.dirname(CONFIG.candidateFile), { recursive: true });
  fs.writeFileSync(
    CONFIG.candidateFile,
    JSON.stringify({
      generatedAt: at,
      candidates: candidates.map(x => ({
        endpointId: x.endpointId,
        category: x.category,
        score: x.score,
        proxy: x.proxy,
      })),
    }, null, 2) + '\n',
  );
}

function selectCandidates() {
  const stable = loadStable();
  const state = loadState();
  const at = now();
  const atMs = Date.parse(at);

  // Stable is only the discovery feed. Known China assets are maintained from
  // persistent China state even when they are absent from the current Stable feed.
  const candidates = buildCandidates(stable, state, atMs);

  state.generatedAt = at;
  state.lastCandidateRunAt = at;
  state.lastCandidateCount = candidates.length;
  state.currentStableCount = stable.length;
  state.currentStableIds = stable.map(x => x.endpointId);

  saveState(state);
  saveCandidates(candidates, at);

  console.log(JSON.stringify({
    stable: stable.length,
    candidates: candidates.length,
    categories: candidates.reduce((m, x) => {
      m[x.category] = (m[x.category] || 0) + 1;
      return m;
    }, {}),
    chatgptIncumbents: candidates.filter(x => x.category === 'chatgpt-incumbent').length,
    stateFile: CONFIG.stateFile,
    candidateFile: CONFIG.candidateFile,
  }, null, 2));
}

if (require.main === module) {
  selectCandidates();
}

module.exports = {
  endpointIdentity,
  loadStable,
  loadState,
  saveState,
  recentRate,
  deriveState,
  updateNode,
  isDue,
  buildCandidates,
  selectCandidates,
};

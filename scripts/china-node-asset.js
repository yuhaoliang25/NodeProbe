#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { timeDecayedEvidence } = require('./time-decay');

const CONFIG = {
  stableFile: process.env.CHINA_STABLE_FILE || 'subscriptions/stable.yaml',
  stateFile: process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json',
  candidateFile: process.env.CHINA_CANDIDATE_FILE || 'data/china-probe-candidates.json',
  discoveryQueueFile: process.env.CHINA_DISCOVERY_QUEUE_FILE || 'data/china-discovery-queue.json',
  chatgptFile: process.env.CHINA_CHATGPT_FILE || 'subscriptions/chatgpt.yaml',
  stickyFile: process.env.CHINA_STICKY_FILE || 'subscriptions/sticky.yaml',
  maxNodesPerRun: Number(process.env.CHINA_MAX_NODES || 300),
  veteranRetestMs: 24 * 60 * 60 * 1000,
  failedRetryMs: 2 * 60 * 60 * 1000,
  recentWindow: 10,
  decayHalfLifeMs: Number(process.env.CHINA_ASSET_DECAY_HALF_LIFE_MS || 72 * 60 * 60 * 1000),
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

function loadStickyIncumbent() {
  if (!fs.existsSync(CONFIG.stickyFile)) return null;
  const doc = yaml.load(fs.readFileSync(CONFIG.stickyFile, 'utf8'));
  if (!Array.isArray(doc?.proxies) || doc.proxies.length === 0) return null;
  const proxy = doc.proxies[0];
  if (!proxy || !proxy.server || !proxy.port || !proxy.type) return null;
  return { endpointId: endpointIdentity(proxy), proxy };
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

function parseDiscoveryQueueText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    // A previous writer may have concatenated two complete JSON documents.
    // JSON.parse reports the first non-whitespace character after document #1,
    // but that position is not a safe assumption for locating document #2
    // because whitespace/newlines may surround the boundary. Search nearby
    // object starts and accept the first complete queue document we can parse.
    const match = String(error?.message || '').match(/position (\d+)/);
    const position = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(position) || position < 0) throw error;

    const candidates = [];
    const from = Math.max(0, position - 4096);
    for (let i = from; i < text.length; i += 1) {
      if (text[i] !== '{') continue;
      try {
        const value = JSON.parse(text.slice(i));
        if (value && typeof value === 'object' && Array.isArray(value.items)) {
          candidates.push(value);
          // Prefer the first complete queue after the reported boundary.
          return value;
        }
      } catch {
        // Keep scanning: this may be an inner object or the first document.
      }
    }

    throw error;
  }
}
function loadDiscoveryQueue() {
  if (!fs.existsSync(CONFIG.discoveryQueueFile)) {
    return { version: 1, updatedAt: null, items: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG.discoveryQueueFile, 'utf8');
    const queue = parseDiscoveryQueueText(raw);
    if (!queue || typeof queue !== 'object' || !Array.isArray(queue.items)) {
      throw new Error('China discovery queue is invalid: ' + CONFIG.discoveryQueueFile);
    }
    // Rewrite a successfully recovered queue atomically so the corruption is
    // repaired before this cycle modifies or republishes it.
    if (raw.trim() !== JSON.stringify(queue, null, 2).trim()) {
      saveDiscoveryQueue(queue);
      console.log('Recovered and atomically repaired China discovery queue.');
    }
    return queue;
  } catch (error) {
    throw new Error('Unable to load China discovery queue: ' + error.message);
  }
}

function saveDiscoveryQueue(queue) {
  fs.mkdirSync(path.dirname(CONFIG.discoveryQueueFile), { recursive: true });
  const tmp = CONFIG.discoveryQueueFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\\n');
  // Atomic replace: readers can only observe a complete JSON document.
  fs.renameSync(tmp, CONFIG.discoveryQueueFile);
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

function recentRate(node, atMs = Date.now()) {
  const observations = Array.isArray(node.observations) ? node.observations : [];
  if (!observations.length) return null;
  return timeDecayedEvidence(observations, atMs, CONFIG.decayHalfLifeMs).rate;
}

function deriveState(node, atMs = Date.now()) {
  const rate = recentRate(node, atMs);

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
  if (node.state === 'FORGOTTEN') {
    return new Date(atMs + CONFIG.forgottenRetryMs).toISOString();
  }
  // A newly discovered endpoint that has already failed is no longer fresh
  // exploration. Give it the same recovery backoff as other failed assets;
  // otherwise a dead NEW node is due on every cycle forever.
  if (
    node.failureStreak > 0 ||
    node.state === 'DEGRADED' ||
    node.state === 'UNTRUSTED'
  ) {
    return new Date(atMs + CONFIG.failedRetryMs).toISOString();
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
    node.state = deriveState(node, Date.parse(at));
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

function buildCandidates(stable, state, atMs, discoveryQueue) {
  const candidates = [];

  // Stable is a discovery feed, not a one-run queue. Every newly seen endpoint
  // enters persistent discovery memory; if the current run cannot afford to
  // test it, it remains pending for a later cycle even if Stable changes.
  const queueById = new Map(
    (discoveryQueue.items || []).filter(item => item?.endpointId).map(item => [item.endpointId, item]),
  );
  for (const item of stable) {
    const existing = queueById.get(item.endpointId);
    if (existing) {
      existing.proxy = item.proxy;
      existing.lastDiscoveredAt = now();
    } else if (!state.nodes[item.endpointId]) {
      const at = now();
      queueById.set(item.endpointId, {
        endpointId: item.endpointId,
        proxy: item.proxy,
        firstDiscoveredAt: at,
        lastDiscoveredAt: at,
        lastSelectedAt: null,
      });
    }
  }

  // Once China has recognized an endpoint, the asset lifecycle owns it. The
  // discovery backlog must never compete with maintenance or revive forgotten
  // assets from a later Stable snapshot.
  for (const id of [...queueById.keys()]) {
    if (state.nodes[id]) queueById.delete(id);
  }
  discoveryQueue.items = [...queueById.values()];
  const chatgptIncumbents = loadChatGPTIncumbents();
  const stickyIncumbent = loadStickyIncumbent();

  // Sticky is intentionally probed every cycle. Its purpose is to protect
  // the incumbent from churn, not to protect it from reality: a recently
  // dead incumbent must be detected before it can hurt short-term use.
  if (stickyIncumbent) {
    const old = state.nodes[stickyIncumbent.endpointId];
    candidates.push({
      endpointId: stickyIncumbent.endpointId,
      proxy: old?.proxy || stickyIncumbent.proxy,
      category: 'sticky-incumbent',
      score: 2100,
    });
  }

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
  // the latest Global Stable feed. A failed NEW node is also maintenance:
  // it must use the recovery lane rather than masquerading as fresh discovery.
  for (const old of Object.values(state.nodes || {})) {
    if (!old?.endpointId || !old?.proxy || !isDue(old, atMs)) continue;

    let category = 'probation-recheck';
    if (old.state === 'TRUSTED') {
      category = old.observedRuns >= 10 ? 'veteran' : 'trusted-recheck';
    } else if (
      old.state === 'DEGRADED' ||
      old.state === 'UNTRUSTED' ||
      old.failureStreak > 0
    ) {
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

  // Exploration consumes the persistent discovery backlog in oldest-first
  // order. It is intentionally not limited to the endpoints present in the
  // current Stable snapshot.
  const explorationQueue = [...queueById.values()].sort((a, b) =>
    String(a.firstDiscoveredAt || '').localeCompare(String(b.firstDiscoveredAt || ''))
      || String(a.lastSelectedAt || '').localeCompare(String(b.lastSelectedAt || '')),
  );
  for (const item of explorationQueue) {
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
  const stickyIncumbentSelected = unique
    .filter(candidate => candidate.category === 'sticky-incumbent')
    .sort((a, b) => b.score - a.score);

  const chatgptIncumbentsSelected = unique
    .filter(candidate => candidate.category === 'chatgpt-incumbent')
    .sort((a, b) => b.score - a.score);

  const maintenance = unique
    .filter(candidate =>
      candidate.category !== 'new' &&
      candidate.category !== 'chatgpt-incumbent' &&
      candidate.category !== 'sticky-incumbent'
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
  const selectedSticky = stickyIncumbentSelected.slice(0, Math.min(1, Math.max(0, CONFIG.maxNodesPerRun - selectedIncumbents.length)));
  const remainingCapacity = Math.max(
    0,
    CONFIG.maxNodesPerRun - selectedIncumbents.length - selectedSticky.length,
  );

  const selectedOrdinary = ordinaryMaintenance.slice(0, Math.min(ordinaryLimit, remainingCapacity));
  const selectedRecovery = recovery.slice(0, Math.min(recoveryLimit, Math.max(0, remainingCapacity - selectedOrdinary.length)));
  const selectedExploration = exploration.slice(0, Math.min(explorationLimit, Math.max(0, remainingCapacity - selectedOrdinary.length - selectedRecovery.length)));

  const selected = [
    ...selectedIncumbents,
    ...selectedSticky,
    ...selectedOrdinary,
    ...selectedRecovery,
    ...selectedExploration,
  ];

  for (const candidate of selected) {
    const item = queueById.get(candidate.endpointId);
    if (item) item.lastSelectedAt = now();
  }
  discoveryQueue.items = [...queueById.values()];
  discoveryQueue.updatedAt = now();

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
      !chatgptIncumbentIds.has(candidate.endpointId) &&
      candidate.category !== 'sticky-incumbent'
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
  const discoveryQueue = loadDiscoveryQueue();
  const at = now();
  const atMs = Date.parse(at);

  // Stable is only the discovery feed. Known China assets are maintained from
  // persistent China state even when they are absent from the current Stable feed.
  const candidates = buildCandidates(stable, state, atMs, discoveryQueue);
  saveDiscoveryQueue(discoveryQueue);

  state.generatedAt = at;
  state.lastCandidateRunAt = at;
  state.lastCandidateCount = candidates.length;
  state.currentStableCount = stable.length;
  state.currentStableIds = stable.map(x => x.endpointId);

  saveState(state);
  saveCandidates(candidates, at);

  console.log(JSON.stringify({
    stable: stable.length,
    discoveryBacklog: discoveryQueue.items.length,
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
  loadDiscoveryQueue,
  saveDiscoveryQueue,
  selectCandidates,
};

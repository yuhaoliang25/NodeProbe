#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { timeDecayedEvidence } = require('./time-decay');

const ASSET_FILE = process.env.CHINA_ASSET_FILE || 'data/china-node-assets.json';
const PAIR_FILE = process.env.CHINA_PAIR_KNOWLEDGE_FILE || 'data/china-pair-knowledge.json';
const EXIT_FILE = process.env.CHINA_EXIT_POOL_FILE || 'subscriptions/exit.yaml';
const PAIR_POOL_FILE = process.env.CHINA_PAIR_POOL_FILE || 'subscriptions/pairs.yaml';
const OUTPUT_FILE = process.env.CHINA_ELITE_FILE || 'subscriptions/elite.yaml';
const CHATGPT_OUTPUT_FILE = process.env.CHINA_CHATGPT_FILE || 'subscriptions/chatgpt.yaml';
const META_FILE = path.join(path.dirname(OUTPUT_FILE), 'china-elite.json');

const MAX_PATHS = Math.max(1, Number(process.env.CHINA_ELITE_MAX_PATHS || 3));
const MIN_OBSERVATIONS = Math.max(1, Number(process.env.CHINA_ELITE_MIN_OBSERVATIONS || 5));
const MIN_RECENT_RATE = Math.max(0, Math.min(1, Number(process.env.CHINA_ELITE_MIN_RECENT_RATE || 0.90)));
const DECAY_HALF_LIFE_MS = Math.max(1, Number(process.env.CHINA_ELITE_DECAY_HALF_LIFE_MS || 72 * 60 * 60 * 1000));
const PAIR_MAX_AGE_MS = Math.max(1, Number(process.env.CHINA_PAIR_MAX_AGE_MS || 72 * 60 * 60 * 1000));
const CHATGPT_MIN_RATE = Math.max(0, Math.min(1, Number(process.env.CHINA_CHATGPT_MIN_SUCCESS_RATE || 1.0)));
const CHATGPT_MIN_ATTEMPTS = Math.max(1, Number(process.env.CHINA_CHATGPT_MIN_ATTEMPTS || 3));
const PAIR_MIN_RATE = Math.max(0, Math.min(1, Number(process.env.CHINA_PAIR_MIN_SUCCESS_RATE || 0.80)));

function loadJson(file) {
  if (!fs.existsSync(file)) throw new Error('Missing file: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadYaml(file) {
  if (!fs.existsSync(file)) return [];
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(doc?.proxies)) throw new Error(file + ': expected proxies array');
  return doc.proxies.filter(p => p && typeof p === 'object' && p.name);
}

function recent(node) {
  return Array.isArray(node?.observations) ? node.observations.slice(-10) : [];
}

function rate(obs) {
  return obs.length ? obs.filter(x => x.success === true).length / obs.length : 0;
}

function p95(obs) {
  const values = obs.map(x => Number(x.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)] : null;
}

function latestSpeed(node) {
  // Ignore runs that did not enter the bounded speed-test lane, but honor the
  // most recent actual speed attempt. A newer failed test must invalidate an
  // older successful throughput measurement rather than leaving stale speed
  // evidence in the ranking indefinitely.
  const attempts = recent(node).filter(x => x.speedSuccess === true || x.speedSuccess === false);
  if (!attempts.length) return null;
  const latest = attempts[attempts.length - 1];
  if (latest.speedSuccess !== true) return null;
  const speed = Number(latest.speedMbps);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

function speedScore(node) {
  const speed = latestSpeed(node);
  if (speed == null) return 0;
  // Logarithmic scoring keeps a 100 Mbps node from completely overwhelming
  // reliability, while still strongly preferring 10 Mbps over 1 Mbps.
  return Math.min(500, Math.log2(1 + speed) * 80);
}

function isHongKongProxy(proxy) {
  const name = String(proxy?.name || '');
  // ChatGPT must not use Hong Kong exits, regardless of ordinary Elite
  // eligibility. Prefer explicit country markers used by NodeProbe naming,
  // and also recognize literal Chinese/English labels.
  if (/香港|hong[\s_-]*kong/i.test(name)) return true;
  const flag = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0];
  if (flag) {
    const code = [...flag]
      .map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65))
      .join('');
    if (code === 'HK') return true;
  }
  return /(?:^|[^A-Za-z])HK_\d+(?:\||$)/.test(name);
}

function chatgptRate(node) {
  const obs = recent(node).filter(x => Array.isArray(x.chatgptAttempts) && x.chatgptAttempts.length);
  if (!obs.length) return null;
  const values = obs.map(x => Number(x.chatgptSuccessRate)).filter(Number.isFinite);
  return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
}

function chatgptScore(node) {
  const obs = recent(node).filter(x => Array.isArray(x.chatgptAttempts) && x.chatgptAttempts.length);
  const latest = obs[obs.length - 1];
  if (!latest || latest.chatgptEligible !== true) return -Infinity;
  const successRate = Number(latest.chatgptSuccessRate);
  const latency = p95(latest.chatgptAttempts);
  const latencyPenalty = latency == null ? 0 : Math.min(250, latency / 20);
  // Speed is a secondary preference within the ChatGPT-capable pool, not a
  // capability gate. Keep its contribution bounded so a fast but less reliable
  // exit cannot outrank the strict ChatGPT success-rate requirement.
  const throughputScore = Math.min(100, Math.log2(1 + Math.max(0, latestSpeed(node) || 0)) * 15);
  return successRate * 1000 +
    Math.min(100, obs.length * 10) +
    Math.min(50, Number(node.observedRuns || 0)) +
    throughputScore -
    latencyPenalty;
}

function latestChatGPTObservation(node) {
  const obs = recent(node).filter(x => Array.isArray(x.chatgptAttempts) && x.chatgptAttempts.length);
  return obs.length ? obs[obs.length - 1] : null;
}

function chatgptEligible(node) {
  const latest = latestChatGPTObservation(node);
  if (!latest) return false;
  // ChatGPT is its own capability pool. It still requires a confirmed usable
  // exit in the same observation, but it must not depend on the ordinary
  // Elite threshold (top-3 ranking, five-run trust threshold, or 90% recent
  // rate). The ChatGPT-specific three-attempt test is the capability gate.
  return latest.success === true &&
    latest.exitSuccess === true &&
    latest.chatgptEligible === true &&
    Number(latest.chatgptSuccessRate) >= CHATGPT_MIN_RATE &&
    latest.chatgptAttempts.length >= CHATGPT_MIN_ATTEMPTS;
}

function exitScore(node, atMs = Date.now()) {
  const obs = recent(node);
  const decayed = timeDecayedEvidence(node.observations, atMs, DECAY_HALF_LIFE_MS);
  const recentRate = decayed.rate;
  const lifetimeRate = node.observedRuns ? node.successes / node.observedRuns : 0;
  const latency = p95(obs);
  const latencyPenalty = latency == null ? 0 : Math.min(250, latency / 20);
  const throughputScore = speedScore(node);
  return recentRate * 1000 + lifetimeRate * 500 + throughputScore + Math.min(30, node.observedRuns || 0) * 5 - latencyPenalty;
}

function eligibleExits(state, atMs = Date.now()) {
  return Object.values(state.nodes || {})
    .filter(node =>
      node &&
      node.state === 'TRUSTED' &&
      node.proxy &&
      Number(node.observedRuns) >= MIN_OBSERVATIONS &&
      timeDecayedEvidence(node.observations, atMs, DECAY_HALF_LIFE_MS).rate >= MIN_RECENT_RATE &&
      Number(node.failureStreak || 0) === 0
    )
    .map(node => ({
      kind: 'exit',
      endpointId: node.endpointId,
      proxy: node.proxy,
      score: exitScore(node, atMs),
      recentSuccessRate: timeDecayedEvidence(node.observations, atMs, DECAY_HALF_LIFE_MS).rate,
      lifetimeSuccessRate: node.observedRuns ? node.successes / node.observedRuns : 0,
      observedRuns: node.observedRuns,
      p95LatencyMs: p95(recent(node)),
      speedMbps: latestSpeed(node),
    }))
    .sort((a, b) => b.score - a.score || b.recentSuccessRate - a.recentSuccessRate || b.observedRuns - a.observedRuns);
}

function eligiblePairs(state) {
  const cutoff = Date.now() - PAIR_MAX_AGE_MS;
  return Object.entries(state.pairs || {})
    .map(([pairId, pair]) => {
      const last = Date.parse(pair.lastObservedAt || '');
      const obs = Array.isArray(pair.observations) ? pair.observations.slice(-10) : [];
      const recentRate = obs.length ? obs.filter(x => x.success === true && x.improved === true).length / obs.length : 0;
      return { pairId, pair, last, obs, recentRate };
    })
    .filter(x =>
      Number.isFinite(x.last) &&
      x.last >= cutoff &&
      x.pair.relay &&
      x.pair.landing &&
      x.obs.some(x => x.confirmed === true) &&
      x.recentRate >= PAIR_MIN_RATE
    )
    .sort((a, b) => b.recentRate - a.recentRate || b.last - a.last);
}

function main() {
  const assets = loadJson(ASSET_FILE);
  const pairState = fs.existsSync(PAIR_FILE) ? loadJson(PAIR_FILE) : { pairs: {} };
  const atMs = Date.now();
  const exits = eligibleExits(assets, atMs);
  const selected = exits.slice(0, MAX_PATHS);

  // ChatGPT is an independent capability pool. Retain healthy incumbents
  // first, then use newly tested ChatGPT-capable exits to fill vacancies.
  const previousChatgpt = loadYaml(CHATGPT_OUTPUT_FILE);
  const previousNames = new Set(previousChatgpt.map(p => String(p.name)));
  // Do not derive ChatGPT candidates from the ordinary Elite list.
  // The ordinary list is deliberately small and ranking-oriented; ChatGPT
  // needs its own evidence pool so a capable node can enter or remain there
  // even when it is not among the ordinary Elite paths.
  const eligibleChatgpt = Object.values(assets.nodes || {})
    .filter(node => node && node.proxy && !isHongKongProxy(node.proxy) && chatgptEligible(node))
    .map(node => ({
      kind: 'exit',
      endpointId: node.endpointId,
      proxy: node.proxy,
      score: exitScore(node, atMs),
      recentSuccessRate: timeDecayedEvidence(node.observations, atMs, DECAY_HALF_LIFE_MS).rate,
      lifetimeSuccessRate: node.observedRuns ? node.successes / node.observedRuns : 0,
      observedRuns: node.observedRuns,
      p95LatencyMs: p95(recent(node)),
      speedMbps: latestSpeed(node),
      chatgptScore: chatgptScore(node),
    }))
    .sort((a,b) => b.chatgptScore - a.chatgptScore || b.score - a.score);
  const byName = new Map(eligibleChatgpt.map(item => [String(item.proxy.name), item]));
  const incumbents = previousChatgpt.map(proxy => byName.get(String(proxy.name))).filter(Boolean);
  const chatgptSelected = [];
  const selectedIds = new Set();
  for (const item of incumbents) {
    if (chatgptSelected.length >= MAX_PATHS) break;
    chatgptSelected.push(item);
    selectedIds.add(item.endpointId);
  }
  for (const item of eligibleChatgpt) {
    if (chatgptSelected.length >= MAX_PATHS) break;
    if (selectedIds.has(item.endpointId)) continue;
    chatgptSelected.push(item);
    selectedIds.add(item.endpointId);
  }
  const chatgptExits = eligibleChatgpt;
  const pairFallbacks = selected.length < MAX_PATHS ? eligiblePairs(pairState).slice(0, MAX_PATHS - selected.length) : [];

  const exitNames = new Set(loadYaml(EXIT_FILE).map(p => String(p.name)));
  const pairByName = new Map(loadYaml(PAIR_POOL_FILE).map(p => [String(p.name), p]));
  const proxies = [];
  const paths = [];

  for (const item of selected) {
    const name = String(item.proxy.name || '');
    if (!exitNames.has(name)) continue;
    proxies.push(item.proxy);
    paths.push({
      kind: 'exit',
      endpointId: item.endpointId,
      name,
      score: item.score,
      recentSuccessRate: item.recentSuccessRate,
      lifetimeSuccessRate: item.lifetimeSuccessRate,
      observedRuns: item.observedRuns,
      p95LatencyMs: item.p95LatencyMs,
      speedMbps: item.speedMbps,
    });
  }

  for (const item of pairFallbacks) {
    const relayName = 'PAIR-RELAY-' + item.pair.relayEndpointId;
    const pairName = 'PAIR-' + item.pairId;
    const relay = pairByName.get(relayName);
    const pair = pairByName.get(pairName);
    if (!relay || !pair) continue;
    proxies.push(relay, pair);
    paths.push({
      kind: 'pair',
      pairId: item.pairId,
      name: pairName,
      relayName,
      recentSuccessRate: item.recentRate,
      lastObservedAt: item.pair.lastObservedAt,
    });
  }

  const seen = new Set();
  const unique = proxies.filter(p => {
    const name = String(p.name);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, yaml.dump({ proxies: unique }, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: true,
    quotingType: "'",
  }));

  fs.writeFileSync(CHATGPT_OUTPUT_FILE, yaml.dump({ proxies: chatgptSelected.map(item => item.proxy) }, {
    lineWidth: -1, noRefs: true, forceQuotes: true, quotingType: '\''
  }));

  fs.writeFileSync(META_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    maxPaths: MAX_PATHS,
    counts: {
      eligibleExits: exits.length,
      chatgptEligibleExits: chatgptExits.length,
      chatgptSelectedPaths: chatgptSelected.length,
      chatgptIncumbentPaths: incumbents.length,
      selectedPaths: paths.length,
      publishedProxies: unique.length,
    },
    policy: {
      minObservations: MIN_OBSERVATIONS,
      minRecentSuccessRate: MIN_RECENT_RATE,
      decayHalfLifeMs: DECAY_HALF_LIFE_MS,
      chatgptMinSuccessRate: CHATGPT_MIN_RATE,
      chatgptMinAttempts: CHATGPT_MIN_ATTEMPTS,
      chatgptPoolMode: 'incumbent-first-with-exploration',
      chatgptExcludedRegions: ['HK'],
      pairFallbackOnly: true,
    },
    paths,
    chatgptPaths: chatgptSelected.map(item => ({kind: previousNames.has(String(item.proxy.name)) ? 'chatgpt-incumbent' : 'chatgpt-exploration', endpointId:item.endpointId, name:String(item.proxy.name||''), score:item.score, chatgptScore:item.chatgptScore, chatgptSuccessRate:chatgptRate(assets.nodes[item.endpointId])})),
  }, null, 2) + '\n');

  console.log(JSON.stringify({
    eligibleExits: exits.length,
    selectedPaths: paths.length,
    publishedProxies: unique.length,
    chatgptEligibleExits: chatgptExits.length,
    chatgptSelectedPaths: chatgptSelected.length,
    chatgptIncumbentPaths: incumbents.length,
    output: OUTPUT_FILE,
    chatgptOutput: CHATGPT_OUTPUT_FILE,
  }, null, 2));
}

main();

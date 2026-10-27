#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const API = process.env.MIHOMO_API || 'http://127.0.0.1:9090';
const PROXY = process.env.TEST_PROXY || 'http://127.0.0.1:7890';
const requestedMax = Number(process.env.TEST_MAX_NODES || 30);
const MAX_NODES = Number.isFinite(requestedMax) ? Math.max(1, Math.min(100, Math.floor(requestedMax))) : 30;
const OUT = 'reports/chatgpt-unlock';
const SELECTED = 'data/chatgpt-test-selected.json';
const CONFIG_OUT = 'mihomo/chatgpt-test-config.yaml';

function readProxies(file) {
  try {
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
    return Array.isArray(doc.proxies) ? doc.proxies.filter(p => p && p.name && p.type && p.server && p.port) : [];
  } catch {
    return [];
  }
}
function evenlySample(items, limit) {
  if (items.length <= limit) return items;
  if (limit === 1) return [items[0]];
  return Array.from({ length: limit }, (_, i) => items[Math.round(i * (items.length - 1) / (limit - 1))]);
}
async function apiJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const body = await response.text();
  if (!response.ok) throw new Error('Mihomo API HTTP ' + response.status + ': ' + body.slice(0, 200));
  return body ? JSON.parse(body) : {};
}
function curl(url) {
  const r = spawnSync('curl', [
    '--silent', '--show-error', '--location', '--max-time', '12',
    '--connect-timeout', '6', '--proxy', PROXY,
    '--user-agent', 'NodeProbe-ChatGPT-Unlock-Test/1.0',
    '--output', '-', '--write-out', '\n__NODEPROBE_STATUS__:%{http_code}',
    url,
  ], { encoding: 'utf8', timeout: 15000, maxBuffer: 3 * 1024 * 1024 });
  if (r.error) return { status: 0, body: '', error: r.error.message };
  const text = r.stdout || '';
  const marker = '\n__NODEPROBE_STATUS__:';
  const at = text.lastIndexOf(marker);
  const body = at >= 0 ? text.slice(0, at) : text;
  const status = at >= 0 ? Number(text.slice(at + marker.length).trim()) || 0 : 0;
  return { status, body: body.slice(0, 2 * 1024 * 1024), error: r.status === 0 ? null : (r.stderr || ('curl exit ' + r.status)).trim().slice(0, 300) };
}
function classifyPage(result) {
  const body = result.body.toLowerCase();
  const challenge = /just a moment|verify you are human|cf-chl-|captcha|unusual activity|unsupported country|not available in your country|country or region not supported|vpn.*blocked/.test(body);
  const hasAppHints = /chatgpt|openai|__next|application\/json/.test(body);
  return {
    status: result.status,
    accessible: result.status === 200 && !challenge && hasAppHints,
    challengeOrRestrictionSuspected: challenge,
    error: result.error,
  };
}
function classifyApi(result) {
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch {}
  const code = parsed?.error?.code || parsed?.error?.type || null;
  const message = typeof parsed?.error?.message === 'string' ? parsed.error.message.slice(0, 240) : null;
  const authRejectedAsExpected = result.status === 401 && /api.?key|authentication/i.test((String(code || '') + ' ' + String(message || '')).toLowerCase());
  const appLayerResponse = Boolean(parsed && parsed.error) && [400, 401, 403, 404, 429].includes(result.status);
  return {
    status: result.status,
    appLayerResponse,
    authRejectedAsExpected,
    errorCode: code,
    errorMessage: message,
    error: result.error,
  };
}
function isHongKongProxy(proxy) {
  const name = String(proxy?.name || '');
  if (/香港|hong[\s_-]*kong/i.test(name)) return true;
  const flag = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0];
  if (flag) {
    const code = [...flag].map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65)).join('');
    if (code === 'HK') return true;
  }
  return /(?:^|[^A-Za-z])HK_\d+(?:\||$)/.test(name);
}
function latestGoodObservation(node) {
  const observations = Array.isArray(node?.observations) ? node.observations : [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (let i = observations.length - 1; i >= 0; i--) {
    const obs = observations[i];
    const at = Date.parse(obs?.at || '');
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (obs.success === true && obs.exitSuccess === true) return obs;
  }
  return null;
}
function assetScore(node, observation) {
  const trusted = node.state === 'TRUSTED' ? 100000 : 0;
  const stateScore = node.state === 'PROBATION' ? 20000 : node.state === 'DEGRADED' ? 5000 : 0;
  const reliability = Number(node.observedRuns) > 0 ? (Number(node.successes || 0) / Number(node.observedRuns)) * 1000 : 0;
  const speed = Number(observation.speedSuccess === true ? observation.speedMbps : 0);
  const speedScore = Number.isFinite(speed) && speed > 0 ? Math.min(500, Math.log2(1 + speed) * 50) : 0;
  const latency = Number(observation.latencyMs);
  const latencyScore = Number.isFinite(latency) && latency > 0 ? Math.max(0, 500 - latency / 10) : 0;
  const ageHours = Math.max(0, (Date.now() - Date.parse(observation.at)) / 3600000);
  const freshnessScore = Math.max(0, 200 - ageHours);
  return trusted + stateScore + reliability + speedScore + latencyScore + freshnessScore;
}
function prepare() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync('mihomo', { recursive: true });

  const assetFile = 'data/china-node-assets.json';
  if (!fs.existsSync(assetFile)) throw new Error('China asset pool missing: ' + assetFile + '; refusing to fall back to unrelated repository nodes.');
  const state = JSON.parse(fs.readFileSync(assetFile, 'utf8'));
  if (!state || typeof state.nodes !== 'object' || !state.nodes) throw new Error('China asset pool has invalid schema: expected nodes object.');

  const candidates = [];
  for (const node of Object.values(state.nodes)) {
    const proxy = node?.proxy;
    if (!proxy?.name || !proxy?.type || !proxy?.server || !proxy?.port || isHongKongProxy(proxy)) continue;
    const observation = latestGoodObservation(node);
    if (!observation) continue;
    candidates.push({
      proxy,
      endpointId: node.endpointId || null,
      state: node.state || 'UNKNOWN',
      observation,
      score: assetScore(node, observation),
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.proxy.name.localeCompare(b.proxy.name));
  const selected = candidates.slice(0, MAX_NODES);
  if (!selected.length) {
    throw new Error('No eligible China asset nodes: require a non-Hong-Kong proxy with a successful exit observation within the last 7 days.');
  }
  const proxies = selected.map(x => x.proxy);
  fs.writeFileSync(SELECTED, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'B2 China Asset Pool (nodeprobe-state/china-node-assets.json)',
    availableCount: candidates.length,
    selectedCount: proxies.length,
    selectionPolicy: 'rank recent successful exit observations; prefer TRUSTED assets, reliability, measured speed, lower latency and freshness; exclude Hong Kong',
    selected: selected.map(x => ({
      name: x.proxy.name,
      endpointId: x.endpointId,
      state: x.state,
      score: Math.round(x.score * 100) / 100,
      observedAt: x.observation.at,
      latencyMs: x.observation.latencyMs ?? null,
      speedMbps: x.observation.speedSuccess === true ? x.observation.speedMbps ?? null : null,
    })),
    proxies,
  }, null, 2) + '\n');

  const names = proxies.map(p => p.name);
  const config = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': '127.0.0.1:9090',
    proxies,
    'proxy-groups': [{ name: 'PROBE', type: 'select', proxies: names }],
    rules: ['MATCH,PROBE'],
  };
  fs.writeFileSync(CONFIG_OUT, yaml.dump(config, { lineWidth: -1, noRefs: true }));
  console.log('[chatgpt-test] source=China Asset Pool candidates=' + candidates.length + ' selected=' + proxies.length);
  console.log('[chatgpt-test] selection=recent successful exits; TRUSTED preferred; Hong Kong excluded');
  console.log('[chatgpt-test] endpoints: Cloudflare trace, ChatGPT web, unauthenticated OpenAI API /v1/models');
}
async function run() {
  const selection = JSON.parse(fs.readFileSync(SELECTED, 'utf8'));
  const rows = [];
  for (let i = 0; i < selection.proxies.length; i++) {
    const p = selection.proxies[i];
    const row = { name: p.name, testedAt: new Date().toISOString() };
    try {
      await apiJson(API + '/proxies/PROBE', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: p.name }),
      });
      await new Promise(r => setTimeout(r, 300));
      const trace = curl('https://www.cloudflare.com/cdn-cgi/trace');
      row.cloudflare = { status: trace.status, error: trace.error };
      const loc = trace.body.match(/(?:^|\n)loc=([A-Z]{2})(?:\n|$)/);
      row.cloudflare.region = loc ? loc[1] : null;
      row.cloudflare.traceRecognized = trace.status === 200 && /(?:^|\n)(?:loc|ip|http)=/.test(trace.body);

      const page = curl('https://chatgpt.com/');
      row.chatgptWeb = classifyPage(page);

      const api = curl('https://api.openai.com/v1/models');
      row.openaiApi = classifyApi(api);
    } catch (e) {
      row.probeError = String(e && e.message || e).slice(0, 300);
    }
    rows.push(row);
    const compactError = value => value ? String(value).replace(/\s+/g, ' ').slice(0, 100) : '-';
    console.log('[chatgpt-test] ' + (i + 1) + '/' + selection.proxies.length +
      ' trace=' + (row.cloudflare?.status ?? 'skip') +
      ' traceErr=' + compactError(row.cloudflare?.error) +
      ' web=' + (row.chatgptWeb?.accessible ? 'accessible' : (row.chatgptWeb?.status ?? 'skip')) +
      ' webErr=' + compactError(row.chatgptWeb?.error) +
      ' api=' + (row.openaiApi?.authRejectedAsExpected ? '401-auth' : (row.openaiApi?.status ?? 'skip')) +
      ' apiErr=' + compactError(row.openaiApi?.error) +
      ' region=' + (row.cloudflare?.region || '?') + ' | ' + p.name);
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    source: selection.source,
    availableCount: selection.availableCount,
    testedCount: rows.length,
    regionRecognized: rows.filter(x => x.cloudflare?.traceRecognized).length,
    chatgptWebAccessible: rows.filter(x => x.chatgptWeb?.accessible).length,
    chatgptRestrictionSuspected: rows.filter(x => x.chatgptWeb?.challengeOrRestrictionSuspected).length,
    openaiApiApplicationResponse: rows.filter(x => x.openaiApi?.appLayerResponse).length,
    openaiApiExpectedAuthRejection: rows.filter(x => x.openaiApi?.authRejectedAsExpected).length,
    note: 'Anonymous network indicators only; this does not verify account login or a real ChatGPT conversation.',
    results: rows,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('[chatgpt-test] summary: ' + JSON.stringify({
    source: summary.source, tested: summary.testedCount,
    regionRecognized: summary.regionRecognized,
    webAccessible: summary.chatgptWebAccessible,
    restrictionSuspected: summary.chatgptRestrictionSuspected,
    apiApplicationResponse: summary.openaiApiApplicationResponse,
    apiExpectedAuthRejection: summary.openaiApiExpectedAuthRejection,
  }));
}
(async () => {
  if (process.argv[2] === 'prepare') prepare();
  else await run();
})().catch(e => { console.error('[chatgpt-test] FATAL:', e); process.exit(1); });

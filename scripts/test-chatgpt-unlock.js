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
async function prepare() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync('data', { recursive: true });
  fs.mkdirSync('mihomo', { recursive: true });
  const stable = readProxies('data/stable.yaml');
  const checkedIn = readProxies('mihomo/all.yaml');
  const source = stable.length ? 'B2 stable.yaml' : 'repository mihomo/all.yaml fallback';
  const available = stable.length ? stable : checkedIn;
  if (!available.length) throw new Error('No usable proxies in B2 stable.yaml or mihomo/all.yaml');
  const selected = evenlySample(available, MAX_NODES);
  fs.writeFileSync(SELECTED, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source,
    availableCount: available.length,
    selectedCount: selected.length,
    proxies: selected,
  }, null, 2) + '\n');
  const names = selected.map(p => p.name);
  const config = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': '127.0.0.1:9090',
    proxies: selected,
    'proxy-groups': [{ name: 'PROBE', type: 'select', proxies: names }],
    rules: ['MATCH,PROBE'],
  };
  fs.writeFileSync(CONFIG_OUT, yaml.dump(config, { lineWidth: -1, noRefs: true }));
  console.log('[chatgpt-test] source=' + source + ' available=' + available.length + ' selected=' + selected.length);
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
    const compactError = value => value ? String(value).replace(/\\s+/g, ' ').slice(0, 100) : '-';
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
  if (process.argv[2] === 'prepare') await prepare();
  else await run();
})().catch(e => { console.error('[chatgpt-test] FATAL:', e); process.exit(1); });

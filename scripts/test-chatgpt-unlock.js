#!/usr/bin/env node
/* global document, location */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { chromium } = require('playwright');

const API = process.env.MIHOMO_API || 'http://127.0.0.1:9090';
const PROXY = process.env.TEST_PROXY || 'http://127.0.0.1:7890';
const requestedMax = Number(process.env.TEST_MAX_NODES || 30);
const MAX_NODES = Number.isFinite(requestedMax) ? Math.max(1, Math.min(100, Math.floor(requestedMax))) : 30;
const requestedChallengeWait = Number(process.env.CHALLENGE_WAIT_SECONDS || 20);
const CHALLENGE_WAIT_SECONDS = Number.isFinite(requestedChallengeWait)
  ? Math.max(5, Math.min(45, Math.floor(requestedChallengeWait))) : 20;
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
    '--silent', '--show-error', '--location', '--max-time', '8',
    '--connect-timeout', '3', '--proxy', PROXY,
    '--user-agent', 'NodeProbe-ChatGPT-Unlock-Test/1.0',
    '--output', '-', '--write-out', '\n__NODEPROBE_META__:%{http_code}|%{content_type}|%{url_effective}',
    url,
  ], { encoding: 'utf8', timeout: 10000, maxBuffer: 3 * 1024 * 1024 });
  if (r.error) return { status: 0, body: '', error: r.error.message };
  const text = r.stdout || '';
  const marker = '\n__NODEPROBE_META__:';
  const at = text.lastIndexOf(marker);
  const body = at >= 0 ? text.slice(0, at) : text;
  const meta = at >= 0 ? text.slice(at + marker.length).trim().split('|') : [];
  const status = Number(meta[0]) || 0;
  return {
    status,
    contentType: meta[1] || null,
    effectiveUrl: meta[2] || null,
    body: body.slice(0, 2 * 1024 * 1024),
    error: r.status === 0 ? null : (r.stderr || ('curl exit ' + r.status)).trim().slice(0, 300),
  };
}
function classifyPage(result) {
  const body = result.body.toLowerCase();
  const challenge = /just a moment|verify you are human|cf-chl-|captcha|unusual activity|unsupported country|not available in your country|country or region not supported|vpn.{0,30}blocked|enable javascript and cookies to continue/.test(body);
  const hasAppHints = /chatgpt|openai|__next|application\/json/.test(body);
  const title = (result.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  const snippet = result.body.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim().slice(0, 300);
  let classification = 'other';
  if (result.status === 0) classification = 'connection_error';
  else if (challenge) classification = result.status === 403 ? 'http_403_challenge_page' : 'challenge_or_restriction_page';
  else if (result.status === 403) classification = 'http_403_forbidden';
  else if (result.status === 429) classification = 'http_429_rate_limited';
  else if (result.status === 200 && hasAppHints) classification = 'http_200_app_shell_unverified';
  else if (result.status === 200) classification = 'http_200_unverified_page';
  return {
    status: result.status,
    contentType: result.contentType,
    effectiveUrl: result.effectiveUrl,
    classification,
    // curl does not execute JavaScript; an HTTP 200 app shell is not proof that the UI rendered.
    accessible: false,
    challengeOrRestrictionSuspected: challenge,
    pageTitle: title || null,
    responseSnippet: snippet || null,
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
async function probeBrowser(browser, proxyName) {
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(12000);
  page.setDefaultTimeout(5000);
  let responseStatus = 0;
  let navigationError = null;
  const failedRequests = [];
  const networkResponses = [];
  const pageErrors = [];
  const mainDocumentResponses = [];
  const challengeTimeline = [];
  page.on('pageerror', error => { if (pageErrors.length < 5) pageErrors.push(String(error?.message || error).slice(0, 180)); });
  page.on('response', response => {
    const url = response.url();
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if ((/cloudflare\.com$/i.test(parsed.hostname) || /chatgpt\.com$/i.test(parsed.hostname) || /openai\.com$/i.test(parsed.hostname)) && networkResponses.length < 40) {
      networkResponses.push({ host: parsed.hostname, path: parsed.pathname.slice(0, 120), status: response.status(), resourceType: response.request().resourceType() });
    }
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      responseStatus = response.status();
      if (mainDocumentResponses.length < 10) {
        void response.allHeaders().then(headers => {
          const cookieHeader = String(headers['set-cookie'] || '');
          mainDocumentResponses.push({
            status: response.status(),
            url: response.url().slice(0, 240),
            cfMitigated: headers['cf-mitigated'] || null,
            cfRay: headers['cf-ray'] || null,
            server: headers.server || null,
            contentType: headers['content-type'] || null,
            setCookieNames: [...cookieHeader.matchAll(/(?:^|,\s*)([^=;,\s]+)=/g)].map(m => m[1]).slice(0, 12),
          });
        }).catch(() => {});
      }
    }
  });
  page.on('requestfailed', request => {
    const url = request.url();
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if ((/cloudflare\.com$/i.test(host) || /chatgpt\.com$/i.test(host) || /openai\.com$/i.test(host)) && failedRequests.length < 12) {
      failedRequests.push({ host, error: String(request.failure()?.errorText || 'unknown').slice(0, 160) });
    }
  });
  try {
    const response = await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 12000 });
    responseStatus = response ? response.status() : 0;
    // Observe the site's normal JavaScript challenge flow; do not solve, spoof, or bypass it.
    const deadline = Date.now() + CHALLENGE_WAIT_SECONDS * 1000;
    while (Date.now() < deadline) {
      let snapshot = { title: '', url: page.url(), bodyTextLength: 0, htmlLength: 0, hasMain: false, hasComposer: false };
      try {
        snapshot = await page.evaluate(() => {
          const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
          const title = document.title || '';
          return {
            title: title.slice(0, 160),
            url: location.href.slice(0, 240),
            bodyTextLength: bodyText.length,
            bodyTextSnippet: bodyText.slice(0, 180) || null,
            htmlLength: document.documentElement?.outerHTML?.length || 0,
            hasMain: Boolean(document.querySelector('main, [role="main"]')),
            hasComposer: Boolean(document.querySelector('textarea, [contenteditable="true"], [data-testid*="composer"]')),
          };
        });
      } catch (e) {
        snapshot.evaluateError = String(e?.message || e).slice(0, 120);
      }
      snapshot.elapsedMs = CHALLENGE_WAIT_SECONDS * 1000 - Math.max(0, deadline - Date.now());
      if (challengeTimeline.length < 24) challengeTimeline.push(snapshot);
      const text = (snapshot.title + ' ' + (snapshot.bodyTextSnippet || '')).toLowerCase();
      const stillChallenge = /just a moment|attention required|verify you are human|cf-chl-|captcha|enable javascript and cookies to continue/.test(text);
      if (snapshot.hasMain || snapshot.hasComposer) break;
      if (!stillChallenge && snapshot.bodyTextLength > 0) break;
      await page.waitForTimeout(2000);
    }
  } catch (e) {
    navigationError = String(e && e.message || e).slice(0, 240);
  }
  let pageData = {
    title: '', url: page.url(), readyState: null, bodyText: '', bodyTextContentSnippet: '',
    bodyTextContentLength: 0, htmlLength: 0, bodyHtmlLength: 0, scriptSources: [],
    scriptCount: 0, iframeCount: 0, formCount: 0, inputCount: 0,
    challengeElementCount: 0, hasMain: false, hasLoginControl: false, hasComposer: false,
  };
  try {
    pageData = await page.evaluate(() => {
      const body = document.body;
      const bodyText = (body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
      const controls = [...document.querySelectorAll('button, a')].map(el => (el.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase());
      const challengeElements = document.querySelectorAll(
        '[id*="challenge" i], [class*="challenge" i], #challenge-form, [name*="captcha" i], iframe[src*="challenge" i]'
      );
      return {
        title: document.title || '',
        url: location.href,
        readyState: document.readyState,
        bodyText,
        bodyTextContentLength: (body?.textContent || '').trim().length,
        bodyTextContentSnippet: (body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        scriptSources: [...document.scripts].map(s => { try { if (!s.src) return 'inline'; const u = new URL(s.src); return u.hostname + u.pathname.slice(0, 100); } catch { return 'unknown'; } }).slice(0, 8),
        htmlLength: document.documentElement?.outerHTML?.length || 0,
        bodyHtmlLength: body?.innerHTML?.length || 0,
        scriptCount: document.scripts.length,
        iframeCount: document.querySelectorAll('iframe').length,
        formCount: document.querySelectorAll('form').length,
        inputCount: document.querySelectorAll('input').length,
        challengeElementCount: challengeElements.length,
        hasMain: Boolean(document.querySelector('main, [role="main"]')),
        hasLoginControl: controls.some(t => /^(log in|sign up|登录|注册)$/.test(t)),
        hasComposer: Boolean(document.querySelector('textarea, [contenteditable="true"], [data-testid*="composer"]')),
      };
    });
  } catch (e) {
    navigationError = navigationError || String(e && e.message || e).slice(0, 240);
  }
  // Cloudflare challenge pages can expose a useful title while body.innerText is empty.
  // Classify from both title and body, and retain explicit body-availability diagnostics.
  const title = String(pageData.title || '').trim();
  const bodyText = String(pageData.bodyText || '').trim();
  const signals = (title + ' ' + bodyText).toLowerCase();
  const bodyTextAvailable = bodyText.length > 0;
  const challengeTitle = /just a moment|attention required|security check/i.test(title);
  const challengeBody = /just a moment|verify you are human|enable javascript and cookies to continue|unusual activity|sorry, you have been blocked|cf-chl-|captcha/.test(bodyText.toLowerCase());
  const challenge = challengeTitle || challengeBody || /cf-chl-|captcha/.test(signals);
  const regionRestriction = /unsupported country|not available in your country|country or region not supported|not available in your region/.test(signals);
  const titleLooksRight = /chatgpt/i.test(title);
  const renderedLanding = responseStatus === 200 && titleLooksRight && !challenge && !regionRestriction &&
    (pageData.hasMain || pageData.hasLoginControl || pageData.hasComposer) &&
    /chatgpt|openai|log in|sign up|登录|注册/i.test(pageData.bodyText);
  await context.close();
  return {
    status: responseStatus,
    classification: navigationError ? 'browser_navigation_error' :
      challenge ? 'browser_challenge_page' :
      regionRestriction ? 'browser_region_restriction' :
      renderedLanding ? 'browser_landing_rendered' :
      responseStatus === 403 ? 'browser_http_403' :
      responseStatus === 429 ? 'browser_http_429' :
      responseStatus === 200 ? 'browser_200_unverified' : 'browser_unavailable',
    landingPageRendered: Boolean(renderedLanding),
    // Anonymous landing-page rendering is not proof that a logged-in user can start a conversation.
    authenticatedChatVerified: false,
    challengeSuspected: Boolean(challenge),
    challengeSignal: challengeTitle ? 'title' : challengeBody ? 'body' : challenge ? 'other' : null,
    regionRestrictionSuspected: Boolean(regionRestriction),
    bodyTextAvailable,
    bodyTextLength: bodyText.length,
    bodyTextContentLength: pageData.bodyTextContentLength || 0,
    bodyTextContentSnippet: pageData.bodyTextContentSnippet || null,
    scriptSources: pageData.scriptSources || [],
    networkResponses,
    mainDocumentResponses,
    challengeTimeline,
    challengeWaitSeconds: CHALLENGE_WAIT_SECONDS,
    challengeResolvedDuringWait: challengeTimeline.some(x =>
      (x.hasMain || x.hasComposer) && !/just a moment|attention required|verify you are human|cf-chl-|captcha|enable javascript and cookies to continue/i.test(x.title + ' ' + (x.bodyTextSnippet || ''))
    ),
    pageErrors,
    failedRequests,
    htmlLength: pageData.htmlLength || 0,
    bodyHtmlLength: pageData.bodyHtmlLength || 0,
    readyState: pageData.readyState || null,
    scriptCount: pageData.scriptCount || 0,
    iframeCount: pageData.iframeCount || 0,
    formCount: pageData.formCount || 0,
    inputCount: pageData.inputCount || 0,
    challengeElementCount: pageData.challengeElementCount || 0,
    title: title || null,
    effectiveUrl: pageData.url || null,
    hasMain: pageData.hasMain,
    hasLoginControl: pageData.hasLoginControl,
    hasComposer: pageData.hasComposer,
    bodySnippet: pageData.bodyText || null,
    error: navigationError,
  };
}
async function run() {
  const selection = JSON.parse(fs.readFileSync(SELECTED, 'utf8'));
  const rows = [];
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: PROXY },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
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
      row.chatgptBrowser = await probeBrowser(browser, p.name);

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
      ' browser=' + (row.chatgptBrowser?.classification || 'skip') +
      ' webErr=' + compactError(row.chatgptWeb?.error) +
      ' api=' + (row.openaiApi?.authRejectedAsExpected ? '401-auth' : (row.openaiApi?.status ?? 'skip')) +
      ' apiErr=' + compactError(row.openaiApi?.error) +
      ' region=' + (row.cloudflare?.region || '?') + ' | ' + p.name);
  }
  await browser.close();
  const summary = {
    generatedAt: new Date().toISOString(),
    source: selection.source,
    availableCount: selection.availableCount,
    testedCount: rows.length,
    regionRecognized: rows.filter(x => x.cloudflare?.traceRecognized).length,
    chatgptWebAccessible: rows.filter(x => x.chatgptWeb?.accessible).length,
    browserLandingRendered: rows.filter(x => x.chatgptBrowser?.landingPageRendered).length,
    browserChallengePages: rows.filter(x => x.chatgptBrowser?.classification === 'browser_challenge_page').length,
    browserRegionRestrictions: rows.filter(x => x.chatgptBrowser?.classification === 'browser_region_restriction').length,
    browserNavigationErrors: rows.filter(x => x.chatgptBrowser?.classification === 'browser_navigation_error').length,
    // Count empty text only when the browser received an HTTP response; navigation failures are separate.
    browserEmptyBodies: rows.filter(x => x.chatgptBrowser && x.chatgptBrowser.status > 0 && !x.chatgptBrowser.bodyTextAvailable).length,
    browserEmptyDomBodies: rows.filter(x => x.chatgptBrowser && x.chatgptBrowser.status > 0 && (x.chatgptBrowser.bodyHtmlLength || 0) === 0).length,
    browserResponsesWithHtmlButNoText: rows.filter(x => x.chatgptBrowser && x.chatgptBrowser.status > 0 && (x.chatgptBrowser.bodyHtmlLength || 0) > 0 && !x.chatgptBrowser.bodyTextAvailable).length,
    browserChallengeRequestFailures: rows.reduce((n, x) => n + (x.chatgptBrowser?.failedRequests || []).filter(r => /challenges\.cloudflare\.com$/i.test(r.host)).length, 0),
    chatgptHttp403: rows.filter(x => x.chatgptWeb?.status === 403).length,
    chatgptHttp403Challenge: rows.filter(x => x.chatgptWeb?.classification === 'http_403_challenge_page').length,
    chatgptHttp200: rows.filter(x => x.chatgptWeb?.status === 200).length,
    chatgptHttp200Challenge: rows.filter(x => x.chatgptWeb?.status === 200 && x.chatgptWeb?.challengeOrRestrictionSuspected).length,
    chatgptHttp200Unverified: rows.filter(x => ['http_200_unverified_page', 'http_200_app_shell_unverified'].includes(x.chatgptWeb?.classification)).length,
    chatgptConnectionErrors: rows.filter(x => x.chatgptWeb?.classification === 'connection_error').length,
    chatgptRestrictionSuspected: rows.filter(x => x.chatgptWeb?.challengeOrRestrictionSuspected).length,
    openaiApiApplicationResponse: rows.filter(x => x.openaiApi?.appLayerResponse).length,
    openaiApiExpectedAuthRejection: rows.filter(x => x.openaiApi?.authRejectedAsExpected).length,
    challengeWaitSeconds: CHALLENGE_WAIT_SECONDS,
    challengeResolvedDuringWait: rows.filter(x => x.chatgptBrowser?.challengeResolvedDuringWait).length,
    mainDocumentResponsesWithCfMitigated: rows.reduce((n, x) => n + (x.chatgptBrowser?.mainDocumentResponses || []).filter(r => r.cfMitigated).length, 0),
    note: 'The browser test only observes the normal anonymous JavaScript challenge flow; it does not solve or bypass challenges. HTTP 200 or a rendered landing page does not prove account login or a real conversation works.',
    results: rows,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('[chatgpt-test] summary: ' + JSON.stringify({
    source: summary.source, tested: summary.testedCount,
    regionRecognized: summary.regionRecognized,
    webAccessible: summary.chatgptWebAccessible,
    browserLandingRendered: summary.browserLandingRendered,
    browserChallengePages: summary.browserChallengePages,
    browserRegionRestrictions: summary.browserRegionRestrictions,
    browserNavigationErrors: summary.browserNavigationErrors,
    browserEmptyBodies: summary.browserEmptyBodies,
    browserEmptyDomBodies: summary.browserEmptyDomBodies,
    browserResponsesWithHtmlButNoText: summary.browserResponsesWithHtmlButNoText,
    browserChallengeRequestFailures: summary.browserChallengeRequestFailures,
    challengeWaitSeconds: summary.challengeWaitSeconds,
    challengeResolvedDuringWait: summary.challengeResolvedDuringWait,
    mainDocumentResponsesWithCfMitigated: summary.mainDocumentResponsesWithCfMitigated,
    http403: summary.chatgptHttp403,
    http403Challenge: summary.chatgptHttp403Challenge,
    http200: summary.chatgptHttp200,
    http200Challenge: summary.chatgptHttp200Challenge,
    http200Unverified: summary.chatgptHttp200Unverified,
    connectionErrors: summary.chatgptConnectionErrors,
    restrictionSuspected: summary.chatgptRestrictionSuspected,
    apiApplicationResponse: summary.openaiApiApplicationResponse,
    apiExpectedAuthRejection: summary.openaiApiExpectedAuthRejection,
  }));
}
(async () => {
  if (process.argv[2] === 'prepare') prepare();
  else await run();
})().catch(e => { console.error('[chatgpt-test] FATAL:', e); process.exit(1); });

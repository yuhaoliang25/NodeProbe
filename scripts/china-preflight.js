#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

function fail(message) {
  console.error('[china-preflight] FAIL: ' + message);
  process.exitCode = 1;
}

function run(name, command, args) {
  console.log('[china-preflight] ' + name + '...');
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    fail(name + ': ' + result.error.message);
    return false;
  }
  if (result.status !== 0) {
    fail(name + ': exit ' + result.status);
    return false;
  }
  return true;
}

const scriptsDir = path.join(ROOT, 'scripts');
function collectJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}
const jsFiles = collectJs(scriptsDir).sort();

let ok = true;

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    fail('syntax error in ' + path.relative(ROOT, file));
    ok = false;
  }
}

if (!run('undefined-variable lint', 'npm', ['run', 'lint', '--silent'])) {
  ok = false;
}

const checks = [
  ['CHINA_MAX_NODES', process.env.CHINA_MAX_NODES, value => Number.isInteger(Number(value)) && Number(value) > 0],
  ['CHINA_PROBE_CONCURRENCY', process.env.CHINA_PROBE_CONCURRENCY, value => Number.isInteger(Number(value)) && Number(value) > 0],
  ['CHINA_B2_LIST_TIMEOUT_MS', process.env.CHINA_B2_LIST_TIMEOUT_MS, value => value === undefined || (Number.isInteger(Number(value)) && Number(value) > 0)],
  ['CHINA_B2_OBSERVATION_DOWNLOAD_TIMEOUT_MS', process.env.CHINA_B2_OBSERVATION_DOWNLOAD_TIMEOUT_MS, value => value === undefined || (Number.isInteger(Number(value)) && Number(value) > 0)],
  ['PAIR_OBSERVATION_RECOVERY_WINDOW_HOURS', process.env.PAIR_OBSERVATION_RECOVERY_WINDOW_HOURS, value => value === undefined || (Number.isFinite(Number(value)) && Number(value) >= 0)],
];

for (const [name, value, predicate] of checks) {
  if (value !== undefined && !predicate(value)) {
    fail(name + ' is invalid: ' + value);
    ok = false;
  }
}

if (process.env.CHINA_MAX_NODES !== undefined && Number(process.env.CHINA_MAX_NODES) > 50000) {
  console.warn('[china-preflight] WARN: CHINA_MAX_NODES is unusually high: ' + process.env.CHINA_MAX_NODES);
}

if (!process.env.CHINA_B2_BUCKET) {
  console.warn('[china-preflight] CHINA_B2_BUCKET not set; china-b2-sync.js will use its default.');
}
if (!process.env.CHINA_B2_PREFIX) {
  console.warn('[china-preflight] CHINA_B2_PREFIX not set; china-b2-sync.js will use its default.');
}

const autoModuleChecks = fs.existsSync(path.join(scriptsDir, 'preflight'))
  ? fs.readdirSync(path.join(scriptsDir, 'preflight'))
      .filter(file => file.endsWith('.js'))
      .sort()
      .map(file => path.join('scripts', 'preflight', file))
  : [];

const configuredModuleChecks = (process.env.CHINA_PREFLIGHT_MODULES || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const moduleChecks = [...autoModuleChecks, ...configuredModuleChecks];

for (const modulePath of moduleChecks) {
  const resolved = path.resolve(modulePath);
  if (!fs.existsSync(resolved)) {
    fail('preflight module does not exist: ' + modulePath);
    ok = false;
    continue;
  }
  if (!run('module preflight ' + modulePath, process.execPath, [resolved])) {
    ok = false;
  }
}

if (!ok) {
  console.error('[china-preflight] BLOCKED: cycle will not start.');
  process.exit(1);
}

console.log('[china-preflight] PASS: static checks and configured preflight modules passed; no probe/test has started.');

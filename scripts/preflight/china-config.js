#!/usr/bin/env node
'use strict';

function positiveInt(name, value) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(name + ' must be a positive integer; got ' + value);
  }
}

function nonNegativeNumber(name, value) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error(name + ' must be a non-negative number; got ' + value);
  }
}

positiveInt('CHINA_MAX_NODES', process.env.CHINA_MAX_NODES);
positiveInt('CHINA_PROBE_CONCURRENCY', process.env.CHINA_PROBE_CONCURRENCY);
positiveInt('B2_LIST_TIMEOUT_MS', process.env.CHINA_B2_LIST_TIMEOUT_MS);
positiveInt('B2_OBSERVATION_DOWNLOAD_TIMEOUT_MS', process.env.CHINA_B2_OBSERVATION_DOWNLOAD_TIMEOUT_MS);
nonNegativeNumber('PAIR_OBSERVATION_RECOVERY_WINDOW_HOURS', process.env.PAIR_OBSERVATION_RECOVERY_WINDOW_HOURS);

if (!process.env.CHINA_B2_BUCKET) throw new Error('CHINA_B2_BUCKET is empty');
if (!process.env.CHINA_B2_PREFIX) throw new Error('CHINA_B2_PREFIX is empty');

if (Number(process.env.CHINA_PROBE_CONCURRENCY) > Number(process.env.CHINA_MAX_NODES)) {
  throw new Error('CHINA_PROBE_CONCURRENCY cannot exceed CHINA_MAX_NODES');
}

console.log('[china-config-preflight] PASS');

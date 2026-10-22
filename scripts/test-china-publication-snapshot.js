#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeprobe-publication-snapshot-'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function freeze(dir, inputs, releaseId) {
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts/china-publication-snapshot.js'), 'freeze',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHINA_PUBLICATION_SNAPSHOT_DIR: dir,
      CHINA_RELEASE_ID: releaseId,
      CHINA_ASSET_FILE: inputs.asset,
      CHINA_PAIR_KNOWLEDGE_FILE: inputs.pairs,
      CHINA_STICKY_STATE_FILE: inputs.sticky,
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  const inputs = {
    asset: path.join(temp, 'live-assets.json'),
    pairs: path.join(temp, 'live-pairs.json'),
    sticky: path.join(temp, 'live-sticky.json'),
    observations: path.join(temp, 'current-observations.json'),
  };
  writeJson(inputs.asset, {
    version: 1,
    generatedAt: '2026-10-21T00:00:00.000Z',
    nodes: { old: { endpointId: 'old', state: 'TRUSTED', observedRuns: 8 } },
  });
  writeJson(inputs.pairs, { version: 1, pairs: {} });
  writeJson(inputs.sticky, { version: 1, endpointId: 'old', retiredEndpointIds: [] });
  writeJson(inputs.observations, { observations: [{ endpointId: 'new', success: true }] });

  const firstDir = path.join(temp, 'snapshot-a');
  const firstGeneration = freeze(firstDir, inputs, 'run-a');
  const firstSnapshot = fs.readFileSync(path.join(firstDir, 'china-node-assets.json'), 'utf8');

  // A different current observation batch must not participate in snapshot identity
  // or mutate the already-frozen inputs.
  writeJson(inputs.observations, { observations: [{ endpointId: 'old', success: false }] });
  const secondDir = path.join(temp, 'snapshot-b');
  const secondGeneration = freeze(secondDir, inputs, 'run-b');
  assert.strictEqual(secondGeneration, firstGeneration);
  assert.strictEqual(
    fs.readFileSync(path.join(secondDir, 'china-node-assets.json'), 'utf8'),
    firstSnapshot,
  );

  // Even if live persistent state changes later in the cycle, the existing
  // publication snapshot remains unchanged.
  writeJson(inputs.asset, {
    version: 1,
    generatedAt: '2026-10-22T00:00:00.000Z',
    nodes: {
      old: { endpointId: 'old', state: 'DEGRADED', observedRuns: 9 },
      new: { endpointId: 'new', state: 'NEW', observedRuns: 1 },
    },
  });
  assert.strictEqual(
    fs.readFileSync(path.join(firstDir, 'china-node-assets.json'), 'utf8'),
    firstSnapshot,
  );

  console.log('China publication snapshot regression checks passed: generation=' + firstGeneration);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

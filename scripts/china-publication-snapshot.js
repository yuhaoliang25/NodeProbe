#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INPUTS = [
  {
    key: 'assetState',
    env: 'CHINA_ASSET_FILE',
    fallback: 'data/china-node-assets.json',
    file: 'china-node-assets.json',
    empty: { version: 1, generatedAt: null, nodes: {} },
    validate(value) {
      return value && typeof value === 'object' && value.nodes &&
        typeof value.nodes === 'object' && !Array.isArray(value.nodes);
    },
  },
  {
    key: 'pairKnowledge',
    env: 'CHINA_PAIR_KNOWLEDGE_FILE',
    fallback: 'data/china-pair-knowledge.json',
    file: 'china-pair-knowledge.json',
    empty: { version: 1, pairs: {}, processedBatches: [] },
    validate(value) {
      return value && typeof value === 'object' && value.pairs &&
        typeof value.pairs === 'object' && !Array.isArray(value.pairs);
    },
  },
  {
    key: 'stickyState',
    env: 'CHINA_STICKY_STATE_FILE',
    fallback: 'data/china-sticky.json',
    file: 'china-sticky.json',
    empty: {
      version: 1,
      endpointId: null,
      selectedAt: null,
      switchedAt: null,
      switchReason: null,
      retiredEndpointIds: [],
    },
    validate(value) {
      return value && typeof value === 'object' && !Array.isArray(value);
    },
  },
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readState(input) {
  const source = process.env[input.env] || input.fallback;
  let value = input.empty;
  if (fs.existsSync(source)) {
    value = JSON.parse(fs.readFileSync(source, 'utf8'));
  }
  if (!input.validate(value)) {
    throw new Error('Invalid publication input state (' + input.key + '): ' + source);
  }
  return { source, value };
}

function freeze() {
  const dir = path.resolve(process.env.CHINA_PUBLICATION_SNAPSHOT_DIR ||
    ('data/china-publication-snapshots/' + (process.env.CHINA_RELEASE_ID || 'manual')));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // A snapshot is immutable for its release ID. Never silently replace it.
  fs.mkdirSync(dir);

  const files = [];
  for (const input of INPUTS) {
    const { source, value } = readState(input);
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const destination = path.join(dir, input.file);
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    files.push({
      key: input.key,
      source,
      file: input.file,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const generation = sha256(Buffer.from(files
    .map(file => file.key + ':' + file.sha256)
    .join('\n'))).slice(0, 24);
  const manifest = {
    version: 1,
    generation,
    releaseId: process.env.CHINA_RELEASE_ID || null,
    createdAt: new Date().toISOString(),
    semantics: 'pre-observation publication inputs; immutable for this release ID',
    files,
  };
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.error('[china] publication snapshot frozen: ' + dir + ' generation=' + generation);
  process.stdout.write(generation + '\n');
}

if (process.argv[2] !== 'freeze') {
  console.error('usage: node scripts/china-publication-snapshot.js freeze');
  process.exit(2);
}
try {
  freeze();
} catch (error) {
  console.error('[china] unable to freeze publication snapshot: ' + error.message);
  process.exit(1);
}

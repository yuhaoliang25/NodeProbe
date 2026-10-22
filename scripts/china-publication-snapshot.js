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

function generationFor(files) {
  return sha256(Buffer.from(files
    .map(file => file.key + ':' + file.sha256)
    .join('\n'))).slice(0, 24);
}

function emitGeneration(dir, manifest, reused) {
  const actualFiles = manifest.files.map(file => {
    const bytes = fs.readFileSync(path.join(dir, file.file));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error('Frozen publication snapshot failed integrity check: ' + file.file);
    }
    return file;
  });
  const generation = generationFor(actualFiles);
  if (generation !== manifest.generation) {
    throw new Error('Frozen publication snapshot generation does not match its manifest');
  }
  console.error('[china] publication snapshot ' + (reused ? 'reused' : 'frozen') +
    ': ' + dir + ' generation=' + generation);
  process.stdout.write(generation + '\n');
}

function freeze() {
  const dir = path.resolve(process.env.CHINA_PUBLICATION_SNAPSHOT_DIR ||
    ('data/china-publication-snapshots/' + (process.env.CHINA_RELEASE_ID || 'manual')));
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  // A failed publication can be retried with the same release ID. Reuse its
  // complete immutable snapshot rather than accidentally capturing newer state.
  if (fs.existsSync(dir)) {
    const manifestFile = path.join(dir, 'snapshot.json');
    if (!fs.existsSync(manifestFile)) {
      throw new Error('Snapshot directory exists but is incomplete: ' + dir);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.version !== 1 || !Array.isArray(manifest.files) ||
        manifest.files.length !== INPUTS.length) {
      throw new Error('Invalid existing publication snapshot manifest: ' + manifestFile);
    }
    emitGeneration(dir, manifest, true);
    return;
  }

  // Build in a temporary sibling directory so readers never see a partial
  // snapshot. Rename publishes the completed directory atomically.
  const tempDir = dir + '.tmp-' + process.pid;
  fs.mkdirSync(tempDir);
  try {
    const files = [];
    for (const input of INPUTS) {
      const { source, value } = readState(input);
      const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
      fs.writeFileSync(path.join(tempDir, input.file), bytes, { flag: 'wx' });
      files.push({
        key: input.key,
        source,
        file: input.file,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }

    const generation = generationFor(files);
    const manifest = {
      version: 1,
      generation,
      releaseId: process.env.CHINA_RELEASE_ID || null,
      createdAt: new Date().toISOString(),
      semantics: 'pre-observation publication inputs; immutable for this release ID',
      files,
    };
    fs.writeFileSync(path.join(tempDir, 'snapshot.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tempDir, dir);
    emitGeneration(dir, manifest, false);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
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

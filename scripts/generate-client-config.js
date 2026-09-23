#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const INPUT_DIR = path.resolve('subscriptions');
const OUTPUT = path.resolve('mihomo/client.yaml');

const POOLS = [{ file: 'direct.yaml', role: 'direct' }];
const TEST_URL = 'https://www.google.com/generate_204';

function loadPool(file) {
  const full = path.join(INPUT_DIR, file);
  if (!fs.existsSync(full)) return [];

  const doc = yaml.load(fs.readFileSync(full, 'utf8'));
  if (!doc || !Array.isArray(doc.proxies)) {
    throw new Error(`${file}: expected a YAML document with a proxies array`);
  }

  return doc.proxies
    .filter(p => p && typeof p === 'object' && p.name)
    .map(p => ({ ...p, name: String(p.name) }));
}

function uniqueProxies(items) {
  const seen = new Set();
  return items.filter(p => {
    if (seen.has(p.name)) {
      throw new Error(`duplicate proxy name in client pools: ${p.name}`);
    }
    seen.add(p.name);
    return true;
  });
}

const direct = loadPool('direct.yaml');

const directNames = direct.map(p => p.name);
const proxies = uniqueProxies([...direct]);
const config = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  ipv6: false,

  proxies,

  'proxy-groups': [
    {
      name: 'DIRECT-AUTO',
      type: 'url-test',
      proxies: directNames,
      url: TEST_URL,
      interval: 300,
      tolerance: 100,
      lazy: false,
      'expected-status': 204
    },
    {
      name: 'PROXY',
      type: 'select',
      proxies: ['DIRECT-AUTO', 'DIRECT']
    }
  ],

  rules: ['MATCH,PROXY']
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(
  OUTPUT,
  yaml.dump(config, {
    lineWidth: -1,
    noRefs: true,
    forceQuotes: true,
    quotingType: "'"
  }),
  'utf8'
);

console.log(
  `client.yaml: direct=${direct.length}`
);
console.log(`generated: ${OUTPUT}`);

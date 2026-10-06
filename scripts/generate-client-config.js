#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const INPUT = path.resolve(process.env.CHINA_ELITE_FILE || 'subscriptions/elite.yaml');
const OUTPUT = path.resolve('mihomo/client.yaml');

function loadElite() {
  if (!fs.existsSync(INPUT)) throw new Error('China elite subscription missing: ' + INPUT);
  const doc = yaml.load(fs.readFileSync(INPUT, 'utf8'));
  if (!doc || !Array.isArray(doc.proxies)) {
    throw new Error('elite.yaml: expected a YAML document with a proxies array');
  }
  return doc.proxies
    .filter(p => p && typeof p === 'object' && p.name)
    .map(p => ({ ...p, name: String(p.name) }));
}

function uniqueProxies(items) {
  const seen = new Set();
  return items.filter(p => {
    if (seen.has(p.name)) {
      throw new Error('duplicate proxy name in elite subscription: ' + p.name);
    }
    seen.add(p.name);
    return true;
  });
}

const elite = uniqueProxies(loadElite());
const selectable = elite
  .filter(p => !String(p.name).startsWith('PAIR-RELAY-'))
  .map(p => p.name);

const config = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  ipv6: false,

  proxies: elite,

  'proxy-groups': [
    {
      name: 'PROXY',
      type: 'select',
      proxies: [...selectable, 'DIRECT']
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

console.log('client.yaml: elite=' + elite.length + ' selectable=' + selectable.length);
console.log('generated: ' + OUTPUT);

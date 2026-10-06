#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const INPUT = path.resolve(process.env.CHINA_ELITE_FILE || 'subscriptions/elite.yaml');
const CHATGPT_INPUT = path.resolve(process.env.CHINA_CHATGPT_FILE || 'subscriptions/chatgpt.yaml');
const STICKY_INPUT = path.resolve(process.env.CHINA_STICKY_FILE || 'subscriptions/sticky.yaml');
const OUTPUT = path.resolve('mihomo/client.yaml');

function loadYamlProxies(file, label) {
  if (!fs.existsSync(file)) throw new Error(label + ' subscription missing: ' + file);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.proxies)) {
    throw new Error(label + ': expected a YAML document with a proxies array');
  }
  return doc.proxies
    .filter(p => p && typeof p === 'object' && p.name)
    .map(p => ({ ...p, name: String(p.name) }));
}

function uniqueProxies(items) {
  const seen = new Set();
  return items.filter(p => {
    if (seen.has(p.name)) {
      throw new Error('duplicate proxy name: ' + p.name);
    }
    seen.add(p.name);
    return true;
  });
}

const elite = uniqueProxies(loadYamlProxies(INPUT, 'elite.yaml'));
const chatgpt = uniqueProxies(loadYamlProxies(CHATGPT_INPUT, 'chatgpt.yaml'));
const sticky = uniqueProxies(loadYamlProxies(STICKY_INPUT, 'sticky.yaml'));

const eliteNames = new Set(elite.map(p => p.name));
for (const p of chatgpt) {
  if (!eliteNames.has(p.name)) {
    throw new Error('ChatGPT proxy is not present in elite.yaml: ' + p.name);
  }
}

const allProxies = uniqueProxies([...elite, ...sticky]);
const selectable = elite
  .filter(p => !String(p.name).startsWith('PAIR-RELAY-'))
  .map(p => p.name);

const chatgptGroup = chatgpt.length ? [{
  name: 'CHATGPT',
  type: 'select',
  proxies: chatgpt.map(p => p.name)
}] : [];

const stickyGroup = sticky.length ? [{
  name: 'STICKY',
  type: 'select',
  proxies: sticky.map(p => p.name)
}] : [];

const rules = [];
if (sticky.length) {
  rules.push(
    'DOMAIN-SUFFIX,x.com,STICKY',
    'DOMAIN-SUFFIX,twitter.com,STICKY',
    'DOMAIN-SUFFIX,t.co,STICKY',
    'DOMAIN-SUFFIX,threads.com,STICKY',
    'DOMAIN-SUFFIX,threads.net,STICKY'
  );
}
if (chatgpt.length) {
  rules.push(
    'DOMAIN-SUFFIX,chatgpt.com,CHATGPT',
    'DOMAIN-SUFFIX,chat.openai.com,CHATGPT',
    'DOMAIN-SUFFIX,auth.openai.com,CHATGPT',
    'DOMAIN-SUFFIX,oaistatic.com,CHATGPT',
    'DOMAIN-SUFFIX,oaiusercontent.com,CHATGPT'
  );
}
rules.push('MATCH,PROXY');

const config = {
  'mixed-port': 7890,
  'allow-lan': false,
  mode: 'rule',
  'log-level': 'warning',
  ipv6: false,

  proxies: allProxies,

  'proxy-groups': [
    {
      name: 'PROXY',
      type: 'select',
      proxies: [...selectable, 'DIRECT']
    },
    ...chatgptGroup,
    ...stickyGroup
  ],
  rules
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
  'client.yaml: elite=' + elite.length +
  ' selectable=' + selectable.length +
  ' chatgpt=' + chatgpt.length +
  ' sticky=' + sticky.length
);
console.log('generated: ' + OUTPUT);

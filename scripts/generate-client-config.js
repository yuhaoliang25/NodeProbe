#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const INPUT = path.resolve(process.env.CHINA_ELITE_FILE || 'subscriptions/elite.yaml');
const CHATGPT_INPUT = path.resolve(process.env.CHINA_CHATGPT_FILE || 'subscriptions/chatgpt.yaml');
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

function loadChatGPT() {
  if (!fs.existsSync(CHATGPT_INPUT)) throw new Error('China ChatGPT subscription missing: ' + CHATGPT_INPUT);
  const doc = yaml.load(fs.readFileSync(CHATGPT_INPUT, 'utf8'));
  if (!doc || !Array.isArray(doc.proxies)) throw new Error('chatgpt.yaml: expected a YAML document with a proxies array');
  return doc.proxies.filter(p => p && typeof p === 'object' && p.name).map(p => ({ ...p, name: String(p.name) }));
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
const chatgpt = uniqueProxies(loadChatGPT());
const eliteNames = new Set(elite.map(p => p.name));
for (const p of chatgpt) if (!eliteNames.has(p.name)) throw new Error('ChatGPT proxy is not present in elite.yaml: ' + p.name);
const selectable = elite
  .filter(p => !String(p.name).startsWith('PAIR-RELAY-'))
  .map(p => p.name);

const chatgptGroup = chatgpt.length ? [{
  name: 'CHATGPT',
  type: 'select',
  proxies: chatgpt.map(p => p.name)
}] : [];

const rules = chatgpt.length ? [
  'DOMAIN-SUFFIX,chatgpt.com,CHATGPT',
  'DOMAIN-SUFFIX,chat.openai.com,CHATGPT',
  'DOMAIN-SUFFIX,auth.openai.com,CHATGPT',
  'DOMAIN-SUFFIX,oaistatic.com,CHATGPT',
  'DOMAIN-SUFFIX,oaiusercontent.com,CHATGPT',
  'MATCH,PROXY'
] : ['MATCH,PROXY'];

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
    },
    ...chatgptGroup
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

console.log('client.yaml: elite=' + elite.length + ' selectable=' + selectable.length + ' chatgpt=' + chatgpt.length);
console.log('generated: ' + OUTPUT);

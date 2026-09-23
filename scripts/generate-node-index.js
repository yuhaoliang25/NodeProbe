#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function shard(name){return crypto.createHash('sha256').update(String(name||'').trim().toLowerCase()).digest('hex').slice(0,2)}
function safeProxy(p){if(!p)return null;return {name:p.name||null,type:p.type||null,server:p.server||null,port:p.port||null,network:p.network||null,tls:Boolean(p.tls),sni:p.sni||null,flow:p.flow||null}}
const pool=readJson('data/node-pool.json',{nodes:[]});
const nodes=pool.nodes||[];
const out='reports/node-index';
fs.mkdirSync(out,{recursive:true});
for(const f of fs.readdirSync(out))if(f.endsWith('.json'))fs.unlinkSync(path.join(out,f));
const generatedAt=new Date().toISOString(), groups=new Map();
for(const n of nodes){
  if(!n.fingerprint)continue;
  const r=rep.nodes?.[n.fingerprint]||{}, h=n.lastHealth||{};
  const item={
    fingerprint:n.fingerprint,
    node:safeProxy(n.proxy),
    status:n.status||null,
    everStable:Boolean(n.everStable),
    firstObservedAt:n.firstObservedAt||null,
    firstObservedSource:n.firstObservedSource||null,
    lastObservedAt:n.lastObservedAt||null,
    lastHealthyAt:n.lastSeen||null,
    lifetimeDays:n.lifetimeDays??null,
    observedRuns:n.observedRuns??0,
    healthyRuns:n.healthyRuns??0,
    failedRuns:n.failedRuns??0,
    currentSources:n.currentSources||[],
    knownSources:n.knownSources||[],
    sourceObservations:n.sourceObservations||[],
    health:{rounds:h.rounds??null,successes:h.successes??null,successRate:h.successRate??null,avgLatency:h.avgLatency??null,p95Latency:h.p95Latency??null},
    reputation:{status:r.status||null,longTermSuccessRate:r.longTermSuccessRate??null,totalTests:r.totalTests??0,totalFailures:r.totalFailures??0,recentFailures:r.recentFailures??0,recentSuccesses:r.recentSuccesses??0,lastSeen:r.lastSeen||null}
  };
  const s=shard(n.name||n.fingerprint); if(!groups.has(s))groups.set(s,{});
  groups.get(s)[n.fingerprint]=item;
}
const manifest={version:1,generatedAt,nodeCount:nodes.length,lookup:'SHA-256(lowercase node name), first two hex characters = shard',shards:{}};
for(const [s,items] of groups){fs.writeFileSync(path.join(out,s+'.json'),JSON.stringify({version:1,generatedAt,nodes:items},null,2));manifest.shards[s]={file:'node-index/'+s+'.json',count:Object.keys(items).length}}
fs.writeFileSync('reports/node-index.json',JSON.stringify(manifest,null,2));
console.log('diagnostic index:',nodes.length,'nodes across',groups.size,'shards');

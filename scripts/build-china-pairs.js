#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const yaml=require('js-yaml');
const { timeDecayedEvidence } = require('./time-decay');

const C={
  stateFile:process.env.CHINA_PAIR_KNOWLEDGE_FILE||'data/china-pair-knowledge.json',
  outputFile:process.env.CHINA_PAIR_POOL_FILE||'subscriptions/pairs.yaml',
  maxAgeMs:Number(process.env.CHINA_PAIR_MAX_AGE_MS||72*60*60*1000),
  minSuccessRate:Number(process.env.CHINA_PAIR_MIN_SUCCESS_RATE||0.8),
  maxPairs:Number(process.env.CHINA_PAIR_MAX_OUTPUT||20),
  decayHalfLifeMs:Number(process.env.CHINA_PAIR_DECAY_HALF_LIFE_MS||72*60*60*1000),
};
function dump(proxies){return yaml.dump({proxies},{lineWidth:-1,noRefs:true,forceQuotes:true,quotingType:"'"})}
function load(){
  if(!fs.existsSync(C.stateFile))throw new Error('China pair knowledge state missing: '+C.stateFile);
  const state=JSON.parse(fs.readFileSync(C.stateFile,'utf8'));
  if(!state||typeof state!=='object'||!state.pairs||typeof state.pairs!=='object'){
    throw new Error('China pair knowledge state is invalid: '+C.stateFile);
  }
  return state;
}
const state=load();const now=Date.now();const cutoff=now-C.maxAgeMs;const candidates=[];
for(const [pairId,p] of Object.entries(state.pairs||{})){
  const last=Date.parse(p.lastObservedAt||'');
  if(!Number.isFinite(last)||last<cutoff||!p.relay||!p.landing)continue;
  const obs=Array.isArray(p.observations)?p.observations:[];
  const rate=timeDecayedEvidence(obs,now,C.decayHalfLifeMs,x=>x.success===true).rate;
  if(!obs.some(x=>x.confirmed))continue;
  if(rate<C.minSuccessRate)continue;
  const recent=obs.filter(x=>x.success===true);
  const median=values=>{const xs=values.filter(Number.isFinite).sort((a,b)=>a-b);return xs.length?xs[Math.floor(xs.length/2)]:null};
  const latencyMs=median(recent.slice(-10).map(x=>x.screenLatencyMs));
  const speedMbps=median(recent.slice(-10).map(x=>x.speedMbps));
  const confirmedLatencyMs=median(recent.slice(-10).map(x=>x.confirmationLatencyMs));
  // Rank paths on their own measured performance: stable confirmation rate,
  // absolute latency, then absolute throughput. Relay-only baseline improvement
  // is diagnostic only and never an admission/ranking criterion.
  const latencyForRank=confirmedLatencyMs??latencyMs??Infinity;
  const throughputForRank=speedMbps??0;
  const relayName='PAIR-RELAY-'+p.relayEndpointId;
  const pairName='PAIR-'+pairId;
  const relay={...p.relay,name:relayName};
  const landing={...p.landing,name:pairName,'dialer-proxy':relayName};
  candidates.push({pairId,lastObservedAt:p.lastObservedAt,rate,latencyMs,speedMbps,confirmedLatencyMs,latencyForRank,throughputForRank,relayEndpointId:p.relayEndpointId,landingEndpointId:p.landingEndpointId,relay,pair:landing});
}
candidates.sort((a,b)=>a.latencyForRank-b.latencyForRank||a.latencyMs-b.latencyMs||b.throughputForRank-a.throughputForRank||b.rate-a.rate||Date.parse(b.lastObservedAt)-Date.parse(a.lastObservedAt));
const selected=candidates.slice(0,C.maxPairs);
const proxies=[];const seen=new Set();
for(const x of selected)for(const p of [x.relay,x.pair]){if(!seen.has(p.name)){seen.add(p.name);proxies.push(p)}}
fs.mkdirSync(path.dirname(C.outputFile),{recursive:true});
fs.writeFileSync(C.outputFile,dump(proxies));
fs.writeFileSync(path.join(path.dirname(C.outputFile),'china-pair-pool.json'),JSON.stringify({
  generatedAt:new Date().toISOString(),
  decayHalfLifeMs:C.decayHalfLifeMs,
  count:selected.length,
  definitions:{pair:'China → relay → landing → target; experimental evidence only'},
  ranking:'time-decayed path success rate, then absolute confirmation latency, then measured download Mbps; no relay-relative improvement score',
  pairs:selected.map(x=>({pairId:x.pairId,lastObservedAt:x.lastObservedAt,recentSuccessRate:x.rate,latencyMs:x.latencyMs,speedMbps:x.speedMbps,confirmedLatencyMs:x.confirmedLatencyMs,relayEndpointId:x.relayEndpointId||null}))
},null,2)+'\n');
console.log(JSON.stringify({knownPairs:Object.keys(state.pairs||{}).length,selected:selected.length,proxies:proxies.length},null,2));

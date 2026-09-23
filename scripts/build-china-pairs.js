#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const yaml=require('js-yaml');

const C={
  stateFile:process.env.CHINA_PAIR_KNOWLEDGE_FILE||'data/china-pair-knowledge.json',
  outputFile:process.env.CHINA_PAIR_POOL_FILE||'subscriptions/pairs.yaml',
  maxAgeMs:Number(process.env.CHINA_PAIR_MAX_AGE_MS||72*60*60*1000),
  minSuccessRate:Number(process.env.CHINA_PAIR_MIN_SUCCESS_RATE||0.8),
  maxPairs:Number(process.env.CHINA_PAIR_MAX_OUTPUT||20),
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
const state=load();const cutoff=Date.now()-C.maxAgeMs;const candidates=[];
for(const [pairId,p] of Object.entries(state.pairs||{})){
  const last=Date.parse(p.lastObservedAt||'');
  if(!Number.isFinite(last)||last<cutoff||!p.relay||!p.landing)continue;
  const obs=Array.isArray(p.observations)?p.observations.slice(-10):[];
  const rate=obs.length?obs.filter(x=>x.success&&x.improved).length/obs.length:0;
  if(!obs.some(x=>x.confirmed))continue;
  if(rate<C.minSuccessRate)continue;
  const relayName='PAIR-RELAY-'+p.relayEndpointId;
  const pairName='PAIR-'+pairId;
  const relay={...p.relay,name:relayName};
  const landing={...p.landing,name:pairName,'dialer-proxy':relayName};
  candidates.push({pairId,lastObservedAt:p.lastObservedAt,rate,relayEndpointId:p.relayEndpointId,landingEndpointId:p.landingEndpointId,relay,pair:landing});
}
candidates.sort((a,b)=>b.rate-a.rate||Date.parse(b.lastObservedAt)-Date.parse(a.lastObservedAt));
const selected=candidates.slice(0,C.maxPairs);
const proxies=[];const seen=new Set();
for(const x of selected)for(const p of [x.relay,x.pair]){if(!seen.has(p.name)){seen.add(p.name);proxies.push(p)}}
fs.mkdirSync(path.dirname(C.outputFile),{recursive:true});
fs.writeFileSync(C.outputFile,dump(proxies));
fs.writeFileSync(path.join(path.dirname(C.outputFile),'china-pair-pool.json'),JSON.stringify({
  generatedAt:new Date().toISOString(),
  count:selected.length,
  definitions:{pair:'China → relay → landing → target; experimental evidence only'},
  pairs:selected.map(x=>({pairId:x.pairId,lastObservedAt:x.lastObservedAt,recentSuccessRate:x.rate,relayEndpointId:x.relayEndpointId||null}))
},null,2)+'\n');
console.log(JSON.stringify({knownPairs:Object.keys(state.pairs||{}).length,selected:selected.length,proxies:proxies.length},null,2));

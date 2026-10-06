#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const { timeDecayedEvidence } = require('./time-decay');
const CONFIG={
    assetFile:process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',
  outputFile:process.env.CHINA_RELAY_CANDIDATE_FILE||'data/china-relay-pair-candidates.json',
  relayLimit:Number(process.env.CHINA_RELAY_TOP_K||8),
  landingLimit:Number(process.env.CHINA_RELAY_LANDING_LIMIT||30),
  pairLimit:Number(process.env.CHINA_RELAY_PAIR_LIMIT||240),
};

function proxyFor(node){
  return node?.proxy&&node.proxy.server&&node.proxy.port&&node.proxy.type?node.proxy:null;
}
function loadAssets(){
  if(!fs.existsSync(CONFIG.assetFile))throw new Error('China asset state missing: '+CONFIG.assetFile);
  const state=JSON.parse(fs.readFileSync(CONFIG.assetFile,'utf8'));
  if(!state||typeof state!=='object'||!state.nodes||typeof state.nodes!=='object'){
    throw new Error('China asset state is invalid: '+CONFIG.assetFile);
  }
  return state.nodes;
}
function latest(node){
  const xs=Array.isArray(node?.observations)?node.observations:[];
  return xs.length?xs[xs.length-1]:null;
}
function reachRate(node,atMs){
  const xs=Array.isArray(node?.observations)?node.observations:[];
  return timeDecayedEvidence(xs,atMs,CONFIG.decayHalfLifeMs,x=>x.reachabilitySuccess===true).rate;
}
function relayScore(node,atMs){
  const x=latest(node)||{};
  const rate=reachRate(node,atMs);
  const latency=Number.isFinite(x.reachabilityLatencyMs)?x.reachabilityLatencyMs:3000;
  return rate*1000 + Math.min(500,Math.max(0,500-latency/2)) + Math.min(300,Number(node.observedRuns||0)*20);
}

const assets=loadAssets();
const now=Date.now();
const relayCandidates=[];
for(const [id,node] of Object.entries(assets)){
  const p=node?.proxy;
  const x=latest(node);
  if(!p||!x)continue;
  // Relay selection is an experimental production-adjacent role, so nodes
  // already classified as unrecoverable must not re-enter it from one lucky
  // reachability observation. DEGRADED remains eligible because reachability
  // can still make it useful as a relay even when its exit is weak.
  if(node.state==='UNTRUSTED'||node.state==='FORGOTTEN')continue;
  // A relay must first be reachable from China, but its exit must be weak.
  if(x.reachabilitySuccess!==true)continue;
  if(x.exitSuccess!==false)continue;
  relayCandidates.push({
    endpointId:id,
    proxy:p,
    score:relayScore(node,now),
    reason:'reachable-but-exit-weak',
    lastExitSuccess:x.exitSuccess===true,
    lastProbeSuccess:x.success===true,
    recentReachabilityRate:reachRate(node,now),
    lastReachabilityLatencyMs:x.reachabilityLatencyMs??null,
    observedRuns:Number(node.observedRuns||0),
  });
}
relayCandidates.sort((a,b)=>b.score-a.score||a.endpointId.localeCompare(b.endpointId));
const relays=relayCandidates.slice(0,CONFIG.relayLimit);

const landings=[];
for(const [id,node] of Object.entries(assets)){
  const p=proxyFor(node);
  const x=latest(node);
  if(!p||!x)continue;
  if(id===undefined||id==='')continue;
  if(node.state==='UNTRUSTED'||node.state==='FORGOTTEN')continue;
  // Landing candidates are China-owned assets with a recent successful
  // exit observation. No Global Best membership or score is consulted.
  if(x.exitSuccess!==true)continue;
  landings.push({
    endpointId:id,
    proxy:p,
    state:node.state,
    observedRuns:Number(node.observedRuns||0),
    recentSuccessRate:node.observations?.length
      ? node.observations.slice(-10).filter(o=>o.success).length/Math.min(10,node.observations.length)
      : 0,
  });
}
landings.sort((a,b)=>{
  const stateRank={TRUSTED:3,PROBATION:2,DEGRADED:1,NEW:0};
  return (stateRank[b.state]||0)-(stateRank[a.state]||0)
    || b.recentSuccessRate-a.recentSuccessRate
    || b.observedRuns-a.observedRuns
    || a.endpointId.localeCompare(b.endpointId);
});
const selectedLandings=landings.slice(0,CONFIG.landingLimit);

const pairs=[];
for(const relay of relays){
  for(const landing of selectedLandings){
    if(relay.endpointId===landing.endpointId)continue;
    pairs.push({
      pairId:crypto.createHash('sha256').update(relay.endpointId+'|'+landing.endpointId).digest('hex').slice(0,16),
      relayEndpointId:relay.endpointId,
      landingEndpointId:landing.endpointId,
      relay:relay.proxy,
      landing:landing.proxy,
      relayScore:relay.score,
    });
    if(pairs.length>=CONFIG.pairLimit)break;
  }
  if(pairs.length>=CONFIG.pairLimit)break;
}

const out={
  version:1,
  generatedAt:new Date().toISOString(),
  strategy:{
    relay:'top-K China assets whose latest reachability test is good and exit test is weak',
    landing:'China-owned assets with a recent successful exit observation, excluding China Trusted relay/exit overlap',
    maxRelayCandidates:CONFIG.relayLimit,
    maxLandingCandidates:CONFIG.landingLimit,
    maxPairs:CONFIG.pairLimit,
    decayHalfLifeMs:CONFIG.decayHalfLifeMs,
    noMultiHop:true,
  },
  relayCandidates:relays.map(({proxy,...x})=>x),
  landingCandidates:selectedLandings.map(({proxy,...x})=>x),
  pairs,
};
fs.mkdirSync(path.dirname(CONFIG.outputFile),{recursive:true});
fs.writeFileSync(CONFIG.outputFile,JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({
  chinaAssets:Object.keys(assets).length,
  relayCandidates:relays.length,
  landingCandidates:selectedLandings.length,
  pairs:pairs.length,
  output:CONFIG.outputFile,
},null,2));

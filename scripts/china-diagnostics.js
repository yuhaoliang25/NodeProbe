#!/usr/bin/env node
'use strict';

const fs=require('fs');
const yaml=require('js-yaml');

function readJson(file,fallback=null){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}
}
function readYamlProxies(file){
  try{
    const d=yaml.load(fs.readFileSync(file,'utf8'));
    return Array.isArray(d?.proxies)?d.proxies.filter(p=>p&&p.name):[];
  }catch{return [];}
}
function countStates(nodes){
  return Object.values(nodes||{}).reduce((m,n)=>{
    const s=String(n?.state||'UNKNOWN');
    m[s]=(m[s]||0)+1;
    return m;
  },{});
}
function probeSummary(p){
  if(!p)return null;
  const obs=Array.isArray(p.observations)?p.observations:[];
  return {
    candidates:obs.length,
    reachable:obs.filter(x=>x.reachabilitySuccess===true).length,
    exitSuccess:obs.filter(x=>x.exitSuccess===true).length,
    stabilityEligible:obs.filter(x=>x.stabilityEligible===true).length,
    chatgptEligible:obs.filter(x=>x.chatgptEligible===true).length,
    success:obs.filter(x=>x.success===true).length,
    failures:obs.filter(x=>x.success!==true).length,
    attempts:Array.isArray(p.attempts)?p.attempts.length:0,
    deepPass:obs.filter(x=>Array.isArray(x.successfulStages) && x.successfulStages.some(s=>s.startsWith('deep-round-'))).length
  };
}

const assets=readJson(process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',{nodes:{}});
const candidates=readJson(process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json',{candidates:[]});
const probe=readJson(process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json',null);
const sticky=readJson(process.env.CHINA_STICKY_STATE_FILE||'data/china-sticky.json',{});
const eliteMeta=readJson('subscriptions/china-elite.json',{});
const pools=readJson('subscriptions/china-pools.json',{});
const pairPool=readJson('subscriptions/china-pair-pool.json',{});
const diagnostics={
  version:1,
  generatedAt:new Date().toISOString(),
  releaseId:process.env.CHINA_RELEASE_ID||null,
  environment:process.env.CHINA_PROBE_ENV||null,
  assets:{
    total:Object.keys(assets.nodes||{}).length,
    states:countStates(assets.nodes),
    trusted:Object.values(assets.nodes||{}).filter(n=>n?.state==='TRUSTED'&&n?.proxy).length
  },
  candidates:{
    total:Array.isArray(candidates.candidates)?candidates.candidates.length:0,
    categories:(candidates.candidates||[]).reduce((m,x)=>{const k=x.category||'unknown';m[k]=(m[k]||0)+1;return m;},{})
  },
  probe:probeSummary(probe),
  subscriptions:{
    exit:readYamlProxies('subscriptions/exit.yaml').length,
    elite:readYamlProxies('subscriptions/elite.yaml').length,
    chatgpt:readYamlProxies('subscriptions/chatgpt.yaml').length,
    sticky:readYamlProxies('subscriptions/sticky.yaml').length,
    pairs:readYamlProxies('subscriptions/pairs.yaml').length
  },
  selection:{
    stickyEligible:Number(sticky.candidateCount||0),
    stickySelected:sticky.endpointId||null,
    stickyReason:sticky.switchReason||null,
    stickyRetiredLegacyCount:Array.isArray(sticky.retiredEndpointIds)?sticky.retiredEndpointIds.length:0,
    eliteEligible:Number(eliteMeta.counts?.eligibleExits||0),
    eliteSelected:Number(eliteMeta.counts?.selectedPaths||0),
    chatgptEligible:Number(eliteMeta.counts?.chatgptEligibleExits||0),
    chatgptSelected:Number(eliteMeta.counts?.chatgptSelectedPaths||0),
    exitPool:Number(pools.counts?.exit||0),
    pairPool:Number(pairPool.counts?.pairs||0)
  }
};
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/china-diagnostics.json',JSON.stringify(diagnostics,null,2)+'\n');
console.log(JSON.stringify(diagnostics,null,2));

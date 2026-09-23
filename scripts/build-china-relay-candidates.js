#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const yaml=require('js-yaml');

const CONFIG={
  stableFile:process.env.CHINA_STABLE_FILE||'subscriptions/stable.yaml',
  bestFile:process.env.CHINA_BEST_FILE||'subscriptions/best.yaml',
  assetFile:process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',
  outputFile:process.env.CHINA_RELAY_CANDIDATE_FILE||'data/china-relay-pair-candidates.json',
  relayLimit:Number(process.env.CHINA_RELAY_TOP_K||8),
  landingLimit:Number(process.env.CHINA_RELAY_LANDING_LIMIT||30),
  pairLimit:Number(process.env.CHINA_RELAY_PAIR_LIMIT||240),
};

function endpointId(p){
  if(p['endpoint-id'])return p['endpoint-id'];
  const t=String(p.type||'').toLowerCase();
  const auth=t==='shadowsocks'?[p.cipher||'',p.password||'']:t==='vmess'||t==='vless'?[p.uuid||'']:[p.password||''];
  const w=p['ws-opts']||{},g=p['grpc-opts']||{},r=p['reality-opts']||{};
  return crypto.createHash('sha256').update(JSON.stringify([
    t,String(p.server).toLowerCase(),Number(p.port),auth,p.network||'tcp',
    {wsPath:w.path||'',wsHost:w.headers?.Host||'',grpcService:g['grpc-service-name']||''},
    p.tls?'tls':'plain',p.sni||'',p.flow||'',r['public-key']||'',r['short-id']||''
  ])).digest('hex').slice(0,16);
}

function loadYaml(file){
  if(!fs.existsSync(file))return [];
  const d=yaml.load(fs.readFileSync(file,'utf8'));
  return Array.isArray(d?.proxies)?d.proxies.filter(p=>p&&p.name&&p.server&&p.port&&p.type):[];
}
function loadAssets(){
  try{return JSON.parse(fs.readFileSync(CONFIG.assetFile,'utf8')).nodes||{}}
  catch{return {}}
}
function latest(node){
  const xs=Array.isArray(node?.observations)?node.observations:[];
  return xs.length?xs[xs.length-1]:null;
}
function reachRate(node){
  const xs=(Array.isArray(node?.observations)?node.observations:[]).slice(-10);
  const usable=xs.filter(x=>x.reachabilitySuccess!=null);
  return usable.length?usable.filter(x=>x.reachabilitySuccess).length/usable.length:0;
}
function relayScore(node){
  const x=latest(node)||{};
  const rate=reachRate(node);
  const latency=Number.isFinite(x.reachabilityLatencyMs)?x.reachabilityLatencyMs:3000;
  return rate*1000 + Math.min(500,Math.max(0,500-latency/2)) + Math.min(300,Number(node.observedRuns||0)*20);
}

const stable=loadYaml(CONFIG.stableFile);
const best=loadYaml(CONFIG.bestFile);
const assets=loadAssets();
const stableMap=new Map(stable.map(p=>[endpointId(p),p]));
const bestMap=new Map(best.map(p=>[endpointId(p),p]));
const directTrusted=new Set(Object.entries(assets).filter(([,n])=>n?.state==='TRUSTED').map(([id])=>id));

const relayCandidates=[];
for(const [id,node] of Object.entries(assets)){
  const p=stableMap.get(id);
  const x=latest(node);
  if(!p||!x)continue;
  // A relay must first be reachable from China, but its direct exit must be weak.
  if(x.reachabilitySuccess!==true)continue;
  if(x.success===true)continue;
  relayCandidates.push({
    endpointId:id,
    proxy:p,
    score:relayScore(node),
    reason:'reachable-but-direct-weak',
    recentReachabilityRate:reachRate(node),
    lastReachabilityLatencyMs:x.reachabilityLatencyMs??null,
    observedRuns:Number(node.observedRuns||0),
  });
}
relayCandidates.sort((a,b)=>b.score-a.score||a.endpointId.localeCompare(b.endpointId));
const relays=relayCandidates.slice(0,CONFIG.relayLimit);

const landings=[];
for(const [id,p] of bestMap){
  if(id===undefined||directTrusted.has(id))continue;
  landings.push({endpointId:id,proxy:p});
}
landings.sort((a,b)=>a.endpointId.localeCompare(b.endpointId));
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
    relay:'top-K reachable Stable nodes whose latest direct test is weak',
    landing:'Best nodes excluding China Trusted/direct-capable nodes',
    maxRelayCandidates:CONFIG.relayLimit,
    maxLandingCandidates:CONFIG.landingLimit,
    maxPairs:CONFIG.pairLimit,
    noMultiHop:true,
  },
  relayCandidates:relays.map(({proxy,...x})=>x),
  landingCandidates:selectedLandings.map(({proxy,...x})=>x),
  pairs,
};
fs.mkdirSync(path.dirname(CONFIG.outputFile),{recursive:true});
fs.writeFileSync(CONFIG.outputFile,JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({
  stable:stable.length,
  best:best.length,
  relayCandidates:relays.length,
  landingCandidates:selectedLandings.length,
  pairs:pairs.length,
  output:CONFIG.outputFile,
},null,2));

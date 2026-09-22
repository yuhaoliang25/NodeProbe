#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const yaml=require('js-yaml');

const STABLE_FILE=process.env.CHINA_STABLE_FILE||'subscriptions/stable.yaml';
const BEST_FILE=process.env.CHINA_BEST_FILE||'subscriptions/best.yaml';
const ASSET_FILE=process.env.CHINA_ASSET_FILE||'data/china-node-assets.json';
const OUTPUT_DIR=path.resolve(process.env.CHINA_POOL_DIR||'subscriptions');

function loadYaml(file){
  const d=yaml.load(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(d?.proxies))throw new Error(file+': missing proxies');
  return d.proxies;
}
function loadAssets(){
  try{return JSON.parse(fs.readFileSync(ASSET_FILE,'utf8')).nodes||{}}
  catch{return {}}
}
function id(p){
  if(p['endpoint-id'])return p['endpoint-id'];
  const crypto=require('crypto');
  const t=String(p.type||'').toLowerCase(), r=p['reality-opts']||{}, w=p['ws-opts']||{}, g=p['grpc-opts']||{};
  const auth=t==='shadowsocks'?[p.cipher||'',p.password||'']:t==='vmess'||t==='vless'?[p.uuid||'']:[p.password||''];
  return crypto.createHash('sha256').update(JSON.stringify([t,String(p.server).toLowerCase(),Number(p.port),auth,p.network||'tcp',{wsPath:w.path||'',wsHost:w.headers?.Host||'',grpcService:g['grpc-service-name']||''},p.tls?'tls':'plain',p.sni||'',p.flow||'',r['public-key']||'',r['short-id']||''])).digest('hex').slice(0,16);
}
function dump(proxies){return yaml.dump({proxies},{lineWidth:-1,noRefs:true,forceQuotes:true,quotingType:"'"})}

const stable=loadYaml(STABLE_FILE);
const best=loadYaml(BEST_FILE);
const assets=loadAssets();
const stableMap=new Map(stable.map(p=>[id(p),p]));
const bestMap=new Map(best.map(p=>[id(p),p]));

const trusted=new Set(Object.entries(assets)
  .filter(([,n])=>n&&n.state==='TRUSTED')
  .map(([k])=>k));

const relay=[],landing=[],direct=[];
for(const [endpointId,node] of Object.entries(assets)){
  if(!trusted.has(endpointId))continue;
  const p=stableMap.get(endpointId);
  if(!p)continue;
  if(bestMap.has(endpointId)){
    direct.push(bestMap.get(endpointId));
  }else{
    relay.push(p);
  }
}
for(const [endpointId,p] of bestMap){
  if(!trusted.has(endpointId))landing.push(p);
  else if(!direct.some(x=>id(x)===endpointId))direct.push(p);
}

const unique=xs=>{const m=new Map();for(const p of xs)m.set(id(p),p);return [...m.values()]};
const pools={direct:unique(direct),relay:unique(relay),landing:unique(landing)};
fs.mkdirSync(OUTPUT_DIR,{recursive:true});
for(const [name,p] of Object.entries(pools))fs.writeFileSync(path.join(OUTPUT_DIR,name+'.yaml'),dump(p));
fs.writeFileSync(path.join(OUTPUT_DIR,'china-pools.json'),JSON.stringify({
  generatedAt:new Date().toISOString(),
  counts:Object.fromEntries(Object.entries(pools).map(([k,v])=>[k,v.length])),
  definitions:{
    direct:'Best ∩ China Trusted',
    relay:'Stable ∩ China Trusted - Best',
    landing:'Best - China Trusted'
  }
},null,2)+'\n');

console.log(JSON.stringify({
  stable:stable.length,
  best:best.length,
  trusted:[...trusted].length,
  direct:pools.direct.length,
  relay:pools.relay.length,
  landing:pools.landing.length
},null,2));

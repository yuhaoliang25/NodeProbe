#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const yaml=require('js-yaml');

const ASSET_FILE=process.env.CHINA_ASSET_FILE||'data/china-node-assets.json';
const OUTPUT_DIR=path.resolve(process.env.CHINA_POOL_DIR||'subscriptions');

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

const assets=loadAssets();

const trusted=new Set(Object.entries(assets)
  .filter(([,n])=>n&&n.state==='TRUSTED'&&n.proxy)
  .map(([k])=>k));

const direct=[];
for(const [endpointId,node] of Object.entries(assets)){
  if(node?.state!=='TRUSTED'||!node.proxy)continue;
  direct.push(node.proxy);
}
const unique=xs=>{const m=new Map();for(const p of xs)m.set(id(p),p);return [...m.values()]};
const pools={direct:unique(direct)};
fs.mkdirSync(OUTPUT_DIR,{recursive:true});
for(const obsolete of ['relay.yaml','landing.yaml'])fs.rmSync(path.join(OUTPUT_DIR,obsolete),{force:true});
for(const [name,p] of Object.entries(pools))fs.writeFileSync(path.join(OUTPUT_DIR,name+'.yaml'),dump(p));
fs.writeFileSync(path.join(OUTPUT_DIR,'china-pools.json'),JSON.stringify({
  generatedAt:new Date().toISOString(),
  counts:{direct:pools.direct.length},
  definitions:{
    direct:'China Trusted assets',
    relay:'experimental only; not part of the production China pool',
    landing:'experimental only; not part of the production China pool'
  }
},null,2)+'\n');
console.log(JSON.stringify({
  trusted:[...trusted].length,
  direct:pools.direct.length,
  relay:0,
  landing:0
},null,2));

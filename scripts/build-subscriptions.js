#!/usr/bin/env node
'use strict';
const fs=require('fs'),yaml=require('js-yaml'),crypto=require('crypto');
const raw=JSON.parse(fs.readFileSync('data/raw-sources.json','utf8'));
const proxies=[],seen=new Set(),usedNames=new Set(),sourcesById=new Map();
function valid(p){
  if(!p||typeof p!=='object'||!p.name||!p.server||!p.port||!p.type)return false;
  const port=Number(p.port); if(!Number.isInteger(port)||port<1||port>65535)return false;
  const t=String(p.type).toLowerCase();
  if(['vless','vmess'].includes(t)&&(!p.uuid||!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(String(p.uuid))))return false;
  if(t==='shadowsocks'&&!p.cipher)return false;
  if(t==='trojan'&&!p.password)return false;
  if(p['reality-opts']){
    const o=p['reality-opts'];
    if(!['vless','vmess','trojan'].includes(t)||typeof o!=='object'||!o['public-key'])return false;
    if(o['short-id']!==undefined&&(!/^[0-9a-fA-F]{2,16}$/.test(String(o['short-id']))||String(o['short-id']).length%2))return false;
  }
  return true;
}
function endpointIdentity(p){
  const t=String(p.type).toLowerCase();
  const auth=t==='shadowsocks'?[p.cipher||'',p.password||'']:t==='vmess'||t==='vless'?[p.uuid||'']:[p.password||''];
  const transport=p.network||'tcp';
  const tls=p.tls?'tls':'plain';
  const sni=p.sni||'';
  const reality=p['reality-opts']||{};
  const ws=p['ws-opts']||{}, grpc=p['grpc-opts']||{};
  const transportOpts={wsPath:ws.path||'',wsHost:ws.headers?.Host||'',grpcService:grpc['grpc-service-name']||''};
  return crypto.createHash('sha256').update(JSON.stringify([t,String(p.server).toLowerCase(),Number(p.port),auth,transport,transportOpts,tls,sni,p.flow||'',reality['public-key']||'',reality['short-id']||''])).digest('hex').slice(0,16);
}
function fingerprint(p){return endpointIdentity(p);}
function add(p,source){
  if(p&&p['reality-opts'])p.tls=true;
  if(!valid(p))return;
  const key=fingerprint(p);
  if(seen.has(key)){
    const meta=sourcesById.get(key);
    if(meta&&!meta.includes(source))meta.push(source);
    return;
  }
  seen.add(key);
  sourcesById.set(key,[source]);
  p['endpoint-id']=key;
  let name=String(p.name).trim()||String(p.server);
  if(usedNames.has(name))name=name+'-'+key;
  usedNames.add(name);
  proxies.push({...p,name,_source:source,_sources:[source],_id:key});
}
function decodeB64Json(s){try{return JSON.parse(Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'))}catch{return null}}
function vmessProxy(u,source){
 const d=decodeB64Json(u.slice(8)); if(!d||!d.add||!d.port||!d.id)return;
 const p={type:'vmess',name:d.ps||d.add,server:d.add,port:Number(d.port),uuid:d.id,alterId:Number(d.aid||0),cipher:d.scy||'auto',tls:d.tls==='tls'};
 if(d.sni)p.sni=d.sni;
 const net=d.net||'tcp';
 if(net==='ws'){p.network='ws';p['ws-opts']={path:d.path||'/'};if(d.host)p['ws-opts'].headers={Host:d.host}}
 else if(net==='grpc'){p.network='grpc';p['grpc-opts']={['grpc-service-name']:d.path||d.serviceName||''}}
 else p.network=net;
 add(p,source);
}
function uriProxy(u,source){
 try{
  if(/^vmess:\/\//i.test(u)){vmessProxy(u,source);return}
  const x=new URL(u), t=x.protocol.slice(0,-1).toLowerCase();
  if(t==='vless'||t==='trojan'){
   const p={type:t,name:decodeURIComponent(x.hash.slice(1))||x.hostname,server:x.hostname,port:Number(x.port),tls:x.searchParams.get('security')==='tls'};
   if(t==='vless')p.uuid=decodeURIComponent(x.username); else p.password=decodeURIComponent(x.username);
   const network=x.searchParams.get('type')||x.searchParams.get('network')||'tcp'; p.network=network;
   const sni=x.searchParams.get('sni')||x.searchParams.get('host'); if(sni)p.sni=sni;
   if(network==='ws'){p['ws-opts']={path:x.searchParams.get('path')||'/'};if(x.searchParams.get('host'))p['ws-opts'].headers={Host:x.searchParams.get('host')}}
   if(network==='grpc')p['grpc-opts']={'grpc-service-name':x.searchParams.get('serviceName')||x.searchParams.get('path')||''};
   if(x.searchParams.get('flow'))p.flow=x.searchParams.get('flow');
   if(x.searchParams.get('security')==='reality')p['reality-opts']={'public-key':x.searchParams.get('pbk')||'', 'short-id':x.searchParams.get('sid')||''};
   add(p,source);
  } else if(t==='ss'){
   const decoded=Buffer.from(x.username,'base64').toString('utf8'); const i=decoded.indexOf(':');
   if(i>0)add({type:'ss',name:decodeURIComponent(x.hash.slice(1))||x.hostname,server:x.hostname,port:Number(x.port),cipher:decoded.slice(0,i),password:decoded.slice(i+1)},source);
  }
 }catch{}
}
for(const s of raw){
 let d; try{d=yaml.load(s.text)}catch{}
 if(Array.isArray(d?.proxies))d.proxies.forEach(p=>add(p,s.name));
 else if(s.format==='uri'||s.format==='base64'||/^(vless|vmess|trojan|ss):\/\//im.test(s.text)){
   for(const line of s.text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))uriProxy(line,s.name);
 }
}
for(const p of proxies){
  const list=sourcesById.get(p._id)||[p._source];
  p._sources=[...new Set(list)];
}
// Snapshot only current Source discovery membership before historical Node Pool
// entries are merged; pool-only nodes must never reintroduce stale sources.
const currentSourceMembership=new Map([...sourcesById].map(([id,list])=>[id,[...new Set(list||[])]]));
const poolFile='data/node-pool.json';
let poolState={version:1,nodes:[],updatedAt:null,updatedRunId:null};
try{
 const pool=JSON.parse(fs.readFileSync(poolFile,'utf8'));
 poolState=pool;
 for(const entry of pool.nodes||[]){
   if(entry.status==='dead')continue;
   const id=entry.fingerprint||entry.proxy?.['endpoint-id'];
   const p=entry.proxy?{...entry.proxy}:{};
   if(!id||!p.server||!p.port||seen.has(id))continue;
   p['endpoint-id']=id;
   p._id=id;
   p._poolOnly=true;
   p._source=null;
   p._sources=Array.isArray(entry.currentSources)?entry.currentSources:[];
   seen.add(id);
   sourcesById.set(id,[...p._sources]);
   let name=String(p.name||p.server).trim()||String(p.server);
   if(usedNames.has(name))name=name+'-pool-'+id;
   usedNames.add(name);
   proxies.push({...p,name});
 }
 console.log('persistent node pool merged:',(pool.nodes||[]).filter(x=>x.status!=='dead').length,'entries');
}catch(e){console.log('persistent node pool unavailable:',e.message)}
fs.writeFileSync('data/current-node-sources.json',JSON.stringify(Object.fromEntries(currentSourceMembership),null,2));

// Complete inventory is kept for all.yaml; only selected work is written to candidates.json.
const candidateLimit=Math.max(1,Number(process.env.NODE_CANDIDATE_LIMIT||1500));
const nowMs=Date.now();
const poolById=new Map((poolState.nodes||[]).map(x=>[x.fingerprint,x]));
const currentRunId=process.env.GITHUB_RUN_ID||null;
let currentRunObserved=new Set();
if(currentRunId&&poolState.updatedRunId===currentRunId){
 try{
   const currentHealth=JSON.parse(fs.readFileSync('data/health.json','utf8'));
   currentRunObserved=new Set((currentHealth.results||[]).map(r=>r.fingerprint).filter(Boolean));
 }catch{}
}
const inventoryById=new Map(proxies.map(p=>[p['endpoint-id']||p._id,p]));
const maintenance=[];
for(const [id,entry] of poolById){
 if(entry.status==='dead')continue;
 const p=inventoryById.get(id);
 if(!p)continue;
 const dueAt=entry.nextProbeAt?Date.parse(entry.nextProbeAt):NaN;
 if(!Number.isFinite(dueAt)||dueAt<=nowMs){
   maintenance.push({id,proxy:p,overdueMs:Number.isFinite(dueAt)?Math.max(0,nowMs-dueAt):Number.MAX_SAFE_INTEGER});
 }
}
maintenance.sort((a,b)=>b.overdueMs-a.overdueMs||a.id.localeCompare(b.id));
const exploration=proxies.filter(p=>{
 const id=p['endpoint-id']||p._id;
 const entry=poolById.get(id);
 return !entry&&!p._poolOnly;
});
const selectedIds=new Set(),selected=[];
for(const item of maintenance){
 if(selected.length>=candidateLimit)break;
 selected.push(item.proxy); selectedIds.add(item.id);
}
for(const p of exploration){
 if(selected.length>=candidateLimit)break;
 const id=p['endpoint-id']||p._id;
 if(selectedIds.has(id))continue;
 selected.push(p); selectedIds.add(id);
}
// Nodes observed in this workflow are retained for the later Best/Stable builds.
for(const id of currentRunObserved){
 if(selectedIds.has(id))continue;
 const p=inventoryById.get(id);
 if(!p)continue;
 selected.push(p); selectedIds.add(id);
}
const clean=selected.map(({_source,_sources,_id,...p})=>{delete p['endpoint-id'];return p;});
const fullClean=proxies.map(({_source,_sources,_id,...p})=>{delete p['endpoint-id'];return p;});
fs.mkdirSync('subscriptions',{recursive:true});

// Keep generated subscriptions maximally compatible with stricter YAML parsers.
// In particular, public node names and credentials often contain punctuation
// such as |, :, #, %, or leading indicator-like characters. js-yaml can emit
// valid plain scalars for these, but some Clash clients use stricter YAML
// parsing rules. Quoting all strings avoids parser-dependent interpretation.
const yamlOptions={lineWidth:-1,noRefs:true,forceQuotes:true,quotingType:"'"};
function dumpSubscription(set){
  return yaml.dump({proxies:set},{...yamlOptions});
}
fs.writeFileSync('subscriptions/all.yaml',dumpSubscription(fullClean));
try{
 const h=JSON.parse(fs.readFileSync('data/health.json','utf8'));
 const history=JSON.parse(fs.readFileSync('data/history.json','utf8'));
 const hist={};
 for(const batch of history) for(const r of batch.results) if(r.fingerprint){
   const x=hist[r.fingerprint]??={tests:0,successes:0,latencies:[]};
   x.tests+=r.rounds; x.successes+=r.successes; x.latencies.push(...r.delays.filter(v=>v>0));
 }
 const metrics=new Map(Object.entries(hist).map(([id,x])=>{
   const s=[...x.latencies].sort((a,b)=>a-b), p=q=>s.length?s[Math.min(s.length-1,Math.ceil(s.length*q)-1)]:null;
   return [id,{longRate:x.tests?x.successes/x.tests:0,avg:s.length?Math.round(s.reduce((a,b)=>a+b,0)/s.length):null,p95:p(.95),tests:x.tests}];
 }));
 const stability=(()=>{try{return JSON.parse(fs.readFileSync('data/stability.json','utf8'))}catch{return null}})();
 const currentStability=new Map();
 for(const x of (stability?.healthGeneratedAt===h.generatedAt?(stability.results||[]):[])){ if(x.fingerprint)currentStability.set(x.fingerprint,x); if(x.name)currentStability.set(x.name,x); }
 const sourceQuality=new Map(Object.entries(h.sourceStats||{}).map(([name,x])=>[name,x])); const sourceReputation=(()=>{try{return JSON.parse(fs.readFileSync('data/source-reputation.json','utf8'))}catch{return {sources:{}}}})();
 const histStats=new Map(Object.entries(hist).map(([id,x])=>{
   const observations=[];
   for(const batch of history) for(const r of batch.results||[])if(r.fingerprint===id&&Array.isArray(r.delays))observations.push(...r.delays);
   const recent=observations.slice(-12), weights=recent.map((_,i)=>i+1), total=weights.reduce((a,b)=>a+b,0);
   const weightedRate=total?recent.reduce((s,v,i)=>s+(Number(v)>0?weights[i]:0),0)/total:0;
   return [id,{...x,recentTests:recent.length,weightedRate}];
 }));
 function currentRate(r){return Number(r.successRate||0)}
 function currentLatency(r){return r.avgLatency==null?Infinity:Number(r.avgLatency)}
 function historyMetric(id){return histStats.get(id)||{tests:0,successes:0,latencies:[],recentTests:0,weightedRate:0}}
 function stableEligible(r){
   const m=historyMetric(r.fingerprint);
   const currentOk=r.rounds>=2&&currentRate(r)>=0.8&&currentLatency(r)<=5000;
   if(!currentOk)return false;
   if(m.tests===0)return r.successes>=2;
   return m.recentTests>=6&&m.weightedRate>=0.8;
 }
 function bestEligible(r){
   const m=historyMetric(r.fingerprint),repNode=reputation.nodes?.[r.fingerprint],st=currentStability.get(r.fingerprint)||currentStability.get(r.name);
   const currentOk=r.rounds>=3&&currentRate(r)>=0.9&&currentLatency(r)<=2500&&Number(r.p95Latency||Infinity)<=5000;
   if(!currentOk||repNode?.status==='quarantine'||repNode?.status==='degraded')return false;
   // When the current run has a stability confirmation, Best requires it. The
   // first build of a run happens before confirmation and therefore keeps the
   // provisional set; the final rebuild after confirmation applies this gate.
   if(stability?.healthGeneratedAt===h.generatedAt && (!st || !st.eligible))return false;
   if(m.tests===0)return r.successes>=3;
   return m.recentTests>=9&&m.weightedRate>=0.9;
 }
 const google=new Set(h.results.filter(r=>currentRate(r)>0).map(r=>r.name));
 const stable=new Set(h.results.filter(stableEligible).map(r=>r.name));
 let reputation={nodes:{}};
 try{reputation=JSON.parse(fs.readFileSync('data/reputation.json','utf8'))}catch{}
 const best=new Set(h.results.filter(bestEligible).map(r=>r.name));
 function qualityScore(r,m){
  const success=Math.max(0,Math.min(1,r.successRate||0)),long=Math.max(0,Math.min(1,m?.weightedRate??m?.longRate??0));
  const latency=m?.avg?Math.max(0,1-Math.min(1,m.avg/5000)):0,p95=m?.p95?Math.max(0,1-Math.min(1,m.p95/10000)):0;
  const sourceList=Array.isArray(r.sources)?r.sources:[r.source].filter(Boolean);
  const sourceRates=sourceList.map(s=>{const historical=sourceReputation.sources?.[s]?.weightedNodeSuccessRate;return Number.isFinite(Number(historical))?Number(historical):Number(sourceQuality.get(s)?.nodeSuccessRate)});
  const validSourceRates=sourceRates.filter(Number.isFinite),sourceQualityScore=validSourceRates.length?validSourceRates.reduce((a,b)=>a+b,0)/validSourceRates.length:0;
  const provenance=Math.min(1,Math.max(0,(sourceList.length-1)/3));
  return Math.round(100*(0.38*success+0.35*long+0.15*latency+0.09*p95+0.03*provenance));
 }
 const pick=set=>clean.filter(p=>set.has(p.name));

 // Country pool: keep a small, intentional set of well-known regions rather
 // than trying to maximize geographic coverage. Prefer nodes that already
 // passed the current health checks, and cap each country independently.
 const COUNTRY_TARGETS={
   US:'United States',JP:'Japan',KR:'South Korea',SG:'Singapore',
   GB:'United Kingdom',DE:'Germany',FR:'France',NL:'Netherlands',
   CA:'Canada',AU:'Australia',IN:'India',TW:'Taiwan',HK:'Hong Kong'
 };
 const COUNTRY_LIMIT=3;
 function countryCodeFromName(name){
   const m=String(name||'').match(/(?:^|\s|[^A-Za-z])([\u{1F1E6}-\u{1F1FF}]{2})(?=[A-Z]{2}_|\||\s|$)/u);
   if(m){
     const chars=[...m[1]];
     if(chars.length===2){
       const code=chars.map(c=>String.fromCharCode(c.codePointAt(0)-0x1F1E6+65)).join('');
       if(COUNTRY_TARGETS[code])return code;
     }
   }
   const iso=String(name||'').match(/(?:^|[^A-Za-z])([A-Z]{2})_\d+(?:\||$)/);
   return iso&&COUNTRY_TARGETS[iso[1]]?iso[1]:null;
 }
 const candidateByName=new Map(clean.map(p=>[p.name,p]));
 let geoByHost={};
 try{geoByHost=JSON.parse(fs.readFileSync('data/ip-geolocation.json','utf8'))}catch{}
 const countryBuckets=new Map(Object.keys(COUNTRY_TARGETS).map(k=>[k,[]]));
 for(const r of h.results){
   const p=candidateByName.get(r.name); if(!p)continue;
   const geo=geoByHost[String(p.server||'')];
   // Country membership is based on the resolved server IP. If geolocation
   // failed, fall back to the source-declared country so the pool does not
   // disappear completely; the record is marked as fallback in metadata.
   const detected=geo?.country_code&&COUNTRY_TARGETS[geo.country_code]?geo.country_code:null;
   const declared=countryCodeFromName(p.name);
   const code=detected||declared; if(!code)continue;
   const m=historyMetric(r.fingerprint);
   const usable=r.rounds>=2&&currentRate(r)>=0.8&&currentLatency(r)<=5000;
   if(!usable)continue;
   countryBuckets.get(code).push({
     proxy:p,result:r,score:qualityScore(r,m),
     detectedCountry:detected,declaredCountry:declared,
     countrySource:detected?'ip':'declared'
   });
 }
 const countrySelected=[];
 for(const [code,list] of countryBuckets){
   list.sort((a,b)=>b.score-a.score);
   const selected=[];
   const protocols=new Set();
   for(const item of list){
     const type=String(item.proxy.type||'').toLowerCase();
     if(selected.length>=COUNTRY_LIMIT)break;
     if(!protocols.has(type)){selected.push(item);protocols.add(type);}
   }
   for(const item of list){
     if(selected.length>=COUNTRY_LIMIT)break;
     if(!selected.includes(item))selected.push(item);
   }
   countrySelected.push(...selected.map(x=>x.proxy));
 }
 const countrySet=new Set(countrySelected.map(p=>p.name));
 fs.writeFileSync('subscriptions/country.yaml',dumpSubscription(countrySelected));
 fs.writeFileSync('data/country-pool.json',JSON.stringify({
   generatedAt:new Date().toISOString(),
   targets:COUNTRY_TARGETS,
   limitPerCountry:COUNTRY_LIMIT,
   countries:Object.fromEntries([...countryBuckets].map(([code,list])=>[
     code,
     {name:COUNTRY_TARGETS[code],available:list.length,selected:list.filter(x=>countrySet.has(x.proxy.name)).slice(0,COUNTRY_LIMIT).map(x=>({name:x.proxy.name,type:x.proxy.type,score:x.score,declaredCountry:x.declaredCountry,detectedCountry:x.detectedCountry,countrySource:x.countrySource}))}
   ]))
 },null,2));
 console.log('country pool:',countrySelected.length,'nodes across',Object.values(Object.fromEntries([...countryBuckets].map(([k,v])=>[k,v.length]))).filter(x=>x>0).length,'countries');
 fs.writeFileSync('subscriptions/google.yaml',dumpSubscription(pick(google)));
 fs.writeFileSync('subscriptions/stable.yaml',dumpSubscription(pick(stable)));
 fs.writeFileSync('subscriptions/best.yaml',dumpSubscription(pick(best)));
 const scored=h.results.map(r=>{const m=metrics.get(r.fingerprint)||{};return {...r,qualityScore:qualityScore(r,m)}}).sort((a,b)=>b.qualityScore-a.qualityScore);
 fs.writeFileSync('data/scores.json',JSON.stringify({generatedAt:new Date().toISOString(),results:scored,sourceQuality:Object.fromEntries(sourceQuality)},null,2));
 const sourceHistory=[];
 try{sourceHistory.push(...JSON.parse(fs.readFileSync('data/source-history.json','utf8')))}catch{}
 const nowIso=new Date().toISOString();
 sourceHistory.push({generatedAt:nowIso,sources:Object.fromEntries(sourceQuality)});
 const sourceRuns=sourceHistory.slice(-30),sourceReputationOut={generatedAt:nowIso,sources:{}};
 const sourceEvolution=(()=>{try{return JSON.parse(fs.readFileSync('data/source-evolution.json','utf8'))}catch{return {runs:[]}}})();
 const sourceNames=new Set([
   ...sourceRuns.flatMap(run=>Object.keys(run.sources||{})),
   ...Object.keys((sourceEvolution.runs?.at(-1)?.sources)||{})
 ]);
 const registryState=(()=>{try{return JSON.parse(fs.readFileSync('data/sources.json','utf8'))}catch{return {sources:[]}}})();
 const registryById=new Map((registryState.sources||[]).map(s=>[s.name||s.url,s]));
 for(const source of sourceNames){
   const observations=sourceRuns.flatMap(run=>{
     const x=run.sources?.[source];
     if(!x)return [];
     return [{at:run.generatedAt,successRate:Number(x.successRate||0),nodeSuccessRate:Number(x.nodeSuccessRate||0),avgLatency:x.avgLatency==null?null:Number(x.avgLatency),nodes:Number(x.nodes||0)}];
   });
   const recent=observations.slice(-12),weights=recent.map((_,i)=>i+1),total=weights.reduce((a,b)=>a+b,0);
   const weightedNodeSuccess=total?recent.reduce((s,x,i)=>s+x.nodeSuccessRate*weights[i],0)/total:0;
   const weightedTestSuccess=total?recent.reduce((s,x,i)=>s+x.successRate*weights[i],0)/total:0;
   const weightedNodes=total?recent.reduce((s,x,i)=>s+x.nodes*weights[i],0)/total:0;
   const weightedSuccessfulNodes=total?recent.reduce((s,x,i)=>s+x.nodes*x.nodeSuccessRate*weights[i],0)/total:0;
   const alpha=2,beta=2,posteriorN=weightedNodes,posteriorS=weightedSuccessfulNodes,posteriorMean=(posteriorS+alpha)/(posteriorN+alpha+beta),phat=posteriorN>0?posteriorS/posteriorN:0,z=1.645;
   const denom=1+(z*z/Math.max(1,posteriorN));
   const wilsonLower=posteriorN>0?Math.max(0,(phat+(z*z/(2*posteriorN))-z*Math.sqrt((phat*(1-phat)/posteriorN)+(z*z/(4*posteriorN*posteriorN))))/denom):0;
   const usable=recent.filter(x=>x.avgLatency!=null),avgLatency=usable.length?Math.round(usable.reduce((s,x)=>s+x.avgLatency,0)/usable.length):null,last=recent.at(-1);
   const lastObservedAt=last?.at||registryById.get(source)?.lastSeen||null;
   const stalenessDays=lastObservedAt?Math.max(0,(Date.now()-Date.parse(lastObservedAt))/86400000):Infinity;
   const evolutionRuns=(sourceEvolution.runs||[]).map(run=>run.sources?.[source]).filter(Boolean).slice(-12);
   const churn=evolutionRuns.filter(x=>x.replacementRate!=null).map(x=>Number(x.replacementRate));
   const avgReplacementRate=churn.length?churn.reduce((a,b)=>a+b,0)/churn.length:null;
   const qualityTrend=evolutionRuns.length>=2?Number((Number(evolutionRuns.at(-1).quality||0)-Number(evolutionRuns[0].quality||0)).toFixed(4)):null;

   let status;
   if(stalenessDays>30)status='dead';
   else if(stalenessDays>7)status='stale';
   else if(recent.length>=6&&recent.slice(-6).every(x=>x.nodeSuccessRate<0.1))status='degraded';
   else if(posteriorN>=10&&wilsonLower<0.35)status='weak';
   else if(posteriorN>=20&&wilsonLower>=0.70)status='trusted';
   else status='normal';

   sourceReputationOut.sources[source]={
     runs:observations.length,
     weightedNodeSuccessRate:Number(weightedNodeSuccess.toFixed(4)),
     weightedTestSuccessRate:Number(weightedTestSuccess.toFixed(4)),
     effectiveNodes:Number(posteriorN.toFixed(2)),
     effectiveSuccessfulNodes:Number(posteriorS.toFixed(2)),
     posteriorMean:Number(posteriorMean.toFixed(4)),
     lowerBound90:Number(wilsonLower.toFixed(4)),
     avgLatency,
     currentNodeSuccessRate:last?.nodeSuccessRate??0,
     currentSuccessRate:last?.successRate??0,
     currentNodes:last?.nodes??0,
     lastObservedAt,
     stalenessDays:Number.isFinite(stalenessDays)?Number(stalenessDays.toFixed(2)):null,
     evolution:{observations:evolutionRuns.length,avgReplacementRate:avgReplacementRate==null?null:Number(avgReplacementRate.toFixed(4)),qualityTrend},
     status
   };
 }
fs.writeFileSync('data/source-history.json',JSON.stringify(sourceRuns,null,2));
 fs.writeFileSync('data/source-reputation.json',JSON.stringify(sourceReputationOut,null,2));
 try{
   const registry=JSON.parse(fs.readFileSync('data/sources.json','utf8')),fetched=new Set(raw.map(x=>x.name));
   for(const s of registry.sources||[]){
     const id=s.name||s.url,rep=sourceReputationOut.sources?.[id];
     if(rep){
       s.reputation=rep.weightedNodeSuccessRate;
       if(!s.fetchFailures)s.status=rep.status==='trusted'?'trusted'
         :rep.status==='degraded'?'weak'
         :rep.status==='weak'?'weak'
         :rep.status==='stale'?'stale'
         :rep.status==='dead'?'dead'
         :(s.status==='candidate'?'normal':s.status);
     }
     if(fetched.has(id)){s.fetchFailures=0;s.lastSeen=new Date().toISOString();}
     if(s.status==='dead')s.nextProbeAt=new Date(Date.now()+30*86400000).toISOString();
     else if(s.status==='stale')s.nextProbeAt=new Date(Date.now()+7*86400000).toISOString();
     else if(s.status==='trusted')s.nextProbeAt=new Date(Date.now()+24*3600000).toISOString();
     else if(s.status==='normal')s.nextProbeAt=new Date(Date.now()+12*3600000).toISOString();
     else if(s.status==='weak')s.nextProbeAt=new Date(Date.now()+72*3600000).toISOString();
     else s.nextProbeAt=new Date(Date.now()+6*3600000).toISOString();
   }
   registry.updatedAt=new Date().toISOString();
   fs.writeFileSync('data/sources.json',JSON.stringify(registry,null,2));
 }catch(e){console.log('source registry update skipped:',e.message)}
 console.log('google/stable/best:',google.size,stable.size,best.size);
}catch(e){console.log('health data unavailable; only all.yaml generated:',e.message)}
fs.writeFileSync('data/candidates.json',JSON.stringify(proxies,null,2));
console.log('candidate nodes:',clean.length,'maintenance due:',maintenance.length,'exploration available:',exploration.length,'retained current-run:',currentRunObserved.size,'capacity:',candidateLimit);

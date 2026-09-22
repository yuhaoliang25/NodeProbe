#!/usr/bin/env node
'use strict';
const fs=require('fs'),yaml=require('js-yaml');
const OUT='reports/best-audit';
const read=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
fs.mkdirSync(OUT,{recursive:true});
const best=yaml.load(fs.readFileSync('subscriptions/best.yaml','utf8'));
const health=read('data/health.json',{results:[]});
const detailed=read('reports/health-test/detailed.json',{results:[]});
const history=read('data/history.json',[]);
const scores=read('data/scores.json',{results:[]});
const reputation=read('data/reputation.json',{nodes:{}});
const stability=read('data/stability.json',{results:[]});
const stabilityBy=new Map();
for(const x of stability.results||[]){if(x.fingerprint)stabilityBy.set(x.fingerprint,x);if(x.name)stabilityBy.set(x.name,x);}
const pool=read('data/node-pool.json',{nodes:[]});
const scoreBy=new Map((scores.results||[]).filter(x=>x.fingerprint).map(x=>[x.fingerprint,x]));
const poolBy=new Map((pool.nodes||[]).map(x=>[x.fingerprint,x]));
const healthBy=new Map((health.results||[]).map(x=>[x.fingerprint||x.name,x]));
const detailedBy=new Map((detailed.results||[]).map(x=>[x.fingerprint||x.name,x]));
const histBy=new Map();
for(const batch of history) for(const r of batch.results||[]) if(r.fingerprint){
  if(!histBy.has(r.fingerprint))histBy.set(r.fingerprint,[]);
  histBy.get(r.fingerprint).push({generatedAt:batch.generatedAt,name:r.name,rounds:r.rounds,successes:r.successes,successRate:r.successRate,avgLatency:r.avgLatency,p95Latency:r.p95Latency,delays:r.delays,stage1Flaky:r.stage1Flaky});
}
function eligibility(r){
 if(!r)return null;
 const current={rounds:Number(r.rounds||0)>=3,successRate:Number(r.successRate||0)>=.9,avgLatency:Number(r.avgLatency==null?Infinity:r.avgLatency)<=2500,p95Latency:Number(r.p95Latency==null?Infinity:r.p95Latency)<=5000};
 const hist=(histBy.get(r.fingerprint)||[]).flatMap(x=>x.delays||[]).slice(-12);
 const weights=hist.map((_,i)=>i+1),total=weights.reduce((a,b)=>a+b,0);
 const wr=total?hist.reduce((s,v,i)=>s+(Number(v)>0?weights[i]:0),0)/total:0;
 const historical=hist.length===0?Number(r.successes||0)>=3:(hist.length>=9&&wr>=.9);
 const rep=reputation.nodes?.[r.fingerprint];
 return {current,historicalRule:historical,notQuarantine:!rep||rep.status!=='quarantine',notDegraded:!rep||rep.status!=='degraded',historicalRecentTests:hist.length,historicalWeightedSuccessRate:wr,final:Object.values(current).every(Boolean)&&historical&&(!rep||rep.status!=='quarantine')&&(!rep||rep.status!=='degraded')};
}
const results=[];
for(const p of best.proxies||[]){
 const fp=p['endpoint-id']||null,h=healthBy.get(fp)||healthBy.get(p.name)||null,d=detailedBy.get(fp)||detailedBy.get(p.name)||null,score=scoreBy.get(fp)||null,pe=poolBy.get(fp)||null,st=stabilityBy.get(fp)||stabilityBy.get(p.name)||null;
 results.push({name:p.name,fingerprint:fp,proxy:{name:p.name,type:p.type,server:p.server,port:p.port,network:p.network,tls:p.tls,sni:p.sni,flow:p.flow},selection:{qualityScore:score?.qualityScore??null,scoreRecord:score,eligibility:eligibility(h),reputation:fp?reputation.nodes?.[fp]||null:null,stability:st},currentRun:{generatedAt:health.generatedAt,target:health.target,roundsConfigured:health.rounds,timeoutMs:health.timeout,expectedStatus:health.expectedStatus,health:h,attempts:d?.attempts||[]},historical:histBy.get(fp)||[],nodePool:pe?{status:pe.status,everStable:pe.everStable,firstObservedAt:pe.firstObservedAt,firstObservedSource:pe.firstObservedSource,lastObservedAt:pe.lastObservedAt,lastHealthyAt:pe.lastHealthyAt,observedRuns:pe.observedRuns,healthyRuns:pe.healthyRuns,failedRuns:pe.failedRuns,currentSources:pe.currentSources,knownSources:pe.knownSources}:null});
}
const report={generatedAt:new Date().toISOString(),runGeneratedAt:health.generatedAt||null,count:results.length,nodes:results};
fs.writeFileSync(OUT+'/best-audit.json',JSON.stringify(report,null,2));
const md=['# NodeProbe best selection audit','Generated: '+report.generatedAt,'Health run: '+(health.generatedAt||'unknown'),'Nodes in best: '+results.length,'','This artifact records the current-run evidence for every node that entered best. Runtime state is not committed and this report is not uploaded to B2.',''];
for(const r of results){
 const h=r.currentRun.health,s=r.selection,e=s.eligibility,st=s.stability;
 md.push('## '+r.name,'','- Fingerprint: '+(r.fingerprint||'unknown'),'- Type: '+(r.proxy.type||'?')+' | '+(r.proxy.server||'?')+':'+(r.proxy.port||'?'),'- Selection score: '+(s.qualityScore==null?'N/A':s.qualityScore),'- Current result: '+(h?(h.successes+'/'+h.rounds+' = '+(h.successRate*100).toFixed(1)+'%, avg '+(h.avgLatency??'N/A')+' ms, p95 '+(h.p95Latency??'N/A')+' ms'):'MISSING'),'- Reputation: '+(s.reputation?.status||'N/A'),'','### Why it entered best');
 if(e){for(const [k,v] of Object.entries(e.current))md.push('- '+k+': '+(v?'PASS':'FAIL'));md.push('- historicalRule: '+(e.historicalRule?'PASS':'FAIL'),'- notQuarantine: '+(e.notQuarantine?'PASS':'FAIL'),'- notDegraded: '+(e.notDegraded?'PASS':'FAIL'),'- final: '+(e.final?'PASS':'FAIL'),'- historical recent tests: '+e.historicalRecentTests,'- historical weighted success rate: '+e.historicalWeightedSuccessRate.toFixed(4));}
 md.push('','### Stability confirmation');
 if(st)md.push('- Attempts: '+st.attempts,'- Success rate: '+(st.successRate*100).toFixed(1)+'%','- Timeout rate: '+(st.timeoutRate*100).toFixed(1)+'%','- Max consecutive failures: '+st.maxConsecutiveFailures,'- Max consecutive timeouts: '+st.maxConsecutiveTimeouts,'- p95 latency: '+(st.p95Latency??'N/A')+' ms','- Stability gate: '+(st.eligible?'PASS':'FAIL')); else md.push('- no stability confirmation record for this run');
 md.push('','### Full current-run test process','| # | Stage | Time | Timeout | Result | Delay | Error |','|---:|---|---|---:|---|---:|---|');
 let i=0; for(const a of h?.attempts||[]) {i++;md.push('| '+i+' | '+a.stage+' | '+a.timestamp+' | '+a.timeoutMs+' | '+(a.success?'PASS':'FAIL')+' | '+(a.delayMs??'-')+' ms | '+String(a.error||'').replace(/\\|/g,'\\\\|').replace(/\\n/g,' ')+' |');}
 md.push('','### Historical runs');
 if(r.historical.length)for(const x of r.historical)md.push('- '+x.generatedAt+': '+x.successes+'/'+x.rounds+', '+(x.successRate*100).toFixed(1)+'%, avg '+(x.avgLatency??'N/A')+' ms, p95 '+(x.p95Latency??'N/A')+' ms');
 else md.push('- no historical record');
}
fs.writeFileSync(OUT+'/best-audit.md',md.join('\\n')+'\\n');
console.log('best audit:',results.length,'nodes');

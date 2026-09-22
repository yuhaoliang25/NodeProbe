#!/usr/bin/env node
'use strict';
const fs=require('fs');
const API=process.env.MIHOMO_API||'http://127.0.0.1:9090';
const TARGET=process.env.GOOGLE_TEST_URL||'https://www.google.com/generate_204';
const ROUNDS=Number(process.env.TEST_ROUNDS||3), TIMEOUT=Number(process.env.TEST_TIMEOUT||8000), EXPECTED=process.env.TEST_EXPECTED||'204';
const STAGE2_LIMIT=Number(process.env.STAGE2_LIMIT||300);
const STAGE3_LIMIT=Number(process.env.STAGE3_LIMIT||100);
const FAST_TIMEOUT=Number(process.env.FAST_TIMEOUT||5000);
const BATCH_SIZE=Number(process.env.TEST_BATCH_SIZE||250);
const BATCH_PAUSE=Number(process.env.TEST_BATCH_PAUSE_MS||500);
const CONCURRENCY=Math.max(1,Number(process.env.TEST_CONCURRENCY||24));
async function json(url){const r=await fetch(url);const t=await r.text();if(!r.ok)throw new Error('HTTP '+r.status+' '+t.slice(0,300));return JSON.parse(t)}
async function main(){
 const all={};
 const attempts={};
 function record(name,stage,timeout,delay,error=''){(attempts[name]??=[]).push({stage,timestamp:new Date().toISOString(),timeoutMs:timeout,delayMs:Number(delay)>0?Number(delay):null,success:Number(delay)>0,error:error||null});}
 const candidates=JSON.parse(fs.readFileSync('data/candidates.json','utf8'));
 const sourceByName=new Map(candidates.map(x=>[x.name,Array.isArray(x._sources)&&x._sources.length?x._sources:[x._source||'unknown']]));
 const ids=new Map(candidates.map(x=>[x.name,x['endpoint-id']||x._id]));
 function loadReputation(){
  try{
   const raw=JSON.parse(fs.readFileSync('data/reputation.json','utf8'));
   const nodes=raw&&raw.nodes&&typeof raw.nodes==='object'?raw.nodes:{};
   const allowedTrust=new Set(['untrusted','normal','trusted']);
   const normalized={};
   for(const [id,r] of Object.entries(nodes)){
    if(!r||typeof r!=='object')continue;
    normalized[id]={
     successes:Number.isFinite(Number(r.successes))?Number(r.successes):0,
     failures:Number.isFinite(Number(r.failures))?Number(r.failures):0,
     recentSuccesses:Number.isFinite(Number(r.recentSuccesses))?Number(r.recentSuccesses):0,
     recentFailures:Number.isFinite(Number(r.recentFailures))?Number(r.recentFailures):0,
     recentOutcomes:Array.isArray(r.recentOutcomes)?r.recentOutcomes.slice(-12).filter(x=>x&&typeof x==='object'&&typeof x.success==='boolean'):[],
     lastTestAt:r.lastTestAt||null,
     lastSuccessAt:r.lastSuccessAt||null,
     lastFailureAt:r.lastFailureAt||null,
     everStable:Boolean(r.everStable),
     trust:allowedTrust.has(r.trust)?r.trust:'untrusted'
    };
   }
   return normalized;
  }catch{return {}}
 }
 const rep=loadReputation();
 const nodePool=(()=>{try{return JSON.parse(fs.readFileSync('data/node-pool.json','utf8')).nodes||[]}catch{return []}})();
 const poolById=new Map(nodePool.filter(x=>x&&x.fingerprint).map(x=>[x.fingerprint,x]));
 function trustOf(p){
  const id=p['endpoint-id']||p._id;
  return rep[id]?.trust||'untrusted';
 }
 function budget(p){
  const trust=trustOf(p);
  if(trust==='trusted')return 3;
  if(trust==='normal')return 2;
  return 1;
 }
 // Every candidate gets a mandatory Stage 1 test. Historical reputation only
 // influences which Stage-1 survivors receive deeper testing later.
 const names=candidates.map(p=>p.name);
 async function testGroup(selected,timeout,stage){
  if(!selected.length)return {};
  const merged={};
  for(let i=0;i<selected.length;i+=BATCH_SIZE){
   const batch=selected.slice(i,i+BATCH_SIZE);
   let cursor=0;
   async function worker(){
    while(true){
     const idx=cursor++;
     if(idx>=batch.length)return;
     const name=batch[idx];
     try{
      const q=new URLSearchParams({url:TARGET,timeout:String(timeout),expected:EXPECTED});
      const result=await json(API+'/proxies/'+encodeURIComponent(name)+'/delay?'+q);
      const d=Number(result.delay);
      merged[name]=Number.isFinite(d)&&d>0?d:0;
      (all[name]??=[]).push(merged[name]);
      record(name, stage, timeout, merged[name]);
     }catch(e){
      merged[name]=0;
      (all[name]??=[]).push(0);
      record(name, stage, timeout, 0, String(e&&e.message||e));
     }
    }
   }
   await Promise.all(Array.from({length:Math.min(CONCURRENCY,batch.length)},()=>worker()));
   console.log(' batch',Math.floor(i/BATCH_SIZE)+1,'/',Math.ceil(selected.length/BATCH_SIZE),'tested',batch.length,'concurrency',Math.min(CONCURRENCY,batch.length));
   if(i+BATCH_SIZE<selected.length)await new Promise(r=>setTimeout(r,BATCH_PAUSE));
  }
  return merged;
 }
 const r1=await testGroup(names,FAST_TIMEOUT,'stage1-fast');
 const firstPass=new Set(Object.entries(r1).filter(([,d])=>Number(d)>0).map(([n])=>n));
 const firstFailures=names.filter(n=>!firstPass.has(n));
 // A single timeout/transport error is not enough to discard a node.
 // Retry Stage-1 failures once with the normal timeout.
 const retry1=await testGroup(firstFailures,TIMEOUT,'stage1-retry');
 const retryPass=new Set(Object.entries(retry1).filter(([,d])=>Number(d)>0).map(([n])=>n));
 const survivors1=[...new Set([...firstPass,...retryPass])];
 const flakyStage1=[...retryPass].filter(n=>!firstPass.has(n));
 console.log('stage1:',names.length,'->',survivors1.length,'first-pass',firstPass.size,'retry-recovered',flakyStage1.length,'final-fail',names.length-survivors1.length);

 const budgets=new Map(candidates.map(p=>[p.name,budget(p)]));
 // The budget is the maximum number of rounds allowed for a node.
 // Stage 1 is mandatory; Stage 2 requires budget >= 2; Stage 3 requires >= 3.
 // This keeps the trust model as a testing-cost control rather than an
 // admission gate.
 const stage2Candidates=survivors1.filter(name=>(budgets.get(name)||1)>=2);
 const r2=await testGroup(stage2Candidates,TIMEOUT,'stage2');
 const survivors2=Object.entries(r2).filter(([,d])=>Number(d)>0).sort((a,b)=>Number(a[1])-Number(b[1])).slice(0,STAGE2_LIMIT).map(([n])=>n);
 console.log('stage2:',stage2Candidates.length,'->',survivors2.length);

 const deepCandidates=survivors2.slice(0,STAGE3_LIMIT);
 for(let round=3;round<=ROUNDS;round++){
  const eligible=deepCandidates.filter(name=>(budgets.get(name)||0)>=round);
  const result=await testGroup(eligible,TIMEOUT,'deep-round-'+round);
  console.log('deep round',round,'tested',Object.keys(result).length);
  if(round<ROUNDS)await new Promise(r=>setTimeout(r,1500));
 }
 // Stage-1/2 failures are intentionally retained in the report with fewer rounds.
 const rows=Object.entries(all).map(([name,delays])=>{
  const ok=delays.filter(x=>x>0),sorted=[...ok].sort((a,b)=>a-b),pct=p=>ok.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:null;
  return {name,fingerprint:ids.get(name)||null,source:sourceByName.get(name)||['unknown'],sources:sourceByName.get(name)||['unknown'],rounds:delays.length,successes:ok.length,successRate:ok.length/delays.length,avgLatency:ok.length?Math.round(ok.reduce((a,b)=>a+b,0)/ok.length):null,p50Latency:pct(.5),p95Latency:pct(.95),maxLatency:ok.length?Math.max(...ok):null,stage1Flaky:flakyStage1.includes(name),delays,attempts:attempts[name]||[]};
 }).sort((a,b)=>(b.successRate-a.successRate)||(a.avgLatency??1e9)-(b.avgLatency??1e9));
 const report={generatedAt:new Date().toISOString(),identity:'endpoint-id-v1',target:TARGET,rounds:ROUNDS,timeout:TIMEOUT,expectedStatus:EXPECTED,staging:{stage1:'all',stage1Retry:'failed-once',stage2:STAGE2_LIMIT,stage3:STAGE3_LIMIT,fastTimeout:FAST_TIMEOUT},results:rows};
 fs.mkdirSync('data',{recursive:true});
 fs.mkdirSync('reports/health-test', {recursive:true});
 fs.writeFileSync('reports/health-test/detailed.json',JSON.stringify(report,null,2));
 report.sourceStats={};
 for(const r of rows){
   for(const source of r.sources||[r.source||'unknown']){
     const s=report.sourceStats[source]??={nodes:0,successful:0,totalTests:0,totalSuccesses:0,latencies:[]};
     s.nodes++;
     if(r.successes>0)s.successful++;
     s.totalTests+=r.rounds;
     s.totalSuccesses+=r.successes;
     if(r.avgLatency)s.latencies.push(r.avgLatency);
   }
 }
 for(const s of Object.values(report.sourceStats)){
   s.successRate=s.totalTests?s.totalSuccesses/s.totalTests:0;
   s.nodeSuccessRate=s.nodes?s.successful/s.nodes:0;
   s.avgLatency=s.latencies.length?Math.round(s.latencies.reduce((a,b)=>a+b,0)/s.latencies.length):null;
   delete s.latencies;
 }
 const persistedResults=rows.map(({attempts,...r})=>r);
 const persistedReport={...report,results:persistedResults};
 fs.writeFileSync('data/health.json',JSON.stringify(persistedReport,null,2));
 let history=[]; try{history=JSON.parse(fs.readFileSync('data/history.json','utf8'))}catch{}
 history.push(persistedReport); history=history.slice(-30);
 fs.writeFileSync('data/history.json',JSON.stringify(history,null,2));
 const reputation={version:2,generatedAt:new Date().toISOString(),nodes:{...rep}};
 for(const row of rows){
   const id=row.fingerprint;
   if(!id)continue;
   const prev=rep[id]||{};
   const pool=poolById.get(id)||{};
   const outcomes=(Array.isArray(prev.recentOutcomes)?prev.recentOutcomes:[]).concat(
     row.delays.map(delay=>({at:new Date().toISOString(),success:Number(delay)>0}))
   ).slice(-12);
   const successes=Number(prev.successes||0)+row.successes;
   const failures=Number(prev.failures||0)+(row.rounds-row.successes);
   const tests=successes+failures;
   const recent6=outcomes.slice(-6);
   const recentSuccesses=recent6.filter(x=>x.success).length;
   const recentFailures=recent6.length-recentSuccesses;
   const everStable=Boolean(prev.everStable||pool.everStable||pool.status==='stable');
   let trust=prev.trust||'untrusted';
   const cumulativeRate=tests?successes/tests:0;
   const recentRate=recent6.length?recentSuccesses/recent6.length:0;
   if(trust==='untrusted'&&tests>=3&&cumulativeRate>=2/3)trust='normal';
   if(trust==='normal'&&recent6.length>=6&&recentRate>=0.8&&everStable)trust='trusted';
   else if(trust==='trusted'&&recent6.length>=6&&recentRate<0.5)trust='normal';
   else if(trust==='normal'&&recent6.length>=6&&recentRate<1/3)trust='untrusted';
   const successAt=outcomes.filter(x=>x.success).at(-1)?.at||prev.lastSuccessAt||null;
   const failureAt=outcomes.filter(x=>!x.success).at(-1)?.at||prev.lastFailureAt||null;
   reputation.nodes[id]={
     successes,
     failures,
     recentSuccesses,
     recentFailures,
     recentOutcomes:outcomes,
     lastTestAt:outcomes.at(-1)?.at||prev.lastTestAt||null,
     lastSuccessAt:successAt,
     lastFailureAt:failureAt,
     everStable,
     trust
   };
 }
 fs.writeFileSync('data/reputation.json',JSON.stringify(reputation,null,2));

 console.log('tested:',rows.length,'current>=80%:',rows.filter(x=>x.successRate>=.8).length,'current>=90%+latency:',rows.filter(x=>x.successRate>=.9&&x.p95Latency<=5000&&x.avgLatency<=2500).length,'stage1-flaky:',rows.filter(x=>x.stage1Flaky).length);
}
main().catch(e=>{console.error(e);process.exit(1)});

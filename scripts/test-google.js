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
 const rep=(()=>{try{return JSON.parse(fs.readFileSync('data/reputation.json','utf8')).nodes||{}}catch{return {}}})();
 const now=Date.now();
 function score(p){
  const r=rep[p._id];
  if(!r)return 50;
  const rate=Math.max(0,Math.min(1,Number(r.longTermSuccessRate||0)));
  const recent=Math.max(0,Math.min(1,1-(Number(r.recentFailures||0)/6)));
  const age=Math.max(0,now-Date.parse(r.lastSeen||0));
  const freshness=age<=86400000?1:age<=604800000?.7:.4;
  if(r.status==='quarantine')return -100;
  if(r.status==='degraded')return 15+rate*25+recent*10;
  return 40+rate*35+recent*15+freshness*10;
 }
 function budget(p){
  const s=score(p);
  if(s<0)return 0;
  if(s<35)return 1;
  if(s<65)return 2;
  return 3;
 }
 // Every candidate gets a mandatory Stage 1 test. Historical reputation only
 // influences which Stage-1 survivors receive deeper testing later.
 const names=candidates.map(p=>p.name);
 async function testGroup(selected,timeout){
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
      record(name, timeout===FAST_TIMEOUT?'stage1-fast':timeout===TIMEOUT?'stage-test':'test', timeout, merged[name]);
     }catch(e){
      merged[name]=0;
      (all[name]??=[]).push(0);
      record(name, timeout===FAST_TIMEOUT?'stage1-fast':timeout===TIMEOUT?'stage-test':'test', timeout, 0, String(e&&e.message||e));
     }
    }
   }
   await Promise.all(Array.from({length:Math.min(CONCURRENCY,batch.length)},()=>worker()));
   console.log(' batch',Math.floor(i/BATCH_SIZE)+1,'/',Math.ceil(selected.length/BATCH_SIZE),'tested',batch.length,'concurrency',Math.min(CONCURRENCY,batch.length));
   if(i+BATCH_SIZE<selected.length)await new Promise(r=>setTimeout(r,BATCH_PAUSE));
  }
  return merged;
 }
 const r1=await testGroup(names,FAST_TIMEOUT);
 const firstPass=new Set(Object.entries(r1).filter(([,d])=>Number(d)>0).map(([n])=>n));
 const firstFailures=names.filter(n=>!firstPass.has(n));
 // A single timeout/transport error is not enough to discard a node.
 // Retry Stage-1 failures once with the normal timeout.
 const retry1=await testGroup(firstFailures,TIMEOUT);
 const retryPass=new Set(Object.entries(retry1).filter(([,d])=>Number(d)>0).map(([n])=>n));
 const survivors1=[...new Set([...firstPass,...retryPass])];
 const flakyStage1=[...retryPass].filter(n=>!firstPass.has(n));
 console.log('stage1:',names.length,'->',survivors1.length,'first-pass',firstPass.size,'retry-recovered',flakyStage1.length,'final-fail',names.length-survivors1.length);

 const r2=await testGroup(survivors1,TIMEOUT);
 const survivors2=Object.entries(r2).filter(([,d])=>Number(d)>0).sort((a,b)=>Number(a[1])-Number(b[1])).slice(0,STAGE2_LIMIT).map(([n])=>n);
 console.log('stage2:',survivors1.length,'->',survivors2.length);

 const budgets=new Map(candidates.map(p=>{
  const id=p['endpoint-id']||p._id, r=rep[id];
  if(!r)return [p.name,3];
  const rate=Number(r.longTermSuccessRate||0);
  const recentFailures=Number(r.recentFailures||0);
  if(r.status==='quarantine')return [p.name,0];
  if(r.status==='degraded')return [p.name,1];
  return [p.name,rate>=0.9?3:2];
 }));
 const deepCandidates=survivors2.slice(0,STAGE3_LIMIT);
 for(let round=3;round<=ROUNDS;round++){
  const eligible=deepCandidates.filter(name=>(budgets.get(name)||0)>=round);
  const result=await testGroup(eligible,TIMEOUT);
  for(const name of eligible){
    const recent=attempts[name]||[];
    const last=recent.at(-1);
    if(last)last.stage='deep-round-'+round;
  }
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
 fs.writeFileSync('data/health.json',JSON.stringify(report,null,2));
 let history=[]; try{history=JSON.parse(fs.readFileSync('data/history.json','utf8'))}catch{}
 history.push(report); history=history.slice(-30);
 fs.writeFileSync('data/history.json',JSON.stringify(history,null,2));
 const reputation={generatedAt:new Date().toISOString(),nodes:{}};
 for(const [id,r] of new Map(rows.filter(x=>x.fingerprint).map(x=>[x.fingerprint,x]))){
   const past=history.flatMap(b=>b.results||[]).filter(x=>x.fingerprint===id);
   const observations=past.flatMap(x=>Array.isArray(x.delays)?x.delays:[]);
   const tests=observations.length, successes=observations.filter(x=>Number(x)>0).length;
   const failures=tests-successes;
   // Keep total counters for auditability, but base reputation on a recency-weighted
   // window so an old healthy period cannot hide a current outage.
   const recent=observations.slice(-12);
   const weights=recent.map((_,i)=>i+1);
   const weightTotal=weights.reduce((a,b)=>a+b,0);
   const weightedSuccessRate=weightTotal?recent.reduce((s,x,i)=>s+(Number(x)>0?weights[i]:0),0)/weightTotal:0;
   const recent6=observations.slice(-6);
   const recentFailures=recent6.filter(x=>!(Number(x)>0)).length;
   const recentSuccesses=recent6.filter(x=>Number(x)>0).length;
   const status=recent6.length>=6&&recentFailures===6?'quarantine':
     (recentFailures>=3||weightedSuccessRate<0.6?'degraded':
     (recent6.length>=3&&recentFailures>0&&recentSuccesses>=2?'flaky':'active'));
   reputation.nodes[id]={name:r.name,longTermSuccessRate:weightedSuccessRate,totalTests:tests,totalFailures:failures,recentFailures,recentSuccesses,status,lastSeen:new Date().toISOString()};
 }
 fs.writeFileSync('data/reputation.json',JSON.stringify(reputation,null,2));
 console.log('tested:',rows.length,'current>=80%:',rows.filter(x=>x.successRate>=.8).length,'current>=90%+latency:',rows.filter(x=>x.successRate>=.9&&x.p95Latency<=5000&&x.avgLatency<=2500).length,'stage1-flaky:',rows.filter(x=>x.stage1Flaky).length);
}
main().catch(e=>{console.error(e);process.exit(1)});

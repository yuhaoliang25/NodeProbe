#!/usr/bin/env node
'use strict';
const fs=require('fs'),yaml=require('js-yaml');
const {runConcurrent,probeDelay}=require('./lib/probe-runner');
const {summarizeAttempts}=require('./lib/probe-stability');
const API=process.env.MIHOMO_API||'http://127.0.0.1:9090';
const ROUNDS=Number(process.env.STABILITY_ROUNDS||5);
const ATTEMPTS_PER_TARGET=Number(process.env.STABILITY_ATTEMPTS_PER_TARGET||10);
const TIMEOUT=Number(process.env.STABILITY_TIMEOUT||5000);
const CONCURRENCY=Math.max(1,Number(process.env.STABILITY_CONCURRENCY||12));
const ROUND_PAUSE=Number(process.env.STABILITY_ROUND_PAUSE_MS||15000);
const MAX_NODES=Number(process.env.STABILITY_MAX_NODES||100);
const TARGETS=[
 {id:'google',url:'https://www.google.com/generate_204',expected:'204'},
 {id:'cloudflare',url:'https://www.cloudflare.com/cdn-cgi/trace',expected:'200'},
 {id:'github',url:'https://github.com/',expected:'200'}
];
const MIN_SUCCESS_RATE=Number(process.env.STABILITY_MIN_SUCCESS_RATE||0.95);
const MIN_TARGET_SUCCESS_RATE=Number(process.env.STABILITY_MIN_TARGET_SUCCESS_RATE||0.8);
const MIN_ROUND_SUCCESS_RATE=Number(process.env.STABILITY_MIN_ROUND_SUCCESS_RATE||2/3);
const MAX_CONSECUTIVE_FAILURES=Number(process.env.STABILITY_MAX_CONSECUTIVE_FAILURES||1);
const MAX_CONSECUTIVE_TIMEOUTS=Number(process.env.STABILITY_MAX_CONSECUTIVE_TIMEOUTS||1);
const P95_LIMIT=Number(process.env.STABILITY_P95_LIMIT||5000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
async function main(){
 const doc=yaml.load(fs.readFileSync('subscriptions/best.yaml','utf8'))||{};
 const nodes=(doc.proxies||[]).slice(0,MAX_NODES);
 const config={rounds:ROUNDS,attemptsPerTarget:ATTEMPTS_PER_TARGET,timeoutMs:TIMEOUT,targets:TARGETS,maxNodes:MAX_NODES,
   thresholds:{minSuccessRate:MIN_SUCCESS_RATE,minTargetSuccessRate:MIN_TARGET_SUCCESS_RATE,minRoundSuccessRate:MIN_ROUND_SUCCESS_RATE,
   maxConsecutiveFailures:MAX_CONSECUTIVE_FAILURES,maxConsecutiveTimeouts:MAX_CONSECUTIVE_TIMEOUTS,p95Latency:P95_LIMIT}};
 fs.mkdirSync('data',{recursive:true});fs.mkdirSync('reports/stability',{recursive:true});
 if(!nodes.length){const r={generatedAt:new Date().toISOString(),version:'stability-v1',config,provisionalBestCount:0,stabilityPassCount:0,results:[]};
   fs.writeFileSync('data/stability.json',JSON.stringify(r,null,2));fs.writeFileSync('reports/stability/stability.json',JSON.stringify(r,null,2));console.log('stability confirmation: 0 provisional');return}
 const attempts=[];
 async function test(n,t,round,attempt){
   const result=await probeDelay({api:API,name:n.name,target:t.url,expected:t.expected,timeout:TIMEOUT});
   return {node:n.name,fingerprint:n['endpoint-id']||null,target:t.id,round,attempt,timestamp:result.startedAt,finishedAt:result.finishedAt,timeoutMs:TIMEOUT,delayMs:result.delayMs,success:result.success,timeout:result.timeout,error:result.error};
 } for(let round=1;round<=ROUNDS;round++){
   const jobs=[];const perRound=ATTEMPTS_PER_TARGET/ROUNDS;
   if(!Number.isInteger(perRound))throw Error('STABILITY_ATTEMPTS_PER_TARGET must divide evenly by STABILITY_ROUNDS');
   for(const n of nodes)for(const t of [...TARGETS].sort(()=>Math.random()-.5))for(let a=1;a<=perRound;a++)jobs.push({n,t,a});
   const jobs=[];
   const perRound=ATTEMPTS_PER_TARGET/ROUNDS;
   if(!Number.isInteger(perRound))throw Error('STABILITY_ATTEMPTS_PER_TARGET must divide evenly by STABILITY_ROUNDS');
   for(const n of nodes)for(const t of [...TARGETS].sort(()=>Math.random()-.5))for(let a=1;a<=perRound;a++)jobs.push({n,t,a});
   const roundAttempts=await runConcurrent(jobs,async j=>test(j.n,j.t,round,j.a),CONCURRENCY);
   attempts.push(...roundAttempts);
   console.log('stability round',round+'/'+ROUNDS,'attempts',jobs.length);
   if(round<ROUNDS)await sleep(ROUND_PAUSE);
 }
 const by=new Map(nodes.map(n=>[n.name,{name:n.name,fingerprint:n['endpoint-id']||null,a:[]}]));
 for(const x of attempts){const n=by.get(x.node);if(n)n.a.push(x)}
 const results=[];
 for(const n of by.values()){
   results.push({name:n.name,fingerprint:n.fingerprint,...summarizeAttempts(n.a,TARGETS,ROUNDS,{
     minSuccessRate:MIN_SUCCESS_RATE,minTargetSuccessRate:MIN_TARGET_SUCCESS_RATE,minRoundSuccessRate:MIN_ROUND_SUCCESS_RATE,
     maxConsecutiveFailures:MAX_CONSECUTIVE_FAILURES,maxConsecutiveTimeouts:MAX_CONSECUTIVE_TIMEOUTS,p95Latency:P95_LIMIT
   })});
 }
 const report={generatedAt:new Date().toISOString(),healthGeneratedAt:read('data/health.json',{generatedAt:null}).generatedAt||null,version:'stability-v1',config,provisionalBestCount:nodes.length,stabilityPassCount:results.filter(x=>x.eligible).length,results};
 fs.writeFileSync('data/stability.json',JSON.stringify(report,null,2));
 let hist=read('data/stability-history.json',[]);if(!Array.isArray(hist))hist=[];
 hist.push({generatedAt:report.generatedAt,config,provisionalBestCount:report.provisionalBestCount,stabilityPassCount:report.stabilityPassCount,results});fs.writeFileSync('data/stability-history.json',JSON.stringify(hist.slice(-30),null,2));
 fs.writeFileSync('reports/stability/stability.json',JSON.stringify(report,null,2));
 fs.writeFileSync('reports/stability/attempts.json',JSON.stringify({generatedAt:report.generatedAt,attempts},null,2));
 const md=['# NodeProbe Stability Confirmation','Generated: '+report.generatedAt,'Provisional Best: '+nodes.length,'Stability Pass: '+report.stabilityPassCount,'',
 'Thresholds are experimental and should be revised only from accumulated future evidence.','','| Node | Success | Timeout | Max failure run | Max timeout run | p95 | Result |','|---|---:|---:|---:|---:|---:|---|'];
 for(const r of results)md.push('| '+r.name+' | '+(r.successRate*100).toFixed(1)+'% | '+(r.timeoutRate*100).toFixed(1)+'% | '+r.maxConsecutiveFailures+' | '+r.maxConsecutiveTimeouts+' | '+(r.p95Latency??'-')+' ms | '+(r.eligible?'PASS':'FAIL')+' |');
 fs.writeFileSync('reports/stability/stability.md',md.join('\n')+'\n');
 console.log('stability confirmation:',nodes.length,'provisional ->',report.stabilityPassCount,'pass');
}
main().catch(e=>{console.error(e);process.exit(1)});

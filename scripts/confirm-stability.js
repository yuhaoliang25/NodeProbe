#!/usr/bin/env node
'use strict';
const fs=require('fs'),yaml=require('js-yaml');
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
async function api(url){const r=await fetch(url);const t=await r.text();if(!r.ok)throw Error('HTTP '+r.status+' '+t.slice(0,200));return JSON.parse(t)}
function maxRun(a,p){let b=0,c=0;for(const x of a){if(p(x)){c++;b=Math.max(b,c)}else c=0}return b}
function pct(a,q){const s=a.filter(x=>x.success).map(x=>x.delayMs).sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.ceil(s.length*q)-1)]:null}
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
   const at=new Date().toISOString();
   try{
     const q=new URLSearchParams({url:t.url,timeout:String(TIMEOUT),expected:t.expected});
     const r=await api(API+'/proxies/'+encodeURIComponent(n.name)+'/delay?'+q),d=Number(r.delay),ok=Number.isFinite(d)&&d>0;
     return {node:n.name,fingerprint:n['endpoint-id']||null,target:t.id,round,attempt,timestamp:at,finishedAt:new Date().toISOString(),timeoutMs:TIMEOUT,delayMs:ok?d:null,success:ok,timeout:!ok,error:ok?null:'invalid delay'};
   }catch(e){const msg=String(e&&e.message||e);return {node:n.name,fingerprint:n['endpoint-id']||null,target:t.id,round,attempt,timestamp:at,finishedAt:new Date().toISOString(),timeoutMs:TIMEOUT,delayMs:null,success:false,timeout:/timeout|timed out|deadline/i.test(msg),error:msg}}
 }
 for(let round=1;round<=ROUNDS;round++){
   const jobs=[];const perRound=ATTEMPTS_PER_TARGET/ROUNDS;
   if(!Number.isInteger(perRound))throw Error('STABILITY_ATTEMPTS_PER_TARGET must divide evenly by STABILITY_ROUNDS');
   for(const n of nodes)for(const t of [...TARGETS].sort(()=>Math.random()-.5))for(let a=1;a<=perRound;a++)jobs.push({n,t,a});
   let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=jobs.length)return;const j=jobs[i];attempts.push(await test(j.n,j.t,round,j.a))}}
   await Promise.all(Array.from({length:Math.min(CONCURRENCY,jobs.length)},worker));
   console.log('stability round',round+'/'+ROUNDS,'attempts',jobs.length);
   if(round<ROUNDS)await sleep(ROUND_PAUSE);
 }
 const by=new Map(nodes.map(n=>[n.name,{name:n.name,fingerprint:n['endpoint-id']||null,a:[],t:{},r:{}}]));
 for(const x of attempts){const n=by.get(x.node);if(!n)continue;n.a.push(x);(n.t[x.target]??=[]).push(x);(n.r[x.round]??=[]).push(x)}
 const results=[];
 for(const n of by.values()){
   const a=n.a,ok=a.filter(x=>x.success),to=a.filter(x=>x.timeout),p95=pct(a,.95);
   const targets=Object.fromEntries(Object.entries(n.t).map(([id,v])=>{const s=v.filter(x=>x.success).length;return[id,{attempts:v.length,successes:s,failures:v.length-s,successRate:s/v.length,timeoutRate:v.filter(x=>x.timeout).length/v.length,p95Latency:pct(v,.95)}]}));
   const rounds=Object.fromEntries(Object.entries(n.r).map(([id,v])=>{const s=v.filter(x=>x.success).length;return[id,{attempts:v.length,successes:s,successRate:s/v.length,timeoutCount:v.filter(x=>x.timeout).length}]}));
   const sr=ok.length/a.length, targetPass=Object.values(targets).every(x=>x.successRate>=MIN_TARGET_SUCCESS_RATE);
   const roundRates=Object.values(rounds).map(x=>x.successRate),roundPass=roundRates.length===ROUNDS&&roundRates.every(x=>x>=MIN_ROUND_SUCCESS_RATE);
   const eligible=sr>=MIN_SUCCESS_RATE&&targetPass&&roundPass&&maxRun(a,x=>!x.success)<=MAX_CONSECUTIVE_FAILURES&&maxRun(a,x=>x.timeout)<=MAX_CONSECUTIVE_TIMEOUTS&&(p95==null||p95<=P95_LIMIT);
   results.push({name:n.name,fingerprint:n.fingerprint,attempts:a.length,successes:ok.length,failures:a.length-ok.length,timeouts:to.length,successRate:sr,timeoutRate:to.length/a.length,
     maxConsecutiveFailures:maxRun(a,x=>!x.success),maxConsecutiveTimeouts:maxRun(a,x=>x.timeout),p50Latency:pct(a,.5),p95Latency:p95,p99Latency:pct(a,.99),maxLatency:ok.length?Math.max(...ok.map(x=>x.delayMs)):null,targetStats:targets,roundStats:rounds,eligible})
 }
 const report={generatedAt:new Date().toISOString(),version:'stability-v1',config,provisionalBestCount:nodes.length,stabilityPassCount:results.filter(x=>x.eligible).length,results};
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

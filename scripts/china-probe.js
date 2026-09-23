#!/usr/bin/env node
'use strict';

const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const net=require('net');
const yaml=require('js-yaml');
const {runConcurrent,probeDelay}=require('./lib/probe-runner');
const {summarizeAttempts}=require('./lib/probe-stability');

const CONFIG={
  candidateFile:process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json',
  stableFile:process.env.CHINA_STABLE_FILE||'subscriptions/stable.yaml',
  stableUrl:process.env.CHINA_STABLE_URL||'',
  observationFile:process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json',
  observationDir:process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations',
  mihomoBin:process.env.MIHOMO_BIN||'mihomo',
  api:process.env.MIHOMO_API||'http://127.0.0.1:19090',
  mixedPort:Number(process.env.CHINA_PROBE_PORT||17890),
  target:process.env.CHINA_PROBE_TARGET||'https://www.google.com/generate_204',
  expected:process.env.CHINA_PROBE_EXPECTED||'204',
  timeout:Number(process.env.CHINA_PROBE_TIMEOUT||8000),
  concurrency:Number(process.env.CHINA_PROBE_CONCURRENCY||8),
  reachabilityTimeout:Number(process.env.CHINA_REACHABILITY_TIMEOUT||3000),
  fastTimeout:Number(process.env.CHINA_STAGE1_TIMEOUT||5000),
  deepRounds:Number(process.env.CHINA_DEEP_ROUNDS||2),
  stabilityRounds:Number(process.env.CHINA_STABILITY_ROUNDS||3),
  stabilityAttempts:Number(process.env.CHINA_STABILITY_ATTEMPTS||6),
  stabilityTimeout:Number(process.env.CHINA_STABILITY_TIMEOUT||5000),
  stabilityConcurrency:Number(process.env.CHINA_STABILITY_CONCURRENCY||8),
  stabilityMinSuccessRate:Number(process.env.CHINA_STABILITY_MIN_SUCCESS_RATE||0.9),
  stabilityMinTargetSuccessRate:Number(process.env.CHINA_STABILITY_MIN_TARGET_SUCCESS_RATE||0.67),
  stabilityMinRoundSuccessRate:Number(process.env.CHINA_STABILITY_MIN_ROUND_SUCCESS_RATE||0.67),
  stabilityP95:Number(process.env.CHINA_STABILITY_P95_LIMIT||5000),
  stabilityMaxConsecutiveFailures:Number(process.env.CHINA_STABILITY_MAX_CONSECUTIVE_FAILURES||1),
  stabilityMaxConsecutiveTimeouts:Number(process.env.CHINA_STABILITY_MAX_CONSECUTIVE_TIMEOUTS||1),
  environment:process.env.CHINA_PROBE_ENV||os.hostname(),
};

function now(){return new Date().toISOString()}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function fetchText(url){const r=await fetch(url);if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}
async function apiJson(url,opts){const r=await fetch(url,opts);const t=await r.text();if(!r.ok)throw new Error('API '+r.status+' '+t.slice(0,200));return JSON.parse(t)}

function tcpReachability(proxy,timeout){
  return new Promise(resolve=>{
    const started=Date.now();
    const socket=net.createConnection({host:String(proxy.server),port:Number(proxy.port)});
    let settled=false;
    const finish=(success,error=null)=>{
      if(settled)return;
      settled=true;
      socket.destroy();
      resolve({success,latencyMs:success?Date.now()-started:null,error,timeout:error==='timeout'});
    };
    socket.setTimeout(timeout,()=>finish(false,'timeout'));
    socket.once('connect',()=>finish(true));
    socket.once('error',e=>finish(false,String(e.message||e).slice(0,300)));
  });
}

async function loadStable(){
  const text=CONFIG.stableUrl?await fetchText(CONFIG.stableUrl):fs.readFileSync(CONFIG.stableFile,'utf8');
  const d=yaml.load(text);
  if(!Array.isArray(d?.proxies))throw new Error('stable pool has no proxies');
  return d.proxies.filter(p=>p&&p.name&&p.server&&p.port&&p.type);
}

function endpointId(p){
  if(p['endpoint-id'])return p['endpoint-id'];
  const crypto=require('crypto');
  const t=String(p.type||'').toLowerCase();
  const auth=t==='shadowsocks'?[p.cipher||'',p.password||'']:t==='vmess'||t==='vless'?[p.uuid||'']:[p.password||''];
  const ws=p['ws-opts']||{},grpc=p['grpc-opts']||{},r=p['reality-opts']||{};
  return crypto.createHash('sha256').update(JSON.stringify([
    t,String(p.server).toLowerCase(),Number(p.port),auth,p.network||'tcp',
    {wsPath:ws.path||'',wsHost:ws.headers?.Host||'',grpcService:grpc['grpc-service-name']||''},
    p.tls?'tls':'plain',p.sni||'',p.flow||'',r['public-key']||'',r['short-id']||''
  ])).digest('hex').slice(0,16);
}

function configFor(proxies){
  return {
    'mixed-port':CONFIG.mixedPort,
    'external-controller':'127.0.0.1:19090',
    'allow-lan':false,
    mode:'rule',
    'log-level':'warning',
    ipv6:false,
    proxies,
    'proxy-groups':[{
      name:'CHINA-PROBE',
      type:'select',
      proxies:proxies.map(p=>p.name),
    }],
    rules:['MATCH,CHINA-PROBE'],
  };
}

async function waitApi(){
  for(let i=0;i<30;i++){
    try{await apiJson(CONFIG.api+'/version');return}
    catch{await sleep(500)}
  }
  throw new Error('mihomo API did not become ready');
}

async function main(){
  const stable=await loadStable();
  const selected=[];
  let candidates=null;
  try{
    candidates=JSON.parse(fs.readFileSync(CONFIG.candidateFile,'utf8')).candidates;
  }catch{}
  if(!Array.isArray(candidates))throw new Error('China candidate file missing or invalid; refusing to probe all Stable nodes');
  const wanted=new Set(candidates.map(x=>x.endpointId).filter(Boolean));
  if(!wanted.size)throw new Error('China candidate file contains no endpoint IDs');
  for(const p of stable){
    if(wanted.has(endpointId(p)))selected.push(p);
  }
  if(!selected.length)throw new Error('candidate IDs do not match current Stable pool');

  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nodeprobe-china-'));
  const configPath=path.join(dir,'config.yaml');
  fs.writeFileSync(configPath,yaml.dump(configFor(selected),{noRefs:true,lineWidth:-1}));

  const child=spawn(CONFIG.mihomoBin,['-d',dir,'-f',configPath],{stdio:['ignore','pipe','pipe']});
  let stderr='';
  child.stderr.on('data',d=>{stderr+=d.toString()});
  child.stdout.on('data',()=>{});

  try{
    await waitApi();
    const observations=[];
    const traces=new Map(selected.map(p=>[endpointId(p),[]]));

    // Stage 0 measures China -> endpoint reachability only. It deliberately does
    // not use Mihomo or an Internet target, so the result is not contaminated by
    // endpoint -> target performance.
    const reachability=await runConcurrent(selected,async p=>{
      const result=await tcpReachability(p,CONFIG.reachabilityTimeout);
      const row={
        endpointId:endpointId(p),
        at:now(),
        success:result.success,
        latencyMs:result.latencyMs,
        error:result.error,
        timeout:result.timeout,
        probeEnvironment:CONFIG.environment,
        stage:'reachability',
        finishedAt:now(),
      };
      traces.get(row.endpointId).push(row);
      observations.push(row);
      return row;
    },CONFIG.concurrency);
    const reachable=new Set(reachability.filter(x=>x.success).map(x=>x.endpointId));

    async function runStage(proxies,timeout,stage){
      const rows=await runConcurrent(proxies,async p=>{
        const result=await probeDelay({
          api:CONFIG.api,
          name:p.name,
          target:CONFIG.target,
          expected:CONFIG.expected,
          timeout,
        });
        const observation={
          endpointId:endpointId(p),
          at:result.startedAt,
          success:result.success,
          latencyMs:result.delayMs,
          error:result.error,
          timeout:result.timeout,
          probeEnvironment:CONFIG.environment,
          stage,
          finishedAt:result.finishedAt,
        };
        traces.get(observation.endpointId).push(observation);
        return observation;
      },CONFIG.concurrency);
      observations.push(...rows);
      return rows;
    }

    // Stage 1 measures the actual direct proxy path: China -> node -> target.
    // This is intentionally separate from Stage 0 reachability.
    const reachableProxies=selected.filter(p=>reachable.has(endpointId(p)));
    const stage1=await runStage(reachableProxies,CONFIG.fastTimeout,'direct-stage1-fast');
    const firstPass=reachableProxies.filter((p,i)=>stage1[i].success);
    const firstFail=reachableProxies.filter((p,i)=>!stage1[i].success);

    // A single timeout/transport failure is not enough to discard a candidate.
    const retry=await runStage(firstFail,CONFIG.timeout,'stage1-retry');
    const retryPass=new Set(retry.filter(x=>x.success).map(x=>x.endpointId));
    const survivors=[...firstPass,...firstFail.filter(p=>retryPass.has(endpointId(p)))];

    // Stage 2: normal-timeout confirmation for Stage-1 survivors.
    const stage2=await runStage(survivors,CONFIG.timeout,'stage2');
    let deep=survivors.filter((p,i)=>stage2[i].success);

    // Deep rounds provide repeated evidence rather than changing China trust directly.
    for(let round=1;round<=CONFIG.deepRounds;round++){
      const result=await runStage(deep,CONFIG.timeout,'deep-round-'+round);
      deep=deep.filter((p,i)=>result[i].success);
      if(!deep.length)break;
    }

    // Stability confirmation reuses the same multi-round metrics as Global, but
    // runs from the China environment and produces China-only evidence.
    const stabilityTargets=[
      {id:'google',url:'https://www.google.com/generate_204',expected:'204'},
      {id:'cloudflare',url:'https://www.cloudflare.com/cdn-cgi/trace',expected:'200'},
      {id:'github',url:'https://github.com/',expected:'200'},
    ];
    const stabilityAttempts=[];
    const stabilityCandidates=deep.slice();
    const perRound=CONFIG.stabilityAttempts/CONFIG.stabilityRounds;
    if(!Number.isInteger(perRound))throw new Error('CHINA_STABILITY_ATTEMPTS must divide evenly by CHINA_STABILITY_ROUNDS');
    for(let round=1;round<=CONFIG.stabilityRounds;round++){
      const jobs=[];
      for(const p of stabilityCandidates){
        for(const target of [...stabilityTargets].sort(()=>Math.random()-.5)){
          for(let attempt=1;attempt<=perRound;attempt++)jobs.push({p,target,attempt});
        }
      }
      const rows=await runConcurrent(jobs,async j=>{
        const result=await probeDelay({api:CONFIG.api,name:j.p.name,target:j.target.url,expected:j.target.expected,timeout:CONFIG.stabilityTimeout});
        const row={endpointId:endpointId(j.p),at:result.startedAt,success:result.success,latencyMs:result.delayMs,error:result.error,timeout:result.timeout,probeEnvironment:CONFIG.environment,stage:'stability-round-'+round,target:j.target.id,round,finishedAt:result.finishedAt};
        traces.get(row.endpointId).push(row);
        return row;
      },CONFIG.stabilityConcurrency);
      stabilityAttempts.push(...rows);
    }
    const stabilityById=new Map(stabilityCandidates.map(p=>[endpointId(p),[]]));
    for(const x of stabilityAttempts)stabilityById.get(x.endpointId)?.push(x);
    const stabilityResults=stabilityCandidates.map(p=>{
      const id=endpointId(p);
      return {endpointId:id,...summarizeAttempts(stabilityById.get(id)||[],stabilityTargets,CONFIG.stabilityRounds,{minSuccessRate:CONFIG.stabilityMinSuccessRate,minTargetSuccessRate:CONFIG.stabilityMinTargetSuccessRate,minRoundSuccessRate:CONFIG.stabilityMinRoundSuccessRate,maxConsecutiveFailures:CONFIG.stabilityMaxConsecutiveFailures,maxConsecutiveTimeouts:CONFIG.stabilityMaxConsecutiveTimeouts,p95Latency:CONFIG.stabilityP95})};
    });
    const stableIds=new Set(stabilityResults.filter(x=>x.eligible).map(x=>x.endpointId));

    // Stage attempts are detailed evidence. Only one final observation per node
    // is applied to the China asset, so several stages in one probe run do not
    // artificially inflate observedRuns or China trust.
    const finalObservations=selected.map(p=>{
      const id=endpointId(p);
      const trace=traces.get(id)||[];
      const last=trace[trace.length-1];
      const reachabilityAttempt=trace.find(x=>x.stage==='reachability');
      const directAttempts=trace.filter(x=>/^direct-stage1-fast|stage1-retry|stage2|deep-round-/.test(x.stage));
      const directSuccess=directAttempts.some(x=>x.success);
      const stability=stabilityById.has(id)?stabilityResults.find(x=>x.endpointId===id)||null:null;
      return {
        endpointId:id,
        at:trace[0]?.at||now(),
        success:Boolean(last?.success)&&(!stabilityById.has(id)||stableIds.has(id)),
        reachabilitySuccess:Boolean(reachabilityAttempt?.success),
        reachabilityLatencyMs:reachabilityAttempt?.latencyMs??null,
        directSuccess,
        stabilityEligible:stability?.eligible??null,
        latencyMs:last?.latencyMs??null,
        error:last?.error||null,
        timeout:Boolean(last?.timeout),
        probeEnvironment:CONFIG.environment,
        stage:last?.stage||null,
        successfulStages:trace.filter(x=>x.success).map(x=>x.stage),
        failedStages:trace.filter(x=>!x.success).map(x=>x.stage),
        attemptCount:trace.length,
        stability,
      };
    });

    const probeRunId=now();
    const payload={
      version:3,
      generatedAt:probeRunId,
      probeRunId,
      probeEnvironment:CONFIG.environment,
      target:CONFIG.target,
      expected:CONFIG.expected,
      stages:{reachabilityTimeout:CONFIG.reachabilityTimeout,stage1Timeout:CONFIG.fastTimeout,deepRounds:CONFIG.deepRounds,stabilityRounds:CONFIG.stabilityRounds,stabilityAttempts:CONFIG.stabilityAttempts},
      observations:finalObservations,
      attempts:observations,
      stabilityResults,
    };

    console.log(JSON.stringify({
      candidates:selected.length,
      reachable:reachable.size,
      directCandidates:reachableProxies.length,
      stage1Pass:firstPass.length,
      stage1RetryPass:retryPass.size,
      stage2Pass:stage2.filter(x=>x.success).length,
      deepPass:deep.length,
      attempts:observations.length,
      finalObservations:finalObservations.length,
      target:CONFIG.target,
      environment:CONFIG.environment,
    },null,2));

    fs.mkdirSync(path.dirname(CONFIG.observationFile),{recursive:true});
    fs.writeFileSync(CONFIG.observationFile,JSON.stringify(payload,null,2)+'\n');
    fs.mkdirSync(CONFIG.observationDir,{recursive:true});
    const safeEnv=CONFIG.environment.replace(/[^A-Za-z0-9._-]+/g,'_');
    const batchFile=path.join(CONFIG.observationDir,`${new Date().toISOString().replace(/[:.]/g,'-')}-${safeEnv}.json`);
    fs.writeFileSync(batchFile,JSON.stringify(payload,null,2)+'\n');

    console.log(JSON.stringify({
      candidates:selected.length,
      successes:finalObservations.filter(x=>x.success).length,
      failures:finalObservations.filter(x=>!x.success).length,
      target:CONFIG.target,
      environment:CONFIG.environment,
      observationFile:CONFIG.observationFile,
      batchFile,
    },null,2));
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if(!child.killed)child.kill('SIGKILL');
    if(stderr.trim())console.error(stderr.slice(-2000));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

main().catch(e=>{console.error(e);process.exit(1)});

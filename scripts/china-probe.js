#!/usr/bin/env node
'use strict';

const fs=require('fs');
const os=require('os');
const path=require('path');
const {spawn}=require('child_process');
const yaml=require('js-yaml');

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
  environment:process.env.CHINA_PROBE_ENV||os.hostname(),
};

function now(){return new Date().toISOString()}
async function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
async function fetchText(url){const r=await fetch(url);if(!r.ok)throw new Error('HTTP '+r.status);return r.text()}
async function apiJson(url,opts){const r=await fetch(url,opts);const t=await r.text();if(!r.ok)throw new Error('API '+r.status+' '+t.slice(0,200));return JSON.parse(t)}

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
    const observations=new Array(selected.length);
    let nextIndex=0;
    async function probeOne(index){
      const p=selected[index];
      const at=now();
      try{
        const q=new URLSearchParams({
          url:CONFIG.target,
          timeout:String(CONFIG.timeout),
          expected:CONFIG.expected,
        });
        const result=await apiJson(CONFIG.api+'/proxies/'+encodeURIComponent(p.name)+'/delay?'+q);
        const latencyMs=Number(result.delay);
        observations[index]={
          endpointId:endpointId(p),
          at,
          success:Number.isFinite(latencyMs)&&latencyMs>0,
          latencyMs:Number.isFinite(latencyMs)&&latencyMs>0?latencyMs:null,
          error:null,
          probeEnvironment:CONFIG.environment,
        };
      }catch(e){
        observations[index]={
          endpointId:endpointId(p),
          at,
          success:false,
          latencyMs:null,
          error:String(e&&e.message||e).slice(0,300),
          probeEnvironment:CONFIG.environment,
        };
      }
    }
    async function worker(){
      while(true){
        const index=nextIndex++;
        if(index>=selected.length)return;
        await probeOne(index);
      }
    }
    const workerCount=Math.min(Math.max(1,CONFIG.concurrency),selected.length);
    await Promise.all(Array.from({length:workerCount},()=>worker()));

    fs.mkdirSync(path.dirname(CONFIG.observationFile),{recursive:true});
    fs.writeFileSync(CONFIG.observationFile,JSON.stringify(observations,null,2)+'\n');
    fs.mkdirSync(CONFIG.observationDir,{recursive:true});
    const safeEnv=CONFIG.environment.replace(/[^A-Za-z0-9._-]+/g,'_');
    const batchFile=path.join(CONFIG.observationDir,`${new Date().toISOString().replace(/[:.]/g,'-')}-${safeEnv}.json`);
    fs.writeFileSync(batchFile,JSON.stringify({version:1,generatedAt:now(),probeEnvironment:CONFIG.environment,target:CONFIG.target,expected:CONFIG.expected,observations},null,2)+'\n');

    console.log(JSON.stringify({
      candidates:selected.length,
      successes:observations.filter(x=>x.success).length,
      failures:observations.filter(x=>!x.success).length,
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

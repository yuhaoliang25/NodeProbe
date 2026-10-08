#!/usr/bin/env node
'use strict';

const fs=require('fs');
const yaml=require('js-yaml');

function readJson(file,fallback=null){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}
}
function readYamlProxies(file){
  try{
    const d=yaml.load(fs.readFileSync(file,'utf8'));
    return Array.isArray(d?.proxies)?d.proxies.filter(p=>p&&p.name):[];
  }catch{return [];}
}
function countStates(nodes){
  return Object.values(nodes||{}).reduce((m,n)=>{
    const s=String(n?.state||'UNKNOWN');
    m[s]=(m[s]||0)+1;
    return m;
  },{});
}
function probeSummary(p){
  if(!p)return null;
  const obs=Array.isArray(p.observations)?p.observations:[];
  const attempts=Array.isArray(p.attempts)?p.attempts:[];
  const countStage=(stage,predicate=x=>x.success===true)=>attempts.filter(x=>x.stage===stage&&predicate(x)).length;
  const stageRows=(stage)=>attempts.filter(x=>x.stage===stage);
  const errorCounts=(stage)=>{
    const out={};
    for(const x of stageRows(stage)){
      if(x.success===true)continue;
      const key=String(x.error||'unknown').slice(0,160);
      out[key]=(out[key]||0)+1;
    }
    return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1]-a[1]).slice(0,10));
  };
  const errorKinds=(stage)=>{
    const out={};
    for(const x of stageRows(stage)){
      if(x.success===true)continue;
      const key=String(x.errorKind||'unknown');
      out[key]=(out[key]||0)+1;
    }
    return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1]-a[1]));
  };
  return {
    candidates:obs.length,
    reachable:obs.filter(x=>x.reachabilitySuccess===true).length,
    exitSuccess:obs.filter(x=>x.exitSuccess===true).length,
    stabilityEligible:obs.filter(x=>x.stabilityEligible===true).length,
    chatgptEligible:obs.filter(x=>x.chatgptEligible===true).length,
    success:obs.filter(x=>x.success===true).length,
    failures:obs.filter(x=>x.success!==true).length,
    attempts:attempts.length,
    stages:{
      stage1Fast:{attempts:stageRows('exit-stage1-fast').length,passed:countStage('exit-stage1-fast')},
      stage1Retry:{attempts:stageRows('stage1-retry').length,passed:countStage('stage1-retry')},
      stage2:{attempts:stageRows('stage2').length,passed:countStage('stage2')},
      deepRounds:Object.fromEntries([...new Set(attempts.map(x=>x.stage).filter(s=>String(s).startsWith('deep-round-')))]
        .sort()
        .map(stage=>[stage,{attempts:stageRows(stage).length,passed:countStage(stage)}])),
      stability:Object.fromEntries([...new Set(attempts.map(x=>x.stage).filter(s=>String(s).startsWith('stability-round-')))]
        .sort()
        .map(stage=>[stage,{attempts:stageRows(stage).length,passed:countStage(stage)}]))
    },
    failureReasons:{
      stage1Fast:errorCounts('exit-stage1-fast'),
      stage1Retry:errorCounts('stage1-retry'),
      stage2:errorCounts('stage2')
    },
    failureKinds:{
      stage1Fast:errorKinds('exit-stage1-fast'),
      stage1Retry:errorKinds('stage1-retry'),
      stage2:errorKinds('stage2')
    },
    deepPass:obs.filter(x=>Array.isArray(x.successfulStages) && x.successfulStages.some(s=>s.startsWith('deep-round-'))).length
  };
}

const assets=readJson(process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',{nodes:{}});
const candidates=readJson(process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json',{candidates:[]});
const probe=readJson(process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json',null);
const sticky=readJson(process.env.CHINA_STICKY_STATE_FILE||'data/china-sticky.json',{});
const eliteMeta=readJson('subscriptions/china-elite.json',{});
const pools=readJson('subscriptions/china-pools.json',{});
const pairPool=readJson('subscriptions/china-pair-pool.json',{});
const diagnostics={
  version:2,
  generatedAt:new Date().toISOString(),
  releaseId:process.env.CHINA_RELEASE_ID||null,
  environment:process.env.CHINA_PROBE_ENV||null,
  assets:{
    total:Object.keys(assets.nodes||{}).length,
    states:countStates(assets.nodes),
    trusted:Object.values(assets.nodes||{}).filter(n=>n?.state==='TRUSTED'&&n?.proxy).length
  },
  candidates:{
    total:Array.isArray(candidates.candidates)?candidates.candidates.length:0,
    categories:(candidates.candidates||[]).reduce((m,x)=>{const k=x.category||'unknown';m[k]=(m[k]||0)+1;return m;},{})
  },
  probe:probeSummary(probe),
  subscriptions:{
    exit:readYamlProxies('subscriptions/exit.yaml').length,
    elite:readYamlProxies('subscriptions/elite.yaml').length,
    chatgpt:readYamlProxies('subscriptions/chatgpt.yaml').length,
    sticky:readYamlProxies('subscriptions/sticky.yaml').length,
    pairs:readYamlProxies('subscriptions/pairs.yaml').length
  },
  selection:{
    stickyEligible:Number(sticky.candidateCount||0),
    stickySelected:sticky.endpointId||null,
    stickyReason:sticky.switchReason||null,
    stickyRetiredLegacyCount:Array.isArray(sticky.retiredEndpointIds)?sticky.retiredEndpointIds.length:0,
    eliteEligible:Number(eliteMeta.counts?.eligibleExits||0),
    eliteSelected:Number(eliteMeta.counts?.selectedPaths||0),
    chatgptEligible:Number(eliteMeta.counts?.chatgptEligibleExits||0),
    chatgptSelected:Number(eliteMeta.counts?.chatgptSelectedPaths||0),
    exitPool:Number(pools.counts?.exit||0),
    pairPool:Number(pairPool.counts?.pairs||0)
  }
};
fs.mkdirSync('data',{recursive:true});
fs.writeFileSync('data/china-diagnostics.json',JSON.stringify(diagnostics,null,2)+'\n');

// Raw probe observations are transient. The snapshot has already been summarized
// above; only processed batches are removed here. Unprocessed batches remain for
// crash recovery and are not uploaded to B2.
function cleanupTransient(stateFile, processedKey, dir){
  const state=readJson(stateFile,null);
  const processed=new Set(Array.isArray(state?.[processedKey])?state[processedKey]:[]);
  let removed=0;
  if(fs.existsSync(dir)){
    for(const name of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))){
      if(!processed.has(name))continue;
      try{fs.unlinkSync(require('path').join(dir,name));removed++;}catch{}
    }
  }
  return removed;
}
const cleanedObservationBatches=cleanupTransient(process.env.CHINA_ASSET_FILE||'data/china-node-assets.json','processedObservationBatches',process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations');
const cleanedPairObservationBatches=cleanupTransient(process.env.CHINA_PAIR_KNOWLEDGE_FILE||'data/china-pair-knowledge.json','processedBatches',process.env.CHINA_PAIR_OBSERVATION_DIR||'data/china-pair-observations');
try{fs.unlinkSync(process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json');}catch{}
try{fs.unlinkSync(process.env.CHINA_PAIR_OBSERVATION_FILE||'data/china-pair-observations.json');}catch{}
console.log(`[china] diagnostics: assets= assets=${diagnostics.assets.total} candidates=${diagnostics.candidates.total} probe=${diagnostics.probe?.candidates??0} reachable=${diagnostics.probe?.reachable??0} stability=${diagnostics.probe?.stabilityEligible??0} exit=${diagnostics.subscriptions.exit} elite=${diagnostics.subscriptions.elite} chatgpt=${diagnostics.subscriptions.chatgpt} pairs=${diagnostics.subscriptions.pairs}`);

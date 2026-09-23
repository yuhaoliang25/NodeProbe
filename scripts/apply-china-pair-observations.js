#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const C={
  observationFile:process.env.CHINA_PAIR_OBSERVATION_FILE||'data/china-pair-observations.json',
  observationDir:process.env.CHINA_PAIR_OBSERVATION_DIR||'data/china-pair-observations',
  stateFile:process.env.CHINA_PAIR_KNOWLEDGE_FILE||'data/china-pair-knowledge.json',
  retention:Number(process.env.CHINA_PAIR_OBSERVATION_RETENTION||30),
  batchRetention:Number(process.env.CHINA_PAIR_BATCH_RETENTION||1000),
  appliedObservationRetention:Number(process.env.CHINA_PAIR_APPLIED_OBSERVATION_RETENTION||5000),
};
function now(){return new Date().toISOString()}
function loadState(){try{return JSON.parse(fs.readFileSync(C.stateFile,'utf8'))}catch{return {version:1,pairs:{},processedBatches:[]}}}
function loadBatches(){
  const out=[];
  // Only batch files are persistent observation inbox entries. The single
  // observationFile is a local latest-run snapshot and must not be re-applied
  // by the state updater on every workflow run.
  try{
    for(const f of fs.readdirSync(C.observationDir).filter(x=>x.endsWith('.json')).sort()){
      const data=JSON.parse(fs.readFileSync(path.join(C.observationDir,f),'utf8'));
      if(!data || typeof data!=='object'){
        throw new Error('invalid China pair observation batch: '+f);
      }
      out.push({name:f,data});
    }
  }catch{}
  return out;
}
function pairKey(x){return x.pairId||crypto.createHash('sha256').update(String(x.relayEndpointId)+'|'+String(x.landingEndpointId)).digest('hex').slice(0,16)}
function observationId(x,batchName){
  return crypto.createHash('sha256').update(JSON.stringify([
    batchName||null,x.pairId||null,x.relayEndpointId||null,x.landingEndpointId||null,
    x.at||null,Boolean(x.success),x.latencyMs??null,x.baselineLatencyMs??null,Boolean(x.improved),
  ])).digest('hex');
}
function apply(){
  const state=loadState();const seen=new Set(state.processedBatches||[]);const appliedIds=new Set(state.appliedObservationIds||[]);let applied=0;
  for(const b of loadBatches()){
    if(b.name&&seen.has(b.name))continue;
    const d=b.data||{};
    const screen=Array.isArray(d.screen)?d.screen:[];
    const accepted=Array.isArray(d.accepted)?d.accepted:[];
    const acceptedMap=new Map(accepted.map(x=>[x.pairId,x]));
    const pairConfigs=new Map((Array.isArray(d.pairs)?d.pairs:[]).map(x=>[x.pairId,x]));
    for(const x of screen){
      const id=observationId(x,b.name);
      if(appliedIds.has(id))continue;
      const key=pairKey(x);
      const cfg=pairConfigs.get(x.pairId)||{};
      const p=state.pairs[key]||{pairId:key,relayEndpointId:x.relayEndpointId,landingEndpointId:x.landingEndpointId,relay:cfg.relay||null,landing:cfg.landing||null,observations:[]};
      p.relay=cfg.relay||p.relay||null;p.landing=cfg.landing||p.landing||null;
      p.lastObservedAt=x.at||d.generatedAt||now();
      p.lastScreenLatencyMs=x.latencyMs??null;
      p.lastBaselineLatencyMs=x.baselineLatencyMs??null;
      p.lastImprovement=Boolean(x.improved);
      p.observations.push({
        at:x.at||d.generatedAt||now(),
        success:Boolean(x.success),
        screenLatencyMs:x.latencyMs??null,
        baselineLatencyMs:x.baselineLatencyMs??null,
        improvement:x.improved&&x.baselineLatencyMs&&x.latencyMs?1-x.latencyMs/x.baselineLatencyMs:null,
        improved:Boolean(x.improved),
        confirmationSuccessRate:acceptedMap.get(x.pairId)?.confirmationSuccessRate??null,
        confirmationAttempts:acceptedMap.get(x.pairId)?.confirmationAttempts??0,
        confirmed:Boolean(acceptedMap.get(x.pairId)),
        environment:d.probeEnvironment||'china-default'
      });
      p.observations=p.observations.slice(-C.retention);
      if(x.success&&x.improved){p.successes=(p.successes||0)+1;p.lastSuccessAt=p.lastObservedAt;}
      p.lastScreenSuccess=Boolean(x.success);p.lastImproved=Boolean(x.improved);
      state.pairs[key]=p;applied++;appliedIds.add(id);
    }
    if(b.name)seen.add(b.name);
  }
  state.version=1;state.generatedAt=now();state.processedBatches=[...seen].slice(-C.batchRetention);
  state.appliedObservationIds=[...appliedIds].slice(-C.appliedObservationRetention);
  fs.mkdirSync(path.dirname(C.stateFile),{recursive:true});fs.writeFileSync(C.stateFile,JSON.stringify(state,null,2)+'\n');
  console.log(JSON.stringify({applied,pairs:Object.keys(state.pairs).length,stateFile:C.stateFile},null,2));
}
apply();

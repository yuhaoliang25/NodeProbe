#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {loadState,saveState,updateNode}=require('./china-node-asset');

const CONFIG={
  candidateFile:process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json',
  observationFile:process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json',
  observationDir:process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations',
  assetFile:process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',
  environment:process.env.CHINA_PROBE_ENV||'china-default',
  appliedRetention:Number(process.env.CHINA_APPLIED_OBSERVATION_RETENTION||5000),
  batchRetention:Number(process.env.CHINA_APPLIED_BATCH_RETENTION||1000),
};

function now(){return new Date().toISOString()}
function observationId(o){
  return crypto.createHash('sha256').update(JSON.stringify([
    o.endpointId,o.at,o.probeEnvironment||CONFIG.environment,
    Boolean(o.success),o.latencyMs==null?null:Number(o.latencyMs),o.error||null,
  ])).digest('hex');
}

function loadObservations(){
  const out=[];
  try{
    const d=JSON.parse(fs.readFileSync(CONFIG.observationFile,'utf8'));
    if(Array.isArray(d))out.push(...d.map(observation=>({observation,batchName:null})));
    else if(Array.isArray(d?.observations)){
      out.push(...d.observations.map(observation=>({observation,batchName:null})));
    }
  }catch{}
  try{
    for(const file of fs.readdirSync(CONFIG.observationDir).filter(x=>x.endsWith('.json')).sort()){
      try{
        const d=JSON.parse(fs.readFileSync(path.join(CONFIG.observationDir,file),'utf8'));
        const observations=Array.isArray(d)?d:d?.observations;
        if(Array.isArray(observations)){
          out.push(...observations.map(observation=>({observation,batchName:file})));
        }
      }catch{}
    }
  }catch{}
  return out;
}

/*
 * Observation application is intentionally separate from network probing.
 * A China-side agent can produce the observation file and then call this
 * updater. No Global Node Pool or Global Node lifecycle state is consulted here.
 */
function apply(){
  const observations=loadObservations();
  const state=loadState();
  const appliedIds=new Set(Array.isArray(state.appliedObservationIds)?state.appliedObservationIds:[]);
  const processedBatches=new Set(Array.isArray(state.processedObservationBatches)?state.processedObservationBatches:[]);
  const at=now();

  let applied=0;
  const batchesSeen=new Set();
  for(const item of observations){
    const o=item.observation;
    if(!o||!o.endpointId||typeof o.success!=='boolean')continue;
    if(item.batchName)batchesSeen.add(item.batchName);
    const id=observationId(o);
    if(appliedIds.has(id))continue;
    // Observations are authoritative evidence from the China probe agent.
    // Candidate files are scheduling artifacts and may be absent or stale on cold start;
    // do not make lifecycle application depend on the next candidate feed.
    let node=state.nodes[o.endpointId];
    if(!node){
      node={
        endpointId:o.endpointId,
        proxy:o.proxy||null,
        firstObservedAt:o.at||at,
        lastObservedAt:null,
        observedRuns:0,
        successes:0,
        failures:0,
        recentSuccesses:0,
        recentFailures:0,
        successStreak:0,
        failureStreak:0,
        lastSuccessAt:null,
        lastFailureAt:null,
        lastProbeAt:null,
        state:'NEW',
        deadSince:null,
        recheckLevel:0,
        nextProbeAt:at,
        observations:[],
      };
      state.nodes[o.endpointId]=node;
    }
    updateNode(node,{
      at:o.at||at,
      proxy:o.proxy||null,
      success:o.success,
      latencyMs:o.latencyMs,
      error:o.error,
      probeEnvironment:o.probeEnvironment||CONFIG.environment,
      reachabilitySuccess:o.reachabilitySuccess,
      reachabilityLatencyMs:o.reachabilityLatencyMs,
      directSuccess:o.directSuccess,
      stabilityEligible:o.stabilityEligible,
    });
    applied++;
    appliedIds.add(id);
  }

  for(const batchName of batchesSeen)processedBatches.add(batchName);
  state.appliedObservationIds=[...appliedIds].slice(-CONFIG.appliedRetention);
  state.processedObservationBatches=[...processedBatches].slice(-CONFIG.batchRetention);
  state.lastObservationApplyAt=at;
  state.lastObservationCount=applied;
  saveState(state);

  console.log(JSON.stringify({
    observations:observations.length,
    applied,
    processedBatches:[...batchesSeen],
    assetFile:CONFIG.assetFile,
  },null,2));
}

if(require.main===module)apply();
module.exports={apply};

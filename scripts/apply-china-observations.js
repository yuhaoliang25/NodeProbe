#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const {loadState,saveState,updateNode}=require('./china-node-asset');

const CONFIG={
  candidateFile:process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json',
  observationFile:process.env.CHINA_OBSERVATION_FILE||'data/china-probe-observations.json',
  assetFile:process.env.CHINA_ASSET_FILE||'data/china-node-assets.json',
  environment:process.env.CHINA_PROBE_ENV||'china-default',
};

function now(){return new Date().toISOString()}

function loadCandidates(){
  const d=JSON.parse(fs.readFileSync(CONFIG.candidateFile,'utf8'));
  return Array.isArray(d?.candidates)?d.candidates:[];
}

function loadObservations(){
  try{
    const d=JSON.parse(fs.readFileSync(CONFIG.observationFile,'utf8'));
    return Array.isArray(d)?d:[];
  }catch{return []}
}

/*
 * Observation application is intentionally separate from network probing.
 * A China-side agent can produce the observation file and then call this
 * updater. No Global reputation is consulted here.
 */
function apply(){
  const observations=loadObservations();
  const state=loadState();
  const at=now();

  let applied=0;
  for(const o of observations){
    if(!o||!o.endpointId||typeof o.success!=='boolean')continue;
    let node=state.nodes[o.endpointId];
    if(!node){
      node={
        endpointId:o.endpointId,
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
        globalStableObservedAt:null,
        observations:[],
      };
      state.nodes[o.endpointId]=node;
    }
    updateNode(node,{
      at:o.at||at,
      success:o.success,
      latencyMs:o.latencyMs,
      error:o.error,
      probeEnvironment:o.probeEnvironment||CONFIG.environment,
    });
    applied++;
  }

  state.lastObservationApplyAt=at;
  state.lastObservationCount=applied;
  saveState(state);

  console.log(JSON.stringify({
    observations:observations.length,
    applied,
    assetFile:CONFIG.assetFile,
  },null,2));
}

if(require.main===module)apply();
module.exports={apply};

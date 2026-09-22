#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const BUCKET=process.env.CHINA_B2_BUCKET||'nodeprobe';
const PREFIX=process.env.CHINA_B2_PREFIX||'nodeprobe-state/china';
const OBS_REMOTE=PREFIX+'/observations';
const OBS_DIR=process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations';
const ASSET_FILE=process.env.CHINA_ASSET_FILE||'data/china-node-assets.json';

function run(args){
  const r=spawnSync(process.env.B2_BIN||'b2v4',args,{encoding:'utf8',env:process.env});
  if(r.error)throw r.error;
  if(r.status!==0){
    process.stderr.write(r.stderr||'');
    process.exit(r.status||1);
  }
  return r.stdout||'';
}

function processedBatches(){
  try{
    const state=JSON.parse(fs.readFileSync(ASSET_FILE,'utf8'));
    return new Set(Array.isArray(state.processedObservationBatches)
      ? state.processedObservationBatches : []);
  }catch{
    return new Set();
  }
}

function listRemote(){
  const stdout=run(['ls','b2://'+BUCKET+'/'+OBS_REMOTE]);
  return stdout.split(/\r?\n/)
    .map(x=>x.trim())
    .filter(Boolean)
    .filter(x=>x.endsWith('.json'))
    .map(x=>x.includes('/')?x.slice(x.lastIndexOf('/')+1):x);
}

function pull(){
  fs.mkdirSync(OBS_DIR,{recursive:true});
  const processed=processedBatches();
  const remoteFiles=listRemote();
  let downloaded=0;
  for(const file of remoteFiles){
    if(processed.has(file))continue;
    const remote=OBS_REMOTE+'/'+file;
    const local=path.join(OBS_DIR,file);
    run(['file','download','b2://'+BUCKET+'/'+remote,local]);
    downloaded++;
  }
  console.log(JSON.stringify({
    remoteBatches:remoteFiles.length,
    alreadyProcessed:processed.size,
    downloaded,
    observationDir:OBS_DIR,
  },null,2));
}

if(require.main===module){
  if(process.argv[2]!=='pull-observations'){
    console.error('usage: node scripts/pull-china-observations.js pull-observations');
    process.exit(2);
  }
  pull();
}

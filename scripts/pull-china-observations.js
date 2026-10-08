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
const B2_LIST_TIMEOUT_MS=Number(process.env.CHINA_B2_LIST_TIMEOUT_MS||15000);
const B2_DOWNLOAD_TIMEOUT_MS=Number(process.env.CHINA_B2_DOWNLOAD_TIMEOUT_MS||60000);
const RECOVERY_WINDOW_HOURS=Number(process.env.CHINA_OBSERVATION_RECOVERY_WINDOW_HOURS||48);

function run(args,timeout){ 
  const r=spawnSync(process.env.B2_BIN||'b2v4',args,{
    encoding:'utf8',
    env:process.env,
    timeout,
  });
  if(r.error){
    if(r.error.code==='ETIMEDOUT'){
      throw new Error(`B2 command timed out after ${timeout}ms: ${args.join(' ')}`);
    }
    throw r.error;
  }
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
  console.log(`[china-observations] listing B2 observation batches (timeout=${B2_LIST_TIMEOUT_MS}ms)...`);
  const stdout=run(['ls','b2://'+BUCKET+'/'+OBS_REMOTE],B2_LIST_TIMEOUT_MS);
  console.log('[china-observations] B2 observation listing completed.');
  return stdout.split(/\r?\n/)
    .map(x=>x.trim())
    .filter(Boolean)
    .filter(x=>x.endsWith('.json'))
    .map(x=>x.includes('/')?x.slice(x.lastIndexOf('/')+1):x);
}

function batchTimestamp(file){
  const match=file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:-\d{3})?Z)-/);
  if(!match)return null;
  const normalized=match[1].replace(/-(\d{3})Z$/,'.$1Z');
  const time=Date.parse(normalized);
  return Number.isFinite(time)?time:null;
}

function pull(){
  fs.mkdirSync(OBS_DIR,{recursive:true});
  const processed=processedBatches();
  const remoteFiles=listRemote();
  const cutoff=Date.now()-RECOVERY_WINDOW_HOURS*60*60*1000;
  let downloaded=0;
  let skippedOld=0;
  for(const file of remoteFiles){
    if(processed.has(file))continue;
    const timestamp=batchTimestamp(file);
    if(timestamp!==null && timestamp<cutoff){
      skippedOld++;
      continue;
    }
    const remote=OBS_REMOTE+'/'+file;
    const local=path.join(OBS_DIR,file);
    console.log(`[china-observations] downloading ${file}...`);
    run(['file','download','b2://'+BUCKET+'/'+remote,local],B2_DOWNLOAD_TIMEOUT_MS);
    downloaded++;
    console.log(`[china-observations] recovered ${file}`);
  }
  console.log(JSON.stringify({
    remoteBatches:remoteFiles.length,
    alreadyProcessed:processed.size,
    downloaded,
    skippedOld,
    recoveryWindowHours:RECOVERY_WINDOW_HOURS,
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

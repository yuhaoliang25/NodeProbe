#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const BUCKET=process.env.CHINA_B2_BUCKET||'nodeprobe';
const PREFIX=process.env.CHINA_B2_PREFIX||'nodeprobe-state/china';
const STABLE_REMOTE=process.env.CHINA_STABLE_REMOTE||'nodeprobe-state/china/stable.yaml';
const STABLE_LOCAL=process.env.CHINA_STABLE_FILE||'subscriptions/stable.yaml';
const CANDIDATE_REMOTE=PREFIX+'/candidates.json';
const OBS_REMOTE=PREFIX+'/observations';
const CANDIDATE_LOCAL=process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json';
const OBS_DIR=process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations';
const PAIR_CANDIDATE_REMOTE=PREFIX+'/pair-candidates.json';
const PAIR_CANDIDATE_LOCAL=process.env.CHINA_RELAY_CANDIDATE_FILE||'data/china-relay-pair-candidates.json';
const PAIR_OBS_REMOTE=PREFIX+'/pair-observations';
const PAIR_OBS_DIR=process.env.CHINA_PAIR_OBSERVATION_DIR||'data/china-pair-observations';

function run(args){
  const r=spawnSync(process.env.B2_BIN||'b2v4',args,{stdio:'inherit',env:process.env});
  if(r.error)throw r.error;
  if(r.status!==0)process.exit(r.status||1);
}
function usage(){
  console.log('usage: node scripts/china-b2-sync.js pull-stable | pull-candidates | push-observations | pull-pair-candidates | push-pair-observations');
}
const mode=process.argv[2];
if(mode==='pull-stable'){
  fs.mkdirSync(path.dirname(STABLE_LOCAL),{recursive:true});
  run(['file','download','b2://'+BUCKET+'/'+STABLE_REMOTE,STABLE_LOCAL]);
}else if(mode==='pull-candidates'){
  fs.mkdirSync(path.dirname(CANDIDATE_LOCAL),{recursive:true});
  run(['file','download','b2://'+BUCKET+'/'+CANDIDATE_REMOTE,CANDIDATE_LOCAL]);
}else if(mode==='pull-pair-candidates'){
  fs.mkdirSync(path.dirname(PAIR_CANDIDATE_LOCAL),{recursive:true});
  run(['file','download','b2://'+BUCKET+'/'+PAIR_CANDIDATE_REMOTE,PAIR_CANDIDATE_LOCAL]);
}else if(mode==='push-observations'){
  if(!fs.existsSync(OBS_DIR)){ console.log('no observation batches'); process.exit(0); }
  const files=fs.readdirSync(OBS_DIR).filter(x=>x.endsWith('.json')).sort();
  for(const file of files){
    run(['file','upload',BUCKET,path.join(OBS_DIR,file),OBS_REMOTE+'/'+file]);
    fs.unlinkSync(path.join(OBS_DIR,file));
  }
}else if(mode==='push-pair-observations'){
  if(!fs.existsSync(PAIR_OBS_DIR)){ console.log('no pair observation batches'); process.exit(0); }
  const files=fs.readdirSync(PAIR_OBS_DIR).filter(x=>x.endsWith('.json')).sort();
  for(const file of files){
    run(['file','upload',BUCKET,path.join(PAIR_OBS_DIR,file),PAIR_OBS_REMOTE+'/'+file]);
    fs.unlinkSync(path.join(PAIR_OBS_DIR,file));
  }
}else{
  usage();
  process.exit(2);
}

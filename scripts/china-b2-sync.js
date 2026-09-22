#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');

const BUCKET=process.env.CHINA_B2_BUCKET||'nodeprobe';
const PREFIX=process.env.CHINA_B2_PREFIX||'nodeprobe-state/china';
const CANDIDATE_REMOTE=PREFIX+'/candidates.json';
const OBS_REMOTE=PREFIX+'/observations';
const CANDIDATE_LOCAL=process.env.CHINA_CANDIDATE_FILE||'data/china-probe-candidates.json';
const OBS_DIR=process.env.CHINA_OBSERVATION_DIR||'data/china-probe-observations';

function run(args){
  const r=spawnSync(process.env.B2_BIN||'b2v4',args,{stdio:'inherit',env:process.env});
  if(r.error)throw r.error;
  if(r.status!==0)process.exit(r.status||1);
}
function usage(){
  console.log('usage: node scripts/china-b2-sync.js pull-candidates | push-observations');
}
const mode=process.argv[2];
if(mode==='pull-candidates'){
  fs.mkdirSync(path.dirname(CANDIDATE_LOCAL),{recursive:true});
  run(['file','download','b2://'+BUCKET+'/'+CANDIDATE_REMOTE,CANDIDATE_LOCAL]);
}else if(mode==='push-observations'){
  if(!fs.existsSync(OBS_DIR))return console.log('no observation batches');
  const files=fs.readdirSync(OBS_DIR).filter(x=>x.endsWith('.json')).sort();
  for(const file of files){
    run(['file','upload',BUCKET,path.join(OBS_DIR,file),OBS_REMOTE+'/'+file]);
  }
}else{
  usage();
  process.exit(2);
}

#!/usr/bin/env node
'use strict';

// Keep the newest uploaded version for each exact object name and delete
// every older upload/hide marker. This is independent of upload success so
// stale versions can still be cleaned when the main workflow fails later.
const keyId=process.env.B2_APPLICATION_KEY_ID;
const applicationKey=process.env.B2_APPLICATION_KEY;
const bucketName=process.env.B2_BUCKET||'nodeprobe';
if(!keyId||!applicationKey)throw new Error('B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required');

async function request(url,options={}){
  const response=await fetch(url,options);
  const text=await response.text();
  let body;
  try{body=JSON.parse(text)}catch{body=null}
  if(!response.ok)throw new Error('B2 API '+response.status+': '+(body?.message||text.slice(0,500)));
  return body;
}
async function authorize(){
  const basic=Buffer.from(keyId+':'+applicationKey).toString('base64');
  return request('https://api.backblazeb2.com/b2api/v2/b2_authorize_account',{
    headers:{Authorization:'Basic '+basic}
  });
}
async function api(auth,name,payload){
  return request(auth.apiUrl+'/b2api/v2/'+name,{
    method:'POST',
    headers:{Authorization:auth.authorizationToken,'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
}
async function getBucketId(auth){
  const result=await api(auth,'b2_list_buckets',{accountId:auth.accountId,bucketName});
  // B2's response field is bucketName (not name).
  const bucket=result.buckets?.find(x=>x.bucketName===bucketName);
  if(!bucket)throw new Error('B2 bucket not found: '+bucketName);
  return bucket.bucketId;
}
async function listExactVersions(auth,bucketId,fileName){
  const all=[];
  let startFileName=fileName;
  let startFileId;
  for(let page=0;page<100;page++){
    const result=await api(auth,'b2_list_file_versions',{
      bucketId,startFileName,startFileId,maxFileCount:1000
    });
    const files=Array.isArray(result.files)?result.files:[];
    all.push(...files.filter(x=>x.fileName===fileName));
    if(!result.nextFileName||result.nextFileName!==fileName)return all;
    const nextFileId=result.nextFileId;
    if(!nextFileId||(result.nextFileName===startFileName&&nextFileId===startFileId)){
      throw new Error('B2 version pagination did not advance for '+fileName);
    }
    startFileName=result.nextFileName;
    startFileId=nextFileId;
  }
  throw new Error('Version listing exceeded 100 pages for '+fileName);
}
async function prune(auth,bucketId,fileName){
  const versions=await listExactVersions(auth,bucketId,fileName);
  const uploads=versions.filter(x=>x.action==='upload'&&x.fileId);
  if(!uploads.length){
    console.log('[B2] '+fileName+': no uploaded version found; nothing to prune');
    return;
  }
  uploads.sort((a,b)=>Number(b.uploadTimestamp||0)-Number(a.uploadTimestamp||0));
  const keep=uploads[0];
  let deleted=0;
  for(const version of versions){
    if(!version.fileId||version.fileId===keep.fileId)continue;
    await api(auth,'b2_delete_file_version',{fileName:version.fileName,fileId:version.fileId});
    deleted++;
  }
  const remaining=await listExactVersions(auth,bucketId,fileName);
  const remainingUploads=remaining.filter(x=>x.action==='upload');
  if(remaining.length!==1||remainingUploads.length!==1||remainingUploads[0].fileId!==keep.fileId){
    throw new Error('[B2] post-prune verification failed for '+fileName+
      ': remaining versions='+remaining.length+', uploads='+remainingUploads.length);
  }
  console.log('[B2] '+fileName+': before='+versions.length+
    ', kept latest='+keep.fileId+', deleted='+deleted+', after='+remaining.length+' (verified)');
}
async function main(){
  const names=[...new Set(process.argv.slice(2))].filter(Boolean);
  if(!names.length)throw new Error('Usage: node scripts/b2-prune-versions.js <remote-file> [...]');
  const auth=await authorize();
  const bucketId=await getBucketId(auth);
  for(const name of names)await prune(auth,bucketId,name);
}
main().catch(error=>{console.error(error.stack||error);process.exit(1)});

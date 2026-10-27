#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const API='https://api.github.com';
const UA='FreeNodeFilter/0.1';
const TOKEN=process.env.GITHUB_TOKEN||process.env.GH_TOKEN||'';
const MAX_REPOS=8;
const MAX_FILES_PER_REPO=12;
const MAX_NEW_SOURCES=60;
const MAX_DISCOVERY_PAGES=10;
const REPO_REVISIT_DAYS=7;
const stateFile=path.resolve('data/sources.json');
const discoveryFile=path.resolve('data/discovery-state.json');

function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function sourceId(url){return 'dynamic-'+crypto.createHash('sha256').update(url).digest('hex').slice(0,12)}
function canonical(url){
  try{const u=new URL(url);u.hash='';return u.toString().replace(/\/$/,'')}catch{return null}
}
function isCandidatePath(p){
  const x=p.toLowerCase();
  return /\.(ya?ml|json|txt|conf|list)$/.test(x)&&/(sub|node|proxy|clash|sing|v2ray|vless|vmess|trojan|ssr|ss|free)/.test(x);
}
async function api(url){
  const r=await fetch(url,{headers:{accept:'application/vnd.github+json','user-agent':UA,...(TOKEN?{authorization:'Bearer '+TOKEN}:{})}});
  if(!r.ok)throw new Error('GitHub API '+r.status+' '+url);
  return r.json();
}
async function looksLikeSource(url){
  try{
    const r=await fetch(url,{redirect:'follow',headers:{'user-agent':UA}});
    if(!r.ok)return false;
    const text=(await r.text()).slice(0,200000);
    return /(^|\n)\s*proxies\s*:/m.test(text)||/(?:vless|vmess|trojan|ss|ssr):\/\//i.test(text);
  }catch{return false}
}
async function fetchText(url,limit=200000){
  const r=await fetch(url,{redirect:'follow',headers:{'user-agent':UA}});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return (await r.text()).slice(0,limit);
}
function candidateUrl(url){
  try{
    const u=new URL(url);
    if(!/^https?:$/.test(u.protocol))return null;
    const host=u.hostname.toLowerCase();
    const pathAndQuery=(u.pathname+' '+u.search).toLowerCase();
    const githubHost=host==='raw.githubusercontent.com'||host==='gist.githubusercontent.com'||host==='github.com';
    const looksNamed=/(sub|subscription|node|proxy|clash|v2ray|vless|vmess|trojan|ssr|free|yaml|yml|txt|json)/.test(pathAndQuery);
    if(!githubHost&&!looksNamed)return null;
    if(host==='github.com'&&u.pathname.includes('/blob/')){
      const parts=u.pathname.split('/').filter(Boolean);
      if(parts.length>=4){
        const branch=parts[2];
        const file=parts.slice(3).join('/');
        return canonical('https://raw.githubusercontent.com/'+parts[0]+'/'+parts[1]+'/'+branch+'/'+file);
      }
    }
    return canonical(u.toString());
  }catch{return null}
}
function extractSourceUrls(text){
  const found=new Set();
  const re=/https?:\/\/[^\s"'<>\])}]+/gi;
  for(const m of text.matchAll(re)){
    const u=candidateUrl(m[0].replace(/[.,;:]+$/,''));
    if(u)found.add(u);
  }
  return [...found];
}

function nextProbe(status,reputation){
  const effective=reputation?.status||status;
  const hours=effective==='trusted'?24
    :effective==='normal'?12
    :effective==='weak'?72
    :effective==='degraded'?72
    :effective==='stale'?168
    :effective==='dead'?720
    :6;
  return new Date(Date.now()+hours*3600000).toISOString();
}
function lifecycle(old,rep,fetchOk){
  const current=rep?.status||old?.status||'candidate';
  if(!fetchOk){
    const failures=Number(old?.fetchFailures||0)+1;
    return {status:failures>=6?'dead':'weak',fetchFailures:failures};
  }
  const failures=0;
  if(!rep)return {status:old?.status==='candidate'?'normal':old?.status||'normal',fetchFailures:failures};
  if(rep.status==='trusted')return {status:'trusted',fetchFailures:failures};
  if(rep.status==='degraded')return {status:'weak',fetchFailures:failures};
  if(rep.status==='weak')return {status:'weak',fetchFailures:failures};
  return {status:current==='candidate'?'normal':current,fetchFailures:failures};
}

async function main(){
  fs.mkdirSync('data',{recursive:true});
  const state=readJson(stateFile,{sources:[]});
  const repState=readJson('data/source-reputation.json',{sources:{}});
  const discovery=readJson(discoveryFile,{version:1,channels:{},repos:{},sources:{}});
  if(!discovery.channels)discovery.channels={};
  if(!discovery.repos)discovery.repos={};
  if(!discovery.sources)discovery.sources={};
  const known=new Map();
  for(const s of (state.sources||[])){const u=canonical(s.url);if(u)known.set(u,s)}

  // GitHub discovery is intentionally multi-channel and stateful.
  // A fixed first page is not enough: it repeatedly returns the same repos.
  // Persist a small cursor per (query,sort) channel and remember when each
  // repository was actually expanded.
  const channels=[
    ...['free proxy nodes clash','free v2ray nodes','free proxy subscription','clash subscription nodes'].map(q=>({q,sort:'updated'})),
    ...['free proxy nodes clash','free v2ray nodes','free proxy subscription','clash subscription nodes'].map(q=>({q,sort:'created'})),
    ...['free proxy nodes clash','free v2ray nodes','free proxy subscription','clash subscription nodes'].map(q=>({q,sort:'stars'}))
  ];
  const repos=new Map();
  for(const ch of channels){
    const key=ch.sort+'::'+ch.q;
    const st=discovery.channels[key]||{page:1,runs:0,lastRun:null};
    const page=Math.max(1,Math.min(MAX_DISCOVERY_PAGES,Number(st.page)||1));
    try{
      const d=await api(API+'/search/repositories?q='+encodeURIComponent(ch.q)+'&sort='+ch.sort+'&order=desc&per_page='+MAX_REPOS+'&page='+page);
      for(const r of (d.items||[]))if(r.full_name)repos.set(r.full_name,r);
      st.runs=(Number(st.runs)||0)+1;
      st.lastRun=new Date().toISOString();
      st.page=page>=MAX_DISCOVERY_PAGES?1:page+1;
      st.lastCount=(d.items||[]).length;
      discovery.channels[key]=st;
    }catch(e){
      console.error('discover search failed:',e.message);
      st.lastError=new Date().toISOString();
      discovery.channels[key]=st;
    }
  }

  let added=0;
  const addCandidate=async(u,from,type='discovered_url')=>{
    if(added>=MAX_NEW_SOURCES||!u||known.has(u))return false;
    if(!(await looksLikeSource(u)))return false;
    const now=new Date().toISOString();
    const item={url:u,type,name:sourceId(u),discoveredFrom:from,firstSeen:now,lastSeen:now,status:'candidate',reputation:null,fetchFailures:0,nextProbeAt:now};
    known.set(u,item);state.sources.push(item);added++;
    console.log('NEW',u,'from',from);
    return true;
  };

  // Frontier 1: repository files discovered through GitHub search.
  for(const repo of repos.values()){
    if(added>=MAX_NEW_SOURCES)break;
    const repoState=discovery.repos[repo.full_name]||{timesSeen:0};
    repoState.timesSeen=(Number(repoState.timesSeen)||0)+1;
    repoState.lastSeenAt=new Date().toISOString();
    repoState.stars=repo.stargazers_count||0;
    repoState.pushedAt=repo.pushed_at||null;
    repoState.createdAt=repo.created_at||null;
    discovery.repos[repo.full_name]=repoState;
    const lastExpanded=Date.parse(repoState.lastExpandedAt||0);
    if(lastExpanded && Date.now()-lastExpanded < REPO_REVISIT_DAYS*86400000) continue;
    repoState.lastExpandedAt=new Date().toISOString();
    try{
      const branch=repo.default_branch||'main';
      const tree=await api(API+'/repos/'+repo.full_name+'/git/trees/'+encodeURIComponent(branch)+'?recursive=1');
      const files=(tree.tree||[]).filter(x=>x.type==='blob'&&x.path&&isCandidatePath(x.path)).slice(0,MAX_FILES_PER_REPO);
      for(const f of files){
        if(added>=MAX_NEW_SOURCES)break;
        const raw='https://raw.githubusercontent.com/'+repo.full_name+'/'+branch+'/'+f.path.split('/').map(encodeURIComponent).join('/');
        await addCandidate(canonical(raw),'github:'+repo.full_name,'github_raw');
      }
      // Also inspect README text: many repositories publish links to sources
      // without putting the actual subscription in the repository tree.
      if(added<MAX_NEW_SOURCES){
        try{
          const readme=await api(API+'/repos/'+repo.full_name+'/readme');
          const text=Buffer.from(readme.content||'','base64').toString('utf8');
          for(const u of extractSourceUrls(text)){
            if(added>=MAX_NEW_SOURCES)break;
            await addCandidate(u,'github:'+repo.full_name,'discovered_url');
          }
        }catch{}
      }
    }catch(e){console.error('repo scan failed:',repo.full_name,e.message)}
  }

  // Frontier 2: existing sources can discover additional sources. Only a
  // bounded number of parents are expanded per run to prevent an unbounded
  // crawler from turning the workflow into a general web spider.
  const frontier=(state.sources||[])
    .filter(s=>s.url&&(!s.nextProbeAt||Date.parse(s.nextProbeAt)<=Date.now()))
    .sort((a,b)=>{
      const aa=Date.parse(discovery.sources[a.name||sourceId(a.url)]?.lastExpandedAt||0);
      const bb=Date.parse(discovery.sources[b.name||sourceId(b.url)]?.lastExpandedAt||0);
      return aa-bb;
    })
    .slice(0,20);
  for(const parent of frontier){
    if(added>=MAX_NEW_SOURCES)break;
    const parentId=parent.name||sourceId(parent.url);
    const parentState=discovery.sources[parentId]||{timesExpanded:0};
    parentState.timesExpanded=(Number(parentState.timesExpanded)||0)+1;
    parentState.lastExpandedAt=new Date().toISOString();
    discovery.sources[parentId]=parentState;
    try{
      const text=await fetchText(parent.url,120000);
      for(const u of extractSourceUrls(text)){
        if(added>=MAX_NEW_SOURCES)break;
        await addCandidate(u,parent.name||parent.url,'source_link');
      }
    }catch{}
  }

  for(const s of state.sources||[]){
    if(!s.url)continue;
    const id=s.name||sourceId(s.url);
    const rep=repState.sources?.[id]||repState.sources?.[s.url]||null;
    if(rep){
  s.reputation=rep.weightedNodeSuccessRate;
  s.status=rep.status==='trusted'?'trusted'
    :rep.status==='degraded'?'weak'
    :rep.status==='weak'?'weak'
    :rep.status==='stale'?'stale'
    :rep.status==='dead'?'dead'
    :(s.status==='candidate'?'normal':s.status);
}
    if(!s.status)s.status='candidate';
    if(!s.firstSeen)s.firstSeen=new Date().toISOString();
    if(!s.lastSeen)s.lastSeen=s.firstSeen;
    if(!s.fetchFailures)s.fetchFailures=0;
    s.name=id;
    // Newly discovered candidates must be fetched in this workflow run.
    // Scheduling them six hours ahead here caused fetch-sources.js to skip
    // every fresh discovery, then repeatedly postpone candidates before fetch.
    s.nextProbeAt=(s.status==='candidate'&&!rep)
      ? new Date().toISOString()
      : nextProbe(s.status,rep);
  }

  state.updatedAt=new Date().toISOString();
  state.version=1;
  discovery.updatedAt=state.updatedAt;
  discovery.version=1;
  fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
  fs.writeFileSync(discoveryFile,JSON.stringify(discovery,null,2)+'\n');
  console.log('discovered:',added,'total dynamic:',state.sources.length);
}

main().catch(e=>{console.error(e);process.exit(1)});

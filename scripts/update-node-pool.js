#!/usr/bin/env node
'use strict';

const fs=require('fs');

const CANDIDATES='data/candidates.json';
const HEALTH='data/health.json';
const POOL='data/node-pool.json';
const EVOLUTION='data/source-evolution.json';

function readJson(path,fallback){
  try{return JSON.parse(fs.readFileSync(path,'utf8'))}catch{return fallback}
}
function cleanProxy(p){
  const x={...p};
  delete x._source; delete x._sources; delete x._id; delete x._poolOnly;
  return x;
}
function healthy(r){
  if(!r)return false;
  const rounds=Number(r.rounds||0), successes=Number(r.successes||0);
  return rounds>=2 && successes>=Math.ceil(rounds*0.67);
}
const DEAD_RECHECK_MS=[4,12,24,72,168,336,720].map(h=>h*3600000);
function nextProbeAt(status,atMs,recheckLevel=0){
  const intervals={
    stable:24*3600000,
    active:12*3600000,
    probation:6*3600000,
    stale:4*3600000
  };
  if(status==='dead'){
    const ms=DEAD_RECHECK_MS[Math.min(Math.max(0,recheckLevel),DEAD_RECHECK_MS.length-1)];
    return new Date(atMs+ms).toISOString();
  }
  const ms=intervals[status];
  return ms?new Date(atMs+ms).toISOString():null;
}
function sourceQuality(rows){
  if(!rows.length)return 0;
  const q=rows.map(r=>{
    const success=Math.max(0,Math.min(1,Number(r.successRate||0)));
    const latency=r.avgLatency==null?1:Math.max(0,Math.min(1,Number(r.avgLatency)/5000));
    return 0.75*success+0.25*(1-latency);
  });
  return q.reduce((a,b)=>a+b,0)/q.length;
}

function main(){
  const candidates=readJson(CANDIDATES,[]);
  const health=readJson(HEALTH,{results:[]});
  const old=readJson(POOL,{version:1,nodes:[],updatedAt:null});
  const oldMap=new Map((old.nodes||[]).map(x=>[x.fingerprint,x]));
  const now=new Date().toISOString();
  const results=new Map((health.results||[]).filter(r=>r.fingerprint).map(r=>[r.fingerprint,r]));
  const candidateMap=new Map(candidates.map(p=>[p['endpoint-id']||p._id,p]));
  const nodes=new Map();

  for(const entry of old.nodes||[]){
    nodes.set(entry.fingerprint,{...entry});
  }

  // Source membership is refreshed independently of health maintenance. This
  // lets a node remain a persistent asset even when it is not due for probing,
  // while still recording that a source stopped publishing it.
  const currentSourceMembership=readJson('data/current-node-sources.json',null);
  if(currentSourceMembership&&typeof currentSourceMembership==='object'){
    for(const [id,entry] of nodes){
      const currentSources=Array.isArray(currentSourceMembership[id])
        ? [...new Set(currentSourceMembership[id].filter(Boolean))]
        : [];
      const knownSources=[...new Set([...(entry.knownSources||[]),...currentSources])];
      const previousObservations=Array.isArray(entry.sourceObservations)?entry.sourceObservations:[];
      const observationMap=new Map(previousObservations.filter(x=>x&&x.source).map(x=>[x.source,{...x}]));
      for(const source of currentSources){
        const x=observationMap.get(source)||{source,firstObservedAt:now,lastObservedAt:now};
        x.lastObservedAt=now;
        observationMap.set(source,x);
      }
      entry.currentSources=currentSources;
      entry.knownSources=knownSources;
      entry.observedSources=[...observationMap.values()].map(x=>x.source);
      entry.sourceObservations=[...observationMap.values()].sort((a,b)=>String(a.firstObservedAt).localeCompare(String(b.firstObservedAt)));
    }
  }

  for(const p of candidates){
    const id=p['endpoint-id']||p._id;
    if(!id)continue;
    const r=results.get(id);
    const prev=oldMap.get(id);
    const currentSources=[...new Set(Array.isArray(p._sources)?p._sources.filter(Boolean):[])];
    const knownSources=[...new Set([...(prev?.knownSources||[]),...currentSources])];
    // These timestamps mean when NodeProbe observed the node, not when the source published it.
    // A source file's timestamp is not reliable publication evidence: long-lived nodes can remain
    // in a subscription for a long time and appear in a much newer file without being newly published.
    const firstObservedAt=prev?.firstObservedAt||prev?.firstSeen||now;
    // Preserve source provenance separately from the endpoint fingerprint.
    // Provenance is metadata only and must never participate in endpoint-id.
    const firstObservedSource=prev?.firstObservedSource||prev?.firstSeenSource||currentSources[0]||null;
    const previousObservations=Array.isArray(prev?.sourceObservations)?prev.sourceObservations:[];
    const observationMap=new Map(previousObservations.filter(x=>x&&x.source).map(x=>[x.source,{...x}]));
    for(const source of currentSources){
      const x=observationMap.get(source)||{source,firstObservedAt:now,lastObservedAt:now};
      x.lastObservedAt=now;
      observationMap.set(source,x);
    }
    const sourceObservations=[...observationMap.values()].sort((a,b)=>String(a.firstObservedAt).localeCompare(String(b.firstObservedAt)));
    const observedSources=sourceObservations.map(x=>x.source);
    const hasObservation=Boolean(r);
    const currentHealthy=hasObservation&&healthy(r);
    const wasDead=prev?.status==='dead';
    let deadSince=prev?.deadSince||null;
    let recheckLevel=Number.isInteger(prev?.recheckLevel)?prev.recheckLevel:0;
    let recoveryRuns=Number(prev?.recoveryRuns||0);
    // A candidate without a health result was not actually observed. Do not
    // turn an untested/skipped candidate into a failure or advance its schedule.
    const healthyRuns=hasObservation
      ? (currentHealthy?(Number(prev?.healthyRuns||0)+1):0)
      : Number(prev?.healthyRuns||0);
    const failedRuns=hasObservation
      ? (currentHealthy?0:(Number(prev?.failedRuns||0)+1))
      : Number(prev?.failedRuns||0);
    const observedRuns=hasObservation
      ? Number(prev?.observedRuns||0)+1
      : Number(prev?.observedRuns||0);

    let status=prev?.status||'new';
    let forgotten=false;
    if(wasDead){
      status='dead';
      if(hasObservation){
        if(currentHealthy){
          recoveryRuns+=1;
          if(recoveryRuns>=3){
            status=prev?.everStable?'stable':'active';
            deadSince=null;
            recheckLevel=0;
          }
        }else{
          recoveryRuns=0;
          recheckLevel+=1;
          if(recheckLevel>=DEAD_RECHECK_MS.length)forgotten=true;
        }
      }
    }else if(hasObservation){
      if(currentHealthy){
        if(healthyRuns>=6 || prev?.everStable)status='stable';
        else if(healthyRuns>=2)status='active';
        else status='probation';
      }else if(failedRuns>=3){
        status='dead';
        deadSince=now;
        recheckLevel=0;
        recoveryRuns=0;
      }else{
        status=prev?.everStable?'stale':(failedRuns>=2?'stale':'probation');
      }
    }

    const proxy=cleanProxy(p);
    if(forgotten){
      nodes.delete(id);
      continue;
    }
    const lifetimeDays=Math.max(0,(Date.now()-Date.parse(firstObservedAt))/86400000);
    const entry={
      fingerprint:id,
      name:proxy.name,
      proxy,
      status,
      everStable:Boolean(prev?.everStable||status==='stable'),
      firstObservedAt,
      firstObservedSource,
      observedSources,
      sourceObservations,
      lastSeen:hasObservation&&currentHealthy?now:(prev?.lastSeen||firstObservedAt),
      lastObservedAt:hasObservation?now:(prev?.lastObservedAt||firstObservedAt),
      lifetimeDays:Number(lifetimeDays.toFixed(3)),
      observedRuns,
      healthyRuns,
      failedRuns,
      currentSources,
      knownSources,
      deadSince:status==='dead'?(deadSince||now):null,
      recheckLevel:status==='dead'?recheckLevel:0,
      recoveryRuns:status==='dead'?recoveryRuns:0,
      nextProbeAt:hasObservation
        ? nextProbeAt(status,Date.now(),recheckLevel)
        : (prev?.nextProbeAt||null),
      lastHealth:hasObservation?{
        rounds:r.rounds,
        successes:r.successes,
        successRate:r.successRate,
        avgLatency:r.avgLatency,
        p95Latency:r.p95Latency
      }:(prev?.lastHealth||null)
    };
    nodes.set(id,entry);
  }

  const ordered=[...nodes.values()].sort((a,b)=>{
    const rank={stable:0,active:1,probation:2,stale:3,dead:4};
    return (rank[a.status]??9)-(rank[b.status]??9)
      || Number(b.lifetimeDays||0)-Number(a.lifetimeDays||0);
  });

  fs.writeFileSync(POOL,JSON.stringify({
    version:1,
    generatedAt:now,
    updatedAt:now,
    updatedRunId:process.env.GITHUB_RUN_ID||null,
    activeCount:ordered.filter(x=>x.status!=='dead').length,
    stableCount:ordered.filter(x=>x.status==='stable').length,
    staleCount:ordered.filter(x=>x.status==='stale').length,
    deadCount:ordered.filter(x=>x.status==='dead').length,
    nodes:ordered
  },null,2));

  // Track what each source is actually publishing in the current run.
  // This deliberately uses currentSources, not knownSources, so a historical
  // relationship is never mistaken for current source membership.
  const currentBySource=new Map();
  for(const [id,p] of candidateMap){
    const r=results.get(id);
    for(const source of (Array.isArray(p._sources)?p._sources:[])){
      const x=currentBySource.get(source)||{ids:[],rows:[]};
      x.ids.push(id);
      if(r)x.rows.push(r);
      currentBySource.set(source,x);
    }
  }

  const evolution=readJson(EVOLUTION,{version:1,runs:[]});
  const previous=evolution.runs?.at(-1)?.sources||{};
  const snapshot={generatedAt:now,sources:{}};

  for(const [source,x] of currentBySource){
    const ids=[...new Set(x.ids)];
    const prevIds=new Set(previous[source]?.nodeIds||[]);
    const currentIds=new Set(ids);
    const added=ids.filter(id=>!prevIds.has(id));
    const removed=[...prevIds].filter(id=>!currentIds.has(id));
    const retained=ids.filter(id=>prevIds.has(id));
    const replacementRate=prevIds.size?1-(retained.length/prevIds.size):null;
    const quality=sourceQuality(x.rows);
    const prevQuality=previous[source]?.quality??null;
    snapshot.sources[source]={
      nodeCount:ids.length,
      nodeIds:ids,
      addedCount:added.length,
      removedCount:removed.length,
      retainedCount:retained.length,
      replacementRate:replacementRate==null?null:Number(replacementRate.toFixed(4)),
      quality:Number(quality.toFixed(4)),
      qualityDelta:prevQuality==null?null:Number((quality-prevQuality).toFixed(4))
    };
  }

  const runs=[...(evolution.runs||[]),snapshot].slice(-30);
  fs.writeFileSync(EVOLUTION,JSON.stringify({version:1,generatedAt:now,runs},null,2));

  const stable=ordered.filter(x=>x.status==='stable').length;
  const active=ordered.filter(x=>x.status==='active').length;
  const stale=ordered.filter(x=>x.status==='stale').length;
  const dead=ordered.filter(x=>x.status==='dead').length;
  console.log('node pool:',ordered.length,'stable',stable,'active',active,'stale',stale,'dead',dead);
  console.log('source evolution:',Object.keys(snapshot.sources).length,'sources observed');
}

main();

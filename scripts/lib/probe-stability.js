'use strict';

function maxConsecutive(items,predicate){
  let best=0,current=0;
  for(const item of items){
    if(predicate(item)){current++;best=Math.max(best,current);}
    else current=0;
  }
  return best;
}

function percentile(items,q){
  const values=items.filter(x=>x.success&&Number.isFinite(x.delayMs)).map(x=>x.delayMs).sort((a,b)=>a-b);
  if(!values.length)return null;
  return values[Math.min(values.length-1,Math.ceil(values.length*q)-1)];
}

function summarizeAttempts(attempts,targets,rounds,thresholds){
  const byTarget={};
  for(const target of targets)byTarget[target.id]=attempts.filter(x=>x.target===target.id);
  const targetStats=Object.fromEntries(Object.entries(byTarget).map(([id,v])=>{
    const successes=v.filter(x=>x.success).length;
    return [id,{attempts:v.length,successes,failures:v.length-successes,successRate:v.length?successes/v.length:0,timeoutRate:v.length?v.filter(x=>x.timeout).length/v.length:0,p95Latency:percentile(v,.95)}];
  }));
  const byRound={};
  for(const x of attempts)(byRound[x.round]??=[]).push(x);
  const roundStats=Object.fromEntries(Object.entries(byRound).map(([id,v])=>{
    const successes=v.filter(x=>x.success).length;
    return [id,{attempts:v.length,successes,successRate:v.length?successes/v.length:0,timeoutCount:v.filter(x=>x.timeout).length}];
  }));
  const successes=attempts.filter(x=>x.success).length;
  const timeouts=attempts.filter(x=>x.timeout).length;
  const successRate=attempts.length?successes/attempts.length:0;
  const p95Latency=percentile(attempts,.95);
  const targetPass=targets.every(t=>(targetStats[t.id]?.successRate??0)>=thresholds.minTargetSuccessRate);
  const roundPass=Object.keys(roundStats).length===rounds&&Object.values(roundStats).every(x=>x.successRate>=thresholds.minRoundSuccessRate);
  const eligible=successRate>=thresholds.minSuccessRate&&targetPass&&roundPass&&
    maxConsecutive(attempts,x=>!x.success)<=thresholds.maxConsecutiveFailures&&
    maxConsecutive(attempts,x=>x.timeout)<=thresholds.maxConsecutiveTimeouts&&
    (p95Latency==null||p95Latency<=thresholds.p95Latency);
  return {
    attempts:attempts.length,successes,failures:attempts.length-successes,timeouts,
    successRate,timeoutRate:attempts.length?timeouts/attempts.length:0,
    maxConsecutiveFailures:maxConsecutive(attempts,x=>!x.success),
    maxConsecutiveTimeouts:maxConsecutive(attempts,x=>x.timeout),
    p50Latency:percentile(attempts,.5),p95Latency,p99Latency:percentile(attempts,.99),
    maxLatency:attempts.some(x=>x.success)?Math.max(...attempts.filter(x=>x.success).map(x=>x.delayMs)):null,
    targetStats,roundStats,eligible
  };
}

module.exports={maxConsecutive,percentile,summarizeAttempts};

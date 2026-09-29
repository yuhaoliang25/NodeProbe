'use strict';

async function apiJson(url,timeoutMs=10000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),Math.max(1,Number(timeoutMs)||10000));
  try{
    const r=await fetch(url,{signal:controller.signal});
    const t=await r.text();
    if(!r.ok)throw new Error('API '+r.status+' '+t.slice(0,200));
    return JSON.parse(t);
  }catch(e){
    if(e?.name==='AbortError')throw new Error('API request timeout after '+timeoutMs+'ms');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function runConcurrent(items,worker,concurrency){
  const results=new Array(items.length);
  let cursor=0;
  async function loop(){
    while(true){
      const index=cursor++;
      if(index>=items.length)return;
      results[index]=await worker(items[index],index);
    }
  }
  const n=Math.min(Math.max(1,Number(concurrency)||1),items.length);
  await Promise.all(Array.from({length:n},()=>loop()));
  return results;
}

async function probeDelay({api,name,target,expected,timeout}){
  const q=new URLSearchParams({
    url:target,
    timeout:String(timeout),
    expected:String(expected),
  });
  const startedAt=new Date().toISOString();
  try{
    const result=await apiJson(api+'/proxies/'+encodeURIComponent(name)+'/delay?'+q,Number(timeout)+3000);
    const delayMs=Number(result.delay);
    return {
      startedAt,
      finishedAt:new Date().toISOString(),
      success:Number.isFinite(delayMs)&&delayMs>0,
      delayMs:Number.isFinite(delayMs)&&delayMs>0?delayMs:null,
      timeout:false,
      error:null,
    };
  }catch(e){
    const error=String(e&&e.message||e).slice(0,300);
    return {
      startedAt,
      finishedAt:new Date().toISOString(),
      success:false,
      delayMs:null,
      timeout:/timeout|timed out|deadline/i.test(error),
      error,
    };
  }
}

function successRate(results){
  if(!results.length)return 0;
  return results.filter(x=>x.success).length/results.length;
}

module.exports={apiJson,runConcurrent,probeDelay,successRate};

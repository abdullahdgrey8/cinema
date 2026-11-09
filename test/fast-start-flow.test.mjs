import test from 'node:test';
import assert from 'node:assert/strict';
import {createFastStartFlow} from '../public/fast-start-flow.js';

const source={hash:'a',index:0,sessionId:'first',name:'First.mp4',size:200,
  generation:7,seekEpoch:0,identity:'movie:2024:signal run',movie:{title:'Signal Run',year:2024}};
const target={hash:'b',index:1,name:'Second.mp4',size:256,identity:source.identity};
const state={hash:'b',index:1,sessionId:'second',status:'ready',mode:'direct',url:'/stream?hash=b&index=1'};
const attachment={file:{index:1,name:target.name,size:target.size},state};
const ticket='a'.repeat(48);
const reply={ticket,expiresAt:12000,attachment,previewBytes:128};
const proof={openingFrame:0,runwayFrame:3.1,bytes:128};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness({check=async()=>reply,commit=async()=>({attachment}),decode=async()=>proof,wait=async()=>{}}={}){
  let current=source,clock=0,timeout;
  const calls=[],views=[],played=[];
  const flow=createFastStartFlow({
    getSource:()=>current,validateTarget:()=>true,render:view=>views.push(view),attach:result=>played.push(result),
    api:async(_route,data,signal)=>{
      calls.push(data);
      if(data.action==='check')return check(data,signal);
      if(data.action==='commit')return commit(data,signal);
      return {ok:true};
    },
    preview:decode,wait,now:()=>clock,schedule:callback=>{timeout=callback;return 1;},cancelTimer:()=>{timeout=null;},
  });
  return {flow,calls,views,played,source:value=>{current=value;},time:value=>{clock=value;},expire:()=>timeout?.()};
}

test('an explicit comparison can follow the original URL transition and attach an exact decoded alternate',async()=>{
  const pending=Promise.withResolvers();
  const h=harness({decode:async()=>pending.promise});
  const run=h.flow.start(target);
  await tick();
  assert.equal(h.views.at(-1).phase,'decoding');
  h.source({...source,url:'/hls/original'});
  h.flow.refresh();
  pending.resolve(proof);
  await run;
  assert.deepEqual(h.calls.map(call=>call.action),['check','commit']);
  assert.equal(h.calls[0].purpose,'fast-start');
  assert.equal(h.played[0].attachment.state.sessionId,'second');
});

test('a primary picture during commit cancels the ticket and keeps the original',async()=>{
  const response=Promise.withResolvers();
  const h=harness({commit:async()=>response.promise});
  const run=h.flow.start(target);
  await tick();
  assert.equal(h.views.at(-1).phase,'committing');
  h.source(null);
  h.flow.primaryFrame();
  response.resolve({attachment});
  await run;
  assert.deepEqual(h.calls.map(call=>call.action),['check','commit','cancel']);
  assert.equal(h.played.length,0);
  assert.equal(h.views.at(-1).phase,'primary');
});

test('opening wait is bounded and insufficient runway never commits',async()=>{
  let attempt=0;
  const h=harness({check:async()=>++attempt===1?{waiting:true,message:'Waiting for opening'}:reply,
    decode:async()=>({...proof,runwayFrame:2.8})});
  await h.flow.start(target);
  assert.ok(h.views.some(view=>view.phase==='waiting'));
  assert.deepEqual(h.calls.map(call=>call.action),['check','check','cancel']);
  assert.equal(h.played.length,0);
  assert.equal(h.views.at(-1).phase,'unavailable');
});

test('timeout, generation change and late proof never take over the original',async()=>{
  for(const invalidation of ['timeout','retarget','cancel']){
    const check=Promise.withResolvers();
    const h=harness({check:async()=>check.promise});
    const run=h.flow.start(target);
    await tick();
    if(invalidation==='timeout')h.expire();
    if(invalidation==='retarget'){h.source({...source,generation:8});h.flow.refresh();}
    if(invalidation==='cancel')h.flow.cancel();
    check.resolve(reply);
    await run;
    assert.equal(h.played.length,0);
    assert.deepEqual(h.calls.map(call=>call.action),['check','cancel']);
  }
});

test('a different committed session and a mismatched release are never used',async()=>{
  const h=harness({commit:async()=>({attachment:{...attachment,state:{...state,sessionId:'other'}}})});
  await h.flow.start({...target,identity:'different'});
  assert.equal(h.calls.length,0);
  await h.flow.start(target);
  assert.deepEqual(h.calls.map(call=>call.action),['check','commit','cancel']);
  assert.equal(h.played.length,0);
});

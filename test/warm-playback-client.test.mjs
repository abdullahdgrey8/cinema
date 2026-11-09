import test from 'node:test';
import assert from 'node:assert/strict';
import {createWarmPlayback} from '../public/warm-playback.js';

const original={hash:'a',index:2,sessionId:'source',url:'/hls/a-2/run/index.m3u8',title:'First title',
  generation:5,position:5,positionVerified:true,paused:false};
const fallback={hash:'b',index:1,sessionId:'ready',fileName:'Fallback.mp4',mode:'direct'};
const lease={...original,ticket:'ticket',expiresAt:75_000,phase:'ready'};
const asAttachment=(ref,changes={})=>({
  file:{index:ref.index,name:ref.hash+'.mp4',size:100,progress:1},
  state:{hash:ref.hash,index:ref.index,sessionId:ref.sessionId,status:'ready',url:ref.url||'/stream?hash='+ref.hash,...changes},
});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(response){
  const calls=[],paints=[],attachments=[],scheduled=new Map();
  let source={...original},now=0,next=0;
  const flow=createWarmPlayback({
    api:async(route,body)=>{calls.push({route,body});return response(route,body);},
    getSource:()=>source,attach:(attachment,context)=>{attachments.push({attachment,context});source=null;},
    render:value=>paints.push(value),titleFor:option=>option.fileName,
    now:()=>now,schedule:callback=>{scheduled.set(++next,callback);return next;},cancel:id=>scheduled.delete(id),
  });
  return {flow,calls,paints,attachments,scheduled,source:value=>{source=value;},now:value=>{now=value;}};
}

test('explicit warm switch and return attach exact sessions and save the final verified playhead',async()=>{
  const h=fixture((route,body)=>{
    if(route.includes('/options?'))return {options:[original,fallback]};
    if(body?.action==='switch'){
      h.source({...original,position:7,paused:true});
      return {lease,attachment:asAttachment(fallback)};
    }
    if(body?.action==='return')return {attachment:asAttachment(original)};
    throw Error('Unexpected request');
  });
  await h.flow.options();
  assert.deepEqual(h.paints.at(-1).options.map(item=>item.hash),['b']);
  await h.flow.switchTo(fallback);
  assert.equal(h.attachments.length,1);
  assert.equal(h.attachments[0].context.fallback,true);
  assert.equal(h.paints.at(-1).lease.title,'First title');
  assert.equal(h.scheduled.size,1);
  await h.flow.returnToParked();
  assert.equal(h.attachments.length,2);
  assert.deepEqual(h.attachments[1].context,{fallback:false,intent:undefined,verifiedEpisode:undefined,position:7,positionVerified:true,paused:true});
  assert.equal(h.paints.at(-1).lease,null);
  assert.deepEqual(h.calls.filter(call=>call.body).map(call=>call.body.action),['switch','return']);
});

test('switch rejection keeps the existing player and a late accepted switch is dismissed',async()=>{
  let finish;
  const h=fixture((route,body)=>{
    if(route.includes('/options?'))return {options:[fallback]};
    if(body?.action==='dismiss')return {ok:true};
    return new Promise(resolve=>{finish=resolve;});
  });
  await h.flow.options();
  const wait=h.flow.switchTo(fallback);
  h.flow.cancelPendingSwitch();
  finish({lease,attachment:asAttachment(fallback)});
  await wait;
  await tick();
  assert.equal(h.attachments.length,0);
  assert.equal(h.paints.at(-1).lease,null);
  assert.deepEqual(h.calls.filter(call=>call.body).map(call=>call.body.action),['switch','dismiss']);
});

test('stale ready payload and wrong return run never replace the current player',async()=>{
  let switchCount=0;
  const h=fixture((route,body)=>{
    if(route.includes('/options?'))return {options:[fallback]};
    if(body?.action==='dismiss')return {ok:true};
    if(body?.action==='switch')return {lease,attachment:asAttachment(fallback,++switchCount===1?{sessionId:'wrong'}:{})};
    if(body?.action==='return')return {attachment:asAttachment(original,{url:'/hls/replacement'})};
  });
  await h.flow.options();
  await h.flow.switchTo(fallback);
  assert.equal(h.attachments.length,0);
  assert.match(h.paints.at(-1).error,/changed/);
  await h.flow.switchTo(fallback);
  await h.flow.returnToParked();
  assert.equal(h.attachments.length,1);
  assert.equal(h.paints.at(-1).lease,null);
  assert.match(h.paints.at(-1).returnNotice,/Return is no longer available/);
});

test('elapsed warm lease cannot trigger an automatic or manual return',async()=>{
  const h=fixture((route,body)=>route.includes('/options?')?{options:[fallback]}:
    body?.action==='switch'?{lease,attachment:asAttachment(fallback)}:{lease:null});
  await h.flow.options();
  await h.flow.switchTo(fallback);
  h.now(75_001);
  h.flow.refresh();
  await h.flow.returnToParked();
  assert.equal(h.attachments.length,1);
  assert.equal(h.paints.at(-1).lease,null);
  assert.equal(h.scheduled.size,0);
  assert.equal(h.calls.some(call=>call.body?.action==='return'),false);
  assert.match(h.paints.at(-1).returnNotice,/Return is no longer available/);
});


test('a poll that overlaps an accepted Return cannot discard its reply',async()=>{
  let resolveStatus,resolveReturn;
  const h=fixture((route,body)=>{
    if(route.includes('/options?'))return {options:[fallback]};
    if(body?.action==='switch')return {lease,attachment:asAttachment(fallback)};
    if(body?.action==='return')return new Promise(resolve=>{resolveReturn=resolve;});
    return new Promise(resolve=>{resolveStatus=resolve;});
  });
  await h.flow.options();
  await h.flow.switchTo(fallback);
  const status=h.scheduled.values().next().value();
  const returning=h.flow.returnToParked();
  h.now(75_001);
  h.flow.refresh();
  resolveStatus({lease:null});
  await status;
  resolveReturn({attachment:asAttachment(original)});
  await returning;
  assert.equal(h.attachments.length,2);
  assert.equal(h.attachments.at(-1).attachment.state.url,original.url);
  assert.equal(h.paints.at(-1).returnNotice,'');
});

test('the fallback keeps playing with an explanation after background invalidation',async()=>{
  const h=fixture((route,body)=>route.includes('/options?')?{options:[fallback]}:
    body?.action==='switch'?{lease,attachment:asAttachment(fallback)}:{lease:null});
  await h.flow.options();
  await h.flow.switchTo(fallback);
  await h.scheduled.values().next().value();
  assert.equal(h.attachments.length,1);
  assert.match(h.paints.at(-1).returnNotice,/My Library/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRescueFlow} from '../public/rescue-flow.js';

const source={hash:'a',index:0,name:'A.mp4',size:25,url:'/stream?hash=a&index=0',
  identity:'movie:2024:example',generation:6,sessionId:'a1',seekEpoch:1,track:3,time:34.25,paused:false};
const target={hash:'b',index:1,name:'B.mp4',size:27,identity:source.identity};
const bState={hash:'b',index:1,sessionId:'b1',status:'ready',mode:'direct',url:'/stream?hash=b&index=1'};
const attachment={file:{index:1,name:'B.mp4',size:27},state:bState};
const reply={ticket:'b'.repeat(48),expiresAt:45000,attachment};
const decoded={beginning:true,openingFrame:.2,sceneTime:41.25,sceneFrame:41.29};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(apiHandler,preview=async()=>decoded){
  let active={...source},valid=true,now=0,callback;
  const views=[],attached=[],calls=[];
  const flow=createRescueFlow({getSource:()=>active,preview,validateCandidate:()=>valid,
    listCandidates:async()=>[target],attach:(...args)=>attached.push(args),render:state=>views.push(state),
    api:async(_url,body,signal)=>{calls.push(body.action);return apiHandler(body,signal);},
    now:()=>now,schedule:fn=>{callback=fn;return 1;},cancel:()=>{callback=null;}});
  return {flow,views,attached,calls,setSource:value=>{active=value;},invalid:()=>{valid=false;},
    setNow:value=>{now=value;},expire:()=>callback?.()};
}
test('the decoder proof precedes the offer and only an explicit command attaches a matched scene',async()=>{
  let showFrame;
  const f=fixture(async body=>body.action==='check'?reply:{attachment},
    async()=>new Promise(resolve=>{showFrame=resolve;}));
  f.flow.show();await flush();
  const check=f.flow.check(target);await flush();
  assert.equal(f.views.at(-1).phase,'previewing');
  await f.flow.commit('scene');assert.equal(f.attached.length,0);
  showFrame(decoded);await check;
  assert.equal(f.views.at(-1).proof.sceneTime,41.25);
  assert.equal(f.attached.length,0);
  f.setSource({...source,paused:true});
  await f.flow.commit('scene');
  assert.equal(f.attached.length,1);
  assert.equal(f.attached[0][1].position,41.25);
  assert.equal(f.attached[0][1].paused,true);
  assert.deepEqual(f.calls,['check','commit']);
});
test('caption ambiguity or unverified landing allows only the decoded beginning',async()=>{
  const f=fixture(async body=>body.action==='check'?reply:{attachment},
    async()=>({...decoded,sceneFrame:48}));
  f.flow.show();await flush();await f.flow.check(target);
  assert.equal(f.views.at(-1).proof.sceneTime,null);
  await f.flow.commit('scene');assert.equal(f.attached.length,0);
  await f.flow.commit('beginning');
  assert.equal(f.attached[0][1].position,0);
});
test('cancellation releases a late ticket without previewing or taking over',async()=>{
  let later,previewed=false;
  const f=fixture(async body=>body.action==='check'?new Promise(resolve=>{later=resolve;}):{ok:true},
    async()=>{previewed=true;return decoded;});
  f.flow.show();await flush();
  const check=f.flow.check(target);
  f.flow.close();
  later(reply);await check;
  assert.equal(previewed,false);
  assert.deepEqual(f.calls,['check','cancel']);
});
test('source recovery during the offer and a changed committed session preserve the current player',async()=>{
  const f=fixture(async body=>body.action==='check'?reply:
    body.action==='commit'?{attachment:{...attachment,state:{...bState,sessionId:'different'}}}:{ok:true});
  f.flow.show();await flush();await f.flow.check(target);
  f.setSource({...source,time:source.time+3});
  f.flow.refresh();
  assert.equal(f.views.at(-1).proof,null);
  await f.flow.commit('beginning');
  assert.equal(f.attached.length,0);
  f.setSource(source);await f.flow.check(target);
  await f.flow.commit('scene');
  assert.equal(f.attached.length,0);
  assert.match(f.views.at(-1).message,/changed/);
});
test('a timed out or changed candidate never has an active offer',async()=>{
  const f=fixture(async body=>body.action==='check'?reply:{ok:true});
  f.flow.show();await flush();await f.flow.check(target);
  f.invalid();
  await f.flow.commit('scene');
  assert.equal(f.attached.length,0);
  assert.equal(f.views.at(-1).proof,null);
  assert.deepEqual(f.calls,['check','cancel']);
});
test('a new check waits for the ready proposal to be released',async()=>{
  let release;
  const f=fixture(async body=>body.action==='check'?reply:new Promise(resolve=>{release=resolve;}));
  f.flow.show();await flush();await f.flow.check(target);
  const next=f.flow.check(target);
  await flush();
  assert.deepEqual(f.calls,['check','cancel']);
  release({ok:true});await next;
  assert.deepEqual(f.calls,['check','cancel','check']);
  assert.equal(f.views.at(-1).phase,'ready');
});

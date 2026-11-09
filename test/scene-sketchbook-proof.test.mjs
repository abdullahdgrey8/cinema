import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWatchedRuntime,WATCHED_ENABLED,WATCHED_STORE} from '../public/watched-runtime.js';
import {writeCoverageStore} from '../public/watched-coverage.js';

const hash='a'.repeat(40),seal='c'.repeat(64);
const proof={kind:'sealed',seal,timeline:{mode:'direct',offsetMs:0,run:null}};
const file={hash,index:0,mode:'direct',run:null,sessionId:'d'.repeat(32),attachment:'e'.repeat(32),complete:true};
const interior={startMs:1400,endMs:1650};
function fixture({response=()=>proof}={}){
  let source={...file},library=[{hash}];
  const requests=[],storage=new Map([[WATCHED_ENABLED,'yes'],[WATCHED_STORE,writeCoverageStore([
    {hash,index:0,proof,updatedAt:1,video:[[1000,2000],[4000,5000]],caption:null}
  ])]]);
  const runtime=createWatchedRuntime({
    storage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    getSource:()=>source,getLibrary:()=>library,getSavedCaption:()=>null,describe:()=>null,
    api:async(url,body,signal)=>{requests.push({url,body});return response(signal);}
  });
  return {runtime,requests,setSource:value=>{source=value;},removeFile:()=>{library=[];}};
}

test('a frame can be authorized within one sealed continuous watched span only',async()=>{
  const {runtime,requests}=fixture();
  assert.deepEqual(await runtime.authorizeWatchedSpan(interior),{status:'ready',seal});
  assert.deepEqual(requests,[{url:'/api/watched/proof',body:{
    hash,index:0,mode:'direct',run:null,sessionId:file.sessionId,attachment:file.attachment,expected:seal
  }}]);
  for(const span of [{startMs:1900,endMs:4100},{startMs:2700,endMs:3000},{startMs:4800,endMs:5050}]){
    assert.deepEqual(await runtime.authorizeWatchedSpan(span),{status:'outside'});
  }
  assert.equal(requests.length,1);
  assert.equal(runtime.hasWatchedSpan(interior,'f'.repeat(64)),false);
});

test('a new attachment, lost file or opt-out rejects capture without requesting playback proof',async()=>{
  const {runtime,requests,setSource,removeFile}=fixture();
  for(const source of [null,{...file,complete:false},{...file,mode:'hls',run:'0'.repeat(12)},
    {...file,sessionId:null},{...file,index:1}]){
    setSource(source);
    assert.deepEqual(await runtime.authorizeWatchedSpan(interior),{status:'outside'});
  }
  setSource(file);
  runtime.setEnabled(false);
  assert.deepEqual(await runtime.authorizeWatchedSpan(interior),{status:'outside'});
  runtime.setEnabled(true);
  removeFile();
  assert.equal(runtime.hasWatchedSpan(interior,seal),false);
  assert.deepEqual(await runtime.authorizeWatchedSpan(interior),{status:'outside'});
  assert.equal(requests.length,0);
});

test('changing the attached file or resetting watched history cancels a pending proof',async()=>{
  for(const invalidate of [
    ({setSource})=>setSource({...file,attachment:'f'.repeat(32)}),
    ({runtime})=>runtime.syncStorage(),
    ({runtime})=>runtime.clear(),
  ]){
    let resolve;
    const item=fixture({response:()=>new Promise(done=>{resolve=done;})});
    const pending=item.runtime.authorizeWatchedSpan(interior);
    invalidate(item);
    resolve(proof);
    assert.deepEqual(await pending,{status:'unverified'});
  }
});

test('an abort or an unverifiable source never returns a seal',async()=>{
  const {runtime}=fixture({response:()=>null});
  assert.deepEqual(await runtime.authorizeWatchedSpan(interior),{status:'unverified'});
  const control=new AbortController();
  control.abort();
  assert.deepEqual(await runtime.authorizeWatchedSpan(interior,control.signal),{status:'unverified'});
});

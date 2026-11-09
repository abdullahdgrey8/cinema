import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWatchedRuntime,WATCHED_ENABLED,WATCHED_STORE} from '../public/watched-runtime.js';
import {writeCoverageStore} from '../public/watched-coverage.js';
import {watchedCueDigest} from '../public/watched-captions.js';

const hash='a'.repeat(40),id='b'.repeat(32);
const proof={kind:'sealed',seal:'c'.repeat(64),timeline:{mode:'direct',offsetMs:0,run:null}};
const cues=[[1500,2000,'I left a map'],[5500,6000,'Future map']];

test('a paused opt-in archive remains searchable without sharing caption contents or confusing an inexact Jump',async()=>{
  const digest=await watchedCueDigest(cues);
  const caption={id,digest,offsetMs:0,ranges:[[1000,4000]]};
  const record={hash,index:0,proof,updatedAt:1,video:[[1000,4000]],caption};
  const slots=new Map([[WATCHED_STORE,writeCoverageStore([record])],['cinema-history','retained']]);
  const requests=[];
  let mode='direct',selection={id,offsetMs:0},source=null;
  const service=createWatchedRuntime({
    storage:{getItem:k=>slots.get(k),setItem:(k,v)=>slots.set(k,v)},
    getSource:()=>source,getLibrary:()=>[{hash}],getSavedCaption:()=>selection,
    api:async(url,body)=>{requests.push([url,body]);return proof;},
    describe:()=>({title:'Echo Harbor'}),readCaption:async()=>({bytes:200,cues,digest})
  });
  assert.deepEqual(service.getCollection(),{enabled:false,hasEvidence:true});
  const found=await service.search('map');
  assert.deepEqual(found.results.map(hit=>hit.quote),['I left a map']);
  assert.deepEqual(requests[0],['/api/watched/proof',{hash,index:0,mode,run:null,expected:proof.seal}]);
  assert.equal(await service.authorize(found.results[0],{active:true,caption}),false);
  source={hash,index:0,mode,run:null,sessionId:'d'.repeat(32),attachment:'e'.repeat(32),complete:true};
  assert.equal(await service.authorize(found.results[0],{active:true,caption:{...caption,digest:'f'.repeat(64)}}),false);
  assert.equal(await service.authorize(found.results[0],{active:true,caption}),true);
  const recap=await service.loadRecap({hash,index:0,resumeTime:5});
  assert.deepEqual(recap.lines,[{time:1.5,text:'I left a map'}]);
  assert.equal(recap.end,4);
  assert.equal(recap.canReplay,false);
  selection={id,offsetMs:250};
  assert.deepEqual((await service.search('map')).results,[]);
  assert.deepEqual((await service.loadRecap({hash,index:0,resumeTime:5})).lines,[]);
  service.setEnabled(true);
  service.clear();
  assert.deepEqual(service.getCollection(),{enabled:true,hasEvidence:false});
  assert.equal(slots.get(WATCHED_ENABLED),'yes');
  assert.equal(slots.get('cinema-history'),'retained');
  assert.equal(slots.get(WATCHED_STORE).includes('map'),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {firstPictureDuration,isOpeningBufferAlignment,sourceMemoryCohorts,sourceMemoryLabel} from '../public/source-memory.js';

const v1='a'.repeat(40),v2='b'.repeat(64),other='c'.repeat(40);
const row={hash:v1,infohash_v1:v1,infohash_v2:v2};
const cohorts=[{condition:'downloaded',mode:'direct',count:1,medianMs:1260},
  {condition:'downloaded',mode:'hls',count:3,medianMs:2450}];
const view={enabled:true,available:true,observed:[{hash:v1,cohorts}]};

test('reports exact full magnet families and suppresses stale or ambiguous results',()=>{
  assert.deepEqual(sourceMemoryCohorts({memoryAliases:[v1,v2]},view,[row]),cohorts);
  assert.deepEqual(sourceMemoryCohorts({memoryAliases:[v2]},view,[row]),cohorts);
  assert.deepEqual(sourceMemoryCohorts({memoryAliases:[v1]},view,[row]),cohorts);
  for(const [aliases,library] of [
    [[v1,'e'.repeat(64)],[row]],
    [[v1,other],[row]],
    [[v2.slice(0,40)],[{hash:v2.slice(0,40),infohash_v2:v2}]],
    [[v1],[{hash:v1}]],
    [[v1,v2],[row,{hash:other,infohash_v2:v2}]],
    [undefined,[row]],
    [[v1],[]]
  ])assert.deepEqual(sourceMemoryCohorts({existingHash:v1,memoryAliases:aliases},view,library),[]);
  assert.deepEqual(sourceMemoryCohorts({memoryAliases:[v1]}, {...view,available:false},[row]),[]);
  assert.deepEqual(sourceMemoryCohorts({memoryAliases:[v1]}, {...view,enabled:false},[row]),[]);
});

test('first picture timing accepts either native event order without timing a stale or synthetic event',()=>{
  assert.equal(firstPictureDuration({startedAt:100,frameAt:1680,frameSeenAt:1695,playingAt:1675}),1580);
  assert.equal(firstPictureDuration({startedAt:100,frameAt:1680,frameSeenAt:1695,playingAt:1720}),1580);
  for(const change of [{playingAt:null},{frameAt:99},{playingAt:2800},{frameAt:1700},{frameSeenAt:NaN}]){
    assert.equal(firstPictureDuration({startedAt:100,frameAt:1680,frameSeenAt:1695,playingAt:1720,...change}),null);
  }
  assert.equal(sourceMemoryLabel(cohorts[0]),'Already downloaded · Direct · 1.3 sec · 1 observed start');
  assert.match(sourceMemoryLabel(cohorts[1]),/Prepared stream.*median.*3 observed starts/);
});
test('opening alignment can only bridge the first small HLS gap',()=>{
  assert.equal(isOpeningBufferAlignment(.146222,.046222,.1),true);
  for(const args of [[.146222,0,.1],[.146222,.046222,0],[.146222,null,.1],[.146222,.026222,.1],
    [.40,.30,.1],[4.15,.05,.1],[.6,.2,.4],[-.1,-.2,.1],[Infinity,.05,.1]]){
    assert.equal(isOpeningBufferAlignment(...args),false);
  }
});

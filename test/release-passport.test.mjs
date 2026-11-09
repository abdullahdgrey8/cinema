import test from 'node:test';
import assert from 'node:assert/strict';
import {createReleaseObservation} from '../public/release-passport.js';
import {releaseProbeFacts} from '../torrent-media.mjs';

test('passport starts its clock on a presented picture and never counts startup or brief waits', () => {
  const attempt=createReleaseObservation(100);
  attempt.wait(160);
  attempt.settle(1600);
  assert.deepEqual(attempt.snapshot(1600),{picture:null,firstPictureMs:null,stalls:{count:0,totalMs:0,waiting:false}});
  attempt.frame(1820,1280,720);
  attempt.wait(3000);
  attempt.settle(3290);
  attempt.wait(4000);
  assert.deepEqual(attempt.snapshot(4200),{picture:{width:1280,height:720},firstPictureMs:1720,stalls:{count:0,totalMs:0,waiting:false}});
  assert.deepEqual(attempt.snapshot(4700).stalls,{count:1,totalMs:700,waiting:true});
  attempt.settle(5070);
  assert.deepEqual(attempt.snapshot(6000).stalls,{count:1,totalMs:1070,waiting:false});
});

test('a viewer-delayed start can retain picture evidence without claiming a startup time', () => {
  const attempt=createReleaseObservation(0);
  attempt.excludeStart();
  attempt.frame(8000,1920,1080);
  attempt.frame(10000,1280,720);
  assert.deepEqual(attempt.snapshot(11000),{picture:{width:1280,height:720},firstPictureMs:null,stalls:{count:0,totalMs:0,waiting:false}});
  attempt.wait(12000);
  attempt.settle(12550);
  assert.equal(attempt.snapshot(13000).stalls.count,0);
});

test('the local probe projects only safe codec identifiers and dimensions', () => {
  const facts=releaseProbeFacts({format:{filename:'C:/private/example.mkv',tags:{secret:'hidden'}},streams:[
    {codec_type:'video',codec_name:'h264',width:160,height:90,filename:'private',tags:{title:'hidden'}},
    {codec_type:'audio',codec_name:'aac',channels:6},
  ]});
  assert.deepEqual(facts,{videoCodec:'h264',audioCodec:'aac',width:160,height:90});
  assert.equal(releaseProbeFacts(null),null);
  assert.deepEqual(releaseProbeFacts({streams:[{codec_type:'video',codec_name:'https://secret.invalid',width:12.5,height:-2}]}),
    {videoCodec:null,audioCodec:null,width:null,height:null});
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureEdition,compareEditions} from '../public/edition-atlas-model.js';

const story='movie:wikipedia-123:2024:midnight bridge';
const fileA='a'.repeat(40)+':0',fileB='b'.repeat(40)+':0';
const cue=(time,text,length=1.5)=>({startTime:time,endTime:time+length,text});
const phrases=[
  'The lantern stays on until the ferry arrives.',
  'Our neighbor left the keys beneath the garden bench.',
  'Bring the letter to the blue house before sunrise.',
  'A quiet storm is coming across the harbor tonight.',
  'Only the baker knows where she buried the compass.',
  'The last freight train stops at the eastern bridge.',
  'We will find the old oak tree near the river.',
  'Do not forget the silver pocket watch on the shelf.'
];
const first=phrases.map((text,index)=>cue(4+index*6,text));
const second=phrases.map((text,index)=>cue(6+index*6+(index>=4?12:0),text));
second.splice(4,0,cue(26,'The ferryman paid for this boat with six copper coins.'),
  cue(30,'He wrote his secret name on a postcard for Nora.'));
const build=(cues,{isFirst=false,...overrides}={})=>captureEdition({
  identity:story,fileKey:isFirst?fileA:fileB,label:isFirst?'First cut':'Second cut',
  duration:isFirst?52:66,sessionId:isFirst?'first-run':'second-run',track:isFirst?1:2,offset:0,cues,...overrides
});
const shifted=(cues,offset)=>cues.map(row=>({
  ...row,startTime:Math.max(0,row.startTime+offset),endTime:Math.max(Math.max(0,row.startTime+offset)+.01,row.endTime+offset)
}));

test('independently shifted cuts align before and after a localized inserted dialogue block',()=>{
  const a=build(first,{isFirst:true}),b=build(second);
  assert.ok(a&&b);
  const comparison=compareEditions(a,b);
  assert.equal(comparison.status,'ready');
  const shared=comparison.spans.filter(span=>span.kind==='shared');
  assert.deepEqual(shared.map(span=>span.offset),[2,14]);
  assert.deepEqual(shared.map(span=>span.jumpSecond),[6,42]);
  assert.equal(comparison.counts.secondOnly,1);
  const insertion=comparison.spans.find(span=>span.kind==='second-only');
  assert.deepEqual(insertion.first,[22,28]);
  assert.deepEqual(insertion.second,[24,42]);
  assert.equal(insertion.jumpSecond,undefined);
  assert.deepEqual(comparison.spans[0].first,[0,4]);
  assert.equal(comparison.spans.at(-1).kind,'uncertain');
  assert.equal(JSON.stringify(comparison).includes('ferryman'),false);
  assert.equal(JSON.stringify(a).includes('lantern'),false);
});

test('a split subtitle line remains matchable without assuming the second line is a new anchor',()=>{
  const reflow=second.flatMap(row=>row.text===phrases[4]?
    [cue(row.startTime,'Only the baker knows',.8),cue(row.startTime+.8,'where she buried the compass.',.7)]:[row]);
  const result=compareEditions(build(first,{isFirst:true}),build(reflow));
  assert.equal(result.status,'ready');
  assert.deepEqual(result.spans.filter(span=>span.kind==='shared').map(span=>span.offset),[2,14]);
});

test('identical subtitle evidence is rejected even when adjusted cue starts are clipped',()=>{
  const a=build(first,{isFirst:true});
  const b=build(shifted(first,-6),{offset:-6,originalTimes:first.map(({startTime,endTime})=>[startTime,endTime])});
  assert.equal(compareEditions(a,b).status,'duplicate-track');
  assert.equal(compareEditions(a,build(shifted(first,3),{offset:3})).status,'duplicate-track');
});

test('file and verified story must both be independently identified',()=>{
  const a=build(first,{isFirst:true});
  assert.equal(compareEditions(a,build(second,{fileKey:fileA})).status,'same-file');
  assert.equal(compareEditions(a,build(second,{identity:'movie:wikipedia-99:2024:midnight bridge'})).status,'wrong-title');
  assert.equal(compareEditions(a,build(second,{sessionId:'first-run'})).status,'same-file');
  assert.equal(build(first,{sessionId:''}),null);
  assert.equal(build(first,{track:-1}),null);
});

test('sparse or indistinguishably repeated dialogue cannot establish an alignment',()=>{
  const a=build(first,{isFirst:true});
  const repeated=first.flatMap(({startTime,text})=>[cue(startTime+2,text),cue(startTime+3.8,text)]);
  assert.equal(compareEditions(a,build(repeated)).status,'insufficient');
  assert.equal(compareEditions(a,build(second.slice(0,2))).status,'insufficient');
});

test('a crossing dialogue order leaves its enclosing interval uncertain',()=>{
  const reordered=first.map(({startTime,text},index)=>cue(startTime+2,index===3?phrases[4]:index===4?phrases[3]:text));
  const result=compareEditions(build(first,{isFirst:true}),build(reordered));
  assert.equal(result.status,'ready');
  assert.ok(result.spans.some(span=>span.kind==='uncertain'&&span.first[0]<22&&span.first[1]>28));
  assert.equal(result.counts.firstOnly+result.counts.secondOnly,0);
});

test('silent extra runtime, isolated unmatched dialogue and unknown tails are not attributed as an edit',()=>{
  const noExtraWords=second.filter(({text})=>!text.includes('ferryman')&&!text.includes('postcard'));
  const result=compareEditions(build(first,{isFirst:true,duration:null}),build(noExtraWords));
  assert.equal(result.status,'ready');
  assert.equal(result.counts.secondOnly,0);
  assert.ok(result.spans.some(span=>span.kind==='uncertain'&&span.first[0]===22&&span.second[1]===42));
  assert.equal(result.spans.at(-1).kind,'uncertain');
});

test('reversing the cuts reports evidence on the first track only',()=>{
  const result=compareEditions(build(second,{isFirst:true,duration:66}),build(first,{duration:52}));
  assert.equal(result.status,'ready');
  assert.equal(result.counts.firstOnly,1);
  assert.equal(result.counts.secondOnly,0);
  assert.deepEqual(result.spans.filter(span=>span.kind==='shared').map(span=>span.offset),[-2,-14]);
});

test('different dialogue in an equal-length bracket stays uncertain',()=>{
  const changed=first.map(({startTime,text})=>cue(startTime+2,text));
  changed.splice(4,0,cue(25.75,'My little brother put the copper money under your chair.',.75),
    cue(27.75,'She left a folded paper beside the yellow bicycle.',.75));
  const result=compareEditions(build(first,{isFirst:true}),build(changed));
  assert.equal(result.status,'ready');
  assert.equal(result.counts.secondOnly,0);
  assert.ok(result.spans.some(span=>span.kind==='uncertain'&&span.first[0]===22&&span.first[1]===28));
});

test('dense alternating evidence is capped and the undisplayed remainder is uncertain',()=>{
  const many=Array.from({length:140},(_,index)=>cue(4+index*6,'Marker '+index+' should remain beneath the old lighthouse tonight.'));
  const varying=many.map((row,index)=>cue(row.startTime+2+(Math.floor(index/2)%2)*4,row.text));
  const result=compareEditions(build(many,{isFirst:true,duration:850}),build(varying,{duration:856}));
  assert.equal(result.status,'ready');
  assert.ok(result.spans.length<=64);
  assert.equal(result.spans.at(-1).kind,'uncertain');
  assert.equal(result.spans.at(-1).second[1],856);
  assert.equal(Object.values(result.counts).reduce((sum,value)=>sum+value,0),result.spans.length);
});

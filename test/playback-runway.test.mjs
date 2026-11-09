import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlaybackRunway} from '../public/playback-runway.js';

const sample=(changes={})=>({
  now:0,key:'movie:0:generation-1',mode:'hls',complete:false,position:2,playbackRate:1,phase:'playing',
  buffered:[[0,8]],manifest:[[0,40]],duration:120,visible:true,...changes
});
const trace=(runway,times,changes,edge=40)=>times.map(time=>runway.observe(sample({
  now:time*1000,position:time+2,manifest:[[0,edge]],...changes(time)
}))).at(-1);

test('ahead starts at the playhead and ends at the first actual gap in either range',()=>{
  const runway=createPlaybackRunway();
  const state=runway.observe(sample({position:10,buffered:[[0,8],[10,15],[15,18],[18.01,80]],
    manifest:[[22,90],[10,20],[2,10]],duration:180}));
  assert.equal(state.bufferedAhead,8);
  assert.equal(state.preparedAhead,10);
  assert.equal(runway.observe(sample({position:9,buffered:[[10,30]],manifest:[[10,50]]})).bufferedAhead,0);
  assert.equal(runway.observe(sample({position:9,manifest:[[10,50]]})).preparedAhead,0);
});

test('native HLS without a fragment playlist cannot use seekable or aggregate prepared coverage',()=>{
  const state=createPlaybackRunway().observe(sample({manifest:[],buffered:[[0,6]],seekable:[[0,120]],publishedDuration:90}));
  assert.equal(state.bufferedAhead,4);
  assert.equal(state.preparedAhead,null);
  assert.equal(state.estimate,null);
  assert.equal(state.trend,'unavailable');
});

test('direct playback uses the browser buffer even when its metadata is seekable to the end',()=>{
  const state=createPlaybackRunway().observe(sample({mode:'direct',buffered:[[0,8]],seekable:[[0,120]],manifest:[[0,90]]}));
  assert.equal(state.bufferedAhead,6);
  assert.equal(state.preparedAhead,null);
  assert.equal(state.trend,'unavailable');
  assert.equal(state.estimate,null);
});

test('a sustained unchanged edge estimates depletion from the prepared span, not browser buffer',()=>{
  const runway=createPlaybackRunway();
  const first=trace(runway,[0,4,8],()=>({}),27);
  assert.equal(first.trend,'collecting');
  const result=trace(runway,[12],time=>({buffered:[[time+2,time+5]]}),27);
  assert.equal(result.bufferedAhead,3);
  assert.equal(result.preparedAhead,13);
  assert.equal(result.trend,'draining');
  assert.ok(result.estimate.earliest<=13&&result.estimate.latest>=13);
  assert.ok(result.estimate.latest<18);
});

test('batched fragment delivery at the playback pace does not falsely predict a stall',()=>{
  const runway=createPlaybackRunway();
  const result=trace(runway,[0,2,4,6,8,10,12,14,16,18],time=>({manifest:[[0,20+6*Math.floor(time/6)]]}));
  assert.ok(['steady','uncertain'].includes(result.trend));
  assert.equal(result.estimate,null);
  const steady=createPlaybackRunway();
  assert.equal(trace(steady,[0,4,8,12],time=>({manifest:[[0,20+time]]})).trend,'steady');
});

test('published growth below playback speed gives a bounded conditional estimate',()=>{
  const runway=createPlaybackRunway();
  const state=trace(runway,[0,2,4,6,8,10,12,14,16,18,20,22,24],
    time=>({manifest:[[0,23+4*Math.floor(time/8)]]}));
  assert.equal(state.trend,'draining');
  assert.ok(state.estimate.earliest>0&&state.estimate.latest<60);
  assert.ok(state.estimate.earliest<=18&&state.estimate.latest>=18);
});

test('wall time accounts for playback speed, and changing rate starts a fresh observation',()=>{
  const runway=createPlaybackRunway();
  const state=trace(runway,[0,4,8,12],time=>({position:time*2+2,playbackRate:2}),44);
  assert.equal(state.preparedAhead,18);
  assert.equal(state.trend,'draining');
  assert.ok(state.estimate.earliest<=9&&state.estimate.latest>=9&&state.estimate.latest<12);
  const changed=trace(runway,[14],()=>({position:28,playbackRate:1}),44);
  assert.equal(changed.trend,'collecting');
  assert.equal(changed.estimate,null);
});

test('seeking, visibility, recovery, clock gaps, new source, and regression discard a forecast',()=>{
  const resetCases=[
    {position:4}, {position:28}, {phase:'waiting'}, {phase:'paused'}, {phase:'blocked'},
    {visible:false}, {key:'new-run'}, {now:8000}, {now:22000}, {manifest:[[0,19]]},
    {manifest:[[9,40]]}
  ];
  for(const change of resetCases){
    const runway=createPlaybackRunway();
    assert.equal(trace(runway,[0,4,8,12],()=>({})).trend,'draining');
    const result=trace(runway,[14],()=>change);
    assert.equal(result.estimate,null,JSON.stringify(change));
    const resumed=trace(runway,[16],()=>({}));
    assert.equal(resumed.estimate,null,JSON.stringify(change));
  }
});

test('long horizons and a published whole remainder do not display a countdown',()=>{
  const runway=createPlaybackRunway();
  assert.equal(trace(runway,[0,4,8,12],()=>({}),100).estimate,null);
  const finished=createPlaybackRunway().observe(sample({complete:true,manifest:[[0,120]]}));
  assert.equal(finished.complete,true);
  assert.equal(finished.estimate,null);
  const finalSpan=trace(createPlaybackRunway(),[0,4,8,12],()=>({duration:25}),25);
  assert.equal(finalSpan.estimate,null);
});

test('crossing adjacent HLS fragments keeps one contiguous publication frontier',()=>{
  const runway=createPlaybackRunway();
  const fragments=Array.from({length:13},(_,index)=>[2*index,2*(index+1)]);
  const state=trace(runway,[0,4,8,12],()=>({manifest:fragments}));
  assert.equal(state.preparedAhead,12);
  assert.equal(state.trend,'draining');
});

test('an early publication burst ages out while the current edge stays flat',()=>{
  const runway=createPlaybackRunway();
  const result=trace(runway,[0,2,4,6,8,10,12,14,16,18,20],time=>({
    position:2+time*1.5,playbackRate:1.5,manifest:[[0,time<4?8:36]],
  }));
  assert.equal(result.trend,'draining');
  assert.ok(result.estimate.earliest<=4/1.5&&result.estimate.latest>=4/1.5);
  assert.ok(result.estimate.latest<5);
});

test('a known long batch cadence is not confused with a flat edge between batches',()=>{
  const runway=createPlaybackRunway();
  const times=[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38,40];
  const result=trace(runway,times,time=>({manifest:[[0,time<4?42:time<24?63:84]]}));
  assert.equal(result.trend,'uncertain');
  assert.equal(result.estimate,null);
});

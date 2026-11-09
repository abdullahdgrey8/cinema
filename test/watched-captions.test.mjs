import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonicalWatchedCues,watchedCueDigest,eligibleWatchedCues,matchWatchedCues,searchWatchedCaptions} from '../public/watched-captions.js';

test('canonical caption identity keeps overlaps, duplicates and empty rendered cues',async()=>{
  const raw=[[2000,4000,' A  & B '],[1000,2250,'Cafe\u0301'],[3000,3100,''],[2000,4000,'A & B']];
  const cues=canonicalWatchedCues(raw);
  assert.deepEqual(cues,[[1000,2250,'Café'],[2000,4000,'A & B'],[2000,4000,'A & B'],[3000,3100,'']]);
  assert.equal(await watchedCueDigest(raw),await watchedCueDigest(cues));
  assert.notEqual(await watchedCueDigest(raw),await watchedCueDigest([...raw,[3900,4100,'Another line']]));
  assert.equal(canonicalWatchedCues([[1,0,'bad']]),null);
});

test('only whole cues within both exact groups survive, including offset and positive gaps',()=>{
  const all=[[0,1000,'opening boundary'],[1000,1800,'meet me'],[1900,2500,'at dawn'],
    [4500,5100,'crosses end'],[5200,6300,'skipped'],[7000,8100,'next chapter'],[9000,9100,'future']];
  const watched=eligibleWatchedCues(all,[[1000,5000],[7000,9000]],[[900,2800],[4300,5000],[7200,9000]],{offsetMs:100});
  assert.deepEqual(watched.map(cue=>[cue.startMs,cue.endMs,cue.text]),[[1100,1900,'meet me'],[2000,2600,'at dawn']]);
  assert.deepEqual(matchWatchedCues(watched,'meet me at dawn').map(hit=>[hit.startMs,hit.endMs,hit.text]),
    [[1100,2600,'meet me at dawn']]);
  assert.deepEqual(eligibleWatchedCues(all,[],[[0,10000]]),[]);
});

test('a nearby pair of watched cues cannot bridge even a short unobserved gap',()=>{
  const cues=eligibleWatchedCues([[1000,1500,'where are'],[1900,2300,'the keys']],[[800,1600],[1800,2400]],[[800,2500]]);
  assert.equal(cues.length,2);
  assert.deepEqual(matchWatchedCues(cues,'are the keys'),[]);
});

test('changed unwatched text does not reveal a result or alter ordering under separately verified caption identities',async()=>{
  const run=async text=>{
    const cues=[[1000,1500,'The map is here'],[3000,4000,text],[5500,6250,'Map in second passage']];
    const digest=await watchedCueDigest(cues);
    const record={hash:'a'.repeat(40),index:2,updatedAt:1,video:[[900,1700],[5100,6500]],caption:{id:'b'.repeat(32),digest,offsetMs:0,ranges:[[900,1700],[5100,6500]]}};
    return searchWatchedCaptions([record],{
      query:'map',verify:async()=>true,
      read:async()=>({bytes:200,cues,digest})
    });
  };
  const first=await run('map in unwatched scene'),second=await run('another unwatched phrase');
  assert.deepEqual(first.matches.map(match=>match.text),['The map is here','Map in second passage']);
  assert.deepEqual(first.matches.map(({startMs,endMs,text})=>({startMs,endMs,text})),second.matches.map(({startMs,endMs,text})=>({startMs,endMs,text})));
  assert.equal(first.limited,second.limited);
});

test('a changed file or same-ID changed caption produces the same empty result and skips unverified reads',async()=>{
  let calls=0;
  const record={hash:'a'.repeat(40),index:0,updatedAt:1,video:[[0,5000]],caption:{id:'b'.repeat(32),digest:'c'.repeat(64),offsetMs:0,ranges:[[0,5000]]}};
  const opts={query:'line',read:async()=>{calls++;return {bytes:100,digest:'d'.repeat(64),cues:[[1000,2000,'line']]};}};
  assert.deepEqual(await searchWatchedCaptions([record],{...opts,verify:async()=>false}),{matches:[],limited:false});
  assert.equal(calls,0);
  assert.deepEqual(await searchWatchedCaptions([record],{...opts,verify:async()=>true}),{matches:[],limited:false});
  assert.equal(calls,1);
});

test('caption coverage survives an exact rewatch out of media order',()=>{
  const watch=[[5500,8000],[900,4500]],captions=[[5500,8000],[900,4500]];
  const result=eligibleWatchedCues([[1000,2000,'early'],[6000,7000,'late']],watch,captions);
  assert.deepEqual(result.map(cue=>cue.text),['early','late']);
});

test('library caption loading stays in recent order with two reads and a fixed 12 MiB budget',async()=>{
  const records=Array.from({length:14},(_,index)=>({
    hash:(index+1).toString(16).padStart(40,'0'),index,updatedAt:index,video:[[0,5000]],
    caption:{id:(index+1).toString(16).padStart(32,'0'),digest:'b'.repeat(64),offsetMs:0,ranges:[[0,5000]]}
  }));
  let inflight=0,peak=0;
  const reads=[];
  const result=await searchWatchedCaptions(records,{query:'map',verify:async()=>true,
    read:async(id,limit)=>{
      reads.push(parseInt(id,16));
      assert.equal(limit,1024*1024);
      inflight++;peak=Math.max(peak,inflight);
      await new Promise(resolve=>setImmediate(resolve));inflight--;
      return {bytes:limit,cues:[[1000,2000,'map']],digest:'b'.repeat(64)};
    }});
  assert.equal(peak,2);
  assert.deepEqual(reads,[14,13,12,11,10,9,8,7,6,5,4,3]);
  assert.equal(result.matches.length,12);
  assert.equal(result.limited,true);
});

test('visible matches and eligible cue work have independent ceilings',async()=>{
  const base={hash:'a'.repeat(40),index:0,updatedAt:1,video:[[0,500000]],
    caption:{id:'b'.repeat(32),digest:'c'.repeat(64),offsetMs:0,ranges:[[0,500000]]}};
  const small=Array.from({length:61},(_,i)=>[i*4,i*4+2,'map']);
  const capped=await searchWatchedCaptions([base],{query:'map',verify:async()=>true,
    read:async()=>({bytes:200,cues:small,digest:'c'.repeat(64)})});
  assert.equal(capped.matches.length,60);
  assert.equal(capped.limited,true);
  const many=Array.from({length:32001},(_,i)=>[i*4,i*4+2,i===32000?'map':'another phrase']);
  const two=await searchWatchedCaptions([base,{...base,index:1}],{query:'map',verify:async()=>true,
    read:async()=>({bytes:200,cues:many,digest:'c'.repeat(64)})});
  assert.equal(two.matches.length,1);
  assert.equal(two.limited,true);
});

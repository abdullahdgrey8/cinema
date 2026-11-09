import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEpisodes} from '../episodes.mjs';

const episode=(id,fields={})=>({id,season:1,number:id,type:'regular',name:'Episode '+id,...fields});
const aprilClock=Date.parse('2026-04-18T12:00:00Z');

test('schedule preserves provider precision, bounds dates by UTC day, and coalesces an exact cold show lookup',async t=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const calls=[];
  const rows=[
    episode(1,{airdate:'2026-04-17',airtime:'00:35',airstamp:'2026-04-18T00:35:00-05:00'}),
    episode(2,{airdate:'2026-04-18',airtime:'',airstamp:'2026-04-18T12:00:00+00:00'}),
    episode(3,{airdate:'2026-04-19',airtime:'00:00',airstamp:'2026-04-19T00:00:00+09:00'}),
    episode(4,{airdate:'2026-04-20',airtime:'08:15',airstamp:'2026-04-20T08:15:00'}),
    episode(5,{airdate:'2026-04-31',airtime:'10:00',airstamp:'2026-04-31T10:00:00+00:00'}),
    episode(6,{airdate:'2026-04-01'}),
    episode(7,{airdate:'2026-04-02',airtime:'23:15',airstamp:'2026-04-01T23:15:00-03:00'}),
    episode(8,{airdate:'2026-05-23'}),
    episode(9,{airdate:'2026-05-24'}),
    episode(10,{season:0,number:null,type:'significant_special',airdate:'2026-04-21'}),
    episode(11,{airdate:'',airtime:null,airstamp:null})
  ];
  const service=createEpisodes({now:()=>aprilClock,fetchImpl:async url=>{
    calls.push(new URL(url).pathname+new URL(url).search);
    await gate;
    return Response.json(rows);
  }});
  t.after(()=>service.close());
  await assert.rejects(()=>service.schedule({showId:'Example Series'}),{status:400});
  const first=service.schedule({showId:'tvmaze-42'}),second=service.schedule({showId:'tvmaze-42'});
  release();
  const data=await first;
  assert.deepEqual(await second,data);
  assert.deepEqual(calls,['/shows/42/episodes?specials=1']);
  assert.equal(data.showId,'tvmaze-42');
  assert.equal(data.updatedAt,aprilClock);
  assert.equal(data.undatedCount,2);
  const lookup=id=>data.episodes.find(row=>row.id==='tvmaze-episode-'+id);
  assert.deepEqual(lookup(1),{id:'tvmaze-episode-1',title:'Episode 1',season:1,number:1,special:false,
    schedule:{precision:'instant',date:'2026-04-17',at:'2026-04-18T05:35:00.000Z'}});
  assert.deepEqual(lookup(2).schedule,{precision:'date',date:'2026-04-18',at:null});
  assert.deepEqual(lookup(3).schedule,{precision:'instant',date:'2026-04-19',at:'2026-04-18T15:00:00.000Z'});
  assert.deepEqual(lookup(4).schedule,{precision:'date',date:'2026-04-20',at:null});
  assert.equal(lookup(5),undefined);
  assert.equal(lookup(6),undefined);
  assert.ok(lookup(7),'UTC instant day is used at the lower boundary');
  assert.ok(lookup(8),'Upper boundary is inclusive');
  assert.equal(lookup(9),undefined);
  assert.equal(lookup(10).special,true);
  assert.equal(lookup(11),undefined);
  assert.deepEqual(await service.schedule({showId:'tvmaze-42'}),data);
  assert.equal(calls.length,1);
});


test('cached catalog and intent follow the current clock and update dependent anime numbering',async t=>{
  let time=Date.parse('2026-04-18T05:34:59.999Z');
  const calls=[];
  const service=createEpisodes({now:()=>time,catalogTtlMs:24*60*60*1000,fetchImpl:async url=>{
    const location=new URL(url);
    calls.push(location.pathname+location.search);
    switch(location.pathname){
      case '/shows/7':
        return Response.json({id:7,name:'Clock Anime',premiered:'2026-04-17',
          type:'Animation',language:'Japanese',status:'Running'});
      case '/shows/7/seasons':
        return Response.json([{number:1,episodeOrder:1,endDate:'2026-04-17'},{number:2,episodeOrder:2}]);
      case '/shows/7/akas':
        return Response.json([]);
      case '/shows/7/episodes':
        return Response.json([
          episode(31,{number:1,airdate:'2026-04-17',airtime:'00:35',airstamp:'2026-04-18T00:35:00-05:00'}),
          episode(32,{season:2,number:1,airdate:'2026-04-18',airtime:'',airstamp:'2026-04-18T11:00:00+00:00'}),
          episode(33,{season:2,number:2,airdate:null})
        ]);
      default: throw Error('Unexpected provider request '+location);
    }
  }});
  t.after(()=>service.close());
  const id='tvmaze-7', selected=episodeId=>({showId:id,episodeId:'tvmaze-episode-'+episodeId});
  const first=await service.catalog({id});
  assert.equal(first.cached,false);
  assert.equal(first.airedEpisodes,0);
  assert.equal(first.episodes[0].searchable,false);
  assert.equal(first.episodes[1].absoluteNumber,null);
  assert.throws(()=>service.resolveIntent(selected(31)),/not aired/);
  assert.equal((await service.schedule({showId:id})).updatedAt,first.updatedAt);
  assert.equal(calls.length,4);
  time++;
  assert.equal(service.resolveIntent(selected(31)).absoluteNumber,1,'Intent must use the current clock without requiring a catalog refresh');
  const exact=await service.catalog({id});
  assert.equal(exact.cached,true);
  assert.equal(exact.updatedAt,first.updatedAt);
  assert.equal(exact.airedEpisodes,1);
  assert.equal(exact.seasons[0].airedEpisodes,1);
  assert.equal(exact.episodes[1].absoluteNumber,2);
  assert.equal(first.airedEpisodes,0,'Earlier responses remain snapshots');
  time=Date.parse('2026-04-18T11:00:00Z');
  assert.throws(()=>service.resolveIntent(selected(32)),/not aired/,'A synthetic stamp must not enable episode lookup at a made-up time');
  time=Date.parse('2026-04-18T23:59:59Z');
  assert.equal(service.resolveIntent(selected(32)).absoluteNumber,2);
  const dateOnly=await service.catalog({id});
  assert.equal(dateOnly.episodes[1].aired,true);
  assert.equal(dateOnly.episodes[1].searchable,true);
  assert.equal(dateOnly.episodes[2].aired,null);
  assert.equal(dateOnly.episodes[2].searchable,true,'Unknown dates preserve the existing manual source search');
  assert.equal(dateOnly.airedEpisodes,2);
  assert.equal(calls.length,4);
});


test('schedule work stays bounded and a provider error neither poisons cache nor blocks another show',async t=>{
  let release,working=0,peak=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const attempts=new Map();
  const service=createEpisodes({now:()=>aprilClock,fetchImpl:async url=>{
    const id=new URL(url).pathname.split('/')[2];
    attempts.set(id,(attempts.get(id)||0)+1);
    working++;peak=Math.max(peak,working);
    try{
      await gate;
      if(id==='1'&&attempts.get(id)===1)return Response.json({}, {status:503});
      return Response.json([episode(Number(id),{airdate:'2026-04-18'})]);
    }finally{working--;}
  }});
  t.after(()=>service.close());
  const requested=Array.from({length:12},(_,i)=>service.schedule({showId:'tvmaze-'+(i+1)}));
  const coalesced=service.schedule({showId:'tvmaze-12'});
  const excess=service.schedule({showId:'tvmaze-13'}).then(()=>null,error=>error.status);
  const settled=Promise.allSettled(requested);
  release();
  assert.equal(await excess,429);
  const result=await settled;
  assert.equal(result[0].status,'rejected');
  assert.equal(result[0].reason.status,502);
  assert.equal(result[1].value.episodes[0].id,'tvmaze-episode-2');
  assert.deepEqual(await coalesced,result.at(-1).value);
  assert.equal(attempts.get('12'),1);
  assert.ok(peak<=2);
  const retry=await service.schedule({showId:'tvmaze-1'});
  assert.equal(retry.episodes[0].id,'tvmaze-episode-1');
  assert.equal(attempts.get('1'),2);
});


test('a schedule reuses a completed episode response while the same full catalog is still loading',async t=>{
  let seasonsReady,episodeFetched;
  const seasonsGate=new Promise(resolve=>{seasonsReady=resolve;});
  const episodeResponse=new Promise(resolve=>{episodeFetched=resolve;});
  let episodeCalls=0;
  const service=createEpisodes({now:()=>aprilClock,fetchImpl:async url=>{
    switch(new URL(url).pathname){
      case '/shows/2':return Response.json({id:2,name:'Example',type:'Scripted',language:'English'});
      case '/shows/2/seasons':await seasonsGate;return Response.json([{number:1,episodeOrder:1}]);
      case '/shows/2/akas':return Response.json([]);
      case '/shows/2/episodes':
        episodeCalls++;episodeFetched();
        return Response.json([episode(1,{airdate:'2026-04-18'})]);
      default:throw Error('Unexpected provider request');
    }
  }});
  t.after(()=>service.close());
  const full=service.catalog({id:'tvmaze-2'});
  try{
    await episodeResponse;
    await new Promise(resolve=>setImmediate(resolve));
    const result=await service.schedule({showId:'tvmaze-2'});
    assert.equal(result.episodes[0].id,'tvmaze-episode-1');
    assert.equal(episodeCalls,1);
  }finally{seasonsReady();await full;}
});


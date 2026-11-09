import assert from 'node:assert/strict';
import {test} from 'node:test';
import {weekDays,groupWeekEpisodes} from '../public/follow-week.js';

const series={id:'tvmaze-12',title:'Followed Series',kind:'tv'};
const another={id:'tvmaze-13',title:'Another Series',kind:'anime'};
const episode=(id,schedule)=>({id:'tvmaze-episode-'+id,title:'Episode '+id,season:1,number:id,schedule});
const schedule=(show,episodes,undatedCount=0)=>({showId:show.id,episodes,undatedCount});
const index=(...rows)=>new Map(rows.map(row=>[row.showId,row]));
const utc=value=>Date.parse(value);
const options={now:utc('2026-11-08T21:30:00Z'),timeZone:'Asia/Karachi'};
const forDate=(result,date)=>result.days.find(day=>day.key===date).episodes;

test('the selected week starts on the device local Monday and retains seven calendar dates',()=>{
  const current=weekDays(options);
  assert.equal(current.today,'2026-11-09');
  assert.deepEqual(current.days,['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15']);
  assert.equal(weekDays({...options,offset:-1}).days[0],'2026-11-02');
  assert.equal(weekDays({...options,offset:2}).days[6],'2026-11-29');
});

test('an instant moves to its local calendar day, but a date-only listing keeps the provider date',()=>{
  const timed=episode(1,{precision:'instant',at:'2026-11-08T20:00:00+00:00',date:'2026-11-08'});
  const dateOnly=episode(2,{precision:'date',date:'2026-11-08',at:'2026-11-08T00:00:00Z'});
  const data=index(schedule(series,[dateOnly,timed]));
  const current=groupWeekEpisodes([series],data,options);
  assert.deepEqual(forDate(current,'2026-11-09').map(row=>[row.episode.number,row.phase]),[[1,'aired']]);
  const previous=groupWeekEpisodes([series],data,{...options,offset:-1});
  assert.deepEqual(forDate(previous,'2026-11-08').map(row=>[row.episode.number,row.phase,row.at]),[[2,'date',null]]);
});

test('DST transition keeps local calendar days and orders both repeated-hour instants',()=>{
  const first=episode(1,{precision:'instant',at:'2026-11-01T01:30:00-04:00'});
  const second=episode(2,{precision:'instant',at:'2026-11-01T01:30:00-05:00'});
  const data=index(schedule(series,[second,first]));
  const result=groupWeekEpisodes([series],data,{now:utc('2026-11-01T06:00:00Z'),timeZone:'America/New_York'});
  assert.equal(result.today,'2026-11-01');
  assert.equal(result.days[0].key,'2026-10-26');
  assert.deepEqual(forDate(result,'2026-11-01').map(row=>[row.episode.number,row.phase]),[[1,'aired'],[2,'upcoming']]);
});

test('unannounced or invalid times stay outside the week and old unfollowed snapshots cannot reappear',()=>{
  const unknown=episode(1,{precision:'unknown'});
  const malformed=episode(2,{precision:'instant',at:'2026-11-12T19:30:00'});
  const valid=episode(3,{precision:'date',date:'2026-11-11'});
  const impossible=episode(4,{precision:'date',date:'2026-11-31'});
  const data=index(schedule(series,[unknown,malformed,valid,impossible],3),schedule(another,[valid],5));
  const result=groupWeekEpisodes([series],data,options);
  assert.equal(result.undatedCount,3);
  assert.deepEqual(forDate(result,'2026-11-11').map(row=>row.show.id),[series.id]);
  assert.equal(result.days.flatMap(day=>day.episodes).length,1);
  assert.equal(groupWeekEpisodes([],data,options).days.flatMap(day=>day.episodes).length,0);
});

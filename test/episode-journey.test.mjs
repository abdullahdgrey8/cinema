import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bestEpisodePlaybackSource,buildEpisodeJourney,findVerifiedLocalEpisode} from '../public/episodes.js';

const showId='tvmaze-123';
const episodes=[
  {id:'e1',season:1,number:1,aired:true,searchable:true},
  {id:'e2',season:1,number:2,aired:true,searchable:true},
  {id:'e3',season:2,number:1,aired:true,searchable:true},
  {id:'e4',season:2,number:2,aired:false,searchable:true},
  {id:'e5',season:2,number:3,aired:null,searchable:true},
  {id:'s1',season:2,number:0,aired:true,special:true}
];
const catalog={show:{id:showId},episodes};
const watched=(episodeId,updated,options={})=>({index:0,time:1380,finished:true,updated,episode:{showId,episodeId},...options});
const build=(history={},library=[])=>buildEpisodeJourney(catalog,history,library.map(hash=>({hash})));

test('the latest unfinished episode resumes the same present file',()=>{
  const journey=build({first:watched('e1',5),pack:{files:{4:watched('e2',9,{index:4,time:188,finished:false})}}},['pack']);
  assert.equal(journey.next.episode.id,'e2');
  assert.equal(journey.next.mode,'resume');
  assert.deepEqual(journey.next.resume,{hash:'pack',index:4,time:188});
  assert.equal(journey.watchedCount,1);
});

test('a watched episode advances across seasons and counts duplicate releases once',()=>{
  const journey=build({first:watched('e1',5),pack:watched('e2',9),duplicate:watched('e2',4)},['pack']);
  assert.deepEqual([...journey.episodeStates],[['e1','watched'],['e2','watched']]);
  assert.equal(journey.next.episode.id,'e3');
  assert.equal(journey.next.mode,'next');
  assert.equal(journey.airedCount,3);
});

test('the next episode can be checked in the last verified same-season torrent',()=>{
  const history={pack:watched('e1',6)};
  assert.equal(build(history,['pack']).next.packHash,'pack');
  assert.equal(build(history).next.packHash,null);
});

test('a removed release keeps progress but no longer offers direct resume',()=>{
  const journey=build({removed:watched('e1',5,{time:60,finished:false}),old:watched('e1',3,{time:45,finished:false})},['old']);
  assert.equal(journey.episodeStates.get('e1'),'in-progress');
  assert.equal(journey.next.episode.id,'e1');
  assert.equal(journey.next.resume,null);
});

test('untagged and other-show history do not mark episodes; unavailable episodes do not advance',()=>{
  const history={legacy:{index:0,time:1380,finished:true,fileName:'Series.S01E01.mkv'},other:watched('e1',10,{episode:{showId:'other-show',episodeId:'e1'}})};
  assert.equal(build(history).watchedCount,0);
  assert.equal(build(history).next.mode,'start');
  const completed={...history,first:watched('e1',3),second:watched('e2',4),third:watched('e3',5)};
  assert.equal(build(completed).next,null);
});

test('pack playback requires one verified single-episode file with the requested identity',async()=>{
  const input={hash:'pack',showId,episodeId:'e2'};
  const exact={verified:true,singleEpisode:true,index:4,intent:{showId,episodeId:'e2'}};
  const find=(target,expectedIndex)=>findVerifiedLocalEpisode(async (route,request)=>{
    assert.equal(route,'/api/episodes/file');
    assert.deepEqual(request,input);
    return target;
  },{...input,expectedIndex});
  assert.deepEqual(await find(exact),exact);
  assert.equal(await find({...exact,singleEpisode:false}),null);
  assert.equal(await find({...exact,verified:false}),null);
  assert.equal(await find({...exact,intent:{showId,episodeId:'e3'}}),null);
  assert.equal(await find(exact,2),null);
  assert.deepEqual(await find(exact,4),exact);
  assert.equal(await findVerifiedLocalEpisode(async()=>{throw Error('Torrent removed');},input),null);
});

test('the episode recommendation prefers a verified local copy then the first ranked seeded source',()=>{
  const unseeded={key:'unseeded',nbSeeders:0};
  const unknown={key:'unknown',nbSeeders:-1};
  const local={key:'local',existingHash:'pack',nbSeeders:40};
  const bestRemote={key:'best-remote',nbSeeders:8};
  const nextRemote={key:'next-remote',nbSeeders:20};
  const unavailable=()=>false;
  const sources=[unseeded,unknown,local,bestRemote,nextRemote];
  assert.equal(bestEpisodePlaybackSource(sources,source=>source===local),local);
  assert.equal(bestEpisodePlaybackSource(sources,unavailable),bestRemote);
  assert.equal(bestEpisodePlaybackSource([unseeded,unknown,local],unavailable),null);
});

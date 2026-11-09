import test from 'node:test';
import assert from 'node:assert/strict';
import {createFollowStore,checkFollowEpisode} from '../public/follow-week-data.js';

const show={id:'tvmaze-12',title:'Signal Run',kind:'korean',year:2026,posterUrl:'/api/metadata/poster?id=fixture'};
const episode={id:'tvmaze-episode-99',season:1,number:2};
const hash='a'.repeat(40);
const subtitleId='c'.repeat(32);

test('following persists only the verified display record and rejects a thirteenth show',()=>{
  const storage=new Map();
  const make=()=>createFollowStore({getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)});
  const store=make();
  assert.equal(store.follow({...show,secret:'extra'}).ok,true);
  assert.equal(store.follow({id:'justwatch-example',title:'Unverified'}).ok,false);
  assert.deepEqual(make().list(),[show]);
  for(let id=20;id<31;id++)assert.equal(store.follow({...show,id:'tvmaze-'+id}).ok,true);
  assert.match(store.follow({...show,id:'tvmaze-100'}).message,/12/);
  assert.equal(store.unfollow(show.id).ok,true);
  assert.equal(make().list().some(item=>item.id===show.id),false);
});

test('a storage failure preserves the last confirmed follow state',()=>{
  const store=createFollowStore({getItem:()=>JSON.stringify([show]),setItem(){throw Error('Quota');}});
  assert.match(store.unfollow(show.id).message,/save/i);
  assert.deepEqual(store.list(),[show]);
});

function fixture(overrides={}){
  const requests=[];
  const target={verified:true,singleEpisode:true,index:1,intent:{showId:show.id,episodeId:episode.id}};
  const context={show,episode,
    getLibrary:()=>[{hash,name:'Signal.Run.S01.Complete'}],getHistory:()=>({}),
    isConnected:()=>true,
    api:async(route,body)=>{requests.push({route,body});return target;},
    getCaption:()=>({id:subtitleId,origin:'english-search'}),
    checkCaption:async id=>{requests.push({caption:id});return true;},...overrides};
  return {requests,context};
}

test('only an exact episode file and an existing English-search track support both claims',async()=>{
  const f=fixture();
  const checked=await checkFollowEpisode(f.context);
  assert.match(checked.source,/Episode file in My Library/);
  assert.match(checked.captions,/English track saved/);
  assert.deepEqual(f.requests,[
    {route:'/api/episodes/file',body:{hash,showId:show.id,episodeId:episode.id}},{caption:subtitleId}
  ]);
});

test('a wrong episode or a multi-episode file cannot lend its captions',async()=>{
  for(const target of [
    {verified:true,singleEpisode:false,index:1,intent:{showId:show.id,episodeId:episode.id}},
    {verified:true,singleEpisode:true,index:1,intent:{showId:show.id,episodeId:'tvmaze-episode-88'}}
  ]){
    const f=fixture({api:async()=>target,getCaption(){assert.fail('A wrong file cannot authorize caption evidence');}});
    const checked=await checkFollowEpisode(f.context);
    assert.match(checked.source,/No match/);
    assert.match(checked.captions,/Not checked/);
  }
});

test('imported and missing captions keep independent status, even for an exact local episode',async()=>{
  const imported=await checkFollowEpisode(fixture({getCaption:()=>({id:subtitleId,origin:'import'})}).context);
  assert.match(imported.captions,/language unconfirmed/);
  const missing=await checkFollowEpisode(fixture({checkCaption:async()=>false}).context);
  assert.match(missing.source,/Episode file in My Library/);
  assert.match(missing.captions,/missing/);
});

test('disconnection and a release removed during a check produce no readiness claim',async()=>{
  const offline=fixture({isConnected:()=>false});
  assert.match((await checkFollowEpisode(offline.context)).source,/connection/i);
  assert.deepEqual(offline.requests,[]);
  let library=[{hash,name:'Signal.Run.S01.Complete'}];
  const f=fixture({getLibrary:()=>library,api:async()=>{
    library=[];
    return {verified:true,singleEpisode:true,index:1,intent:{showId:show.id,episodeId:episode.id}};
  }});
  assert.doesNotMatch((await checkFollowEpisode(f.context)).source,/Episode file in My Library/);
  assert.deepEqual(f.requests,[]);
});

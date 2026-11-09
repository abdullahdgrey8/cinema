import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../public/watch-planner-model.js';

const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const film=(id,title,year,runtime,extra={})=>({id,title,year,runtime,kind:'movies',isSeries:false,...extra});
const row=(items,extra={})=>({id:'movies',source:'Test chart',periodStart:'2026-11-01',periodEnd:'2026-11-07',items,...extra});
const local=(hash,title)=>({hash,name:title,title,kind:'movies',progress:1,state:'uploading'});
const proof=(index,fileName)=>({index,fileName,size:100});
const associated=(hash)=>({status:'ready',sources:[{existingHash:hash}]});
const planned=(id,title,minutes,extra={})=>({id,title,year:2025,kind:'movies',minutes,durationSource:'catalog-film',...extra});

test('timed picks exclude unknown runtimes, longer films and whole-series averages',()=>{
  const candidates=model.buildPlannerCandidates?.({rows:[row([
    film('justwatch-a','Short one',2025,32,{genres:['Comedy']}),
    film('justwatch-b','Longer one',2026,40),
    film('justwatch-c','Unknown',2026,null),
    {id:'tvmaze-4',title:'Series',kind:'tv',isSeries:true,year:2026,runtime:22}
  ])]});
  assert.deepEqual(candidates?.map(({minutes})=>minutes),[32,40,null,null]);
  assert.deepEqual(model.chooseTonight(candidates,{budgetMinutes:35}).map(({title})=>title),['Short one']);
  assert.deepEqual(model.chooseTonight(candidates,{budgetMinutes:30}),[]);
  assert.deepEqual(model.chooseTonight(candidates,{budgetMinutes:35,mood:'tense'}),[]);
});

test('a local file is associated by exact hash and measured only for the same index and basename',()=>{
  const title=film('justwatch-a','Example',2025,38,{availability:associated(a)});
  const input={rows:[row([title])],library:[local(a,'Example'),local(b,'Example')],connected:true,
    history:{[a]:{files:{2:{index:2,fileName:'Example.2025.mkv',duration:1921}}},
      [b]:{index:1,fileName:'Other.mkv',duration:1700}},
    verifiedFiles:new Map([[a,proof(2,'Example.2025.mkv')],[b,proof(1,'Example.2025.mkv')]])};
  const candidates=model.buildPlannerCandidates(input);
  const linked=candidates.find(item=>item.id===title.id);
  assert.equal(linked.readiness,'local');
  assert.equal(linked.minutes,33);
  assert.equal(linked.durationSource,'measured');
  assert.deepEqual(linked.local,{hash:a,index:2});
  const standalone=candidates.find(item=>item.origin==='library');
  assert.equal(standalone.verifyHash,b);
  assert.equal(standalone.minutes,null);
  assert.equal(model.buildPlannerCandidates({...input,connected:false}).find(item=>item.id===title.id).local,undefined);
  assert.equal(model.buildPlannerCandidates({...input,library:[local(b,'Example')]}).find(item=>item.id===title.id).local,undefined);
});

test('strongly merged saved titles retain film duration and remakes stay separate',()=>{
  const items=[film('justwatch-a','Example',1998,null,{metadataId:'wikipedia-10'}),
    film('netflix-b','Example',2025,41,{metadataId:'wikipedia-11'}),
    film('netflix-duplicate','Example',2025,41,{metadataId:'wikipedia-11'})];
  const candidates=model.buildPlannerCandidates({rows:[row(items)],saved:[film('wikipedia-10','Example',1998,48)]});
  assert.deepEqual(candidates.map(({year,minutes})=>[year,minutes]),[[1998,48],[2025,41]]);
});

test('an exact active episode gets measured time, while a compound or unverified pack does not',()=>{
  const series={...local(c,'Example Series'),kind:'tv'};
  const intent={showId:'tvmaze-9',episodeId:'tvmaze-episode-32',showTitle:'Example Series',episodeTitle:'A New Day'};
  const active={hash:c,index:0,fileName:'Example.S01E02.mkv',duration:1831,ready:true,intent,
    verifiedEpisode:{index:0,showId:intent.showId,episodeId:intent.episodeId}};
  const first=model.buildPlannerCandidates({library:[series],connected:true,active})[0];
  assert.equal(first.minutes,31);
  assert.equal(first.durationSource,'episode');
  assert.equal(first.readiness,'ready');
  assert.deepEqual(first.local,{hash:c,index:0,intent});
  const unverified=model.buildPlannerCandidates({library:[series],connected:true,active:{...active,verifiedEpisode:null},
    verifiedFiles:new Map([[c,proof(0,'Example.S01E01E02.mkv')]])})[0];
  assert.equal(unverified.minutes,null);
  assert.equal(unverified.local,undefined);
});

test('program arithmetic counts a single intermission and leaves an unknown total unknown',()=>{
  const first=planned('justwatch-a','Film A',48),second=planned('justwatch-b','Film B',32);
  assert.deepEqual(model.programTotals([first,second],10),{totalMinutes:90,intermissionMinutes:10});
  assert.deepEqual(model.programTotals([first],10),{totalMinutes:48,intermissionMinutes:0});
  assert.deepEqual(model.programTotals([first,{...second,minutes:null}],10),{totalMinutes:null,intermissionMinutes:10});
  assert.deepEqual(model.suggestProgram([first,second],{budgetMinutes:90,intermissionMinutes:10}),[first,second]);
  assert.deepEqual(model.suggestProgram([first,second],{budgetMinutes:89,intermissionMinutes:10}),[]);
});

test('private ballots reveal only the overlap, using current proof and stable ties',()=>{
  const deck=Array.from({length:8},(_,i)=>({...planned('justwatch-'+i,'Film '+i,30),readiness:'local',local:{hash:a,index:i}}));
  const round=model.ballotDeck(deck);
  assert.equal(round.length,6);
  assert.equal(model.ballotDeck(deck,6)[0].id,'justwatch-6');
  const first=new Set(['justwatch-1','justwatch-2']),second=new Set(['justwatch-2','justwatch-3']);
  const overlap=model.sharedPicks(round,first,second,deck.filter(item=>item.id!=='justwatch-2'));
  assert.deepEqual(overlap.map(item=>item.id),['justwatch-2']);
  assert.equal(overlap[0].local,undefined);
  assert.equal(overlap[0].readiness,'unchecked');
  assert.deepEqual(model.sharedPicks(round,first,new Set(['justwatch-5'])),[]);
});

test('export allows only bounded display metadata, and private plans retain sanitized id',()=>{
  const item=planned('local:'+a,'Film A',48,{local:{hash:a,index:2},sourceUrl:'https://example.test/',votes:[a]});
  const saved=model.saveProgram([item],10);
  assert.deepEqual(model.readProgram(JSON.stringify(saved)),saved);
  assert.equal(saved.items[0].id,'local:'+a);
  assert.equal(saved.intermissionMinutes,10);
  const exported=model.exportProgram([item],10);
  assert.deepEqual(exported,{version:1,items:[{title:'Film A',year:2025,kind:'movies',minutes:48,durationSource:'catalog-film'}],intermissionMinutes:10});
  for(const title of ['magnet:?xt=urn:btih:'+a,'C:\private\video.mkv','https://example.test/title','Film '+a]){
    assert.equal(model.exportProgram([{...item,title}],10),null);
  }
  assert.equal(model.readProgram({...saved,version:2}),null);
});

test('a remembered verified episode can return to its active file without a fresh source intent',()=>{
  const series={...local(c,'Example Series'),kind:'tv'};
  const active={hash:c,index:2,fileName:'Example.S01E02.mkv',duration:1561,ready:true,
    verifiedEpisode:{index:2,showId:'tvmaze-9',episodeId:'tvmaze-episode-32'}};
  const [candidate]=model.buildPlannerCandidates({library:[series],connected:true,active});
  assert.equal(candidate.minutes,27);
  assert.equal(candidate.readiness,'ready');
  assert.equal(candidate.local.index,2);
});

test('a movie torrent with only a sample or stale proof remains unchecked',()=>{
  const item=local(a,'Example');
  const get=(library,file)=>model.buildPlannerCandidates({library,connected:true,verifiedFiles:new Map([[a,file]])})[0];
  assert.equal(get([item],proof(0,'Example.sample.mkv')).readiness,'unchecked');
  assert.equal(get([{...item,progress:0.5}],proof(0,'Example.mkv')).readiness,'unchecked');
  assert.equal(get([{...item,state:'checkingUP'}],proof(0,'Example.mkv')).readiness,'unchecked');
});

test('an exact completed release is chosen for verification ahead of a partial release',()=>{
  const item=film('justwatch-a','Example',2025,42,{availability:{status:'ready',sources:[{existingHash:a},{existingHash:b}]}});
  const [candidate]=model.buildPlannerCandidates({rows:[row([item])],
    library:[{...local(a,'Example'),progress:0.2},local(b,'Example')],connected:true});
  assert.equal(candidate.verifyHash,b);
  assert.equal(candidate.readiness,'options');
});

test('Tonight fills eligible slots when all choices come from the same part of the library',()=>{
  const library=[local(a,'First'),local(b,'Second'),local(c,'Third')];
  const verifiedFiles=new Map(library.map(({hash,title})=>[hash,proof(0,title+'.mkv')]));
  const history=Object.fromEntries(library.map(({hash,title})=>[hash,{index:0,fileName:title+'.mkv',duration:1800}]));
  const candidates=model.buildPlannerCandidates({library,verifiedFiles,history,connected:true});
  const picks=model.chooseTonight(candidates,{budgetMinutes:45});
  assert.deepEqual(picks.map(item=>item.title),['First','Second','Third']);
  assert.deepEqual(picks.map(item=>item.pickLabel),['From your library','Wildcard','Also fits']);
});

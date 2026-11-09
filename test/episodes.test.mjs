import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEpisodes,rankEpisodeSources,matchEpisodeFile} from '../episodes.mjs';

const intent={showId:'tvmaze-1',showTitle:'Example Series',aliases:['Example Series','Example Alias'],kind:'tv',episodeId:'tvmaze-episode-12',season:1,episode:2,absoluteNumber:null};
const source=(fileName,id=fileName,seeds=20)=>({fileName,fileUrl:'https://source.example/'+encodeURIComponent(id),fileSize:500*1024*1024,nbSeeders:seeds});
function fetchFixture({anime=false,missingDate=false,order=2}={}){
  const calls=[];
  const fetchImpl=async url=>{const u=new URL(url);calls.push(u.pathname+u.search);let body;
    if(u.pathname==='/search/shows')body=[{show:{id:1,name:'Example Series',premiered:'2020-01-01'}}];
    else if(u.pathname==='/shows/1')body={id:1,name:'Example Series',premiered:'2020-01-01',type:anime?'Animation':'Scripted',language:anime?'Japanese':'Korean',status:'Ended'};
    else if(u.pathname==='/shows/1/seasons')body=[{number:1,episodeOrder:order,premiereDate:'2020-01-01',endDate:'2020-02-01'},{number:2,episodeOrder:null}];
    else if(u.pathname==='/shows/1/akas')body=[{name:'Example Alias'}];
    else if(u.pathname==='/shows/1/episodes')body=[{id:11,season:1,number:1,type:'regular',name:'Opening',airdate:'2020-01-01',runtime:25},{id:12,season:1,number:2,type:'regular',name:'Second',airdate:missingDate?'':'2020-01-08',runtime:25},{id:13,season:1,number:null,type:'significant_special',name:'Special',airdate:'2020-02-01'},{id:21,season:2,number:1,type:'regular',name:'Next',airdate:'2099-01-01',runtime:25}];
    else return new Response('Not found',{status:404});
    return Response.json(body);
  };
  return {fetchImpl,calls};
}
async function finished(episodes,id){for(let i=0;i<300;i++){const state=episodes.get(id);if(!['queued','searching'].includes(state.status))return state;await new Promise(r=>setTimeout(r,5));}assert.fail('Episode search did not finish');}
function harness(t,options={}) {
  const fixture=fetchFixture(options),state={calls:[],results:options.results||[source('Example Series S01E02 1080p')],nextId:0,registered:[]};
  const qb=async(endpoint,params)=>{state.calls.push({endpoint,params});if(endpoint==='search/plugins')return [{name:'video',enabled:true,supportedCategories:[{id:'tv'},{id:'anime'},{id:'all'}]}];if(endpoint==='search/start')return {id:++state.nextId};if(endpoint==='search/results')return {status:'Stopped',results:state.results};return '';};
  const episodes=createEpisodes({qb,fetchImpl:fixture.fetchImpl,registerResult:(row,context)=>{state.registered.push({row,context});return {...row,key:row.fileUrl};},pollMs:1,...options.factory});t.after(()=>episodes.close());return {episodes,state,...fixture};
}

test('episode ranking rejects wrong show/season/episode and labels packs for file verification',()=>{
  const rows=[source('Example Series S01E03 1080p','wrong-episode',999),source('Example Series S02E02 1080p','wrong-season',999),source('Other Example Series S01E02','wrong-title',999),source('Example Series S01E02 1080p','correct'),source('Example Alias 1x02 720p','alias'),source('Example Series S01 COMPLETE','pack',1000),source('Example Series S01E01-E03','range'),source('Example Series S01E02 trailer','trailer')];
  const results=rankEpisodeSources(rows,intent);assert.equal(results.length,4);assert.ok(results.some(x=>x.matchType==='season-pack'));assert.ok(results.every(x=>x.fileVerificationRequired));assert.ok(results.some(x=>x.matchType==='multi-episode'));
});

test('short and numeric show names do not accept unrelated prefixes',()=>{
  assert.equal(rankEpisodeSources([source('Dark Shadows S01E02')],{...intent,showTitle:'Dark',aliases:[]}).length,0);
  assert.equal(rankEpisodeSources([source('1984 S01E02')],{...intent,showTitle:'1984',aliases:[]}).length,1);
});

test('anime absolute episodes are accepted only when backed by a known absolute number',()=>{
  const a={...intent,kind:'anime',absoluteNumber:2};
  assert.equal(rankEpisodeSources([source('[Subs] Example Series - 02 [1080p]')],a)[0].matchType,'absolute-episode');
  assert.equal(rankEpisodeSources([source('[Subs] Example Series - 03 [1080p]')],a).length,0);
  assert.equal(rankEpisodeSources([source('[Subs] Example Series - 02 [1080p]')],{...a,season:2,absoluteNumber:null}).length,0);
});

test('episode ranking removes camera copies and duplicate provider listings, preferring seeded sources',()=>{
  const rows=[source('Example Series S01E02 HDCAM','cam',999),source('Example.Series.S01E02.1080p','a',20),source('Example Series S01E02 1080p','b',30),source('Example Series S01E02 2160p','unseeded',0),source('Example Series S01 Complete','pack',15)];
  const results=rankEpisodeSources(rows,intent);assert.equal(results.length,3);assert.equal(results[0].nbSeeders,30);assert.equal(results.at(-1).availability,'unseeded');assert.match(results.at(-1).sourceNote,/may be unavailable/);
});

test('explicit multi-season and complete-series packs match only an exact title and covered season',()=>{
  const wanted={...intent,showTitle:'Boston Legal',aliases:['Boston Legal'],season:3};
  const rows=[
    source('Boston Legal - Season 1 to 5 (Complete) - Mp4 x264 AC3 1080p','written-range'),
    source('Boston Legal Season 1 2 3 4 5','season-list'),
    source('Boston.Legal.S01-S05.1080p','compact-range'),
    source('Boston Legal - The Complete Series','explicit-complete'),
    source('Boston Legal S01-S02 1080p','wrong-range'),
    source('Boston Legal Season 1 2 4 5','missing-season'),
    source('Boston Legal Season 5 to 1 Complete','backwards-range'),
    source('Other Boston Legal Complete Series','wrong-title'),
    source('Boston Legal Season 3 Complete','one-season'),
    source('Boston Legal S03E02-S04E01','cross-season-episode'),
    source('Boston Legal S03E02.srt','subtitle'),
    {...source('Boston Legal S03E02','bad-magnet'),fileUrl:'magnet:?dn=Boston+Legal'},
  ];
  const results=rankEpisodeSources(rows,wanted);
  assert.deepEqual(new Map(results.map(row=>[row.fileUrl.split('/').at(-1),row.matchType])),new Map([
    ['written-range','series-pack'],['season-list','series-pack'],['compact-range','series-pack'],
    ['explicit-complete','series-pack'],['one-season','season-pack'],
  ]));
  assert.ok(results.every(row=>row.fileVerificationRequired));
});

test('streaming hints let a strong pack outrank a weak episode while preserving exact preference on similar releases',()=>{
  const exact=source('Example Series S01E02 1080p x264','exact',30);
  const pack=source('Example Series S01 Complete 1080p x264','pack',30);
  assert.equal(rankEpisodeSources([pack,exact],intent)[0].matchType,'episode');
  const weak={...source('Example Series S01E02 2160p HEVC','weak',1),fileSize:15*1024**3};
  const unknown=source('Example Series S01E02 720p','unknown',-1);
  const ranked=rankEpisodeSources([weak,unknown,pack],intent);
  assert.equal(ranked[0].matchType,'season-pack');
  assert.equal(ranked.find(row=>row.fileUrl===unknown.fileUrl).availability,'unknown');
});

test('file selection verifies exact episodes and never silently picks a wrong or ambiguous video',()=>{
  const files=[{index:0,name:'Example Series/Example.Series.S01E01.mkv'},{index:1,name:'Example Series/Example.Series.S01E02.mkv'},{index:2,name:'Example Series/Example.Series.S02E02.mkv'}];
  assert.equal(matchEpisodeFile(files,intent).index,1);
  assert.equal(matchEpisodeFile(files,intent).singleEpisode,true);
  const compound=matchEpisodeFile([{index:0,name:'Example Series S01E02-E03.mkv'}],intent);
  assert.equal(compound.verified,true);
  assert.equal(compound.singleEpisode,false);
  assert.equal(matchEpisodeFile([{index:0,name:'Example Series Season 1/02-03.mkv'}],intent).singleEpisode,false);
  assert.equal(matchEpisodeFile([{index:0,name:'Example Series Season 1/02 - Second.mkv'}],intent).index,0);
  assert.equal(matchEpisodeFile([{index:0,name:'Example Series/S01E02.mkv'}],intent).index,0);
  const dated=matchEpisodeFile([
    {index:0,name:'Example Series Season 1/Example.Series.2024.S01E01.First.Light.mp4'},
    {index:1,name:'Example Series Season 1/Example.Series.2024.S01E02.Second.Wave.mp4'},
  ],{...intent,year:2024});
  assert.equal(dated.index,1);
  assert.equal(dated.singleEpisode,true);
  assert.equal(matchEpisodeFile([{index:0,name:'Other Show S01E02.mkv'}],intent).verified,false);
  assert.equal(matchEpisodeFile([{index:0,name:'Other Show Season 1/02 - Second.mkv'}],intent).verified,false);
  assert.equal(matchEpisodeFile([{index:0,name:'video.mkv'}],intent).verified,false);
  assert.equal(matchEpisodeFile([files[1],{...files[1],index:4}],intent).index,null);
  assert.equal(matchEpisodeFile([{index:0,name:'Example Series S01E02 sample.mkv'}],intent).candidates.length,0);
});

test('a multi-season pack needs exact numbering in the file or a matching single-season folder',()=>{
  const wanted={...intent,showTitle:'Boston Legal',aliases:[],season:3};
  const root='Boston Legal - Season 1 to 5 (Complete) - Mp4 x264 AC3 1080p';
  const files=[{index:0,name:`${root}/Season 1/02 - Another Episode.mp4`},
    {index:1,name:`${root}/Season 3/02 - The Right Episode.mp4`},
    {index:2,name:`${root}/02 - Unqualified Episode.mp4`},
    {index:3,name:`${root}/Season 4/S03E02 - Crossed.mp4`},
    {index:4,name:'Other Show Complete Series/S03E02 - Wrong Title.mp4'},
    {index:5,name:`${root}/S03E02-S04E01 - Crossed.mp4`},
    {index:6,name:`${root}/3x02-4x01 - Crossed.mp4`},
    {index:7,name:`${root}/S03E02/03 - Wrong Number.mp4`}];
  const matched=matchEpisodeFile(files,wanted);
  assert.equal(matched.index,1);
  assert.equal(matched.singleEpisode,true);
  assert.equal(matchEpisodeFile([...files,{index:8,name:`${root}/Boston.Legal.S03E02.mp4`}],wanted).verified,false);
});

test('catalog counts provider episode records separately from specials and future episode orders',async t=>{
  const h=harness(t,{order:5}),catalog=await h.episodes.catalog({title:'Example Series',year:2020,kind:'tv'});
  assert.equal(catalog.totalEpisodes,3);assert.equal(catalog.totalSpecials,1);assert.equal(catalog.totalSeasons,2);assert.equal(catalog.airedEpisodes,2);
  assert.equal(catalog.seasons[0].episodeOrder,5);assert.equal(catalog.seasons[0].totalEpisodes,2);assert.ok(catalog.warnings.some(x=>/not invented/.test(x)));
  assert.equal(catalog.episodes.find(e=>e.id==='tvmaze-episode-13').searchable,false);assert.equal(catalog.show.provider,'TVmaze');
  const before=h.calls.length;assert.equal((await h.episodes.catalog({id:'tvmaze-1'})).cached,true);assert.equal(h.calls.length,before);
  assert.throws(()=>h.episodes.resolveIntent({showId:'tvmaze-1',episodeId:'tvmaze-episode-13'}),/special/);
  assert.equal(catalog.episodes.find(e=>e.id==='tvmaze-episode-21').searchable,false);
  assert.throws(()=>h.episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-21'}),/not aired/);
});

test('episode intent is metadata-authoritative and jobs register matched sources without downloading',async t=>{
  const h=harness(t);await h.episodes.catalog({id:'tvmaze-1'});
  const request={showId:'tvmaze-1',episodeId:'tvmaze-episode-12',season:99,episode:999};
  const started=h.episodes.start(request),duplicate=h.episodes.start(request);assert.equal(started.id,duplicate.id);assert.equal(started.intent.season,1);assert.equal(started.intent.episode,2);
  const job=await finished(h.episodes,started.id);assert.equal(job.status,'ready');assert.equal(job.sources[0].intent.episode,2);
  const search=h.state.calls.find(c=>c.endpoint==='search/start');assert.equal(search.params.pattern,'Example Series S01E02');
  assert.ok(h.state.calls.some(c=>c.endpoint==='search/delete'));assert.ok(!h.state.calls.some(c=>c.endpoint.startsWith('torrents/')));
  assert.equal(h.episodes.intentForKey(job.sources[0].key,request).episode,2);assert.equal(h.episodes.intentForKey(job.sources[0].key,{showId:'tvmaze-2',episodeId:request.episodeId}),null);
  assert.throws(()=>h.episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-999'}),/expired/);
});

test('episode lookup asks every enabled plugin, keeps partial results and reaches the paged title fallback',async t=>{
  const fixture=fetchFixture(),calls=[],secondPoll=Promise.withResolvers();
  let id=0,firstPolls=0;
  const qb=async(endpoint,params)=>{
    calls.push({endpoint,params});
    if(endpoint==='search/plugins')return [{name:'native',enabled:true,supportedCategories:[{id:'tv'}]},
      {name:'general',enabled:true,supportedCategories:[{id:'all'}]},{name:'disabled',enabled:false}];
    if(endpoint==='search/start')return {id:++id};
    if(endpoint!=='search/results')return '';
    if(params.id==='1'){
      if(++firstPolls===1)return {status:'Running',total:1,results:[source('Example Series S01E02 1080p','partial',0)]};
      await secondPoll.promise;throw Error('One qBittorrent poll was interrupted.');
    }
    if(params.id==='2')return {status:'Stopped',total:1,results:[source('Other Series S01 Complete','wrong',500)]};
    if(params.offset===0)return {status:'Stopped',total:501,results:Array.from({length:500},(_,i)=>source('Other Series S01E02',i))};
    return {status:'Stopped',total:501,results:[source('Example Series Season 1 to 5 Complete x264','full-pack',200)]};
  };
  const episodes=createEpisodes({qb,fetchImpl:fixture.fetchImpl,registerResult:row=>({...row,key:row.fileUrl}),pollMs:1});
  t.after(()=>episodes.close());
  await episodes.catalog({id:'tvmaze-1'});
  const job=episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-12'});
  try{
    for(let i=0;i<100&&!episodes.get(job.id).sources.length;i++)await new Promise(r=>setTimeout(r,2));
    const progress=episodes.get(job.id);
    assert.equal(progress.status,'searching');
    assert.match(progress.sources[0].fileUrl,/partial$/);
  }finally{secondPoll.resolve();}
  const completed=await finished(episodes,job.id);
  assert.equal(completed.status,'ready');
  assert.equal(completed.sources[0].matchType,'series-pack');
  assert.ok(completed.sources.some(row=>row.fileUrl.endsWith('/partial')));
  assert.deepEqual(completed.coverage,{enabled:2,queriesAttempted:3,queriesCompleted:2,incomplete:1});
  assert.match(completed.message,/still shown/);
  assert.deepEqual(calls.filter(row=>row.endpoint==='search/start').map(row=>row.params),
    ['Example Series S01E02','Example Series S01','Example Series'].map(pattern=>({pattern,category:'all',plugins:'native|general'})));
  assert.deepEqual(calls.filter(row=>row.endpoint==='search/delete').map(row=>row.params.id),['1','2','3']);
  assert.ok(calls.some(row=>row.endpoint==='search/results'&&row.params.id==='3'&&row.params.offset===500));
});

test('episode connection changes retain visible results without cleaning an old search on the new daemon',async t=>{
  const fixture=fetchFixture(),calls=[],secondPoll=Promise.withResolvers();
  let epoch=0,firstPolls=0;
  const qb=async(endpoint,params)=>{
    calls.push({endpoint,params,epoch});
    if(endpoint==='search/plugins')return [{name:'general',enabled:true}];
    if(endpoint==='search/start')return {id:1};
    if(endpoint==='search/results'){
      if(epoch===0&&++firstPolls>1)await secondPoll.promise;
      return {status:epoch===0?'Running':'Stopped',results:[source('Example Series S01E02 1080p')]};
    }
    return '';
  };
  const episodes=createEpisodes({qb,fetchImpl:fixture.fetchImpl,registerResult:row=>({...row,key:row.fileUrl}),connectionEpoch:()=>epoch,pollMs:1});
  t.after(()=>episodes.close());
  await episodes.catalog({id:'tvmaze-1'});
  const selector={showId:'tvmaze-1',episodeId:'tvmaze-episode-12'},old=episodes.start(selector);
  try{
    for(let i=0;i<100&&!episodes.get(old.id).sources.length;i++)await new Promise(r=>setTimeout(r,2));
    assert.equal(episodes.get(old.id).sources.length,1);
    epoch++;
    const ended=episodes.get(old.id);
    assert.equal(ended.status,'ready');
    assert.equal(ended.sources.length,1);
    assert.equal(ended.coverage.incomplete,1);
    assert.match(ended.message,/connection changed/);
  }finally{secondPoll.resolve();}
  const next=episodes.start(selector);
  assert.notEqual(next.id,old.id);
  assert.equal((await finished(episodes,next.id)).status,'ready');
  assert.deepEqual(calls.filter(row=>['search/stop','search/delete'].includes(row.endpoint)).map(row=>[row.endpoint,row.params.id,row.epoch]),
    [['search/stop','1',1],['search/delete','1',1]]);
});

test('an unverified existing torrent remains listed while episode lookup finds a remote alternative',async t=>{
  const fixture=fetchFixture();let id=0;
  const qb=async(endpoint,params)=>{
    if(endpoint==='search/plugins')return [{name:'general',enabled:true}];
    if(endpoint==='search/start')return {id:++id};
    if(endpoint==='search/results')return {status:'Stopped',results:params.id==='1'?
      [source('Example Series S01E02 1080p','local')]:[source('Example Series The Complete Series x264','fallback')]};
    return '';
  };
  const registerResult=row=>row.fileUrl.endsWith('/local')?
    {...row,key:row.fileUrl,existingHash:'a'.repeat(40),streaming:{score:120,label:'Ready in library'}}:{...row,key:row.fileUrl};
  const episodes=createEpisodes({qb,fetchImpl:fixture.fetchImpl,registerResult,pollMs:1});
  t.after(()=>episodes.close());
  await episodes.catalog({id:'tvmaze-1'});
  const job=await finished(episodes,episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-12'}).id);
  assert.equal(job.status,'ready');
  assert.equal(job.sources[0].existingHash,'a'.repeat(40));
  assert.equal(job.sources[0].streaming.label,'Ready in library');
  assert.equal(job.sources[1].matchType,'series-pack');
  assert.equal(job.coverage.queriesAttempted,3);
});

test('shared season pack keys retain separate intents for each selected episode',async t=>{
  const h=harness(t,{results:[source('Example Series S01 COMPLETE','same-pack')]});await h.episodes.catalog({id:'tvmaze-1'});
  const first=await finished(h.episodes,h.episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-11'}).id),second=await finished(h.episodes,h.episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-12'}).id);
  const key=first.sources[0].key;assert.equal(second.sources[0].key,key);assert.equal(h.episodes.intentForKey(key),null);
  assert.equal(h.episodes.intentForKey(key,{showId:'tvmaze-1',episodeId:'tvmaze-episode-11'}).episode,1);assert.equal(h.episodes.intentForKey(key,{showId:'tvmaze-1',episodeId:'tvmaze-episode-12'}).episode,2);
});

test('unknown provider title fails honestly and incomplete anime seasons have no fabricated absolute number',async t=>{
  const h=harness(t,{anime:true,missingDate:true});await assert.rejects(h.episodes.catalog({title:'Wrong Series'}),/No exact/);
  const c=await h.episodes.catalog({id:'tvmaze-1'});assert.equal(c.show.kind,'anime');assert.equal(c.episodes.find(e=>e.id==='tvmaze-episode-12').absoluteNumber,2);assert.equal(c.episodes.find(e=>e.id==='tvmaze-episode-21').absoluteNumber,null);assert.equal(c.episodes.find(e=>e.id==='tvmaze-episode-12').aired,null);
  assert.ok(c.warnings.some(w=>/numbering/.test(w)));
});

test('a translated Korean title resolves through an exact native TVmaze AKA with two bounded searches',async t=>{
  const fixture=fetchFixture(),calls=[],native='별의 약속',official='Byeorui Yaksok';
  const show=id=>({id,name:id===1?official:'Unrelated Drama '+id,premiered:'2020-01-01'});
  const fetchImpl=async url=>{const u=new URL(url);calls.push(u.pathname+u.search);
    if(u.pathname==='/search/shows')return Response.json((u.searchParams.get('q')===native?[show(1)]:[show(2),show(3),show(4),show(5)]).map(show=>({show})));
    if(/\/akas$/.test(u.pathname))return Response.json(u.pathname==='/shows/1/akas'?[{name:native}]:[{name:'Different title'}]);
    if(u.pathname==='/shows/1')return Response.json({...show(1),type:'Scripted',language:'Korean',status:'Ended'});
    return fixture.fetchImpl(url);};
  const episodes=createEpisodes({fetchImpl});t.after(()=>episodes.close());
  const c=await episodes.catalog({title:'Promise in the Stars',year:2020,alternateTitle:'Some Romanization',aliases:[native,'Another English Alias']});
  assert.equal(c.show.id,'tvmaze-1');assert.equal(c.show.title,official);assert.ok(c.show.aliases.includes(native));
  const searches=calls.filter(p=>p.startsWith('/search/shows'));assert.equal(searches.length,2);assert.ok(searches[1].includes(encodeURIComponent(native)));
  assert.equal(calls.filter(p=>/\/akas$/.test(p)).length,3,'At most three candidates are checked, with the selected AKA response reused by its catalog');
  assert.equal(calls.filter(p=>p==='/shows/1/akas').length,1);
});

test('alias lookup retains filename cleaning and accepts an exact alternate provider name',async t=>{
  const fixture=fetchFixture(),calls=[];
  const fetchImpl=async url=>{const u=new URL(url);calls.push(u.pathname+u.search);
    if(u.pathname==='/search/shows')return Response.json([{show:{id:1,name:'Example Series',premiered:'2020-01-01'}}]);
    return fixture.fetchImpl(url);};
  const episodes=createEpisodes({fetchImpl});t.after(()=>episodes.close());
  const c=await episodes.catalog({title:'Translated.Title.2020.S01E02.1080p.WEB-DL',alternateTitle:'Example Series',kind:'tv'});
  assert.equal(c.show.id,'tvmaze-1');assert.equal(new URL('https://api.tvmaze.com'+calls.find(p=>p.startsWith('/search/shows'))).searchParams.get('q'),'Translated Title');
  assert.equal(calls.filter(p=>p.startsWith('/search/shows')).length,2);
});

test('alias matches reject ambiguous identities and a different or unknown premiere year',async t=>{
  for(const scenario of ['ambiguous','wrong-year','unknown-year']){
    const calls=[];
    const fetchImpl=async url=>{const u=new URL(url);calls.push(u.pathname);
      if(u.pathname==='/search/shows')return Response.json((scenario==='ambiguous'?[1,2]:[1]).map(id=>({show:{id,name:'Different official name '+id,premiered:scenario==='wrong-year'?'2019-01-01':scenario==='unknown-year'?null:'2020-01-01'}})));
      if(/\/akas$/.test(u.pathname))return Response.json([{name:'별의 약속'}]);
      assert.fail('No catalog data should be loaded for an unverified title');};
    const episodes=createEpisodes({fetchImpl});t.after(()=>episodes.close());
    await assert.rejects(episodes.catalog({title:'Translated title',aliases:['별의 약속'],year:2020}),scenario==='ambiguous'?/Several TVmaze/:/No exact TVmaze/,scenario);
    if(scenario!=='ambiguous')assert.equal(calls.filter(p=>/\/akas$/.test(p)).length,0,'A year mismatch must not reach alias verification');
  }
});

test('fuzzy-looking results never establish alias identity and lookup remains bounded',async t=>{
  const calls=[];let active=0,peak=0;
  const fetchImpl=async url=>{const u=new URL(url);calls.push(u.pathname+u.search);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
    if(u.pathname==='/search/shows')return Response.json(Array.from({length:20},(_,i)=>({show:{id:i+1,name:'Almost Correct Title '+i,premiered:'2020-01-01'}})));
    if(/\/akas$/.test(u.pathname))return Response.json([{name:'Correct Title Again'}]);
    assert.fail('Fuzzy candidates must not become an episode catalog');};
  const episodes=createEpisodes({fetchImpl});t.after(()=>episodes.close());
  await assert.rejects(episodes.catalog({title:'Correct Title',aliases:['올바른 제목',...Array.from({length:30},(_,i)=>'Alias '+i)],year:2020}),/No exact TVmaze/);
  assert.equal(calls.filter(p=>p.startsWith('/search/shows')).length,2);assert.equal(calls.filter(p=>/\/akas$/.test(p)).length,3);assert.ok(peak<=2);
});

test('later anime absolute numbering requires fully aired, contiguous seasons matching provider episode orders',async t=>{
  const h=harness(t,{anime:true});const c=await h.episodes.catalog({id:'tvmaze-1'});
  assert.equal(c.episodes.find(e=>e.id==='tvmaze-episode-21').absoluteNumber,3);
  const incomplete=harness(t,{anime:true,order:8});const missing=await incomplete.episodes.catalog({id:'tvmaze-1'});
  assert.equal(missing.episodes.find(e=>e.id==='tvmaze-episode-21').absoluteNumber,null);
});

test('calendar-year anime derives clearly labelled aired order and searches absolute episodes first',async t=>{
  const fixture=fetchFixture({anime:true}),calls=[];
  const fetchImpl=async url=>{const pathname=new URL(url).pathname;
    if(pathname==='/shows/1')return Response.json({id:1,name:'Example Series',premiered:'2002-10-01',type:'Animation',language:'Japanese',status:'Ended'});
    if(pathname==='/shows/1/seasons')return Response.json([{number:2002,episodeOrder:null,premiereDate:'2002-10-01',endDate:'2002-12-26'},{number:2003,episodeOrder:null,premiereDate:'2003-01-02',endDate:'2003-01-09'}]);
    if(pathname==='/shows/1/episodes')return Response.json([{id:11,season:2002,number:1,type:'regular',airdate:'2002-10-01'},{id:12,season:2002,number:2,type:'regular',airdate:'2002-12-26'},{id:21,season:2003,number:1,type:'regular',airdate:'2003-01-02'}]);
    return fixture.fetchImpl(url);};
  const qb=async(endpoint,params)=>{calls.push({endpoint,params});if(endpoint==='search/plugins')return [{name:'anime',enabled:true,supportedCategories:[{id:'anime'}]}];if(endpoint==='search/start')return {id:1};if(endpoint==='search/results')return {status:'Stopped',results:[source('[Group] Example Series 003 [1080p]')]};return '';};
  const episodes=createEpisodes({qb,fetchImpl,registerResult:r=>({...r,key:r.fileUrl}),pollMs:1});t.after(()=>episodes.close());
  const c=await episodes.catalog({id:'tvmaze-1'}),selected=c.episodes.find(e=>e.id==='tvmaze-episode-21');
  assert.equal(selected.absoluteNumber,3);assert.equal(selected.numberingLabel,'TVmaze aired order (derived)');assert.equal(c.seasons[0].calendarSeason,true);
  const job=await finished(episodes,episodes.start({showId:'tvmaze-1',episodeId:selected.id}).id);
  assert.equal(job.sources.length,1);assert.equal(calls.find(c=>c.endpoint==='search/start').params.pattern,'Example Series 03');
  assert.equal(matchEpisodeFile([{index:0,name:'[Group] Example Series - 002 [1080p].mkv'},{index:1,name:'[Group] Example Series 003 [1080p].mkv'}],job.intent).index,1);
});

test('calendar anime refuses derived numbering across missing years, episodes, unknown dates, or unfinished seasons',async t=>{
  for(const fault of ['year-gap','episode-gap','end-date-mismatch','unknown-airdate','still-running','missing-first-year']){
    const fixture=fetchFixture({anime:true});
    const fetchImpl=async url=>{const pathname=new URL(url).pathname;
      if(pathname==='/shows/1')return Response.json({id:1,name:'Example Series',premiered:fault==='missing-first-year'?'2001-01-01':'2002-10-01',type:'Animation',language:'Japanese',status:fault==='still-running'?'Running':'Ended'});
      if(pathname==='/shows/1/seasons')return Response.json([{number:2002,episodeOrder:null,endDate:fault==='end-date-mismatch'?'2002-12-31':'2002-12-26'},{number:fault==='year-gap'?2004:2003,episodeOrder:null}]);
      if(pathname==='/shows/1/episodes')return Response.json([{id:11,season:2002,number:1,type:'regular',airdate:fault==='unknown-airdate'?'':'2002-10-01'},{id:12,season:2002,number:fault==='episode-gap'?3:2,type:'regular',airdate:'2002-12-26'},{id:21,season:fault==='year-gap'?2004:2003,number:1,type:'regular',airdate:'2004-01-01'}]);
      return fixture.fetchImpl(url);};
    const episodes=createEpisodes({fetchImpl});t.after(()=>episodes.close());const c=await episodes.catalog({id:'tvmaze-1'});
    assert.equal(c.episodes.find(e=>e.id==='tvmaze-episode-21').absoluteNumber,null,fault);
    assert.throws(()=>episodes.resolveIntent({showId:'tvmaze-1',episodeId:'tvmaze-episode-21'}),/not complete enough/,fault);
  }
});

test('at most two episode jobs run and cancelling one affects only its own qBittorrent searches',async t=>{
  const fixture=fetchFixture(),calls=[],live=new Set(),patterns=new Map();let next=800,peak=0,release=false;
  const fetchImpl=async url=>{const r=await fixture.fetchImpl(url);if(new URL(url).pathname==='/shows/1/episodes'){const rows=await r.json();rows.push({id:14,season:1,number:3,type:'regular',name:'Third',airdate:'2020-01-15'});return Response.json(rows);}return r;};
  const qb=async(endpoint,params)=>{calls.push({endpoint,params});if(endpoint==='search/plugins')return [{name:'tv',enabled:true,supportedCategories:[{id:'tv'}]}];if(endpoint==='search/start'){const id=++next;live.add(String(id));patterns.set(String(id),params.pattern);peak=Math.max(peak,live.size);return {id};}if(endpoint==='search/results')return {status:release?'Stopped':'Running',results:[source(patterns.get(params.id)+' 1080p')]};if(endpoint==='search/delete')live.delete(params.id);return '';};
  const episodes=createEpisodes({qb,fetchImpl,registerResult:r=>({...r,key:r.fileUrl}),pollMs:2});t.after(()=>episodes.close());await episodes.catalog({id:'tvmaze-1'});
  const one=episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-11'}),two=episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-12'}),three=episodes.start({showId:'tvmaze-1',episodeId:'tvmaze-episode-14'});
  assert.equal(three.status,'queued');for(let i=0;i<100&&patterns.size<2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(patterns.size,2);
  await episodes.cancel(one.id);for(let i=0;i<100&&patterns.size<3;i++)await new Promise(r=>setTimeout(r,2));assert.equal(patterns.size,3);assert.equal(episodes.get(one.id).status,'cancelled');
  release=true;assert.equal((await finished(episodes,two.id)).status,'ready');assert.equal((await finished(episodes,three.id)).status,'ready');assert.equal(peak,2);
  assert.ok(calls.filter(c=>['search/stop','search/delete'].includes(c.endpoint)).every(c=>patterns.has(c.params.id)),'Only search IDs created by this module may be stopped or deleted');
});

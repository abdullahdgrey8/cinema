import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankSources,createDiscovery} from '../discovery-manager.mjs';

const movie={id:'film-1',title:'Example Story',kind:'movies',year:2020};
const source=(name,seeds=20,url='magnet:?xt=urn:btih:'+'a'.repeat(40))=>({fileName:name,nbSeeders:seeds,fileSize:1e9,fileUrl:url});
test('short show titles reject unrelated episode names and reversed title words',()=>{
  const dark={title:'Dark',kind:'tv',year:2017};
  const rows=[source('Pretty Little Liars S03E13 This Is a Dark Ride',999,'https://example.test/wrong'),source('Romance in the Dark 2014',800,'https://example.test/film'),source('Dark Shadows 2012 HDVD-Rips',500,'https://example.test/prefix'),source('Dark S01 1080p WEB-DL',10)];
  assert.deepEqual(rankSources(rows,dark).map(r=>r.fileName),['Dark S01 1080p WEB-DL']);
  assert.equal(rankSources([source('Castle in the Sky 1986')],{title:'Sky Castle',kind:'tv',year:2018}).length,0);
});
test('shows offer the beginning before late episodes and remove duplicate release spellings',()=>{
  const rows=[source('Severance S02E10 1080p',1000,'https://example.test/late'),source('Severance.S01.1080p',10,'https://example.test/season'),source('Severance S01 1080p',11,'https://example.test/duplicate'),source('Severance S01E01 720p',100,'https://example.test/first')];
  const results=rankSources(rows,{title:'Severance',kind:'tv',year:2022});assert.equal(results.length,3);assert.equal(results[0].fileUrl,'https://example.test/duplicate');assert.match(results[1].fileName,/S01E01/);assert.match(results[2].fileName,/S02E10/);
  assert.equal(rankSources([source('Avatar 2009 Spanish TS')],{title:'Avatar',kind:'movies',year:2009}).length,0);
});
test('discovery keeps unique seeded title matches and rejects wrong-year, camera, episode and tiny results',()=>{
  const rows=[source('Example.Story.2020.1080p.x264',10),source('Example.Story.2020.1080p.x264',100),source('Example Story 2021 1080p',500,'https://source.invalid/wrong-year'),source('Example Story 2020 HDCAM',800,'https://source.invalid/cam'),source('Example Story S01E01',1000,'https://source.invalid/episode'),source('Other Story 2020',900,'https://source.invalid/wrong-title'),source('Example Story 2020',0,'https://source.invalid/dead'),{...source('Example Story 2020',200,'https://source.invalid/tiny'),fileSize:5}];
  const result=rankSources(rows,movie);assert.equal(result.length,1);assert.equal(result[0].nbSeeders,100);assert.equal(result[0].streamFriendly,true);
});
test('release-year matching treats numbers in the movie title as title words',()=>{
  const item={id:'1917',title:'1917',kind:'movies',year:2019};
  const rows=[source('1917.2019.1080p.x264'),source('1917.2020.1080p.x264',900,'https://example.test/wrong-year')];
  assert.deepEqual(rankSources(rows,item,{preferStream:true}).map(row=>row.fileName),['1917.2019.1080p.x264']);
});
test('discovery searches plugins in background without adding torrents, deduplicates catalog and cleans search jobs',async()=>{
  const calls=[],qb=async(endpoint,params)=>{calls.push([endpoint,params]);if(endpoint==='search/plugins')return [{name:'movies',enabled:true,supportedCategories:[{id:'movies'}]}];if(endpoint==='search/start')return {id:1};if(endpoint==='search/results')return {status:'Stopped',results:[source('Example.Story.2020.1080p')]};return '';};
  const discovery=createDiscovery({qb,metadata:{discovery:async()=>({rows:[{id:'movies',items:[movie,movie]}]})},registerResult:row=>({...row,key:'known-key'}),pollMs:1});
  discovery.get();for(let i=0;i<100&&discovery.get().status!=='ready';i++)await new Promise(r=>setTimeout(r,5));
  const result=discovery.get();assert.equal(result.rows[0].items.length,1);assert.equal(result.rows[0].items[0].availability.sources[0].key,'known-key');assert.equal(result.sourceProgress.done,1);assert.ok(calls.some(([p])=>p==='search/delete'));assert.equal(calls.some(([p])=>p.startsWith('torrents/')),false);await discovery.close();
});

test('an opened title checks every enabled plugin and keeps verified search matches after an interrupted poll',async t=>{
  const calls=[];
  let polls=0;
  const qb=async(endpoint,params)=>{
    calls.push({endpoint,params});
    if(endpoint==='search/plugins')return [
      {name:'films',enabled:true,supportedCategories:[{id:'movies'}]},
      {name:'general',enabled:true,supportedCategories:[{id:'all'}]},
      {name:'disabled',enabled:false,supportedCategories:[{id:'all'}]},
    ];
    if(endpoint==='search/start')return {id:15};
    if(endpoint==='search/results'){
      if(++polls>1)throw Error('provider interrupted');
      return {status:'Running',results:[source('Example Story 2020 720p x264',42)]};
    }
    return '';
  };
  const discovery=createDiscovery({qb,metadata:{discovery:async()=>({rows:[{id:'movies',items:[movie]}]})},
    registerResult:row=>({...row,key:'retained'}),pollMs:1});
  t.after(()=>discovery.close());
  const options={mode:'on-demand',focus:movie.id};
  discovery.get(options);
  let result;
  for(let attempt=0;attempt<100;attempt++){
    result=discovery.get(options).selectedItem?.availability;
    if(result?.partial)break;
    await new Promise(resolve=>setTimeout(resolve,3));
  }
  assert.deepEqual(calls.find(call=>call.endpoint==='search/start').params,{pattern:'Example Story 2020',category:'all',plugins:'films|general'});
  assert.equal(result.status,'ready');
  assert.equal(result.sources[0].key,'retained');
  assert.equal(result.partial,true);
  assert.ok(calls.some(call=>call.endpoint==='search/delete'&&call.params.id==='15'));
  assert.ok(!calls.some(call=>call.endpoint.startsWith('torrents/')));
});

async function ready(discovery){for(let i=0;i<200;i++){const state=discovery.get();if(state.status==='ready')return state;if(state.status==='error')assert.fail(JSON.stringify(state.warnings));await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Discovery did not finish its isolated mock search');}
function harness(t,{item=movie,pluginName=null,registerResult,plugins}={}){
  const state={clock:1000,rows:[source('Example.Story.2020.1080p')],calls:[],catalogCalls:0,job:0};
  const qb=async(endpoint,params)=>{
    state.calls.push({endpoint,params});
    if(endpoint==='search/plugins')return plugins||[{name:'movies',enabled:true,supportedCategories:[{id:'movies'},{id:'all'}]}];
    if(endpoint==='search/start')return {id:++state.job};
    if(endpoint==='search/results')return {status:'Stopped',results:state.rows};
    return '';
  };
  const discovery=createDiscovery({qb,metadata:{discovery:async()=>{state.catalogCalls++;return {rows:[{id:'test',items:[item]}]};}},registerResult:registerResult||((row)=>({...row,key:'known-key'})),pluginName,pollMs:1,now:()=>state.clock});
  t.after(()=>discovery.close());return {discovery,state,starts:()=>state.calls.filter(c=>c.endpoint==='search/start')};
}

test('manual discovery refresh bypasses a cached unavailable result so recovered sources become watchable',async t=>{
  const h=harness(t);h.state.rows=[];
  assert.equal((await ready(h.discovery)).rows[0].items[0].availability.status,'unavailable');assert.equal(h.starts().length,1);
  h.state.rows=[source('Example.Story.2020.1080p',77)];h.discovery.refresh();
  const refreshed=await ready(h.discovery);
  assert.equal(h.starts().length,2,'An explicit refresh must actually query the provider again');
  assert.equal(refreshed.rows[0].items[0].availability.sources[0].nbSeeders,77);assert.equal(refreshed.rows[0].items[0].availability.status,'ready');
  assert.equal(h.state.calls.filter(c=>c.endpoint==='search/delete').length,2);
});

test('discovery refreshes after thirty minutes without restarting on every poll',async t=>{
  const h=harness(t);await ready(h.discovery);assert.equal(h.starts().length,1);
  h.state.clock+=30*60*1000-1;
  for(let i=0;i<5;i++)h.discovery.get();
  assert.equal(h.starts().length,1);assert.equal(h.state.catalogCalls,1);
  h.state.rows=[source('Example.Story.2020.720p',9)];h.state.clock+=2;
  for(let i=0;i<5;i++)h.discovery.get();
  const renewed=await ready(h.discovery);assert.equal(h.starts().length,2,'Concurrent polls should share the one scheduled refresh');assert.equal(h.state.catalogCalls,2);
  assert.equal(renewed.rows[0].items[0].availability.sources[0].nbSeeders,9);
});

test('reading discovery renews existing selection registrations without unnecessary provider traffic',async t=>{
  const registered=new Map();let clock=1000;
  const h=harness(t,{registerResult:(row,context)=>{
    const key=row.key||'retained-selection';registered.set(key,{seenAt:clock,context});return {...row,key};
  }});
  const first=await ready(h.discovery),key=first.rows[0].items[0].availability.sources[0].key;
  assert.equal(registered.get(key).seenAt,1000);
  clock=10*60*1000;h.state.clock=clock;registered.clear();
  const restored=h.discovery.get();assert.equal(restored.rows[0].items[0].availability.sources[0].key,key);
  assert.equal(registered.get(key).seenAt,clock,'Old catalog cards need a currently registered add selection');
  assert.equal(registered.get(key).context.category,'movies');assert.equal(h.starts().length,1);
});

test('ranking excludes trailers, samples and bonus videos while preserving those words in real titles',()=>{
  const rows=['trailer','sample','featurette','extras'].map((word,i)=>source(`Example Story 2020 ${word} 1080p`,1000,`https://source.invalid/bonus-${i}`));
  rows.push(source('Example Story 2020 1080p',5));
  assert.deepEqual(rankSources(rows,movie).map(r=>r.fileName),['Example Story 2020 1080p']);
  const realTitle={id:'extras-series',title:'Extras',kind:'tv'};
  assert.equal(rankSources([source('Extras.S01E01.1080p',10)],realTitle).length,1,'A legitimate title named Extras must remain discoverable');
});

test('topical ebook results can be small files but film results keep their minimum video size',()=>{
  const ebook={id:'books-topic',title:'Linux',kind:'other',topic:true,nativeCategory:'books'};
  const rows=[{...source('Linux handbook.epub',30,'https://source.invalid/book'),fileSize:256*1024},{...source('Linux guide.pdf',0,'https://source.invalid/no-seeds'),fileSize:256*1024}];
  assert.equal(rankSources(rows,ebook).length,1);assert.equal(rankSources(rows,{...ebook,topic:false,kind:'movies'}).length,0);
});

test('plugin browsing isolates the chosen provider and keeps native ebook categories',async t=>{
  const plugins=[{name:'chosen-books',enabled:true,supportedCategories:[{id:'books'},{id:'all'}]},{name:'other-books',enabled:true,supportedCategories:[{id:'books'}]}];
  const h=harness(t,{item:{id:'linux-topic',title:'Linux',kind:'other',topic:true,nativeCategory:'books'},pluginName:'chosen-books',plugins});
  h.state.rows=[{...source('Linux handbook.epub'),fileSize:256*1024}];
  const state=await ready(h.discovery);assert.equal(state.rows[0].items[0].availability.status,'ready');
  assert.deepEqual(h.starts().map(c=>c.params),[{pattern:'Linux',category:'books',plugins:'chosen-books'}]);
  assert.equal(h.state.calls.some(c=>c.endpoint.startsWith('torrents/')),false);
});
test('film suggestions exclude different titles that contain the chart title',()=>{
  const film={title:'Obsession',kind:'movies',year:2026};
  const rows=[
    source('Maids Obsession 2026 1080p H264',500,'https://example.test/prefix'),
    source('Obsession With The Night 2026 1080p H264',500,'https://example.test/suffix'),
    source('[Group] Obsession 2026 1080p H264',30),
  ];
  assert.deepEqual(rankSources(rows,film).map(row=>row.fileName),['[Group] Obsession 2026 1080p H264']);
});


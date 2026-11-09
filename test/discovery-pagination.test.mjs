import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDiscovery} from '../discovery-manager.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(d,options){for(let i=0;i<300;i++){const state=d.get(options);if(state.status==='ready')return state;assert.notEqual(state.status,'error',JSON.stringify(state.warnings));await delay(2);}assert.fail('Discovery did not become ready');}
function fixture(t,{slow=false}={}){
  const calls=[],catalogCalls=[];let job=0,live=0,maximum=0;
  const qb=async(endpoint,params)=>{
    calls.push({endpoint,params});
    if(endpoint==='search/plugins')return [{name:'video',enabled:true,supportedCategories:[{id:'movies'},{id:'tv'},{id:'all'}]}];
    if(endpoint==='search/start'){live++;maximum=Math.max(maximum,live);return {id:++job};}
    if(endpoint==='search/results'){if(slow)await delay(15);return {status:'Stopped',results:[]};}
    if(endpoint==='search/delete')live--;
    return '';
  };
  const discovery=createDiscovery({qb,registerResult:r=>r,pollMs:1,metadata:{discovery:async options=>{
    catalogCalls.push(options);return {period:options.period,rows:['movies','tv'].map(kind=>({id:kind,items:Array.from({length:19},(_,i)=>({id:kind+'-'+options.period+'-'+i,title:options.period+' title '+i,kind,year:2026}))}))};
  }}});
  t.after(()=>discovery.close());return {discovery,calls,catalogCalls,maximum:()=>maximum};
}
test('discovery exposes all pages, searches visible titles, preserves independent shelf pages and reuses cached pages',async t=>{
  const h=fixture(t),d=h.discovery;const first=await ready(d,{period:'week'});
  assert.equal(h.catalogCalls[0].refresh,false,'First load must reuse a current persisted chart cache');
  assert.equal(first.rows[0].items.length,8);assert.equal(first.rows[0].totalItems,19);assert.equal(first.rows[0].totalPages,3);assert.equal(first.rows[0].hasNext,true);
  assert.equal(h.calls.filter(c=>c.endpoint==='search/start').length,16);
  const next=await ready(d,{period:'week',moviesPage:2});
  assert.equal(next.rows[0].items[0].id,'movies-week-8');assert.equal(next.rows[1].page,1);
  assert.equal(h.calls.filter(c=>c.endpoint==='search/start').length,24,'Only new visible titles should need provider queries');
  const last=await ready(d,{period:'week',moviesPage:100});
  assert.equal(last.rows[0].page,3);assert.equal(last.rows[0].items.length,3);assert.equal(last.rows[0].hasNext,false);
  await ready(d,{period:'week'});assert.equal(h.calls.filter(c=>c.endpoint==='search/start').length,27);
  assert.equal(h.catalogCalls.length,1);assert.ok(h.maximum()<=2);
});
test('changing time window discards old titles and rapid page changes retain bounded search concurrency',async t=>{
  const h=fixture(t,{slow:true}),d=h.discovery;d.get({period:'week'});await delay(8);
  d.get({period:'week',moviesPage:2});d.get({period:'month',moviesPage:3});
  const result=await ready(d,{period:'month',moviesPage:3});
  assert.equal(result.period,'month');assert.equal(result.rows[0].page,3);
  assert.ok(result.rows.flatMap(row=>row.items).every(item=>item.id.includes('-month-')));
  assert.ok(h.maximum()<=2,'Changing filters must not start extra worker pools');
  assert.equal(h.calls.some(c=>c.endpoint.startsWith('torrents/')),false);
});
test('invalid paging and periods fail before any provider queries',async t=>{
  const h=fixture(t);
  for(const options of [{period:'all-time'},{moviesPage:0},{animePage:1.5},{tvPage:'NaN'}])assert.throws(()=>h.discovery.get(options),{status:400});
  assert.equal(h.calls.length,0);assert.equal(h.catalogCalls.length,0);
});

test('upcoming buzz-chart titles remain visible without starting torrent source queries',async t=>{
  const calls=[],d=createDiscovery({qb:async endpoint=>{calls.push(endpoint);if(endpoint==='search/plugins')return [{name:'tv',enabled:true,supportedCategories:[{id:'tv'}]}];throw Error('Unexpected source query');},registerResult:r=>r,metadata:{discovery:async()=>({rows:[{id:'korean',items:[{id:'future-show',title:'Future series',kind:'tv',upcoming:true,premiered:'2027-01-01'}]}]})}});
  t.after(()=>d.close());const result=await ready(d);
  assert.equal(result.rows[0].items[0].availability.status,'upcoming');assert.match(result.rows[0].items[0].availability.message,/2027-01-01/);assert.equal(calls.includes('search/start'),false);
});

test('a selected category searches only its visible page and home interleaves categories',async t=>{
  const h=fixture(t);await ready(h.discovery,{category:'tv'});
  let starts=h.calls.filter(c=>c.endpoint==='search/start');assert.equal(starts.length,8);assert.ok(starts.every(c=>c.params.category==='tv'));
  await ready(h.discovery,{category:'movies'});starts=h.calls.filter(c=>c.endpoint==='search/start');assert.equal(starts.length,16);assert.ok(starts.slice(8).every(c=>c.params.category==='movies'));
  const home=fixture(t);await ready(home.discovery);assert.deepEqual(home.calls.filter(c=>c.endpoint==='search/start').slice(0,4).map(c=>c.params.category),['movies','tv','movies','tv']);
});

test('on-demand discovery publishes titles and playable candidates before unrelated work completes',async t=>{
  const calls=[];
  let finishCatalog,finishResults,partial;
  const catalogWork=new Promise(resolve=>{finishCatalog=resolve;});
  const partialReady=new Promise(resolve=>{partial=resolve;});
  const d=createDiscovery({
    metadata:{discovery:async({onPartial})=>{
      const rows=[{id:'movies',items:[{id:'current-film',title:'Current Film',kind:'movies',year:2026}]}];
      onPartial(rows[0]);
      partial();
      await catalogWork;
      return {rows};
    }},
    registerResult:result=>({...result,key:'play-current-film'}),
    pollMs:10000,
    qb:async(endpoint,params)=>{
      calls.push({endpoint,params});
      if(endpoint==='search/plugins')return [{name:'video',enabled:true,supportedCategories:[{id:'movies'}]}];
      if(endpoint==='search/start')return {id:45};
      if(endpoint==='search/results')return {status:'Running',results:[{
        fileName:'Current Film 2026 1080p H264',fileSize:500*1024*1024,nbSeeders:20,
        fileUrl:'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
      }]};
      if(endpoint==='search/delete')finishResults?.();
      return '';
    }
  });
  t.after(async()=>{finishCatalog();await d.close();});
  const browse={mode:'on-demand'};
  d.get(browse);
  await partialReady;
  const first=d.get(browse);
  assert.equal(first.rows[0].items[0].title,'Current Film');
  assert.equal(first.catalogLoading,true);
  assert.equal(first.rows[0].items[0].availability.status,'idle');
  assert.equal(calls.length,0,'Opening Discover must not start a release search');
  const focus={...browse,focus:'current-film'};
  d.get(focus);
  let state;
  for(let attempt=0;attempt<150;attempt++){
    state=d.get(focus);
    if(state.selectedItem?.availability.sources.length)break;
    await delay(2);
  }
  assert.equal(state.catalogLoading,true,'The selected title must work while unrelated chart requests are pending');
  assert.equal(state.selectedItem.availability.sources[0].key,'play-current-film');
  assert.equal(state.selectedItem.availability.status,'searching','A valid early result should be playable before the job ends');
  assert.equal(calls.filter(call=>call.endpoint==='search/start').length,1);
  const cleaned=new Promise(resolve=>{finishResults=resolve;});
  d.get(browse);
  await Promise.race([cleaned,delay(500)]);
  assert.ok(calls.some(call=>call.endpoint==='search/delete'),'Closing the detail must cancel without waiting for the next long poll');
  assert.equal(d.get(browse).selectedItem,undefined);
});

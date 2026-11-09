import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginBrowse} from '../plugin-browse.mjs';

const plugin=(name,categories,enabled=true)=>({name,fullName:name+' source',enabled,supportedCategories:categories.map(id=>({id,name:id}))});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ready(browser,name,options){for(let i=0;i<100;i++){const result=await browser.get(name,options);if(result.status==='ready')return result;await pause(3);}assert.fail('Plugin browse did not finish.');}
const readyPassive=(browser,name,options)=>ready(browser,name,{...options,poll:true});
function harness(t,{plugins=[plugin('chosen',['movies','all']),plugin('unrelated',['movies','tv','all'])],running=false,metadataRows,resultFor,onStart,onPlugins,sourceTimeoutMs=1000,now=Date.now,enrichDiscoveryItems}={}){
  const calls=[],jobs=new Map(),registered=[],polls=new Map();let next=0,metadataCalls=0;
  const state={plugins,running};
  const qb=async(endpoint,params,method)=>{
    calls.push({endpoint,params,method});
    if(endpoint==='search/plugins'){await onPlugins?.(state);return state.plugins;}
    if(endpoint==='search/start'){const id=String(++next);jobs.set(id,params);await onStart?.({params,id,state});return {id};}
    if(endpoint==='search/results'){const id=String(params.id),job=jobs.get(id),poll=(polls.get(id)||0)+1;polls.set(id,poll);if(resultFor)return resultFor({job,id,poll,state});return {status:state.running?'Running':'Stopped',results:[{fileName:job.pattern+' 1080p x264',fileUrl:'https://provider.example/download/'+params.id,nbSeeders:40,fileSize:job.category==='books'?5e6:1e9}]};}
    return '';
  };
  const metadata={enrichDiscoveryItems,discovery:async options=>{metadataCalls++;return {rows:(typeof metadataRows==='function'?metadataRows(options):metadataRows)||['movies','tv','anime'].map(kind=>({id:kind,kind,title:kind,description:'Provider-backed starter titles',items:Array.from({length:6},(_,i)=>({id:kind+'-'+i,title:kind+' Story '+i,kind,year:2020,sourceUrl:'https://metadata.example/'+i}))})),warnings:[],updatedAt:123};}};
  const browser=createPluginBrowse({qb,metadata,registerResult:(row,context)=>{registered.push({row,context});return {...row,key:'key-'+row.fileUrl};},pollMs:3,sourceTimeoutMs,now});
  t.after(()=>browser.close());
  return {browser,calls,jobs,registered,state,get metadataCalls(){return metadataCalls;}};
}

test('only selected plugin searches advertised media categories and registration remembers its downloader',async t=>{
  const h=harness(t,{plugins:[plugin('chosen',['movies']),plugin('unrelated',['movies','tv','all'])]});const result=await ready(h.browser,'chosen');
  assert.equal(result.pluginName,'chosen');assert.equal(result.rows.length,1);assert.equal(result.rows[0].items.length,4);
  const searches=h.calls.filter(call=>call.endpoint==='search/start');assert.equal(searches.length,4);assert.ok(searches.every(call=>call.params.plugins==='chosen'&&call.params.category==='movies'));
  assert.ok(h.registered.every(entry=>entry.row.engineName==='chosen'&&entry.context.pluginName==='chosen'));
  assert.ok(result.rows[0].items.every(item=>item.availability.sources.length===1));
  assert.equal(h.calls.some(call=>call.endpoint.startsWith('torrents/')),false);
});

test('a media category exposes its complete catalog through pages without querying hidden titles',async t=>{
  const items=Array.from({length:19},(_,i)=>({id:'movie-'+i,title:'Movie Story '+i,kind:'movies',year:2026}));
  const h=harness(t,{plugins:[plugin('chosen',['movies'])],metadataRows:[{id:'movies',kind:'movies',title:'Movies',items}]});
  const initial=await ready(h.browser,'chosen');assert.equal(initial.rows[0].canExploreAll,true);assert.equal(initial.rows[0].catalogTotal,19);
  const first=await ready(h.browser,'chosen',{category:'movies'});assert.equal(first.rows[0].totalPages,3);assert.equal(first.rows[0].items.length,8);
  const next=await ready(h.browser,'chosen',{category:'movies',page:2});assert.equal(next.rows[0].items[0].id,'movie-8');assert.equal(next.rows[0].page,2);
  const last=await ready(h.browser,'chosen',{category:'movies',page:3});assert.equal(last.rows[0].items.length,3);assert.equal(last.rows[0].hasNext,false);
  assert.ok(h.calls.filter(c=>c.endpoint==='search/start').every(c=>c.params.plugins==='chosen'));
});

test('native miscellaneous shelves use topic matching and retain exact category IDs',async t=>{
  const h=harness(t,{plugins:[plugin('bookshelf',['books'])]});const result=await ready(h.browser,'bookshelf');
  assert.equal(h.metadataCalls,0);assert.equal(result.rows[0].nativeCategory,'books');assert.equal(result.rows[0].items[0].title,'History');assert.ok(result.rows[0].items.every(item=>item.topic&&item.kind==='other'&&item.nativeCategory==='books'));
  assert.ok(h.calls.filter(call=>call.endpoint==='search/start').every(call=>call.params.plugins==='bookshelf'&&call.params.category==='books'));
  assert.equal(result.rows[0].items[0].availability.sources[0].fileSize,5e6,'small ebook is not incorrectly rejected as a tiny video');
  assert.match(result.description,/not a complete browsable catalog/);
});

test('all-only plugins get honest general keyword suggestions without unsupported movie or TV requests',async t=>{
  const h=harness(t,{plugins:[plugin('general',['all'])]});const result=await ready(h.browser,'general');
  assert.equal(h.metadataCalls,0);assert.equal(result.rows.length,1);assert.equal(result.rows[0].items[0].title,'Documentary');assert.ok(result.rows[0].topic);
  assert.ok(h.calls.filter(call=>call.endpoint==='search/start').every(call=>call.params.category==='all'&&call.params.plugins==='general'));
});

test('initial browse is bounded to four shelves, four items per shelf, and eight total cards',async t=>{
  const h=harness(t,{plugins:[plugin('wide',['movies','tv','anime','books','music','software','games','all'])]});const result=await ready(h.browser,'wide');
  assert.equal(result.rows.length,4);assert.equal(result.rows.flatMap(row=>row.items).length,8);assert.ok(result.rows.every(row=>row.items.length<=4));assert.ok(result.rows.some(row=>row.nativeCategory==='books'));assert.match(result.warnings.join(' '),/first four/);
  assert.equal(h.calls.filter(call=>call.endpoint==='search/start').length,8);
});

test('concurrent visits share one browser and duplicate native capabilities do not duplicate shelves',async t=>{
  const h=harness(t,{plugins:[plugin('books',['books','books','all'])]});await Promise.all([h.browser.get('books'),h.browser.get('books'),h.browser.get('books')]);const result=await ready(h.browser,'books');
  assert.equal(result.rows.length,1);assert.equal(result.plugin.categories.length,2);assert.equal(h.calls.filter(call=>call.endpoint==='search/start').length,4);
});

test('invalid, unknown, and disabled plugin identifiers fail before any search begins',async t=>{
  const h=harness(t,{plugins:[plugin('disabled',['all'],false)]});
  await assert.rejects(h.browser.get('a|b'),{status:400});await assert.rejects(h.browser.get('missing'),{status:404});await assert.rejects(h.browser.get('disabled'),{status:400});
  assert.equal(h.calls.some(call=>call.endpoint==='search/start'),false);
});

test('the fourth browser evicts the least recently used plugin and stops its jobs',async t=>{
  const h=harness(t,{plugins:['alpha','beta','gamma','delta'].map(name=>plugin(name,['all'])),running:true});
  for(const name of ['alpha','beta','gamma']){await h.browser.get(name);await pause(12);}
  await h.browser.get('alpha');await h.browser.get('delta');await pause(12);
  const betaJobs=[...h.jobs].filter(([,job])=>job.plugins==='beta').map(([id])=>id);assert.ok(betaJobs.length>0);
  assert.ok(betaJobs.every(id=>h.calls.some(call=>call.endpoint==='search/stop'&&call.params.id===id)));
  const alphaJobs=[...h.jobs].filter(([,job])=>job.plugins==='alpha').map(([id])=>id);assert.ok(alphaJobs.every(id=>!h.calls.some(call=>call.endpoint==='search/stop'&&call.params.id===id)));
  await h.browser.close();await assert.rejects(h.browser.get('alpha'),{status:503});
});

test('disabling an open plugin cancels its running searches and rejects further browsing',async t=>{
  const h=harness(t,{plugins:[plugin('chosen',['all'])],running:true});await h.browser.get('chosen');await pause(15);h.state.plugins[0].enabled=false;
  await assert.rejects(h.browser.get('chosen'),{status:400});assert.ok(h.calls.some(call=>call.endpoint==='search/stop'));
});

test('refresh rechecks sources but never downloads a torrent',async t=>{
  const h=harness(t,{plugins:[plugin('chosen',['music'])]});await ready(h.browser,'chosen');const before=h.calls.filter(call=>call.endpoint==='search/start').length;
  await h.browser.refresh('chosen');await ready(h.browser,'chosen');assert.equal(h.calls.filter(call=>call.endpoint==='search/start').length,before*2);assert.equal(h.calls.some(call=>call.endpoint==='torrents/add'),false);
});

test('an advertised category outside the initial four shelves can be browsed on its own',async t=>{
  const h=harness(t,{plugins:[plugin('wide',['movies','tv','anime','books','music','software','games','all']),plugin('elsewhere',['software'])]});
  const initial=await ready(h.browser,'wide');assert.equal(initial.rows.some(row=>row.nativeCategory==='software'),false);
  const before=h.calls.length,selected=await ready(h.browser,'wide',{category:'software'});
  assert.equal(selected.category,'software');assert.equal(selected.rows.length,1);assert.equal(selected.rows[0].items.length,4);assert.equal(selected.rows[0].items[0].title,'Linux');
  const searches=h.calls.slice(before).filter(call=>call.endpoint==='search/start');assert.equal(searches.length,4);assert.ok(searches.every(call=>call.params.plugins==='wide'&&call.params.category==='software'));
  await h.browser.refresh('wide',{category:'software'});await ready(h.browser,'wide',{category:'software'});assert.equal(h.calls.slice(before).filter(call=>call.endpoint==='search/start').length,8);
});

test('category selection rejects capabilities a plugin does not actually advertise',async t=>{
  const h=harness(t,{plugins:[plugin('books',['books','all'])]});await assert.rejects(h.browser.get('books',{category:'software'}),{status:400});await assert.rejects(h.browser.refresh('books',{category:'books|music'}),{status:400});assert.equal(h.calls.some(call=>call.endpoint==='search/start'),false);
});

test('guide chooses exact Korean and General collections, preserves actual chart evidence, and passively peeks only the requested view',async t=>{
  const week={id:'korean',kind:'tv',periodLabel:'Provider week',periodStart:'2026-10-26',periodEnd:'2026-11-01',
    source:'Fixture chart',stale:true,items:[{id:'kr-week',kind:'tv',title:'Harbor Letters',year:2026}]};
  const month={...week,periodLabel:'Provider four weeks',periodStart:'2026-10-05',stale:false,
    items:[{id:'kr-month',kind:'tv',title:'Harbor Days',year:2026}]};
  const h=harness(t,{plugins:[plugin('chosen',['tv','software','all'])],
    metadataRows:options=>[{id:'tv',kind:'tv',items:[{id:'tv',kind:'tv',title:'Other Show'}]},options.period==='month'?month:week]});
  const initial=await ready(h.browser,'chosen');
  assert.deepEqual(initial.browseCategories.map(({id,category,collection,group})=>({id,category,collection,group})),[
    {id:'all',category:'all',collection:null,group:'overview'},
    {id:'native:tv',category:'tv',collection:null,group:'media'},
    {id:'korean',category:'tv',collection:'korean',group:'media'},
    {id:'native:software',category:'software',collection:null,group:'misc'},
    {id:'general',category:'all',collection:'general',group:'misc'}
  ]);
  const selection={category:'tv',collection:'korean',period:'month',page:1};
  const chosen=await ready(h.browser,'chosen',selection);
  assert.deepEqual({category:chosen.category,collection:chosen.collection,period:chosen.period,requestedPage:chosen.requestedPage},
    {category:'tv',collection:'korean',period:'month',requestedPage:1});
  assert.equal(chosen.rows.length,1);
  assert.equal(chosen.rows[0].browseId,'korean');
  assert.equal(chosen.rows[0].chartState,'available');
  assert.equal(chosen.rows[0].periodLabel,month.periodLabel);
  assert.equal(chosen.rows[0].periodStart,month.periodStart);
  assert.equal(chosen.rows[0].source,month.source);
  assert.equal(chosen.rows[0].items[0].title,'Harbor Days');
  assert.ok(h.calls.some(row=>row.endpoint==='search/start'&&row.params.category==='tv'&&row.params.pattern==='Harbor Days'));
  const before=h.calls.length, registrations=h.registered.length;
  const passive=await h.browser.get('chosen',{...selection,poll:true});
  assert.deepEqual(passive,chosen);
  await assert.rejects(h.browser.get('chosen',{...selection,period:'week',poll:true}),{status:409});
  assert.equal(h.calls.length,before);
  assert.equal(h.registered.length,registrations);
  const general=await ready(h.browser,'chosen',{category:'all',collection:'general',period:'month'});
  assert.equal(general.period,'week');
  assert.equal(general.rows[0].browseId,'general');
  assert.equal(general.rows[0].items[0].title,'Documentary');
});

test('visible evidence distinguishes finished empty results, timeouts, failures, pending and upcoming',async t=>{
  const titles=['Ready Show','Empty Show','Unseeded Show','Broken Show','Slow Show','Useful Show','Future Show','Malformed Show'];
  const chart={id:'tv',kind:'tv',items:titles.map((title,index)=>({id:'show-'+index,title,kind:'tv',upcoming:index===6}))};
  const h=harness(t,{plugins:[plugin('chosen',['tv'])],metadataRows:[chart],sourceTimeoutMs:35,
    resultFor({job,id,poll}){
      const result={fileName:job.pattern+' 1080p',fileUrl:'https://provider.example/'+id,nbSeeders:40,fileSize:1e9,engineName:'wrong'};
      if(job.pattern==='Ready Show')return {status:'Stopped',results:[null,result,{...result,nbSeeders:90}]};
      if(job.pattern==='Empty Show')return {status:'Stopped',results:[]};
      if(job.pattern==='Unseeded Show')return {status:'Stopped',results:[{...result,nbSeeders:0}]};
      if(job.pattern==='Broken Show')throw Error('Connection lost');
      if(job.pattern==='Slow Show')return {status:'Running',results:[]};
      if(job.pattern==='Useful Show')return {status:'Running',results:poll===1?[result]:[]};
      if(job.pattern==='Malformed Show')return {status:'Stopped',results:{unexpected:true}};
      assert.fail('An upcoming title should never launch a search');
    }});
  const options={category:'tv'};
  await h.browser.get('chosen',options);
  let initial;
  for(let i=0;i<60;i++){
    initial=await h.browser.get('chosen',{...options,poll:true});
    if(initial.rows[0]?.evidence.pending>0)break;
    await pause(1);
  }
  assert.ok(initial.rows[0].evidence.pending>0);
  const row=(await ready(h.browser,'chosen',options)).rows[0];
  const {checkedAt,...counts}=row.evidence;
  assert.ok(Number.isFinite(checkedAt));
  assert.deepEqual(counts,{total:8,matched:2,noMatch:2,pending:0,unavailable:3,upcoming:1});
  assert.deepEqual(row.items.map(item=>item.availability.status),
    ['ready','no-match','no-match','error','timeout','ready','upcoming','error']);
  assert.equal(row.items[4].availability.timedOut,true);
  assert.equal(row.items[5].availability.timedOut,true);
  assert.equal(row.items[0].availability.sources.length,1);
  assert.equal(row.items[0].availability.sources[0].nbSeeders,90);
  assert.equal(row.items[0].availability.sources[0].engineName,'chosen');
  assert.equal(h.calls.filter(call=>call.endpoint==='search/start').length,7);
  assert.equal(h.calls.filter(call=>call.endpoint==='search/delete').length,7);
});

test('page-only Recheck keeps other completed keys across scopes and checks film year after enrichment',async t=>{
  let clock=1000;
  const movies={id:'movies',kind:'movies',items:Array.from({length:9},(_,i)=>({id:'m'+i,title:'Film Story '+i,kind:'movies'}))};
  const television={id:'tv',kind:'tv',items:[{id:'tv-1',title:'Other Show',kind:'tv',year:2026}]};
  const h=harness(t,{plugins:[plugin('chosen',['movies','tv'])],metadataRows:[movies,television],now:()=>clock,
    enrichDiscoveryItems:async items=>items.map(item=>({...item,...(item.kind==='movies'?{year:2026}:{})}))});
  const starts=()=>h.calls.filter(call=>call.endpoint==='search/start').map(call=>call.params.pattern);
  const first=await ready(h.browser,'chosen',{category:'movies'});
  assert.equal(first.rows[0].evidence.checkedAt,1000);
  assert.equal(starts().length,8);
  assert.ok(starts().every(pattern=>pattern.endsWith(' 2026')));
  const second={category:'movies',page:2};
  await ready(h.browser,'chosen',second);
  assert.equal(starts().length,9);
  clock=2000;
  const metadataReads=h.metadataCalls;
  const fresh=await h.browser.refresh('chosen',second);
  assert.deepEqual(fresh.rows[0].evidence,{total:1,matched:0,noMatch:0,pending:1,unavailable:0,upcoming:0});
  const rechecked=await ready(h.browser,'chosen',second);
  assert.equal(rechecked.rows[0].evidence.checkedAt,2000);
  assert.equal(h.metadataCalls,metadataReads);
  assert.deepEqual(starts().slice(8),['Film Story 8 2026','Film Story 8 2026']);
  const restored=await ready(h.browser,'chosen',{category:'movies'});
  assert.equal(restored.rows[0].evidence.checkedAt,1000);
  assert.equal(starts().length,10);
  await ready(h.browser,'chosen',{category:'tv'});
  await ready(h.browser,'chosen',{category:'movies'});
  assert.equal(starts().length,11);

  clock=1000+30*60*1000+1;
  const before=h.calls.length;
  const stale=await h.browser.get('chosen',{category:'movies',poll:true});
  assert.equal(stale.rows[0].evidence.checkedAt,1000);
  assert.equal(h.calls.length,before);
  assert.equal((await h.browser.get('chosen',{category:'movies'})).rows[0].evidence.checkedAt,1000);
  assert.equal(starts().length,11,'Same-scope reads do not auto-recheck');
  await ready(h.browser,'chosen',{category:'movies',period:'month'});
  assert.equal(starts().length,19);
});

test('missing and empty chart providers leave dedicated media rows available without starting a search',async t=>{
  const h=harness(t,{plugins:[plugin('chosen',['movies','tv'])],metadataRows:[
    {id:'movies',kind:'movies',unavailable:true,source:'Provider unavailable',items:[]},
    {id:'tv',kind:'tv',items:[{id:'ordinary',kind:'tv',title:'Ordinary Show'}]},
    {id:'korean',kind:'tv',source:'Korean weekly chart',periodLabel:'Actual week',items:[]}
  ]});
  const korean=(await ready(h.browser,'chosen',{category:'tv',collection:'korean'})).rows[0];
  assert.equal(korean.chartState,'empty');
  assert.equal(korean.browseId,'korean');
  assert.equal(korean.periodLabel,'Actual week');
  assert.deepEqual(korean.evidence,{total:0,matched:0,noMatch:0,pending:0,unavailable:0,upcoming:0});
  const movies=(await ready(h.browser,'chosen',{category:'movies',period:'month'})).rows[0];
  assert.equal(movies.chartState,'unavailable');
  assert.equal(movies.browseId,'native:movies');
  assert.equal(h.calls.filter(call=>call.endpoint==='search/start').length,0);
});

test('capability loss between jobs clears completed cache and late results while all visible cards settle',async t=>{
  let firstPoll,release,televisionStarted=false,trip=true;
  const reading=new Promise(resolve=>{firstPoll=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const h=harness(t,{plugins:[plugin('chosen',['movies','tv'])],metadataRows:[
    {id:'movies',kind:'movies',items:[{id:'movie',title:'Earlier Film',kind:'movies',year:2026}]},
    {id:'tv',kind:'tv',items:['Pending Show','Blocked Show','Future Show'].map((title,index)=>({id:'t'+index,title,kind:'tv',upcoming:index===2}))}
  ],
  onStart({params}){if(params.category==='tv')televisionStarted=true;},
  async onPlugins(state){
    if(trip&&televisionStarted){await reading;state.plugins[0].enabled=false;}
  },
  async resultFor({job,id}){
    if(job.category==='tv'){firstPoll();await blocked;}
    return {status:'Stopped',results:[{fileName:job.pattern+' 1080p',fileUrl:'https://provider.example/'+id,nbSeeders:30,fileSize:1e9}]};
  }});
  await ready(h.browser,'chosen',{category:'movies'});
  const television={category:'tv'};
  await h.browser.get('chosen',television);
  await reading;
  const settled=await readyPassive(h.browser,'chosen',television);
  assert.deepEqual({...settled.rows[0].evidence,checkedAt:null},
    {total:3,matched:0,noMatch:0,pending:0,unavailable:2,upcoming:1,checkedAt:null});
  assert.deepEqual(settled.rows[0].items.map(row=>row.availability.reason),['plugin-changed','plugin-changed',undefined]);
  assert.equal(h.calls.filter(call=>call.endpoint==='search/start'&&call.params.category==='tv').length,1);
  release();
  for(let i=0;i<60&&!h.calls.some(call=>call.endpoint==='search/delete'&&call.params.id==='2');i++)await pause(1);
  assert.ok(h.calls.some(call=>call.endpoint==='search/stop'&&call.params.id==='2'));
  assert.ok(h.calls.some(call=>call.endpoint==='search/delete'&&call.params.id==='2'));
  assert.equal(h.registered.filter(row=>row.row.fileName.startsWith('Pending Show')).length,0);
  trip=false;
  h.state.plugins[0].enabled=true;
  await ready(h.browser,'chosen',{category:'movies'});
  assert.equal(h.calls.filter(call=>call.endpoint==='search/start'&&call.params.category==='movies').length,2);
});
test('passive polling for a removed capability is superseded without querying qBittorrent',async t=>{
  const h=harness(t,{plugins:[plugin('chosen',['movies','tv'])]});
  await ready(h.browser,'chosen',{category:'movies'});
  h.state.plugins=[plugin('chosen',['tv'])];
  await ready(h.browser,'chosen',{category:'tv'});
  const count=h.calls.length;
  await assert.rejects(h.browser.get('chosen',{category:'movies',poll:true}),{status:409});
  assert.equal(h.calls.length,count);
});


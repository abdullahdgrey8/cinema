import test from 'node:test';
import {recentFetch} from './recent-fixtures.mjs';
import {NETFLIX_COUNTRIES,NETFLIX_GLOBAL,createRecentCatalog,parseChartTSV} from '../recent-catalog.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMetadata,cleanQuery,validateMetadataUrl,parseWikipedia,parseTVmaze,parsePageMetadata,parseRankedTable,matchConfidence} from '../metadata.mjs';

const image='https://upload.wikimedia.org/wikipedia/en/a/ab/Test_poster.jpg';
const page={pageid:123,title:'Arrival (film)',fullurl:'https://en.wikipedia.org/wiki/Arrival_(film)',thumbnail:{source:image},extract:'Arrival is a 2016 science fiction film about first contact.',pageprops:{'wikibase-shortdesc':'2016 film by Denis Villeneuve'}};
const response=(value,type='application/json',status=200)=>new Response(typeof value==='string'||value instanceof Uint8Array?value:JSON.stringify(value),{status,headers:{'Content-Type':type}});
async function fixture(t,fetchImpl){const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-metadata-test-'));const metadata=await createMetadata({local,fetchImpl,minIntervalMs:0});t.after(async()=>{await metadata.close();await fs.rm(local,{recursive:true,force:true});});return {metadata,local};}
function wikiFetch(url){return url.includes('/w/api.php')?response({query:{pages:[page]}}):response(`<script type="application/ld+json">${JSON.stringify({'@type':'Article',name:'Arrival',image})}</script>`,'text/html');}

test('release names clean without destroying numeric film titles',()=>{
  assert.deepEqual(cleanQuery('[Group] Arrival.2016.1080p.BluRay.x265.mkv',{kind:'movies'}),{query:'Arrival',kind:'movies',year:2016});
  assert.equal(cleanQuery('Blade Runner 2049').query,'Blade Runner 2049');
  assert.equal(cleanQuery('1917').query,'1917');
  assert.equal(cleanQuery('Reply 1988',{kind:'tv',year:2015}).query,'Reply 1988');
  assert.equal(cleanQuery('Breaking.Bad.S01E03.1080p.mkv',{kind:'tv'}).query,'Breaking Bad');
  assert.throws(()=>cleanQuery('a'),/between/);assert.throws(()=>cleanQuery('Arrival',{year:1400}),/release year/);
});

test('Wikipedia rejects disambiguation/list pages and penalizes release-year mismatch',()=>{
  const request={query:'Arrival',year:2016,kind:'movies'};
  const matches=parseWikipedia({query:{pages:[page,{...page,pageid:2,title:'Arrival (disambiguation)',pageprops:{disambiguation:'','wikibase-shortdesc':'Films'}},{...page,pageid:3,title:'List of accolades received by Arrival'}]}},request);
  assert.equal(matches.length,1);assert.equal(matches[0].year,2016);assert.equal(matches[0].confidence,1);
  assert.ok(matchConfidence({...request,year:1996},matches[0])<.7);
});

test('TVmaze strips markup and keeps factual genres, rating and runtime',()=>{
  const [item]=parseTVmaze([{show:{id:3,name:'A Show',premiered:'2020-01-01',type:'Animation',language:'Japanese',summary:'<p>Hello <b>world</b> &amp; friends.</p><script>bad()</script>',url:'https://www.tvmaze.com/shows/3/a-show',genres:['Drama'],runtime:25,rating:{average:8.1},image:{medium:'https://static.tvmaze.com/uploads/images/medium_portrait/1/2.jpg'}}}],{query:'A Show',kind:'anime',year:2020});
  assert.equal(item.kind,'anime');assert.equal(item.overview,'Hello world & friends.');assert.equal(item.runtime,25);assert.deepEqual(item.rating,{value:8.1,scale:10,source:'TVmaze'});
});

test('structured page parser handles graph and OpenGraph while ignoring article publication year',()=>{
  const parsed=parsePageMetadata(`<script type="application/ld+json">broken</script><script type="application/ld+json">{"@graph":[{"@type":"Article","name":"Arrival","datePublished":"2008-01-01"}]}</script><meta content="${image}?x=1&amp;y=2" property="og:image">`);
  assert.equal(parsed.title,'Arrival');assert.equal(parsed.year,null);assert.equal(parsed.posterRemote,image+'?x=1&y=2');
  const film=parsePageMetadata('<script type="application/ld+json">{"@type":"Movie","name":"Arrival","duration":"PT1H56M","datePublished":"2016-11-11"}</script>');assert.equal(film.runtime,116);assert.equal(film.year,2016);
});

test('URL allowlist refuses private addresses, credentials, SVG and lookalike domains',()=>{
  for(const url of ['http://127.0.0.1:8080/a.jpg','https://static.tvmaze.com.evil.example/uploads/images/a.jpg','https://user:pass@static.tvmaze.com/uploads/images/a.jpg','https://upload.wikimedia.org:444/wikipedia/a.jpg','https://upload.wikimedia.org/wikipedia/a.svg','https://[::1]/wikipedia/a.jpg'])assert.throws(()=>validateMetadataUrl(url,'image'));
  assert.equal(validateMetadataUrl(image,'image').hostname,'upload.wikimedia.org');
});

test('lookup coalesces concurrent calls and persists exact poster IDs across restart',async t=>{
  let requests=0;const {metadata,local}=await fixture(t,async url=>{requests++;return wikiFetch(url);});
  const [first,second]=await Promise.all([metadata.lookup('Arrival',{kind:'movies',year:2016}),metadata.lookup('Arrival',{kind:'movies',year:2016})]);
  assert.equal(requests,2);assert.deepEqual(first,second);assert.ok(first.matches[0].structuredPage);
  const restarted=await createMetadata({local,fetchImpl:()=>{throw Error('Should be cached');},minIntervalMs:0});
  const cached=await restarted.lookup('Arrival',{kind:'movies',year:2016});assert.equal(cached.cached,true);assert.equal(cached.matches[0].posterUrl,first.matches[0].posterUrl);await restarted.close();
});

test('poster validates signature, caches bytes, and survives restart without network',async t=>{
  const jpeg=Buffer.from([255,216,255,224,0,16,1,2,3]);let images=0;
  const {metadata,local}=await fixture(t,async url=>{if(url.startsWith('https://upload.')){images++;return response(jpeg,'image/jpeg');}return wikiFetch(url);});
  const found=await metadata.lookup('Arrival',{kind:'movies'});const id=new URL(found.matches[0].posterUrl,'http://localhost').searchParams.get('id');
  const result=await metadata.poster(id);assert.deepEqual(result.body,jpeg);assert.equal(result.contentType,'image/jpeg');
  const restarted=await createMetadata({local,fetchImpl:()=>{throw Error('No network');}});assert.deepEqual((await restarted.poster(id)).body,jpeg);assert.equal(images,1);await restarted.close();
});

test('poster redirect toward loopback is blocked before a second request',async t=>{
  const calls=[];const {metadata}=await fixture(t,async url=>{calls.push(url);return url.startsWith('https://upload.')?new Response(null,{status:302,headers:{location:'http://127.0.0.1:8080/private'}}):wikiFetch(url);});
  const found=await metadata.lookup('Arrival',{kind:'movies'}),id=new URL(found.matches[0].posterUrl,'http://localhost').searchParams.get('id');
  await assert.rejects(metadata.poster(id),/unsafe URL/);assert.ok(calls.every(url=>!url.includes('127.0.0.1')));
});

test('poster rejects HTML masquerading as JPEG and invalid IDs',async t=>{
  const {metadata}=await fixture(t,async url=>url.startsWith('https://upload.')?response('<script>bad()</script>','image/jpeg'):wikiFetch(url));
  const found=await metadata.lookup('Arrival',{kind:'movies'}),id=new URL(found.matches[0].posterUrl,'http://localhost').searchParams.get('id');
  await assert.rejects(metadata.poster(id),/supported poster/);await assert.rejects(metadata.poster('../index'),{status:400});await assert.rejects(metadata.poster('a'.repeat(32)),{status:404});
});

test('oversized metadata response fails honestly without returning arbitrary matches',async t=>{
  const {metadata}=await fixture(t,async()=>new Response('small',{headers:{'Content-Type':'application/json','Content-Length':String(2*1024*1024)}}));
  const result=await metadata.lookup('Arrival',{kind:'movies'});assert.deepEqual(result.matches,[]);assert.match(result.warnings[0],/too large/);
});

test('provider outages remain explicit and television can fall back to Wikipedia',async t=>{
  const {metadata}=await fixture(t,async url=>url.includes('tvmaze')?response('unavailable','text/plain',429):wikiFetch(url));
  const result=await metadata.lookup('Arrival',{kind:'tv'});assert.equal(result.matches.length,1);assert.match(result.warnings[0],/TVmaze:.*busy/);
});

test('corrupt cache records cannot prevent module startup',async t=>{
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-metadata-corrupt-'));t.after(()=>fs.rm(local,{recursive:true,force:true}));await fs.mkdir(path.join(local,'metadata'));await fs.writeFile(path.join(local,'metadata','index.json'),JSON.stringify({lookups:[null,'bad'],posters:[{}]}));
  const metadata=await createMetadata({local,fetchImpl:async url=>wikiFetch(url),minIntervalMs:0});assert.equal((await metadata.lookup('Arrival',{kind:'movies'})).matches[0].title,'Arrival');await metadata.close();
});

test('source-list parser reads title/year columns and refuses external or edit links',()=>{
  const html='<table class="wikitable sortable"><tr><th>Title</th><th>Year</th></tr><tr><td><i><a href="/wiki/Arrival_(film)">Arrival</a></i></td><td>2016</td></tr><tr><td><i><a href="https://localhost/private">Wrong</a></i></td><td>2000</td></tr><tr><td><i><a href="/wiki/Missing?action=edit&amp;redlink=1">Missing</a></i></td><td>2001</td></tr></table>';
  const picks=parseRankedTable(html,'https://en.wikipedia.org/wiki/List_of_highest-grossing_films');assert.equal(picks.length,1);assert.equal(picks[0].title,'Arrival');assert.equal(picks[0].year,2016);assert.equal(picks[0].pageTitle,'Arrival (film)');
});

test('dated discovery caches week and month separately and persists provider-backed shelves',async t=>{
  let requests=0;const {metadata,local}=await fixture(t,async url=>{requests++;return recentFetch(url);});
  const week=await metadata.discovery(),month=await metadata.discovery({period:'month'});assert.equal(week.rows.length,4);assert.ok(week.rows.every(row=>row.items.length>=19));assert.equal(week.period,'week');assert.equal(month.period,'month');assert.notEqual(week.rows[0].periodStart,month.rows[0].periodStart);assert.ok(week.rows[3].items[0].posterUrl.startsWith('/api/metadata/poster?id='));
  // The public country feed can complete during the initial catalog and invalidates it once.
  for(let i=0;metadata.discoveryRevision===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));
  await metadata.discovery();await metadata.discovery({period:'month'});
  const count=requests;assert.equal((await metadata.discovery()).cached,true);assert.equal(requests,count);
  const restarted=await createMetadata({local,fetchImpl:()=>{throw Error('No network');}});assert.equal((await restarted.discovery({period:'month'})).rows[0].periodStart,month.rows[0].periodStart);assert.equal((await restarted.discovery()).rows[0].periodStart,week.rows[0].periodStart);await restarted.close();
});

test('expired discovery retains the last good source-fed shelves during a provider outage',async t=>{
  let clock=Date.now(),offline=false;const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-discovery-offline-'));const metadata=await createMetadata({local,minIntervalMs:0,now:()=>clock,fetchImpl:async url=>{if(offline)throw Error('Offline');return recentFetch(url);}});t.after(async()=>{await metadata.close();await fs.rm(local,{recursive:true,force:true});});
  const original=await metadata.discovery();clock+=7*60*60*1000;offline=true;const stale=await metadata.discovery();assert.equal(stale.rows[0].stale,true);assert.deepEqual(stale.rows[0].items,original.rows[0].items);assert.ok(stale.warnings.some(w=>w.includes('last saved dated chart')));
});

test('unannounced oversized body is bounded while streaming',async t=>{
  const {metadata}=await fixture(t,async()=>new Response('x'.repeat(1024*1024+1),{headers:{'Content-Type':'application/json'}}));const result=await metadata.lookup('Arrival',{kind:'movies'});assert.equal(result.matches.length,0);assert.match(result.warnings[0],/too large/);
});

test('legacy historical discovery caches cannot appear as current charts',async t=>{
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-old-catalog-'));t.after(()=>fs.rm(local,{recursive:true,force:true}));await fs.mkdir(path.join(local,'metadata'));await fs.writeFile(path.join(local,'metadata','index.json'),JSON.stringify({discovery:{updatedAt:Date.now(),rows:[{id:'movies',items:[{title:'Old starter'}]}]}}));
  const metadata=await createMetadata({local,fetchImpl:async()=>{throw Error('Offline');}});t.after(()=>metadata.close());const result=await metadata.discovery();assert.ok(result.rows.every(row=>row.items.length===0));assert.ok(result.warnings.length);
});

test('new anime poster provider is path constrained and preserves redirect protections',()=>{
  assert.equal(validateMetadataUrl('https://static.animecorner.me/2026/06/art.jpg','image').hostname,'static.animecorner.me');for(const url of ['https://static.animecorner.me/private.jpg','https://static.animecorner.me.evil.example/2026/06/a.jpg','https://static.animecorner.me/2026/06/a.svg'])assert.throws(()=>validateMetadataUrl(url,'image'));
  assert.equal(validateMetadataUrl('https://www.fundex.co.kr/pjmeta/pjimg/pj_13550.jpg','image').hostname,'www.fundex.co.kr');for(const url of ['https://www.fundex.co.kr/private.jpg','https://www.fundex.co.kr/pjmeta/pjimg/pj_secret.jpg','https://www.fundex.co.kr/pjmeta/pjimg/pj_1.svg'])assert.throws(()=>validateMetadataUrl(url,'image'));
});

test('slow country expansion never blocks initial charts and publishes a cache revision when ready',async t=>{
  let release;const deferred=new Promise(resolve=>{release=resolve;});
  const {metadata,local}=await fixture(t,async url=>url===NETFLIX_COUNTRIES?deferred:recentFetch(url));t.after(()=>release(recentFetch(NETFLIX_COUNTRIES)));
  const first=await metadata.discovery();assert.equal(first.rows[0].items.length,20);assert.equal(first.expanding,true);assert.equal(metadata.discoveryRevision,0);
  release(recentFetch(NETFLIX_COUNTRIES));for(let i=0;metadata.discoveryRevision===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(metadata.discoveryRevision,1);
  const expanded=await metadata.discovery();assert.equal(expanded.rows[0].items.length,40);assert.equal(expanded.rows[0].sourceUrl,NETFLIX_COUNTRIES);assert.equal(expanded.expanding,false);const saved=JSON.parse(await fs.readFile(path.join(local,'metadata','recent-countries-v1.json'),'utf8'));assert.equal(saved.weeks.length,4);assert.ok(saved.records.every(row=>row.week>='2026-09-13'));
});

test('artwork enrichment retains chart identity, emits incremental metadata ids, and stops on navigation',async t=>{
  const {metadata}=await fixture(t,async url=>wikiFetch(url)),items=[{id:'netflix-one',title:'Arrival',kind:'movies',isSeries:false,year:2016,chartRank:1,source:'Netflix',sourceUrl:'https://www.netflix.com/tudum/top10/'}],seen=[];
  const result=await metadata.enrichDiscoveryItems(items,{onItem:item=>seen.push(item)});assert.equal(result[0].id,'netflix-one');assert.equal(result[0].metadataId,'wikipedia-123');assert.equal(result[0].chartRank,1);assert.equal(result[0].source,'Netflix');assert.equal(seen.length,1);assert.ok(seen[0].posterUrl);
  const stopped=await metadata.enrichDiscoveryItems(items,{shouldContinue:()=>false,onItem:()=>assert.fail('Navigation canceled enrichment')});assert.deepEqual(stopped,items);
});

test('yearless chart titles with two matching remakes keep their artwork unguessed',async t=>{
  const {metadata}=await fixture(t,async url=>url.includes('/w/api.php')?response({query:{pages:[page,{...page,pageid:456,title:'Arrival (1996 film)',pageprops:{'wikibase-shortdesc':'1996 film'}}]}}):wikiFetch(url));const items=[{id:'netflix-one',title:'Arrival',kind:'movies',year:null}],enriched=await metadata.enrichDiscoveryItems(items);assert.deepEqual(enriched,items);
});

test('persisted global chart starts one background warm-up after restart and discovers a newer country cache',async t=>{
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-catalog-restart-')),clock=Date.parse('2026-10-08T12:00:00Z'),provider=createRecentCatalog({now:()=>clock,fetchImpl:recentFetch});
  const global=await provider.discovery();await provider.close();assert.equal(global.rows[0].items.length,20);assert.equal(global.expanding,false);
  await fs.mkdir(path.join(local,'metadata'));await fs.writeFile(path.join(local,'metadata','index.json'),JSON.stringify({discoveryVersion:3,discoveries:{week:global}}));
  const weeks=['2026-10-04','2026-09-27','2026-09-20','2026-09-13'],records=parseChartTSV(await recentFetch(NETFLIX_COUNTRIES).text()).filter(row=>weeks.includes(row.week));await fs.writeFile(path.join(local,'metadata','recent-countries-v1.json'),JSON.stringify({version:1,weeks,records,expiresAt:clock+6*60*60*1000}));
  let release;const held=new Promise(resolve=>{release=resolve;}),calls=[];const metadata=await createMetadata({local,now:()=>clock,minIntervalMs:0,fetchImpl:async url=>{calls.push(url);if(url===NETFLIX_GLOBAL)await held;return recentFetch(url);}});
  t.after(async()=>{release();await metadata.close();await fs.rm(local,{recursive:true,force:true});});
  const [first,second]=await Promise.all([metadata.discovery(),metadata.discovery()]);assert.equal(first.cached,true);assert.equal(second.cached,true);assert.equal(first.rows[0].items.length,20);assert.equal(metadata.discoveryRevision,0);assert.equal(calls.filter(url=>url===NETFLIX_GLOBAL).length,1,'cached reads coalesce into one background provider warm-up');
  release();for(let i=0;metadata.discoveryRevision===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(metadata.discoveryRevision,1);
  const expanded=await metadata.discovery();assert.equal(expanded.rows[0].items.length,40);assert.equal(expanded.rows[0].sourceUrl,NETFLIX_COUNTRIES);assert.equal(calls.filter(url=>url===NETFLIX_GLOBAL).length,1);assert.equal(calls.filter(url=>url===NETFLIX_COUNTRIES).length,0,'country data came from the persisted public cache');
});

test('background country failure after restart preserves the valid cached catalog',async t=>{
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-catalog-warm-failed-')),clock=Date.parse('2026-10-08T12:00:00Z'),provider=createRecentCatalog({now:()=>clock,fetchImpl:recentFetch}),global=await provider.discovery();await provider.close();await fs.mkdir(path.join(local,'metadata'));await fs.writeFile(path.join(local,'metadata','index.json'),JSON.stringify({discoveryVersion:3,discoveries:{week:global}}));
  const metadata=await createMetadata({local,now:()=>clock,minIntervalMs:0,fetchImpl:async url=>{if(url===NETFLIX_COUNTRIES)throw Error('Country feed offline');return recentFetch(url);}});t.after(async()=>{await metadata.close();await fs.rm(local,{recursive:true,force:true});});
  assert.equal((await metadata.discovery()).cached,true);for(let i=0;metadata.discoveryRevision===0&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,5));const retained=await metadata.discovery();assert.equal(retained.cached,true);assert.deepEqual(retained.rows,global.rows);assert.ok(retained.warnings.some(value=>value.includes('saved dated charts remain available')));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {cinema,HASH} from './helpers.mjs';
import {createPlaybackCache} from '../playback-cache.mjs';
import {createQbitSync} from '../qbit-sync.mjs';

test('static assets revalidate without caching credentials or serving another path',async t=>{
  const c=await cinema(t);
  const asset=await c.request('/app.js');
  assert.equal(asset.status,200);
  const etag=asset.headers.get('etag');
  assert.ok(etag);
  assert.ok((await asset.text()).length>1000);
  const validated=await c.request('/app.js',undefined,{headers:{'If-None-Match':'W/'+etag}});
  assert.equal(validated.status,304);
  assert.equal(await validated.text(),'');
  assert.equal((await c.request('/api/session')).headers.get('cache-control'),'no-store');
  assert.equal((await c.request('/launch-cinema.mjs')).status,404);
});

test('result pages advance over provider warnings and carry streaming hints',async t=>{
  const release=(fileName,hash,size,nbSeeders)=>({fileName,fileUrl:'magnet:?xt=urn:btih:'+hash.repeat(40),fileSize:size,nbSeeders,engineName:'video'});
  const c=await cinema(t,{results:[
    {fileName:'Configuration error: API key missing',engineName:'video'},
    release('Example.2026.1080p.H264', 'a',1.2e9,24),
    release('Example.2026.2160p.HEVC','b',18e9,37),
  ]});
  const job=await c.api('/api/search',{query:'Example',category:'movies'});
  const first=await c.api('/api/results?id='+job.id+'&limit=2');
  assert.equal(first.results.length,1);
  assert.equal(first.warnings.length,1);
  assert.equal(first.nextOffset,2);
  assert.equal(first.hasMore,true);
  const next=await c.api('/api/results?id='+job.id+'&offset='+first.nextOffset+'&limit=2');
  assert.equal(next.nextOffset,3);
  assert.equal(next.hasMore,false);
  assert.ok(first.results[0].streaming.score>next.results[0].streaming.score);
});

test('ordinary title search checks all enabled plugins and explicit native search keeps its category',async t=>{
  const c=await cinema(t);
  const defaultJob=await c.api('/api/search',{query:'Boston Legal',category:'tv'});
  assert.equal(defaultJob.scope,'all-enabled');
  assert.equal(defaultJob.pluginCount,3);
  assert.deepEqual(c.state.searches.at(-1),{id:defaultJob.id,pattern:'Boston Legal',category:'all',plugins:'video|anime|misc'});
  const explicit=await c.api('/api/search',{query:'Boston Legal',category:'tv',plugin:'video'});
  assert.equal(explicit.scope,'single');
  assert.deepEqual(c.state.searches.at(-1),{id:explicit.id,pattern:'Boston Legal',category:'tv',plugins:'video'});
  const books=await c.api('/api/search',{query:'Guide',category:'books'});
  assert.equal(books.scope,'category');
  assert.deepEqual(c.state.searches.at(-1),{id:books.id,pattern:'Guide',category:'books',plugins:'misc'});
  assert.ok(!c.state.requests.some(({endpoint})=>endpoint==='torrents/add'));
});

test('broad media results preserve the stronger duplicate and skip nonvideo and invalid links',async t=>{
  const release={fileName:'Boston.Legal.S02E01.720p.x264.mp4',fileUrl:`magnet:?xt=urn:btih:${HASH}`,fileSize:550e6,nbSeeders:36,nbLeechers:4,engineName:'video'};
  const c=await cinema(t,{results:[
    release,
    {...release,nbSeeders:1,engineName:'misc',fileUrl:release.fileUrl+'&dn=other-label'},
    {fileName:'Boston Legal S02E01.srt',fileUrl:'https://video.example/subtitle',fileSize:300000,nbSeeders:500},
    {fileName:'Boston Legal S02E01.mp4',fileUrl:'magnet:?xt=invalid',nbSeeders:999},
  ]});
  const job=await c.api('/api/search',{query:'Boston Legal',category:'all',intentCategory:'tv'});
  const first=await c.api('/api/results?id='+job.id+'&limit=1');
  const next=await c.api('/api/results?id='+job.id+'&offset='+first.nextOffset+'&limit=4');
  assert.equal(first.results[0].kind,'tv');
  assert.equal(next.results.length,1);
  assert.equal(next.results[0].key,first.results[0].key);
  assert.equal(next.results[0].nbSeeders,36);
  assert.equal(next.results[0].engineName,'video');
  assert.equal(next.warnings.length,1);
  assert.equal(next.nextOffset,4);
  assert.ok(!c.state.requests.some(({endpoint})=>endpoint==='torrents/add'));
});

test('playback cache clears only recognized unused generated runs',async t=>{
  const c=await cinema(t);
  const root=path.join(c.dir,'hls',HASH+'-0');
  const active=path.join(root,'111111111111'),unused=path.join(root,'222222222222'),unrecognized=path.join(root,'333333333333');
  for(const folder of [active,unused,unrecognized]){
    await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(folder,'seg000000.ts'),Buffer.alloc(188));
  }
  await fs.writeFile(path.join(unrecognized,'do-not-delete.txt'),'not a generated artifact');
  const original=path.join(c.dir,'original.mp4');
  await fs.writeFile(original,'original content');
  const cache=await createPlaybackCache({local:c.dir,protectedRuns:()=>new Set([active])});
  t.after(()=>cache.close());
  const initial=await cache.status();
  assert.equal(initial.bytes,3*188);
  assert.equal(initial.reclaimableBytes,188);
  const cleared=await cache.clear();
  assert.equal(cleared.removedBytes,188);
  assert.equal(cleared.failedRuns,0);
  await assert.rejects(fs.stat(unused),{code:'ENOENT'});
  assert.equal((await fs.stat(active)).isDirectory(),true);
  assert.equal(await fs.readFile(original,'utf8'),'original content');
  assert.equal(await fs.readFile(path.join(unrecognized,'do-not-delete.txt'),'utf8'),'not a generated artifact');
  assert.equal((await cache.setQuota(5)).quotaGiB,5);
  assert.equal((await cache.setQuota(null)).quotaGiB,null);
});

test('qBittorrent incremental sync preserves unchanged data and removes only reported torrents',async()=>{
  const calls=[],replies=[
    {rid:1,full_update:true,torrents:{[HASH]:{name:'Fixture',progress:.3,tags:'cinema'}},server_state:{dl_info_speed:400,up_info_speed:0}},
    {rid:2,torrents:{[HASH]:{progress:.5}},server_state:{dl_info_speed:900}},
    {rid:3,torrents_removed:[HASH]},
    {rid:1,full_update:true},
  ];
  const sync=createQbitSync(async(endpoint,params)=>{calls.push({endpoint,params});return replies.shift();});
  assert.equal((await sync.read()).torrents[0].tags,'cinema');
  assert.deepEqual(await sync.read(),{torrents:[{hash:HASH,name:'Fixture',progress:.5,tags:'cinema'}],transfer:{dl_info_speed:900,up_info_speed:0}});
  assert.deepEqual((await sync.read()).torrents,[]);
  sync.reset();
  assert.deepEqual(await sync.read(),{torrents:[],transfer:{}});
  assert.deepEqual(calls.map(call=>call.params.rid),[0,1,2,0]);
});

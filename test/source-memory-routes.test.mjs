import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {createMedia} from '../torrent-media.mjs';
import {setupSparseMkv} from './startup-fixture.mjs';
import {cinema,HASH,torrent,until} from './helpers.mjs';

test('local reporting is off initially and accepts one exact fresh incomplete HLS start',async t=>{
  const c=await cinema(t);
  await setupSparseMkv(c);
  await until(async()=>{
    const state=await c.api('/api/state');
    return state.connected&&state.library.some(item=>item.hash===HASH);
  },{description:'the exact isolated torrent to be present'});
  assert.equal((await c.api('/api/state')).sourceMemory.enabled,false);
  const enabled=await c.api('/api/source-memory',{action:'preferences',enabled:true});
  assert.equal(enabled.enabled,true);
  const fresh=await c.api('/api/prepare',{hash:HASH,index:0,rememberStart:true});
  assert.equal(fresh.memoryStart?.revision,enabled.revision);
  const ready=await until(async()=>{
    const state=await c.api('/api/playback?hash='+HASH+'&index=0');
    assert.equal(state.memoryStart,undefined);
    return state.status==='ready'&&state;
  },{timeout:15000,description:'verified isolated HLS while incomplete'});
  assert.equal(ready.mode,'hls');
  assert.equal(ready.complete,false);
  assert.ok(ready.progress<1);
  const payload={action:'record',hash:HASH,index:0,sessionId:ready.sessionId,revision:enabled.revision,firstPictureMs:1700};
  assert.deepEqual(await c.api('/api/source-memory',{...payload,index:1}),{accepted:false});
  assert.deepEqual(await c.api('/api/source-memory',{...payload,sessionId:'0'.repeat(32)}),{accepted:false});
  const reports=await Promise.all([c.api('/api/source-memory',payload),c.api('/api/source-memory',payload)]);
  assert.equal(reports.filter(result=>result.accepted).length,1);
  assert.deepEqual((await c.api('/api/state')).sourceMemory.observed,[{hash:HASH,
    cohorts:[{condition:'downloading',mode:'hls',count:1,medianMs:1700}]}]);
  assert.equal((await c.api('/api/prepare',{hash:HASH,index:0,rememberStart:true})).memoryStart,undefined);
  const cleared=await c.api('/api/source-memory',{action:'clear',confirm:true});
  assert.deepEqual(cleared.observed,[]);
  assert.notEqual(cleared.revision,enabled.revision);
  assert.deepEqual(await c.api('/api/source-memory',payload),{accepted:false});
});


async function memoryFixtureVideo(filename){
  await encode(['-f','lavfi','-i','color=c=blue:s=96x54:r=10:d=2',
    '-an','-c:v','libx264','-preset','ultrafast','-threads:v','1','-g','10',
    '-pix_fmt','yuv420p','-movflags','+faststart',filename]);
  return (await fs.stat(filename)).size;
}
async function encode(args){
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],
    {windowsHide:true,stdio:['ignore','ignore','pipe']});
  let diagnostic='';
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-3000);});
  const [code]=await once(child,'close');
  assert.equal(code,0,diagnostic);
}
function completeFile(index,name,size){
  return {index,name,size,priority:1,progress:1};
}
async function currentPlayback(api,hash){
  return until(async()=>{
    const current=await api('/api/playback?hash='+hash+'&index=0');
    assert.notEqual(current.status,'error',JSON.stringify(current));
    return current.status==='ready'&&current;
  },{description:'the exact isolated playback session to be ready'});
}
function completedTorrent(dir,hash,name,size){
  return torrent(dir,{hash,name,size,total_size:size,downloaded:size,
    content_path:path.join(dir,name)});
}

test('a restored completed HLS copy and a multi-video torrent do not produce observations',async t=>{
  const c=await cinema(t),restoredName='Restored.fixture.mp4',packName='Pack.first.mp4',
    siblingName='Pack.second.mp4',packHash='b'.repeat(40),run='123456abcdef';
  const source=path.join(c.dir,restoredName),size=await memoryFixtureVideo(source);
  await fs.copyFile(source,path.join(c.dir,packName));
  await fs.copyFile(source,path.join(c.dir,siblingName));
  c.state.torrents=[
    completedTorrent(c.dir,HASH,restoredName,size),
    completedTorrent(c.dir,packHash,packName,size*2),
  ];
  c.state.files.set(HASH,[completeFile(0,restoredName,size)]);
  c.state.files.set(packHash,[completeFile(0,packName,size),completeFile(1,siblingName,size)]);
  const cache=path.join(c.dir,'hls',HASH+'-0'),folder=path.join(cache,run);
  await fs.mkdir(folder,{recursive:true});
  await encode(['-i',source,'-map','0:v:0','-c:v','copy','-f','hls','-hls_time','1',
    '-hls_list_size','0','-hls_segment_filename',path.join(folder,'seg%06d.ts'),path.join(folder,'index.m3u8')]);
  await fs.writeFile(path.join(cache,'completed.json'),JSON.stringify({run,size,duration:2}));
  await until(async()=>{
    const state=await c.api('/api/state');
    return state.connected&&state.library.length===2;
  },{description:'the two completed fixture torrents'});
  const enabled=await c.api('/api/source-memory',{action:'preferences',enabled:true});
  assert.equal(enabled.enabled,true);
  const report=state=>c.api('/api/source-memory',{action:'record',hash:state.hash,index:state.index,
    sessionId:state.sessionId,revision:enabled.revision,firstPictureMs:800});

  await c.api('/api/prepare',{hash:HASH,index:0,rememberStart:true});
  const restored=await currentPlayback(c.api,HASH);
  assert.equal(restored.mode,'hls');
  assert.equal(restored.complete,true);
  assert.equal(restored.url,'/hls/'+HASH+'-0/'+run+'/index.m3u8');
  const manifest=await (await c.request(restored.url)).text();
  assert.match(manifest,/#EXT-X-ENDLIST/);
  const segment=await c.request(restored.url.replace('index.m3u8','seg000000.ts'));
  assert.equal(segment.status,200);
  assert.equal(new Uint8Array(await segment.arrayBuffer())[0],0x47);
  assert.deepEqual(await report(restored),{accepted:false});

  const multi=await c.api('/api/prepare',{hash:packHash,index:0,rememberStart:true});
  assert.equal(multi.memoryStart,undefined);
  const ready=await currentPlayback(c.api,packHash);
  assert.equal(ready.mode,'direct');
  assert.deepEqual(await report(ready),{accepted:false});
  assert.deepEqual((await c.api('/api/state')).sourceMemory.observed,[]);
  assert.deepEqual(c.state.requests.filter(row=>row.method==='POST'&&row.endpoint.startsWith('torrents/')),[]);
});

test('an actual fresh daemon admission binds scope and epoch and rejects an expired report',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-source-memory-media-'));
  const name='Exact.fixture.mp4',requests=[];
  let media,origin;
  const server=http.createServer(async(req,res)=>{
    try{await media.stream(req,res,new URL(req.url,origin));}
    catch(error){if(res.headersSent)res.destroy();else res.writeHead(error.status||500).end();}
  });
  t.after(async()=>{
    await media?.shutdown();
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cinema-source-memory-media-'));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const size=await memoryFixtureVideo(path.join(dir,name));
  const selected=completedTorrent(dir,HASH,name,size),selectedFile=completeFile(0,name,size);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin='http://127.0.0.1:'+server.address().port;
  const qb=async(endpoint,params={},method='GET')=>{
    requests.push({endpoint,method});
    assert.equal(method,'GET','Completed fixture playback and observation are read-only');
    if(endpoint==='torrents/info')return [selected];
    if(endpoint==='torrents/files')return [selectedFile];
    if(endpoint==='torrents/properties')return {piece_size:size};
    if(endpoint==='app/preferences')return {};
    throw Error('Unexpected mock qBittorrent endpoint '+endpoint);
  };
  media=createMedia({qb,rawQb:async()=>{throw Error('No fixture torrent export');},
    local:dir,origin,internalToken:'source-memory-fixture'});
  const context={scope:'c'.repeat(64),connectionEpoch:7,revision:'d'.repeat(32)};
  const prepared=await media.prepare(HASH,0,{sourceMemory:context});
  assert.deepEqual(prepared.memoryStart,{revision:context.revision,size});
  const ready=await until(async()=>{
    const current=await media.playback(HASH,0);
    assert.notEqual(current.status,'error',JSON.stringify(current));
    return current.status==='ready'&&current;
  },{description:'the directly prepared exact file'});
  assert.equal(ready.mode,'direct');
  assert.equal(ready.sessionId,prepared.sessionId);
  const beforeReports=requests.length;
  const consume=identity=>media.consumeSourceMemoryStart(HASH,0,ready.sessionId,identity);
  assert.equal(consume({...context,scope:'e'.repeat(64)}),null);
  assert.equal(consume({...context,connectionEpoch:8}),null);
  assert.equal(consume({...context,revision:'f'.repeat(32)}),null);

  // The production TTL uses Date.now. Apply the scoped clock only to one
  // synchronous call and restore it before timers or I/O can run.
  const expiredAt=Date.now()+31*60*1000;
  const wallClock=t.mock.method(Date,'now',()=>expiredAt);
  try{assert.equal(consume(context),null);}
  finally{wallClock.mock.restore();}
  assert.deepEqual(consume(context),{hash:HASH,index:0,name,size,condition:'downloaded',mode:'direct'});
  assert.equal(consume(context),null);
  assert.equal(requests.length,beforeReports,'Admitting or rejecting local reports needs no qBittorrent read');
});

test('search route exposes only full normalized unambiguous memory aliases',async t=>{
  const c=await cinema(t),v1='a'.repeat(40),otherV1='b'.repeat(40),
    v2='cd'.repeat(32),otherV2='ef'.repeat(32);
  const btih=value=>'urn:btih:'+value, btmh=value=>'urn:btmh:1220'+value;
  const magnet=(...values)=>'magnet:?'+values.map(value=>'xt='+encodeURIComponent(value)).join('&');
  c.state.torrents=[torrent(c.dir,{hash:v1,infohash_v1:v1,infohash_v2:v2})];
  c.state.results=[
    ['V1',magnet(btih(v1.toUpperCase()))],
    ['V2',magnet(btmh(v2.toUpperCase()))],
    ['Hybrid',magnet(btih(v1),btmh(v2),btih(v1.toUpperCase()))],
    ['Ambiguous V1',magnet(btih(v1),btih(otherV1))],
    ['Ambiguous V2',magnet(btmh(v2),btmh(otherV2))],
    ['Truncated V2',magnet(btmh(v2.slice(0,40)))],
    ['Provider link','https://video.example/opaque-source'],
  ].map(([fileName,fileUrl])=>({fileName,fileUrl,siteUrl:'https://video.example',fileSize:1024,nbSeeders:5,nbLeechers:1}));
  await until(async()=>{
    const state=await c.api('/api/state');
    return state.connected&&state.library.some(row=>row.hash===v1);
  },{description:'the exact local hybrid alias fixture'});
  const {id}=await c.api('/api/search',{query:'Source memory fixture',category:'all'});
  const result=await c.api('/api/results?id='+id);
  const rows=new Map(result.results.map(row=>[row.fileName,row]));
  assert.equal(rows.size,6);
  assert.deepEqual(rows.get('V1').memoryAliases,[v1]);
  assert.deepEqual(rows.get('V2').memoryAliases,[v2]);
  assert.deepEqual(rows.get('Hybrid').memoryAliases,[v1,v2]);
  for(const name of ['Ambiguous V1','Ambiguous V2','Provider link']){
    assert.equal(Object.hasOwn(rows.get(name),'memoryAliases'),false,name);
  }
  assert.equal(rows.get('Ambiguous V1').existingHash,v1,
    'A legacy existingHash must not give an ambiguous row a memory alias');
  assert.equal(rows.has('Truncated V2'),false,'A truncated v2 magnet must not become a release');
  assert.ok(result.warnings.some(warning=>warning.message==='Truncated V2'));
  assert.deepEqual(c.state.requests.filter(row=>row.method==='POST'&&row.endpoint!=='auth/login')
    .map(row=>row.endpoint),['search/start']);
  assert.deepEqual(c.state.requests.filter(row=>/^search\/(?:start|results|status|stop|delete)$/.test(row.endpoint))
    .map(row=>row.endpoint),['search/start','search/results']);
});

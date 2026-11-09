import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import http from 'node:http';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent,until,wait} from './helpers.mjs';

const data=Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(value.length+':'),value]);
  if (typeof value==='string') return bencode(Buffer.from(value));
  if (typeof value==='number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'),...value.map(bencode),Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(key=>[bencode(key),bencode(value[key])]),Buffer.from('e')]);
}
function exportTorrent(c,metadata) {
  const bytes=bencode(metadata);
  c.state.handlers['torrents/export']=({res})=>{res.writeHead(200,{'Content-Type':'application/x-bittorrent'});res.end(bytes);};
}
async function videoFile(c,changes={}) {
  await fs.writeFile(path.join(c.dir,'sample.mp4'),data);
  c.state.torrents=[torrent(c.dir)];
  c.state.files.set(HASH,[{index:0,name:'sample.mp4',size:data.length,progress:1,piece_range:[0,2],priority:1,...changes}]);
}

test('local API protects mutations and streams complete byte/suffix ranges',async t=>{
  const c=await cinema(t);await videoFile(c);
  assert.equal((await fetch(c.base+'/api/prepare',{method:'POST',body:'{}'})).status,403);
  assert.equal((await c.request('/api/session',undefined,{headers:{Origin:'https://untrusted.example'}})).status,403);
  const foreignHostStatus=await new Promise((resolve,reject)=>{
    const request=http.get(c.base+'/api/session',{headers:{Host:'untrusted.example'}},res=>{res.resume();resolve(res.statusCode);});request.on('error',reject);
  });
  assert.equal(foreignHostStatus,403);
  const session=await c.api('/api/session');assert.equal(Object.hasOwn(session,'password'),false);
  const sought=await c.request(`/stream?hash=${HASH}&index=0`,undefined,{headers:{Range:'bytes=10-19'}});
  assert.equal(sought.status,206);assert.equal(sought.headers.get('content-range'),'bytes 10-19/36');assert.equal(await sought.text(),'abcdefghij');
  const suffix=await c.request(`/stream?hash=${HASH}&index=0`,undefined,{headers:{Range:'bytes=-5'}});
  assert.equal(suffix.status,206);assert.equal(await suffix.text(),'vwxyz');
  const invalid=await c.request(`/stream?hash=${HASH}&index=0`,undefined,{headers:{Range:'bytes=200-'}});
  assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */36');
  c.state.files.get(HASH)[0].name='../escape.mp4';
  assert.equal((await c.request(`/stream?hash=${HASH}&index=0`)).status,403);
});

test('partial single-file downloads wait for verified pieces and read .!qB files',async t=>{
  const c=await cinema(t);await videoFile(c,{progress:.2});
  c.state.torrents[0].progress=.2;c.state.pieces=[0,0,0];
  exportTorrent(c,{info:{name:'sample.mp4',length:data.length,'piece length':16,pieces:Buffer.alloc(60)}});
  await fs.rename(path.join(c.dir,'sample.mp4'),path.join(c.dir,'sample.mp4.!qB'));
  let returned=false;
  const waiting=c.request(`/stream?hash=${HASH}&index=0`).then(async r=>{returned=true;assert.equal(r.status,200);return r.text();});
  await wait(250);assert.equal(returned,false,'Undownloaded pieces must not be returned as zeroes or corrupt video');
  c.state.pieces=[2,2,2];assert.equal(await waiting,data.toString());
});

test('multifile streaming uses exact torrent offsets including preceding nonvideo files',async t=>{
  const c=await cinema(t);
  await fs.mkdir(path.join(c.dir,'Fixture'));
  await fs.writeFile(path.join(c.dir,'Fixture','sample.mp4'),data);
  c.state.torrents=[torrent(c.dir,{name:'Fixture',progress:.2})];
  c.state.files.set(HASH,[
    {index:0,name:'Fixture/lead.txt',size:7,progress:1,piece_range:[0,0],priority:1},
    {index:1,name:'Fixture/sample.mp4',size:36,progress:.2,piece_range:[0,2],priority:1},
  ]);
  exportTorrent(c,{info:{name:'Fixture','piece length':16,pieces:Buffer.alloc(60),files:[{length:7,path:['lead.txt']},{length:36,path:['sample.mp4']}]}});
  c.state.pieces=[2,0,2];
  const files=await c.api('/api/files?hash='+HASH);
  assert.ok(files.some(f=>f.name.endsWith('lead.txt')),'Nonvideo files remain visible and are labeled unplayable');
  assert.equal(files.find(f=>f.index===0).playable,false);
  assert.equal(files.find(f=>f.index===1).playable,true);
  let returned=false;
  const waiting=c.request(`/stream?hash=${HASH}&index=1`,undefined,{headers:{Range:'bytes=10-14'}}).then(async r=>{returned=true;assert.equal(r.status,206);return r.text();});
  await wait(300);assert.equal(returned,false,'Relative bytes 10-14 are absolute bytes 17-21: piece 1 must be verified');
  c.state.pieces=[2,2,2];assert.equal(await waiting,'abcde');
});

for (const layout of ['v1-padding','v2-alignment']) test(`piece gating respects ${layout} omitted from qBittorrent's visible file list`,async t=>{
  const c=await cinema(t);
  await fs.mkdir(path.join(c.dir,'Fixture'));
  await fs.writeFile(path.join(c.dir,'Fixture','sample.mp4'),data);
  c.state.torrents=[torrent(c.dir,{name:'Fixture',progress:.2})];
  c.state.files.set(HASH,[
    {index:0,name:'Fixture/lead.txt',size:7,progress:1,piece_range:[0,0],priority:1},
    {index:1,name:'Fixture/sample.mp4',size:36,progress:.2,piece_range:[1,3],priority:1},
  ]);
  const info=layout==='v1-padding'
    ? {name:'Fixture','piece length':16,pieces:Buffer.alloc(80),files:[{length:7,path:['lead.txt']},{length:9,path:['.pad','9'],attr:'p'},{length:36,path:['sample.mp4']}]}
    : {name:'Fixture','piece length':16,'meta version':2,'file tree':{'lead.txt':{'':{length:7}},'sample.mp4':{'':{length:36}}}};
  exportTorrent(c,{info});c.state.pieces=[2,0,2,2];
  let returned=false;
  const waiting=c.request(`/stream?hash=${HASH}&index=1`,undefined,{headers:{Range:'bytes=0-4'}}).then(async r=>{returned=true;assert.equal(r.status,206);return r.text();});
  await wait(250);assert.equal(returned,false,'First media byte is in piece 1, after nine bytes of padding');
  c.state.pieces=[2,2,2,2];assert.equal(await waiting,'01234');
});

test('an unverifiable multifile layout waits safely, and complete files remain playable',async t=>{
  const c=await cinema(t);await videoFile(c,{progress:.2});
  c.state.files.get(HASH).push({index:1,name:'notes.txt',size:7,progress:1,piece_range:[2,2],priority:1});
  c.state.pieces=[2,2,2];
  c.state.handlers['torrents/export']=({send})=>send('Not found',404);
  const partial=await c.request(`/stream?hash=${HASH}&index=0`);assert.equal(partial.status,409);
  c.state.files.get(HASH)[0].progress=1;
  const complete=await c.request(`/stream?hash=${HASH}&index=0`);assert.equal(complete.status,200);assert.equal(await complete.text(),data.toString());
});

test('removing a playing download closes only its active file readers before deleting',async t=>{
  const c=await cinema(t),other='b'.repeat(40),size=512*1024,pieceSize=256*1024;
  const first='first.mp4',second='second.mp4';
  await fs.writeFile(path.join(c.dir,first),Buffer.alloc(size,0x61));
  await fs.writeFile(path.join(c.dir,second),Buffer.alloc(size,0x62));
  c.state.torrents=[torrent(c.dir,{name:first,size,total_size:size,progress:.5}),torrent(c.dir,{hash:other,name:second,size,total_size:size,progress:.5})];
  c.state.files.set(HASH,[{index:0,name:first,size,progress:.5,piece_range:[0,1],priority:1}]);
  c.state.files.set(other,[{index:0,name:second,size,progress:.5,piece_range:[0,1],priority:1}]);
  c.state.properties={piece_size:pieceSize};c.state.pieces=[2,0];
  c.state.handlers['torrents/export']=({params,res})=>{
    const bytes=bencode({info:{name:params.get('hash')===HASH?first:second,length:size,'piece length':pieceSize,pieces:Buffer.alloc(40)}});
    res.writeHead(200,{'Content-Type':'application/x-bittorrent'});res.end(bytes);
  };
  async function read(hash){
    const response=await c.request(`/stream?hash=${hash}&index=0`);assert.equal(response.status,200);
    const reader=response.body.getReader();const initial=await reader.read();assert.ok(initial.value.length>0);
    const state={length:initial.value.length,closed:false,error:null};
    state.finished=(async()=>{try{while(true){const chunk=await reader.read();if(chunk.done)break;state.length+=chunk.value.length;}}catch(error){state.error=error;}finally{state.closed=true;}})();
    return state;
  }
  const [selectedReader,otherReader]=await Promise.all([read(HASH),read(other)]);
  await wait(100);assert.equal(selectedReader.closed,false);assert.equal(otherReader.closed,false);
  await c.api('/api/torrent/action',{hash:HASH,action:'delete',deleteFiles:false,confirmName:first});
  await until(()=>selectedReader.closed,{timeout:3000,description:'deleted torrent stream to close'});
  assert.ok(selectedReader.error,'Incomplete HTTP response must terminate when its torrent is removed');
  assert.equal(otherReader.closed,false,'Deleting one torrent must not interrupt another stream');
  assert.equal((await c.request(`/stream?hash=${HASH}&index=0`)).status,410);
  c.state.pieces=[2,2];await otherReader.finished;assert.equal(otherReader.error,null);assert.equal(otherReader.length,size);
});

test('playback converts incompatible MKV through real HLS while qBittorrent is still downloading',async t=>{
  const c=await cinema(t);
  const filename='fixture.mkv';
  const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=160x90:r=25:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','ffv1','-c:a','pcm_s16le','-shortest',path.join(c.dir,filename)],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(encoder,'close'))[0],0,'Synthetic MKV fixture should encode');
  const size=(await fs.stat(path.join(c.dir,filename))).size;
  const pieceSize=16384,pieceCount=Math.ceil(size/pieceSize);
  c.state.torrents=[torrent(c.dir,{name:filename,size,total_size:size,progress:.8,dlspeed:1000000,eta:10})];
  c.state.files.set(HASH,[{index:0,name:filename,size,progress:.8,piece_range:[0,pieceCount-1],priority:1}]);
  c.state.properties={piece_size:pieceSize};c.state.pieces=Array(pieceCount).fill(2);
  exportTorrent(c,{info:{name:filename,length:size,'piece length':pieceSize,pieces:Buffer.alloc(pieceCount*20)}});
  const prepared=await c.api('/api/prepare',{hash:HASH,index:0});assert.ok(prepared.status);
  const playback=await until(async()=>{
    const r=await c.api(`/api/playback?hash=${HASH}&index=0`);
    assert.notEqual(r.status,'error',JSON.stringify(r));
    return r.status==='ready' && r;
  },{timeout:30000,interval:200,description:'browser-compatible HLS before full torrent completion'});
  assert.equal(c.state.files.get(HASH)[0].progress,.8,'Playback must not require a completed torrent');
  assert.equal(playback.mode,'hls');assert.ok(playback.url);
  const manifestResponse=await c.request(playback.url);assert.equal(manifestResponse.status,200);
  const manifest=await manifestResponse.text();assert.match(manifest,/#EXTM3U/);
  const segment=manifest.split(/\r?\n/).find(line=>line && !line.startsWith('#'));
  assert.ok(segment,'A playable manifest needs at least one media segment');
  const segmentUrl=new URL(segment,new URL(playback.url,c.base));
  const segmentResponse=await fetch(segmentUrl);assert.equal(segmentResponse.status,200);
  const bytes=new Uint8Array(await segmentResponse.arrayBuffer());assert.ok(bytes.length>188);assert.equal(bytes[0],0x47,'HLS segment must contain MPEG transport packets');
});

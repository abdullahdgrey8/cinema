import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent,until,wait} from './helpers.mjs';
import {createMedia} from '../torrent-media.mjs';

test('a genuinely incomplete MKV produces playable HLS while its remaining pieces are unavailable',async t=>{
  const c=await cinema(t),name='partial-fixture.mkv';
  const encoded=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=160x90:r=25:d=60','-f','lavfi','-i','sine=frequency=440:duration=60','-c:v','ffv1','-c:a','pcm_s16le','-shortest',path.join(c.dir,name)],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(encoded,'close'))[0],0);
  const original=await fs.readFile(path.join(c.dir,name)),size=original.length,pieceSize=65536,count=Math.ceil(size/pieceSize),have=Math.ceil(count*.35);
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress:.35,dlspeed:1000000})];
  c.state.files.set(HASH,[{index:0,name,size,progress:.35,piece_range:[0,count-1],priority:1}]);
  c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,i)=>i<have?2:0);
  // The sparse, undownloaded region contains no playable source data.
  const handle=await fs.open(path.join(c.dir,name),'r+');await handle.write(Buffer.alloc(size-have*pieceSize),0,size-have*pieceSize,have*pieceSize);await handle.close();
  // Old versions could save a 20-second prefix as a completed 60-second movie.
  const badRun='123456abcdef',badFolder=path.join(c.dir,'hls',HASH+'-0',badRun);await fs.mkdir(badFolder,{recursive:true});
  await fs.writeFile(path.join(badFolder,'index.m3u8'),'#EXTM3U\n#EXTINF:20,\nseg000000.ts\n#EXT-X-ENDLIST\n');
  await fs.writeFile(path.join(c.dir,'hls',HASH+'-0','completed.json'),JSON.stringify({run:badRun,size,duration:60}));
  await c.api('/api/prepare',{hash:HASH,index:0});
  const ready=await until(async()=>{const p=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(p.status,'error',JSON.stringify(p));return p.status==='ready'&&p;},{timeout:18000,interval:200,description:'actual HLS playback with 65% of source pieces still unavailable'});
  assert.equal(ready.mode,'hls');assert.equal(ready.progress,.35);assert.ok(c.state.pieces.includes(0));
  assert.deepEqual(ready.probeFacts,{videoCodec:'ffv1',audioCodec:'pcm_s16le',width:160,height:90});
  assert.ok(!ready.url.includes(badRun),'A legacy truncated completed cache must never be used');
  const manifest=await (await c.request(ready.url)).text();assert.match(manifest,/#EXTINF:/);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);
  const published=path.join(c.dir,...new URL(ready.url,c.base).pathname.split('/').filter(Boolean));
  await fs.appendFile(published,'#EXT-X-ENDLIST\n');
  assert.doesNotMatch(await (await c.request(ready.url)).text(),/#EXT-X-ENDLIST/,'An unvalidated end marker must not tell the browser that a partial movie finished');
  const segment=manifest.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
  const segmentUrl=new URL(segment,new URL(ready.url,c.base));
  const bytes=new Uint8Array(await (await fetch(segmentUrl)).arrayBuffer());assert.equal(bytes[0],0x47);assert.ok(bytes.length>188);
  let finalValidationDelayed=false;
  c.state.handlers['torrents/info']=async({params,send})=>{
    const playlist=await fs.readFile(published,'utf8').catch(()=>'');
    const publishedSeconds=[...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum,m)=>sum+Number(m[1]),0);
    if(!finalValidationDelayed&&c.state.torrents[0].progress===1&&publishedSeconds>=59&&playlist.includes('#EXT-X-ENDLIST')){finalValidationDelayed=true;await wait(750);}
    const selected=params.get('hashes')?.split('|');send(c.state.torrents.filter(t=>!selected||selected.includes(t.hash)));
  };
  // Continue the same encoder/playlist when the download supplies later pieces.
  const remaining=await fs.open(path.join(c.dir,name),'r+');
  try{await remaining.write(original,have*pieceSize,size-have*pieceSize,have*pieceSize);}finally{await remaining.close();}
  c.state.pieces.fill(2);c.state.files.get(HASH)[0].progress=1;c.state.torrents[0].progress=1;
  const finished=await until(async()=>{const states=await Promise.all(Array.from({length:4},()=>c.api(`/api/playback?hash=${HASH}&index=0`)));for(const p of states){assert.notEqual(p.status,'error',JSON.stringify(p));if(p.url)assert.equal(p.url,ready.url,'Final validation must not replace a live playback URL');}return states.find(p=>p.complete);},{timeout:15000,interval:5,description:'same playback session to finish amid concurrent polling and delayed completion validation'}).catch(async error=>{t.diagnostic(JSON.stringify({files:await fs.readdir(path.dirname(published)),published:await fs.readFile(published,'utf8').catch(()=>''),temporary:await fs.readFile(published+'.tmp','utf8').catch(()=>'')}));throw error;});
  assert.equal(finalValidationDelayed,true,'The final validation delay must exercise the completion race');
  assert.equal(finished.url,ready.url);assert.match(await (await c.request(finished.url)).text(),/#EXT-X-ENDLIST/);
});

test('internal converter streams survive the normal piece timeout and transient qBittorrent outage without EOF',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-stream-stall-'));await fs.writeFile(path.join(dir,'sample.mp4'),'abcdef');
  let state=[2,0,0],offline=false;
  const qb=async endpoint=>{
    if(endpoint==='torrents/info')return [torrent(dir,{name:'sample.mp4',size:6,total_size:6,progress:1/3})];
    if(endpoint==='torrents/files')return [{index:0,name:'sample.mp4',size:6,progress:1/3,priority:1,piece_range:[0,2]}];
    if(endpoint==='torrents/properties')return {piece_size:2};
    if(endpoint==='torrents/pieceStates'){if(offline)throw Object.assign(Error('Temporarily offline'),{status:503});return state;}
    if(endpoint==='app/preferences')return {};
    return '';
  };
  let media;
  const server=http.createServer(async(req,res)=>{try{await media.stream(req,res,new URL(req.url,'http://127.0.0.1'));}catch(e){if(res.headersSent)res.destroy();else{res.writeHead(e.status||500);res.end(e.message);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  media=createMedia({qb,rawQb:async()=>{throw Error('No export');},local:dir,origin:base,internalToken:'private-token',pieceWaitMs:100});
  t.after(async()=>{await media.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('cinema-stream-stall-'));await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const internal=await fetch(`${base}/stream?hash=${HASH}&index=0&internal=private-token`),reader=internal.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'ab');
  let ended=false,failed=null;const tail=(async()=>{let text='';try{for(;;){const next=await reader.read();if(next.done)break;text+=Buffer.from(next.value).toString();}}catch(e){failed=e;}finally{ended=true;}return text;})();
  await wait(800);assert.equal(ended,false,'A missing piece is buffering, not end of video');
  offline=true;await wait(900);assert.equal(ended,false,'A temporary qBittorrent outage must not end the converter input');
  offline=false;state=[2,2,2];assert.equal(await tail,'cdef');assert.equal(failed,null);
});

for(const {faststart,mp3=false} of [{faststart:true},{faststart:false},{faststart:true,mp3:true}])
test(`partial MP4 starts with ${faststart?'opening':'trailing'} movie index, ${mp3?'MP3':'AAC'} audio, and most video pieces missing`,async t=>{
  const c=await cinema(t),name='partial-fixture.mp4';
  const encoded=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=80','-f','lavfi','-i','sine=frequency=440:duration=80','-c:v','libx264','-preset','ultrafast','-g','100','-b:v','1M','-c:a',mp3?'libmp3lame':'aac',...(faststart?['-movflags','+faststart']:[]),'-shortest',path.join(c.dir,name)],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(encoded,'close'))[0],0);
  const data=await fs.readFile(path.join(c.dir,name)),size=data.length,pieceSize=65536,count=Math.ceil(size/pieceSize),have=Math.ceil(count*.25);
  let offset=0,moov;
  while(offset+8<=size){const length=data.readUInt32BE(offset),kind=data.toString('ascii',offset+4,offset+8);if(kind==='moov'){moov={start:offset,end:offset+length};break;}assert.ok(length>=8);offset+=length;}
  assert.ok(moov);
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress:.3,dlspeed:1000000})];
  c.state.files.set(HASH,[{index:0,name,size,progress:.3,piece_range:[0,count-1],priority:1}]);
  c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,i)=>i<have||(i>=Math.floor(moov.start/pieceSize)&&i<=Math.floor((moov.end-1)/pieceSize))?2:0);
  for(let i=0;i<count;i++)if(c.state.pieces[i]===0)data.fill(0,i*pieceSize,Math.min(size,(i+1)*pieceSize));
  await fs.writeFile(path.join(c.dir,name),data);
  if(!faststart)for(let i=have;i<count;i++)c.state.pieces[i]=0;
  await c.api('/api/prepare',{hash:HASH,index:0});
  if(!faststart){
    const waiting=await until(async()=>{const p=await c.api(`/api/playback?hash=${HASH}&index=0`);return p.stage==='index'&&p;},{timeout:4000,description:'specific trailing video index buffering message'});
    assert.match(waiting.message,/video index/);
    for(let i=Math.floor(moov.start/pieceSize);i<=Math.floor((moov.end-1)/pieceSize);i++)c.state.pieces[i]=2;
  }
  const ready=await until(async()=>{const p=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(p.status,'error',JSON.stringify(p));return p.status==='ready'&&p;},{timeout:18000,interval:200,description:`partial MP4 ${faststart?'faststart':'trailing index'} to become playable`});
  assert.equal(ready.mode,mp3?'hls':'direct');assert.ok(ready.duration>70);assert.ok(c.state.pieces.includes(0));
  if(mp3){
    const manifest=await (await c.request(ready.url)).text();
    assert.match(manifest,/#EXTINF:/);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);
    return;
  }
  // Browser compatibility fallback must also publish segments before download completes.
  await c.api('/api/prepare',{hash:HASH,index:0,forceTranscode:true});
  const hls=await until(async()=>{const p=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(p.status,'error',JSON.stringify(p));return p.status==='ready'&&p.mode==='hls'&&p;},{timeout:18000,interval:200,description:'partial MP4 HLS fallback'});
  const manifest=await (await c.request(hls.url)).text();assert.match(manifest,/#EXTINF:/);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);
});

test('stream sends the first verified piece without waiting for a larger HTTP chunk',async t=>{
  const c=await cinema(t),size=6,name='small.mp4';await fs.writeFile(path.join(c.dir,name),'abcdef');
  c.state.torrents=[torrent(c.dir,{name,progress:1/3,size,total_size:size})];
  c.state.files.set(HASH,[{index:0,name,size,progress:1/3,priority:1,piece_range:[0,2]}]);
  c.state.properties={piece_size:2};c.state.pieces=[2,0,0];
  const response=await c.request(`/stream?hash=${HASH}&index=0`,undefined,{signal:AbortSignal.timeout(5000)}),reader=response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'ab');
  c.state.pieces=[2,2,2];let remainder='';for(;;){const chunk=await reader.read();if(chunk.done)break;remainder+=Buffer.from(chunk.value).toString();}
  assert.equal(remainder,'cdef');
});

test('selected episode owns sequential download then restores sibling priorities, including crash recovery',async t=>{
  const c=await cinema(t),size=1024*1024;
  c.state.torrents=[torrent(c.dir,{progress:.1,seq_dl:false,f_l_piece_prio:false})];
  c.state.files.set(HASH,[0,1,2,3].map(index=>({index,name:`Episode ${index+1}.mkv`,size,progress:0,piece_range:[index,index],priority:index===2?0:1})));
  c.state.pieces=[0,0,0,0];c.state.properties={piece_size:size};
  c.state.handlers['torrents/filePrio']=({params,send})=>{for(const id of params.get('id').split('|'))c.state.files.get(HASH).find(f=>f.index===Number(id)).priority=Number(params.get('priority'));send('');};
  c.state.handlers['torrents/toggleSequentialDownload']=({send})=>{c.state.torrents[0].seq_dl=!c.state.torrents[0].seq_dl;send('');};
  c.state.handlers['torrents/toggleFirstLastPiecePrio']=({send})=>{c.state.torrents[0].f_l_piece_prio=!c.state.torrents[0].f_l_piece_prio;send('');};
  await Promise.all([c.api('/api/prepare',{hash:HASH,index:1}),c.api('/api/prepare',{hash:HASH,index:1})]);
  assert.deepEqual(c.state.files.get(HASH).map(f=>f.priority),[0,6,0,0]);
  assert.equal(c.state.torrents[0].seq_dl,true);assert.equal(c.state.torrents[0].f_l_piece_prio,true);
  const status=await c.api(`/api/playback?hash=${HASH}&index=1`);assert.equal(status.deferredFiles,2);assert.match(status.priorityNote,/other files/i);
  // Respect a user priority change after focus was applied.
  c.state.files.get(HASH)[3].priority=6;
  await c.restart();
  await until(()=>c.state.files.get(HASH)[0].priority===1&&c.state.files.get(HASH)[1].priority===1&&c.state.files.get(HASH)[3].priority===6&&c.state.torrents[0].seq_dl===false&&c.state.torrents[0].f_l_piece_prio===false);
  assert.deepEqual(c.state.files.get(HASH).map(f=>f.priority),[1,1,0,6]);assert.equal(c.state.torrents[0].seq_dl,false);
  await c.api('/api/prepare',{hash:HASH,index:1});c.state.files.get(HASH)[1].progress=1;
  await until(()=>c.state.files.get(HASH)[0].priority===1&&c.state.files.get(HASH)[1].priority===1&&c.state.files.get(HASH)[3].priority===6,{timeout:5000,description:'restore original files after selected file finishes'});
  assert.deepEqual(c.state.files.get(HASH).map(f=>f.priority),[1,1,0,6]);
});

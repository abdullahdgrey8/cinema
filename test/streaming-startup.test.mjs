import {setupSparseMkv} from './startup-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {cinema,HASH,torrent,until} from './helpers.mjs';

test('long H264 MKV starts with less than one percent present and unavailable trailing SeekHead metadata',async t=>{
  const c=await cinema(t),{have,size,progress}=await setupSparseMkv(c);
  const blocked=spawn(ffprobe.path,['-v','error','-analyzeduration','1500000','-probesize','1500000','-show_streams','-show_format','-of','json',`${c.base}/stream?hash=${HASH}&index=0`],{windowsHide:true,stdio:'ignore'});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;blocked.kill();},2500);await once(blocked,'close');clearTimeout(timer);
  assert.equal(timedOut,true,'The previous seekable inspector blocks on unavailable tail metadata');
  const started=Date.now();await c.api('/api/prepare',{hash:HASH,index:0});
  const ready=await until(async()=>{const p=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(p.status,'error',JSON.stringify(p));return p.status==='ready'&&p;},{timeout:12000,interval:200,description:'H264 partial MKV to start without its tail tags'});
  const manifest=await (await c.request(ready.url)).text();assert.match(manifest,/#EXTINF:/);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);assert.ok(ready.duration>1700);assert.ok(ready.progress<.01);assert.equal(ready.complete,false);
  t.diagnostic(JSON.stringify({startupMs:Date.now()-started,downloadedPercent:progress*100,availableBytes:have,totalBytes:size,playlistSegments:(manifest.match(/#EXTINF:/g)||[]).length}));
});

test('partial AVI/Xvid with unavailable idx1 starts without scanning to the end',async t=>{
  const c=await cinema(t),name='partial-xvid.avi',file=path.join(c.dir,name);
  const encoded=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=180','-f','lavfi','-i','sine=frequency=440:duration=180','-c:v','mpeg4','-vtag','XVID','-g','100','-q:v','3','-c:a','libmp3lame','-b:a','128k','-shortest',file],{windowsHide:true,stdio:'ignore'});assert.equal((await once(encoded,'close'))[0],0);
  const original=await fs.readFile(file),size=original.length,pieceSize=65536,have=Math.min(2*1024*1024,Math.floor(size*.15/pieceSize)*pieceSize),progress=have/size;
  assert.ok(original.lastIndexOf(Buffer.from('idx1'))>have);assert.ok(progress<.2);
  const output=await fs.open(file,'w');await output.truncate(size);await output.write(original.subarray(0,have));await output.close();
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress,dlspeed:1_000_000})];c.state.files.set(HASH,[{index:0,name,size,progress,piece_range:[0,Math.ceil(size/pieceSize)-1],priority:1}]);c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:Math.ceil(size/pieceSize)},(_,i)=>i<have/pieceSize?2:0);
  const started=Date.now();await c.api('/api/prepare',{hash:HASH,index:0});let last;
  const ready=await until(async()=>{last=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(last.status,'error',JSON.stringify(last));return last.status==='ready'&&last;},{timeout:10000,interval:200,description:'partial AVI to produce browser video without its trailing index'}).catch(e=>{t.diagnostic(JSON.stringify(last));throw e;});
  const manifest=await (await c.request(ready.url)).text();assert.match(manifest,/#EXTINF:/);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);assert.equal(ready.complete,false);
  t.diagnostic(JSON.stringify({format:'AVI/Xvid',startupMs:Date.now()-started,downloadedPercent:progress*100,availableBytes:have,totalBytes:size}));
});

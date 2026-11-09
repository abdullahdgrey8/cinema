import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {cinema,HASH,torrent,until} from './helpers.mjs';
import {openingCopyEvidence,sameOpeningCopyEvidence} from '../torrent-media.mjs';

test('early copy recovery requires the same converter, verified wait, and fresh manifest',()=>{
  const child={},wait={},run='123456789abc';
  const session={child,run,index:0,item:{f:{progress:.1}},copyVideo:true,segments:0,
    generatedDuration:10,publishedDuration:0,playlist:null};
  const reader={internal:true,index:0,converterChild:child,converterRun:run,waiting:wait,copyWait:wait};
  const first=openingCopyEvidence(session,[reader],null);
  assert.ok(first,'Confirmed ENOENT before any publication can be the opening evidence');
  assert.ok(sameOpeningCopyEvidence(first,openingCopyEvidence(session,[reader],null)));
  assert.equal(openingCopyEvidence(session,[reader],undefined),null,'An unreadable manifest is unknown');
  assert.equal(openingCopyEvidence(session,[reader],'corrupt'),null);
  for(const invalid of [
    {...reader,internal:false},
    {...reader,converterRun:'retiring'},
    {...reader,converterChild:{}},
    {...reader,copyWait:null},
    {...reader,waiting:{}},
    {...reader,index:1},
  ])assert.equal(openingCopyEvidence(session,[invalid],null),null);
  assert.equal(openingCopyEvidence(session,[reader,{...reader}],null),null,'Parallel readers are ambiguous');
  assert.equal(sameOpeningCopyEvidence(first,openingCopyEvidence(session,[{...reader}],null)),false);
  const nextWait={};
  assert.equal(sameOpeningCopyEvidence(first,openingCopyEvidence(session,[{...reader,waiting:nextWait,copyWait:nextWait}],null)),false);
  const oneSegment='#EXTM3U\n#EXTINF:4.0,\nseg000000.ts\n';
  const published={...session,playlist:oneSegment,segments:1,publishedDuration:4};
  const after=openingCopyEvidence(published,[reader],oneSegment);
  assert.ok(after);
  assert.equal(sameOpeningCopyEvidence(first,after),false,'New publication must start a fresh confirmation');
  assert.equal(openingCopyEvidence(published,[reader],null),null,'A missing previously published playlist is unknown');
  assert.equal(openingCopyEvidence(published,[reader],oneSegment+'#EXT-X-ENDLIST\n'),null);
  assert.equal(openingCopyEvidence({...published,generatedDuration:9.99},[reader],oneSegment),null);
  assert.equal(openingCopyEvidence({...published,segments:2},[reader],oneSegment),null);
  assert.equal(openingCopyEvidence({...published,item:{f:{progress:1}}},[reader],oneSegment),null);
});

for(const firstSegment of [false,true])test(`sparse-keyframe H264 begins HLS with fifteen seconds downloaded and ${firstSegment?'one':'no'} early complete segment`,async t=>{
  const c=await cinema(t),name='long-keyframe-interval.mkv',filename=path.join(c.dir,name);
  const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=120','-f','lavfi','-i','sine=frequency=440:duration=120','-c:v','libx264','-preset','ultrafast','-b:v','1M','-g','900','-keyint_min','900','-sc_threshold','0',...(firstSegment?['-force_key_frames','4']:[]),'-c:a','aac','-shortest',filename],{windowsHide:true,stdio:'ignore'});assert.equal((await once(encoder,'close'))[0],0);
  const probe=spawn(ffprobe.path,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,pos,size,flags','-of','json',filename],{windowsHide:true,stdio:['ignore','pipe','ignore']});let output='';probe.stdout.on('data',data=>output+=data);assert.equal((await once(probe,'close'))[0],0);const packets=JSON.parse(output).packets,keyframes=packets.filter(packet=>packet.flags.includes('K')).map(packet=>Number(packet.pts_time));assert.ok(keyframes[firstSegment?2:1]>30,'This fixture must lack the next keyframe needed to publish two segments');if(firstSegment)assert.ok(keyframes[1]>=4&&keyframes[1]<5,'The first four-second segment can complete before the long keyframe gap');
  const original=await fs.readFile(filename),size=original.length,pieceSize=65536,count=Math.ceil(size/pieceSize),openingEnd=Math.max(...packets.filter(packet=>Number(packet.pts_time)<=15).map(packet=>Number(packet.pos)+Number(packet.size))),have=Math.ceil(openingEnd/pieceSize),downloaded=have/count;
  assert.ok(downloaded<.2,'Most of the movie, including its second keyframe, remains unavailable');const partial=Buffer.alloc(size);original.copy(partial,0,0,have*pieceSize);await fs.writeFile(filename,partial);
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress:downloaded,state:'downloading',dlspeed:500000})];c.state.files.set(HASH,[{index:0,name,size,progress:downloaded,piece_range:[0,count-1],priority:1}]);c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,index)=>index<have?2:0);
  await c.api('/api/prepare',{hash:HASH,index:0});let last;
  const ready=await until(async()=>{last=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(last.status,'error',JSON.stringify(last));return last.status==='ready'&&last;},{timeout:15000,interval:150,description:'HLS to publish independently decodable segments without waiting for the second source keyframe'}).catch(error=>{t.diagnostic(JSON.stringify(last));throw error;});
  assert.equal(ready.mode,'hls');assert.equal(ready.startup.copyFallback,'verified-piece-wait');assert.ok(c.state.pieces.includes(0));const manifest=await(await c.request(ready.url)).text();assert.ok((manifest.match(/#EXTINF:/g)||[]).length>=2);assert.doesNotMatch(manifest,/#EXT-X-ENDLIST/);const published=[...manifest.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum,match)=>sum+Number(match[1]),0);assert.ok(ready.availableDuration<=published+.05,'The seekable timeline must not include encoder output from unfinished segments');assert.ok(ready.availableDuration<30);
  assert.deepEqual(c.state.requests.filter(({endpoint,method})=>method==='POST'&&endpoint.startsWith('torrents/')).map(({endpoint})=>endpoint),['torrents/start']);
  assert.equal((await fs.readdir(path.join(c.dir,'hls',HASH+'-0'))).length,2,'The copy run is replaced only once');
});

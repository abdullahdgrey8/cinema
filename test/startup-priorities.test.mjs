import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent,until} from './helpers.mjs';

// qBittorrent 5.2.4, TorrentImpl::applyFirstLastPiecePriority:
// edges get Maximum(7), middle pieces inherit the file priority. Sequential
// mode resolves equal priorities in index order. Deliberately model that public
// behavior, rather than handing the decoder a downloaded tail unconditionally.
// https://github.com/qbittorrent/qBittorrent/blob/release-5.2.4/src/base/bittorrent/torrentimpl.cpp
function nextPiece(state,size,pieceSize,firstLast){
  const file=state.files.get(HASH)[0],count=state.pieces.length,edge=Math.ceil(size*.01/pieceSize);
  return state.pieces.map((have,index)=>({index,priority:have===2||!file.priority?-1:firstLast&&(index<edge||index>=count-edge)?7:file.priority})).filter(piece=>piece.priority>=0).sort((a,b)=>b.priority-a.priority||a.index-b.index)[0]?.index;
}

test('playback recovers a real trailing MP4 index after libtorrent resets edge priorities',async t=>{
  const c=await cinema(t),name='trailing-index.mp4',filename=path.join(c.dir,name);
  const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=120','-f','lavfi','-i','sine=frequency=440:duration=120','-c:v','libx264','-preset','ultrafast','-g','100','-b:v','1M','-c:a','aac','-shortest',filename],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(encoder,'close'))[0],0);
  const original=await fs.readFile(filename),size=original.length,pieceSize=65536,count=Math.ceil(size/pieceSize),opening=16;
  assert.ok(count>100,'Fixture must be substantially larger than its initial playback buffer');
  let offset=0,moov;
  while(offset+8<=size){const length=original.readUInt32BE(offset),type=original.toString('ascii',offset+4,offset+8);if(type==='moov'){moov={start:offset,end:offset+length};break;}assert.ok(length>=8);offset+=length;}
  assert.ok(moov&&moov.start>size*.95,'Fixture must have a genuine movie index near EOF');
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress:opening/count,state:'downloading',seq_dl:false,f_l_piece_prio:false,dlspeed:1000000})];
  c.state.files.set(HASH,[{index:0,name,size,progress:opening/count,piece_range:[0,count-1],priority:7}]);c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,index)=>index<opening?2:0);
  const disk=Buffer.alloc(size);original.copy(disk,0,0,opening*pieceSize);await fs.writeFile(filename,disk);
  let edgePriorities=false, filePrioritiesSettled=false;
  c.state.handlers['torrents/filePrio']=({params,send})=>{
    c.state.files.get(HASH)[0].priority=Number(params.get('priority'));send('');
    // libtorrent 1.2.20 recomputes piece priorities again when the disk job returns.
    setTimeout(()=>{edgePriorities=false;filePrioritiesSettled=true;},200);
  };
  c.state.handlers['torrents/toggleSequentialDownload']=({send})=>{c.state.torrents[0].seq_dl=!c.state.torrents[0].seq_dl;send('');};
  c.state.handlers['torrents/toggleFirstLastPiecePrio']=({send})=>{edgePriorities=c.state.torrents[0].f_l_piece_prio=!c.state.torrents[0].f_l_piece_prio;send('');};
  await c.api('/api/prepare',{hash:HASH,index:0});
  await until(()=>filePrioritiesSettled);
  assert.equal(c.state.torrents[0].f_l_piece_prio,true,'qBittorrent still reports the option enabled');
  assert.equal(nextPiece(c.state,size,pieceSize,edgePriorities),opening,'the file priority callback reset effective edge priority');
  await until(()=>edgePriorities,{timeout:7000,description:'the playback scheduler to refresh the missing MP4 index priority'});
  const transferred=[],budget=Math.ceil(size*.01/pieceSize)+6,handle=await fs.open(filename,'r+');
  try{for(let n=0;n<budget;n++){const index=nextPiece(c.state,size,pieceSize,edgePriorities);if(index===undefined)break;const start=index*pieceSize,end=Math.min(size,start+pieceSize);await handle.write(original.subarray(start,end),0,end-start,start);c.state.pieces[index]=2;transferred.push(index);}}finally{await handle.close();}
  const ready=await until(async()=>{const result=await c.api(`/api/playback?hash=${HASH}&index=0`);assert.notEqual(result.status,'error',JSON.stringify(result));return result.status==='ready'&&result;},{timeout:10000,interval:100,description:'real tail-index MP4 to start within a small priority-controlled transfer budget'});
  assert.equal(ready.mode,'direct');assert.ok(ready.duration>110);assert.ok(transferred.some(index=>index>=Math.floor(moov.start/pieceSize)),'The piece scheduler—not the fixture—must fetch the missing movie index');assert.ok(c.state.pieces.filter(value=>value===2).length<count*.2,'At least 80% of media pieces remain unavailable');assert.equal(c.state.torrents[0].progress,opening/count);
});

test('restart restores an originally enabled edge priority after an interrupted refresh',async t=>{
  const c=await cinema(t), journal=path.join(c.dir,'stream-priorities.json');
  c.state.torrents=[torrent(c.dir,{progress:.2, state:'downloading', f_l_piece_prio:false})];
  c.state.files.set(HASH,[{index:0,name:'Film.mp4',size:100,progress:.2,priority:1}]);
  c.state.handlers['torrents/toggleFirstLastPiecePrio']=({params,send})=>{
    assert.equal(params.get('hashes'),HASH);
    c.state.torrents[0].f_l_piece_prio=!c.state.torrents[0].f_l_piece_prio;
    send('');
  };
  await fs.writeFile(journal,JSON.stringify([{hash:HASH,index:0,seq:true,firstLast:true,edgeRefreshPending:true,files:[{index:0,priority:1,applied:1}]}]));
  await c.restart();
  await until(async()=>JSON.parse(await fs.readFile(journal,'utf8')).length===0,{description:'priority recovery to clear its journal'});
  assert.equal(c.state.torrents[0].f_l_piece_prio,true);
  assert.equal(c.state.torrents[0].seq_dl,true);
  assert.equal(c.state.files.get(HASH)[0].priority,1);
});

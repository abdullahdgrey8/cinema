import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createMedia} from '../torrent-media.mjs';
import {until} from './helpers.mjs';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40), D='d'.repeat(40);
const pieceSize=65536, previewLength=10*pieceSize;
const fastStart={purpose:'fast-start'};

async function makeVideo(filename,width) {
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i',
    'testsrc2=s='+width+'x180:r=24:d=18','-c:v','libx264','-preset','ultrafast',
    '-g','48','-b:v','1200k','-threads','2','-pix_fmt','yuv420p','-movflags','+faststart',filename],
    {windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
  return fs.readFile(filename);
}

test('Fast Start waits without probing, offers a bounded verified MP4, and adopts only the exact winner',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-fast-start-'));
  const files=new Map(), states=new Map(), requests=[], reads=[];
  let media,origin,clock=Date.now(),block=null;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,origin);
    reads.push({hash:url.searchParams.get('hash'),internal:url.searchParams.has('internal')});
    try{await media.stream(req,res,url);}
    catch(e){if(res.headersSent)res.destroy();else res.writeHead(e.status||500).end();}
  });
  t.after(async()=>{
    await media?.shutdown();
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const addFile=async(hash,name,data,verified)=>{
    assert.ok(data.length>previewLength);
    const disk=Buffer.alloc(data.length,0x7f),filename=path.join(dir,name);
    data.copy(disk,0,0,verified*pieceSize);
    await fs.writeFile(filename,disk);
    const count=Math.ceil(data.length/pieceSize);
    states.set(hash,Array.from({length:count},(_,i)=>i<verified?2:0));
    files.set(hash,{index:0,name,size:data.length,progress:Math.min(1,verified/count),priority:1});
    return filename;
  };
  const primary=await makeVideo(path.join(dir,'original.mp4'),320);
  const alternate=await makeVideo(path.join(dir,'alternate.mp4'),416);
  const primaryPath=await addFile(A,'Primary.mp4',primary,0);
  const alternatePath=await addFile(B,'Alternate.mp4',alternate,0);
  await addFile(C,'Another.m4v',alternate,Math.ceil(alternate.length/pieceSize));
  const outside=Buffer.alloc(7*1024*1024);
  outside.writeUInt32BE(outside.length-8,0);outside.write('mdat',4);
  outside.writeUInt32BE(8,outside.length-8);outside.write('moov',outside.length-4);
  await addFile(D,'Tail index.mp4',outside,Math.ceil(outside.length/pieceSize));

  const feedOpening=async(hash,filename,data)=>{
    const handle=await fs.open(filename,'r+');
    try{await handle.write(data,0,previewLength,0);}finally{await handle.close();}
    states.get(hash).fill(2,0,10);
    files.get(hash).progress=10/states.get(hash).length;
  };
  const qb=async(endpoint,params={},method='GET')=>{
    const hash=params.hashes||params.hash, file=files.get(hash);
    requests.push({endpoint,hash,method});
    if(endpoint==='torrents/info'){
      if(block?.hash===hash){
        const pending=block;block=null;pending.entered();
        await pending.release;
      }
      return file?[{hash,name:file.name,save_path:dir,state:file.progress===1?'uploading':'downloading',
        size:file.size,progress:file.progress,seq_dl:true,f_l_piece_prio:true}]:[];
    }
    if(endpoint==='torrents/files')return file?[structuredClone(file)]:[];
    if(endpoint==='torrents/properties')return {piece_size:pieceSize};
    if(endpoint==='torrents/pieceStates')return [...states.get(hash)];
    return {};
  };
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin='http://127.0.0.1:'+server.address().port;
  media=createMedia({qb,local:dir,origin,internalToken:'fast-start-test',pieceWaitMs:120,now:()=>clock});
  const prepared=await media.prepare(A,0);
  assert.equal(prepared.status,'buffering');
  const writes=()=>requests.filter(request=>request.method==='POST');
  const baselineWrites=writes().length;
  assert.ok(baselineWrites>0,'Ordinary primary prepare may manage its download');
  const to=hash=>{const {name,size}=files.get(hash);return {hash,index:0,name,size};};
  const from={...to(A),sessionId:prepared.sessionId};
  const check=(target,source=from)=>media.rescueCheck(source,target,fastStart);
  const inspectCount=hash=>reads.filter(read=>read.hash===hash&&read.internal).length;

  const beforeSame=requests.length;
  await assert.rejects(check(to(A)),{status:409});
  await assert.rejects(check({...to(B),name:'Alternate.mkv'}),{status:422});
  assert.equal(requests.length,beforeSame);
  await assert.rejects(check(to(D)),{status:422,message:/outside the Fast Start preview/});
  assert.equal(inspectCount(D),0);
  const waiting=await check(to(B));
  assert.deepEqual(Object.keys(waiting).sort(),['message','waiting']);
  assert.equal(waiting.waiting,true);
  assert.equal(inspectCount(B),0);

  await feedOpening(B,alternatePath,alternate);
  const offer=await until(async()=>{
    const result=await check(to(B));
    return result.waiting?false:result;
  },{description:'verified alternate opening and guarded FFprobe'});
  assert.equal(offer.expiresAt,clock+16000);
  assert.equal(offer.previewBytes,previewLength);
  assert.equal(offer.attachment.state.mode,'direct');
  assert.equal(offer.attachment.state.probeFacts.width,416);
  assert.equal((await media.playback(B,0)).status,'idle');
  assert.ok(inspectCount(B)>0,'The extra FFprobe read from the guarded stream');
  await assert.rejects(check(to(C)),{status:429});
  const url=origin+offer.attachment.state.url;
  const prefix=await fetch(url,{headers:{range:'bytes=0-'+(previewLength-1)}});
  assert.equal(prefix.status,206);
  assert.equal(prefix.headers.get('content-range'),'bytes 0-'+(previewLength-1)+'/'+alternate.length);
  assert.deepEqual(Buffer.from(await prefix.arrayBuffer()),alternate.subarray(0,previewLength));
  const unverified=await fetch(url,{headers:{range:'bytes='+previewLength+'-'+(previewLength+9)}});
  assert.equal(unverified.status,504);
  await unverified.arrayBuffer();

  await feedOpening(A,primaryPath,primary);
  const ready=await until(async()=>{
    const state=await media.playback(A,0);
    assert.notEqual(state.status,'error',JSON.stringify(state));
    return state.status==='ready'&&state;
  },{description:'the original publishes its URL in the same session'});
  assert.equal(ready.sessionId,from.sessionId);
  assert.equal(ready.probeFacts.width,320);

  const committed=await media.rescueCommit(offer.ticket);
  assert.equal(committed.attachment.state.sessionId,offer.attachment.state.sessionId);
  assert.equal((await media.playback(A,0)).url,ready.url);
  assert.deepEqual(media.rescueCancel(offer.ticket),{ok:true});
  assert.equal((await media.playback(B,0)).status,'idle','A late cancel removes only the unused provisional session');

  const withUrl={...from,url:ready.url};
  const revocable=await check(to(B),withUrl);
  states.get(B)[9]=0;
  await assert.rejects(media.rescueCommit(revocable.ticket),{status:409,message:/verified preview changed/i});
  states.get(B)[9]=2;
  const adoption=await check(to(B),withUrl);
  const accepted=await media.rescueCommit(adoption.ticket);
  const stream=await fetch(origin+accepted.attachment.state.url,{headers:{range:'bytes=0-31'}});
  assert.equal(stream.status,206);
  assert.deepEqual(Buffer.from(await stream.arrayBuffer()),alternate.subarray(0,32));
  media.rescueCancel(adoption.ticket);
  const observed=await media.playback(B,0);
  assert.equal(observed.sessionId,accepted.attachment.state.sessionId);

  const earlierProbes=inspectCount(B);
  const reused=await check(to(B),withUrl);
  assert.equal(inspectCount(B),earlierProbes,'An exact ready direct session needs no second inspector');
  const existing=await media.rescueCommit(reused.ticket);
  media.rescueCancel(reused.ticket);
  assert.equal(existing.attachment.state.sessionId,observed.sessionId);
  assert.equal((await media.playback(B,0)).sessionId,observed.sessionId);

  const stale=await check(to(C),withUrl);
  let entered,release;
  const waitingCommit=new Promise(resolve=>{entered=resolve;});
  const releaseCommit=new Promise(resolve=>{release=resolve;});
  block={hash:C,entered,release:releaseCommit};
  const oldCommit=assert.rejects(media.rescueCommit(stale.ticket),{status:409});
  await waitingCommit;
  await media.prepare(A,0);
  release();
  await oldCommit;
  assert.equal((await media.playback(C,0)).status,'idle');
  assert.equal((await media.playback(A,0)).sessionId,from.sessionId);
  assert.equal(writes().length,baselineWrites,'Fast Start never writes to qBittorrent');

  const lost=await check(to(C),withUrl);
  assert.ok(lost.previewBytes<=6*1024*1024);
  clock=lost.expiresAt-1;
  await media.rescueCommit(lost.ticket);
  clock=lost.expiresAt+1;
  await assert.rejects(check(to(C),withUrl),{status:429},'A just-in-time commit still has time for the visible player');
  clock+=5000;
  // With no native attachment or exact read, the scheduler retires the offer.
  await new Promise(resolve=>setTimeout(resolve,850));
  assert.equal((await media.playback(C,0)).status,'idle');
  assert.equal((await media.playback(A,0)).url,ready.url);
  assert.equal(writes().length,baselineWrites);
});


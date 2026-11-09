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
import {until,wait} from './helpers.mjs';

const A='a'.repeat(40), B='b'.repeat(40), C='c'.repeat(40);
const pieceSize=65536;

async function encode(file,options) {
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi',
    '-i','testsrc2=s=160x90:r=25:d=42','-f','lavfi','-i','sine=frequency=440:duration=42',
    ...options,'-shortest',file],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
}

test('warm return reuses the verified run, checks both files, and retires only a detached lease',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-warm-'));
  const partial=path.join(dir,'Partial.mkv'), direct=path.join(dir,'Ready.mp4'), completed=path.join(dir,'Complete.mkv');
  let media, origin;
  const streamReads=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,origin);
    try{
      if(url.pathname==='/stream'){streamReads.push(url.searchParams.get('hash'));await media.stream(req,res,url);}
      else await media.serveHls(req,res,url);
    }catch(e){if(res.headersSent)res.destroy();else res.writeHead(e.status||500).end();}
  });
  t.after(async()=>{
    await media?.shutdown();
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  await encode(completed,['-c:v','ffv1','-c:a','pcm_s16le','-threads','2']);
  await encode(direct,['-c:v','libx264','-c:a','aac','-threads','2','-movflags','+faststart']);
  const video=await fs.readFile(completed), size=video.length, count=Math.ceil(size/pieceSize);
  const readyPieces=Math.ceil(count*.36), startSize=readyPieces*pieceSize;
  const partialData=Buffer.alloc(size);video.copy(partialData,0,0,startSize);
  await fs.writeFile(partial,partialData);
  const files=new Map([[A,{index:0,name:'Partial.mkv',size,progress:.36,priority:1}],
    [B,{index:0,name:'Ready.mp4',size:(await fs.stat(direct)).size,progress:1,priority:1}],
    [C,{index:0,name:'Complete.mkv',size,progress:1,priority:1}]]);
  const states=new Map([[A,Array.from({length:count},(_,i)=>i<readyPieces?2:0)]]);
  const reads=[],mutations=[];
  let delayedHash=null, unblock, waitForBlocked;
  let clock=Date.now();
  const qb=async(endpoint,params={},method='GET')=>{
    const hash=params.hashes||params.hash;
    if(method==='POST'){mutations.push([endpoint,hash]);return '';}
    reads.push([endpoint,hash]);
    if(endpoint==='torrents/info'){
      if(delayedHash===hash&&waitForBlocked){
        const report=waitForBlocked;waitForBlocked=null;
        await new Promise(resolve=>{unblock=resolve;report();});
      }
      const file=files.get(hash);
      return file?[{hash,name:file.name,save_path:dir,state:file.progress===1?'uploading':'downloading',
        size:file.size,progress:file.progress,seq_dl:true,f_l_piece_prio:true}]:[];
    }
    if(endpoint==='torrents/files')return files.has(hash)?[structuredClone(files.get(hash))]:[];
    if(endpoint==='torrents/properties')return {piece_size:pieceSize};
    if(endpoint==='torrents/pieceStates')return states.get(hash)||[];
    return {};
  };
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin='http://127.0.0.1:'+server.address().port;
  media=createMedia({qb,local:dir,origin,internalToken:'warm-test',now:()=>clock});
  async function prepare(hash,complete=false){
    const selected=await media.prepare(hash,0);
    const ready=await until(async()=>{
      const value=await media.playback(hash,0);
      assert.notEqual(value.status,'error',JSON.stringify(value));
      return value.status==='ready'&&(!complete||value.complete)&&value;
    },{timeout:18000,description:'ready playback for '+hash[0]});
    assert.equal(ready.sessionId,selected.sessionId);
    return ready;
  }
  const c=await prepare(C,true), b=await prepare(B), a=await prepare(A);
  const identity=state=>({hash:state.hash,index:state.index,sessionId:state.sessionId});
  const source=identity(a), fallback=identity(b), cached=identity(c);
  assert.equal(b.mode,'direct');assert.equal(a.mode,'hls');assert.equal(c.mode,'hls');
  assert.equal(a.complete,false);
  const initialMutations=mutations.length;
  const readCount=reads.length;
  await assert.rejects(media.warmSwitch(source,{...source,index:1}),{status:409});
  assert.equal(reads.length,readCount,'Same-torrent rejection runs before qBittorrent reads');
  await assert.rejects(media.warmSwitch({...source,sessionId:'0'.repeat(32)},fallback),{status:409});
  assert.deepEqual((await media.warmOptions(A,0,a.sessionId)).options.map(option=>option.mode).sort(),['direct','hls']);
  delayedHash=B;
  const blocked=new Promise(resolve=>{waitForBlocked=resolve;});
  const rejected=assert.rejects(media.warmSwitch(source,fallback),{status:409});
  await blocked;
  try{await media.prepare(A,0);}finally{unblock();}
  await rejected;
  delayedHash=null;
  const fallbackReads=streamReads.filter(hash=>hash===B).length;
  const switched=await media.warmSwitch(source,fallback);
  assert.equal(switched.attachment.state.url,b.url);
  assert.equal(switched.attachment.file.name,'Ready.mp4');
  assert.equal(switched.lease.url,a.url);
  assert.equal(switched.lease.expiresAt,clock+75000);
  assert.equal(switched.lease.phase,'ready');
  assert.equal(streamReads.filter(hash=>hash===B).length,fallbackReads,'The handoff launches no fallback reader or probe');
  const advanced=Math.ceil(count*.66), handle=await fs.open(partial,'r+');
  try{await handle.write(video,startSize,advanced*pieceSize-startSize,startSize);}finally{await handle.close();}
  states.get(A).fill(2,readyPieces,advanced);
  files.get(A).progress=.66;
  await until(()=>media.warmStatus(switched.lease.ticket).lease?.availableDuration>a.availableDuration+4,
    {timeout:15000,description:'the retained HLS run to grow while the fallback is active'});
  const returned=await media.warmReturn(switched.lease.ticket);
  assert.equal(returned.attachment.state.sessionId,a.sessionId);
  assert.equal(returned.attachment.state.url,a.url);
  assert.ok(returned.attachment.state.availableDuration>a.availableDuration);
  assert.equal(media.warmStatus(switched.lease.ticket).lease,null);
  await assert.rejects(media.warmReturn(switched.lease.ticket),{status:409});
  const saved=await media.warmSwitch(source,cached);
  assert.equal(saved.attachment.state.url,c.url);
  clock+=75001;
  await media.playback(A,0);
  await wait(900);
  assert.equal(media.warmStatus(saved.lease.ticket).lease,null);
  assert.equal((await media.playback(A,0)).url,a.url,'An active viewer survives a lost switch response');
  const completeParked=await media.warmSwitch(cached,fallback);
  media.warmDismiss(completeParked.lease.ticket);
  assert.equal((await media.playback(C,0)).sessionId,c.sessionId,'Dismissing a completed run preserves its verified session');
  const cFolder=path.join(dir,path.dirname(c.url));
  const segment=path.join(cFolder,'seg000001.ts');
  await fs.rename(segment,segment+'.missing');
  try{
    await assert.rejects(media.warmSwitch(source,cached),{status:409});
    assert.ok(!(await media.warmOptions(A,0,a.sessionId)).options.some(option=>option.hash===C));
  }finally{await fs.rename(segment+'.missing',segment);}
  const replacement=await fs.open(direct,'r+');
  try{await replacement.write(Buffer.from([0]),0,1,10);}finally{await replacement.close();}
  await assert.rejects(media.warmSwitch(source,fallback),{status:409});
  const detached=await media.warmSwitch(source,cached);
  clock+=75001;
  assert.equal(media.warmStatus(detached.lease.ticket).lease,null);
  await wait(900);
  assert.equal((await media.playback(A,0)).status,'queued','Expired detached preparation retires');
  assert.equal(mutations.length,initialMutations,'Warm operations must not write to qBittorrent');
});

test('missing and stale sessions are rejected without touching qBittorrent',async t=>{
  const invalid=()=>({hash:A,index:0,sessionId:'0'.repeat(32)});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-warm-invalid-'));
  const media=createMedia({qb:async()=>{throw Error('Unexpected qBittorrent request');},local:dir,origin:'http://127.0.0.1:1'});
  t.after(async()=>{
    await media.shutdown();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  await assert.rejects(media.warmOptions(A,0,invalid().sessionId),{status:409});
  await assert.rejects(media.warmSwitch(invalid(),{...invalid(),hash:B}),{status:409});
  await assert.rejects(media.warmReturn('0'.repeat(48)),{status:409});
  assert.deepEqual(media.warmDismiss('0'.repeat(48)),{ok:true});
});


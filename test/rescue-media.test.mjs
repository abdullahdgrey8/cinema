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
const pieceSize=65536;

async function ffmpegRun(args) {
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error',...args],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
}

test('rescue preflights verified bytes and a cached HLS run while the exact original stays attached',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-rescue-'));
  const paths={a:path.join(dir,'Original.mp4'), b:path.join(dir,'Replacement.mp4'),
    c:path.join(dir,'Cached.mkv'), d:path.join(dir,'Unsupported.mkv')};
  const cache=path.join(dir,'hls',C+'-0','012345abcdef');
  let media,origin,clock=Date.now(),reserved=null;
  const requests=[],rawReads=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,origin);
    try{
      if(url.pathname==='/stream'){
        rawReads.push({hash:url.searchParams.get('hash'),internal:url.searchParams.has('internal')});
        await media.stream(req,res,url);
      }else await media.serveHls(req,res,url);
    }catch(e){if(res.headersSent)res.destroy();else res.writeHead(e.status||500).end();}
  });
  t.after(async()=>{
    await media?.shutdown();
    if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  await ffmpegRun(['-f','lavfi','-i','testsrc2=s=320x180:r=24:d=28','-f','lavfi','-i','sine=frequency=320:duration=28',
    '-c:v','libx264','-preset','ultrafast','-g','48','-b:v','1200k','-threads','2','-c:a','aac',
    '-movflags','+faststart','-shortest',paths.a]);
  await ffmpegRun(['-i',paths.a,'-c','copy',paths.c]);
  await fs.copyFile(paths.c,paths.d);
  await fs.mkdir(cache,{recursive:true});
  await ffmpegRun(['-i',paths.a,'-c','copy','-f','hls','-hls_time','2','-hls_list_size','0',
    '-hls_playlist_type','event','-hls_segment_filename',path.join(cache,'seg%06d.ts'),path.join(cache,'index.m3u8')]);
  await fs.writeFile(path.join(cache,'..','completed.json'),JSON.stringify({
    run:'012345abcdef',size:(await fs.stat(paths.c)).size,duration:28
  }));
  const data=await fs.readFile(paths.a), count=Math.ceil(data.length/pieceSize);
  assert.ok(count>=16);
  const initial=10, advanced=Math.min(count-1,15);
  const sparse=Buffer.alloc(data.length,0x7f);
  data.copy(sparse,0,0,initial*pieceSize);
  await fs.writeFile(paths.b,sparse);
  const files=new Map([[A,{index:0,name:'Original.mp4',size:data.length,progress:1,priority:1}],
    [B,{index:0,name:'Replacement.mp4',size:data.length,progress:initial/count,priority:1}],
    [C,{index:0,name:'Cached.mkv',size:(await fs.stat(paths.c)).size,progress:1,priority:1}],
    [D,{index:0,name:'Unsupported.mkv',size:(await fs.stat(paths.d)).size,progress:1,priority:1}]]);
  const pieces=Array.from({length:count},(_,i)=>i<initial?2:0);
  let delayed=null,blocked,release,hideSourceFile=false;
  const qb=async(endpoint,params={},method='GET')=>{
    const hash=params.hashes||params.hash;
    requests.push({endpoint,hash,method});
    if(method==='POST')throw Error('A rescue action must not write to qBittorrent');
    if(endpoint==='torrents/info'){
      if(delayed===hash&&blocked){
        const report=blocked;blocked=null;
        await new Promise(resolve=>{release=resolve;report();});
      }
      const file=files.get(hash);
      return file?[{hash,name:file.name,save_path:dir,state:file.progress===1?'uploading':'downloading',
        size:file.size,progress:file.progress,seq_dl:true,f_l_piece_prio:true}]:[];
    }
    if(endpoint==='torrents/files')return files.has(hash)&&!(hash===A&&hideSourceFile)?[structuredClone(files.get(hash))]:[];
    if(endpoint==='torrents/properties')return {piece_size:pieceSize};
    if(endpoint==='torrents/pieceStates')return hash===B?pieces:[];
    return {};
  };
  server.listen(0,'127.0.0.1');await once(server,'listening');
  origin='http://127.0.0.1:'+server.address().port;
  media=createMedia({qb,local:dir,origin,internalToken:'rescue-test',pieceWaitMs:120,
    now:()=>clock,cacheReserved:folder=>folder===reserved});
  const prepared=await media.prepare(A,0);
  const ready=await until(async()=>{
    const state=await media.playback(A,0);
    assert.notEqual(state.status,'error',JSON.stringify(state));
    return state.status==='ready'&&state;
  },{description:'direct original playback'});
  assert.equal(ready.sessionId,prepared.sessionId);
  const to=hash=>{const {name,size}=files.get(hash);return {hash,index:0,name,size};};
  const from={...to(A),sessionId:ready.sessionId,url:ready.url};
  const beforeSame=requests.length;
  await assert.rejects(media.rescueCheck(from,to(A)),{status:409});
  assert.equal(requests.length,beforeSame);
  await assert.rejects(media.rescueCheck(from,to(D)),{status:422});
  assert.equal(rawReads.filter(read=>read.hash===D).length,0,'Unsupported containers do not start a probe');
  pieces.fill(0);
  await assert.rejects(media.rescueCheck(from,to(B)),{status:409});
  pieces.fill(2,0,initial);
  // Existing availability reads are cached briefly. Wait for the fixture's
  // first verified download update to be observable.
  const partial=await until(async()=>{
    try{return await media.rescueCheck(from,to(B));}
    catch(e){if(e.status===409&&/still downloading/.test(e.message))return false;throw e;}
  },{description:'real FFprobe on a partially downloaded fast-start MP4'});
  assert.equal(partial.attachment.state.mode,'direct');
  assert.ok(partial.attachment.state.progress<1);
  assert.equal(partial.expiresAt,clock+45000);
  assert.equal((await media.playback(B,0)).status,'idle','The candidate is detached until commit');
  assert.equal((await media.playback(A,0)).url,ready.url);
  assert.ok(rawReads.some(read=>read.hash===B&&read.internal),'The probe reads the real guarded stream');
  const preview=await fetch(origin+partial.attachment.state.url,{headers:{range:'bytes=0-1023'}});
  assert.equal(preview.status,206);
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()),data.subarray(0,1024));
  const unknownOffset=initial*pieceSize;
  const withheld=await fetch(origin+partial.attachment.state.url,{headers:{range:'bytes='+unknownOffset+'-'+(unknownOffset+127)}});
  assert.equal(withheld.status,504,'Unverified disk bytes cannot be served by a rescue preview');
  await withheld.arrayBuffer();
  const handle=await fs.open(paths.b,'r+');
  try{await handle.write(data,unknownOffset,(advanced-initial)*pieceSize,unknownOffset);}finally{await handle.close();}
  pieces.fill(2,initial,advanced);files.get(B).progress=advanced/count;
  const committed=await media.rescueCommit(partial.ticket);
  assert.equal(committed.attachment.state.sessionId,partial.attachment.state.sessionId);
  assert.equal(committed.attachment.state.url,partial.attachment.state.url);
  assert.equal((await media.playback(A,0)).url,ready.url);
  await assert.rejects(media.rescueCommit(partial.ticket),{status:409});
  const priorProbes=rawReads.filter(read=>read.hash===B&&read.internal).length;
  const changed=await media.rescueCheck(from,to(B));
  assert.equal(rawReads.filter(read=>read.hash===B&&read.internal).length,priorProbes);
  const originalStamp=await fs.stat(paths.b);
  const replace=await fs.open(paths.b,'r+');
  try{await replace.write(Buffer.from([42]),0,1,42);}finally{await replace.close();}
  await fs.utimes(paths.b,originalStamp.atime,new Date(originalStamp.mtimeMs-2000));
  await assert.rejects(media.rescueCommit(changed.ticket),{status:409});
  const cached=await media.rescueCheck(from,to(C));
  assert.equal(cached.attachment.state.mode,'hls');
  assert.equal(cached.attachment.state.complete,true);
  assert.equal((await media.playback(C,0)).status,'idle');
  assert.ok(media.protectedCacheRuns().has(cache));
  assert.match(await (await fetch(origin+cached.attachment.state.url)).text(),/#EXT-X-ENDLIST/);
  assert.equal(rawReads.filter(read=>read.hash===C).length,0);
  reserved=cache;
  await assert.rejects(media.rescueCommit(cached.ticket),{status:409});
  reserved=null;
  assert.ok(!media.protectedCacheRuns().has(cache));
  const cacheChanged=await media.rescueCheck(from,to(C));
  const segmentPath=path.join(cache,'seg000001.ts'),segmentStamp=await fs.stat(segmentPath);
  const segment=await fs.open(segmentPath,'r+');
  try{await segment.write(Buffer.from([42]),0,1,30);}finally{await segment.close();}
  await fs.utimes(segmentPath,segmentStamp.atime,new Date(segmentStamp.mtimeMs-2000));
  await assert.rejects(media.rescueCommit(cacheChanged.ticket),{status:409});
  const canceled=await media.rescueCheck(from,to(C));
  assert.deepEqual(media.rescueCancel(canceled.ticket),{ok:true});
  await assert.rejects(media.rescueCommit(canceled.ticket),{status:409});
  const expiring=await media.rescueCheck(from,to(C));
  clock+=45001;
  await assert.rejects(media.rescueCommit(expiring.ticket),{status:409});
  const controller=new AbortController();
  delayed=C;
  const blockedRequest=new Promise(resolve=>{blocked=resolve;});
  const aborted=assert.rejects(media.rescueCheck(from,to(C),{signal:controller.signal}),{status:409});
  await blockedRequest;
  await assert.rejects(media.rescueCheck(from,to(B)),{status:429});
  controller.abort();release();
  await aborted;delayed=null;
  const ordinary=await media.rescueCheck(from,to(C));
  await media.prepare(A,0);
  await assert.rejects(media.rescueCommit(ordinary.ticket),{status:409});
  hideSourceFile=true;
  await until(async()=>(await media.playback(A,0)).status==='error',{description:'original in terminal error'});
  hideSourceFile=false;
  const terminal=await media.rescueCheck({...to(A),sessionId:ready.sessionId},to(C));
  assert.equal((await media.playback(A,0)).status,'error','Preflight leaves a terminal original attached');
  assert.equal((await media.rescueCommit(terminal.ticket)).attachment.state.url,terminal.attachment.state.url);
  assert.equal(requests.filter(request=>request.method==='POST').length,0);
});


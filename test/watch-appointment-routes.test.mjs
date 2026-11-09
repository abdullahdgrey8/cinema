import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent,until} from './helpers.mjs';

const BACKUP='b'.repeat(40),CHECK='/api/watch-appointment',OPAQUE=/^[a-f0-9]{64}$/;
const target=(hash,key)=>({hash,...(key?{key}:{})});
const check=(c,targets,options={})=>c.api(CHECK,{targets,allowProbe:false,...options});
const writes=c=>c.state.requests.filter(row=>row.method==='POST'&&row.endpoint.startsWith('torrents/'));
const proof=(epoch,file)=>({epoch,key:file.key,playKey:file.playKey});

async function connected(c){
  await until(async()=>(await c.api('/api/state')).connected,{description:'the isolated qBittorrent connection'});
}
function libraryFile(c,{hash=HASH,name,size=1024*1024,progress=1,state}){
  c.state.torrents.push(torrent(c.dir,{hash,name,size,total_size:size,progress,...(state?{state}:{})}));
  c.state.files.set(hash,[{index:0,name,size,progress,priority:1,piece_range:[0,Math.ceil(size/65536)-1]}]);
}
async function clip(c,name){
  const filename=path.join(c.dir,name);
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=96x64:r=12:d=1',
    '-c:v','libx264','-pix_fmt','yuv420p',filename],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
  return {filename,size:(await fs.stat(filename)).size};
}

test('appointment observes exact file progress and refuses ambiguous or changed targets',async t=>{
  const c=await cinema(t);
  libraryFile(c,{name:'Nested/First Feature.mp4',progress:.25,state:'downloading'});
  libraryFile(c,{hash:BACKUP,name:'Backup.mp4',progress:0,state:'metaDL'});
  await connected(c);
  const first=await check(c,[target(HASH),target(BACKUP)]);
  assert.match(first.epoch,OPAQUE);
  assert.ok(Number.isFinite(first.observedMs)&&first.observedMs>=0);
  const [primary,backup]=first.files;
  assert.match(primary.key,OPAQUE);
  assert.deepEqual(primary,{hash:HASH,key:primary.key,index:0,name:'First Feature.mp4',size:1024*1024,
    downloaded:256*1024,status:'downloading'});
  assert.deepEqual(backup,{hash:BACKUP,status:'finding'});
  c.state.torrents[0].state='stoppedDL';
  const paused=await check(c,[target(HASH,primary.key)],{epoch:first.epoch});
  assert.ok(paused.observedMs>=first.observedMs);
  assert.equal(paused.files[0].status,'paused');
  c.state.files.get(HASH)[0].name='Nested/Renamed.mp4';
  assert.deepEqual((await check(c,[target(HASH,primary.key)],{epoch:first.epoch})).files[0],
    {hash:HASH,key:primary.key,status:'unavailable',reason:'file-changed'});
  c.state.files.get(HASH).push({index:1,name:'Second Episode.mp4',size:1024,progress:0});
  assert.equal((await check(c,[target(HASH)])).files[0].status,'unavailable');
  c.state.torrents.splice(1,1);
  assert.equal((await check(c,[target(BACKUP)])).files[0].reason,'missing');
  const duplicate=await c.request(CHECK,{targets:[target(HASH),target(HASH)],allowProbe:false});
  assert.equal(duplicate.status,400);
  assert.deepEqual(writes(c),[]);
});

test('appointment proves a local direct file and rejects a changed disk stamp before prepare',async t=>{
  const c=await cinema(t),name='Verified Local Feature.mp4',backup='Second Local Feature.mp4';
  const {filename,size}=await clip(c,name);
  await fs.copyFile(filename,path.join(c.dir,backup));
  libraryFile(c,{name,size});
  libraryFile(c,{hash:BACKUP,name:backup,size});
  await connected(c);
  const onDisk=await check(c,[target(HASH)]);
  assert.equal(onDisk.files[0].status,'on-disk');
  assert.equal(onDisk.files[0].playKey,undefined);
  const checked=await check(c,[target(HASH,onDisk.files[0].key)],{epoch:onDisk.epoch,allowProbe:true});
  const verified=checked.files[0];
  assert.equal(verified.status,'ready',JSON.stringify(verified));
  assert.match(verified.playKey,OPAQUE);
  assert.equal(verified.downloaded,size);
  assert.equal(JSON.stringify(checked).includes(c.dir),false);
  assert.deepEqual((await check(c,[target(HASH,verified.key)],{epoch:checked.epoch})).files,[verified]);
  assert.deepEqual(writes(c),[]);

  const stat=await fs.stat(filename);
  await fs.utimes(filename,stat.atime,new Date(stat.mtimeMs+60000));
  const reject=await c.request('/api/prepare',{hash:HASH,index:0,appointment:proof(checked.epoch,verified)});
  assert.equal(reject.status,409);
  assert.equal((await reject.json()).code,'appointment-file-changed');
  assert.equal((await c.api('/api/playback?hash='+HASH+'&index=0')).status,'idle');
  assert.deepEqual(writes(c),[]);

  const next=await check(c,[target(HASH,verified.key)],{epoch:checked.epoch,allowProbe:true});
  assert.equal(next.files[0].status,'ready');
  assert.equal(next.files[0].key,verified.key);
  assert.notEqual(next.files[0].playKey,verified.playKey);
  await c.api('/api/prepare',{hash:HASH,index:0,appointment:proof(next.epoch,next.files[0])});
  const busy=await check(c,[target(BACKUP)],{epoch:next.epoch,allowProbe:true});
  assert.equal(busy.files[0].status,'on-disk');
  assert.equal(busy.files[0].reason,'player-busy');
  assert.equal(busy.files[0].playKey,undefined);
  const ready=await until(async()=>{
    const state=await c.api('/api/playback?hash='+HASH+'&index=0');
    assert.notEqual(state.status,'error',state.message);
    return state.status==='ready'&&state;
  },{description:'ordinary playback of the freshly attested direct file'});
  assert.equal(ready.mode,'direct');
  assert.deepEqual(writes(c),[]);
  await c.restart();
  await connected(c);
  const stale=await c.request(CHECK,{epoch:next.epoch,targets:[target(HASH,verified.key)],allowProbe:false});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,'appointment-connection-changed');
});

test('appointment limits observers globally and releases an aborted request',async t=>{
  const c=await cinema(t);
  libraryFile(c,{name:'Slow File.mp4',progress:.1,state:'downloading'});
  await connected(c);
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  c.state.handlers['torrents/files']=async({send,state,params})=>{
    entered.resolve();
    await release.promise;
    send(state.files.get(params.get('hash'))||[]);
  };
  const controller=new AbortController();
  const pending=c.request(CHECK,{targets:[target(HASH)],allowProbe:false},{signal:controller.signal});
  const aborted=assert.rejects(pending,{name:'AbortError'});
  try{
    await entered.promise;
    const busy=await c.request(CHECK,{targets:[target(HASH)],allowProbe:false});
    assert.equal(busy.status,429);
    assert.equal((await busy.json()).code,'appointment-check-busy');
    controller.abort();
    await aborted;
  }finally{controller.abort();release.resolve();}
  await until(async()=>{
    const next=await c.request(CHECK,{targets:[target(HASH)],allowProbe:false});
    if(next.status===429)return false;
    assert.equal(next.status,200);
    return (await next.json()).files[0].status==='downloading';
  },{description:'the canceled global observer to drain'});
  assert.deepEqual(writes(c),[]);
});

test('appointment withholds Play when the same-size file changes after the local probe',async t=>{
  const c=await cinema(t),name='Changed During Verification.mp4';
  const {filename,size}=await clip(c,name);
  libraryFile(c,{name,size});
  await connected(c);
  let snapshots=0;
  c.state.handlers['torrents/files']=async({send,state,params})=>{
    if(++snapshots===2){
      const stat=await fs.stat(filename);
      await fs.utimes(filename,stat.atime,new Date(stat.mtimeMs+60000));
    }
    send(state.files.get(params.get('hash'))||[]);
  };
  const result=await check(c,[target(HASH)],{allowProbe:true});
  assert.equal(snapshots,2,'The exact qBittorrent file was checked again after FFprobe exited');
  assert.equal(result.files[0].status,'unavailable');
  assert.equal(result.files[0].reason,'file-changed');
  assert.equal(result.files[0].playKey,undefined);
  assert.equal((await fs.stat(filename)).size,size);
  assert.deepEqual(writes(c),[]);
});

test('removing a target during its final verification leaves the backup observation usable',async t=>{
  const c=await cinema(t),name='Remove During Verification.mp4';
  const {size}=await clip(c,name);
  libraryFile(c,{name,size});
  libraryFile(c,{hash:BACKUP,name:'Still Downloading.mp4',progress:.3,state:'downloading'});
  await connected(c);
  const release=Promise.withResolvers();
  let snapshots=0,waiting=false;
  c.state.handlers['torrents/files']=async({send,state,params})=>{
    const hash=params.get('hash');
    if(hash===HASH&&++snapshots===2){waiting=true;await release.promise;}
    send(state.files.get(hash)||[]);
  };
  c.state.handlers['torrents/delete']=({send,state,params})=>{
    const hash=params.get('hashes');
    state.torrents=state.torrents.filter(torrent=>torrent.hash!==hash);
    state.files.delete(hash);
    send('');
  };
  const pending=check(c,[target(HASH),target(BACKUP)],{allowProbe:true});
  try{
    await until(()=>waiting,{description:'the post-probe verification to remain in flight'});
    await c.api('/api/torrent/action',{hash:HASH,action:'delete',confirmName:name,deleteFiles:false});
  }finally{release.resolve();}
  const {files}=await pending;
  assert.equal(files[0].status,'unavailable');
  assert.equal(files[0].reason,'missing');
  assert.equal(files[0].playKey,undefined);
  assert.equal(files[1].status,'downloading');
  assert.deepEqual(writes(c).map(({endpoint})=>endpoint),['torrents/delete']);
});

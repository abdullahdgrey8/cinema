import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent,until} from './helpers.mjs';

const nonce='e'.repeat(32);
const absent={kind:'unavailable'};
const watched='/api/watched/proof';

async function video(filename,options=[]){
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=320x180:r=24:d=13',
    ...options,filename],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
  return (await fs.stat(filename)).size;
}
async function playback(c,index=0){
  await c.api('/api/prepare',{hash:HASH,index});
  return until(async()=>{
    const state=await c.api('/api/playback?hash='+HASH+'&index='+index);
    assert.notEqual(state.status,'error',state.message);
    return state.status==='ready'&&state;
  },{description:'ready exact test media'});
}
const mutations=requests=>requests.filter(row=>row.method==='POST'&&row.endpoint!=='auth/login');

test('an exact complete playback file seals, survives restart checks, and rejects a changed or sibling file',async t=>{
  const c=await cinema(t);
  const name='Observed.mp4', sibling='Sibling.mp4',filename=path.join(c.dir,name);
  const size=await video(filename,['-c:v','libx264','-b:v','1200k','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart']);
  await fs.copyFile(filename,path.join(c.dir,sibling));
  c.state.torrents=[torrent(c.dir,{name:'Isolated test pack',size:size*2,total_size:size*2})];
  c.state.files.set(HASH,[{index:0,name,size,progress:1,priority:1},{index:1,name:sibling,size,progress:1,priority:1}]);
  const state=await playback(c);
  const before=c.state.requests.length;
  assert.equal(state.mode,'direct');
  const input={hash:HASH,index:0,mode:'direct'};
  const checked=await c.api(watched,{...input,sessionId:state.sessionId,attachment:nonce});
  assert.equal(checked.kind,'sealed');
  assert.match(checked.seal,/^[0-9a-f]{64}$/);
  assert.deepEqual(checked.timeline,{mode:'direct',offsetMs:0,run:null});
  assert.deepEqual(Object.keys(checked).sort(),['kind','seal','timeline']);
  assert.deepEqual(await c.api(watched,{...input,expected:checked.seal}),checked);
  const reopenedAttachment='01234567-89ab-cdef-0123-456789abcdef';
  assert.deepEqual(await c.api(watched,{...input,sessionId:state.sessionId,attachment:reopenedAttachment,expected:checked.seal}),checked,
    'A sealed file can revalidate when the exact same playback session is reopened under a new client attachment');
  assert.deepEqual(await c.api(watched,{...input,index:1,expected:checked.seal}),absent);
  assert.deepEqual(await c.api(watched,{...input,sessionId:'b'.repeat(32),attachment:nonce}),absent);
  assert.equal((await c.request(watched,{...input,expected:checked.seal},{headers:{'X-Cinema-Token':'bad'}})).status,403);
  assert.equal((await c.request(watched,{...input,index:'0',expected:checked.seal})).status,400);
  assert.equal((await c.request(watched,{...input,mode:'hls',run:'../index',expected:checked.seal})).status,400);
  await c.restart();
  assert.deepEqual(await c.api(watched,{...input,expected:checked.seal}),checked);
  const handle=await fs.open(filename,'r+');
  try{
    const byte=Buffer.alloc(1);await handle.read(byte,0,1,size-3);byte[0]^=0xff;
    await handle.write(byte,0,1,size-3);
  }finally{await handle.close();}
  assert.deepEqual(await c.api(watched,{...input,expected:checked.seal}),absent);
  assert.deepEqual(mutations(c.state.requests.slice(before)),[]);
  assert.ok(!c.state.requests.slice(before).some(row=>row.endpoint==='torrents/export'),
    'A complete detached check reads the exact file without exporting torrent metadata');
});

test('partial proof stays within exact verified opening pieces and is never promoted at completion',async t=>{
  const c=await cinema(t);
  const name='Growing.mp4',filename=path.join(c.dir,name);
  const size=await video(filename,['-c:v','libx264','-b:v','1200k','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart']);
  const pieceSize=65536,count=Math.ceil(size/pieceSize),initial=12;
  assert.ok(count>initial);
  const file={index:0,name,size,progress:initial/count,priority:1,piece_range:[0,count-1]};
  const release=torrent(c.dir,{name,size,total_size:size,progress:file.progress,state:'downloading'});
  c.state.torrents=[release];c.state.files.set(HASH,[file]);c.state.properties={piece_size:pieceSize};
  c.state.pieces=Array.from({length:count},(_,i)=>i<initial?2:0);
  const state=await playback(c);
  const baseline=c.state.requests.length;
  const input={hash:HASH,index:0,mode:'direct',sessionId:state.sessionId,attachment:nonce};
  const first=await c.api(watched,input);
  assert.equal(first.kind,'volatile');
  assert.match(first.seal,/^[0-9a-f]{64}$/);
  assert.deepEqual(await c.api(watched,{...input,expected:first.seal}),first);
  assert.deepEqual(await c.api(watched,{hash:HASH,index:0,mode:'direct',expected:first.seal}),absent);

  c.state.pieces[0]=0;
  assert.deepEqual(await c.api(watched,{...input,expected:first.seal}),absent);
  c.state.pieces[0]=2;
  const nextInput={...input,attachment:'01234567-89ab-cdef-0123-456789abcdef'};
  const next=await c.api(watched,nextInput);
  assert.equal(next.kind,'volatile');
  assert.notEqual(next.seal,first.seal);
  assert.deepEqual(await c.api(watched,{...input,expected:first.seal}),absent);
  file.progress-=.01;
  assert.deepEqual(await c.api(watched,{...nextInput,expected:next.seal}),absent);
  file.progress+=.02;
  assert.deepEqual(await c.api(watched,{...nextInput,expected:next.seal}),absent);

  const finalInput={...input,attachment:'f'.repeat(32)};
  const partial=await c.api(watched,finalInput);
  assert.equal(partial.kind,'volatile');
  c.state.pieces.fill(2);file.progress=1;release.progress=1;release.state='uploading';
  assert.deepEqual(await c.api(watched,{...finalInput,expected:partial.seal}),absent);
  const complete=await c.api(watched,finalInput);
  assert.equal(complete.kind,'sealed');
  assert.notEqual(complete.seal,partial.seal);
  assert.deepEqual(await c.api(watched,{hash:HASH,index:0,mode:'direct',expected:complete.seal}),complete);
  assert.deepEqual(mutations(c.state.requests.slice(baseline)),[]);
});

test('HLS binds the newly converted exact run and rejects a legacy cache or regenerated timeline',async t=>{
  const c=await cinema(t);
  const name='Converted.mp4',filename=path.join(c.dir,name);
  const size=await video(filename,['-c:v','libx264','-b:v','900k','-preset','ultrafast','-g','48',
    '-pix_fmt','yuv420p','-threads','2','-movflags','+faststart']);
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size})];
  c.state.files.set(HASH,[{index:0,name,size,progress:1,priority:1}]);
  await c.api('/api/prepare',{hash:HASH,index:0,forceTranscode:true});
  const marker=path.join(c.dir,'hls',HASH+'-0','completed.json');
  const state=await until(async()=>{
    const row=await c.api('/api/playback?hash='+HASH+'&index=0');
    assert.notEqual(row.status,'error',row.message);
    return row.complete&&await fs.stat(marker).then(()=>row).catch(()=>false);
  },{description:'verified full HLS conversion'});
  const baseline=c.state.requests.length, run=state.url.split('/')[3];
  const input={hash:HASH,index:0,mode:'hls',run};
  const proof=await c.api(watched,{...input,sessionId:state.sessionId,attachment:nonce});
  assert.equal(proof.kind,'sealed');
  assert.deepEqual(proof.timeline,{mode:'hls',run,offsetMs:0});
  assert.deepEqual(await c.api(watched,{...input,run:'0'.repeat(12),expected:proof.seal}),absent);
  await c.restart();
  assert.deepEqual(await c.api(watched,{...input,expected:proof.seal}),proof);
  const stored=JSON.parse(await fs.readFile(marker,'utf8'));
  await fs.writeFile(marker,JSON.stringify({...stored,dialogue:{...stored.dialogue,offsetMs:1250}}));
  assert.deepEqual(await c.api(watched,{...input,expected:proof.seal}),absent);
  await fs.writeFile(marker,JSON.stringify({run:stored.run,size:stored.size,duration:stored.duration}));
  assert.deepEqual(await c.api(watched,{...input,expected:proof.seal}),absent);
  const legacy=await playback(c);
  assert.equal(legacy.mode,'hls','The original legacy cache still works for ordinary playback');
  assert.deepEqual(await c.api(watched,{...input,sessionId:legacy.sessionId,attachment:nonce}),absent);
  assert.deepEqual(mutations(c.state.requests.slice(baseline)),[]);
});

test('proof admits only two validations and an aborted caller cannot free a slot while its read still runs',async t=>{
  const c=await cinema(t);
  const name='Read-only.mp4',size=180000;
  await fs.writeFile(path.join(c.dir,name),Buffer.alloc(size,42));
  const source=torrent(c.dir,{name,size,total_size:size});
  c.state.torrents=[source];
  c.state.files.set(HASH,[{index:0,name,size,progress:1,priority:1}]);
  let started=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  c.state.handlers['torrents/info']=async({params,send})=>{
    if(params.get('hashes')===HASH){started++;await gate;}
    send([source]);
  };
  const input={hash:HASH,index:0,mode:'direct',expected:'9'.repeat(64)};
  const control=new AbortController();
  const first=c.request(watched,input,{signal:control.signal});
  const second=c.request(watched,input);
  try{
    await until(()=>started===2,{description:'exactly two in-flight proof snapshots'});
    assert.equal((await c.request(watched,input)).status,429);
    const stopped=assert.rejects(first,{name:'AbortError'});
    control.abort();
    await stopped;
    assert.equal((await c.request(watched,input)).status,429);
    assert.equal(started,2);
  }finally{release();}
  assert.deepEqual(await (await second).json(),absent);
  await until(async()=>{
    const response=await c.request(watched,input);
    return response.status===200&&(await response.json()).kind==='unavailable';
  },{description:'proof slot released after its aborted snapshot settled'});
  assert.deepEqual(mutations(c.state.requests),[]);
});

test('a growing zero-origin HLS run can provide volatile proof, then a distinct sealed proof',async t=>{
  const c=await cinema(t);
  const name='Growing conversion.mp4',filename=path.join(c.dir,name);
  const size=await video(filename,['-c:v','libx264','-b:v','1100k','-preset','ultrafast','-g','48',
    '-pix_fmt','yuv420p','-threads','2','-movflags','+faststart']);
  const pieceSize=65536,count=Math.ceil(size/pieceSize),opening=count-3;
  assert.ok(opening>12);
  const file={index:0,name,size,progress:opening/count,priority:1,piece_range:[0,count-1]};
  const source=torrent(c.dir,{name,size,total_size:size,progress:file.progress,state:'downloading'});
  c.state.torrents=[source];c.state.files.set(HASH,[file]);c.state.properties={piece_size:pieceSize};
  c.state.pieces=Array.from({length:count},(_,i)=>i<opening?2:0);
  await c.api('/api/prepare',{hash:HASH,index:0,forceTranscode:true});
  const state=await until(async()=>{
    const current=await c.api('/api/playback?hash='+HASH+'&index=0');
    assert.notEqual(current.status,'error',current.message);
    return current.status==='ready'&&current;
  },{description:'growing HLS exact run'});
  assert.equal(state.complete,false);
  const baseline=c.state.requests.length,run=state.url.split('/')[3];
  const input={hash:HASH,index:0,mode:'hls',run,sessionId:state.sessionId,attachment:nonce};
  const live=await c.api(watched,input);
  assert.equal(live.kind,'volatile');
  assert.deepEqual(await c.api(watched,{...input,expected:live.seal}),live);
  c.state.pieces.fill(2);file.progress=1;source.progress=1;source.state='uploading';
  const sealed=await until(async()=>{
    const proof=await c.api(watched,input);
    return proof.kind==='sealed'&&proof;
  },{description:'distinct sealed HLS proof after completion'});
  assert.notEqual(live.seal,sealed.seal);
  assert.deepEqual(await c.api(watched,{...input,expected:live.seal}),absent);
  assert.deepEqual(mutations(c.state.requests.slice(baseline)),[]);
});


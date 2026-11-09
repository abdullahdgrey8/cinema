import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createHash} from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {createScenePreview,indexScene} from '../scene-preview.mjs';
import {runSceneChild} from '../scene-clip.mjs';
import {sameDialogueObject} from '../torrent-media.mjs';

test('the shared file identity accepts Windows path dev zero only with the same inode and birth',()=>{
  const descriptor={dev:17n,ino:101n,birth:1000n}, named={...descriptor,dev:0n};
  assert.equal(sameDialogueObject(descriptor,named,'win32'),true);
  assert.equal(sameDialogueObject(named,descriptor,'win32'),true);
  assert.equal(sameDialogueObject(descriptor,{...descriptor},'linux'),true);
  assert.equal(sameDialogueObject(descriptor,named,'linux'),false);
  assert.equal(sameDialogueObject(descriptor,named),process.platform==='win32');
  for(const change of [{ino:102n},{birth:1001n},{dev:18n},{ino:0n}])
    assert.equal(sameDialogueObject(descriptor,{...descriptor,...change},'win32'),false);
  assert.equal(sameDialogueObject({...descriptor,ino:0n},{...named,ino:0n},'win32'),false);
  assert.equal(sameDialogueObject(descriptor,{...named,ino:102n},'win32'),false);
  assert.equal(sameDialogueObject(descriptor,{...named,birth:1001n},'win32'),false);
  assert.equal(sameDialogueObject(descriptor,null,'win32'),false);
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function words(...values){const bytes=Buffer.alloc(values.length*4);values.forEach((value,index)=>bytes.writeUInt32BE(value,index*4));return bytes;}
const box=(name,...parts)=>Buffer.concat([words(8+parts.reduce((size,part)=>size+part.length,0)),Buffer.from(name),...parts]);
const full=(name,...parts)=>box(name,words(0),...parts);
function encode(value){
  if(typeof value==='string')return encode(Buffer.from(value));
  if(typeof value==='number')return Buffer.from(`i${value}e`);
  if(Buffer.isBuffer(value))return Buffer.concat([Buffer.from(`${value.length}:`),value]);
  return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(name=>[encode(name),encode(value[name])]),Buffer.from('e')]);
}

// A six-second H.264/AAC sample-table fixture with an actual parser-valid
// fast-start prefix and a separate late data piece. No encoder or movie file is
// needed: this test cancels the descriptor read before remuxing can begin.
function copyCancellationFixture({chunks=1,samplesPerChunk=6}={}){
  const dataOffset=65536,pieceSize=16384,count=chunks*samplesPerChunk,idr=Buffer.from([0,0,0,2,0x65,0xaa]);
  const offsets=Array.from({length:chunks},(_,index)=>dataOffset+index*pieceSize);
  const duration=count*1000;
  function track(video){
    const entry=Buffer.alloc(video?78:28);entry.writeUInt16BE(1,6);
    const config=video?box('avcC',Buffer.from([1,0,0,0,0xff,0,0])):
      full('esds',Buffer.from('031900010004114015000000000000000000000005021190060102','hex'));
    const tables=[full('stsd',words(1),box(video?'avc1':'mp4a',entry,config)),
      full('stts',words(1,count,1000)),full('stsc',words(1,1,samplesPerChunk,1)),full('stsz',words(video?idr.length:4,count)),
      full('stco',words(chunks,...offsets.map(offset=>offset+(video?0:samplesPerChunk*idr.length))))];
    if(video)tables.push(full('stss',words(chunks,...offsets.map((_,index)=>index*samplesPerChunk+1))));
    const tkhd=Buffer.alloc(80);tkhd.writeUInt32BE(video?1:2,8);tkhd.writeUInt32BE(duration,16);
    const mdhd=Buffer.alloc(20);mdhd.writeUInt32BE(1000,8);mdhd.writeUInt32BE(duration,12);
    const handler=Buffer.alloc(20);handler.write(video?'vide':'soun',4);
    const reference=box('dinf',full('dref',words(1),box('url ',words(1))));
    return box('trak',full('tkhd',tkhd),box('mdia',full('mdhd',mdhd),full('hdlr',handler),
      box('minf',box(video?'vmhd':'smhd'),reference,box('stbl',...tables))));
  }
  const movieHeader=Buffer.alloc(96);movieHeader.writeUInt32BE(1000,8);movieHeader.writeUInt32BE(duration,12);
  const ftyp=box('ftyp',Buffer.from('isom'),words(0),Buffer.from('isom'));
  const moov=box('moov',full('mvhd',movieHeader),track(true),track(false));
  const chunkBytes=samplesPerChunk*(idr.length+4);
  const bytes=Buffer.alloc(offsets.at(-1)+chunkBytes);
  const prefix=Buffer.concat([ftyp,moov,words(bytes.length-ftyp.length-moov.length),Buffer.from('mdat')]);
  assert(prefix.length<pieceSize);prefix.copy(bytes);
  for(const offset of offsets){
    for(let sample=0;sample<samplesPerChunk;sample++)idr.copy(bytes,offset+sample*idr.length);
    bytes.fill(0x42,offset+samplesPerChunk*idr.length,offset+chunkBytes);
  }
  const pieces=[];
  for(let start=0;start<bytes.length;start+=pieceSize)pieces.push(createHash('sha1').update(bytes.subarray(start,start+pieceSize)).digest());
  const info=encode({name:'copy-scene.mp4',length:bytes.length,'piece length':pieceSize,pieces:Buffer.concat(pieces)});
  return {bytes,dataOffset,pieceSize,hash:createHash('sha1').update(info).digest('hex'),metadata:Buffer.concat([Buffer.from('d4:info'),info,Buffer.from('e')]),
    file:{name:'copy-scene.mp4',index:0,size:bytes.length,piece_range:[0,pieces.length-1]},states:[2,0,0,0,...Array(chunks).fill(2)]};
}

test('the actual preview slot stays busy through an admitted-piece read and descriptor close after cancellation',{timeout:8000},async t=>{
  const local=await fsp.mkdtemp(path.join(os.tmpdir(),'cinema-scene-drain-')), fixture=copyCancellationFixture();
  const readEntered=deferred(),readRelease=deferred(),closeEntered=deferred(),closeRelease=deferred();
  const control=new AbortController(), reason=Error('Cancel during scene piece copy');
  const events=[];let opened=0,closed=0,settled=false,readDrained=false,stateReads=0;
  const manager=createScenePreview({local,bind(){return {assertCurrent(){},async open(){
    const attempt=++opened;
    return {file:fixture.file,validate:async()=>{},reader:{
      async raw(endpoint){assert.equal(endpoint,'torrents/export');return new Response(fixture.metadata,{headers:{'Content-Type':'application/x-bittorrent'}});},
      async json(endpoint){
        if(endpoint==='torrents/properties')return {infohash_v1:fixture.hash,infohash_v2:''};
        assert.equal(endpoint,'torrents/pieceStates');stateReads++;
        return attempt===1?fixture.states:Array(fixture.states.length).fill(0);
      }
    },handle:{
      async read(target,offset,length,position){
        if(position===fixture.dataOffset){
          assert.equal(stateReads,2,'The late read must be pieces.admit after the real index worker, not bootstrap');
          events.push('read-start');readEntered.resolve();await readRelease.promise;
          readDrained=true;events.push('read-drained');
        }
        fixture.bytes.copy(target,offset,position,position+length);return {bytesRead:length,buffer:target};
      },
      async close(){
        if(attempt===1){assert.equal(readDrained,true);events.push('close-start');closeEntered.resolve();await closeRelease.promise;}
        closed++;events.push('close-done');
      }
    }};
  }}}});
  const identity={hash:fixture.hash,index:0,sessionId:'isolated-copy',targetMs:1100};
  let pending;
  t.after(async()=>{
    control.abort();readRelease.resolve();closeRelease.resolve();await manager.cancel();await pending;
    const target=path.resolve(local);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^cinema-scene-drain-/);
    await fsp.rm(target,{recursive:true,force:true});
  });
  pending=manager.start(identity,{signal:control.signal}).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
  await Promise.race([readEntered.promise,pending.then(result=>assert.fail(`Preview exited before the late piece read: ${result.error?.stack}`))]);
  control.abort(reason);
  const drained=manager.cancel(fixture.hash);
  await assert.rejects(manager.start(identity),{code:'scene-busy'});
  assert.equal(settled,false);assert.equal(closed,0);assert.equal(opened,1);
  readRelease.resolve();await closeEntered.promise;
  await assert.rejects(manager.start(identity),{code:'scene-busy'});
  assert.equal(settled,false);assert.equal(closed,0);assert.equal(opened,1);
  closeRelease.resolve();
  assert.equal((await pending).error,reason);await drained;
  assert.deepEqual(events,['read-start','read-drained','close-start','close-done']);
  await assert.rejects(manager.start(identity),{code:'scene-missing'});
  assert.equal(opened,2,'A new request must open after the underlying read and close both finish');
  assert.equal(closed,2);
});

const nativeLease={id:'10000000-0000-0000-0000-000000000001',ttlMs:6000,state:'requested',pieces:1,verified:0};

async function sceneLeaseFixture(t,{onRequest,onStatus,onPublication,corruptTarget=false}={}){
  const local=await fsp.mkdtemp(path.join(os.tmpdir(),'cinema-scene-lease-'));
  const fixture=copyCancellationFixture({chunks:3,samplesPerChunk:14});
  const {bytes,dataOffset,pieceSize,hash,metadata,file,states}=fixture;
  const targetStart=dataOffset+2*pieceSize;
  states[states.length-1]=0;
  if(corruptTarget)bytes[targetStart]^=1;
  const dropReserve=()=>{states[dataOffset/pieceSize]=0;};
  const events=[], readPositions=[];
  let closed=0, publicationReads=0;
  const manager=createScenePreview({local,bind(){return {assertCurrent(){},async open(){
    return {file,validate:async()=>{},reader:{
      async raw(endpoint){
        assert.equal(endpoint,'torrents/export');
        return new Response(metadata,{headers:{'Content-Type':'application/x-bittorrent'}});
      },
      async json(endpoint,_params,phaseSignal){
        if(endpoint==='torrents/properties')return {infohash_v1:hash,infohash_v2:''};
        assert.equal(endpoint,'torrents/pieceStates');
        if(phaseSignal&&onPublication)
          states[states.length-1]=await onPublication(phaseSignal,++publicationReads)?2:0;
        return [...states];
      },
    },handle:{
      async read(target,offset,length,position){
        readPositions.push(position);
        bytes.copy(target,offset,position,position+length);
        return {bytesRead:length,buffer:target};
      },
      async close(){closed++;},
    },scheduler:{
      async available(){events.push(['available']);return true;},
      async request(plan){events.push(['request',plan]);return onRequest?onRequest():nativeLease;},
      async status(hash,id){events.push(['status',hash,id]);return onStatus?onStatus(dropReserve):null;},
      async cancel(hash,id){events.push(['cancel',hash,id]);},
    }};
  }}}});
  t.after(async()=>{
    await manager.cancel();
    await fsp.rmdir(path.join(local,'scene-preview-work'));
    await fsp.rmdir(local);
  });
  return {
    hash,events,readPositions,get closed(){return closed;},
    expectedPlan:{hash,index:0,size:bytes.length,reserve:[dataOffset,targetStart],ranges:[[targetStart,bytes.length]]},
    start(foreground={},signal){
      return manager.start({hash,index:0,sessionId:'isolated-lease',targetMs:38_100,
        foreground:{playheadMs:1100,bufferedUntilMs:13_100,sampledAt:performance.now(),...foreground}},{signal});
    },
  };
}

test('expired samples and short browser buffers refuse a scene lease before scheduling',{timeout:8000},async t=>{
  const fixture=await sceneLeaseFixture(t);
  const observedAt=10_000;
  t.mock.method(performance,'now',()=>observedAt);
  await assert.rejects(fixture.start({sampledAt:observedAt-2500}),{code:'scene-runway'});
  await assert.rejects(fixture.start({bufferedUntilMs:11_099}),{code:'scene-runway'});
  assert.deepEqual(fixture.events,[['available'],['available']]);
  assert.deepEqual(fixture.readPositions,[0,0]);
  assert.equal(fixture.closed,2);
});

test('cancellation drains a late lease reply and cancels that exact lease without polling',{timeout:8000},async t=>{
  const requestEntered=deferred(), reply=deferred();
  const fixture=await sceneLeaseFixture(t,{onRequest(){requestEntered.resolve();return reply.promise;}});
  const control=new AbortController(), reason=Error('Cancel while the scene engine is responding');
  const pending=fixture.start({},control.signal).then(value=>({value}),error=>({error}));
  try {
    await Promise.race([requestEntered.promise,pending.then(result=>assert.fail(`Preview exited before scheduling: ${result.error?.stack}`))]);
    control.abort(reason);
    await assert.rejects(fixture.start(),{code:'scene-busy'});
    assert.equal(fixture.closed,0);
  } finally {
    reply.resolve(nativeLease);
  }
  assert.equal((await pending).error,reason);
  assert.deepEqual(fixture.events,[['available'],['request',fixture.expectedPlan],['cancel',fixture.hash,nativeLease.id]]);
  assert.deepEqual(fixture.readPositions,[0]);
  assert.equal(fixture.closed,1);
});

test('a lost native request reply never triggers a retry or a guessed cancellation',{timeout:8000},async t=>{
  const reason=Object.assign(Error('The native request response was lost'),{code:'scene-fetch-unavailable'});
  const fixture=await sceneLeaseFixture(t,{onRequest(){throw reason;}});
  await assert.rejects(fixture.start(),error=>error===reason);
  assert.deepEqual(fixture.events,[['available'],['request',fixture.expectedPlan]]);
  assert.deepEqual(fixture.readPositions,[0]);
  assert.equal(fixture.closed,1);
});

test('a lost reserve cancels its lease even when the native status reports completion',{timeout:8000},async t=>{
  const fixture=await sceneLeaseFixture(t,{onStatus(dropReserve){
    dropReserve();
    return {...nativeLease,state:'complete',verified:1};
  }});
  await assert.rejects(fixture.start(),{code:'scene-runway'});
  assert.deepEqual(fixture.events,[['available'],['request',fixture.expectedPlan],
    ['status',fixture.hash,nativeLease.id],['cancel',fixture.hash,nativeLease.id]]);
  assert.deepEqual(fixture.readPositions,[0]);
  assert.equal(fixture.closed,1);
});

test('a complete lease waits for the public piece state and still verifies the downloaded bytes',{timeout:8000},async t=>{
  const snapshots=[];
  const fixture=await sceneLeaseFixture(t,{
    onStatus:()=>({...nativeLease,state:'complete',verified:1}),
    onPublication(_signal,read){
      const available=read>1;
      snapshots.push(available);
      return available;
    },
    corruptTarget:true,
  });
  await assert.rejects(fixture.start(),{code:'scene-unverified',message:'The requested scene bytes did not pass verification.'});
  assert.deepEqual(snapshots,[false,true]);
  assert.deepEqual(fixture.events,[['available'],['request',fixture.expectedPlan],
    ['status',fixture.hash,nativeLease.id],['cancel',fixture.hash,nativeLease.id]]);
  assert.equal(fixture.readPositions.at(-1),fixture.expectedPlan.ranges[0][0]);
  assert.equal(fixture.closed,1);
});

test('cancellation interrupts the public piece state wait without requesting another lease',{timeout:8000},async t=>{
  const reading=deferred(), control=new AbortController(), reason=Error('Cancel while waiting for published pieces');
  const fixture=await sceneLeaseFixture(t,{
    onStatus:()=>({...nativeLease,state:'complete',verified:1}),
    async onPublication(signal,read){
      if(read===1)return false;
      reading.resolve(signal);
      await once(signal,'abort');
      signal.throwIfAborted();
    },
  });
  const pending=fixture.start({},control.signal).then(value=>({value}),error=>({error}));
  const phase=await Promise.race([reading.promise,pending.then(result=>assert.fail(`Preview exited before observing publication: ${result.error?.stack}`))]);
  control.abort(reason);
  assert.equal((await pending).error,reason);
  assert.equal(phase.reason,reason);
  assert.deepEqual(fixture.events,[['available'],['request',fixture.expectedPlan],
    ['status',fixture.hash,nativeLease.id],['cancel',fixture.hash,nativeLease.id]]);
  assert.deepEqual(fixture.readPositions,[0]);
  assert.equal(fixture.closed,1);
});

test('cancelling scene indexing terminates the actual Node worker before its promise settles',async()=>{
  const control = new AbortController(), reason=Error('Cancel the index');
  const pending = indexScene(Buffer.alloc(8),32,1000,control.signal);
  control.abort(reason);
  await assert.rejects(pending,error=>error===reason);
});

for (const [label,executable,argumentsFor] of [
  ['FFmpeg',ffmpeg,url=>['-v','error','-nostdin','-i',url,'-f','null','-']],
  ['FFprobe',ffprobe.path,url=>['-v','error','-show_packets',url]],
]) test(`cancelling ${label} closes its live input before the scene worker slot releases`,async t=>{
  let accept,close;
  const connected = new Promise(resolve=>{accept=resolve;}), closed = new Promise(resolve=>{close=resolve;});
  const server = http.createServer((_req,res)=>{
    res.once('close',close);
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':300000});
    res.flushHeaders();accept();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const control=new AbortController(), reason=Error(`Cancel ${label}`);
  const timeout=AbortSignal.timeout(4500);
  const pending=runSceneChild(executable,argumentsFor(`http://127.0.0.1:${server.address().port}/held.mp4`),
    AbortSignal.any([control.signal,timeout]));
  const rejected=assert.rejects(pending,error=>error===reason);
  await Promise.race([connected,pending]);
  control.abort(reason);
  await rejected;
  const disconnected=Promise.race([closed,new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(Error('The media subprocess still has a live socket')),2000);timer.unref();
  })]);
  await disconnected;
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {cinema,torrent,until} from './helpers.mjs';
import {bootstrapNeeded,NeedMoreScenePrefix,parseSceneMovie,selectScene} from '../scene-mp4-index.mjs';

function bencode(value) {
  if (typeof value==='string') return bencode(Buffer.from(value));
  if (typeof value==='number') return Buffer.from(`i${value}e`);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`),value]);
  return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(key=>[bencode(key),bencode(value[key])]),Buffer.from('e')]);
}

function requiredRanges(data,targetMs) {
  let prefix = Buffer.alloc(0);
  for (;;) {
    try { bootstrapNeeded(prefix,data.length);break; }
    catch (error) {
      if (!(error instanceof NeedMoreScenePrefix)) throw error;
      prefix = data.subarray(0,error.minimumBytes);
    }
  }
  return selectScene(parseSceneMovie(prefix,data.length),targetMs,2000,{audioPrerollSamples:8,readAheadMs:600}).ranges;
}

test('an authenticated discontiguous scene returns a clip, denies missing and tampered pieces and keeps the foreground session',async t=>{
  const c = await cinema(t), name='preview-fixture.mp4', targetMs=70013, pieceSize=65536;
  const complete = path.join(c.dir,'reference.mp4'), partial = path.join(c.dir,name);
  const encoded = spawn(ffmpeg,['-hide_banner','-v','error','-filter_threads','1','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=85',
    '-f','lavfi','-i','sine=frequency=770:sample_rate=48000:duration=85','-c:v','libx264','-threads','1',
    '-preset','ultrafast','-crf','15','-g','50','-sc_threshold','0','-c:a','aac','-movflags','+faststart','-shortest',complete],
    {windowsHide:true,stdio:'ignore'});
  assert.equal((await once(encoded,'close'))[0],0);
  const original = await fsp.readFile(complete), size=original.length;
  const count = Math.ceil(size/pieceSize), hashes=[];
  assert(count>32,'The fixture must have a usable hole after the first MiB');
  for (let index=0;index<count;index++) hashes.push(createHash('sha1').update(original.subarray(index*pieceSize,(index+1)*pieceSize)).digest());
  const info = bencode({length:size,name,'piece length':pieceSize,pieces:Buffer.concat(hashes)});
  const metadata = Buffer.concat([Buffer.from('d4:info'),info,Buffer.from('e')]);
  const hash = createHash('sha1').update(info).digest('hex');
  const ranges = requiredRanges(original,targetMs);
  const admitted = new Set(Array.from({length:16},(_,index)=>index));
  let scenePiece;
  for(const [start,end] of ranges)for(let i=Math.floor(start/pieceSize);i<Math.ceil(end/pieceSize);i++){
    admitted.add(i);
    if(i>16) scenePiece ??= i;
  }
  assert(scenePiece>16 && admitted.size<count && !admitted.has(16));
  const sparse = Buffer.alloc(size);
  for (const index of admitted) original.copy(sparse,index*pieceSize,index*pieceSize,Math.min(size,(index+1)*pieceSize));
  await fsp.writeFile(partial,sparse);
  const progress = admitted.size/count;
  c.state.torrents = [torrent(c.dir,{hash,name,size,total_size:size,progress,state:'downloading'})];
  c.state.files.set(hash,[{index:0,name,size,progress,piece_range:[0,count-1],priority:1}]);
  c.state.properties = {hash,infohash_v1:hash,infohash_v2:'',piece_size:pieceSize,pieces_num:count};
  c.state.pieces = Array.from({length:count},(_,i)=>admitted.has(i)?2:0);
  c.state.handlers['app/preferences'] = ({send})=>send({temp_path_enabled:false});
  c.state.handlers['torrents/export'] = ({res})=>{res.setHeader('Content-Type','application/x-bittorrent');res.end(metadata);};
  await c.api('/api/prepare',{hash,index:0});
  const foreground = await until(async()=>{
    const state = await c.api(`/api/playback?hash=${hash}&index=0`);
    assert.notEqual(state.status,'error',JSON.stringify(state));
    return state.status==='ready'&&state;
  },{timeout:12000,description:'the original video picture path to be ready'});
  const body = {hash,index:0,sessionId:foreground.sessionId,targetMs};
  const start = c.state.requests.length;
  const response = await c.request('/api/scene-preview',body);
  assert.equal(response.status,200, response.ok?'':await response.text());
  assert.equal(response.headers.get('Content-Type'),'video/mp4');
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString('ascii',4,8),'ftyp');
  assert(Number(response.headers.get('X-Cinema-Scene-Seek'))>0);
  assert.equal(bytes.length,Number(response.headers.get('Content-Length')));
  const current = await c.api(`/api/playback?hash=${hash}&index=0`);
  assert.equal(current.sessionId,foreground.sessionId);
  assert.equal(current.url,foreground.url);
  assert.equal(current.progress,progress);
  c.state.pieces[scenePiece] = 0;
  const missing = await c.request('/api/scene-preview',body);
  assert.equal(missing.status,409);
  const missingNotice=await missing.json();
  assert.equal(missingNotice.code,'scene-missing');
  assert.equal(missingNotice.canFetch,undefined);
  assert.match(missingNotice.error,/still downloading/);
  const stale = await c.request('/api/scene-preview',{...body,fetch:true,playheadMs:0,bufferedUntilMs:12000,
    sampledAt:Date.now()-1000});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).code,'scene-runway');
  c.state.pieces[scenePiece] = 2;
  const file = await fsp.open(partial,'r+');
  try {
    await file.write(Buffer.from([sparse[scenePiece*pieceSize]^0xff]),0,1,scenePiece*pieceSize);
  } finally {await file.close();}
  const corrupt = await c.request('/api/scene-preview',body);
  assert.equal(corrupt.status,422);
  assert.match((await corrupt.json()).error,/verify/);
  assert(c.state.requests.slice(start).every(request=>request.method==='GET'),'Scene verification must not mutate qBittorrent');
  assert.deepEqual(await fsp.readdir(path.join(c.dir,'scene-preview-work')),[]);

  // Restore the synthetic source before exercising lifecycle failures. Holding
  // export occurs after the preview opened its own source descriptor.
  const repaired = await fsp.open(partial,'r+');
  try {await repaired.write(sparse.subarray(scenePiece*pieceSize,scenePiece*pieceSize+1),0,1,scenePiece*pieceSize);}
  finally {await repaired.close();}
  const normalExport = c.state.handlers['torrents/export'];
  function holdExport() {
    const held = {response:null,closed:false};
    c.state.handlers['torrents/export'] = ({res})=>{
      assert.equal(held.response,null,'Only the pending preview may request this held export');
      held.response=res;
      res.once('close',()=>{held.closed=true;});
      res.writeHead(200,{'Content-Type':'application/x-bittorrent'});
      res.write(metadata.subarray(0,12));
    };
    t.after(()=>held.response?.destroy());
    return held;
  }
  await t.test('client abort closes the held export and releases the preview slot',async()=>{
    const held = holdExport(), control = new AbortController();
    const cancelled = c.request('/api/scene-preview',body,{signal:control.signal})
      .then(response=>({response}),error=>({error}));
    await until(()=>held.response,{timeout:3000,description:'preview export to start after its descriptor opens'});
    control.abort();
    assert.equal((await cancelled).error?.name,'AbortError');
    await until(()=>held.closed,{timeout:3000,description:'aborted preview to close its qBittorrent export'});
    c.state.handlers['torrents/export']=normalExport;
    c.state.pieces[scenePiece]=0;
    await until(async()=>{
      const retry=await c.request('/api/scene-preview',body), result=await retry.json();
      if(retry.status===429)return false;
      assert.equal(retry.status,409,JSON.stringify(result));
      assert.match(result.error,/still downloading/);
      return true;
    },{timeout:3000,description:'the cancelled preview slot to accept another request'});
    c.state.pieces[scenePiece]=2;
    const unchanged=await c.api(`/api/playback?hash=${hash}&index=0`);
    assert.equal(unchanged.sessionId,foreground.sessionId);
    assert.equal(unchanged.url,foreground.url);
    assert(c.state.requests.slice(start).every(request=>request.method==='GET'),'Aborting or retrying preview must not change the download');
  });
  await t.test('remove with files drains the pending preview before the downloader deletes its source',async()=>{
    const held=holdExport();
    const preview=c.request('/api/scene-preview',body).then(async response=>({status:response.status,body:await response.json()}));
    await until(()=>held.response,{timeout:3000,description:'preview to hold a source descriptor during export'});
    let deletionCount=0;
    c.state.handlers['torrents/delete']=async({params,send})=>{
      deletionCount++;
      assert.equal(params.get('hashes'),hash);
      assert.equal(params.get('deleteFiles'),'true');
      assert.equal(held.closed,true,'The preview export must close before the downloader receives deletion');
      await fsp.unlink(partial);
      c.state.torrents=[];c.state.files.delete(hash);
      send('');
    };
    const removed=await c.api('/api/torrent/action',{hash,action:'delete',deleteFiles:true,confirmName:name});
    assert.equal(removed.ok,true);
    assert.equal(removed.warning,undefined);
    const stopped=await preview;
    assert.equal(stopped.status,409,JSON.stringify(stopped.body));
    assert.match(stopped.body.error,/changed/);
    assert.equal(deletionCount,1);
    await assert.rejects(fsp.stat(partial),{code:'ENOENT'});
    assert.deepEqual(await fsp.readdir(path.join(c.dir,'scene-preview-work')),[]);
    assert.equal((await c.request(`/stream?hash=${hash}&index=0`)).status,410);
  });
});

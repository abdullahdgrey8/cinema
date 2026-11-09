import {Worker} from 'node:worker_threads';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {bootstrapNeeded,NeedMoreScenePrefix,MAX_SCENE_BOOTSTRAP_READ} from './scene-mp4-index.mjs';
import {createVerifiedScenePieces,matchSceneTorrentFile,readSceneMetainfo} from './scene-torrent-proof.mjs';
import {buildSceneClip} from './scene-clip.mjs';

const ATTEMPT_MS = 15_000;
const FETCH_ATTEMPT_MS = 22_000;
const LEASE_MS = 6_000;
const RUNWAY_MARGIN_MS = 4_000;
const MAX_ADMISSION_AGE_MS = 2_000;
const PIECE_PUBLICATION_MS = 2_000;
const INDEX_MS = 3000;
const COPY_MS = 4000;
const FFMPEG_MS = 6000;
const FFPROBE_MS = 3000;
const rootName = 'scene-preview-work';
const folderPattern = /^clip-[a-zA-Z0-9]{6}$/;
const removed = Object.assign(Error('The playback source changed.'),{code:'scene-changed'});
const deadlines = (signal,ms) => AbortSignal.any([signal,AbortSignal.timeout(ms)]);
const problem = (code,message) => Object.assign(Error(message),{code});

function copyStorageError() {
  return problem('scene-unavailable','Cinema could not open its temporary preview storage.');
}

async function scratchRoot(local) {
  await fsp.mkdir(local,{recursive:true});
  const parent = await fsp.realpath(local), root = path.join(parent,rootName);
  await fsp.mkdir(root).catch(error=>{ if(error.code!=='EEXIST')throw error; });
  const [stamp,real] = await Promise.all([fsp.lstat(root),fsp.realpath(root)]);
  if (!stamp.isDirectory() || stamp.isSymbolicLink() || real!==root) throw copyStorageError();
  return root;
}

async function cleanScratch(root,folder) {
  if (path.dirname(folder)!==root || !folderPattern.test(path.basename(folder))) return;
  const [stamp,real] = await Promise.all([fsp.lstat(folder),fsp.realpath(folder)]).catch(()=>[]);
  if (!stamp?.isDirectory() || stamp.isSymbolicLink() || real!==folder) return;
  // This dedicated directory contains only the app-generated preview MP4.
  await fsp.unlink(path.join(folder,'preview.mp4')).catch(error=>{ if(error.code!=='ENOENT')throw error; });
  await fsp.rmdir(folder).catch(error=>{ if(error.code!=='ENOENT')throw error; });
}

async function prepareScratch(local) {
  const root = await scratchRoot(local);
  for (const name of await fsp.readdir(root)) {
    if (folderPattern.test(name)) await cleanScratch(root,path.join(root,name)).catch(()=>{});
  }
  return root;
}

async function readBootstrap(pieces,states,size,signal) {
  let bytes = Buffer.alloc(0), length = 0;
  for (;;) {
    signal.throwIfAborted();
    let needed;
    try {
      needed = bootstrapNeeded(bytes.subarray(0,length),size);
      if (needed===length) return bytes.subarray(0,length);
    } catch(error) {
      if (!(error instanceof NeedMoreScenePrefix)) throw problem('scene-unsupported','The video index is unsupported.');
      needed = error.minimumBytes;
    }
    if (needed<=length) throw problem('scene-unverified','The video index did not advance.');
    if (needed>bytes.length) {
      const expanded = Buffer.allocUnsafe(needed);
      bytes.copy(expanded,0,0,length);
      bytes = expanded;
    }
    while (length<needed) {
      const end = Math.min(needed,length+MAX_SCENE_BOOTSTRAP_READ);
      const segment = await pieces.read(length,end,states,signal);
      signal.throwIfAborted();
      if (segment.length!==end-length) throw problem('scene-unverified','The video index read was incomplete.');
      segment.copy(bytes,length);
      length = end;
    }
  }
}

export function indexScene(prefix,sourceSize,targetMs,signal,{playheadMs}={}) {
  signal.throwIfAborted();
  const transferable = Uint8Array.from(prefix);
  return new Promise((resolve,reject)=>{
    const worker = new Worker(new URL('./scene-preview-worker.mjs',import.meta.url),{
      workerData:{prefix:transferable,sourceSize,targetMs,playheadMs},transferList:[transferable.buffer],
      resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4},
    });
    let result,failure;
    const abort = () => { void worker.terminate().catch(()=>{}); };
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
    worker.once('message',message=>{result=message;});
    worker.once('error',error=>{failure=error;});
    worker.once('exit',code=>{
      signal.removeEventListener('abort',abort);
      if (signal.aborted) return reject(signal.reason);
      if (failure || code!==0) return reject(problem('scene-unavailable','Cinema could not read this scene index.'));
      if (!result?.scene) return reject(problem('scene-unsupported','This video does not support a preview at that time.'));
      resolve(result.scene);
    });
  });
}

async function fetchScenePieces({scheduler,selection,scene,pieces,states,hash,index,size,check,signal}) {
  const unavailable = () => problem('scene-fetch-unavailable','The scene fetch engine could not schedule this preview.');
  const shortRunway = () => problem('scene-runway','The current video needs more verified buffer.');
  const end = Math.min(scene.foreground?.throughMs??0,selection.bufferedUntilMs);
  const covers = (now,remaining) => end - (selection.playheadMs + now-selection.sampledAt) >= remaining + RUNWAY_MARGIN_MS;
  const canStart = now => now-selection.sampledAt<=MAX_ADMISSION_AGE_MS && covers(now,LEASE_MS);
  if (!canStart(performance.now())) throw shortRunway();
  const available = await states();
  check();
  const plan = pieces.fetchPlan(scene.ranges,scene.foreground,available);
  if (!plan) {
    // Ordinary downloading may have reached the scene while the engine was checked.
    try { await pieces.admit(scene.ranges,available,deadlines(signal,COPY_MS)); return; }
    catch (error) { if (error.code!=='scene-missing') throw error; }
    throw shortRunway();
  }
  const started = performance.now();
  if (!canStart(started)) throw shortRunway();
  let current,id,cutoff=started+LEASE_MS;
  try {
    current = await scheduler.request({hash,index,size,...plan});
    id = current?.id;
    check();
    if (!id) throw unavailable();
    while (current) {
      const now = performance.now();
      cutoff = Math.min(cutoff,now+current.ttlMs);
      if (now>=cutoff) break;
      if (!covers(now,cutoff-now) || !pieces.hasRunway(plan.reserve,await states())) throw shortRunway();
      check();
      if (performance.now()>=cutoff) break;
      if (current.state==='complete') return;
      await delay(150,undefined,{signal});
      check();
      if (performance.now()>=cutoff) break;
      current = await scheduler.status(hash,id);
      check();
    }
    throw unavailable();
  } finally {
    if (id) await scheduler.cancel(hash,id).catch(()=>{});
  }
}

async function admitFetchedScene({scene,pieces,states,check,signal}) {
  // The lease reads live libtorrent state. qB's ordinary piece snapshot can
  // lag behind that result by its refresh interval. Observe, never reissue.
  const publication = deadlines(signal,PIECE_PUBLICATION_MS);
  try {
    for (;;) {
      const available = await states(publication);
      publication.throwIfAborted();
      check();
      pieces.recheck(available);
      try { await pieces.admit(scene.ranges,available,deadlines(signal,COPY_MS)); return; }
      catch (error) { if (error.code!=='scene-missing') throw error; }
      await delay(125,undefined,{signal:publication});
    }
  } catch (error) {
    check();
    if (publication.aborted) throw problem('scene-fetch-unavailable','The engine has not published the verified scene yet.');
    throw error;
  }
}

export function createScenePreview({local,bind}) {
  let slot, root;
  function prepareRoot(){
    root ??= prepareScratch(local).catch(()=>{root=undefined;return null;});
    return root;
  }
  void prepareRoot();

  function cancel(hash) {
    if (slot && (!hash || slot.hash===hash)) {
      slot.control.abort(removed);
      return slot.closed;
    }
  }

  async function prepare(lease,owner,{index,targetMs,foreground},signal) {
    let source,folder,scratch;
    function check() {
      signal.throwIfAborted();
      owner.assertCurrent();
    }
    try {
      check();
      source = await owner.open(signal);
      check();
      const {reader,handle,file,validate,scheduler} = source;
      const hash = lease.hash, params = {hash};
      const properties = await reader.json('torrents/properties',params);
      const metadata = await readSceneMetainfo(await reader.raw('torrents/export',params),{hash,properties,signal});
      check();
      const selected = matchSceneTorrentFile(metadata,file);
      const pieces = createVerifiedScenePieces({metadata,file:selected,handle,signal});
      const states = phaseSignal => reader.json('torrents/pieceStates',params,phaseSignal);
      const opening = await states();
      const prefix = await readBootstrap(pieces,opening,selected.size,deadlines(signal,COPY_MS));
      check();
      const scene = await indexScene(prefix,selected.size,targetMs,deadlines(signal,INDEX_MS),{playheadMs:foreground?.playheadMs});
      check();
      const available = await states();
      pieces.recheck(available);
      try { await pieces.admit(scene.ranges,available,deadlines(signal,COPY_MS)); }
      catch (error) {
        if (error.code!=='scene-missing'||!scheduler) throw error;
        if (!await scheduler.available()) throw error;
        check();
        if (!foreground) { error.canFetch=true; throw error; }
        await validate();
        check();
        await fetchScenePieces({scheduler,selection:foreground,scene,pieces,states,hash,index,size:selected.size,check,signal});
        await admitFetchedScene({scene,pieces,states,check,signal});
      }
      pieces.recheck(await states());
      await validate();
      check();
      scratch = await prepareRoot();
      if (!scratch) throw copyStorageError();
      check();
      folder = await fsp.mkdtemp(path.join(scratch,'clip-'));
      const clip = await buildSceneClip({scene,pieces,sourceSize:selected.size,targetMs,folder,signal,
        copySignal:deadlines(signal,FFMPEG_MS),probeMs:FFPROBE_MS});
      check();
      pieces.recheck(await states());
      await validate();
      check();
      return clip;
    } finally {
      try { await source?.handle.close(); }
      finally { if (folder) await cleanScratch(scratch,folder); }
    }
  }

  async function start(identity,{signal}={}) {
    const owner = bind(identity);
    if (slot) {
      if (slot.hash===identity.hash) cancel(slot.hash);
      throw problem('scene-busy','Another scene is finishing. Try again in a moment.');
    }
    const control = new AbortController();
    let close;
    const lease = {control,hash:identity.hash,closed:new Promise(resolve=>{close=resolve;})};
    slot = lease;
    try {
      const attempt = deadlines(signal ? AbortSignal.any([control.signal,signal]) : control.signal,
        identity.foreground?FETCH_ATTEMPT_MS:ATTEMPT_MS);
      const result = await prepare(lease,owner,identity,attempt);
      attempt.throwIfAborted();
      owner.assertCurrent();
      return result;
    } finally {
      if (slot===lease) slot=undefined;
      close();
    }
  }

  return {start,cancel};
}

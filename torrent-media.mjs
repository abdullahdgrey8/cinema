import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {createScenePreview} from './scene-preview.mjs';
import {atomicWriteLocalJson} from './source-memory.mjs';
import {audioMaster,audioMasterName,audioManifestDigest,audioMediaFile,audioRenditionRoles,audioStartAlignment,
  descriptionAudioOrdinal,descriptionProbeExecutable,descriptionTeeMux,plausibleCompletedDescription,readAudioRendition,validAudioSegment} from './hls-audio.mjs';

const VIDEO = /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg|ogv)$/i;
const STARTUP_BYTES=512*1024;
const INDEX_PRIORITY_WAIT_MS=2250;
const INDEX_PRIORITY_RETRY_MS=7500;
const VIEWER_GRACE_MS=6500;
const WARM_LEASE_MS=75000;
const RESCUE_LEASE_MS=45000;
const RESCUE_PROBE_MS=5000;
const FAST_START_MAX_BYTES=6*1024*1024;
const FAST_START_LEASE_MS=16000;
const FAST_START_ADOPTION_MS=5000;
const COPY_WAIT_CONFIRM_MS=150;
const APPOINTMENT_PROBE_MS=2500;
const DESCRIPTION_PROBE_MS=1250;
const COMPLETED_DESCRIPTION_HANDOFF_MS=100;
const DESCRIPTION_PROBE_OUTPUT=64*1024;
const DESCRIPTION_SOURCE_PREFIX=64*1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));
function error(message, status = 400) { return Object.assign(new Error(message), {status}); }
function validHash(hash) { if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(hash || '')) throw error('Invalid torrent identifier'); return hash.toLowerCase(); }

export function sameDialogueObject(a,b,platform=process.platform) {
  // Windows path stat can report device 0 even when fstat on the same
  // file returns a real volume ID. The seal uses the open handle's ID.
  return Boolean(a&&b&&a.ino!==0n&&a.ino===b.ino&&a.birth===b.birth&&
    (a.dev===b.dev||platform==='win32'&&(a.dev===0n||b.dev===0n)));
}

export function openingCopyEvidence(session,transfers,playlist){
  if(!session.child||!session.run||!session.copyVideo||session.forceVideoEncode||session.readyAt||
    !(session.item?.f.progress<1)||!(session.segments<2)||!(session.generatedDuration-session.publishedDuration>=6)||
    (playlist===null?session.playlist!==null:
      typeof playlist!=='string'||!playlist.startsWith('#EXTM3U')||playlist.includes('#EXT-X-ENDLIST')))return null;
  const readers=[...(transfers||[])].filter(reader=>reader.internal&&reader.index===session.index&&
    reader.converterChild===session.child&&reader.converterRun===session.run);
  if(readers.length!==1)return null;
  const [reader]=readers,wait=reader.waiting;
  return wait&&reader.copyWait===wait?{child:session.child,run:session.run,reader,wait,playlist}:null;
}

export function sameOpeningCopyEvidence(previous,current){
  return Boolean(previous&&current&&previous.child===current.child&&previous.run===current.run&&
    previous.reader===current.reader&&previous.wait===current.wait&&previous.playlist===current.playlist);
}
function inside(base, target) { const relative = path.relative(base, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); }
function rangeFor(header, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw error('Empty media file', 416);
  if (!header) return {start:0, end:size-1, partial:false};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw error('Invalid byte range',416);
  const start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) throw error('Invalid byte range',416);
  return {start,end,partial:true};
}

// FFmpeg on Windows can exit successfully after a playlist rename collided
// with a reader. Recover only a complete, closed manifest after encoder exit;
// never serve a still-being-written .tmp file or invent an end-of-video marker.
export async function publishCompletedManifest(folder,{sourceComplete,duration=0,published=''}={}) {
  if(!sourceComplete)return published;
  const temp=path.join(folder,'index.m3u8.tmp'),target=path.join(folder,'index.m3u8');
  const candidate=await fsp.readFile(temp,'utf8').catch(()=>null);if(!candidate)return published;
  const seconds=text=>[...text.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum,m)=>sum+Number(m[1]),0);
  if(!candidate.startsWith('#EXTM3U')||!candidate.includes('#EXT-X-ENDLIST')||seconds(candidate)<Number(duration||0)-2||seconds(candidate)<seconds(published))return published;
  const entries=candidate.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  if(!entries.length||entries.length!==(candidate.match(/^#EXTINF:/gm)||[]).length||new Set(entries).size!==entries.length||entries.some(name=>!/^seg\d{6}\.ts$/.test(name)))return published;
  for(const name of entries){const stat=await fsp.lstat(path.join(folder,name)).catch(()=>null);if(!stat?.isFile()||stat.size<188)return published;}
  for(let attempt=0;attempt<6;attempt++) {
    try{await fsp.rename(temp,target);return candidate;}
    catch(e){if(!['EACCES','EPERM','EBUSY'].includes(e.code)||attempt===5)return published;await delay(80);}
  }
  return published;
}

// Torrent offsets must include padding omitted by some versions of torrents/files.
// A file's piece_range alone does not reveal its offset within the first piece.
function bdecode(buffer) {
  let pos=0, nodes=0;
  function read(depth=0) {
    if (++nodes > 2000000 || depth > 100 || pos >= buffer.length) throw error('Invalid torrent metadata');
    const byte=buffer[pos++];
    if (byte===105) { const end=buffer.indexOf(101,pos); if(end<0)throw error('Invalid torrent integer');const n=Number(buffer.toString('ascii',pos,end));pos=end+1;if(!Number.isSafeInteger(n))throw error('Invalid torrent size');return n; }
    if (byte===108 || byte===100) {
      const value=byte===108?[]:Object.create(null);
      while (buffer[pos]!==101) { if(pos>=buffer.length)throw error('Invalid torrent collection');if(byte===108)value.push(read(depth+1));else {const key=read(depth+1);if(!Buffer.isBuffer(key))throw error('Invalid torrent key');value[key.toString('utf8')]=read(depth+1);} }
      pos++;return value;
    }
    if(byte>=48 && byte<=57) {pos--;const colon=buffer.indexOf(58,pos);if(colon<0)throw error('Invalid torrent string');const n=Number(buffer.toString('ascii',pos,colon));if(!Number.isSafeInteger(n)||n<0||colon+1+n>buffer.length)throw error('Invalid torrent string length');pos=colon+1+n;return buffer.subarray(colon+1,pos);}
    throw error('Invalid torrent metadata');
  }
  return read();
}
function metadataFiles(buffer) {
  const info=bdecode(buffer).info;
  if(!info || !Number.isSafeInteger(info['piece length']) || info['piece length']<=0)throw error('Torrent has no piece layout');
  const pieceSize=info['piece length'];const entries=[];let offset=0;
  const text=value=>Buffer.isBuffer(value)?value.toString('utf8'):String(value||'');
  const add=(name,size,padding=false)=>{if(!Number.isSafeInteger(size)||size<0)throw error('Invalid file size');entries.push({name,size,offset,padding});offset+=size;};
  if(Array.isArray(info.files)) {
    for(const f of info.files) {const name=(f['path.utf-8']||f.path||[]).map(text).join('/');add(name,f.length,text(f.attr).includes('p'));}
  } else if(info['file tree']) {
    function walk(tree,prefix='') {
      for(const key of Object.keys(tree).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))) {
        if(key==='') {const f=tree[key];if(f.length>0)offset=Math.ceil(offset/pieceSize)*pieceSize;add(prefix,f.length,text(f.attr).includes('p'));}
        else walk(tree[key],prefix?prefix+'/'+key:key);
      }
    }
    walk(info['file tree']);
  } else if(Number.isSafeInteger(info.length))add(text(info['name.utf-8']||info.name),info.length);
  else throw error('Torrent file layout unavailable');
  return {pieceSize,entries,rootName:text(info['name.utf-8']||info.name)};
}

export function releaseProbeFacts(probe) {
  const streams=probe?.streams;
  if(!Array.isArray(streams))return null;
  const video=streams.find(stream=>stream?.codec_type==='video');
  if(!video)return null;
  const audio=streams.find(stream=>stream?.codec_type==='audio');
  const codec=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_]{0,23}$/i.test(value)?value.toLowerCase():null;
  const dimension=value=>Number.isInteger(value)&&value>0&&value<=32768?value:null;
  return {videoCodec:codec(video.codec_name),audioCodec:codec(audio?.codec_name),width:dimension(video.width),height:dimension(video.height)};
}

export function createMedia({qb, rawQb, sceneReader, sceneEpoch=()=>null, local, origin, internalToken, pieceWaitMs=180000, cacheReserved=()=>false, now=Date.now}) {
  const hlsRoot=path.join(local,'hls');
  const sessions=new Map(), layouts=new Map(), pieceCache=new Map(), children=new Set();
  const telemetrySnapshots=new Map(), pendingPieces=new Map(), writingRuns=new Set(), readingRuns=new Map();
  const activeStreams=new Map(), cancelledHashes=new Set();
  const priorities=new Map(), priorityLocks=new Map(), priorityChecks=new Map();
  const priorityFile=path.join(local,'stream-priorities.json');
  let priorityWrite=Promise.resolve();
  let stopping=false, activeTranscode=null, preferencesCache=null, nextPrioritySweep=0;
  let ordinarySelection=0, pendingSelections=0, warmLease=null;
  let rescueCheckActive=null, rescueProposal=null, fastStartAdoption=null;
  let appointmentObserver=null, appointmentProbe=null, appointmentWarmWork=0;
  const appointmentSecret=randomBytes(32), appointmentCodecs=new Map(), appointmentRemovals=new Set();
  const ready=fsp.mkdir(hlsRoot,{recursive:true});
  const roleExecutable=descriptionProbeExecutable();
  let roleProbe=null;
  let sceneForeground=null, sceneGeneration=0;
  const scenePreview=createScenePreview({local,bind:bindScenePreview});
  function selectSceneForeground(session=null){
    sceneForeground=session;
    void scenePreview.cancel();
    return ++sceneGeneration;
  }

  function priorityLock(hash,work) {
    const previous=priorityLocks.get(hash)||Promise.resolve();
    const next=previous.catch(()=>{}).then(work);priorityLocks.set(hash,next);
    next.finally(()=>{if(priorityLocks.get(hash)===next)priorityLocks.delete(hash);}).catch(()=>{});
    return next;
  }
  function savePriorities() {
    const entries=structuredClone([...priorities.values()]);
    const next=priorityWrite.catch(()=>{}).then(async()=>{await ready;await atomicWriteLocalJson(priorityFile,entries);});
    priorityWrite=next;return next;
  }
  async function restorePriority(hash) {
    const saved=priorities.get(hash);if(!saved)return;
    let current;
    try {current=await snapshot(hash);}catch(e){if(e.status!==404)throw e;priorities.delete(hash);await savePriorities();return;}
    // Preserve priority changes made by the user in qBittorrent while playing.
    for(const entry of saved.files) {
      const file=current.all.find(f=>f.index===entry.index);
      if(file && file.priority===entry.applied && file.priority!==entry.priority)await qb('torrents/filePrio',{hash,id:entry.index,priority:entry.priority},'POST');
    }
    if(saved.seq===false && current.t.seq_dl===true)await qb('torrents/toggleSequentialDownload',{hashes:hash},'POST');
    if((saved.firstLast===false && current.t.f_l_piece_prio===true) || (saved.firstLast===true && saved.edgeRefreshPending && current.t.f_l_piece_prio===false))
      await qb('torrents/toggleFirstLastPiecePrio',{hashes:hash},'POST');
    priorities.delete(hash);await savePriorities();
  }
  const priorityReady=(async()=>{
    const saved=await fsp.readFile(priorityFile,'utf8').then(JSON.parse).catch(()=>[]);
    for(const entry of Array.isArray(saved)?saved:[]) {
      if(!entry||!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(entry.hash||'') || !Array.isArray(entry.files))continue;
      if(!entry.files.every(f=>f&&Number.isSafeInteger(f.index)&&f.index>=0&&[0,1,6,7].includes(f.priority)&&[0,1,6,7].includes(f.applied)))continue;
      priorities.set(entry.hash,entry);
    }
    // An interrupted process must not leave the rest of a season deselected.
    for(const hash of priorities.keys())await priorityLock(hash,()=>restorePriority(hash)).catch(()=>{});
  })();
  async function focusDownload(item) {
    await priorityReady;
    return priorityLock(item.hash,async()=>{
      const previous=priorities.get(item.hash);
      if(previous?.index===item.f.index){if(/^(?:stopped|paused|queued)DL$/.test(item.t.state))await qb('torrents/start',{hashes:item.hash},'POST');return;}
      if(previous)await restorePriority(item.hash);
      item=await info(item.hash,item.f.index);
      if(item.f.progress>=1)return;
      // qBittorrent raises edge pieces to 7. Preserve a lone file's normal or
      // high priority so we do not trigger a needless disk priority update.
      const selectedPriority=item.all.length===1&&[1,6].includes(item.f.priority)?item.f.priority:6;
      const saved={hash:item.hash,index:item.f.index,seq:item.t.seq_dl,firstLast:item.t.f_l_piece_prio,files:item.all.map(f=>({index:f.index,priority:f.priority,applied:f.index===item.f.index?selectedPriority:(f.progress<1?0:f.priority)}))};
      priorities.set(item.hash,saved);await savePriorities();
      // Sequential mode can ignore high file priorities. Exclude sibling files
      // temporarily so the piece picker actually starts at the chosen episode.
      try {
        const deferred=saved.files.filter(f=>f.applied===0&&f.priority!==0).map(f=>f.index);
        if(deferred.length)await qb('torrents/filePrio',{hash:item.hash,id:deferred.join('|'),priority:0},'POST');
        if(item.f.priority!==selectedPriority)await qb('torrents/filePrio',{hash:item.hash,id:item.f.index,priority:selectedPriority},'POST');
        if(!item.t.seq_dl)await qb('torrents/toggleSequentialDownload',{hashes:item.hash},'POST');
        if(!item.t.f_l_piece_prio)await qb('torrents/toggleFirstLastPiecePrio',{hashes:item.hash},'POST');
        await qb('torrents/start',{hashes:item.hash},'POST');
      }catch(e){await restorePriority(item.hash).catch(()=>{});throw e;}
    });
  }

  async function torrent(hash) {
    const list=await qb('torrents/info',{hashes:validHash(hash)});const value=list.find(t=>t.hash?.toLowerCase()===hash.toLowerCase())||list[0];
    if(!value)throw error('This download was removed from qBittorrent.',404);return value;
  }
  async function snapshot(hash) {
    const [t,all]=await Promise.all([torrent(hash),qb('torrents/files',{hash})]);
    return {t,all:Array.isArray(all)?all:[]};
  }
  function telemetrySnapshot(hash) {
    // Share a single read across scheduler tasks for this hash. Mutations,
    // byte readers, and completion validation still call snapshot directly.
    const recent=telemetrySnapshots.get(hash);
    if(recent && (!recent.at || Date.now()-recent.at<450))return recent.promise;
    const entry={at:0,promise:null};
    entry.promise=snapshot(hash).then(value=>{entry.at=Date.now();return value;},failure=>{
      if(telemetrySnapshots.get(hash)===entry)telemetrySnapshots.delete(hash);
      throw failure;
    });
    telemetrySnapshots.set(hash,entry);
    if(telemetrySnapshots.size>128) {
      for(const [key,value] of telemetrySnapshots)if(value.at && Date.now()-value.at>=450)telemetrySnapshots.delete(key);
    }
    return entry.promise;
  }
  async function layout(hash,all) {
    if(layouts.has(hash))return layouts.get(hash);
    let promise=(async()=>{
      try {
        const response=await rawQb('torrents/export',{hash});
        if(!response.ok)throw error('Cannot read torrent layout');
        const data=Buffer.from(await response.arrayBuffer());if(data.length>64*1024*1024)throw error('Torrent layout too large');
        const parsed=metadataFiles(data), candidates=parsed.entries.filter(f=>!f.padding);
        const offsets=new Map(),dialogueOffsets=new Map(),named=new Map();
        for(const entry of candidates){
          const key=entry.name+'\0'+entry.size;
          named.set(key,named.has(key)?null:entry);
        }
        for(let i=0;i<all.length;i++) {
          const f=all[i],name=f.name.replaceAll('\\','/');
          let entry=parsed.entries.find(e=>e.size===f.size&&(name===e.name||name.endsWith('/'+e.name)));
          // Renaming files or the torrent root changes names, but not metadata order.
          if(!entry)entry=(all.length===parsed.entries.length?parsed.entries:candidates)[i];
          if(!entry||entry.size!==f.size)continue;
          const first=Math.floor(entry.offset/parsed.pieceSize),last=Math.floor((entry.offset+Math.max(0,f.size-1))/parsed.pieceSize);
          if(f.piece_range && (first!==f.piece_range[0] || last!==f.piece_range[1]))continue;
          offsets.set(f.index,entry.offset);
          const rootPrefix=parsed.rootName+'/';
          const directKey=name+'\0'+f.size, rootKey=name.startsWith(rootPrefix)?name.slice(rootPrefix.length)+'\0'+f.size:null;
          const names=[directKey,rootKey].filter(key=>key&&named.has(key));
          if(names.length===1&&named.get(names[0])===entry)dialogueOffsets.set(f.index,{name,size:f.size});
        }
        return {pieceSize:parsed.pieceSize,offsets,dialogueOffsets};
      } catch {
        const properties=await qb('torrents/properties',{hash});
        const size=Number(properties.piece_size), offsets=new Map(), dialogueOffsets=new Map();
        if(all.length===1 && (!all[0].piece_range || all[0].piece_range[0]===0)){
          const file=all[0];
          offsets.set(file.index,0);
          if(typeof file.name==='string')dialogueOffsets.set(file.index,{name:file.name.replaceAll('\\','/'),size:file.size});
        }
        return {pieceSize:Number.isSafeInteger(size)&&size>0?size:0,offsets,dialogueOffsets};
      }
    })();
    layouts.set(hash,promise);
    try {
      const result=await promise;
      if(result.offsets.size<all.length){const timer=setTimeout(()=>{if(layouts.get(hash)===promise)layouts.delete(hash);},3000);timer.unref();}
      return result;
    }catch(e){layouts.delete(hash);throw e;}
  }
  async function info(hash,index,{telemetry=false}={}) {
    hash=validHash(hash);if(!Number.isSafeInteger(Number(index)) || Number(index)<0)throw error('Invalid video file');
    const {t,all}=await (telemetry?telemetrySnapshot(hash):snapshot(hash));const f=all.find(f=>f.index===Number(index));
    if(!f || !VIDEO.test(f.name))throw error('No playable video at this file index.',404);
    if(path.isAbsolute(f.name) || !inside(path.resolve(t.save_path||'.'),path.resolve(t.save_path||'.',f.name)))throw error('Invalid media path',403);
    const map=await layout(hash,all);return {hash,t,all,f,pieceSize:map.pieceSize,offset:map.offsets.get(f.index),dialogueOffset:map.dialogueOffsets.get(f.index)};
  }
  async function pieces(hash,fresh=false) {
    const previous=pieceCache.get(hash);
    if(previous && !fresh && Date.now()-previous.at<600)return previous.value;
    const read=async()=>{
      const value=await qb('torrents/pieceStates',{hash});
      if(!Array.isArray(value))throw error('qBittorrent did not provide piece availability.',503);
      return value;
    };
    // Completion never trusts a cached view of which bytes are present.
    if(fresh)return read();
    const pending=pendingPieces.get(hash);
    if(pending)return pending;
    const promise=read().then(value=>{
      if(pendingPieces.get(hash)===promise)pieceCache.set(hash,{at:Date.now(),value});
      return value;
    }).finally(()=>{if(pendingPieces.get(hash)===promise)pendingPieces.delete(hash);});
    pendingPieces.set(hash,promise);
    return promise;
  }
  async function preferences() {
    if(!preferencesCache || Date.now()-preferencesCache.at>30000) {
      const value=await qb('app/preferences').catch(()=>({}));preferencesCache={at:Date.now(),value};
    }
    return preferencesCache.value;
  }
  async function resolvePath(item,refresh=true,observedPreferences) {
    const prefs=observedPreferences??await preferences();const roots=[item.t.download_path,item.t.save_path,prefs.temp_path_enabled?prefs.temp_path:null].filter(Boolean).map(p=>path.resolve(p));
    const candidates=[];
    for(const base of roots) {const p=path.resolve(base,item.f.name);if(inside(base,p))candidates.push({base,p});}
    if(item.all.length===1 && item.t.content_path) {
      const p=path.resolve(item.t.content_path);const base=roots.find(base=>inside(base,p));if(base)candidates.push({base,p});
    }
    for(const {base,p} of candidates)for(const candidate of [p,p+'.!qB']) {
      try {
        const [realBase,real]=await Promise.all([fsp.realpath(base),fsp.realpath(candidate)]);
        if(!inside(realBase,real))throw error('Invalid media path',403);
        if((await fsp.stat(real)).isFile())return real;
      }catch(e) {if(e.status===403)throw e; /* qBittorrent may currently be creating, moving or renaming it. */ }
    }
    if(refresh) {
      const current=await snapshot(item.hash);const file=current.all.find(f=>f.index===item.f.index);
      if(file && (file.name!==item.f.name || current.t.save_path!==item.t.save_path || current.t.download_path!==item.t.download_path || current.t.content_path!==item.t.content_path)) {
        item.t=current.t;item.all=current.all;item.f=file;return resolvePath(item,false);
      }
    }
    throw error('Waiting for qBittorrent to create the video file on disk.',409);
  }
  async function buffer(item,{verifyComplete=false}={}) {
    if(item.f.progress>=1)return {bytes:item.f.size,ratio:1,target:Math.min(item.f.size,STARTUP_BYTES)};
    if(item.offset===undefined || !item.pieceSize)return {bytes:0,ratio:0,target:Math.min(item.f.size,STARTUP_BYTES)};
    const state=await pieces(item.hash,verifyComplete);let cursor=item.offset;
    const end=item.offset+Math.min(item.f.size,verifyComplete?Infinity:STARTUP_BYTES);
    while(cursor<end && state[Math.floor(cursor/item.pieceSize)]===2)cursor=Math.min(end,(Math.floor(cursor/item.pieceSize)+1)*item.pieceSize);
    const bytes=cursor-item.offset,target=Math.min(item.f.size,STARTUP_BYTES);return {bytes,target,ratio:target?clamp(bytes/target):0};
  }
  async function movieIndex(item) {
    if(item.f.progress>=1 || !/\.(mp4|m4v|mov)$/i.test(item.f.name))return {ready:true};
    if(item.offset===undefined||!item.pieceSize)return {ready:false,progress:0};
    const state=await pieces(item.hash);
    const lastPiece=Math.floor((item.offset+item.f.size-1)/item.pieceSize);
    const edgeStart=lastPiece-Math.ceil(item.f.size*.01/item.pieceSize)+1;
    const availability=(start,length)=>{
      let bytes=0,missingAt,unrequestedEdge;
      for(let cursor=start;cursor<start+length;) {
        const index=Math.floor((item.offset+cursor)/item.pieceSize),end=Math.min(start+length,(index+1)*item.pieceSize-item.offset);
        if(state[index]===2)bytes+=end-cursor;
        else {
          missingAt??=cursor;
          if(index>=edgeStart && state[index]===0)unrequestedEdge??=index;
        }
        cursor=end;
      }
      return {ready:bytes===length,progress:clamp(bytes/length),at:missingAt??start,unrequestedEdge};
    };
    let handle;
    try {
      handle=await fsp.open(await resolvePath(item),'r');
      for(let at=0,boxes=0;at+8<=item.f.size&&boxes++<1000;) {
        const headerState=availability(at,8);if(!headerState.ready)return headerState;
        const header=Buffer.alloc(16),result=await handle.read(header,0,Math.min(16,item.f.size-at),at);
        if(result.bytesRead<8)return {ready:false,progress:0,at};
        const kind=header.toString('ascii',4,8);let size=header.readUInt32BE(0);
        if(size===1){const wideHeader=availability(at,16);if(!wideHeader.ready)return wideHeader;const n=header.readBigUInt64BE(8);if(n>BigInt(Number.MAX_SAFE_INTEGER))return {ready:true};size=Number(n);}
        if(!size)size=item.f.size-at;
        if(size<8||at+size>item.f.size)return {ready:true}; // Let ffprobe diagnose malformed or non-ISO containers.
        if(kind==='moov')return availability(at,size);
        if(kind==='moof')return {ready:true};
        at+=size;
      }
      return {ready:true};
    }catch(e){if(e.status===409||e.code==='ENOENT')return {ready:false,progress:0};throw e;}
    finally {if(handle)await handle.close();}
  }

  async function fastStartOpening(item,fresh=false) {
    const limit=Math.min(item.f.size,FAST_START_MAX_BYTES), target=Math.min(item.f.size,STARTUP_BYTES);
    const waiting=()=>({waiting:true,message:'Waiting for the replacement’s verified opening bytes.'});
    let previewBytes=limit;
    if(item.f.progress<1){
      if(item.offset===undefined||!item.pieceSize)
        throw error('This replacement needs its exact torrent layout before Fast Start can check it.',422);
      const states=await pieces(item.hash,fresh);
      let cursor=item.offset;
      const end=cursor+limit;
      while(cursor<end&&states[Math.floor(cursor/item.pieceSize)]===2)
        cursor=Math.min(end,(Math.floor(cursor/item.pieceSize)+1)*item.pieceSize);
      previewBytes=cursor-item.offset;
      if(previewBytes<target)return waiting();
    }
    let stamp;
    try{stamp=await fileStamp(item);}
    catch(e){if(item.f.progress<1&&e.status===409)return waiting();throw e;}
    if(item.f.progress===1&&stamp.size!==BigInt(item.f.size))
      throw error('The replacement video is not readable from disk.',409);
    if(stamp.size<BigInt(previewBytes))return waiting();
    const missing=()=>{
      if(previewBytes<limit)return waiting();
      throw error('This replacement’s opening video index is outside the Fast Start preview.',422);
    };
    const opening={bytes:target,ratio:1,target};
    const result={opening,previewBytes,stamp};
    const handle=await fsp.open(stamp.filename,'r'), header=Buffer.alloc(16);
    try {
      let movie=false,media=false;
      for(let at=0,boxes=0;at<item.f.size&&boxes++<1000;){
        if(at+8>previewBytes)return missing();
        const {bytesRead}=await handle.read(header,0,Math.min(16,previewBytes-at),at);
        if(bytesRead<8)return missing();
        const kind=header.toString('ascii',4,8);
        let size=header.readUInt32BE(0),headerSize=8;
        if(size===1){
          if(at+16>previewBytes||bytesRead<16)return missing();
          const wide=header.readBigUInt64BE(8);
          if(wide>BigInt(Number.MAX_SAFE_INTEGER))return missing();
          size=Number(wide);headerSize=16;
        }
        if(!size)size=item.f.size-at;
        if(size<headerSize||size>item.f.size-at)
          throw error('This replacement has an unreadable MP4 opening.',422);
        if(kind==='mdat'&&size>headerSize&&at+headerSize<previewBytes){
          media=true;
          if(movie)return result;
        }
        if(at+size>previewBytes){
          if(at+size>limit)throw error('This replacement’s opening video index is outside the Fast Start preview.',422);
          return missing();
        }
        if(kind==='moov'){
          movie=true;
          if(media)return result;
        }
        // A fragment's moof must fit before its mdat, along with the init moov.
        if(kind==='moof'&&!movie)throw error('This replacement is missing its opening MP4 index.',422);
        at+=size;
      }
      return missing();
    }finally{await handle.close();}
  }

  async function refreshIndexPriority(session,item) {
    const piece=session.header.unrequestedEdge;
    if(session.indexPriorityRefreshed || (session.indexPriorityAttempts||0)>=2)return;
    if(piece===undefined){if(!session.indexPriorityAttempts)session.nextIndexPriorityAttempt=0;return;}
    const now=Date.now();
    session.nextIndexPriorityAttempt ||= now+INDEX_PRIORITY_WAIT_MS;
    if(now<session.nextIndexPriorityAttempt)return;
    session.nextIndexPriorityAttempt=now+INDEX_PRIORITY_RETRY_MS;
    const hash=item.hash;
    await priorityLock(hash,async()=>{
      const saved=priorities.get(hash);
      if(saved?.index!==session.index || session.cancelled || session.suspended || cancelledHashes.has(hash) || stopping)return;
      const current=await torrent(hash);
      if(!/^(?:downloading|stalledDL|forcedDL)$/.test(current.state) || current.seq_dl!==true)return;
      if(current.f_l_piece_prio!==true && !saved.edgeRefreshPending)return;
      if(!saved.edgeRefreshPending && (await pieces(hash,true))[piece]!==0)return;
      session.indexPriorityAttempts=(session.indexPriorityAttempts||0)+1;
      // libtorrent 1.2 can replace qBittorrent's edge priorities when the file
      // priority disk job completes. Reapply them after the needed tail piece
      // has stayed unscheduled, leaving sequential mode and files untouched.
      if(!saved.edgeRefreshPending){
        saved.edgeRefreshPending=true;
        try{await savePriorities();}catch(e){delete saved.edgeRefreshPending;throw e;}
      }
      try {
        if(current.f_l_piece_prio===true)await qb('torrents/toggleFirstLastPiecePrio',{hashes:hash},'POST');
      }finally {
        if((await torrent(hash)).f_l_piece_prio===false)await qb('torrents/toggleFirstLastPiecePrio',{hashes:hash},'POST');
      }
      delete saved.edgeRefreshPending;
      await savePriorities();
      session.indexPriorityRefreshed=true;
    });
  }
  async function files(hash) {
    hash=validHash(hash);const {all}=await snapshot(hash);if(!all.length)return [];
    const map=await layout(hash,all);
    return all.map(f=>({...f,playable:VIDEO.test(f.name),browserLikely:/\.(mp4|m4v|webm)$/i.test(f.name),progressive:map.offsets.has(f.index)&&map.pieceSize>0}));
  }

  async function plannerFile(hash) {
    hash=validHash(hash);
    try {
      const {t,all}=await snapshot(hash);
      if(t.hash?.toLowerCase()!==hash||/error|missingfiles|checking|moving/i.test(t.state||''))return null;
      const candidates=all.filter(file=>typeof file.name==='string'&&VIDEO.test(file.name)&&
        !/(?:^|[\\/._ -])sample(?:[\\/._ -]|$)/i.test(file.name));
      if(candidates.length!==1)return null;
      const f=candidates[0];
      if(f.progress!==1||!Number.isSafeInteger(f.index)||f.index<0||!Number.isSafeInteger(f.size)||f.size<=0||
        path.isAbsolute(f.name)||path.win32.isAbsolute(f.name))return null;
      const file=await resolvePath({hash,t,all,f},false);
      if((await fsp.stat(file)).size!==f.size)return null;
      return {index:f.index,fileName:f.name.split(/[\\/]/).at(-1),size:f.size};
    }catch(e){
      if([403,404,409].includes(e.status)||e.code==='ENOENT')return null;
      throw e;
    }
  }

  async function stream(req,res,url) {
    const hash=validHash(url.searchParams.get('hash'));
    const internal=Boolean(internalToken)&&url.searchParams.get('internal')===internalToken;
    if(!internal)abortAppointmentProbe();
    if(cancelledHashes.has(hash))throw error('Playback has stopped for this removed download.',410);
    let closed=false,handle=null,filename=null,lastState=0,state=[],settle;
    const completion=new Promise(resolve=>{settle=resolve;});
    const index=Number(url.searchParams.get('index')),run=url.searchParams.get('converterRun'),current=activeTranscode;
    const roleToken=url.searchParams.get('descriptionProbe');
    const role=internal&&req.method==='GET'&&roleToken&&roleProbe?.token===roleToken&&
      roleProbe.session.hash===hash&&roleProbe.session.index===index&&currentRoleProbe(roleProbe)?roleProbe:null;
    if(roleToken&&!role)throw error('Audio inspection is no longer current.',409);
    const converter=internal&&req.method==='GET'&&current?.child&&!current.stopRequested&&
      current.hash===hash&&current.index===index&&current.run===run?current:null;
    const transfer={res,completion,index,internal,waiting:null,copyWait:null,
      converterRun:converter?run:null,converterChild:converter?.child,cancel:()=>{onClose();res.destroy();}};
    const setCopyWait=wait=>{
      if(!converter||transfer.copyWait===wait)return;
      if(converter.copyFallbackCheck?.reader===transfer)clearCopyFallbackCheck(converter);
      transfer.copyWait=wait;
    };
    const onClose=()=>{closed=true;setCopyWait(null);};
    let transfers=activeStreams.get(hash);if(!transfers){transfers=new Set();activeStreams.set(hash,transfers);}transfers.add(transfer);
    if(converter?.copyFallbackCheck)clearCopyFallbackCheck(converter);
    res.on('close',onClose);
    try {
    const item=await info(hash,url.searchParams.get('index'));if(closed)return;
    if(role&&(!currentRoleProbe(role)||role.identity!==audioSourceIdentity(item)))throw error('Audio source changed.',409);
    const mappedAudio=converter?.audioRun;
    if(mappedAudio?.source&&mappedAudio.source.identity!==audioSourceIdentity(item)){
      retireChangedAudioSource(converter);
      throw error('Audio source changed.',409);
    }
    let requested;try {requested=rangeFor(req.headers.range,item.f.size);}catch(e){res.writeHead(416,{'Content-Range':`bytes */${item.f.size}`});res.end();return;}
    const sendHeaders=()=>{
      const ext=path.extname(item.f.name).toLowerCase();
      res.writeHead(requested.partial?206:200,{'Content-Type':({'.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska','.mov':'video/quicktime'})[ext]||'application/octet-stream','Content-Length':requested.end-requested.start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(requested.partial?{'Content-Range':`bytes ${requested.start}-${requested.end}/${item.f.size}`}:{})});
    };
    if(req.method==='HEAD'){sendHeaders();res.end();return;}
    if(role&&requested.start!==0)throw error('Audio inspection starts at the verified opening.',409);
    if(item.f.progress<1 && (item.offset===undefined||!item.pieceSize))throw error('The exact torrent layout is unavailable. Playback will start after this file completes.',409);
      for(let offset=requested.start;offset<=requested.end && !closed;) {
        // Never withhold an already verified piece because the next 256 KiB
        // HTTP chunk happens to straddle a still-missing torrent piece.
        const pieceEnd=item.f.progress<1&&item.offset!==undefined&&item.pieceSize?((Math.floor((item.offset+offset)/item.pieceSize)+1)*item.pieceSize-item.offset-1):Infinity;
        // Closing an internal HTTP reader looks like normal EOF to FFmpeg,
        // which can publish a falsely finished HLS movie. A peer stall has no
        // deadline: cancellation/disconnection still closes this reader.
        const end=Math.min(offset+256*1024-1,requested.end,pieceEnd);const deadline=internal?Infinity:Date.now()+pieceWaitMs;
        if(item.f.progress<1) {
          const first=Math.floor((item.offset+offset)/item.pieceSize),last=Math.floor((item.offset+end)/item.pieceSize);
          while(!closed) {
            if(Date.now()-lastState>650){
              try {state=await pieces(hash);lastState=Date.now();}
              catch(e){setCopyWait(null);if(internal&&(e.status>=500||e.status===401)){await delay(1000);continue;}throw e;}
            }
            const known=state.length>last?state.slice(first,last+1):[];
            if(known.length&&known.every(p=>p===2))break;
            transfer.waiting||={byteOffset:offset,pieceIndex:first,since:Date.now(),region:offset<STARTUP_BYTES?'opening':offset>=item.f.size*.9?'end':'middle'};
            // An incomplete piece vector or a daemon error cannot witness this wait.
            if(converter)setCopyWait(known.some(p=>p===0||p===1)?transfer.waiting:null);
            if(Date.now()>deadline)throw error('Buffering stopped: qBittorrent has not downloaded the next pieces. Resume the download or try again when more peers connect.',504);
            await delay(350);
          }
        }
        if(closed)break;
        setCopyWait(null);
        transfer.waiting=null;
        let bytesRead=0,bytes=Buffer.alloc(end-offset+1);
        while(!closed && !bytesRead) {
          try {
            if(!handle){
              filename=await resolvePath(item);
              if(closed)break;
              handle=await fsp.open(filename,'r');
              if(closed)break;
              if(mappedAudio?.source){
                const stat=await handle.stat({bigint:true}),stamp=dialogueFileStamp(filename,stat);
                if(!stat.isFile()||!audioSourceMatches(mappedAudio.source,stamp)){
                  retireChangedAudioSource(converter);
                  throw error('Audio source changed.',403);
                }
                // Even a seek or reconnect must read from the same verified opening.
                const sample=Buffer.alloc(mappedAudio.source.length);
                const {bytesRead}=await handle.read(sample,0,sample.length,0);
                if(bytesRead!==sample.length||audioPrefixDigest(sample)!==mappedAudio.source.digest){
                  retireChangedAudioSource(converter);
                  throw error('Audio source changed.',403);
                }
              }
            }
            ({bytesRead}=await handle.read(bytes,0,bytes.length,offset));
            if(!bytesRead){await handle.close();handle=null;}
          }catch(e){if(handle){await handle.close().catch(()=>{});handle=null;}if(['EACCES','EPERM'].includes(e.code))throw error('Cinema cannot read this video file. Check its file permissions.',403);if(e.status===403 || Date.now()>deadline)throw e;}
          if(!bytesRead){if(Date.now()>deadline)throw error('The downloaded video is not readable from disk yet.',409);await delay(350);}
        }
        if(closed)break;
        if(!res.headersSent){
          if(role&&!role.stamp){
            if(!currentRoleProbe(role))throw error('Audio inspection is no longer current.',409);
            const stat=await handle.stat({bigint:true});
            if(!stat.isFile()||stat.ino===0n||role.complete&&stat.size!==BigInt(item.f.size))throw error('Audio source changed.',409);
            const prefix=bytes.subarray(0,Math.min(bytesRead,DESCRIPTION_SOURCE_PREFIX));
            role.stamp=dialogueFileStamp(filename,stat);
            role.length=prefix.length;
            role.digest=audioPrefixDigest(prefix);
          }
          if(!internal)observeFastStart(item.hash+'-'+item.f.index);
          sendHeaders();
        }
        offset+=bytesRead;
        if(!res.write(bytes.subarray(0,bytesRead)))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
      }
      if(!closed)res.end();
    }finally {
      setCopyWait(null);
      res.off('close',onClose);if(handle)await handle.close().catch(()=>{});
      transfers.delete(transfer);if(!transfers.size&&activeStreams.get(hash)===transfers)activeStreams.delete(hash);
      settle();
    }
  }

  function sourceUrl(session,converterRun=null) {
    return `${origin}/stream?hash=${session.hash}&index=${session.index}&internal=${encodeURIComponent(internalToken)}${converterRun?'&converterRun='+converterRun:''}`;
  }
  function inputOptions(session) {
    // Matroska follows SeekHead entries for tags/attachments at arbitrary
    // offsets on seekable input. Those optional tail reads can block startup
    // until the download finishes. Its streaming path skips these seeks.
    // AVI similarly loads its tail idx1 whenever the input is seekable.
    // MP4 must remain seekable: a trailing moov atom is essential metadata.
    const progressive=session.item?.f.progress<1&&/\.(mkv|webm|avi|ts|m2ts|mpg|mpeg|ogv)$/i.test(session.item?.f.name||'');
    return [...(progressive?['-seekable','0']:[]),'-analyzeduration','1000000','-probesize',String(STARTUP_BYTES)];
  }
  function runProbe(session,{signal,timeoutMs=20000,localInput=null}={}) {
    if(session.cancelled||stopping||signal?.aborted)return Promise.reject(error('Playback preparation was cancelled.',409));
    return new Promise((resolve,reject)=>{
      session.probeAttempts=(session.probeAttempts||0)+1;
      const source=localInput?[
        '-protocol_whitelist','file','-f',localInput.format,
        ...(localInput.format==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),
        '-i',localInput.filename,
      ]:[sourceUrl(session)];
      const child=spawn(ffprobe.path,['-v','error',...inputOptions(session),'-show_streams','-show_format','-of','json',...source],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      children.add(child);session.probeChild=child;let output='',failure;
      const stop=reason=>{if(failure)return;failure=reason;child.kill();};
      const abort=()=>stop(error('Playback preparation was cancelled.',409));
      const timeout=setTimeout(()=>stop(error('Waiting for video headers and downloaded pieces.',409)),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
      child.stdout.on('data',data=>{
        if(failure)return;
        output+=data;if(output.length>2*1024*1024)stop(error('Video metadata is too large.',422));
      });
      child.stderr.resume();
      child.once('error',()=>{failure||=error('The video inspector could not start. Restart Cinema after checking its installation.',503);});
      child.once('close',code=>{
        clearTimeout(timeout);signal?.removeEventListener('abort',abort);
        children.delete(child);if(session.probeChild===child)session.probeChild=null;
        if(failure)return reject(failure);
        if(code!==0)return reject(error('Waiting for a readable video header. The source may still be downloading.',409));
        try{
          const result=JSON.parse(output);
          if(!result.streams?.some(s=>s.codec_type==='video'))throw error('This file does not contain a supported video stream.',422);
          resolve(result);
        }catch(e){reject(e.status?e:error('Unable to inspect this video.',422));}
      });
    });
  }
  function audioPrefixDigest(bytes){
    return createHash('sha256').update(bytes).digest('hex');
  }
  function audioSourceIdentity(item){
    return JSON.stringify([item.hash,item.f.index,item.f.name,item.f.size,item.offset,item.pieceSize]);
  }
  function audioSourceMatches(source,stamp){
    return source.complete?sameDialogueStat(source.stamp,stamp):
      sameDialogueObject(source.stamp,stamp)&&source.stamp.filename===stamp.filename;
  }
  function currentRoleProbe(job){
    const {session}=job;
    return !stopping&&!job.cancelled&&!session.cancelled&&!session.suspended&&sessions.get(session.key)===session&&
      session.requestOrder===job.order&&ordinarySelection===job.order;
  }
  function abortRoleProbe(session){
    const job=roleProbe;
    if(!job||session&&job.session!==session)return null;
    job.cancelled=true;
    job.child.kill();
    return job.closed;
  }
  function startRoleProbe(session,item){
    if(!roleExecutable||!internalToken||roleProbe||session.roleAttempted||session.cancelled||session.suspended||
      sessions.get(session.key)!==session||session.requestOrder!==ordinarySelection||
      !/\.mkv$/i.test(item.f.name)||item.t.hash?.toLowerCase()!==item.hash||
      !Number.isSafeInteger(item.f.size)||item.f.size<1)return;
    session.roleAttempted=true;
    const token=randomBytes(16).toString('hex');
    const query=sourceUrl(session)+'&descriptionProbe='+token;
    const input=new URL(query);
    if(input.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(input.hostname))return;
    const args=['-v','error','-protocol_whitelist','http,tcp','-f','matroska','-seekable','0','-analyzeduration','150000',
      '-probesize','131072','-show_entries','stream=index,codec_type,codec_name,profile,channels,sample_rate,start_time:stream_disposition=default,visual_impaired,dependent,attached_pic',
      '-of','json','-i',query];
    const started=performance.now();
    let child;
    try{child=spawn(roleExecutable,args,{windowsHide:true,stdio:['ignore','pipe','ignore']});}catch{return;}
    let settle;
    const closed=new Promise(resolve=>{settle=resolve;});
    const timing=session.audioRoleTiming={inspectionMs:null,waitMs:0,waitExpired:false};
    const job={session,order:session.requestOrder,identity:audioSourceIdentity(item),complete:item.f.progress===1,
      token,child,closed,cancelled:false,stamp:null,length:0,digest:null,timing};
    roleProbe=job;children.add(child);
    const timer=setTimeout(()=>{if(roleProbe===job)abortRoleProbe(session);},DESCRIPTION_PROBE_MS);
    timer.unref();
    let length=0;
    const output=[];
    child.stdout.on('data',chunk=>{
      if(job.cancelled)return;
      length+=chunk.length;
      if(length>DESCRIPTION_PROBE_OUTPUT)abortRoleProbe(session);
      else output.push(chunk);
    });
    child.once('error',()=>{job.cancelled=true;});
    child.once('close',code=>{
      clearTimeout(timer);children.delete(child);
      timing.inspectionMs=Math.round(performance.now()-started);
      if(roleProbe===job)roleProbe=null;
      if(code===0&&job.stamp&&job.length>0&&currentRoleProbe(job)){
        try{
          const metadata=JSON.parse(Buffer.concat(output,length).toString('utf8'));
          const {order,identity,complete,stamp,length:prefixLength,digest}=job;
          session.roleResult={order,identity,complete,stamp,length:prefixLength,digest,metadata};
        }catch{/* The ordinary packaged probe is the only opening gate. */}
      }
      settle();
    });
  }
  function takeRoleResult(session){
    const source=session.roleResult;
    abortRoleProbe(session);
    if(!source||source.order!==session.requestOrder||source.order!==ordinarySelection||
      source.identity!==audioSourceIdentity(session.item))return null;
    const ordinal=descriptionAudioOrdinal(source.metadata,session.probe);
    return ordinal===null?null:{source,ordinal};
  }
  function retireChangedAudioSource(session){
    // Never keep a track index from an earlier backing file. The ordinary
    // pipeline may inspect the new source again under its own existing gate.
    session.roleResult=null;
    session.probe=null;
    if(session.audioRun)session.audioRun.withdrawn=true;
    stopTranscode(session);
  }

  function directCompatible(item,probe) {
    const video=probe.streams.find(s=>s.codec_type==='video');const audio=probe.streams.find(s=>s.codec_type==='audio');
    if(/\.(mp4|m4v)$/i.test(item.f.name))return video.codec_name==='h264'&&['yuv420p','yuvj420p'].includes(video.pix_fmt||'yuv420p')&&(!audio||['aac','mp3'].includes(audio.codec_name));
    if(/\.webm$/i.test(item.f.name))return ['vp8','vp9','av1'].includes(video.codec_name)&&(!audio||['opus','vorbis'].includes(audio.codec_name));
    return false;
  }

  function warmIdentity(value) {
    const hash=validHash(value?.hash), index=Number(value?.index);
    if(value?.index===null||value?.index===undefined||!Number.isSafeInteger(index)||index<0||
      !/^[a-f\d]{32}$/i.test(value?.sessionId||''))throw error('Choose a current playback session.');
    return {hash,index,sessionId:value.sessionId};
  }
  function matchingSession(identity) {
    const session=sessions.get(identity.hash+'-'+identity.index);
    return session?.sessionId===identity.sessionId&&!session.cancelled&&!session.suspended&&
      !cancelledHashes.has(identity.hash)&&!stopping?session:null;
  }
  function warmSource(identity) {
    const session=matchingSession(identity);
    return session&&['buffering','converting','queued','ready'].includes(session.status)?session:null;
  }
  async function currentWarmFile(session) {
    const {t,all}=await snapshot(session.hash);
    const f=all.find(file=>file.index===session.index);
    if(t.hash?.toLowerCase()!==session.hash || /error|missingfiles|checking|moving/i.test(t.state||'') ||
       !f || f.name!==session.item?.f.name || f.size!==session.item?.f.size ||
       !Number.isSafeInteger(f.size) || f.size<=0 || path.isAbsolute(f.name) || path.win32.isAbsolute(f.name))
      throw error('This playback file has changed or is no longer available.',409);
    return {...session.item,hash:session.hash,t,all,f};
  }
  async function fileStamp(item) {
    const filename=await resolvePath(item,false);
    const stat=await fsp.stat(filename,{bigint:true});
    if(!stat.isFile())throw error('This playback file is unavailable.',409);
    return dialogueFileStamp(filename,stat);
  }
  function sameFile(a,b) {
    return a&&b&&a.filename===b.filename&&a.size===b.size&&a.dev===b.dev&&a.ino===b.ino&&a.mtime===b.mtime;
  }

  function appointmentError(message,status,code){return Object.assign(error(message,status),{code});}
  function appointmentChanged(){
    return appointmentError('This appointment file changed. Check it again before playing.',409,'appointment-file-changed');
  }
  function appointmentOpaque(fields){
    return createHmac('sha256',appointmentSecret).update(JSON.stringify(fields)).digest('hex');
  }
  function appointmentFile({all,t,hash}){
    if(t.hash?.toLowerCase()!==hash||/error|missingfiles|checking|moving/i.test(t.state||''))return null;
    const candidates=all.filter(f=>typeof f.name==='string'&&VIDEO.test(f.name)&&
      !/(?:^|[\\/._ -])sample(?:[\\/._ -]|$)/i.test(f.name));
    const f=candidates[0];
    return candidates.length===1&&dialogueName(f.name)&&Number.isSafeInteger(f.index)&&f.index>=0&&
      Number.isSafeInteger(f.size)&&f.size>0&&Number.isFinite(f.progress)&&f.progress>=0&&f.progress<=1?f:null;
  }
  async function appointmentSource(hash){
    if(appointmentRemovals.has(hash))return {reason:'missing'};
    try{
      const item={...await snapshot(hash),hash};
      if(appointmentRemovals.has(hash))return {reason:'missing'};
      if(/^meta/i.test(item.t.state||'')||!item.all.length)return {finding:true};
      const f=appointmentFile(item);
      return f?{item:{...item,f}}:{reason:'no-exact-file'};
    }catch(e){
      if(e.status===404)return {reason:'missing'};
      throw appointmentError('Reconnect qBittorrent to check this appointment.',503,'appointment-disconnected');
    }
  }
  function appointmentFileKey(item,epoch){
    return appointmentOpaque(['file',epoch,item.hash,item.f.index,item.f.name,item.f.size]);
  }
  function appointmentPlayKey(key,stamp){
    return appointmentOpaque(['play',key,stamp.filename,dialogueStat(stamp)]);
  }
  function sameAppointmentStamp(a,b){
    return sameFile(a,b)&&a.ctime===b.ctime&&a.birth===b.birth;
  }
  async function appointmentStamp(item){
    const stamp=await fileStamp(item).catch(()=>null);
    return stamp&&stamp.ino!==0n&&stamp.size===BigInt(item.f.size)?stamp:null;
  }
  function appointmentIdle(owner=null){
    return !stopping&&!activeTranscode&&!pendingSelections&&!children.size&&!activeStreams.size&&!readingRuns.size&&
      !rescueCheckActive&&!rescueProposal&&!fastStartAdoption&&!warmLease&&!appointmentWarmWork&&!dialogueReads&&
      (!appointmentProbe||appointmentProbe===owner)&&
      ![...sessions.values()].some(session=>now()-Math.max(session.lastObserved||0,session.lastRequested||0)<VIEWER_GRACE_MS);
  }
  function abortAppointmentProbe(hash){
    const job=appointmentProbe;
    job?.controller.abort();
    return hash!==undefined&&job?.hash===hash?job.closed:undefined;
  }
  function invalidateAppointments(){
    appointmentObserver?.controller.abort();
    abortAppointmentProbe();
    appointmentCodecs.clear();
    preferencesCache=null;
  }
  function beginAppointmentRemoval(hash){
    if(appointmentRemovals.has(hash))throw error('This download is already being removed.',409);
    appointmentRemovals.add(hash);
    markAppointmentRemoval(hash);
    return ()=>appointmentRemovals.delete(hash);
  }
  function markAppointmentRemoval(hash){
    if(appointmentObserver?.hashes.has(hash))appointmentObserver.removed.add(hash);
  }
  async function inspectAppointment(item,key,stamp,format,context){
    if(!context.allowProbe)return {reason:'check-needed'};
    if(!appointmentIdle())return {reason:'player-busy'};
    context.signal.throwIfAborted();
    const controller=new AbortController(),signal=AbortSignal.any([context.signal,controller.signal]);
    const probe=appointmentProbe={hash:item.hash,controller,closed:null};
    try{
      const inspection=runProbe({item},{signal,timeoutMs:APPOINTMENT_PROBE_MS,
        localInput:{format,filename:stamp.filename}});
      probe.closed=inspection.catch(()=>{});
      let result;
      try{result=await inspection;}catch{
        return {reason:signal.aborted?'player-busy':'probe-unavailable'};
      }
      if(signal.aborted||!appointmentIdle(probe))return {reason:'player-busy'};
      const {item:current}=await appointmentSource(item.hash);
      if(!current||current.f.progress!==1||appointmentFileKey(current,context.epoch)!==key)
        return {changed:true};
      const fresh=await appointmentStamp(current);
      if(!fresh||appointmentPlayKey(key,fresh)!==appointmentPlayKey(key,stamp))return {changed:true};
      if(signal.aborted||!context.isCurrent()||!appointmentIdle(probe))return {reason:'player-busy'};
      const direct=directCompatible(current,result);
      const proof=appointmentPlayKey(key,fresh);
      appointmentCodecs.delete(proof);
      appointmentCodecs.set(proof,direct);
      if(appointmentCodecs.size>16)appointmentCodecs.delete(appointmentCodecs.keys().next().value);
      return {direct};
    }finally{if(appointmentProbe===probe)appointmentProbe=null;}
  }
  async function observeAppointment(target,context){
    const {hash}=target;
    const base={hash,...(target.key?{key:target.key}:{})};
    const {item,finding,reason}=await appointmentSource(hash);
    context.signal.throwIfAborted();
    if(!item)return {...base,status:finding?'finding':'unavailable',...(reason?{reason}:{})};
    const key=appointmentFileKey(item,context.epoch), f=item.f;
    if(target.key&&target.key!==key)return {...base,status:'unavailable',reason:'file-changed'};
    const selection={hash,key,index:f.index,name:f.name.split(/[\\/]/).at(-1),size:f.size,
      downloaded:Math.floor(f.progress*f.size)};
    if(f.progress<1){
      if(/^(?:stopped|paused)/i.test(item.t.state||''))return {...selection,status:'paused'};
      return {...selection,status:'downloading'};
    }
    const stamp=await appointmentStamp(item);
    context.signal.throwIfAborted();
    if(!stamp)return {...selection,status:'unavailable',reason:'file-missing'};
    const format=/\.(mp4|m4v)$/i.test(f.name)?'mov':/\.webm$/i.test(f.name)?'matroska':null;
    if(!format)return {...selection,status:'on-disk',reason:'needs-preparation'};
    const playKey=appointmentPlayKey(key,stamp),session=sessions.get(hash+'-'+f.index);
    const readyDirect=session?.status==='ready'&&session.mode==='direct'&&!session.cancelled&&!session.suspended&&
      session.item?.f.name===f.name&&session.item.f.size===f.size&&session.readyFile?.ino!==undefined&&
      appointmentPlayKey(key,session.readyFile)===playKey&&directCompatible(item,session.probe);
    const known=appointmentCodecs.get(playKey);
    const evidence=readyDirect||known!==undefined?{direct:readyDirect||known}:
      await inspectAppointment(item,key,stamp,format,context);
    if(evidence.changed)return {...selection,status:'unavailable',reason:'file-changed'};
    return evidence.direct?{...selection,status:'ready',playKey}:
      {...selection,status:'on-disk',reason:evidence.reason||'needs-preparation'};
  }
  async function watchAppointment(targets,{epoch,allowProbe,signal,isCurrent}){
    if(appointmentObserver)throw appointmentError('An appointment check is already running.',429,'appointment-check-busy');
    const controller=new AbortController(), observation=appointmentObserver={controller,removed:new Set(),
      hashes:new Set(targets.map(target=>target.hash))};
    const context={epoch,allowProbe,signal:AbortSignal.any([signal,controller.signal]),isCurrent};
    try{
      const files=[];
      for(const target of targets){
        context.signal.throwIfAborted();
        files.push(await observeAppointment(target,context));
      }
      if(!isCurrent()||controller.signal.aborted)
        throw appointmentError('The connection changed. Check the appointment again.',409,'appointment-connection-changed');
      return {epoch,observedMs:performance.now(),files:files.map(file=>observation.removed.has(file.hash)?
        {hash:file.hash,...(file.key?{key:file.key}:{}),status:'unavailable',reason:'missing'}:file)};
    }catch(e){
      if(!isCurrent()||controller.signal.aborted)
        throw appointmentError('The appointment changed. Check it again.',409,'appointment-connection-changed');
      throw e;
    }finally{if(appointmentObserver===observation)appointmentObserver=null;}
  }
  async function verifyAppointment(item,proof){
    const file=appointmentFile(item);
    if(!file||file.index!==item.f.index||file.progress!==1||appointmentFileKey(item,proof.epoch)!==proof.key)
      throw appointmentChanged();
    const stamp=await appointmentStamp(item);
    if(!stamp||!proof.isCurrent()||appointmentRemovals.has(item.hash)||
      appointmentPlayKey(proof.key,stamp)!==proof.playKey)throw appointmentChanged();
    return stamp;
  }

  const dialogueUnavailable={kind:'unavailable'};
  let dialogueReads=0;
  const dialogueAttachments=new Map();
  const dialogueHex=/^[a-f0-9]{64}$/;
  const dialogueRun=/^[a-f0-9]{12}$/;
  const dialogueSession=/^[a-f0-9]{32}$/;
  const dialogueNonce=/^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
  const dialogueWindow=64*1024;
  function dialogueName(name) {
    if(typeof name!=='string'||!name||name.length>4096||name.includes('\0')||path.win32.isAbsolute(name)||path.posix.isAbsolute(name))
      return null;
    const normalized=name.replaceAll('\\','/');
    return /^[a-z]:/i.test(normalized)||normalized.split('/').some(part=>!part||part==='.'||part==='..')?null:normalized;
  }
  function dialogueStat(stat) {
    return [stat.dev,stat.ino,stat.size,stat.mtime,stat.ctime,stat.birth].map(String).join(':');
  }
  function dialogueFileStamp(filename,stat) {
    return {filename,size:stat.size,dev:stat.dev,ino:stat.ino,mtime:stat.mtimeNs,ctime:stat.ctimeNs,birth:stat.birthtimeNs};
  }
  function bindScenePreview(identity) {
    const {hash,index}=identity, session=matchingSession(identity), epoch=sceneEpoch();
    const generation=sceneGeneration, order=session?.requestOrder, url=session?.url, mode=session?.mode, run=session?.run;
    const sourceFile=session?.item?.f;
    const unavailable=()=>Object.assign(Error('This scene is no longer attached to the current video.'),{code:'scene-changed'});
    function assertCurrent(){
      if(epoch===null||sceneEpoch()!==epoch||pendingSelections||generation!==sceneGeneration||!session||sceneForeground!==session||
        matchingSession(identity)!==session||session.requestOrder!==order||session.status!=='ready'||
        session.url!==url||session.mode!==mode||session.run!==run||session.complete||warmLease||
        session.item?.f.name!==sourceFile?.name||session.item?.f.size!==sourceFile?.size)throw unavailable();
    }
    assertCurrent();
    if(!sceneReader||!url||!['direct','hls'].includes(mode)||!/[.](mp4|m4v)$/i.test(sourceFile?.name||'')||sourceFile.progress>=1)
      throw Object.assign(Error('This video does not support an available-scene preview.'),{code:'scene-unsupported'});
    return {assertCurrent,async open(signal){
      const reader=sceneReader(signal), params={hash};
      async function observe(){
        assertCurrent();
        const [items,all,prefs]=await Promise.all([reader.json('torrents/info',{hashes:hash}),
          reader.json('torrents/files',params),reader.json('app/preferences')]);
        signal.throwIfAborted();assertCurrent();
        const t=Array.isArray(items)&&items.length===1?items[0]:null;
        const selected=Array.isArray(all)?all.filter(file=>file.index===index):[];
        const f=selected.length===1?selected[0]:null;
        if(t?.hash?.toLowerCase()!==hash||typeof t.state!=='string'||/error|missingfiles|checking|moving|metadl/i.test(t.state)||
          !f||f.name!==sourceFile.name||f.size!==sourceFile.size||!dialogueName(f.name)||
          !Array.isArray(f.piece_range)||f.piece_range.length!==2||
          !Number.isFinite(f.progress)||f.progress<0||f.progress>=1||!prefs||typeof prefs!=='object'||Array.isArray(prefs))throw unavailable();
        const location=[t.save_path,t.download_path,t.content_path,prefs.temp_path_enabled===true?prefs.temp_path:null];
        if(location.some(value=>value&&(typeof value!=='string'||!path.isAbsolute(value))))throw unavailable();
        return {hash,t,f,all,prefs,location};
      }
      const initial=await observe();
      const filename=await resolvePath(initial,false,initial.prefs);
      signal.throwIfAborted();assertCurrent();
      const handle=await fsp.open(filename,'r');
      try {
        const [descriptor,name]=await Promise.all([handle.stat({bigint:true}),fsp.lstat(filename,{bigint:true})]);
        const stamp=dialogueFileStamp(filename,descriptor);
        if(!descriptor.isFile()||!name.isFile()||stamp.size<1n||stamp.size>BigInt(initial.f.size)||
          !sameDialogueObject(stamp,dialogueFileStamp(filename,name)))throw unavailable();
        async function validate(){
          const current=await observe();
          if(current.f.piece_range.some((part,i)=>part!==initial.f.piece_range[i])||
            current.location.some((part,i)=>part!==initial.location[i]))throw unavailable();
          const actual=await resolvePath(current,false,current.prefs);
          if(actual!==filename)throw unavailable();
          const [nowOpen,nowName]=await Promise.all([handle.stat({bigint:true}),fsp.lstat(filename,{bigint:true})]);
          if(!nowOpen.isFile()||!nowName.isFile()||nowOpen.size<stamp.size||nowOpen.size>BigInt(initial.f.size)||
            !sameDialogueObject(stamp,dialogueFileStamp(filename,nowOpen))||
            !sameDialogueObject(stamp,dialogueFileStamp(filename,nowName)))throw unavailable();
          signal.throwIfAborted();assertCurrent();
        }
        return {reader,handle,file:initial.f,validate,scheduler:mode==='direct'?reader.scheduler:null};
      }catch(error){await handle.close();throw error;}
    }};
  }
  function sameDialogueStat(a,b) {
    return sameDialogueObject(a,b)&&a.filename===b.filename&&a.size===b.size&&a.mtime===b.mtime&&a.ctime===b.ctime;
  }
  async function dialogueSamples(item,complete,signal) {
    signal.throwIfAborted();
    const width=Math.min(dialogueWindow,Math.floor(item.f.size/2));
    if(!width)return null;
    const filename=await resolvePath(item,false), handle=await fsp.open(filename,'r');
    try{
      signal.throwIfAborted();
      const opened=await handle.stat({bigint:true}),before=dialogueFileStamp(filename,opened);
      if(!opened.isFile()||opened.ino===0n||complete&&opened.size!==BigInt(item.f.size))return null;
      const positions=[0,complete?item.f.size-width:width], digest=createHash('sha256');
      for(const position of positions){
        signal.throwIfAborted();
        const sample=Buffer.alloc(width),read=await handle.read(sample,0,width,position);
        if(read.bytesRead!==width)return null;
        digest.update(sample);
      }
      const after=dialogueFileStamp(filename,await handle.stat({bigint:true}));
      if(!sameDialogueStat(before,after))return null;
      signal.throwIfAborted();
      if(await resolvePath(item,false)!==filename)return null;
      const current=await fsp.lstat(filename,{bigint:true});
      if(!current.isFile()||!sameDialogueStat(after,dialogueFileStamp(filename,current)))return null;
      return {stamp:before,digest:digest.digest('hex')};
    }finally{await handle.close();}
  }
  async function dialogueSource(hash,index) {
    const {t,all}=await snapshot(hash),f=all.find(file=>file.index===index);
    const name=dialogueName(f?.name);
    if(!name||!VIDEO.test(name)||t.hash?.toLowerCase()!==hash||/error|missingfiles|checking|moving/i.test(t.state||'')||
      !Number.isSafeInteger(f.size)||f.size<2||!Number.isFinite(f.progress)||f.progress<0||f.progress>1||
      cancelledHashes.has(hash))return null;
    return {hash,t,all,f,name};
  }
  function currentDialogueSession(identity,mode,run) {
    const session=matchingSession(identity);
    if(session?.status!=='ready'||session.mode!==mode)return null;
    const url=mode==='direct'?'/stream?hash='+identity.hash+'&index='+identity.index:
      '/hls/'+identity.hash+'-'+identity.index+'/'+run+'/index.m3u8';
    return session.url===url&&(mode==='direct'||session.run===run)?session:null;
  }
  function dialogueLayout(source,item) {
    const {offset,pieceSize,dialogueOffset}=source||{};
    if(!dialogueOffset||dialogueOffset.name!==item.name||dialogueOffset.size!==item.f.size||
      !Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(pieceSize)||pieceSize<1||
      !Number.isSafeInteger(offset+item.f.size))return null;
    const first=Math.floor(offset/pieceSize),last=Math.floor((offset+item.f.size-1)/pieceSize);
    const range=item.f.piece_range;
    if(range!==undefined&&(!Array.isArray(range)||range[0]!==first||range[1]!==last))return null;
    return {offset,pieceSize};
  }
  async function dialogueVerifiedOpening(item,layout,signal) {
    const states=await pieces(item.hash,true);
    signal.throwIfAborted();
    const length=2*Math.min(dialogueWindow,Math.floor(item.f.size/2));
    const first=Math.floor(layout.offset/layout.pieceSize), last=Math.floor((layout.offset+length-1)/layout.pieceSize);
    if(last>=states.length)return false;
    for(let piece=first;piece<=last;piece++)if(states[piece]!==2)return false;
    return true;
  }
  function getDialogueAttachment(session,attachment,expected) {
    if(!session||!attachment)return null;
    let entry=dialogueAttachments.get(session.key);
    if(entry?.session!==session||entry.attachment!==attachment){
      if(expected)return null;
      entry={session,attachment,partial:null,invalid:false};
    }
    dialogueAttachments.delete(session.key);dialogueAttachments.set(session.key,entry);
    while(dialogueAttachments.size>32)dialogueAttachments.delete(dialogueAttachments.keys().next().value);
    return entry;
  }
  async function dialogueVolatile(item,session,binding,expected,signal) {
    if(!binding||binding.invalid||expected&&binding.partial?.seal!==expected)return null;
    const layout=dialogueLayout(session.item,item), prior=binding.partial;
    if(!layout||prior&&(prior.progress>item.f.progress||prior.offset!==layout.offset||prior.pieceSize!==layout.pieceSize))
      {binding.invalid=true;return null;}
    if(!await dialogueVerifiedOpening(item,layout,signal)){
      if(prior)binding.invalid=true;
      return null;
    }
    const sample=await dialogueSamples(item,false,signal);
    if(!sample)return null;
    const backing=session.mode==='hls'?session.dialogueRun?.stamp:session.directFile;
    if(!sameDialogueObject(backing,sample.stamp)||prior&&
      (!sameDialogueObject(prior.stamp,sample.stamp)||prior.stamp.filename!==sample.stamp.filename||
        prior.stamp.size>sample.stamp.size||prior.digest!==sample.digest)){
      binding.invalid=true;return null;
    }
    if(!await dialogueVerifiedOpening(item,layout,signal)){
      if(prior)binding.invalid=true;
      return null;
    }
    return {seal:prior?.seal||randomBytes(32).toString('hex'),stamp:sample.stamp,digest:sample.digest,
      progress:item.f.progress,...layout};
  }
  function dialogueZeroOrigin(probe) {
    const declaredZero=value=>value!==null&&value!==undefined&&value!==''&&Number(value)===0;
    const video=probe?.streams?.find(stream=>stream.codec_type==='video');
    const audio=probe?.streams?.find(stream=>stream.codec_type==='audio');
    return declaredZero(probe?.format?.start_time)&&declaredZero(video?.start_time)&&
      (!audio||declaredZero(audio.start_time));
  }
  async function awaitDialogueDeadline(work,signal,fallback) {
    if(signal.aborted)return fallback;
    let abandon;
    try{return await Promise.race([work,new Promise(resolve=>{
      abandon=()=>resolve(fallback);
      signal.addEventListener('abort',abandon,{once:true});
    })]);}
    finally{signal.removeEventListener('abort',abandon);}
  }
  async function captureDialogueRun(session,run) {
    if(!dialogueZeroOrigin(session.probe)||dialogueReads>=2)return null;
    const source=session.item,name=dialogueName(source.f.name);
    if(!name||!Number.isSafeInteger(source.f.size)||source.f.size<2)return null;
    const item={...source,name}, complete=item.f.progress===1, signal=AbortSignal.timeout(250);
    const work=(async()=>{
      dialogueReads++;
      try{
        const layout=complete?null:dialogueLayout(source,item);
        if(!complete&&(!layout||!await dialogueVerifiedOpening(item,layout,signal)))return null;
        const sample=await dialogueSamples(item,false,signal);
        if(!sample||complete&&sample.stamp.size!==BigInt(item.f.size)||
          !complete&&!await dialogueVerifiedOpening(item,layout,signal))return null;
        signal.throwIfAborted();
        return {run,offsetMs:0,name,size:item.f.size,complete,layout,...sample};
      }catch{return null;}
      finally{dialogueReads--;}
    })();
    // Recording an optional source stamp must not wait on a busy daemon
    // before starting the ordinary converter.
    return awaitDialogueDeadline(work,signal,null);
  }
  async function readDialogueMetadata(filename,maxBytes,signal) {
    signal.throwIfAborted();
    const original=await fsp.lstat(filename,{bigint:true});
    if(!original.isFile()||original.size<=0n||original.size>BigInt(maxBytes))return null;
    const handle=await fsp.open(filename,'r');
    try{
      const opened=await handle.stat({bigint:true});
      const stamp=dialogueFileStamp(filename,opened);
      if(!opened.isFile()||!sameDialogueStat(stamp,dialogueFileStamp(filename,original)))return null;
      signal.throwIfAborted();
      const bytes=Buffer.alloc(Number(opened.size));
      if((await handle.read(bytes,0,bytes.length,0)).bytesRead!==bytes.length)return null;
      if(!sameDialogueStat(stamp,dialogueFileStamp(filename,await fsp.lstat(filename,{bigint:true}))))return null;
      return bytes.toString('utf8');
    }finally{await handle.close();}
  }
  async function dialogueManifest(item,run,signal) {
    const key=item.hash+'-'+item.f.index, folder=path.resolve(hlsRoot,key,run);
    if(cacheReserved(folder))return null;
    const root=await fsp.realpath(hlsRoot), real=await fsp.realpath(folder);
    if(real!==path.join(root,key,run))return null;
    const playlist=await readDialogueMetadata(path.join(folder,'index.m3u8'),256*1024,signal);
    if(!playlist?.startsWith('#EXTM3U')||!/^#EXT-X-MEDIA-SEQUENCE:0\r?$/m.test(playlist)||
      !/^#EXT-X-PLAYLIST-TYPE:EVENT\r?$/m.test(playlist)||/^#EXT-X-(?:DISCONTINUITY|START|SKIP|MAP)(?::|\r?$)/m.test(playlist))
      return null;
    const first=playlist.split(/\r?\n/).find(line=>line&&!line.startsWith('#'));
    if(first!=='seg000000.ts')return null;
    const filename=path.join(folder,first),stat=await fsp.lstat(filename,{bigint:true});
    if(!stat.isFile()||stat.ino===0n||stat.size<188n||cacheReserved(folder))return null;
    return {folder,first:dialogueStat(dialogueFileStamp(filename,stat)),complete:playlist.includes('#EXT-X-ENDLIST')};
  }
  function dialogueRunSource(run,item,sample,complete) {
    if(!run||run.name!==item.name||run.size!==item.f.size||!sample)return false;
    if(run.complete)return complete&&sameDialogueStat(run.stamp,sample.stamp);
    return sameDialogueObject(run.stamp,sample.stamp)&&run.stamp.size<=sample.stamp.size&&run.digest===sample.digest&&
      (complete||run.layout?.offset===sample.offset&&run.layout?.pieceSize===sample.pieceSize);
  }
  async function dialogueHlsRun(item,run,session,sample,complete,signal) {
    const manifest=await dialogueManifest(item,run,signal);
    if(!manifest)return null;
    const live=session?.dialogueRun;
    if(live?.run===run&&!session.complete&&dialogueRunSource(live,item,sample,complete)){
      if(live.first&&live.first!==manifest.first)return null;
      live.first=manifest.first;
      return manifest.first;
    }
    if(!complete||!manifest.complete)return null;
    const metadata=await readDialogueMetadata(path.join(manifest.folder,'..','completed.json'),4096,signal);
    const saved=metadata&&JSON.parse(metadata), proof=saved?.dialogue;
    if(saved?.run!==run||saved?.size!==item.f.size||proof?.v!==1||proof.offsetMs!==0||
      proof.source!==dialogueStat(sample.stamp)||proof.first!==manifest.first||cacheReserved(manifest.folder))
      return null;
    return manifest.first;
  }
  async function finishDialogueRun(session,item) {
    const run=session.dialogueRun,name=dialogueName(item.f.name);
    // The converter already checked all pieces, even if the daemon's file
    // progress briefly lags behind verification at completion.
    if(!run||!name||!session.readyFile||dialogueReads>=2||session.readyFile.size!==BigInt(item.f.size))return null;
    const signal=AbortSignal.timeout(250),source={...item,name};
    dialogueReads++;
    abortAppointmentProbe();
    try{
      const sample=run.complete?run:await dialogueSamples(source,false,signal);
      if(!dialogueRunSource(run,source,sample,true)||!sameDialogueStat(session.readyFile,sample.stamp))return null;
      const manifest=await dialogueManifest(source,run.run,signal);
      signal.throwIfAborted();
      if(!manifest?.complete||run.first&&run.first!==manifest.first)return null;
      return {v:1,offsetMs:0,source:dialogueStat(sample.stamp),first:manifest.first};
    }catch{return null;}
    finally{dialogueReads--;}
  }

  async function dialogueProof(input,{signal}={}) {
    const {index,sessionId,attachment,mode,expected}=input??{},hash=validHash(input?.hash),run=input?.run??null;
    if(!Number.isSafeInteger(index)||index<0||!['direct','hls'].includes(mode)||
      (mode==='direct'?run!==null:typeof run!=='string'||!dialogueRun.test(run))||
      sessionId!==undefined&&(typeof sessionId!=='string'||!dialogueSession.test(sessionId))||
      attachment!==undefined&&(typeof attachment!=='string'||!dialogueNonce.test(attachment)||!sessionId)||
      expected!==undefined&&(typeof expected!=='string'||!dialogueHex.test(expected)))
      throw error('Choose an exact playback file and timeline.');
    const identity={hash,index,sessionId};
    const session=sessionId?currentDialogueSession(identity,mode,run):null;
    if(stopping||signal?.aborted||sessionId&&!session||!session&&!expected)return dialogueUnavailable;
    if(dialogueReads>=2)throw error('Video evidence is already being checked. Try again shortly.',429);
    const control=signal?AbortSignal.any([signal,AbortSignal.timeout(6000)]):AbortSignal.timeout(6000);
    const binding=getDialogueAttachment(session,attachment,expected);
    const current=()=>!stopping&&!cancelledHashes.has(hash)&&(!session||currentDialogueSession(identity,mode,run)===session)&&
      (!binding||dialogueAttachments.get(session.key)===binding);
    dialogueReads++;
    const work=(async()=>{
      try{
        const item=await dialogueSource(hash,index);
        control.throwIfAborted();
        if(!item||!current()||session&&
          (dialogueName(session.item?.f?.name)!==item.name||session.item?.f?.size!==item.f.size))return dialogueUnavailable;
        const timeline={mode,offsetMs:0,run};
        if(item.f.progress<1){
          if(!binding||binding.pending||session.readyFile)return dialogueUnavailable;
          binding.pending=true;
          try{
            const partial=await dialogueVolatile(item,session,binding,expected,control);
            if(!partial)return dialogueUnavailable;
            if(mode==='hls'){
              const first=await dialogueHlsRun(item,run,session,partial,false,control);
              if(!first||binding.partial?.first&&binding.partial.first!==first)return dialogueUnavailable;
              partial.first=first;
            }
            control.throwIfAborted();
            if(!current())return dialogueUnavailable;
            binding.partial=partial;
            return {kind:'volatile',seal:partial.seal,timeline};
          }finally{binding.pending=false;}
        }
        if(binding?.partial){
          if(expected===binding.partial.seal){binding.partial=null;return dialogueUnavailable;}
          binding.partial=null;
        }
        const sample=await dialogueSamples(item,true,control);
        if(!sample||!current())return dialogueUnavailable;
        let hlsFirst=null;
        if(mode==='hls'){
          hlsFirst=await dialogueHlsRun(item,run,session,sample,true,control);
          if(!hlsFirst)return dialogueUnavailable;
        }else if(session&&!(session.readyFile?sameDialogueStat(session.readyFile,sample.stamp):sameDialogueObject(session.directFile,sample.stamp)))
          return dialogueUnavailable;
        control.throwIfAborted();
        if(!current())return dialogueUnavailable;
        const seal=createHash('sha256').update(JSON.stringify([1,hash,index,item.name,item.f.size,mode,run,
          timeline.offsetMs,dialogueStat(sample.stamp),sample.digest,hlsFirst])).digest('hex');
        return expected&&expected!==seal?dialogueUnavailable:{kind:'sealed',seal,timeline};
      }catch{return dialogueUnavailable;}
      finally{dialogueReads--;}
    })();
    // Keep the slot until the underlying daemon or disk read actually exits.
    return awaitDialogueDeadline(work,control,dialogueUnavailable);
  }

  async function warmManifest(session,item,complete,withProof=false) {
    const folder=session.folder, run=session.run;
    if(!folder || !/^[a-f\d]{12}$/i.test(run||'') || folder!==path.resolve(hlsRoot,session.key,run) ||
      cacheReserved(folder))return false;
    const manifest=path.join(folder,'index.m3u8');
    const root=await fsp.realpath(hlsRoot), realFolder=await fsp.realpath(folder);
    if(!inside(root,realFolder) || realFolder!==path.join(root,session.key,run) ||
      !(await fsp.lstat(manifest)).isFile())return false;
    const playlist=await fsp.readFile(manifest,'utf8');
    const entries=playlist.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    if(!playlist.startsWith('#EXTM3U') || !entries.length ||
      entries.length!==(playlist.match(/^#EXTINF:/gm)||[]).length ||
      entries.some((name,i)=>name!=='seg'+String(i).padStart(6,'0')+'.ts'))return false;
    if(complete) {
      const marker=path.join(hlsRoot,session.key,'completed.json');
      if(!(await fsp.lstat(marker)).isFile())return false;
      const saved=JSON.parse(await fsp.readFile(marker,'utf8'));
      if(saved.run!==run || saved.size!==item.f.size || !Number.isFinite(saved.duration) || saved.duration<=0 ||
        !playlist.includes('#EXT-X-ENDLIST') || playlistDuration(playlist)<saved.duration-2)return false;
    }
    const contents=await fsp.readdir(folder,{withFileTypes:true});
    const regular=new Set(contents.filter(entry=>entry.isFile()&&!entry.isSymbolicLink()).map(entry=>entry.name));
    if(!entries.every(name=>regular.has(name)))return false;
    const proof=withProof?createHash('sha256').update(playlist):null;
    for(let offset=0;offset<entries.length;offset+=32) {
      const stats=await Promise.all(entries.slice(offset,offset+32).map(name=>fsp.lstat(path.join(folder,name),{bigint:true})));
      if(stats.some(stat=>!stat.isFile()||stat.size<188n))return false;
      if(proof)for(const stat of stats)proof.update([stat.dev,stat.ino,stat.size,stat.mtimeNs].join(':')+'\n');
    }
    if(cacheReserved(folder))return false;
    return proof?proof.digest('hex'):true;
  }
  function fallbackSession(session) {
    return session?.status==='ready' && session.url &&
      (session.mode==='direct' || session.mode==='hls'&&session.complete);
  }
  async function verifyFallback(session) {
    if(!fallbackSession(session))return null;
    try{
      const item=await currentWarmFile(session);
      if(item.f.progress!==1)return null;
      const file=await fileStamp(item);
      if(file.size!==BigInt(item.f.size)||!sameFile(file,session.readyFile))return null;
      if(session.mode==='direct')return session.probe&&directCompatible(item,session.probe)?item:null;
      return await warmManifest(session,item,true)?item:null;
    }catch(e){
      if(['ENOENT','ENOTDIR'].includes(e.code)||[403,404,409].includes(e.status)||e instanceof SyntaxError)return null;
      throw e;
    }
  }
  async function verifyWarmSource(session,item) {
    if(session.status!=='ready')return;
    try{
      if(session.mode==='hls'&&!await warmManifest(session,item,session.complete))
        throw error('The saved playback copy is no longer available.',409);
      if(session.mode==='direct'){
        const file=await fileStamp(item);
        if(file.size<=0n||item.f.progress===1&&(file.size!==BigInt(item.f.size)||session.readyFile&&!sameFile(file,session.readyFile)))
          throw error('The saved video file has changed.',409);
      }
    }catch(e){
      if(['ENOENT','ENOTDIR'].includes(e.code)||[403,404].includes(e.status)||e instanceof SyntaxError)
        throw error('The saved playback file is no longer available.',409);
      throw e;
    }
  }
  function attachment(session,item) {
    const {index,name,size,progress}=item.f;
    return {file:{index,name,size,progress,playable:true},state:serialize(session)};
  }
  function leaseState(lease) {
    if(!lease || now()>=lease.expiresAt)return null;
    const session=warmSource(lease.source);
    if(!session || lease.url&&session.url!==lease.url)return null;
    const url=session.status==='ready'?session.url:null;
    const availableDuration=session.mode==='hls'?Math.min(session.duration||Infinity,session.publishedDuration||0):undefined;
    return {ticket:lease.ticket,expiresAt:lease.expiresAt,...lease.source,
      phase:url?'ready':'preparing',...(url?{url,availableDuration}:{})};
  }
  function clearWarmLease(retire=false) {
    const lease=warmLease;warmLease=null;
    if(!retire||!lease)return;
    const session=matchingSession(lease.source);
    if(!session || session.lastObserved!==undefined&&now()-session.lastObserved<VIEWER_GRACE_MS)return;
    const readingHls=session.folder&&readingRuns.has(session.folder);
    const readingDirect=[...(activeStreams.get(session.hash)||[])].some(transfer=>!transfer.internal&&transfer.index===session.index);
    if(readingHls||readingDirect)return;
    if(session.complete || session.mode==='direct'&&session.item?.f.progress===1)return;
    abortRoleProbe(session);
    session.suspended=true;
    session.status='queued';
    session.message='Playback preparation can continue when you return to this title.';
    session.probeChild?.kill();
    stopTranscode(session);
    // Actual readers and the closing writer continue protecting their own runs.
    session.folder=null;session.url=null;session.readyAt=null;
  }
  function expireWarmLease() {
    if(!warmLease)return;
    if(now()>=warmLease.expiresAt){clearWarmLease(true);return;}
    const state=leaseState(warmLease);
    if(!state){clearWarmLease();return;}
    if(state.url&&!warmLease.url)warmLease.url=state.url;
  }
  async function warmOptions(hash,index,sessionId) {
    const from=warmIdentity({hash,index,sessionId}), revision=ordinarySelection;
    if(!warmSource(from))throw error('This playback session changed. Open the player again.',409);
    const candidates=[...sessions.values()].filter(session=>session.hash!==from.hash&&fallbackSession(session))
      .sort((a,b)=>(b.lastObserved||b.lastRequested||0)-(a.lastObserved||a.lastRequested||0)).slice(0,6);
    const checked=await Promise.allSettled(candidates.map(async session=>({session,item:await verifyFallback(session)})));
    if(revision!==ordinarySelection||!warmSource(from))throw error('This playback session changed. Open the player again.',409);
    const options=[];
    for(const result of checked) {
      if(result.status!=='fulfilled')continue;
      const {session,item}=result.value;
      if(!item||matchingSession(session)!==session||!fallbackSession(session))continue;
      options.push({hash:session.hash,index:session.index,sessionId:session.sessionId,fileName:item.f.name,mode:session.mode});
      if(options.length===4)break;
    }
    return {options};
  }
  async function warmSwitch(from,to) {
    from=warmIdentity(from);to=warmIdentity(to);
    if(from.hash===to.hash)throw error('Choose a different download for the fallback.',409);
    abortAppointmentProbe();
    ++appointmentWarmWork;
    try{return await switchWarmPlayback(from,to);}finally{--appointmentWarmWork;}
  }
  async function switchWarmPlayback(from,to) {
    expireWarmLease();
    const revision=ordinarySelection, source=warmSource(from), fallback=matchingSession(to);
    if(warmLease||pendingSelections||!source||!fallbackSession(fallback))throw error('The selected playback sessions are no longer available.',409);
    const originalUrl=source.status==='ready'?source.url:null, fallbackUrl=fallback.url;
    const sourceFile={name:source.item.f.name,size:source.item.f.size};
    const [sourceItem,item]=await Promise.all([
      currentWarmFile(source).then(async item=>{await verifyWarmSource(source,item);return item;}),
      verifyFallback(fallback)
    ]);
    if(warmLease||pendingSelections||revision!==ordinarySelection||warmSource(from)!==source||matchingSession(to)!==fallback||
      sourceItem.f.name!==sourceFile.name||sourceItem.f.size!==sourceFile.size||
      !item||!fallbackSession(fallback)||fallback.url!==fallbackUrl||originalUrl&&source.url!==originalUrl||
      fallback.folder&&cacheReserved(fallback.folder))throw error('The selected playback sessions changed. Try again.',409);
    source.item=sourceItem;
    fallback.item=item;
    fallback.lastObserved=now();
    warmLease={ticket:randomBytes(24).toString('hex'),expiresAt:now()+WARM_LEASE_MS,
      source:from,file:sourceFile,url:originalUrl||(source.status==='ready'?source.url:null)};
    selectSceneForeground(fallback);
    return {lease:leaseState(warmLease),attachment:attachment(fallback,item)};
  }
  function warmStatus(ticket) {
    return {lease:warmLease?.ticket===ticket?leaseState(warmLease):null};
  }
  async function warmReturn(ticket) {
    abortAppointmentProbe();
    expireWarmLease();
    const lease=warmLease, revision=ordinarySelection;
    if(pendingSelections||!lease||lease.ticket!==ticket)throw error('The saved playback session is no longer available.',409);
    const session=warmSource(lease.source);
    if(!session)throw error('The saved playback session is no longer available.',409);
    const item=await currentWarmFile(session);
    if(item.f.name!==lease.file.name||item.f.size!==lease.file.size)throw error('The saved video file has changed.',409);
    await verifyWarmSource(session,item);
    if(warmLease!==lease||pendingSelections||revision!==ordinarySelection||warmSource(lease.source)!==session||!leaseState(lease))
      throw error('The saved playback session is no longer available.',409);
    session.item=item;
    session.lastObserved=now();
    clearWarmLease();
    selectSceneForeground(session);
    return {attachment:attachment(session,item)};
  }
  function warmDismiss(ticket) {
    if(warmLease?.ticket===ticket)clearWarmLease(true);
    return {ok:true};
  }


  function rescueIdentity(value,source=false) {
    const hash=validHash(value?.hash), index=value?.index, name=value?.name, size=value?.size;
    if(!Number.isSafeInteger(index)||index<0||!Number.isSafeInteger(size)||size<=0||
      typeof name!=='string'||!name||name.length>4096||name.includes('\0')||
      path.isAbsolute(name)||path.win32.isAbsolute(name))
      throw error('Choose an exact video file for the replacement check.');
    if(!source)return {hash,index,name,size};
    return {...warmIdentity(value),name,size,...(value.url===undefined?{}:{url:value.url})};
  }
  function rescueFileMatches(item,identity) {
    return item?.f?.index===identity.index&&item.f.name===identity.name&&item.f.size===identity.size;
  }
  function rescueSourceSession(identity) {
    const session=matchingSession(identity);
    if(!session||!rescueFileMatches(session.item,identity)||
      identity.url!==undefined&&identity.url!==session.url)
      throw error('The original playback session changed. Open the replacement again.',409);
    return session;
  }
  async function rescueSourceFile(identity,session) {
    const {t,all}=await snapshot(identity.hash);
    const f=all.find(file=>file.index===identity.index);
    if(t.hash?.toLowerCase()!==identity.hash||!rescueFileMatches({f},identity))
      throw error('The original video file changed. Open the replacement again.',409);
    return {...session.item,hash:identity.hash,t,all,f};
  }
  async function rescueTargetFile(identity) {
    const item=await info(identity.hash,identity.index);
    if(item.t.hash?.toLowerCase()!==identity.hash||!rescueFileMatches(item,identity)||
      /error|missingfiles|checking|moving/i.test(item.t.state||'')||
      cancelledHashes.has(identity.hash))
      throw error('The replacement video file changed or is unavailable.',409);
    return item;
  }
  function rescueBackingMatches(before,after,beforeProgress,afterProgress) {
    if(afterProgress<beforeProgress)return false;
    if(sameFile(before,after))return true;
    // A growing file can gain bytes or be renamed on completion. A new inode,
    // a shrunk file, or a change after completion cannot reuse the proof.
    return beforeProgress<1&&afterProgress>beforeProgress&&before&&after&&before.ino!==0n&&
      before.ino===after.ino&&before.dev===after.dev&&after.size>=before.size;
  }
  function rescueOwned(check,signal) {
    if(stopping||signal?.aborted||check.selection!==ordinarySelection||pendingSelections)
      throw error('Playback changed while checking the replacement. Check it again.',409);
    const current=rescueSourceSession(check.from);
    const url=check.fastStart&&current.status!=='ready'?undefined:current.url;
    const starting=check.fastStart&&['buffering','converting','queued','ready'].includes(current.status);
    const changed=check.fastStart?(!starting||check.originalUrl&&url!==check.originalUrl):url!==check.originalUrl;
    if(current!==check.source||changed||sessions.get(check.targetKey)!==check.previous||cancelledHashes.has(check.to.hash))
      throw error('Playback changed while checking the replacement. Check it again.',409);
    if(check.fastStart&&!check.originalUrl&&url)check.originalUrl=url;
  }
  async function rescueRequiredBytes(item) {
    const opening=await buffer(item);
    if(item.f.progress<1) {
      if(item.offset===undefined||!item.pieceSize)
        throw error('The replacement needs to finish downloading before it can be checked.',409);
      if(opening.ratio<1||!(await movieIndex(item)).ready)
        throw error('The replacement is still downloading the opening or video index.',409);
    }
    return opening;
  }
  function rescueDirectProof(item,session,stamp) {
    if(session?.status!=='ready'||session.mode!=='direct'||!session.probe||!directCompatible(item,session.probe))
      return false;
    if(sameFile(stamp,session.readyFile)||sameFile(stamp,session.directFile))return true;
    return Boolean(session.directFile&&session.directFile.ino!==0n&&stamp.ino===session.directFile.ino&&
      stamp.dev===session.directFile.dev&&item.f.progress<1&&stamp.size>=session.directFile.size);
  }
  function observeFastStart(key) {
    if(fastStartAdoption?.candidate.key!==key||sessions.get(key)!==fastStartAdoption.candidate)return;
    if(now()>=fastStartAdoption.expiresAt)retireFastStart();
    else fastStartAdoption=null;
  }
  function retireFastStart() {
    const candidate=fastStartAdoption?.candidate;
    fastStartAdoption=null;
    if(candidate&&sessions.get(candidate.key)===candidate)sessions.delete(candidate.key);
  }
  function expireRescueProposal() {
    if(rescueProposal&&now()>=rescueProposal.expiresAt)rescueProposal=null;
    if(fastStartAdoption&&now()>=fastStartAdoption.expiresAt)retireFastStart();
  }
  function invalidateRescue() {
    rescueProposal=null;
    rescueCheckActive?.controller.abort();
    retireFastStart();
  }
  function rescueFailure(e) {
    if(e.code==='ENOENT'||e.code==='ENOTDIR'||e.status===403||e.status===404)
      return error('A video file or its playback copy is no longer available.',409);
    return e;
  }
  async function rescueCheck(from,to,{signal,purpose}={}) {
    from=rescueIdentity(from,true);to=rescueIdentity(to);
    const fastStart=purpose==='fast-start', fastStartExpiry=fastStart?now()+FAST_START_LEASE_MS:0;
    if(from.hash===to.hash)throw error('Choose a different download for the replacement.',409);
    if(fastStart&&!/\.(mp4|m4v)$/i.test(to.name))
      throw error('Fast Start needs a direct-play MP4 or M4V replacement.',422);
    expireRescueProposal();
    if(rescueCheckActive||rescueProposal||fastStartAdoption)throw error('A replacement is already being checked.',429);
    if(pendingSelections||stopping||signal?.aborted)throw error('Playback changed before the replacement check.',409);
    const source=rescueSourceSession(from), targetKey=to.hash+'-'+to.index, controller=new AbortController();
    abortAppointmentProbe();
    const check={from,to,source,targetKey,controller,fastStart,selection:ordinarySelection,
      originalUrl:fastStart&&source.status!=='ready'?undefined:source.url,
      previous:sessions.get(targetKey),candidate:null};
    rescueCheckActive=check;
    const cancelSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try {
      rescueOwned(check,cancelSignal);
      const [original,item]=await Promise.all([rescueSourceFile(from,source),rescueTargetFile(to)]);
      const preview=fastStart?await fastStartOpening(item):null;
      if(preview?.waiting){rescueOwned(check,cancelSignal);return preview;}
      const partialOpening=preview?.opening||(item.f.progress<1?await rescueRequiredBytes(item):null);
      const [sourceStamp,stamp]=await Promise.all([fileStamp(original).catch(()=>null),preview?.stamp||fileStamp(item)]);
      if(stamp.size<=0n||item.f.progress===1&&stamp.size!==BigInt(to.size))
        throw error('The replacement video is not readable from disk.',409);
      rescueOwned(check,cancelSignal);
      const prior=check.previous;
      const newCandidate=()=>({key:targetKey,hash:to.hash,index:to.index,sessionId:randomBytes(16).toString('hex'),
        startedAt:Date.now(),status:'buffering',item});
      let detached=newCandidate();
      let candidate=check.candidate=!fastStart&&prior?.complete&&prior.mode==='hls'?prior:detached;
      let manifestProof;
      if(!fastStart&&item.f.progress===1&&(candidate===prior||await loadCompleted(candidate,item))&&
        sameFile(stamp,candidate.readyFile)&&(manifestProof=await warmManifest(candidate,item,true,true))) {
        // The exact cached run stays pinned while this check or proposal owns it.
      } else {
        if(detached.complete)detached=newCandidate();
        candidate=check.candidate=detached;
        if(!/\.(mp4|m4v|webm)$/i.test(to.name))
          throw error('This replacement needs a prepared playback copy. Your original can stay open.',422);
        candidate.buffer=partialOpening||await rescueRequiredBytes(item);
        rescueOwned(check,cancelSignal);
        if(rescueDirectProof(item,prior,stamp)) {
          candidate=check.candidate=prior;
        } else {
          if(prior&&(fastStart||prior.child||prior.probeChild||prior.runCompletion||prior.busy))
            throw error('This replacement is already being prepared. Check it again shortly.',409);
          candidate.probe=await runProbe(candidate,{signal:cancelSignal,timeoutMs:RESCUE_PROBE_MS});
          if(!directCompatible(item,candidate.probe))
            throw error('This replacement needs a prepared playback copy. Your original can stay open.',422);
          candidate.mode='direct';candidate.status='ready';candidate.readyAt=Date.now();
          candidate.directFile=stamp;
          candidate.duration=Number(candidate.probe.format?.duration)||
            Number(candidate.probe.streams.find(stream=>stream.codec_type==='video')?.duration)||undefined;
          candidate.url='/stream?hash='+to.hash+'&index='+to.index;
          candidate.message='This replacement is ready to preview.';
        }
      }
      const fresh=await rescueTargetFile(to), freshStamp=await fileStamp(fresh);
      if(!rescueBackingMatches(stamp,freshStamp,item.f.progress,fresh.f.progress)||
        fresh.f.progress===1&&freshStamp.size!==BigInt(to.size))
        throw error('The replacement video changed during the check.',409);
      if(candidate.mode==='hls'&&(cacheReserved(candidate.folder)||candidate.status!=='ready'||!candidate.complete))
        throw error('The replacement playback copy is no longer available.',409);
      if(candidate===detached){
        candidate.item=fresh;
        if(candidate.mode==='direct'&&fresh.f.progress===1)candidate.readyFile=freshStamp;
      }
      rescueOwned(check,cancelSignal);
      const expiresAt=fastStart?fastStartExpiry:now()+RESCUE_LEASE_MS;
      if(now()>=expiresAt)throw error('The replacement check expired. Check the video again.',409);
      const ticket=randomBytes(24).toString('hex');
      const offer=fastStart?{previewBytes:preview.previewBytes}:{};
      rescueProposal={...check,candidate,ticket,expiresAt,sourceStamp,sourceProgress:original.f.progress,
        stamp:freshStamp,progress:fresh.f.progress,url:candidate.url,manifestProof,...offer};
      return {ticket,expiresAt,attachment:attachment({...candidate,item:fresh},fresh),...offer};
    } catch(e){throw rescueFailure(e);}
    finally{if(rescueCheckActive===check)rescueCheckActive=null;}
  }
  async function rescueCommit(ticket) {
    expireRescueProposal();
    const proposal=rescueProposal;
    if(!proposal||proposal.ticket!==ticket||proposal.committing)
      throw error('The replacement check expired. Check the video again.',409);
    proposal.committing=true;
    try {
      rescueOwned(proposal);
      const {candidate,from,to,source}=proposal;
      const [original,item]=await Promise.all([rescueSourceFile(from,source),rescueTargetFile(to)]);
      const [originalStamp,stamp]=await Promise.all([
        proposal.sourceStamp?fileStamp(original):Promise.resolve(null),fileStamp(item)
      ]);
      if(proposal.sourceStamp&&!rescueBackingMatches(proposal.sourceStamp,originalStamp,proposal.sourceProgress,original.f.progress))
        throw error('The original video changed before switching.',409);
      if(!rescueBackingMatches(proposal.stamp,stamp,proposal.progress,item.f.progress)||
        item.f.progress===1&&stamp.size!==BigInt(to.size))
        throw error('The replacement video changed before switching.',409);
      const preview=proposal.fastStart?await fastStartOpening(item,true):null;
      if(proposal.fastStart&&(!preview?.previewBytes||preview.previewBytes<proposal.previewBytes||!sameFile(preview.stamp,stamp)))
        throw error('The verified preview changed before switching.',409);
      const opening=preview?.opening||(candidate.mode==='direct'?await rescueRequiredBytes(item):null);
      if(candidate.mode==='hls'&&proposal.manifestProof!==await warmManifest(candidate,item,true,true))
        throw error('The replacement playback copy changed before switching.',409);
      rescueOwned(proposal);
      if(rescueProposal!==proposal||now()>=proposal.expiresAt||candidate.url!==proposal.url||
        candidate.status!=='ready'||candidate.folder&&cacheReserved(candidate.folder))
        throw error('The replacement check expired or changed. Check the video again.',409);
      rescueProposal=null;
      selectSceneForeground(candidate);
      if(proposal.fastStart){
        if(!proposal.previous){
          candidate.item=item;
          candidate.buffer=opening;
          candidate.requestOrder=0;
          if(item.f.progress===1)candidate.readyFile=stamp;
          sessions.set(proposal.targetKey,candidate);
          fastStartAdoption={ticket,expiresAt:now()+FAST_START_ADOPTION_MS,candidate};
        }
        return {attachment:attachment({...candidate,item},item)};
      }
      clearWarmLease();
      candidate.item=item;
      candidate.lastObserved=now();
      candidate.lastRequested=Date.now();
      candidate.requestOrder=++ordinarySelection;abortRoleProbe();
      if(opening)candidate.buffer=opening;
      if(item.f.progress===1)candidate.readyFile=stamp;
      sessions.set(proposal.targetKey,candidate);
      return {attachment:attachment(candidate,item)};
    }catch(e){throw rescueFailure(e);}
    finally{if(rescueProposal===proposal)rescueProposal=null;}
  }
  function rescueCancel(ticket) {
    if(rescueProposal?.ticket===ticket)rescueProposal=null;
    if(fastStartAdoption?.ticket===ticket)retireFastStart();
    return {ok:true};
  }

  function audioRunProjection(session){
    const state=session.audioRun;
    if(!state||state.withdrawn||!state.alignment||state.run!==session.run||session.status!=='ready'||
      !audioRenditionRoles.every(role=>state.renditions[role]))return undefined;
    const base='/hls/'+session.key+'/'+state.run+'/';
    return {
      url:base+audioMasterName,original:base+'audio-original.m3u8',description:base+'audio-description.m3u8',
      originalDuration:Math.max(0,state.renditions.original.seconds-state.alignment.original),
      descriptionDuration:Math.max(0,state.renditions.description.seconds-state.alignment.description)
    };
  }
  function currentAudioRun(session,state){
    return !stopping&&!session.cancelled&&!session.suspended&&sessions.get(session.key)===session&&
      session.audioRun===state&&session.run===state.run&&session.folder===state.folder;
  }
  async function refreshAudioRun(session,state){
    if(state.reading||state.finalizing||state.withdrawn||!currentAudioRun(session,state))return;
    state.reading=true;
    try{
      const results=await Promise.all(audioRenditionRoles.map(role=>
        readAudioRendition(state.folder,role,state.target,state.renditions[role])));
      if(state.finalizing||!currentAudioRun(session,state))return;
      for(const [index,role] of audioRenditionRoles.entries()){
        const {rendition,invalid}=results[index];
        if(invalid){state.withdrawn=true;return;}
        if(rendition)state.renditions[role]=rendition;
      }
      const behind=audioRenditionRoles.some(role=>{
        const rendition=state.renditions[role],ready=rendition?.seconds||0;
        return session.publishedDuration-ready>2*state.target;
      });
      if(behind){state.withdrawn=true;return;}
      if(!state.alignment&&audioRenditionRoles.every(role=>state.renditions[role])){
        const alignment=await audioStartAlignment(state.folder);
        if(!state.finalizing&&currentAudioRun(session,state)&&alignment)state.alignment=alignment;
      }
    }finally{state.reading=false;}
  }
  function audioBackingSeal(item,stamp){
    if(!stamp||stamp.ino===0n||item.f.progress!==1||stamp.size!==BigInt(item.f.size))return null;
    return audioManifestDigest(JSON.stringify([item.hash,item.f.index,item.f.name,item.f.size,stamp.filename,dialogueStat(stamp)]));
  }
  async function audioPrefixStillMatches(item,source,stamp){
    if(source.identity!==audioSourceIdentity(item)||!sameDialogueObject(source.stamp,stamp)||
      source.complete&&!sameDialogueStat(source.stamp,stamp))return false;
    const handle=await fsp.open(stamp.filename,'r');
    try{
      const stat=await handle.stat({bigint:true});
      const opened=dialogueFileStamp(stamp.filename,stat);
      if(!stat.isFile()||!sameDialogueStat(stamp,opened))return false;
      const bytes=Buffer.alloc(source.length);
      if((await handle.read(bytes,0,bytes.length,0)).bytesRead!==bytes.length||audioPrefixDigest(bytes)!==source.digest)return false;
      return sameDialogueStat(opened,dialogueFileStamp(stamp.filename,await handle.stat({bigint:true})));
    }finally{await handle.close();}
  }
  async function inspectFinalAudio(folder,target,expected,signal){
    const manifests=await Promise.all(audioRenditionRoles.map(role=>readAudioRendition(folder,role,target,null,{signal})));
    if(signal?.aborted||manifests.some(({rendition})=>!rendition?.complete||Math.abs(rendition.seconds-expected)>1))return null;
    const alignment=await audioStartAlignment(folder);
    if(signal?.aborted||!alignment)return null;
    return {alignment,renditions:Object.fromEntries(audioRenditionRoles.map((role,i)=>[role,manifests[i].rendition]))};
  }
  function audioFinalProof(state,source,canonical){
    const manifests=Object.fromEntries(audioRenditionRoles.map(role=>[role,audioManifestDigest(state.renditions[role].text)]));
    return {v:1,run:state.run,target:state.target,ordinal:state.ordinal,source,canonical:audioManifestDigest(canonical),manifests};
  }
  async function finishAudioRun(session,item,canonical,expected){
    const state=session.audioRun,stamp=session.readyFile;
    if(!state||state.withdrawn||!currentAudioRun(session,state))return null;
    state.finalizing=true;
    try{
      const source=audioBackingSeal(item,stamp);
      if(!source||!await audioPrefixStillMatches(item,state.source,stamp))return null;
      const proof=await inspectFinalAudio(state.folder,state.target,expected);
      if(!proof||state.withdrawn||!currentAudioRun(session,state)||audioBackingSeal(item,await fileStamp(item))!==source)return null;
      Object.assign(state,proof,{complete:true});
      return audioFinalProof(state,source,canonical);
    }catch{return null;}
    finally{if(!state.complete)state.withdrawn=true;}
  }
  async function restoreAudioRun(session,item,folder,canonical,saved,stamp){
    const proof=saved.audio;
    if(!proof||proof.v!==1||proof.run!==saved.run||![2,4].includes(proof.target)||
      !Number.isSafeInteger(proof.ordinal)||proof.ordinal<1||proof.ordinal>127||
      typeof proof.source!=='string'||proof.source!==audioBackingSeal(item,stamp)||
      proof.canonical!==audioManifestDigest(canonical)||sessions.get(session.key)!==session)return null;
    const signal=AbortSignal.timeout(350);
    const work=(async()=>{
      try{
        const root=await fsp.realpath(hlsRoot),real=await fsp.realpath(folder);
        if(signal.aborted||real!==path.join(root,session.key,saved.run)||cacheReserved(folder))return null;
        const result=await inspectFinalAudio(folder,proof.target,playlistDuration(canonical),signal);
        if(!result||audioRenditionRoles.some(role=>proof.manifests?.[role]!==audioManifestDigest(result.renditions[role].text)))return null;
        if(signal.aborted||audioBackingSeal(item,await fileStamp(item))!==proof.source)return null;
        return {run:saved.run,folder,target:proof.target,ordinal:proof.ordinal,complete:true,...result};
      }catch{return null;}
    })();
    return awaitDialogueDeadline(work,signal,null);
  }

  async function loadCompleted(session,item) {
    if(session.checkedDisk)return false;session.checkedDisk=true;
    try {
      const saved=JSON.parse(await fsp.readFile(path.join(hlsRoot,session.key,'completed.json'),'utf8'));
      if(saved.size!==item.f.size||!/^[a-f\d]{12}$/i.test(saved.run))return false;
      const folder=path.resolve(hlsRoot,session.key,saved.run);
      if(cacheReserved(folder))return false;
      const playlist=await fsp.readFile(path.join(folder,'index.m3u8'),'utf8');
      const actualDuration=playlistDuration(playlist);
      if(!playlist.includes('#EXT-X-ENDLIST')||item.f.progress<1||actualDuration<Number(saved.duration||0)-2)return false;
      session.readyFile=await fileStamp(item).catch(()=>null);
      const audio=await restoreAudioRun(session,item,folder,playlist,saved,session.readyFile);
      if(cacheReserved(folder)||session.cancelled||session.suspended||stopping)return false;
      session.audioRun=audio;
      session.folder=folder;session.run=saved.run;session.duration=saved.duration;session.generatedDuration=saved.duration;session.publishedDuration=actualDuration;session.mode='hls';session.status='ready';session.readyAt||=Date.now();session.complete=true;session.url=`/hls/${session.key}/${session.run}/index.m3u8`;session.message='Ready to play from your saved browser-friendly copy.';session.restoredHls=true;return true;
    }catch{return false;}
  }
  function playlistDuration(playlist) {return [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].reduce((sum,match)=>sum+Number(match[1]),0);}

  function clearCopyFallbackCheck(session){
    clearTimeout(session.copyFallbackCheck?.timer);
    session.copyFallbackCheck=null;
  }

  function restartCopyAsEncode(session,reason){
    session.copyFallback=reason;
    session.forceVideoEncode=true;
    stopTranscode(session);
  }

  function checkOpeningCopyFallback(session,playlist,readAt){
    const evidence=openingCopyEvidence(session,activeStreams.get(session.hash),playlist);
    const previous=session.copyFallbackCheck;
    if(sameOpeningCopyEvidence(previous,evidence)){
      if(previous.timer===null&&readAt-previous.observedAt>=COPY_WAIT_CONFIRM_MS)
        restartCopyAsEncode(session,'verified-piece-wait');
      return;
    }
    clearCopyFallbackCheck(session);
    if(!evidence)return;
    const check={...evidence,observedAt:performance.now(),timer:null};
    session.copyFallbackCheck=check;
    check.timer=setTimeout(()=>{
      check.timer=null;
      if(session.copyFallbackCheck===check)void refreshPlaylist(session).catch(()=>{});
    },COPY_WAIT_CONFIRM_MS+1);
    check.timer.unref();
  }

  async function refreshPlaylist(session) {
    const {child,run,folder}=session;
    if(activeTranscode!==session||!child||session.stopRequested||session.playlistChecking||session.finalizing||session.cancelled||session.suspended||session.status==='error'||stopping)return;
    session.playlistChecking=true;
    const readAt=performance.now();
    try {
      const playlist=await fsp.readFile(path.join(folder,'index.m3u8'),'utf8').catch(error=>error.code==='ENOENT'?null:undefined);
      if(activeTranscode!==session||session.finalizing||session.cancelled||session.suspended||session.status==='error'||session.stopRequested||
        session.child!==child||session.run!==run||session.folder!==folder||stopping)return;
      if(typeof playlist==='string'&&playlist!==session.playlist) {
        session.playlist=playlist;
        session.segments=(playlist.match(/^#EXTINF:/gm)||[]).length;
        session.publishedDuration=playlistDuration(playlist);
        if(session.segments)session.firstSegmentAt||=Date.now();
      }
      if(session.audioRun){
        const publication=refreshAudioRun(session,session.audioRun);
        // Read the already-published optional files once before the first eligible attachment.
        // Waiting for new torrent bytes is never part of the ordinary opening.
        if(session.segments>=2&&!session.readyAt)
          await awaitDialogueDeadline(publication,AbortSignal.timeout(45),null);
        else void publication;
        if(activeTranscode!==session||session.finalizing||session.cancelled||session.suspended||
          session.stopRequested||session.child!==child||session.run!==run||stopping)return;
      }
      // Copying H264 cannot close the first HLS segment until another source
      // keyframe arrives. Re-encode once if opening frames arrived but the
      // remux cannot publish two segments. The foreground URL is still unset.
      const ahead=(session.generatedDuration||0)-session.publishedDuration;
      if(session.segments<2&&!session.readyAt&&session.copyVideo&&!session.forceVideoEncode&&ahead>=4&&Date.now()-session.transcodeStartedAt>=3500) {
        restartCopyAsEncode(session,'wall-clock');return;
      }
      // A finalized short video is handled separately by the converter's exit
      // validation. During a download use only published, independent media.
      if(session.segments>=2) {
        clearCopyFallbackCheck(session);
        session.readyAt||=Date.now();
        session.status='ready';
        session.message='Streaming now while the video is prepared in the background. Seek within the available timeline.';
      }else checkOpeningCopyFallback(session,playlist,readAt);
    }finally {
      session.playlistChecking=false;
      const check=session.copyFallbackCheck;
      // The confirmation timer may have fired while an earlier read was in flight.
      if(check?.timer===null&&readAt-check.observedAt<COPY_WAIT_CONFIRM_MS&&
        performance.now()-check.observedAt>=COPY_WAIT_CONFIRM_MS)
        void refreshPlaylist(session).catch(()=>{});
    }
  }

  function watchPlaylist(session,folder) {
    let watcher=null,timer=null;
    const close=()=>{clearTimeout(timer);timer=null;watcher?.close();watcher=null;};
    try {
      watcher=fs.watch(folder,{persistent:false},(event,name)=>{
        if(name&&name!=='index.m3u8'&&!audioRenditionRoles.some(role=>name==='audio-'+role+'.m3u8'))return;
        clearTimeout(timer);
        timer=setTimeout(()=>{timer=null;void refreshPlaylist(session).catch(()=>{});},35);
        timer.unref();
      });
      watcher.on('error',close);
    }catch { /* The periodic scheduler also checks the published manifest. */ }
    return close;
  }

  function stopTranscode(session) {
    if(!session || activeTranscode!==session || session.stopRequested)return;
    clearCopyFallbackCheck(session);
    session.stopRequested=true;
    if(!session.finalizing)session.child?.kill();
  }

  async function startTranscode(session) {
    await ready;if(stopping||session.cancelled||session.finalizing||session.suspended)return;
    if(activeTranscode && activeTranscode!==session) {
      if(activeTranscode.finalizing || activeTranscode.requestOrder>=session.requestOrder){
        session.status='queued';session.message='Queued for playback preparation. Another title is currently being converted.';
        return;
      }
      const previous=activeTranscode;abortRoleProbe(previous);previous.suspended=true;previous.status='queued';previous.message='Playback preparation is paused while your newly selected video is prepared.';
      stopTranscode(previous);
      session.status='queued';session.message='Waiting for the previous video preparation to close.';
      return;
    }
    if(activeTranscode)return;
    const order=session.requestOrder;
    let resolveClose;
    session.runCompletion=new Promise(resolve=>{resolveClose=resolve;});
    session.stopRequested=false;
    activeTranscode=session;session.status='converting';session.generatedDuration=0;session.publishedDuration=0;session.segments=0;session.playlist=null;session.transcodeStartedAt=Date.now();session.message=session.forceVideoEncode?'Creating regular playback segments for this video. Its original keyframes are too far apart for a quick start.':'Preparing the first video segments. Playback starts as soon as they are ready.';
    const run=session.run=randomBytes(6).toString('hex');
    session.dialogueRun=null;
    const folder=session.folder=path.resolve(hlsRoot,session.key,session.run);
    session.audioRun=null;
    writingRuns.add(folder);
    const releaseRun=()=>{
      writingRuns.delete(folder);
      if(activeTranscode===session)activeTranscode=null;
      session.runCompletion=null;
      resolveClose();
      void pump();
    };
    try{await fsp.mkdir(folder,{recursive:true});}
    catch(e){releaseRun();throw e;}
    if(session.cancelled||session.suspended||session.stopRequested||stopping){releaseRun();return;}
    session.dialogueRun=await captureDialogueRun(session,session.run);
    if(session.cancelled||session.suspended||session.stopRequested||stopping){releaseRun();return;}
    const role=roleProbe;
    let waitExpired=false;
    if(!session.roleResult&&session.item.f.progress===1&&role?.session===session&&
      currentRoleProbe(role)&&plausibleCompletedDescription(session.probe)){
      // The ordinary run already owns the slot. Only completed media may use this short handoff.
      const started=performance.now();
      let timer;
      try{
        await Promise.race([role.closed,new Promise(resolve=>{
          timer=setTimeout(()=>{waitExpired=true;resolve();},COMPLETED_DESCRIPTION_HANDOFF_MS);
          timer.unref();
        })]);
      }finally{
        clearTimeout(timer);
        role.timing.waitMs=Math.round(performance.now()-started);
        role.timing.waitExpired=waitExpired;
      }
      if(stopping||session.cancelled||session.suspended||session.stopRequested||sessions.get(session.key)!==session||
        session.requestOrder!==order||ordinarySelection!==order||activeTranscode!==session||session.run!==run){
        abortRoleProbe(session);releaseRun();return;
      }
      if(waitExpired)abortRoleProbe(session);
    }
    const alternate=waitExpired?null:takeRoleResult(session);
    session.url=`/hls/${session.key}/${session.run}/index.m3u8`;
    const video=session.probe.streams.find(s=>s.codec_type==='video');
    const canCopy=!session.forceVideoEncode&&video.codec_name==='h264' && ['yuv420p','yuvj420p'].includes(video.pix_fmt||'yuv420p');session.copyVideo=canCopy;
    // On incomplete sources, two short encoded segments can open playback
    // after four seconds of media rather than eight. Grow back to four-second
    // keyframe spacing after startup, avoiding a permanent increase in files.
    const quickStart=!canCopy&&session.item.f.progress<1;
    const keyframes=quickStart?'expr:gte(t,if(lte(n_forced,2),2*n_forced,4*n_forced-4))':'expr:gte(t,n_forced*4)';
    const videoArgs=canCopy?['-c:v','copy']:['-c:v','libx264','-preset','veryfast','-crf','23','-threads','2','-vf',"scale=w='trunc(min(1920,iw)/2)*2':h=-2",'-pix_fmt','yuv420p','-force_key_frames',keyframes,'-sc_threshold','0'];
    // A fast copy can reach a missing piece before the next default progress report.
    const copyProgress=canCopy&&session.item.f.progress<1?['-stats_period','0.1']:[];
    const target=quickStart?2:4;
    const mux=alternate?descriptionTeeMux(target):['-f','hls','-hls_time',String(target),'-hls_list_size','0',
      '-hls_playlist_type','event','-hls_flags','independent_segments+temp_file','-hls_segment_filename',
      path.join(folder,'seg%06d.ts'),path.join(folder,'index.m3u8')];
    if(alternate)session.audioRun={run,folder,target,ordinal:alternate.ordinal,source:alternate.source,renditions:{},alignment:null};
    const extraMap=alternate?['-map','0:a:'+alternate.ordinal]:[],extraCodec=alternate?['-c:a:1','copy']:[];
    const args=['-hide_banner','-loglevel','warning','-nostdin','-y','-fflags','+genpts',...copyProgress,...inputOptions(session),
      '-i',sourceUrl(session,run),'-map','0:v:0','-map',alternate?'0:a:0':'0:a:0?',...extraMap,...videoArgs,
      '-c:a','aac','-ac','2','-b:a','160k',...extraCodec,'-max_muxing_queue_size','1024','-progress','pipe:1','-nostats',...mux];
    const closeWatch=watchPlaylist(session,folder);
    let child;
    try{child=spawn(ffmpeg,args,{...(alternate?{cwd:folder}:{}),windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch(e){closeWatch();releaseRun();throw e;}
    session.child=child;children.add(child);let progress='',details='';
    child.stdout.on('data',chunk=>{progress+=chunk;const lines=progress.split(/\r?\n/);progress=lines.pop();for(const line of lines){const [key,value]=line.split('=');if(key==='out_time_us' && Number.isFinite(Number(value)))session.generatedDuration=Math.max(0,Number(value)/1000000);if(key==='speed')session.encodingSpeed=value;}});
    child.stderr.on('data',chunk=>{details=(details+chunk).slice(-3000);});
    let finished=false;
    const finish=async(code,spawnError=false)=>{
      if(finished)return;finished=true;closeWatch();children.delete(child);
      // A killed converter may emit close after this file has been selected
      // again. Its exit must not clear or fail the replacement conversion.
      if(session.child!==child){releaseRun();return;}
      clearCopyFallbackCheck(session);
      // Keep ownership until asynchronous validation finishes. Otherwise a
      // concurrent playback poll can start another run and replace the URL
      // between process exit and the completed-file check.
      session.finalizing=true;
      try {
      if(stopping||session.cancelled||session.suspended||session.stopRequested)return;
      if(code===0) {
        let playlist=await fsp.readFile(path.join(session.folder,'index.m3u8'),'utf8').catch(()=>'');
        const current=await info(session.hash,session.index).catch(()=>null);
        const sourceComplete=current&&(current.f.progress>=1||(await buffer(current,{verifyComplete:true}).catch(()=>({bytes:0}))).bytes>=current.f.size);
        if(stopping||session.cancelled||session.suspended||session.stopRequested||session.child!==child)return;
        playlist=await publishCompletedManifest(session.folder,{sourceComplete,duration:session.duration,published:playlist});
        if(stopping||session.cancelled||session.suspended||session.stopRequested||session.child!==child)return;
        const actualDuration=playlistDuration(playlist),durationComplete=!session.duration||actualDuration>=session.duration-2;session.publishedDuration=actualDuration;
        if(sourceComplete&&durationComplete&&playlist.includes('#EXTINF:')&&playlist.includes('#EXT-X-ENDLIST')) {
          session.readyFile=await fileStamp(current).catch(()=>null);
          if(stopping||session.cancelled||session.suspended||session.stopRequested||session.child!==child)return;
          const audioWork=finishAudioRun(session,current,playlist,actualDuration);
          if(!session.readyAt&&session.audioRun)await awaitDialogueDeadline(audioWork,AbortSignal.timeout(45),null);
          if(stopping||session.cancelled||session.suspended||session.stopRequested||session.child!==child)return;
          session.complete=true;session.readyAt||=Date.now();session.status='ready';session.message='Ready to play. Your original download and playback copy are kept.';
          const [dialogue,audio]=await Promise.all([finishDialogueRun(session,current),audioWork]);
          if(stopping||session.cancelled||session.suspended||session.stopRequested||session.child!==child)return;
          await fsp.writeFile(path.join(hlsRoot,session.key,'completed.json'),JSON.stringify({run:session.run,size:session.fileSize,
            duration:session.duration||session.generatedDuration,...(dialogue?{dialogue}:{}),...(audio?{audio}:{})})).catch(()=>{});
        }else {session.complete=false;session.status='error';session.message=playlist.includes('#EXTINF:')?'The playback stream was interrupted before the video finished. Your download is kept. Retry playback to continue preparing it.':'The video converter produced no playable segments. Retry playback or choose another source.';}
      }else {session.status='error';session.message=spawnError?'The video converter could not start. Restart Cinema.':'Playback preparation was interrupted. Check that qBittorrent is downloading, then retry. Your original file is kept.';session.diagnostic=details;}
      }finally {
        if(session.child===child)session.child=null;
        session.finalizing=false;releaseRun();
      }
    };
    let spawnError=false;
    child.once('error',()=>{spawnError=true;});
    child.once('close',code=>void finish(code,spawnError));
  }
  async function updateSession(session) {
    if(session.busy || session.finalizing || session.cancelled || session.suspended || session.status==='error' || stopping)return;
    session.busy=true;
    try {
      const item=await info(session.hash,session.index,{telemetry:true});
      if(session.cancelled||session.suspended||session.finalizing||stopping)return;
      session.item=item;session.fileSize=item.f.size;session.telemetryError=null;
      if(item.f.progress>=1&&session.copyFallbackCheck)clearCopyFallbackCheck(session);
      session.buffer=await buffer(item);
      if(session.cancelled||session.suspended||session.finalizing||stopping)return;
      if(session.mode==='direct'){
        if(!session.readyFile&&session.directFile&&item.f.progress===1){
          const file=await fileStamp(item).catch(()=>null);
          if(file&&file.ino!==0n&&file.ino===session.directFile.ino&&file.dev===session.directFile.dev)session.readyFile=file;
        }
        return;
      }
      if(session.complete)return;
      if(await loadCompleted(session,item)){abortRoleProbe(session);return;}
      if(session.cancelled||session.suspended||session.finalizing||stopping)return;
      if(item.offset===undefined && item.f.progress<1) {session.status='buffering';session.message='Waiting for this file to finish: its exact torrent piece layout could not be verified.';return;}
      if(session.child)return; // Playlist publication is independent of qBittorrent reads.
      if(!session.probe) {
        if(Date.now()<(session.nextProbe||0))return;
        const minimum=Math.min(item.f.size,STARTUP_BYTES);
        if(session.buffer.bytes<minimum && item.f.progress<1){session.status='buffering';session.stage='opening';session.message=/^(?:paused|stopped)/.test(item.t.state)?'This download is paused. Resume it to build the opening playback buffer.':'Downloading the opening video pieces before playback.';return;}
        session.openingReadyAt||=Date.now();
        startRoleProbe(session,item);
        session.header=await movieIndex(item);
        if(!session.header.ready){
          session.status='buffering';session.stage='index';session.message='The opening buffer is ready. Downloading the video index needed for playback; some MP4 files store it near the end.';
          await refreshIndexPriority(session,item);
          return;
        }
        session.indexReadyAt||=Date.now();
        session.stage='inspecting';
        session.status='buffering';session.message='Reading the video format and preparing playback…';
        try {session.probe=await runProbe(session);session.lastProbeError=null;session.probeReadyAt=Date.now();}
        catch(e) {abortRoleProbe(session);session.roleResult=null;if(session.cancelled||session.suspended||stopping)return;session.lastProbeError=e.message;session.nextProbe=Date.now()+4000;if(item.f.progress>=1 && e.status!==503){session.probeFailures=(session.probeFailures||0)+1;if(session.probeFailures>=2)throw error('This video could not be read. Retry or try another source.',422);}if(e.status===409){session.message=session.probeAttempts>1?'Still waiting for required video data. Check the waiting region below; downloading more of the middle does not help when a required header is missing.':e.message;return;}throw e;}
        if(session.cancelled||session.suspended||stopping)return;
        session.duration=Number(session.probe.format?.duration)||Number(session.probe.streams.find(s=>s.codec_type==='video')?.duration)||undefined;
        if(!session.forceHls && directCompatible(item,session.probe)) {
          const observedFile=await fileStamp(item).catch(()=>null);
          if(session.cancelled||session.suspended||stopping)return;
          if(session.appointmentBacking&&!sameAppointmentStamp(session.appointmentBacking,observedFile))throw appointmentChanged();
          session.directFile=observedFile;
          if(item.f.progress===1)session.readyFile=observedFile;
          session.mode='direct';session.status='ready';session.readyAt||=Date.now();
          session.url='/stream?hash='+session.hash+'&index='+session.index;
          session.message=item.f.progress>=1?'Ready to play your downloaded video.':'Streaming verified pieces while qBittorrent downloads ahead.';
          return;
        }
        session.mode='hls';
      }
      if(!activeTranscode || activeTranscode.requestOrder<session.requestOrder)await startTranscode(session);else {session.status='queued';session.message='Queued for playback preparation. Another title is currently being converted.';}
    }catch(e){
      if([401,502,503].includes(e.status)){
        session.telemetryError=e.message;
        if(!session.child&&session.status!=='ready'){session.status='buffering';session.message=e.message;}
      }else {session.status='error';session.message=e.message;}
    }
    finally {session.busy=false;}
  }
  async function pump() {
    if(stopping)return;
    await priorityReady;
    if(stopping)return;
    expireWarmLease();expireRescueProposal();
    const currentTime=Date.now();
    if(currentTime>=nextPrioritySweep){
      nextPrioritySweep=currentTime+1500;
      for(const [hash,saved] of priorities){
        if(priorityChecks.has(hash)||priorityLocks.has(hash))continue;
        // Poll outside the mutation lock. A slow daemon cannot pile up queued
        // priority work or delay a new play request behind a periodic read.
        const work=telemetrySnapshot(hash).then(async current=>{
          if(current.all.find(f=>f.index===saved.index)?.progress>=1)
            await priorityLock(hash,async()=>{if(priorities.get(hash)===saved)await restorePriority(hash);});
        }).catch(async e=>{
          if(e.status===404)await priorityLock(hash,async()=>{if(priorities.get(hash)===saved)await restorePriority(hash);});
        });
        priorityChecks.set(hash,work);
        void work.finally(()=>{if(priorityChecks.get(hash)===work)priorityChecks.delete(hash);}).catch(()=>{});
      }
    }
    if(activeTranscode)void refreshPlaylist(activeTranscode).catch(()=>{});
    // A real queue continues preparing titles even after their player closes.
    for(const session of [...sessions.values()].sort((a,b)=>b.requestOrder-a.requestOrder)){
      const observed=now()-Math.max(session.lastObserved||0,session.lastRequested||0)<VIEWER_GRACE_MS;
      if((session.complete||session.mode==='direct')&&!observed)continue;
      if(session.busy||session.suspended||session.cancelled||session.finalizing||session.status==='error'||currentTime<(session.nextTelemetry||0))continue;
      session.nextTelemetry=currentTime+(session.probe||session.complete?1500:750);
      void updateSession(session);
    }
  }
  const scheduler=setInterval(()=>void pump(),750);scheduler.unref();
  function serialize(session) {
    const item=session.item,t=item?.t||{};
    const target=session.buffer?.target||0;
    const focused=priorities.get(session.hash),deferred=focused?.index===session.index?focused.files.filter(f=>f.priority>0&&f.applied===0).length:0;
    const totalSize=item?.all.reduce((sum,f)=>sum+f.size,0)||0,totalDone=item?.all.reduce((sum,f)=>sum+f.size*clamp(f.progress),0)||0;
    let pending=[...(activeStreams.get(session.hash)||[])].filter(transfer=>transfer.index===session.index&&transfer.waiting).map(transfer=>transfer.waiting).sort((a,b)=>a.since-b.since)[0];
    if(!pending&&!session.probe&&item?.f.progress<1){
      const offset=session.header&&!session.header.ready?session.header.at:session.buffer?.ratio<1?session.buffer.bytes:null;
      if(Number.isFinite(offset)){
        if(session.gateWaiting?.byteOffset!==offset)session.gateWaiting={byteOffset:offset,pieceIndex:item.offset!==undefined&&item.pieceSize?Math.floor((item.offset+offset)/item.pieceSize):null,since:Date.now(),region:offset<STARTUP_BYTES?'opening':offset>=item.f.size*.9?'end':'middle'};
        pending=session.gateWaiting;
      }
    }
    const waiting=pending?{byteOffset:pending.byteOffset,pieceIndex:pending.pieceIndex,region:pending.region,waitSeconds:Math.floor((Date.now()-pending.since)/1000)}:null;
    const sinceStart=at=>at?Math.max(0,at-session.startedAt):null;
    const startup={
      elapsedSeconds:Math.floor(sinceStart(session.readyAt||Date.now())/1000),
      openingReadyMs:sinceStart(session.openingReadyAt),indexReadyMs:sinceStart(session.indexReadyAt),
      probeReadyMs:sinceStart(session.probeReadyAt),firstSegmentMs:sinceStart(session.firstSegmentAt),readyMs:sinceStart(session.readyAt),
      probeAttempts:session.probeAttempts||0,lastProbeError:session.lastProbeError||null,
      encodingSpeed:session.encodingSpeed||null,telemetryError:session.telemetryError||null,waiting,
      copyFallback:session.copyFallback||null,
      ...(session.audioRoleTiming?{audioRole:session.audioRoleTiming}:{}),
    };
    return {hash:session.hash,index:session.index,sessionId:session.sessionId,status:session.status,message:session.message,mode:session.mode||null,stage:session.status==='ready'?'streaming':session.child?'segments':session.stage||'opening',startup,headerProgress:session.header?.progress,url:session.status==='ready'?session.url:undefined,progress:clamp(item?.f.progress),bufferProgress:clamp(session.buffer?.ratio),bufferedBytes:session.buffer?.bytes||0,bufferTarget:target,duration:session.duration,availableDuration:session.mode==='hls'?Math.min(session.duration||Infinity,session.publishedDuration||0):undefined,conversionProgress:session.duration?clamp((session.generatedDuration||0)/session.duration):undefined,complete:Boolean(session.complete),deferredFiles:deferred,priorityNote:deferred?'Downloading this video first for streaming. Other files in this download resume automatically when it finishes.':null,download:{speed:t.dlspeed||0,eta:t.eta,seeds:t.num_seeds||0,peers:t.num_leechs||0,state:t.state,progress:clamp(item?.f.progress),totalProgress:totalSize?clamp(totalDone/totalSize):clamp(t.progress)},fileName:item?.f.name,probeFacts:releaseProbeFacts(session.probe),audio:audioRunProjection(session),playable:true};
  }
  async function prepare(hash,index,options={}) {
    const startedAt=Date.now();
    hash=validHash(hash);
    const sceneSelection=selectSceneForeground();
    abortAppointmentProbe();
    ++pendingSelections;
    try{
      let item,stamp;
      if(options.appointment){
        const selection=ordinarySelection;
        try{item=await info(hash,index);stamp=await verifyAppointment(item,options.appointment);}
        catch{throw appointmentChanged();}
        if(selection!==ordinarySelection||!options.appointment.isCurrent())throw appointmentChanged();
      }
      const requestOrder=++ordinarySelection;abortRoleProbe();clearWarmLease();invalidateRescue();
      const result=await prepareSelected(hash,index,options,startedAt,requestOrder,item,stamp);
      if(sceneSelection===sceneGeneration)sceneForeground=matchingSession({hash,index:Number(index),sessionId:result.sessionId});
      return result;
    }finally{--pendingSelections;}
  }
  function sourceMemoryFile(item){
    const f=item?.f;
    if(!f||!Number.isSafeInteger(f.size)||f.size<=0||typeof f.name!=='string'||
      item.all.filter(file=>VIDEO.test(file.name)).length!==1)return null;
    return {hash:item.hash,index:f.index,name:f.name,size:f.size};
  }
  function consumeSourceMemoryStart(hash,index,sessionId,context){
    const session=sessions.get(hash+'-'+index),proof=session?.sourceMemoryStart;
    if(!proof||session.sessionId!==sessionId||session.cancelled||session.suspended||session.restoredHls||
      session.status!=='ready'||!session.url||!['direct','hls'].includes(session.mode)||
      Date.now()-session.startedAt<0||Date.now()-session.startedAt>30*60*1000||
      proof.scope!==context.scope||proof.connectionEpoch!==context.connectionEpoch||proof.revision!==context.revision)return null;
    const exact=sourceMemoryFile(session.item),prior=proof.file;
    if(!exact||exact.hash!==prior.hash||exact.index!==prior.index||exact.name!==prior.name||exact.size!==prior.size)return null;
    session.sourceMemoryStart=null;
    return {...exact,condition:proof.condition,mode:session.mode};
  }
  async function prepareSelected(hash,index,options,startedAt,requestOrder,confirmedItem,appointmentBacking) {
    const item=confirmedItem||await info(hash,index);const key=`${hash}-${Number(index)}`;let session=sessions.get(key);
    cancelledHashes.delete(hash);
    let memoryStart=null;
    if(session&&(options.retry||appointmentBacking&&
      (session.mode!=='direct'||!sameAppointmentStamp(session.readyFile,appointmentBacking)))) {
      session.cancelled=true;session.probeChild?.kill();stopTranscode(session);
      sessions.delete(key);session=null;
    }
    if(!session) {
      session={key,hash,index:Number(index),sessionId:randomBytes(16).toString('hex'),startedAt,status:'buffering',message:'Preparing your video…',item,forceHls:Boolean(options.forceHls||options.forceTranscode||options.mode==='hls')};sessions.set(key,session);
      if(options.sourceMemory&&!options.retry&&!options.forceTranscode&&!options.forceHls&&!options.mode&&
        Number.isFinite(item.f.progress)&&item.f.progress>=0&&item.f.progress<=1){
        const file=sourceMemoryFile(item);
        if(file){
          session.sourceMemoryStart={...options.sourceMemory,file,condition:item.f.progress<1?'downloading':'downloaded'};
          memoryStart={revision:options.sourceMemory.revision,size:file.size};
        }
      }
    }
    if(appointmentBacking){
      session.appointmentBacking=appointmentBacking;
      session.checkedDisk=true;
    }
    session.requestOrder=Math.max(session.requestOrder||0,requestOrder);
    session.lastRequested=Date.now();session.item=item;session.suspended=false;
    if(roleExecutable&&!session.probe&&!session.roleAttempted&&!session.checkedDisk&&/\.mkv$/i.test(item.f.name)){
      if(item.f.progress===1)startRoleProbe(session,item);
      else void buffer(item).then(opening=>{
        if(opening.bytes>=Math.min(item.f.size,STARTUP_BYTES))startRoleProbe(session,item);
      }).catch(()=>{});
    }
    if((options.forceHls||options.forceTranscode) && session.mode==='direct'){session.mode='hls';session.forceHls=true;session.status='queued';}
    if(item.f.progress<1) {
      await focusDownload(item);
    }
    void updateSession(session);
    return memoryStart?{...serialize(session),memoryStart}:serialize(session);
  }
  async function playback(hash,index) {
    expireRescueProposal();
    hash=validHash(hash);const key=`${hash}-${Number(index)}`,session=sessions.get(key);
    if(!session) {
      const item=await info(hash,index,{telemetry:true});const b=await buffer(item);
      return {status:'idle',message:'Press play to prepare this video.',progress:clamp(item.f.progress),bufferProgress:b.ratio,download:{speed:item.t.dlspeed||0,eta:item.t.eta,seeds:item.t.num_seeds||0,state:item.t.state}};
    }
    // An existing player reads cached status. The scheduler owns updates and
    // preparation even if the client is paused, minimized, or polling rapidly.
    abortAppointmentProbe();
    observeFastStart(key);
    session.lastObserved=now();return serialize(session);
  }
  async function serveAudio(req,res,key,run,folder,name,media){
    const session=sessions.get(key),state=session?.audioRun;
    if(!state||state.run!==run||!currentAudioRun(session,state))throw error('Audio rendition is no longer current.',404);
    if(name===audioMasterName){
      if(!audioRunProjection(session))throw error('Audio renditions are not available.',404);
      const body=Buffer.from(audioMaster);
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':body.length,'Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:body);
      return;
    }
    const rendition=state.renditions[media.role];
    if(!state.alignment||!rendition)throw error('Audio rendition is not ready.',404);
    if(media.number===null){
      const body=Buffer.from(state.complete?rendition.text:rendition.text.replace(/^#EXT-X-ENDLIST\r?\n?/gm,''));
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':body.length,'Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:body);
      return;
    }
    if(media.number>=rendition.durations.length)throw error('Audio segment is not ready.',404);
    let handle;
    try{
      const root=await fsp.realpath(hlsRoot),filename=path.join(folder,name),real=await fsp.realpath(filename);
      if(real!==path.join(root,key,run,name)||!validAudioSegment(await fsp.lstat(filename)))throw error('Audio segment is not ready.',404);
      handle=await fsp.open(real,'r');
      const stat=await handle.stat();
      if(!validAudioSegment(stat)||!currentAudioRun(session,state))throw error('Audio segment is no longer available.',404);
      res.writeHead(200,{'Content-Type':'video/mp2t','Content-Length':stat.size,'Cache-Control':'private, max-age=86400'});
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(handle.createReadStream({autoClose:false}),res);
    }catch(e){
      if(!res.headersSent){
        state.withdrawn=true;
        throw error('Audio segment is no longer available.',404);
      }
      throw e;
    }finally{if(handle)await handle.close();}
  }
  async function serveHls(req,res,url) {
    const parts=url.pathname.split('/').filter(Boolean);
    const name=parts[3],side=audioMediaFile(name);
    if(parts.length!==4 || parts[0]!=='hls' || !/^(?:[a-f\d]{40}|[a-f\d]{64})-\d+$/i.test(parts[1]) || !/^[a-f\d]{12}$/i.test(parts[2]) ||
      !side&&name!==audioMasterName&&!/^(?:index\.m3u8|seg\d{6}\.ts)$/.test(name))throw error('Playback segment not found',404);
    const key=parts[1].toLowerCase(),run=parts[2].toLowerCase();
    abortAppointmentProbe();
    const folder=path.resolve(hlsRoot,key,run);
    if(cacheReserved(folder))throw error('Playback copy is being cleared. Prepare the title again to play it.',404);
    readingRuns.set(folder,(readingRuns.get(folder)||0)+1);
    try {
    if(side||name===audioMasterName)return await serveAudio(req,res,key,run,folder,name,side);
    const candidate=path.join(folder,name);let real;
    try {real=await fsp.realpath(candidate);if(!inside(await fsp.realpath(hlsRoot),real))throw error('Invalid playback path',403);}catch(e){if(e.status)throw e;throw error('Playback segment is not ready yet.',404);}
    const playlist=parts[3].endsWith('.m3u8');
    // FFmpeg atomically replaces the growing playlist. Read it once so its
    // Content-Length and body always describe the same published version.
    if(playlist) {
      const session=sessions.get(key);
      const preview=rescueProposal?.expiresAt>now()?rescueProposal.candidate:null;
      let contents=await fsp.readFile(real);
      // Publish end-of-movie only after the converter exit has been validated
      // against the full source and expected duration (not merely exit code 0).
      if(!(session?.complete&&session.run===run)&&!(preview?.complete&&preview.key===key&&preview.run===run))contents=Buffer.from(contents.toString('utf8').replace(/^#EXT-X-ENDLIST\r?\n?/gm,''));
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl','Content-Length':contents.length,'Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:contents);return;
    }
    const stat=await fsp.stat(real);
    res.writeHead(200,{'Content-Type':'video/mp2t','Content-Length':stat.size,'Cache-Control':'private, max-age=86400'});
    if(req.method==='HEAD'){res.end();return;}
    await pipeline(fs.createReadStream(real),res);
    }finally{
      const count=readingRuns.get(folder)-1;
      if(count)readingRuns.set(folder,count);else readingRuns.delete(folder);
    }
  }
  async function cancel(hash) {
    hash=validHash(hash);cancelledHashes.add(hash);++ordinarySelection;invalidateRescue();
    const sceneClosed=scenePreview.cancel(hash);
    if(sceneForeground?.hash===hash){sceneForeground=null;sceneGeneration++;}
    markAppointmentRemoval(hash);
    const appointmentClosed=abortAppointmentProbe(hash);
    const roleClosed=roleProbe?.session.hash===hash?abortRoleProbe(roleProbe.session):null;
    if(warmLease?.source.hash===hash)clearWarmLease();
    const exits=[appointmentClosed,roleClosed,sceneClosed].filter(Boolean);
    await priorityReady;await priorityLock(hash,()=>restorePriority(hash));
    // On Windows an open reader can prevent qBittorrent deleting the original.
    // Completion resolves only after the raw reader's FileHandle is closed.
    for(const transfer of activeStreams.get(hash)||[]) {exits.push(transfer.completion);transfer.cancel();}
    for(const [key,session] of sessions)if(session.hash===hash) {
      session.cancelled=true;session.status='error';session.message='This download was removed from qBittorrent.';
      if(session.runCompletion)exits.push(session.runCompletion);
      stopTranscode(session);
      for(const child of [session.probeChild].filter(Boolean)) {
        exits.push(new Promise(resolve=>{if(child.exitCode!==null){resolve();return;}const timer=setTimeout(resolve,5000);timer.unref();child.once('close',()=>{clearTimeout(timer);resolve();});child.kill();}));
      }
      sessions.delete(key);
    }
    layouts.delete(hash);pieceCache.delete(hash);pendingPieces.delete(hash);telemetrySnapshots.delete(hash);
    await Promise.all(exits);void pump();
  }
  async function remove(hash,{deleteFiles=false}={}) {
    hash=validHash(hash);await cancel(hash);if(!deleteFiles)return;
    const realLocal=await fsp.realpath(local);
    const roots=[{root:hlsRoot,pattern:new RegExp('^'+hash+'-\\d+$','i')},{root:path.join(local,'playback'),pattern:new RegExp('^'+hash+'-\\d+(?:-[a-f\\d]+\\.part)?\\.mp4$','i')}];
    for(const entry of roots) {
      const absoluteRoot=path.resolve(entry.root);const realRoot=await fsp.realpath(absoluteRoot).catch(()=>null);if(!realRoot)continue;
      if(!inside(realLocal,realRoot)||realRoot===realLocal)throw error('Refusing playback cleanup outside Cinema storage.',403);
      for(const name of await fsp.readdir(absoluteRoot)) {
        if(!entry.pattern.test(name))continue;
        const candidate=path.resolve(absoluteRoot,name);if(candidate===absoluteRoot||!inside(absoluteRoot,candidate))throw error('Refusing an invalid playback cleanup path.',403);
        const real=await fsp.realpath(candidate).catch(()=>null);if(!real||!inside(realRoot,real)||real===realRoot)throw error('Refusing playback cleanup outside its storage folder.',403);
        await fsp.rm(candidate,{recursive:true,force:true,maxRetries:4,retryDelay:200});
      }
    }
  }
  async function shutdown() {
    stopping=true;clearWarmLease();invalidateRescue();clearInterval(scheduler);
    const sceneClosed=scenePreview.cancel();
    const appointmentClosed=appointmentProbe?.closed;
    invalidateAppointments();
    const closing=activeTranscode?.runCompletion;
    const roleClosed=abortRoleProbe();
    stopTranscode(activeTranscode);
    for(const transfers of activeStreams.values())for(const transfer of transfers)transfer.cancel();
    for(const child of children)if(child!==activeTranscode?.child)child.kill();
    await Promise.all([closing,appointmentClosed,roleClosed,sceneClosed]);
    await priorityReady;
    await Promise.all([...priorities.keys()].map(hash=>priorityLock(hash,()=>restorePriority(hash)).catch(()=>{})));
  }
  function protectedCacheRuns(){
    const runs=new Set([...writingRuns,...readingRuns.keys()]);
    for(const session of sessions.values())if(session.folder)runs.add(session.folder);
    const checkingFolder=rescueCheckActive?.candidate?.folder, previewFolder=rescueProposal?.candidate?.folder;
    if(checkingFolder)runs.add(checkingFolder);
    if(previewFolder&&rescueProposal.expiresAt>now())runs.add(previewFolder);
    return runs;
  }
  return {files,plannerFile,watchAppointment,invalidateAppointments,beginAppointmentRemoval,prepare,playback,stream,serveHls,cancel,remove,shutdown,protectedCacheRuns,consumeSourceMemoryStart,
    previewScene:scenePreview.start,invalidateScenePreview:scenePreview.cancel,
    warmOptions,warmSwitch,warmStatus,warmReturn,warmDismiss,rescueCheck,rescueCommit,rescueCancel,dialogueProof};
}

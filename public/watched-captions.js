import {dialogueKey} from './scene-finder.js';

const FILE_BYTES=1024*1024, QUERY_BYTES=12*FILE_BYTES, MAX_CUES=64000, MAX_MATCHES=60;
const utf8=new TextEncoder();
const hexId=/^[a-f0-9]{32}$/;
const empty=()=>({matches:[],limited:false});
const collapsed=text=>text.normalize('NFC').replace(/\s+/gu,' ').trim();

function compareText(a,b){
  if(a===b)return 0;
  const left=Array.from(a),right=Array.from(b);
  for(let i=0;i<Math.min(left.length,right.length);i++){
    const difference=left[i].codePointAt(0)-right[i].codePointAt(0);
    if(difference)return difference;
  }
  return left.length-right.length;
}

export function canonicalWatchedCues(tuples){
  if(!Array.isArray(tuples)||tuples.length>MAX_CUES)return null;
  const cues=[];
  let chars=0;
  for(const tuple of tuples){
    if(!Array.isArray(tuple)||tuple.length!==3)return null;
    const [start,end,text]=tuple;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||typeof text!=='string')return null;
    chars+=text.length;
    if(chars>FILE_BYTES)return null;
    cues.push([start,end,collapsed(text)]);
  }
  return cues.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||compareText(a[2],b[2]));
}

export function copyWatchedTrackCues(cues){
  if(!cues||cues.length>MAX_CUES)return null;
  return canonicalWatchedCues(Array.from(cues,cue=>[
    Math.round(cue.startTime*1000),Math.round(cue.endTime*1000),
    String(cue.getCueAsHTML?.().textContent??cue.text??'')
  ]));
}

export async function watchedCueDigest(tuples){
  const cues=canonicalWatchedCues(tuples);
  if(!cues)return null;
  const digest=await crypto.subtle.digest('SHA-256',utf8.encode(JSON.stringify(cues)));
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}

function intersections(video,caption,window){
  video=[...video].sort((a,b)=>a[0]-b[0]);
  caption=[...caption].sort((a,b)=>a[0]-b[0]);
  const result=[];
  let a=0,b=0;
  while(a<video.length&&b<caption.length){
    const first=video[a],second=caption[b];
    const start=Math.max(first[0],second[0],window?.[0]??0);
    const end=Math.min(first[1],second[1],window?.[1]??Infinity);
    if(start<end)result.push([start,end]);
    if(first[1]<=second[1])a++;
    else b++;
  }
  return result;
}

export function eligibleWatchedCues(cues,video,caption,{offsetMs=0,window=null}={}){
  const allowed=intersections(video,caption,window);
  const result=[];
  let group=0;
  for(const [start,end,text] of cues){
    const startMs=start+offsetMs,endMs=end+offsetMs;
    while(group<allowed.length&&allowed[group][1]<=startMs)group++;
    if(group>=allowed.length)break;
    if(text&&startMs>=allowed[group][0]&&endMs<=allowed[group][1])
      result.push({startMs,endMs,text,group});
  }
  return result;
}

export function matchWatchedCues(cues,query,limit=Infinity){
  const phrase=dialogueKey(query);
  if(!phrase)return [];
  const matches=[];
  for(let i=0;i<cues.length&&matches.length<limit;i++){
    const cue=cues[i],key=dialogueKey(cue.text);
    if(key.includes(phrase)){
      matches.push(cue);
      continue;
    }
    const next=cues[i+1];
    if(!next||next.group!==cue.group||next.startMs<cue.endMs-150||next.startMs>cue.endMs+1250)continue;
    const tail=dialogueKey(next.text);
    if(!tail.includes(phrase)&&(key+' '+tail).includes(phrase))
      matches.push({...cue,endMs:next.endMs,text:cue.text+' '+next.text});
  }
  return matches;
}

const stamp='(?:\\d{2,}:)?\\d{2}:\\d{2}\\.\\d{3}';
const timing=new RegExp('^'+stamp+'[ \\t]+-->[ \\t]+'+stamp+'(?:[ \\t].*)?$');

function cueCount(bytes){
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n');}catch{return null;}
  const [head,...blocks]=text.split(/\n(?:[ \t]*\n)+/);
  if(!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(head)||head.includes('-->'))return null;
  let count=0;
  for(const block of blocks){
    const [first,second]=block.split('\n',2);
    if(!first||/^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(first))continue;
    if(!timing.test(first)&&(!second||first.includes('-->')||!timing.test(second)))return null;
    if(++count>MAX_CUES)return null;
  }
  return count;
}

async function parseNativeCaption(bytes,expected,signal){
  signal.throwIfAborted();
  const media=document.createElement('video'),track=document.createElement('track');
  const url=URL.createObjectURL(new Blob([bytes],{type:'text/vtt'}));
  const listeners=new AbortController();
  let timer;
  try{
    const loaded=new Promise(resolve=>{
      track.addEventListener('load',()=>resolve(true),{signal:listeners.signal});
      track.addEventListener('error',()=>resolve(false),{signal:listeners.signal});
      signal.addEventListener('abort',()=>resolve(false),{signal:listeners.signal});
      timer=setTimeout(()=>resolve(false),2500);
    });
    media.hidden=true;
    media.preload='none';
    track.kind='subtitles';
    track.src=url;
    media.append(track);
    document.body.append(media);
    track.track.mode='hidden';
    if(!await loaded||track.track.cues?.length!==expected)return null;
    return copyWatchedTrackCues(track.track.cues);
  }finally{
    clearTimeout(timer);
    listeners.abort();
    media.remove();
    URL.revokeObjectURL(url);
  }
}

export async function readLocalWatchedCaption(id,limit=FILE_BYTES,signal){
  if(!hexId.test(id||'')||limit<1)return {bytes:0};
  limit=Math.min(limit,FILE_BYTES);
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
  let bytes=0,reader;
  try{
    const response=await fetch('/api/subtitles/file?id='+encodeURIComponent(id),{cache:'no-store',signal});
    if(!response.ok||!response.body||Number(response.headers.get('content-length'))>limit){
      await response.body?.cancel().catch(()=>{});
      return {bytes:0};
    }
    reader=response.body.getReader();
    const chunks=[];
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.byteLength;
      if(bytes>limit){
        await reader.cancel().catch(()=>{});
        return {bytes:limit};
      }
      chunks.push(value);
    }
    const payload=new Uint8Array(bytes);
    let offset=0;
    for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.byteLength;}
    const count=cueCount(payload);
    if(count===null)return {bytes};
    const cues=await parseNativeCaption(payload,count,signal);
    if(!cues)return {bytes};
    return {bytes,cues,digest:await watchedCueDigest(cues)};
  }catch{
    return {bytes:Math.min(bytes,limit)};
  }finally{reader?.releaseLock();}
}

export async function searchWatchedCaptions(records,{query,verify,read=readLocalWatchedCaption,signal}={}){
  if(dialogueKey(query).length<2)return empty();
  const candidates=records.filter(record=>record.caption&&intersections(record.video,record.caption.ranges).length)
    .sort((a,b)=>b.updatedAt-a.updatedAt);
  const matches=[];
  let remaining=QUERY_BYTES,examined=0,limited=false;
  for(let start=0;start<candidates.length;){
    signal?.throwIfAborted();
    if(remaining<=0||examined>=MAX_CUES||matches.length>=MAX_MATCHES){limited=true;break;}
    const count=remaining>=2*FILE_BYTES?2:1,allowance=Math.min(FILE_BYTES,remaining);
    const batch=await Promise.all(candidates.slice(start,start+count).map(async record=>{
      if(!await verify(record,signal))return {record,bytes:0};
      const file=await read(record.caption.id,allowance,signal);
      return {...file,record};
    }));
    signal?.throwIfAborted();
    start+=batch.length;
    for(const {record,bytes,cues,digest} of batch){
      remaining-=Math.min(allowance,Math.max(0,bytes||0));
      if(!cues||digest!==record.caption.digest)continue;
      const eligible=eligibleWatchedCues(cues,record.video,record.caption.ranges,{offsetMs:record.caption.offsetMs});
      const allowanceCues=MAX_CUES-examined,allowanceMatches=MAX_MATCHES-matches.length;
      const hits=matchWatchedCues(eligible.slice(0,allowanceCues),query,allowanceMatches+1);
      limited||=eligible.length>allowanceCues||hits.length>allowanceMatches;
      examined+=Math.min(allowanceCues,eligible.length);
      matches.push(...hits.slice(0,allowanceMatches).map(hit=>({...hit,record})));
    }
  }
  return {matches,limited};
}

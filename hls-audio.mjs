import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const audioMasterName='audio-master.m3u8';
export const audioRenditionRoles=['original','description'];
const maxManifestBytes=512*1024;
const maxSegments=8192;
const ptsWrap=2**33;

const mediaName=role=>'audio-'+role+'.m3u8';
const segmentName=(role,number)=>'audio-'+role+'-'+String(number).padStart(6,'0')+'.ts';
export const audioMaster=[
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="cinema",NAME="Original embedded",DEFAULT=YES,AUTOSELECT=YES',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="cinema",NAME="Original",DEFAULT=NO,AUTOSELECT=YES,URI="audio-original.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="cinema",NAME="Audio description",DEFAULT=NO,AUTOSELECT=YES,CHARACTERISTICS="public.accessibility.describes-video",URI="audio-description.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="cinema"',
  'index.m3u8',''
].join('\n');

export function audioMediaFile(name){
  const found=/^audio-(original|description)(?:\.m3u8|-(\d{6})\.ts)$/.exec(name);
  return found&&{role:found[1],number:found[2]===undefined?null:Number(found[2])};
}

export function descriptionProbeExecutable(env=process.env,platform=process.platform){
  const executable=env.CINEMA_DESCRIPTION_FFPROBE;
  if(executable!==undefined)return path.isAbsolute(executable)?executable:null;
  return platform==='win32'?'C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe':null;
}

function streamLayout(probe){
  if(!Array.isArray(probe?.streams)||probe.streams.length>128)return null;
  const streams=probe.streams.filter(stream=>['audio','video'].includes(stream?.codec_type));
  if(streams.some((stream,i)=>!Number.isSafeInteger(stream.index)||stream.index<0||stream.index>1024||
    i>0&&stream.index<=streams[i-1].index||typeof stream.codec_name!=='string'||!stream.codec_name))return null;
  return streams;
}

function disposition(dispositions,key){
  const value=dispositions?.[key];
  return value===0||value===1?value:null;
}

function startTime(stream){
  if(!['number','string'].includes(typeof stream.start_time)||!String(stream.start_time).trim())return NaN;
  return Number(stream.start_time);
}


function safeAacDescription(stream){
  return stream?.codec_name==='aac'&&stream.profile==='LC'&&
    [1,2].includes(stream.channels)&&[44100,48000].includes(Number(stream.sample_rate));
}

export function plausibleCompletedDescription(packaged){
  const streams=streamLayout(packaged);
  if(!streams)return false;
  const audio=streams.filter(stream=>stream.codec_type==='audio');
  const video=streams.find(stream=>stream.codec_type==='video'),original=audio[0];
  if(!video||disposition(original?.disposition,'default')!==1||
    audio.filter(stream=>disposition(stream.disposition,'default')===1).length!==1)return false;
  return audio.slice(1).some(candidate=>{
    if(!safeAacDescription(candidate)||disposition(candidate.disposition,'dependent')===1)return false;
    const times=[video,original,candidate].map(startTime);
    return times.some(value=>!Number.isFinite(value))||Math.max(...times)-Math.min(...times)<=.1;
  });
}

export function descriptionAudioOrdinal(modern,packaged){
  const roles=streamLayout(modern),ordinary=streamLayout(packaged);
  if(!roles||!ordinary||roles.length!==ordinary.length||
    roles.some((stream,i)=>stream.index!==ordinary[i].index||stream.codec_name!==ordinary[i].codec_name||
      stream.codec_type!==ordinary[i].codec_type))return null;
  const audio=roles.filter(stream=>stream.codec_type==='audio'),video=roles.find(stream=>stream.codec_type==='video');
  const originals=audio.filter(stream=>disposition(stream.disposition,'default')===1);
  const described=audio.filter(stream=>disposition(stream.disposition,'visual_impaired')===1);
  if(!video||disposition(video.disposition,'attached_pic')!==0||audio.length<2||originals.length!==1||
    originals[0]!==audio[0]||described.length!==1||described[0]===audio[0]||
    audio.some(stream=>['default','visual_impaired','dependent'].some(key=>disposition(stream.disposition,key)===null)))return null;
  const [original]=originals,[description]=described;
  if(disposition(original.disposition,'visual_impaired')!==0||disposition(original.disposition,'dependent')!==0||
    disposition(description.disposition,'default')!==0||disposition(description.disposition,'dependent')!==0)return null;
  const packagedDescription=ordinary.find(stream=>stream.index===description.index);
  if(!safeAacDescription(description)||!safeAacDescription(packagedDescription)||description.channels!==packagedDescription.channels||
    Number(description.sample_rate)!==Number(packagedDescription.sample_rate))return null;
  const reference=[video,original,description],starts=reference.map(startTime);
  const ordinaryStarts=reference.map(stream=>startTime(ordinary.find(entry=>entry.index===stream.index)));
  if([...starts,...ordinaryStarts].some(value=>!Number.isFinite(value))||
    Math.max(...starts)-Math.min(...starts)>.1||Math.max(...ordinaryStarts)-Math.min(...ordinaryStarts)>.1||
    starts.some((value,i)=>Math.abs(value-ordinaryStarts[i])>.1))return null;
  return audio.indexOf(description);
}

export function descriptionTeeMux(target){
  const slave=(list,selection,segments,onfail='ignore')=>
    '[f=hls:onfail='+onfail+':select='+selection.replaceAll(':','\\\\:')+
    ':hls_time='+target+':hls_list_size=0:hls_playlist_type=event:hls_flags=independent_segments+temp_file:hls_segment_filename='+segments+']'+list;
  return ['-f','tee',[
    slave('index.m3u8','v:0,a:0','seg%06d.ts','abort'),
    slave(mediaName('original'),'a:0','audio-original-%06d.ts'),
    slave(mediaName('description'),'a:1','audio-description-%06d.ts')
  ].join('|')];
}

async function readGenerated(folder,name,limit,{prefix=false}={}){
  const filename=path.join(folder,name);
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.size<=0||(!prefix&&before.size>limit))return null;
  const handle=await fs.open(filename,'r');
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.ino!==before.ino||stat.size!==before.size||stat.mtimeMs!==before.mtimeMs)return null;
    const bytes=Buffer.alloc(Math.min(stat.size,limit));
    if((await handle.read(bytes,0,bytes.length,0)).bytesRead!==bytes.length)return null;
    const after=await handle.stat();
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)return null;
    return bytes;
  }finally{await handle.close();}
}

export function parseAudioRendition(text,role,target){
  if(!audioRenditionRoles.includes(role)||typeof text!=='string'||text.length>maxManifestBytes)return null;
  const lines=text.trimEnd().split(/\r?\n/);
  if(lines[0]!=='#EXTM3U')return null;
  const headers=new Set();
  const durations=[];
  let duration=null,seconds=0,complete=false;
  for(const line of lines.slice(1)){
    if(complete)return null;
    if(duration!==null){
      if(line!==segmentName(role,durations.length)||durations.length>=maxSegments)return null;
      durations.push(duration);seconds+=duration;duration=null;continue;
    }
    const segment=/^#EXTINF:(\d{1,2}(?:\.\d{1,9})?),$/.exec(line);
    if(segment){
      duration=Number(segment[1]);
      if(!headers.has('start')||!headers.has('type')||!headers.has('target')||duration<=0||duration>target+1)return null;
      continue;
    }
    if(line==='#EXT-X-ENDLIST'){complete=true;continue;}
    const field=line==='#EXT-X-MEDIA-SEQUENCE:0'?'start':line==='#EXT-X-PLAYLIST-TYPE:EVENT'?'type':
      line==='#EXT-X-INDEPENDENT-SEGMENTS'?'independent':/^#EXT-X-VERSION:\d{1,2}$/.test(line)?'version':
      /^#EXT-X-TARGETDURATION:[1-5]$/.test(line)&&Number(line.at(-1))<=target+1?'target':null;
    if(!field||durations.length||headers.has(field))return null;
    headers.add(field);
  }
  return durations.length&&duration===null?{text,durations,seconds,complete}:null;
}

export async function readAudioRendition(folder,role,target,previous=null,{signal}={}){
  try{
    signal?.throwIfAborted();
    const raw=await readGenerated(folder,mediaName(role),maxManifestBytes);
    const parsed=raw&&parseAudioRendition(raw.toString('utf8'),role,target);
    if(!parsed)return {invalid:true};
    if(previous&&previous.durations.some((duration,i)=>parsed.durations[i]!==duration))return {invalid:true};
    // FFmpeg atomically publishes immutable segments before advancing an EVENT list.
    // Read only new files and recheck the endpoints during live growth.
    const count=parsed.durations.length,first=previous?previous.durations.length:0;
    for(let start=first;start<count;start+=24){
      signal?.throwIfAborted();
      const chunk=Array.from({length:Math.min(24,count-start)},(_,i)=>segmentName(role,start+i));
      const stats=await Promise.all(chunk.map(name=>fs.lstat(path.join(folder,name))));
      if(stats.some(stat=>!validAudioSegment(stat)))return {invalid:true};
    }
    if(previous){
      const stats=await Promise.all([0,count-1].map(i=>fs.lstat(path.join(folder,segmentName(role,i)))));
      if(stats.some(stat=>!validAudioSegment(stat)))return {invalid:true};
    }
    return {rendition:parsed};
  }catch(error){return {invalid:error.code!=='ENOENT'||Boolean(previous)};}
}

export function validAudioSegment(stat){
  return Boolean(stat?.isFile()&&stat.size>=188&&stat.size%188===0);
}

function firstPts(bytes){
  const found={audio:null,video:null};
  for(let at=0;at+188<=bytes.length;at+=188){
    if(bytes[at]!==0x47)return null;
    const flags=bytes[at+3],type=(flags>>4)&3;
    if(!(bytes[at+1]&0x40)||bytes[at+1]&0x80||flags&0xc0||!(type&1))continue;
    const start=at+4+(type&2?1+bytes[at+4]:0);
    if(start+14>at+188||bytes[start]!==0||bytes[start+1]!==0||bytes[start+2]!==1)continue;
    const id=bytes[start+3],stream=id>=0xc0&&id<=0xdf?'audio':id>=0xe0&&id<=0xef?'video':null;
    if(!stream||found[stream]!==null||!(bytes[start+7]&0x80)||bytes[start+8]<5)continue;
    const [a,b,c,d,e]=bytes.subarray(start+9,start+14);
    if(!(a&1)||!(c&1)||!(e&1))return null;
    found[stream]=((a>>1)&7)*2**30+b*2**22+(c>>1)*2**15+d*2**7+(e>>1);
    if(found.audio!==null&&found.video!==null)break;
  }
  return found;
}

export async function audioStartAlignment(folder){
  try{
    const names=['seg000000.ts',segmentName('original',0),segmentName('description',0)];
    const tracks=await Promise.all(names.map(name=>readGenerated(folder,name,256*1024,{prefix:true})));
    const points=tracks.map(bytes=>bytes&&firstPts(bytes));
    if(points.some(point=>!point||point.audio===null)||points[0].video===null)return null;
    const origin=points[0].audio;
    const delta=pts=>((pts-origin+ptsWrap+ptsWrap/2)%ptsWrap-ptsWrap/2)/90000;
    const gaps=[delta(points[0].video),delta(points[1].audio),delta(points[2].audio)];
    if(gaps.some(gap=>Math.abs(gap)>.1)||Math.abs(gaps[1]-gaps[2])>.1)return null;
    return {original:Math.abs(gaps[1]-gaps[0]),description:Math.abs(gaps[2]-gaps[0])};
  }catch{return null;}
}

export function audioManifestDigest(text){
  return createHash('sha256').update(text).digest('hex');
}

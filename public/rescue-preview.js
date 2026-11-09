import {captureEdition,compareEditions} from './edition-atlas-model.js';
import {createDialogueIndex,createSceneAnchor,resolveScenePin} from './scene-relay.js';

const OPENING_LIMIT=1.25;
const SEEK_TOLERANCE=.75;
const CAPTION_LIMIT=8000;
const HASH=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const inSpan=(time,[start,end])=>time>=start&&time<end;

export function mapRescueScene(source,target){
  if(!source||!target||!Number.isFinite(source.time)||source.time<0||!source.identity||
    source.identity!==target.identity||source.hash===target.hash)return null;
  const comparison=compareEditions(captureEdition(source),captureEdition(target));
  if(comparison.status!=='ready')return null;
  const shared=comparison.spans.find(span=>span.kind==='shared'&&inSpan(source.time,span.first));
  if(!shared)return null;
  const anchor=createSceneAnchor(createDialogueIndex(source.cues.slice(0,CAPTION_LIMIT)),source.time);
  if(!anchor?.before||!anchor.after)return null;
  const match=resolveScenePin({fileKey:source.fileKey,identity:source.identity,position:source.time,anchor},
    {fileKey:target.fileKey,identity:target.identity,index:createDialogueIndex(target.cues.slice(0,CAPTION_LIMIT))});
  if(match.state!=='matched'||!inSpan(match.time,shared.second))return null;
  const shift=match.time-source.time;
  const offsets=shared.first.map((time,index)=>shared.second[index]-time);
  // Atlas bounds are used only to reject a match; the time comes from the
  // actual target dialogue match and its cue-relative displacement.
  return shift>=Math.min(...offsets)-1.5&&shift<=Math.max(...offsets)+1.5?match.time:null;
}

export function rescuePreviewURL(state,origin){
  if(!state||typeof state.url!=='string'||!HASH.test(state.hash||'')||!Number.isSafeInteger(state.index)||state.index<0||
    state.status!=='ready')return null;
  let url;
  try{url=new URL(state.url,origin);}catch{return null;}
  if(url.origin!==origin||url.username||url.password||url.hash)return null;
  if(state.mode==='direct'&&url.pathname==='/stream'&&url.searchParams.size===2&&
    url.searchParams.get('hash')===state.hash&&url.searchParams.get('index')===String(state.index))return url.href;
  if(state.mode==='hls'&&state.complete===true&&!url.search&&
    new RegExp('^/hls/'+state.hash+'-'+state.index+'/[a-f0-9]{12}/index\\.m3u8$').test(url.pathname))return url.href;
  return null;
}

function withAbort(value,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(value).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

async function stage(parent,milliseconds,message,run){
  parent.throwIfAborted();
  const timerSignal=new AbortController();
  const signal=AbortSignal.any([parent,timerSignal.signal]);
  const timer=setTimeout(()=>timerSignal.abort(Error(message)),milliseconds);
  try{return await run(signal);}
  finally{clearTimeout(timer);timerSignal.abort();}
}

function decodeFrame(video,signal,accept,start){
  return new Promise((resolve,reject)=>{
    let handle=null,settled=false;
    const abort=()=>finish(signal.reason);
    const failed=()=>finish(Error('This replacement could not decode a picture. Choose another release.'));
    function finish(error,time){
      if(settled)return;
      settled=true;
      signal.removeEventListener('abort',abort);
      video.removeEventListener('error',failed);
      if(handle!==null)video.cancelVideoFrameCallback(handle);
      if(error)reject(error);
      else resolve(time);
    }
    function frame(_now,metadata){
      handle=null;
      const time=metadata?.mediaTime;
      if(Number.isFinite(time)&&time>=0&&video.videoWidth>0&&video.videoHeight>0&&
        !video.seeking&&video.readyState>=2&&!video.error&&accept(time)){
        finish(null,time);
      }else if(!settled)handle=video.requestVideoFrameCallback(frame);
    }
    if(signal.aborted){abort();return;}
    if(video.error){failed();return;}
    signal.addEventListener('abort',abort,{once:true});
    video.addEventListener('error',failed,{once:true});
    handle=video.requestVideoFrameCallback(frame);
    try{Promise.resolve(start()).catch(failed);}
    catch{failed();}
  });
}

function waitHls(engine,event,signal,start){
  return new Promise((resolve,reject)=>{
    const abort=()=>finish(signal.reason);
    const ready=()=>finish();
    function finish(error){
      engine.off(event,ready);
      signal.removeEventListener('abort',abort);
      if(error)reject(error);else resolve();
    }
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    engine.on(event,ready);
    try{start();}catch(error){finish(error);}
  });
}

function readCaptionTrack(video,subtitle,signal){
  return new Promise((resolve,reject)=>{
    const track=document.createElement('track');
    track.kind='subtitles';
    track.srclang='en';
    track.src='/api/subtitles/file?id='+encodeURIComponent(subtitle.id);
    const offset=Number.isFinite(subtitle.offset)&&Math.abs(subtitle.offset)<=3600?subtitle.offset:0;
    const abort=()=>finish(signal.reason);
    const failed=()=>finish(Error('The saved replacement subtitles could not be loaded.'));
    function finish(error,result){
      signal.removeEventListener('abort',abort);
      track.removeEventListener('load',ready);
      track.removeEventListener('error',failed);
      track.remove();
      if(error)reject(error);else resolve(result);
    }
    function ready(){
      const cues=[],originalTimes=[];
      const list=track.track.cues;
      for(let index=0;index<Math.min(list?.length||0,CAPTION_LIMIT);index++){
        const cue=list[index],startTime=Math.max(0,cue.startTime+offset);
        cues.push({startTime,endTime:Math.max(startTime+.01,cue.endTime+offset),
          text:String(cue.getCueAsHTML?.().textContent??cue.text??'').slice(0,900)});
        originalTimes.push([cue.startTime,cue.endTime]);
      }
      finish(null,{cues,originalTimes,offset});
    }
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    track.addEventListener('load',ready,{once:true});
    track.addEventListener('error',failed,{once:true});
    video.append(track);
    track.track.mode='hidden';
  });
}

function rangeCovers(ranges,time){
  for(let index=0;index<(ranges?.length||0);index++){
    if(time>=ranges.start(index)&&time+.2<ranges.end(index))return true;
  }
  return false;
}
function canPreviewSeek(video,state,fragments,time,hlsEngine){
  if(!Number.isFinite(time)||time<0||Number.isFinite(video.duration)&&time+.2>=video.duration)return false;
  if(rangeCovers(video.buffered,time))return true;
  if(!rangeCovers(video.seekable,time))return false;
  if(state.mode==='direct')return state.progress===1;
  return state.complete===true&&(!hlsEngine||fragments?.some(([start,end])=>time>=start&&time+.2<end));
}

export async function previewRescue({attachment,source,subtitle,loadHls,signal}={}){
  signal?.throwIfAborted();
  const {file,state,identity}=attachment||{};
  const url=rescuePreviewURL(state,location.origin);
  if(!url||file?.index!==state.index||state.hash===source?.hash||
    typeof state.sessionId!=='string'||!state.sessionId)throw Error('This replacement file is no longer ready.');
  const video=document.createElement('video');
  if(typeof video.requestVideoFrameCallback!=='function')
    throw Error('Cinema could not verify a decoded replacement frame on this device.');
  video.muted=true;video.defaultMuted=true;video.volume=0;video.playsInline=true;
  video.preload='metadata';video.disablePictureInPicture=true;video.disableRemotePlayback=true;
  video.setAttribute('aria-hidden','true');video.tabIndex=-1;
  // Keep a tiny composited surface so WebView2 can present a proof frame.
  // The surface cannot receive focus, input or audible playback.
  Object.assign(video.style,{position:'fixed',width:'2px',height:'2px',left:'0',top:'0',
    opacity:'.01',pointerEvents:'none',zIndex:'2147483647'});
  const failure=new AbortController();
  const lifetime=signal?AbortSignal.any([signal,failure.signal]):failure.signal;
  let engine=null,fragments=null;
  try{
    (document.querySelector('#player-dialog[open]')||document.body).append(video);
    const openingFrame=await stage(lifetime,8500,'The replacement did not decode its opening in time.',async step=>{
      if(state.mode==='hls'){
        let Hls;
        try{Hls=await withAbort(loadHls?.(),step);}catch{step.throwIfAborted();}
        if(Hls?.isSupported?.()){
          engine=new Hls({enableWorker:false,startPosition:0,backBufferLength:0,maxBufferLength:3,maxMaxBufferLength:6,maxBufferSize:8*1024*1024});
          engine.on(Hls.Events.ERROR,(_event,data)=>{
            if(data.fatal)failure.abort(Error('The saved replacement stream could not be read.'));
          });
          engine.on(Hls.Events.LEVEL_LOADED,(_event,data)=>{
            fragments=(data.details?.fragments||[]).map(fragment=>[fragment.start,fragment.start+fragment.duration]);
          });
          await waitHls(engine,Hls.Events.MEDIA_ATTACHED,step,()=>engine.attachMedia(video));
          await waitHls(engine,Hls.Events.MANIFEST_PARSED,step,()=>engine.loadSource(url));
        }else if(video.canPlayType('application/vnd.apple.mpegurl'))video.src=url;
        else throw Error('This replacement stream needs browser playback support.');
      }else video.src=url;
      return decodeFrame(video,step,time=>time<=OPENING_LIMIT,()=>video.play());
    });
    signal?.throwIfAborted();
    video.pause();engine?.stopLoad();
    const result={beginning:true,openingFrame,sceneTime:null};
    if(!source?.identity||source.identity!==identity||!Array.isArray(source.cues)||
      !/^[a-f0-9]{32}$/.test(subtitle?.id||''))return result;
    try{
      const captions=await stage(lifetime,2500,'The saved replacement subtitles did not load.',step=>readCaptionTrack(video,subtitle,step));
      const target={hash:state.hash,index:state.index,fileKey:state.hash+':'+state.index,
        sessionId:state.sessionId,identity,label:file.name,track:0,
        duration:Number.isFinite(video.duration)&&video.duration>0?video.duration:state.duration,...captions};
      const sceneTime=mapRescueScene(source,target);
      if(sceneTime===null||!canPreviewSeek(video,state,fragments,sceneTime,engine))return result;
      const sceneFrame=await stage(lifetime,4000,'The matched scene did not decode in time.',step=>
        decodeFrame(video,step,time=>Math.abs(time-sceneTime)<=SEEK_TOLERANCE,()=>{
          engine?.startLoad(sceneTime);
          video.currentTime=sceneTime;
          return video.play();
        }));
      signal?.throwIfAborted();
      return {...result,sceneTime,sceneFrame};
    }catch{
      signal?.throwIfAborted();
      return result;
    }
  }finally{
    try{engine?.destroy();}
    finally{video.pause();video.removeAttribute('src');video.load();video.remove();}
  }
}

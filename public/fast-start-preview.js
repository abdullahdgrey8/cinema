import {rescuePreviewURL} from './rescue-preview.js';

const MAX_PREVIEW_BYTES=6*1024*1024;
const PREVIEW_TIMEOUT_MS=8500;
const OPENING_LIMIT=1.25;
const RUNWAY_SECONDS=3;
const RUNWAY_TOLERANCE=.75;

function requirePreviewURL(attachment,previewBytes){
  const {state,file}=attachment||{};
  if(state?.mode!=='direct'||typeof state.sessionId!=='string'||!state.sessionId||
    !Number.isSafeInteger(state.index)||file?.index!==state.index||
    typeof file.name!=='string'||!/\.(?:mp4|m4v)$/i.test(file.name)||
    !Number.isSafeInteger(file.size)||!Number.isSafeInteger(previewBytes)||
    previewBytes<1||previewBytes>MAX_PREVIEW_BYTES||previewBytes>file.size){
    throw Error('This copy does not have a supported opening preview.');
  }
  const url=rescuePreviewURL(state,location.origin);
  if(!url)throw Error('This copy no longer has an exact local preview.');
  return url;
}

async function readVerifiedPrefix(url,previewBytes,fileSize,signal){
  const range='0-'+(previewBytes-1);
  const response=await fetch(url,{headers:{Range:'bytes='+range},redirect:'error',cache:'no-store',signal});
  const length=response.headers.get('Content-Length');
  if(signal.aborted||response.status!==206||response.redirected||(response.url&&response.url!==url)||!response.body||
    response.headers.get('Content-Range')!=='bytes '+range+'/'+fileSize||
    length!==null&&length!==String(previewBytes)){
    void response.body?.cancel().catch(()=>{});
    signal.throwIfAborted();
    throw Error('The local opening range could not be verified.');
  }
  const bytes=new Uint8Array(previewBytes),reader=response.body.getReader();
  let count=0,complete=false;
  const cancel=()=>void reader.cancel().catch(()=>{});
  signal.addEventListener('abort',cancel,{once:true});
  try{
    while(true){
      signal.throwIfAborted();
      const {done,value}=await reader.read();
      signal.throwIfAborted();
      if(done)break;
      if(value.byteLength>previewBytes-count)throw Error('The local opening range exceeded its verified length.');
      bytes.set(value,count);
      count+=value.byteLength;
    }
    if(count!==previewBytes)throw Error('The local opening range was shorter than expected.');
    complete=true;
    return bytes;
  }finally{
    signal.removeEventListener('abort',cancel);
    if(!complete)cancel();
    reader.releaseLock();
  }
}

function decodeOpening(video,signal){
  return new Promise((resolve,reject)=>{
    let handle=null,settled=false,openingFrame=null;
    const abort=()=>finish(signal.reason);
    const failed=()=>finish(Error('The copy could not decode its opening and three seconds of video.'));
    function finish(error,proof){
      if(settled)return;
      settled=true;
      signal.removeEventListener('abort',abort);
      video.removeEventListener('error',failed);
      video.removeEventListener('ended',failed);
      if(handle!==null)video.cancelVideoFrameCallback(handle);
      if(error)reject(error);
      else resolve(proof);
    }
    function frame(_now,metadata){
      handle=null;
      if(settled)return;
      const time=metadata?.mediaTime;
      if(Number.isFinite(time)&&time>=0&&video.videoWidth>0&&video.videoHeight>0&&
        !video.paused&&!video.seeking&&video.readyState>=2&&!video.error){
        if(openingFrame===null){
          if(time>OPENING_LIMIT){failed();return;}
          openingFrame=time;
        }else if(time-openingFrame>=RUNWAY_SECONDS){
          if(time-openingFrame>RUNWAY_SECONDS+RUNWAY_TOLERANCE){failed();return;}
          finish(null,{openingFrame,runwayFrame:time});
          return;
        }
      }
      handle=video.requestVideoFrameCallback(frame);
    }
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    video.addEventListener('error',failed,{once:true});
    video.addEventListener('ended',failed,{once:true});
    try{
      handle=video.requestVideoFrameCallback(frame);
      Promise.resolve(video.play()).catch(failed);
    }catch{failed();}
  });
}

async function previewOpening(bytes,signal){
  signal.throwIfAborted();
  const video=document.createElement('video');
  if(typeof video.requestVideoFrameCallback!=='function'||typeof video.cancelVideoFrameCallback!=='function')
    throw Error('This device could not verify a decoded opening frame.');
  video.muted=true;
  video.defaultMuted=true;
  video.playsInline=true;
  video.disablePictureInPicture=true;
  video.disableRemotePlayback=true;
  video.tabIndex=-1;
  video.setAttribute('aria-hidden','true');
  // A tiny composited surface lets WebView2 present a frame without exposing a player.
  Object.assign(video.style,{position:'fixed',width:'2px',height:'2px',left:'0',top:'0',
    opacity:'.01',pointerEvents:'none',zIndex:'2147483647'});
  const blobURL=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));
  try{
    (document.querySelector('#player-dialog[open]')||document.body).append(video);
    video.src=blobURL;
    return await decodeOpening(video,signal);
  }finally{
    try{
      video.pause();
      video.removeAttribute('src');
      video.load();
    }finally{
      video.remove();
      URL.revokeObjectURL(blobURL);
    }
  }
}

export async function previewFastStart({attachment,previewBytes,signal}={}){
  signal?.throwIfAborted();
  const url=requirePreviewURL(attachment,previewBytes);
  const controller=new AbortController();
  const lifetime=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(Error('The opening preview did not finish in time.')),PREVIEW_TIMEOUT_MS);
  try{
    const prefix=await readVerifiedPrefix(url,previewBytes,attachment.file.size,lifetime);
    const proof=await previewOpening(prefix,lifetime);
    lifetime.throwIfAborted();
    return {...proof,bytes:prefix.byteLength};
  }finally{
    clearTimeout(timer);
    controller.abort();
  }
}

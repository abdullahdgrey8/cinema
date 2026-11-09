import {matchesPlaybackAttachment} from './warm-playback.js';

const endpoint='/api/playback/rescue';
const durationMs=16000;
const prefixLimit=6*1024*1024;
const sourceFields=['hash','index','sessionId','name','size','identity','generation','seekEpoch'];
const sameSource=(first,current)=>Boolean(current&&sourceFields.every(key=>current[key]===first[key])&&
  (!first.url||first.url===current.url));
const sourcePayload=source=>Object.fromEntries(['hash','index','sessionId','name','size','url'].map(key=>[key,source[key]]));
const targetPayload=target=>Object.fromEntries(['hash','index','name','size'].map(key=>[key,target[key]]));
const eligibleTarget=(target,source)=>Boolean(target&&target.hash!==source.hash&&target.identity===source.identity&&/\.(?:mp4|m4v)$/i.test(target.name));
const exactAttachment=(attachment,target)=>Boolean(attachment?.state?.status==='ready'&&
  attachment.state.mode==='direct'&&attachment.state.hash===target.hash&&attachment.state.index===target.index&&
  attachment.file?.index===target.index&&attachment.file.name===target.name&&attachment.file.size===target.size&&
  typeof attachment.state.url==='string'&&typeof attachment.state.sessionId==='string'&&attachment.state.sessionId);

function waitForOpening(signal){
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},1250);
    function stop(){clearTimeout(timer);reject(signal.reason);}
    signal.addEventListener('abort',stop,{once:true});
  });
}

export function createFastStartFlow({api,getSource,validateTarget,preview,attach,render,
  wait=waitForOpening,now=Date.now,schedule=setTimeout,cancelTimer=clearTimeout}){
  let job=null,phase='idle',message='',releasing=null;
  function paint(){
    render({available:Boolean(getSource()),busy:Boolean(job),phase,message});
  }
  function report(next,text=''){
    phase=next;
    message=text;
    paint();
  }
  function release(run){
    if(!run?.ticket)return;
    const ticket=run.ticket;
    run.ticket=null;
    const pending=api(endpoint,{action:'cancel',ticket},AbortSignal.timeout(1500)).catch(()=>{});
    releasing=pending;
    void pending.then(()=>{if(releasing===pending)releasing=null;});
  }
  function stop(next,text){
    const run=job;
    job=null;
    if(run){
      cancelTimer(run.timer);
      run.controller.abort();
      release(run);
    }
    report(next,text);
  }
  function refresh(){
    if(job&&!sameSource(job.source,getSource())){
      stop('cancelled','Fast Start ended. Your original copy stays selected.');
    }else paint();
  }
  function primaryFrame(){
    if(job)stop('primary','Your original copy started first.');
    else paint();
  }
  async function start(target){
    const source=getSource();
    if(job||!source||!eligibleTarget(target,source)||!validateTarget(target,source))return;
    const controller=new AbortController(),deadline=now()+durationMs;
    const run=job={source,controller,ticket:null,timer:null};
    const timeout=()=>{if(job===run)stop('unavailable','Fast Start timed out. Your original copy is still selected.');};
    run.timer=schedule(timeout,durationMs);
    const current=()=>{
      if(job!==run){release(run);return false;}
      if(now()>=deadline){timeout();return false;}
      const active=getSource();
      if(!sameSource(source,active)||!validateTarget(target,active)){
        stop('cancelled','Playback changed. Your original copy stays selected.');
        return false;
      }
      return true;
    };
    report('checking','Checking the alternate opening…');
    try{
      if(releasing)await releasing;
      let reply;
      for(let attempt=0;attempt<12;attempt++){
        if(!current())return;
        reply=await api(endpoint,{action:'check',purpose:'fast-start',from:sourcePayload(source),to:targetPayload(target),
          ...(source.episode?{episode:source.episode}:{movie:source.movie})},controller.signal);
        run.ticket=/^[a-f\d]{48}$/i.test(reply?.ticket||'')?reply.ticket:null;
        if(!current())return;
        if(!reply?.waiting)break;
        if(run.ticket)throw Error('The alternate check returned an invalid offer.');
        report('waiting','Waiting for verified opening video in the alternate…');
        await wait(controller.signal);
      }
      if(!current())return;
      if(reply?.waiting){timeout();return;}
      const {attachment,expiresAt,previewBytes}=reply||{};
      if(!run.ticket||!Number.isFinite(expiresAt)||expiresAt<=now()||!exactAttachment(attachment,target)||
        !Number.isSafeInteger(previewBytes)||previewBytes<1||previewBytes>Math.min(prefixLimit,target.size)){
        throw Error('The checked copy changed or could not be read.');
      }
      report('decoding','Testing pictures in the alternate…');
      const proof=await preview({attachment,previewBytes,signal:controller.signal});
      if(!current())return;
      if(!Number.isFinite(proof?.openingFrame)||proof.openingFrame<0||proof.openingFrame>1.25||
        !Number.isFinite(proof.runwayFrame)||proof.runwayFrame-proof.openingFrame<3||proof.bytes!==previewBytes){
        throw Error('The alternate needs more playable video to start.');
      }
      if(expiresAt<=now())throw Error('The alternate check expired.');
      report('committing','Opening the checked copy…');
      const result=await api(endpoint,{action:'commit',ticket:run.ticket},controller.signal);
      if(!current())return;
      if(!exactAttachment(result?.attachment,target)||!matchesPlaybackAttachment(result.attachment,attachment.state)){
        throw Error('The checked copy changed before it could open.');
      }
      run.ticket=null;
      stop('idle');
      attach({attachment:result.attachment,source:getSource(),target});
    }catch(error){
      if(job===run)stop('unavailable',error.message||'The alternate could not start. Your original copy is still selected.');
    }
  }
  return {start,refresh,primaryFrame,
    cancel:()=>stop('cancelled','Keeping your original copy.'),
    clear:()=>stop('idle'),
  };
}

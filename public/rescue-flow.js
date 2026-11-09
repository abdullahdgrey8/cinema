import { matchesPlaybackAttachment } from './warm-playback.js';

const endpoint='/api/playback/rescue';
const sourceKeys=['hash','index','sessionId','name','size','url','identity','generation','seekEpoch','track'];
const sameSource=(a,b)=>Boolean(a&&b&&sourceKeys.every(key=>a[key]===b[key]));
const sameMoment=(a,b)=>sameSource(a,b)&&(Number.isFinite(a.time)?
  Number.isFinite(b.time)&&Math.abs(b.time-a.time)<=2:
  !Number.isFinite(b.time)||b.time<.75);
const wireSource=source=>Object.fromEntries(['hash','index','sessionId','name','size','url'].map(key=>[key,source[key]]));
const wireTarget=target=>Object.fromEntries(['hash','index','name','size'].map(key=>[key,target[key]]));
const exactTarget=(attachment,target)=>Boolean(attachment?.state?.status==='ready'&&
  ['direct','hls'].includes(attachment.state.mode)&&attachment.state.hash===target.hash&&
  attachment.state.index===target.index&&attachment.file?.index===target.index&&
  attachment.file.name===target.name&&attachment.file.size===target.size&&
  typeof attachment.state.sessionId==='string'&&attachment.state.sessionId.length&&typeof attachment.state.url==='string');

export function createRescueFlow({api,getSource,listCandidates,preview,validateCandidate,attach,render,
  now=Date.now,schedule=setTimeout,cancel=clearTimeout}){
  let open=false,phase='idle',options=[],message='',listing=null,attempt=null,timer=null,releasing=null;
  function paint(){
    render({open,phase,options,message,selected:attempt?.target||null,proof:attempt?.proof||null,
      available:Boolean(getSource())});
  }
  function release(job){
    if(!job?.ticket)return;
    const ticket=job.ticket;
    job.ticket=null;
    const request=api(endpoint,{action:'cancel',ticket},AbortSignal.timeout(1500)).catch(()=>{});
    releasing=request;
    void request.then(()=>{if(releasing===request)releasing=null;});
  }
  function stop(next='idle',text=''){
    const job=attempt;
    attempt=null;
    cancel(timer);timer=null;
    job?.controller.abort();release(job);
    phase=next;message=text;
  }
  function close(){
    open=false;
    listing?.abort();listing=null;
    options=[];stop();paint();
  }
  function refresh(){
    if(open&&attempt&&!sameMoment(attempt.source,getSource())){
      stop('idle','Playback changed. Pause the original before checking again.');
    }
    paint();
  }
  async function list(){
    const source=getSource();
    if(!open||!source||listing||attempt)return;
    const task=listing=new AbortController();
    phase='listing';message='Looking for other releases in My Library…';paint();
    try{
      const candidates=await listCandidates(source,task.signal);
      if(listing!==task||!open)return;
      if(!sameSource(source,getSource())){options=[];message='The active release changed. Check again.';return;}
      options=(Array.isArray(candidates)?candidates:[]).filter(item=>item?.hash!==source.hash&&
        item.identity===source.identity).slice(0,8);
      message=options.length?'Choose a release to check its playback.':'No matching replacement is available in My Library yet.';
    }catch(e){
      if(listing===task&&!task.signal.aborted)message=e.message||'Cinema could not check My Library.';
    }finally{
      if(listing===task){listing=null;phase='idle';paint();}
    }
  }
  function show(){
    if(open)return;
    open=true;paint();void list();
  }
  function cancelCheck(){
    stop('idle','Replacement check canceled.');paint();
  }
  async function check(target){
    const source=getSource();
    if(!open||!source||listing||phase==='committing'||!options.includes(target)||
      source.identity!==target.identity||!validateCandidate(target,source))return;
    stop();
    const job=attempt={source,target,controller:new AbortController(),ticket:null};
    const current=()=>attempt===job&&open&&sameMoment(source,getSource());
    phase='checking';message='Checking the selected file…';paint();
    try{
      if(releasing)await releasing;
      if(!current()){if(attempt===job)stop('idle','Playback changed. Check again.');return;}
      const reply=await api(endpoint,{action:'check',from:wireSource(source),to:wireTarget(target),
        ...(source.episode?{episode:source.episode}:{movie:source.movie})},job.controller.signal);
      job.ticket=reply?.ticket;
      if(!current()){release(job);if(attempt===job)stop('idle','Playback changed. Check again.');return;}
      if(!/^[a-f\d]{48}$/i.test(job.ticket||'')||!Number.isFinite(reply.expiresAt)||reply.expiresAt<=now()||
        !exactTarget(reply.attachment,target))throw Error('The checked file changed. Choose it again.');
      job.expiresAt=reply.expiresAt;
      job.attachment=reply.attachment;
      phase='previewing';message='Testing a frame and looking for your scene…';paint();
      timer=schedule(()=>{
        if(attempt!==job||phase==='committing')return;
        stop('idle','The check expired. Select the release to check it again.');paint();
      },Math.max(1,reply.expiresAt-now()));
      const observed=await preview({...reply.attachment,identity:target.identity},source,target,job.controller.signal);
      if(!current()){if(attempt===job)stop('idle','Playback changed. Check again.');return;}
      if(!observed?.beginning||!Number.isFinite(observed.openingFrame)||observed.openingFrame<0||observed.openingFrame>1.25)
        throw Error('Cinema could not decode the opening of this release.');
      if(Number.isFinite(observed.sceneTime)&&observed.sceneTime>=0&&Number.isFinite(observed.sceneFrame)&&
        Math.abs(observed.sceneTime-observed.sceneFrame)<.75){
        job.proof={sceneTime:observed.sceneTime};
        message='Your scene is ready in this release.';
      }else{
        job.proof={sceneTime:null};
        message='The opening is ready. Cinema could not verify the same scene in this release.';
      }
      phase='ready';
    }catch(e){
      if(attempt===job&&!job.controller.signal.aborted)stop('idle',e.message||'This release could not play.');
    }finally{
      paint();
    }
  }
  async function commit(kind){
    const job=attempt,source=getSource();
    if(phase!=='ready'||!job?.proof||!['scene','beginning'].includes(kind))return;
    if(kind==='scene'&&!Number.isFinite(job.proof.sceneTime))return;
    if(job.expiresAt<=now()||!sameMoment(job.source,source)||!validateCandidate(job.target,source)){
      stop('idle','Playback or the replacement changed. Check again.');paint();return;
    }
    phase='committing';message='Switching to your checked release…';paint();
    try{
      const {attachment}=await api(endpoint,{action:'commit',ticket:job.ticket},job.controller.signal);
      if(attempt!==job)return;
      const current=getSource();
      if(!sameMoment(job.source,current)||!validateCandidate(job.target,current)||
        !exactTarget(attachment,job.target)||!matchesPlaybackAttachment(attachment,job.attachment.state))
        throw Error('Playback or the replacement changed. Check again.');
      const position=kind==='scene'?job.proof.sceneTime:0;
      job.ticket=null;
      close();
      attach(attachment,{position,paused:current.paused,target:job.target,source:current});
    }catch(e){
      if(attempt===job)stop('idle',e.message||'The switch was interrupted. Your original is still open.');
    }finally{
      paint();
    }
  }
  return {show,close,list,check,commit,refresh,cancelCheck};
}

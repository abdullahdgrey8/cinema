import {watchedCueDigest} from './watched-captions.js';
import {
  decodeStudioSubtitle,primaryStudioCues,createStudioCueIndex,activeStudioCue,studioOverlap,
  studioJumpTarget,studioSeekLanded,studioOffsetMs,STUDIO_PAIRINGS_KEY,readStudioPairings,
  writeStudioPairings,studioPairKey,saveStudioPairing,removeStudioPairing,
} from './two-track-model.js';

const MAX_FILE=1024*1024;
const ID=/^[a-f0-9]{32}$/,DIGEST=/^[a-f0-9]{64}$/;
const primaryOffset=value=>Number.isFinite(value)&&Number.isSafeInteger(Math.round(value*1000))?Math.round(value*1000):null;
const UNREADABLE='This subtitle is unreadable or exceeds the 1 MiB read limit.';
const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
const safeName=(value,fallback)=>typeof value==='string'&&value.trim()?Array.from(value.trim()).slice(0,60).join(''):fallback;
const samePlayer=(a,b)=>a?.generation===b?.generation&&a?.url===b?.url;
const sameAttachment=(a,b)=>Boolean(a&&b&&samePlayer(a.player,b.player)&&a.primary?.fileKey===b.primary?.fileKey&&
  a.primary?.id===b.primary?.id&&a.primary?.element===b.primary?.element);
const sameBinding=(a,b)=>sameAttachment(a,b)&&a.primary?.revision===b.primary?.revision&&
  a.primary?.offset===b.primary?.offset&&a.primary?.rows===b.primary?.rows&&a.primary?.status===b.primary?.status;
const sameCue=(a,b)=>Boolean(a&&b&&a.startMs===b.startMs&&a.endMs===b.endMs&&a.text===b.text&&
  a.activeStartMs===b.activeStartMs&&a.activeEndMs===b.activeEndMs);
const samePair=(a,b)=>Boolean(a?.overlap&&b?.overlap&&a.overlap.startMs===b.overlap.startMs&&
  a.overlap.endMs===b.overlap.endMs&&sameCue(a.first,b.first)&&sameCue(a.second,b.second));

export function createTwoTrackStudio({panel,ancestor,dialog,video,getPrimary,getPlayerIdentity,importCaption,
  readCaption,canSeekScene,seekScene,formatTime,storage}){
  const $=name=>panel.querySelector('#two-track-'+name);
  const heading=$('heading'),primaryName=$('primary-name'),primaryLine=$('primary-line'),
    secondaryName=$('secondary-name'),secondaryLine=$('secondary-line'),file=$('file'),offset=$('offset'),
    reset=$('reset'),remove=$('remove'),restore=$('restore'),forget=$('forget'),overlapText=$('overlap'),
    jump=$('jump'),status=$('status');
  let binding=null,primaryData=null,second=null,records=null,positionMs=null,rendered=null,
    operation=null,note='',selectionRevision=0,offsetRevision=0,frame=null,lastSample=-Infinity;
  const visible=()=>Boolean(dialog.open&&ancestor.open&&panel.open&&!document.hidden);
  const capture=()=>({primary:getPrimary(),player:getPlayerIdentity()});
  const valid=()=>Boolean(binding?.player?.url&&binding.primary?.status==='ready'&&binding.primary.element&&
    studioPairKey(binding.primary.fileKey,binding.primary.id)&&primaryOffset(binding.primary.offset)!==null&&
    Array.isArray(binding.primary.rows));

  function abortOperation(){
    const previous=operation;
    operation=null;
    previous?.controller.abort();
  }
  function syncBinding(){
    const next=capture();
    if(sameBinding(binding,next))return false;
    const same=sameAttachment(binding,next),sameRows=binding?.primary?.rows===next.primary?.rows;
    if(!samePlayer(binding?.player,next.player))positionMs=null;
    abortOperation();
    if(!same||!sameRows){
      primaryData=null;second=null;selectionRevision++;offsetRevision++;
      offset.value='0';
    }
    note='';binding=next;
    return true;
  }
  function primaryIndex(){
    if(!primaryData&&valid()){
      const raw=primaryStudioCues(binding.primary.rows);
      primaryData={raw,index:createStudioCueIndex(raw)};
    }
    return primaryData?.index||null;
  }
  function loadRecords(){
    if(records!==null)return;
    try{records=readStudioPairings(storage.getItem(STUDIO_PAIRINGS_KEY));}
    catch{records=[];}
  }
  function savedPair(){
    if(!valid())return null;
    loadRecords();
    const key=studioPairKey(binding.primary.fileKey,binding.primary.id);
    return records.find(item=>studioPairKey(item.fileKey,item.primaryId)===key)||null;
  }
  function persist(updated){
    try{storage.setItem(STUDIO_PAIRINGS_KEY,writeStudioPairings(updated));records=updated;return true;}
    catch{return false;}
  }
  function readPosition(){
    if(!video.seeking&&video.readyState>=1&&Number.isFinite(video.currentTime)&&video.currentTime>=0)
      positionMs=video.currentTime*1000;
  }
  function pairAt(position){
    if(!Number.isFinite(position)||!valid())return {first:null,second:null,overlap:null};
    const first=activeStudioCue(primaryIndex(),position,primaryOffset(binding.primary.offset));
    const counterpart=second?activeStudioCue(second.index,position,second.offsetMs):null;
    return {first,second:counterpart,overlap:studioOverlap(first,counterpart)};
  }
  function hideControl(control,hidden){
    if(hidden&&!control.hidden&&document.activeElement===control)heading.focus({preventScroll:true});
    control.hidden=hidden;
  }

  function render(){
    const primary=binding?.primary,enabled=valid(),saved=savedPair(),busy=operation?.kind==='read';
    rendered=pairAt(positionMs);
    setText(primaryName,enabled?safeName(primary.name,'Selected subtitle'):'Choose a primary subtitle');
    setText(secondaryName,second?.name||'Choose a second subtitle');
    setText(primaryLine,rendered.first?.text||(enabled?'No primary line at this moment.':'No primary track selected.'));
    setText(secondaryLine,rendered.second?.text||(second?'No second line at this moment.':'No second track selected.'));
    file.disabled=!enabled;
    offset.disabled=!second;
    reset.disabled=!second||second.offsetMs===0;
    hideControl(remove,!second);
    hideControl(forget,!saved);
    hideControl(restore,!saved||Boolean(second)&&saved.secondaryId===second.id&&document.activeElement!==restore);
    if(saved)setText(restore,'Restore '+saved.name);
    restore.setAttribute('aria-disabled',String(busy||Boolean(saved&&second?.id===saved.secondaryId)));
    const overlap=rendered.overlap,target=studioJumpTarget(overlap);
    overlapText.hidden=!overlap;
    const ready=target!==null&&!video.seeking&&!operation&&canSeekScene(target/1000);
    if(overlap){
      const start=formatTime(overlap.startMs/1000),end=formatTime(overlap.endMs/1000);
      const range=start===end?((overlap.endMs-overlap.startMs)/1000)+' sec overlap':'Overlap '+start+' – '+end;
      setText(overlapText,range+(target===null?' · Too short to jump to.':ready?'':' · Waiting for a ready seek range.'));
    }
    hideControl(jump,target===null);
    jump.setAttribute('aria-disabled',String(!ready));
    setText(status,busy?'Checking the second subtitle…':note||(!enabled?
      (primary?.status==='loading'?'Reading the primary subtitle…':'Choose a primary subtitle to compare two tracks.'):
      second?'':saved?'A saved pair is available to restore.':'Choose a second subtitle to compare it with the primary track.'));
  }

  function stopFrame(){
    if(frame!==null)cancelAnimationFrame(frame);
    frame=null;lastSample=-Infinity;
  }
  function suspend(){
    if(operation)note='';
    abortOperation();stopFrame();
  }
  function frameLoop(){
    if(!visible()||video.paused||video.ended){stopFrame();return;}
    if(frame!==null)return;
    frame=requestAnimationFrame(now=>{
      frame=null;
      if(!visible()||video.paused||video.ended){stopFrame();return;}
      if(now-lastSample>=50){
        lastSample=now;syncBinding();readPosition();render();
      }
      frameLoop();
    });
  }
  function refresh({sample=false}={}){
    if(!visible()){suspend();return;}
    const changed=syncBinding();
    if(sample||changed||positionMs===null||video.paused||video.ended)readPosition();
    render();frameLoop();
  }
  function primaryChanged(){refresh();}

  function begin(kind){
    abortOperation();
    const attempt={kind,binding,selectionRevision,offsetRevision,controller:new AbortController()};
    operation=attempt;note='';
    return attempt;
  }
  function current(attempt){
    return operation===attempt&&!attempt.controller.signal.aborted&&visible()&&
      attempt.selectionRevision===selectionRevision&&attempt.offsetRevision===offsetRevision&&sameBinding(attempt.binding,capture());
  }
  function commitSecond(attempt,{id,digest,index,name,offsetMs},primaryDigest,remember){
    if(!current(attempt))return;
    second={id,digest,index,name,offsetMs,primaryDigest};
    offset.value=String(offsetMs/1000);
    selectionRevision++;offsetRevision++;
    const primary=binding.primary;
    note='Second subtitle ready.';
    if(remember){
      const pairing={fileKey:primary.fileKey,primaryId:primary.id,primaryDigest,secondaryId:id,
        secondaryDigest:digest,name,offsetMs};
      if(!persist(saveStudioPairing(records,pairing)))note='Second subtitle ready. The pairing couldn’t be saved.';
    }
  }

  async function selectSecond({localFile,record}){
    if(!visible())return;
    syncBinding();
    if(!valid())return;
    loadRecords();primaryIndex();
    const attempt=begin('read'),signal=attempt.controller.signal;
    render();
    try{
      if(!current(attempt))return;
      let imported,decoded;
      if(localFile){
        if(!/\.(srt|vtt|ass|ssa)$/i.test(localFile.name))throw Error('Choose an SRT, VTT, ASS, or SSA subtitle.');
        if(localFile.size>MAX_FILE)throw Error('Choose a subtitle file of 1 MiB or less.');
        const bytes=await localFile.arrayBuffer();
        if(!current(attempt))return;
        decoded=decodeStudioSubtitle(bytes);
      }
      const primaryDigest=await watchedCueDigest(primaryData.raw);
      if(!current(attempt))return;
      if(!DIGEST.test(primaryDigest||''))throw Error('This primary subtitle couldn’t be verified.');
      if(record&&record.primaryDigest!==primaryDigest)throw Error('The saved primary subtitle has changed.');
      if(localFile){
        try{imported=await importCaption({name:localFile.name,text:decoded},signal);}
        catch{if(!current(attempt))return;throw Error('Couldn’t import this local subtitle.');}
        if(!current(attempt))return;
      }
      const id=record?.secondaryId||imported?.id;
      if(!ID.test(id||''))throw Error(UNREADABLE);
      let parsed;
      try{parsed=await readCaption(id,signal);}
      catch{if(!current(attempt))return;throw Error(UNREADABLE);}
      if(!current(attempt))return;
      const digest=parsed?.digest,index=createStudioCueIndex(parsed?.cues);
      if(!index||!DIGEST.test(digest||''))throw Error(UNREADABLE);
      if(record&&record.secondaryDigest!==digest)throw Error('The saved second subtitle has changed.');
      if(digest===primaryDigest)throw Error('This is the same subtitle as the primary track.');
      commitSecond(attempt,{id,digest,index,name:safeName(record?.name||imported?.name||localFile?.name,'Second subtitle'),
        offsetMs:record?.offsetMs??0},primaryDigest,Boolean(localFile));
    }catch(error){
      if(current(attempt))note=error?.message||UNREADABLE;
    }finally{
      if(operation===attempt){
        if(!visible()||signal.aborted){abortOperation();return;}
        operation=null;refresh();
      }
    }
  }

  function changeOffset(value){
    if(!visible())return;
    syncBinding();
    if(!second||value===null||value===second.offsetMs)return;
    abortOperation();offsetRevision++;
    second={...second,offsetMs:value};
    note='';
    const saved=savedPair();
    if(saved&&saved.primaryDigest===second.primaryDigest&&saved.secondaryId===second.id&&saved.secondaryDigest===second.digest&&
      !persist(saveStudioPairing(records,{...saved,offsetMs:value})))note='The timing changed for this session. The pairing couldn’t be saved.';
    refresh();
  }

  async function jumpToOverlap(){
    if(!visible()||video.seeking||operation)return;
    const expected=rendered;
    syncBinding();readPosition();
    const fresh=pairAt(positionMs),target=studioJumpTarget(fresh.overlap);
    if(target===null||!samePair(expected,fresh)||!canSeekScene(target/1000)){render();return;}
    const attempt=begin('seek');
    if(!current(attempt)){abortOperation();return;}
    render();
    let moved=false;
    try{moved=await seekScene(target/1000,attempt.binding.primary.revision);}catch{}
    const owns=operation===attempt;
    const active=current(attempt);
    if(!owns)return;
    const landed=studioSeekLanded({moved,current:active&&!video.seeking,positionMs:video.currentTime*1000,overlap:fresh.overlap});
    operation=null;
    if(!active)return;
    if(landed)note='Jumped to the overlap.';
    refresh({sample:true});
  }

  panel.addEventListener('toggle',()=>refresh());
  ancestor.addEventListener('toggle',()=>refresh());
  dialog.addEventListener('close',()=>{suspend();refresh();});
  new MutationObserver(()=>refresh()).observe(dialog,{attributes:true,attributeFilter:['open']});
  document.addEventListener('visibilitychange',()=>refresh());
  for(const event of ['loadedmetadata','seeked','pause','ended','playing','play'])
    video.addEventListener(event,()=>refresh({sample:true}));
  for(const event of ['seeking','timeupdate','emptied'])video.addEventListener(event,()=>refresh());
  file.addEventListener('change',()=>{
    const localFile=file.files?.[0];
    file.value='';
    if(localFile)void selectSecond({localFile});
  });
  offset.addEventListener('input',()=>{
    const value=offset.value.trim()?studioOffsetMs(Number(offset.value)):null;
    offset.setAttribute('aria-invalid',String(value===null));
    changeOffset(value);
  });
  offset.addEventListener('blur',()=>{offset.setAttribute('aria-invalid','false');offset.value=String((second?.offsetMs??0)/1000);});
  reset.addEventListener('click',()=>{
    if(!second||!visible())return;
    offset.focus({preventScroll:true});changeOffset(0);offset.setAttribute('aria-invalid','false');offset.value=String((second?.offsetMs??0)/1000);
  });
  restore.addEventListener('click',()=>{
    if(restore.getAttribute('aria-disabled')==='true'||!visible())return;
    syncBinding();
    const record=savedPair();
    if(record)void selectSecond({record});
  });
  remove.addEventListener('click',()=>{
    if(!visible())return;
    syncBinding();
    if(!second)return;
    abortOperation();second=null;selectionRevision++;offsetRevision++;offset.value='0';
    note='Second track removed.';render();
  });
  forget.addEventListener('click',()=>{
    if(!visible())return;
    syncBinding();
    const saved=savedPair();
    if(!saved)return;
    abortOperation();
    note=persist(removeStudioPairing(records,saved.fileKey,saved.primaryId))?'Saved pair forgotten.':'Couldn’t forget this pairing.';
    render();
  });
  jump.addEventListener('click',()=>{if(jump.getAttribute('aria-disabled')==='false')void jumpToOverlap();});
  refresh();
  return {primaryChanged,refresh};
}

import {createCoverageWitness,readCoverageStore,writeCoverageStore,mergeCoverage,catchUpPassage,containsCoverage} from './watched-coverage.js';
import {eligibleWatchedCues,readLocalWatchedCaption,searchWatchedCaptions} from './watched-captions.js';

export const WATCHED_ENABLED='cinema-watched-enabled-v1';
export const WATCHED_STORE='cinema-watched-coverage-v1';
const route='/api/watched/proof';
const sealPattern=/^[a-f0-9]{64}$/;
const saveDelay=5000,retryDelay=4000;
const sameFile=(a,b)=>a?.hash===b?.hash&&a?.index===b?.index;
const sameTimeline=(a,b)=>Boolean(a&&b&&a.mode===b.mode&&a.offsetMs===b.offsetMs&&a.run===b.run);
const sameProof=(a,b)=>a?.kind===b?.kind&&a?.seal===b?.seal&&sameTimeline(a?.timeline,b?.timeline);
const sameCaption=(a,b)=>Boolean(a&&b&&a.id===b.id&&a.offsetMs===b.offsetMs);
const proofValid=(proof,source)=>Boolean(proof&&['sealed','volatile'].includes(proof.kind)&&sealPattern.test(proof.seal||'')&&
  sameTimeline(proof.timeline,{mode:source.mode,run:source.run,offsetMs:0}));
const identity=source=>source&&[source.hash,source.index,source.mode,source.run,source.sessionId,source.attachment,source.complete].join(':');
const ms=seconds=>Math.round(seconds*1000);

function boundedWork(){
  let active=0;
  const queue=[];
  function release(){
    if(queue.length)queue[0].finish(true);
    else active--;
  }
  return async function run(work,signal){
    if(signal?.aborted)return null;
    if(active<2)active++;
    else{
      if(queue.length>=6)return null;
      const turn=await new Promise(resolve=>{
        const entry={finish(accepted){
          clearTimeout(timer);
          signal?.removeEventListener('abort',abort);
          const index=queue.indexOf(entry);
          if(index>=0)queue.splice(index,1);
          resolve(accepted);
        }};
        const abort=()=>entry.finish(false);
        const timer=setTimeout(abort,2500);
        queue.push(entry);
        signal?.addEventListener('abort',abort,{once:true});
      });
      if(!turn)return null;
    }
    try{return signal?.aborted?null:await work();}
    finally{release();}
  };
}

export function createWatchedRuntime({storage,api,getSource,getLibrary,getSavedCaption,describe,onChange,now=Date.now,
  readCaption=readLocalWatchedCaption}){
  const get=key=>{try{return storage.getItem(key);}catch{return null;}};
  const put=(key,value)=>{try{storage.setItem(key,value);}catch{}};
  let records=readCoverageStore(get(WATCHED_STORE)),enabled=get(WATCHED_ENABLED)==='yes',attachment=null,evidenceEpoch=0;
  const proofs=boundedWork(),captions=boundedWork();
  const read=async(id,limit,signal)=>await captions(()=>readCaption(id,limit,signal),signal)||{bytes:0};

  async function ask(source,expected,signal){
    return proofs(async()=>{
      try{
        const live=Boolean(source.sessionId&&source.attachment);
        const value=await api(route,{hash:source.hash,index:source.index,mode:source.mode,run:source.run,
          ...(live?{sessionId:source.sessionId,attachment:source.attachment}:{}),...(expected?{expected:expected.seal}:{})},signal);
        return !signal?.aborted&&proofValid(value,source)&&(!expected||sameProof(expected,value))?value:null;
      }catch{return null;}
    },signal);
  }

  function clearAttachment(){
    if(!attachment)return;
    attachment.controller.abort();
    clearTimeout(attachment.timer);
    attachment=null;
  }

  function setEnabled(value){
    enabled=Boolean(value);
    put(WATCHED_ENABLED,enabled?'yes':'no');
    clearAttachment();
    evidenceEpoch++;
    onChange?.('reset');
  }

  function clear(){
    clearAttachment();
    evidenceEpoch++;
    records=[];
    put(WATCHED_STORE,writeCoverageStore(records));
    onChange?.('reset');
  }

  function syncStorage(){
    clearAttachment();
    evidenceEpoch++;
    enabled=get(WATCHED_ENABLED)==='yes';
    records=readCoverageStore(get(WATCHED_STORE));
    onChange?.('reset');
  }

  function current(context){
    return enabled&&attachment===context&&!context.controller.signal.aborted&&identity(getSource())===context.key;
  }

  function start(source,key){
    clearAttachment();
    const context={source,key,controller:new AbortController(),witness:createCoverageWitness(),proof:null,
      pending:false,retryAt:0,timer:null,saving:false};
    attachment=context;
    return context;
  }

  async function admit(context){
    context.pending=true;
    const proof=await ask(context.source,null,context.controller.signal);
    if(!current(context))return;
    context.pending=false;
    if(proof)context.proof=proof;
    else context.retryAt=now()+retryDelay;
  }

  async function commit(context){
    context.timer=null;
    if(!current(context)||context.saving||context.proof?.kind!=='sealed')return;
    const snapshot=context.witness.snapshot();
    if(!snapshot.video.length)return;
    context.saving=true;
    const confirmed=await ask(context.source,context.proof,context.controller.signal);
    context.saving=false;
    if(!current(context))return;
    if(!confirmed){
      context.witness=createCoverageWitness();
      context.proof=null;
      context.retryAt=now()+retryDelay;
      return;
    }
    const latest=context.witness.snapshot().caption;
    if(snapshot.caption&&(!sameCaption(snapshot.caption,latest)||snapshot.caption.digest!==latest.digest))
      snapshot.caption=null;
    const stored=readCoverageStore(get(WATCHED_STORE));
    const next=mergeCoverage(stored,{hash:context.source.hash,index:context.source.index,
      proof:confirmed,updatedAt:now(),...snapshot});
    const serialized=writeCoverageStore(next);
    records=readCoverageStore(serialized);
    put(WATCHED_STORE,serialized);
    onChange?.();
  }

  function observe(sample){
    if(!enabled)return;
    const source=getSource(),key=identity(source);
    if(!source||!sample.eligible){
      boundary();
      return;
    }
    const context=attachment?.key===key?attachment:start(source,key);
    if(!context.proof){
      if(!context.pending&&now()>=context.retryAt)void admit(context);
      return;
    }
    context.witness.observe(sample);
    if(context.proof.kind==='sealed'&&!context.timer&&!context.saving)
      context.timer=setTimeout(()=>void commit(context),saveDelay);
  }

  function boundary(played){
    attachment?.witness.boundary(played);
  }

  function volatileRecord(){
    const context=attachment;
    if(context?.proof?.kind!=='volatile'||!current(context))return null;
    const snapshot=context.witness.snapshot();
    return snapshot.video.length?{hash:context.source.hash,index:context.source.index,proof:context.proof,
      updatedAt:now(),...snapshot}:null;
  }

  function available(){
    const known=new Set(getLibrary().map(item=>item.hash)),pending=volatileRecord();
    return [...(pending?[pending]:[]),...records].filter(record=>known.has(record.hash));
  }

  function selected(record){
    return sameCaption(getSavedCaption(record.hash,record.index),record.caption);
  }

  async function verify(record,signal,requireActive=false){
    if(!getLibrary().some(item=>item.hash===record.hash))return false;
    const attached=getSource();
    const live=sameFile(record,attached)&&sameTimeline(record.proof.timeline,attached&&{
      mode:attached.mode,run:attached.run,offsetMs:0});
    if(requireActive&&!live)return false;
    if(record.proof.kind==='volatile'&&(!live||!sameProof(record.proof,attachment?.proof)||!current(attachment)))return false;
    const source=live?attached:{hash:record.hash,index:record.index,...record.proof.timeline};
    return Boolean(await ask(source,record.proof,signal));
  }

  async function search(query,signal){
    const result=await searchWatchedCaptions(available().filter(record=>selected(record)),{
      query,read,signal,verify
    });
    const results=result.matches.flatMap((hit,ordinal)=>{
      if(!selected(hit.record)||!getLibrary().some(item=>item.hash===hit.record.hash))return [];
      const meta=describe(hit.record.hash,hit.record.index);
      if(!meta)return [];
      const {record,startMs,endMs,text}=hit;
      return [{...meta,key:[record.hash,record.index,record.proof.seal,startMs,endMs,ordinal].join(':'),
        record,startMs,endMs,time:startMs/1000,quote:text}];
    });
    return {results,limited:result.limited};
  }

  function canCatchUp(target){
    if(!target||!Number.isFinite(target.resumeTime))return false;
    return available().some(record=>sameFile(record,target)&&catchUpPassage(record.video,ms(target.resumeTime)));
  }

  async function loadRecap(target,signal){
    const candidates=available().filter(record=>sameFile(record,target)).sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const record of candidates){
      signal?.throwIfAborted();
      const passage=catchUpPassage(record.video,ms(target.resumeTime));
      if(!passage||!await verify(record,signal))continue;
      let lines=[];
      if(record.caption&&selected(record)){
        const loaded=await read(record.caption.id,undefined,signal);
        if(loaded.cues&&loaded.digest===record.caption.digest&&selected(record)){
          lines=eligibleWatchedCues(loaded.cues,record.video,record.caption.ranges,{
            offsetMs:record.caption.offsetMs,window:passage
          }).slice(-3).map(cue=>({time:cue.startMs/1000,text:cue.text}));
        }
      }
      signal?.throwIfAborted();
      return {...describe(record.hash,record.index),record,start:passage[0]/1000,end:passage[1]/1000,
        resumeTime:target.resumeTime,lines,canReplay:false};
    }
    return null;
  }

  function stillCovered(result){
    const witness=available().find(candidate=>sameFile(candidate,result.record)&&sameProof(candidate.proof,result.record.proof));
    if(!witness)return false;
    if(result.kind==='passage')
      return containsCoverage(witness.video,result.startMs,result.endMs);
    return sameCaption(witness.caption,result.record.caption)&&witness.caption.digest===result.record.caption.digest&&
      containsCoverage(witness.video,result.startMs,result.endMs)&&containsCoverage(witness.caption.ranges,result.startMs,result.endMs);
  }

  async function authorize(result,{active=false,caption=null,signal}={}){
    if(!result?.record||!stillCovered(result)||!await verify(result.record,signal,active))return false;
    if(result.kind==='passage')return stillCovered(result);
    if(!selected(result.record)||active&&(!sameCaption(caption,result.record.caption)||caption.digest!==result.record.caption.digest))return false;
    const currentCaption=await read(result.record.caption.id,undefined,signal);
    return !signal?.aborted&&currentCaption.digest===result.record.caption.digest&&selected(result.record)&&stillCovered(result);
  }

  function watchedSpan(source,span,seal){
    if(!enabled||!source?.complete||!source.sessionId||!source.attachment||!span||
      !getLibrary().some(item=>item.hash===source.hash))return null;
    const timeline={mode:source.mode,run:source.run,offsetMs:0};
    return records.find(record=>sameFile(record,source)&&record.proof.kind==='sealed'&&
      (!seal||record.proof.seal===seal)&&sameTimeline(record.proof.timeline,timeline)&&
      containsCoverage(record.video,span.startMs,span.endMs))??null;
  }

  function hasWatchedSpan(span,seal){
    return Boolean(watchedSpan(getSource(),span,seal));
  }

  async function authorizeWatchedSpan(span,signal){
    if(signal?.aborted)return {status:'unverified'};
    const source=getSource(),key=identity(source),epoch=evidenceEpoch,record=watchedSpan(source,span);
    if(!record)return {status:'outside'};
    const confirmed=await ask(source,record.proof,signal);
    const latest=getSource();
    if(!confirmed||signal?.aborted||epoch!==evidenceEpoch||identity(latest)!==key||
      !watchedSpan(latest,span,confirmed.seal))return {status:'unverified'};
    return {status:'ready',seal:confirmed.seal};
  }

  return {getCollection:()=>({enabled,hasEvidence:records.length>0||Boolean(volatileRecord())}),
    setEnabled,clear,syncStorage,observe,boundary,detach:clearAttachment,search,canCatchUp,loadRecap,authorize,hasWatchedSpan,authorizeWatchedSpan};
}

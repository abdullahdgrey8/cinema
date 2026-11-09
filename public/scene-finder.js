import {bindMomentAction} from './scene-preview.js';

const PAGE_SIZE=8;
const NEARBY_GAP=1.25;

export const dialogueKey=text=>String(text||'').normalize('NFKD')
  .replace(/(\p{Script=Latin})\p{M}+/gu,'$1').toLowerCase().replace(/['’]/g,'')
  .replace(/[^\p{L}\p{M}\p{N}]+/gu,' ').trim();

export function indexDialogue(cues){
  return cues.filter(cue=>Number.isFinite(cue.startTime)&&Number.isFinite(cue.endTime)&&cue.endTime>cue.startTime)
    .map(cue=>({cue,key:dialogueKey(cue.text)})).filter(row=>row.key)
    .sort((a,b)=>a.cue.startTime-b.cue.startTime);
}

export function findDialogue(index,query){
  const phrase=dialogueKey(query);
  if(!phrase)return [];
  const matches=[];
  for(let i=0;i<index.length;i++){
    const {cue,key}=index[i],next=index[i+1];
    if(key.includes(phrase)){
      matches.push(cue);
    }else if(next&&next.cue.startTime>=cue.endTime-.15&&next.cue.startTime<=cue.endTime+NEARBY_GAP&&
      !next.key.includes(phrase)&&(key+' '+next.key).includes(phrase)){
      matches.push({...cue,text:cue.text+' '+next.cue.text});
    }
  }
  return matches;
}

export function lastDialogue(index,seconds){
  if(!Number.isFinite(seconds))return null;
  let low=0,high=index.length;
  while(low<high){
    const middle=Math.floor((low+high)/2);
    if(index[middle].cue.startTime<=seconds)low=middle+1;
    else high=middle;
  }
  return index[low-1]?.cue||null;
}

export function createSceneFinder({panel,host,video,getTrack,canSeekScene,seekScene,canPreviewScene,previewScene,previewAttachmentKey,formatTime,openSubtitles,replayCaption}){
  if(!panel||!host)return {trackChanged(){},refresh(){}};
  host.innerHTML=
    '<div class="scene-heading"><div><h3 id="scene-finder-title">Find a scene</h3><p>Search the words you remember. Jump to a ready scene or check a preview when available.</p></div>'+
    '<button class="player-control scene-replay" type="button" data-scene-replay hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 1.8 7.4M3 5v5h5"/><path d="M11 9l4 3-4 3z"/></svg>Replay last line</button></div>'+
    '<form class="scene-search" data-scene-search hidden><label>Search dialogue<input type="search" maxlength="120" autocomplete="off" placeholder="Try a name or phrase"></label></form>'+
    '<p class="scene-status" role="status" data-scene-status></p>'+
    '<button class="player-control scene-subtitle-link" type="button" data-scene-subtitles hidden>Open subtitle settings</button>'+
    '<ul class="scene-matches" aria-label="Matching lines" data-scene-matches hidden></ul>'+
    '<nav class="scene-pages" aria-label="Dialogue results pages" data-scene-pages hidden>'+
    '<button class="player-control" type="button" data-scene-prev>Previous</button><span data-scene-page></span>'+
    '<button class="player-control" type="button" data-scene-next>Next</button></nav>';

  const $=selector=>host.querySelector(selector);
  const form=$('[data-scene-search]'),input=$('input'),replay=$('[data-scene-replay]'),status=$('[data-scene-status]');
  const subtitleLink=$('[data-scene-subtitles]'),list=$('[data-scene-matches]'),pager=$('[data-scene-pages]');
  const previous=$('[data-scene-prev]'),next=$('[data-scene-next]'),pageLabel=$('[data-scene-page]');
  let index=[],matches=[],visible=[],page=0,revision=-1,fileKey,queryTimer,attempt=0,seeking=false;
  const message=text=>{if(status.textContent!==text)status.textContent=text;};
  const format=formatTime||String;
  const available=cue=>Boolean(cue&&canSeekScene?.(cue.startTime));
  const previewable=cue=>Boolean(previewScene&&canPreviewScene?.(cue.startTime));

  function refresh(){
    if(!panel.open)return;
    const replayCue=lastDialogue(index,video.currentTime);
    const replayDisabled=seeking||!available(replayCue);
    const replayTitle=replayCue?'Replay at '+format(replayCue.startTime):'Replay becomes available after the first line.';
    if(replay.disabled!==replayDisabled)replay.disabled=replayDisabled;
    if(replay.title!==replayTitle)replay.title=replayTitle;
    const attachmentKey=previewAttachmentKey?.();
    for(const row of visible){
      const intent=available(row.cue)?'jump':attachmentKey&&previewable(row.cue)?'preview':'waiting';
      row.attachmentKey=intent==='preview'?attachmentKey:null;
      const disabled=intent==='waiting'||seeking;
      if(row.button.disabled!==disabled)row.button.disabled=disabled;
      if(row.intent!==intent){
        row.intent=intent;
        row.action.textContent=intent==='jump'?'Jump':intent==='preview'?'Preview':'Not ready yet';
        row.action.className=intent==='preview'?'scene-action scene-action-preview':'scene-action';
      }
    }
  }

  async function jump(cue,displayedRevision,showCaption=false){
    if(seeking||!cue||displayedRevision!==getTrack().revision)return;
    if(!available(cue)){refresh();message('That moment is unavailable. Try again when more video is ready.');return;}
    const id=++attempt;
    seeking=true;
    refresh();
    message('Jumping to '+format(cue.startTime)+'…');
    let landed=false;
    try{landed=await seekScene?.(cue.startTime,displayedRevision);}catch{}
    if(id!==attempt||displayedRevision!==getTrack().revision)return;
    seeking=false;
    refresh();
    if(!landed){message('That moment is unavailable. Try again when more video is ready.');return;}
    if(showCaption)replayCaption?.(cue,displayedRevision);
    if(panel.open){
      panel.open=false;
      panel.querySelector('summary')?.focus();
    }
  }

  function resultRow(cue){
    const li=document.createElement('li'),button=document.createElement('button');
    const time=document.createElement('span'),line=document.createElement('span'),action=document.createElement('span');
    li.className='scene-match';
    button.type='button';button.className='scene-result';
    time.className='scene-time';time.textContent=format(cue.startTime);
    line.className='scene-line';line.textContent=cue.text;
    button.append(time,line,action);li.append(button);
    const displayedRevision=revision,displayedFile=fileKey;
    const row={li,button,action,cue,intent:null,attachmentKey:null};
    const validate=()=>{
      const current=getTrack();
      return current.revision===displayedRevision&&current.fileKey===displayedFile;
    };
    bindMomentAction(button,()=>({intent:row.intent,attachmentKey:row.attachmentKey}),({intent,attachmentKey})=>{
      if(seeking||!panel.open||!visible.includes(row)||!validate())return;
      if(intent==='jump'){void jump(cue,displayedRevision);return;}
      if(intent!=='preview')return;
      const previewCurrent=()=>validate()&&attachmentKey===previewAttachmentKey?.();
      if(!previewCurrent()){
        refresh();message('Playback changed. Choose the scene again.');return;
      }
      if(available(cue)){
        refresh();message('That moment is ready. Choose Jump to move playback.');return;
      }
      if(!previewable(cue)){
        refresh();message('That moment is unavailable. Try again when more video is ready.');return;
      }
      if(!previewScene(cue.startTime,{origin:'dialogue',opener:button,validate:previewCurrent,attachmentKey}))
        message('Try checking this moment again in a moment.');
    });
    return row;
  }

  function render(){
    const pages=Math.max(1,Math.ceil(matches.length/PAGE_SIZE));
    page=Math.max(0,Math.min(page,pages-1));
    visible=matches.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(resultRow);
    list.replaceChildren(...visible.map(row=>row.li));
    list.hidden=!visible.length;pager.hidden=pages===1;
    previous.disabled=page===0;next.disabled=page===pages-1;
    pageLabel.textContent='Page '+(page+1)+' of '+pages;
    refresh();
  }

  function search(){
    clearTimeout(queryTimer);
    if(!panel.open)return;
    const track=getTrack();
    if(revision!==track.revision||fileKey!==track.fileKey){revision=track.revision;fileKey=track.fileKey;index=indexDialogue(track.cues);}
    const hasDialogue=index.length>0,query=input.value.trim();
    form.hidden=!hasDialogue;replay.hidden=!hasDialogue;
    subtitleLink.hidden=hasDialogue||!track.hasFile||track.status==='loading';
    matches=hasDialogue?findDialogue(index,query):[];
    page=0;
    render();
    if(matches.length){message(matches.length+(matches.length===1?' matching line':' matching lines'));return;}
    if(hasDialogue){message(query?'No matching lines. Try fewer or different words.':'Type a word or phrase to find its moment in the video.');return;}
    if(track.status==='loading'){message('Reading subtitle track…');return;}
    if(track.status==='error'){message('This track could not be read. Try another subtitle track.');return;}
    message(track.hasFile?'Choose or import subtitles to search this video.':'Dialogue search opens when the video file is selected.');
  }

  function changePage(delta){
    page+=delta;render();
    message(matches.length+' matching lines. '+pageLabel.textContent+'.');
    (visible.find(row=>!row.button.disabled)?.button||input).focus();
  }

  function scheduleSearch(){
    clearTimeout(queryTimer);
    queryTimer=setTimeout(search,130);
  }
  form.addEventListener('submit',event=>{event.preventDefault();search();});
  input.addEventListener('input',event=>{if(!event.isComposing)scheduleSearch();});
  input.addEventListener('compositionend',scheduleSearch);
  input.addEventListener('keydown',event=>{
    if(event.key!=='ArrowDown'||event.isComposing)return;
    clearTimeout(queryTimer);
    search();
    const button=visible.find(row=>!row.button.disabled)?.button;
    if(button){event.preventDefault();button.focus();}
  });
  replay.addEventListener('click',()=>{void jump(lastDialogue(index,video.currentTime),revision,true);});
  subtitleLink.addEventListener('click',openSubtitles);
  previous.addEventListener('click',()=>changePage(-1));
  next.addEventListener('click',()=>changePage(1));
  panel.addEventListener('toggle',()=>{
    if(panel.open)search();
    else clearTimeout(queryTimer);
  });
  for(const event of ['timeupdate','progress','seeked','loadedmetadata','durationchange'])video.addEventListener(event,refresh);
  return {
    refresh,
    trackChanged({resetQuery=false}={}){
      attempt++;seeking=false;
      if(resetQuery)input.value='';
      search();
    },
  };
}

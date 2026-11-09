import {updateKeyedList} from './dom.js';
import {buildSoundIndex,projectSoundCues} from './sound-cues.js';

const PAGE_SIZE=10;
const escape=value=>String(value??'').replace(/[&<>"']/g,character=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[character]));
const text=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const samePlayer=(left,right)=>left?.generation===right?.generation&&left?.url===right?.url;
const sameTrack=(left,right)=>left?.revision===right?.revision&&left?.fileKey===right?.fileKey&&
  left?.element===right?.element&&left?.offset===right?.offset&&left?.status===right?.status&&left?.hasFile===right?.hasFile;
const sameHandle=(left,right)=>Boolean(left&&right&&samePlayer(left.player,right.player)&&sameTrack(left.track,right.track));

export function createSoundMap({panel,ancestor,dialog,video,getTrack,getPlayerIdentity,canSeekScene,seekScene,formatTime,openSubtitles}){
  const $=selector=>panel.querySelector(selector);
  const list=$('#sound-map-list'),heading=$('#sound-map-heading'),later=$('#sound-map-later'),
    status=$('#sound-map-status'),limited=$('#sound-map-limited'),subtitles=$('#sound-map-subtitles'),
    pages=$('#sound-map-pages'),pageLabel=$('#sound-map-page'),previous=$('#sound-map-previous'),next=$('#sound-map-next');
  let handle=null,index=null,scan=null,scanFailed=false,wasVisible=false,showLater=false,
    positionMs=null,anchor=null,rows=[],eligible=[],page=0,jump=null,jumpedCue=null;
  const capture=()=>({track:getTrack(),player:getPlayerIdentity()});
  const visible=()=>Boolean(dialog.open&&ancestor.open&&panel.open&&!document.hidden);
  const clock=cue=>String(formatTime(cue.startMs/1000));
  const ready=cue=>Boolean(!video.seeking&&handle?.player?.url&&canSeekScene(cue.startMs/1000));

  function stopScan(){
    const previousScan=scan;
    scan=null;
    previousScan?.controller.abort();
  }
  function suspend(){
    if(!wasVisible)return;
    wasVisible=false;
    stopScan();
    jump=null;jumpedCue=null;
  }
  function adopt(nextHandle){
    if(!samePlayer(handle?.player,nextHandle?.player))positionMs=null;
    stopScan();
    handle=nextHandle;index=null;scanFailed=false;showLater=false;anchor=null;jump=null;jumpedCue=null;
  }
  function readPosition(){
    if(!video.seeking&&video.readyState>=1&&Number.isFinite(video.currentTime)&&video.currentTime>=0)
      positionMs=Math.floor(video.currentTime*1000);
  }

  function showRows(nextRows){
    const focused=list.contains(document.activeElement)?document.activeElement.closest('[data-sound-cue]'):null;
    const keepFocus=!focused||nextRows.some(({cue})=>cue.key===focused.dataset.soundCue);
    const changed=rows.length!==nextRows.length||nextRows.some((row,index)=>row.cue!==rows[index]?.cue||row.ready!==rows[index]?.ready);
    rows=nextRows;
    if(changed)updateKeyedList(list,rows.map(({cue,ready:available})=>({
      key:cue.key,signature:cue.key,value:available,
      html:()=>'<li><button type="button" class="sound-map-row" data-sound-cue="'+escape(cue.key)+
        '"><span class="sound-map-time">'+escape(clock(cue))+'</span><span class="sound-map-label">'+escape(cue.label)+
        '</span><span class="sound-map-action"></span></button></li>',
      patch(element){
        const button=element.firstElementChild;
        button.setAttribute('aria-disabled',String(!available));
        text(button.querySelector('.sound-map-action'),available?'Jump':'Not ready yet');
      },
    })));
    list.hidden=!rows.length;
    if(!keepFocus&&visible())heading.focus({preventScroll:true});
  }

  function render(){
    const track=handle?.track,hasIndex=Boolean(index);
    later.hidden=!hasIndex;
    later.setAttribute('aria-pressed',String(showLater));
    subtitles.hidden=!track?.hasFile||track.status==='loading'||track.status==='ready'&&!scanFailed;
    limited.hidden=!(index?.limited&&(showLater||Number.isFinite(index.limitedAtMs)&&positionMs!==null&&positionMs>=index.limitedAtMs));

    eligible=hasIndex?projectSoundCues(index.cues,positionMs,showLater):[];
    const totalPages=Math.max(1,Math.ceil(eligible.length/PAGE_SIZE));
    const previousAnchor=anchor===null?-1:eligible.findIndex(cue=>cue.key===anchor);
    page=previousAnchor<0?totalPages-1:Math.floor(previousAnchor/PAGE_SIZE);
    const slice=eligible.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE);
    anchor=slice[0]?.key??null;
    const nextRows=slice.map(cue=>({cue,ready:ready(cue)}));
    showRows(nextRows);

    pages.hidden=totalPages<2&&!pages.contains(document.activeElement);
    previous.setAttribute('aria-disabled',String(page===0));
    next.setAttribute('aria-disabled',String(page+1>=totalPages));
    text(pageLabel,'Page '+(page+1)+' of '+totalPages);

    let message;
    if(scan||track?.status==='loading')message='Reading the selected captions…';
    else if(scanFailed||track?.status==='error')message='Couldn’t read sound cues from these captions. Choose another track.';
    else if(!track?.hasFile)message='Sound cues are available after a video file is selected.';
    else if(track.status!=='ready')message='Choose subtitles to see sound cues. They’re often included in SDH or CC tracks.';
    else if(!hasIndex)message='Sound cues are available when this video opens.';
    else if(jumpedCue)message=showLater||positionMs!==null&&jumpedCue.startMs<=positionMs?'Jumped to '+clock(jumpedCue)+'.':'Jump complete.';
    else if(!showLater&&positionMs===null)message='Sound cues appear when playback has a settled position.';
    else if(!eligible.length)message=showLater?'No recognized sound cues in the selected captions.':'No recognized sound cues up to this position.';
    else if(!video.seeking&&!nextRows.some(row=>row.ready))message='These cue times aren’t ready to play yet.';
    else message='Choose a cue to jump to its time.';
    // Readiness and position changes should not interrupt an in-flight seek with a new status.
    if(!jump||!video.seeking)text(status,message);
  }

  function startScan(snapshot){
    const task={controller:new AbortController()};
    scan=task;
    const current=()=>scan===task&&visible()&&sameHandle(snapshot,capture());
    void Promise.resolve().then(()=>{
      if(!current())return null;
      return buildSoundIndex(snapshot.track,{signal:task.controller.signal,isCurrent:current});
    }).then(result=>{
      if(!current())return;
      scan=null;
      if(result)index=result;
      else scanFailed=true;
      refresh();
    }).catch(()=>{
      if(!current())return;
      scan=null;scanFailed=true;refresh();
    });
  }
  function refresh(){
    if(!visible()){suspend();return;}
    wasVisible=true;
    const current=capture();
    if(!sameHandle(handle,current))adopt(current);
    readPosition();
    if(!index&&!scan&&!scanFailed&&handle.player?.url&&handle.track?.status==='ready'&&
      handle.track.element&&handle.track.fileKey&&Array.isArray(handle.track.rows))startScan(handle);
    render();
  }
  function trackChanged(){
    if(visible()){refresh();return;}
    suspend();
    adopt(null);
    if(rows.length){
      rows=[];eligible=[];
      updateKeyedList(list,[]);
      list.hidden=true;
    }
  }

  async function activate(cue){
    if(!visible()||!handle?.track||!ready(cue))return;
    const attempt={handle,cue};
    jump=attempt;jumpedCue=null;
    const current=()=>jump===attempt&&visible()&&sameHandle(attempt.handle,capture());
    if(!current()||!ready(cue)){if(jump===attempt)jump=null;return;}
    let landed=false;
    try{landed=await seekScene(cue.startMs/1000,attempt.handle.track.revision);}catch{}
    if(!current())return;
    jump=null;
    if(landed===true)jumpedCue=cue;
    refresh();
  }
  function movePage(delta){
    const cue=eligible[(page+delta)*PAGE_SIZE];
    if(!cue)return;
    anchor=cue.key;jumpedCue=null;
    render();
  }

  panel.addEventListener('toggle',refresh);
  ancestor.addEventListener('toggle',refresh);
  dialog.addEventListener('close',()=>{suspend();refresh();});
  new MutationObserver(refresh).observe(dialog,{attributes:true,attributeFilter:['open']});
  document.addEventListener('visibilitychange',refresh);
  for(const event of ['timeupdate','seeked','loadedmetadata','emptied'])video.addEventListener(event,refresh);
  video.addEventListener('seeking',()=>{if(!jump)jumpedCue=null;refresh();});
  later.addEventListener('click',()=>{
    if(!visible()||!index)return;
    showLater=!showLater;jump=null;jumpedCue=null;
    render();
  });
  previous.addEventListener('click',()=>{if(previous.getAttribute('aria-disabled')==='false')movePage(-1);});
  next.addEventListener('click',()=>{if(next.getAttribute('aria-disabled')==='false')movePage(1);});
  pages.addEventListener('focusout',event=>{
    if(!pages.contains(event.relatedTarget)&&eligible.length<=PAGE_SIZE)pages.hidden=true;
  });
  list.addEventListener('click',event=>{
    const button=event.target.closest('[data-sound-cue]');
    if(!button||button.getAttribute('aria-disabled')==='true')return;
    const item=rows.find(row=>row.cue.key===button.dataset.soundCue);
    if(item)void activate(item.cue);
  });
  subtitles.addEventListener('click',()=>{if(visible())openSubtitles();});
  refresh();
  return {trackChanged,refresh};
}

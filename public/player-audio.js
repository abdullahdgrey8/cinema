const baseRun=/^\/hls\/(?:[a-f\d]{40}|[a-f\d]{64})-\d+\/[a-f\d]{12}\/index\.m3u8$/;
const original='original',description='description';
const positionMargin=.35;

export function playerAudioOffer(canonical,audio){
  if(!baseRun.test(canonical||'')||!audio)return null;
  const run=canonical.slice(0,-'index.m3u8'.length);
  if(audio.url!==run+'audio-master.m3u8'||audio.original!==run+'audio-original.m3u8'||
    audio.description!==run+'audio-description.m3u8'||![audio.originalDuration,audio.descriptionDuration].every(n=>Number.isFinite(n)&&n>0))return null;
  return {url:audio.url,original:audio.original,description:audio.description,
    originalDuration:audio.originalDuration,descriptionDuration:audio.descriptionDuration};
}

function sameRendition(value,path){
  if(typeof value!=='string'||!value)return false;
  try{return new URL(value,location.origin).href===location.origin+path;}catch{return false;}
}

export function createPlayerAudio({panel,video,onChange,restoreFocus}){
  const buttons=[...panel.querySelectorAll('button[data-audio-role]')];
  const notice=panel.querySelector('[data-audio-status]');
  let attachment=null;
  const current=record=>attachment===record&&record.isCurrent();
  const setStatus=message=>{if(notice.textContent!==message)notice.textContent=message;};

  function tracks(record){
    const result={};
    for(const item of record.player.audioTracks||[]){
      if(sameRendition(item.url,record.offer.original))result.original=item.id;
      else if(sameRendition(item.url,record.offer.description))result.description=item.id;
      else if(!item.url&&item.default)result.embedded=item.id;
    }
    return result;
  }

  function available(record,role){
    const end=role===description?record.live?.descriptionDuration:record.live?.originalDuration;
    return Number.isFinite(end)&&Number.isFinite(video.currentTime)&&video.currentTime+positionMargin<end;
  }

  function render(record){
    if(!current(record))return;
    const options=tracks(record);
    const show=Number.isInteger(options.embedded)&&Number.isInteger(options.original)&&Number.isInteger(options.description);
    if(!show&&panel.hidden)return;
    panel.hidden=false;
    for(const button of buttons){
      const role=button.dataset.audioRole;
      const pressed=String(role===record.selected);
      if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
      const waiting=String(Boolean(record.pending||role===description&&(!show||!record.live||!available(record,role))));
      if(button.getAttribute('aria-disabled')!==waiting)button.setAttribute('aria-disabled',waiting);
    }
  }

  function clearPending(record){
    clearTimeout(record.pending?.timer);
    record.pending=null;
  }

  function finish(record,id){
    if(!current(record)||record.pending?.id!==id)return;
    const {role,recovery}=record.pending;
    clearPending(record);
    record.selected=role;
    record.selectedId=id;
    setStatus(recovery?'Audio description is unavailable here. Original selected.':
      role===description?(video.paused?'Audio description selected. Ready when you resume.':'Audio description selected.'):
        (video.paused?'Original selected. Ready when you resume.':'Original selected.'));
    render(record);onChange();
  }

  function request(record,role,id,recovery=false){
    if(!current(record)||!Number.isInteger(id))return;
    clearPending(record);
    const timer=setTimeout(()=>{
      if(!current(record)||record.pending?.timer!==timer)return;
      if(!recovery){recover(record);return;}
      clearPending(record);
      setStatus('Original is taking longer to switch. Try Original again.');
      render(record);onChange();
    },4000);
    record.pending={role,id,recovery,timer};
    setStatus(recovery?'Returning to Original…':role===description?'Switching to audio description…':'Switching to Original…');
    render(record);onChange();
    record.player.audioTrack=id;
  }

  function recover(record){
    if(!current(record))return;
    const options=tracks(record), embedded=options.embedded;
    if(!Number.isInteger(embedded)){
      clearPending(record);render(record);setStatus('Audio description could not be switched.');onChange();return;
    }
    if(record.selectedId===embedded&&record.player.audioTrack===embedded){
      clearPending(record);setStatus('Audio description is unavailable here. Original selected.');render(record);onChange();return;
    }
    request(record,original,embedded,true);
  }

  for(const button of buttons)button.addEventListener('click',()=>{
    const record=attachment,role=button.dataset.audioRole;
    if(!record||!current(record)||record.pending||
      role===record.selected&&record.player.audioTrack===record.selectedId)return;
    const options=tracks(record);
    if(role===description&&!available(record,role)){
      setStatus(record.live?'Audio description is still preparing for this part.':'Audio description is unavailable here.');return;
    }
    const id=role===original&&!available(record,original)?options.embedded:options[role];
    request(record,role,id,role===original&&id===options.embedded);
  });
  video.addEventListener('timeupdate',()=>{if(attachment&&!panel.hidden)render(attachment);});

  function reset(){
    const focused=panel.contains(document.activeElement);
    if(attachment)clearPending(attachment);
    attachment=null;
    panel.hidden=true;panel.open=false;setStatus('');
    if(focused)restoreFocus();
  }

  function bind(player,events,canonical,offer,isCurrent){
    reset();
    const record=attachment={player,canonical,offer,live:offer,lastKnown:offer,isCurrent,selected:original,selectedId:null,pending:null};
    player.on(events.AUDIO_TRACKS_UPDATED,()=>{
      if(!current(record))return;
      const options=tracks(record);
      if(record.selectedId===null&&Number.isInteger(options.embedded))record.selectedId=options.embedded;
      render(record);
    });
    player.on(events.AUDIO_TRACK_SWITCHED,(_event,data)=>finish(record,data?.id));
    player.on(events.BUFFER_APPENDED,(_event,data)=>{
      if(!current(record)||!video.paused||!record.pending||data?.parent!=='audio')return;
      const {frag,timeRanges}=data,id=record.pending.id,at=video.currentTime;
      if(frag?.level!==id||frag.sn==='initSegment'||!Number.isFinite(frag.start)||!Number.isFinite(frag.duration)||
        at<frag.start-.1||at>frag.start+frag.duration+.05)return;
      const ranges=timeRanges?.audio;
      if(ranges&&Array.from({length:ranges.length},(_,index)=>ranges.start(index)<=at+.05&&ranges.end(index)>at+.05).some(Boolean))
        finish(record,id);
    });
    setStatus('Choose the original sound or the description supplied with this video.');
  }

  function refresh(canonical,audio){
    const record=attachment;
    if(!record||!current(record)||record.canonical!==canonical)return;
    const next=record.failedRole?null:playerAudioOffer(canonical,audio);
    const previous=record.live;
    record.live=next;
    if(next)record.lastKnown=next;
    if(previous&&!next){
      if(record.selected===description||record.pending||record.selectedId===tracks(record).original)recover(record);
      else setStatus('Audio description is unavailable here. Original selected.');
    }
    render(record);
  }

  function handleError(data){
    const record=attachment;
    if(!record||!current(record)||!data?.fatal||
      !(data.frag?.type==='audio'||data.context?.type==='audioTrack'||data.parent==='audio')||
      (!record.pending&&record.selectedId===tracks(record).embedded))return false;
    record.failedRole=true;record.live=null;recover(record);
    queueMicrotask(()=>{if(current(record))record.player.startLoad();});
    return true;
  }

  function limit(){
    const record=attachment;
    if(!record||!current(record))return Infinity;
    const options=tracks(record),end=id=>!Number.isInteger(id)?Infinity:
      id===options.description?record.lastKnown.descriptionDuration:id===options.original?record.lastKnown.originalDuration:Infinity;
    return Math.min(end(record.selectedId),end(record.pending?.id));
  }
  return {bind,refresh,handleError,limit,reset};
}

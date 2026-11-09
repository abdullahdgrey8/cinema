const limit=3;

export function createSceneSketchbook({panel,ancestor,dialog,video,readFrame,authorize,hasCoverage,formatTime}){
  const document=panel.ownerDocument;
  const save=panel.querySelector('#scene-sketchbook-save'),hint=panel.querySelector('#scene-sketchbook-hint');
  const status=panel.querySelector('#scene-sketchbook-status'),gallery=panel.querySelector('#scene-sketchbook-gallery');
  const stills=[];
  let pending=null,sequence=0;

  function visible(){return panel.open&&ancestor.open&&dialog.open&&!document.hidden;}
  function say(text){
    if(status.textContent!==text)status.textContent=text;
  }
  function abort(){
    if(pending&&!pending.signal.aborted){pending.abort();say('');}
  }
  function release(still){
    still.canvas.width=0;
    still.canvas.height=0;
    still.figure.remove();
  }
  function refresh(){
    if(!visible()){abort();return;}
    const frame=readFrame();
    const text=frame.reason||'Save a still from inside a section you’ve already watched.';
    if(hint.textContent!==text)hint.textContent=text;
    save.setAttribute('aria-disabled',String(Boolean(pending||frame.reason)));
  }
  function reset(){
    abort();
    for(const still of stills.splice(0))release(still);
    sequence=0;
    gallery.hidden=true;
    say('');
    refresh();
  }
  function recheckCoverage(){
    let lost=false;
    for(let index=stills.length-1;index>=0;index--){
      const still=stills[index];
      if(hasCoverage(still.span,still.seal,still.attachment))continue;
      stills.splice(index,1);
      release(still);
      lost=true;
    }
    gallery.hidden=!stills.length;
    if(lost)say('A saved still is no longer available.');
    refresh();
  }
  function paint(snapshot,seal){
    const canvas=document.createElement('canvas');
    const scale=Math.min(256/snapshot.width,144/snapshot.height,1);
    canvas.width=Math.max(1,Math.round(snapshot.width*scale));
    canvas.height=Math.max(1,Math.round(snapshot.height*scale));
    canvas.setAttribute('aria-hidden','true');
    const context=canvas.getContext('2d');
    if(!context)return false;
    context.drawImage(video,0,0,canvas.width,canvas.height);
    const figure=document.createElement('figure'),caption=document.createElement('figcaption');
    const time=formatTime(snapshot.time);
    caption.textContent='Still '+(++sequence)+' · '+time;
    figure.append(canvas,caption);
    if(stills.length===limit)release(stills.shift());
    stills.push({canvas,figure,span:snapshot.span,seal,attachment:snapshot.attachment});
    gallery.append(figure);
    gallery.hidden=false;
    say('Saved a still at '+time+'.');
    return true;
  }

  save.addEventListener('click',async()=>{
    if(!visible()||pending)return;
    const snapshot=readFrame();
    if(snapshot.reason){refresh();return;}
    const control=pending=new AbortController();
    say('Checking this moment…');
    refresh();
    try{
      const result=await authorize(snapshot.span,control.signal);
      if(control.signal.aborted||!visible())return;
      const latest=readFrame();
      if(latest.reason||latest.attachment!==snapshot.attachment||latest.frame!==snapshot.frame||
        latest.time!==snapshot.time||latest.totalFrames!==snapshot.totalFrames||
        latest.width!==snapshot.width||latest.height!==snapshot.height){
        say('The picture changed. Pause and try again.');
        return;
      }
      if(result.status==='outside'){
        say('Move back into a section you’ve watched. Recent playback can take a few seconds to appear here.');
      }else if(result.status!=='ready'||!hasCoverage(snapshot.span,result.seal,snapshot.attachment)||!paint(snapshot,result.seal)){
        say('Cinema couldn’t verify this still. Try again in a moment.');
      }
    }catch{
      if(!control.signal.aborted&&visible())say('Cinema couldn’t save this still. Try again in a moment.');
    }finally{
      if(pending===control)pending=null;
      refresh();
    }
  });

  for(const target of [panel,ancestor])target.addEventListener('toggle',refresh);
  dialog.addEventListener('close',reset);
  document.addEventListener('visibilitychange',()=>document.hidden?reset():refresh());
  for(const event of ['play','seeking','emptied','waiting','error']){
    video.addEventListener(event,()=>{abort();refresh();});
  }
  for(const event of ['pause','seeked','loadeddata','canplay','ended'])video.addEventListener(event,refresh);

  return {refresh,reset,recheckCoverage};
}

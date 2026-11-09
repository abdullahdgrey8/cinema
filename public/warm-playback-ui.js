import {updateHTML} from './dom.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const text=(value,limit=180)=>typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,limit):'';
const icon=(name,extra='')=>`<svg class="cinema-icon ${extra}" aria-hidden="true"><use href="#ico-${name}"/></svg>`;
const swapIcon=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15m-4-4 4 4-4 4m5 4H5m4-4-4 4 4 4"/></svg>`;
const returnIcon=`<svg class="cinema-icon warm-return-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 3 10l5 5m-5-5h11a6 6 0 1 1 0 12h-3"/></svg>`;

function setText(node,value){
  if(node&&node.textContent!==value)node.textContent=value;
}
function setDisabled(node,disabled){
  if(!node)return;
  if(disabled)node.setAttribute('aria-disabled','true');
  else node.removeAttribute('aria-disabled');
}

function optionKey(option){
  return JSON.stringify([option.hash,option.index,option.sessionId]);
}
function basename(value){
  return text(typeof value==='string'?value.split(/[\\/]/).at(-1):'',150).replace(/^[a-z]:/i,'');
}
function optionMarkup(option,key){
  const title=text(option.title,130)||basename(option.fileName)||'Local video';
  const file=basename(option.fileName);
  return `<li><button type="button" class="warm-choice" data-warm-option="${escape(key)}" aria-label="${escape('Play '+title+(file&&file!==title?' · '+file:''))}">
    <span class="warm-choice-icon">${icon('play')}</span>
    <span class="warm-choice-copy"><strong>${escape(title)}</strong>${file&&file!==title?`<small>${escape(file)}</small>`:''}</span>
    ${icon('right','warm-choice-chevron')}
  </button></li>`;
}
function visible(node){
  return Boolean(node?.isConnected&&!node.closest('[hidden], dialog:not([open])'));
}
function focusPlayer(node){
  const dialog=node?.closest('dialog');
  const back=dialog?.open&&dialog.querySelector('#close-player');
  if(visible(back))back.focus({preventScroll:true});
}

export function createWarmPlaybackUI({panel,bar,dock,onOptions,onSwitch,onReturn,onDismiss}){
  if(!panel||!bar||!dock)return {update(){}};
  panel.innerHTML=`<summary class="player-control">${swapIcon}<span>Switch while it prepares</span></summary>
    <div class="player-sheet warm-chooser" role="region" aria-labelledby="warm-chooser-title">
      <h3 id="warm-chooser-title">Watch something in the meantime</h3>
      <p class="warm-chooser-intro">Choose a ready title from this PC. You can return while your video prepares.</p>
      <p class="warm-chooser-status" data-warm-status role="status" aria-live="polite" aria-atomic="true"></p>
      <ul class="warm-choices" data-warm-options aria-label="Ready local titles" hidden></ul>
      <div class="warm-chooser-empty" data-warm-empty hidden><strong>No ready titles on this PC yet</strong>
        <p>Finished videos appear here once Cinema has prepared them for playback.</p></div>
      <button class="player-control warm-retry" type="button" data-warm-retry hidden>Check again</button>
    </div>`;
  bar.setAttribute('aria-label','Return to the video you were preparing');
  bar.innerHTML=`<div class="warm-return-copy">${returnIcon}
    <span class="warm-return-description"><strong data-warm-title></strong><span data-warm-phase></span></span></div>
    <div class="warm-return-actions"><button class="player-primary warm-return-button" type="button" data-warm-return></button>
      <button class="player-control warm-dismiss" type="button" data-warm-dismiss>Dismiss</button></div>
    <p class="warm-return-error" data-warm-return-error hidden></p>
    <span class="sr-only" data-warm-announcement role="status" aria-live="polite" aria-atomic="true"></span>`;
  dock.innerHTML=returnIcon+'<span data-warm-dock-label></span>';
  const dockLive=document.createElement('span');
  dockLive.className='sr-only';
  dockLive.setAttribute('role','status');
  dockLive.setAttribute('aria-live','polite');
  dockLive.setAttribute('aria-atomic','true');
  dock.after(dockLive);

  const summary=panel.querySelector('summary');
  const optionsList=panel.querySelector('[data-warm-options]'),chooserStatus=panel.querySelector('[data-warm-status]');
  const empty=panel.querySelector('[data-warm-empty]'),retry=panel.querySelector('[data-warm-retry]');
  const returnButton=bar.querySelector('[data-warm-return]'),dismiss=bar.querySelector('[data-warm-dismiss]');
  const titleNode=bar.querySelector('[data-warm-title]'),phaseNode=bar.querySelector('[data-warm-phase]');
  const returnError=bar.querySelector('[data-warm-return-error]'),announcement=bar.querySelector('[data-warm-announcement]');
  const dockLabel=dock.querySelector('[data-warm-dock-label]');
  let available=false,loading=false,busy=false,lease=null,returnNotice='';
  let options=new Map(),lastLeaseState='',optionsRequested=false;

  const canCheck=()=>available&&panel.open&&visible(panel)&&!loading&&!busy;
  function requestOptions(){
    if(!canCheck())return;
    optionsRequested=true;
    void onOptions?.();
  }
  panel.addEventListener('toggle',requestOptions);
  retry.addEventListener('click',requestOptions);
  optionsList.addEventListener('click',event=>{
    const button=event.target.closest('[data-warm-option]');
    if(!button||!optionsList.contains(button)||!canCheck())return;
    const option=options.get(button.dataset.warmOption);
    if(option)void onSwitch?.(option);
  });
  returnButton.addEventListener('click',()=>{
    if(lease&&!busy&&visible(bar))void onReturn?.();
  });
  dock.addEventListener('click',()=>{
    if(lease&&!busy&&visible(dock))void onReturn?.();
  });
  dismiss.addEventListener('click',()=>{
    if((lease||returnNotice)&&!busy&&visible(bar))void onDismiss?.();
  });

  function renderChooser(error){
    if(!available){
      const restoreFocus=panel.contains(document.activeElement);
      panel.open=false;panel.hidden=true;optionsRequested=false;
      if(restoreFocus)focusPlayer(panel);
      optionsList.replaceChildren();optionsList.hidden=true;
      empty.hidden=true;retry.hidden=true;
      setText(chooserStatus,'');
      return;
    }
    panel.hidden=false;
    const status=error||(loading?'Checking your ready titles…':busy?'Switching videos…':options.size?
      options.size+(options.size===1?' ready title':' ready titles'):'');
    setText(chooserStatus,status);
    chooserStatus.dataset.tone=error?'error':'normal';
    const restoreChoice=optionsList.contains(document.activeElement),restoreRetry=document.activeElement===retry;
    updateHTML(optionsList,[...options].map(([key,option])=>optionMarkup(option,key)).join(''));
    optionsList.hidden=!options.size;
    optionsList.setAttribute('aria-busy',String(loading||busy));
    for(const button of optionsList.querySelectorAll('button'))setDisabled(button,loading||busy);
    empty.hidden=!optionsRequested||Boolean(options.size||loading||busy||error);
    retry.hidden=!error||loading||busy;
    if(panel.open&&(restoreChoice&&!optionsList.contains(document.activeElement)||restoreRetry&&retry.hidden)){
      summary.focus({preventScroll:true});
    }
  }

  function renderReturn(error){
    if(!lease){
      const restorePlayer=bar.contains(document.activeElement),restoreDock=document.activeElement===dock;
      bar.hidden=!returnNotice;dock.hidden=true;lastLeaseState='';
      returnButton.hidden=true;
      for(const node of [phaseNode,returnButton,returnError,dockLabel])setText(node,'');
      setText(titleNode,returnNotice);
      setText(announcement,returnNotice);setText(dockLive,returnNotice);
      dismiss.setAttribute('aria-label','Dismiss return message');
      setDisabled(dismiss,false);returnError.hidden=true;
      delete bar.dataset.phase;
      dock.removeAttribute('aria-label');
      if(restorePlayer){
        if(returnNotice) dismiss.focus({preventScroll:true});
        else focusPlayer(bar);
      }
      const main=dock.parentElement?.querySelector('#restore-player');
      if(restoreDock&&visible(main))main.focus({preventScroll:true});
      return;
    }
    const title=text(lease.title,130)||'your first video';
    const ready=lease.phase==='ready',phase=ready?'Ready to return to':'Preparing in the background';
    const action='Return to '+title;
    bar.hidden=false;dock.hidden=false;returnButton.hidden=false;
    bar.dataset.phase=ready?'ready':'preparing';
    setText(titleNode,title);
    setText(phaseNode,phase);
    setText(returnButton,action);
    setText(dockLabel,action);
    dock.setAttribute('aria-label',action);
    dismiss.setAttribute('aria-label','Dismiss return to '+title);
    setDisabled(returnButton,busy);setDisabled(dock,busy);setDisabled(dismiss,busy);
    returnError.hidden=!error;
    setText(returnError,error);
    const state=JSON.stringify([title,lease.phase,lease.expiresAt,error]);
    if(state!==lastLeaseState){
      const message=error||(ready?title+' is ready to return to.':title+' is preparing in the background.');
      setText(announcement,message);setText(dockLive,message);
      lastLeaseState=state;
    }
  }

  function update(next={}){
    available=Boolean(next.available);
    loading=Boolean(next.loading);
    busy=Boolean(next.busy);
    lease=next.lease||null;
    returnNotice=text(next.returnNotice);
    dockLive.classList.toggle('sr-only',!returnNotice);
    dockLive.classList.toggle('warm-dock-message',Boolean(returnNotice));
    const list=available&&Array.isArray(next.options)?next.options.filter(option=>option&&typeof option.hash==='string'&&
      Number.isSafeInteger(option.index)&&option.index>=0&&typeof option.sessionId==='string'&&option.sessionId).slice(0,6):[];
    options=new Map(list.map(option=>[optionKey(option),option]));
    const error=text(next.error);
    renderChooser(error);
    renderReturn(!available?error:'');
  }
  update();
  return {update};
}


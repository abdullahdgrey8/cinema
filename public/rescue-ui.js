import { updateHTML } from './dom.js';

export function createRescueUI({panel,clockTime,escape,onShow,onClose,onList,onCheck,onCommit,onCancel,onFind,
  onFastStart,onKeepOriginal}){
  if(!panel)return {update(){},updateFastStart(){}};
  const $=selector=>panel.querySelector(selector);
  const status=$('[data-rescue-status]'),list=$('[data-rescue-options]'),ready=$('[data-rescue-ready]');
  const selected=$('[data-rescue-selected]'),scene=$('[data-rescue-scene]'),beginning=$('[data-rescue-beginning]');
  const cancel=$('[data-rescue-cancel]'),refresh=$('[data-rescue-refresh]'),find=$('[data-rescue-find]');
  const title=$('[data-rescue-title]'),intro=$('[data-rescue-intro]'),summary=$('[data-rescue-label]');
  let choices=[],phase='idle',latest=null,fast={available:false,busy:false,phase:'idle',message:''};
  const setText=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
  const setDisabled=(node,disabled)=>{if(node.getAttribute('aria-disabled')!==String(disabled))node.setAttribute('aria-disabled',String(disabled));};
  const busy=()=>fast.busy||['listing','checking','previewing','committing'].includes(phase);
  const startup=()=>fast.busy||fast.available&&!['checking','previewing','committing','ready'].includes(phase);
  const eligible=option=>/\.(?:mp4|m4v)$/i.test(option?.name||'');
  panel.addEventListener('toggle',()=>panel.open&&!panel.hidden?onShow():onClose());
  refresh.addEventListener('click',()=>{if(!busy()&&phase!=='ready')onList();});
  cancel.addEventListener('click',()=>{if(fast.busy)onKeepOriginal();else if(phase!=='committing')onCancel();});
  find.addEventListener('click',()=>{if(!fast.busy&&phase!=='committing')onFind();});
  list.addEventListener('click',event=>{
    const button=event.target.closest('[data-rescue-option]');
    if(!button||busy()||!panel.open)return;
    const choice=choices[Number(button.dataset.rescueOption)];
    if(!choice)return;
    if(startup()){
      if(fast.available&&eligible(choice))onFastStart(choice);
    }else onCheck(choice);
  });
  scene.addEventListener('click',()=>{if(phase==='ready')onCommit('scene');});
  beginning.addEventListener('click',()=>{if(phase==='ready')onCommit('beginning');});
  function paint(){
    if(!latest)return;
    if(!latest.available){
      if(panel.open)panel.open=false;
      panel.hidden=true;
      return;
    }
    panel.hidden=false;
    phase=latest.phase;
    const compare=startup();
    setText(summary,compare?'Fast Start':'Rescue');
    if(!latest.open)return;
    setText(title,compare?'Try a faster start':'Try another release');
    setText(intro,compare?'Your original keeps preparing. Choose an alternate to use it automatically if its opening is ready first.':
      'Your current video stays open while Cinema checks a replacement.');
    choices=compare?latest.options.filter(eligible):latest.options;
    const noCompatible=compare&&!choices.length&&latest.options.length;
    setText(status,fast.message||(noCompatible?'No compatible MP4 copy found in My Library. Your original keeps preparing.':latest.message));
    status.dataset.phase=fast.busy?fast.phase:phase;
    updateHTML(list,choices.map((option,index)=>`<li><button type="button" data-rescue-option="${index}" class="rescue-choice">
      <span><strong>${escape(option.label)}</strong><small>${escape(option.progress>=1?'Downloaded':'Downloading')}</small></span>
      <span class="rescue-check-label">${compare?'Use if it starts first':'Check'}</span></button></li>`).join(''));
    list.hidden=!choices.length;
    for(const button of list.querySelectorAll('button'))setDisabled(button,busy());
    const offered=Boolean(latest.proof)&&!fast.busy;
    if(!offered&&ready.contains(document.activeElement))refresh.focus({preventScroll:true});
    ready.hidden=!offered;
    setText(selected,latest.selected?.label||'');
    const mapped=offered&&Number.isFinite(latest.proof.sceneTime);
    scene.hidden=!mapped;
    if(mapped)setText(scene,'Switch and resume at '+clockTime(latest.proof.sceneTime));
    setDisabled(scene,phase!=='ready');setDisabled(beginning,phase!=='ready');
    const canCancel=fast.busy||['checking','previewing','ready'].includes(phase);
    if(!canCancel&&document.activeElement===cancel)panel.querySelector('summary').focus({preventScroll:true});
    cancel.hidden=!canCancel;
    setText(cancel,fast.busy?'Keep original':phase==='ready'?'Clear check':'Cancel check');
    setDisabled(refresh,busy()||phase==='ready');setDisabled(find,fast.busy||phase==='committing');
  }
  return {
    update(state){latest=state;paint();},
    updateFastStart(state){fast=state;paint();},
  };
}

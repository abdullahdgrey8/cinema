import {appendAppointmentSample,classifyAppointmentDeadline,estimateAppointment,localAppointmentInput,parseAppointmentDeadline} from './watch-appointment-model.js';

const checkInterval=12_000, freshFor=20_000, maxTime=12*60*60_000;
const hashPattern=/^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const keyPattern=/^[a-f\d]{64}$/i;
const posterPattern=/^\/api\/metadata\/poster\?id=[a-z\d_-]{1,100}$/i;
const deadlineFormat=new Intl.DateTimeFormat(undefined,{weekday:'short',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const estimateFormat=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const knownStatuses=new Set(['finding','downloading','paused','on-disk','ready','unavailable']);
const statusText={finding:'Finding the video file',downloading:'Still downloading',paused:'Download paused',
  'on-disk':'On this PC · playback unconfirmed',ready:'Direct play checked',unavailable:'This exact file is unavailable'};

const icon=id=>`<svg class="cinema-icon" aria-hidden="true"><use href="#ico-${id}"/></svg>`;
function slotMarkup(slot,label){
  return `<article class="appointment-slot" id="appointment-${slot}-card" aria-labelledby="appointment-${slot}-title">
    <div class="appointment-art">${icon('film')}<img id="appointment-${slot}-poster" alt="" decoding="async" hidden></div>
    <div class="appointment-slot-copy"><span class="appointment-slot-label">${label}</span><h4 id="appointment-${slot}-title"></h4>
      <p id="appointment-${slot}-status" class="appointment-slot-status"></p>
      <progress id="appointment-${slot}-progress" max="100" value="0" aria-label="${label} download progress" hidden></progress>
      <p id="appointment-${slot}-estimate" class="appointment-estimate" hidden></p></div>
    <button class="subtle appointment-play" id="appointment-play-${slot}" type="button" aria-disabled="true">${slot==='backup'?'Play backup':'Play title'}</button>
  </article>`;
}

export function createWatchAppointment({panel,rail,dialog,getSnapshot,getPoster,request,canProbe,openPlanner,openFile}){
  if(!panel||!rail||!request)return {refresh(){}};
  panel.innerHTML=`<div class="appointment-heading"><div class="appointment-mark">${icon('film')}</div><div>
    <span class="appointment-eyebrow">YOUR WATCH APPOINTMENT</span><h3 id="appointment-heading">Ready by</h3>
    <p>Pick a title, set a time, and have a backup if you want one.</p></div></div>
    <form id="appointment-form" class="appointment-form">
      <label for="appointment-primary">Title from My Library<select id="appointment-primary" required></select></label>
      <label for="appointment-time">Watch by<input id="appointment-time" type="datetime-local" required></label>
      <label for="appointment-backup">Backup from My Library<select id="appointment-backup"></select></label>
      <button id="appointment-start" class="primary" type="submit">Start appointment</button>
      <p id="appointment-setup-note">Choose a time in the next 12 hours. Checks run while this Cinema window is visible.</p>
    </form>
    <section class="appointment-current" id="appointment-current" aria-labelledby="appointment-overview" hidden>
      <div class="appointment-timecard"><div><span class="appointment-eyebrow">WATCH BY</span><h4 id="appointment-overview" tabindex="-1"><time id="appointment-due"></time></h4></div>
        <p id="appointment-outcome"></p></div>
      <div class="appointment-lineup">${slotMarkup('primary','Main title')}${slotMarkup('backup','Backup')}</div>
      <div class="appointment-actions"><button id="appointment-check" class="subtle" type="button" aria-disabled="false">Check now</button>
        <button id="appointment-stop" class="text-button" type="button">Stop appointment</button></div>
    </section>
    <p id="appointment-message" class="appointment-message" role="status"></p>`;
  rail.innerHTML=`<div class="appointment-rail-mark" aria-hidden="true">${icon('film')}</div><div class="appointment-rail-copy">
    <span class="appointment-eyebrow">WATCH APPOINTMENT</span><strong id="appointment-rail-title"></strong><p id="appointment-rail-state"></p></div>
    <button id="appointment-rail-open" class="subtle" type="button" aria-haspopup="dialog" aria-controls="watch-planner-dialog">View appointment ${icon('right')}</button>
    <span id="appointment-rail-announcement" class="sr-only" role="status"></span>`;
  const $=id=>panel.querySelector('#appointment-'+id);
  const railTitle=rail.querySelector('#appointment-rail-title'),railState=rail.querySelector('#appointment-rail-state');
  const railOpen=rail.querySelector('#appointment-rail-open'),railAnnouncement=rail.querySelector('#appointment-rail-announcement');
  const form=$('form'),primary=$('primary'),backup=$('backup'),time=$('time'),current=$('current');
  const checkButton=$('check'),message=$('message');
  let plan=null,work=null,timer=null,optionSignature='',notice='',timeEdited=false;

  const setText=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
  const stamp=()=>Date.now();
  const library=()=>getSnapshot()?.library||[];
  const connected=()=>Boolean(getSnapshot()?.connected);
  const fresh=record=>Number.isFinite(record.checkedAt)&&stamp()>=record.checkedAt&&stamp()-record.checkedAt<=freshFor;
  const available=()=>connected()&&!document.hidden;

  function announce(text){
    const inPlanner=dialog.open&&!panel.hidden;
    setText(message,inPlanner?text:'');
    setText(railAnnouncement,!document.querySelector('dialog[open]')&&plan?text:'');
  }

  function syncChoices(){
    const items=library().filter(item=>hashPattern.test(item.hash||'')).slice(0,250);
    $('start').disabled=!connected()||!items.length;
    setText($('setup-note'),!connected()?'Reconnect qBittorrent to check your library.':!items.length?
      'Add a download to My Library before making an appointment.':'Choose a time in the next 12 hours. Checks run while this Cinema window is visible.');
    const signature=JSON.stringify(items.map(item=>[item.hash,item.title||item.name]));
    if(signature===optionSignature)return;
    optionSignature=signature;
    for(const [select,empty] of [[primary,'Choose a title'],[backup,'No backup']]){
      const chosen=select.value;
      const choices=items.map(item=>new Option(String(item.title||item.name||'Library video').slice(0,180),item.hash));
      select.replaceChildren(new Option(empty,''),...choices);
      if(choices.some(option=>option.value===chosen))select.value=chosen;
    }
  }

  function setDefaults(){
    const now=stamp();
    time.min=localAppointmentInput(now);
    time.max=localAppointmentInput(now+maxTime);
    if(!timeEdited)time.value=localAppointmentInput(now+45*60_000);
  }

  function stopWork(){
    clearTimeout(timer);timer=null;
    if(work){work.abort();work=null;}
  }

  function dueResult(){
    if(!plan||plan.outcome||stamp()<plan.due)return false;
    const primaryFile=plan.files[0];
    plan.outcome=classifyAppointmentDeadline({due:plan.due,checkedAt:plan.checkedAt,status:primaryFile?.status,
      available:available()&&!plan.hiddenSince&&!plan.offlineSince&&!plan.invalid});
    plan.dueStatus=primaryFile?.status;
    stopWork();
    return true;
  }

  function schedule(){
    clearTimeout(timer);timer=null;
    if(!plan||plan.outcome||plan.invalid||!available())return;
    timer=setTimeout(()=>{
      if(dueResult()){render();return;}
      if(work)schedule();else void inspect();
    },Math.max(0,Math.min(checkInterval,plan.due-stamp())));
  }

  function ready(file){
    return file?.status==='ready'&&keyPattern.test(file.key||'')&&keyPattern.test(file.playKey||'')&&Number.isSafeInteger(file.index)&&file.index>=0;
  }

  function renderSlot(slot,target,file,record){
    const card=$(slot+'-card'),art=$(slot+'-poster'),progress=$(slot+'-progress'),estimate=$(slot+'-estimate');
    card.hidden=!target;
    if(!target)return;
    setText($(slot+'-title'),target.title);
    if(art.getAttribute('src')!==target.poster){
      if(target.poster)art.setAttribute('src',target.poster);else art.removeAttribute('src');
    }
    art.hidden=!target.poster;
    const currentFile=available()&&!record.invalid&&fresh(record)?file:null;
    const status=currentFile?.status||'pending';
    card.dataset.state=status;
    let detail=statusText[status]||'Waiting for a fresh check';
    if(!connected())detail='qBittorrent is disconnected';
    else if(document.hidden)detail='Checks are paused while Cinema is hidden';
    else if(record.invalid)detail='Connection changed · start a new appointment';
    else if(status==='on-disk'&&currentFile.reason==='player-busy')detail='On this PC · check when playback is idle';
    else if(status==='on-disk'&&currentFile.reason==='needs-preparation')detail='On this PC · needs player preparation';
    if(currentFile&&['downloading','paused'].includes(status)&&Number.isSafeInteger(currentFile.downloaded)&&currentFile.size>0)
      detail+=` · ${Math.min(99,Math.floor(100*currentFile.downloaded/currentFile.size))}%`;
    setText($(slot+'-status'),detail);
    progress.hidden=!currentFile||!['downloading','paused'].includes(status)||!(currentFile.size>0);
    if(!progress.hidden)progress.value=100*currentFile.downloaded/currentFile.size;
    const window=slot==='primary'&&status==='downloading'?estimateAppointment(record.samples):null;
    estimate.hidden=!window;
    if(window){
      const early=estimateFormat.format(new Date(record.checkedAt+window.earlyMinutes*60_000));
      const late=estimateFormat.format(new Date(record.checkedAt+window.lateMinutes*60_000));
      setText(estimate,`Estimated download window ${early} – ${late}`);
    }
    $("play-"+slot).setAttribute('aria-disabled',String(Boolean(work)||!ready(currentFile)));
  }

  function outcomeText(record){
    if(record.outcome==='ready')return 'Time reached · direct play was checked';
    if(record.outcome==='waiting')return record.dueStatus==='downloading'?'Time reached · main title still downloading':'Time reached · main title was still waiting';
    if(record.outcome==='unconfirmed')return 'Time reached · Cinema could not confirm readiness then';
    if(!connected())return 'Waiting for qBittorrent';
    if(record.invalid)return 'Connection changed · start a new appointment';
    if(document.hidden)return 'Checks paused while Cinema is hidden';
    if(!fresh(record))return 'Checking the selected files';
    if(ready(record.files[0]))return 'Main title checked';
    if(ready(record.files[1]))return 'Backup checked · main title still waiting';
    return 'Checking as the downloads change';
  }

  function render(){
    form.hidden=Boolean(plan);current.hidden=!plan;rail.hidden=!plan;
    if(!plan){
      if(dialog.open&&!panel.hidden)syncChoices();
      announce(notice);
      return;
    }
    const date=new Date(plan.due),deadline=deadlineFormat.format(date);
    $('due').dateTime=date.toISOString();setText($('due'),deadline);
    const status=outcomeText(plan);
    setText($('outcome'),status);setText(railTitle,plan.targets[0].title);
    renderSlot('primary',plan.targets[0],plan.files[0],plan);
    renderSlot('backup',plan.targets[1],plan.files[1],plan);
    const hasEvidence=available()&&!plan.invalid&&fresh(plan);
    const railDetail=hasEvidence&&!plan.outcome&&!ready(plan.files[0])?$('primary-status').textContent:status;
    const backupHint=hasEvidence&&ready(plan.files[1])&&!ready(plan.files[0])?' · Backup checked':'';
    setText(railState,`${deadline} · ${railDetail}${backupHint}`);
    checkButton.setAttribute('aria-disabled',String(Boolean(work)||!available()||plan.invalid));
    const primaryStatus=hasEvidence&&status==='Checking as the downloads change'?statusText[plan.files[0]?.status]:null;
    announce(notice||(primaryStatus?`${status}. ${primaryStatus}.`:status));
  }

  function accept(record,result){
    if(!result||!keyPattern.test(result.epoch||'')||record.epoch&&result.epoch!==record.epoch||
      !Array.isArray(result.files)||result.files.length!==record.targets.length||
      result.files.some((file,index)=>file?.hash!==record.targets[index].hash||!knownStatuses.has(file.status)))throw Error('The exact appointment check could not be confirmed.');
    record.epoch=result.epoch;
    record.files=result.files.map((file,index)=>{
      const target=record.targets[index];
      if(target.changed||target.key&&file.key&&file.key!==target.key||target.playKey&&file.playKey&&file.playKey!==target.playKey){
        target.changed=true;
        return {hash:target.hash,status:'unavailable'};
      }
      if(keyPattern.test(file.key||''))target.key=file.key;
      if(ready(file))target.playKey=file.playKey;
      return file;
    });
    record.checkedAt=stamp();
    record.samples=appendAppointmentSample(record.samples,record.files[0],result.observedMs);
  }

  async function inspect(launch){
    const record=plan;
    if(!record||work||!available()||record.invalid)return;
    const oldProof=Number.isInteger(launch)?record.files[launch]?.playKey:null;
    const controller=new AbortController();
    work=controller;notice='';render();schedule();
    try{
      const result=await request({...(record.epoch?{epoch:record.epoch}:{}),
        targets:record.targets.map(({hash,key})=>({hash,...(key?{key}:{})})),allowProbe:canProbe()},controller.signal);
      if(plan!==record||work!==controller||controller.signal.aborted)return;
      if(!record.outcome&&stamp()>=record.due){dueResult();return;}
      accept(record,result);
      if(Number.isInteger(launch)){
        const file=record.files[launch];
        if(oldProof&&ready(file)&&file.playKey===oldProof){
          work=null;
          openFile({...file,epoch:record.epoch});
          return;
        }
        notice='This exact file is no longer ready. Check the appointment again.';
      }
    }catch(error){
      if(plan!==record||work!==controller||controller.signal.aborted)return;
      record.samples=[];record.checkedAt=null;
      if(error.code==='appointment-connection-changed')record.invalid=true;
      notice=record.invalid?'Connection changed. Stop and start a new appointment.':'Could not check the selected files. Try Check now.';
    }finally{
      if(work===controller)work=null;
      if(plan===record){render();schedule();}
    }
  }

  function start(event){
    event.preventDefault();
    if(plan)return;
    if(!available()){notice='Reconnect qBittorrent to start an appointment.';render();return;}
    const now=stamp(),due=parseAppointmentDeadline(time.value,now);
    if(!due){notice='Choose an unambiguous local time in the next 12 hours.';render();time.focus();return;}
    const choices=library(),ids=[primary.value,...(backup.value?[backup.value]:[])];
    if(!ids[0]||new Set(ids).size!==ids.length||ids.some(hash=>!choices.some(item=>item.hash===hash))){
      notice='Choose an available main title and a separate backup if you want one.';render();primary.focus();return;
    }
    const targets=ids.map(hash=>{
      const item=choices.find(entry=>entry.hash===hash),art=getPoster?.(item);
      return {hash,title:String(item.title||item.name||'Library video').slice(0,180),poster:posterPattern.test(art||'')?art:null};
    });
    plan={due,targets,files:[],samples:[],epoch:null,checkedAt:null,outcome:null,invalid:false,hiddenSince:null,offlineSince:null};
    notice='';render();$('overview').focus();void inspect();
  }

  function refresh({wake=false}={}){
    if(!plan){if(dialog.open&&!panel.hidden)render();return;}
    if(document.hidden&&!plan.hiddenSince){plan.hiddenSince=stamp();plan.samples=[];plan.checkedAt=null;stopWork();}
    if(!connected()&&!plan.offlineSince){plan.offlineSince=stamp();plan.samples=[];plan.checkedAt=null;stopWork();}
    dueResult();
    const resumed=available()&&(plan.hiddenSince||plan.offlineSince);
    if(available()){plan.hiddenSince=null;plan.offlineSince=null;}
    render();
    if(!plan.outcome&&available()&&!plan.invalid&&!work&&(resumed||wake&&!fresh(plan)))void inspect();
    else if(!timer&&!work)schedule();
  }

  setDefaults();form.addEventListener('submit',start);
  time.addEventListener('input',()=>{timeEdited=true;});
  railOpen.addEventListener('click',()=>openPlanner(railOpen));
  checkButton.addEventListener('click',()=>{if(checkButton.getAttribute('aria-disabled')==='false')void inspect();});
  $('stop').addEventListener('click',()=>{stopWork();plan=null;notice='Appointment stopped.';timeEdited=false;setDefaults();render();primary.focus();});
  for(const [index,slot] of ['primary','backup'].entries())$('play-'+slot).addEventListener('click',event=>{
    if(event.currentTarget.getAttribute('aria-disabled')==='false')void inspect(index);
  });
  document.addEventListener('visibilitychange',()=>refresh({wake:true}));
  window.addEventListener('focus',()=>refresh({wake:true}));
  window.addEventListener('pagehide',()=>{stopWork();plan=null;render();});
  return {refresh,show(){if(!plan)setDefaults();refresh();}};
}

import {updateHTML} from './dom.js';
import {buildPlannerCandidates,chooseTonight,suggestProgram,programTotals,ballotDeck,sharedPicks,saveProgram,readProgram,exportProgram} from './watch-planner-model.js';
import {createWatchAppointment} from './watch-appointment.js';

const storageKey='cinema-watch-program-v1';
const proofAge=60_000,checkLimit=6;
const labels={ready:'Ready in player',local:'On this PC',options:'Find watch options',unchecked:'Not checked'};
const kinds={movies:'Film',tv:'Series',korean:'K-drama',anime:'Anime'};
const escape=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const icon=id=>`<svg class="cinema-icon" aria-hidden="true"><use href="#ico-${id}"/></svg>`;
const runtime=item=>item.minutes==null?'Runtime unknown':`${item.minutes} min${item.durationSource==='catalog-film'?' estimate':item.durationSource==='measured'?' measured':item.durationSource==='episode'?' episode':''}`;
const clock=minutes=>minutes<60?minutes+' min':Math.floor(minutes/60)+' hr'+(minutes%60?' '+minutes%60+' min':'');
const titleText=item=>item.year?item.title+' ('+item.year+')':item.title;
const safePoster=url=>typeof url==='string'&&/^\/api\/metadata\/poster\?id=[a-z\d_-]{1,100}$/i.test(url);

function localStamp(item){
  return JSON.stringify([item.name,item.size,item.total_size,item.content_path,item.save_path,item.completion_on,item.progress>=1,item.amount_left===0,/error|missingfiles|check|moving/i.test(item.state||'')]);
}
function libraryStamp(snapshot){
  if(!snapshot.connected)return 'offline';
  return JSON.stringify(snapshot.library.map(item=>[item.hash,localStamp(item)]).sort(([a],[b])=>String(a).localeCompare(String(b))));
}
function art(item){
  return safePoster(item.posterUrl)?`<img src="${escape(item.posterUrl)}" alt="" loading="lazy" decoding="async">`:icon('film');
}
function facts(item){
  return [item.year,kinds[item.kind],runtime(item)].filter(Boolean).map(escape).join(' · ');
}
function card(item,{action=true}={}){
  const state=labels[item.readiness]||labels.unchecked;
  const available=Boolean(item.local||item.titleItem);
  const cta=item.local?'Play':item.readiness==='options'?'Watch options':'Open title';
  return `<article class="planner-card"><div class="planner-poster">${art(item)}</div><div class="planner-card-copy">
    <span class="planner-state" data-ready="${escape(item.readiness||'unchecked')}">${escape(state)}</span>
    <h4>${escape(item.title)}</h4><p class="planner-facts">${facts(item)}</p>
    ${item.pickLabel?`<p class="planner-pick-label">${escape(item.pickLabel)}</p>`:''}
    ${item.reason?`<p class="planner-reason">${escape(item.reason)}</p>`:''}
    ${action&&available?`<button class="subtle" type="button" data-planner-open="${escape(item.id)}" aria-label="${escape(cta+' for '+titleText(item))}">${escape(cta)} ${icon('right')}</button>`:''}
    </div></article>`;
}
const empty=(heading,body)=>`<div class="planner-empty"><strong>${escape(heading)}</strong><p>${escape(body)}</p></div>`;
const budgetField=(id,label)=>`<label for="${id}">${label}<span class="planner-input-unit"><input id="${id}" type="number" min="1" max="1200" inputmode="numeric" step="1" placeholder="Any"><span aria-hidden="true">min</span></span></label>`;

export function createWatchPlanner({dialog,trigger,getSnapshot,verifyFile,openTitle,openPlayer,appointmentRail,checkAppointment,canCheckAppointment,getAppointmentPoster}){
  if(!dialog||!trigger)return {refresh(){}};
  dialog.innerHTML=`<div class="planner-shell">
    <header class="planner-header"><div><p class="planner-kicker">${icon('film')} CINEMA PLANNER</p><h2 id="watch-planner-heading">Plan a watch</h2><p>Make time for something good.</p></div>
      <button id="planner-close" class="planner-close" type="button" aria-label="Close watch planner">${icon('close')}</button></header>
    <div class="planner-modes" role="group" aria-label="Planning mode">
      <button type="button" data-planner-mode="tonight" aria-pressed="true">Tonight</button>
      <button type="button" data-planner-mode="movie" aria-pressed="false">Movie Night</button>
      <button type="button" data-planner-mode="together" aria-pressed="false">Pick Together</button>
      <button type="button" data-planner-mode="appointment" aria-pressed="false">Ready by</button>
    </div>
    <div class="planner-main">
      <section data-planner-panel="tonight" aria-labelledby="planner-tonight-heading">
        <div class="planner-section-heading"><div><h3 id="planner-tonight-heading">Tonight in Three Picks</h3><p>A short list for the time you have.</p></div></div>
        <div class="planner-fields">${budgetField('planner-tonight-budget','Time available')}
          <label for="planner-mood">Mood<select id="planner-mood"><option value="any">Any mood</option><option value="light">Light</option><option value="tense">Tense</option><option value="adventure">Adventure</option><option value="heartfelt">Heartfelt</option></select></label></div>
        <p id="planner-tonight-status" class="planner-status" role="status"></p><div id="planner-tonight-picks" class="planner-cards"></div>
      </section>
      <section data-planner-panel="movie" aria-labelledby="planner-movie-heading" hidden>
        <div class="planner-section-heading"><div><h3 id="planner-movie-heading">Movie Night</h3><p>Put together a double feature with room for a break.</p></div></div>
        <div class="planner-fields planner-program-fields">${budgetField('planner-movie-budget','Time available')}
          <label for="planner-intermission">Intermission<span class="planner-input-unit"><input id="planner-intermission" type="number" min="0" max="120" step="1" value="10" inputmode="numeric"><span aria-hidden="true">min</span></span></label>
          <button class="subtle" id="planner-suggest" type="button">Suggest two titles</button></div>
        <div class="planner-program-meta"><strong id="planner-total" role="status"></strong><span id="planner-remaining"></span></div>
        <ol id="planner-program" class="planner-program" aria-label="Movie Night program"></ol>
        <div class="planner-fields planner-add"><label for="planner-choices">Add a title<select id="planner-choices"></select></label><button id="planner-add" class="subtle" type="button">Add to program</button></div>
        <div class="planner-actions"><button id="planner-save" class="primary" type="button">Save on this PC</button><button id="planner-export" class="subtle" type="button">Export plan</button></div>
        <p id="planner-movie-status" class="planner-status" role="status"></p>
      </section>
      <section data-planner-panel="together" aria-label="Pick Together" hidden><div id="planner-together"></div></section>
      <section data-planner-panel="appointment" aria-label="Ready by" hidden></section>
    </div>
    <footer class="planner-footer" id="planner-footer"><div><strong>Local availability</strong><p id="planner-check-status" role="status"></p></div>
      <button id="planner-check" class="subtle" type="button">Check local files</button></footer>
  </div>`;

  const $=selector=>dialog.querySelector(selector);
  const budget=$('#planner-tonight-budget'),mood=$('#planner-mood'),movieBudget=$('#planner-movie-budget'),intermission=$('#planner-intermission');
  const choices=$('#planner-choices'),ballotHost=$('#planner-together'),tonightHost=$('#planner-tonight-picks'),programHost=$('#planner-program');
  const modes=[...dialog.querySelectorAll('[data-planner-mode]')],panels=[...dialog.querySelectorAll('[data-planner-panel]')];
  const verifiedFiles=new Map();
  const triedFiles=new Set();
  let proofsTimer=null,mode='tonight',snapshot={},fingerprint='',candidates=[],verification=null,handoff=false;
  let returnFocus=trigger;
  const appointment=createWatchAppointment({panel:$('[data-planner-panel="appointment"]'),rail:appointmentRail,dialog,getSnapshot,
    request:checkAppointment,canProbe:canCheckAppointment,getPoster:getAppointmentPoster,
    openPlanner:from=>showPlanner('appointment',from),openFile:file=>{
      handoff=true;
      if(dialog.open)dialog.close();
      void openPlayer(file.hash,null,file.index,null,{appointment:{epoch:file.epoch,key:file.key,playKey:file.playKey}});
    }});
  let program=[],programStatus='',checkStatus='',round=null,deckOffset=0;
  const readStored=()=>{try{return readProgram(localStorage.getItem(storageKey));}catch{return null;}};
  function loadStored(){
    const saved=readStored();
    if(saved){program=saved.items;intermission.value=String(saved.intermissionMinutes);}
  }
  loadStored();
  const valueOf=input=>input.value!==''&&input.validity.valid?Number(input.value):null;
  const breakMinutes=()=>valueOf(intermission)??0;
  const setText=(selector,text)=>{const node=$(selector);if(node.textContent!==text)node.textContent=text;};
  function setVerificationStatus(text){
    checkStatus=text;
    setText('#planner-check-status',text);
  }
  function cancelVerification(message=''){
    if(verification){verification.controller.abort();verification=null;}
    if(message)setVerificationStatus(message);
  }
  function scheduleProofExpiry(){
    clearTimeout(proofsTimer);proofsTimer=null;
    if(!dialog.open||!verifiedFiles.size)return;
    const expiry=Math.min(...[...verifiedFiles.values()].map(file=>file.checkedAt+proofAge));
    proofsTimer=setTimeout(refresh,Math.max(1,expiry-Date.now()));
  }
  function synchronize(){
    snapshot=getSnapshot()||{};
    snapshot={...snapshot,library:snapshot.library||[]};
    const nextStamp=libraryStamp(snapshot);
    if(verification&&verification.fingerprint!==nextStamp)cancelVerification('Library changed. Check local files again when ready.');
    if(fingerprint!==nextStamp)triedFiles.clear();
    fingerprint=nextStamp;
    const current=new Map(snapshot.library.map(item=>[item.hash,localStamp(item)]));
    let invalidated=false;
    for(const [hash,file] of verifiedFiles){
      if(snapshot.connected&&current.get(hash)===file.stamp&&Date.now()-file.checkedAt<proofAge)continue;
      verifiedFiles.delete(hash);invalidated=true;
    }
    if(invalidated&&!verification)setVerificationStatus(snapshot.connected?'Local availability changed. Check local files to confirm it again.':'Reconnect the library to check local files.');
    candidates=buildPlannerCandidates({...snapshot,verifiedFiles});
    scheduleProofExpiry();
  }
  function renderTonight(){
    const limit=valueOf(budget),invalid=!budget.validity.valid;
    const picks=invalid?[]:chooseTonight(candidates,{budgetMinutes:limit,mood:mood.value});
    setText('#planner-tonight-status',invalid?'Enter a whole number from 1 to 1,200 minutes.':picks.length?
      (picks.length===1?'1 pick':picks.length+' picks')+(limit?' within '+limit+' minutes.':'.'):'');
    updateHTML(tonightHost,picks.length?picks.map(item=>card(item)).join(''):
      empty(candidates.length?'No picks fit these choices':'Your lineup is still empty',candidates.length?'Try a longer time window or a different mood.':'Explore Home or save a title to My List, then come back here.'));
  }
  function liveProgram(){
    return program.map(item=>candidates.find(candidate=>candidate.id===item.id)||{...item,readiness:'unchecked'});
  }
  function renderMovie(){
    const items=liveProgram(),breakTime=breakMinutes(),totals=programTotals(items,breakTime);
    const limit=valueOf(movieBudget),partial=items.length&&totals.totalMinutes==null;
    setText('#planner-total',!items.length?'No titles yet':partial?'Total unknown':clock(totals.totalMinutes)+' total');
    setText('#planner-remaining',!items.length?'':partial?'At least one title has no confirmed runtime.':
      limit!=null?(limit>=totals.totalMinutes?clock(limit-totals.totalMinutes)+' to spare':clock(totals.totalMinutes-limit)+' over budget'):
      items.length===2&&breakTime?clock(breakTime)+' intermission included':'');
    updateHTML(programHost,items.length?items.map((item,index)=>`<li class="planner-program-step">
      <span class="planner-step-number" aria-hidden="true">${String(index+1).padStart(2,'0')}</span>
      <div class="planner-program-item">${card(item)}<div class="planner-order">
        <button type="button" class="subtle" data-planner-move="${index}:up" aria-label="Move ${escape(item.title)} up" ${index===0?'disabled':''}>Move up</button>
        <button type="button" class="subtle" data-planner-move="${index}:down" aria-label="Move ${escape(item.title)} down" ${index===items.length-1?'disabled':''}>Move down</button>
        <button type="button" class="subtle" data-planner-remove="${index}" aria-label="Remove ${escape(item.title)}">Remove</button>
      </div></div></li>`).join(''):`<li>${empty('Your evening is open','Pick two titles or start with a suggested program.')}</li>`);
    const available=candidates.filter(candidate=>!program.some(item=>item.id===candidate.id)).slice(0,120),previous=choices.value;
    updateHTML(choices,`<option value="">${available.length?'Choose from your lineup':'No more titles available'}</option>`+
      available.map(item=>`<option value="${escape(item.id)}">${escape(titleText(item)+' · '+runtime(item))}</option>`).join(''));
    if(available.some(item=>item.id===previous))choices.value=previous;
    choices.disabled=program.length>=2||!available.length;
    $('#planner-add').disabled=choices.disabled||!choices.value;
    $('#planner-suggest').disabled=candidates.length<2;
    $('#planner-save').disabled=$('#planner-export').disabled=!program.length||!intermission.validity.valid;
    setText('#planner-movie-status',programStatus);
  }
  function newRound({next=false}={}){
    if(next)deckOffset++;
    round={phase:'first',deck:ballotDeck(candidates,deckOffset),first:new Set(),second:new Set(),shared:[]};
  }
  function renderTogether({focus=false}={}){
    if(!round)newRound();
    const {phase,deck}=round;
    if(phase==='handoff'){
      updateHTML(ballotHost,`<div class="planner-handoff"><span class="planner-handoff-mark">${icon('film')}</span>
        <h3 id="planner-together-heading" tabindex="-1">Pass the screen</h3><p>When the second person is ready, hand them the controls.</p>
        <button class="primary" type="button" data-planner-ballot="continue">Ready for person two</button></div>`);
    }else if(phase==='result'){
      const ids=round.shared.map(item=>item.id),current=new Set(candidates.map(item=>item.id));
      const shared=sharedPicks(round.shared,ids,ids,candidates).map(item=>current.has(item.id)?item:{...item,titleItem:undefined});
      updateHTML(ballotHost,`<div class="planner-section-heading"><div><h3 id="planner-together-heading" tabindex="-1">${shared.length?'Your shared picks':'No shared picks this round'}</h3>
        <p>${shared.length?'Titles you both chose, with ready options first.':'Try another shortlist for a fresh round.'}</p></div></div>
        ${shared.length?`<div class="planner-cards">${shared.map(item=>card(item)).join('')}</div>`:''}
        <button class="subtle planner-round-action" type="button" data-planner-ballot="another">Try another shortlist</button>`);
    }else{
      const vote=phase==='first'?round.first:round.second;
      updateHTML(ballotHost,`<div class="planner-section-heading"><div><h3 id="planner-together-heading" tabindex="-1">Person ${phase==='first'?'one':'two'}, your turn</h3>
        <p>Choose any titles you’d be happy to watch.</p></div></div>
        ${deck.length?`<div class="planner-ballot" role="group" aria-label="Private shortlist">${deck.map(item=>`<button class="planner-vote" type="button"
          data-planner-vote="${escape(item.id)}" aria-pressed="${vote.has(item.id)}"><span class="planner-poster">${art(item)}</span><span class="planner-vote-copy">
          <strong>${escape(item.title)}</strong><span class="planner-facts">${facts(item)}</span></span><span class="planner-vote-check" aria-hidden="true">${icon('check')}</span></button>`).join('')}</div>
          <button class="primary planner-round-action" type="button" data-planner-ballot="finish">${phase==='first'?'Finish my picks':'Reveal shared picks'}</button>`:
          empty('No shortlist yet','Discover or save a few titles, then come back to Pick Together.') }`);
    }
    if(focus)$('#planner-together-heading')?.focus();
  }
  function render(){
    const check=$('#planner-check');
    check.textContent=verification?'Cancel check':'Check local files';
    check.disabled=!verification&&(!snapshot.connected||!candidates.some(item=>item.verifyHash&&!verifiedFiles.has(item.verifyHash)));
    setText('#planner-check-status',checkStatus||(!snapshot.connected?'Reconnect the library to check local files.':'Check up to six files from your library.'));
    if(mode==='tonight')renderTonight();
    if(mode==='movie')renderMovie();
  }
  function refresh(){
    appointment.refresh();
    if(!dialog.open)return;
    synchronize();render();
    if(mode==='together'&&round?.phase==='result')renderTogether();
  }
  function switchMode(next){
    if(next===mode)return;
    if(mode==='together'){round=null;ballotHost.replaceChildren();}
    mode=next;
    for(const button of modes)button.setAttribute('aria-pressed',String(button.dataset.plannerMode===mode));
    for(const panel of panels)panel.hidden=panel.dataset.plannerPanel!==mode;
    $('#planner-footer').hidden=mode==='appointment';
    if(mode==='appointment'){cancelVerification();appointment.show?.();}
    if(mode==='together'){newRound();renderTogether({focus:true});}
    refresh();
  }
  async function checkLocal(){
    if(verification){cancelVerification('Local check canceled.');render();return;}
    synchronize();
    const pending=[...new Set(candidates.map(item=>item.verifyHash).filter(Boolean))].filter(hash=>!verifiedFiles.has(hash));
    if(!pending.some(hash=>!triedFiles.has(hash)))triedFiles.clear();
    const hashes=pending.filter(hash=>!triedFiles.has(hash)).slice(0,checkLimit);
    if(!snapshot.connected||!hashes.length){setVerificationStatus(snapshot.connected?'No unchecked files to verify.':'Reconnect the library to check local files.');render();return;}
    const check={controller:new AbortController(),fingerprint};
    verification=check;
    const found=new Map();
    for(let i=0;i<hashes.length;i++){
      if(verification!==check||check.controller.signal.aborted)return;
      const hash=hashes[i],item=snapshot.library.find(entry=>entry.hash===hash);
      triedFiles.add(hash);
      setVerificationStatus('Checking local file '+(i+1)+' of '+hashes.length+'…');render();
      const signal=AbortSignal.any([check.controller.signal,AbortSignal.timeout(3500)]);
      try{
        const file=await verifyFile(hash,signal);
        if(Number.isSafeInteger(file?.index)&&file.index>=0&&typeof file.fileName==='string'&&file.fileName&&
          !/[\\/]/.test(file.fileName)&&Number.isSafeInteger(file.size)&&file.size>0&&!signal.aborted&&item){
          found.set(hash,{index:file.index,fileName:file.fileName,size:file.size,checkedAt:Date.now(),stamp:localStamp(item)});
        }
      }catch{}
      if(verification!==check||!dialog.open)return;
      synchronize();
      if(verification!==check)return;
    }
    for(const [hash,file] of found)verifiedFiles.set(hash,file);
    verification=null;
    setVerificationStatus(found.size?'Checked '+found.size+' completed video '+(found.size===1?'file':'files')+'.':'No completed video file could be confirmed.');
    refresh();
  }
  function launch(id){
    synchronize();
    const item=candidates.find(candidate=>candidate.id===id);
    if(!item?.local&&!item?.titleItem){render();if(mode==='together')renderTogether();return;}
    handoff=true;
    dialog.close();
    if(item.local)void openPlayer(item.local.hash,item.local.intent??null,item.local.index);
    else void openTitle(item.titleItem);
  }
  function save(exporting){
    const items=liveProgram(),record=exporting?exportProgram(items,breakMinutes()):saveProgram(items,breakMinutes());
    if(!record){programStatus='Choose at least one title with exportable metadata.';renderMovie();return;}
    const json=JSON.stringify(record,null,2);
    if(new TextEncoder().encode(json+(exporting?'\n':'')).length>8192){programStatus='This program is too large to save.';renderMovie();return;}
    try{
      if(exporting){
        const url=URL.createObjectURL(new Blob([json+'\n'],{type:'application/json'}));
        const link=document.createElement('a');
        link.href=url;link.download='cinema-movie-night.json';document.body.append(link);
        try{link.click();}finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
        programStatus='Export requested. Check your downloads.';
      }else{
        localStorage.setItem(storageKey,json);
        programStatus='Movie Night saved on this PC.';
      }
    }catch{programStatus=exporting?'Could not start the export.':'Could not save this program on this PC.';}
    renderMovie();
  }
  function ballotAction(action){
    if(action==='another'){newRound({next:true});renderTogether({focus:true});return;}
    if(action==='continue'&&round.phase==='handoff')round.phase='second';
    else if(action==='finish'&&round.phase==='first')round.phase='handoff';
    else if(action==='finish'&&round.phase==='second'){
      synchronize();
      const ids=new Set(sharedPicks(round.deck,round.first,round.second,candidates).map(item=>item.id));
      round.shared=round.deck.filter(item=>ids.has(item.id));
      round.first.clear();round.second.clear();round.deck=[];round.phase='result';
    }else return;
    renderTogether({focus:true});
  }

  dialog.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button||button.disabled)return;
    const data=button.dataset;
    if(data.plannerMode)switchMode(data.plannerMode);
    else if(data.plannerOpen)launch(data.plannerOpen);
    else if(data.plannerBallot)ballotAction(data.plannerBallot);
    else if(data.plannerVote&&['first','second'].includes(round?.phase)){
      const vote=round[round.phase],id=data.plannerVote;
      if(vote.has(id))vote.delete(id);else vote.add(id);
      button.setAttribute('aria-pressed',String(vote.has(id)));
    }else if(data.plannerMove){
      const [from,direction]=data.plannerMove.split(':'),index=Number(from),target=index+(direction==='up'?-1:1);
      [program[index],program[target]]=[program[target],program[index]];
      programStatus='Program order updated.';renderMovie();
      programHost.querySelectorAll('.planner-program-step')[target]?.querySelector('button:not([disabled])')?.focus();
    }else if(data.plannerRemove!==undefined){
      program.splice(Number(data.plannerRemove),1);programStatus='Title removed from the program.';renderMovie();
      (choices.disabled?$('#planner-suggest'):choices).focus();
    }
  });
  $('#planner-close').addEventListener('click',()=>dialog.close());
  $('#planner-check').addEventListener('click',()=>{void checkLocal();});
  for(const field of [budget,mood])field.addEventListener('input',renderTonight);
  for(const field of [movieBudget,intermission])field.addEventListener('input',()=>{programStatus='';renderMovie();});
  choices.addEventListener('change',()=>{$('#planner-add').disabled=!choices.value;});
  $('#planner-add').addEventListener('click',()=>{
    const item=candidates.find(candidate=>candidate.id===choices.value);
    if(item&&program.length<2&&!program.some(entry=>entry.id===item.id)){
      program.push(item);programStatus='Added '+item.title+'.';choices.value='';renderMovie();
      (choices.disabled?$('#planner-save'):choices).focus();
    }
  });
  $('#planner-suggest').addEventListener('click',()=>{
    const limit=valueOf(movieBudget);
    if(!movieBudget.validity.valid||!intermission.validity.valid){programStatus='Enter a valid time and intermission first.';renderMovie();return;}
    const picks=suggestProgram(candidates,{budgetMinutes:limit,intermissionMinutes:breakMinutes()});
    if(picks.length===2){program=picks;programStatus='A two-title program is ready to edit.';}
    else programStatus='No two-title program fits. Try a longer window or add titles yourself.';
    renderMovie();
  });
  $('#planner-save').addEventListener('click',()=>save(false));
  $('#planner-export').addEventListener('click',()=>save(true));
  function showPlanner(next,opener){
    if(dialog.open)return;
    handoff=false;checkStatus='';
    returnFocus=opener;
    switchMode(next);
    dialog.showModal();
    if(next==='appointment')appointment.show?.();
    refresh();
    modes.find(button=>button.dataset.plannerMode===next)?.focus();
  }
  trigger.addEventListener('click',()=>showPlanner('tonight',trigger));
  dialog.addEventListener('close',()=>{
    if(dialog.open)return;
    cancelVerification();verifiedFiles.clear();triedFiles.clear();clearTimeout(proofsTimer);
    round=null;deckOffset=0;ballotHost.replaceChildren();
    appointment.refresh();
    if(!handoff){
      const target=[returnFocus,trigger].find(node=>node?.isConnected&&!node.closest('[hidden]'));
      (target||document.querySelector('#main-content'))?.focus();
    }
  });
  return {refresh};
}


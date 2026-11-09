import {updateHTML} from './dom.js';

const PAGE_SIZE=12,RESULT_LIMIT=60,NO_MATCHES='No watched dialogue matches this search.';
const escapeText=value=>String(value??'').replace(/[&<>"']/g,character=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[character]));
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const visible=element=>element?.isConnected&&!element.closest('[hidden]')&&element.getClientRects().length>0;
const success=result=>result!==false&&result?.ok!==false;
const arrow='<span aria-hidden="true">→</span>';
const closeIcon='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

function resultCard(result,index,time){
  const title=typeof result.title==='string'&&result.title.trim()?result.title:'Saved title';
  const poster=typeof result.posterUrl==='string'&&result.posterUrl.startsWith('/api/metadata/poster?')?
    '<img src="'+escapeText(result.posterUrl)+'" alt="" width="60" height="88" loading="lazy" decoding="async">':'';
  return '<li class="dialogue-result"><div class="dialogue-poster" aria-hidden="true"><span>'+
    escapeText(title.trim().slice(0,1).toUpperCase())+'</span>'+poster+'</div><div class="dialogue-result-copy"><div class="dialogue-result-heading"><h3>'+
    escapeText(title)+'</h3><span class="dialogue-time">'+escapeText(time)+'</span></div><blockquote>'+escapeText(result.quote)+
    '</blockquote></div><button type="button" class="subtle" data-dialogue-result="'+index+'" aria-label="Open file for '+
    escapeText(title+' at '+time)+'">Open file '+arrow+'</button></li>';
}

function mountRecap(host,home){
  const id=home?'watched-catch-up-title':'player-catch-up-title';
  host.classList.add('watched-recap');
  if(!home)host.setAttribute('aria-labelledby',id);
  host.innerHTML=`
    <div class="recap-heading">
      <div><p class="dialogue-kicker">YOUR WATCHED PASSAGE</p><h2 id="${id}" tabindex="-1">Catch Up</h2></div>
      <button class="recap-close" type="button" data-catch-up-close aria-label="Close Catch Up">${closeIcon}</button>
    </div>
    <div class="recap-body">
      <div class="recap-passage" data-catch-up-passage hidden>
        <span>Previously watched</span><strong data-catch-up-range></strong>
      </div>
      <p class="recap-status" data-catch-up-status role="status" aria-live="polite" aria-atomic="true"></p>
      <ul class="recap-lines" data-catch-up-lines aria-label="Watched dialogue in this passage" hidden></ul>
      <div class="recap-actions">
        <button type="button" class="subtle" data-catch-up-retry hidden>Try again</button>
        <button type="button" class="subtle" data-catch-up-replay hidden></button>
        <button type="button" class="primary" data-catch-up-resume hidden></button>
      </div>
    </div>`;
  const $=selector=>host.querySelector(selector);
  return {host,heading:$('#'+id),close:$('[data-catch-up-close]'),passage:$('[data-catch-up-passage]'),
    range:$('[data-catch-up-range]'),status:$('[data-catch-up-status]'),lines:$('[data-catch-up-lines]'),
    retry:$('[data-catch-up-retry]'),replay:$('[data-catch-up-replay]'),resume:$('[data-catch-up-resume]'),session:null};
}

export function createWatchedDialogueUI({searchHost,recapDialog,playerHost,formatTime,getCollection,
  setCollection,clearEvidence,search,loadRecap,onModeChange,onOpenMatch,onReplay,onResume}){
  searchHost.classList.add('watched-dialogue-search');
  searchHost.innerHTML=`
    <div class="dialogue-modes" role="group" aria-label="Search mode">
      <button type="button" data-dialogue-mode="titles" aria-pressed="true">Titles</button>
      <button type="button" data-dialogue-mode="dialogue" aria-pressed="false" aria-controls="watched-dialogue-panel">Watched Dialogue</button>
    </div>
    <section id="watched-dialogue-panel" class="dialogue-panel" aria-labelledby="watched-dialogue-title" hidden>
      <header class="dialogue-header"><div>
        <p class="dialogue-kicker">FROM YOUR WATCH HISTORY</p>
        <h2 id="watched-dialogue-title">Find a line you remember</h2>
        <p>Search dialogue from passages you watched with captions.</p>
      </div></header>
      <div class="dialogue-opt-in" data-dialogue-welcome hidden>
        <div><strong>Remember watched passages</strong><p>Cinema saves watched ranges on this device so you can find their dialogue later.</p></div>
        <button type="button" class="primary" data-dialogue-opt-in>Turn on collection</button>
      </div>
      <form class="dialogue-search-form" data-dialogue-search>
        <label for="watched-dialogue-query" class="sr-only">Search watched dialogue</label>
        <input id="watched-dialogue-query" type="search" data-dialogue-query required autocomplete="off" maxlength="120" placeholder="Try a name or phrase">
        <button type="submit" class="primary" data-dialogue-submit>Search dialogue</button>
      </form>
        <p class="dialogue-status" data-dialogue-status role="status" aria-live="polite" aria-atomic="true"></p>
      <details class="dialogue-privacy" data-dialogue-privacy>
        <summary>Viewing evidence controls <span data-dialogue-collection-status></span></summary>
        <div class="dialogue-privacy-body">
          <p>Collection is local to this device. You can pause it and keep searching evidence you already saved.</p>
          <div class="dialogue-privacy-actions">
            <button type="button" class="subtle" data-dialogue-collection-toggle></button>
            <button type="button" class="subtle" data-dialogue-clear aria-expanded="false" aria-controls="dialogue-clear-confirmation">Clear evidence</button>
          </div>
          <div id="dialogue-clear-confirmation" class="dialogue-clear-confirm" data-dialogue-clear-confirm hidden>
            <p>Clear the watched passage and dialogue evidence on this device?</p>
            <div class="dialogue-privacy-actions">
              <button type="button" class="subtle" data-dialogue-cancel-clear>Keep evidence</button>
              <button type="button" class="subtle" data-dialogue-confirm-clear>Clear evidence</button>
            </div>
          </div>
        </div>
      </details>
      <div class="dialogue-listing">
        <nav class="dialogue-pages" aria-label="Watched dialogue result pages" data-dialogue-pages hidden>
          <button type="button" class="subtle" data-dialogue-previous>Previous</button>
          <span data-dialogue-page></span>
          <button type="button" class="subtle" data-dialogue-next>Next</button>
        </nav>
        <ul class="dialogue-results" aria-label="Matching watched dialogue" data-dialogue-results hidden></ul>
      </div>
    </section>`;
  const $=selector=>searchHost.querySelector(selector);
  const modeButtons=[...searchHost.querySelectorAll('[data-dialogue-mode]')],panel=$('#watched-dialogue-panel'),
    form=$('[data-dialogue-search]'),input=$('[data-dialogue-query]'),results=$('[data-dialogue-results]'),
    status=$('[data-dialogue-status]'),pages=$('[data-dialogue-pages]'),pageLabel=$('[data-dialogue-page]'),
    previous=$('[data-dialogue-previous]'),next=$('[data-dialogue-next]'),welcome=$('[data-dialogue-welcome]'),
    enable=$('[data-dialogue-opt-in]'),toggle=$('[data-dialogue-collection-toggle]'),privacy=$('[data-dialogue-privacy]'),
    collection=$('[data-dialogue-collection-status]'),clear=$('[data-dialogue-clear]'),confirmation=$('[data-dialogue-clear-confirm]'),
    keep=$('[data-dialogue-cancel-clear]'),confirmClear=$('[data-dialogue-confirm-clear]');
  const surfaces={home:mountRecap(recapDialog,true),player:mountRecap(playerHost,false)};
  playerHost.hidden=true;
  let currentMode='titles',queryTask=null,openTask=null,resultsData=[],limited=false,hasSearched=false,page=1,
    message='',collectionBusy=false,searchMotion=null;
  const time=value=>String(formatTime(value));
  const motionAllowed=()=>!matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate=element=>motionAllowed()?element.animate([{opacity:.78,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],
    {duration:160,easing:'ease-out'}):null;

  function collectionState(){
    const value=getCollection();
    return typeof value==='boolean'?{enabled:value,hasEvidence:undefined}:
      {enabled:value?.enabled===true,hasEvidence:value?.hasEvidence};
  }
  function refreshCollection(){
    const state=collectionState();
    welcome.hidden=state.enabled||state.hasEvidence===true;
    form.hidden=!state.enabled&&state.hasEvidence===false;
    setText(collection,state.enabled?'Collection on':state.hasEvidence===true?'Collection paused':'Collection off');
    setText(toggle,state.enabled?'Pause collection':'Turn on collection');
    for(const button of [enable,toggle,clear,confirmClear])button.setAttribute('aria-disabled',String(collectionBusy));
    if(currentMode==='dialogue'&&!message&&!hasSearched&&!queryTask&&state.enabled&&state.hasEvidence===false)
      setText(status,'Play a title with captions to start collecting dialogue.');
    return state;
  }
  function renderSearch(){
    const state=refreshCollection();
    const total=resultsData.length,totalPages=Math.max(1,Math.ceil(total/PAGE_SIZE)),start=(page-1)*PAGE_SIZE;
    results.hidden=!total;
    results.setAttribute('aria-busy',String(Boolean(queryTask)));
    pages.hidden=totalPages<2;
    previous.setAttribute('aria-disabled',String(page<=1));
    next.setAttribute('aria-disabled',String(page>=totalPages));
    setText(pageLabel,'Page '+page+' of '+totalPages);
    updateHTML(results,resultsData.slice(start,start+PAGE_SIZE).map((result,offset)=>resultCard(result,start+offset,time(result.time))).join(''));
    for(const button of results.querySelectorAll('[data-dialogue-result]'))
      button.setAttribute('aria-disabled',String(Boolean(openTask)));
    const count=total?(total===1?'1 watched match':total+' watched matches')+'.':NO_MATCHES;
    const idle=state.enabled&&state.hasEvidence===false?'Play a title with captions to start collecting dialogue.':'';
    setText(status,message||(queryTask?'Checking your watched dialogue…':hasSearched?count+
      (limited?' This search reached a local evidence limit.':''):idle));
  }
  function clearSearchData(){
    const query=queryTask,opening=openTask;
    queryTask=null;openTask=null;
    query?.abort();opening?.controller.abort();
    resultsData=[];limited=false;hasSearched=false;page=1;message='';
    renderSearch();
  }
  function resetConfirmation({focus=false}={}){
    confirmation.hidden=true;
    clear.setAttribute('aria-expanded','false');
    if(focus&&visible(clear))clear.focus({preventScroll:true});
  }
  function setMode(nextMode,{focus=false}={}){
    if(!['titles','dialogue'].includes(nextMode))return;
    const changed=currentMode!==nextMode;
    currentMode=nextMode;
    if(changed){
      clearSearchData();
      resetConfirmation();
      privacy.open=false;
    }
    panel.hidden=nextMode==='titles';
    for(const button of modeButtons)button.setAttribute('aria-pressed',String(button.dataset.dialogueMode===nextMode));
    onModeChange(nextMode);
    if(changed){
      searchMotion?.cancel();
      searchMotion=panel.hidden?null:animate(panel);
    }
    if(focus)focusSearch();
  }
  function mode(){return currentMode;}
  function focusSearch(){
    if(currentMode!=='dialogue')return false;
    const target=form.hidden?enable:input;
    if(!visible(target))return false;
    target.focus({preventScroll:true});
    return true;
  }
  function closeSearch(){
    input.value='';
    if(currentMode==='titles')clearSearchData();
    setMode('titles');
  }

  async function updateCollection(enabled,initiator){
    if(collectionBusy)return;
    collectionBusy=true;refreshCollection();
    try{
      if(!success(await setCollection(enabled)))throw Error();
      if(enabled&&initiator===enable&&document.activeElement===enable&&currentMode==='dialogue'){
        refreshCollection();
        input.focus({preventScroll:true});
      }
      message=enabled?'Collection is on.':'Collection is paused.';
    }catch{message='Couldn’t update collection. Try again.';}
    finally{collectionBusy=false;renderSearch();}
  }
  async function clearSavedEvidence(){
    if(collectionBusy)return;
    collectionBusy=true;refreshCollection();
    try{
      if(!success(await clearEvidence()))throw Error();
      invalidate();
      resetConfirmation({focus:true});
      message='Watched evidence cleared.';
    }catch{message='Couldn’t clear watched evidence. Try again.';}
    finally{collectionBusy=false;renderSearch();}
  }

  async function submitSearch(event){
    event.preventDefault();
    const query=input.value.trim();
    if(!query||currentMode!=='dialogue'||form.hidden)return;
    clearSearchData();
    const task=new AbortController();
    queryTask=task;
    renderSearch();
    try{
      const reply=await search(query,task.signal);
      if(queryTask!==task)return;
      if(!Array.isArray(reply?.results))throw Error();
      resultsData=reply.results.filter(result=>typeof result?.quote==='string'&&result.quote.trim()&&
        Number.isFinite(result.time)&&result.time>=0).slice(0,RESULT_LIMIT);
      limited=reply.limited===true||reply.results.length>RESULT_LIMIT;
      message='';hasSearched=true;
    }catch{
      if(queryTask===task&&!task.signal.aborted)message='Couldn’t check watched dialogue. Try again.';
    }finally{
      if(queryTask===task){queryTask=null;renderSearch();}
    }
  }
  async function openMatch(index){
    const result=resultsData[index];
    if(openTask||!result)return;
    const task={controller:new AbortController()};
    openTask=task;message='Checking the exact file…';renderSearch();
    try{
      if(!success(await onOpenMatch(result,task.controller.signal)))throw Error();
      if(openTask===task)message='';
    }catch{
      if(openTask===task){
        resultsData=resultsData.filter(entry=>entry!==result);
        page=Math.min(page,Math.max(1,Math.ceil(resultsData.length/PAGE_SIZE)));
        message='This exact file can’t open from this result. Search again to refresh it.';
      }
    }finally{
      if(openTask===task){openTask=null;renderSearch();}
    }
  }
  function movePage(delta){
    const requested=page+delta;
    if(openTask||queryTask||requested<1||requested>Math.ceil(resultsData.length/PAGE_SIZE))return;
    page=requested;message='';renderSearch();
    const total=resultsData.length;
    setText(status,'Showing matches '+((page-1)*PAGE_SIZE+1)+'–'+Math.min(page*PAGE_SIZE,total)+' of '+total+'.'+
      (limited?' This search reached a local evidence limit.':''));
  }

  function validRecap(recap){
    return recap&&[recap.start,recap.end,recap.resumeTime].every(Number.isFinite)&&recap.start>=0&&
      recap.start<recap.end&&recap.end<=recap.resumeTime&&recap.end-recap.start<=45;
  }
  function renderRecap(surface){
    const session=surface.session,recap=session?.recap;
    setText(surface.status,session?.message||'');
    surface.passage.hidden=!recap;
    const lines=Array.isArray(recap?.lines)?recap.lines.filter(line=>Number.isFinite(line?.time)&&
      line.time>=recap.start&&line.time<=recap.end&&typeof line.text==='string'&&line.text.trim()).slice(0,3):[];
    if(recap)setText(surface.range,time(recap.start)+' – '+time(recap.end));
    surface.lines.hidden=!lines.length;
    updateHTML(surface.lines,lines.map(line=>'<li><span class="dialogue-time">'+escapeText(time(line.time))+
      '</span><blockquote>'+escapeText(line.text)+'</blockquote></li>').join(''));
    surface.retry.hidden=!session?.retry&&surface.retry!==document.activeElement;
    surface.retry.setAttribute('aria-disabled',String(!session?.retry||session?.loading));
    surface.replay.hidden=!recap;
    surface.resume.hidden=!recap;
    if(recap){
      setText(surface.replay,recap.canReplay===true?'Replay passage':'Open from '+time(recap.start));
      setText(surface.resume,'Resume at '+time(recap.resumeTime));
    }
    for(const button of [surface.replay,surface.resume])button.setAttribute('aria-disabled',String(Boolean(session?.acting)));
  }
  function releaseRecap(surface){
    const session=surface.session;
    surface.session=null;
    session?.controller?.abort();
    session?.actionController?.abort();
    session?.motion?.cancel();
    renderRecap(surface);
    return session;
  }
  async function requestRecap(surface,session){
    const task=new AbortController();
    session.controller?.abort();
    session.controller=task;session.loading=true;session.retry=false;
    session.recap=null;session.message='Finding your last watched passage…';
    renderRecap(surface);
    try{
      const recap=await loadRecap(session.target,task.signal);
      if(surface.session!==session||session.controller!==task)return;
      if(validRecap(recap)){
        session.recap=recap;
        session.message=recap.lines?.length?'Lines from this watched passage.':
          'This passage has a verified time range. Captions aren’t available for it.';
      }else session.message='There’s no verified watched passage before this resume point.';
    }catch{
      if(surface.session===session&&session.controller===task&&!task.signal.aborted){
        session.retry=true;session.message='Couldn’t load Catch Up. Try again.';
      }
    }finally{
      if(surface.session===session&&session.controller===task){session.loading=false;renderRecap(surface);}
    }
  }
  async function openCatchUp(target,{surface='home',trigger=document.activeElement}={}){
    const view=surfaces[surface];
    if(!view||!target)return false;
    releaseRecap(view);
    const session=view.session={target,trigger,recap:null,controller:null,actionController:null,motion:null};
    if(surface==='home'){
      if(!recapDialog.open)recapDialog.showModal();
    }else playerHost.hidden=false;
    view.heading.focus({preventScroll:true});
    session.motion=animate(view.host);
    await requestRecap(view,session);
    return view.session===session&&Boolean(session.recap);
  }
  function closePlayer({restoreFocus=false}={}){
    const session=releaseRecap(surfaces.player);
    playerHost.hidden=true;
    if(restoreFocus&&visible(session?.trigger))session.trigger.focus({preventScroll:true});
  }
  function invalidate(){
    clearSearchData();
    for(const surface of Object.values(surfaces)){
      const session=surface.session;
      if(!session)continue;
      if(surface===surfaces.home&&session.handoff){releaseRecap(surface);continue;}
      session.controller?.abort();session.controller=null;session.loading=false;
      session.actionController?.abort();session.actionController=null;session.acting=false;
      session.recap=null;session.retry=false;session.message='This watched passage is no longer available.';
      renderRecap(surface);
    }
  }
  async function actOnRecap(surface,action){
    const session=surface.session,recap=session?.recap;
    if(!recap||session.acting)return;
    const home=surface===surfaces.home,controller=new AbortController();
    session.actionController=controller;session.acting=true;
    session.message=action==='replay'?'Checking this watched passage…':'Checking the exact file…';
    renderRecap(surface);
    if(home){session.handoff=true;recapDialog.close();}
    try{
      const callback=action==='replay'?onReplay:onResume;
      if(!success(await callback(session.target,recap,controller.signal)))throw Error();
      if(surface.session!==session||session.actionController!==controller)return;
      if(home)releaseRecap(surface);else closePlayer();
    }catch{
      if(surface.session!==session||session.actionController!==controller)return;
      session.actionController=null;session.handoff=false;session.acting=false;session.recap=null;
      session.message='This exact file or passage is no longer available.';
      renderRecap(surface);
      if(home&&!document.querySelector('dialog[open]')&&visible(session.trigger)){
        recapDialog.showModal();
        surface.heading.focus({preventScroll:true});
      }else if(home)releaseRecap(surface);
    }
  }

  for(const button of modeButtons)button.addEventListener('click',()=>setMode(button.dataset.dialogueMode));
  form.addEventListener('submit',submitSearch);
  input.addEventListener('input',clearSearchData);
  previous.addEventListener('click',()=>movePage(-1));
  next.addEventListener('click',()=>movePage(1));
  results.addEventListener('click',event=>{
    const button=event.target.closest('[data-dialogue-result]');
    if(button)void openMatch(Number(button.dataset.dialogueResult));
  });
  results.addEventListener('error',event=>{if(event.target.matches?.('.dialogue-poster img'))event.target.remove();},true);
  enable.addEventListener('click',()=>void updateCollection(true,enable));
  toggle.addEventListener('click',()=>void updateCollection(!collectionState().enabled,toggle));
  clear.addEventListener('click',()=>{
    if(collectionBusy)return;
    confirmation.hidden=false;
    clear.setAttribute('aria-expanded','true');
    keep.focus({preventScroll:true});
  });
  keep.addEventListener('click',()=>resetConfirmation({focus:true}));
  confirmClear.addEventListener('click',()=>void clearSavedEvidence());
  privacy.addEventListener('toggle',()=>{if(!privacy.open)resetConfirmation();});
  for(const surface of Object.values(surfaces)){
    surface.replay.addEventListener('click',()=>void actOnRecap(surface,'replay'));
    surface.resume.addEventListener('click',()=>void actOnRecap(surface,'resume'));
    surface.retry.addEventListener('click',()=>{
      const session=surface.session;
      if(session?.retry&&!session.loading)void requestRecap(surface,session);
    });
    surface.retry.addEventListener('blur',()=>{if(!surface.session?.retry)surface.retry.hidden=true;});
  }
  surfaces.home.close.addEventListener('click',()=>recapDialog.close());
  surfaces.player.close.addEventListener('click',()=>closePlayer({restoreFocus:true}));
  recapDialog.addEventListener('close',()=>{
    if(recapDialog.open||surfaces.home.session?.handoff)return;
    const session=releaseRecap(surfaces.home);
    if(visible(session?.trigger))session.trigger.focus({preventScroll:true});
  });
  renderSearch();
  return {mode,setMode,focusSearch,closeSearch,invalidate,openCatchUp,closePlayer,refreshCollection};
}

import {updateHTML,updateKeyedList} from './dom.js';
import {createStoryOrbit} from './story-orbit.js';

const playIcon='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.4a.8.8 0 0 1 1.22-.68l10.15 6.6a.8.8 0 0 1 0 1.36l-10.15 6.6A.8.8 0 0 1 8 18.6z"/></svg>';
const forwardIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const closeIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
export function buildEpisodeJourney(catalog,history={},library=[]){
  const aired=(catalog?.episodes||[]).filter(episode=>episode.aired===true&&!episode.special&&Number.isInteger(episode.number)&&episode.number>0)
    .sort((a,b)=>a.season-b.season||a.number-b.number);
  const byId=new Map(aired.map(episode=>[episode.id,episode]));
  const local=new Set(library.map(torrent=>torrent.hash));
  const activity=new Map();
  for(const [hash,entry] of Object.entries(history)){
    const files=entry?.files&&typeof entry.files==='object'?Object.values(entry.files):[entry];
    for(const record of files){
      const identity=record?.episode;
      if(!identity||identity.showId!==catalog?.show?.id||!byId.has(identity.episodeId))continue;
      const time=Number.isFinite(record.time)?record.time:0;
      const finished=record.finished===true;
      if(!finished&&time<=0)continue;
      const updated=Number.isFinite(record.updated)?record.updated:0;
      const state=activity.get(identity.episodeId)||{finished:false,updated:-1,resumeFile:null};
      state.finished=state.finished||finished;
      state.updated=Math.max(state.updated,updated);
      if(!finished&&(!state.resumeFile||updated>state.resumeFile.updated))state.resumeFile={hash,index:record.index,time,updated};
      if(local.has(hash)&&(!state.pack||updated>state.pack.updated))state.pack={hash,updated};
      activity.set(identity.episodeId,state);
    }
  }
  const episodeStates=new Map([...activity].map(([id,state])=>[id,state.finished?'watched':'in-progress']));
  const watchedCount=[...activity.values()].filter(state=>state.finished).length;
  const watchable=episode=>episode.searchable&&(!episode.calendarSeason||episode.absoluteNumber);
  const last=aired.reduce((recent,episode)=>{
    const current=activity.get(episode.id);
    return current&&(!recent||current.updated>=activity.get(recent.id).updated)?episode:recent;
  },null);
  const lastState=last&&activity.get(last.id);
  let next=null;
  if(lastState&&!lastState.finished&&watchable(last)){
    const file=lastState.resumeFile;
    const resume=file&&local.has(file.hash)&&Number.isInteger(file.index)&&file.index>=0?{hash:file.hash,index:file.index,time:file.time}:null;
    next={episode:last,mode:'resume',resume};
  }else{
    const unwatched=episode=>watchable(episode)&&!activity.get(episode.id)?.finished;
    const following=aired.slice(aired.indexOf(last)+1).find(unwatched);
    const episode=following||aired.find(unwatched);
    if(episode){
      const mode=!last?'start':following?'next':'earlier';
      const packHash=last?.season===episode.season?lastState?.pack?.hash:null;
      next={episode,mode,packHash:packHash||null};
    }
  }
  return {episodeStates,watchedCount,airedCount:aired.length,next};
}

export async function findVerifiedLocalEpisode(api,{hash,showId,episodeId,expectedIndex=null,signal}){
  try{
    const target=await api('/api/episodes/file',{hash,showId,episodeId},false,signal);
    if(target?.verified&&target.singleEpisode===true&&Number.isInteger(target.index)&&target.index>=0&&
      (expectedIndex===null||expectedIndex===target.index)&&
      target.intent?.showId===showId&&target.intent?.episodeId===episodeId)return target;
  }catch{}
  return null;
}

function reportedPeers(value){
  if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))return null;
  const count=Number(value);
  return Number.isSafeInteger(count)&&count>=0?count:null;
}

export function bestEpisodePlaybackSource(sources,verifiedLocal){
  return sources.find(source=>source.existingHash&&verifiedLocal(source))||
    sources.find(source=>!source.existingHash&&source.key&&reportedPeers(source.nbSeeders)>0)||null;
}

function suitableLocalEpisode(torrent,target){
  const file=target?.matches?.find(row=>row.index===target.index);
  if(!torrent||!file||/error|missing|checking|moving/i.test(torrent.state||''))return false;
  return file.progress===1||file.progress>0&&file.progressive===true&&torrent.dlspeed>0&&
    !/paused|stopped|queued/i.test(torrent.state||'');
}

export function createEpisodesUI({api,escape,onAdd,onPlay,onRemember,isFollowed=()=>false,onToggleFollow,onRelatedFilm,
  getWatchHistory=()=>({}),getLibrary=()=>[]}){
  const $=selector=>document.querySelector(selector),dialog=$('#episodes-dialog');
  let currentItem=null,catalog=null,selectedSeason=null,selectedEpisode=null,job=null,sourceRows=[],timer=null,catalogGeneration=0,sourceGeneration=0,episodePage=1,excludeHash=null;
  const pageSize=24;
  const episodeLabel=episode=>episode.number===null||episode.number===undefined?episode.special?'Special':'Unnumbered episode':Number(episode.season)>=1900&&Number(episode.season)<=2100?`${episode.season} · E${String(episode.number).padStart(2,'0')}`:`S${String(episode.season??0).padStart(2,'0')}E${String(episode.number).padStart(2,'0')}`;
  const seasonLabel=number=>Number(number)===0?'Specials':Number(number)>=1900&&Number(number)<=2100?`${number} season`:`Season ${number}`;
  const count=(number,singular,plural=singular+'s')=>`${Number(number)||0} ${Number(number)===1?singular:plural}`;
  const bytes=value=>Number(value)>=1024**3?(Number(value)/1024**3).toFixed(1)+' GB':Number(value)>=1024**2?(Number(value)/1024**2).toFixed(0)+' MB':'Size unknown';
  const today=()=>{const date=new Date();return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;};
  const isAired=episode=>typeof episode.aired==='boolean'?episode.aired:Boolean(episode.airdate&&episode.airdate<=today());
  const canSearch=episode=>Boolean(episode.searchable&&episode.aired!==false&&(!episode.airdate||isAired(episode)));
  const sourcePanel=$('#episode-sources');
  const sourceList=$('#episode-source-list');
  const episodeList=$('#episodes-list');
  const localSourceChecks=new Map();
  let localSourceCheck=null;
  const followButton=$('#episodes-follow');
  const journeyPanel=document.createElement('section');
  const journeyStatus=document.createElement('p');
  journeyStatus.className='sr-only';
  journeyStatus.setAttribute('role','status');
  journeyPanel.className='episode-journey';
  journeyPanel.setAttribute('aria-labelledby','episode-journey-heading');
  journeyPanel.hidden=true;
  $('#episodes-summary').after(journeyPanel,journeyStatus);
  let journey=null,journeyCheck=null,orbitReturn=null,orbitHandoff=null;
  const orbitBack=document.createElement('button');
  orbitBack.type='button';
  orbitBack.className='text-button episode-orbit-back';
  orbitBack.hidden=true;
  $('#episodes-summary').before(orbitBack);
  const orbitHost=document.createElement('section');
  journeyStatus.after(orbitHost);
  const orbit=createStoryOrbit({
    host:orbitHost,api:(url,body,signal)=>api(url,body,false,signal),escape,
    onViewChange:view=>{dialog.dataset.orbitView=view;},
    onCanonical:openOriginalEpisode,onRelated:openRelated
  });
  const sourceHome=document.createComment('Episode watch options');
  sourcePanel.before(sourceHome);
  const sourcePrimary=document.createElement('div');
  const sourceOptions=document.createElement('details');
  const guide=document.createElement('details');
  const close=dialog.querySelector('[data-close="episodes-dialog"]');
  close.classList.add('cinema-dialog-close');
  close.innerHTML=closeIcon;
  dialog.querySelector('.dialog-heading .eyebrow').textContent='EPISODES';
  dialog.querySelector('.episode-sources .eyebrow').textContent='WATCH THIS EPISODE';
  const footer=dialog.querySelector('.episodes-footer');
  footer.querySelector('span')?.remove();
  guide.className='episode-guide';
  guide.innerHTML='<summary>About this episode guide</summary>';
  guide.append($('#episodes-warning'),$('#episodes-attribution'));
  footer.prepend(guide);
  guide.hidden=true;

  sourceList.before(sourcePrimary,sourceOptions);
  sourcePrimary.className='episode-watch-primary';
  sourceOptions.className='episode-watch-options';
  sourceOptions.innerHTML='<summary>Other watch options</summary>';
  sourceOptions.append(sourceList);
  sourceOptions.hidden=true;
  const sourceBack=document.createElement('button');
  sourceBack.type='button';
  sourceBack.className='text-button episode-watch-back';
  sourceBack.textContent='Close watch options';
  sourcePanel.append(sourceBack);
  sourceBack.addEventListener('click',()=>{
    const row=selectedEpisode&&document.getElementById('episode-'+selectedEpisode.id);
    const target=row?.querySelector('[data-episode-search]')||$('#episodes-season');
    void cancelSearch();
    selectedEpisode=null;
    sourceRows=[];
    sourcePanel.hidden=true;
    renderEpisodes();
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'nearest'});
  });

  function status(selector,message){if($(selector).textContent!==message)$(selector).textContent=message;}
  function scrollTo(element,block='start'){
    element.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block});
  }
  function renderJourney(){
    const next=journey?.next,watched=journey?.watchedCount||0,aired=journey?.airedCount||0;
    const checking=journeyCheck!==null;
    const message=checking?'Checking your library for this episode.':'';
    if(journeyStatus.textContent!==message)journeyStatus.textContent=message;
    journeyPanel.hidden=!next&&!watched;
    if(journeyPanel.hidden)return;
    const heading=next?{start:'Start the story',next:'Up next',resume:'Continue watching',earlier:'An earlier episode is unwatched'}[next.mode]:
      watched===aired?'You’re caught up':'Your progress';
    const label=next?.resume?'Resume episode':next?.mode==='next'?'Watch next episode':'Find watch options';
    updateHTML(journeyPanel,`<div class="episode-journey-copy">
      <p class="eyebrow">YOUR STORY MAP</p><h3 id="episode-journey-heading">${heading}</h3>
      ${next?`<p>${escape(episodeLabel(next.episode))} · ${escape(next.episode.title||'Episode')}</p>`:''}
      ${watched||next?.mode==='resume'?`<div class="episode-journey-meter"><progress value="${watched}" max="${aired}" aria-label="Aired episodes watched"></progress><span>${watched} of ${aired} aired episodes watched</span></div>`:''}
    </div>${next?`<button type="button" class="primary title-watch-button" data-episode-journey="${escape(next.episode.id)}" aria-disabled="${checking}" ${next.resume?'':'aria-controls="episode-sources"'}>${playIcon}${checking?'Checking your library…':label}</button>`:''}`);
  }
  function refreshJourney(removedHash){
    journey=buildEpisodeJourney(catalog,getWatchHistory(),getLibrary().filter(torrent=>torrent.hash!==removedHash&&torrent.hash!==excludeHash));
    renderJourney();
  }
  function renderFollow(){
    const show=catalog?.show;
    followButton.hidden=!onToggleFollow||!/^tvmaze-[1-9]\d{0,7}$/.test(show?.id||'');
    if(followButton.hidden)return;
    const following=isFollowed(show.id);
    followButton.setAttribute('aria-pressed',String(following));
    followButton.querySelector('span').textContent=following?'Following':'Follow';
  }
  function renderCatalog(){
    if(!catalog)return;const show=catalog.show||{};
    $('#episodes-title').textContent=show.title||currentItem?.title||'Episodes & seasons';
    renderFollow();
    const poster=currentItem?.posterUrl?.startsWith('/api/metadata/poster?')?`<img src="${escape(currentItem.posterUrl)}" alt="" width="86" height="122" decoding="async">`:'';
    const backdrop=currentItem?.backdropUrl?.startsWith('/api/metadata/poster?')?
      `<div class="episode-summary-art" aria-hidden="true"><img src="${escape(currentItem.backdropUrl)}" alt="" decoding="async"></div>`:'';
    const facts=[show.year,show.kind==='anime'?'Anime':'Series',catalog.totalSeasons&&count(catalog.totalSeasons,'season'),catalog.totalEpisodes&&count(catalog.totalEpisodes,'episode')].filter(Boolean).join(' · ');
    updateHTML($('#episodes-summary'),`${backdrop}${poster?`<div class="episodes-poster">${poster}</div>`:''}<div>
      <p class="episode-series-facts">${escape(facts)}</p>
      ${currentItem.overview?`<p class="episode-series-note">${escape(currentItem.overview)}</p>`:''}
    </div>`);
    const warnings=[catalog.countNote,...(catalog.warnings||[]).map(value=>typeof value==='string'?value:value.message)].filter(Boolean);$('#episodes-warning').hidden=!warnings.length;$('#episodes-warning').textContent=warnings.join(' · ');
    const seasons=catalog.seasons||[];
    if(!seasons.some(season=>Number(season.number)===Number(selectedSeason)))selectedSeason=seasons.find(season=>Number(season.number)>0)?.number??seasons[0]?.number??null;
    $('#episodes-toolbar').hidden=!seasons.length;
    const options=seasons.map(season=>`<option value="${Number(season.number)}">${escape(seasonLabel(season.number))} · ${count(season.totalEpisodes,'episode')}</option>`).join('');
    updateHTML($('#episodes-season'),options);if(selectedSeason!==null)$('#episodes-season').value=String(selectedSeason);
    const source=show.sourceUrl;$('#episodes-attribution').hidden=!(typeof source==='string'&&source.startsWith('https://www.tvmaze.com/'));if(!$('#episodes-attribution').hidden)$('#episodes-attribution').href=source;
    guide.hidden=!warnings.length&&$('#episodes-attribution').hidden;
    refreshJourney();
    renderEpisodes();
    orbit.reset(show.id);
  }
  function renderEpisodes(){
    if(!catalog)return;const filter=$('#episodes-filter').value.trim().toLowerCase(),airedOnly=$('#episodes-aired-only').checked;
    let episodes=(catalog.episodes||[]).filter(episode=>Number(episode.season)===Number(selectedSeason));
    const total=episodes.length;episodes=episodes.filter(episode=>(!airedOnly||isAired(episode))&&(!filter||(`${episodeLabel(episode)} ${episode.number??''} ${episode.title||''}`).toLowerCase().includes(filter)));
    const filteredTotal=episodes.length,totalPages=Math.max(1,Math.ceil(filteredTotal/pageSize));episodePage=Math.min(totalPages,Math.max(1,episodePage));
    const first=filteredTotal?(episodePage-1)*pageSize+1:0,last=Math.min(filteredTotal,episodePage*pageSize),shown=episodes.slice((episodePage-1)*pageSize,episodePage*pageSize);
    status('#episodes-status',filteredTotal>pageSize?`${first}–${last} of ${count(filteredTotal,'episode')}`:
      count(filteredTotal,'episode')+(filteredTotal!==total?' shown':''));
    $('#episodes-pagination').hidden=filteredTotal<=pageSize;$('#episodes-page-label').textContent=`Page ${episodePage} of ${totalPages}`;$('#episodes-page-previous').disabled=episodePage===1;$('#episodes-page-next').disabled=episodePage===totalPages;
    const placedId=!sourcePanel.hidden&&shown.some(episode=>episode.id===selectedEpisode?.id)?selectedEpisode.id:null;
    if(!placedId&&episodeList.contains(sourcePanel))sourceHome.after(sourcePanel);
    const entries=shown.map(episode=>{
      const label=episodeLabel(episode),selected=selectedEpisode?.id===episode.id,searchable=canSearch(episode);
      const waiting=selected&&['queued','searching'].includes(job?.status);
      const date=episode.airdate&&/^\d{4}-\d{2}-\d{2}$/.test(episode.airdate)?
        new Date(episode.airdate+'T12:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'';
      const upcoming=episode.aired===false||episode.airdate&&!isAired(episode);
      const meta=[episode.runtime?episode.runtime+' min':'',episode.special?'Special':'',upcoming?(date?'Coming '+date:'Coming soon'):''].filter(Boolean).join(' · ');
      const title=episode.title||'Episode '+(episode.number??'');
      const watchState=journey?.episodeStates.get(episode.id);
      const handoff=orbitHandoff?.id===episode.id?orbitHandoff:null;
      const html=`<div class="episode-list-item"><article class="episode-row" id="episode-${escape(episode.id)}">
        <div class="episode-number" aria-hidden="true">${escape(episode.number==null?'—':String(episode.number).padStart(2,'0'))}</div>
        <div class="episode-description"><div class="episode-row-title"><h3>${escape(title)}</h3>${watchState?`<span class="episode-watch-state" data-watch-state="${watchState}">${watchState==='watched'?'Watched':'In progress'}</span>`:''}</div>
          ${meta?`<p class="episode-card-facts">${escape(meta)}</p>`:''}
          ${handoff?`<p id="episode-orbit-note" class="episode-orbit-note">${escape(handoff.text)}</p>`:''}
          ${episode.overview?`<p class="episode-card-overview">${escape(episode.overview)}</p>`:''}
          ${!searchable&&!upcoming?`<small>${episode.number==null?'Search by title to find this special.':'This episode is unavailable.'}</small>`:''}
        </div>${searchable?`<button type="button" class="subtle episode-watch-action" data-episode-search="${escape(episode.id)}" aria-label="Watch options for ${escape(label+' '+title)}" ${handoff?'aria-describedby="episode-orbit-note"':''} aria-controls="episode-sources"><span class="episode-watch-label">Watch</span>${forwardIcon}</button>`:''}
      </article></div>`;
      return {key:episode.id,signature:html,html:()=>html,value:`${selected}:${waiting}:${placedId===episode.id}`,patch(element){
        const row=element.firstElementChild,button=row.querySelector('[data-episode-search]');
        row.classList.toggle('selected',selected);
        if(!button)return;
        button.disabled=waiting;
        button.setAttribute('aria-expanded',String(placedId===episode.id));
        button.querySelector('.episode-watch-label').textContent=waiting?'Looking…':selected?'Watch options':'Watch';
      }};
    });
    updateKeyedList(episodeList,entries);
    if(!entries.length)updateHTML(episodeList,'<div class="empty"><h3>No episodes match these filters</h3><p>Try another season or clear the episode filter.</p></div>');
    if(placedId){
      const row=document.getElementById('episode-'+placedId);
      if(row&&row.nextElementSibling!==sourcePanel)row.after(sourcePanel);
    }
  }
  async function cancelSearch({announce=false}={}){
    const generation=++sourceGeneration;clearTimeout(timer);const previous=job;job=null;
    localSourceCheck?.abort();
    localSourceCheck=null;
    if(!announce)localSourceChecks.clear();
    if(journeyCheck!==null){journeyCheck=null;renderJourney();}
    if(previous?.id&&['queued','searching'].includes(previous.status))await api('/api/episodes/search/cancel',{id:previous.id}).catch(()=>{});
    if(announce&&dialog.open&&generation===sourceGeneration){job={...previous,status:'cancelled'};renderSources();}
  }
  const sourceKey=source=>String(source.key||source.existingHash||'');
  const localTorrent=hash=>getLibrary().find(torrent=>torrent.hash===hash);
  function verifiedLocalSource(source){
    const hash=source.existingHash,target=localSourceChecks.get(hash);
    return suitableLocalEpisode(localTorrent(hash),target)?target:null;
  }
  function checkLocalSources(){
    if(localSourceCheck||localSourceChecks.size>=3||!selectedEpisode||!catalog||!dialog.open)return;
    const source=sourceRows.find(row=>row.existingHash&&!localSourceChecks.has(row.existingHash)&&localTorrent(row.existingHash));
    if(!source)return;
    const hash=source.existingHash,generation=sourceGeneration;
    const controller=localSourceCheck=new AbortController();
    localSourceChecks.set(hash,null);
    void findVerifiedLocalEpisode(api,{hash,showId:catalog.show.id,episodeId:selectedEpisode.id,signal:controller.signal}).then(target=>{
      if(localSourceCheck!==controller||generation!==sourceGeneration||!dialog.open)return;
      localSourceCheck=null;
      if(target)localSourceChecks.set(hash,target);
      renderSources();
    });
  }
  function renderSources(){
    const phase=job?.status||'searching',waiting=['queued','searching'].includes(phase);
    const focusedSource=sourcePanel.contains(document.activeElement)&&document.activeElement.closest('[data-episode-source]');
    sourcePanel.hidden=false;
    $('#episode-sources-title').textContent=selectedEpisode?`${episodeLabel(selectedEpisode)} · ${selectedEpisode.title||'Episode'}`:'Watch this episode';
    $('#episode-cancel-search').hidden=!waiting;
    $('#episode-retry-search').textContent='Search again';
    sourceRows=(job?.sources||[]).filter(source=>sourceKey(source)&&(!excludeHash||source.existingHash!==excludeHash));
    const best=bestEpisodePlaybackSource(sourceRows,verifiedLocalSource);
    const lead=best||sourceRows[0];
    const alternatives=sourceRows.filter(source=>source!==lead);
    const incomplete=job?.coverage?.incomplete;
    let message;
    if(waiting)message=best?'A match is available while Cinema checks more sources.':
      sourceRows.length?'Some sources need a closer look. Checking for a stronger match…':
      job?.message||'Looking for a way to watch…';
    else if(phase==='cancelled')message=sourceRows.length?'Search stopped. Matches already found are still available.':'Search cancelled.';
    else if(phase==='error')message=job?.message||'The search couldn’t finish. Search again.';
    else if(best)message=best.existingHash?'A matching episode is available in your library.':
      'Best available match found. Cinema checks the episode file before playback.';
    else if(sourceRows.length)message='No source is ready to recommend. You can try a listed source.';
    else if(phase==='ready'&&excludeHash)message='No other release matched this episode.';
    else message='No matching source found for this episode.';
    if(!waiting&&incomplete&&phase!=='error'&&phase!=='cancelled')message+=' '+(job?.message||'Some source checks couldn’t finish.');
    status('#episode-source-status',message);
    $('#episode-retry-search').hidden=waiting||Boolean(best&&!incomplete&&phase==='ready');
    sourceOptions.hidden=!alternatives.length;
    sourceOptions.querySelector('summary').textContent=alternatives.length?'Other watch options ('+alternatives.length+')':'Other watch options';
    if(sourceOptions.hidden)sourceOptions.open=false;
    const openDetails=[...sourcePanel.querySelectorAll('.watch-release-info[open]')].map(element=>element.id);
    updateHTML(sourcePrimary,lead?renderRelease(lead,lead===best):waiting?
      '<div class="episode-source-loading" aria-hidden="true"><span class="spinner"></span><p>Finding this episode</p></div>':'');
    updateHTML(sourceList,alternatives.map(source=>renderRelease(source,false)).join(''));
    for(const id of openDetails){const detail=document.getElementById(id);if(detail)detail.open=true;}
    renderEpisodes();
    if(focusedSource&&!focusedSource.isConnected&&!sourcePanel.contains(document.activeElement))
      $('#episode-sources-title').focus({preventScroll:true});
    if(phase!=='cancelled')checkLocalSources();
  }
  function renderRelease(source,primary){
    const intent=source.intent||job?.intent,existing=source.existingHash;
    const pack=source.matchType||intent?.sourceType;
    const includesOthers=pack==='series-pack'?'Includes other seasons.':
      ['season-pack','multi-episode'].includes(pack)?'Includes other episodes.':'';
    const label=existing?'In your library':primary?'Recommended source':'Alternative source';
    const seeders=reportedPeers(source.nbSeeders),leechers=reportedPeers(source.nbLeechers);
    const facts=[seeders===null?'Seeders unknown':seeders===0?'No seeders reported':count(seeders,'seeder'),
      leechers===null?'Leechers unknown':count(leechers,'leecher'),bytes(source.fileSize)].join(' · ');
    const details=[source.engineName,existing?null:source.streaming?.label].filter(Boolean).join(' · ');
    const key=sourceKey(source),detailId=escape(key.replace(/[^a-z0-9_-]/gi,'_'));
    const playable=existing?verifiedLocalSource(source):seeders>0;
    const action=primary?'Play best source':playable?'Play episode':'Try source';
    return `<article class="watch-release"><div class="watch-release-copy">
      <strong>${label}</strong>${source.streaming?.resolution?`<span class="watch-quality">${escape(source.streaming.resolution)}</span>`:''}
      <p class="watch-release-note">${escape(facts)}</p>
      ${includesOthers?`<p class="watch-release-note">${includesOthers}</p>`:''}
      <details class="watch-release-info" id="episode-release-${detailId}"><summary>Release details</summary>
        <p>${escape(source.fileName||'Episode release')}</p>${details?`<p>${escape(details)}</p>`:''}
        ${source.sourceNote?`<p>${escape(source.sourceNote)}</p>`:''}
      </details>
    </div><button type="button" class="${primary?'primary':'subtle'} title-watch-button" data-episode-source="${escape(key)}"
      data-episode-source-visit="${sourceGeneration}" data-episode-existing="${escape(existing||'')}" ${intent?'':'disabled'}>${playIcon}${action}</button></article>`;
  }
  async function pollSources(generation){
    if(generation!==sourceGeneration||!job?.id||!dialog.open)return;
    try{const next=await api('/api/episodes/search?id='+encodeURIComponent(job.id));if(generation!==sourceGeneration||!dialog.open)return;job=next;renderSources();if(['queued','searching'].includes(job.status))timer=setTimeout(()=>pollSources(generation),1800);}
    catch(error){if(generation!==sourceGeneration||!dialog.open)return;job={...job,status:'error',message:error.message};renderSources();}
  }
  async function findSources(id){
    const episode=catalog?.episodes?.find(item=>item.id===id);if(!episode||!canSearch(episode))return;
    orbit.showOriginal();
    dialog.removeAttribute('data-orbit-handoff');
    const cancellation=cancelSearch(),generation=sourceGeneration;
    selectedEpisode=episode;sourceRows=[];job={status:'searching',sources:[],message:'Checking installed plugins for this episode…'};
    sourceOptions.open=false;
    renderSources();$('#episode-sources-title').focus({preventScroll:true});scrollTo(sourcePanel,'nearest');
    await cancellation;
    if(generation!==sourceGeneration||!dialog.open)return;
    try{const next=await api('/api/episodes/search',{showId:catalog.show.id,episodeId:episode.id});if(generation!==sourceGeneration||!dialog.open){if(next.id)api('/api/episodes/search/cancel',{id:next.id}).catch(()=>{});return;}job=next;renderSources();if(['queued','searching'].includes(job.status))timer=setTimeout(()=>pollSources(generation),1200);}
    catch(error){if(generation!==sourceGeneration||!dialog.open)return;job={status:'error',sources:[],message:error.message};renderSources();}
  }
  function showEpisodePage(episode){
    selectedSeason=episode.season;
    $('#episodes-season').value=String(selectedSeason);
    $('#episodes-filter').value='';
    if(!isAired(episode))$('#episodes-aired-only').checked=false;
    const season=catalog.episodes.filter(item=>item.season===selectedSeason&&(!$('#episodes-aired-only').checked||isAired(item)));
    episodePage=Math.floor(season.findIndex(item=>item.id===episode.id)/pageSize)+1;
  }
  function focusOriginalEpisode(episode){
    const row=document.getElementById('episode-'+episode.id);
    if(!row)return;
    row.tabIndex=-1;
    row.focus({preventScroll:true});
    scrollTo(row,'nearest');
  }
  function openOriginalEpisode(id,{orderLabel,alternateLabel}){
    const episode=catalog?.episodes?.find(row=>row.id===id);
    if(!dialog.open||!episode)return false;
    const select=$('#episodes-season');
    if(!Array.from(select.options).some(option=>option.value===String(episode.season))){
      select.add(new Option(seasonLabel(episode.season),String(episode.season)));
      $('#episodes-toolbar').hidden=false;
    }
    orbitHandoff={id,text:`${orderLabel} ${alternateLabel} → Original ${episodeLabel(episode)}. Release numbering can differ. Check that the release names this episode.`};
    dialog.setAttribute('data-orbit-handoff','');
    orbit.showOriginal();
    showEpisodePage(episode);
    renderEpisodes();
    focusOriginalEpisode(episode);
    return true;
  }
  function clearOrbitHandoff(){
    orbitHandoff=null;
    dialog.removeAttribute('data-orbit-handoff');
  }
  function updateOrbitBack(){
    orbitBack.hidden=!orbitReturn;
    orbitBack.textContent=orbitReturn?'← Back to '+orbitReturn.title:'';
  }
  function focusGuide(){
    const heading=$('#episodes-title');
    heading.tabIndex=-1;
    heading.focus({preventScroll:true});
  }
  function openRelated(item){
    if(!dialog.open||!item?.title)return;
    if(item.kind==='movies'){
      dialog.close();
      onRelatedFilm?.({...item,isSeries:false});
      return;
    }
    if(item.kind!=='tv'||!/^tvmaze-[1-9]\d{0,7}$/.test(item.id))return;
    orbitReturn={item:currentItem,title:catalog?.show?.title||currentItem.title,excludeHash,view:orbit.getState(),relatedId:item.id,
      season:selectedSeason,page:episodePage,filter:$('#episodes-filter').value,
      aired:$('#episodes-aired-only').checked,scroll:dialog.scrollTop};
    void open({...item,isSeries:true},{orbitNavigation:true});
    focusGuide();
  }
  orbitBack.addEventListener('click',async()=>{
    const previous=orbitReturn;
    if(!previous)return;
    orbitReturn=null;
    const opening=open(previous.item,{excludeHash:previous.excludeHash,orbitNavigation:true});
    const generation=catalogGeneration;
    focusGuide();
    await opening;
    if(generation!==catalogGeneration||!dialog.open||!catalog)return;
    if(catalog.seasons?.some(season=>Number(season.number)===Number(previous.season))){
      selectedSeason=previous.season;
      $('#episodes-season').value=String(selectedSeason);
    }
    episodePage=previous.page;
    $('#episodes-filter').value=previous.filter;
    $('#episodes-aired-only').checked=previous.aired;
    renderEpisodes();
    const restored=await orbit.restore(previous.view,{focusRelatedId:previous.relatedId});
    if(restored===undefined||generation!==catalogGeneration||!dialog.open)return;
    dialog.scrollTop=previous.scroll;
    if(!restored)focusGuide();
  });
  function playLibraryEpisode(hash,intent,index){
    onRemember?.(currentItem);
    dialog.close();
    void onPlay(hash,intent,index);
  }
  async function followJourney(episodeId,{requireSuitable=false}={}){
    if(journeyCheck!==null||!dialog.open)return;
    refreshJourney();
    const next=journey.next;
    if(next?.episode.id!==episodeId)return;
    orbit.showOriginal();
    clearOrbitHandoff();
    const localHash=next.resume?.hash||next.packHash;
    if(localHash){
      const cancellation=cancelSearch(),generation=sourceGeneration;
      journeyCheck=generation;
      selectedEpisode=null;
      sourcePanel.hidden=true;
      renderJourney();
      renderEpisodes();
      const target=await findVerifiedLocalEpisode(api,{hash:localHash,showId:catalog.show.id,episodeId,expectedIndex:next.resume?.index});
      if(journeyCheck!==generation||!dialog.open)return;
      const torrent=localTorrent(localHash);
      if(target&&torrent&&(!requireSuitable||suitableLocalEpisode(torrent,target))){
        playLibraryEpisode(localHash,target.intent,target.index);
        return;
      }
      await cancellation;
      if(journeyCheck!==generation||!dialog.open)return;
    }
    showEpisodePage(next.episode);
    await findSources(next.episode.id);
  }
  async function loadCatalog(){
    const item=currentItem,generation=++catalogGeneration;catalog=null;clearOrbitHandoff();orbit.reset(null);renderFollow();journey=null;journeyPanel.hidden=true;selectedSeason=null;selectedEpisode=null;episodePage=1;$('#episodes-toolbar').hidden=true;$('#episodes-pagination').hidden=true;sourcePanel.hidden=true;$('#episodes-warning').hidden=true;$('#episodes-retry-catalog').hidden=true;$('#episodes-attribution').hidden=true;guide.hidden=true;guide.open=false;$('#episodes-summary').replaceChildren();episodeList.innerHTML='<div class="episode-source-loading" aria-hidden="true"><span class="spinner"></span><p>Loading episodes</p></div>';episodeList.setAttribute('aria-busy','true');status('#episodes-status','Loading episodes…');
    try{const result=await api('/api/episodes/catalog',{id:item.metadataId||item.id,title:item.seriesTitle||item.title,year:item.year,kind:item.kind,aliases:item.aliases,alternateTitle:item.alternateTitle});if(generation!==catalogGeneration||!dialog.open)return;catalog=result;const seasonHint=Number(item.season)||Number(/\bSeason\s+(\d{1,3})\b/i.exec(item.title)?.[1]||/\b(\d{1,3})(?:st|nd|rd|th)\s+Season\b/i.exec(item.title)?.[1]);if(seasonHint>0&&catalog.seasons?.some(season=>Number(season.number)===seasonHint))selectedSeason=seasonHint;renderCatalog();if(!(catalog.episodes||[]).length){status('#episodes-status','No episode list is available for this title.');$('#episodes-list').innerHTML='<div class="empty"><h3>No episode list found</h3><p>This may be a film, a different title match, or a show the catalog has not listed yet. You can still use a title search.</p></div>';$('#episodes-retry-catalog').hidden=false;}}
    catch(error){if(generation!==catalogGeneration||!dialog.open)return;status('#episodes-status','We couldn’t load these episodes.');$('#episodes-list').innerHTML='<div class="empty"><p>Try loading the episode guide again.</p></div>';$('#episodes-warning').textContent=error.message;$('#episodes-warning').hidden=false;guide.hidden=false;$('#episodes-retry-catalog').hidden=false;}
    finally{if(generation===catalogGeneration)$('#episodes-list').setAttribute('aria-busy','false');}
  }
  async function open(item,{episodeId=null,excludeHash:currentHash=null,search=true,orbitNavigation=false,startWatching=false}={}){
    if(!orbitNavigation)orbitReturn=null;
    updateOrbitBack();
    if(!item?.title)return;void cancelSearch();currentItem=item;excludeHash=currentHash;$('#episodes-title').textContent=item.title;$('#episodes-filter').value='';$('#episodes-aired-only').checked=false;
    if($('#title-detail-dialog')?.open)$('#title-detail-dialog').close();if(!dialog.open)dialog.showModal();dialog.scrollTop=0;
    const loading=loadCatalog(),generation=catalogGeneration;
    await loading;
    if(generation!==catalogGeneration||!dialog.open)return;
    if(episodeId){
      const target=catalog?.episodes?.find(episode=>episode.id===episodeId);
      if(target){
        showEpisodePage(target);
        if(search)await findSources(episodeId);
        else{
          renderEpisodes();
          focusOriginalEpisode(target);
        }
      }else if(!search&&catalog)status('#episodes-status','This episode is no longer listed. The current guide is below.');
    }else if(startWatching&&search&&journey?.next){
      await followJourney(journey.next.episode.id,{requireSuitable:true});
    }
  }
  followButton.addEventListener('click',()=>{
    if(followButton.hidden||!catalog?.show)return;
    const result=onToggleFollow(catalog.show,currentItem);
    renderFollow();
    status('#episodes-status',result?.ok?(isFollowed(catalog.show.id)?'Following in This Week.':'Removed from This Week.'):
      result?.message||'Cinema couldn’t save this change.');
  });
  journeyPanel.addEventListener('click',event=>{
    const button=event.target.closest('[data-episode-journey]');
    if(button)void followJourney(button.dataset.episodeJourney);
  });
  $('#episodes-season').addEventListener('change',()=>{clearOrbitHandoff();void cancelSearch();selectedEpisode=null;sourceRows=[];$('#episode-sources').hidden=true;selectedSeason=Number($('#episodes-season').value);episodePage=1;$('#episodes-filter').value='';renderEpisodes();});
  $('#episodes-filter').addEventListener('input',()=>{episodePage=1;renderEpisodes();});$('#episodes-aired-only').addEventListener('change',()=>{episodePage=1;renderEpisodes();});
  $('#episodes-page-previous').addEventListener('click',()=>{episodePage--;renderEpisodes();scrollTo(episodeList);});
  $('#episodes-page-next').addEventListener('click',()=>{episodePage++;renderEpisodes();scrollTo(episodeList);});
  episodeList.addEventListener('click',event=>{
    const button=event.target.closest('[data-episode-search]');
    if(!button||button.disabled)return;
    dialog.removeAttribute('data-orbit-handoff');
    if(selectedEpisode?.id===button.dataset.episodeSearch&&!sourcePanel.hidden){
      $('#episode-sources-title').focus({preventScroll:true});
      scrollTo(sourcePanel,'nearest');
      return;
    }
    void findSources(button.dataset.episodeSearch);
  });
  $('#episode-cancel-search').addEventListener('click',()=>void cancelSearch({announce:true}));$('#episode-retry-search').addEventListener('click',()=>{if(selectedEpisode)void findSources(selectedEpisode.id);});
  $('#episodes-retry-catalog').addEventListener('click',()=>void loadCatalog());
  sourcePanel.addEventListener('click',event=>{
    const button=event.target.closest('[data-episode-source]');
    if(!button||button.disabled||!dialog.open||sourcePanel.hidden||
      button.dataset.episodeSourceVisit!==String(sourceGeneration))return;
    const source=sourceRows.find(row=>sourceKey(row)===button.dataset.episodeSource);
    const intent=source?.intent||job?.intent;
    if(!source||!intent||!selectedEpisode||intent.episodeId!==selectedEpisode.id||intent.showId!==catalog?.show?.id||
      (source.existingHash||'')!==button.dataset.episodeExisting)return;
    button.disabled=true;
    if(source.existingHash)playLibraryEpisode(source.existingHash,intent,verifiedLocalSource(source)?.index??null);
    else{
      onRemember?.(currentItem);
      dialog.close();
      void onAdd(source.key,intent.kind||currentItem.kind,intent);
    }
  });
  dialog.addEventListener('close',()=>{catalogGeneration++;orbit.cancel();orbitReturn=null;void cancelSearch();});
  return {open,invalidateHash(hash){
    for(const source of sourceRows)if(source.existingHash===hash)delete source.existingHash;
    if(dialog.open&&catalog){refreshJourney(hash);if(selectedEpisode)renderSources();else renderEpisodes();}
  },close(){dialog.close();},getSelectedEpisode(){return selectedEpisode;}};
}

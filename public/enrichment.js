import {createSceneFinder} from './scene-finder.js';
import {watchedCueDigest} from './watched-captions.js';

// Metadata is decorative: a lookup never adds a source or changes a download.
export function createEnrichment({api, clean, escape, onChange, getActive, getLibrary, onEpisodes,
  canSeekScene,seekScene,canPreviewScene,previewScene,previewAttachmentKey,formatSceneTime,onSceneTrackChange,onCaptionChange,onWatchedCaptionReady}) {
  const $ = selector => document.querySelector(selector);
  let matches=[], selected=null, lookupGeneration=0, subtitleGeneration=0, subtitleSelection=0, trackElement=null;
  let saved={}, subtitleHistory={};
  try { saved=JSON.parse(localStorage.getItem('cinema-title-info')||'{}'); } catch {}
  try { subtitleHistory=JSON.parse(localStorage.getItem('cinema-subtitles')||'{}'); } catch {}
  if(!saved||Array.isArray(saved)||typeof saved!=='object')saved={};
  if(!subtitleHistory||Array.isArray(subtitleHistory)||typeof subtitleHistory!=='object')subtitleHistory={};
  const withoutReleaseYear=name=>{const value=String(name),match=[...value.matchAll(/\b(?:19|20)\d{2}\b/g)].find(m=>m.index>1);return match?value.slice(0,match.index).trim():value;};
  const key=name=>withoutReleaseYear(clean(name).replace(/^\[[^\]]+\]\s*/,'').replace(/\b(?:S\d{1,2}(?:E\d{1,3})?|Season\s*\d+|Complete)\b.*$/i,'')).replace(/[^\p{L}\p{N}]+/gu,' ').trim().toLowerCase();
  const storage=(name,data)=>{try{localStorage.setItem(name,JSON.stringify(data));}catch{}};
  const safePoster=m=>m?.posterUrl?.startsWith('/api/metadata/poster?')?m.posterUrl:null;
  const safeBackdrop=m=>m?.backdropUrl?.startsWith('/api/metadata/poster?')?m.backdropUrl:null;
  const safeLink=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return '';}};
  const isSeries=m=>typeof m.isSeries==='boolean'?m.isSeries:m.kind==='tv'||m.kind==='korean'||String(m.id).startsWith('tvmaze-')||m.kind==='anime'&&m.mediaType!=='movie'&&!/\bfilm\b/i.test(String(m.overview||'').slice(0,250));
  const index=new Map(),lookupCache=new Map();
  function indexSaved(){
    index.clear();lookupCache.clear();
    for(const item of Object.values(saved)){
      if(!item?.title)continue;
      const title=key(item.title);
      if(!index.has(title))index.set(title,new Map());
      index.get(title).set(String(item.year||''),item);
    }
  }
  indexSaved();
  function metadata(name){
    if(lookupCache.has(name))return lookupCache.get(name);
    const title=key(name),year=[...String(name).matchAll(/\b(?:19|20)\d{2}\b/g)].find(m=>m.index>1)?.[0];
    const matches=index.get(title);
    const item=(year?matches?.get(year):matches?.values().next().value)||
      (selected&&key(selected.title)===title&&(!year||String(selected.year)===year)?selected:null);
    if(lookupCache.size>=1200)lookupCache.delete(lookupCache.keys().next().value);
    lookupCache.set(name,item);
    return item;
  }
  function rememberMany(items){
    if(!items.length)return;
    for(const item of items)if(item?.title)saved[`${key(item.title)}:${item.year||''}`]=item;
    saved=Object.fromEntries(Object.entries(saved).slice(-150));
    indexSaved();storage('cinema-title-info',saved);onChange();
  }
  function remember(item){if(item)rememberMany([item]);}
  function cancelCatalog(){lookupGeneration++;selected=null;matches=[];lookupCache.clear();}
  function poster(name) {const m=metadata(name),src=safePoster(m);return src?`<img class="title-poster" src="${escape(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:'';}
  function info(m) {return [m.year,m.kind==='anime'?'Anime':isSeries(m)?'Series':m.kind==='movies'?'Film':'',...(m.genres||[]).slice(0,2),m.runtime?`${m.runtime} min`:''].filter(Boolean).map(escape).join(' · ');}
  function renderCatalog() {
    const host=$('#title-catalog');
    host.setAttribute('aria-busy','false');
    host.classList.remove('is-catalog-loading');
    if(!selected){host.hidden=true;host.replaceChildren();return;}
    const m=selected,poster=safePoster(m),backdrop=safeBackdrop(m),link=safeLink(m.sourceUrl);
    const changingMatch=document.activeElement?.id==='metadata-match';
    const alternate=matches.length>1?
      `<label>Choose the title you meant<select id="metadata-match">${matches.map((x,i)=>`<option value="${i}" ${x.id===m.id?'selected':''}>${escape(x.title)}${x.year?' · '+escape(x.year):''}</option>`).join('')}</select></label>`:'';
    host.hidden=false;
    host.innerHTML=`
      <div class="catalog-backdrop" aria-hidden="true">${backdrop?`<img src="${escape(backdrop)}" alt="" decoding="async">`:''}</div>
      ${poster?`<div class="catalog-poster"><img src="${escape(poster)}" alt="" width="160" height="240" decoding="async"></div>`:''}
      <div class="catalog-copy">
        <p class="catalog-kicker">${Number(m.confidence)>=.8?'Title spotlight':'Possible match'}</p>
        <h3>${escape(m.title)}</h3>
        <p class="catalog-facts">${info(m)}</p>
        ${m.overview?`<p class="catalog-overview">${escape(m.overview)}</p>`:''}
        <div class="catalog-bottom">
          ${onEpisodes&&isSeries(m)?'<button class="primary catalog-episodes" data-catalog-episodes type="button">Browse episodes</button>':''}
          ${alternate||link?`<details class="catalog-match-details"${changingMatch?' open':''}><summary>${alternate?'Other title matches':'About this title'}</summary><div class="catalog-match-body">
            ${alternate}${link?`<a href="${escape(link)}" target="_blank" rel="noopener noreferrer">Title information from ${escape(m.source||'public catalog')}</a>`:''}
          </div></details>`:''}
        </div>
      </div>`;
    const art=host.querySelector('.catalog-backdrop img');
    if(art){
      const reveal=()=>{if(art.isConnected&&art.naturalWidth)art.classList.add('is-ready');};
      if(art.complete)reveal();
      else art.addEventListener('load',reveal,{once:true});
    }
    if(changingMatch)$('#metadata-match')?.focus({preventScroll:true});
  }
  async function searchCatalog(query,kind) {
    cancelCatalog();const generation=lookupGeneration,host=$('#title-catalog');
    host.hidden=!['all','movies','tv','anime'].includes(kind);if(host.hidden)return;
    host.classList.add('is-catalog-loading');
    host.setAttribute('aria-busy','true');
    host.innerHTML='<div class="catalog-skeleton" aria-hidden="true"><i></i><span><b></b><b></b><b></b></span></div>';
    $('#metadata-note').textContent='';
    try{const result=await api('/api/metadata/search',{query,kind});if(generation!==lookupGeneration)return;
      matches=result.matches||[];selected=matches[0]||null;lookupCache.clear();
      // Keep exact/high-confidence matches for collection cards, including after restart.
      rememberMany(matches.filter(m=>Number(m.confidence)>=.8));
      if(!matches.some(m=>Number(m.confidence)>=.8))onChange();
      renderCatalog();
    }catch{if(generation===lookupGeneration)renderCatalog();}
  }
  $('#title-catalog').addEventListener('change',e=>{if(e.target.id!=='metadata-match')return;selected=matches[Number(e.target.value)];remember(selected);renderCatalog();});
  $('#title-catalog').addEventListener('click',e=>{if(!e.target.closest('[data-catalog-episodes]')||!selected)return;remember(selected);if($('#title-detail-dialog')?.open)$('#title-detail-dialog').close();onEpisodes?.(selected);});
  document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement&&e.target.closest('.catalog-poster,.cover,.discovery-art,.detail-poster,.episodes-poster,.continue-art,.result-thumb'))e.target.hidden=true;},true);

  const currentKey=()=>{const a=getActive();return Number.isInteger(a?.index)?`${a.hash}:${a.index}`:null;};
  let currentTrack=null, originalCues=[],stopReplayCaption=null,watchedDigest=null;
  const noDialogue=Object.freeze([]);
  let sceneRevision=0,sceneSnapshot=noDialogue,scenePhase='empty',sceneSource=null,sceneContext=null,sceneOffset=0;
  const sceneCues=()=>sceneSource===currentKey()?sceneSnapshot:noDialogue;
  const sceneTrackIdentity=()=>sceneRevision;
  function savedRescueSubtitle(hash,index){
    const record=subtitleHistory[`${hash}:${index}`];
    return /^[a-f0-9]{32}$/.test(record?.id||'')?
      {id:record.id,offset:Number.isFinite(record.offset)?record.offset:0}:null;
  }
  function watchedCaption(){
    if(scenePhase!=='ready'||sceneSource!==currentKey()||!trackElement||!/^[a-f0-9]{32}$/.test(currentTrack?.id||''))return null;
    const revision=sceneRevision,element=trackElement;
    if(watchedDigest?.revision!==revision){
      const entry=watchedDigest={revision,digest:null};
      const tuples=originalCues.length<=64000?originalCues.map(([,start,end,text])=>[Math.round(start*1000),Math.round(end*1000),text]):null;
      if(tuples)void watchedCueDigest(tuples).then(digest=>{
        if(watchedDigest!==entry||element!==trackElement||revision!==sceneRevision)return;
        entry.digest=digest;
        onWatchedCaptionReady?.();
      }).catch(()=>{});
    }
    return {id:currentTrack.id,digest:watchedDigest.digest,offsetMs:Math.round(sceneOffset*1000),
      showing:element.track.mode==='showing',revision};
  }
  function savedCalendarCaption(hash,index){
    const record=subtitleHistory[`${hash}:${index}`];
    return /^[a-f0-9]{32}$/.test(record?.id||'')?{id:record.id,origin:record.origin}:null;
  }
  function sceneEditionTrack(){
    if(scenePhase!=='ready'||sceneSource!==currentKey()||!sceneSnapshot.length)return null;
    return {track:sceneRevision,offset:sceneOffset,cues:sceneSnapshot,
      originalTimes:()=>originalCues.map(([,start,end])=>[start,end])};
  }
  function soundTrack(){
    const fileKey=currentKey(),element=trackElement;
    const ready=Boolean(fileKey&&fileKey===sceneSource&&scenePhase==='ready'&&element?.readyState===2);
    return {revision:sceneRevision,element:ready?element:null,fileKey,offset:sceneOffset,
      id:ready?currentTrack?.id:null,name:ready?currentTrack?.name:null,
      status:ready?'ready':scenePhase==='ready'?'empty':scenePhase,hasFile:fileKey!==null,rows:ready?originalCues:null};
  }
  const scenePanel=$('#scene-panel');
  function openSubtitleSettings(){scenePanel.open=false;$('#subtitle-panel').open=true;$('#subtitle-query').focus();}
  const sceneFinder=createSceneFinder({
    panel:scenePanel,host:$('#scene-finder'),video:$('#video'),canSeekScene,seekScene,canPreviewScene,previewScene,previewAttachmentKey,
    formatTime:formatSceneTime,replayCaption,
    getTrack:()=>{const fileKey=currentKey();return {revision:sceneTrackIdentity(),cues:sceneCues(),status:scenePhase,fileKey,hasFile:fileKey!==null};},
    openSubtitles:openSubtitleSettings,
  });
  function sceneTrackChanged(resetQuery=false){
    stopReplayCaption?.();
    sceneRevision++;
    sceneFinder.trackChanged({resetQuery});
    onSceneTrackChange?.();
  }
  function replayCaption(cue,revision){
    const track=trackElement,video=$('#video'),enabled=$('#subtitle-enabled');
    if(!track||enabled.checked||revision!==sceneTrackIdentity())return;
    stopReplayCaption?.();
    function expire(){
      if(video.currentTime<cue.startTime-.5||video.currentTime>=cue.endTime+.1)stopReplayCaption?.();
    }
    function stop(){
      video.removeEventListener('timeupdate',expire);
      video.removeEventListener('seeked',expire);
      video.removeEventListener('ended',stop);
      if(track===trackElement&&!enabled.checked)track.track.mode='hidden';
      stopReplayCaption=null;
    }
    stopReplayCaption=stop;
    track.track.mode='showing';
    video.addEventListener('timeupdate',expire);
    video.addEventListener('seeked',expire);
    video.addEventListener('ended',stop);
    expire();
  }
  function subtitleStatus(message){$('#subtitle-status').textContent=message;}
  function detachTrack(){
    const changed=Boolean(trackElement)||scenePhase!=='empty';
    if(trackElement){trackElement.remove();trackElement=null;}
    currentTrack=null;originalCues=[];watchedDigest=null;sceneSnapshot=noDialogue;scenePhase='empty';sceneSource=null;
    if(changed)sceneTrackChanged();
  }
  function applyOffset({force=false}={}){
    const delay=Number($('#subtitle-offset').value)||0;
    for(const [cue,start,end] of originalCues){
      cue.startTime=Math.max(0,start+delay);cue.endTime=Math.max(cue.startTime+.01,end+delay);
    }
    const k=currentKey();
    if(k&&subtitleHistory[k]){subtitleHistory[k].offset=delay;storage('cinema-subtitles',subtitleHistory);}
    if(scenePhase==='ready'&&(force||delay!==sceneOffset)){
      sceneOffset=delay;
      sceneSnapshot=Object.freeze(originalCues.map(([cue,_start,_end,text])=>
        Object.freeze({startTime:cue.startTime,endTime:cue.endTime,text})));
      sceneTrackChanged();
    }
  }
  function attachTrack(record,persist=true) {
    detachTrack();const k=currentKey();if(!k)return;
    if(!record?.id||!/^[-a-zA-Z0-9_]{8,128}$/.test(record.id)){subtitleStatus('This subtitle file is unavailable. Import it again.');return;}
    currentTrack=record;trackElement=document.createElement('track');trackElement.kind='subtitles';trackElement.label=record.name||'English';trackElement.srclang=record.language||'en';trackElement.src='/api/subtitles/file?id='+encodeURIComponent(record.id);trackElement.default=true;
    const track=trackElement;
    track.addEventListener('load',()=>{
      if(track!==trackElement||k!==currentKey())return;
      originalCues=Array.from(track.track.cues||[],cue=>{
        const text=String(cue.getCueAsHTML?.().textContent??cue.text??'').replace(/\s+/g,' ').trim();
        return [cue,cue.startTime,cue.endTime,text];
      });
      sceneSource=k;scenePhase='ready';applyOffset({force:true});
      track.track.mode=$('#subtitle-enabled').checked?'showing':'hidden';
      subtitleStatus(`${record.name||'English subtitles'} · ${originalCues.length} cues loaded`);
    });
    track.addEventListener('error',()=>{
      if(track!==trackElement||k!==currentKey())return;
      originalCues=[];sceneSnapshot=noDialogue;sceneSource=null;scenePhase='error';sceneTrackChanged();
      subtitleStatus('This saved subtitle could not load. Import it again or choose another online result.');
    });
    $('#subtitle-enabled').checked=record.enabled!==false;$('#subtitle-offset').value=record.offset||0;
    scenePhase='loading';sceneTrackChanged();
    $('#video').append(track);track.track.mode=$('#subtitle-enabled').checked?'showing':'hidden';
    subtitleStatus(`Loading ${record.name||'English subtitles'}…`);
    if(persist){subtitleHistory[k]={...record,offset:Number(record.offset)||0};const entries=Object.entries(subtitleHistory);subtitleHistory=Object.fromEntries(entries.slice(-150));storage('cinema-subtitles',subtitleHistory);onCaptionChange?.();}
  }
  const inRange=(value,min,max)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:undefined;};
  const releaseYear=value=>[...String(value).matchAll(/\b(?:19|20)\d{2}\b/g)].find(match=>match.index>1)?.[0];
  const episodeMarker=/\bS(\d{1,2})[ ._-]*E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/i;
  function subtitleContext(){
    const active=getActive(),intent=active?.intent;
    const file=active?.files?.find(file=>file.index===active.index);
    const torrent=getLibrary().find(item=>item.hash===active?.hash);
    const release=file?.name?.split(/[\\/]/).at(-1)||torrent?.name||torrent?.title||'';
    const torrentTitle=torrent?.name||torrent?.title;
    const known=(release?metadata(release):null)||(torrentTitle?metadata(torrentTitle):null);
    const cleaned=release?clean(release):'';
    const marker=episodeMarker.exec(release.replace(/[._]/g,' '));
    const title=intent?.showTitle||known?.title||withoutReleaseYear(cleaned.replace(/\b(?:S\d{1,2}(?:[ ._-]*E\d{1,3})?|\d{1,2}x\d{1,3})\b.*$/i,'')).trim();
    const kind=[intent?.kind,known?.kind,torrent?.kind].find(value=>['movies','tv','anime','korean','movie','series'].includes(value));
    const series=intent?.episodeId||marker?true:known?isSeries(known):['tv','korean','series'].includes(kind)?true:['movies','movie'].includes(kind)?false:undefined;
    return {
      title,kind,isSeries:series,release:release.slice(0,400),
      year:inRange(intent?.year||known?.year||releaseYear(cleaned),1900,2099),
      season:inRange(intent?.season,1,100)||inRange(marker?.[1]||marker?.[3],1,100),
      episode:inRange(marker?.[2]||marker?.[4],1,1000)||inRange(intent?.calendarSeason?intent.absoluteNumber:intent?.episode,1,1000),
    };
  }
  function fileChanged() {
    subtitleGeneration++;subtitleSelection++;detachTrack();$('#subtitle-results').replaceChildren();$('#subtitle-offset').value=0;$('#subtitle-enabled').checked=false;$('#subtitle-search-button').disabled=false;
    const k=currentKey();
    if(k!==sceneContext){sceneContext=k;sceneTrackChanged(true);}
    const {title,season,episode}=subtitleContext();
    $('#subtitle-query').value=title;
    $('#subtitle-season').value=season??'';
    $('#subtitle-episode').value=episode??'';
    subtitleStatus('Search English subtitles online or import an SRT, VTT, or ASS file.');
    const record=subtitleHistory[currentKey()];if(record)attachTrack(record,false);
  }
  async function searchSubtitles(event){event.preventDefault();const query=$('#subtitle-query').value.trim();if(!query)return;
    const generation=++subtitleGeneration,button=$('#subtitle-search-button');button.disabled=true;$('#subtitle-results').replaceChildren();subtitleStatus('Searching free English subtitle sources…');
    const season=inRange($('#subtitle-season').value,1,100),episode=inRange($('#subtitle-episode').value,1,1000);
    const context=subtitleContext(),sameTitle=Boolean(context.title&&query.toLowerCase()===context.title.toLowerCase());
    const payload={query,language:'en'};
    if(season)payload.season=season;
    if(episode)payload.episode=episode;
    if(sameTitle){
      for(const name of ['year','kind','isSeries','release'])if(context[name]!==undefined&&context[name]!=='')payload[name]=context[name];
    }
    try{const result=await api('/api/subtitles/search',payload);if(generation!==subtitleGeneration)return;
      const rows=result.results||[];
      const card=(row,suggested=false)=>`<article class="subtitle-result${suggested?' subtitle-suggested':''}"><div>${suggested?'<span class="subtitle-suggested-label">Suggested track</span>':''}<strong>English${row.source?' · '+escape(row.source):''}</strong><p>${escape(row.release||row.title||'')}</p></div><button type="button" class="${suggested?'primary':'subtle'}" data-subtitle-id="${escape(row.id)}">Use subtitle</button></article>`;
      $('#subtitle-results').innerHTML=rows.length?card(rows[0],true)+(rows.length>1?`<details class="subtitle-more"><summary>${rows.length-1} more ${rows.length===2?'track':'tracks'}</summary>${rows.slice(1).map(row=>card(row)).join('')}</details>`:''):'';
      const warnings=(result.warnings||[]).map(x=>typeof x==='string'?x:x.message);
      subtitleStatus([rows.length?'Choose a track to turn on English subtitles.':'No English subtitles found. Try another title or import a subtitle file.',...warnings].join(' '));
    }catch(e){if(generation===subtitleGeneration)subtitleStatus(e.message+' You can still import a subtitle file.');}
    finally{if(generation===subtitleGeneration)button.disabled=false;}
  }
  $('#subtitle-form').addEventListener('submit',searchSubtitles);
  $('#subtitle-results').addEventListener('click',async e=>{const b=e.target.closest('[data-subtitle-id]');if(!b)return;const k=currentKey(),generation=++subtitleSelection;b.disabled=true;subtitleStatus('Downloading and preparing the subtitle…');try{const record=await api('/api/subtitles/download',{id:b.dataset.subtitleId});if(k===currentKey()&&generation===subtitleSelection)attachTrack({...record,origin:'english-search'});}catch(error){if(generation===subtitleSelection)subtitleStatus(error.message);}finally{b.disabled=false;}});
  $('#subtitle-file').addEventListener('change',async e=>{const file=e.target.files[0],k=currentKey();if(!file)return;const generation=++subtitleSelection;try{if(file.size>2*1024*1024)throw Error('Choose a subtitle file smaller than 2 MB.');subtitleStatus('Importing your subtitle…');const record=await api('/api/subtitles/import',{name:file.name,text:await file.text()});if(k===currentKey()&&generation===subtitleSelection)attachTrack(record);}catch(error){if(generation===subtitleSelection)subtitleStatus(error.message);}finally{e.target.value='';}});
  $('#subtitle-enabled').addEventListener('change',()=>{
    stopReplayCaption?.();
    const enabled=$('#subtitle-enabled').checked;
    if(trackElement){
      trackElement.track.mode=enabled?'showing':'hidden';
      const record=subtitleHistory[currentKey()];
      if(record){record.enabled=enabled;storage('cinema-subtitles',subtitleHistory);}
    }else if(enabled){
      $('#subtitle-enabled').checked=false;subtitleStatus('Choose or import a subtitle first.');
    }
  });
  $('#subtitle-offset').addEventListener('input',applyOffset);
  $('#subtitle-remove').addEventListener('click',()=>{subtitleSelection++;const k=currentKey();detachTrack();delete subtitleHistory[k];storage('cinema-subtitles',subtitleHistory);onCaptionChange?.();$('#subtitle-enabled').checked=false;subtitleStatus('Subtitles removed from this video. The saved subtitle file is kept.');});
  return {searchCatalog,cancelCatalog,poster,metadata,remember,fileChanged,detachTrack,sceneCues,sceneTrackIdentity,sceneEditionTrack,savedRescueSubtitle,savedCalendarCaption,watchedCaption,soundTrack,openSubtitleSettings,
    refreshScenes:sceneFinder.refresh,restoreTrack:()=>{if(currentTrack)attachTrack(currentTrack,false);}};
}

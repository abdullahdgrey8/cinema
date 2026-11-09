import {updateHTML} from './dom.js';

const playIcon='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.4a.8.8 0 0 1 1.22-.68l10.15 6.6a.8.8 0 0 1 0 1.36l-10.15 6.6A.8.8 0 0 1 8 18.6z"/></svg>';
const episodesIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m10 9 4.5 3-4.5 3z"/></svg>';

export function createDiscoveryUI({api,escape,onAdd,onPlay,onSearch,onRemember,getOperation,onEpisodes,onCatalog,onSave,isSaved}) {
  const $=selector=>document.querySelector(selector);
  const allowed=new Set(['home','movies','tv','anime','korean']);
  const rowIds=['movies','new-movies','tv','korean','anime'];
  const dialog=$('#title-detail-dialog');
  const rememberedItems=new Map();
  const renderedShelves=new Map();
  const unavailableArtwork=new Set();
  let state=null,timer=null,currentView='home',selectedId=null,searchMode=false,requestGeneration=0;
  let period='week',pages=Object.fromEntries(rowIds.map(id=>[id,1]));
  let detailItemId=null,externalItem=false,detailLoadError=false;

  const visible=()=>!searchMode&&allowed.has(currentView);
  const dateLabel=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')?
    new Date(value+'T12:00:00Z').toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'';
  const rowDates=row=>[dateLabel(row.periodStart),dateLabel(row.periodEnd)].filter(Boolean).join(' – ');
  const shelfArt=(item,landscape)=>{
    const url=landscape&&item.backdropUrl?.startsWith('/api/metadata/poster?')?item.backdropUrl:item.posterUrl;
    return url?.startsWith('/api/metadata/poster?')?
      `<img src="${escape(url)}" alt="" loading="lazy" decoding="async"${landscape&&url===item.posterUrl?' class="shelf-portrait-crop"':''}>`:'';
  };
  const rating=item=>item.rating?(typeof item.rating==='object'?`${item.rating.value}/${item.rating.scale||10}`:item.rating):'';
  const facts=item=>[
    item.upcoming&&item.premiered?'Premieres '+item.premiered:item.year,
    ...(item.genres||[]).slice(0,2),rating(item)?'★ '+rating(item):''
  ].filter(Boolean).join(' · ');
  const series=item=>typeof item.isSeries==='boolean'?item.isSeries:
    ['tv','korean'].includes(item.kind)||String(item.id).startsWith('tvmaze-')||
    item.kind==='anime'&&item.mediaType!=='movie'&&!/\bfilm\b/i.test(String(item.overview||'').slice(0,250));
  const itemFor=id=>state?.selectedItem?.id===id?state.selectedItem:
    state?.rows?.flatMap(row=>row.items||[]).find(item=>item.id===id)||rememberedItems.get(id);

  function parameters(includeFocus=true){
    const result={period,category:$('#discover-filter').value||'all',mode:'on-demand',
      ...Object.fromEntries(rowIds.map(id=>[id+'Page',pages[id]]))};
    if(includeFocus&&dialog.open&&selectedId)result.focus=selectedId;
    return result;
  }
  function endpoint(includeFocus=true){return '/api/discover?'+new URLSearchParams(parameters(includeFocus));}
  function pause(){
    clearTimeout(timer);
    timer=null;
    requestGeneration++;
  }
  function setText(selector,text){
    const element=$(selector);
    if(element.textContent!==text)element.textContent=text;
  }

  function pagination(row){
    const page=Number(row.page)||pages[row.id]||1,totalPages=Math.max(1,Number(row.totalPages)||1);
    if((row.items?.length||0)<2&&totalPages===1)return '';
    const total=Number(row.totalItems??row.items?.length??0),size=Number(row.pageSize)||8;
    const first=total?((page-1)*size)+1:0,last=Math.min(total,((page-1)*size)+(row.items?.length||0));
    const previous=row.hasPrevious??page>1,next=row.hasNext??page<totalPages;
    const arrow=id=>`<svg class="cinema-icon" aria-hidden="true"><use href="#ico-${id}"/></svg>`;
    return `<nav class="discovery-pagination" aria-label="${escape(row.title)}">
      <span>${first}–${last} of ${total} titles <small>Page ${page} of ${totalPages}</small></span>
      <div><button type="button" class="subtle" data-discover-page-row="${escape(row.id)}" data-discover-page="${page-1}" data-rail-step="-1" data-has-page="${previous}" aria-label="Previous titles in ${escape(row.title)}" ${previous?'':'disabled'}>${arrow('left')}</button>
      <button type="button" class="subtle" data-discover-page-row="${escape(row.id)}" data-discover-page="${page+1}" data-rail-step="1" data-has-page="${next}" aria-label="More titles in ${escape(row.title)}" ${next?'':'disabled'}>${arrow('right')}</button></div>
    </nav>`;
  }
  function syncRail(rail){
    const pagination=rail.parentElement?.querySelector('.discovery-pagination');
    if(!pagination)return;
    const previous=pagination.querySelector('[data-rail-step="-1"]'),next=pagination.querySelector('[data-rail-step="1"]');
    previous.disabled=rail.scrollLeft<2&&previous.dataset.hasPage!=='true';
    next.disabled=rail.scrollLeft+rail.clientWidth>=rail.scrollWidth-2&&next.dataset.hasPage!=='true';
  }
  const railResize=new ResizeObserver(entries=>{for(const entry of entries)syncRail(entry.target);});
  function releaseShelf(entry){if(entry.rail)railResize.unobserve(entry.rail);}
  function card(item,row,position){
    const ranked=(row.id==='movies'||row.id==='tv')&&row.chartProvider==='justwatch'&&item.chartRank;
    const badge=item.upcoming?'Coming soon':ranked?'#'+item.chartRank:'';
    const description=facts(item);
    return `<article class="discovery-card" style="--card-delay:${Math.min(position,5)*32}ms">
      <button type="button" class="discovery-card-open" data-discover-detail="${escape(item.id)}" aria-label="${escape('Open '+item.title+(item.year?' ('+item.year+')':''))}">
        <span class="discovery-art" aria-hidden="true"><span class="art-fallback"><svg class="cinema-icon"><use href="#ico-film"/></svg></span>${shelfArt(item,row.id==='tv'||row.id==='korean')}${badge?`<span class="discovery-badge${ranked?' is-rank':''}">${escape(badge)}</span>`:''}<span class="discovery-play"><svg class="cinema-icon"><use href="#ico-right"/></svg></span></span>
        <span class="discovery-copy"><span class="title-button">${escape(item.title)}</span>${description?`<span class="discovery-facts">${escape(description)}</span>`:''}</span>
      </button>
    </article>`;
  }
  function shelf(row){
    const attribution=row.sourceUrl||row.sourceUrls?.[0];
    return `<div class="section-heading">
      <div><span class="eyebrow">${escape(row.stale?'From the last update':row.id==='new-movies'?'Recent films':row.id==='korean'?'K-drama':row.id==='anime'?'Anime':'What’s popular')}</span>
      <h3 id="discovery-row-${escape(row.id)}-title" tabindex="-1">${escape(row.title)}</h3>
      ${rowDates(row)?`<p class="discovery-dates">${escape(rowDates(row))}</p>`:''}</div>
      <span class="muted">${escape(row.description||'')}</span>
    </div>
    ${row.items?.length?`<div class="discovery-grid${row.id==='tv'||row.id==='korean'?' discovery-grid-landscape':''}">${row.items.map((item,index)=>card(item,row,index)).join('')}</div>`:
      '<div class="empty"><h3>No titles available for this period</h3><p>Choose another period or search directly.</p></div>'}
    ${pagination(row)}
    ${attribution&&/^https:\/\//.test(attribution)?`<details class="shelf-credits"><summary>About this chart</summary><a class="row-attribution" href="${escape(attribution)}" target="_blank" rel="noopener noreferrer">${escape(row.source||'Catalog source')}</a>${rowDates(row)?`<span>${escape(rowDates(row))}</span>`:''}</details>`:''}`;
  }
  function renderShelves(rows){
    const host=$('#discover-rows'),wanted=new Set(rows.map(row=>row.id));
    if(!renderedShelves.size)host.replaceChildren();
    for(const [id,entry] of renderedShelves){
      if(!wanted.has(id)){releaseShelf(entry);entry.element.remove();renderedShelves.delete(id);}
    }
    let position=host.firstElementChild;
    for(const row of rows){
      let entry=renderedShelves.get(row.id);
      if(!entry){
        const element=document.createElement('section');
        element.className='discovery-row';
        element.setAttribute('aria-labelledby','discovery-row-'+row.id+'-title');
        entry={element,row:null,html:null};
        renderedShelves.set(row.id,entry);
      }
      if(entry.element!==position)host.insertBefore(entry.element,position);
      position=entry.element.nextElementSibling;
      if(entry.row===row)continue;
      const html=shelf(row);
      const positionOnPage=entry.row?.page===row.page?entry.rail?.scrollLeft||0:0;
      entry.row=row;
      if(entry.html!==html){
        releaseShelf(entry);
        entry.html=html;updateHTML(entry.element,html);
        entry.rail=entry.element.querySelector('.discovery-grid');
        if(entry.rail){
          for(const image of entry.rail.querySelectorAll('img'))image.addEventListener('error',()=>image.remove(),{once:true});
          entry.rail.scrollLeft=positionOnPage;
          entry.rail.addEventListener('scroll',()=>syncRail(entry.rail),{passive:true});
          railResize.observe(entry.rail);
        }
      }
    }
  }
  function render(){
    onCatalog?.({rows:state?.rows||[],visible:visible(),view:currentView});
    $('#discover-section').hidden=!visible();
    if(!visible()){if(dialog.open)renderDetail();return;}
    const filter=$('#discover-filter').value;
    const rows=(state?.rows||[]).filter(row=>!filter||filter==='all'||(row.category||row.id)===filter);
    const waiting=!rows.length&&(!state||state.status==='loading'||state.catalogLoading);
    const error=state?.status==='error';
    setText('#discover-status',waiting?'Finding what’s popular…':error?'Discover is temporarily unavailable.':'');
    setText('#discover-warning',(state?.warnings||[]).map(w=>typeof w==='string'?w:w.message).join(' · '));
    $('#discover-rows').setAttribute('aria-busy',String(waiting));
    if(rows.length)renderShelves(rows);
    else{
      for(const entry of renderedShelves.values())releaseShelf(entry);
      renderedShelves.clear();
      updateHTML($('#discover-rows'),waiting?'<div class="discovery-skeleton" aria-hidden="true"><div></div><div></div><div></div><div></div><div></div><div></div></div>':
        `<div class="empty"><h3>${error?'Discovery is temporarily unavailable':'No titles for this view'}</h3><p>Try another period or search a title above.</p></div>`);
    }
    if(dialog.open)renderDetail();
  }
  function playbackAction(source,item,{primary=false}={}){
    const operation=getOperation?.(source.key),existing=operation?.hash||source.existingHash;
    const pending=operation&&['adding','accepted','uncertain'].includes(operation.status)&&!existing;
    const attrs=existing?`data-discover-play="${escape(existing)}"`:
      `data-discover-add="${escape(source.key)}" data-kind="${escape(item.kind)}"`;
    const label=pending?'Getting ready…':primary?'Play best source':existing||Number(source.nbSeeders)>0?'Play':'Try source';
    return `<button type="button" class="${primary?'primary':'subtle'} title-watch-button" ${primary?'id="title-watch-primary"':''} ${attrs} ${pending?'disabled':''}>${playIcon}${label}</button>`;
  }
  function release(source,index,item){
    const existing=getOperation?.(source.key)?.hash||source.existingHash;
    const size=Number(source.fileSize)>0?`${(source.fileSize/1024**3).toFixed(1)} GB`:'';
    const count=(value,label)=>Number.isInteger(value)&&value>=0?`${value} ${label}`:`${label} unknown`;
    const facts=[source.engineName,size||'Size unknown',count(source.nbSeeders,'seeders'),count(source.nbLeechers,'leechers')].filter(Boolean).join(' · ');
    return `<article class="watch-release"><div class="watch-release-copy">
      <strong>${existing?'In your library':index===0?'Recommended':`Option ${index+1}`}</strong>
      ${source.streaming?.resolution?`<span class="watch-quality">${escape(source.streaming.resolution)}</span>`:''}
      <details class="watch-release-info" id="title-release-${escape(String(source.key||index).replace(/[^a-z0-9_-]/gi,'_'))}"><summary>Release details</summary>
        <p>${escape(source.fileName||'')}</p><p>${escape(facts)}</p>
      </details></div>${playbackAction(source,item)}</article>`;
  }
  function prepareDetail(){
    const body=$('#title-detail-body'),heading=$('#title-detail-title');
    const close=dialog.querySelector('[data-close="title-detail-dialog"]');
    close.classList.add('cinema-dialog-close');
    close.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    body.innerHTML=`<div class="title-detail-hero">
      <div class="title-detail-backdrop" aria-hidden="true"></div>
      <div class="title-detail-copy"><p class="title-detail-kind" id="title-detail-kind"></p>
        <div id="title-detail-heading"></div>
        <p class="title-detail-facts" id="title-detail-facts"></p>
        <p class="title-detail-overview" id="title-detail-overview"></p>
        <div class="title-detail-actions" id="title-detail-actions"></div>
        <p class="title-watch-status" id="title-watch-status" role="status"></p>
      </div>
      <div class="title-detail-cover" id="title-detail-cover" aria-hidden="true"></div>
    </div>
    <details class="title-watch-options" id="title-watch-options"><summary>
      <span>Watch options</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </summary><div class="title-watch-options-body">
      <div id="title-release-list"></div>
      <div class="title-watch-footer" id="title-watch-footer"></div>
    </div></details>`;
    $('#title-detail-heading').append(heading);
  }
  function detailArtwork(item){
    const available=url=>typeof url==='string'&&url.startsWith('/api/metadata/poster?')&&!unavailableArtwork.has(url);
    const backdrop=[item.backdropUrl,item.posterUrl].find(available);
    const cover=available(item.posterUrl)?
      `<img src="${escape(item.posterUrl)}" width="220" height="330" alt="" decoding="async">`:'';
    const backdropHost=$('.title-detail-backdrop'),coverHost=$('#title-detail-cover');
    updateHTML(backdropHost,backdrop?
      `<img class="${backdrop===item.posterUrl?'is-poster':''}" src="${escape(backdrop)}" alt="" decoding="async">`:'');
    updateHTML(coverHost,cover);
    coverHost.hidden=!cover;
    function retryWithout(image,url){
      if(!image||image.onerror)return;
      image.onerror=()=>{
        if(!image.isConnected||selectedId!==item.id)return;
        unavailableArtwork.add(url);
        if(unavailableArtwork.size>160)unavailableArtwork.delete(unavailableArtwork.values().next().value);
        detailArtwork(item);
      };
    }
    retryWithout(backdropHost.querySelector('img'),backdrop);
    retryWithout(coverHost.querySelector('img'),item.posterUrl);
  }
  function renderDetail(){
    const item=itemFor(selectedId);
    if(!item)return;
    if(!$('#title-detail-actions'))prepareDetail();
    if(detailItemId!==item.id){
      detailItemId=item.id;
      $('#title-watch-options').open=false;
      dialog.scrollTop=0;
    }
    const availability=item.availability||{},sources=availability.sources||[];
    const best=sources.find(source=>{
      const operation=getOperation?.(source.key);
      return operation?.status!=='failed'&&(source.existingHash||operation?.hash||Number(source.nbSeeders)>0);
    });
    const isSeries=series(item),hasEpisodes=Boolean(onEpisodes&&isSeries);
    const finding=!externalItem&&!detailLoadError&&(!availability.status||['idle','queued','searching'].includes(availability.status));
    const options=$('#title-watch-options');
    const heading=item.kind==='anime'?'Anime':item.kind==='korean'?'Korean series':isSeries?'Series':'Film';
    setText('#title-detail-title',item.title);
    setText('#title-detail-kind',heading);
    setText('#title-detail-facts',facts(item));
    setText('#title-detail-overview',item.overview||'');
    detailArtwork(item);

    const action=hasEpisodes?`<button type="button" class="primary title-watch-button" id="title-watch-primary" data-discover-episodes="${escape(item.id)}" data-start-watching>${playIcon}Start watching</button>
      <button type="button" class="subtle title-watch-button" data-discover-episodes="${escape(item.id)}">${episodesIcon}Episodes</button>`:
      best?playbackAction(best,item,{primary:true}):
      finding?`<button type="button" class="primary title-watch-button" id="title-watch-primary" disabled>${playIcon}Play</button>`:
      `<button type="button" class="subtle title-watch-button" id="title-watch-primary" data-discover-search="${escape(item.id)}">Search for this title</button>`;
    const saved=Boolean(isSaved?.(item));
    const saveButton=onSave?`<button type="button" class="subtle title-watch-button title-save-button" id="title-save-button" data-discover-save="${escape(item.id)}" aria-pressed="${saved}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${saved?'m5 12 4 4L19 6':'M12 5v14M5 12h14'}"/></svg>My list</button>`:'';
    updateHTML($('#title-detail-actions'),action+saveButton);
    const watchStatus=hasEpisodes||externalItem?'':availability.partial?availability.message:
      best?(finding?'Source found. Checking for more options…':'Source found. Cinema will check the video when it starts.'):
      finding?'Looking for a way to watch…':item.upcoming?'Available after release.':
      sources.length?'Only low-availability sources were found.':'No playable release found yet.';
    setText('#title-watch-status',watchStatus||'');

    const openDetails=detailItemId===item.id&&options.open?
      [...options.querySelectorAll('.watch-release-info[open]')].map(element=>element.id):[];
    updateHTML($('#title-release-list'),sources.length?
      sources.map((source,index)=>release(source,index,item)).join(''):
      `<p class="title-watch-empty">${escape(finding?'Looking for releases…':availability.message||'No releases are available right now.')}</p>`);
    for(const id of openDetails){const detail=document.getElementById(id);if(detail)detail.open=true;}
    const sourceLink=item.sourceUrl&&/^https:\/\//.test(item.sourceUrl)?
      `<a href="${escape(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">About this listing</a>`:'';
    updateHTML($('#title-watch-footer'),`<button type="button" class="subtle" data-discover-search="${escape(item.id)}">Search all releases</button>${sourceLink}`);
  }
  function accept(next){
    state=next;
    for(const row of next.rows||[]){
      if(rowIds.includes(row.id)&&row.page)pages[row.id]=Number(row.page);
      for(const item of row.items||[])rememberedItems.set(item.id,item);
    }
    if(next.selectedItem)rememberedItems.set(next.selectedItem.id,next.selectedItem);
    while(rememberedItems.size>500)rememberedItems.delete(rememberedItems.keys().next().value);
  }
  async function load({announce=false,focusRow=null}={}){
    if(!visible()&&!dialog.open){pause();render();return;}
    clearTimeout(timer);
    timer=null;
    const generation=++requestGeneration;
    render();
    try{
      const next=await api(endpoint());
      if(generation!==requestGeneration)return;
      detailLoadError=false;
      accept(next);
      render();
      if(announce){
        const row=focusRow&&state.rows?.find(row=>row.id===focusRow);
        setText('#discover-page-status',row?`${row.title}: page ${row.page||1} of ${row.totalPages||1}.`:'Discovery updated.');
      }
      if(focusRow){
        const heading=document.getElementById('discovery-row-'+focusRow+'-title');
        heading?.focus({preventScroll:true});
        heading?.scrollIntoView({block:'start'});
      }
    }catch(error){
      if(generation!==requestGeneration)return;
      detailLoadError=dialog.open;
      if(!state)state={status:'error',rows:[],warnings:[error.message]};
      render();
      setText('#discover-status',error.message);
    }finally{
      if(generation===requestGeneration&&(visible()||dialog.open)){
        const delay=state?.catalogLoading||state?.status==='loading'?900:dialog.open&&state?.status==='finding-sources'?750:30000;
        timer=setTimeout(()=>load(),delay);
      }
    }
  }

  $('#discover-filter').addEventListener('change',()=>void load({announce:true}));
  const periodButtons=[...document.querySelectorAll('[data-discover-period]')];
  for(const button of periodButtons)button.addEventListener('click',()=>{
    if(button.dataset.discoverPeriod===period)return;
    const select=$('#discover-period');
    select.value=button.dataset.discoverPeriod;
    select.dispatchEvent(new Event('change'));
  });
  $('#discover-period').addEventListener('change',()=>{
    period=$('#discover-period').value==='month'?'month':'week';
    for(const button of periodButtons)button.setAttribute('aria-pressed',String(button.dataset.discoverPeriod===period));
    pages=Object.fromEntries(rowIds.map(id=>[id,1]));
    state=null;
    void load({announce:true});
  });
  $('#discover-refresh').addEventListener('click',async()=>{
    const button=$('#discover-refresh'),generation=++requestGeneration;
    clearTimeout(timer);
    button.disabled=true;
    try{
      const next=await api('/api/discover/refresh',parameters());
      if(generation!==requestGeneration)return;
      accept(next);
      render();
      setText('#discover-page-status','Refreshing charts in the background.');
      void load();
    }catch(error){
      if(generation===requestGeneration){
        setText('#discover-status',error.message);
        timer=setTimeout(()=>load(),4000);
      }
    }finally{button.disabled=false;}
  });
  dialog.addEventListener('close',()=>{
    if(dialog.open)return;
    selectedId=null;
    externalItem=false;
    detailLoadError=false;
    if(visible())void load();
    else void api(endpoint(false)).catch(()=>{});
  });
  function openDetail(id,{external=false}={}){
    if(!itemFor(id))return;
    selectedId=id;
    externalItem=external;
    detailLoadError=false;
    renderDetail();
    if(!dialog.open)dialog.showModal();
    if(!external)void load();
  }
  document.addEventListener('click',event=>{
    const page=event.target.closest('[data-discover-page-row]');
    if(page&&!page.disabled){
      const row=page.dataset.discoverPageRow;
      const rail=page.closest('.discovery-row')?.querySelector('.discovery-grid'),step=Number(page.dataset.railStep);
      const hasRoom=rail&&(step<0?rail.scrollLeft>2:rail.scrollLeft+rail.clientWidth<rail.scrollWidth-2);
      if(hasRoom)rail.scrollBy({left:step*rail.clientWidth*.82,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
      else if(page.dataset.hasPage==='true'&&rowIds.includes(row)){pages[row]=Math.max(1,Number(page.dataset.discoverPage)||1);void load({announce:true,focusRow:row});}
      return;
    }
    const detail=event.target.closest('[data-discover-detail]');
    if(detail){
      openDetail(detail.dataset.discoverDetail);
    }
    const save=event.target.closest('[data-discover-save]');
    if(save){
      const item=itemFor(save.dataset.discoverSave);
      if(item){onSave?.(item);renderDetail();}
      return;
    }
    const episode=event.target.closest('[data-discover-episodes]');
    if(episode){
      const item=itemFor(episode.dataset.discoverEpisodes);
      if(item){onRemember(item);dialog.close();onEpisodes?.(item,episode.hasAttribute('data-start-watching')?{startWatching:true}:undefined);}
      return;
    }
    const add=event.target.closest('[data-discover-add]');
    if(add&&!add.disabled){
      const item=itemFor(selectedId);
      if(item)onRemember(item);
      dialog.close();
      void onAdd(add.dataset.discoverAdd,add.dataset.kind);
    }
    const play=event.target.closest('[data-discover-play]');
    if(play){dialog.close();void onPlay(play.dataset.discoverPlay);}
    const search=event.target.closest('[data-discover-search]');
    if(search){
      const item=itemFor(selectedId);
      if(item){onRemember(item);dialog.close();onSearch(item);}
    }
  });
  return {
    load,render,
    openItem(item){
      if(!item?.id||!item.title)return;
      const inCatalog=state?.rows?.some(row=>row.items?.some(entry=>entry.id===item.id));
      if(!inCatalog)rememberedItems.set(item.id,{...item,availability:undefined});
      openDetail(item.id,{external:!inCatalog});
    },
    invalidateHash(hash){
      for(const item of rememberedItems.values())for(const source of item.availability?.sources||[])
        if(source.existingHash===hash)delete source.existingHash;
      render();
    },
    setSearchMode(value){
      const wasVisible=visible();
      searchMode=Boolean(value);
      if(!visible())pause();
      render();
      if(visible()&&!wasVisible)void load();
    },
    setView(view){
      const wasVisible=visible(),previous=$('#discover-filter').value;
      searchMode=false;
      currentView=view;
      $('#discover-filter').value=rowIds.includes(view)?view:'all';
      if(!visible())pause();
      render();
      if(visible()&&(!wasVisible||previous!==$('#discover-filter').value||!state))void load();
    },
  };
}

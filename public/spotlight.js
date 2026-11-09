const artUrl=value=>typeof value==='string'&&value.startsWith('/api/metadata/poster?')?value:'';
const svg=id=>`<svg class="cinema-icon" aria-hidden="true"><use href="#ico-${id}"/></svg>`;
const facts=item=>[
  item.year,
  item.kind==='movies'?'Movie':item.kind==='anime'?'Anime':'Series',
  ...(item.genres||[]).slice(0,2),
].filter(Boolean);

export function createSpotlight({escape,openItem,isSaved,toggleSaved,lookup}){
  const frame=document.getElementById('spotlight-frame');
  const controls=document.getElementById('spotlight-controls');
  const position=document.getElementById('spotlight-position');
  const steps=document.getElementById('spotlight-steps');
  let items=[],index=0,signature='',stepSignature='';
  const details=new Map();

  function showSynopsis(featured){
    const {item}=featured,match=details.get(item.id);
    const synopsis=frame.querySelector('.spotlight-synopsis');
    if(!synopsis)return;
    const text=item.overview||match?.overview||'';
    if(synopsis.textContent!==text)synopsis.textContent=text;
    synopsis.hidden=!text;
    if(text||!lookup||details.has(item.id))return;
    details.set(item.id,null);
    if(details.size>30)details.delete(details.keys().next().value);
    void lookup(item).then(match=>{
      if(!details.has(item.id))return;
      details.set(item.id,match);
      if(items[index]?.item.id===item.id)showSynopsis(items[index]);
    }).catch(()=>{});
  }

  function updateControls(){
    controls.hidden=items.length<2;
    const next=JSON.stringify(items.map(({item})=>[item.id,item.title]));
    if(next!==stepSignature){
      stepSignature=next;
      const focused=steps.contains(document.activeElement)?document.activeElement.dataset.featuredIndex:null;
      steps.innerHTML=items.map(({item},i)=>`<button type="button" data-featured-index="${i}" aria-label="${escape('Show '+item.title)}"><span></span></button>`).join('');
      if(focused!==null)steps.querySelector(`[data-featured-index="${focused}"]`)?.focus({preventScroll:true});
    }
    for(const button of steps.children)button.setAttribute('aria-pressed',String(Number(button.dataset.featuredIndex)===index));
    const slideNumber=`Featured title ${index+1} of ${items.length}. ${items[index].item.title}`;
    if(position.textContent!==slideNumber)position.textContent=slideNumber;
  }

  function render(){
    const featured=items[index];
    if(!featured)return;
    const {item,label}=featured,backdrop=artUrl(item.backdropUrl),poster=artUrl(item.posterUrl);
    const art=backdrop||poster,saved=isSaved(item);
    const next=JSON.stringify([item.id,item.title,item.overview,art,label,facts(item)]);
    if(next===signature){
      const button=frame.querySelector('#spotlight-save');
      if(button&&button.getAttribute('aria-pressed')!==String(saved)){
        button.setAttribute('aria-pressed',String(saved));
        button.setAttribute('aria-label',`${saved?'Remove from':'Add to'} My List`);
        button.querySelector('use').setAttribute('href',saved?'#ico-check':'#ico-bookmark');
        button.querySelector('span').textContent=saved?'In My List':'My List';
      }
      updateControls();
      showSynopsis(featured);
      return;
    }
    signature=next;
    const focused=frame.contains(document.activeElement)?document.activeElement.id:'';
    const previous=frame.querySelector('.spotlight-visual img.is-loaded')||frame.querySelector('.spotlight-outgoing img');
    const previousWide=previous?.parentElement.classList.contains('is-wide');
    frame.innerHTML=`
      <div class="spotlight-slide">
        <div class="spotlight-visual${backdrop?' is-wide':''}" aria-hidden="true">
          ${art?`<img src="${escape(art)}" alt="" decoding="async" fetchpriority="high">`:''}
        </div>
        <div class="spotlight-scrim"></div>
        <div class="spotlight-copy">
          <div class="spotlight-kicker"><span></span>${escape(label)}</div>
          <h1>${escape(item.title)}</h1>
          <div class="spotlight-facts">${facts(item).map(text=>`<span>${escape(text)}</span>`).join('')}</div>
          <p class="spotlight-synopsis" ${item.overview?'':'hidden'}>${escape(item.overview||'')}</p>
          <div class="spotlight-actions">
            <button id="spotlight-open" class="hero-primary" type="button">${svg('play')} View title</button>
            <button id="spotlight-save" class="hero-secondary" type="button" aria-pressed="${saved}" aria-label="${saved?'Remove from':'Add to'} My List">${svg(saved?'check':'bookmark')}<span>${saved?'In My List':'My List'}</span></button>
          </div>
        </div>
      </div>`;
    const visual=frame.querySelector('.spotlight-visual'),image=visual.querySelector('img');
    let outgoing=null;
    if(image&&previous){
      outgoing=document.createElement('div');
      outgoing.className='spotlight-outgoing'+(previousWide?' is-wide':'');
      outgoing.setAttribute('aria-hidden','true');
      outgoing.append(previous);
      visual.before(outgoing);
    }
    function reveal(){
      image.classList.add('is-loaded');
      if(outgoing)setTimeout(()=>outgoing.remove(),650);
    }
    function missing(){
      if(backdrop&&poster&&image.getAttribute('src')!==poster){
        image.parentElement.classList.remove('is-wide');image.src=poster;
      }else{image.remove();outgoing?.remove();}
    }
    if(image){
      image.addEventListener('load',reveal);
      image.addEventListener('error',missing);
      if(image.complete){if(image.naturalWidth)reveal();else missing();}
    }
    frame.querySelector('#spotlight-open').onclick=()=>openItem(item);
    frame.querySelector('#spotlight-save').onclick=()=>{toggleSaved(item);render();};
    if(focused)document.getElementById(focused)?.focus({preventScroll:true});
    updateControls();
    showSynopsis(featured);
  }

  function move(change){
    if(items.length<2)return;
    index=(index+change+items.length)%items.length;
    render();
  }
  document.getElementById('spotlight-previous').onclick=()=>move(-1);
  document.getElementById('spotlight-next').onclick=()=>move(1);
  steps.addEventListener('click',event=>{
    const button=event.target.closest('[data-featured-index]');
    if(button){index=Number(button.dataset.featuredIndex);render();}
  });
  document.getElementById('spotlight-explore').onclick=()=>{
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('discover-section').scrollIntoView({block:'start',behavior:reduced?'instant':'smooth'});
  };
  return {
    render,
    update({rows,visible,view}){
      if(view!=='home'||!visible)return;
      const selected=items[index]?.item.id,featured=new Map();
      for(const [id,label,limit] of [['movies','Featured film',1],['tv','Series spotlight',1],['korean','K-drama spotlight',1],['anime','Anime spotlight',1],['new-movies','Popular this year',1]]){
        const row=rows.find(value=>value.id===id);
        for(const item of (row?.items||[]).filter(item=>item.title&&artUrl(item.posterUrl)&&!item.upcoming).slice(0,limit)){
          if(!featured.has(item.id))featured.set(item.id,{item,label});
        }
      }
      if(!featured.size)return;
      items=[...featured.values()].slice(0,7);
      index=Math.max(0,items.findIndex(value=>value.item.id===selected));
      render();
    },
  };
}

export function createWatchlist({escape,openItem,onChange}){
  const key='cinema-watchlist-v1';
  let saved=[];
  try{const value=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(value))saved=value.filter(item=>typeof item?.id==='string'&&typeof item.title==='string').slice(0,60);}catch{}
  const list=document.getElementById('watchlist-grid');
  const isSaved=item=>saved.some(entry=>entry.id===item?.id);
  function render(){
    list.innerHTML=saved.length?saved.map(item=>`<button type="button" class="watchlist-card" data-watchlist-id="${escape(item.id)}">
      <span class="watchlist-art">${artUrl(item.posterUrl)?`<img src="${escape(item.posterUrl)}" alt="" loading="lazy" decoding="async">`:svg('bookmark')}</span>
      <span class="watchlist-name">${escape(item.title)}</span>
    </button>`).join(''):'<p class="watchlist-empty">Save a title from its details or the featured row to find it here later.</p>';
  }
  list.addEventListener('click',event=>{
    const entry=event.target.closest('[data-watchlist-id]');
    const item=entry&&saved.find(value=>value.id===entry.dataset.watchlistId);
    if(item)openItem(item);
  });
  render();
  return {
    isSaved,
    entries:()=>saved.slice(),
    toggle(item){
      if(!item?.id||!item.title)return false;
      if(isSaved(item))saved=saved.filter(entry=>entry.id!==item.id);
      else{
        const {id,title,year,kind,isSeries,posterUrl,backdropUrl,overview,genres,mediaType,browseCategory,sourceUrl,runtime,metadataId}=item;
        saved=[{id,title,year,kind,isSeries,posterUrl,backdropUrl,overview,genres,mediaType,browseCategory,sourceUrl,runtime,metadataId},...saved].slice(0,60);
      }
      try{localStorage.setItem(key,JSON.stringify(saved));}catch{}
      render();onChange?.();
      return isSaved(item);
    },
  };
}

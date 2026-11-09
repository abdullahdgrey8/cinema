import {updateHTML} from './dom.js';

const ORBIT='/api/episodes/orbit';
const VIEWS=['original','orders','related'];
const SHOW=/^tvmaze-[1-9]\d{0,7}$/;
const EPISODE=/^tvmaze-episode-[1-9]\d{0,15}$/;
const FILM=/^wikidata-Q[1-9]\d{0,13}$/;
const UNKNOWN='unknown';
const asSeason=value=>value===null||Number.isSafeInteger(value)?value:undefined;
const seasonValue=value=>value===null?UNKNOWN:String(value);
const seasonName=value=>value===null?'Unspecified season':value===0?'Specials':'Season '+value;
const episodeCount=(value,word='episode')=>value+' '+word+(value===1?'':'s');

function episodeLabel({season,number,special}){
  if(special)return 'Special';
  if(!Number.isSafeInteger(number))return 'Unnumbered episode';
  if(!Number.isSafeInteger(season))return 'Episode '+number;
  const ep='E'+String(number).padStart(2,'0');
  return season>=1900?season+' · '+ep:'S'+String(season).padStart(2,'0')+ep;
}

function attribution(value,origin,fallback){
  try{
    const url=new URL(value);
    if(url.origin===origin&&!url.username&&!url.password)return url.href;
  }catch{}
  return fallback;
}

export function createStoryOrbit({host,api,escape,onViewChange,onCanonical,onRelated}){
  host.classList.add('story-orbit');
  host.setAttribute('aria-label','Story Orbit');
  host.innerHTML=`
    <div class="orbit-bar">
      <div class="orbit-identity">
        <span class="orbit-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="5" transform="rotate(-40 12 12)"/><circle cx="19" cy="6" r="1.35" fill="currentColor" stroke="none"/></svg></span>
        <div><span class="orbit-kicker">STORY ORBIT</span><label for="orbit-view">Watch order</label></div>
      </div>
      <select id="orbit-view" data-orbit-view>
        <option value="original">Original order</option>
        <option value="orders">Alternate orders</option>
        <option value="related">Related titles</option>
      </select>
    </div>
    <p class="sr-only" data-orbit-live role="status" aria-live="polite" aria-atomic="true"></p>
    <section class="orbit-panel" data-orbit-panel aria-labelledby="orbit-heading" hidden>
      <header class="orbit-heading">
        <div><h3 id="orbit-heading"></h3><p data-orbit-intro></p></div>
        <a data-orbit-source target="_blank" rel="noopener noreferrer"></a>
      </header>
      <div class="orbit-controls" data-orbit-controls hidden>
        <label>Edition<select data-orbit-edition aria-label="Alternate edition"></select></label>
        <label data-orbit-season-label hidden>Season<select data-orbit-season aria-label="Alternate season"></select></label>
      </div>
      <p class="orbit-coverage" data-orbit-coverage hidden></p>
      <div class="orbit-status-row">
        <p data-orbit-status aria-hidden="true"></p>
        <button type="button" class="subtle" data-orbit-retry hidden>Retry</button>
      </div>
      <nav class="orbit-pages" data-orbit-pages aria-label="Alternate order pages" hidden>
        <button type="button" class="subtle" data-orbit-previous>Previous</button>
        <span data-orbit-page></span>
        <button type="button" class="subtle" data-orbit-next>Next</button>
      </nav>
      <ol class="orbit-episodes" data-orbit-episodes hidden></ol>
      <ul class="orbit-related" data-orbit-related hidden></ul>
    </section>`;
  const $=selector=>host.querySelector(selector);
  const chooser=$('[data-orbit-view]'),panel=$('[data-orbit-panel]'),heading=$('#orbit-heading'),
    intro=$('[data-orbit-intro]'),source=$('[data-orbit-source]'),controls=$('[data-orbit-controls]'),
    edition=$('[data-orbit-edition]'),seasonLabel=$('[data-orbit-season-label]'),seasonPicker=$('[data-orbit-season]'),
    coverage=$('[data-orbit-coverage]'),live=$('[data-orbit-live]'),status=$('[data-orbit-status]'),
    retry=$('[data-orbit-retry]'),episodes=$('[data-orbit-episodes]'),related=$('[data-orbit-related]'),
    pages=$('[data-orbit-pages]'),pageLabel=$('[data-orbit-page]'),prev=$('[data-orbit-previous]'),next=$('[data-orbit-next]');
  let showId=null,view='original',orderId=null,season,page=1,orders=null,detail=null,relatedData=null,
    pending=null,error=false,notice='',version=0,motion=null;
  const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
  const currentDetail=()=>detail&&detail.order.id===orderId&&detail.season===season&&detail.page===page?detail:null;
  const busy=()=>Boolean(pending);

  function cancel(){
    version++;
    const previous=pending;
    pending=null;
    previous?.controller.abort();
    motion?.cancel();
    motion=null;
  }

  function rowMarkup(row){
    const code=episodeLabel(row),title=row.title||'Episode';
    const originals=Array.isArray(row.canonical)?row.canonical.filter(item=>EPISODE.test(item?.id||'')):[];
    const mapping=!originals.length?'Original episode unavailable':row.split&&row.merged?'Split and merged':
      row.split?'Split episode':row.merged?'Merged episodes':'Original episode';
    const flags=[mapping,row.incomplete&&originals.length?'Incomplete mapping':''].filter(Boolean);
    return '<li class="orbit-episode"><div class="orbit-episode-number"><span>ALTERNATE</span><strong>'+escape(code)+
      '</strong></div><div class="orbit-episode-story"><h4>'+escape(title)+'</h4><p class="orbit-mapping">'+escape(flags.join(' · '))+
      '</p>'+(originals.length?'<ul class="orbit-originals">'+originals.map(item=>{
        const canonical=episodeLabel(item),name=item.title||'Episode';
        return '<li><button type="button" class="orbit-original-button" data-orbit-canonical="'+escape(item.id)+
          '" data-orbit-row="'+escape(row.id)+'" aria-label="View original episode '+escape(canonical+' '+name)+'">'+
          '<span><strong>'+escape(canonical)+'</strong> '+escape(name)+'</span><small>View original episode <span aria-hidden="true">→</span></small></button></li>';
      }).join('')+'</ul>':'')+'</div></li>';
  }

  function relatedMarkup(item){
    const type=item.kind==='movies'?'Film':'Series';
    const direction=item.relation==='follows'?'Comes before':'Follows';
    return '<li><button type="button" class="orbit-related-card" data-orbit-related-id="'+escape(item.id)+'"><span class="orbit-relation">'+direction+
      '</span><strong>'+escape(item.title)+'</strong><span class="orbit-related-meta">'+escape([type,item.year].filter(Boolean).join(' · '))+
      '</span><span class="orbit-related-action">'+(item.kind==='movies'?'View film details':'Open episode guide')+' <span aria-hidden="true">→</span></span></button></li>';
  }

  function render(){
    host.hidden=!showId;
    chooser.value=view;
    panel.hidden=view==='original';
    if(panel.hidden){setText(live,'');return;}
    const showingOrders=view==='orders',current=currentDetail();
    const items=relatedData?.items||[];
    const activeOrder=orders?.find(entry=>entry.id===orderId);
    const orderOptions=showingOrders&&Boolean(orders?.length);
    const activeEdition=showingOrders&&detail?.order.id===orderId?detail:null;
    const seasons=activeEdition?.seasons||[];
    panel.dataset.orbitState=error?'error':busy()?'loading':'ready';
    setText(heading,showingOrders?'Alternate orders':'Related titles');
    setText(intro,showingOrders?'Compare edition numbering with the original episode guide.':
      'Direct connections recorded by Wikidata. Watch order is up to you.');
    setText(source,showingOrders?'TVmaze ↗':'Wikidata ↗');
    source.href=showingOrders?attribution(activeOrder?.sourceUrl,'https://www.tvmaze.com','https://www.tvmaze.com/api#show-alternate-lists'):
      'https://www.wikidata.org/wiki/Wikidata:Main_Page';
    controls.hidden=!orderOptions;
    if(orderOptions){
      updateHTML(edition,orders.map(item=>'<option value="'+escape(item.id)+'">'+escape(item.label)+'</option>').join(''));
      edition.value=String(orderId);
    }
    seasonLabel.hidden=!seasons.length;
    if(seasons.length){
      updateHTML(seasonPicker,seasons.map(item=>'<option value="'+escape(seasonValue(item.number))+'">'+
        escape(seasonName(item.number)+' · '+episodeCount(item.count))+'</option>').join(''));
      seasonPicker.value=seasonValue(season);
    }
    coverage.hidden=!activeEdition;
    if(activeEdition)setText(coverage,activeEdition.coveredCount+' of '+activeEdition.canonicalCount+' original episodes linked across this edition.');
    const display=showingOrders?(current||(busy()?activeEdition:null)):null;
    episodes.hidden=!display?.rows.length;
    episodes.inert=Boolean(display&&!current);
    if(!episodes.hidden)updateHTML(episodes,display.rows.map(rowMarkup).join(''));
    related.hidden=showingOrders||!items.length;
    if(!related.hidden)updateHTML(related,items.map(relatedMarkup).join(''));
    pages.hidden=!(activeEdition?.totalPages>1)&&!pages.contains(document.activeElement);
    if(!pages.hidden){
      setText(pageLabel,busy()&&!current?'Loading page '+page+'…':'Page '+page+' of '+(activeEdition?.totalPages||1));
      prev.setAttribute('aria-disabled',String(busy()||page<=1));
      next.setAttribute('aria-disabled',String(busy()||page>=(activeEdition?.totalPages||1)));
    }
    retry.hidden=!(error||pending?.retry||retry===document.activeElement);
    retry.setAttribute('aria-disabled',String(busy()||!error));
    let message='';
    if(notice)message=notice;
    else if(error)message=showingOrders?'Couldn’t load this episode order. Try again.':'Couldn’t load related titles. Try again.';
    else if(busy())message=showingOrders?'Loading episode order…':'Looking up related titles…';
    else if(showingOrders)message=!orders?.length?'TVmaze has no alternate order for this series.':
      current?.rows.length?episodeCount(current.totalRows,'episode')+' in this season.':'No alternate episodes are listed in this season.';
    else if(items.length)message=episodeCount(items.length,'related title')+(relatedData.partial?' · Some connections couldn’t be verified.':'.');
    else message=relatedData?.partial?'No related titles could be verified. Some connections were unavailable.':
      'No direct related titles are listed.';
    setText(status,message);
    setText(live,message);
  }

  function belongs(result){
    if(result?.showId!==showId)throw Error('Unexpected Story Orbit response.');
  }

  async function load({retrying=false}={}){
    if(!showId||view==='original')return;
    const target=view;
    const task={controller:new AbortController(),retry:retrying};
    pending=task;error=false;notice='';
    render();
    const read=async(type,args={})=>api(ORBIT,{showId,view:type,...args},task.controller.signal);
    try{
      if(target==='related'){
        const data=await read('related');
        if(pending!==task)return;
        belongs(data);
        if(!Array.isArray(data.items))throw Error('Invalid related titles.');
        relatedData={partial:data.partial===true,items:data.items.filter(item=>
          typeof item?.title==='string'&&item.title&&['follows','followed-by'].includes(item.relation)&&
          (item.kind==='tv'&&SHOW.test(item.id||'')||item.kind==='movies'&&FILM.test(item.id||'')))};
      }else{
        if(!orders){
          const data=await read('orders');
          if(pending!==task)return;
          belongs(data);
          if(!Array.isArray(data.orders))throw Error('Invalid order index.');
          orders=data.orders.filter(item=>typeof item?.label==='string'&&item.label&&Number.isSafeInteger(item.id)&&item.id>0);
        }
        if(orders.length){
          if(!orders.some(item=>item.id===orderId)){orderId=orders[0].id;season=undefined;page=1;}
          render();
          const data=await read('order',{orderId,...(season===undefined?{}:{season}),page});
          if(pending!==task)return;
          belongs(data);
          if(data.order?.id!==orderId||!Array.isArray(data.rows)||!Array.isArray(data.seasons)||
            ![data.page,data.totalPages,data.totalRows,data.coveredCount,data.canonicalCount].every(value=>Number.isSafeInteger(value)&&value>=0)||
            data.page<1||data.totalPages<data.page||asSeason(data.season)===undefined||
            data.seasons.some(item=>asSeason(item?.number)===undefined||!Number.isSafeInteger(item.count))||
            data.rows.some(item=>!Number.isSafeInteger(item?.id)||!Array.isArray(item.canonical)))
            throw Error('Invalid alternate order.');
          detail=data;
          season=data.season;page=data.page;
        }
      }
    }catch{
      if(pending===task)error=true;
    }finally{
      if(pending===task){pending=null;render();}
    }
  }

  function changeView(nextView,{animate=false}={}){
    cancel();
    view=nextView;error=false;notice='';
    onViewChange(view);
    const shouldLoad=view==='related'&&!relatedData||view==='orders'&&(!orders||orders.length&&!currentDetail());
    const work=shouldLoad?load():(render(),undefined);
    if(animate&&view!=='original'&&!matchMedia('(prefers-reduced-motion: reduce)').matches)
      motion=panel.animate([{opacity:.72,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],
        {duration:155,easing:'ease-out'});
    return work;
  }

  function reset(id){
    showId=typeof id==='string'&&SHOW.test(id)?id:null;
    orders=null;detail=null;relatedData=null;orderId=null;season=undefined;page=1;
    changeView('original');
  }

  function showOriginal(){changeView('original');}
  function getState(){return {showId,view,orderId,season,page};}
  async function restore(state,{focusRelatedId}={}){
    if(!showId||state?.showId!==showId||!VIEWS.includes(state.view))return false;
    orderId=Number.isSafeInteger(state.orderId)&&state.orderId>0?state.orderId:null;
    season=asSeason(state.season);
    page=Number.isSafeInteger(state.page)&&state.page>0?state.page:1;
    const work=changeView(state.view),captured=version;
    await work;
    if(captured!==version||host.hidden||!host.isConnected||host.closest('dialog:not([open])'))return undefined;
    if(!focusRelatedId)return true;
    const button=[...related.querySelectorAll('[data-orbit-related-id]')].find(node=>node.dataset.orbitRelatedId===focusRelatedId);
    if(view!=='related'||related.hidden||!button)return false;
    button.focus({preventScroll:true});
    return true;
  }

  function reload(){cancel();void load();}
  chooser.addEventListener('change',()=>{if(VIEWS.includes(chooser.value))void changeView(chooser.value,{animate:true});});
  edition.addEventListener('change',()=>{
    const selected=Number(edition.value);
    if(!orders?.some(item=>item.id===selected)||orderId===selected)return;
    orderId=selected;season=undefined;page=1;reload();
  });
  seasonPicker.addEventListener('change',()=>{
    const selected=seasonPicker.value===UNKNOWN?null:Number(seasonPicker.value);
    if(!detail?.seasons.some(entry=>entry.number===selected)||selected===season)return;
    season=selected;page=1;reload();
  });
  prev.addEventListener('click',()=>{if(prev.getAttribute('aria-disabled')==='false'){page--;reload();}});
  next.addEventListener('click',()=>{if(next.getAttribute('aria-disabled')==='false'){page++;reload();}});
  retry.addEventListener('click',()=>{if(error&&!busy()){cancel();void load({retrying:true});}});
  retry.addEventListener('blur',()=>{if(!error&&!pending?.retry)retry.hidden=true;});
  pages.addEventListener('focusout',event=>{
    if(!pages.contains(event.relatedTarget)&&!(detail?.totalPages>1))pages.hidden=true;
  });
  episodes.addEventListener('click',event=>{
    const button=event.target.closest('[data-orbit-canonical]');
    if(!button)return;
    const row=currentDetail()?.rows.find(entry=>String(entry.id)===button.dataset.orbitRow);
    const original=row?.canonical?.find(entry=>entry.id===button.dataset.orbitCanonical);
    if(original&&onCanonical(original.id,{orderLabel:detail.order.label,alternateLabel:episodeLabel(row),
      canonicalLabel:episodeLabel(original)})===false){
      notice='This original episode has changed. Stay here or return to the original guide.';
      render();
    }
  });
  related.addEventListener('click',event=>{
    const button=event.target.closest('[data-orbit-related-id]');
    const item=button&&relatedData?.items.find(entry=>entry.id===button.dataset.orbitRelatedId);
    if(item)onRelated(item);
  });

  host.hidden=true;
  return {reset,getState,restore,showOriginal,cancel};
}

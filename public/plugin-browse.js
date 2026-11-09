import {updateHTML,updateKeyedList} from './dom.js';

const BROWSE='/api/plugins/browse';
const POLL_MS=1500,MAX_SOURCE_AGE=60*60*1000;
const overview={id:'all',name:'Overview',category:'all',collection:'',group:'overview'};
const isWorking=state=>['loading','finding-sources'].includes(state?.status);
const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
const dateLabel=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
const checkLabel=new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const dateOnly=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?Date.parse(value+'T00:00:00Z'):NaN;
const seenRecently=(source,now)=>typeof source?.key==='string'&&Boolean(source.key)&&
  Number.isFinite(source.seenAt)&&source.seenAt>0&&source.seenAt<=now&&now-source.seenAt<MAX_SOURCE_AGE;
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const countLabel=new Intl.NumberFormat();
const sizeLabel=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});

function reportedNumber(value){
  if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}
function reportedSize(value){
  const size=reportedNumber(value);
  if(size===null)return 'Unknown';
  const unit=size<1024?0:Math.min(4,Math.floor(Math.log2(size)/10));
  return sizeLabel.format(size/1024**unit)+' '+['B','KiB','MiB','GiB','TiB'][unit];
}
function httpsLink(value){
  try{
    const url=new URL(value);
    if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;
  }catch{}
  return '';
}
function namedFormat(file){
  const codec=file.match(/\b([xh][ ._-]?26[45]|AVC|HEVC|AV1|VP9|XviD|DivX)\b/i)?.[1].toUpperCase().replace(/[ ._-]/g,'');
  const container=file.match(/\.(mkv|mp4|webm|avi|m4v|mov|flac|mp3|epub|pdf)$/i)?.[1].toUpperCase();
  const format={X264:'H.264',H264:'H.264',AVC:'H.264',X265:'H.265',H265:'H.265',HEVC:'H.265'};
  return [format[codec]||codec,container].filter(Boolean).join(' · ');
}

export function createPluginBrowser({api,escape,onAdd,onPlay,onSearch,onRemember}){
  const $=selector=>document.querySelector(selector);
  const guide=$('#plugin-browse'),grid=$('#sources-grid'),category=$('#plugin-browse-category'),
    period=$('#plugin-browse-period'),periodField=$('#plugin-browse-period-field'),title=$('#plugin-browse-title'),
    description=$('#plugin-browse-description'),status=$('#plugin-browse-status'),retry=$('#plugin-browse-retry'),
    refresh=$('#plugin-browse-refresh'),results=$('#plugin-browse-results'),pager=$('#plugin-browse-pages'),
    pageLabel=$('#plugin-browse-page-label'),previous=$('#plugin-browse-previous'),next=$('#plugin-browse-next');
  let name='',selectedId='all',preferredPeriod='week',choices=[overview],page=1,state=null,run=null,
    timer=null,pending=null,failure=null,notice='',origin=null,motion=null;
  let pageModel=null,cards=new Map();
  const adding=new Set();

  function selected(){return choices.find(item=>item.id===selectedId)||overview;}
  function canChoosePeriod(){
    return selected().group==='media'||selectedId==='all'&&choices.some(item=>item.group==='media');
  }
  function requestScope(){
    const choice=selected();
    return {name,category:choice.category,collection:choice.collection||'',
      period:canChoosePeriod()?preferredPeriod:'week',page};
  }
  function echoes(result,scope){
    return result?.pluginName===scope.name&&result.category===scope.category&&
      (result.collection||'')===scope.collection&&result.period===scope.period&&result.requestedPage===scope.page;
  }
  function params(scope,passive){
    const query=new URLSearchParams({name:scope.name,category:scope.category,period:scope.period,page:String(scope.page)});
    if(scope.collection)query.set('collection',scope.collection);
    if(passive)query.set('poll','1');
    return query;
  }
  function cancel(){
    clearTimeout(timer);timer=null;
    const old=run;
    run=null;pending=null;
    old?.controller.abort();
    motion?.cancel();motion=null;
  }

  function updateSelectors(){
    const groups=[['Media','media'],['Misc','misc']];
    const options=group=>choices.filter(item=>item.group===group&&item.id!=='all').map(item=>
      '<option value="'+escape(item.id)+'">'+escape(item.name)+'</option>').join('');
    updateHTML(category,'<option value="all">Overview</option>'+groups.map(([label,key])=>{
      const markup=options(key);
      return markup?'<optgroup label="'+label+'">'+markup+'</optgroup>':'';
    }).join(''));
    category.value=selectedId;
    period.value=preferredPeriod;
    periodField.hidden=!canChoosePeriod();
  }

  function sourceLabel(row){
    if(row.topic)return '<p class="plugin-provenance">Topic suggestions</p>';
    const start=dateOnly(row.periodStart),end=dateOnly(row.periodEnd),published=dateOnly(row.publishedAt);
    const date=Number.isFinite(start)&&Number.isFinite(end)&&start<=end?dateLabel.formatRange(start,end):
      Number.isFinite(end)?dateLabel.format(end):Number.isFinite(start)?dateLabel.format(start):'';
    const href=httpsLink(row.sourceUrl||row.sourceUrls?.[0]);
    const source=typeof row.source==='string'&&row.source?row.source:'';
    const provenance=[row.periodLabel,date].filter(Boolean).map(escape);
    if(source)provenance.push(href?'<a href="'+escape(href)+'" target="_blank" rel="noopener noreferrer">'+escape(source)+' ↗</a>':escape(source));
    if(Number.isFinite(published))provenance.push('Published '+escape(dateLabel.format(published)));
    if(row.stale||row.chartState==='stale')provenance.push('<span class="plugin-stale">Saved chart</span>');
    return provenance.length?'<p class="plugin-provenance">'+provenance.join(' <span aria-hidden="true">·</span> ')+'</p>':'';
  }
  function sampleMarkup(row){
    const evidence=row.evidence||{},total=number(evidence.total),matched=number(evidence.matched);
    if(!total)return '';
    const counts=[['noMatch','without a seeded match'],['pending','pending'],['unavailable','unavailable'],['upcoming','upcoming']]
      .flatMap(([key,label])=>number(evidence[key])?[number(evidence[key])+' '+label]:[]);
    const checked=evidence.checkedAt;
    const last=Number.isFinite(checked)&&checked>0?'<span class="plugin-check-date">Latest check '+escape(checkLabel.format(checked))+'</span>':'';
    return '<div class="plugin-sample"><strong>'+matched+' of '+total+' suggestions returned a seeded match</strong>'+
      (counts.length?'<span>'+counts.join(' · ')+'</span>':'')+last+'</div>';
  }
  function resultSummary(available,sources){
    const timeout=available.timedOut===true||available.reason==='timeout'||available.provenance==='timeout';
    if(sources.length)return timeout?'Seeded choices found before the check timed out.':
      sources.length+(sources.length===1?' seeded choice':' seeded choices');
    if(timeout)return 'This check timed out.';
    if(available.status==='upcoming')return 'Upcoming title. Check after it premieres.';
    if(['idle','queued','searching','pending'].includes(available.status)||!available.status)return 'Checking for seeded choices…';
    if(available.status==='no-match')return 'No seeded match in the returned results.';
    return available.reason==='plugin-changed'?'The plugin changed during this check.':'This check was unavailable.';
  }
  function releaseMarkup(source,item,cardKey,index){
    const file=typeof source.fileName==='string'&&source.fileName?source.fileName:'Release';
    const label=source.existingHash?'Open':item.topic?'Add':'Watch';
    const attrs=source.existingHash?'data-plugin-play="'+escape(source.existingHash)+'"':
      'data-plugin-add="'+escape(source.key||'')+'"';
    const seeds=reportedNumber(source.nbSeeders),leechers=reportedNumber(source.nbLeechers);
    const format=[source.streaming?.resolution,namedFormat(file)].filter(Boolean).join(' · ');
    const provider=state?.plugin?.fullName||source.engineName||name;
    const date=reportedNumber(source.pubDate),published=date>0&&date<=8.64e12?dateLabel.format(date*1000):'';
    const listing=httpsLink(source.descrLink);
    const facts=[['Seeders',seeds===null?'Unknown':countLabel.format(seeds)],
      ['Leechers',leechers===null?'Unknown':countLabel.format(leechers)],['Size',reportedSize(source.fileSize)]];
    return '<div class="plugin-release"><div><strong>'+escape(source.existingHash?'In your library':index===0?'Recommended choice':'Choice '+(index+1))+
      '</strong><p class="plugin-release-name">'+escape(file)+'</p>'+
      '<dl class="plugin-release-facts" aria-label="Reported release details">'+facts.map(([label,value])=>
        '<div><dt>'+label+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl>'+
      (format?'<p class="plugin-release-format">'+escape('From release name: '+format)+'</p>':'')+
      '<p class="plugin-release-provider">'+escape([provider,published].filter(Boolean).join(' · '))+
      (listing?' <a href="'+escape(listing)+'" target="_blank" rel="noopener noreferrer" aria-label="'+
        escape('Release listing for '+file)+'">Listing <span aria-hidden="true">↗</span></a>':'')+'</p></div>'+
      '<button type="button" class="'+(index===0?'primary':'subtle')+'" '+attrs+' data-item="'+escape(cardKey)+
      '" aria-label="'+escape(label+' '+file)+'" aria-disabled="'+String(Boolean(!source.existingHash&&(failure?.reload||source.key&&adding.has(source.key))))+'">'+label+'</button></div>';
  }
  function cardMarkup(item,cardKey,expanded){
    const available=item.availability||{},sources=Array.isArray(available.sources)?available.sources:[];
    const poster=typeof item.posterUrl==='string'&&item.posterUrl.startsWith('/api/metadata/poster?')?
      '<img src="'+escape(item.posterUrl)+'" alt="" width="51" height="74" loading="lazy" decoding="async">':'';
    const type=item.topic?'Topic suggestion':item.kind==='movies'?'Film':item.kind==='anime'?'Anime':item.kind==='korean'?'Korean drama':'Series';
    return '<article class="plugin-pick"><div class="plugin-pick-title"><span class="plugin-pick-art" aria-hidden="true">'+
      '<svg class="cinema-icon"><use href="#ico-film"/></svg>'+poster+'</span><div><h3>'+escape(item.title)+
      '</h3><p>'+escape([item.year,type].filter(Boolean).join(' · '))+'</p></div></div>'+
      '<p class="plugin-card-state">'+escape(resultSummary(available,sources))+'</p>'+
      (sources.length?'<details class="plugin-choices" data-plugin-choice="'+escape(cardKey)+'"'+(expanded?' open':'')+
      '><summary data-plugin-choice-summary="'+escape(cardKey)+'">'+(item.topic?'Release choices':'Watch options')+
      '</summary>'+sources.map((source,index)=>releaseMarkup(source,item,cardKey,index)).join('')+'</details>':'')+
      '<button class="text-button plugin-manual-search" type="button" data-plugin-more="'+escape(cardKey)+
      '" aria-label="'+escape('Search all releases from this plugin for '+item.title)+'">'+
      'Search all releases from this plugin <span aria-hidden="true">→</span></button></article>';
  }
  function renderRows(rows){
    const expanded=new Set([...results.querySelectorAll('[data-plugin-choice][open]')].map(detail=>detail.dataset.pluginChoice));
    cards=new Map();
    if(!rows.length){
      const heading=state?'No suggestions on this page':'Getting this page ready';
      const copy=state?'Choose a category, or open a search in this plugin.':'Cinema is looking up suggestions for this plugin.';
      updateHTML(results,'<div class="plugin-guide-empty"><h3>'+heading+'</h3><p>'+copy+'</p>'+
        (state?'<button class="subtle" type="button" data-plugin-empty-search>Open scoped search</button>':'')+'</div>');
      return;
    }
    updateKeyedList(results,rows.map(row=>{
      const key=String(row.browseId||row.id),items=row.items||[];
      const availableChoice=selectedId==='all'&&choices.some(choice=>choice.id===key&&choice.id!=='all');
      const chartMessage=row.chartState==='unavailable'?'This chart is unavailable for the selected period.':
        row.chartState==='empty'?'No verified titles are listed for this period.':'No suggestions are listed for this category.';
      const markup='<section class="plugin-shelf"><div class="plugin-shelf-heading"><div><h3>'+escape(row.title)+
        '</h3>'+sourceLabel(row)+'</div>'+(availableChoice?'<button class="subtle" type="button" data-plugin-catalog="'+escape(key)+
          '" aria-label="Explore '+escape(row.title)+' category">Explore category</button>':'')+'</div>'+sampleMarkup(row)+
        (items.length?'<div class="plugin-picks">'+items.map((item,index)=>{
          const cardKey=key+'::'+String(item.id??index);
          cards.set(cardKey,item);
          return cardMarkup(item,cardKey,expanded.has(cardKey));
        }).join('')+'</div>':'<div class="plugin-guide-empty"><p>'+chartMessage+
          '</p><button class="subtle" type="button" data-plugin-empty-search>Open scoped search</button></div>')+'</section>';
      return {key,signature:markup,html:()=>markup};
    }));
  }
  function render(){
    if(guide.hidden)return;
    updateSelectors();
    setText(title,state?.plugin?.fullName||state?.plugin?.name||name);
    setText(description,'Browse suggested searches from charts and topics. This plugin supplies the release results and reports their availability.');
    const rows=Array.isArray(state?.rows)?state.rows:[];
    renderRows(rows);
    if(selectedId!=='all'&&rows[0])pageModel=rows[0];
    const showPages=selectedId!=='all'&&number(pageModel?.totalPages)>1;
    pager.hidden=!showPages&&!pager.contains(document.activeElement);
    if(!pager.hidden){
      const shown=rows[0]?.page||page;
      setText(pageLabel,'Page '+shown+' of '+(pageModel?.totalPages||1)+
        (pageModel?.totalItems?' · '+pageModel.totalItems+' suggestions':''));
      previous.setAttribute('aria-disabled',String(!state||shown<=1));
      next.setAttribute('aria-disabled',String(!state||shown>=(pageModel?.totalPages||1)));
    }
    refresh.setAttribute('aria-disabled',String(Boolean(pending?.method==='recheck'||!state&&!failure)));
    retry.hidden=!(failure||pending?.retry||retry===document.activeElement);
    retry.setAttribute('aria-disabled',String(!failure||Boolean(pending)));
    if(failure)setText(retry,failure.label);
    const done=number(state?.sourceProgress?.done),total=number(state?.sourceProgress?.total);
    const count=rows.reduce((sum,row)=>sum+(row.items?.length||0),0);
    const warning=(state?.warnings||[]).find(value=>typeof value==='string'&&value);
    setText(status,notice||failure?.message||(!state||state.status==='loading'?'Looking up suggestions…':
      state.status==='finding-sources'?'Checking this page · '+done+' of '+total+' checked':
      state.status==='error'?(warning||'This page couldn’t load. Recheck or choose a different category.'):
      count?count+(count===1?' suggestion':' suggestions')+' on this page.':warning||'This page has no suggestions.'));
  }

  async function request(current,method,{retrying=false}={}){
    if(run!==current||guide.hidden)return;
    const task={method,retry:retrying};
    pending=task;failure=null;
    if(method!=='poll')notice='';
    render();
    const scope=current.scope;
    try{
      const data=method==='recheck'?
        await api(BROWSE+'/refresh',{...scope,...(!scope.collection?{collection:undefined}:{})},false,current.controller.signal):
        await api(BROWSE+'?'+params(scope,method==='poll'),undefined,false,current.controller.signal);
      if(run!==current||pending!==task)return;
      if(!echoes(data,scope))throw Object.assign(Error('This page changed while it was loading.'),{status:409});
      state=data;
      if(Array.isArray(data.browseCategories)){
        const valid=data.browseCategories.filter(item=>item&&typeof item.id==='string'&&typeof item.name==='string'&&
          typeof item.category==='string'&&['overview','media','misc'].includes(item.group));
        choices=[overview,...valid.filter(item=>item.id!=='all')];
      }
    }catch(error){
      if(run!==current||pending!==task||current.controller.signal.aborted)return;
      const reload=method==='poll'&&error?.status===409;
      const connection=method==='poll'||!error?.status;
      failure={method,reload,label:reload?'Reload this page':connection?'Retry connection':'Try again',
        message:reload?'This page is no longer active. Reload it to check again.':
          connection?'Couldn’t refresh this page. Retry the connection.':error.message||'This page couldn’t load.'};
    }finally{
      if(run!==current||pending!==task)return;
      pending=null;
      if(!failure&&retrying&&retry===document.activeElement)title.focus({preventScroll:true});
      render();
      if(!failure&&isWorking(state))timer=setTimeout(()=>{timer=null;void request(current,'poll');},POLL_MS);
    }
  }

  function load(method='open',{keepPager=false,retrying=false}={}){
    cancel();
    state=null;failure=null;notice='';
    if(!keepPager)pageModel=null;
    const current=run={scope:requestScope(),controller:new AbortController()};
    void request(current,method,{retrying});
  }
  function choose(id){
    if(id===selectedId||!choices.some(item=>item.id===id))return;
    selectedId=id;page=1;load();
  }
  function animateEntry(){
    if(!matchMedia('(prefers-reduced-motion: reduce)').matches)
      motion=guide.animate([{opacity:.72,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],
        {duration:155,easing:'ease-out'});
  }
  function open(plugin,trigger){
    if(typeof plugin!=='string'||!plugin)return;
    name=plugin;origin=trigger||null;selectedId='all';preferredPeriod='week';choices=[overview];page=1;
    guide.hidden=false;grid.hidden=true;
    load();animateEntry();
    title.focus({preventScroll:true});
    guide.scrollIntoView({block:'nearest',behavior:'instant'});
  }
  function close({restoreFocus=false}={}){
    const previousName=name,saved=origin;
    cancel();name='';state=null;failure=null;notice='';cards.clear();origin=null;
    guide.hidden=true;grid.hidden=false;
    if(restoreFocus){
      const target=saved?.isConnected?saved:[...grid.querySelectorAll('[data-browse-plugin]')]
        .find(button=>button.dataset.browsePlugin===previousName)||$('#plugin-filter');
      target?.focus({preventScroll:true});
      target?.scrollIntoView({block:'nearest',behavior:'instant'});
    }
  }
  function expired(){
    notice='This choice has expired. Recheck this page for current choices.';
    render();refresh.focus({preventScroll:true});
  }
  async function add(button){
    const current=run,item=cards.get(button.dataset.item);
    const key=button.dataset.pluginAdd,source=item?.availability?.sources?.find(entry=>String(entry.key||'')===key);
    if(!item||adding.has(key)||failure?.reload)return;
    if(!seenRecently(source,Date.now())){expired();return;}
    if(!item.topic)onRemember(item);
    adding.add(key);render();
    try{
      const reply=await onAdd(key,item.nativeCategory||selected().category);
      if(run===current&&reply?.expired)expired();
    }catch(error){
      if(run===current){if(error?.expired)expired();else{notice='Couldn’t open this choice. Try again.';render();}}
    }finally{
      adding.delete(key);
      if(run===current)render();
    }
  }
  function turnPage(delta,button){
    if(button.getAttribute('aria-disabled')!=='false')return;
    page=(state?.rows?.[0]?.page||page)+delta;
    load('open',{keepPager:true});
  }

  $('#plugin-browse-back').addEventListener('click',()=>close({restoreFocus:true}));
  category.addEventListener('change',()=>choose(category.value));
  period.addEventListener('change',()=>{
    if(!['week','month'].includes(period.value)||!canChoosePeriod())return;
    preferredPeriod=period.value;page=1;load();
  });
  refresh.addEventListener('click',()=>{if(name&&refresh.getAttribute('aria-disabled')==='false')load('recheck',{keepPager:true});});
  retry.addEventListener('click',()=>{
    if(!failure||pending||!run)return;
    if(failure.reload)load('open',{keepPager:true,retrying:true});
    else void request(run,failure.method,{retrying:true});
  });
  retry.addEventListener('blur',()=>{if(!failure&&!pending?.retry)retry.hidden=true;});
  previous.addEventListener('click',()=>turnPage(-1,previous));
  next.addEventListener('click',()=>turnPage(1,next));
  pager.addEventListener('focusout',event=>{
    if(!pager.contains(event.relatedTarget)&&!(number(pageModel?.totalPages)>1))pager.hidden=true;
  });
  grid.addEventListener('click',event=>{
    const button=event.target.closest('[data-browse-plugin]');
    if(button&&!button.disabled)open(button.dataset.browsePlugin,button);
  });
  results.addEventListener('click',event=>{
    const browse=event.target.closest('[data-plugin-catalog]'),addButton=event.target.closest('[data-plugin-add]'),
      play=event.target.closest('[data-plugin-play]'),more=event.target.closest('[data-plugin-more]');
    if(browse){choose(browse.dataset.pluginCatalog);category.focus({preventScroll:true});}
    else if(addButton)void add(addButton);
    else if(play&&cards.get(play.dataset.item)?.availability?.sources?.some(source=>source.existingHash===play.dataset.pluginPlay))
      void onPlay(play.dataset.pluginPlay);
    else if(more){const item=cards.get(more.dataset.pluginMore);if(item)onSearch(item,name);}
    else if(event.target.closest('[data-plugin-empty-search]'))onSearch({nativeCategory:selected().category,title:''},name);
  });
  results.addEventListener('error',event=>{if(event.target.matches?.('.plugin-pick-art img'))event.target.remove();},true);
  return {open,close,invalidateHash(hash){
    for(const item of cards.values())for(const source of item.availability?.sources||[])
      if(source.existingHash===hash)delete source.existingHash;
    if(!guide.hidden)render();
  }};
}

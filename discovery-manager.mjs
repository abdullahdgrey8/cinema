import {magnetHashes,torrentIdentity,validReleaseLink,nonVideoRelease} from './lib.mjs';
import {streamingHint} from './release-streaming.mjs';
import {setTimeout as wait} from 'node:timers/promises';

const norm=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[._]/g,' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const ROW_IDS=['movies','new-movies','tv','korean','anime'];
// Rank release candidates, not content quality or authenticity. Seed counts are
// provider estimates; the client labels the ranking and offers alternatives.
export function rankSources(results,item,{preferStream=false}={}) {
  const phrase=norm(item.title),words=phrase.split(' ').filter(Boolean), unique=new Map();
  for(const row of results||[]) {
    if(typeof row?.fileName!=='string'||!validReleaseLink(row.fileUrl)||
      !item.topic&&['movies','tv','korean','anime'].includes(item.kind)&&nonVideoRelease(row.fileName))continue;
    if(/api key|configuration error|password protected|\b(?:CAM|HDCAM|CAMRip|TSRip|telesync|HDTS|TS|TELES|HDTC|TC)\b/i.test(row.fileName))continue;
    if(['trailer','sample','featurette','extras'].some(word=>!words.includes(word)&&new RegExp(`\\b${word}\\b`,'i').test(row.fileName)))continue;
    const name=norm(row.fileName),tokens=new Set(name.split(' '));
    if(!words.length||!words.every(word=>tokens.has(word)))continue;
    if(!item.topic&&!(` ${name} `).includes(` ${phrase} `))continue;
    const series=item.kind==='tv';
    const film=item.kind==='movies'&&!item.topic;
    const leading=norm(String(row.fileName).replace(/^(?:\s*\[[^\]]+\])+\s*/,''));
    // Avoid promoting a different title that contains the chart title's words.
    if((series||film)&&!(leading===phrase||leading.startsWith(phrase+' ')))continue;
    if(series){const suffix=leading.slice(phrase.length).trim();if(suffix&&!/^(?:(?:19|20)\d{2}|s\d{1,2}(?:e\d{1,3})?|\d{1,2}x\d{2}|season(?:s)?|complete|the complete|all seasons|collection|(?:2160|1080|720|480)p|english|german|korean|japanese|multi|dual|bluray|web|webrip|webdl|hdtv|dvdrip|proper|repack|netflix)(?:\s|$)/i.test(suffix))continue;}
    if(film){
      const suffix=leading.slice(phrase.length).trim();
      if(suffix&&!/^(?:(?:18|19|20)\d{2}|(?:2160|1080|720|480)p|4k|uhd|bluray|blu ray|web|webdl|webrip|hdtv|dvdrip|remux|proper|repack|uncut|extended|remastered|directors cut|h ?26[45]|x26[45]|hevc|avc|av1|mkv|mp4|avi)(?:\s|$)/i.test(suffix))continue;
      if(/\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{2}\b/i.test(row.fileName))continue;
    }
    const titlePosition=name.indexOf(phrase);
    const releaseSuffix=titlePosition>=0?name.slice(titlePosition+phrase.length):name;
    const year=releaseSuffix.match(/\b(?:18|19|20)\d{2}\b/)?.[0];
    if(item.kind==='movies'&&item.year&&year&&Number(year)!==Number(item.year))continue;
    const seeds=Math.max(0,Number(row.nbSeeders)||0);if(!seeds)continue;
    if(!item.topic&&Number(row.fileSize)>0&&Number(row.fileSize)<30*1024*1024)continue;
    const streamFriendly=/\b(?:x264|H[. ]?264|AVC)\b|\.mp4\b/i.test(row.fileName);
    const playbackScore=preferStream?streamingHint(row,item.kind).score:
      Math.log2(seeds+1)*10+(/\b1080p\b/i.test(row.fileName)?4:/\b720p\b/i.test(row.fileName)?3:0)+(streamFriendly?3:0);
    const score=playbackScore+(year&&Number(year)===Number(item.year)?2:0);
    let sequenceTier=0;
    if(series){const episode=/\bS(\d{1,2})[ ._-]*E(\d{1,3})\b|\b(\d{1,2})x(\d{2})\b/i.exec(row.fileName);const season=/\bS(\d{1,2})\b|\bseason\s*(\d{1,2})\b/i.exec(row.fileName);
      sequenceTier=/complete\s+(?:series|collection)|all\s+seasons/i.test(row.fileName)?0:season&&Number(season[1]||season[2])===1&&!episode?1:episode&&Number(episode[1]||episode[3])===1&&Number(episode[2]||episode[4])===1?2:4;
    }
    const key=torrentIdentity(row.fileUrl),previous=unique.get(key);
    const candidate={...row,score,streamFriendly,sequenceTier};if(!previous||candidate.score>previous.score)unique.set(key,candidate);
  }
  const ranked=[...unique.values()].sort((a,b)=>a.sequenceTier-b.sequenceTier||b.score-a.score||b.nbSeeders-a.nbSeeders),deduplicated=[];
  for(const row of ranked){if(deduplicated.some(prior=>norm(prior.fileName)===norm(row.fileName)&&Math.abs(Number(prior.fileSize)-Number(row.fileSize))<10*1024*1024))continue;deduplicated.push(row);if(deduplicated.length===4)break;}return deduplicated;
}

export function createDiscovery({qb,metadata,registerResult,pluginName=null,pluginSignature=null,sourceCache=new Map(),sourceTimeoutMs=25000,pollMs=1800,workers=2,pageSize=8,now=Date.now}) {
  pageSize=Math.max(1,Math.min(24,Number(pageSize)||8));
  let state={status:'idle',rows:[],warnings:[],updatedAt:null,sourceProgress:{done:0,total:0}},running=null,requested=false,closed=false,generation=0,generationSignal=new AbortController(),catalogLoad=null,focusedItem=null;
  const liveJobs=new Set(),pluginAvailability=new WeakMap();
  let pluginRecheck=0,lastRun=0,request={period:'week',pages:{}},signature='',catalog=null,forceCatalog=false,reloadCatalog=false,catalogRevision=Number(metadata.discoveryRevision)||0;
  function options(value={}){
    const period=value.period??'week';if(!['week','month'].includes(period))throw Object.assign(Error('Choose this week or this month.'),{status:400});
    const category=value.category??'all';if(!['all','movies','tv','korean','anime'].includes(category))throw Object.assign(Error('Choose a discovery category.'),{status:400});
    const pages={};for(const id of ROW_IDS){const n=Number(value[id+'Page']??value.pages?.[id]??1);if(!Number.isInteger(n)||n<1||n>10000)throw Object.assign(Error('Choose a valid discovery page.'),{status:400});pages[id]=n;}
    const page=Number(value.page??1);if(!Number.isInteger(page)||page<1||page>10000)throw Object.assign(Error('Choose a valid discovery page.'),{status:400});
    const onDemand=value.mode==='on-demand',focus=onDemand?String(value.focus||''):'';
    if(focus&&!/^[a-z0-9-]{1,100}$/i.test(focus))throw Object.assign(Error('Choose a valid discovery title.'),{status:400});
    return {period,category,pages,page,onDemand,focus};
  }
  function catalogItem(id){
    for(const row of catalog?.rows||[]){
      const item=row.items.find(candidate=>candidate.id===id);
      if(item)return item;
    }
    return null;
  }
  function selectedItem(){
    return request.focus&&(catalogItem(request.focus)||focusedItem?.id===request.focus&&focusedItem)||null;
  }
  function publicItem(item){
    const observed=!pluginName||pluginAvailability.get(item)===generation?item.availability:null;
    const availability=observed||(item.upcoming?{status:'upcoming',sources:[],message:'Episode sources can be checked after the premiere.'}:{status:request.onDemand?'idle':'queued',sources:[],message:request.onDemand?'Open this title to check for a release.':'Waiting to check your plugins…'});
    return {...item,availability:{...availability,sources:pluginName?(availability.sources||[]):(availability.sources||[]).map(source=>registerResult(source,{category:item.nativeCategory||item.kind,plugins:[]}))}};
  }
  function projectedRows(){
    return (catalog?.rows||[]).filter(row=>!request.onDemand||request.category==='all'||request.category===(row.category||row.id)).map(row=>{
      const totalItems=row.items.length,totalPages=Math.max(1,Math.ceil(totalItems/pageSize)),page=Math.min(request.pages[row.id]||request.page||1,totalPages);
      const items=row.items.slice((page-1)*pageSize,page*pageSize).map(publicItem);
      return {...row,items,page,pageSize,totalItems,totalPages,hasNext:page<totalPages,hasPrevious:page>1};
    });
  }
  function snapshot(){
    const item=selectedItem();
    return {...state,period:request.period,rows:projectedRows(),...(item?{selectedItem:publicItem(item)}:{})};
  }
  async function lookup(item,plugins,gen,signal,onProgress) {
    const category=item.nativeCategory||(item.kind==='movies'?'movies':item.kind==='anime'?'anime':'tv');
    const broad=request.onDemand&&!item.nativeCategory;
    const supported=plugins.filter(p=>p.enabled&&p.supportedCategories?.some(c=>c.id===category));
    const chosen=broad?plugins.filter(p=>p.enabled):supported.length?supported:
      plugins.filter(p=>p.enabled&&p.supportedCategories?.some(c=>c.id==='all'));
    if(!chosen.length)return {status:'unavailable',message:'No enabled plugins support this title category.',sources:[]};
    const queryCategory=broad||!supported.length?'all':category;
    const cacheKey=`${item.id}:${item.year||''}:${category}:${queryCategory}:${chosen.map(p=>p.name).join('|')}`,cached=sourceCache.get(cacheKey);
    if(cached&&now()-cached.at<30*60*1000)return {...cached.result,cached:true};
    const sourceOptions=results=>rankSources(results,item,{preferStream:broad}).map(row=>registerResult(row,{category,plugins:chosen}))
      .sort((a,b)=>a.sequenceTier-b.sequenceTier||(b.streaming?.score??b.score)-(a.streaming?.score??a.score));
    let id,sources=[];
    try {
      const job=await qb('search/start',{pattern:`${item.title}${item.kind==='movies'&&item.year?' '+item.year:''}`.slice(0,180),category:queryCategory,plugins:chosen.map(p=>p.name).join('|')},'POST');id=String(job.id);liveJobs.add(id);
      let complete=false,deadline=now()+sourceTimeoutMs,progressShown=false;
      const rows=new Map();
      while(!closed&&gen===generation&&now()<deadline) {
        const result=await qb('search/results',{id,limit:broad?500:300,offset:0});
        for(const row of result.results||[])if(row?.fileUrl)rows.set(row.fileUrl,row);
        sources=sourceOptions([...rows.values()]);
        if(result.status!=='Running'){complete=true;break;}
        if(onProgress&&!progressShown&&gen===generation&&sources.length){
          progressShown=true;onProgress({status:'searching',message:'Sources found. Cinema is checking for more options.',sources});
        }
        await wait(pollMs,undefined,{signal});
      }
      if(closed||gen!==generation)return {status:'cancelled',sources:[]};
      const message=sources.length?(complete?'Matched releases ranked for playback readiness.':'Some plugins were still checking. The releases found so far are available.'):
        complete?'No matching seeded release found in the selected sources.':'The source check timed out before a matching seeded release was found.';
      const output={status:sources.length?'ready':'unavailable',message,sources,checkedAt:now(),partial:!complete};
      if(complete){sourceCache.set(cacheKey,{at:now(),result:output});if(sourceCache.size>200)sourceCache.delete(sourceCache.keys().next().value);}
      return output;
    }catch(e){return signal.aborted?{status:'cancelled',sources:[]}:
      sources.length?{status:'ready',message:'The source check was interrupted. The releases found so far are available.',sources,partial:true}:
      {status:'error',message:e.message,sources:[]};}
    finally{if(id){liveJobs.delete(id);await qb('search/stop',{id},'POST').catch(()=>{});await qb('search/delete',{id},'POST').catch(()=>{});}}
  }
  const pluginChanged='The enabled plugin or its categories changed. Reload this view or choose another plugin.';
  const cancelled=()=>({status:'cancelled',sources:[]});
  const currentPluginRun=run=>!closed&&run.valid&&run.gen===generation&&!run.signal.aborted;
  const setAvailability=(item,value,gen)=>{
    item.availability=value;
    if(pluginName)pluginAvailability.set(item,gen);
  };
  function invalidatePluginRun(run){
    if(!currentPluginRun(run))return;
    run.valid=false;
    sourceCache.clear();
    run.controller.abort();
    for(const item of run.targets)if(!item.upcoming)
      setAvailability(item,{status:'unavailable',reason:'plugin-changed',message:pluginChanged,sources:[],checkedAt:now()},run.gen);
    state.sourceProgress.done=run.targets.length;
    state.status='ready';
  }
  function pluginJob(item,category,run){
    // Hold the admission gate through start so the next job sees any capability
    // change that happened during this start. The result polls remain concurrent.
    const admission=run.admission.then(async()=>{
      if(!currentPluginRun(run))return null;
      const installed=await qb('search/plugins');
      if(!currentPluginRun(run))return null;
      if(!Array.isArray(installed))throw Error('The plugin list is unavailable. Try again.');
      const plugin=installed.find(entry=>entry?.name===pluginName);
      if(plugin&&plugin.enabled!==false&&(plugin.enabled!==true||!Array.isArray(plugin.supportedCategories)))
        throw Error('The plugin capability list is unavailable. Try again.');
      const categories=[...new Set((Array.isArray(plugin?.supportedCategories)?plugin.supportedCategories:[]).map(value=>value?.id)
        .filter(value=>typeof value==='string'&&value))].sort();
      if(!plugin?.enabled||!categories.includes(category)||pluginSignature&&JSON.stringify(categories)!==pluginSignature){
        invalidatePluginRun(run);
        return null;
      }
      const pattern=(item.title+(item.kind==='movies'&&item.year?' '+item.year:'')).slice(0,180);
      const job=await qb('search/start',{pattern,category,plugins:pluginName},'POST');
      const id=String(job?.id??'');
      if(!/^\d{1,16}$/.test(id)||!Number.isSafeInteger(Number(id)))throw Error('The plugin returned an invalid search job.');
      liveJobs.add(id);
      return {id,plugin};
    });
    run.admission=admission.then(()=>{},()=>{});
    return admission;
  }
  function pluginRow(row){
    if(!row||typeof row.fileName!=='string'||!row.fileName.trim()||row.fileName.length>2048||
      typeof row.fileUrl!=='string'||row.fileUrl.length>8192||!/^magnet:\?|^https?:\/\//i.test(row.fileUrl))return false;
    try{
      const url=new URL(row.fileUrl);
      if(url.protocol==='magnet:'&&!magnetHashes(row.fileUrl).length)return false;
    }catch{return false;}
    if(!['undefined','number','string'].includes(typeof row.nbSeeders)||
      row.nbSeeders!==undefined&&!Number.isFinite(Number(row.nbSeeders)))return false;
    if(!['undefined','number','string'].includes(typeof row.fileSize)||
      row.fileSize!==undefined&&!Number.isFinite(Number(row.fileSize)))return false;
    return true;
  }
  async function lookupPlugin(item,run){
    const category=item.nativeCategory||(item.kind==='movies'?'movies':item.kind==='anime'?'anime':'tv');
    const year=Number(item.year);
    const key=JSON.stringify([norm(item.title),item.kind,Number.isSafeInteger(year)&&year>0?year:'',category,pluginName]);
    if(!currentPluginRun(run))return cancelled();
    if(run.recheck)sourceCache.delete(key);
    const cache=sourceCache.get(key);
    const expose=(result,plugin)=>({...result,sources:result.sources.map(row=>registerResult(row,
      {category,plugins:plugin?[plugin]:[],pluginName})).sort((a,b)=>a.sequenceTier-b.sequenceTier||
        (b.streaming?.score??b.score)-(a.streaming?.score??a.score))});
    if(cache&&now()-cache.at<30*60*1000)return {...expose(cache.result),cached:true};
    if(cache)sourceCache.delete(key);
    let started;
    try{
      started=await pluginJob(item,category,run);
      if(!started||!currentPluginRun(run))return cancelled();
      const deadline=now()+sourceTimeoutMs;
      let best=[],stopped=false,malformed=false;
      while(currentPluginRun(run)&&now()<deadline){
        const result=await qb('search/results',{id:started.id,limit:300,offset:0});
        if(!currentPluginRun(run))return cancelled();
        if(!['Running','Stopped'].includes(result?.status)||!Array.isArray(result.results))
          throw Error('The plugin returned an invalid search result.');
        const page=result.results.slice(0,300), rows=page.filter(pluginRow);
        best=rankSources([...best,...rows],item);
        if(result.status==='Stopped'&&now()<=deadline){
          stopped=true;malformed=rows.length!==page.length;break;
        }
        if(result.status==='Stopped'||now()>=deadline)break;
        await wait(Math.min(pollMs,deadline-now()),undefined,{signal:run.signal});
      }
      if(!currentPluginRun(run))return cancelled();
      if(stopped&&malformed&&!best.length)throw Error('The completed search returned invalid release entries.');
      const checkedAt=now(),timedOut=!stopped;
      const result={status:best.length?'ready':timedOut?'timeout':'no-match',sources:best,checkedAt,
        ...(timedOut?{timedOut:true,reason:'timeout'}:{}),
        message:best.length?timedOut?'The check timed out. These matching seeded releases were returned before it stopped.':
          'Matching seeded releases in this check.':
          timedOut?'This plugin did not finish checking before the time limit.':
          'This completed check found no usable seeded match in the returned results.'};
      if(stopped&&!malformed){
        sourceCache.set(key,{at:checkedAt,result});
        if(sourceCache.size>200)sourceCache.delete(sourceCache.keys().next().value);
      }
      return expose(result,started.plugin);
    }catch(e){
      return currentPluginRun(run)?{status:'error',reason:'check-failed',message:e.message,sources:[],checkedAt:now()}:cancelled();
    }finally{
      if(started){
        const id=started.id;
        liveJobs.delete(id);
        await qb('search/stop',{id},'POST').catch(()=>{});
        await qb('search/delete',{id},'POST').catch(()=>{});
      }
    }
  }
  function publishCatalog(result,period){
    const previous=catalog?.period===period?catalog.rows:[];
    const rows=(result.rows||[]).map(row=>{
      const seen=new Set(),oldItems=new Map((previous?.find(entry=>entry.id===row.id)?.items||[]).map(item=>[item.id,item]));
      const items=[];
      for(const item of row.items||[]){
        const identity=[item.kind,norm(item.title),item.year||''].join(':');
        if(seen.has(identity))continue;
        seen.add(identity);
        const old=oldItems.get(item.id);
        items.push(old&&old.title===item.title&&old.year===item.year?Object.assign(old,item):{...item});
      }
      return {...row,items};
    });
    catalog={...result,period,rows};
  }
  function updateBrowseStatus(){
    const sourceStatus=state.sourceProgress.done<state.sourceProgress.total?'finding-sources':'ready';
    state={...state,status:catalogLoad&&!catalog?.rows?.length?'loading':sourceStatus,
      updatedAt:catalog?.updatedAt||null,warnings:[...(catalog?.warnings||[])],
      catalogLoading:Boolean(catalogLoad)};
  }
  function beginCatalog(period,refresh){
    if(!refresh&&catalogLoad?.period===period)return catalogLoad.promise;
    const load={period,promise:null};
    catalogLoad=load;
    const current=()=>!closed&&catalogLoad===load&&request.period===period;
    const onPartial=row=>{
      if(!current()||!request.onDemand)return;
      const existing=catalog?.rows||[],rows=existing.some(entry=>entry.id===row.id)?
        existing.map(entry=>entry.id===row.id?row:entry):[...existing,row];
      rows.sort((a,b)=>ROW_IDS.indexOf(a.id)-ROW_IDS.indexOf(b.id));
      publishCatalog({...catalog,updatedAt:catalog?.updatedAt||now(),rows},period);
      updateBrowseStatus();
      if(request.focus&&!state.sourceProgress.total)start();
    };
    const previous=metadata.cachedDiscovery?.(period);
    if(request.onDemand&&!catalog&&previous){publishCatalog(previous,period);updateBrowseStatus();}
    load.promise=Promise.resolve().then(()=>metadata.discovery({period,refresh,...(request.onDemand?{onPartial}:{})}))
      .then(result=>{if(current())publishCatalog(result,period);})
      .catch(error=>{
        if(!current())return;
        if(catalog)catalog={...catalog,warnings:[...(catalog.warnings||[]),error.message]};
        else state={...state,status:'error',warnings:[error.message]};
      }).finally(()=>{
        if(!current())return;
        catalogLoad=null;
        if(request.onDemand&&catalog){
          updateBrowseStatus();
          if(!state.sourceProgress.total)start();
        }
      });
    return load.promise;
  }
  async function run() {
    const gen=generation,currentPeriod=request.period,controller=generationSignal,signal=controller.signal;
    lastRun=now();
    try {
      if((!catalog&&!catalogLoad)||forceCatalog||reloadCatalog){
        const refresh=forceCatalog;forceCatalog=false;reloadCatalog=false;
        state={...state,status:request.onDemand&&catalog?'ready':'loading',warnings:[]};
        beginCatalog(currentPeriod,refresh);
      }
      if(catalogLoad&&!request.onDemand)await catalogLoad.promise;
      if(closed||gen!==generation||!catalog)return;
      state={...catalog,status:'finding-sources',updatedAt:catalog.updatedAt||now(),warnings:[...(catalog.warnings||[])],sourceProgress:{done:0,total:0}};
      // Search only the visible pages. All catalog titles remain available to page
      // through, while two workers bound qBittorrent traffic even during rapid paging.
      const visible=projectedRows().filter(row=>request.category==='all'||(row.category||row.id)===request.category),items=[];
      // Home alternates between shelves; a category view gives its own titles the
      // entire worker pool rather than waiting behind unrelated films and shows.
      for(let i=0;i<pageSize;i++)for(const row of visible){const shown=row.items[i];if(shown)items.push(catalog.rows.find(entry=>entry.id===row.id).items.find(item=>item.id===shown.id));}
      const focused=selectedItem();
      const targets=request.onDemand?(focused?[focused]:[]):items;
      state.sourceProgress.total=targets.length;
      state.catalogLoading=Boolean(catalogLoad);
      if(typeof metadata.enrichDiscoveryItems==='function'){
        // Posters and descriptions arrive independently of plugin source searches.
        // A late result from a previous page or time window cannot replace new cards.
        const enrich=request.onDemand?(focused?[focused]:items.filter(item=>!item.posterUrl).slice(0,8)):items;
        const onItem=updated=>{if(closed||gen!==generation)return;const item=enrich.find(item=>item.id===updated.id);if(item){const availability=item.availability;Object.assign(item,updated,{availability});}};
        void metadata.enrichDiscoveryItems(enrich,{onItem,shouldContinue:()=>!closed&&gen===generation}).then(updated=>{for(const item of updated||[])onItem(item);}).catch(()=>{});
      }
      if(!targets.length){state.status='ready';return;}
      let plugins;
      if(!pluginName){
        try{plugins=await qb('search/plugins');if(!Array.isArray(plugins))throw Error('The plugin list is unavailable.');}
        catch(e){if(gen!==generation)return;for(const item of targets)item.availability={status:'error',sources:[],message:e.message};state.warnings.push('Connect qBittorrent to look up sources for these titles.');state.sourceProgress.done=targets.length;state.status='ready';return;}
      }
      const pluginRun={gen,controller,signal,targets,valid:true,recheck:pluginRecheck===gen,admission:Promise.resolve()};
      let cursor=0;
      await Promise.all(Array.from({length:Math.min(workers,targets.length)},async()=>{
        while(cursor<targets.length&&!closed&&gen===generation&&pluginRun.valid){
          const item=targets[cursor++];
          if(item.upcoming){setAvailability(item,{status:'upcoming',sources:[],message:`Premieres ${item.premiered||'on an unannounced date'}. Episode sources can be checked after they air.`},gen);state.sourceProgress.done++;continue;}
          setAvailability(item,{status:'searching',sources:[],message:'Checking your matching plugins…'},gen);
          // Resolve a release year before querying a film when possible, so a
          // currently charting remake cannot inherit an older film's cached sources.
          if(item.kind==='movies'&&!item.year&&typeof metadata.enrichDiscoveryItems==='function'){
            const enriched=await metadata.enrichDiscoveryItems([item],{shouldContinue:()=>!closed&&gen===generation}).catch(()=>[]);
            if(enriched?.[0]&&(!pluginName||currentPluginRun(pluginRun))){const availability=item.availability;Object.assign(item,enriched[0],{availability});}
          }
          if(closed||gen!==generation||!pluginRun.valid)break;
          const found=pluginName?await lookupPlugin({...item},pluginRun):await lookup(item,plugins,gen,signal,request.onDemand?availability=>{
            if(gen===generation)item.availability=availability;
          }:null);
          if(gen===generation&&pluginRun.valid){setAvailability(item,found,gen);state.sourceProgress.done++;}
          else if(!pluginName&&item.availability.status==='searching')delete item.availability;
        }
      }));if(gen===generation)state.status='ready';
    }catch(e){if(gen===generation)state={...state,status:'error',warnings:[...state.warnings,e.message]};}
  }
  function start(){
    if(closed)return;
    requested=true;
    if(running)return;
    running=(async()=>{
      while(!closed&&requested){requested=false;await run();}
    })().finally(()=>{running=null;if(requested)start();});
  }
  function access(value,refresh=false){
    if(closed)return snapshot();const next=options(value),key=JSON.stringify(next),changed=key!==signature,expired=!pluginName&&lastRun>0&&now()-lastRun>30*60*1000,revision=Number(metadata.discoveryRevision)||0,expanded=!pluginName&&revision!==catalogRevision;
    if(!changed&&!refresh&&next.onDemand&&next.focus&&(expanded||expired)){
      catalogRevision=revision;lastRun=now();
      beginCatalog(next.period,false);
      return snapshot();
    }
    if(changed||refresh||expanded||state.status==='idle'||expired&&!running){
      if(next.focus!==request.focus)focusedItem=catalogItem(next.focus);
      if(next.period!==request.period){catalog=null;catalogLoad=null;state={...state,status:'loading',rows:[],warnings:[],sourceProgress:{done:0,total:0}};}
      if(refresh&&pluginName)pluginRecheck=generation+1;
      else if(refresh){sourceCache.clear();forceCatalog=true;}
      else if(expired&&!running)reloadCatalog=true;
      if(expanded){catalogRevision=revision;reloadCatalog=true;}
      generationSignal.abort();generationSignal=new AbortController();
      request=next;signature=key;generation++;state.sourceProgress={done:0,total:0};state.status=catalog?'finding-sources':'loading';start();
    }
    return snapshot();
  }
  return {
    get(value){return access(value);},
    peek(){return snapshot();},
    refresh(value){return access(value,true);},
    async close(){closed=true;generation++;generationSignal.abort();await running;await Promise.allSettled([...liveJobs].map(async id=>{await qb('search/stop',{id},'POST').catch(()=>{});await qb('search/delete',{id},'POST').catch(()=>{});}));}
  };
}

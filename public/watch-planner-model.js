const kinds=new Set(['movies','tv','korean','anime']);
const durationSources=new Set(['measured','catalog-film','episode']);
const providerId=/^(?:justwatch|netflix|wikipedia|tvmaze|fundex|animecorner|imdb|tmdb)-[a-z0-9][a-z0-9_-]{0,105}$/i;
const torrentHash=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const videoFile=/\.(?:mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg|ogv)$/i;
const readinessOrder={ready:0,local:1,options:2,unchecked:3};
const sameKind=(first,second)=>first===second||[first,second].includes('tv')&&[first,second].includes('korean');
const moodGenres={
  light:['comedy','family','animation','romantic comedy'],
  tense:['thriller','mystery','crime','horror','suspense'],
  adventure:['action','adventure','fantasy','science fiction','sci fi'],
  heartfelt:['romance','drama','music','romantic comedy'],
};
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const basename=value=>typeof value==='string'?value.split(/[\\/]/).at(-1):'';
const validIndex=value=>Number.isInteger(value)&&value>=0;
const validHash=value=>typeof value==='string'&&torrentHash.test(value);
const availableTorrent=item=>Boolean(item&&!/check|error|missingfiles/i.test(item.state||''));
const completedTorrent=item=>availableTorrent(item)&&item.progress>=1;
const yearOf=value=>Number.isInteger(value)&&value>=1800&&value<=2200?value:null;
const minuteCount=value=>Number.isFinite(value)&&value>0&&value<=1440?Math.ceil(value):null;
const secondsToMinutes=value=>Number.isFinite(value)?minuteCount(value/60):null;
const breakLength=value=>Number.isInteger(value)&&value>=0&&value<=120?value:0;
const privateId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9:_-]{0,159}$/i.test(value);
const videoName=value=>typeof value==='string'&&videoFile.test(value)&&
  !/\b(?:sample|trailer|teaser|featurette|extras|bonus|behind the scenes)\b/.test(normalize(value));

function kindOf(item,row){
  if(item?.kind==='korean'||item?.browseCategory==='korean'||row?.id==='korean')return 'korean';
  return kinds.has(item?.kind)?item.kind:null;
}
function chartInfo(row,item){
  if(typeof row?.periodEnd!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.periodEnd))return null;
  return {
    source:String(row.source||item.source||'Published chart').slice(0,100),
    start:typeof row.periodStart==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.periodStart)?row.periodStart:null,
    end:row.periodEnd,stale:row.stale===true,
    rank:Number.isInteger(item.chartRank)&&item.chartRank>0?item.chartRank:null
  };
}
function betterChart(candidate,current){
  if(!current)return true;
  if(candidate.stale!==current.stale)return !candidate.stale;
  if(candidate.source===current.source&&candidate.end===current.end)return (candidate.rank??Infinity)<(current.rank??Infinity);
  return candidate.end>current.end;
}
function titleReason(candidate){
  if(candidate.readiness==='ready')return 'This exact video is ready in your player.';
  if(candidate.readiness==='local')return 'Cinema checked the completed video on this PC.';
  if(candidate.chart){
    const {source,start,end,stale,rank}=candidate.chart;
    const dates=start&&start!==end?start+' – '+end:end;
    return (stale?'Last available chart: ':'')+source+(rank?' · #'+rank:'')+' · '+dates;
  }
  if(candidate.readiness==='options')return 'Cinema found watch options. The video has not been verified.';
  if(candidate.origin==='saved')return 'Saved in My List.';
  if(candidate.origin==='library')return 'From your library. The video has not been checked.';
  return 'From Discover. The video has not been checked.';
}
function filenameProof(value){
  return value&&validIndex(value.index)&&value.fileName===basename(value.fileName)&&videoName(value.fileName)&&
    Number.isSafeInteger(value.size)&&value.size>0?value:null;
}
function activeFile(active,hash){
  const fileName=basename(active?.fileName);
  if(active?.hash!==hash||!validIndex(active.index)||!videoName(fileName))return null;
  return {index:active.index,fileName,duration:active.duration,ready:active.ready===true};
}
function recordFor(history,hash,file){
  const saved=history?.[hash],record=saved?.files?.[file.index]||(saved?.index===file.index?saved:null);
  return record?.index===file.index&&record.fileName===file.fileName?record:null;
}
function episodeIntent(active,file){
  const {intent,verifiedEpisode}=active;
  if(verifiedEpisode?.index!==file.index||!/^tvmaze-\d+$/.test(verifiedEpisode.showId)||
    !/^tvmaze-episode-\d+$/.test(verifiedEpisode.episodeId))return null;
  const {showId,episodeId}=verifiedEpisode;
  if(!intent)return {showId,episodeId};
  return intent.showId===showId&&intent.episodeId===episodeId?intent:null;
}
function filmLabelMatches(candidate,file){
  const stem=normalize(file.fileName.replace(videoFile,''));
  const title=normalize(candidate.title);
  if(!title||!candidate.year||!stem.startsWith(title+' '))return false;
  return stem.slice(title.length+1).split(' ')[0]===String(candidate.year);
}

export function buildPlannerCandidates({rows=[],saved=[],library=[],history={},connected=false,active=null,verifiedFiles=new Map()}={}){
  const groups=new Set(),byProvider=new Map(),byHash=new Map(library.filter(item=>validHash(item?.hash)).map(item=>[item.hash,item]));
  function merge(primary,secondary){
    for(const key of secondary.keys){primary.keys.add(key);byProvider.set(key,primary);}
    for(const hash of secondary.hashes)primary.hashes.add(hash);
    if(secondary.chart&&betterChart(secondary.chart,primary.chart))primary.chart=secondary.chart;
    if(primary.minutes===null&&secondary.minutes!==null){primary.minutes=secondary.minutes;primary.durationSource=secondary.durationSource;}
    primary.year??=secondary.year;
    if(secondary.kind==='korean')primary.kind='korean';
    primary.posterUrl||=secondary.posterUrl;
    if(!primary.genres.length)primary.genres=secondary.genres;
    primary.checked||=secondary.checked;
    primary.upcoming=primary.upcoming&&secondary.upcoming;
    groups.delete(secondary);
    return primary;
  }
  function addTitle(item,row){
    const kind=kindOf(item,row);
    if(!kind||typeof item?.title!=='string'||!item.title.trim()||!providerId.test(item.id||''))return;
    const title=item.title.trim().slice(0,180),year=yearOf(item.year);
    const minutes=kind==='movies'&&item.isSeries!==true?minuteCount(item.runtime):null;
    const sources=Array.isArray(item.availability?.sources)?item.availability.sources:[];
    const keys=new Set([item.id,item.metadataId].filter(value=>typeof value==='string'&&providerId.test(value)));
    const entry={
      id:item.id,title,year,kind,posterUrl:item.posterUrl?.startsWith('/api/metadata/poster?')?item.posterUrl:null,
      minutes,durationSource:minutes===null?null:'catalog-film',
      origin:row?'chart':'saved',titleItem:item,chart:chartInfo(row,item),keys,
      genres:Array.isArray(item.genres)?item.genres.filter(value=>typeof value==='string').slice(0,8):[],
      checked:item.availability?.status==='ready'&&sources.length>0,upcoming:item.upcoming===true,
      hashes:new Set(sources.map(source=>source?.existingHash).filter(validHash)),
    };
    const existing=[...new Set([...keys].map(key=>byProvider.get(key)).filter(group=>group&&sameKind(group.kind,kind)&&
      (!group.year||!year||group.year===year)))];
    if(existing.length){
      const [primary,...others]=existing;
      for(const group of others)merge(primary,group);
      merge(primary,entry);
    }else{
      groups.add(entry);
      for(const key of keys)if(!byProvider.has(key))byProvider.set(key,entry);
    }
  }

  for(const row of rows)for(const item of row?.items||[])addTitle(item,row);
  for(const item of saved)addTitle(item,null);

  function attachMovie(candidate,hash,{standalone=false}={}){
    const item=connected&&byHash.get(hash);
    if(!item||!['movies','other'].includes(item.kind))return;
    if(!candidate.verifyHash||completedTorrent(item)&&!completedTorrent(byHash.get(candidate.verifyHash)))candidate.verifyHash=hash;
    const file=activeFile(active,hash),proof=filenameProof(verifiedFiles.get(hash));
    const exactActive=file&&(standalone||proof&&proof.index===file.index&&proof.fileName===file.fileName||filmLabelMatches(candidate,file))?file:null;
    const completed=proof&&completedTorrent(item)?proof:null;
    const chosen=exactActive?.ready?exactActive:completed;
    if(!chosen)return;
    const readiness=exactActive?.ready?'ready':'local';
    if(readinessOrder[readiness]>=readinessOrder[candidate.readiness])return;
    candidate.local={hash,index:chosen.index};
    candidate.verifyHash=hash;
    candidate.readiness=readiness;
    const sameActive=exactActive?.index===chosen.index&&exactActive.fileName===chosen.fileName;
    const measured=secondsToMinutes(sameActive?exactActive.duration:null)??secondsToMinutes(recordFor(history,hash,chosen)?.duration);
    if(measured!==null){candidate.minutes=measured;candidate.durationSource='measured';}
  }

  const candidates=[],displayKeys=new Map(),associated=new Set();
  for(const {keys,hashes,checked,...candidate} of groups){
    candidate.readiness=checked?'options':'unchecked';
    if(candidate.kind==='movies'&&!candidate.upcoming){
      for(const hash of hashes){
        if(connected&&['movies','other'].includes(byHash.get(hash)?.kind))associated.add(hash);
        attachMovie(candidate,hash);
      }
    }
    const displayKey=candidate.year&&candidate.kind+':'+candidate.year+':'+normalize(candidate.title);
    const previous=displayKey&&displayKeys.get(displayKey);
    if(previous&&candidate.origin==='chart'&&previous.origin==='chart'&&!candidate.verifyHash&&!previous.verifyHash)continue;
    if(displayKey&&!previous)displayKeys.set(displayKey,candidate);
    candidates.push({...candidate,reason:titleReason(candidate)});
  }

  for(const [hash,item] of byHash){
    const kind=kindOf(item);
    if(!kind||associated.has(hash)||typeof item.title!=='string'||!item.title.trim())continue;
    const candidate={
      id:'library:'+hash,title:item.title.trim().slice(0,180),year:null,kind,posterUrl:null,genres:[],
      minutes:null,durationSource:null,readiness:'unchecked',origin:'library'
    };
    if(kind==='movies')attachMovie(candidate,hash,{standalone:true});
    const file=connected?activeFile(active,hash):null;
    const intent=kind!=='movies'&&file?episodeIntent(active,file):null;
    if(intent){
      const minutes=secondsToMinutes(file.duration)??secondsToMinutes(recordFor(history,hash,file)?.duration);
      const episodeTitle=typeof intent.episodeTitle==='string'&&intent.episodeTitle.trim()?intent.episodeTitle.trim():'Episode';
      const showTitle=typeof intent.showTitle==='string'&&intent.showTitle.trim()?intent.showTitle.trim():candidate.title;
      Object.assign(candidate,{
        id:'episode:'+intent.showId+':'+intent.episodeId,title:(showTitle+' · '+episodeTitle).slice(0,180),
        year:yearOf(intent.year),minutes,durationSource:minutes===null?null:'episode',
        titleItem:{id:intent.showId,title:showTitle,year:yearOf(intent.year),kind,isSeries:true}
      });
      if(file.ready){candidate.readiness='ready';candidate.local={hash,index:file.index,intent};}
    }
    candidates.push({...candidate,reason:titleReason(candidate)});
  }
  return candidates;
}

function sameTitle(first,second){
  return first.id===second.id||first.kind===second.kind&&normalize(first.title)===normalize(second.title)&&
    (first.year??null)===(second.year??null);
}
function distinct(candidates){
  const unique=[];
  for(const candidate of candidates)if(!unique.some(item=>sameTitle(item,candidate)))unique.push(candidate);
  return unique;
}
function budgetOf(value){
  if(value===null||value===undefined||value==='')return Infinity;
  return Number.isFinite(value)&&value>0?value:0;
}
function rankReadiness(a,b){
  return (readinessOrder[a.readiness]??readinessOrder.unchecked)-(readinessOrder[b.readiness]??readinessOrder.unchecked);
}
function matchesMood(candidate,mood){
  const allowed=moodGenres[mood];
  return !allowed||(candidate.genres||[]).some(genre=>allowed.includes(normalize(genre)));
}

export function chooseTonight(candidates,{budgetMinutes,mood='any'}={}){
  const budget=budgetOf(budgetMinutes);
  const eligible=candidates.filter(item=>!item.upcoming&&matchesMood(item,mood)&&
    (budget===Infinity||minuteCount(item.minutes)!==null&&item.minutes<=budget));
  const available=()=>eligible.filter(item=>!picks.some(pick=>sameTitle(item,pick)));
  const picks=[];
  const local=eligible.filter(item=>['ready','local'].includes(item.readiness)).sort(rankReadiness)[0];
  const personal=local||eligible.find(item=>item.origin==='saved');
  if(personal)picks.push({...personal,pickLabel:local?'From your library':'From My List'});
  const chart=available().filter(item=>item.chart).reduce((best,item)=>betterChart(item.chart,best?.chart)?item:best,null);
  if(chart)picks.push({...chart,pickLabel:chart.chart.stale?'From the last chart':'From the chart'});
  const remaining=available();
  const usedKinds=new Set(picks.map(item=>item.kind));
  const usedGenres=new Set(picks.flatMap(item=>item.genres||[]).map(normalize));
  const wildcard=remaining.find(item=>!usedKinds.has(item.kind))||
    remaining.find(item=>(item.genres||[]).some(genre=>!usedGenres.has(normalize(genre))))||remaining[0];
  if(wildcard)picks.push({...wildcard,pickLabel:'Wildcard'});
  for(const item of available().sort(rankReadiness)){
    if(picks.length===3)break;
    if(!picks.some(pick=>sameTitle(item,pick)))picks.push({...item,pickLabel:budget===Infinity?'Another pick':'Also fits'});
  }
  return picks;
}

export function programTotals(items,intermissionMinutes){
  const intermission=items.length===2?breakLength(intermissionMinutes):0;
  const durations=items.map(item=>minuteCount(item?.minutes));
  const totalMinutes=durations.includes(null)?null:durations.reduce((total,minutes)=>total+minutes,intermission);
  return {totalMinutes,intermissionMinutes:intermission};
}

export function suggestProgram(candidates,{budgetMinutes,intermissionMinutes}={}){
  const budget=budgetOf(budgetMinutes);
  const eligible=distinct(candidates.filter(item=>!item.upcoming&&minuteCount(item.minutes)!==null).sort(rankReadiness)).slice(0,18);
  let best=null;
  for(let index=0;index<eligible.length-1;index++){
    for(let next=index+1;next<eligible.length;next++){
      const items=[eligible[index],eligible[next]];
      const {totalMinutes}=programTotals(items,intermissionMinutes);
      if(totalMinutes>budget)continue;
      const rank=items.reduce((score,item)=>score+(readinessOrder[item.readiness]??readinessOrder.unchecked),0);
      if(!best||rank<best.rank||rank===best.rank&&totalMinutes>best.totalMinutes)best={items,rank,totalMinutes};
    }
  }
  return best?.items||[];
}

export function ballotDeck(candidates,offset=0){
  const pool=distinct(candidates.filter(item=>!item.upcoming));
  if(!pool.length)return [];
  const start=Number.isFinite(offset)?((Math.trunc(offset)%pool.length)+pool.length)%pool.length:0;
  return [...pool.slice(start),...pool.slice(0,start)].slice(0,6);
}

export function sharedPicks(deck,first,second,latest=deck){
  const firstVotes=new Set(first),secondVotes=new Set(second),current=new Map(latest.map(item=>[item.id,item]));
  return deck.filter(item=>firstVotes.has(item.id)&&secondVotes.has(item.id)).map(item=>{
    const fresh=current.get(item.id);
    if(fresh)return fresh;
    const {local,verifyHash,...display}=item;
    return {...display,readiness:'unchecked',reason:'Availability has not been checked.'};
  }).sort(rankReadiness);
}

function plainTitle(value){
  if(typeof value!=='string')return null;
  const title=value.normalize('NFKC').trim();
  if(!title||title.length>180||/[\p{Cc}\p{Cf}<>\\/]/u.test(title))return null;
  if(/\b(?:[a-z][a-z0-9+.-]*:\/\/|magnet:|urn:|file:|www\.)|^[a-z]:|\b[a-f0-9]{40}\b|\b[a-f0-9]{64}\b|\b[a-z2-7]{32}\b/i.test(title))return null;
  if(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|co|tv|me|edu|gov|local|test)\b|\.(?:mkv|mp4|avi|mov|webm|torrent|exe|zip|json)\b/i.test(title))return null;
  return title.replace(/\s+/gu,' ');
}
function program(items,intermissionMinutes,includeId){
  if(!Array.isArray(items)||items.length<1||items.length>2)return null;
  const safe=[];
  for(const item of items){
    const title=plainTitle(item?.title);
    if(!title||!kinds.has(item.kind)||includeId&&!privateId(item.id))return null;
    const durationSource=durationSources.has(item.durationSource)?item.durationSource:null;
    const minutes=durationSource?minuteCount(item.minutes):null;
    safe.push({
      ...(includeId?{id:item.id}:{}),title,year:yearOf(item.year),kind:item.kind,
      minutes,durationSource:minutes===null?null:durationSource
    });
  }
  const result={version:1,items:safe,intermissionMinutes:breakLength(intermissionMinutes)};
  return new TextEncoder().encode(JSON.stringify(result)).length<=8192?result:null;
}

export function saveProgram(items,intermissionMinutes){
  return program(items,intermissionMinutes,true);
}
export function readProgram(value){
  let saved=value;
  if(typeof value==='string'){
    if(new TextEncoder().encode(value).length>8192)return null;
    try{saved=JSON.parse(value);}catch{return null;}
  }
  return saved?.version===1?saveProgram(saved.items,saved.intermissionMinutes):null;
}
export function exportProgram(items,intermissionMinutes){
  return program(items,intermissionMinutes,false);
}

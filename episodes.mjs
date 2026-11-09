import {randomBytes} from 'node:crypto';
import {magnetHashes,torrentIdentity} from './lib.mjs';
import {cleanQuery} from './metadata.mjs';
import {createEpisodeOrbit} from './episode-orbit.mjs';
import {createRelatedTitles} from './story-orbit-related.mjs';
import {streamingHint} from './release-streaming.mjs';

// Free public endpoints and numbering policy: https://www.tvmaze.com/api
// Episode counts are provider records, never inferred from a torrent filename.
const VIDEO=/\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg|ogv)$/i;
const NON_VIDEO=/\.(?:srt|ass|ssa|vtt|sub|nfo|txt|pdf|epub|mobi|mp3|flac|aac|ogg|wav|jpg|jpeg|png|webp|exe|msi|iso)$/i;
const SOURCE_LIMIT=12, CANDIDATE_LIMIT=48, QUERY_ROWS=1000;
const episodePreference={episode:7,'absolute-episode':7,'multi-episode':4,'season-pack':2,'series-pack':0};
const verificationNote={episode:'Episode number matched; Cinema must verify its file.',
  'absolute-episode':'Anime absolute number matched; Cinema must verify its file.',
  'multi-episode':'Multiple episodes: Cinema must verify the selected episode in its file list.',
  'season-pack':'Season pack: Cinema must verify the selected episode in its file list.',
  'series-pack':'Series pack: Cinema must verify the selected episode in its file list.'};
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim().slice(0,1400);
const norm=value=>plain(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[._]/g,' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const pad=n=>String(n).padStart(2,'0');
const num=value=>Number.isInteger(value)&&value>=0?value:null;
const crossedMarker=(text,match)=>/^\s*(?:[-–—,+&]\s*)?(?:S\d{1,3}\s*E\d{1,4}|\d{1,3}x\d{1,4})\b/i.test(text.slice(match.index+match[0].length));
function marker(name) {
  const text=String(name).replace(/[._]/g,' ');
  let m=/\bS(\d{1,3})\s*E(\d{1,4})((?:\s*(?:E|[-–]\s*E?)(?:\d{1,4}))*)\b/i.exec(text);
  if(m){const season=Number(m[1]),first=Number(m[2]),rest=m[3]||'',extra=[...rest.matchAll(/\d+/g)].map(x=>Number(x[0]));const episodes=new Set([first,...extra]);if(/[-–]/.test(rest)&&extra.length===1&&extra[0]>=first&&extra[0]-first<=500)for(let e=first;e<=extra[0];e++)episodes.add(e);return {season,episodes,index:m.index,compound:extra.length>0,crossed:crossedMarker(text,m)};}
  m=/\b(\d{1,3})x(\d{1,4})(?:\s*[-–]\s*(\d{1,4})(?!x\d))?\b/i.exec(text);
  if(m){const first=Number(m[2]),last=m[3]?Number(m[3]):first,episodes=new Set([first]);if(last>=first&&last-first<=500)for(let e=first;e<=last;e++)episodes.add(e);return {season:Number(m[1]),episodes,index:m.index,compound:Boolean(m[3]),crossed:crossedMarker(text,m)};}
  m=/\bSeason\s*(\d{1,3})\s*(?:Episode|Ep|E)\s*(\d{1,4})\b/i.exec(text);
  if(m)return {season:Number(m[1]),episodes:new Set([Number(m[2])]),index:m.index,crossed:crossedMarker(text,m)};
  return null;
}
function packMarker(name){
  const text=String(name).replace(/[._]/g,' ');
  const season=/\b(?:Seasons?\s*|S)(\d{1,3})(?!\d|\s*E\d)\b/i.exec(text);
  const complete=/\b(?:the\s+)?(?:complete\s+(?:tv\s+)?series|all\s+seasons)\b/i.exec(text);
  if(!season)return complete?{index:complete.index,type:'series-pack',seasons:null}:null;
  const first=Number(season[1]),tail=text.slice(season.index+season[0].length);
  const range=/^(?:\s*(?:to|through)\s+(?:seasons?\s*|s)?|\s*[-–—]\s*(?:seasons?\s*|s)|[-–—])(\d{1,3})(?!\d|\s*E\d)\b/i.exec(tail);
  if(range){
    const last=Number(range[1]);
    if(last<first||last-first>100)return {index:season.index,type:'series-pack',seasons:[]};
    return {index:season.index,type:last===first?'season-pack':'series-pack',seasons:Array.from({length:last-first+1},(_,i)=>first+i)};
  }
  const list=/^(?:(?:\s*[,/&+]\s*|\s+)(?:s(?:easons?)?\s*)?\d{1,3}(?!\d|\s*E\d)\b)+/i.exec(tail);
  const seasons=[...new Set([first,...(list?.[0].match(/\d+/g)||[]).map(Number)])];
  return {index:season.index,type:seasons.length>1?'series-pack':'season-pack',
    seasons:Math.max(...seasons)-Math.min(...seasons)<=100?seasons:[]};
}
function releasePrefix(name,index){
  const prefix=String(name).slice(0,index).replace(/[._]/g,' ');
  return norm(prefix.replace(/^(?:\[[^\]]+\]\s*)+/,'').replace(/[([](?:19|20)\d{2}[)\]]/g,'')
    .replace(/\s+(?:19|20)\d{2}\s*$/,'').replace(/[\s-–]+$/,''));
}
function titleMatches(name,index,intent){const prefix=releasePrefix(name,index);return [intent.showTitle,...(intent.aliases||[])].some(title=>norm(title)===prefix);}
function classifyEpisodeRelease(name,intent) {
  const text=String(name).replace(/[._]/g,' '),m=marker(text);
  if(m){if(m.crossed||m.season!==intent.season||!m.episodes.has(intent.episode)||!titleMatches(text,m.index,intent))return null;return m.episodes.size>1?'multi-episode':'episode';}
  const pack=packMarker(text);
  if(pack)return (pack.seasons===null||pack.seasons.includes(intent.season))&&titleMatches(text,pack.index,intent)?pack.type:null;
  if(intent.kind==='anime'&&Number.isInteger(intent.absoluteNumber)){
    const stripped=text.replace(/^(?:\[[^\]]+\]\s*)+/,''),absolute=/(?:^|\s[-–]\s|\s(?:EP?|Episode)\s*|\s)(\d{1,4})(?:v\d+)?(?=\s|\[|\(|$)/gi;
    for(const a of stripped.matchAll(absolute))if(Number(a[1])===intent.absoluteNumber&&titleMatches(stripped,a.index,intent))return 'absolute-episode';
  }
  return null;
}
function downloadableEpisode(row){
  if(typeof row?.fileName!=='string'||!row.fileName.trim()||row.fileName.length>2048||NON_VIDEO.test(row.fileName.trim())||
    typeof row.fileUrl!=='string'||row.fileUrl.length>8192||!/^(?:magnet:\?|https?:\/\/)/i.test(row.fileUrl))return false;
  try{
    const url=new URL(row.fileUrl);
    return url.protocol==='magnet:'?magnetHashes(row.fileUrl).length>0:!url.username&&!url.password;
  }catch{return false;}
}
function episodeSourceNote(matchType,availability){
  const status=availability==='unseeded'?'No seeders reported; this release may be unavailable. ':availability==='unknown'?'Seed count unknown. ':'';
  return status+verificationNote[matchType];
}
function episodeCandidates(rows,intent,unique=new Map()){
  for(const row of rows||[]){
    if(!downloadableEpisode(row)||/api key|configuration error|password protected|\b(?:CAM|HDCAM|CAMRip|TSRip|telesync|HDTS|sample|trailer|featurette)\b/i.test(row.fileName))continue;
    const matchType=classifyEpisodeRelease(row.fileName,intent);if(!matchType)continue;
    const size=Number(row.fileSize);if(size>0&&size<15*1024*1024)continue;
    const seeds=row.nbSeeders==null||row.nbSeeders===''?NaN:Number(row.nbSeeders);
    const availability=Number.isFinite(seeds)&&seeds>0?'seeded':seeds===0?'unseeded':'unknown';
    const streaming=streamingHint({...row,nbSeeders:seeds},intent.kind),score=streaming.score+episodePreference[matchType];
    const value={...row,streaming,matchType,score,availability,fileVerificationRequired:true,sourceNote:episodeSourceNote(matchType,availability)};
    const key=torrentIdentity(row.fileUrl),previous=unique.get(key);
    if(!previous||betterEpisode(value,previous)<0)unique.set(key,value);
  }
  return unique;
}
function betterEpisode(a,b){return b.score-a.score||(Number(b.nbSeeders)||0)-(Number(a.nbSeeders)||0);}
function distinctEpisodeSources(rows){
  const ranked=[];
  for(const row of rows.sort(betterEpisode)){
    if(ranked.some(previous=>norm(previous.fileName)===norm(row.fileName)&&Math.abs(Number(previous.fileSize||0)-Number(row.fileSize||0))<=Math.max(1024*1024,Number(row.fileSize||0)*.01)))continue;
    ranked.push(row);if(ranked.length===SOURCE_LIMIT)break;
  }
  return ranked;
}
export function rankEpisodeSources(rows,intent) {
  return distinctEpisodeSources([...episodeCandidates(rows,intent).values()]);
}
export function matchEpisodeFile(files,intent) {
  const candidates=(files||[]).filter(f=>f.playable!==false&&VIDEO.test(f.name)&&!/(?:^|[\\/._ -])sample(?:[\\/._ -]|$)/i.test(f.name));
  // An explicit different show title must not pass merely because its episode
  // numbers coincide. Bare S01E02 files remain usable inside a selected pack.
  const compatiblePrefix=(segment,position)=>!releasePrefix(segment,position)||titleMatches(segment,position,intent);
  const verifiedMatches=candidates.flatMap(file=>{
    const segments=file.name.replaceAll('\\','/').split('/'),base=segments.at(-1);
    const contexts=segments.map(segment=>{const episode=marker(segment);return {segment,episode,pack:episode?null:packMarker(segment)};});
    if(contexts.some(({segment,episode,pack})=>episode?
      episode.crossed||episode.season!==intent.season||!episode.episodes.has(intent.episode)||!compatiblePrefix(segment,episode.index):
      pack&&(!compatiblePrefix(segment,pack.index)||pack.seasons!==null&&!pack.seasons.includes(intent.season))))return [];
    const marked=contexts.findLast(x=>x.episode),numbered=/^(?:Episode\s*|Ep?\s*)?(\d{1,4})(?:\D|$)/i.exec(base.replace(/[._]/g,' '));
    if(marked){
      const markedFile=marked===contexts.at(-1);
      if(!markedFile&&numbered&&Number(numbered[1])!==intent.episode)return [];
      return [{file,singleEpisode:markedFile&&!marked.episode.compound&&marked.episode.episodes.size===1}];
    }
    const seasonal=contexts.findLast(x=>x.pack?.type==='season-pack');
    const simpleNumber=!/^\s*(?:Episode\s*|Ep?\s*)?\d{1,4}\s*[-–]\s*\d{1,4}\b/i.test(base);
    if(seasonal&&numbered)return Number(numbered[1])===intent.episode?[{file,singleEpisode:simpleNumber}]:[];
    return classifyEpisodeRelease(base.replace(VIDEO,''),intent)==='absolute-episode'?[{file,singleEpisode:!/[0-9]\s*[-–]\s*[0-9]/.test(base)}]:[];
  });
  const matches=verifiedMatches.map(match=>match.file),verified=matches.length===1;
  return {index:verified?matches[0].index:null,matches,candidates,verified,singleEpisode:verified&&verifiedMatches[0].singleEpisode,message:verified?'The selected episode was verified in the torrent file list.':matches.length?'Several files match this episode. Choose the release you want.':'No file could be verified as the selected episode. Choose a file manually or another source.'};
}


const DAY_MS=24*60*60*1000;
const exactShow=/^tvmaze-([1-9]\d{0,7})$/;
const clockTime=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const zonedStamp=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
function dateEpoch(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?stamp:NaN;
}
function episodeSchedule(row) {
  const date=Number.isFinite(dateEpoch(row.airdate))?row.airdate:null;
  // TVmaze can emit a placeholder stamp for streaming episodes with no time.
  const stamp=typeof row.airtime==='string'&&clockTime.test(row.airtime)&&
    typeof row.airstamp==='string'&&zonedStamp.test(row.airstamp)&&Number.isFinite(dateEpoch(row.airstamp.slice(0,10)))
    ?Date.parse(row.airstamp):NaN;
  if(Number.isFinite(stamp))return {precision:'instant',date,at:new Date(stamp).toISOString()};
  return {precision:date?'date':'unknown',date,at:null};
}
function providerEpisodeRows(rows) {
  if(!Array.isArray(rows))throw fail('The provider returned an invalid episode catalog.',502);
  return rows.filter(row=>Number.isSafeInteger(row?.id)&&row.id>0&&num(row.season)!==null).slice(0,10000);
}
function episodeScheduleRow(row) {
  const number=num(row.number);
  return {id:'tvmaze-episode-'+row.id,title:plain(row.name)||'Untitled episode',season:row.season,
    number,special:number===null||Boolean(row.type&&row.type!=='regular'),schedule:episodeSchedule(row)};
}
function projectSchedule(showId,record,currentTime) {
  const today=Math.floor(currentTime/DAY_MS);
  let undatedCount=0;
  const episodes=[];
  for(const row of record.episodes) {
    const {id,title,season,number,special,schedule}=row;
    if(schedule.precision==='unknown'){undatedCount++;continue;}
    const day=Math.floor((schedule.precision==='instant'?Date.parse(schedule.at):dateEpoch(schedule.date))/DAY_MS);
    if(day>=today-16&&day<=today+35)episodes.push({id,title,season,number,special,schedule});
  }
  return {showId,episodes,undatedCount,updatedAt:record.updatedAt};
}


function catalogAt(record,currentTime) {
  if(record.clock&&record.clock.at<=currentTime&&currentTime<record.clock.next)return record.clock.value;
  let next=Infinity;
  function hasAired(stamp) {
    if(!Number.isFinite(stamp))return null;
    if(stamp>currentTime){next=Math.min(next,stamp);return false;}
    return true;
  }
  const anime=record.show.kind==='anime', bySeason=new Map();
  let airedEpisodes=0,totalEpisodes=0;
  const list=record.episodes.map(episode=>{
    const {number,special,schedule}=episode;
    const stamp=schedule.precision==='instant'?Date.parse(schedule.at):
      schedule.precision==='date'?dateEpoch(schedule.date)+DAY_MS-1000:NaN;
    const aired=hasAired(stamp);
    const row={...episode,aired,searchable:!special&&number>0&&aired!==false,
      absoluteNumber:anime&&episode.season===1&&!special?number:null};
    if(!special){
      if(!bySeason.has(row.season))bySeason.set(row.season,[]);
      bySeason.get(row.season).push(row);
      totalEpisodes++;
      if(aired===true)airedEpisodes++;
    }
    return row;
  });
  const seasons=record.seasons.map(season=>{
    const entries=bySeason.get(season.number)||[];
    return {...season,totalEpisodes:entries.length,airedEpisodes:entries.filter(episode=>episode.aired===true).length};
  });
  if(anime)deriveAnimeNumbers(bySeason,seasons,record.show,hasAired);
  const value={show:record.show,seasons,episodes:list,totalSeasons:seasons.length,totalEpisodes,
    totalSpecials:list.length-totalEpisodes,airedEpisodes,countNote:record.countNote,
    warnings:record.warnings,updatedAt:record.updatedAt};
  record.clock={at:currentTime,next,value};
  return value;
}
function deriveAnimeNumbers(bySeason,seasons,show,hasAired) {
  const calendar=seasons.length>0&&seasons.every(season=>season.calendarSeason);
  const first=calendar?seasons[0].number:1;
  const preceding=new Map();
  if(!calendar||show.status==='Ended'&&first===show.year){
    const records=new Map();
    for(const season of seasons)if(!records.has(season.number))records.set(season.number,season);
    let earlier=0;
    for(let number=first;;number++){
      preceding.set(number,earlier);
      const season=records.get(number),entries=bySeason.get(number);
      if(!season||!entries?.length)break;
      const matchingOrder=season.episodeOrder===entries.length||
        calendar&&season.episodeOrder===null&&entries.at(-1).airdate===season.endDate;
      if(!matchingOrder||hasAired(dateEpoch(season.endDate)+DAY_MS-1000)!==true||
        entries.some((episode,index)=>episode.number!==index+1||episode.aired!==true))break;
      earlier+=entries.length;
    }
  }
  for(const [season,entries] of bySeason){
    if(season<=1)continue;
    for(const episode of entries)episode.calendarSeason=calendar;
    const earlier=preceding.get(season);
    if(earlier===undefined)continue;
    for(const [index,episode] of entries.entries()){
      if(episode.number!==index+1||entries[index+1]?.number===episode.number)break;
      episode.absoluteNumber=earlier+episode.number;
      if(calendar)episode.numberingLabel='TVmaze aired order (derived)';
    }
  }
}

export function createEpisodes({qb,metadata,registerResult,fetchImpl=fetch,now=Date.now,connectionEpoch=()=>0,sourceTimeoutMs=25000,pollMs=1500,workers=2,catalogTtlMs=6*60*60*1000}={}) {
  const catalogs=new Map(),catalogPending=new Map(),aliasCache=new Map(),jobs=new Map(),activeByEpisode=new Map(),sourceIntents=new Map(),liveSearches=new Set();
  const scheduleCache=new Map(),schedulePending=new Map(),episodePending=new Map();
  let closed=false,working=0,httpWorking=0;const httpQueue=[];
  const orders=createEpisodeOrbit({request,catalog,now});
  const relatedTitles=createRelatedTitles({fetchImpl,now});
  async function orbit(input={}){
    if(closed)throw fail('Story Orbit has stopped.',503);
    if(input?.view==='orders')return orders.orders(input);
    if(input?.view==='order')return orders.order(input);
    if(input?.view==='related')return relatedTitles.related(input);
    throw fail('Choose an episode order or related titles.');
  }
  async function request(endpoint,maxBytes=12*1024*1024) {
    if(closed)throw fail('Episode lookup has stopped.',503);
    if(httpWorking<2)httpWorking++;
    else await new Promise(resolve=>httpQueue.push(resolve));
    try {
      if(closed)throw fail('Episode lookup has stopped.',503);
      const url=new URL(endpoint,'https://api.tvmaze.com');if(url.origin!=='https://api.tvmaze.com')throw fail('Invalid episode provider URL.');
      for(let attempt=0;attempt<2;attempt++) {
        const response=await fetchImpl(url,{headers:{'User-Agent':'CinemaLocal/2.0 (cached personal episode catalog)'},signal:AbortSignal.timeout(12000),redirect:'error'});
        if(response.status===429&&attempt===0){await wait(1200);continue;}
        if(!response.ok)throw fail(response.status===404?'TVmaze has no episode information for this title.':`TVmaze episode lookup is unavailable (HTTP ${response.status}).`,response.status===404?404:502);
        if(Number(response.headers.get('content-length'))>maxBytes)throw fail('The episode catalog is too large.',502);
        const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw fail('The episode catalog is too large.',502);chunks.push(chunk);}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }
    }catch(e){if(e.status)throw e;throw fail('The free episode provider could not be reached. Try again or use manual search.',502);}
    finally{const next=httpQueue.shift();if(next)next();else httpWorking--;}
  }
  async function resolveShow(input) {
    const exact=/^tvmaze-(\d{1,8})$/.exec(String(input.id||''));if(exact)return Number(exact[1]);
    const cleaned=cleanQuery(String(input.seriesTitle||input.title||''),{kind:input.kind==='anime'?'anime':'tv',year:input.year||undefined}),title=plain(cleaned.query),year=cleaned.year;
    if(title.length<2||title.length>160)throw fail('Choose a series title to load its episodes.');
    const yearMatches=s=>!year||Number(String(s.premiered||'').slice(0,4))===Number(year);
    const extract=data=>(Array.isArray(data)?data:[]).map(entry=>entry.show).filter(s=>s&&Number.isSafeInteger(s.id)&&yearMatches(s)).slice(0,20);
    const first=extract(await request('/search/shows?q='+encodeURIComponent(title)));
    const exactMatches=[...new Map(first.filter(s=>norm(s.name)===norm(title)).map(s=>[s.id,s])).values()];
    const ambiguous=()=>fail('Several TVmaze series match this title or its aliases. Choose a specific TVmaze match before opening episodes.',404);
    if(exactMatches.length>1)throw ambiguous();if(exactMatches.length===1)return exactMatches[0].id;
    const aliases=[...new Map([input.alternateTitle,...(Array.isArray(input.aliases)?input.aliases.slice(0,12):[])].filter(value=>typeof value==='string').map(value=>plain(value)).filter(value=>value.length>=2&&value.length<=160&&norm(value)!==norm(title)).map(value=>[norm(value),value])).values()];
    const wanted=new Set([norm(title),...aliases.map(norm)]),alternate=aliases.find(value=>/[\uac00-\ud7af]/.test(value))||aliases[0];
    const second=alternate?extract(await request('/search/shows?q='+encodeURIComponent(alternate))):[];
    // Search rank only bounds the candidates inspected. A score never proves
    // identity: a candidate must match an exact provider name/AKA and year.
    const ordered=[...[...first,...second].filter(s=>wanted.has(norm(s.name)))];
    for(let i=0;i<Math.max(first.length,second.length);i++){if(first[i])ordered.push(first[i]);if(second[i])ordered.push(second[i]);}
    const candidates=[...new Map(ordered.map(s=>[s.id,s])).values()].slice(0,3);
    const checks=await Promise.all(candidates.map(async show=>{const akas=await providerAliases(show.id);return wanted.has(norm(show.name))||akas.some(aka=>wanted.has(norm(aka.name)))?show:null;}));
    const matched=checks.filter(Boolean);if(matched.length>1)throw ambiguous();if(matched.length===1)return matched[0].id;
    throw fail('No exact TVmaze series name or alias match was found. Episode counts and numbering are unavailable; use manual source search.',404);
  }
  async function providerAliases(id) {
    const cached=aliasCache.get(id);if(cached&&cached.updatedAt>now()-catalogTtlMs)return cached.rows;
    const value=await request(`/shows/${id}/akas`),rows=Array.isArray(value)?value:[];
    aliasCache.delete(id);aliasCache.set(id,{rows,updatedAt:now()});while(aliasCache.size>80)aliasCache.delete(aliasCache.keys().next().value);return rows;
  }

  function requestEpisodes(showId,providerId) {
    const existing=episodePending.get(showId);
    if(existing)return existing.promise;
    const entry={settled:false};
    entry.promise=request('/shows/'+providerId+'/episodes?specials=1').then(providerEpisodeRows).finally(()=>{
      entry.settled=true;
      if(!catalogPending.has(showId))episodePending.delete(showId);
    });
    episodePending.set(showId,entry);
    return entry.promise;
  }
  async function schedule({showId}={}) {
    if(closed)throw fail('Episode lookup has stopped.',503);
    const id=typeof showId==='string'?exactShow.exec(showId):null;
    if(!id)throw fail('Choose a verified TVmaze show.');
    const currentTime=now(),catalogRecord=catalogs.get(showId);
    if(catalogRecord&&catalogRecord.updatedAt>currentTime-catalogTtlMs)
      return projectSchedule(showId,catalogRecord,currentTime);
    const cached=scheduleCache.get(showId);
    if(cached&&cached.updatedAt>currentTime-catalogTtlMs)return projectSchedule(showId,cached,currentTime);
    let pending=schedulePending.get(showId);
    if(!pending) {
      if(schedulePending.size>=12)throw fail('Several schedules are already loading. Try again shortly.',429);
      pending=requestEpisodes(showId,id[1]).then(rows=>{
        const value={episodes:rows.map(episodeScheduleRow),updatedAt:now()};
        scheduleCache.delete(showId);scheduleCache.set(showId,value);
        while(scheduleCache.size>24)scheduleCache.delete(scheduleCache.keys().next().value);
        return value;
      }).finally(()=>schedulePending.delete(showId));
      schedulePending.set(showId,pending);
    }
    return projectSchedule(showId,await pending,now());
  }

  async function catalog(input={}) {
    if(closed)throw fail('Episode lookup has stopped.',503);
    const providerId=await resolveShow(input),showId='tvmaze-'+providerId,cached=catalogs.get(showId);
    const currentTime=now();
    if(cached&&cached.updatedAt>currentTime-catalogTtlMs)return {...catalogAt(cached,currentTime),cached:true};
    if(catalogPending.has(showId))return catalogPending.get(showId);
    const pending=(async()=>{
      const warnings=[];
      const [show,seasons,episodes,akas]=await Promise.all([request(`/shows/${providerId}`),request(`/shows/${providerId}/seasons`),requestEpisodes(showId,providerId),providerAliases(providerId).catch(()=>[])]);
      if(show.id!==providerId||!Array.isArray(seasons)||!Array.isArray(episodes))throw fail('The provider returned an invalid episode catalog.',502);
      const kind=show.type==='Animation'&&show.language==='Japanese'?'anime':'tv';
      const aliases=[...new Set([plain(show.name),...akas.map(a=>plain(a.name))].filter(Boolean))].slice(0,35);
      const list=episodes.map(row=>{
        const value=episodeScheduleRow(row);
        return {...value,airdate:value.schedule.date,runtime:num(row.runtime),
          overview:plain(row.summary),sourceUrl:'https://www.tvmaze.com/episodes/'+row.id};
      }).sort((a,b)=>a.season-b.season||(a.number??Infinity)-(b.number??Infinity));
      const seasonsBase=seasons.filter(season=>num(season.number)!==null).map(season=>({
        number:season.number,calendarSeason:season.number>=1900&&season.number<=2100,
        episodeOrder:num(season.episodeOrder),premiereDate:season.premiereDate||null,endDate:season.endDate||null
      })).sort((a,b)=>a.number-b.number);
      const regularCounts=new Map();
      for(const episode of list)if(!episode.special)
        regularCounts.set(episode.season,(regularCounts.get(episode.season)||0)+1);
      for(const season of seasonsBase){
        const count=regularCounts.get(season.number)||0;
        if(season.episodeOrder!==null&&season.episodeOrder>count)
          warnings.push('Season '+season.number+': TVmaze lists an order of '+season.episodeOrder+
            ' episodes but only '+count+' numbered episode records. Unlisted episodes are not invented.');
      }
      if(kind==='anime')warnings.push('Anime numbering follows TVmaze. Later-season absolute numbers are used only when every preceding season has a completed, contiguous episode list matching its stated episode order. Other release orders require manual checking.');
      if(kind==='anime'&&seasonsBase.length&&seasonsBase.every(season=>season.calendarSeason))
        warnings.push('This show uses calendar-year seasons. Absolute episode numbers are derived from TVmaze aired order only for an ended series with consecutive years and complete prior episode lists. They are not official release numbering; torrent files must still be checked.');
      if(list.some(episode=>episode.schedule.precision==='unknown'))
        warnings.push('Some episodes have no known airdate; availability is not assumed.');
      const value={
        show:{id:showId,providerId,title:plain(show.name),year:Number(String(show.premiered||'').slice(0,4))||null,
          kind,aliases,language:plain(show.language),status:plain(show.status),provider:'TVmaze',
          sourceUrl:'https://www.tvmaze.com/shows/'+providerId},
        seasons:seasonsBase,episodes:list,
        countNote:'Counts are numbered episodes currently listed by TVmaze; specials are separate and ordered but unlisted episodes are excluded.',
        warnings,updatedAt:now()
      };
      catalogs.delete(showId);catalogs.set(showId,value);while(catalogs.size>40)catalogs.delete(catalogs.keys().next().value);
      return {...catalogAt(value,now()),cached:false};
    })().finally(()=>{
      catalogPending.delete(showId);
      if(episodePending.get(showId)?.settled)episodePending.delete(showId);
    });
    catalogPending.set(showId,pending);
    return pending;
  }
  function resolveIntent(selector={}) {
    const record=catalogs.get(String(selector.showId));
    const cat=record&&catalogAt(record,now()),episode=cat?.episodes.find(e=>e.id===selector.episodeId);
    if(!cat||!episode)throw fail('Episode information expired. Open this series again.',404);
    if(episode.aired===false)throw fail('This episode has not aired according to TVmaze. Source search is available after its listed airdate.');
    if(!episode.searchable)throw fail('This special has no regular episode number. Use manual title search.');
    if(episode.calendarSeason&&!episode.absoluteNumber)throw fail('TVmaze uses calendar-year seasons for this show, but its episode list is not complete enough to derive release numbering safely. Use manual source search.');
    return {showId:cat.show.id,showTitle:cat.show.title,aliases:cat.show.aliases,year:cat.show.year,kind:cat.show.kind,episodeId:episode.id,episodeTitle:episode.title,season:episode.season,episode:episode.number,absoluteNumber:episode.absoluteNumber,calendarSeason:Boolean(episode.calendarSeason),sourceType:'episode',numbering:episode.numberingLabel||'TVmaze',fileVerificationRequired:true};
  }
  function register(job) {
    const ranked=distinctEpisodeSources([...job.candidates.values()].map(row=>{
      const intent={...job.intent,sourceType:row.matchType};
      const source=registerResult(row,{category:job.intent.kind,plugins:job.plugins,intent});
      const score=(source.existingHash?source.streaming?.score??row.streaming.score:row.streaming.score)+episodePreference[row.matchType];
      return {...row,...source,intent,score,sourceNote:episodeSourceNote(row.matchType,source.existingHash?'local':row.availability)};
    }));
    for(const source of ranked){
      const {key,intent}=source;
      if(!key)continue;
      let association=sourceIntents.get(key);if(!association){association=new Map();sourceIntents.set(key,association);}association.set(intent.episodeId,intent);
      while(association.size>100)association.delete(association.keys().next().value);
      while(sourceIntents.size>500)sourceIntents.delete(sourceIntents.keys().next().value);
    }
    return ranked;
  }
  function intentForKey(key,selector) {const map=sourceIntents.get(String(key));if(!map)return null;if(selector){const wanted=typeof selector==='string'?selector:selector.episodeId,value=map.get(wanted);return value&&(!selector.showId||selector.showId===value.showId)?value:null;}return map.size===1?[...map.values()][0]:null;}
  function observe(job,rows){
    const next=episodeCandidates(rows,job.intent,new Map(job.candidates));
    const retained=[...next.entries()].sort((a,b)=>betterEpisode(a[1],b[1])).slice(0,CANDIDATE_LIMIT);
    if(retained.length===job.candidates.size&&retained.every(([key,row])=>job.candidates.get(key)===row))return;
    job.candidates=new Map(retained);job.sources=register(job);
  }
  function cleanup(search){
    search.cleanup??=(async()=>{
      if(search.job.epoch!==connectionEpoch())return;
      await qb('search/stop',{id:search.id},'POST').catch(()=>{});
      if(search.job.epoch===connectionEpoch())await qb('search/delete',{id:search.id},'POST').catch(()=>{});
    })().finally(()=>liveSearches.delete(search));
    return search.cleanup;
  }
  function finishLookup(job){
    const changed=job.epoch!==connectionEpoch();
    if(closed||job.status!=='searching'&&!(changed&&job.status==='queued'))return;
    if(changed)job.coverage.incomplete=Math.max(job.coverage.incomplete,job.coverage.queriesAttempted-job.coverage.queriesCompleted);
    const partial=changed||job.coverage.incomplete>0;
    job.status=job.sources.length?'ready':partial?'error':'empty';
    job.message=job.sources.length?
      (changed?'The qBittorrent connection changed. Releases found earlier are still shown.':
        partial?'Some searches ended early. Releases found so far are still shown.':'Episode releases matched. Cinema will verify the selected file before playback.'):
      changed?'The qBittorrent connection changed. Search for this episode again.':
        partial?'The search could not finish. Try again to check for this episode.':'No matching episode release found. Try manual search for another release.';
    job.finishedAt=now();
  }
  async function lookup(job) {
    const current=()=>!closed&&job.status==='searching'&&job.epoch===connectionEpoch();
    if(!current()){finishLookup(job);return;}
    const intent=job.intent,available=await qb('search/plugins');
    if(!current()){finishLookup(job);return;}
    if(!Array.isArray(available))throw fail('The enabled plugin list could not be read. Try again.',502);
    const plugins=available.filter(p=>p?.enabled===true&&typeof p.name==='string'&&p.name&&!p.name.includes('|'));
    if(!plugins.length)throw fail('Enable at least one qBittorrent search plugin to find this episode.');
    job.plugins=plugins;
    const pluginNames=[...new Set(plugins.map(p=>p.name))];
    job.coverage.enabled=pluginNames.length;
    const queries=intent.calendarSeason?[`${intent.showTitle} ${pad(intent.absoluteNumber)}`]:[`${intent.showTitle} S${pad(intent.season)}E${pad(intent.episode)}`,`${intent.showTitle} S${pad(intent.season)}`];
    if(!intent.calendarSeason&&intent.kind==='anime'&&intent.absoluteNumber)queries.splice(1,0,`${intent.showTitle} ${pad(intent.absoluteNumber)}`);
    queries.push(intent.showTitle);
    for(const query of queries) {
      if(!current())break;
      let search,complete=false,connectionFailed=false;
      job.coverage.queriesAttempted++;
      try {
        const started=await qb('search/start',{pattern:query.slice(0,180),category:'all',plugins:pluginNames.join('|')},'POST');
        const id=String(started?.id??'');
        if(!/^\d{1,16}$/.test(id)||!Number.isSafeInteger(Number(id)))throw fail('qBittorrent returned an invalid episode search ID.',502);
        search={id,job};liveSearches.add(search);
        const deadline=now()+sourceTimeoutMs;
        let offset=0;
        while(current()&&now()<deadline){
          const limit=Math.min(500,QUERY_ROWS-offset),response=await qb('search/results',{id,limit,offset});
          if(!current())break;
          if(!['Running','Stopped'].includes(response?.status)||!Array.isArray(response.results))throw fail('qBittorrent returned invalid episode results.',502);
          const page=response.results.slice(0,limit);
          observe(job,page);
          const total=Number.isSafeInteger(response.total)?response.total:null;
          if(total!==null)offset+=page.length;
          const more=total!==null&&offset<total;
          if(response.status==='Stopped'&&!more){complete=now()<=deadline;break;}
          if(offset>=QUERY_ROWS)break;
          if(!more||!page.length)await wait(Math.min(pollMs,Math.max(1,deadline-now())));
        }
      }catch(error){connectionFailed=error?.status===503;}
      finally{if(search)await cleanup(search);}
      if(!current())break;
      if(complete)job.coverage.queriesCompleted++;
      else job.coverage.incomplete++;
      // A local hash still needs actual episode verification in the player.
      // Keep looking for a fallback when that is the only exact match.
      if(connectionFailed||complete&&job.sources.some(s=>['episode','absolute-episode'].includes(s.matchType)&&
        !s.existingHash&&s.availability==='seeded'&&s.streaming?.score>=24))break;
    }
    finishLookup(job);
  }
  function pump(){if(closed)return;for(const job of jobs.values()){if(working>=Math.min(2,Math.max(1,workers)))break;if(job.status!=='queued')continue;working++;job.status='searching';job.message='Searching your enabled plugins for this episode…';void lookup(job).catch(e=>{if(job.status==='searching'){if(job.epoch!==connectionEpoch())finishLookup(job);else{job.status='error';job.message=e.message;job.finishedAt=now();}}}).finally(()=>{working--;pump();});}}
  function publicJob(job){return {id:job.id,status:job.status,intent:job.intent,sources:job.sources,message:job.message,coverage:{...job.coverage},createdAt:job.createdAt,finishedAt:job.finishedAt};}
  function start(selector={}) {
    if(closed)throw fail('Episode search has stopped.',503);const intent=resolveIntent(selector),key=intent.showId+':'+intent.episodeId,previous=jobs.get(activeByEpisode.get(key));
    const epoch=connectionEpoch();
    if(previous&&previous.epoch===epoch&&['queued','searching'].includes(previous.status))return publicJob(previous);
    if([...jobs.values()].filter(j=>['queued','searching'].includes(j.status)).length>=30)throw fail('Several episode searches are already queued. Wait for them to finish.',429);
    for(const [id,job] of jobs)if(!['queued','searching'].includes(job.status)&&(now()-job.createdAt>30*60*1000||jobs.size>=80)){jobs.delete(id);const k=job.intent.showId+':'+job.intent.episodeId;if(activeByEpisode.get(k)===id)activeByEpisode.delete(k);}
    const job={id:randomBytes(12).toString('hex'),status:'queued',intent,epoch,candidates:new Map(),sources:[],
      coverage:{enabled:0,queriesAttempted:0,queriesCompleted:0,incomplete:0},message:'Episode search queued.',createdAt:now()};
    jobs.set(job.id,job);activeByEpisode.set(key,job.id);pump();return publicJob(job);
  }
  function get(id){
    const job=jobs.get(String(id));if(!job)throw fail('Episode search expired. Search this episode again.',404);
    if(job.epoch!==connectionEpoch())finishLookup(job);
    else if(job.candidates.size)job.sources=register(job);
    return publicJob(job);
  }
  async function cancel(id){
    const job=jobs.get(String(id));if(!job)throw fail('Episode search not found.',404);
    if(['queued','searching'].includes(job.status)){
      job.status='cancelled';job.message='Episode search cancelled.';
      await Promise.allSettled([...liveSearches].filter(search=>search.job===job).map(cleanup));
    }
    return publicJob(job);
  }
  return {catalog,schedule,orbit,start,get,cancel,resolveIntent,intentForKey,async close(){
    closed=true;relatedTitles.close();
    for(const job of jobs.values())if(['queued','searching'].includes(job.status))job.status='cancelled';
    await Promise.allSettled([...liveSearches].map(cleanup));
  }};
}

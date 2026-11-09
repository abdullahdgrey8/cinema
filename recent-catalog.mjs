import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createFundexCatalog} from './fundex-catalog.mjs';
import {isJustWatchChartUrl,isJustWatchReleaseUrl,justWatchChartUrl,justWatchReleaseUrl,parseJustWatchChart,parseJustWatchRecentMovies} from './justwatch-catalog.mjs';

// These are published charts, not a hand-picked or all-time title list.
export const NETFLIX_GLOBAL='https://www.netflix.com/tudum/top10/data/all-weeks-global.tsv';
export const NETFLIX_COUNTRIES='https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';
export const ANIME_POLLS='https://animecorner.me/polls/browse/anime-of-the-week';
const SIX_HOURS=6*60*60*1000,DAY=24*60*60*1000;
const text=value=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>0&&code<=0x10ffff?String.fromCodePoint(code):'';}).replace(/&(amp|quot|apos|lt|gt|nbsp|ndash|mdash);/gi,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—'})[n.toLowerCase()]).replace(/\s+/g,' ').trim();
const key=value=>text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s*\([^)]*(?:television|TV|series)[^)]*\)\s*$/i,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const id=value=>createHash('sha256').update(value).digest('hex').slice(0,20);
function validate(raw){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443'))throw Error('Unsafe chart provider URL.');const allowed=isJustWatchChartUrl(u)||isJustWatchReleaseUrl(u)||u.hostname==='www.netflix.com'&&[new URL(NETFLIX_GLOBAL).pathname,new URL(NETFLIX_COUNTRIES).pathname].includes(u.pathname)||u.hostname==='animecorner.me'&&(u.pathname==='/polls/browse/anime-of-the-week'||/^\/polls\/vote\/w\d{2}-(?:winter|spring|summer|fall)\d{4}\/results\/?$/.test(u.pathname))||u.hostname==='en.wikipedia.org'&&u.pathname==='/w/api.php';if(!allowed)throw Error('Unsupported chart provider URL.');return u;}
function columns(line){return line.replace(/\r$/,'').split('\t').map(value=>value.startsWith('"')&&value.endsWith('"')?value.slice(1,-1).replace(/""/g,'"'):value);}
export function parseChartTSV(body){const lines=String(body).replace(/^\uFEFF/,'').split('\n'),header=columns(lines.shift()||'');return lines.filter(Boolean).map(line=>Object.fromEntries(columns(line).map((value,i)=>[header[i],value])));}
export function aggregateNetflix(records,weeks,kind){
  const wanted=new Set(weeks),items=new Map();
  for(const row of records){if(!wanted.has(row.week)||!row.show_title||!row.country_iso2||!Number.isInteger(Number(row.weekly_rank))||Number(row.weekly_rank)<1||Number(row.weekly_rank)>10||(kind==='movies'?row.category!=='Films':row.category!=='TV'))continue;const title=text(row.show_title),k=key(title);let item=items.get(k);if(!item){item={id:'netflix-'+id(kind+':'+k),title,kind,year:null,isSeries:kind==='tv',overview:'',posterRemote:null,confidence:1,source:'Netflix Top 10',sourceUrl:'https://www.netflix.com/tudum/top10/',attribution:'Netflix published weekly country charts',countries:new Set(),weeks:new Set(),seasons:new Set(),chartPoints:0,chartAppearances:0};items.set(k,item);}item.chartPoints+=11-Number(row.weekly_rank);item.chartAppearances++;item.countries.add(row.country_iso2);item.weeks.add(row.week);if(row.season_title&&row.season_title!=='N/A')item.seasons.add(text(row.season_title));}
  return [...items.values()].sort((a,b)=>b.chartPoints-a.chartPoints||b.countries.size-a.countries.size||a.title.localeCompare(b.title)).slice(0,1000).map(({countries,weeks:seen,seasons,...item},i)=>({...item,chartRank:i+1,countryCount:countries.size,weeksOnChart:seen.size,chartWeeks:[...seen].sort(),seasons:[...seasons].slice(0,12)}));
}
export function aggregateNetflixGlobal(records,weeks,kind){
  const wanted=new Set(weeks),groups=new Map();
  for(const row of records){if(!wanted.has(row.week)||!row.show_title||(kind==='movies'?!/^Films \(/.test(row.category):!/^TV \(/.test(row.category)))continue;const rank=Number(row.weekly_rank),views=Number(row.weekly_views);if(!Number.isInteger(rank)||rank<1||rank>10||!Number.isFinite(views)||views<0)continue;const title=text(row.show_title),k=key(title);let group=groups.get(k);if(!group){group={title,weeks:new Map(),seasons:new Set()};groups.set(k,group);}const previous=group.weeks.get(row.week);if(!previous||views>previous.views)group.weeks.set(row.week,{views,rank});if(row.season_title&&row.season_title!=='N/A')group.seasons.add(text(row.season_title));}
  return [...groups.values()].map(group=>({id:'netflix-'+id(kind+':'+key(group.title)),title:group.title,kind,isSeries:kind==='tv',year:null,confidence:1,overview:'',posterRemote:null,source:'Netflix global Top 10',sourceUrl:'https://www.netflix.com/tudum/top10/',attribution:'Netflix published global weekly Top 10 charts',weeklyViews:[...group.weeks.values()].reduce((sum,row)=>sum+row.views,0),weeksOnChart:group.weeks.size,chartWeeks:[...group.weeks.keys()].sort(),seasons:[...group.seasons],bestChartRank:Math.min(...[...group.weeks.values()].map(row=>row.rank))})).sort((a,b)=>b.weeklyViews-a.weeklyViews||a.bestChartRank-b.bestChartRank||a.title.localeCompare(b.title)).map((item,i)=>({...item,chartRank:i+1}));
}
export function animeResultLinks(html){return [...new Set([...String(html).matchAll(/https:\/\/animecorner\.me\/polls\/vote\/w\d{2}-(?:winter|spring|summer|fall)\d{4}\/results\/?/g)].map(match=>match[0].replace(/\/$/,'')))].slice(0,6);}
export function parseAnimePoll(html,sourceUrl){
  validate(sourceUrl);const period=/voting period[^<]*? is ([A-Za-z]+ \d{1,2})\s*[-–]\s*([A-Za-z]+ \d{1,2}), (\d{4})/i.exec(text(html));
  if(!period)throw Error('The anime poll did not include a verifiable voting period.');
  const date=value=>{const parsed=Date.parse(value+' '+period[3]+' 00:00:00 UTC');if(!Number.isFinite(parsed))throw Error('Invalid anime poll date.');return new Date(parsed).toISOString().slice(0,10);};
  let periodStart=date(period[1]);const periodEnd=date(period[2]),items=[];if(periodStart>periodEnd)periodStart=String(Number(period[3])-1)+periodStart.slice(4);
  for(const match of String(html).matchAll(/<a\b[^>]*class="[^"]*results-(?:podium-card|ranking-row)(?:\s|"|--)[\s\S]*?<\/a>/g)){
    const block=match[0],title=text(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1]),url=/href="(https:\/\/animecorner\.me\/polls\/rankings\/anime-of-the-week\/[^"?#]+)"/.exec(block)?.[1],animeId=/\/(\d+)\/[^/]+\/?$/.exec(url||'')?.[1],rank=Number(/aria-label="Rank (\d+)"/.exec(block)?.[1]),share=Number(/<strong>([\d.]+)%<\/strong>/.exec(block)?.[1]);
    if(!title||!animeId||!rank||!Number.isFinite(share)||share<0||share>100||items.some(item=>item.id==='animecorner-'+animeId))continue;
    const image=/(?:data-src|src)="(https:\/\/static\.animecorner\.me\/\d{4}\/\d{2}\/[^"<>]+\.(?:jpg|jpeg|png|webp))"/i.exec(block)?.[1]||null;
    items.push({id:'animecorner-'+animeId,title,seriesTitle:title.replace(/\s+(?:Season \d+|\d+(?:st|nd|rd|th) Season)(?:\s+Part \d+)?$/i,'').trim(),alternateTitle:text(/<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1]),kind:'anime',isSeries:true,year:null,confidence:1,posterRemote:image,overview:'',source:'Anime Corner reader poll',sourceUrl:url,attribution:'Anime Corner weekly reader voting; artwork rights belong to their owners',chartRank:rank,voteShare:share,chartWeeks:[periodEnd]});
  }
  if(!items.length)throw Error('The published anime results could not be read.');return {periodStart,periodEnd,sourceUrl,items:items.sort((a,b)=>a.chartRank-b.chartRank)};
}
export function aggregateAnime(polls){const merged=new Map();for(const poll of polls)for(const item of poll.items){const previous=merged.get(key(item.title));if(previous){previous.voteShare+=item.voteShare;previous.weeksOnChart++;previous.chartWeeks.push(poll.periodEnd);}else merged.set(key(item.title),{...item,chartWeeks:[poll.periodEnd],weeksOnChart:1});}return [...merged.values()].sort((a,b)=>b.voteShare-a.voteShare||a.title.localeCompare(b.title)).map((item,i)=>({...item,chartRank:i+1,voteShare:Math.round(item.voteShare*1000)/1000}));}

export function createRecentCatalog({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=30000,local,onUpdate,expandCountries=Boolean(local)}={}){
  let netflixCache=null,animeCache=null,netflixPending=null,animePending=null,countryCache=null,countryPending=null,countryError=null,countryRetryAt=0,netflixPublishedAt=null;const classifications=new Map();
  const countryFile=local?path.join(local,'metadata','recent-countries-v1.json'):null,closing=new AbortController(),fundex=createFundexCatalog({fetchImpl,now,timeoutMs:Math.min(timeoutMs,15000)});
  const trendingCache=new Map(),trendingPending=new Map();
  async function updated(){try{await onUpdate?.({available:Boolean(countryCache),error:countryError});}catch{/* Optional persistence cannot reject background catalog work. */}}
  async function read(raw,maximum,onLine,deadline=timeoutMs){
    let url=validate(raw);for(let redirects=0;redirects<4;redirects++){
      const response=await fetchImpl(url.href,{redirect:'manual',headers:{'User-Agent':'CinemaLocal/3.0 (cached published chart reader)','Accept':'text/tab-separated-values,text/html,application/json'},signal:AbortSignal.any([closing.signal,AbortSignal.timeout(deadline)])});
      if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();url=validate(new URL(response.headers.get('location'),url).href);continue;}
      if(!response.ok){await response.body?.cancel();throw Error(`Chart provider returned HTTP ${response.status}.`);}if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw Error('Chart provider response was too large.');}
      if(url.href===NETFLIX_GLOBAL){const modified=Date.parse(response.headers.get('last-modified'));netflixPublishedAt=Number.isFinite(modified)&&modified<=now()+DAY?new Date(modified).toISOString().slice(0,10):null;}
      const reader=response.body?.getReader();if(!reader)throw Error('Chart provider returned no content.');let size=0,body='',pending='';const decoder=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw Error('Chart provider response was too large.');}const chunk=decoder.decode(value,{stream:true});if(onLine){pending+=chunk;const lines=pending.split('\n');pending=lines.pop();if(pending.length>20000)throw Error('Invalid chart row.');for(const line of lines)onLine(line);}else body+=chunk;}const tail=decoder.decode();if(onLine){pending+=tail;if(pending)onLine(pending);}else body+=tail;}finally{reader.releaseLock();}return body;
    }throw Error('Chart provider redirected too many times.');
  }
  function expand(weeks,refresh=false){
    if(closing.signal.aborted||!expandCountries||countryPending||!refresh&&(countryRetryAt>now()||countryCache?.weeks.join()===weeks.join()&&countryCache.expiresAt>now()))return;
    countryPending=(async()=>{
      if(!refresh&&countryFile)try{const stat=await fs.stat(countryFile);if(stat.size<5*1024*1024){const saved=JSON.parse(await fs.readFile(countryFile,'utf8'));if(saved.version===1&&saved.weeks?.join()===weeks.join()&&saved.expiresAt>now()&&Array.isArray(saved.records)&&saved.records.length<=20000){countryCache=saved;countryError=null;await updated();return;}}}catch{}
      const wanted=new Set(weeks),records=[];let header;
      await read(NETFLIX_COUNTRIES,48*1024*1024,line=>{const values=columns(line);if(!header){header=values;return;}if(!wanted.has(values[header.indexOf('week')]))return;records.push(Object.fromEntries(values.map((value,i)=>[header[i],value])));if(records.length>20000)throw Error('Too many recent country chart records.');},180000);
      if(!records.length)throw Error('Recent Netflix country chart records were unavailable.');countryCache={version:1,weeks,records,expiresAt:now()+SIX_HOURS};countryError=null;
      if(countryFile){await fs.mkdir(path.dirname(countryFile),{recursive:true});const temporary=countryFile+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(countryCache));await fs.rename(temporary,countryFile);}
      await updated();
    })().catch(async cause=>{countryError=cause.message;countryRetryAt=now()+15*60*1000;if(!closing.signal.aborted)await updated();}).finally(()=>{countryPending=null;});
  }
  async function netflix(refresh){if(!refresh&&netflixCache?.expiresAt>now())return netflixCache;if(netflixPending)return netflixPending;netflixPending=(async()=>{
    const global=parseChartTSV(await read(NETFLIX_GLOBAL,3*1024*1024)),weeks=[...new Set(global.map(row=>row.week).filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Date.parse(value)<=now()+DAY))].sort().reverse().slice(0,4);if(!weeks.length)throw Error('Netflix did not publish any dated chart rows.');
    const wanted=new Set(weeks),records=global.filter(row=>wanted.has(row.week));
    if(!records.length)throw Error('The current Netflix global charts could not be read.');netflixCache={weeks,records,publishedAt:netflixPublishedAt,expiresAt:now()+SIX_HOURS};return netflixCache;
  })().finally(()=>{netflixPending=null;});return netflixPending;}
  async function anime(refresh){if(!refresh&&animeCache?.expiresAt>now())return animeCache;if(animePending)return animePending;animePending=(async()=>{
    const links=animeResultLinks(await read(ANIME_POLLS,2*1024*1024));if(!links.length)throw Error('No completed anime weekly polls were published.');const results=await Promise.allSettled(links.map(async url=>parseAnimePoll(await read(url,2*1024*1024),url))),polls=results.filter(result=>result.status==='fulfilled').map(result=>result.value).filter(poll=>Date.parse(poll.periodEnd)<=now()+DAY).sort((a,b)=>b.periodEnd.localeCompare(a.periodEnd)).slice(0,4);if(!polls.length)throw results[0].reason;animeCache={polls,partial:results.some(result=>result.status==='rejected'),expiresAt:now()+SIX_HOURS};return animeCache;
  })().finally(()=>{animePending=null;});return animePending;}
  async function korean(items){
    const unknown=items.filter(item=>!classifications.has(key(item.title))),batches=[];for(let i=0;i<unknown.length;i+=12)batches.push(unknown.slice(i,i+12));let cursor=0,failed=false;
    async function worker(){while(cursor<batches.length){const batch=batches[cursor++],titles=batch.flatMap(item=>[item.title,item.title+' (TV series)',item.title+' ('+new Date(now()).getUTCFullYear()+' TV series)']),url=new URL('https://en.wikipedia.org/w/api.php');url.search=new URLSearchParams({action:'query',format:'json',formatversion:'2',titles:titles.join('|'),redirects:'1',prop:'pageprops|extracts|pageimages',exintro:'1',explaintext:'1',exchars:'500',exlimit:'20',piprop:'thumbnail',pithumbsize:'400',pilicense:'any',pilimit:'50'});
      try{const payload=JSON.parse(await read(url,2*1024*1024));if(payload.error)throw Error(payload.error.info||'Classification unavailable.');
        for(const item of batch){const pages=(payload.query?.pages||[]).filter(page=>!page.missing&&!Object.hasOwn(page.pageprops||{},'disambiguation')&&key(page.title)===key(item.title)&&/television|\bTV\b|series/i.test(text(page.pageprops?.['wikibase-shortdesc'])+' '+text(page.extract)));
          const koreanPages=pages.filter(page=>/South Korean.*(?:television|TV|series)|(?:television|TV).*South Korean/i.test(text(page.pageprops?.['wikibase-shortdesc'])+' '+text(page.extract)));
          if(!koreanPages.length||pages.length!==koreanPages.length){classifications.set(key(item.title),{korean:false});continue;}
          const years=new Set(koreanPages.map(page=>Number(/\b((?:19|20)\d{2})\b/.exec(text(page.pageprops?.['wikibase-shortdesc'])+' '+text(page.extract))?.[1])||null)),page=koreanPages[0],ambiguous=years.size>1;
          classifications.set(key(item.title),{korean:true,overview:ambiguous?'':text(page.extract),year:ambiguous?null:[...years][0],posterRemote:ambiguous?null:page.thumbnail?.source||null,classificationSourceUrl:'https://en.wikipedia.org/wiki/'+encodeURIComponent(page.title),metadataAmbiguous:ambiguous});
        }
      }catch{failed=true;}
    }}
    await Promise.all([worker(),worker()]);return {failed,items:items.filter(item=>classifications.get(key(item.title))?.korean).map(item=>({...item,...classifications.get(key(item.title)),browseCategory:'korean',language:'Korean'}))};
  }
  async function readJustWatch(url,refresh,parse){
    const cached=trendingCache.get(url);
    if(!refresh&&cached?.expiresAt>now()){
      if(cached.error)throw cached.error;
      return cached.row;
    }
    if(trendingPending.has(url))return trendingPending.get(url);
    const request=(async()=>{
      try{
        const row=parse(await read(url,2*1024*1024,null,Math.min(timeoutMs,8000)));
        trendingCache.set(url,{row,expiresAt:now()+SIX_HOURS});
        return row;
      }catch(error){
        trendingCache.set(url,{error,expiresAt:now()+15*60*1000});
        throw error;
      }
    })().finally(()=>trendingPending.delete(url));
    trendingPending.set(url,request);return request;
  }
  async function discovery({period='week',refresh=false,onPartial}={}){
    if(!['week','month'].includes(period))throw Object.assign(Error('Choose week or month.'),{status:400});if(refresh)classifications.clear();const warnings=[],rows=[];
    const label=period==='week'?'Latest published week':'Latest four published weeks';
    const base=(id,title,kind,source,sourceUrl)=>({id,title,kind,period,periodLabel:label,source,sourceUrl,sourceUrls:[sourceUrl],items:[],curated:false,stale:false});
    function announce(row){try{onPartial?.(row);}catch{/* Chart availability is independent of a subscriber. */}}
    function animeRow(data){
      const polls=period==='week'?data.polls.slice(0,1):data.polls,start=polls.at(-1).periodStart,end=polls[0].periodEnd;
      return {...base('anime','Popular anime','anime','Anime Corner weekly reader poll',polls[0].sourceUrl),
        periodStart:start,periodEnd:end,publishedAt:end,sourceUrls:polls.map(poll=>poll.sourceUrl),
        chartWeeks:polls.map(poll=>poll.periodEnd),
        rankingMethod:period==='week'?'Weekly reader vote share':'Sum of weekly reader vote shares; not total unique viewers',
        description:'Anime Corner reader votes · '+start+' to '+end+(period==='month'?' · summed weekly vote shares':''),
        items:aggregateAnime(polls)};
    }
    const trendingRequests=['movies','tv'].map(kind=>readJustWatch(justWatchChartUrl(kind,period),refresh,
      html=>parseJustWatchChart(html,{kind,period,now:now(),plainText:text})).then(row=>{
      announce(row);return row;
    }));
    const year=new Date(now()).getUTCFullYear();
    const recentRequest=readJustWatch(justWatchReleaseUrl(year),refresh,html=>parseJustWatchRecentMovies(html,{year,plainText:text}))
      .then(async row=>{
        const chart=await trendingRequests[0].catch(()=>null),trendingIds=new Set(chart?.items.map(item=>item.id));
        const distinct={...row,items:row.items.filter(item=>!trendingIds.has(item.id))};
        if(distinct.items.length)announce(distinct);
        return distinct;
      });
    const animeRequest=anime(refresh).then(data=>{const row=animeRow(data);announce(row);return row;});
    const fundexRequest=period==='week'?fundex.discovery({refresh}).then(row=>{if(row)announce(row);return row;}):Promise.resolve(null);
    const [netflixResult,animeResult,fundexResult,recentResult,...trendingResults]=await Promise.allSettled([netflix(refresh),animeRequest,fundexRequest,recentRequest,...trendingRequests]);
    const fundexRow=period==='week'&&fundexResult.status==='fulfilled'?fundexResult.value:null;
    const usesNetflix=period==='month'||!fundexRow||trendingResults.some(result=>result.status!=='fulfilled');
    if(usesNetflix&&netflixResult.status==='fulfilled')expand(netflixResult.value.weeks,refresh);
    if(usesNetflix&&netflixResult.status==='fulfilled'){
      const data=netflixResult.value,weeks=period==='week'?data.weeks.slice(0,1):data.weeks,start=new Date(Date.parse(weeks.at(-1))-6*DAY).toISOString().slice(0,10),end=weeks[0],dateInfo={periodStart:start,periodEnd:end,publishedAt:data.publishedAt,publishedAtSource:'Dataset Last-Modified header',chartWeeks:[...weeks]};
      const countries=countryCache?.weeks.join()===data.weeks.join()?countryCache:null,movies=countries?aggregateNetflix(countries.records,weeks,'movies'):aggregateNetflixGlobal(data.records,weeks,'movies'),series=countries?aggregateNetflix(countries.records,weeks,'tv'):aggregateNetflixGlobal(data.records,weeks,'tv'),chartSource=countries?NETFLIX_COUNTRIES:NETFLIX_GLOBAL,chartName=countries?'Netflix weekly country charts':'Netflix global weekly charts',points='Sum of (11 − chart rank) across country chart appearances; not unique viewers';
      rows.push({...base('movies','Popular movies','movies',chartName,chartSource),...dateInfo,rankingMethod:countries?points:'Sum of weekly views across published English and non-English global Top 10 charts',description:countries?`Netflix country Top 10 films · ${start} to ${end} · ranked by chart points across countries`:`Netflix global Top 10 films, English + non-English · ${start} to ${end} · ranked by weekly views`,items:movies});
      rows.push({...base('tv','Popular series','tv',chartName,chartSource),...dateInfo,rankingMethod:countries?points:'Sum of weekly views for each series’ most-viewed season per week; not unique viewers',description:countries?`Netflix country Top 10 series · ${start} to ${end} · ranked by chart points across countries`:`Netflix global Top 10 series, English + non-English · ${start} to ${end} · best-season views per week`,items:series});
      const verified=fundexRow?{items:[],failed:false}:await korean(series);rows.push({...base('korean','Popular Korean series','tv','Netflix charts + Wikipedia country classification',chartSource),...dateInfo,rankingMethod:countries?points:'Best-season weekly views, restricted to verified South Korean series',description:`South Korean series verified by Wikipedia, appearing in Netflix ${countries?'country':'global'} charts · ${start} to ${end}`,items:verified.items});if(verified.failed)warnings.push('Some Korean series could not be classified because Wikipedia was unavailable; only verified titles are shown.');if(!fundexRow&&!verified.items.length)warnings.push('No South Korean series could be verified in the published chart window.');if(now()-Date.parse(end)>10*DAY)warnings.push(`Netflix's latest available chart ends ${end}; newer rankings have not been received.`);if(expandCountries&&!countries)warnings.push(countryPending?'Loading additional country charts in the background; global charts are available now.':countryError?'Country chart expansion is temporarily unavailable; showing published global charts.':'');
    }else{
      if(usesNetflix&&netflixResult.status==='rejected')warnings.push('Netflix charts unavailable: '+netflixResult.reason.message);
      for(const [id,title,kind]of [['movies','Popular movies','movies'],['tv','Popular series','tv'],['korean','Popular Korean series','tv']])rows.push({...base(id,title,kind,'Netflix global weekly charts',NETFLIX_GLOBAL),unavailable:true,description:'Current published charts are temporarily unavailable.'});
    }
    if(fundexRow){rows[rows.findIndex(row=>row.id==='korean')]=fundexRow;if(fundexRow.warning)warnings.push(fundexRow.warning);}else if(period==='week'&&fundexResult.status==='rejected')warnings.push(fundexResult.reason.message+' Showing verified Netflix chart titles when available.');
    if(animeResult.status==='fulfilled'){
      const row=animeResult.value,pollCount=row.chartWeeks.length,end=row.periodEnd;
      rows.push(row);
      if(period==='month'&&pollCount<4)warnings.push(`Anime Corner provided ${pollCount} completed poll${pollCount===1?'':'s'} for this period; unavailable weeks are omitted.`);
      if(now()-Date.parse(end)>10*DAY)warnings.push(`Anime Corner's latest completed poll ends ${end}; voting or a seasonal break can delay newer results.`);
    }else{warnings.push('Anime Corner charts unavailable: '+animeResult.reason.message);rows.push({...base('anime','Popular anime','anime','Anime Corner weekly reader poll',ANIME_POLLS),unavailable:true,description:'Published anime voting results are temporarily unavailable.'});}
    for(const result of trendingResults){
      if(result.status!=='fulfilled')continue;
      const i=rows.findIndex(row=>row.id===result.value.id);
      rows[i]=result.value;
    }
    if(recentResult.status==='fulfilled'&&recentResult.value.items.length)rows.splice(1,0,recentResult.value);
    return {period,periodLabel:label,rows,warnings:warnings.filter(Boolean),expanding:Boolean(usesNetflix&&countryPending&&!countryCache),updatedAt:now(),cached:false,curated:false,sourceUrls:[...new Set(rows.flatMap(row=>row.sourceUrls))]};
  }
  return {discovery,async whenExpanded(){await countryPending;return {available:Boolean(countryCache),error:countryError};},async close(){closing.abort();await Promise.allSettled([countryPending,fundex.close(),...trendingPending.values()]);}};
}

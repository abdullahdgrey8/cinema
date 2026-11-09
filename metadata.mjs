import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createRecentCatalog} from './recent-catalog.mjs';
import {isJustWatchBackdropUrl,isJustWatchPosterUrl,isJustWatchTitleUrl,parseJustWatchBackdrop} from './justwatch-catalog.mjs';

// Public, key-free providers. TVmaze: https://www.tvmaze.com/api (CC BY-SA).
// Wikipedia discovery uses MediaWiki; the best page also supplies JSON-LD/OpenGraph.
// Artwork downloads stay private to this module. Callers proxy images by opaque ID.
const WEEK=7*24*60*60*1000,MAX_CACHE=300,MAX_POSTERS=5000,MAX_IMAGE=5*1024*1024;
const POSTER_CACHE_LIMIT=96*1024*1024,POSTER_PRUNE_BATCH=8*1024*1024;
const USER_AGENT='CinemaLocal/2.0 (personal media metadata; cached Wikipedia and TVmaze client)';
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const error=(message,status=400)=>Object.assign(Error(message),{status});
const shorten=(value,length=900)=>String(value??'').trim().slice(0,length);
const clamp=value=>Math.max(0,Math.min(1,value));
export function plainText(value){return shorten(String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,number)=>{const n=number[0].toLowerCase()==='x'?parseInt(number.slice(1),16):Number(number);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi,(_,entity)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '})[entity.toLowerCase()]).replace(/\s+/g,' '),1500);}
function normalized(value){return plainText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/\s*\([^)]*(?:film|series|anime|TV|television)[^)]*\)/gi,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
export function cleanQuery(raw,{kind='all',year}={}){
  if(typeof raw!=='string')throw error('Enter a title to look up.');
  let query=raw.replace(/^\[[^\]]*\]\s*/,'').replace(/\.(mkv|mp4|avi|webm|m4v)$/i,'').replace(/[._]/g,' ').replace(/\b(?:2160p|1080p|720p|480p|WEB[- ]?DL|WEBRip|BluRay|BRRip|BDRip|HEVC|x26[45]|S\d{1,2}(?:E\d{1,3})?|\d{1,2}x\d{2})\b.*$/i,'').replace(/["|<>]/g,' ').replace(/\s+/g,' ').trim();
  const yearMatches=[...query.matchAll(/\b((?:18|19|20)\d{2})\b/g)].filter(match=>match.index>1&&Number(match[1])<=new Date().getUTCFullYear()+2&&(year===undefined||year===null||year===''||Number(match[1])===Number(year)));
  const yearMatch=yearMatches.at(-1);
  if(yearMatch){year??=Number(yearMatch[1]);query=query.slice(0,yearMatch.index).replace(/[\s([{-]+$/g,'').trim();}
  if(query.length<2||query.length>160||!/\p{L}|\p{N}/u.test(query))throw error('Use a title between 2 and 160 characters.');
  if(!['all','movies','tv','anime'].includes(kind))kind='all';
  if(year!==undefined&&year!==null&&year!==''){year=Number(year);if(!Number.isInteger(year)||year<1880||year>2100)throw error('Enter a valid release year.');}else year=undefined;
  return {query,kind,year};
}
export function validateMetadataUrl(raw,purpose){
  let url;try{url=new URL(raw);}catch{throw error('The metadata provider returned an invalid URL.',502);}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw error('The metadata provider returned an unsafe URL.',502);
  const host=url.hostname;
  const allowed=purpose==='image'?isJustWatchPosterUrl(url)||isJustWatchBackdropUrl(url)||['upload.wikimedia.org','thumb.wikimedia.org','static.tvmaze.com','static.animecorner.me','www.fundex.co.kr'].includes(host)&&(/\.(?:jpe?g|png|webp|gif)$/i.test(url.pathname))&&(host==='static.tvmaze.com'?url.pathname.startsWith('/uploads/images/'):host==='static.animecorner.me'?/^\/\d{4}\/\d{2}\//.test(url.pathname):host==='www.fundex.co.kr'?/^\/pjmeta\/pjimg\/pj_\d+\.jpg$/.test(url.pathname):url.pathname.startsWith('/wikipedia/')):
    purpose==='backdrop-page'?isJustWatchTitleUrl(url):
    purpose==='page'?host==='en.wikipedia.org'&&url.pathname.startsWith('/wiki/'):
    (host==='en.wikipedia.org'&&url.pathname==='/w/api.php')||(host==='api.tvmaze.com'&&url.pathname==='/search/shows');
  if(!allowed)throw error('The metadata provider returned an unsupported URL.',502);
  url.hash='';return url;
}
function approvedImage(url){try{return validateMetadataUrl(url,'image').href;}catch{return null;}}
function imageType(body){
  if(body[0]===255&&body[1]===216&&body[2]===255)return 'image/jpeg';
  if(body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')return 'image/webp';
  return /^GIF8[79]a$/.test(body.subarray(0,6).toString())?'image/gif':null;
}
function safeSource(url,source){try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname===(source==='TVmaze'?'www.tvmaze.com':'en.wikipedia.org'))return u.href;}catch{}return source==='TVmaze'?'https://www.tvmaze.com/':'https://en.wikipedia.org/';}
function similarity(query,title){const a=normalized(query),b=normalized(title);if(a===b)return .92;const aa=new Set(a.split(' ')),bb=new Set(b.split(' '));const overlap=[...aa].filter(word=>bb.has(word)).length;return .82*(2*overlap/(aa.size+bb.size));}
export function matchConfidence(request,match){let score=similarity(request.query,match.title);if(request.year&&match.year)score+=request.year===match.year?.08:-.3;if(request.kind!=='all'&&request.kind!==match.kind&&!(request.kind==='anime'&&match.kind==='movies'))score-=.12;return Math.round(clamp(score)*1000)/1000;}
function yearOf(value){return Number(/\b((?:18|19|20)\d{2})\b/.exec(String(value??''))?.[1])||null;}
function visibleTitle(title){return plainText(title).replace(/\s*\([^)]*(?:film|series|anime|TV|television)[^)]*\)\s*$/i,'').trim();}
export function parseWikipedia(payload,request){
  const pages=payload?.query?.pages;if(!Array.isArray(pages))return [];
  return pages.flatMap(page=>{
    const description=plainText(page.pageprops?.['wikibase-shortdesc']||String(page.extract||'').slice(0,250));
    if(page.missing||page.pageprops&&Object.hasOwn(page.pageprops,'disambiguation')||/^(?:list of|soundtrack|accolades|production of)\b/i.test(page.title||'')||!/(?:\bfilm\b|television|\bTV\b|\banime\b|animated.*series|manga series)/i.test(description))return [];
    const kind=/anime|Japanese.*animat/i.test(description+' '+String(page.extract||'').slice(0,220))?'anime':/\bfilm\b/i.test(description)?'movies':'tv';
    const item={id:'wikipedia-'+page.pageid,title:visibleTitle(page.title),year:yearOf(description)||yearOf(page.title),kind,overview:shorten(plainText(page.extract),900),posterRemote:approvedImage(page.thumbnail?.source),sourceUrl:safeSource(page.fullurl||'https://en.wikipedia.org/wiki/'+encodeURIComponent(page.title),'Wikipedia'),source:'Wikipedia',attribution:'Wikipedia · CC BY-SA; poster rights remain with their owners',genres:[],runtime:null,rating:null};
    item.confidence=matchConfidence(request,item);return item.confidence>=.45?[item]:[];
  });
}
export function parseTVmaze(payload,request){
  if(!Array.isArray(payload))return [];
  return payload.slice(0,15).flatMap(entry=>{const show=entry?.show;if(!show||!Number.isInteger(show.id)||!show.name)return [];
    const item={id:'tvmaze-'+show.id,title:plainText(show.name),year:yearOf(show.premiered),kind:show.type==='Animation'&&show.language==='Japanese'?'anime':'tv',overview:shorten(plainText(show.summary),900),posterRemote:approvedImage(show.image?.medium||show.image?.original),sourceUrl:safeSource(show.url,'TVmaze'),source:'TVmaze',attribution:'TVmaze · CC BY-SA',genres:Array.isArray(show.genres)?show.genres.slice(0,8).map(x=>plainText(x)):[],runtime:Number(show.averageRuntime||show.runtime)||null,rating:typeof show.rating?.average==='number'?{value:show.rating.average,scale:10,source:'TVmaze'}:null,language:show.language?plainText(show.language):null};
    item.confidence=matchConfidence(request,item);return item.confidence>=.45?[item]:[];
  });
}
export function parsePageMetadata(html){
  const objects=[];
  for(const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    if(objects.length>50)break;try{const data=JSON.parse(match[1]);objects.push(...(Array.isArray(data)?data:[data]));}catch{}
  }
  for(let i=0;i<objects.length&&i<100;i++)if(Array.isArray(objects[i]?.['@graph']))objects.push(...objects[i]['@graph'].slice(0,30));
  const node=objects.find(o=>['Movie','TVSeries','Article'].some(type=>[].concat(o?.['@type']||[]).includes(type)));
  const meta={};for(const match of html.matchAll(/<meta\b[^>]*>/gi)){
    const attributes={};for(const attribute of match[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g))attributes[attribute[1].toLowerCase()]=attribute[3];
    const key=attributes.property||attributes.name;if(key&&attributes.content)meta[key]=plainText(attributes.content);
  }
  const image=typeof node?.image==='string'?node.image:Array.isArray(node?.image)?node.image[0]?.url||node.image[0]:node?.image?.url;
  const mediaNode=['Movie','TVSeries'].some(type=>[].concat(node?.['@type']||[]).includes(type));
  const duration=/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(node?.duration||'');
  return {title:plainText(node?.name||meta['og:title']||'').replace(/ - Wikipedia$/,''),posterRemote:approvedImage(image)||approvedImage(meta['og:image']),overview:shorten(plainText(node?.description||meta.description||''),900),year:mediaNode?yearOf(node.datePublished):null,runtime:mediaNode&&duration?Number(duration[1]||0)*60+Number(duration[2]||0)+Number(duration[3]||0)/60:null};
}
export function parseRankedTable(html,sourceUrl,tableIndex=0){
  const tables=[...html.matchAll(/<table\b[^>]*class\s*=\s*["'][^"']*\bwikitable\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi)],table=tables[tableIndex]?.[1];
  if(!table)return [];
  const picks=[];
  for(const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const link=/<i\b[^>]*>\s*(?:<b[^>]*>\s*)?<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(row[1]);if(!link)continue;
    let url;try{url=validateMetadataUrl(new URL(plainText(link[1]),sourceUrl).href,'page');}catch{continue;}
    if(url.search||url.hash)continue;
    const title=plainText(link[2]),cells=[...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell=>plainText(cell[1]));
    const year=Number(cells.find(cell=>/^(?:18|19|20)\d{2}$/.test(cell)))||undefined;
    if(title&&!picks.some(pick=>pick.sourceUrl===url.href))picks.push({title,pageTitle:decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/_/g,' '),year,sourceUrl:url.href});
    if(picks.length===12)break;
  }
  return picks;
}

export async function createMetadata({local,fetchImpl=globalThis.fetch,now=Date.now,minIntervalMs=400,timeoutMs=12000}={}){
  if(!local)throw Error('A local metadata cache directory is required.');
  const directory=path.join(local,'metadata'),imageDirectory=path.join(directory,'posters'),stateFile=path.join(directory,'index.json');
  await fs.mkdir(imageDirectory,{recursive:true});
  let saved={};try{const stat=await fs.stat(stateFile);if(stat.size<8*1024*1024)saved=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch{}
  const entries=value=>Array.isArray(value)?value.filter(entry=>Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[1]&&typeof entry[1]==='object'):[];
  const lookups=new Map(entries(saved.lookups).slice(-MAX_CACHE)),posters=new Map(entries(saved.posters).slice(-MAX_POSTERS)),inflight=new Map(),imageInflight=new Map(),queues=new Map(),lastRequests=new Map();
  // Versioned, period-specific caches deliberately discard the previous historical shelves.
  let writing=Promise.resolve(),discoveryRevision=0,posterPrune=null,lastPosterPrune=-Infinity,posterBytesSincePrune=0;
  const warmedPeriods=new Set(),chartWarmups=new Set();
  const discoveries=saved.discoveryVersion===3&&saved.discoveries&&typeof saved.discoveries==='object'?saved.discoveries:{},discoveryPending=new Map(),recentCatalog=createRecentCatalog({fetchImpl,now,local,timeoutMs:Math.max(timeoutMs,30000),onUpdate:async update=>{
    discoveryRevision++;
    if(update.available)for(const value of Object.values(discoveries))value.expanding=true;
    else for(const value of Object.values(discoveries)){value.expanding=false;value.warnings=[...new Set([...(value.warnings||[]).filter(message=>!message.startsWith('Loading additional country charts')),'Country chart expansion is temporarily unavailable; saved dated charts remain available.'])];}
    await persist();
  }});
  function persist(){const data=JSON.stringify({lookups:[...lookups].slice(-MAX_CACHE),posters:[...posters].slice(-MAX_POSTERS),discoveryVersion:3,discoveries});writing=writing.catch(()=>{}).then(async()=>{const temp=stateFile+'.'+randomBytes(4).toString('hex')+'.tmp';await fs.writeFile(temp,data);await fs.rename(temp,stateFile);});return writing;}
  async function boundedFetch(raw,purpose,maximum){
    let url=validateMetadataUrl(raw,purpose);
    for(let redirect=0;redirect<4;redirect++){
      const response=await fetchImpl(url.href,{redirect:'manual',headers:{'User-Agent':USER_AGENT,Accept:purpose==='image'?'image/jpeg,image/png,image/webp,image/gif':purpose==='page'||purpose==='backdrop-page'?'text/html':'application/json'},signal:AbortSignal.timeout(timeoutMs)});
      if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get('location');if(!location)throw error('Metadata provider returned an empty redirect.',502);url=validateMetadataUrl(new URL(location,url).href,purpose);continue;}
      if(!response.ok){await response.body?.cancel();throw error(response.status===429?'This metadata provider is busy. Try again later.':`Metadata provider returned HTTP ${response.status}.`,502);}
      if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw error('Metadata provider response was too large.',502);}
      const chunks=[];let size=0;const reader=response.body?.getReader();if(!reader)throw error('Metadata provider returned no content.',502);
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw error('Metadata provider response was too large.',502);}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
      return {body:Buffer.concat(chunks),contentType:(response.headers.get('content-type')||'').split(';')[0].toLowerCase()};
    }
    throw error('Metadata provider redirected too many times.',502);
  }
  function request(raw,purpose,maximum){
    const host=validateMetadataUrl(raw,purpose).hostname,previous=queues.get(host)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(async()=>{const delay=Math.max(0,minIntervalMs-(now()-(lastRequests.get(host)||0)));if(delay)await new Promise(resolve=>setTimeout(resolve,delay));lastRequests.set(host,now());return boundedFetch(raw,purpose,maximum);});
    queues.set(host,pending);return pending;
  }
  async function json(url){const data=await request(url,'api',1024*1024);try{return JSON.parse(data.body.toString('utf8'));}catch{throw error('Metadata provider returned invalid JSON.',502);}}
  async function wikipedia(query,warnings){
    const url=new URL('https://en.wikipedia.org/w/api.php');url.search=new URLSearchParams({action:'query',format:'json',formatversion:'2',generator:'search',gsrsearch:`intitle:"${query.query}" ${query.kind==='movies'?'film':query.kind==='tv'?'television':query.kind==='anime'?'anime':''}`,gsrlimit:'8',prop:'pageimages|extracts|info|pageprops',piprop:'thumbnail',pithumbsize:'500',pilicense:'any',exintro:'1',explaintext:'1',exchars:'900',inprop:'url'});
    const payload=await json(url);if(payload.error)throw error('Wikipedia search is temporarily unavailable.',502);
    const matches=parseWikipedia(payload,query).sort((a,b)=>b.confidence-a.confidence),best=matches[0];
    if(best&&best.confidence>=.72){try{const {body,contentType}=await request(best.sourceUrl,'page',2*1024*1024);if(!contentType.includes('html'))throw Error('not HTML');const page=parsePageMetadata(body.toString('utf8'));if(page.title&&similarity(best.title,page.title)>=.8){best.posterRemote=page.posterRemote||best.posterRemote;best.overview=best.overview||page.overview;best.runtime=page.runtime||best.runtime;best.structuredPage=true;}}catch{warnings.push('Wikipedia page artwork could not be enriched; search metadata is still available.');}}
    return matches;
  }
  async function tvmaze(query){const url=new URL('https://api.tvmaze.com/search/shows');url.searchParams.set('q',query.query);return parseTVmaze(await json(url),query);}
  function imageReference(id,record){
    const previous=posters.get(id);
    posters.delete(id);
    posters.set(id,{...previous,...record,seenAt:now()});
    while(posters.size>MAX_POSTERS)posters.delete(posters.keys().next().value);
    return '/api/metadata/poster?id='+id;
  }
  function backdropReference(sourceUrl){
    let page;
    try{page=validateMetadataUrl(sourceUrl,'backdrop-page').href;}catch{return null;}
    return imageReference(digest('justwatch-backdrop:'+page),{page});
  }
  function publicMatch(item){
    const {posterRemote:rawPoster,...visible}=item,posterRemote=approvedImage(rawPoster);
    visible.posterUrl=posterRemote?imageReference(digest(posterRemote),{url:posterRemote}):null;
    visible.backdropUrl=backdropReference(item.sourceUrl);
    visible.matchQuality=item.confidence>=.9?'high':'possible';
    return visible;
  }
  // Upgrade saved charts in memory on launch. Their title links are already
  // allowlisted again before creating any image reference.
  for(const catalog of Object.values(discoveries)){
    for(const row of Array.isArray(catalog?.rows)?catalog.rows:[]){
      for(const item of Array.isArray(row?.items)?row.items:[]){
        if(!item||typeof item!=='object')continue;
        const backdrop=backdropReference(item.sourceUrl);
        if(backdrop)item.backdropUrl=backdrop;
      }
    }
  }
  async function lookup(raw,options={}){
    const query=cleanQuery(raw,options),key=digest(JSON.stringify(query)),cached=lookups.get(key);
    if(cached?.expiresAt>now())return {...cached.value,cached:true};
    if(inflight.has(key))return inflight.get(key);
    const pending=(async()=>{
      const warnings=[],providers=query.kind==='movies'?['Wikipedia']:query.kind==='tv'?['TVmaze']:['Wikipedia','TVmaze'];
      const results=await Promise.allSettled(providers.map(provider=>provider==='Wikipedia'?wikipedia(query,warnings):tvmaze(query)));
      let matches=[];results.forEach((result,index)=>{if(result.status==='fulfilled')matches.push(...result.value);else warnings.push(providers[index]+': '+(result.reason?.message||'Lookup unavailable.'));});
      if(!matches.length&&query.kind==='tv'){try{matches=await wikipedia(query,warnings);}catch(e){warnings.push('Wikipedia: '+e.message);}}
      matches.sort((a,b)=>b.confidence-a.confidence||Number(Boolean(b.posterRemote))-Number(Boolean(a.posterRemote)));
      const unique=[];for(const match of matches){if(!unique.some(item=>normalized(item.title)===normalized(match.title)&&item.year===match.year&&item.kind===match.kind))unique.push(match);}
      const publicMatches=unique.slice(0,8).map(publicMatch),value={query:query.query,year:query.year||null,kind:query.kind,matches:publicMatches,warnings,ambiguous:publicMatches.length>1&&publicMatches[0].confidence-publicMatches[1].confidence<.08||Boolean(publicMatches[0]&&publicMatches[0].confidence<.9),cached:false};
      lookups.delete(key);lookups.set(key,{expiresAt:now()+(matches.length?WEEK:15*60*1000),value});while(lookups.size>MAX_CACHE)lookups.delete(lookups.keys().next().value);await persist();return value;
    })().finally(()=>inflight.delete(key));inflight.set(key,pending);return pending;
  }
  async function poster(id){
    if(!/^[a-f\d]{32}$/.test(id||''))throw error('Invalid poster identifier.');
    const record=posters.get(id);if(!record)throw error('Poster is no longer cached. Look up this title again.',404);
    if(imageInflight.has(id))return imageInflight.get(id);
    const pending=(async()=>{
      const filename=path.join(imageDirectory,id+'.bin');let image;
      try{
        const stat=await fs.stat(filename);
        if(stat.isFile()&&stat.size<=MAX_IMAGE){
          const body=await fs.readFile(filename),contentType=imageType(body);
          if(contentType&&body.length<=MAX_IMAGE)image={body,contentType};
        }
      }catch{}
      if(!image){
        let url=record.url;
        if(record.page&&!url){
          if(record.retryAt>now())throw error('Backdrop is temporarily unavailable.',404);
          try{
            const page=await request(record.page,'backdrop-page',3*1024*1024);
            if(page.contentType==='text/html')url=parseJustWatchBackdrop(page.body.toString('utf8'),record.page);
            if(!url)throw error('This title has no available backdrop.',404);
            const current=posters.get(id);
            if(current)current.url=url;
          }catch(e){
            const current=posters.get(id);
            if(current)current.retryAt=now()+3*60_000;
            throw e;
          }
        }
        image=await request(url,'image',MAX_IMAGE);
        if(imageType(image.body)!==image.contentType||!image.contentType)throw error('The provider did not return a supported poster image.',502);
        await fs.writeFile(filename,image.body);
        scheduleImagePrune(image.body.length);
      }
      return {...image,cacheControl:'public, max-age=604800, immutable'};
    })().finally(()=>imageInflight.delete(id));imageInflight.set(id,pending);return pending;
  }
  const exposeRow=row=>({...row,items:row.items.map(item=>({...publicMatch(item),browseCategory:row.category||row.id}))});
  function applyCatalog(result,previous){
    const warnings=[...(result.warnings||[])];
    const rows=result.rows.map(row=>{
      const saved=previous?.rows?.find(entry=>entry.id===row.id);
      if(row.unavailable&&saved?.items?.length){
        warnings.push(row.title+': showing the last saved dated chart because its provider is unavailable.');
        return {...saved,stale:true};
      }
      return exposeRow(row);
    });
    const savedReleases=previous?.rows?.find(row=>row.id==='new-movies'&&row.items?.[0]?.year===new Date(now()).getUTCFullYear());
    if(savedReleases&&!rows.some(row=>row.id==='new-movies')){
      const trendingIds=new Set(rows.find(row=>row.id==='movies')?.items.map(item=>item.id));
      const items=savedReleases.items.filter(item=>!trendingIds.has(item.id));
      if(items.length)rows.splice(1,0,{...savedReleases,items,stale:true});
    }
    return {...result,rows,warnings};
  }
  function warmCharts(period){
    if(warmedPeriods.has(period))return;
    warmedPeriods.add(period);
    const warmup=recentCatalog.discovery({period}).then(async result=>{
      const cached=discoveries[period];
      if(!cached||discoveryPending.has(period))return;
      const newer=result.rows.some(row=>row.chartProvider?.startsWith('justwatch')&&!cached.rows?.some(saved=>
        saved.id===row.id&&saved.chartProvider===row.chartProvider&&saved.chartUpdatedAt===row.chartUpdatedAt&&
        saved.periodLabel===row.periodLabel));
      if(!newer)return;
      discoveries[period]=applyCatalog(result,cached);
      discoveryRevision++;
      await persist();
    }).catch(()=>{}).finally(()=>chartWarmups.delete(warmup));
    chartWarmups.add(warmup);
  }
  function cachedDiscovery(period){
    const cached=discoveries[period];
    if(!cached?.rows?.some(row=>row.items?.length))return null;
    const stale=cached.updatedAt<=now()-6*60*60*1000;
    return {...cached,cached:true,rows:cached.rows.map(row=>stale?{...row,stale:true}:row)};
  }
  async function discovery({period='week',refresh=false,onPartial}={}){
    if(!['week','month'].includes(period))throw error('Choose week or month.');
    const cached=discoveries[period];
    if(!refresh&&!cached?.expanding&&cached?.updatedAt>now()-6*60*60*1000){
      // A saved global shelf may outlive its interrupted country download. Start
      // the provider once after restart so its disk cache/readiness can advance.
      warmCharts(period);
      return {...cached,cached:true};
    }
    if(discoveryPending.has(period))return discoveryPending.get(period);
    warmedPeriods.add(period);
    const pending=(async()=>{
      const revision=discoveryRevision;
      const result=applyCatalog(await recentCatalog.discovery({period,refresh,onPartial:onPartial&&((row)=>onPartial(exposeRow(row)))}),cached);
      if(result.rows.some(row=>row.items.length)&&revision===discoveryRevision){discoveries[period]=result;await persist();}
      return result;
    })().finally(()=>discoveryPending.delete(period));
    discoveryPending.set(period,pending);return pending;
  }
  async function enrichDiscoveryItems(items,{onItem,shouldContinue=()=>true}={}){
    const results=items.map(item=>({...item}));let cursor=0;
    async function worker(){while(cursor<results.length&&shouldContinue()){const position=cursor++,item=results[position];if(item.metadataAmbiguous||item.posterUrl&&item.overview)continue;
      try{const lookupTitle=item.seriesTitle||item.title,found=await lookup(lookupTitle,{kind:item.kind,year:item.year||undefined}),candidates=found.matches.filter(candidate=>candidate.confidence>=.88&&normalized(candidate.title)===normalized(lookupTitle)),match=candidates[0];
        if(match&&!(item.year==null&&new Set(candidates.map(candidate=>candidate.year)).size>1)&&shouldContinue()){const preserved={id:item.id,title:item.title,kind:item.kind,isSeries:item.isSeries,source:item.source,sourceUrl:item.sourceUrl,attribution:item.attribution};results[position]={...item,...match,...preserved,metadataId:match.id,metadataSource:match.source,metadataSourceUrl:match.sourceUrl,posterUrl:item.posterUrl||match.posterUrl,backdropUrl:item.backdropUrl||match.backdropUrl,overview:item.overview||match.overview,runtime:item.runtime||match.runtime,genres:item.genres?.length?item.genres:match.genres};if(onItem)await onItem(results[position]);}
      }catch{/* A chart stays browsable when optional artwork lookup is unavailable. */}
    }}
    await Promise.all([worker(),worker()]);return results;
  }
  function scheduleImagePrune(bytes){
    posterBytesSincePrune+=bytes;
    if(posterPrune||posterBytesSincePrune<POSTER_PRUNE_BATCH&&now()-lastPosterPrune<60_000)return;
    lastPosterPrune=now();
    posterBytesSincePrune=0;
    posterPrune=pruneImages().catch(()=>{}).finally(()=>{posterPrune=null;});
  }
  async function pruneImages(){
    const entries=(await fs.readdir(imageDirectory)).filter(name=>/^[a-f\d]{32}\.bin$/.test(name));
    const stats=(await Promise.all(entries.map(async name=>{
      try{return {name,...await fs.stat(path.join(imageDirectory,name))};}catch{return null;}
    }))).filter(Boolean);
    let size=stats.reduce((sum,stat)=>sum+stat.size,0);
    for(const stat of stats.sort((a,b)=>a.mtimeMs-b.mtimeMs)){
      if(size<=POSTER_CACHE_LIMIT)break;
      if(imageInflight.has(stat.name.slice(0,32)))continue;
      try{await fs.unlink(path.join(imageDirectory,stat.name));size-=stat.size;}catch{}
    }
  }
  return {lookup,poster,discovery,cachedDiscovery,enrichDiscoveryItems,get discoveryRevision(){return discoveryRevision;},async close(){await recentCatalog.close();await Promise.allSettled(chartWarmups);await writing;await posterPrune;}};
}

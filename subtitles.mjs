import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

const MAX_TEXT=2*1024*1024,MAX_ZIP=8*1024*1024;
const SOURCES={movie:{name:'MovieSubtitles.org',origin:'https://www.moviesubtitles.org'},tv:{name:'TVsubtitles.net',origin:'https://www.tvsubtitles.net'},subsource:{name:'SubSource',origin:'https://subsource.net'}};
const SUBSOURCE_API='https://api.subsource.net';
const SUBSOURCE_DOWNLOAD=/^\/v1\/subtitle\/download\/[a-f0-9]{64}$/;
const failure=(message,status=400)=>Object.assign(new Error(message),{status});
const plain=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi,e=>{const names={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(names[e.toLowerCase()])return names[e.toLowerCase()];const n=e[2]?.toLowerCase()==='x'?parseInt(e.slice(3,-1),16):Number(e.slice(2,-1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const norm=s=>plain(s).normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu,'$1').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu,' ').trim();
const cleanName=s=>path.basename(String(s||'English subtitles').replaceAll('\\','/')).replace(/[\u0000-\u001f]/g,'').slice(0,180);
const titleIdentity=value=>norm(plain(value).replace(/^(.+),\s*(the|a|an)$/i,'$2 $1'));
const sameTitle=(a,b)=>titleIdentity(a)===titleIdentity(b);
const releaseYear=value=>Number(/\b((?:19|20)\d{2})\b/.exec(value)?.[1])||undefined;
function legacyTitleMatches(title,query){
  const alternate=/^(.+?)\s+\(([^()]+)\)$/.exec(title);
  return sameTitle(title,query)||Boolean(alternate&&(sameTitle(alternate[1],query)||sameTitle(alternate[2],query)));
}
function titleQuery(value,{parseYear=true}={}){
  let query=String(value||'').replace(/\.(mp4|mkv|avi|webm)$/i,'').replace(/[._]/g,' ')
    .replace(/\bS\d{1,2}(?:E\d{1,3})?\b|\b\d{1,2}x\d{1,3}\b/gi,'')
    .replace(/\b(?:2160p|1080p|720p|480p|WEB[ -]?(?:DL|RIP)|BluRay|x264|x265|HEVC)\b.*$/i,'').trim();
  const suffix=parseYear&&/^(.+?)\s+[(\[]?((?:19|20)\d{2})[)\]]?$/.exec(query);
  if(suffix)query=suffix[1].trim();
  return {query,year:suffix?Number(suffix[2]):undefined};
}
function allowedSubtitleUrl(url,method){
  if(url.username||url.password||url.protocol!=='https:'||url.hash)return false;
  if(url.origin===SUBSOURCE_API)return !url.search&&(method==='POST'?url.pathname==='/v1/movie/search':SUBSOURCE_DOWNLOAD.test(url.pathname));
  if(url.origin===SOURCES.subsource.origin)return !url.search&&method==='GET'&&(
    /^\/subtitles\/[a-z\d-]{1,160}\/english$/.test(url.pathname)||/^\/subtitle\/[a-z\d-]{1,160}\/english\/\d{1,12}$/.test(url.pathname));
  return method==='GET'&&[SOURCES.movie.origin,SOURCES.tv.origin].includes(url.origin);
}
const platformTags=name=>norm(name).replace(/\bamzn\b/g,'amazon').replace(/\b(?:movies anywhere|ma(?= web\b))\b/g,'moviesanywhere')
  .match(/\b(?:amazon|moviesanywhere|itunes|netflix|hulu|max|disneyplus|paramountplus|peacock)\b/g)||[];
function releaseScore(name,reference){
  const candidate=norm(name),target=norm(reference);
  if(!target)return 0;
  const tokens=new Set(candidate.split(' '));
  const candidatePlatforms=platformTags(name);
  let score=platformTags(reference).some(tag=>candidatePlatforms.includes(tag))?50:0;
  if(candidate.includes(target))score+=100;
  for(const token of new Set(target.split(' '))){
    if(token.length>=3&&!/^(?:19|20)\d{2}$/.test(token)&&tokens.has(token))score++;
  }
  return score;
}
function chooseSubtitleVariant(candidates,reference){
  const platform=platformTags(reference);
  if(!platform.length&&new Set(candidates.flatMap(c=>platformTags(c.name))).size>1)return null;
  const matching=platform.length?candidates.filter(c=>platformTags(c.name).some(tag=>platform.includes(tag))):candidates;
  const regular=matching.filter(c=>!/\b(?:hi|sdh|cc)\b/.test(norm(c.name)));
  const options=regular.length?regular:matching;
  if(options.length===1)return options[0];
  const ranked=options.map(c=>({candidate:c,score:releaseScore(c.name,reference)})).sort((a,b)=>b.score-a.score);
  return ranked.length>1&&ranked[0].score>ranked[1].score?ranked[0].candidate:null;
}
function subtitleTime(value){
  const m=/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if(!m||Number(m[2])>59||Number(m[3])>59)throw failure('The subtitle contains an invalid timestamp.');
  return ((Number(m[1]||0)*60+Number(m[2]))*60+Number(m[3]))*1000+Number(m[4].padEnd(3,'0'));
}
const stamp=ms=>{const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};
function cueText(value){return plain(value.replace(/\{[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ')).trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function toWebVtt(text,name='subtitles.srt'){
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_TEXT)throw failure('Choose a subtitle text file smaller than 2 MB.',413);
  text=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  if(/<!doctype\s+html|<html(?:\s|>)|<script(?:\s|>)/i.test(text)||text.includes('\u0000'))throw failure('This is not a subtitle file. The provider may have returned an error page.');
  const cues=[];
  const add=(start,end,content)=>{const a=subtitleTime(start),b=subtitleTime(end),clean=cueText(content);if(b<=a)throw failure('Subtitle end times must follow their start times.');if(clean)cues.push({start:a,end:b,text:clean});if(cues.length>30000)throw failure('This subtitle contains too many captions.',413);};
  if(/\.(ass|ssa)$/i.test(name)||/^\[Script Info\]/m.test(text)){
    let fields=['layer','start','end','style','name','marginl','marginr','marginv','effect','text'],events=false;
    for(const line of text.split('\n')){
      if(/^\[Events\]/i.test(line)){events=true;continue;}if(/^\[/.test(line)){events=false;continue;}if(!events)continue;
      if(/^Format:/i.test(line))fields=line.slice(line.indexOf(':')+1).split(',').map(s=>s.trim().toLowerCase());
      if(/^Dialogue:/i.test(line)){
        const values=line.slice(line.indexOf(':')+1).trimStart().split(',');
        if(fields.indexOf('text')!==fields.length-1||fields.indexOf('start')<0||fields.indexOf('end')<0)throw failure('Unsupported ASS subtitle event layout.');
        const content=values.slice(fields.length-1).join(',');add(values[fields.indexOf('start')]||'',values[fields.indexOf('end')]||'',content);
      }
    }
  }else{
    for(const block of text.split(/\n[ \t]*\n/)){
      const lines=block.split('\n'),at=lines.findIndex(line=>line.includes('-->'));if(at<0)continue;
      const match=/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[at]);if(!match)throw failure('This subtitle has an invalid timing line.');
      add(match[1],match[2],lines.slice(at+1).join('\n'));
    }
  }
  if(!cues.length)throw failure('No timed captions were found. Choose an SRT, WebVTT, ASS or SSA file.');
  cues.sort((a,b)=>a.start-b.start||a.end-b.end);
  return {vtt:'WEBVTT\n\n'+cues.map((c,i)=>`${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n')+'\n',cues:cues.length};
}
function decodeText(bytes){
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('windows-1252').decode(bytes);}
}
export function subtitleFromZip(bytes,choose){
  if(bytes.length>MAX_ZIP)throw failure('The subtitle archive is too large.',413);
  let eocd=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw failure('The provider did not return a supported subtitle ZIP.');
  const count=bytes.readUInt16LE(eocd+10);let cursor=bytes.readUInt32LE(eocd+16),total=0;const candidates=[];
  if(count>200||bytes.readUInt16LE(eocd+4)!==0||bytes.readUInt16LE(eocd+6)!==0)throw failure('Unsupported subtitle archive.');
  for(let i=0;i<count;i++){
    if(cursor+46>bytes.length||bytes.readUInt32LE(cursor)!==0x02014b50)throw failure('Invalid subtitle archive.');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),packed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nl=bytes.readUInt16LE(cursor+28),el=bytes.readUInt16LE(cursor+30),cl=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nl+el+cl>bytes.length)throw failure('Invalid subtitle archive entry.');
    const name=bytes.toString('utf8',cursor+46,cursor+46+nl).replaceAll('\\','/');cursor+=46+nl+el+cl;total+=size;
    if(name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').includes('..')||name.includes('\0'))throw failure('Unsafe path in subtitle archive.');
    if(total>16*1024*1024)throw failure('The expanded subtitle archive is too large.',413);
    if(!/\.(srt|vtt|ass|ssa)$/i.test(name))continue;
    if((flags&1)||![0,8].includes(method)||size>MAX_TEXT)throw failure('This subtitle archive uses an unsupported format.');
    if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw failure('Invalid compressed subtitle.');
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
    if(start+packed>bytes.length)throw failure('Incomplete subtitle archive.');
    const input=bytes.subarray(start,start+packed);let data;
    try{data=method===0?input:inflateRawSync(input,{maxOutputLength:MAX_TEXT});}catch{throw failure('Could not unpack this subtitle safely.');}
    if(data.length!==size)throw failure('The subtitle archive has an invalid file length.');
    candidates.push({name,text:decodeText(data)});
  }
  if(!candidates.length)throw failure('This ZIP contains no supported subtitle text files.');
  if(candidates.length>1){
    const selected=choose?.(candidates);
    if(selected)return selected;
    throw failure('This download contains multiple subtitle files. Download an individual episode or import the matching subtitle file.');
  }
  return candidates[0];
}

export function createSubtitles({local,fetchImpl=fetch}){
  const folder=path.join(local,'subtitles'),known=new Map(),cache=new Map();let active=0;
  async function readRemote(url,{max=MAX_TEXT,redirects=0,deadline=Date.now()+25000,payload}={}){
    const u=new URL(url),method=payload?'POST':'GET';
    if(!allowedSubtitleUrl(u,method))throw failure('Unsupported subtitle provider address.',400);
    if(redirects>3)throw failure('The subtitle provider redirected too many times.',502);
    if(Date.now()>=deadline)throw failure('The subtitle search took too long. Narrow the title or try again later.',503);
    const headers={'User-Agent':'Cinema/2.0 (personal subtitle client)','Accept':payload?'application/json':'text/html,application/zip,text/plain;q=0.9'};
    if(payload)headers['Content-Type']='application/json';
    let response;try{response=await fetchImpl(u,{method,redirect:'manual',credentials:'omit',headers,body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(Math.max(1,Math.min(12000,deadline-Date.now())))});}catch{throw failure('The subtitle provider could not be reached. Import a local subtitle or try again later.',503);}
    if([301,302,303,307,308].includes(response.status)){
      const next=new URL(response.headers.get('location')||'',u);await response.body?.cancel();
      if(u.origin===SUBSOURCE_API||u.origin===SOURCES.subsource.origin)throw failure('The subtitle provider redirected unexpectedly.',502);
      return readRemote(next,{max,redirects:redirects+1,deadline});
    }
    if(!response.ok){await response.body?.cancel();throw failure(`The subtitle provider returned HTTP ${response.status}. Try another result or import a local file.`,502);}
    if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw failure('The provider response exceeds the subtitle size limit.',413);}
    const parts=[];let size=0;try{for await(const chunk of response.body){size+=chunk.length;if(size>max)throw failure('The provider response exceeds the subtitle size limit.',413);parts.push(chunk);}}catch(e){if(e.status)throw e;throw failure('The subtitle download was interrupted. Try again.',503);}
    return {bytes:Buffer.concat(parts),type:response.headers.get('content-type')||''};
  }
  async function page(url,deadline){const previous=cache.get(url);if(previous&&Date.now()-previous.at<600000)return previous.html;const {bytes}=await readRemote(url,{deadline});const html=decodeText(bytes);if(!/<(?:html|a|tr)\b/i.test(html)||/captcha|cf-chl-|verify you are human/i.test(html))throw failure('This subtitle provider is currently unavailable to the app. Local subtitle import still works.',503);cache.set(url,{at:Date.now(),html});if(cache.size>40)cache.delete(cache.keys().next().value);return html;}
  function register(source,id,title,release='',reference=''){
    const sourceUrl=SOURCES[source].origin+(source==='subsource'?id:'/subtitle-'+id+'.html');
    const key=createHash('sha256').update(sourceUrl).update('\0'+reference).digest('hex').slice(0,32);
    known.set(key,{source,id,title,sourceUrl,release,reference,at:Date.now()});if(known.size>1000)known.delete(known.keys().next().value);
    return {id:key,title:plain(title).trim().slice(0,240),release:plain(release).trim().slice(0,120),language:'en',source:SOURCES[source].name,sourceUrl};
  }
  function subtitleLinks(html,source,fallback){
    const results=[];for(const m of html.matchAll(/<a\b[^>]*href=["']\/?subtitle-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi)){
      if(!/flags\/en\.gif|english subtitles/i.test(m[0]))continue;
      const heading=/<(?:h5|b)\b[^>]*>([\s\S]*?)<\/(?:h5|b)>/i.exec(m[2]);const label=plain(heading?.[1]||fallback).trim();
      results.push(register(source,m[1],label,/\(([^()]*)\)\s*$/.exec(label)?.[1]||''));
    }return [...new Map(results.map(r=>[r.id,r])).values()];
  }
  async function movieSearch(query,year,deadline){
    const first=norm(query).replace(/^(?:the|a|an) /,'')[0]||'0',letter=/[a-z]/.test(first)?first.toUpperCase():'0';
    const html=await page(SOURCES.movie.origin+(letter==='A'?'/movies.html':`/movies-${letter}.html`),deadline);
    const choices=[];for(const m of html.matchAll(/<a\b[^>]*href=["']\/?movie-(\d+)\.html["'][^>]*>([\s\S]*?)<\/a>/gi)){
      const title=plain(/<b>([\s\S]*?)<\/b>/i.exec(m[2])?.[1]||'');
      const indexedYear=releaseYear(plain(m[2].replace(/<b\b[^>]*>[\s\S]*?<\/b>/i,'').replace(/<[^>]*>/g,' ')));
      if(!legacyTitleMatches(title,query)||!m[2].includes('flags/en.gif')||year&&indexedYear!==year)continue;
      choices.push({id:m[1],title});
    }
    const result=await Promise.all(choices.slice(0,3).map(async c=>subtitleLinks(await page(`${SOURCES.movie.origin}/movie-${c.id}.html`,deadline),'movie',c.title)));
    return result.flat();
  }
  async function subsourceSearch(query,year,reference,deadline){
    // The public site uses this endpoint for its search field. No account or API key is sent.
    const {bytes,type}=await readRemote(SUBSOURCE_API+'/v1/movie/search',{max:256*1024,deadline,payload:{query,includeSeasons:false,limit:15}});
    if(!type.includes('application/json'))throw failure('The public subtitle index returned an unexpected response.',502);
    let data;
    try{data=JSON.parse(decodeText(bytes));}catch{throw failure('The public subtitle index returned an invalid response.',502);}
    if(!data?.success||!Array.isArray(data.results))throw failure('The public subtitle index returned an incomplete response.',502);
    const matches=new Map();
    for(const result of data.results.slice(0,15)){
      if(result?.type!=='movie'||typeof result.title!=='string'||!sameTitle(result.title,query))continue;
      if(typeof result.link!=='string'||!/^\/subtitles\/[a-z\d-]{1,160}$/.test(result.link))continue;
      const indexedYear=Number(result.releaseYear);
      if(!Number.isInteger(indexedYear)||indexedYear<1900||indexedYear>2099||year&&Math.abs(indexedYear-year)>1)continue;
      matches.set(result.link,{title:result.title,link:result.link,year:indexedYear});
    }
    const candidates=[...matches.values()],exact=year?candidates.filter(item=>item.year===year):[];
    const choices=exact.length?exact:candidates;
    if(choices.length!==1)return [];
    const movie=choices[0],slug=movie.link.split('/').at(-1);
    const requestedYear=year?new RegExp('\\b'+year+'\\b'):null;
    const html=await page(SOURCES.subsource.origin+movie.link+'/english',deadline),entries=new Map();
    let requestedYearFound=false;
    for(const match of html.matchAll(/<a\b[^>]*href=["'](\/subtitle\/([a-z\d-]+)\/english\/\d{1,12})["'][^>]*>([^<]*)<\/a>/gi)){
      if(match[2]!==slug)continue;
      const release=plain(match[3]).trim().replace(/^English\s+[—–-]\s*/i,'');
      if(!release)continue;
      if(requestedYear?.test(release))requestedYearFound=true;
      const score=releaseScore(release,reference),previous=entries.get(match[1]);
      if(!previous||score>previous.score)entries.set(match[1],{link:match[1],release,score});
    }
    // A nearby premiere year is accepted only when the matching catalog also lists the requested release year.
    if(year&&movie.year!==year&&!requestedYearFound)return [];
    return [...entries.values()].sort((a,b)=>b.score-a.score).slice(0,30).map(item=>
      register('subsource',item.link,movie.title+' ('+movie.year+')',item.release,reference));
  }
  async function tvSearch(query,year,season,episode,deadline){
    const html=await page(SOURCES.tv.origin+'/tvshows.html',deadline),choices=[];
    for(const m of html.matchAll(/<a\b[^>]*href=["']\/?tvshow-(\d+)-\d+\.html["'][^>]*>([\s\S]*?)<\/a>(?:\s*<\/td>(?:\s*<td[^>]*>\d+<\/td>){3}\s*<td[^>]*>([^<]*)<\/td>)?/gi)){
      const title=plain(m[2]).trim(),indexedYear=releaseYear(m[3]||'');
      if(legacyTitleMatches(title,query)&&(!year||!indexedYear||year===indexedYear))choices.push({id:m[1],title});
    }
    const results=[];
    for(const show of choices.slice(0,2)){
      const s=season||1,list=await page(`${SOURCES.tv.origin}/tvshow-${show.id}-${s}.html`,deadline),episodes=[];
      for(const row of list.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
        const num=/<td[^>]*>\s*(\d+)x(\d+)\s*<\/td>/i.exec(row[1]);if(!num||Number(num[1])!==s||episode&&Number(num[2])!==episode)continue;
        const link=/href=["']\/?episode-(\d+)\.html["']/i.exec(row[1]);if(link)episodes.push({id:link[1],number:Number(num[2])});
      }
      episodes.sort((a,b)=>a.number-b.number);
      for(const ep of episodes.slice(0,episode?1:3))results.push(...subtitleLinks(await page(`${SOURCES.tv.origin}/episode-${ep.id}-en.html`,deadline),'tv',`${show.title} S${s}E${ep.number}`));
    }
    return results;
  }
  async function save({name,text}){
    const converted=toWebVtt(text,name),id=randomBytes(16).toString('hex');await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,id+'.vtt'),converted.vtt,'utf8');
    return {id,name:cleanName(name),language:'en',url:'/api/subtitles/file?id='+id,cues:converted.cues};
  }
  async function providerResult(source,work){
    try{return {source,results:await work()};}
    catch(error){return {source,results:[],error:error.message};}
  }
  async function movieProviders(query,year,reference,deadline){
    const modern=await providerResult('subsource',()=>subsourceSearch(query,year,reference,Math.min(deadline,Date.now()+7000)));
    if(modern.results.length)return [modern];
    const legacy=await providerResult('movie',()=>movieSearch(query,year,deadline));
    return legacy.results.length&&modern.error?[legacy]:[modern,legacy];
  }
  return {
    async search({query,language='en',year,kind,isSeries,release,season,episode}={}){
      if(language!=='en')throw failure('Online subtitle search currently supports English. Import a local file for another language.');
      if(typeof query!=='string'||query.trim().length<2||query.length>200)throw failure('Enter a title between 2 and 200 characters.');
      const episodic=/\bS(\d{1,2})E(\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/i.exec(query.replace(/[._]/g,' '));
      season=season===''||season===undefined?Number(episodic?.[1]||episodic?.[3])||undefined:Number(season);episode=episode===''||episode===undefined?Number(episodic?.[2]||episodic?.[4])||undefined:Number(episode);
      if(season!==undefined&&(!Number.isInteger(season)||season<1||season>100)||episode!==undefined&&(!Number.isInteger(episode)||episode<1||episode>1000))throw failure('Enter a valid season and episode number.');
      year=year===undefined||year===''?undefined:Number(year);
      if(year!==undefined&&(!Number.isInteger(year)||year<1900||year>2099))throw failure('Enter a valid release year.');
      const reference=typeof release==='string'&&release.trim()?release.trim().slice(0,512):query;
      const parsed=titleQuery(query,{parseYear:year===undefined}),file=titleQuery(reference);
      query=parsed.query;
      year=year||parsed.year||(sameTitle(query,file.query)?file.year:undefined);
      if(norm(query).length<2)throw failure('Enter the movie or show title.');
      const mediaType=season||episode||isSeries===true?'tv':isSeries===false||['movie','movies'].includes(kind)?'movie':['tv','series','korean'].includes(kind)?'tv':null;
      if(active>=3)throw failure('A subtitle search is already running. Please wait a moment.',429);active++;
      try{
        const deadline=Date.now()+25000,tasks=[];
        if(mediaType!=='tv')tasks.push(movieProviders(query,year,reference,deadline));
        if(mediaType!=='movie')tasks.push(providerResult('tv',()=>tvSearch(query,year,season,episode,deadline)));
        const responses=(await Promise.all(tasks)).flat();
        return {results:responses.flatMap(r=>r.results).slice(0,60),warnings:responses.filter(r=>r.error).map(r=>`${SOURCES[r.source].name}: ${r.error}`),providers:responses.map(r=>({name:SOURCES[r.source].name,status:r.error?'unavailable':'available',message:r.error||'Public English subtitle index'}))};
      }finally{active--;}
    },
    async download({id}={}){
      const selected=known.get(id);if(!selected||Date.now()-selected.at>1800000)throw failure('This subtitle result expired. Search again.',404);
      if(selected.source==='subsource'){
        const html=await page(selected.sourceUrl,Date.now()+12000);
        const target=/href=["'](https:\/\/api\.subsource\.net\/v1\/subtitle\/download\/[a-f0-9]{64})["']/i.exec(html)?.[1];
        if(!target)throw failure('The subtitle provider did not offer a direct download. Choose another result or import a local file.',502);
        const download=await readRemote(target,{max:MAX_ZIP});
        return save(subtitleFromZip(download.bytes,candidates=>
          chooseSubtitleVariant(candidates,platformTags(selected.release).length===1?selected.release:selected.reference)));
      }
      let url=`${SOURCES[selected.source].origin}/download-${selected.id}.html`,download=await readRemote(url,{max:MAX_ZIP});
      if(download.bytes.length<4||download.bytes.readUInt32LE(0)!==0x04034b50){
        const html=decodeText(download.bytes),literals=new Map([...html.matchAll(/var\s+(s\d+)\s*=\s*'([^'\r\n]*)'\s*;/g)].map(m=>[m[1],m[2]]));
        const expression=/document\.location\s*=\s*(s\d+(?:\s*\+\s*s\d+)*)\s*;/.exec(html)?.[1];
        const target=expression?.split(/\s*\+\s*/).map(key=>literals.get(key)||'').join('');
        if(!target||!/^files\/[^\x00-\x1f]+\.zip$/i.test(target)||target.includes('..'))throw failure('The provider did not offer a direct subtitle download. Import a local file or try another result.',502);
        url=new URL(target,SOURCES[selected.source].origin+'/').href;download=await readRemote(url,{max:MAX_ZIP});
      }
      const extracted=subtitleFromZip(download.bytes);return save(extracted);
    },
    import:save,
    async get(id){if(!/^[a-f\d]{32}$/.test(id||''))throw failure('Subtitle not found',404);return fs.readFile(path.join(folder,id+'.vtt'),'utf8').catch(()=>{throw failure('Subtitle not found',404);});},
  };
}

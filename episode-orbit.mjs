import {plainText} from './metadata.mjs';

const SHOW=/^tvmaze-([1-9]\d{0,7})$/;
const EPISODE_LINK=/^https:\/\/api\.tvmaze\.com\/episodes\/([1-9]\d{0,15})$/;
const SHOW_ORDER_LINK=/^https:\/\/www\.tvmaze\.com\/alternatelists\/([1-9]\d{0,15})(?:\/[a-z0-9-]+)?$/i;
const INDEX_BYTES=256*1024, ORDER_BYTES=3*1024*1024;
const POSITIVE_TTL=6*60*60*1000, EMPTY_TTL=30*60*1000;
const ORDER_TYPES=[
  ['dvd_release','DVD release'],['verbatim_order','Verbatim order'],['country_premiere','Country premiere'],
  ['streaming_premiere','Streaming premiere'],['broadcast_premiere','Broadcast premiere'],['language_premiere','Language premiere']
];
const error=(message,status=400)=>Object.assign(Error(message),{status});
const invalid=()=>error('TVmaze returned an invalid watch order. Try again.',502);
const safeId=value=>Number.isSafeInteger(value)&&value>0;
const position=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const title=value=>typeof value==='string'?plainText(value).slice(0,180):'';

function showNumber(showId) {
  const match=typeof showId==='string'?SHOW.exec(showId):null;
  if(!match)throw error('Choose a verified TVmaze show.');
  return match[1];
}
function providerRows(rows,limit) {
  if(!Array.isArray(rows)||rows.length>limit)throw invalid();
  const ids=new Set();
  for(const row of rows){
    if(!safeId(row?.id)||ids.has(row.id))throw invalid();
    ids.add(row.id);
  }
  return rows;
}
function orderDescriptor(row) {
  const label=ORDER_TYPES.filter(([key])=>row[key]===true).map(([,label])=>label).join(' · ')||'Alternate order';
  const source=typeof row.url==='string'&&row.url.length<=240?SHOW_ORDER_LINK.exec(row.url):null;
  return {id:row.id,label,sourceUrl:source?.[1]===String(row.id)?row.url:'https://www.tvmaze.com/alternatelists/'+row.id};
}
function canonicalEpisodes(showId,catalog) {
  if(catalog?.show?.id!==showId||!Array.isArray(catalog.episodes))throw invalid();
  return new Map(catalog.episodes.filter(row=>/^tvmaze-episode-[1-9]\d{0,15}$/.test(row?.id)).map(row=>[
    row.id,{id:row.id,title:title(row.title)||'Untitled episode',season:position(row.season),
      number:position(row.number),special:row.special===true}
  ]));
}
function projectOrder(rows,canonical) {
  const occurrences=new Map();
  const projected=rows.map(row=>{
    const matched=new Map(),links=row._links?.episodes;
    let invalidLink=false;
    if(Array.isArray(links)){
      if(links.length>32)throw invalid();
      for(const link of links){
        const match=typeof link?.href==='string'?EPISODE_LINK.exec(link.href):null;
        const episode=match&&canonical.get('tvmaze-episode-'+match[1]);
        if(episode)matched.set(episode.id,episode);
        else invalidLink=true;
      }
    }
    for(const id of matched.keys())occurrences.set(id,(occurrences.get(id)||0)+1);
    const number=position(row.number);
    return {id:row.id,title:title(row.name)||'Untitled episode',season:position(row.season),number,
      special:number===null||Boolean(row.type&&row.type!=='regular'),split:false,merged:matched.size>1,
      incomplete:matched.size>0&&invalidLink,canonical:[...matched.values()]};
  });
  projected.sort((a,b)=>(a.season??Infinity)-(b.season??Infinity)||(a.number??Infinity)-(b.number??Infinity)||a.id-b.id);
  const bySeason=new Map();
  for(const row of projected){
    row.split=row.canonical.some(episode=>occurrences.get(episode.id)>1);
    if(!bySeason.has(row.season))bySeason.set(row.season,[]);
    bySeason.get(row.season).push(row);
  }
  const seasons=[...bySeason].map(([number,episodes])=>({number,count:episodes.length}));
  return {bySeason,seasons,coveredCount:occurrences.size,canonicalCount:canonical.size};
}

export function createEpisodeOrbit({request,catalog,now=Date.now}) {
  const cache=new Map(),pending=new Map();
  function load(key,loader,isEmpty) {
    const current=cache.get(key);
    if(current&&current.expiresAt>now()){
      cache.delete(key);cache.set(key,current);
      return current.value;
    }
    cache.delete(key);
    if(pending.has(key))return pending.get(key);
    if(pending.size>=8)throw error('Several watch orders are loading. Try again shortly.',429);
    const work=Promise.resolve().then(loader).then(value=>{
      cache.set(key,{value,expiresAt:now()+(isEmpty(value)?EMPTY_TTL:POSITIVE_TTL)});
      while(cache.size>32)cache.delete(cache.keys().next().value);
      return value;
    }).finally(()=>pending.delete(key));
    pending.set(key,work);
    return work;
  }
  async function orders(input) {
    const showId=input?.showId, id=showNumber(showId);
    const rows=await load(showId,async()=>{
      const payload=await request('/shows/'+id+'/alternatelists',INDEX_BYTES);
      return providerRows(payload,32).map(orderDescriptor);
    },rows=>!rows.length);
    return {showId,orders:rows};
  }
  async function order(input) {
    const {showId,orderId,season,page=1}=input??{};
    showNumber(showId);
    if(!safeId(orderId)||!safeId(page)||(season!==undefined&&season!==null&&position(season)===null))
      throw error('Choose an exact watch order, season and page.');
    const available=await orders({showId});
    const descriptor=available.orders.find(row=>row.id===orderId);
    if(!descriptor)throw error('This watch order is unavailable for the selected show.',404);
    const value=await load(showId+':'+orderId,async()=>{
      const rows=providerRows(await request('/alternatelists/'+orderId+'/alternateepisodes',ORDER_BYTES),4096);
      const canonical=await catalog({id:showId});
      return projectOrder(rows,canonicalEpisodes(showId,canonical));
    },value=>!value.seasons.length);
    const {seasons,bySeason,coveredCount,canonicalCount}=value;
    const selected=season===undefined?seasons[0]?.number??null:season;
    if(seasons.length&&!bySeason.has(selected))throw error('This season is unavailable in the selected watch order.',404);
    const episodes=bySeason.get(selected)||[],totalRows=episodes.length;
    const totalPages=Math.max(1,Math.ceil(totalRows/24)), currentPage=Math.min(page,totalPages);
    return {showId,order:descriptor,seasons,season:selected,page:currentPage,totalPages,totalRows,coveredCount,canonicalCount,
      rows:episodes.slice((currentPage-1)*24,currentPage*24)};
  }
  return {orders,order};
}


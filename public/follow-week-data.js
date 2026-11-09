import {findVerifiedLocalEpisode} from './episodes.js';

const storageKey='cinema-follow-week-v1';
const limit=12;
const showIdPattern=/^tvmaze-[1-9]\d{0,7}$/;
const episodeIdPattern=/^tvmaze-episode-[1-9]\d{0,9}$/;
const normalized=value=>String(value??'').normalize('NFKC').toLowerCase()
  .replace(/^(?:\[[^\]]+\]\s*)+/,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

function followRecord(show){
  if(!showIdPattern.test(show?.id||'')||typeof show.title!=='string'||!show.title.trim())return null;
  const kind=['tv','korean','anime'].includes(show.kind)?show.kind:'tv';
  const record={id:show.id,title:show.title.trim().slice(0,160),kind,
    year:Number.isInteger(show.year)&&show.year>=1800&&show.year<=2200?show.year:null};
  if(typeof show.posterUrl==='string'&&show.posterUrl.startsWith('/api/metadata/poster?')&&show.posterUrl.length<=300){
    record.posterUrl=show.posterUrl;
  }
  return record;
}

export function createFollowStore(storage){
  let items=[];
  try{
    const stored=JSON.parse(storage.getItem(storageKey)||'[]');
    if(Array.isArray(stored)){
      const records=new Map();
      for(const entry of stored.slice(0,limit*2)){
        const record=followRecord(entry);
        if(record&&!records.has(record.id))records.set(record.id,record);
        if(records.size===limit)break;
      }
      items=[...records.values()];
    }
  }catch{}
  function save(next){
    try{storage.setItem(storageKey,JSON.stringify(next));}
    catch{return {ok:false,message:'Cinema couldn’t save this change. Try again.'};}
    items=next;
    return {ok:true};
  }
  return {
    list:()=>items.map(item=>({...item})),
    has:id=>items.some(item=>item.id===id),
    follow(show){
      const record=followRecord(show);
      if(!record)return {ok:false,message:'Open a verified episode guide to follow this series.'};
      if(items.some(item=>item.id===record.id))return {ok:true};
      if(items.length>=limit)return {ok:false,message:'You can follow 12 series. Unfollow one from This Week to add another.'};
      return save([...items,record]);
    },
    unfollow(id){
      const next=items.filter(item=>item.id!==id);
      return next.length===items.length?{ok:true}:save(next);
    },
  };
}

function candidateFiles(show,episode,library,history){
  const available=library.filter(item=>/^[a-f\d]{40,64}$/i.test(item.hash||'')&&
    !/error|missingFiles/i.test(item.state||''));
  const candidates=new Map(),previous=[];
  for(const {hash} of available){
    const entry=history[hash];
    const files=entry?.files?Object.values(entry.files):[entry];
    const sameShow=files.filter(file=>file?.episode?.showId===show.id)
      .sort((a,b)=>(b.updated||0)-(a.updated||0));
    if(!sameShow.length)continue;
    const exact=sameShow.find(file=>file.episode.episodeId===episode.id&&Number.isInteger(file.index)&&file.index>=0);
    previous.push({hash,expectedIndex:exact?.index??null,updated:exact?.updated??sameShow[0].updated??0});
  }
  previous.sort((a,b)=>Number(b.expectedIndex!==null)-Number(a.expectedIndex!==null)||b.updated-a.updated);
  for(const file of previous)candidates.set(file.hash,file);
  const title=normalized(show.title);
  for(const item of available){
    const release=normalized(item.name||item.title);
    if(title&&(release===title||release.startsWith(title+' '))&&!candidates.has(item.hash)){
      candidates.set(item.hash,{hash:item.hash,expectedIndex:null});
    }
  }
  return [...candidates.values()].slice(0,3);
}

export async function checkFollowEpisode({show,episode,getLibrary,getHistory,isConnected,
  api,getCaption,checkCaption,signal}){
  const notChecked='Not checked';
  const disconnected={source:'Check your qBittorrent connection',captions:notChecked};
  if(!isConnected())return disconnected;
  if(!showIdPattern.test(show?.id||'')||!episodeIdPattern.test(episode?.id||'')||episode.special||
    !Number.isInteger(episode.number)||episode.number<=0){
    return {source:'Exact file check unavailable for this episode',captions:notChecked};
  }
  const candidates=candidateFiles(show,episode,getLibrary(),getHistory());
  let failed=false;
  for(const candidate of candidates){
    signal?.throwIfAborted();
    if(!isConnected())return disconnected;
    const {hash,expectedIndex}=candidate;
    const target=await findVerifiedLocalEpisode(async(route,body)=>{
      try{return await api(route,body,signal);}
      catch(error){failed=true;throw error;}
    },{hash,showId:show.id,episodeId:episode.id,expectedIndex});
    signal?.throwIfAborted();
    if(!isConnected())return disconnected;
    const isPresent=()=>getLibrary().some(item=>item.hash===hash&&!/error|missingFiles/i.test(item.state||''));
    if(!target||!isPresent())continue;
    const record=getCaption(hash,target.index);
    const source='Episode file in My Library';
    if(!/^[a-f\d]{32}$/.test(record?.id||''))return {source,captions:'No track saved for this file'};
    let exists;
    try{exists=await checkCaption(record.id,signal);}
    catch{exists=null;}
    signal?.throwIfAborted();
    if(!isConnected())return disconnected;
    if(!isPresent())continue;
    if(getCaption(hash,target.index)?.id!==record.id)return {source,captions:notChecked};
    const captions=exists===null?'Couldn’t check the saved track':!exists?'Saved track missing':
      record.origin==='english-search'?'English track saved':'Track saved · language unconfirmed';
    return {source,captions};
  }
  return {source:failed?'Library check incomplete':'No match in checked library releases',captions:notChecked};
}

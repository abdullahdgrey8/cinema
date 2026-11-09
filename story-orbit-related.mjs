const sourceUrl='https://www.wikidata.org/w/api.php';
const showIdPattern=/^tvmaze-([1-9]\d{0,7})$/;
const tvmazeIdPattern=/^[1-9]\d{0,7}$/;
const itemIdPattern=/^Q[1-9]\d{0,11}$/;
const imdbIdPattern=/^tt\d{7,12}$/;
const maxBytes=1024*1024;
const maxTargets=8;
const hour=60*60*1000;
const fault=(message,status=502)=>Object.assign(Error(message),{status});
const unavailable=()=>fault('Related titles are unavailable. Try again in a moment.');

function claimValues(entity,property,read){
  const statements=entity?.claims?.[property];
  if(!Array.isArray(statements))return [];
  const values=new Set();
  for(const statement of statements){
    const snak=statement?.mainsnak;
    if(!['normal','preferred'].includes(statement?.rank)||snak?.snaktype!=='value')continue;
    const value=read(snak.datavalue?.value);
    if(value!==null)values.add(value);
  }
  return [...values];
}

const asString=value=>typeof value==='string'?value:null;
const asItem=value=>value?.['entity-type']==='item'&&typeof value.id==='string'&&itemIdPattern.test(value.id)?value.id:null;
const asYear=value=>{
  const match=/^\+(\d{4})-/.exec(value?.time||'');
  return match&&Number(value.precision)>=9?Number(match[1]):null;
};
const exactValue=(values,pattern)=>values.length===1&&pattern.test(values[0])?values[0]:null;

function relatedItem(entity,relation,sourceId){
  const id=entity?.id,label=entity?.labels?.en?.value;
  const title=typeof label==='string'?label.trim():'';
  if(!title||title.length>160)return null;
  const types=claimValues(entity,'P31',asItem),film=types.includes('Q11424');
  const tvmaze=claimValues(entity,'P8600',asString);
  const provider=exactValue(tvmaze,tvmazeIdPattern);
  const imdb=exactValue(claimValues(entity,'P345',asString),imdbIdPattern);
  const years=claimValues(entity,'P577',asYear),year=years.length===1?years[0]:null;
  const item={title,year,relation,sourceUrl:'https://www.wikidata.org/wiki/'+id};
  if(provider&&!film&&provider!==sourceId)
    return {key:'tvmaze-'+provider,item:{id:'tvmaze-'+provider,kind:'tv',...item}};
  if(film&&imdb&&!tvmaze.length)
    return {key:imdb,item:{id:'wikidata-'+id,kind:'movies',...item}};
  return null;
}

function targetEdges(source){
  const before=new Set(claimValues(source,'P155',asItem));
  const after=new Set(claimValues(source,'P156',asItem));
  before.delete(source.id);
  after.delete(source.id);
  const conflicting=[...before].filter(id=>after.has(id));
  for(const id of conflicting){
    before.delete(id);
    after.delete(id);
  }
  const all=[
    ...[...before].map(id=>({id,relation:'follows'})),
    ...[...after].map(id=>({id,relation:'followed-by'}))
  ];
  return {edges:all.slice(0,maxTargets),partial:all.length>maxTargets||conflicting.length>0};
}

export function createRelatedTitles({fetchImpl=fetch,now=Date.now}={}){
  const pending=new Map(),cache=new Map();
  let closed=false;

  async function request(parameters,signal){
    const url=new URL(sourceUrl);
    url.search=new URLSearchParams({...parameters,format:'json'});
    try{
      const response=await fetchImpl(url,{headers:{'User-Agent':'CinemaLocal/2.14 (personal media metadata and local watch orders)'},
        redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(4000)])});
      if(!response.ok||Number(response.headers.get('content-length'))>maxBytes){
        await response.body?.cancel().catch(()=>{});
        throw unavailable();
      }
      const chunks=[];
      let bytes=0;
      for await(const chunk of response.body){
        bytes+=chunk.length;
        if(bytes>maxBytes)throw unavailable();
        chunks.push(chunk);
      }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!data||typeof data!=='object'||data.error)throw unavailable();
      return data;
    }catch{
      throw unavailable();
    }
  }

  async function entities(ids,signal){
    const data=await request({action:'wbgetentities',ids:ids.join('|'),props:'labels|claims',languages:'en'},signal);
    if(!data.entities||typeof data.entities!=='object'||Array.isArray(data.entities))throw unavailable();
    return new Map(ids.flatMap(id=>{
      const entity=data.entities[id];
      return entity?.id===id&&!('missing' in entity)?[[id,entity]]:[];
    }));
  }

  async function load(showId,sourceId,signal){
    const data=await request({action:'query',list:'search',srnamespace:'0',srlimit:'3',srinfo:'totalhits',
      srprop:'',srsearch:'haswbstatement:P8600='+sourceId},signal);
    const search=data.query?.search,total=data.query?.searchinfo?.totalhits;
    if(!Array.isArray(search)||!Number.isSafeInteger(total)||total<0)throw unavailable();
    if(total>3||search.length>3)return {showId,partial:true,items:[]};
    const ids=[...new Set(search.map(row=>row?.title).filter(id=>typeof id==='string'&&itemIdPattern.test(id)))];
    if(ids.length!==total)return {showId,partial:true,items:[]};
    if(!ids.length)return {showId,partial:false,items:[]};
    const candidates=await entities(ids,signal);
    const sources=[...candidates.values()].filter(entity=>exactValue(claimValues(entity,'P8600',asString),tvmazeIdPattern)===sourceId);
    if(sources.length!==1||candidates.size!==ids.length)return {showId,partial:true,items:[]};
    const {edges,partial}=targetEdges(sources[0]);
    if(!edges.length)return {showId,partial,items:[]};
    const targets=await entities(edges.map(edge=>edge.id),signal);
    const mapped=edges.flatMap(({id,relation})=>{
      const result=relatedItem(targets.get(id),relation,sourceId);
      return result?[result]:[];
    });
    const seen=new Map();
    for(const row of mapped)seen.set(row.key,(seen.get(row.key)||0)+1);
    const items=mapped.filter(row=>seen.get(row.key)===1).map(row=>row.item);
    return {showId,partial:partial||items.length!==edges.length,items};
  }

  async function related({showId}={}){
    if(closed)throw fault('Related title lookup has stopped.',503);
    const valid=typeof showId==='string'?showIdPattern.exec(showId):null;
    if(!valid)throw fault('Choose a verified TVmaze show.',400);
    const cached=cache.get(showId);
    if(cached&&cached.until>now())return cached.value;
    if(pending.has(showId))return pending.get(showId).promise;
    if(pending.size>=2)throw fault('Other related titles are loading. Try again shortly.',429);
    const controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10000)]);
    const promise=load(showId,valid[1],signal).then(value=>{
      if(!closed){
        cache.delete(showId);
        cache.set(showId,{value,until:now()+(value.items.length?6*hour:hour/2)});
        while(cache.size>24)cache.delete(cache.keys().next().value);
      }
      return value;
    }).finally(()=>pending.delete(showId));
    pending.set(showId,{promise,controller});
    return promise;
  }

  return {related,close(){
    closed=true;
    for(const {controller} of pending.values())controller.abort();
    cache.clear();
  }};
}

const fullHash=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const knownCondition=new Set(['downloading','downloaded']);
const knownMode=new Set(['direct','hls']);
const durationFormat=new Intl.NumberFormat(undefined,{maximumFractionDigits:1});

export function sourceMemoryCohorts(source,view,library){
  const aliases=source?.memoryAliases;
  if(!view?.enabled||!view.available||!view.observed?.length||!Array.isArray(aliases)||
    !aliases.length||aliases.length>2||aliases.some(alias=>typeof alias!=='string'||!fullHash.test(alias))||
    new Set(aliases.map(alias=>alias.length)).size!==aliases.length)return [];
  const matchesFamily=(item,alias)=>{
    const candidate=item[alias.length===40?'infohash_v1':'infohash_v2'];
    return typeof candidate==='string'&&candidate.toLowerCase()===alias;
  };
  const matches=library.filter(item=>aliases.some(alias=>matchesFamily(item,alias)));
  if(matches.length!==1||!aliases.every(alias=>matchesFamily(matches[0],alias)))return [];
  const record=view.observed.find(item=>item.hash===matches[0].hash);
  return record?.cohorts?.filter(item=>knownCondition.has(item.condition)&&knownMode.has(item.mode)&&
    Number.isSafeInteger(item.count)&&item.count>0&&Number.isFinite(item.medianMs)&&item.medianMs>=0)||[];
}

export function sourceMemoryLabel({condition,mode,count,medianMs}){
  const elapsed=medianMs<60000?durationFormat.format(medianMs/1000)+' sec':durationFormat.format(medianMs/60000)+' min';
  return [condition==='downloading'?'While downloading':'Already downloaded',mode==='direct'?'Direct':'Prepared stream',
    count===1?elapsed:elapsed+' median',count+' observed '+(count===1?'start':'starts')].join(' · ');
}

export function firstPictureDuration({startedAt,frameAt,frameSeenAt,playingAt}){
  if(![startedAt,frameAt,frameSeenAt,playingAt].every(Number.isFinite)||frameAt<startedAt||
    frameAt>frameSeenAt||playingAt<startedAt||Math.abs(playingAt-frameSeenAt)>1000||
    frameAt-startedAt>30*60*1000)return null;
  return Math.round(frameAt-startedAt);
}

export function isOpeningBufferAlignment(time,bufferStart,padding){
  return [time,bufferStart,padding].every(Number.isFinite)&&bufferStart>0&&bufferStart<=.25&&
    padding>0&&time<=.5&&Math.abs(time-bufferStart-padding)<.001;
}

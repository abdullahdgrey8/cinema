// Read only the ten free records used by FUNdex's public current-week page.
// Historical requests and the provider's additional/subscriber rows are omitted.
export const FUNDEX_PAGE='https://www.fundex.co.kr/fxmain.do';
const FUNDEX_DATA='https://www.fundex.co.kr/select/nowplay.getOqlistNew.do';
const DAY=86400000,SIX_HOURS=6*60*60*1000;
const clean=value=>typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/\s+/g,' ').trim().slice(0,400):'';
const date=value=>{if(!/^\d{8}$/.test(value||''))return null;const iso=`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;return Number.isFinite(Date.parse(iso))&&new Date(iso).toISOString().slice(0,10)===iso?iso:null;};
function isoWeek(value){
  if(!/^\d{6}$/.test(value))return null;const year=Number(value.slice(0,4)),week=Number(value.slice(4));if(year<2000||year>2100||week<1||week>53)return null;
  const jan4=new Date(Date.UTC(year,0,4)),start=jan4.getTime()-((jan4.getUTCDay()+6)%7)*DAY+(week-1)*7*DAY,end=start+6*DAY;
  // An ISO week belongs to the year containing its Thursday.
  if(new Date(start+3*DAY).getUTCFullYear()!==year)return null;
  return {periodStart:new Date(start).toISOString().slice(0,10),periodEnd:new Date(end).toISOString().slice(0,10)};
}
export function parseFundexPage(html,{now=Date.now()}={}){
  const document=String(html).replace(/<!--[\s\S]*?-->/g,''),published=/Last updated on\s*<span[^>]*>\s*([A-Za-z]+)\s+(\d{1,2})\.(\d{4})\./i.exec(document);
  if(!published)throw Error('FUNdex did not publish a readable update date.');
  const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(published[1].toLowerCase()),publishedAt=month<0?null:date(published[3]+String(month+1).padStart(2,'0')+published[2].padStart(2,'0'));
  if(!publishedAt||Date.parse(publishedAt)>now+DAY)throw Error('FUNdex published an invalid update date.');
  const advertised=new Set([...document.matchAll(/\b__WCD\s*=\s*['"](\d{6})['"]/g)].map(match=>match[1])),requested=[...new Set([...document.matchAll(/\bparams\.wcd\s*=\s*['"](\d{6})['"]/g)].map(match=>match[1]))];
  const candidates=requested.filter(week=>advertised.has(week)).map(week=>({week,...isoWeek(week)})).filter(value=>value.periodEnd&&Date.parse(publishedAt)>=Date.parse(value.periodEnd)&&Date.parse(publishedAt)-Date.parse(value.periodEnd)<=10*DAY);
  if(candidates.length!==1)throw Error('FUNdex chart week could not be verified against its update date.');
  return {...candidates[0],publishedAt};
}
export function parseFundexRecords(records,period,{now=Date.now()}={}){
  if(!Array.isArray(records))throw Error('FUNdex returned an invalid public chart.');
  const seen=new Set(),items=[];
  for(const entry of records.slice(0,10)){
    const sourceId=Number(entry?.pj_seq),rank=Number(entry?.cat_rank),nativeTitle=clean(entry?.pjname),englishTitle=clean(entry?.epjname),premiered=date(entry?.startday),title=englishTitle||nativeTitle;
    if(!Number.isSafeInteger(sourceId)||sourceId<=0||sourceId>99999999||entry.cat_id!=='cat001'||!title||!Number.isInteger(rank)||rank<1||rank>10||seen.has(sourceId))continue;
    const share=Number(entry.cat_sharepoint),sourceUrl=`https://www.fundex.co.kr/fundex/funprogram.do?pjseq=${sourceId}`;seen.add(sourceId);
    items.push({id:'fundex-'+sourceId,title,alternateTitle:nativeTitle&&nativeTitle!==title?nativeTitle:'',aliases:[...new Set([title,nativeTitle].filter(Boolean))],kind:'tv',browseCategory:'korean',isSeries:true,year:premiered?Number(premiered.slice(0,4)):null,premiered,upcoming:Boolean(premiered&&Date.parse(premiered)>now),confidence:1,overview:'',posterRemote:`https://www.fundex.co.kr/pjmeta/pjimg/pj_${sourceId}.jpg`,source:'FUNdex / GoodData',sourceUrl,attribution:'FUNdex public weekly K-content online buzz chart; artwork belongs to its rights holders',genres:clean(entry.genre_list).split(',').map(value=>value.trim()).filter(Boolean).slice(0,6),chartRank:rank,...(Number.isFinite(share)&&share>=0&&share<=100?{buzzShare:share}:{}),chartWeeks:[period.periodEnd]});
  }
  if(!items.length)throw Error('FUNdex did not return any readable public drama rankings.');return items.sort((a,b)=>a.chartRank-b.chartRank);
}
export function createFundexCatalog({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=15000}={}){
  let cache=null,pending=null,lastFailure=null,retryAt=0;const closing=new AbortController();
  async function read(url,{body,maximum,type}){
    if(![FUNDEX_PAGE,FUNDEX_DATA].includes(url))throw Error('Unsupported FUNdex URL.');
    const response=await fetchImpl(url,{method:body?'POST':'GET',redirect:'manual',credentials:'omit',headers:{Accept:type,'User-Agent':'CinemaLocal/3.0 (cached public chart reader)',...(body?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}:{})},...(body?{body}:{}),signal:AbortSignal.any([closing.signal,AbortSignal.timeout(timeoutMs)])});
    if(!response.ok||response.status>=300){await response.body?.cancel();throw Error(`FUNdex returned HTTP ${response.status}; redirects are not followed.`);}
    if(response.url&&response.url!==url){await response.body?.cancel();throw Error('FUNdex returned an unexpected response URL.');}
    // The public JSON endpoint currently omits Content-Type. Its bounded body
    // must still parse as JSON; missing types are allowed only on that URL.
    const contentType=response.headers.get('content-type')?.toLowerCase()||'',validType=contentType.includes(type)||url===FUNDEX_DATA&&!contentType;
    if(!validType||Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw Error('FUNdex returned an unexpected content type or oversized response.');}
    const reader=response.body?.getReader();if(!reader)throw Error('FUNdex returned an empty response.');let total=0,text='';const decoder=new TextDecoder();
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maximum){await reader.cancel();throw Error('FUNdex response exceeded the size limit.');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}return text;
  }
  async function discovery({refresh=false}={}){
    if(!refresh&&cache?.expiresAt>now())return {...structuredClone(cache.row),cached:true};if(pending)return pending;
    if(!refresh&&retryAt>now()){if(cache)return {...structuredClone(cache.row),cached:true,stale:true,warning:lastFailure};throw Error(lastFailure);}
    pending=(async()=>{
      try{
        const period=parseFundexPage(await read(FUNDEX_PAGE,{maximum:512*1024,type:'text/html'}),{now:now()}),params={perPage:10,pageoff:0,clsid:null,is_ott:'ott',order:'oqpoint',cat_id:'cat001',wcd:period.week,wtype:'week',table:'tvr_week_rank_nor_ott'};
        const records=JSON.parse(await read(FUNDEX_DATA,{body:new URLSearchParams({param:JSON.stringify(params)}).toString(),maximum:256*1024,type:'application/json'})),items=parseFundexRecords(records,period,{now:now()});
        const row={id:'korean',title:'Popular Korean series',kind:'tv',period:'week',periodLabel:'Latest published week',periodStart:period.periodStart,periodEnd:period.periodEnd,publishedAt:period.publishedAt,source:'FUNdex / GoodData weekly drama buzz',sourceUrl:FUNDEX_PAGE,sourceUrls:[FUNDEX_PAGE],description:`FUNdex public Top 10 Korean TV/OTT drama buzz · ${period.periodStart} to ${period.periodEnd} · includes upcoming titles`,rankingMethod:'Online buzz share from news, communities, videos and social media; not viewers or availability',items,curated:false,stale:now()-Date.parse(period.periodEnd)>10*DAY,cached:false,chartWeeks:[period.periodEnd]};
        cache={row,expiresAt:now()+SIX_HOURS};lastFailure=null;retryAt=0;return structuredClone(row);
      }catch(error){lastFailure='FUNdex current weekly chart unavailable: '+error.message;retryAt=now()+60000;if(cache){cache.expiresAt=Math.min(cache.expiresAt,now());return {...structuredClone(cache.row),stale:true,cached:true,warning:lastFailure};}throw Error(lastFailure);}
    })().finally(()=>{pending=null;});return pending;
  }
  return {discovery,async close(){closing.abort();await pending?.catch(()=>{});}};
}

import {createDiscovery} from './discovery-manager.mjs';

const MEDIA=new Set(['movies','tv','anime']);
const TOPICS={
  books:['History','Science','Biography','Fiction'],
  music:['Jazz','Classical','Rock','Ambient'],
  software:['Linux','Blender','LibreOffice','GIMP'],
  games:['Strategy','Puzzle','Adventure','Racing'],
  pictures:['Nature','Space','Travel','Architecture'],
  general:['Documentary','Nature','Science','History'],
};
const LABELS={movies:'Movies',tv:'TV shows',anime:'Anime',books:'Books',ebooks:'Books',music:'Music',software:'Software',games:'Games',pictures:'Pictures',all:'General interests',other:'Other interests'};
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const categoriesOf=plugin=>{
  const unique=new Map();for(const category of plugin.supportedCategories||[]){if(typeof category?.id!=='string'||!category.id||unique.has(category.id))continue;unique.set(category.id,{id:category.id,name:String(category.name||LABELS[category.id]||category.id)});}return [...unique.values()];
};
function topicGroup(category){
  if(/book|comic|reading/i.test(category))return 'books';
  if(/music|audio/i.test(category))return 'music';
  if(/soft|app|linux/i.test(category))return 'software';
  if(/game/i.test(category))return 'games';
  if(/image|picture|photo/i.test(category))return 'pictures';
  return 'general';
}
function topicRow(category){
  const group=topicGroup(category.id),title=LABELS[category.id]||category.name;
  return {id:'plugin-topic-'+category.id,title,kind:'other',nativeCategory:category.id,browseId:category.id==='all'?'general':'native:'+category.id,chartState:'available',topic:true,curated:true,sourceUrls:[],description:'Keyword suggestions searched only in this plugin. These are topics, not a complete catalog or verified media titles.',items:TOPICS[group].map((topic,index)=>({id:`topic-${category.id}-${index}`,title:topic,topic:true,kind:'other',nativeCategory:category.id,overview:`Explore “${topic}” in this plugin’s ${title.toLowerCase()} search. Results are provided by the plugin; availability varies.`,posterUrl:null,source:null,sourceUrl:null,year:null,genres:[]}))};
}

function choose(plugin,options){
  if(!options||typeof options!=='object')fail('Choose a valid plugin category.');
  const category=options.category??'all', collection=options.collection??null;
  const requestedPeriod=options.period??'week';
  if(!['week','month'].includes(requestedPeriod))fail('Choose this week or this month.');
  if(typeof category!=='string'||category!=='all'&&!plugin.categories.some(item=>item.id===category))
    fail('This plugin does not advertise that category. Choose one of its listed categories.');
  if(collection!==null&&(collection==='korean'?category!=='tv':
    collection==='general'?category!=='all'||!plugin.categories.some(item=>item.id==='all'):true))
    fail('This plugin does not advertise the selected collection.');
  const requestedPage=Number(options.page??1);
  if(!Number.isInteger(requestedPage)||requestedPage<1||requestedPage>10000)fail('Choose a valid plugin page.');
  const overview=category==='all'&&!collection;
  const media=overview?plugin.categories.some(item=>MEDIA.has(item.id)):MEDIA.has(category);
  return {category,collection,period:media?requestedPeriod:'week',requestedPage,overview};
}
function browseCategories(plugin){
  const result=[{id:'all',name:'Overview',category:'all',collection:null,group:'overview'}];
  for(const {id,name} of plugin.categories){
    if(id==='all')continue;
    result.push({id:'native:'+id,name:MEDIA.has(id)?LABELS[id]:name,category:id,collection:null,
      group:MEDIA.has(id)?'media':'misc'});
    if(id==='tv')result.push({id:'korean',name:'Korean dramas',category:'tv',collection:'korean',group:'media'});
  }
  if(plugin.categories.some(item=>item.id==='all'))
    result.push({id:'general',name:'General',category:'all',collection:'general',group:'misc'});
  return result;
}
function mediaRow(plugin,source,category,collection){
  const providerId=collection==='korean'?'korean':category;
  const row=(source.rows||[]).find(entry=>entry.id===providerId);
  const items=(Array.isArray(row?.items)?row.items:[]).filter(item=>item&&typeof item.title==='string'&&item.title.trim())
    .map(item=>({...item,nativeCategory:category}));
  const title=collection==='korean'?'Korean dramas':LABELS[category];
  const chartState=items.length?(row.stale?'stale':'available'):!row||row.unavailable?'unavailable':'empty';
  return {...row,id:'plugin-'+providerId,title,kind:category,nativeCategory:category,
    browseId:collection||'native:'+category,chartState,
    description:row?.description||'Published title suggestions, with sources checked in '+plugin.fullName+'.',items};
}
function evidenceFor(items){
  const counts={total:items.length,matched:0,noMatch:0,pending:0,unavailable:0,upcoming:0};
  let checkedAt=null;
  for(const {availability} of items){
    const status=availability?.status;
    if(status==='upcoming')counts.upcoming++;
    else if(availability?.sources?.length)counts.matched++;
    else if(status==='no-match')counts.noMatch++;
    else if(['idle','queued','searching'].includes(status)||!status)counts.pending++;
    else counts.unavailable++;
    if(Number.isFinite(availability?.checkedAt))checkedAt=Math.max(checkedAt??0,availability.checkedAt);
  }
  return checkedAt===null?counts:{...counts,checkedAt};
}

/** Browse suggestions through public plugin search. No plugin internals are read. */
export function createPluginBrowse({qb,metadata,registerResult,maxActive=3,sourceTimeoutMs=25000,pollMs=1800,now=Date.now}={}){
  if(typeof qb!=='function'||typeof metadata?.discovery!=='function'||typeof registerResult!=='function')throw Error('Plugin browsing requires qBittorrent, metadata and result registration.');
  const limit=Math.max(1,Math.min(3,Number(maxActive)||3)),browsers=new Map();
  let mutation=Promise.resolve(),closed=false,sequence=0;

  async function installed(name){
    const all=await qb('search/plugins');
    if(!Array.isArray(all))fail('The plugin list is unavailable. Try again.',502);
    const plugin=all.find(entry=>entry?.name===name);
    if(!plugin)fail('This plugin is no longer installed. Refresh your plugins.',404);
    if(plugin.enabled===false)fail('This plugin is disabled in qBittorrent. Enable it before browsing.');
    if(plugin.enabled!==true||!Array.isArray(plugin.supportedCategories))fail('The plugin capability list is unavailable. Try again.',502);
    const categories=categoriesOf(plugin);
    return {name:plugin.name,fullName:plugin.fullName||plugin.name,enabled:true,categories};
  }
  async function catalog(plugin,scope,period){
    const capabilities=plugin.categories.filter(item=>scope.overview||item.id===scope.category);
    const categories=new Set(capabilities.map(item=>item.id));
    let source={rows:[],warnings:[],updatedAt:now()};
    if([...categories].some(category=>MEDIA.has(category))){
      try{source=await metadata.discovery({period});}
      catch(e){source.warnings=[e.message||'Title suggestions are temporarily unavailable.'];}
    }
    const candidates=[];
    for(const category of ['movies','tv','anime']){
      if(!categories.has(category))continue;
      const row=mediaRow(plugin,source,category,scope.collection);
      if(!scope.overview||row.items.length)candidates.push(row);
    }
    const misc=capabilities.filter(category=>!MEDIA.has(category.id)&&category.id!=='all');
    candidates.push(...misc.map(topicRow));
    if(!misc.length&&categories.has('all'))candidates.push(topicRow(capabilities.find(category=>category.id==='all')));
    const visible=candidates.slice(0,4),rows=[];let remaining=8;
    visible.forEach((row,index)=>{
      const share=Math.min(4,Math.ceil(remaining/(visible.length-index)));
      const items=scope.overview?row.items.slice(0,share):row.items;
      rows.push({...row,items,catalogTotal:row.items.length,canExploreAll:scope.overview&&row.items.length>items.length});
      remaining-=items.length;
    });
    const warnings=[...(source.warnings||[])];
    if(!rows.length)warnings.push('No suggestions are available in this view. Choose one of the listed categories or open scoped search.');
    if(candidates.length>4)warnings.push('Showing the first four category shelves. Choose another listed category to browse it.');
    return {rows,warnings,updatedAt:source.updatedAt??now(),sourceUrls:[...new Set(rows.flatMap(row=>row.sourceUrls||[]))],pluginName:plugin.name};
  }
  function snapshot(entry,state){
    const {category,collection,period,requestedPage}=entry.active;
    return {...state,pluginName:entry.plugin.name,plugin:entry.plugin,browseCategories:browseCategories(entry.plugin),
      category,collection,period,requestedPage,rows:state.rows.map(row=>({...row,evidence:evidenceFor(row.items)})),
      description:'Browse suggestions, then search within this plugin. qBittorrent plugins provide search results, not a complete browsable catalog. Nothing downloads until you choose a result.'};
  }
  function passive(name,options){
    const entry=browsers.get(name),changed=()=>fail('This plugin view changed. Reload this page to check it again.',409);
    if(!entry?.active)changed();
    let scope;
    try{scope=choose(entry.plugin,options);}catch{changed();}
    if(JSON.stringify(scope)!==JSON.stringify(entry.active))changed();
    return snapshot(entry,entry.discovery.peek());
  }
  async function discard(name){
    const entry=browsers.get(name);
    if(!entry)return;
    browsers.delete(name);
    await entry.discovery?.close();
  }
  async function access(name,refresh=false,options={}){
    if(closed)fail('Plugin browsing has closed.',503);
    if(typeof name!=='string'||!/^[\p{L}\p{N}_.-]{1,100}$/u.test(name))fail('Choose a valid installed plugin.');
    if(!refresh&&options?.poll===true)return passive(name,options);
    const work=mutation.catch(()=>{}).then(async()=>{
      if(closed)fail('Plugin browsing has closed.',503);
      let plugin;
      try{plugin=await installed(name);}
      catch(e){
        if(e.status===400||e.status===404)await discard(name);
        throw e;
      }
      if(closed)fail('Plugin browsing has closed.',503);
      const scope=choose(plugin,options), signature=JSON.stringify(plugin.categories.map(item=>item.id).sort());
      let entry=browsers.get(name);
      if(entry&&entry.signature!==signature){await discard(name);entry=null;}
      if(!entry){
        while(browsers.size>=limit){
          const [oldest]=[...browsers].sort((a,b)=>a[1].used-b[1].used)[0];
          await discard(oldest);
        }
        entry={plugin,signature,sourceCache:new Map(),discovery:null,active:null,used:0};
        browsers.set(name,entry);
      }
      entry.plugin=plugin;entry.used=++sequence;
      if(!entry.active||entry.active.category!==scope.category||entry.active.collection!==scope.collection){
        entry.active=null;
        await entry.discovery?.close();
        if(closed)fail('Plugin browsing has closed.',503);
        entry.discovery=createDiscovery({
          qb,metadata:{discovery:({period})=>catalog(entry.plugin,scope,period),enrichDiscoveryItems:metadata.enrichDiscoveryItems},
          pluginName:name,pluginSignature:signature,sourceCache:entry.sourceCache,sourceTimeoutMs,pollMs,workers:2,now,
          registerResult:(row,context)=>registerResult({...row,engineName:name},{...context,pluginName:name})
        });
      }
      entry.active=scope;
      const query={period:scope.period,page:scope.requestedPage};
      return snapshot(entry,refresh?entry.discovery.refresh(query):entry.discovery.get(query));
    });
    mutation=work.then(()=>{},()=>{});
    return work;
  }

  return {
    get:(name,options)=>access(name,false,options),
    refresh:(name,options)=>access(name,true,options),
    async close(){
      closed=true;
      await mutation.catch(()=>{});
      const active=[...browsers.keys()];
      await Promise.allSettled(active.map(discard));
    },
  };
}

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {classify,title,pluginGroups,statusLabel,torrentIdentity,magnetHashes,validReleaseLink,nonVideoRelease} from './lib.mjs';
import {createQbit} from './qbit-client.mjs';
import {installedCinemaProof} from './installed-cinema.mjs';
import {loadManagedCompanion,MANAGED_CINEMA_PORT,managedLaunchProof,managedMagnetSource,managedStorageMatches,
  managedTorrentStorageMatches} from './managed-companion.mjs';
import {createAddManager} from './add-manager.mjs';
import {createDownloadLocation} from './download-location.mjs';
import {createMedia} from './torrent-media.mjs';
import {createMetadata} from './metadata.mjs';
import {createSubtitles} from './subtitles.mjs';
import {createDiscovery} from './discovery-manager.mjs';
import {createPluginBrowse} from './plugin-browse.mjs';
import {createEpisodes,matchEpisodeFile} from './episodes.mjs';
import {createPlaybackCache} from './playback-cache.mjs';
import {streamingHint} from './release-streaming.mjs';
import {createQbitSync} from './qbit-sync.mjs';
import {atomicWriteLocalJson,createSourceMemory} from './source-memory.mjs';
import {prepareSourceMemoryDirectory} from './source-memory-storage.mjs';
import {portableSceneIdentity} from './public/scene-relay.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const managed=process.env.CINEMA_MANAGED_SCENE_ROOT===undefined?null:await loadManagedCompanion(process.env.CINEMA_MANAGED_SCENE_ROOT);
const installedSecret=process.env.CINEMA_INSTALLED_SECRET;
if(installedSecret!==undefined&&(managed||!/^[a-f\d]{64}$/.test(installedSecret)))throw Error('Invalid Cinema installation identity.');
const local=managed?.appData||process.env.CINEMA_DATA_DIR||path.join(root,'.local');await fsp.mkdir(local,{recursive:true});
const configFile=path.join(local,'connection.json');
let configKnown=true;
let config=managed?.config||await fsp.readFile(configFile,'utf8').then(s=>JSON.parse(s.replace(/^\uFEFF/,''))).catch(()=>{
  configKnown=false;
  return {url:'http://127.0.0.1:8080',username:'admin',password:''};
});
const windowsMemoryBase=process.env.LOCALAPPDATA;
const memoryLocal=managed||process.env.CINEMA_DATA_DIR||process.platform!=='win32'?path.resolve(local,'source-memory'):
  windowsMemoryBase&&path.isAbsolute(windowsMemoryBase)?path.resolve(windowsMemoryBase,'Cinema','SourceMemory'):null;
const sourceMemory=await createSourceMemory({local:memoryLocal??path.resolve(local,'source-memory-unavailable'),
  prepareLocal:create=>{
    if(!memoryLocal)throw Error('Windows Local AppData is unavailable.');
    return prepareSourceMemoryDirectory(memoryLocal,create);
  }});
let memoryConnectionEpoch=0,memorySnapshotEpoch=-1,configuringConnection=false;
const port=managed?MANAGED_CINEMA_PORT:Number(process.env.PORT||3210),origin=`http://127.0.0.1:${port}`,
  token=randomBytes(24).toString('hex'),internalToken=randomBytes(24).toString('hex');
const appointmentServiceId=randomBytes(32).toString('hex');
const sceneCertificateFile=process.env.CINEMA_SCENE_CERT_FILE;
const sceneCertificate=managed?.certificate||(sceneCertificateFile?await fsp.open(sceneCertificateFile,'r').then(async file=>{
  try{
    const bytes=Buffer.alloc(16*1024+1),{bytesRead}=await file.read(bytes);
    return bytesRead<bytes.length?bytes.subarray(0,bytesRead):null;
  }finally{await file.close();}
}).catch(()=>null):null);
const client=createQbit(()=>config,{sceneOrigin:managed?.config.url||process.env.CINEMA_SCENE_ORIGIN,
  sceneKey:managed?.sceneKey||process.env.CINEMA_SCENE_KEY,sceneCertificate});
function qb(endpoint,params,method,beforeSend){
  if(!managed||endpoint!=='torrents/add'||method!=='POST')return client.qb(endpoint,params,method,beforeSend);
  return client.qb('app/preferences').then(prefs=>{
    if(!managedStorageMatches(managed,prefs))fail('The Scene Preview download folder could not be verified. Reopen Cinema Scene Preview.',409);
    return client.qb(endpoint,{...params,savepath:managed.downloads,autoTMM:'false'},method);
  });
}
const qbitSync=createQbitSync(qb);
const downloadLocation=managed?null:await createDownloadLocation(local);
const adds=await createAddManager({qb,local,downloadFolder:()=>downloadLocation?.current().path??null});
let magnetAttempts=[];
let playbackCache;
const media=await createMedia({qb,rawQb:client.raw,sceneReader:client.sceneReader,sceneEpoch:()=>
  snapshot.connected&&!configuringConnection&&memorySnapshotEpoch===memoryConnectionEpoch?memoryConnectionEpoch:null,
  local,origin,internalToken,cacheReserved:folder=>playbackCache?.reserved(folder)??false});
playbackCache=await createPlaybackCache({local,protectedRuns:()=>media.protectedCacheRuns()});
const metadata=await createMetadata({local});
const subtitles=await createSubtitles({local});
const jobs=new Map(),selections=new Map(),guideSelections=new Map();
const selectionMaxAge=60*60*1000,maxGuideSelections=2400;
const discovery=createDiscovery({qb,metadata,registerResult});
const pluginBrowse=createPluginBrowse({qb,metadata,registerResult});
const episodes=createEpisodes({qb,metadata,registerResult,connectionEpoch:()=>memoryConnectionEpoch});
const assets=new Map([
  ['/',['public/index.html','text/html']],['/app.js',['public/app.js','text/javascript']],
  ['/story-orbit.js',['public/story-orbit.js','text/javascript']],['/story-orbit.css',['public/story-orbit.css','text/css']],
  ['/episodes.js',['public/episodes.js','text/javascript']],['/enrichment.js',['public/enrichment.js','text/javascript']],
  ['/discovery.js',['public/discovery.js','text/javascript']],['/plugin-browse.js',['public/plugin-browse.js','text/javascript']],
  ['/plugin-guide.css',['public/plugin-guide.css','text/css']],
  ['/dom.js',['public/dom.js','text/javascript']],['/style.css',['public/style.css','text/css']],
  ['/spotlight.js',['public/spotlight.js','text/javascript']],['/cinema.css',['public/cinema.css','text/css']],
  ['/title.css',['public/title.css','text/css']],['/player.css',['public/player.css','text/css']],
  ['/player-controls.js',['public/player-controls.js','text/javascript']],['/installed-ui.js',['public/installed-ui.js','text/javascript']],
  ['/watched-coverage.js',['public/watched-coverage.js','text/javascript']],['/watched-dialogue.js',['public/watched-dialogue.js','text/javascript']],
  ['/watched-dialogue.css',['public/watched-dialogue.css','text/css']],['/watched-runtime.js',['public/watched-runtime.js','text/javascript']],
  ['/watched-captions.js',['public/watched-captions.js','text/javascript']],
  ['/scene-finder.js',['public/scene-finder.js','text/javascript']],['/scene-finder.css',['public/scene-finder.css','text/css']],
  ['/scene-preview.js',['public/scene-preview.js','text/javascript']],['/scene-preview.css',['public/scene-preview.css','text/css']],
  ['/companion-ui.js',['public/companion-ui.js','text/javascript']],
  ['/sound-map.js',['public/sound-map.js','text/javascript']],['/sound-cues.js',['public/sound-cues.js','text/javascript']],
  ['/sound-map.css',['public/sound-map.css','text/css']],
  ['/two-track-model.js',['public/two-track-model.js','text/javascript']],['/two-track-studio.js',['public/two-track-studio.js','text/javascript']],
  ['/two-track-studio.css',['public/two-track-studio.css','text/css']],
  ['/scene-sketchbook.js',['public/scene-sketchbook.js','text/javascript']],['/scene-sketchbook.css',['public/scene-sketchbook.css','text/css']],
  ['/edition-atlas-model.js',['public/edition-atlas-model.js','text/javascript']],
  ['/edition-atlas-ui.js',['public/edition-atlas-ui.js','text/javascript']],
  ['/scene-editions.css',['public/scene-editions.css','text/css']],
  ['/scene-relay.js',['public/scene-relay.js','text/javascript']],['/playback-map.js',['public/playback-map.js','text/javascript']],
  ['/playback-map.css',['public/playback-map.css','text/css']],
  ['/playback-runway.js',['public/playback-runway.js','text/javascript']],
  ['/release-passport.js',['public/release-passport.js','text/javascript']],
  ['/source-memory.js',['public/source-memory.js','text/javascript']],['/source-memory.css',['public/source-memory.css','text/css']],
  ['/playback-insights-ui.js',['public/playback-insights-ui.js','text/javascript']],
  ['/playback-insights.css',['public/playback-insights.css','text/css']],
  ['/rescue-flow.js',['public/rescue-flow.js','text/javascript']],
  ['/rescue-ui.js',['public/rescue-ui.js','text/javascript']],
  ['/rescue-preview.js',['public/rescue-preview.js','text/javascript']],
  ['/rescue-playback.css',['public/rescue-playback.css','text/css']],
  ['/fast-start-flow.js',['public/fast-start-flow.js','text/javascript']],
  ['/fast-start-preview.js',['public/fast-start-preview.js','text/javascript']],
  ['/follow-week.js',['public/follow-week.js','text/javascript']],
  ['/follow-week-data.js',['public/follow-week-data.js','text/javascript']],
  ['/follow-week.css',['public/follow-week.css','text/css']],
  ['/warm-playback.js',['public/warm-playback.js','text/javascript']],
  ['/warm-playback-ui.js',['public/warm-playback-ui.js','text/javascript']],
  ['/warm-playback.css',['public/warm-playback.css','text/css']],
  ['/watch-planner.js',['public/watch-planner.js','text/javascript']],
  ['/watch-planner-model.js',['public/watch-planner-model.js','text/javascript']],
  ['/watch-planner.css',['public/watch-planner.css','text/css']],
  ['/watch-appointment.js',['public/watch-appointment.js','text/javascript']],
  ['/player-audio.js',['public/player-audio.js','text/javascript']],
  ['/watch-appointment-model.js',['public/watch-appointment-model.js','text/javascript']],
  ['/watch-appointment.css',['public/watch-appointment.css','text/css']],
  ['/vendor/hls.js',['node_modules/hls.js/dist/hls.min.js','text/javascript']],
]);
const assetCache=new Map();
async function serveAsset(req,res,route){
  const [file,type]=assets.get(route),filename=path.join(root,file);
  const stat=await fsp.stat(filename);
  let cached=assetCache.get(route);
  if(!cached||cached.mtime!==stat.mtimeMs||cached.size!==stat.size){
    const bytes=await fsp.readFile(filename);
    cached={mtime:stat.mtimeMs,size:stat.size,bytes,etag:'"'+createHash('sha256').update(bytes).digest('base64url')+'"'};
    assetCache.set(route,cached);
  }
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
  res.setHeader('Content-Type',type+'; charset=utf-8');
  res.setHeader('Cache-Control','private, no-cache');
  res.setHeader('ETag',cached.etag);
  const etags=(req.headers['if-none-match']||'').split(',').map(value=>value.trim().replace(/^W\//,''));
  if(etags.includes(cached.etag)||etags.includes('*')){res.writeHead(304);return res.end();}
  res.setHeader('Content-Length',cached.bytes.length);
  return res.end(req.method==='HEAD'?undefined:cached.bytes);
}
let snapshot={connected:false,version:'',updatedAt:null,error:'Connecting to qBittorrent…',library:[],plugins:[],operations:adds.list(),transfer:{}},refreshPromise,lastPluginRefresh=0;
function sourceMemoryContext(){
  if(!configKnown||configuringConnection||!snapshot.connected||memorySnapshotEpoch!==memoryConnectionEpoch)return null;
  const scope=/^[a-f0-9]{64}$/.test(config.sourceMemoryScope||'')?config.sourceMemoryScope:
    createHash('sha256').update(JSON.stringify([config.url,config.username])).digest('hex');
  return {scope,connectionEpoch:memoryConnectionEpoch};
}
function sourceMemoryView(){
  const context=sourceMemoryContext();
  return sourceMemory.view(context?.scope,context?snapshot.library:[]);
}
function appointmentEpoch(){
  if(shutting)return null;
  const context=sourceMemoryContext();
  return context?createHash('sha256').update(appointmentServiceId+':'+context.connectionEpoch).digest('hex'):null;
}
function appointmentError(message,status,code){throw Object.assign(Error(message),{status,code});}
const appointmentKey=/^[a-f0-9]{64}$/;
function fail(message,status=400){const e=Error(message);e.status=status;throw e;}
function hash(h){if(!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(h||''))fail('Invalid torrent identifier');return h.toLowerCase();}
function index(i){const n=Number(i);if(!Number.isInteger(n)||n<0||i===null||i===undefined)fail('Select a file first');return n;}
async function body(req,limit=65536){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>limit)fail('Request too large',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail('Invalid JSON');}}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function getPlugins(){const ps=await qb('search/plugins');return ps.map(p=>({...p,groups:pluginGroups(p)}));}
async function refresh(fresh=false){
  if(refreshPromise){
    if(!fresh)return refreshPromise;
    await refreshPromise;
    if(refreshPromise)return refresh(true);
  }
  const connectionEpoch=memoryConnectionEpoch;
  refreshPromise=(async()=>{
    try{
      const {torrents:ts,transfer}=await qbitSync.read({fresh});
      const version=snapshot.version||await qb('app/version');
      let plugins=snapshot.plugins,pluginError='';
      if(Date.now()-lastPluginRefresh>30000){try{plugins=await getPlugins();lastPluginRefresh=Date.now();}catch(e){pluginError=e.message;}}
      if(connectionEpoch!==memoryConnectionEpoch)return snapshot;
      adds.reconcile(ts);
      memorySnapshotEpoch=connectionEpoch;
      snapshot={connected:true,version,updatedAt:Date.now(),error:null,pluginError,library:ts.map(t=>({...t,title:title(t.name),kind:classify(t.name,t.category),statusLabel:statusLabel(t)})),plugins,operations:adds.list(),transfer:{dl_info_speed:transfer.dl_info_speed,up_info_speed:transfer.up_info_speed,connection_status:transfer.connection_status,free_space_on_disk:transfer.free_space_on_disk}};
    }catch(e){
      if(connectionEpoch!==memoryConnectionEpoch)return snapshot;
      if(snapshot.connected){memoryConnectionEpoch++;media.invalidateAppointments();void media.invalidateScenePreview();}
      memorySnapshotEpoch=-1;
      snapshot={...snapshot,connected:false,error:e.message,operations:adds.list()};
    }
    return snapshot;
  })().finally(()=>{refreshPromise=null;});return refreshPromise;
}
const poll=setInterval(()=>refresh(),2000);poll.unref();
async function ensureCategory(category){const cats=await qb('torrents/categories');if(!cats[category])try{await qb('torrents/createCategory',{category},'POST');}catch(e){if(!(await qb('torrents/categories'))[category])throw e;}}
async function selectedTorrent(h){const t=(await qb('torrents/info',{hashes:hash(h)}))[0];if(!t)fail('This torrent is no longer in qBittorrent.',404);return t;}
function playbackTicket(value){
  if(typeof value!=='string'||!/^[a-f0-9]{16,64}$/i.test(value))fail('Invalid playback session.');
  return value;
}
function warmFile(value){return {hash:hash(value?.hash),index:index(value?.index),sessionId:playbackTicket(value?.sessionId)};}
function rescueFile(value,source=false){
  const {name,size,url}=value||{};
  if(typeof name!=='string'||!name.length||name.length>800||/[\x00-\x1f]/.test(name)||
    !Number.isSafeInteger(size)||size<=0)fail('Choose an exact video file.');
  if(source&&url!=null&&(typeof url!=='string'||url.length>300||!/^\/(?:stream\?|hls\/)/.test(url)))
    fail('Choose a current playback session.');
  return {hash:hash(value.hash),index:index(value.index),name,size,
    ...(source?{sessionId:playbackTicket(value.sessionId),url:url??undefined}:{})};
}
async function verifiedEpisodeIntent(value){
  const ids={showId:value?.showId,episodeId:value?.episodeId};
  try{return episodes.resolveIntent(ids);}
  catch(e){
    if(e.status!==404)throw e;
    await episodes.catalog({id:ids.showId});
    return episodes.resolveIntent(ids);
  }
}
async function verifyRescueStory(from,to,body){
  if(body.episode){
    const intent=await verifiedEpisodeIntent(body.episode);
    const files=await Promise.all([media.files(from.hash),media.files(to.hash)]);
    for(const [position,entry] of [from,to].entries()){
      const matched=matchEpisodeFile(files[position],intent),file=files[position].find(row=>row.index===matched.index);
      if(!matched.singleEpisode||file?.index!==entry.index||file.name!==entry.name||file.size!==entry.size)
        fail('This replacement could not be verified as the same single episode.',409);
    }
    return;
  }
  const {title:movieTitle,year}=body.movie||{};
  if(typeof movieTitle!=='string'||!movieTitle.trim()||movieTitle.length>180||!Number.isSafeInteger(year))
    fail('Open a verified movie or episode to check a replacement.',409);
  const metadata={kind:'movies',title:movieTitle,year};
  const movieIdentity=name=>portableSceneIdentity({metadata,fileLabel:name.split(/[\\/]/).at(-1)
    .replace(/\.(mp4|mkv|avi|webm|m4v)$/i,'').replace(/[._]/g,' ')
    .replace(/\b(2160p|1080p|720p|480p|WEB[- ]?DL|WEBRip|BluRay|BDRip|x264|x265|HEVC)\b.*$/i,'').trim()});
  const source=movieIdentity(from.name);
  if(!source||source!==movieIdentity(to.name))fail('This replacement could not be verified as the same movie.',409);
}
function validateRead(req){if(req.headers['sec-fetch-site']==='cross-site')fail('Open Cinema directly on this PC.',403);}
async function expireSearches(){for(const [id,j]of jobs)if(j.epoch!==memoryConnectionEpoch||Date.now()-j.createdAt>30*60*1000){jobs.delete(id);if(j.epoch===memoryConnectionEpoch)qb('search/delete',{id},'POST').catch(()=>{});}for(const [key,r]of selections)if(Date.now()-r.seenAt>selectionMaxAge)selections.delete(key);}
const mediaSearchCategories=new Set(['movies','tv','anime']);
function sourceHost(value){return (URL.parse(String(value||''))?.hostname||'').replace(/^www\./i,'');}
function registerResult(x,job){
  let engine=x.engineName;
  if(!engine){
    const host=sourceHost(x.siteUrl)||sourceHost(x.descrLink);
    const matching=host?job.plugins.filter(p=>{
      const provider=sourceHost(p.url);
      return provider&&(host===provider||host.endsWith('.'+provider));
    }):[];
    if(matching.length===1)engine=matching[0].name;
  }
  const identity=torrentIdentity(x.fileUrl);
  const selectionIdentity=job.pluginName?JSON.stringify([identity,job.pluginName,job.category]):identity;
  const key=createHash('sha256').update(selectionIdentity).digest('hex').slice(0,32);
  const inferred=classify(x.fileName,['movies','tv','anime'].includes(job.category)?job.category:job.category==='all'?'':job.category);
  const hashes=magnetHashes(x.fileUrl),distinct=[...new Set(hashes)];
  const memoryAliases=distinct.length&&distinct.length<=2&&new Set(distinct.map(alias=>alias.length)).size===distinct.length?distinct:undefined;
  const existing=snapshot.library.find(t=>[t.hash,t.infohash_v1,t.infohash_v2].filter(Boolean).some(h=>hashes.includes(h.toLowerCase())));
  const selected={...x,key,kind:inferred,engineName:engine,seenAt:Date.now(),category:job.category,existingHash:existing?.hash,memoryAliases,streaming:streamingHint(x,inferred,existing)};
  if(job.releases){
    const previous=job.releases.get(key);
    if(previous&&previous.streaming.score>selected.streaming.score&&previous.existingHash===selected.existingHash)return previous;
    if(job.releases.size<1200||previous)job.releases.set(key,selected);
  }
  if(job.pluginName){
    guideSelections.delete(key);
    guideSelections.set(key,selected);
    if(guideSelections.size>maxGuideSelections)guideSelections.delete(guideSelections.keys().next().value);
  }else selections.set(key,selected);
  return selected;
}
const server=http.createServer(async(req,res)=>{
  try{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))fail('Invalid host',403);
    if(req.headers.origin&&![origin,`http://localhost:${port}`].includes(req.headers.origin))fail('Invalid origin',403);
    validateRead(req);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    const u=new URL(req.url,origin),route=u.pathname;
    if(req.method==='POST'&&req.headers['x-cinema-token']!==token)fail('The app restarted. Refresh the connection and try again.',403);
    if(!['GET','POST','HEAD'].includes(req.method))fail('Method not allowed',405);
    if(route==='/api/session')return json(res,{token,url:config.url,username:config.username,appVersion:'2.26.0',
      ...(managed?{profile:'scene-preview'}:installedSecret?{profile:'installed'}:{})});
    if(route==='/api/installed/ready'&&req.method==='GET'){
      if(!installedSecret)fail('Unknown route',404);
      const challenge=u.searchParams.get('challenge');
      if(!challenge||!/^[a-f\d]{32}$/.test(challenge))fail('Invalid launcher challenge.');
      return json(res,{proof:installedCinemaProof(installedSecret,challenge)});
    }
    if(route==='/api/launcher/scene'&&req.method==='GET'){
      if(!managed)fail('Unknown route',404);
      const challenge=u.searchParams.get('challenge');
      if(!challenge||!/^[a-f\d]{64}$/.test(challenge))fail('Invalid launcher challenge.');
      return json(res,{proof:managedLaunchProof(managed,challenge)});
    }
    if(route==='/api/connect'&&req.method==='POST'){
      if(managed)fail('This connection is managed by the Cinema Scene Preview shortcut.',409);
      if(installedSecret)fail('Cinema Setup configured the bundled qBittorrent connection.',409);
      const b=await body(req);let address;try{address=new URL(b.url);}catch{fail('Enter a valid local Web UI address');}
      const localHttp=address.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(address.hostname);
      if(!(localHttp||client.acceptsSceneOrigin(address.origin))||address.username||address.password)
        fail('Use a local qBittorrent Web UI address on this PC (127.0.0.1).');
      if(configuringConnection)fail('Wait for the current connection check.',409);
      const previous=config,previousKnown=configKnown;
      configuringConnection=true;
      memoryConnectionEpoch++;
      media.invalidateAppointments();
      void media.invalidateScenePreview();
      config={url:address.origin,username:String(b.username||'admin'),password:String(b.password||''),
        sourceMemoryScope:randomBytes(32).toString('hex')};
      client.reset();
      try{
        await client.login();
        await atomicWriteLocalJson(configFile,config);
        configKnown=true;
        qbitSync.reset();snapshot.version='';lastPluginRefresh=0;
        await refresh(true);
        return json(res,{ok:true});
      }catch(e){
        config=previous;configKnown=previousKnown;client.reset();qbitSync.reset();
        memoryConnectionEpoch++;memorySnapshotEpoch=-1;
        snapshot={...snapshot,connected:false};
        throw e;
      }finally{configuringConnection=false;}
    }
    if(route==='/api/state'){
      if(!snapshot.updatedAt)await refresh();
      return json(res,{...snapshot,operations:adds.list(),sourceMemory:sourceMemoryView()});
    }
    if(route==='/api/download-location'){
      if(req.method==='GET')return json(res,managed?{mode:'managed',path:managed.downloads}:downloadLocation.current());
      if(req.method==='POST'){
        if(managed)fail('Cinema Scene Preview uses its own download folder.',409);
        const b=await body(req,4096);
        if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==1||
          !Object.hasOwn(b,'path')||b.path!==null&&typeof b.path!=='string')fail('Choose a folder or use the qBittorrent default.');
        return json(res,await downloadLocation.save(b.path));
      }
    }
    if(route==='/api/source-memory'&&req.method==='POST'){
      const b=await body(req,2048);
      if(b.action==='preferences'&&typeof b.enabled==='boolean'){
        await sourceMemory.setEnabled(b.enabled).catch(()=>fail('Cinema could not save the Source Memory preference.',500));
        return json(res,sourceMemoryView());
      }
      if(b.action==='clear'&&b.confirm===true){
        await sourceMemory.clear().catch(()=>fail('Cinema could not clear Source Memory on this PC.',500));
        return json(res,sourceMemoryView());
      }
      if(b.action==='record'){
        const selected=hash(b.hash),fileIndex=b.index,context=sourceMemoryContext();
        if(!context||!Number.isSafeInteger(fileIndex)||fileIndex<0)return json(res,{accepted:false});
        const {scope,connectionEpoch}=context;
        const isCurrent=()=>{
          const current=sourceMemoryContext();
          return current?.scope===scope&&current.connectionEpoch===connectionEpoch&&
            snapshot.library.some(item=>item.hash===selected);
        };
        const accepted=await sourceMemory.record({scope,revision:b.revision,sessionId:b.sessionId,firstPictureMs:b.firstPictureMs,isCurrent,
          attest:()=>media.consumeSourceMemoryStart(selected,fileIndex,b.sessionId,{scope,connectionEpoch,revision:b.revision})})
          .catch(()=>fail('Cinema could not save the local playback observation.',500));
        return json(res,{accepted});
      }
      fail('Choose a valid Source Memory action.');
    }
    if(route==='/api/playback-cache'&&req.method==='GET')return json(res,await playbackCache.status());
    if(route==='/api/playback-cache'&&req.method==='POST'){
      const b=await body(req);
      if(b.action==='clear'&&b.confirm===true)return json(res,await playbackCache.clear());
      if(b.action==='limit'&&Object.hasOwn(b,'quotaGiB'))return json(res,await playbackCache.setQuota(b.quotaGiB));
      fail('Choose a cache limit or confirm clearing unused playback files.');
    }
    if(route==='/api/status'){const state=await refresh();return json(res,{connected:state.connected,version:state.version,transfer:state.transfer,error:state.error});}
    if(route==='/api/library'){await refresh();if(!snapshot.connected)fail(snapshot.error,503);return json(res,snapshot.library);}
    if(route==='/api/plugins'){
      const plugins=await getPlugins();
      snapshot={...snapshot,plugins,pluginError:null};lastPluginRefresh=Date.now();
      return json(res,plugins);
    }
    if(route==='/api/plugins/browse'&&req.method==='GET'){
      const query=u.searchParams;
      return json(res,await pluginBrowse.get(query.get('name'),{
        category:query.get('category')||'all',page:query.get('page')||1,period:query.get('period')??undefined,
        collection:query.get('collection')??undefined,poll:query.get('poll')==='1',
      }));
    }
    if(route==='/api/plugins/browse/refresh'&&req.method==='POST'){
      const {name,category,page,period,collection}=await body(req);
      return json(res,await pluginBrowse.refresh(name,{category:category||'all',page:page||1,period,collection}));
    }
    if(route==='/api/discover'&&req.method==='GET')return json(res,discovery.get(Object.fromEntries(u.searchParams)));
    if(route==='/api/discover/refresh'&&req.method==='POST')return json(res,discovery.refresh(await body(req)));
    if(route==='/api/episodes/catalog'&&req.method==='POST')return json(res,await episodes.catalog(await body(req)));
    if(route==='/api/episodes/schedule'&&req.method==='POST')return json(res,await episodes.schedule(await body(req)));
    if(route==='/api/episodes/orbit'&&req.method==='POST')return json(res,await episodes.orbit(await body(req)));
    if(route==='/api/episodes/search'&&req.method==='POST')return json(res,await episodes.start(await body(req)));
    if(route==='/api/episodes/search'&&req.method==='GET')return json(res,episodes.get(u.searchParams.get('id')));
    if(route==='/api/episodes/search/cancel'&&req.method==='POST'){const b=await body(req);return json(res,await episodes.cancel(b.id));}
    if(route==='/api/episodes/file'&&req.method==='POST'){
      const b=await body(req),intent=await verifiedEpisodeIntent(b);
      return json(res,{...matchEpisodeFile(await media.files(hash(b.hash)),intent),intent});
    }
    if(route==='/api/metadata/search'&&req.method==='POST'){const b=await body(req);return json(res,await metadata.lookup(b.query,{kind:b.kind,year:b.year}));}
    if(route==='/api/metadata/poster'&&req.method==='GET'){
      const poster=await metadata.poster(u.searchParams.get('id'));
      res.setHeader('Content-Type',poster.contentType);res.setHeader('Cache-Control',poster.cacheControl||'private, max-age=86400');return res.end(poster.body);
    }
    if(route==='/api/subtitles/search'&&req.method==='POST')return json(res,await subtitles.search(await body(req)));
    if(route==='/api/subtitles/download'&&req.method==='POST')return json(res,await subtitles.download(await body(req)));
    if(route==='/api/subtitles/import'&&req.method==='POST')return json(res,await subtitles.import(await body(req,3*1024*1024)));
    if(route==='/api/subtitles/file'&&['GET','HEAD'].includes(req.method)){
      const vtt=await subtitles.get(u.searchParams.get('id'));res.setHeader('Content-Type','text/vtt; charset=utf-8');res.setHeader('Cache-Control','private, max-age=86400');return res.end(req.method==='HEAD'?undefined:vtt);
    }
    if(route==='/api/search'&&req.method==='POST'){
      const b=await body(req),query=String(b.query||'').trim();if(!query)fail('Enter a title or keyword to search');await expireSearches();
      const requested=String(b.category||'all'),epoch=memoryConnectionEpoch,all=await getPlugins();
      if(epoch!==memoryConnectionEpoch)fail('The qBittorrent connection changed. Search again.',409);
      if(b.plugin&&!all.some(p=>p.name===b.plugin))fail('That search plugin is not installed. Refresh Sources.');
      const broad=!b.plugin&&(requested==='all'||mediaSearchCategories.has(requested));
      const category=broad&&requested==='all'&&mediaSearchCategories.has(b.intentCategory)?b.intentCategory:requested;
      const apiCategory=broad||requested==='misc'?'all':requested;
      const plugins=all.filter(p=>p.enabled&&(!b.plugin||p.name===b.plugin)&&
        (requested==='misc'?p.groups.includes('misc'):apiCategory==='all'||p.supportedCategories?.some(c=>c.id===apiCategory)));
      if(!plugins.length)fail('No enabled sources support this category. Select another category or enable the plugin in qBittorrent.');
      const result=await qb('search/start',{pattern:query.slice(0,200),category:apiCategory,plugins:plugins.map(p=>p.name).join('|')},'POST');
      if(epoch!==memoryConnectionEpoch)fail('The qBittorrent connection changed. Search again.',409);
      jobs.set(String(result.id),{createdAt:Date.now(),category,plugins,query,epoch,releases:new Map(),mediaOnly:broad&&mediaSearchCategories.has(category)});
      return json(res,{...result,pluginCount:plugins.length,scope:broad?'all-enabled':b.plugin?'single':'category'});
    }
    if(route==='/api/results'){
      const id=u.searchParams.get('id'),job=jobs.get(id);if(!job||job.epoch!==memoryConnectionEpoch)fail('This search expired. Search again.',404);
      const bounded=(value,fallback,min,max)=>/^\d+$/.test(value||'')?Math.min(max,Math.max(min,Number(value))):fallback;
      const offset=bounded(u.searchParams.get('offset'),0,0,Number.MAX_SAFE_INTEGER),limit=bounded(u.searchParams.get('limit'),500,1,500);
      const r=await qb('search/results',{id,limit,offset}),raw=r.results||[],warnings=[],results=[];
      if(job.epoch!==memoryConnectionEpoch)fail('The qBittorrent connection changed. Search again.',409);
      for(const x of raw){
        if(!x?.fileName||!validReleaseLink(x.fileUrl)||/api key error|configuration (?:error|file)|plugin.*(?:error|failed)|jackett:.*error/i.test(x.fileName)){
          warnings.push({plugin:x?.engineName||'Search provider',message:String(x?.fileName||'This provider returned an invalid result.').replace(/Configuration file:.*?Search:/i,'Search:').slice(0,300)});continue;
        }
        if(job.mediaOnly&&nonVideoRelease(x.fileName))continue;
        results.push(registerResult(x,job));
      }
      const nextOffset=offset+raw.length;
      return json(res,{...r,results,warnings,offset,limit,nextOffset,hasMore:nextOffset<r.total});
    }
    if(route==='/api/search/stop'&&req.method==='POST'){
      const b=await body(req),id=String(b.id),job=jobs.get(id);
      if(job){
        jobs.delete(id);
        if(job.epoch===memoryConnectionEpoch)await qb('search/stop',{id},'POST').catch(()=>{});
        if(job.epoch===memoryConnectionEpoch)await qb('search/delete',{id},'POST').catch(()=>{});
      }
      return json(res,{ok:true});
    }
    if(route==='/api/add'&&req.method==='POST'){
      const b=await body(req),guideSource=guideSelections.get(b.key),source=guideSource||selections.get(b.key);
      if(!source||guideSource&&Date.now()-guideSource.seenAt>=selectionMaxAge){
        guideSelections.delete(b.key);
        return json(res,{error:'This result expired. Search again before adding it.',code:'expired-source'},400);
      }
      if(!/^(?:magnet:\?|https?:\/\/)/i.test(source.fileUrl))fail('This provider returned a link that qBittorrent cannot download. Try another source.');
      const intent=b.episode?episodes.intentForKey(b.key,b.episode):null;
      if(b.episode&&!intent)fail('Episode source selection expired. Find sources for this episode again.');
      const op=await adds.create({...source,intent:intent||undefined},b.category||source.category,b.allowDuplicate===true);return json(res,{...op,...(intent?{intent}:{})},op.status==='adding'?202:200);
    }
    if(route==='/api/companion/magnet'&&req.method==='POST'){
      if(!managed)fail('Unknown route',404);
      const now=Date.now();
      magnetAttempts=magnetAttempts.filter(at=>now-at<60_000);
      if(magnetAttempts.length>=12)fail('Wait a moment before adding another magnet link.',429);
      magnetAttempts.push(now);
      const input=await body(req,10*1024);
      const source=managedMagnetSource(input?.magnet);
      if(!source||Object.keys(input).length!==1)fail('Paste one valid BitTorrent magnet link.');
      await refresh();
      if(!snapshot.connected)fail('Cinema Scene Preview is reconnecting. Try again in a moment.',503);
      const op=await adds.create({...source,manualMagnet:true},undefined,true);
      return json(res,op.existing?{...op,message:'This magnet is already in Scene Preview.'}:op,
        op.status==='adding'&&!op.existing?202:200);
    }
    if(route==='/api/add/status'){const op=adds.get(u.searchParams.get('id'));if(!op)fail('Download request not found',404);return json(res,op);}
    if(route==='/api/add/retry'&&req.method==='POST'){const b=await body(req);if(b.confirmRetry!==true)fail('Confirm the retry after checking the current downloads.');return json(res,await adds.retry(String(b.id)));}
    if(route==='/api/planner-file'&&req.method==='GET')return json(res,await media.plannerFile(hash(u.searchParams.get('hash'))));
    if(route==='/api/files')return json(res,await media.files(hash(u.searchParams.get('hash'))));
    if(route==='/api/watch-appointment'&&req.method==='POST'){
      const b=await body(req,2048);
      if(typeof b?.allowProbe!=='boolean'||!Array.isArray(b.targets)||b.targets.length<1||b.targets.length>2||
        b.epoch!==undefined&&(typeof b.epoch!=='string'||!appointmentKey.test(b.epoch)))fail('Choose one title and an optional separate backup.');
      const targets=b.targets.map(target=>{
        if(!target||target.key!==undefined&&(typeof target.key!=='string'||!appointmentKey.test(target.key)))fail('Choose a current appointment file.');
        return {hash:hash(target.hash),key:target.key};
      });
      if(new Set(targets.map(target=>target.hash)).size!==targets.length)fail('Choose a different backup title.');
      const epoch=appointmentEpoch();
      if(!epoch)appointmentError('Reconnect qBittorrent to check this appointment.',503,'appointment-disconnected');
      if(b.epoch!==undefined&&b.epoch!==epoch)
        appointmentError('The connection changed. Check the appointment again.',409,'appointment-connection-changed');
      const control=new AbortController(), disconnected=()=>control.abort();
      res.once('close',disconnected);
      try{
        const result=await media.watchAppointment(targets,{epoch,allowProbe:b.allowProbe,signal:control.signal,
          isCurrent:()=>appointmentEpoch()===epoch});
        if(!control.signal.aborted&&!res.destroyed)return json(res,result);
        return;
      }finally{res.off('close',disconnected);}
    }
    if(route==='/api/prepare'&&req.method==='POST'){
      const b=await body(req),context=b.rememberStart===true?sourceMemoryContext():null;
      const revision=context?sourceMemory.admission():null;
      const candidate=revision?{...context,revision}:null;
      let appointment;
      if(b.appointment!==undefined){
        const proof=b.appointment,epoch=appointmentEpoch();
        if(!epoch||proof?.epoch!==epoch||typeof proof.key!=='string'||!appointmentKey.test(proof.key)||
          typeof proof.playKey!=='string'||!appointmentKey.test(proof.playKey))
          appointmentError('This appointment file changed. Check it again before playing.',409,'appointment-file-changed');
        appointment={epoch,key:proof.key,playKey:proof.playKey,isCurrent:()=>appointmentEpoch()===epoch};
      }
      const result=await media.prepare(hash(b.hash),index(b.index),{retry:b.retry===true,
        forceTranscode:b.forceTranscode===true,sourceMemory:candidate,appointment});
      const current=candidate?sourceMemoryContext():null;
      if(result.memoryStart&&(!current||current.scope!==candidate.scope||
        current.connectionEpoch!==candidate.connectionEpoch||sourceMemory.admission()!==revision))delete result.memoryStart;
      return json(res,result);
    }
    if(route==='/api/watched/proof'&&req.method==='POST'){
      const control=new AbortController(), disconnected=()=>control.abort();
      res.once('close',disconnected);
      try{
        const input=await body(req,1024);
        const proof=await media.dialogueProof(input,{signal:control.signal});
        if(!control.signal.aborted)return json(res,proof);
        return;
      }finally{res.off('close',disconnected);}
    }
    if(route==='/api/scene-preview'&&req.method==='POST'){
      const control=new AbortController(), disconnected=()=>control.abort();
      res.once('close',disconnected);
      try{
        const b=await body(req,512);
        const maxTime=24*60*60*1000;
        const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=maxTime;
        if(!validTime(b?.targetMs)||!Number.isSafeInteger(b.index))
          fail('Enter a valid scene time.');
        const identity={hash:hash(b.hash),index:index(b.index),sessionId:playbackTicket(b.sessionId),targetMs:b.targetMs};
        if(b.fetch!==undefined&&typeof b.fetch!=='boolean')fail('Enter a valid preview action.');
        if(b.fetch===true){
          if(!validTime(b.playheadMs)||!validTime(b.bufferedUntilMs)||b.bufferedUntilMs<b.playheadMs)
            fail('The current video buffer could not be checked.');
          const age=Number.isSafeInteger(b.sampledAt)?Date.now()-b.sampledAt:Infinity;
          if(age<0||age>500)
            return json(res,{code:'scene-runway',error:'The video buffer check expired. Try the preview again.'},409);
          identity.foreground={playheadMs:b.playheadMs,bufferedUntilMs:b.bufferedUntilMs,sampledAt:performance.now()-age};
        }
        try{
          const {bytes,seekSeconds}=await media.previewScene(identity,{signal:control.signal});
          if(!control.signal.aborted&&!res.destroyed){
            res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':bytes.length,
              'Cache-Control':'no-store','X-Cinema-Scene-Seek':String(seekSeconds)});
            res.end(bytes);
          }
        }catch(e){
          if(control.signal.aborted||res.destroyed)return;
          const notices={
            'scene-busy':[429,'Another scene is finishing. Try again in a moment.'],
            'scene-changed':[409,'The video or connection changed. Try again on the current video.'],
            'scene-limit':[422,'This scene needs more data than a short preview can use.'],
            'scene-missing':[409,'This part is still downloading. Try again once more of it is ready.'],
            'scene-runway':[409,'Let the video build more buffer, then try the preview again.'],
            'scene-fetch-unavailable':[409,'Cinema could not fetch this preview yet. Try again in a moment.'],
            'scene-unsupported':[422,'This video does not support a preview at that time.'],
            'scene-unverified':[422,'Cinema could not verify this scene for preview.'],
          };
          const [status,error]=e.name==='TimeoutError'?[408,'The preview took too long. Try again in a moment.']:
            notices[e.code]??[422,'Cinema could not preview this scene. Try again in a moment.'];
          return json(res,{error,code:Object.hasOwn(notices,e.code)?e.code:undefined,
            ...(e.code==='scene-missing'&&e.canFetch===true?{canFetch:true}:{})},status);
        }
        return;
      }finally{res.off('close',disconnected);}
    }
    if(route==='/api/playback/rescue'&&req.method==='POST'){
      const b=await body(req);
      if(b.action==='commit')return json(res,await media.rescueCommit(playbackTicket(b.ticket)));
      if(b.action==='cancel')return json(res,await media.rescueCancel(playbackTicket(b.ticket)));
      if(b.action!=='check')fail('Unknown replacement action.');
      if(b.purpose!==undefined&&b.purpose!=='fast-start')fail('Unknown replacement purpose.');
      const from=rescueFile(b.from,true),to=rescueFile(b.to);
      if(from.hash===to.hash)fail('Choose a different download for the replacement.',409);
      const control=new AbortController();
      const disconnected=()=>control.abort();
      res.once('close',disconnected);
      try{
        await verifyRescueStory(from,to,b);
        if(control.signal.aborted)return;
        const result=await media.rescueCheck(from,to,{signal:control.signal,purpose:b.purpose});
        if(control.signal.aborted){if(result.ticket)await media.rescueCancel(result.ticket);return;}
        return json(res,result);
      }finally{res.off('close',disconnected);}
    }
    if(route==='/api/playback/warm/options'&&req.method==='GET')
      return json(res,await media.warmOptions(hash(u.searchParams.get('hash')),index(u.searchParams.get('index')),playbackTicket(u.searchParams.get('sessionId'))));
    if(route==='/api/playback/warm'){
      if(req.method==='GET')return json(res,await media.warmStatus(playbackTicket(u.searchParams.get('ticket'))));
      if(req.method==='POST'){
        const b=await body(req);
        if(b.action==='switch')return json(res,await media.warmSwitch(warmFile(b.from),warmFile(b.to)));
        if(b.action==='return')return json(res,await media.warmReturn(playbackTicket(b.ticket)));
        if(b.action==='dismiss')return json(res,await media.warmDismiss(playbackTicket(b.ticket)));
        fail('Unknown playback handoff.');
      }
    }
    if(route==='/api/playback')return json(res,await media.playback(hash(u.searchParams.get('hash')),index(u.searchParams.get('index'))));
    if(route==='/api/torrent/action'&&req.method==='POST'){
      const b=await body(req),h=hash(b.hash);if(!['pause','resume','delete'].includes(b.action))fail('Unknown download action');const t=await selectedTorrent(h);
      if(b.action==='delete'){
        if(typeof b.deleteFiles!=='boolean'||b.confirmName!==t.name)fail('Confirm the exact title and whether to keep its files before removing it.');
        if(managed&&b.deleteFiles&&!await managedTorrentStorageMatches(managed,t))
          fail('Cinema can only delete files inside the Scene Preview download folders.',409);
        const finish=media.beginAppointmentRemoval(h);
        try{
          await media.cancel(h);
          await qb('torrents/delete',{hashes:h,deleteFiles:String(b.deleteFiles)},'POST');
          let cleanupWarning;try{await media.remove(h,{deleteFiles:b.deleteFiles});}catch{cleanupWarning='The torrent was removed, but a saved playback copy could not be cleaned up. Restart Cinema before trying cleanup again.';}
          await refresh(true);return json(res,{ok:true,warning:cleanupWarning});
        }finally{finish();}
      }else await qb(b.action==='pause'?'torrents/stop':'torrents/start',{hashes:h},'POST');
      await refresh(true);return json(res,{ok:true});
    }
    if(route==='/api/category'&&req.method==='POST'){
      const b=await body(req);hash(b.hash);const category=b.category==='misc'?'other':b.category;if(!['movies','tv','anime','other'].includes(category))fail('Invalid category');await ensureCategory(category);await qb('torrents/setCategory',{hashes:b.hash,category},'POST');await refresh(true);return json(res,{ok:true});
    }
    if(route==='/stream'&&['GET','HEAD'].includes(req.method))return await media.stream(req,res,u);
    if(route.startsWith('/hls/')&&['GET','HEAD'].includes(req.method))return await media.serveHls(req,res,u);
    if(['GET','HEAD'].includes(req.method)&&assets.has(route))return await serveAsset(req,res,route);
    fail('Not found',404);
  }catch(e){
    if(res.destroyed)return;
    if(res.headersSent)res.destroy();
    else json(res,{error:e.message,...(typeof e.code==='string'&&e.code.startsWith('appointment-')?{code:e.code}:{})},e.status||500);
  }
});
let shutting=false;async function shutdown(){if(shutting)return;shutting=true;media.invalidateAppointments();clearInterval(poll);await Promise.allSettled([discovery.close(),pluginBrowse.close(),episodes.close(),playbackCache.close()]);await media.shutdown();await metadata.close();await adds.close();server.closeAllConnections();server.close(()=>process.exit(0));}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.listen(port,'127.0.0.1',()=>{console.log(`Cinema is ready at ${origin}`);refresh();});

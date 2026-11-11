import {updateHTML,updateKeyedList} from './dom.js';
import {createEnrichment} from './enrichment.js';
import {createDiscoveryUI} from './discovery.js';
import {createPluginBrowser} from './plugin-browse.js';
import {createEpisodesUI} from './episodes.js';
import {createSpotlight,createWatchlist} from './spotlight.js';
import {createPlaybackMap,playbackMap,readTimeRanges,readyToSeek} from './playback-map.js';
import {createSceneRelay,portableSceneIdentity} from './scene-relay.js';
import {createWatchPlanner} from './watch-planner.js';
import {createPlaybackRunway} from './playback-runway.js';
import {createReleaseObservation} from './release-passport.js';
import {firstPictureDuration,isOpeningBufferAlignment,sourceMemoryCohorts,sourceMemoryLabel} from './source-memory.js';
import {createPlaybackInsightsUI} from './playback-insights-ui.js';
import {createWarmPlayback,samePlaybackSession} from './warm-playback.js';
import {createWarmPlaybackUI} from './warm-playback-ui.js';
import {createEditionAtlasUI} from './edition-atlas-ui.js';
import {createRescueFlow} from './rescue-flow.js';
import {createRescueUI} from './rescue-ui.js';
import {previewRescue} from './rescue-preview.js';
import {createFastStartFlow} from './fast-start-flow.js';
import {previewFastStart} from './fast-start-preview.js';
import {createFollowWeekUI} from './follow-week.js';
import {createFollowStore,checkFollowEpisode} from './follow-week-data.js';
import {createWatchedRuntime,WATCHED_ENABLED,WATCHED_STORE} from './watched-runtime.js';
import {createWatchedDialogueUI} from './watched-dialogue.js';
import {createSoundMap} from './sound-map.js';
import {createPlayerAudio,playerAudioOffer} from './player-audio.js';
import {createSceneSketchbook} from './scene-sketchbook.js';
import {createScenePreviewUI} from './scene-preview.js';
import {createTwoTrackStudio} from './two-track-studio.js';
import {readLocalWatchedCaption} from './watched-captions.js';
const $ = selector => document.querySelector(selector);
const names = {home:'Discover',movies:'Movies',tv:'TV shows',anime:'Anime',korean:'Korean dramas',other:'Miscellaneous',library:'My library',downloads:'Downloads',sources:'Explore plugins',all:'All categories',music:'Music',books:'Books',ebooks:'Books',games:'Games',software:'Software',pictures:'Pictures'};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = value => {const n=Number(value);if(!Number.isFinite(n)||n<0)return 'Unknown';if(n<1024)return Math.round(n)+' B';const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),4);return (n/1024**i).toFixed(1)+' '+['B','KB','MB','GB','TB'][i];};
const percent = value => Math.max(0,Math.min(100,Number(value||0)*100));
const clockTime = value => {const seconds=Math.max(0,Math.floor(Number(value)||0));const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;};
const clean = name => String(name||'Untitled').replace(/\.(mp4|mkv|avi|webm|m4v)$/i,'').replace(/[._]/g,' ').replace(/\b(2160p|1080p|720p|480p|WEB[- ]?DL|WEBRip|BluRay|BDRip|x264|x265|HEVC)\b.*$/i,'').trim();
const eta = value => {const n=Number(value);if(!Number.isFinite(n)||n<=0||n>=8640000)return 'Waiting for peers';if(n<60)return 'Under a minute';if(n<3600)return Math.ceil(n/60)+' min';return Math.floor(n/3600)+'h '+Math.ceil(n%3600/60)+'m';};
const isPaused = t => /^(paused|stopped)/i.test(t.state||'');
const isError = t => /error|missingFiles/i.test(t.state||'');
const videoExtension = /\.(mp4|m4v|webm|mkv|avi|mov|ts|m2ts|mpg|mpeg)$/i;
function firstVideo(files,hash){
  const saved=files.find(file=>file.index===history[hash]?.index);if(saved)return saved;
  const candidates=files.filter(file=>!/(?:^|[\\/._ -])sample(?:[\\/._ -]|$)/i.test(file.name));
  const videos=candidates.length?candidates:files;
  const episodes=videos.filter(file=>/\bS\d{1,2}E\d{1,3}\b|\b\d{1,2}x\d{2}\b|(?:^|[ /._-])(?:E|EP)\d{1,3}\b/i.test(file.name));
  if(episodes.length)return [...episodes].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}))[0];
  return [...videos].sort((a,b)=>a.index-b.index)[0];
}
function watchRecord(hash,index){
  const latest=history[hash];
  return latest?.files?.[index]||(latest?.index===index?latest:null);
}
const categoriesOf = p => Array.isArray(p.supportedCategories) ? p.supportedCategories : [];
const groupOf = p => (p.groups || [...new Set(categoriesOf(p).map(c=>['movies','tv','anime'].includes(c.id)?c.id:'other'))]).map(group=>group==='misc'?'other':group);
const supported = (p,category) => p.enabled && (category==='all'||category==='misc'&&groupOf(p).includes('other')||categoriesOf(p).some(c=>c.id===category));
const categoryName = category => names[category]||category;
let token='',view='home',library=[],plugins=[],operations=[],connected=false,refreshPromise=null,stateTimer=null;
let companionUI;
let videoControls;
function companionAdded(operation){
  if(operation.id&&!operation.existing){
    awaitingOperations.add(operation.id);
    operations=[...operations.filter(item=>item.id!==operation.id),operation];
  }
  setView('downloads');
  notice(operation.existing?'This magnet is already in Scene Preview.':operation.message||'Download added.');
  void refresh();
}
let searchId=null,searchGeneration=0,searchRows=[],searchCategory='all',searchRunning=false,searchPage=0;
let active=null,playGeneration=0,watchTimer=null,hls=null,hlsLoading=null,removeHash=null,duplicateRequest=null,retryOperationId=null,pendingOperationId=null,lastSaved=0;
let foregroundPlay=0,rescueSearch=null,rescueFrameHandle=null,rescueLandingTimer=null;
let mapFrame=0,sceneAvailability='',pendingSeek=null;
let pictureFrame=null,insightAt=-Infinity,insightState='';
const playRequests=new Map(),backViews=[],viewPositions=new Map();
const knownLibraryHashes=new Set(),removedHashes=new Set();
let sourceMemoryView={enabled:false,available:false,observed:[],revision:null,version:0};
let sourceMemoryFence=0,sourceMemoryChanging=false,sourceMemoryConnecting=false;
const additions=new Map(),awaitingOperations=new Set(),handledOperations=new Set(),episodeIntents=new Map(),sourceRequests=new Map();
let history={};try{const saved=JSON.parse(localStorage.getItem('cinema-history')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))history=saved;}catch{}
let followStore=null,followWeek=null,watched=null,watchedUI=null,soundMap=null,twoTrackStudio=null;
const playerAudio=createPlayerAudio({panel:$('#audio-panel'),video:$('#video'),onChange:schedulePlaybackMap,
  restoreFocus:()=>{if($('#player-dialog').open)$('#close-player').focus();}});
const scenePreview=createScenePreviewUI({panel:$('#scene-preview-panel'),ancestor:$('#scene-panel'),mainVideo:$('#video'),
  getContext:scenePreviewContext,canSeek:canSeekScene,request:requestScenePreview,formatTime:clockTime,
  returnFocus:origin=>origin==='timeline'?[$('#timeline-panel input'),$('#timeline-panel > summary')]:
    [$('#scene-finder input[type=search]'),$('#scene-panel > summary')]});
const enrichment=createEnrichment({api,clean,escape,onChange:()=>{renderResults();renderLibrary();schedulePlaybackMap();},getActive:()=>active,getLibrary:()=>library,onEpisodes:item=>episodeUI.open(item),
  canSeekScene,seekScene,canPreviewScene:scenePreview.canCheckAt,previewScene:scenePreview.checkAt,
  previewAttachmentKey:scenePreview.attachmentKey,formatSceneTime:clockTime,onSceneTrackChange:()=>{
    scenePreview.revalidateEntry();
    schedulePlaybackMap();
    watched?.boundary();
    watchedUI?.invalidate();
    soundMap?.trackChanged();
    twoTrackStudio?.primaryChanged();
  },onWatchedCaptionReady:schedulePlaybackMap,
  onCaptionChange:()=>followWeek?.invalidateEvidence()});
soundMap=createSoundMap({panel:$('#sound-map-panel'),ancestor:$('#scene-panel'),dialog:$('#player-dialog'),video:$('#video'),
  getTrack:()=>enrichment.soundTrack(),getPlayerIdentity:()=>({generation:playGeneration,url:active?.url||null}),
  canSeekScene,seekScene,formatTime:clockTime,openSubtitles:()=>enrichment.openSubtitleSettings()});
twoTrackStudio=createTwoTrackStudio({panel:$('#two-track-panel'),ancestor:$('#subtitle-panel'),dialog:$('#player-dialog'),video:$('#video'),
  getPrimary:()=>enrichment.soundTrack(),getPlayerIdentity:()=>({generation:playGeneration,url:active?.url||null}),
  importCaption:(body,signal)=>api('/api/subtitles/import',body,false,signal),
  readCaption:(id,signal)=>readLocalWatchedCaption(id,undefined,signal),canSeekScene,seekScene,formatTime:clockTime,storage:localStorage});
const sceneSketchbook=createSceneSketchbook({panel:$('#scene-sketchbook-panel'),ancestor:$('#scene-panel'),
  dialog:$('#player-dialog'),video:$('#video'),readFrame:sketchbookFrame,formatTime:clockTime,
  authorize:(span,signal)=>watched.authorizeWatchedSpan(span,signal),
  hasCoverage:(span,seal,attachment)=>watchedSource()?.attachment===attachment&&watched.hasWatchedSpan(span,seal)});
const episodeUI=createEpisodesUI({api,escape,onRemember:enrichment.remember,onAdd:(key,category,intent)=>{episodeIntents.set(key,intent);return addSource(key,category,false,intent);},onPlay:openPlayer,getWatchHistory:()=>history,getLibrary:()=>library,
  onRelatedFilm:item=>discoveryUI.openItem(item),
  isFollowed:id=>followStore?.has(id)??false,onToggleFollow:(show,item)=>{
    const result=followStore?.has(show.id)?followStore.unfollow(show.id):
      followStore?.follow({...show,kind:show.kind==='anime'||item?.kind==='anime'||item?.browseCategory==='anime'?'anime':
        item?.kind==='korean'||item?.browseCategory==='korean'||show.language==='Korean'?'korean':'tv',
        posterUrl:item?.posterUrl});
    if(result?.ok)followWeek?.refreshFollows();
    return result;
  }});
const sceneRelay=createSceneRelay({host:$('#scene-relay'),arrival:$('#scene-arrival'),getContext:sceneContext,canSeek:canSeekScene,seek:seekScene,clockTime,escape,onChange:schedulePlaybackMap});
const editionAtlas=createEditionAtlasUI({
  host:$('#edition-atlas'),getContext:atlasContext,canSeek:canSeekScene,seek:seekScene,clockTime,escape,
});
const playbackTimeline=createPlaybackMap({panel:$('#timeline-panel'),clockTime,seek:seekScene,focusScene:id=>sceneRelay.focusPin(id),
  canPreviewAt:scenePreview.canCheckAt,previewAt:scenePreview.checkAt,onSelectionChange:scenePreview.revalidateEntry});
const runwayTracker=createPlaybackRunway();
const playbackInsights=createPlaybackInsightsUI({runwayHost:$('#playback-runway'),passportHost:$('#release-passport')});
const warmUI=createWarmPlaybackUI({
  panel:$('#warm-switch-panel'),bar:$('#warm-return-bar'),dock:$('#dock-warm-return'),
  onOptions:()=>warmFlow.options(),onSwitch:option=>warmFlow.switchTo(option),
  onReturn:()=>warmFlow.returnToParked(),onDismiss:()=>warmFlow.clear(),
});
const warmFlow=createWarmPlayback({
  api,getSource:warmSource,render:warmUI.update,
  titleFor:option=>library.find(item=>item.hash===option.hash)?.title||clean(option.fileName),
  attach:(attachment,context)=>{void openPlayer(attachment.state.hash,context.intent??null,attachment.file.index,{attachment,context});},
});
const rescueUI=createRescueUI({
  panel:$('#rescue-panel'),clockTime,escape,onShow:()=>{rescueFlow.show();fastStartFlow.refresh();},
  onClose:()=>{rescueFlow.close();fastStartFlow.clear();},
  onList:()=>rescueFlow.list(),onCheck:option=>{fastStartFlow.clear();return rescueFlow.check(option);},onCommit:kind=>rescueFlow.commit(kind),
  onCancel:()=>rescueFlow.cancelCheck(),onFind:()=>findReplacement(true),
  onFastStart:option=>fastStartFlow.start(option),onKeepOriginal:()=>fastStartFlow.cancel(),
});
const rescueFlow=createRescueFlow({
  api:(url,body,signal)=>api(url,body,false,signal),getSource:rescueSource,listCandidates:listRescueCandidates,
  validateCandidate:validateRescueCandidate,
  preview:(attachment,source,target,signal)=>previewRescue({attachment,
    source:{...source,originalTimes:source.originalTimes?.()},subtitle:target.subtitle,loadHls,signal}),
  attach:(attachment,context)=>{
    const {source,target,paused,position}=context;
    warmFlow.clear();
    void openPlayer(target.hash,target.intent??null,target.index,{attachment,context:{
      position,positionVerified:true,paused,rescueOriginal:{hash:source.hash,index:source.index,intent:source.intent},
      verifiedEpisode:target.episode?{...target.episode,index:target.index}:null,
    }});
  },
  render:rescueUI.update,
});
const fastStartFlow=createFastStartFlow({
  api:(url,body,signal)=>api(url,body,false,signal),getSource:fastStartSource,
  validateTarget:(target,source)=>validateRescueCandidate(target,source,{checkSubtitles:false}),
  preview:previewFastStart,render:state=>{
    rescueUI.updateFastStart(state);
    const panel=$('#rescue-panel');
    if(state.phase==='primary'&&panel.open){
      const focused=panel.contains(document.activeElement);
      panel.open=false;
      textIfChanged('#playback-status','Your original copy started first.');
      if(focused)$('#video').focus({preventScroll:true});
    }
    $('#player-fast-start').hidden=!state.available||!active?.prepareStarted||
      Date.now()-active.prepareStarted<2500||panel.open;
  },
  attach:({attachment,source,target})=>{
    void openPlayer(target.hash,target.intent??null,target.index,{attachment,context:{
      position:0,positionVerified:true,paused:false,rescueOriginal:{hash:source.hash,index:source.index,intent:source.intent},
      verifiedEpisode:target.episode?{...target.episode,index:target.index}:null,
    }});
  },
});
let spotlight=null,watchlist=null,watchPlanner=null,plannerRows=[];
const discoveryUI=createDiscoveryUI({api,escape,onAdd:addSource,onPlay:openPlayer,onRemember:enrichment.remember,getOperation:key=>additions.get(key),onEpisodes:(item,options)=>episodeUI.open(item,options),
  onCatalog:catalog=>{
    spotlight?.update(catalog);
    if(catalog.view==='home'&&catalog.visible&&catalog.rows.length){
      plannerRows=catalog.rows.slice(0,10);
      watchPlanner?.refresh();
    }
  },isSaved:item=>watchlist?.isSaved(item),onSave:item=>watchlist?.toggle(item),
  onSearch:item=>{
    const category=item.kind==='movies'?'movies':item.kind==='anime'?'anime':'tv';
    setView(category);
    $('#search-category').value=category;
    $('#search-source').value='';
    renderSourceOptions();
    $('#query').value=item.title+(item.kind==='movies'&&item.year?' '+item.year:'');
    $('#search-form').requestSubmit();
  }});
const pluginBrowser=createPluginBrowser({api,escape,onAdd:addSource,onPlay:openPlayer,onRemember:enrichment.remember,onSearch:(item,plugin)=>{
  if(!selectPlugin(plugin,item.nativeCategory||item.kind))return;
  $('#query').value=(item.title||'')+((item.nativeCategory||item.kind)==='movies'&&item.year?' '+item.year:'');
  if(item.title)$('#search-form').requestSubmit();
}});
async function api(url,data,retried=false,signal){
  let response;
  try{response=await fetch(url,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json','X-Cinema-Token':token},body:data===undefined?undefined:JSON.stringify(data),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(url==='/api/episodes/catalog'?45000:30000)});}catch(e){throw Error(e.name==='TimeoutError'?(url==='/api/episodes/catalog'?'The episode catalog is taking longer than expected. Retry the episode list in a moment.':'The request is taking longer than expected. Check the live download status before trying again.'):'Cinema could not reach its local server. Keep qBittorrent open and restart Cinema if needed.');}
  let result;try{result=await response.json();}catch{throw Error('The server returned an unreadable response. Try refreshing the connection.');}
  if(response.status===403&&data!==undefined&&!retried){const session=await api('/api/session');token=session.token;return api(url,data,true,signal);}
  if(!response.ok){const error=Error(result.error||'The request could not finish.');error.status=response.status;error.code=result.code;throw error;}
  return result;
}
async function requestScenePreview({hash,index,sessionId},targetMs,signal,options){
  if(!token)token=(await api('/api/session',undefined,false,signal)).token;
  signal.throwIfAborted();
  const fetchMissing=options?.fetch===true;
  const budget=AbortSignal.any([signal,AbortSignal.timeout(fetchMissing?24000:17000)]);
  let response;
  try{response=await fetch('/api/scene-preview',{method:'POST',headers:{'Content-Type':'application/json','X-Cinema-Token':token},
    body:JSON.stringify({hash,index,sessionId,targetMs,...(fetchMissing?{
      fetch:true,playheadMs:options.playheadMs,bufferedUntilMs:options.bufferedUntilMs,sampledAt:options.sampledAt}:{})}),signal:budget});}
  catch(error){throw Error(error.name==='TimeoutError'?'The preview took too long. Try again in a moment.':'Cinema could not reach the preview. Try again.');}
  if(response.status===403){token='';throw Error('Cinema reconnected. Check the preview again.');}
  if(!response.ok){
    const result=await response.json().catch(()=>null);
    throw Object.assign(Error(result?.error||'Cinema could not preview this scene. Try again.'),
      {code:result?.code,canFetch:result?.canFetch===true});
  }
  const contentType=response.headers.get('Content-Type'), length=Number(response.headers.get('Content-Length'));
  const seekHeader=response.headers.get('X-Cinema-Scene-Seek'), seek=Number(seekHeader);
  if(contentType!=='video/mp4'||!Number.isSafeInteger(length)||length<=0||length>2*1024*1024||
    !seekHeader||!Number.isFinite(seek)||seek<0||seek>8)throw Error('Cinema could not verify the returned preview.');
  let blob;
  try{blob=await response.blob();budget.throwIfAborted();}
  catch(error){throw Error(error.name==='TimeoutError'||budget.reason?.name==='TimeoutError'?
    'The preview took too long. Try again in a moment.':'The preview was incomplete. Try again.');}
  if(blob.size!==length)throw Error('The preview was incomplete. Try again.');
  return {blob,seek};
}
watched=createWatchedRuntime({
  storage:localStorage,api:(url,body,signal)=>api(url,body,false,signal),getSource:watchedSource,
  getLibrary:()=>library,getSavedCaption:(hash,index)=>{
    const selected=enrichment.savedRescueSubtitle(hash,index);
    return selected&&{id:selected.id,offsetMs:Math.round(selected.offset*1000)};
  },describe:(hash,index)=>{
    const item=library.find(torrent=>torrent.hash===hash);
    if(!item)return null;
    const file=watchRecord(hash,index)?.fileName,metadata=enrichment.metadata(file||item.name);
    return {title:metadata?.title||item.title,posterUrl:metadata?.posterUrl||null};
  },onChange:reason=>{
    if(reason==='reset')sceneSketchbook.reset();else sceneSketchbook.recheckCoverage();
    watchedUI?.refreshCollection();renderContinueWatching();schedulePlaybackMap();
  }
});
watchedUI=createWatchedDialogueUI({
  searchHost:$('#watched-dialogue-search'),recapDialog:$('#watched-catch-up'),playerHost:$('#watched-player-catch-up'),
  formatTime:clockTime,getCollection:watched.getCollection,setCollection:watched.setEnabled,clearEvidence:watched.clear,
  search:watched.search,loadRecap:watched.loadRecap,onModeChange:mode=>{
    document.body.classList.toggle('watched-dialogue-mode',mode==='dialogue');
  },onOpenMatch:openWatchedTarget,
  onReplay:(_target,recap,signal)=>openWatchedTarget({...recap,kind:'passage',
    startMs:Math.round(recap.start*1000),endMs:Math.round(recap.end*1000),time:recap.start},signal),
  onResume:async target=>{
    if(active?.hash===target.hash&&active.index===target.index&&$('#player-dialog').open){
      if(active.resumePending)chooseResume(false);
      else{
        active.userPaused=false;
        startVideo(playGeneration);
      }
      return true;
    }
    await openPlayer(target.hash,null,target.index);
    return true;
  }
});
window.addEventListener('storage',event=>{
  if(event.key!==WATCHED_ENABLED&&event.key!==WATCHED_STORE&&event.key!==null)return;
  watched.syncStorage();
  watchedUI.invalidate();
});

function textIfChanged(selector,value){const element=$(selector);const text=String(value??'');if(element.textContent!==text)element.textContent=text;}
function notice(message){$('#notice').textContent=message;$('#notice').hidden=!message;}
function setHTML(selector,html){updateHTML($(selector),html);}
function setSearchVisibility(open,{focus=false}={}){
  $('#search-section').hidden=!open;
  $('#search-toggle').setAttribute('aria-expanded',String(open));
  if(!open){$('#search-filters').open=false;watchedUI.closeSearch();}
  if(focus){
    if(open&&watchedUI.mode()==='dialogue')watchedUI.focusSearch();
    else (open?$('#query'):$('#search-toggle')).focus({preventScroll:true});
    if(open)$('#search-section').scrollIntoView({block:'nearest'});
  }
}
function setConnection(value,message){
  if(connected&&!value)followWeek?.invalidateEvidence();
  connected=value;
  if(!value){
    sceneSketchbook.reset();scenePreview.reset();fastStartFlow.refresh();cancelSourceMemory();
    if(sourceMemoryView.available)acceptSourceMemory({...sourceMemoryView,available:false,observed:[]});
  }
  else sceneSketchbook.refresh();
  $('#connection-dot').classList.toggle('online',value);
  setHTML('#connection-text',(value?(companionUI?.enabled?'Scene Preview connected':'qBittorrent connected'):'Connection interrupted')+
    '<small>'+escape(message||(companionUI?.enabled?'Reopen Cinema Scene Preview':'Check connection settings'))+'</small>');
  textIfChanged('#live-status',value?'● Connected':'○ Reconnecting');
  $('#live-status').classList.toggle('offline',!value);
}
function empty(title,description,action=true){
  const button=action==='magnet'?'<button class="subtle" data-companion-add aria-haspopup="dialog">Add magnet</button>':
    action?'<button class="subtle" data-discover>Discover titles</button>':'';
  return `<div class="empty"><div class="empty-icon" aria-hidden="true"><svg class="cinema-icon"><use href="#ico-film"/></svg></div><h3>${escape(title)}</h3><p>${escape(description)}</p>${button}</div>`;
}
function statusLabel(t){if(t.statusLabel)return t.statusLabel;if(isError(t))return 'Download needs attention';if(isPaused(t))return 'Paused';if(/meta/i.test(t.state))return 'Finding files';if(/check/i.test(t.state))return 'Checking files';if(/queued/i.test(t.state))return 'Queued';if(/stalledDL/i.test(t.state))return 'Waiting for peers';if(t.progress>=1)return 'Downloaded';return 'Downloading';}
function torrentActions(t){return `${['tv','anime'].includes(t.kind)?`<button class="text-button" data-series-hash="${escape(t.hash)}">Episodes</button>`:''}<button class="subtle" data-action="${isPaused(t)?'resume':'pause'}" data-hash="${escape(t.hash)}">${isPaused(t)?'Resume':'Pause'}</button><button class="text-button" data-remove="${escape(t.hash)}" aria-label="Remove ${escape(t.title)}">Remove</button>`;}
function renderLibrary(){
  textIfChanged('#library-count',library.length);textIfChanged('#download-count',library.filter(t=>t.progress<1).length);
  renderContinueWatching();
  if($('#library-section').hidden)return;
  let items=library;
  if(view==='korean')items=items.filter(t=>enrichment.metadata(t.name)?.browseCategory==='korean'||/korean|k-drama/i.test(t.name+' '+t.category));
  if(['movies','tv','anime','other'].includes(view))items=items.filter(t=>t.kind===view||view==='other'&&!['movies','tv','anime'].includes(t.kind));
  if(view==='downloads')items=items.filter(t=>t.progress<1||isError(t));
  const filter=$('#library-filter').value.trim().toLowerCase();if(filter)items=items.filter(t=>(t.title+' '+t.name).toLowerCase().includes(filter));
  const sort=$('#library-sort').value;items=[...items].sort((a,b)=>sort==='name'?a.title.localeCompare(b.title):sort==='progress'?b.progress-a.progress:sort==='continue'?(history[b.hash]?.updated||0)-(history[a.hash]?.updated||0):b.added_on-a.added_on);
  $('#library-title').textContent=view==='downloads'?'Downloads':'My Library';
  $('#library-eyebrow').textContent=view==='downloads'?'Manage transfers':'Ready when you are';
  $('#collection-toolbar').hidden=!['library','downloads'].includes(view);$('#download-summary').hidden=view!=='downloads';$('#library-grid').classList.toggle('download-list',view==='downloads');
  if(view==='downloads')setHTML('#download-summary',`<div><strong>${library.filter(t=>t.progress<1).length}</strong><span>In progress</span></div><div><strong>${bytes(library.reduce((sum,t)=>sum+Number(t.dlspeed||0),0))}/s</strong><span>Download speed</span></div><div><strong>${library.filter(t=>t.progress>=1).length}</strong><span>Saved in your library</span></div>`);
  if(!items.length&&companionUI?.enabled&&!filter){
    setHTML('#library-grid',empty(connected?(library.length?'Nothing downloading right now':'Ready for your first download'):'Scene Preview is reconnecting',
      connected?'Paste a magnet link to get started. Your existing library and search plugins are in the Cinema shortcut.':
        'Reopen Cinema Scene Preview to check the connection. Your existing library is in the Cinema shortcut.',connected?'magnet':false));
    return;
  }
  if(!items.length){setHTML('#library-grid',empty(filter?'No titles match your filter':!connected&&!library.length?'Your cinema is waiting for a connection':view==='downloads'?'Nothing downloading right now':'Room for your next favorite',filter?'Try another name or clear your filter.':!connected&&!library.length?'Open Connection settings to connect to qBittorrent.':view==='downloads'?'Completed downloads live in My library. Files stay until you remove them.':'Choose a source from search to add something to this collection.',!filter));return;}
  const downloadView=view==='downloads';
  updateKeyedList($('#library-grid'),items.map(t=>libraryCard(t,downloadView)));
  if(!downloadView)void hydrateLibraryArtwork(items);
}
const requestedArtwork=new Set();
let fetchingArtwork=false;
async function hydrateLibraryArtwork(items){
  if(fetchingArtwork||requestedArtwork.size>=12)return;
  fetchingArtwork=true;
  try{
    for(const item of items.slice(0,8)){
      if(view!=='library'||requestedArtwork.size>=12)break;
      if(!['movies','tv','anime'].includes(item.kind)||requestedArtwork.has(item.hash)||enrichment.metadata(item.name)?.posterUrl)continue;
      requestedArtwork.add(item.hash);
      const title=clean(item.name).replace(/\bS\d{1,2}(?:E\d{1,3})?\b.*$/i,'').trim();
      if(!title)continue;
      try{
        const result=await api('/api/metadata/search',{query:title,kind:item.kind});
        const candidate=result.matches?.[0];
        if(candidate?.posterUrl&&candidate.confidence>=.9&&!result.ambiguous)enrichment.remember(candidate);
      }catch{}
    }
  }finally{fetchingArtwork=false;}
}
function libraryCard(item,downloadView){
  const {hash,name,title}=item,kind=['movies','tv','anime'].includes(item.kind)?item.kind:'other';
  const paused=isPaused(item),error=isError(item),finished=item.progress>=1;
  const poster=downloadView?'':enrichment.poster(name),actions=torrentActions(item),resume=history[hash];
  const signature=JSON.stringify([downloadView,name,title,kind,paused,error,poster,actions]);
  const label=statusLabel(item),progress=percent(item.progress);
  const received=downloadView?`${progress.toFixed(1)}% · ${bytes(item.downloaded||item.size*item.progress)} / ${bytes(item.total_size||item.size)}`:finished?'Saved on your PC':`${progress.toFixed(1)}% · ↓ ${bytes(item.dlspeed||0)}/s`;
  const speed=downloadView?'↓ '+bytes(item.dlspeed||0)+'/s':bytes(item.total_size||item.size);
  const seeds=downloadView?`${item.num_seeds??0} connected seeds`:resume?.time>10&&!resume.finished?clockTime(resume.time)+' watched':'';
  const remaining=downloadView?finished?'Complete':paused?'Paused':eta(item.eta):'';
  const playLabel=downloadView?'Watch':resume?.time>10&&!resume.finished?'Resume':'Play';
  return {
    key:hash,signature,value:JSON.stringify([label,progress,received,speed,seeds,remaining,playLabel]),
    html:()=>downloadView
      ? `<article class="download-row"><div class="download-cover ${kind}" aria-hidden="true">↓</div><div class="download-info"><div class="download-title"><h3>${escape(title)}</h3><span data-live="label" class="status-pill ${error?'error':paused?'paused':''}"></span></div><p title="${escape(name)}">${escape(name)}</p><div class="progress"><progress aria-label="Download progress for ${escape(title)}" max="100"></progress></div><div class="download-metrics"><span data-live="received"></span><span data-live="speed"></span><span data-live="seeds"></span><span data-live="remaining"></span></div></div><div class="download-actions"><button class="primary" data-play="${escape(hash)}" data-live="play"></button><div>${actions}</div></div></article>`
      : `<article class="collection-card"><button class="collection-art" type="button" data-play="${escape(hash)}" aria-label="Watch ${escape(title)}">${poster}<strong>${escape(title)}</strong></button><div class="collection-actions"><button class="primary" type="button" data-play="${escape(hash)}" data-live="play"></button><details><summary aria-label="More options for ${escape(title)}"><svg class="cinema-icon" aria-hidden="true"><use href="#ico-more"/></svg></summary><div class="collection-options">${actions}</div></details></div><div class="progress"><progress aria-label="Download progress for ${escape(title)}" max="100"></progress></div></article>`,
    patch:element=>{
      for(const [field,value] of Object.entries({label,received,speed,seeds,remaining,play:playLabel})){
        const cell=element.querySelector('[data-live="'+field+'"]');
        if(cell&&cell.textContent!==value)cell.textContent=value;
      }
      element.querySelector('progress').value=progress;
      if(!downloadView)element.setAttribute('data-saved',String(finished));
    },
  };
}
function renderContinueWatching(){
  const section=$('#continue-section');
  if(view!=='home'||!$('#search-results').hidden){section.hidden=true;return;}
  const rows=library.flatMap(item=>{
    const saved=history[item.hash];
    if(!saved)return [];
    return Object.values(saved.files||{[saved.index]:saved})
      .filter(record=>record.time>=5&&!record.finished)
      .map(record=>({item,record}));
  }).sort((a,b)=>b.record.updated-a.record.updated).slice(0,8);
  section.hidden=!rows.length;
  if(!rows.length)return;
  setHTML('#continue-list',rows.map(({item,record})=>{
    const part=record.fileName&&clean(record.fileName)!==item.title?clean(record.fileName):'';
    const progress=record.duration>0?'<progress aria-label="Watch progress" max="100" value="'+percent(record.time/record.duration)+'"></progress>':'';
    const recap=watched?.canCatchUp({hash:item.hash,index:record.index,resumeTime:record.time})?
      `<button type="button" class="subtle continue-catch-up" data-watched-recap="${escape(item.hash)}" data-watched-index="${record.index}" aria-label="Catch Up on ${escape(item.title)}">Catch Up</button>`:'';
    return `<div class="continue-entry"><button type="button" class="continue-card" data-play="${escape(item.hash)}" data-play-index="${record.index}"><span class="continue-art">${enrichment.poster(item.name)}<span aria-hidden="true"><svg class="cinema-icon"><use href="#ico-play"/></svg></span></span><span class="continue-copy"><strong>${escape(item.title)}</strong>${part?`<small>${escape(part)}</small>`:''}<span>Resume at ${clockTime(record.time)}</span>${progress}</span></button>${recap}</div>`;
  }).join(''));
}
function populateCategories(){const previous=$('#search-category').value;const found=new Map([['all','All categories'],['movies','Movies'],['tv','TV shows'],['anime','Anime'],['misc','Miscellaneous / general']]);for(const p of plugins)for(const c of categoriesOf(p))if(!found.has(c.id))found.set(c.id,names[c.id]||c.name||c.id);setHTML('#search-category',[...found].map(([id,label])=>`<option value="${escape(id)}">${escape(label)}</option>`).join(''));$('#search-category').value=found.has(previous)?previous:'all';}
const broadSearchCategory=category=>['all','movies','tv','anime'].includes(category);
const maximumSearchReleases=1500,maximumRawSearchRows=6000;
function renderSourceOptions(){
  const category=$('#search-category').value,select=$('#search-source'),previous=select.value;
  const matching=plugins.filter(p=>supported(p,category)),broad=broadSearchCategory(category);
  const count=broad?plugins.filter(p=>p.enabled).length:matching.length;
  setHTML('#search-source',`<option value="">${broad?'All enabled plugins':'All matching plugins'}</option>`+
    matching.map(p=>`<option value="${escape(p.name)}">${escape(p.fullName||p.name)}</option>`).join(''));
  if(matching.some(p=>p.name===previous))select.value=previous;
  textIfChanged('#source-hint',select.value?'Searching one plugin':`Searching ${count} enabled ${count===1?'plugin':'plugins'}`);
}
function renderSources(){
  const filter=$('#plugin-filter').value.toLowerCase(),group=$('#plugin-group').value,status=$('#plugin-status').value;
  const items=plugins.filter(p=>(p.name+' '+p.fullName).toLowerCase().includes(filter)&&
    (group==='all'||groupOf(p).includes(group))&&(status==='all'||Boolean(p.enabled)===(status==='enabled')))
    .sort((a,b)=>(a.fullName||a.name).localeCompare(b.fullName||b.name));
  const enabled=plugins.filter(p=>p.enabled).length;
  textIfChanged('#plugin-count',`${plugins.length} installed · ${enabled} enabled${items.length!==plugins.length?' · '+items.length+' shown':''}`);
  setHTML('#sources-grid',items.map(p=>`<article class="source-card">
    <div class="source-heading"><span class="source-monogram" aria-hidden="true">${escape((p.fullName||p.name).slice(0,1).toUpperCase())}</span>
      <div><h3>${escape(p.fullName||p.name)}</h3><span class="badge ${p.enabled?'':'disabled'}">${p.enabled?'Enabled':'Disabled in qBittorrent'}</span></div>
    </div><p>${escape(groupOf(p).map(categoryName).join(' · '))}</p>
    <div class="chips" aria-label="Search categories">${categoriesOf(p).map(c=>`<button class="chip" data-plugin="${escape(p.name)}" data-plugin-category="${escape(c.id)}" ${p.enabled?'':'disabled'}>${escape(names[c.id]||c.name||c.id)}</button>`).join('')}</div>
    <button class="primary source-browse" type="button" data-browse-plugin="${escape(p.name)}" ${p.enabled?'':'disabled'}>Browse plugin</button>
    <button class="subtle source-search" type="button" data-plugin="${escape(p.name)}" data-plugin-category="all" ${p.enabled?'':'disabled'}>Search this plugin</button>
  </article>`).join('')||empty(plugins.length?'No matching plugins':'No plugins found',
    plugins.length?'Choose another filter to see more plugins.':connected?'Install search plugins in qBittorrent, then refresh this list.':'Connect to qBittorrent to load the installed plugins.',false));
  renderViewIntro();
}
function acceptPluginList(value){
  if(!Array.isArray(value)||JSON.stringify(value)===JSON.stringify(plugins))return;
  plugins=value;populateCategories();renderSourceOptions();renderSources();
}
function renderViewIntro(){
  if(!['movies','tv','anime','korean','other'].includes(view))return;
  $('#view-title').textContent=names[view];
  $('#view-description').textContent={movies:'See the films everyone’s watching.',tv:'Find a new series to get into.',korean:'Find your next Korean drama.',anime:'Catch up on what’s trending in anime.',other:'Music, books, games and more.'}[view];
  const matches=view==='other'?plugins.filter(p=>supported(p,'misc')):[];
  setHTML('#view-source-chips',matches.slice(0,12).map(p=>`<button class="chip" data-plugin="${escape(p.name)}" data-plugin-category="all">${escape(p.fullName||p.name)}</button>`).join('')+(view==='other'?'<button class="chip" data-view="sources">Browse sources</button>':''));
}
function rememberView(){
  viewPositions.set(view,{top:window.scrollY||0,filter:$('#library-filter').value,sort:$('#library-sort').value,query:$('#query').value,category:$('#search-category').value,source:$('#search-source').value,searchOpen:!$('#search-section').hidden,
    results:$('#search-results').hidden?null:{rows:searchRows,page:searchPage,category:searchCategory,title:$('#results-title').textContent,status:$('#results-status').textContent.replace('Still searching…','Search paused'),warnings:$('#search-warnings').textContent,sort:$('#results-sort').value,group:openReleaseGroup,releaseLimit:visibleReleaseLimit}});
}
function setView(next,{back=false}={}){
  if(!['home','movies','tv','anime','korean','other','library','downloads','sources'].includes(next))return;
  if(next===view)return;
  rememberView();
  if(!back){backViews.push(view);if(backViews.length>20)backViews.shift();}
  foregroundPlay++;
  void stopSearch();
  enrichment.cancelCatalog?.();
  if(view==='sources')pluginBrowser.close?.();
  view=next;
  const saved=viewPositions.get(view),results=saved?.results;
  discoveryUI.setView(view);
  $('#view-name').textContent=names[view];document.title=`${names[view]} · Cinema`;
  $('#view-back').hidden=!backViews.length;
  document.querySelectorAll('nav [data-view]').forEach(button=>{
    const selected=button.dataset.view===view;
    button.classList.toggle('active',selected);
    if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  $('#home-heading').hidden=view!=='home';
  $('#watch-planner-entry').hidden=view!=='home';
  $('#follow-week-entry').hidden=view!=='home';
  $('#view-intro').hidden=!['movies','tv','anime','korean','other'].includes(view);
  $('#library-section').hidden=!['library','downloads'].includes(view);
  $('#watchlist-section').hidden=view!=='library';
  $('#sources-section').hidden=view!=='sources';
  setSearchVisibility(Boolean(results||saved?.searchOpen));
  $('#search-results').hidden=!results;
  $('#title-catalog').hidden=true;
  $('#metadata-note').textContent='';
  $('#library-filter').value=saved?.filter||'';
  $('#library-sort').value=saved?.sort||'recent';
  $('#query').value=saved?.query||'';
  $('#search-category').value=saved?.category||(view==='other'?'misc':view==='korean'?'tv':['movies','tv','anime'].includes(view)?view:'all');
  $('#search-source').value='';
  renderSourceOptions();
  if(saved?.source&&plugins.some(p=>p.name===saved.source&&supported(p,$('#search-category').value))){
    $('#search-source').value=saved.source;renderSourceOptions();
  }
  if(results){
    searchRows=results.rows;searchPage=results.page;searchCategory=results.category;
    openReleaseGroup=results.group;visibleReleaseLimit=results.releaseLimit;
    $('#results-title').textContent=results.title;$('#results-status').textContent=results.status;
    $('#search-warnings').textContent=results.warnings;$('#search-warnings').hidden=!results.warnings;
    $('#results-sort').value=results.sort;discoveryUI.setSearchMode(true);renderResults();
    if(saved.query)void enrichment.searchCatalog(saved.query,searchCategory);
  }
  renderLibrary();renderViewIntro();if(view==='sources')renderSources();
  window.scrollTo({top:saved?.top||0,behavior:'instant'});
}
function selectPlugin(name,category){
  const plugin=plugins.find(p=>p.name===name&&p.enabled);
  if(!plugin){notice('This plugin is unavailable. Refresh the Sources list.');return false;}
  watchedUI.setMode('titles');
  if(['library','downloads'].includes(view))setView('sources');
  setSearchVisibility(true,{focus:true});
  $('#search-category').value=supported(plugin,category)?category:'all';
  renderSourceOptions();$('#search-source').value=name;renderSourceOptions();
  $('#search-filters').open=true;$('#query').placeholder=`Search ${plugin.fullName||name}…`;
  return true;
}
function renderPending(){
  const pending=operations.filter(o=>['adding','accepted','uncertain','failed'].includes(o.status)).sort((a,b)=>b.createdAt-a.createdAt);
  $('#pending-section').hidden=!pending.length;if(!pending.length){pendingOperationId=null;return;}
  const o=pending[0];pendingOperationId=o.id;
  textIfChanged('#pending-title',(o.status==='failed'?'Source needs attention · ':'')+(o.name||'Connecting your source'));
  textIfChanged('#pending-description',(o.message||'Waiting for qBittorrent to confirm the download. You can keep browsing.')+(pending.length>1?` · ${pending.length-1} other requests waiting`:''));
  $('#pending-section').classList.toggle('needs-attention',['uncertain','failed'].includes(o.status));
  $('#retry-add').hidden=!['uncertain','failed'].includes(o.status);
}
async function reconcileOperations(){
  let sourceChanged=false;
  for(const o of operations){
    if(o.status==='removed'||o.hash&&removedHashes.has(o.hash)){if(o.hash)invalidateRemovedHash(o.hash);continue;}
    let requestKey=o.selectionKey;
    for(const [key,entry] of additions){
      const recovered=!entry.id&&entry.status==='uncertain'&&o.selectionKey===key;
      if(entry.id===o.id||recovered){
        requestKey=key;
        if(entry.status!==o.status||entry.hash!==o.hash||entry.message!==o.message||recovered){
          additions.set(key,{...entry,...o});sourceChanged=true;
        }
        if(recovered)awaitingOperations.add(o.id);
      }
    }
    if(!awaitingOperations.has(o.id)||handledOperations.has(o.id))continue;
    if(o.hash&&['ready','accepted'].includes(o.status)){
      handledOperations.add(o.id);awaitingOperations.delete(o.id);
      if(playRequests.get(requestKey)===foregroundPlay){
        notice(o.existing?'Opening your saved copy.':'Source connected. Preparing playback…');
        void openPlayer(o.hash,episodeIntents.get(requestKey)||o.intent);
      }else notice('A source is ready in Downloads. Your current watch continues.');
      playRequests.delete(requestKey);
    }else if(o.status==='failed'){
      handledOperations.add(o.id);awaitingOperations.delete(o.id);playRequests.delete(requestKey);notice(o.message||'The source could not be added.');
    }
  }
  renderPending();
  if(sourceChanged){renderResults();discoveryUI.render();}
}
function invalidateRemovedHash(hash){
  if(!hash)return;warmFlow.invalidate(hash);removedHashes.add(hash);knownLibraryHashes.delete(hash);
  if(active?.hash===hash)scenePreview.reset();
  followWeek?.invalidateEvidence();
  for(const [key,entry] of additions)if(entry.hash===hash){additions.delete(key);playRequests.delete(key);sourceRequests.set(key,(sourceRequests.get(key)||0)+1);if(entry.id){awaitingOperations.delete(entry.id);handledOperations.add(entry.id);}}
  for(const operation of operations)if(operation.hash===hash){awaitingOperations.delete(operation.id);handledOperations.add(operation.id);}operations=operations.filter(operation=>operation.hash!==hash);
  for(const rows of [searchRows,...[...viewPositions.values()].map(position=>position.results?.rows||[])])for(const result of rows)if(result.existingHash===hash)delete result.existingHash;
  discoveryUI.invalidateHash?.(hash);pluginBrowser.invalidateHash?.(hash);episodeUI.invalidateHash?.(hash);
  watchedUI?.invalidate();
}
function reconcileLibraryPresence(state){
  if(!state.connected||!Array.isArray(state.library))return;const present=new Set(state.library.map(item=>item.hash)),removed=[...knownLibraryHashes].filter(hash=>!present.has(hash));
  if(active?.files.length&&!present.has(active.hash))removed.push(active.hash);
  for(const hash of new Set(removed)){
    invalidateRemovedHash(hash);
    if(active?.hash!==hash)continue;
    if(active.preparedOnly?.fallback||active.rescueOriginal){failPreparedPlayback('This checked title is no longer in your library.');continue;}
    stopPlayback({cancelPending:false});
    notice('This torrent was removed from qBittorrent. Your other titles are still available.');
  }
  for(const hash of present){knownLibraryHashes.add(hash);removedHashes.delete(hash);}
}
async function refresh(){if(refreshPromise)return refreshPromise;const memoryFence=sourceMemoryFence;refreshPromise=(async()=>{try{const state=await api('/api/state');setConnection(Boolean(state.connected),state.connected?`${state.version||''} · Local connection`:state.error);if(Array.isArray(state.library))library=state.library;acceptPluginList(state.plugins);if(Array.isArray(state.operations))operations=state.operations;reconcileLibraryPresence(state);if(memoryFence===sourceMemoryFence&&!sourceMemoryChanging&&!sourceMemoryConnecting)acceptSourceMemory(state.sourceMemory);renderLibrary();watchPlanner?.refresh();await reconcileOperations();return Boolean(state.connected);}catch(e){setConnection(false,e.message);watchPlanner?.refresh();return false;}finally{refreshPromise=null;}})();return refreshPromise;}
async function stateLoop(){
  await refresh();
  clearTimeout(stateTimer);
  stateTimer=setTimeout(stateLoop,document.hidden&&!active?8000:2000);
}
async function stopSearch(){searchGeneration++;const old=searchId;searchId=null;searchRunning=false;$('#search-button').disabled=false;$('#search-button').textContent='Search →';if(old!==null)api('/api/search/stop',{id:old}).catch(()=>{});}
function sourceName(url){try{return new URL(url).hostname.replace(/^www\./,'');}catch{return 'Search provider';}}
const resultPageSize=12;
let openReleaseGroup=null,visibleReleaseLimit=8;
function currentRescueSearch(){
  return rescueSearch?.generation===playGeneration&&rescueSearch.hash===active?.hash&&
    rescueSearch.query===$('#query').value.trim()?rescueSearch:null;
}
function patchSourceMemoryRows(){
  const slots=$('#results-grid').querySelectorAll('[data-source-memory-key]');
  if(!slots.length)return;
  const sources=sourceMemoryView.observed.length?new Map(searchRows.map(row=>[row.key,row])):null;
  for(const slot of slots){
    const rows=sources?sourceMemoryCohorts(sources.get(slot.dataset.sourceMemoryKey),sourceMemoryView,library):[];
    slot.hidden=!rows.length;
    const text=rows.map(sourceMemoryLabel).join('\n');
    const summary=slot.querySelector('[data-source-memory-summary]');
    if(summary.textContent!==text)summary.textContent=text;
  }
}
function refreshSourceMemoryControls(message=''){
  const toggle=$('#source-memory-enabled'),clear=$('#source-memory-clear');
  const storageBlocked=sourceMemoryView.storageAvailable===false;
  if(!sourceMemoryChanging)toggle.checked=sourceMemoryView.enabled;
  toggle.disabled=sourceMemoryChanging||!sourceMemoryView.revision||storageBlocked;
  clear.disabled=sourceMemoryChanging||!sourceMemoryView.revision||storageBlocked;
  $('#source-memory-confirm-clear').disabled=sourceMemoryChanging;
  textIfChanged('#source-memory-status',message||(storageBlocked?'Private storage is unavailable.':sourceMemoryView.enabled?
    (sourceMemoryView.available?'Remembering eligible starts.':'Waiting for the local connection.'):'Source Memory is off.'));
}
function acceptSourceMemory(next){
  if(!next||typeof next.revision!=='string'||!Array.isArray(next.observed))return;
  if(next.revision===sourceMemoryView.revision&&next.version<sourceMemoryView.version)return;
  if(next.revision!==sourceMemoryView.revision||!next.enabled||!next.available)cancelSourceMemory();
  sourceMemoryView=next;
  refreshSourceMemoryControls();
  patchSourceMemoryRows();
}
async function changeSourceMemory(action){
  if(sourceMemoryChanging)return;
  sourceMemoryChanging=true;sourceMemoryFence++;cancelSourceMemory();
  if(action.action==='clear'||action.enabled===false)acceptSourceMemory({...sourceMemoryView,observed:[]});
  refreshSourceMemoryControls('Saving your preference…');
  try{
    const value=await api('/api/source-memory',action);
    sourceMemoryFence++;
    acceptSourceMemory(value);
    $('#source-memory-confirm').hidden=true;
    if(action.action==='clear')$('#source-memory-clear').focus();
    refreshSourceMemoryControls(action.action==='clear'?'Saved playback starts were cleared.':'');
  }catch(error){refreshSourceMemoryControls(error.message);}
  finally{
    sourceMemoryChanging=false;
    refreshSourceMemoryControls($('#source-memory-status').textContent);
  }
}
function cancelSourceMemory(){if(active)active.sourceMemoryStart=null;}
function sourceMemoryForeground(){
  return !document.hidden&&$('#player-dialog').open&&!document.querySelector('dialog[open]:not(#player-dialog)');
}
function makeSourceMemoryStart(generation,eligible){
  const file=active?.files.length===1?active.files[0]:null;
  if(!eligible||!file||file.index!==active.index||!connected||!sourceMemoryView.enabled||!sourceMemoryView.available||
    !sourceMemoryForeground()||active.resumeTarget!==0||active.watchedTarget||active.preparedOnly)return null;
  return {generation,hash:active.hash,index:active.index,file,revision:sourceMemoryView.revision,startedAt:performance.now()};
}
function bindSourceMemoryStart(attempt,state){
  if(!attempt||active?.sourceMemoryStart!==attempt)return;
  if(state.hash!==attempt.hash||state.index!==attempt.index||state.fileName!==attempt.file.name||
    state.memoryStart?.size!==attempt.file.size||state.memoryStart?.revision!==attempt.revision||
    typeof state.sessionId!=='string'){cancelSourceMemory();return;}
  attempt.sessionId=state.sessionId;
}
function tryReportSourceMemory(video,attempt){
  if(!attempt||active?.sourceMemoryStart!==attempt||!Number.isFinite(attempt.playingAt)||!Number.isFinite(attempt.frameSeenAt))return;
  cancelSourceMemory();
  const state=active.backendState;
  if(!sourceMemoryView.enabled||!sourceMemoryView.available||attempt.revision!==sourceMemoryView.revision||!connected||
    !attempt.sessionId||state?.sessionId!==attempt.sessionId||state.hash!==attempt.hash||state.index!==attempt.index||
    active.hash!==attempt.hash||active.index!==attempt.index||attempt.generation!==playGeneration||active.url!==attempt.url||
    state.status!=='ready'||state.url!==attempt.url||state.fileName!==attempt.file.name||
    !sourceMemoryForeground()||
    !(video.videoWidth>0&&video.videoHeight>0)||!Number.isFinite(video.currentTime)||video.currentTime<0||video.currentTime>1.25||
    video.paused||video.seeking||video.ended||video.error||video.readyState<2||video.playbackRate!==1||video.defaultPlaybackRate!==1||
    !active.hasPlayed||active.waiting||active.failed||active.autoplayBlocked||active.resumeTarget!==0||
    active.watchedTarget||active.preparedOnly||active.rescueOriginal||active.hlsRecovery)return;
  const firstPictureMs=firstPictureDuration(attempt);
  if(firstPictureMs===null)return;
  void api('/api/source-memory',{action:'record',hash:attempt.hash,index:attempt.index,sessionId:attempt.sessionId,
    revision:attempt.revision,firstPictureMs}).then(result=>{if(result.accepted)void refresh();}).catch(()=>{});
}
function sourceMemoryFrame(video,generation,url,now,frame){
  const attempt=active?.sourceMemoryStart;
  if(!attempt||attempt.generation!==generation||Number.isFinite(attempt.frameSeenAt))return;
  if(!attempt.sessionId||!Number.isFinite(frame?.mediaTime)||frame.mediaTime<0||frame.mediaTime>1.25||
    !Number.isSafeInteger(frame?.presentedFrames)||frame.presentedFrames<1||!video.videoWidth||!video.videoHeight||
    video.paused||video.seeking||!sourceMemoryForeground()){cancelSourceMemory();return;}
  attempt.url=url;
  attempt.frameAt=Number.isFinite(frame.presentationTime)?frame.presentationTime:now;
  attempt.frameSeenAt=performance.now();
  tryReportSourceMemory(video,attempt);
}
function sourceMemoryPlaying(video){
  const attempt=active?.sourceMemoryStart;
  if(!attempt||Number.isFinite(attempt.playingAt))return;
  if(!sourceMemoryForeground()){cancelSourceMemory();return;}
  attempt.playingAt=performance.now();
  tryReportSourceMemory(video,attempt);
}
function releaseHash(source){
  const candidate=source.existingHash||additions.get(source.key)?.hash;
  return candidate&&!removedHashes.has(candidate)?candidate:null;
}
function releaseRank(source){
  const hash=releaseHash(source),local=hash&&library.find(item=>item.hash===hash);
  const suitable=local&&!['error','missingFiles'].includes(local.state);
  return (suitable?(Number(local.progress)>=1?1000:Number(local.dlspeed)>0?90:0):0)+
    (source.streaming?.score??(Number(source.nbSeeders)||0));
}
function canRecommendRelease(source){
  if(source.streaming?.pack||additions.get(source.key)?.status==='failed')return false;
  const hash=releaseHash(source),local=hash&&library.find(item=>item.hash===hash);
  if(local)return !['error','missingFiles'].includes(local.state)&&(Number(local.progress)>=1||Number(local.dlspeed)>0);
  return ['movies','tv','anime'].includes(source.kind)&&Number(source.nbSeeders)>0;
}
function reportedCount(value,label){
  return Number.isInteger(value)&&value>=0?`${value} ${label}`:`${label[0].toUpperCase()+label.slice(1)} unknown`;
}
function compareReleaseSize(a,b,direction){
  const left=Number(a.fileSize),right=Number(b.fileSize);
  if(!(left>0&&right>0))return Number(right>0)-Number(left>0);
  return direction*(left-right);
}
function releaseAction(source){
  const operation=additions.get(source.key);
  const existing=releaseHash(source);
  const pending=operation&&['adding','accepted','uncertain'].includes(operation.status)&&!existing;
  const rescue=currentRescueSearch();
  return rescue?(existing?
    {attr:'data-rescue-restore',label:existing===rescue.hash?'Current release':'Check in player',disabled:existing===rescue.hash}:
    {attr:`data-rescue-download="${escape(source.key)}" data-category="${escape(searchCategory)}"`,
      label:pending?'Adding download…':operation?.status==='failed'?'Retry download':'Download for rescue',disabled:pending}):
    {attr:existing?`data-play="${escape(existing)}"`:`data-add="${escape(source.key)}" data-category="${escape(searchCategory)}"`,
      label:existing?'Play':pending?'Getting ready…':operation?.status==='failed'?'Try again':Number(source.nbSeeders)>0?'Watch':'Try source',disabled:pending};
}
function renderRelease(source,index,recommendedKey){
  const existing=releaseHash(source),action=releaseAction(source);
  const tags=(source.fileName.match(/\b(?:2160p|1080p|720p|480p|WEB[- ]?DL|BluRay|HEVC|x265|x264|English|Hindi|Japanese|Korean|Dual[ ._-]Audio)\b/ig)||[]).slice(0,4);
  const facts=[Number(source.fileSize)>0?bytes(source.fileSize):'Size unknown',reportedCount(source.nbSeeders,'seeders'),
    reportedCount(source.nbLeechers,'leechers'),source.engineName||source.plugin||sourceName(source.siteUrl)];
  const title=existing?'In your library':source.key===recommendedKey?'Recommended':`Option ${index+1}`;
  const details=[...tags,source.streaming?.label].filter(Boolean).join(' · ');
  return `<li class="release-row"><div><strong>${title}${source.streaming?.resolution?' · '+escape(source.streaming.resolution):''}</strong>
    <small class="release-facts">${escape(facts.join(' · '))}</small>
    <details class="result-release-details"><summary>Release details</summary><small>${escape(source.fileName)}</small>${details?`<small>${escape(details)}</small>`:''}
      <div class="source-memory-release" data-source-memory-key="${escape(source.key)}" hidden><strong>Past starts on this PC</strong><small data-source-memory-summary></small></div></details>
    </div><button class="primary" type="button" ${action.attr} ${action.disabled?'disabled':''}>${action.label}</button></li>`;
}
function renderResults(){
  if($('#search-results').hidden)return;
  const sort=$('#results-sort').value;
  const bySeeds=(a,b)=>(b.nbSeeders??-1)-(a.nbSeeders??-1);
  const sortBy={
    'size-small':(a,b)=>compareReleaseSize(a,b,1),
    'size-large':(a,b)=>compareReleaseSize(a,b,-1),
    name:(a,b)=>a.fileName.localeCompare(b.fileName),
    seeders:bySeeds,
    leechers:(a,b)=>(b.nbLeechers??-1)-(a.nbLeechers??-1),
  };
  const rows=[...searchRows].sort(sortBy[sort]||((a,b)=>releaseRank(b)-releaseRank(a)||bySeeds(a,b)));
  const groups=new Map();
  for(const source of rows){
    const title=clean(source.fileName)||source.fileName,kind=source.kind||searchCategory;
    const key=kind+':'+title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    if(!groups.has(key))groups.set(key,{key,title,kind,rows:[]});
    groups.get(key).rows.push(source);
  }
  const pages=Math.max(1,Math.ceil(groups.size/resultPageSize));
  searchPage=Math.max(0,Math.min(searchPage,pages-1));
  $('#result-pagination').hidden=pages<2;
  textIfChanged('#result-page-label',`Page ${searchPage+1} of ${pages} · ${groups.size} titles`);
  $('#result-previous').disabled=searchPage===0;
  $('#result-next').disabled=searchPage>=pages-1;
  if(!groups.size){
    if(!searchRunning)setHTML('#results-grid',empty('No matches this time','Try another title, category, or plugin. Provider warnings appear above.',false));
    return;
  }
  const shown=[...groups.values()].slice(searchPage*resultPageSize,(searchPage+1)*resultPageSize);
  updateKeyedList($('#results-grid'),shown.map(({key,title,kind,rows:releases})=>{
    const expanded=key===openReleaseGroup,top=releases[0],releaseLabel=`${releases.length} ${releases.length===1?'source':'sources'}`;
    const recommended=currentRescueSearch()?null:releases.filter(canRecommendRelease).sort((a,b)=>releaseRank(b)-releaseRank(a))[0];
    const bestAction=recommended?releaseAction(recommended):null;
    const primary=bestAction?`<button class="primary result-best-play" type="button" ${bestAction.attr} ${bestAction.disabled?'disabled':''}
      aria-label="${escape((bestAction.disabled?bestAction.label:'Play best source')+' for '+title)}">${bestAction.disabled?bestAction.label:'Play best source'}</button>`:'';
    const panelId='release-panel-'+encodeURIComponent(key);
    const sourceList=expanded?`<div class="release-panel" id="${panelId}"><ul>${releases.slice(0,visibleReleaseLimit).map((release,index)=>renderRelease(release,index,recommended?.key)).join('')}</ul>${releases.length>visibleReleaseLimit?`<button type="button" class="subtle" data-more-releases>Show more sources</button>`:''}</div>`:`<div id="${panelId}" hidden></div>`;
    const poster=enrichment.poster(top.fileName);
    const html=`<article class="result-title-card"><div class="result-title-top"><div class="result-thumb" aria-hidden="true">${poster}<span><svg class="cinema-icon"><use href="#ico-film"/></svg></span></div><div><h3>${escape(title)}</h3><small>${escape(categoryName(kind))} · ${releaseLabel}</small></div><div class="result-title-actions">${primary}<button class="subtle" type="button" data-release-group="${escape(key)}" aria-expanded="${expanded}" aria-controls="${panelId}">${expanded?'Hide options':'Watch options'}</button></div></div>${sourceList}</article>`;
    return {key,signature:html,html:()=>html};
  }));
  patchSourceMemoryRows();
}
async function search(event){
  event.preventDefault();
  watchedUI.setMode('titles');
  await stopSearch();
  const generation=searchGeneration,query=$('#query').value.trim();
  if(!query)return;
  setSearchVisibility(true);
  $('#search-filters').open=false;
  foregroundPlay++;
  notice('');
  discoveryUI.setSearchMode(true);
  searchCategory=$('#search-category').value;
  const plugin=$('#search-source').value,broad=!plugin&&broadSearchCategory(searchCategory);
  void enrichment.searchCatalog(query,searchCategory);
  searchRows=[];searchPage=0;openReleaseGroup=null;searchRunning=true;
  $('#search-results').hidden=false;
  $('#result-pagination').hidden=true;
  renderContinueWatching();
  $('#results-grid').innerHTML=`<div class="search-loading"><span class="spinner"></span> ${broad?'Searching all enabled plugins…':'Searching your selected sources…'}</div>`;
  $('#results-title').textContent=`Results for “${query}”`;
  $('#results-status').textContent='Asking your sources…';
  $('#search-warnings').hidden=true;$('#search-warnings').textContent='';
  $('#search-button').disabled=true;$('#search-button').textContent='Searching…';
  $('#search-results').scrollIntoView({behavior:'instant',block:'start'});
  try{
    const job=await api('/api/search',{query,category:broad?'all':searchCategory,plugin,...(broad?{intentCategory:searchCategory}:{})});
    if(generation!==searchGeneration){api('/api/search/stop',{id:job.id}).catch(()=>{});return;}
    searchId=job.id;
    const found=new Map(),warnings=new Set();
    let offset=0;
    for(let i=0;i<90&&generation===searchGeneration;i++){
      const result=await api('/api/results?id='+encodeURIComponent(job.id)+'&offset='+offset+'&limit=100');
      if(generation!==searchGeneration)return;
      searchRunning=result.status==='Running';
      const hasDelta=Number.isInteger(result.nextOffset);
      if(!hasDelta)found.clear();
      for(const release of result.results||[]){
        const key=release.key||release.fileUrl,prior=found.get(key);
        if(!prior||releaseRank(release)>=releaseRank(prior))found.set(key,release);
      }
      if(hasDelta)offset=result.nextOffset;
      const limited=found.size>maximumSearchReleases,rawLimit=offset>=maximumRawSearchRows;
      const visible=[...found.values()];
      if(limited)visible.sort((a,b)=>releaseRank(b)-releaseRank(a));
      searchRows=visible.slice(0,maximumSearchReleases);
      for(const warning of result.warnings||[])warnings.add(typeof warning==='string'?warning:`${warning.plugin||'Plugin'}: ${warning.message}`);
      const pluginCount=job.pluginCount??(broad?plugins.filter(p=>p.enabled).length:null);
      const coverage=pluginCount?` · ${pluginCount} ${pluginCount===1?'plugin':'plugins'}`:'';
      const progress=searchRunning?'Still searching…':'Search complete';
      const message=`${searchRows.length} ${searchRows.length===1?'release':'releases'}${coverage} · ${rawLimit?'Search limit reached.':progress}${limited?' · Showing up to '+maximumSearchReleases+' releases.':''}`;
      textIfChanged('#results-status',message);
      $('#search-warnings').hidden=!warnings.size;textIfChanged('#search-warnings',[...warnings].slice(0,12).join(' · '));
      if(!hasDelta||result.results?.length||!searchRunning&&!searchRows.length)renderResults();
      if(rawLimit){void stopSearch();break;}
      if(!searchRunning&&!(hasDelta&&result.hasMore))break;
      if(i===89){searchRunning=false;$('#results-status').textContent+=' · Search timed out. Results found so far are kept.';api('/api/search/stop',{id:job.id}).catch(()=>{});break;}
      if(!(hasDelta&&result.hasMore))await new Promise(resolve=>setTimeout(resolve,1400));
    }
  }catch(e){
    if(generation===searchGeneration){notice(e.message);$('#results-status').textContent='Search interrupted. Any results already found are kept.';}
  }finally{
    if(generation===searchGeneration){searchRunning=false;$('#search-button').disabled=false;$('#search-button').textContent='Search →';renderResults();}
  }
}
async function addSource(key,category,allowDuplicate=false,intent=null,{background=false}={}){
  // Rescue uses ordinary search keys. The exact local episode is verified before a switch.
  intent=background?null:(intent||episodeIntents.get(key));
  if(intent)episodeIntents.set(key,intent);
  const entry=additions.get(key),sameEpisode=!intent||intent.episodeId===entry?.intent?.episodeId;
  if(background)playRequests.delete(key);
  else playRequests.set(key,++foregroundPlay);
  if(entry&&['adding','accepted','uncertain','ready'].includes(entry.status)&&(background||!allowDuplicate)&&sameEpisode){
    if(entry.hash&&!background){playRequests.delete(key);await openPlayer(entry.hash,intent);}
    else if(entry.hash)notice('This release is in My Library. Return to the player to check it.');
    return;
  }
  const requestId=(sourceRequests.get(key)||0)+1;
  sourceRequests.set(key,requestId);
  additions.set(key,{status:'adding',intent,name:searchRows.find(row=>row.key===key)?.fileName,requestedAt:Date.now(),message:'Connecting to qBittorrent…'});
  renderResults();
  notice('Connecting this source. You can follow it in Downloads.');
  try{
    const operation=await api('/api/add',{key,category,allowDuplicate,...(intent?{episode:{showId:intent.showId,episodeId:intent.episodeId}}:{})});
    if(sourceRequests.get(key)!==requestId)return;
    if(operation.status==='duplicate'){
      additions.delete(key);
      if(playRequests.get(key)===foregroundPlay){
        duplicateRequest={key,category,intent};
        setHTML('#duplicate-options',(operation.duplicateCandidates||[]).map(t=>`<button class="duplicate-option" data-duplicate-play="${escape(t.hash)}"><span><strong>${escape(t.title)}</strong><small>${percent(t.progress).toFixed(1)}% downloaded</small></span><span>Open →</span></button>`).join(''));
        $('#duplicate-dialog').showModal();
      }
      playRequests.delete(key);renderResults();return;
    }
    additions.set(key,operation);
    if(operation.id){
      awaitingOperations.add(operation.id);
      operations=[...operations.filter(o=>o.id!==operation.id),operation];
    }
    if(operation.hash){
      if(operation.id){handledOperations.add(operation.id);awaitingOperations.delete(operation.id);}
      await refresh();
      if(sourceRequests.get(key)!==requestId)return;
      const foreground=playRequests.get(key)===foregroundPlay;
      playRequests.delete(key);
      if(foreground)await openPlayer(operation.hash,intent||operation.intent);
      else notice('A source is ready in Downloads. Your current watch continues.');
    }else if(operation.status==='failed'){
      playRequests.delete(key);
      notice(operation.message||'This source could not be added.');
    }else{
      notice(operation.message||'Source accepted. Waiting for qBittorrent to supply its files.');
      renderPending();
    }
    renderResults();
  }catch(e){
    if(sourceRequests.get(key)!==requestId)return;
    const definitive=[400,401,403,404,413,422].includes(e.status);
    if(definitive)playRequests.delete(key);
    additions.set(key,{...additions.get(key),status:definitive?'failed':'uncertain',message:definitive?e.message:'Confirmation was interrupted. Check Downloads before adding another release.'});
    notice(e.message+(definitive?'':' Check Downloads: the source may already have been accepted.'));
    await refresh();renderResults();
    if(e.code==='expired-source')return {expired:true};
  }
}
function setPlaybackStatus(message,phase,feedback=active?.failed?'error':'preparing'){
  textIfChanged('#playback-status',message);
  textIfChanged('#dock-status',message);
  if(phase)textIfChanged('#player-phase',phase);
  textIfChanged('#player-phase-detail',message===phase?'':message);
  $('#player-dialog').setAttribute('data-feedback',feedback);
  $('#player-quick-retry').hidden=feedback!=='error';
}
function showOpeningCover(step){
  const cover=$('#player-placeholder');
  cover.setAttribute('data-opening-step',step);
  cover.hidden=false;
  $('#player-opening-play').hidden=true;
  active.openingTarget=null;
}
function revealOpeningCover(video,generation,url,time,reason){
  const cover=$('#player-placeholder');
  if(cover.hidden||!url||generation!==playGeneration||active?.url!==url||active.resumePending||
    active.rescueSeekPending||active.watchedTarget||active.autoplayBlocked&&video.paused||video.seeking||video.error||video.readyState<2||
    !(video.videoWidth>0&&video.videoHeight>0)||!Number.isFinite(time))return false;
  const target=active.openingTarget??active.resumeTarget??0;
  if(Math.abs(time-target)>1.25||reason==='progress'&&(video.paused||!active.hasPlayed||time<target+.25))return false;
  if(cover.contains(document.activeElement))video.focus({preventScroll:true});
  cover.hidden=true;
  $('#player-opening-play').hidden=true;
  if(active.hasPlayed&&!video.paused)setPlaybackStatus('Now playing',null,'playing');
  return true;
}
function armOpeningPicture(video){
  const generation=playGeneration,url=active?.url;
  if(!url||pictureFrame!==null||$('#player-placeholder').hidden||typeof video.requestVideoFrameCallback!=='function')return;
  const handle=video.requestVideoFrameCallback((_now,frame)=>{
    if(pictureFrame===handle)pictureFrame=null;
    if(Number.isSafeInteger(frame?.presentedFrames)&&frame.presentedFrames>0)
      revealOpeningCover(video,generation,url,frame.mediaTime,'frame');
  });
  pictureFrame=handle;
}
function closePlayerPanels(){
  for(const id of ['#sound-map-panel','#scene-sketchbook-panel','#two-track-panel','#subtitle-panel','#scene-panel','#timeline-panel','#warm-switch-panel','#rescue-panel','#player-options','#player-diagnostics'])$(id).open=false;
}
function destroyMedia(){playerAudio.reset();cancelSourceMemory();sceneSketchbook.reset();scenePreview.reset();invalidateSketchbookFrame();watched?.detach();watchedUI?.closePlayer();pendingSeek?.(false);playbackTimeline.reset();enrichment.detachTrack();if(hls){hls.destroy();hls=null;}const video=$('#video');if(pictureFrame!==null)video.cancelVideoFrameCallback?.(pictureFrame);pictureFrame=null;
  if(rescueFrameHandle!==null)video.cancelVideoFrameCallback?.(rescueFrameHandle);rescueFrameHandle=null;
  clearTimeout(rescueLandingTimer);rescueLandingTimer=null;video.pause();video.removeAttribute('src');video.load();schedulePlaybackMap();}
function saveProgress(){
  const video=$('#video');
  if(!active||active.index===null||active.resumePending||!active.hasPlayed||!Number.isFinite(video.currentTime)||video.currentTime<=0)return;
  const duration=active.backendState?.duration||(active.sourceComplete&&Number.isFinite(video.duration)?video.duration:null);
  const record={index:active.index,time:video.currentTime,duration,updated:Date.now(),fileName:active.files.find(file=>file.index===active.index)?.name.split(/[\\/]/).at(-1),finished:active.ended===true||Boolean(active.sourceComplete&&duration>60&&video.currentTime>=duration-10)};
  const episode=verifiedEpisodeForActive();
  if(episode)record.episode=episode;
  const previous=history[active.hash];
  const files={...(previous?.files||(previous?.index!==undefined?{[previous.index]:previous}:{})),[active.index]:record};
  const recent=Object.entries(files).sort((a,b)=>b[1].updated-a[1].updated).slice(0,100);
  history[active.hash]={...record,files:Object.fromEntries(recent)};
  try{localStorage.setItem('cinema-history',JSON.stringify(history));}catch{}
}
function stopPlayback({cancelPending=true,preserveWarm=false}={}){
  if(cancelPending)foregroundPlay++;
  saveProgress();playGeneration++;clearTimeout(watchTimer);active=null;destroyMedia();
  rescueSearch=null;rescueFlow.close();fastStartFlow.clear();$('#rescue-reopen').hidden=true;
  if(!preserveWarm)warmFlow.clear();
  $('#video').controls=!videoControls;
  $('#resume-choice').hidden=true;$('#startup-diagnostic').textContent='';$('#alternate-source').hidden=true;
  $('#player-dock').hidden=true;$('#player-dialog').close();document.body.classList.remove('has-player');
  renderContinueWatching();
}
function minimizePlayer(){cancelSourceMemory();sceneSketchbook.reset();scenePreview.reset();saveProgress();watched?.boundary();watchedUI?.closePlayer();warmFlow.cancelPendingSwitch();$('#rescue-panel').open=false;rescueFlow.close();fastStartFlow.clear();$('#player-dialog').close();if(active){$('#player-dock').hidden=false;document.body.classList.add('has-player');active.releaseObservation?.excludeStart();runwayTracker.reset();schedulePlaybackMap();}}
function openSeries(hash){const item=library.find(t=>t.hash===hash);if(!item)return;const known=enrichment.metadata(item.name);if($('#player-dialog').open){saveProgress();minimizePlayer();}void episodeUI.open(known||{title:clean(item.name).replace(/\b(?:S\d{1,2}(?:E\d{1,3})?|Season\s*\d+|Complete)\b.*$/i,'').trim(),kind:item.kind});}
async function openPlayer(hash,intent=null,indexHint=null,prepared=null,{watchedTarget=null,appointment=null}={}){
  foregroundPlay++;
  const dialog=$('#player-dialog');
  if(!prepared&&!appointment&&active?.hash===hash&&!(active.preparedOnly&&active.failed)&&(!intent||active.intent?.episodeId===intent.episodeId)&&
    (indexHint===null||active.index===indexHint||active.index===null&&active.indexHint===indexHint)){
    if(!dialog.open)dialog.showModal();
    $('#player-dock').hidden=true;
    if(watchedTarget){
      active.watchedTarget=watchedTarget;
      active.userPaused=true;
      active.resumePending=false;
      $('#video').pause();
      renderResumeChoice();
      renderWatchedPlayer();
      $('#watched-jump-title').focus();
    }else if(active.watchedTarget)playFromWatchedHandoff();
    return;
  }
  stopPlayback({cancelPending:false,preserveWarm:Boolean(prepared)});
  closePlayerPanels();
  active={hash,intent,indexHint,index:null,files:[],url:null,resumed:false,openedAt:Date.now(),watchedTarget,appointment,allowStartMemory:!prepared&&!watchedTarget};
  const generation=playGeneration,t=library.find(item=>item.hash===hash);
  const artwork=t&&enrichment.metadata(t.name);
  const art=artwork?.backdropUrl||artwork?.posterUrl;
  const openingArt=$('#player-opening-art');
  openingArt.hidden=true;
  openingArt.removeAttribute('src');
  if(art?.startsWith('/api/metadata/poster?'))openingArt.src=art;
  $('#player-episodes').hidden=!intent&&!['tv','anime','korean'].includes(t?.kind);
  const title=t?.title||'Getting your video ready';
  textIfChanged('#player-title',title);
  $('#player-title').setAttribute('title',title);
  textIfChanged('#dock-title',t?.title||'Your video');
  $('#file-category').value=['movies','tv','anime'].includes(t?.kind)?t.kind:'other';
  $('#file-select').innerHTML='<option>Finding video files…</option>';
  $('#file-select').disabled=true;
  showOpeningCover('files');
  $('#player-progress').value=0;
  $('#player-progress-label').textContent='Finding files';
  $('#playback-mode').textContent='';
  $('#player-transfer').textContent='';
  $('#player-stream-status').textContent='';
  $('#priority-note').textContent='';
  $('#format-hint').textContent='';
  $('#retry-player').disabled=true;
  setPlaybackStatus('You can keep browsing while we get it ready.','Getting your video ready');
  dialog.showModal();
  renderWatchedPlayer();
  if(watchedTarget)$('#watched-jump-title').focus();
  if(prepared){mountPreparedPlayback(prepared,generation);return;}
  await loadPlaybackFiles(generation);
}
function watchedPlayed(video){
  return readTimeRanges(video.played).map(([start,end])=>[start*1000,end*1000]);
}
function watchedSource(){
  const state=active?.backendState,mode=active?.mode;
  if(!active?.url||!active.watchedAttachment||!state?.sessionId||!Number.isInteger(active.index)||
    state.hash!==active.hash||state.index!==active.index||state.url!==active.url||!['direct','hls'].includes(mode))return null;
  const run=mode==='hls'?/\/([a-f0-9]{12})\/index\.m3u8$/.exec(active.url)?.[1]:null;
  if(mode==='hls'&&!run)return null;
  return {hash:active.hash,index:active.index,mode,run,sessionId:state.sessionId,
    attachment:active.watchedAttachment,complete:mode==='hls'?state.complete===true:state.progress>=1};
}
function sketchbookFrame(){
  const video=$('#video'),source=active;
  if(!watched?.getCollection().enabled)
    return {reason:'Turn on Watched Dialogue in Search to keep track of sections you’ve played.'};
  const attachment=watchedSource();
  if(!connected||!attachment?.complete||!source?.hasPlayed||source.failed||source.waiting||source.resumePending||
    source.watchedTarget||source.rescueSeekPending||source.hlsRecovery||video.error||video.ended)
    return {reason:'Stills are available from completed videos after playback.'};
  if(!video.paused||video.seeking||video.readyState<2)
    return {reason:'Pause inside a section you’ve already watched.'};
  const frame=source.sketchbookFrame,time=video.currentTime,width=video.videoWidth,height=video.videoHeight;
  const totalFrames=video.getVideoPlaybackQuality?.().totalVideoFrames;
  if(!frame||frame.generation!==playGeneration||frame.url!==source.url||frame.revision!==(source.sketchbookRevision||0)||
    !Number.isFinite(time)||Math.abs(time-frame.time)>.3||!(width>0&&height>0)||
    !Number.isFinite(totalFrames)||totalFrames<=0)
    return {reason:'The paused picture isn’t ready for a still. Play briefly, then pause again.'};
  const span={startMs:Math.max(0,Math.floor(Math.min(time,frame.time)*1000-100)),
    endMs:Math.ceil(Math.max(time,frame.time)*1000+100)};
  return {attachment:attachment.attachment,frame,time,width,height,totalFrames,span};
}
function invalidateSketchbookFrame(){
  if(!active)return;
  active.sketchbookRevision=(active.sketchbookRevision||0)+1;
  active.sketchbookFrame=null;
}
async function openWatchedTarget(target,signal){
  const navigation=foregroundPlay;
  if(!await watched.authorize(target,{signal})||signal?.aborted||navigation!==foregroundPlay)return false;
  if(target.record.proof.kind==='volatile'&&(!watchedSource()||active.hash!==target.record.hash||active.index!==target.record.index))return false;
  await openPlayer(target.record.hash,null,target.record.index,null,{watchedTarget:target});
  return true;
}
function watchedRecapTarget(){
  if(!active?.url||!Number.isInteger(active.index))return null;
  const resumeTime=active.resumePending?active.resumeTarget:Math.max(Number($('#video').currentTime)||0,
    active.hasPlayed?0:Number(watchRecord(active.hash,active.index)?.time)||0);
  return {hash:active.hash,index:active.index,resumeTime};
}
function watchedJumpReady(target){
  const source=watchedSource(),timeline=target.record.proof.timeline;
  if(!source||source.hash!==target.record.hash||source.index!==target.record.index||
    timeline.mode!==source.mode||timeline.run!==source.run||timeline.offsetMs!==0||!canSeekScene(target.time))return false;
  if(target.kind==='passage')return true;
  const caption=enrichment.watchedCaption();
  return Boolean(caption?.digest&&caption.id===target.record.caption?.id&&
    caption.digest===target.record.caption.digest&&caption.offsetMs===target.record.caption.offsetMs);
}
function renderWatchedPlayer(){
  const target=active?.watchedTarget,video=$('#video');
  $('#watched-jump').hidden=!target;
  $('#player-dialog').classList.toggle('watched-holding-frame',Boolean(target));
  const controls=!videoControls&&!target&&!active?.resumePending;
  if(video.controls!==controls)video.controls=controls;
  $('#watched-player-recap').hidden=Boolean(target)||!watched.canCatchUp(watchedRecapTarget());
  if(!target)return;
  $('#dock-toggle').hidden=true;
  const ready=watchedJumpReady(target),jump=$('#watched-jump-action');
  jump.disabled=!ready||Boolean(active.watchedJumpBusy);
  textIfChanged('#watched-jump-action',target.kind==='passage'?'Play from '+clockTime(target.time):'Jump to '+clockTime(target.time));
  textIfChanged('#watched-jump-status',active.watchedJumpMessage||(ready?'Your watched moment is ready.':
    'Waiting for the matching video and ready playback range.'));
}
function playFromWatchedHandoff(){
  if(!active?.watchedTarget)return;
  active.watchedTarget=null;
  active.watchedJumpBusy=false;
  active.watchedJumpMessage='';
  active.userPaused=false;
  active.resumePending=false;
  $('#dock-toggle').hidden=false;
  renderWatchedPlayer();
  startVideo(playGeneration);
}
async function jumpToWatchedMoment(){
  const player=active,target=player?.watchedTarget,generation=playGeneration;
  if(!target||player.watchedJumpBusy||!watchedJumpReady(target))return;
  player.watchedJumpBusy=true;
  player.watchedJumpMessage='Checking this exact moment…';
  renderWatchedPlayer();
  const caption=target.kind==='passage'?null:enrichment.watchedCaption();
  const verified=await watched.authorize(target,{active:true,caption});
  if(active!==player||generation!==playGeneration||player.watchedTarget!==target)return;
  const moved=verified&&watchedJumpReady(target)&&await seekScene(target.time,caption?.revision);
  if(active!==player||generation!==playGeneration||player.watchedTarget!==target)return;
  player.watchedJumpBusy=false;
  if(moved){player.openingTarget=target.time;playFromWatchedHandoff();}
  else{
    player.watchedJumpMessage=verified?'That moment did not load. You can try Jump again or play the video.': 'This file or caption no longer matches. You can play the video normally.';
    renderWatchedPlayer();
  }
}
$('#watched-jump-action').onclick=jumpToWatchedMoment;
$('#watched-jump-play').onclick=playFromWatchedHandoff;
$('#watched-player-recap').onclick=event=>{
  const target=watchedRecapTarget();
  if(target)void watchedUI.openCatchUp(target,{surface:'player',trigger:event.currentTarget});
};
$('#continue-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-watched-recap]');
  if(!button)return;
  const hash=button.dataset.watchedRecap,index=Number(button.dataset.watchedIndex);
  const record=watchRecord(hash,index);
  if(record)void watchedUI.openCatchUp({hash,index,resumeTime:record.time},{surface:'home',trigger:button});
});

function warmSource(){
  const state=active?.backendState;
  if(!active||!Number.isInteger(active.index)||active.preparedOnly?.fallback||active.failed||active.ended||
    active.sourceComplete||!state||state.hash!==active.hash||state.index!==active.index||!state.sessionId||
    ['idle','error','unsupported'].includes(state.status))return null;
  const video=$('#video'),position=active.hasPlayed&&Number.isFinite(video.currentTime)?video.currentTime:0;
  const url=active.url===state.url?state.url:undefined;
  return {hash:active.hash,index:active.index,sessionId:state.sessionId,generation:playGeneration,url,
    title:$('#player-title').textContent,intent:active.intent,verifiedEpisode:active.verifiedEpisode,
    position,positionVerified:Boolean(url&&position>0&&canSeekScene(position)),
    paused:Boolean(active.userPaused||active.hasPlayed&&video.paused&&!video.ended)};
}
function mountPreparedPlayback({attachment,context},generation){
  const {file,state}=attachment,select=$('#file-select');
  active.index=file.index;
  active.files=[file];
  active.preparedOnly={hash:state.hash,index:state.index,sessionId:state.sessionId,url:state.url,fallback:context.fallback};
  const saved=watchRecord(active.hash,file.index);
  const fileName=file.name.split(/[\\/]/).at(-1);
  const exactSaved=saved?.fileName===fileName&&!saved.finished;
  const target=context.fallback?(exactSaved?Number(saved.time)||0:0):Number(context.position)||0;
  resetPlaybackAttempt(false,target);
  active.userPaused=Boolean(context.paused);
  active.resumeVerified=Boolean(context.positionVerified);
  active.verifiedEpisode=context.verifiedEpisode??null;
  active.rescueOriginal=context.rescueOriginal??null;
  active.rescueSeekPending=Boolean(active.rescueOriginal&&target>0);
  if(active.rescueSeekPending){
    rescueLandingTimer=setTimeout(()=>{
      if(generation===playGeneration&&active?.rescueSeekPending)
        failPreparedPlayback('The replacement could not reach the verified scene. You can reopen the original.');
    },8500);
  }
  select.innerHTML=`<option value="${file.index}">${escape(fileName)} · ${bytes(file.size)}</option>`;
  select.value=file.index;
  select.disabled=true;
  enrichment.fileChanged();
  renderPlayback(state,generation);
  watchTimer=setTimeout(()=>pollPlayback(generation),active.url?2000:500);
}
function failPreparedPlayback(message){
  if(!active?.preparedOnly||active.failed&&!active.url)return;
  active.failed=true;
  active.url=null;
  clearTimeout(watchTimer);
  destroyMedia();
  setPlaybackStatus(message,'Prepared playback unavailable','error');
  $('#retry-player').disabled=true;
  $('#player-quick-retry').hidden=true;
  $('#rescue-reopen').hidden=!active.rescueOriginal;
  warmFlow.refresh();rescueFlow.refresh();
}
function chooseEpisodeFile(message){
  const select=$('#file-select');
  select.insertAdjacentHTML('afterbegin','<option value="">Choose a video…</option>');
  select.value='';
  $('#retry-player').disabled=false;
  setPlaybackStatus(message,'Choose the video for this episode');
  $('#player-progress-label').textContent='Select an episode file';
  $('#player-options').open=true;
  if($('#player-dialog').open)select.focus();
}
async function loadPlaybackFiles(generation){
  if(!active||generation!==playGeneration)return;
  let filesConfirmed=false;
  try{
    const all=await api('/api/files?hash='+encodeURIComponent(active.hash));
    if(generation!==playGeneration)return;
    filesConfirmed=true;
    const files=all.filter(file=>file.playable===undefined?videoExtension.test(file.name):file.playable);
    const item=library.find(torrent=>torrent.hash===active.hash);
    updatePlayerTransfer(item);
    if(active.appointment&&!files.some(file=>file.index===active.indexHint)){
      active.failed=true;
      setPlaybackStatus('Go back and check the appointment again.','The checked file changed','error');
      return;
    }
    if(!files.length){
      if(all.length&&!/meta/i.test(item?.state||'')){
        setPlaybackStatus('Try a different release for this title.','No playable video','error');
        $('#player-progress-label').textContent=`${all.length} ${all.length===1?'file':'files'} · ${all.slice(0,3).map(file=>file.name.split(/[\\/]/).at(-1)).join(', ')}`;
        $('#retry-player').disabled=false;
        $('#alternate-source').hidden=!item;
        return;
      }
      setPlaybackStatus(isPaused(item||{})?'Resume the download to start watching.':'We’ll start when the video is available.','Finding your video');
      $('#alternate-source').hidden=!item||Date.now()-(active.openedAt||Date.now())<12000;
      watchTimer=setTimeout(()=>loadPlaybackFiles(generation),2000);
      return;
    }
    active.files=files;
    $('#file-select').innerHTML=files.map(file=>`<option value="${file.index}">${escape(file.name.split(/[\\/]/).at(-1))} · ${bytes(file.size)}</option>`).join('');
    $('#file-select').disabled=false;
    active.verifiedEpisode=null;
    let selected;
    if(active.intent){
      const target=await api('/api/episodes/file',{hash:active.hash,showId:active.intent.showId,episodeId:active.intent.episodeId});
      if(generation!==playGeneration)return;
      selected=target.verified?files.find(file=>file.index===target.index):null;
      if(!selected||active.indexHint!==null&&selected.index!==active.indexHint){chooseEpisodeFile('Choose the correct episode from the video list.');return;}
      if(target.singleEpisode===true)active.verifiedEpisode={index:selected.index,showId:active.intent.showId,episodeId:active.intent.episodeId};
    }else if(active.indexHint!==null){
      selected=files.find(file=>file.index===active.indexHint);
      if(!selected){chooseEpisodeFile('The saved video file is unavailable. Choose a video from the list.');return;}
    }else selected=firstVideo(files,active.hash);
    $('#file-select').value=selected.index;
    $('#retry-player').disabled=false;
    await selectFile(active.watchedTarget?.record.proof.timeline.mode==='hls',false,active.allowStartMemory);
  }catch(error){
    if(generation!==playGeneration)return;
    if(error.status===404){
      if(!filesConfirmed){playbackRemoved();return;}
      chooseEpisodeFile('The episode could not be verified. Choose it from the video list.');
      return;
    }
    $('#startup-diagnostic').textContent=error.message;
    setPlaybackStatus('We’ll try connecting again in a moment.','Connection interrupted','error');
    $('#retry-player').disabled=false;
    watchTimer=setTimeout(()=>loadPlaybackFiles(generation),4000);
  }
}
function updatePlayerTransfer(t,download){
  const d=download||{};
  if(!t&&!download)return;
  const progress=d.progress??t?.progress??0,speed=d.speed??t?.dlspeed??0;
  const seeds=Number(d.seeds??t?.num_seeds)||0,peers=Number(d.peers??t?.num_leechs)||0;
  const status=progress>=1?'Selected video downloaded':speed>0?'Download ETA: '+eta(d.eta??t?.eta):
    isPaused(d.state?d:t||{})?'Download paused':seeds+peers?'Waiting for more data':'Waiting for peers';
  setHTML('#player-transfer',`<span><b>${percent(progress).toFixed(1)}%</b> selected video</span>${d.totalProgress!==undefined?`<span><b>${percent(d.totalProgress).toFixed(1)}%</b> whole torrent</span>`:''}<span><b>${bytes(speed)}/s</b> incoming</span><span><b>${seeds+peers}</b> connected ${seeds+peers===1?'peer':'peers'}</span><span>${escape(status)}</span>`);
}
function playbackRemoved(){const hash=active?.hash;if(hash){invalidateRemovedHash(hash);library=library.filter(item=>item.hash!==hash);}stopPlayback({cancelPending:false});renderLibrary();renderResults();notice('This torrent was removed from qBittorrent. Choose another title or add the source again.');}
function verifiedEpisodeForActive(){
  if(!active||active.index===null)return null;
  const verified=active.verifiedEpisode;
  if(verified?.index===active.index)return {showId:verified.showId,episodeId:verified.episodeId};
  const prior=watchRecord(active.hash,active.index);
  const name=active.files.find(file=>file.index===active.index)?.name.split(/[\\/]/).at(-1);
  return name&&prior?.fileName===name&&prior.episode?.showId&&prior.episode?.episodeId?prior.episode:null;
}
function sceneContext(){
  if(!active||active.index===null)return null;
  const video=$('#video'),name=active.files.find(file=>file.index===active.index)?.name.split(/[\\/]/).at(-1);
  const item=library.find(torrent=>torrent.hash===active.hash);
  const metadata=name&&enrichment.metadata(name)||item&&enrichment.metadata(item.name);
  return {
    fileKey:`${active.hash}:${active.index}`,generation:playGeneration,track:enrichment.sceneTrackIdentity?.(),
    identity:portableSceneIdentity({episode:verifiedEpisodeForActive(),fileLabel:name?clean(name):'',metadata}),
    releaseLabel:name,catalog:metadata,time:video.currentTime,canPin:Boolean(active.hasPlayed&&active.url&&video.readyState>=2&&!video.error&&!active.resumePending),
    cues:()=>enrichment.sceneCues?.()||[],
  };
}
function canonicalMovieProvider(metadata){
  return [metadata?.metadataId,metadata?.id].find(id=>/^(?:wikipedia-\d{1,12}|justwatch-[a-f\d]{20})$/.test(id||''));
}
function atlasContext(){
  const scene=sceneContext();
  if(!scene)return null;
  const video=$('#video'),state=active.backendState;
  const providerId=canonicalMovieProvider(scene.catalog);
  const identity=scene.identity?.startsWith('episode:')?scene.identity:
    scene.identity&&providerId?scene.identity+':'+providerId:null;
  const subtitles=enrichment.sceneEditionTrack();
  const decoded=active.presentedGeneration===playGeneration||
    (video.getVideoPlaybackQuality?.().totalVideoFrames||0)>0;
  const canCapture=Boolean(identity&&subtitles&&decoded&&scene.canPin&&!active.failed&&state?.sessionId&&
    state.hash===active.hash&&state.index===active.index&&state.url===active.url);
  const duration=Number.isFinite(state?.duration)&&state.duration>0?state.duration:video.duration;
  return {identity,fileKey:scene.fileKey,label:scene.releaseLabel,duration,
    generation:scene.generation,sessionId:state?.sessionId,hasTrack:Boolean(subtitles),canCapture,...subtitles};
}
function rescueSource(){
  const state=active?.backendState;
  if(!active||active.ended||!state?.sessionId||state.hash!==active.hash||state.index!==active.index)return null;
  const scene=sceneContext(),file=active.files.find(item=>item.index===active.index);
  if(!scene?.identity||!file?.name||!Number.isSafeInteger(file.size)||file.size<=0)return null;
  const video=$('#video'),episode=scene.identity.startsWith('episode:')?verifiedEpisodeForActive():null;
  const provider=episode?null:canonicalMovieProvider(scene.catalog);
  const movie=episode?null:{title:scene.catalog.title,year:Number(scene.catalog.year)};
  const track=enrichment.sceneEditionTrack?.();
  const releaseTitle=clean(scene.releaseLabel).replace(/\s+(?:S\d{1,3}E\d{1,4}|\d{1,3}x\d{1,4})\b.*$/i,'');
  return {hash:active.hash,index:active.index,sessionId:state.sessionId,name:file.name,size:file.size,
    url:active.url||undefined,identity:provider?scene.identity+':'+provider:scene.identity,story:scene.identity,
    fileKey:scene.fileKey,generation:playGeneration,seekEpoch:active.rescueSeekEpoch||0,track:scene.track,
    title:movie?.title||active.intent?.showTitle||scene.catalog?.title||releaseTitle,
    movie,episode,intent:active.intent,duration:Number.isFinite(state.duration)?state.duration:video.duration,
    time:active.rescueFrame?.time??null,paused:Boolean(active.userPaused||active.hasPlayed&&video.paused&&!video.ended),
    cues:track?.cues||[],offset:track?.offset||0,originalTimes:track?.originalTimes};
}
function fastStartSource(){
  const state=active?.backendState,video=$('#video');
  if(!active||!connected||!$('#player-dialog').open||document.hidden||active.preparedOnly||
    active.presentedGeneration===playGeneration||active.resumeTarget>0||active.resumePending||
    active.userPaused||active.autoplayBlocked||active.failed||active.rescueSeekEpoch||
    video.error||typeof video.requestVideoFrameCallback!=='function'||
    !['buffering','converting','queued','ready'].includes(state?.status))return null;
  const source=rescueSource();
  if(!source)return null;
  const titleKey=rescueTitleKey(source.title);
  return library.some(item=>likelyRescueRelease(item,source,titleKey))?source:null;
}
const rescueTitleKey=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function likelyRescueRelease(item,source,titleKey){
  if(item.hash===source.hash||isError(item)||!titleKey)return false;
  const label=rescueTitleKey(item.name);
  return label===titleKey||label.startsWith(titleKey+' ');
}
function rescueMovieMatch(name,source){
  if(!source.movie)return false;
  const label=name.split(/[\\/]/).at(-1),metadata={kind:'movies',...source.movie};
  if(portableSceneIdentity({fileLabel:clean(label),metadata})!==source.story)return false;
  const provider=canonicalMovieProvider(enrichment.metadata(label));
  return !provider||source.identity===source.story||source.identity===source.story+':'+provider;
}
function validateRescueCandidate(target,source,{checkSubtitles=true}={}){
  if(!source||target.hash===source.hash||target.identity!==source.identity||
    !library.some(item=>item.hash===target.hash))return false;
  if(checkSubtitles){
    const saved=enrichment.savedRescueSubtitle?.(target.hash,target.index);
    if(saved?.id!==target.subtitle?.id||saved?.offset!==target.subtitle?.offset)return false;
  }
  return source.episode?target.episode?.episodeId===source.episode.episodeId&&
    target.episode?.showId===source.episode.showId:rescueMovieMatch(target.name,source);
}
async function listRescueCandidates(source,signal){
  const titleKey=rescueTitleKey(source.title);
  const likely=library.filter(item=>likelyRescueRelease(item,source,titleKey))
    .sort((a,b)=>(b.progress||0)-(a.progress||0)).slice(0,8);
  const checked=await Promise.allSettled(likely.map(async item=>{
    let files,intent;
    if(source.episode){
      const match=await api('/api/episodes/file',{hash:item.hash,...source.episode},false,signal);
      if(!match.verified||!match.singleEpisode||!Number.isInteger(match.index))return [];
      files=(match.candidates||[]).filter(file=>file.index===match.index);
      intent=match.intent;
      if(!files.length)files=(await api('/api/files?hash='+encodeURIComponent(item.hash),undefined,false,signal))
        .filter(file=>file.index===match.index);
    }else files=(await api('/api/files?hash='+encodeURIComponent(item.hash),undefined,false,signal))
      .filter(file=>file.playable&&rescueMovieMatch(file.name,source));
    return files.filter(file=>typeof file.name==='string'&&Number.isInteger(file.index)&&
      Number.isSafeInteger(file.size)&&file.size>0).map(file=>({
      hash:item.hash,index:file.index,name:file.name,size:file.size,progress:file.progress,
      label:file.name.split(/[\\/]/).at(-1),identity:source.identity,episode:source.episode,intent,
      subtitle:enrichment.savedRescueSubtitle?.(item.hash,file.index),
    }));
  }));
  const ready=checked.flatMap(result=>result.status==='fulfilled'?result.value:[]);
  if(!ready.length&&checked.length&&checked.every(result=>result.status==='rejected'))throw checked[0].reason;
  return ready;
}
function mapForActive(){
  const state=active?.backendState||{},video=$('#video'),url=active?.url;
  const blocked=Boolean(!url||!active.resumed||active.resumePending||active.failed||active.hlsRecovery||video.error||video.readyState<1);
  const audioEnd=playerAudio.limit();
  const withinAudio=ranges=>Number.isFinite(audioEnd)?ranges?.map(([start,end])=>[start,Math.min(end,audioEnd)]):ranges;
  const published=Number.isFinite(audioEnd)?Math.min(state.availableDuration||0,audioEnd):state.availableDuration;
  return {...playbackMap({mode:active?.mode||state.mode,duration:state.duration,mediaDuration:url?video.duration:undefined,
    complete:active?.sourceComplete,manifest:url?withinAudio(active.manifestRanges):[],publishedDuration:published,
    buffered:url?withinAudio(readTimeRanges(video.buffered)):[],seekable:url?withinAudio(readTimeRanges(video.seekable)):[]}),
    position:url&&Number.isFinite(video.currentTime)?video.currentTime:0,blocked};
}
function canSeekScene(time){
  const map=mapForActive();
  return !map.blocked&&readyToSeek(map,time);
}
function scenePreviewContext(){
  const state=active?.backendState;
  if(document.hidden||!connected||!$('#player-dialog').open||!active?.url||!active.watchedAttachment||active.preparedOnly||
    active.sourceComplete||active.failed||active.resumePending||active.presentedGeneration!==playGeneration||
    state?.status!=='ready'||!state.sessionId||state.hash!==active.hash||state.index!==active.index||
    !/[.](mp4|m4v)$/i.test(state.fileName||''))return null;
  return {key:active.watchedAttachment,hash:active.hash,index:active.index,sessionId:state.sessionId,duration:state.duration};
}
function seekScene(time,track){
  const generation=playGeneration,url=active?.url,video=$('#video');
  const current=()=>generation===playGeneration&&url===active?.url&&(track===undefined||track===enrichment.sceneTrackIdentity?.());
  if(!current()||!canSeekScene(time))return Promise.resolve(false);
  pendingSeek?.(false);
  if(!video.seeking&&Math.abs(video.currentTime-time)<.1)return Promise.resolve(true);
  return new Promise(resolve=>{
    function finish(moved){
      clearTimeout(timer);
      video.removeEventListener('seeked',onSeeked);
      video.removeEventListener('error',onError);
      if(pendingSeek===finish)pendingSeek=null;
      schedulePlaybackMap();
      resolve(moved);
    }
    function onSeeked(){finish(current()&&Math.abs(video.currentTime-time)<.75);}
    function onError(){finish(false);}
    const timer=setTimeout(()=>finish(false),4500);
    pendingSeek=finish;
    video.addEventListener('seeked',onSeeked,{once:true});
    video.addEventListener('error',onError,{once:true});
    try{video.currentTime=time;}catch{finish(false);}
  });
}
function renderPlaybackInsights(map){
  if(active?.index==null){
    runwayTracker.reset();
    insightState='';
    playbackInsights.update({runway:null,passport:null});
    return;
  }
  const video=$('#video'),state=active.backendState,now=performance.now();
  const exact=state?.hash===active.hash&&state?.index===active.index;
  const file=active.files.find(entry=>entry.index===active.index);
  const complete=Boolean(active.url&&active.sourceComplete);
  const phase=active.failed||video.error?'blocked':active.resumePending||video.seeking?'checking':active.hlsRecovery?'waiting':
    !active.url?'preparing':active.ended||video.ended&&complete?'ended':
    active.hasPlayed&&!video.paused&&(active.waiting||video.readyState<3)?'waiting':
    video.paused?'paused':active.hasPlayed?'playing':'preparing';
  const visible=!document.hidden&&$('#player-dialog').open;
  const key=playGeneration+':'+(active.url||'');
  const signature=JSON.stringify([key,phase,video.playbackRate,visible,complete]);
  if(signature===insightState&&now-insightAt<500)return;
  insightAt=now;insightState=signature;
  const runway=runwayTracker.observe({
    now,key,mode:active.url?active.mode:null,complete,position:map.position,playbackRate:video.playbackRate,phase,
    buffered:active.url?readTimeRanges(video.buffered):[],manifest:active.url?active.manifestRanges:[],
    duration:map.duration,visible,
  });
  const observations=active.releaseObservation?.snapshot(now);
  const passport=file?{
    fileName:file.name.split(/[\\/]/).at(-1),mode:active.url?active.mode:null,duration:exact?map.duration:null,
    probe:exact?state.probeFacts??null:null,...observations,
  }:null;
  playbackInsights.update({runway,passport});
}
function observePresentedPicture(video,generation,url){
  const attempt=active?.releaseObservation;
  if(!attempt||typeof video.requestVideoFrameCallback!=='function')return;
  const handle=video.requestVideoFrameCallback((now,frame)=>{
    if(pictureFrame===handle)pictureFrame=null;
    if(generation!==playGeneration||active?.url!==url||active.releaseObservation!==attempt)return;
    if(Number.isSafeInteger(frame?.presentedFrames)&&frame.presentedFrames>0)
      revealOpeningCover(video,generation,url,frame.mediaTime,'frame');
    if(active.resumePending||active.autoplayBlocked||video.paused||document.hidden)attempt.excludeStart();
    active.presentedGeneration=generation;
    sourceMemoryFrame(video,generation,url,now,frame);
    if(video.videoWidth>0&&video.videoHeight>0&&!video.seeking&&!document.hidden&&$('#player-dialog').open)
      fastStartFlow.primaryFrame();
    else fastStartFlow.refresh();
    if(Number.isFinite(frame?.mediaTime)&&!video.seeking)
      active.rescueFrame={time:frame.mediaTime};
    attempt.frame(Number.isFinite(frame?.presentationTime)?frame.presentationTime:now,video.videoWidth,video.videoHeight);
    insightAt=-Infinity;
    schedulePlaybackMap();
  });
  pictureFrame=handle;
}
function observeRescueFrame(){
  const video=$('#video'),source=active;
  if(!source?.url||!source.hasPlayed||rescueFrameHandle!==null||typeof video.requestVideoFrameCallback!=='function')return;
  const generation=playGeneration,url=source.url,epoch=source.rescueSeekEpoch||0;
  const revision=source.sketchbookRevision||0;
  rescueFrameHandle=video.requestVideoFrameCallback((_now,frame)=>{
    rescueFrameHandle=null;
    if(source!==active||generation!==playGeneration||url!==source.url||epoch!==(source.rescueSeekEpoch||0)||
      !Number.isFinite(frame?.mediaTime))return;
    if(revision===(source.sketchbookRevision||0)&&$('#player-dialog').open&&!document.hidden&&
      video.videoWidth>0&&video.videoHeight>0&&Number.isSafeInteger(frame.presentedFrames)&&frame.presentedFrames>0){
      // WebView2 may present the new frame before seeked. The save check still waits for a settled position.
      source.sketchbookFrame={time:frame.mediaTime,presented:frame.presentedFrames,generation,url,revision};
      if(video.paused)sceneSketchbook.refresh();
    }
    if(video.seeking)return;
    source.rescueFrame={time:frame.mediaTime};
    if(watched?.getCollection().enabled){
      const eligible=$('#player-dialog').open&&!document.hidden&&!video.paused&&!video.seeking&&!video.ended&&
        !source.waiting&&!source.resumePending&&!source.watchedTarget&&!source.rescueSeekPending&&video.readyState>=2;
      watched.observe({wallMs:Number.isFinite(frame.presentationTime)?frame.presentationTime:_now,
        mediaMs:frame.mediaTime*1000,rate:video.playbackRate,played:eligible?watchedPlayed(video):[],
        caption:eligible?enrichment.watchedCaption():null,eligible});
    }
    schedulePlaybackMap();
  });
}
function requestSketchbookFrame(replace=false){
  const video=$('#video');
  if(document.hidden||!$('#player-dialog').open||!$('#scene-panel').open||!$('#scene-sketchbook-panel').open||
    !watched.getCollection().enabled||!replace&&!sketchbookFrame().reason)return;
  if(replace&&rescueFrameHandle!==null){
    video.cancelVideoFrameCallback?.(rescueFrameHandle);
    rescueFrameHandle=null;
  }
  observeRescueFrame();
}
function completeRescueLanding(){
  if(!active?.rescueSeekPending)return;
  const video=$('#video');
  if(video.seeking||video.readyState<2||Math.abs(video.currentTime-active.resumeTarget)>=.75)return;
  active.rescueSeekPending=false;clearTimeout(rescueLandingTimer);rescueLandingTimer=null;
  if(active.userPaused)revealOpeningCover(video,playGeneration,active.url,video.currentTime,'landing');
  if(active.userPaused)setPlaybackStatus('Paused at your scene.','Ready to watch','paused');
  else startVideo(playGeneration);
}
function schedulePlaybackMap(){
  if(mapFrame)return;
  mapFrame=requestAnimationFrame(()=>{
    mapFrame=0;
    const map=mapForActive(),marks=sceneRelay.refresh(time=>!map.blocked&&readyToSeek(map,time));
    const previewSource=scenePreviewContext();
    scenePreview.refresh(previewSource);
    playbackTimeline.update({...map,marks,attachmentKey:scenePreview.attachmentKey(previewSource)});renderWatchedPlayer();
    videoControls?.update();
    renderPlaybackInsights(map);
    editionAtlas.refresh(time=>!map.blocked&&readyToSeek(map,time));
    rescueFlow.refresh();
    const arrival=$('#scene-arrival');
    $('#dock-scene').hidden=arrival.hidden||arrival.querySelector('.scene-arrival-jump').hidden;
    const signature=JSON.stringify([playGeneration,map.blocked,map.ready,previewSource?.key,previewSource?.sessionId,previewSource?.duration]);
    if(signature!==sceneAvailability){
      sceneAvailability=signature;enrichment.refreshScenes?.();soundMap?.refresh();twoTrackStudio?.refresh();sceneSketchbook.refresh();
    }
  });
}
function rangeContains(ranges,time){for(let index=0;index<(ranges?.length||0);index++)if(ranges.start(index)<=time&&ranges.end(index)>time+.2)return true;return false;}
function resumeAvailable(){if(!active)return false;const state=active.backendState||{},target=active.resumeTarget||0;if(active.resumeVerified||state.mode==='hls'&&state.complete||state.mode!=='hls'&&state.progress>=1)return true;return (state.mode==='hls'&&(active.manifestRanges||[]).some(([start,end])=>start<=target&&end>target+.2))||rangeContains($('#video').buffered,target);}
function renderResumeChoice(){
  schedulePlaybackMap();
  const shown=Boolean(active?.resumePending);
  $('#resume-choice').hidden=!shown;
  $('#video').controls=!videoControls&&!shown&&!active?.watchedTarget;
  if(!shown)return;
  active.releaseObservation?.excludeStart();
  const ready=resumeAvailable(),time=clockTime(active.resumeTarget);
  const message=ready?'Your saved position is ready.':`Getting ${time} ready. You can start over in the meantime.`;
  textIfChanged('#resume-message',message);
  textIfChanged('#resume-saved','Resume at '+time);
  $('#resume-saved').disabled=!ready;
  $('#dock-toggle').hidden=true;
  setPlaybackStatus(message,'Choose where to start');
}
function startVideo(generation){
  if(!active||generation!==playGeneration||active.resumePending||active.userPaused||active.rescueSeekPending)return;
  const url=active.url;
  $('#video').play().catch(error=>{
    if(generation!==playGeneration||active?.url!==url||error.name==='AbortError')return;
    active.autoplayBlocked=true;cancelSourceMemory();fastStartFlow.refresh();active.releaseObservation?.excludeStart();
    setPlaybackStatus('Your video is ready. Press play to begin.','Ready to watch');
    $('#player-opening-play').hidden=$('#player-placeholder').hidden;
  });
}
function chooseResume(beginning=false){if(!active?.resumePending||!beginning&&!resumeAvailable())return;const target=beginning?0:active.resumeTarget;active.resumePending=false;active.resumeTarget=target;active.resumed=true;active.userPaused=false;active.autoplayBlocked=false;renderResumeChoice();if(hls)hls.startLoad(target);try{$('#video').currentTime=target;}catch{}startVideo(playGeneration);}
function resetPlaybackAttempt(forceTranscode,resumeTarget){
  Object.assign(active,{resumed:false,hasPlayed:false,userPaused:false,waiting:false,ended:false,forceTranscode,failed:false,autoplayBlocked:false,resumePending:false,resumeVerified:false,manifestRanges:[],backendState:null,prepareStarted:Date.now(),lastVideoTime:0,hlsRecovery:null,hlsAttempts:0,hlsRecoveredAt:null,resumeTarget:Math.max(0,resumeTarget)});
  active.rescueFrame=null;active.rescueSeekEpoch=0;active.rescueSeekPending=false;
  active.releaseObservation=createReleaseObservation(performance.now());
}
async function selectFile(forceTranscode=false,retry=false,observeStart=false){
  if(!active?.files.length||active.preparedOnly||$('#file-select').value==='')return;
  warmFlow.clear();rescueFlow.close();fastStartFlow.clear();
  if(!retry)active.networkRetried=false;
  const hadMedia=Boolean(active.url||active.hasPlayed);
  active.allowStartMemory=false;
  saveProgress();clearTimeout(watchTimer);
  const generation=++playGeneration;
  active.url=null;destroyMedia();active.index=Number($('#file-select').value);enrichment.fileChanged();
  const saved=watchRecord(active.hash,active.index);
  const held=Boolean(active.watchedTarget);
  resetPlaybackAttempt(forceTranscode,held||saved?.finished?0:Number(saved?.time)||0);
  if(held)active.userPaused=true;
  renderWatchedPlayer();
  renderResumeChoice();$('#startup-diagnostic').textContent='';if(!retry||!$('#player-placeholder').hidden)showOpeningCover('prepare');$('#retry-player').disabled=true;setPlaybackStatus('You can keep browsing while we get it ready.','Getting your video ready');
  const memoryStart=active.sourceMemoryStart=makeSourceMemoryStart(generation,observeStart&&!hadMedia&&!retry&&!forceTranscode);
  try{
    const state=await api('/api/prepare',{hash:active.hash,index:active.index,forceTranscode,retry,
      ...(memoryStart?{rememberStart:true}:{}),...(active.appointment?{appointment:active.appointment}:{})});
    if(generation!==playGeneration)return;
    bindSourceMemoryStart(memoryStart,state);
    if(state.status)renderPlayback(state,generation);
    await pollPlayback(generation);
  }
  catch(e){
    if(generation!==playGeneration)return;
    cancelSourceMemory();
    if(e.code==='appointment-file-changed'){
      active.failed=true;
      setPlaybackStatus('Go back and check the appointment again.','The checked file changed','error');
      return;
    }
    if(e.status===404){if(/No playable video at this file index/i.test(e.message)){setPlaybackStatus('Choose another video in Options.','This video is unavailable','error');$('#player-options').open=true;if($('#player-dialog').open)$('#file-select').focus();return;}playbackRemoved();return;}
    const definitive=[400,401,403,413,422].includes(e.status);textIfChanged('#player-stream-status',e.message);
    setPlaybackStatus(definitive?'Try again or choose a different release.':'Preparation may still be running. We’ll check again in a moment.',definitive?'Playback needs attention':'Getting your video ready',definitive?'error':'preparing');
    if(!definitive)watchTimer=setTimeout(()=>pollPlayback(generation),1500);
  }
  finally{if(generation===playGeneration)$('#retry-player').disabled=false;}
}
async function reconnectPlayback({resumePosition=null,automatic=false}={}){
  if(!active)return;const video=$('#video'),time=Number(video.currentTime)||0;saveProgress();if(active.hasPlayed&&time>0){active.resumeTarget=time;active.resumeVerified=true;}
  fastStartFlow.clear();
  if(resumePosition!==null){active.resumeTarget=resumePosition;active.resumeVerified=true;}
  if(!automatic){
    active.hlsAttempts=0;active.hlsRecovery=null;
    active.releaseObservation?.excludeStart();
    active.releaseObservation?.settle(performance.now());
  }
  const generation=++playGeneration;clearTimeout(watchTimer);active.url=null;destroyMedia();enrichment.fileChanged();active.resumed=false;active.failed=false;active.waiting=false;active.autoplayBlocked=false;active.manifestRanges=[];setPlaybackStatus('Reconnecting…','Reconnecting playback');await pollPlayback(generation);
}
function recoverGrowingStream(){
  if(!active||active.mode!=='hls'||active.hlsRecovery)return;
  if(active.rescueOriginal){failPreparedPlayback('The replacement could not keep playing. You can reopen the original.');return;}
  if(active.preparedOnly?.fallback){
    failPreparedPlayback('This saved video could not play. You can return to the original title.');
    return;
  }
  if((active.hlsAttempts||0)>=2){
    active.failed=true;
    setPlaybackStatus('Playback stopped. Try again to pick up where you left off.','Playback interrupted');
    $('#retry-player').disabled=false;
    return;
  }
  const video=$('#video');
  const position=Number(video.currentTime)||active.lastVideoTime||active.resumeTarget||0;
  active.hlsRecovery={position,queuedAt:Date.now()};
  runwayTracker.reset();schedulePlaybackMap();
  active.waiting=true;
  setPlaybackStatus('Waiting for enough prepared video to continue…','Waiting for more video');
  maybeRecoverGrowingStream(active.backendState||{});
}
function maybeRecoverGrowingStream(state){
  const recovery=active?.hlsRecovery;
  if(!recovery||recovery.scheduled)return;
  const prepared=Number(state.availableDuration)||0;
  if(!state.complete&&prepared<recovery.position+1.5)return;
  recovery.scheduled=true;
  const generation=playGeneration;
  queueMicrotask(()=>{
    if(!active||generation!==playGeneration||active.hlsRecovery!==recovery)return;
    active.hlsRecovery=null;active.hlsAttempts=(active.hlsAttempts||0)+1;
    active.hlsRecoveredAt=recovery.position;
    // Rebuild the media buffer from just before the stalled boundary so the
    // segment spanning that position can be downloaded and decoded again.
    void reconnectPlayback({resumePosition:Math.max(0,recovery.position-.75),automatic:true});
  });
}
function retryPlayback(){if(!active)return;active.allowStartMemory=false;cancelSourceMemory();if(active.preparedOnly){if(!active.failed)void reconnectPlayback();return;}if(!active.files.length){void loadPlaybackFiles(playGeneration);return;}if(active.index===null){setPlaybackStatus('Select a video in Options.','Choose your video');$('#player-options').open=true;if($('#player-dialog').open)$('#file-select').focus();return;}if(['error','unsupported'].includes(active.backendState?.status)){void selectFile(active.forceTranscode,true);return;}if(active.url){active.networkRetried=false;void reconnectPlayback();return;}clearTimeout(watchTimer);void pollPlayback(playGeneration);}
function loadHls(){
  if(window.Hls)return Promise.resolve(window.Hls);
  if(!hlsLoading){
    hlsLoading=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/vendor/hls.js';
      script.onload=()=>window.Hls?resolve(window.Hls):reject(Error('Playback engine was unavailable.'));
      script.onerror=()=>{script.remove();reject(Error('Playback engine could not load.'));};
      document.head.append(script);
    }).catch(error=>{hlsLoading=null;throw error;});
  }
  return hlsLoading;
}
function attachPlayback(state,generation){
  if(!active||generation!==playGeneration||!state.url||active.url===state.url)return;playerAudio.reset();scenePreview.reset();active.url=state.url;active.mode=state.mode;active.watchedAttachment=crypto.randomUUID();sceneSketchbook.reset();invalidateSketchbookFrame();const video=$('#video');
  if(!active.rescueOriginal&&state.duration&&active.resumeTarget>=state.duration-10)active.resumeTarget=0;
  // A full advertised duration is not evidence that distant torrent pieces exist.
  const incomplete=state.mode==='hls'?!state.complete:state.progress<1,available=state.mode==='hls'&&Number(state.availableDuration)>active.resumeTarget+4;
  active.resumePending=Boolean(active.resumeTarget>0&&incomplete&&!active.resumeVerified&&!available&&!resumeAvailable());const startPosition=active.resumePending?0:active.resumeTarget||0;renderResumeChoice();
  if(state.mode!=='hls'){
    video.src=state.url;video.load();observePresentedPicture(video,generation,state.url);startVideo(generation);return;
  }
  function unavailable(){
    if(!active||generation!==playGeneration)return;
    if(active.preparedOnly){failPreparedPlayback('This prepared video could not play. You can reopen it from My Library.');return;}
    active.failed=true;
    setPlaybackStatus('Try again to open the video.','Player unavailable');
    $('#retry-player').disabled=false;
  }
  function attachHls(Hls){
    if(!active||generation!==playGeneration||active.url!==state.url)return;
    if(!Hls?.isSupported()){
      if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=state.url;video.load();observePresentedPicture(video,generation,state.url);startVideo(generation);}
      else unavailable();
      return;
    }
    if(hls)hls.destroy();
    const player=hls=new Hls({enableWorker:true,startPosition,backBufferLength:90,maxBufferLength:45,liveSyncMode:'buffered'});let retries=0;
    const offer=playerAudioOffer(state.url,state.audio);
    if(offer)playerAudio.bind(player,Hls.Events,state.url,offer,()=>generation===playGeneration&&hls===player&&active?.url===state.url);
    player.on(Hls.Events.MANIFEST_PARSED,()=>{if(generation===playGeneration&&hls===player)startVideo(generation);});
    player.on(Hls.Events.LEVEL_LOADED,(_event,data)=>{if(generation!==playGeneration||hls!==player)return;active.manifestRanges=(data.details?.fragments||[]).map(fragment=>[fragment.start,fragment.start+fragment.duration]);renderResumeChoice();});
    player.on(Hls.Events.ERROR,(_event,data)=>{
      if(generation!==playGeneration||hls!==player)return;
      if(playerAudio.handleError(data))return;
      if(!data.fatal){
        const attempt=active?.sourceMemoryStart;
        // HLS can jump a tiny leading timestamp gap before its first frame. The engine
        // announces that jump synchronously, before the queued media seeking event.
        if(data.details===Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE&&attempt?.sessionId&&
          !attempt.usedInitialAlignment&&!active.hasPlayed&&!Number.isFinite(attempt.frameSeenAt)&&
          !Number.isFinite(attempt.initialAlignmentTime)&&video.seeking&&video.buffered.length&&
          isOpeningBufferAlignment(video.currentTime,video.buffered.start(0),player.config.skipBufferHolePadding))
          attempt.initialAlignmentTime=video.currentTime;
        return;
      }
      cancelSourceMemory();
      if(data.type===Hls.ErrorTypes.NETWORK_ERROR&&retries++<3){
        active.waiting=true;
        setPlaybackStatus('Reconnecting…','Waiting for more video');
        setTimeout(()=>{if(generation===playGeneration&&hls===player)player.startLoad();},2000);
      }else recoverGrowingStream();
    });
    if(Hls.Events.BUFFER_APPENDED)player.on(Hls.Events.BUFFER_APPENDED,()=>{
      if(generation===playGeneration&&hls===player)schedulePlaybackMap();
    });
    player.loadSource(offer?.url||state.url);player.attachMedia(video);
    observePresentedPicture(video,generation,state.url);
  }
  if(window.Hls)attachHls(window.Hls);
  else{
    setPlaybackStatus('Just a moment…','Starting playback');
    void loadHls().then(attachHls).catch(()=>attachHls(null));
  }
}
function renderPlayback(state,generation){
  if(!active||generation!==playGeneration)return;
  const failed=['error','unsupported'].includes(state.status);
  if(failed)active.hlsRecovery=null;
  if(active.sourceMemoryStart?.sessionId&&active.sourceMemoryStart.sessionId!==state.sessionId)cancelSourceMemory();
  playerAudio.refresh(state.url,state.audio);
  active.backendState=state;active.sourceComplete=state.mode==='hls'?state.complete===true:state.progress>=1||state.complete===true;const t=library.find(t=>t.hash===active.hash);updatePlayerTransfer(t,state.download);$('#priority-note').textContent=state.priorityNote||'';
  schedulePlaybackMap();
  textIfChanged('#player-stream-status',state.message);
  const speed=state.download?.speed??t?.dlspeed;
  const connectedPeers=(Number(state.download?.seeds??t?.num_seeds)||0)+(Number(state.download?.peers??t?.num_leechs)||0);
  const delayed=Number(state.startup?.elapsedSeconds)>=12||Number(state.startup?.waiting?.waitSeconds)>=12;
  const noPeers=state.status==='buffering'&&delayed&&speed===0&&connectedPeers===0&&!isPaused(t||{})&&!isError(t||{});
  const opening=!$('#player-placeholder').hidden;
  if(opening)$('#player-placeholder').setAttribute('data-opening-step',state.status==='ready'?'picture':state.status==='metadata'?'files':'prepare');
  const openingPhase={opening:'Getting the opening ready',index:'Getting the video index',inspecting:'Checking the video format',segments:'Preparing the opening'}[state.stage];
  const phase=active.rescueSeekPending?'Finding your scene':noPeers?'Waiting for more video':active.autoplayBlocked?'Ready to watch':
    {metadata:'Finding your video',buffering:openingPhase||'Getting your video ready',ready:opening?'Starting the picture':'Ready to watch',converting:'Preparing the opening',queued:'Getting your video ready',error:'Playback interrupted',unsupported:'No playable video'}[state.status]||'Getting your video ready';
  const video=$('#video'),playing=!opening&&active.url&&!video.paused&&!video.ended&&!active.failed&&video.readyState>=3;
  const message=active.resumePending?$('#resume-message').textContent:
    failed?'Try again or choose a different release.':
    active.hlsRecovery?'Waiting for enough prepared video to continue…':
    active.autoplayBlocked?'Press play to start watching.':
    active.ended?'Finished watching':active.userPaused?'Paused':playing?'Now playing':
    active.waiting&&!opening?'Waiting for more video…':
    noPeers?'We’ll start when more of the video is available.':state.status==='ready'?(opening?'Starting the picture':'Ready to watch'):
    'You can keep browsing while we get it ready.';
  if(!active.failed)setPlaybackStatus(message,phase,failed?'error':playing?'playing':active.userPaused?'paused':'preparing');
  $('#alternate-source').hidden=Boolean(playing||active.ended||!t||fastStartSource()||(!delayed&&!active.waiting&&!['error','unsupported'].includes(state.status)));
  textIfChanged('#alternate-source',rescueSource()?'Check a replacement':'Find another source');
  if(state.mode==='hls'&&!state.url&&!window.Hls)void loadHls().catch(()=>{});
  const converting=state.mode==='hls'&&state.conversionProgress!==undefined;
  const value=(converting?state.conversionProgress:state.bufferProgress)??state.progress??t?.progress??0;
  $('#player-progress').value=state.complete?100:percent(value);
  $('#player-progress-label').textContent=state.stage==='index'?`Video index · ${percent(state.headerProgress).toFixed(0)}%`:state.stage==='inspecting'?'Opening buffer ready · checking format':converting?`Playback preparation · ${percent(value).toFixed(0)}%`:state.bufferProgress!==undefined?`Starting buffer · ${percent(value).toFixed(0)}%`:`Selected file · ${percent(value).toFixed(1)}% downloaded`;
  $('#playback-mode').textContent=state.mode==='hls'?'STREAMING PLAYBACK':state.mode==='direct'?'DIRECT PLAYBACK':'';
  $('#format-hint').textContent=state.mode==='hls'?'A browser-friendly stream is prepared as data arrives. Buffering depends on peers and conversion speed. The original stays on your PC.':'Playback waits for verified torrent pieces. Seeking into an undownloaded section may buffer. Your files stay on your PC.';
  if(state.mode==='hls'&&state.availableDuration!==undefined){
    const buffered=video.buffered.length?video.buffered.end(video.buffered.length-1):0;const prepared=clockTime(state.complete&&state.duration?state.duration:Math.max(state.availableDuration||0,buffered)),total=state.duration?clockTime(state.duration):'unknown';
    $('#player-progress-label').textContent=state.complete?'Playback fully prepared':prepared+' prepared · '+total+' total';
    $('#format-hint').textContent=state.complete?'The complete video is ready to seek and watch. Your original and playback copy stay on this PC.':'Your browser can seek within the prepared timeline ('+prepared+'). The rest prepares in the background; the downloaded original stays on your PC.';
  }
  if(state.status==='ready'||state.url)attachPlayback(state,generation);
  maybeRecoverGrowingStream(state);
  renderResumeChoice();renderStartupDiagnostic(state);$('#retry-player').textContent=failed?'Try again':active.url?'Reconnect':'Check again';
  $('#dock-toggle').hidden=!active.url||active.resumePending;
  warmFlow.refresh();rescueFlow.refresh();fastStartFlow.refresh();
}
function renderStartupDiagnostic(state){const startup=state.startup||{},waiting=startup.waiting,details=[];if(state.status!=='ready'&&Number(startup.elapsedSeconds)>=10)details.push(`Preparing for ${clockTime(startup.elapsedSeconds)}`);if(waiting&&Number(waiting.waitSeconds)>=5)details.push(`Waiting ${clockTime(waiting.waitSeconds)} for required ${waiting.region==='end'?'end-of-file':waiting.region==='middle'?'middle-of-file':'opening'} pieces`);if(state.status!=='ready'&&Number(startup.probeAttempts)>1)details.push(`Video format check ${startup.probeAttempts}`);const speed=Number.parseFloat(startup.encodingSpeed);if(state.mode==='hls'&&!state.complete&&Number.isFinite(speed)&&speed>0)details.push(`Last conversion speed: ${speed.toFixed(2)}×${speed<1?' · playback may pause to buffer':''}`);$('#startup-diagnostic').textContent=details.join(' · ');}
async function pollPlayback(generation){
  if(!active||generation!==playGeneration)return;
  let interval=2000;
  try{
    const state=await api(`/api/playback?hash=${encodeURIComponent(active.hash)}&index=${active.index}`);
    if(generation!==playGeneration)return;
    if(active.rescueOriginal&&['error','unsupported'].includes(state.status)){
      failPreparedPlayback('The replacement could not keep playing. You can reopen the original.');return;
    }
    if(active.preparedOnly){
      const expected=active.preparedOnly;
      if(!samePlaybackSession(state,expected)||state.status==='idle'||
        expected.url&&state.status==='ready'&&state.url!==expected.url){
        failPreparedPlayback('This prepared video changed. Open it from My Library to watch it again.');
        return;
      }
      if(!expected.url&&state.url)expected.url=state.url;
    }
    if(state.status==='idle'){active.url=null;await selectFile(active.forceTranscode);return;}
    renderPlayback(state,generation);
    if(state.status==='error'||state.status==='unsupported'){$('#retry-player').disabled=false;return;}
    if(!state.url&&!active.hasPlayed){
      const elapsed=Date.now()-(active.prepareStarted||0);
      interval=elapsed<5000?300:elapsed<15000?1000:2000;
    }
  }catch(e){
    if(generation!==playGeneration)return;
    if(e.status===404){
      if(active.preparedOnly)failPreparedPlayback('This prepared video is no longer available.');
      else playbackRemoved();
      return;
    }
    textIfChanged('#player-stream-status',e.message);
    setPlaybackStatus('We’ll try connecting again in a moment.','Connection interrupted','error');
  }
  if(generation===playGeneration)watchTimer=setTimeout(()=>pollPlayback(generation),interval);
}
async function torrentAction(button){button.disabled=true;try{await api('/api/torrent/action',{hash:button.dataset.hash,action:button.dataset.action});await refresh();}catch(e){notice(e.message);}finally{button.disabled=false;}}
async function retryAdd(id){
  if(!id)return;$('#retry-add').disabled=true;$('#confirm-retry-add').disabled=true;$('#retry-add-error').textContent='';
  const request=++foregroundPlay;
  try{
    const operation=await api('/api/add/retry',{id,confirmRetry:true});
    operations=[...operations.filter(o=>o.id!==operation.id),operation];
    if(operation.selectionKey){additions.set(operation.selectionKey,operation);playRequests.set(operation.selectionKey,request);}
    handledOperations.delete(operation.id);awaitingOperations.add(operation.id);
    $('#retry-add-dialog').close();notice(operation.message||'Checking this source with qBittorrent.');
    await reconcileOperations();await refresh();
  }catch(e){if($('#retry-add-dialog').open)$('#retry-add-error').textContent=e.message;else notice(e.message);}
  finally{$('#retry-add').disabled=false;$('#confirm-retry-add').disabled=false;}
}
function confirmRemove(hash){const t=library.find(t=>t.hash===hash);if(!t)return;removeHash=hash;$('#remove-title').textContent=t.name;$('#delete-files').checked=false;$('#remove-error').textContent='';$('#remove-dialog').showModal();}
// Delegated actions stay usable as live download status changes.
document.addEventListener('click',event=>{const target=event.target;const series=target.closest('[data-series-hash]');if(series)openSeries(series.dataset.seriesHash);if(target.closest('#player-episodes')&&active)openSeries(active.hash);const nav=target.closest('[data-view]');if(nav)setView(nav.dataset.view);const play=target.closest('[data-play]');if(play)openPlayer(play.dataset.play,null,play.hasAttribute('data-play-index')?Number(play.dataset.playIndex):null);const plugin=target.closest('[data-plugin]');if(plugin&&!plugin.disabled)selectPlugin(plugin.dataset.plugin,plugin.dataset.pluginCategory);const add=target.closest('[data-add]');if(add&&!add.disabled)addSource(add.dataset.add,add.dataset.category);const action=target.closest('[data-action]');if(action&&!action.disabled)torrentAction(action);const remove=target.closest('[data-remove]');if(remove)confirmRemove(remove.dataset.remove);const duplicate=target.closest('[data-duplicate-play]');if(duplicate){$('#duplicate-dialog').close();openPlayer(duplicate.dataset.duplicatePlay,duplicateRequest?.intent);}if(target.closest('[data-discover]')){setView('home');$('#query').focus();$('#search-section').scrollIntoView({behavior:'instant',block:'center'});}const close=target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();});
$('#view-back').onclick=()=>{const previous=backViews.pop();if(previous)setView(previous,{back:true});};
$('#results-grid').addEventListener('click',event=>{
  const download=event.target.closest('[data-rescue-download]'),restore=event.target.closest('[data-rescue-restore]');
  const search=currentRescueSearch();
  if(search&&download&&!download.disabled){
    void addSource(download.dataset.rescueDownload,download.dataset.category,true,null,{background:true});return;
  }
  if(search&&restore&&!restore.disabled){
    $('#restore-player').click();openRescuePanel();return;
  }
  const group=event.target.closest('[data-release-group]');
  if(group){openReleaseGroup=openReleaseGroup===group.dataset.releaseGroup?null:group.dataset.releaseGroup;visibleReleaseLimit=8;renderResults();}
  if(event.target.closest('[data-more-releases]')){visibleReleaseLimit+=8;renderResults();}
});
function moveResultPage(change){searchPage+=change;openReleaseGroup=null;renderResults();$('#results-title').setAttribute('tabindex','-1');$('#results-title').focus();$('#results-title').scrollIntoView({behavior:'instant',block:'start'});}
$('#result-previous').onclick=()=>moveResultPage(-1);$('#result-next').onclick=()=>moveResultPage(1);
function findReplacement(background=false){
  const item=library.find(t=>t.hash===active?.hash);if(!item)return;
  const intent=active.intent,source=rescueSource();
  minimizePlayer();
  if(background&&source){
    const episodeQuery=Number.isInteger(intent?.season)&&Number.isInteger(intent?.episode)?
      source.title+' S'+String(intent.season).padStart(2,'0')+'E'+String(intent.episode).padStart(2,'0'):
      clean(source.name.split(/[\\/]/).at(-1));
    const query=source.movie?source.movie.title+' '+source.movie.year:episodeQuery;
    setView(source.movie?'movies':item.kind==='anime'?'anime':'tv');
    rescueSearch={hash:source.hash,generation:playGeneration,query};
    $('#query').value=query;$('#search-source').value='';renderSourceOptions();
    $('#search-form').requestSubmit();return;
  }
  if(intent?.showId&&intent.episodeId){
    void episodeUI.open({id:intent.showId,title:intent.showTitle||clean(item.name),year:intent.year,kind:intent.kind,season:intent.season},{episodeId:intent.episodeId,excludeHash:item.hash});
    return;
  }
  setView(item.kind==='movies'?'movies':item.kind==='anime'?'anime':['tv','korean'].includes(item.kind)?'tv':'home');
  $('#query').value=clean(item.name);$('#search-source').value='';renderSourceOptions();
  $('#search-form').requestSubmit();
}
function openRescuePanel(){
  if(!rescueSource()){findReplacement();return;}
  const panel=$('#rescue-panel');
  panel.hidden=false;panel.open=true;panel.querySelector('summary').focus({preventScroll:true});
  rescueFlow.show();
}
$('#alternate-source').onclick=openRescuePanel;
$('#player-fast-start').onclick=openRescuePanel;
$('#rescue-reopen').onclick=()=>{
  const source=active?.rescueOriginal;
  if(source)void openPlayer(source.hash,source.intent,source.index);
};
$('#refresh').onclick=async()=>{if(!await refresh())notice('Cannot reach qBittorrent. Check Connection settings.');else notice('Library and downloads are up to date.');};
$('#plugin-refresh').onclick=async event=>{
  const button=event.currentTarget;
  button.disabled=true;
  textIfChanged('#plugin-refresh-status','Checking installed plugins…');
  try{
    const list=await api('/api/plugins');
    acceptPluginList(list);
    renderSources();
    textIfChanged('#plugin-refresh-status','Plugin list is up to date.');
  }catch(error){textIfChanged('#plugin-refresh-status',error.message);}
  finally{button.disabled=false;}
};
$('#search-category').onchange=()=>{$('#search-source').value='';renderSourceOptions();};$('#search-source').onchange=renderSourceOptions;
const settingsDialog=$('#settings');
const downloadLocationSection=$('#download-location-settings');
const downloadLocationForm=$('#download-location-form');
const downloadLocationPath=$('#download-location-path');
const downloadLocationBrowse=$('#download-location-browse');
const downloadLocationSave=$('#download-location-save');
const downloadLocationDefault=$('#download-location-default');
const downloadLocationRetry=$('#download-location-retry');
const downloadLocationError=$('#download-location-error');
const downloadFolderBridge=globalThis.window?.cinemaDesktopFolderPicker===true &&
  typeof globalThis.chrome?.webview?.postMessage==='function' &&
  typeof globalThis.chrome?.webview?.addEventListener==='function' ? globalThis.chrome.webview : null;
let downloadLocationVisit=0,downloadLocationState=null,downloadLocationRead=null;
let downloadLocationSaving=false,downloadLocationPick=null,downloadLocationNotice='';

function renderDownloadLocation(){
  const mode=downloadLocationState?.mode,currentPath=downloadLocationState?.path;
  const editable=mode==='default'||mode==='custom'||mode==='repair';
  const locked=Boolean(downloadLocationRead||downloadLocationSaving);
  const draft=downloadLocationPath.value;
  downloadLocationForm.hidden=!editable;
  downloadLocationPath.disabled=locked||!editable;
  downloadLocationBrowse.hidden=!downloadFolderBridge;
  downloadLocationBrowse.disabled=locked||!editable;
  downloadLocationBrowse.setAttribute('aria-disabled',String(Boolean(downloadLocationPick)));
  downloadLocationSave.disabled=locked||!editable||!draft.trim()||draft===currentPath;
  downloadLocationDefault.disabled=locked||(mode!=='custom'&&mode!=='repair');
  downloadLocationRetry.hidden=Boolean(mode||locked||!downloadLocationError.textContent);
  textIfChanged('#download-location-current-path',currentPath||'');
  $('#download-location-current-path').hidden=!currentPath;
  let status='Checking download location…';
  if(downloadLocationSaving)status='Saving download location…';
  else if(downloadLocationPick)status='Choose a folder in Windows…';
  else if(downloadLocationNotice)status=downloadLocationNotice;
  else if(mode==='managed')status='Cinema Scene Preview uses its own managed download folder.';
  else if(mode==='custom')status='Saved folder for new downloads';
  else if(mode==='default')status='New downloads follow qBittorrent’s default or category folder.';
  else if(mode==='repair')status='The saved download location needs attention.';
  else if(!locked&&downloadLocationError.textContent)status='Download location is unavailable.';
  textIfChanged('#download-location-status',status);
}

function applyDownloadLocationState(result){
  const {mode,path}=result||{};
  if(!['default','custom','managed'].includes(mode)||path!==null&&typeof path!=='string'||
      mode==='custom'&&!path||mode==='default'&&path!==null){
    throw Error('Cinema could not read the saved download location. Try again.');
  }
  downloadLocationState={mode,path};
  downloadLocationPath.value=mode==='custom'?path:'';
}

function currentDownloadLocationVisit(visit){
  return settingsDialog.open&&visit===downloadLocationVisit;
}

async function loadDownloadLocation(){
  if(!settingsDialog.open||downloadLocationRead||downloadLocationSaving)return;
  const visit=downloadLocationVisit,controller=new AbortController();
  downloadLocationRead=controller;
  downloadLocationError.textContent='';
  renderDownloadLocation();
  try{
    const result=await api('/api/download-location',undefined,false,controller.signal);
    if(currentDownloadLocationVisit(visit)){
      applyDownloadLocationState(result);
      downloadLocationSection.hidden=false;
    }
  }catch(error){
    if(currentDownloadLocationVisit(visit)){
      if(error.status===500)downloadLocationState={mode:'repair',path:null};
      downloadLocationSection.hidden=error.status===404;
      downloadLocationError.textContent=error.message;
    }
  }finally{
    if(downloadLocationRead===controller)downloadLocationRead=null;
    if(currentDownloadLocationVisit(visit))renderDownloadLocation();
  }
}

function clearDownloadLocationPending(){
  downloadLocationVisit++;
  downloadLocationRead?.abort();
  downloadLocationRead=null;
  downloadLocationPick=null;
}

function openDownloadLocation(){
  clearDownloadLocationPending();
  downloadLocationState=null;
  downloadLocationNotice='';
  downloadLocationError.textContent='';
  downloadLocationPath.value='';
  downloadLocationPath.removeAttribute('aria-invalid');
  renderDownloadLocation();
  void loadDownloadLocation();
}

async function saveDownloadLocation(path){
  const mode=downloadLocationState?.mode;
  if(!settingsDialog.open||downloadLocationSaving||downloadLocationRead||
      !['default','custom','repair'].includes(mode)||(mode!=='repair'&&path===downloadLocationState.path)||path==='')return;
  const visit=downloadLocationVisit;
  const origin=document.activeElement;
  downloadLocationPick=null;
  downloadLocationSaving=true;
  downloadLocationNotice='';
  downloadLocationError.textContent='';
  downloadLocationPath.removeAttribute('aria-invalid');
  renderDownloadLocation();
  try{
    const result=await api('/api/download-location',{path});
    if(currentDownloadLocationVisit(visit)){
      applyDownloadLocationState(result);
      downloadLocationNotice=downloadLocationState.mode==='default'?
        'New downloads will use qBittorrent’s default or category folder.':'Download location saved for new downloads.';
    }
  }catch(error){
    if(currentDownloadLocationVisit(visit)){
      downloadLocationError.textContent=error.message;
      if(path!==null&&[400,422].includes(error.status))downloadLocationPath.setAttribute('aria-invalid','true');
    }
  }finally{
    downloadLocationSaving=false;
    if(currentDownloadLocationVisit(visit)){
      renderDownloadLocation();
      if(downloadLocationForm.contains(origin)&&document.activeElement===document.body)downloadLocationPath.focus();
    }else if(settingsDialog.open)void loadDownloadLocation();
  }
}

downloadLocationPath.addEventListener('input',()=>{
  downloadLocationPick=null;
  downloadLocationNotice='';
  downloadLocationError.textContent='';
  downloadLocationPath.removeAttribute('aria-invalid');
  renderDownloadLocation();
});
downloadLocationForm.addEventListener('submit',event=>{
  event.preventDefault();
  void saveDownloadLocation(downloadLocationPath.value);
});
downloadLocationDefault.addEventListener('click',()=>void saveDownloadLocation(null));
downloadLocationRetry.addEventListener('click',()=>void loadDownloadLocation());
downloadLocationBrowse.addEventListener('click',()=>{
  if(!downloadFolderBridge||!settingsDialog.open||downloadLocationForm.hidden||
      downloadLocationBrowse.disabled||downloadLocationPick)return;
  try{
    const id=globalThis.crypto.randomUUID().replaceAll('-','');
    downloadLocationPick={id,visit:downloadLocationVisit};
    downloadLocationNotice='';
    downloadLocationError.textContent='';
    downloadFolderBridge.postMessage('cinema:pick-download-folder:'+id);
  }catch{
    downloadLocationPick=null;
    downloadLocationError.textContent='Cinema could not open the Windows folder picker. Enter the folder path here.';
  }
  renderDownloadLocation();
});
downloadFolderBridge?.addEventListener('message',event=>{
  const pick=downloadLocationPick;
  if(!pick||!currentDownloadLocationVisit(pick.visit)||typeof event.data!=='string')return;
  const prefix='cinema:download-folder:'+pick.id+':';
  const failed=event.data==='cinema:download-folder-error:'+pick.id;
  if(!failed&&!event.data.startsWith(prefix))return;
  downloadLocationPick=null;
  const selectedPath=failed?'':event.data.slice(prefix.length);
  if(failed)downloadLocationError.textContent='Cinema could not open the Windows folder picker. Enter the folder path here.';
  if(selectedPath){
    downloadLocationPath.value=selectedPath;
    downloadLocationPath.removeAttribute('aria-invalid');
  }
  renderDownloadLocation();
  const focusTarget=selectedPath||failed?downloadLocationPath:downloadLocationBrowse;
  focusTarget.focus({preventScroll:true});
});
settingsDialog.addEventListener('close',()=>{
  if(!settingsDialog.open)clearDownloadLocationPending();
});

async function refreshPlaybackCache(change){
  const limit=$('#cache-limit'),clear=$('#cache-clear'),confirm=$('#cache-confirm-clear');
  limit.disabled=clear.disabled=confirm.disabled=true;
  $('#cache-error').textContent='';
  try{
    const state=await api('/api/playback-cache',change);
    const quota=state.quotaGiB===null?'':String(state.quotaGiB);
    if(quota&&!Array.from(limit.options).some(option=>option.value===quota)){
      const option=document.createElement('option');option.value=quota;option.textContent=quota+' GiB';limit.append(option);
    }
    limit.value=quota;
    textIfChanged('#cache-size',`${bytes(state.bytes)} stored · ${bytes(state.reclaimableBytes)} can be cleared`);
    if(change?.action==='clear'){
      $('#cache-confirm').hidden=true;
      textIfChanged('#cache-size',`Cleared ${bytes(state.removedBytes)} · ${bytes(state.bytes)} still stored`);
    }
    if(state.failedRuns)$('#cache-error').textContent='Some entries could not be cleared. Try again after playback ends.';
    clear.disabled=!state.reclaimableBytes;
  }catch(error){
    $('#cache-error').textContent=error.message;
    if(!change)textIfChanged('#cache-size','Cache size is unavailable.');
  }finally{
    limit.disabled=confirm.disabled=false;
  }
}
$('#settings-button').onclick=()=>{
  $('#cinema-menu').open=false;
  $('#connection-error').textContent='';$('#cache-confirm').hidden=true;$('#source-memory-confirm').hidden=true;refreshSourceMemoryControls();
  settingsDialog.showModal();
  openDownloadLocation();
  void refreshPlaybackCache();
};
$('#cache-limit').onchange=()=>refreshPlaybackCache({action:'limit',quotaGiB:$('#cache-limit').value?Number($('#cache-limit').value):null});
$('#cache-clear').onclick=()=>{$('#cache-confirm').hidden=false;$('#cache-cancel-clear').focus();};
$('#cache-cancel-clear').onclick=()=>{$('#cache-confirm').hidden=true;$('#cache-clear').focus();};
$('#cache-confirm-clear').onclick=()=>refreshPlaybackCache({action:'clear',confirm:true});
$('#connection-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type=submit]');button.disabled=true;sourceMemoryConnecting=true;sourceMemoryFence++;cancelSourceMemory();acceptSourceMemory({...sourceMemoryView,available:false,observed:[]});$('#connection-error').textContent='Connecting…';try{await api('/api/connect',Object.fromEntries(new FormData(form)));form.elements.password.value='';$('#settings').close();sourceMemoryConnecting=false;sourceMemoryFence++;await refresh();notice('Connected to qBittorrent.');}catch(e){sourceMemoryFence++;$('#connection-error').textContent=e.message;}finally{sourceMemoryConnecting=false;button.disabled=false;}};
$('#source-memory-enabled').onchange=event=>void changeSourceMemory({action:'preferences',enabled:event.currentTarget.checked});
$('#source-memory-clear').onclick=()=>{$('#source-memory-confirm').hidden=false;$('#source-memory-cancel-clear').focus();};
$('#source-memory-cancel-clear').onclick=()=>{$('#source-memory-confirm').hidden=true;$('#source-memory-clear').focus();};
$('#source-memory-confirm-clear').onclick=()=>void changeSourceMemory({action:'clear',confirm:true});
function closeSearch(){
  rescueSearch=null;foregroundPlay++;void stopSearch();enrichment.cancelCatalog?.();
  $('#search-results').hidden=true;discoveryUI.setSearchMode(false);renderContinueWatching();
  setSearchVisibility(false,{focus:true});
}
$('#search-form').onsubmit=search;
$('#close-search').onclick=closeSearch;
$('#dismiss-search').onclick=closeSearch;
$('#search-toggle').onclick=()=>$('#search-section').hidden?setSearchVisibility(true,{focus:true}):closeSearch();
$('#results-sort').onchange=()=>{searchPage=0;renderResults();};
$('#retry-add').onclick=()=>{const operation=operations.find(o=>o.id===pendingOperationId);if(!operation)return;if(operation.status==='uncertain'){retryOperationId=operation.id;$('#retry-add-title').textContent=operation.name;$('#retry-add-error').textContent='';$('#retry-add-dialog').showModal();}else retryAdd(operation.id);};
$('#confirm-retry-add').onclick=()=>retryAdd(retryOperationId);
$('#library-filter').oninput=renderLibrary;$('#library-sort').onchange=renderLibrary;$('#plugin-filter').oninput=renderSources;$('#plugin-group').onchange=renderSources;$('#plugin-status').onchange=renderSources;
$('#duplicate-add').onclick=()=>{if(!duplicateRequest)return;const {key,category,intent}=duplicateRequest;duplicateRequest=null;$('#duplicate-dialog').close();addSource(key,category,true,intent);};
$('#remove-form').onsubmit=async event=>{event.preventDefault();const t=library.find(t=>t.hash===removeHash);if(!t)return;const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{await api('/api/torrent/action',{hash:removeHash,action:'delete',deleteFiles:$('#delete-files').checked,confirmName:t.name});if(active?.hash===removeHash){
  if(active.preparedOnly?.fallback||active.rescueOriginal)failPreparedPlayback('This checked title is no longer in your library.');
  else stopPlayback();
}$('#remove-dialog').close();notice($('#delete-files').checked?'Torrent and downloaded files removed.':'Torrent removed. Downloaded files were kept on your PC.');await refresh();}catch(e){$('#remove-error').textContent=e.message;}finally{button.disabled=false;}};
$('#file-select').onchange=()=>{if(active){saveProgress();active.watchedTarget=null;active.intent=null;active.verifiedEpisode=null;active.appointment=null;}selectFile(false,false,true);};$('#retry-player').onclick=$('#player-quick-retry').onclick=retryPlayback;$('#resume-beginning').onclick=()=>chooseResume(true);$('#resume-saved').onclick=()=>chooseResume(false);
$('#file-category').onchange=async event=>{if(!active)return;try{await api('/api/category',{hash:active.hash,category:event.target.value});await refresh();}catch(e){setPlaybackStatus(e.message);}};
$('#close-player').onclick=$('#browse-player').onclick=minimizePlayer;
$('#player-dialog').addEventListener('cancel',event=>{
  event.preventDefault();
  if(scenePreview.escape())return;
  if(!$('#watched-player-catch-up').hidden){watchedUI.closePlayer({restoreFocus:true});return;}
  if(videoControls?.closeMenus())return;
  const sounds=$('#sound-map-panel'),studio=$('#two-track-panel'),sketchbook=$('#scene-sketchbook-panel');
  const sceneTools=$('#scene-panel').open?[sketchbook,sounds].filter(panel=>panel.open):[];
  const nested=$('#subtitle-panel').open&&studio.open?studio:
    sceneTools.find(panel=>panel.contains(document.activeElement))||sceneTools[0];
  const panel=nested||['#rescue-panel','#scene-panel','#subtitle-panel','#warm-switch-panel','#player-options','#timeline-panel']
    .map(id=>$(id)).find(item=>item.open);
  if(!panel){minimizePlayer();return;}
  panel.open=false;
  panel.querySelector('summary').focus();
});
$('#stop-player').onclick=$('#dock-stop').onclick=stopPlayback;$('#restore-player').onclick=()=>{$('#player-dialog').showModal();$('#player-dock').hidden=true;};
$('#dock-scene').onclick=()=>{$('#restore-player').click();$('#scene-arrival .scene-arrival-jump').focus();};
$('#dock-toggle').onclick=()=>{const video=$('#video');if(video.paused)video.play().catch(()=>{});else video.pause();};
$('#player-opening-play').onclick=()=>startVideo(playGeneration);
$('#video').addEventListener('loadedmetadata',()=>{if(!active||active.resumed)return;const video=$('#video');if(!active.resumePending&&(active.mode!=='hls'||!hls)&&active.resumeTarget>0&&(!Number.isFinite(video.duration)||active.resumeTarget<video.duration-(active.rescueOriginal?.hash ? .2 : 10))){try{video.currentTime=active.resumeTarget;}catch{}}active.resumed=true;renderResumeChoice();});
for(const event of ['seeked','loadeddata','canplay'])$('#video').addEventListener(event,completeRescueLanding);
for(const event of ['loadeddata','seeked'])$('#video').addEventListener(event,()=>{
  const video=$('#video');
  if(typeof video.requestVideoFrameCallback==='function')armOpeningPicture(video);
  else revealOpeningCover(video,playGeneration,active?.url,video.currentTime,'decoded');
});
$('#video').addEventListener('progress',renderResumeChoice);$('#video').addEventListener('canplay',renderResumeChoice);
$('#video').addEventListener('play',()=>{invalidateSketchbookFrame();requestSketchbookFrame(true);if(active?.resumePending){active.resumePending=false;active.resumeTarget=0;active.resumed=true;renderResumeChoice();}});
$('#video').addEventListener('timeupdate',()=>{
  schedulePlaybackMap();
  const video=$('#video'),time=video.currentTime;
  revealOpeningCover(video,playGeneration,active?.url,time,'progress');
  if(active?.hasPlayed&&Number.isFinite(time)&&!active.hlsRecovery){
    observeRescueFrame();
    active.lastVideoTime=time;
    if(active.hlsRecoveredAt!==null&&time>=active.hlsRecoveredAt+5){active.hlsAttempts=0;active.hlsRecoveredAt=null;}
  }
  if(Date.now()-lastSaved<10000)return;lastSaved=Date.now();saveProgress();
});
for(const event of ['durationchange','progress','seeked','waiting','error','playing','emptied','pause','ended'])$('#video').addEventListener(event,schedulePlaybackMap);
for(const event of ['pointerdown','keydown'])$('#video').addEventListener(event,cancelSourceMemory,true);
$('#video').addEventListener('seeking',({currentTarget:video})=>{
  const attempt=active?.sourceMemoryStart;
  if(attempt&&!active.hasPlayed&&!Number.isFinite(attempt.frameSeenAt)&&
    Number.isFinite(attempt.initialAlignmentTime)&&video.currentTime===attempt.initialAlignmentTime){
    attempt.usedInitialAlignment=true;
    delete attempt.initialAlignmentTime;
  }else cancelSourceMemory();
  if(active?.url){
    active.releaseObservation?.settle(performance.now());
    active.rescueSeekEpoch=(active.rescueSeekEpoch||0)+1;
    active.rescueFrame=null;
    invalidateSketchbookFrame();
    requestSketchbookFrame(true);
  }
  fastStartFlow.refresh();
  runwayTracker.reset();
  schedulePlaybackMap();
});
$('#video').addEventListener('emptied',invalidateSketchbookFrame);
$('#video').addEventListener('ratechange',()=>{
  cancelSourceMemory();
  runwayTracker.reset();
  schedulePlaybackMap();
});
$('#video').addEventListener('playing',()=>{
  if(!active)return;
  active.releaseObservation?.settle(performance.now());active.failed=false;active.autoplayBlocked=false;active.hasPlayed=true;active.userPaused=false;active.waiting=false;active.ended=false;
  const video=$('#video');
  sourceMemoryPlaying(video);$('#dock-toggle').textContent='Pause';
  if($('#player-placeholder').hidden)setPlaybackStatus('Now playing',null,'playing');
  else{setPlaybackStatus('Starting the picture','Starting the picture');armOpeningPicture(video);}
});
$('#player-opening-art').addEventListener('load',event=>{event.currentTarget.hidden=false;});
$('#video').addEventListener('pause',()=>{if(!active)return;if(active.url){cancelSourceMemory();active.releaseObservation?.excludeStart();active.releaseObservation?.settle(performance.now());}$('#dock-toggle').textContent='Play';if(active.url&&active.hasPlayed&&!$('#video').ended&&!$('#video').error){active.userPaused=true;setPlaybackStatus('Paused',null,'paused');}fastStartFlow.refresh();requestSketchbookFrame();sceneSketchbook.refresh();saveProgress();});
$('#video').addEventListener('error',fastStartFlow.refresh);
$('#video').addEventListener('waiting',()=>{
  if(!active?.url)return;
  const video=$('#video');
  if(active.presentedGeneration===playGeneration&&active.hasPlayed&&!active.userPaused&&!active.resumePending&&!video.paused&&!video.seeking&&!video.ended&&!video.error&&video.readyState<3&&!document.hidden)
    active.releaseObservation?.wait(performance.now());
  active.waiting=true;
  if(!active.userPaused&&!active.resumePending){
    if($('#player-placeholder').hidden)setPlaybackStatus('Waiting for more video…','Waiting for more video');
    else setPlaybackStatus('Starting the picture','Starting the picture');
  }
});
$('#video').addEventListener('error',()=>{if(!active?.url)return;cancelSourceMemory();active.releaseObservation?.settle(performance.now());const code=$('#video').error?.code;if(active.rescueOriginal){failPreparedPlayback('The replacement could not play. You can reopen the original.');return;}if(active.preparedOnly&&[3,4].includes(code)&&(active.preparedOnly.fallback||active.mode==='direct')){failPreparedPlayback(active.preparedOnly.fallback?'This saved video could not play. You can return to the original title.':'This prepared video could not play. You can reopen it from My Library.');return;}if(active.mode==='hls'&&[3,4].includes(code)){recoverGrowingStream();}else if(active.mode==='direct'&&!active.forceTranscode&&[3,4].includes(code)){setPlaybackStatus('Just a moment…','Getting your video ready');selectFile(true,true);}else if(code===2&&!active.networkRetried){active.networkRetried=true;reconnectPlayback();}else{active.failed=true;setPlaybackStatus('Try again to pick up where you left off.','Playback interrupted');$('#retry-player').disabled=false;}});
$('#video').addEventListener('ended',()=>{if(active){active.releaseObservation?.settle(performance.now());active.ended=Boolean(active.sourceComplete);active.waiting=!active.sourceComplete;active.userPaused=false;setPlaybackStatus(active.sourceComplete?'Finished watching':'Waiting for the next part of the video…');saveProgress();}});
for(const event of ['seeking','seeked','waiting','pause','ratechange','ended','emptied','error']){
  $('#video').addEventListener(event,()=>watched.boundary(
    watched.getCollection().enabled&&active?.url&&['pause','ended','waiting'].includes(event)?watchedPlayed($('#video')):undefined));
}
$('#video').textTracks?.addEventListener('change',()=>watched.boundary());
window.addEventListener('beforeunload',saveProgress);
document.addEventListener('visibilitychange',()=>{
  watched.boundary();
  fastStartFlow.refresh();
  if(document.hidden){
    scenePreview.reset();
    cancelSourceMemory();
    active?.releaseObservation?.excludeStart();
    active?.releaseObservation?.settle(performance.now());
    runwayTracker.reset();
  }else refresh();
  schedulePlaybackMap();
});
function activePlannerFile(){
  if(!active?.url||!Number.isInteger(active.index))return null;
  const file=active.files.find(entry=>entry.index===active.index),video=$('#video');
  if(!file)return null;
  const episode=verifiedEpisodeForActive();
  return {
    hash:active.hash,index:active.index,fileName:file.name.split(/[\\/]/).at(-1),intent:active.intent,
    verifiedEpisode:episode?{index:active.index,...episode}:null,
    duration:active.backendState?.duration||(active.sourceComplete&&Number.isFinite(video.duration)?video.duration:null),
    ready:video.readyState>=3&&!video.error&&!video.ended&&!active.failed&&!active.waiting&&!active.hlsRecovery&&!active.resumePending,
  };
}
async function verifyPlannerFile(hash,signal){
  const response=await fetch('/api/planner-file?hash='+encodeURIComponent(hash),{
    signal:AbortSignal.any([signal,AbortSignal.timeout(6500)]),
  });
  if(!response.ok)throw Error('Cinema could not check this download.');
  return response.json();
}
async function verifyFollowCaption(id,signal){
  const timeout=AbortSignal.timeout(4500);
  const response=await fetch('/api/subtitles/file?id='+encodeURIComponent(id),{
    method:'HEAD',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
  });
  if(response.status===404)return false;
  if(!response.ok)throw Error('Cinema couldn’t check this track.');
  return true;
}
async function startApplication(){
  void import('./player-controls.js').then(({createVideoControls})=>{
    videoControls=createVideoControls({
      video:$('#video'),controls:$('#video-controls'),panels:[$('#audio-panel'),$('#subtitle-panel')],
      getPlayback:()=>({map:mapForActive(),key:active?.watchedAttachment||active?.url,
        visible:Boolean(active?.url&&!active.watchedTarget&&!active.resumePending&&$('#player-placeholder').hidden)}),
      seek:seekScene,clockTime,onInteract:cancelSourceMemory,
    });
    schedulePlaybackMap();
  }).catch(error=>console.warn('Cinema video controls could not load.',error));
  const openTitle=item=>discoveryUI.openItem(item);
  followStore=createFollowStore(localStorage);
  followWeek=createFollowWeekUI({
    getFollows:followStore.list,
    loadSchedule:(showId,signal)=>api('/api/episodes/schedule',{showId},false,signal),
    onUnfollow:id=>followStore.unfollow(id),
    onOpenEpisode:(show,episodeId)=>episodeUI.open(show,{episodeId,search:false}),
    onBrowse:()=>setView('tv'),
    checkEpisode:(show,episode,signal)=>checkFollowEpisode({show,episode,signal,
      getLibrary:()=>library,getHistory:()=>history,isConnected:()=>connected,
      api:(url,body,checkSignal)=>api(url,body,false,checkSignal),
      getCaption:enrichment.savedCalendarCaption,checkCaption:verifyFollowCaption}),
  });
  watchlist=createWatchlist({escape,openItem:openTitle,onChange:()=>{spotlight?.render();watchPlanner?.refresh();}});
  watchPlanner=createWatchPlanner({
    dialog:$('#watch-planner-dialog'),trigger:$('#watch-planner-open'),verifyFile:verifyPlannerFile,
    getSnapshot:()=>({rows:plannerRows,saved:watchlist.entries(),library,connected,history,active:activePlannerFile()}),
    openTitle,openPlayer,appointmentRail:$('#appointment-rail'),canCheckAppointment:()=>!active,
    getAppointmentPoster:item=>enrichment.metadata(item.name)?.posterUrl,
    checkAppointment:(input,signal)=>api('/api/watch-appointment',input,false,AbortSignal.any([signal,AbortSignal.timeout(7500)])),
  });
  for(const event of ['playing','canplay','waiting','error','ended','emptied'])$('#video').addEventListener(event,watchPlanner.refresh);
  spotlight=createSpotlight({escape,openItem:openTitle,isSaved:watchlist.isSaved,toggleSaved:watchlist.toggle,lookup:async item=>{
    const {matches}=await api('/api/metadata/search',{query:item.title,year:item.year,kind:item.kind==='korean'?'tv':item.kind});
    return matches?.find(match=>match.confidence>=.9&&(!item.year||String(match.year)===String(item.year)));
  }});
  const menu=$('#cinema-menu'),filters=$('#search-filters'),browse=$('#browse-options');
  menu.addEventListener('click',event=>{if(event.target.closest('[data-view]'))menu.open=false;});
  document.addEventListener('click',event=>{
    if(!menu.contains(event.target))menu.open=false;
    if(!filters.contains(event.target))filters.open=false;
    if(!browse.contains(event.target))browse.open=false;
    if(event.target.closest('[data-discover]'))setSearchVisibility(true,{focus:true});
  });
  document.addEventListener('keydown',event=>{
    if(document.querySelector('dialog[open]'))return;
    if(event.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary').focus();return;}
    if(event.key==='Escape'&&filters.open){filters.open=false;filters.querySelector('summary').focus();return;}
    if(event.key==='Escape'&&browse.open){browse.open=false;browse.querySelector('summary').focus();return;}
    const typing=event.target.matches('input,textarea,select,[contenteditable=true]');
    if((event.key==='/'&&!typing)||(event.key.toLowerCase()==='k'&&(event.ctrlKey||event.metaKey))){
      event.preventDefault();setSearchVisibility(true,{focus:true});
    }else if(event.key==='Escape'&&!$('#search-section').hidden){
      event.preventDefault();closeSearch();
    }
  });
  void discoveryUI.load();
  void stateLoop();
  try{
    const session=await api('/api/session');
    token=session.token;
    if(session.profile==='scene-preview'){
      const {createCompanionUI}=await import('./companion-ui.js');
      companionUI=createCompanionUI({request:magnet=>api('/api/companion/magnet',{magnet}),onAdded:companionAdded});
      companionUI.enable();renderLibrary();
    }
    if(session.profile==='installed'){
      const {enableInstalledUI}=await import('./installed-ui.js');
      enableInstalledUI({onSearch:async query=>{
        try{
          if(!plugins.some(p=>p.name==='cinema_open_films'&&p.enabled))acceptPluginList(await api('/api/plugins'));
          if(!selectPlugin('cinema_open_films','movies'))return;
          $('#query').value=query;
          $('#search-form').requestSubmit();
        }catch(e){notice(e.message);}
      }});
    }
    $('#connection-form').elements.url.value=session.url;
    $('#connection-form').elements.username.value=session.username;
  }catch(e){notice(e.message);}
}
void startApplication();







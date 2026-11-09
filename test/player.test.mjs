import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {playbackMap,readTimeRanges,readyToSeek} from '../public/playback-map.js';
import {createPlaybackRunway} from '../public/playback-runway.js';
import {createReleaseObservation} from '../public/release-passport.js';
import {createWarmPlayback,samePlaybackSession} from '../public/warm-playback.js';
import {createRescueFlow} from '../public/rescue-flow.js';
import {createFastStartFlow} from '../public/fast-start-flow.js';
import {previewFastStart} from '../public/fast-start-preview.js';
import {portableSceneIdentity} from '../public/scene-relay.js';
import {createWatchedRuntime,WATCHED_ENABLED,WATCHED_STORE} from '../public/watched-runtime.js';
import {firstPictureDuration,isOpeningBufferAlignment,sourceMemoryCohorts,sourceMemoryLabel} from '../public/source-memory.js';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const startup=app.indexOf('\nvoid startApplication();');
assert.ok(startup>0,'The fixture must exclude only automatic application startup.');
const audio=fs.readFileSync(new URL('../public/player-audio.js',import.meta.url),'utf8').replace(/^export /gm,'');
const audioScope='const {createPlayerAudio,playerAudioOffer}=(()=>{'+audio+';return {createPlayerAudio,playerAudioOffer};})();\n';
const script=audioScope+app.slice(0,startup).replace(/^import .*;\r?$/gm,'')+`\nglobalThis.playerTest={selectFile,renderPlayback,pollPlayback,retryPlayback,reconnectPlayback,saveProgress,loadPlaybackFiles,reconcileLibraryPresence,reconcileOperations,addSource,openPlayer,watchRecord,renderContinueWatching,setConnection,acceptSourceMemory,requestScenePreview,setLibrary:value=>library=value,setOperations:value=>operations=value,getActive:()=>active,setActive:value=>active=value,getHistory:()=>history,getGeneration:()=>playGeneration,additions,knownLibraryHashes,warmFlow};`;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const ranges=values=>({length:values.length,start:index=>values[index][0],end:index=>values[index][1]});
function harness({savedTime=0,fetchImpl,preloadHls=true,rejectAutoplay=false}={}){
  let observedAt=0, frameId=0, soundControls, studioControls;
  const frameCallbacks=new Map(), insightUpdates=[], previewResets=[];
  class Element{
    constructor(id){Object.assign(this,{id,value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,open:false,paused:true,ended:false,seeking:false,currentTime:0,duration:1800,readyState:0,playbackRate:1,defaultPlaybackRate:1,buffered:ranges([]),seekable:ranges([]),played:ranges([]),playCalls:0,listeners:{},classList:{add(){},remove(){},toggle(){}}});}
    addEventListener(event,handler){(this.listeners[event]||=[]).push(handler);}emit(event){for(const fn of this.listeners[event]||[])fn({currentTarget:this,preventDefault(){}});}setAttribute(){}removeAttribute(name){delete this[name];}remove(){}querySelector(){return new Element('child');}querySelectorAll(){return [];}append(){}replaceChildren(){}insertAdjacentHTML(){}close(){this.open=false;}showModal(){this.open=true;}scrollIntoView(){}focus(){documentMock.activeElement=this;}canPlayType(){return '';}
    contains(node){return node===this||this.id==='player-placeholder'&&['player-opening-play','player-fast-start'].includes(node?.id);}
    requestVideoFrameCallback(callback){frameCallbacks.set(++frameId,callback);return frameId;}
    cancelVideoFrameCallback(id){frameCallbacks.delete(id);}
    pause(){this.paused=true;this.emit('pause');}load(){this.currentTime=0;this.readyState=0;}
    play(){this.playCalls++;if(rejectAutoplay&&this.playCalls===1)return Promise.reject(new DOMException('Playback was blocked','NotAllowedError'));this.paused=false;this.emit('play');return Promise.resolve();}
  }
  const nodes=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element(match[1])]));nodes['file-select'].value='0';nodes['library-sort'].value='recent';
  const hlsInstances=[],scripts=[];
  class Hls{
    static Events={MANIFEST_PARSED:'manifest',LEVEL_LOADED:'level',ERROR:'error'};static ErrorTypes={NETWORK_ERROR:'network',MEDIA_ERROR:'media'};static isSupported(){return true;}
    static ErrorDetails={BUFFER_SEEK_OVER_HOLE:'bufferSeekOverHole'};
    constructor(config){this.config={skipBufferHolePadding:.1,...config};this.listeners={};this.startCalls=[];hlsInstances.push(this);}on(event,handler){this.listeners[event]=handler;}emit(event,data={}){this.listeners[event]?.(event,data);}loadSource(url){this.url=url;}attachMedia(video){this.video=video;}destroy(){this.destroyed=true;}startLoad(time){this.startCalls.push(time);}recoverMediaError(){this.recovered=true;}
  }
  const timers=new Map(),requests=[],storage=new Map([['cinema-history',JSON.stringify(savedTime?{abc:{index:0,time:savedTime,duration:1800}}:{})]]);let timerId=0;
  const response=body=>({ok:true,status:200,json:async()=>body});
  const windowMock={Hls:preloadHls?Hls:null,addEventListener(){},scrollTo(){}};
  const documentMock=Object.assign(new Element('document'),{
    querySelector:selector=>selector==='dialog[open]:not(#player-dialog)'?(nodes.settings.open?nodes.settings:null):nodes[selector.slice(1)],
    querySelectorAll:()=>[],createTextNode:()=>({}),createElement:name=>new Element(name),head:{append:script=>scripts.push(script)},body:{classList:{remove(){},add(){}}},
  });
  const context=vm.createContext({console,performance:{now:()=>observedAt},queueMicrotask,URL,URLSearchParams,AbortSignal,DOMException,Date,Promise,Map,Set,Math,Number,String,Array,Object,JSON,RegExp,Error,FormData:class{},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},window:windowMock,document:documentMock,updateHTML:(element,value)=>element.innerHTML=value,updateKeyedList:(element,entries)=>element.innerHTML=entries.map(entry=>entry.html()).join(''),createEnrichment:()=>({fileChanged(){},detachTrack(){},remember(){},metadata(){},poster(){return '';},sceneTrackIdentity:()=>7}),createDiscoveryUI:()=>({render(){},invalidateHash(){}}),createPluginBrowser:()=>({invalidateHash(){}}),createEpisodesUI:()=>({invalidateHash(){}}),fetch:async(url,options={})=>{const request={url,...options,data:options.body?JSON.parse(options.body):undefined};requests.push(request);const value=await fetchImpl(request);return value?.ok!==undefined?value:response(value);},
    playbackMap,readTimeRanges,readyToSeek,createPlaybackRunway,createReleaseObservation,
    firstPictureDuration,isOpeningBufferAlignment,sourceMemoryCohorts,sourceMemoryLabel,
    crypto:globalThis.crypto,createWatchedRuntime,WATCHED_ENABLED,WATCHED_STORE,
    createWatchedDialogueUI:()=>({refreshCollection(){},invalidate(){},closePlayer(){},closeSearch(){},
      mode:()=>'titles',setMode(){},focusSearch(){},openCatchUp(){}}),
    createPlaybackInsightsUI:()=>({update:value=>insightUpdates.push(value)}),createSoundMap:settings=>{soundControls=settings;return {trackChanged(){},refresh(){}};},
    createTwoTrackStudio:settings=>{studioControls=settings;return {primaryChanged(){},refresh(){}};},
    createSceneSketchbook:()=>({refresh(){},reset(){},recheckCoverage(){}}),
    createScenePreviewUI:()=>({refresh(){},revalidateEntry(){},reset(){previewResets.push(observedAt);},escape(){return false;},
      attachmentKey:()=>null,canCheckAt:()=>false,checkAt:()=>false}),
    samePlaybackSession,portableSceneIdentity,createRescueFlow,createFastStartFlow,previewFastStart,
    createRescueUI:()=>({update(){},updateFastStart(){}}),createEditionAtlasUI:()=>({refresh(){}}),createWarmPlaybackUI:()=>({update(){}}),createWarmPlayback:settings=>createWarmPlayback({
      ...settings,schedule:callback=>{timers.set(++timerId,callback);return timerId;},cancel:id=>timers.delete(id),
    }),createSceneRelay:()=>({refresh:()=>[],focusPin(){}}),createPlaybackMap:()=>({reset(){},update(){}}),requestAnimationFrame:callback=>{queueMicrotask(callback);return 1;}});
  vm.runInContext(script,context);const api=context.playerTest;api.setActive({hash:'abc',index:null,files:[{index:0,name:'Test.mkv',size:1024}],url:null,intent:{episodeId:'ep-2'},resumed:false});
  async function timer(){const [id,fn]=timers.entries().next().value||[];assert.ok(fn,'A follow-up poll should be scheduled');timers.delete(id);await fn();await tick();}
  function present(width,height,frame={}){
    const frames=[...frameCallbacks.values()];frameCallbacks.clear();
    Object.assign(nodes.video,{videoWidth:width,videoHeight:height});
    for(const callback of frames)callback(observedAt,{presentationTime:observedAt,...frame});
  }
  return {api,nodes,hlsInstances,requests,timers,timer,storage,scripts,frameCallbacks,insightUpdates,previewResets,present,soundControls,studioControls,document:documentMock,setNow:value=>{observedAt=value;},completeHls(){windowMock.Hls=Hls;scripts.at(-1).onload();}};
}
const ready=(changes={})=>({status:'ready',mode:'hls',url:'/hls/test/same-run/index.m3u8',progress:.01,availableDuration:24,duration:1800,complete:false,bufferProgress:1,...changes});

test('the real player invalidates a scene preview on connection loss, reconnect and file selection',async()=>{
  const h=harness({fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:.05})});
  h.api.setConnection(true);
  await h.api.selectFile();
  const initial=h.previewResets.length;
  h.api.setConnection(false);
  assert.equal(h.previewResets.length,initial+1);
  h.api.setConnection(true);
  const connected=h.previewResets.length;
  await h.api.reconnectPlayback();
  assert(h.previewResets.length>connected);
  const reconnected=h.previewResets.length;
  await h.api.selectFile();
  assert(h.previewResets.length>reconnected);
});

test('the preview POST is never replayed on a token rejection and reports a timeout while reading the clip',async()=>{
  let sessions=0,posts=0;
  const h=harness({fetchImpl:({url})=>{
    if(url==='/api/session')return {token:`token-${++sessions}`};
    assert.equal(url,'/api/scene-preview');
    if(++posts===1)return {ok:false,status:403};
    return {ok:true,status:200,headers:new Map([['Content-Type','video/mp4'],['Content-Length','1024'],['X-Cinema-Scene-Seek','0.4']]),
      blob:async()=>{throw new DOMException('Deadline exceeded','TimeoutError');}};
  }});
  const source={hash:'abc',index:0,sessionId:'session'};
  await assert.rejects(h.api.requestScenePreview(source,1000,new AbortController().signal),/Check the preview again/);
  assert.equal(sessions,1);assert.equal(posts,1);
  await assert.rejects(h.api.requestScenePreview(source,1000,new AbortController().signal),/preview took too long/);
  assert.equal(sessions,2);assert.equal(posts,2);
});

test('opening waits past metadata and playing for an exact submitted first picture',async()=>{
  const h=harness({fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});
  await h.api.selectFile();
  const cover=h.nodes['player-placeholder'],video=h.nodes.video;
  video.readyState=3;
  video.emit('loadedmetadata');
  video.emit('playing');
  assert.equal(cover.hidden,false);
  assert.equal(h.nodes['playback-status'].textContent,'Starting the picture');
  h.present(320,180,{mediaTime:.04,presentedFrames:1});
  assert.equal(cover.hidden,true);
  assert.equal(h.nodes['playback-status'].textContent,'Now playing');
  await h.api.reconnectPlayback();
  assert.equal(cover.hidden,true,'A reconnect cannot bring back a completed opener');
});

test('opening ignores an old attachment frame and covers a saved position until it lands',async()=>{
  const h=harness({savedTime:900,fetchImpl:()=>ready()});
  await h.api.selectFile();
  const old=[...h.frameCallbacks.values()][0];
  await h.api.selectFile();
  const cover=h.nodes['player-placeholder'],video=h.nodes.video;
  Object.assign(video,{readyState:3,videoWidth:320,videoHeight:180});
  old(100,{mediaTime:.04,presentedFrames:1});
  assert.equal(cover.hidden,false);
  h.present(320,180,{mediaTime:.04,presentedFrames:1});
  assert.equal(cover.hidden,false);
  assert.equal(h.nodes['resume-choice'].hidden,false);
  h.hlsInstances.at(-1).emit('level',{details:{fragments:[{start:896,duration:8}]}});
  h.nodes['resume-saved'].onclick();
  video.emit('seeked');
  h.present(320,180,{mediaTime:900.04,presentedFrames:2});
  assert.equal(cover.hidden,true);
});

test('opening offers manual Play after autoplay refusal and moves focus only on reveal',async()=>{
  const h=harness({rejectAutoplay:true,fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});
  await h.api.selectFile();await tick();
  const cover=h.nodes['player-placeholder'],play=h.nodes['player-opening-play'],video=h.nodes.video;
  assert.equal(cover.hidden,false);
  assert.equal(play.hidden,false);
  video.readyState=2;
  h.present(320,180,{mediaTime:0,presentedFrames:1});
  assert.equal(cover.hidden,false,'A paused decode cannot remove the manual Play action');
  play.focus();play.onclick();
  assert.equal(video.playCalls,2);
  video.readyState=3;video.emit('playing');
  assert.equal(h.document.activeElement,play);
  h.present(320,180,{mediaTime:.04,presentedFrames:1});
  assert.equal(cover.hidden,true);
  assert.equal(h.document.activeElement,video);
});

test('opening can recover from an absent frame callback after actual decoded playback advances',async()=>{
  const h=harness({fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});
  await h.api.selectFile();
  const cover=h.nodes['player-placeholder'],video=h.nodes.video;
  Object.assign(video,{readyState:3,videoWidth:320,videoHeight:180,currentTime:.2});
  video.emit('playing');video.emit('timeupdate');
  assert.equal(cover.hidden,false);
  video.currentTime=.27;video.emit('timeupdate');
  assert.equal(cover.hidden,true);
  const decoded=harness({fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});
  decoded.nodes.video.requestVideoFrameCallback=undefined;
  await decoded.api.selectFile();
  Object.assign(decoded.nodes.video,{readyState:2,videoWidth:320,videoHeight:180});
  decoded.nodes.video.emit('loadeddata');
  assert.equal(decoded.nodes['player-placeholder'].hidden,true);
});

async function memoryPlayer({mode='direct',rejectAutoplay=false,grant=true}={}){
  const memoryView={enabled:true,available:true,revision:'memory-revision',version:1,observed:[]};
  const initial=ready({hash:'abc',index:0,fileName:'Test.mkv',sessionId:'session-1',mode,
    ...(mode==='direct'?{url:'/stream?hash=abc&index=0',progress:1,complete:true}:{})});
  const memoryStart={size:1024,revision:memoryView.revision};
  let state=initial;
  const h=harness({rejectAutoplay,fetchImpl:request=>{
    if(request.url==='/api/state')return {connected:true,sourceMemory:memoryView};
    if(request.url==='/api/source-memory')return {accepted:false};
    if(request.url==='/api/prepare'&&grant&&state===initial)return {...state,memoryStart};
    return state;
  }});
  const video=h.nodes.video;
  const player=h.nodes['player-dialog'];
  h.api.setConnection(true);
  h.api.acceptSourceMemory(memoryView);
  player.showModal();
  h.setNow(100);
  await h.api.selectFile(false,false,true);
  assert.equal(h.requests.find(request=>request.url==='/api/prepare')?.data.rememberStart,true);
  if(mode==='hls')h.hlsInstances[0].emit('manifest');
  video.readyState=4;
  const frame={mediaTime:.129222,presentedFrames:1};
  return {h,video,frame,initial,memoryView,setState:value=>{state=value;},
    records:()=>h.requests.filter(request=>request.url==='/api/source-memory'&&request.data.action==='record').map(request=>request.data),
    playing:at=>{h.setNow(at);video.emit('playing');},
    picture:at=>{h.setNow(at);h.present(160,90,{...frame,presentationTime:at-5});}};
}

test('Source Memory reports one exact first picture with either native event order',async t=>{
  for(const first of ['playing','picture']){
    await t.test(first+' first',async()=>{
      const m=await memoryPlayer();
      const replay=[...m.h.frameCallbacks.values()][0];
      m[first](500);
      assert.deepEqual(m.records(),[]);
      m[first==='playing'?'picture':'playing'](550);
      assert.deepEqual(m.records(),[{action:'record',hash:'abc',index:0,sessionId:'session-1',
        revision:m.memoryView.revision,firstPictureMs:first==='playing'?445:395}]);
      replay(560,{...m.frame,presentationTime:555,presentedFrames:2});
      m.playing(570);
      assert.equal(m.records().length,1);
    });
  }
});

test('Source Memory rechecks picture dimensions and opening position when playing follows the frame',async t=>{
  for(const [name,media,expected] of [
    ['still displaying the opening',{},1],
    ['zero width',{videoWidth:0},0],
    ['zero height',{videoHeight:0},0],
    ['invalid dimensions',{videoWidth:NaN},0],
    ['past the opening',{currentTime:1.251},0],
    ['before the opening',{currentTime:-.01},0],
    ['unknown position',{currentTime:NaN},0],
  ]){
    await t.test(name,async()=>{
      const m=await memoryPlayer();
      m.picture(500);
      assert.deepEqual(m.records(),[]);
      Object.assign(m.video,{currentTime:.2},media);
      m.playing(550);
      assert.equal(m.records().length,expected);
      if(expected)assert.equal(m.records()[0].firstPictureMs,395);
      Object.assign(m.video,{videoWidth:160,videoHeight:90,currentTime:.2});
      m.playing(600);
      assert.equal(m.records().length,expected);
    });
  }
});

function openingSeek(m,{announced=false,landAt=.146222}={}){
  const {h,video}=m;
  Object.assign(video,{buffered:ranges([[.046222,4]]),currentTime:.146222,seeking:true});
  if(announced)h.hlsInstances[0].emit('error',{details:'bufferSeekOverHole',fatal:false});
  video.currentTime=landAt;
  video.emit('seeking');
  video.seeking=false;
  video.emit('seeked');
}

test('Source Memory accepts only one exact engine-marked opening HLS seek',async t=>{
  for(const [name,boundary,expected] of [
    ['engine alignment',m=>openingSeek(m,{announced:true}),1],
    ['manual seek to the same near-zero target',m=>openingSeek(m),0],
    ['engine marked a different target',m=>openingSeek(m,{announced:true,landAt:.147}),0],
    ['a second marked seek',m=>{openingSeek(m,{announced:true});openingSeek(m,{announced:true});},0],
    ['video input followed by engine alignment',m=>{m.video.emit('keydown');openingSeek(m,{announced:true});},0],
  ]){
    await t.test(name,async()=>{
      const m=await memoryPlayer({mode:'hls'});
      boundary(m);
      m.playing(500);
      m.picture(550);
      assert.equal(m.records().length,expected);
    });
  }
});

test('Source Memory stays canceled when a foreground playback boundary is reversed',async t=>{
  for(const [name,interrupt] of [
    ['pause then manual play',async m=>{m.playing(450);m.video.pause();await m.video.play();}],
    ['speed change then normal speed',m=>{
      m.playing(450);
      m.video.playbackRate=2;
      m.video.emit('ratechange');
      m.video.playbackRate=1;
      m.video.emit('ratechange');
    }],
    ['hide then reveal the app',async m=>{
      m.playing(450);
      m.h.document.hidden=true;
      m.h.document.emit('visibilitychange');
      m.h.document.hidden=false;
      m.h.document.emit('visibilitychange');
      await tick();
    }],
    ['first picture behind a modal',m=>{m.h.nodes.settings.showModal();m.picture(450);m.h.nodes.settings.close();}],
    ['playing behind a modal',m=>{m.h.nodes.settings.showModal();m.playing(450);m.h.nodes.settings.close();}],
  ]){
    await t.test(name,async()=>{
      const m=await memoryPlayer();
      await interrupt(m);
      m.playing(500);
      m.picture(550);
      assert.deepEqual(m.records(),[]);
    });
  }
});

test('Source Memory ignores stale preparations and replacement attachments',async t=>{
  for(const [name,invalidate] of [
    ['a changed session ID even after the original returns',m=>{
      const generation=m.h.api.getGeneration();
      m.h.api.renderPlayback({...m.initial,sessionId:'session-2'},generation);
      m.h.api.renderPlayback(m.initial,generation);
    }],
    ['an explicit reconnect to the same file',async m=>{m.h.api.retryPlayback();await tick();}],
    ['a retargeted file and a queued old frame',async m=>{
      const replay=[...m.h.frameCallbacks.values()][0];
      m.h.api.getActive().files.push({index:1,name:'Second.mkv',size:2048});
      m.h.nodes['file-select'].value='1';
      m.setState({...m.initial,index:1,fileName:'Second.mkv',sessionId:'session-2',url:'/stream?hash=abc&index=1'});
      await m.h.api.selectFile(false,false,true);
      assert.equal(m.h.requests.filter(request=>request.url==='/api/prepare').at(-1).data.rememberStart,undefined);
      replay(490,{...m.frame,presentationTime:485});
    }],
    ['a disconnected then reconnected engine',m=>{
      m.h.api.setConnection(false);
      m.h.api.setConnection(true);
      m.h.api.acceptSourceMemory(m.memoryView);
    }],
  ]){
    await t.test(name,async()=>{
      const m=await memoryPlayer();
      m.playing(450);
      await invalidate(m);
      m.video.readyState=4;
      m.playing(500);
      m.picture(550);
      assert.deepEqual(m.records(),[]);
    });
  }
});

test('Source Memory requires an admitted automatic start',async t=>{
  await t.test('missing prepare admission',async()=>{
    const m=await memoryPlayer({grant:false});
    m.playing(500);
    m.picture(550);
    assert.deepEqual(m.records(),[]);
  });
  await t.test('autoplay refused, then manual play succeeds',async()=>{
    const m=await memoryPlayer({rejectAutoplay:true});
    assert.equal(m.h.api.getActive().autoplayBlocked,true);
    await m.video.play();
    m.playing(500);
    m.picture(550);
    assert.deepEqual(m.records(),[]);
  });
});

test('Caption tools cannot seek into an unprepared HLS range or a stale caption revision',async()=>{
  const h=harness({fetchImpl:()=>ready({availableDuration:8})}),state=ready({availableDuration:8});
  h.api.setActive({...h.api.getActive(),index:0,url:state.url,mode:'hls',resumed:true,sourceComplete:false,
    manifestRanges:[[0,8]],backendState:state});
  Object.assign(h.nodes.video,{currentTime:1,readyState:2,seekable:ranges([[0,8]])});
  assert.equal(h.soundControls.canSeekScene(3),true);
  assert.equal(h.soundControls.canSeekScene(20),false);
  assert.equal(await h.soundControls.seekScene(20,7),false);
  assert.equal(await h.soundControls.seekScene(3,6),false);
  assert.equal(h.studioControls.canSeekScene(3),true);
  assert.equal(h.studioControls.canSeekScene(20),false);
  assert.equal(await h.studioControls.seekScene(20,7),false);
  assert.equal(await h.studioControls.seekScene(3,6),false);
  assert.equal(h.nodes.video.currentTime,1);
  assert.equal(h.nodes.video.paused,true);
  assert.deepEqual(h.requests,[]);
});
test('uncertain preparation timeout keeps polling and attaches the accepted stream',async()=>{
  let failed=false;const h=harness({fetchImpl:request=>{if(request.url==='/api/prepare'&&!failed){failed=true;throw new DOMException('Timed out','TimeoutError');}return ready();}});await h.api.selectFile();assert.equal(h.hlsInstances.length,0);assert.match(h.nodes['playback-status'].textContent,/may still be running/);await h.timer();assert.equal(h.hlsInstances.length,1);assert.equal(h.api.getActive().url,ready().url);assert.equal(h.requests.filter(r=>r.url==='/api/prepare').length,1);
});
test('native network error and manual reconnect reuse the same HLS run without restarting preparation',async()=>{
  const h=harness({fetchImpl:()=>ready()});await h.api.selectFile();const initial=h.hlsInstances[0];h.nodes.video.error={code:2};h.nodes.video.emit('error');await tick();assert.equal(initial.destroyed,true);assert.equal(h.hlsInstances.length,2);assert.equal(h.hlsInstances[1].url,initial.url);assert.equal(h.requests.filter(r=>r.url==='/api/prepare').length,1);h.api.retryPlayback();await tick();assert.equal(h.requests.filter(r=>r.url==='/api/prepare').length,1);assert.equal(h.api.getActive().intent.episodeId,'ep-2');
});
test('HLS resumes only inside its prepared timeline and preserves history while waiting',async()=>{
  const h=harness({savedTime:900,fetchImpl:()=>ready()});await h.api.selectFile();assert.equal(h.api.getActive().resumePending,true);assert.equal(h.hlsInstances[0].config.startPosition,0);h.hlsInstances[0].emit('manifest');h.nodes.video.emit('loadedmetadata');assert.equal(h.nodes.video.playCalls,0);assert.equal(h.nodes.video.currentTime,0);assert.equal(h.nodes['resume-saved'].disabled,true);h.nodes.video.currentTime=2;h.api.getActive().hasPlayed=true;h.api.saveProgress();assert.equal(h.api.getHistory().abc.time,900);h.hlsInstances[0].emit('level',{details:{fragments:[{start:896,duration:8}]}});assert.equal(h.nodes['resume-saved'].disabled,false);h.nodes['resume-saved'].onclick();assert.equal(h.nodes.video.currentTime,900);assert.equal(h.nodes.video.playCalls,1);
});
test('incomplete direct files cannot automatically seek to an unbuffered saved position',async()=>{
  const h=harness({savedTime:900,fetchImpl:()=>ready({mode:'direct',url:'/stream?hash=abc&index=0',availableDuration:undefined})});await h.api.selectFile();h.nodes.video.emit('loadedmetadata');assert.equal(h.api.getActive().resumePending,true);assert.equal(h.nodes.video.currentTime,0);assert.equal(h.nodes.video.playCalls,0);h.nodes.video.buffered=ranges([[890,920]]);h.nodes.video.emit('progress');assert.equal(h.nodes['resume-saved'].disabled,false);h.nodes['resume-saved'].onclick();assert.equal(h.nodes.video.currentTime,900);
});
test('explicit beginning choice starts immediately; completed direct files retain normal resume',async()=>{
  const h=harness({savedTime:900,fetchImpl:()=>ready()});await h.api.selectFile();h.nodes['resume-beginning'].onclick();assert.equal(h.api.getActive().resumePending,false);assert.equal(h.nodes.video.currentTime,0);assert.equal(h.nodes.video.playCalls,1);h.nodes.video.emit('playing');h.nodes.video.currentTime=3;h.api.saveProgress();assert.equal(h.api.getHistory().abc.time,3);
  const full=harness({savedTime:900,fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});await full.api.selectFile();full.nodes.video.emit('loadedmetadata');assert.equal(full.api.getActive().resumePending,false);assert.equal(full.nodes.video.currentTime,900);assert.equal(full.nodes.video.playCalls,1);
});
test('download completion alone cannot mark an unfinished HLS movie watched to its end',async()=>{
  const h=harness({fetchImpl:()=>ready({progress:1,complete:false})});await h.api.selectFile();h.nodes.video.emit('ended');assert.equal(h.api.getActive().ended,false);assert.match(h.nodes['playback-status'].textContent,/Waiting for the next/);
});
test('confirmed external removal clears the dock and stale source link but offline state does not',async()=>{
  const h=harness({fetchImpl:()=>ready()});await h.api.selectFile();h.api.knownLibraryHashes.add('abc');h.api.additions.set('key',{id:'op',hash:'abc',status:'ready'});h.api.reconcileLibraryPresence({connected:false,library:[]});assert.ok(h.api.getActive());assert.ok(h.api.additions.has('key'));h.api.reconcileLibraryPresence({connected:true,library:[]});assert.equal(h.api.getActive(),null);assert.equal(h.nodes['player-dock'].hidden,true);assert.equal(h.api.additions.has('key'),false);
});
test('missing episode metadata requests manual file selection without removing its existing torrent',async()=>{
  const h=harness({fetchImpl:request=>request.url.startsWith('/api/files?')?[{index:0,name:'Show.S01E02.mkv',size:1024,playable:true}]:{ok:false,status:404,json:async()=>({error:'Episode metadata was not found.'})}});await h.api.loadPlaybackFiles(h.api.getGeneration());assert.equal(h.api.getActive().hash,'abc');assert.equal(h.nodes['file-select'].value,'');assert.equal(h.nodes['player-options'].open,true);assert.match(h.nodes['playback-status'].textContent,/episode could not be verified/);assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,0);
});
test('HLS is loaded on demand once, and a delayed script cannot attach after switching to direct playback',async()=>{
  const h=harness({preloadHls:false,fetchImpl:request=>{
    const index=request.data?.index??Number(new URL(request.url,'http://localhost').searchParams.get('index'));
    return index===1?ready({mode:'direct',url:'/stream?index=1',progress:1}):ready();
  }});
  assert.doesNotMatch(html,/<script[^>]+src="\/vendor\/hls\.js"/);
  h.api.getActive().files.push({index:1,name:'Episode two.mp4',size:1024});
  assert.equal(h.scripts.length,0);
  await h.api.selectFile();
  assert.equal(h.scripts.length,1);
  await h.api.pollPlayback(h.api.getGeneration());
  assert.equal(h.scripts.length,1);
  h.nodes['file-select'].value='1';
  await h.api.selectFile();
  h.completeHls();
  await tick();
  assert.equal(h.hlsInstances.length,0);
  assert.equal(h.nodes.video.src,'/stream?index=1');
});
test('decoder loss at an unfinished HLS edge waits, then reconnects to the same run near the interrupted position',async()=>{
  let prepared=12;
  const h=harness({fetchImpl:()=>ready({availableDuration:prepared})});
  await h.api.selectFile();
  const original=h.hlsInstances[0];
  h.nodes.video.emit('playing');
  h.nodes.video.currentTime=12;
  h.nodes.video.emit('timeupdate');
  h.nodes.video.error={code:4};
  h.nodes.video.emit('error');
  await tick();
  assert.equal(h.hlsInstances.length,1);
  assert.match(h.nodes['playback-status'].textContent,/Waiting for enough prepared video/);
  prepared=52;
  await h.api.pollPlayback(h.api.getGeneration());
  await tick();
  assert.equal(original.destroyed,true);
  assert.equal(h.hlsInstances.length,2);
  assert.equal(h.hlsInstances[1].url,original.url);
  assert.equal(h.hlsInstances[1].config.startPosition,11.25);
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,1);
});
test('continue watching keeps independent positions for two episodes in one season pack',async()=>{
  const h=harness({savedTime:75,fetchImpl:()=>ready({mode:'direct',url:'/stream',progress:1})});
  h.api.getActive().files=[{index:0,name:'Series.S01E01.mp4'},{index:1,name:'Series.S01E02.mp4'}];
  await h.api.selectFile();
  h.nodes.video.emit('playing');
  h.nodes.video.currentTime=125;h.api.saveProgress();
  h.nodes['file-select'].value='1';
  await h.api.selectFile();
  h.nodes.video.emit('playing');
  h.nodes.video.currentTime=43;h.api.saveProgress();
  assert.equal(h.api.watchRecord('abc',0).time,125);
  assert.equal(h.api.watchRecord('abc',1).time,43);
  h.api.setLibrary([{hash:'abc',title:'Series',name:'Series.S01.mkv'}]);
  h.nodes['search-results'].hidden=true;
  h.api.renderContinueWatching();
  assert.match(h.nodes['continue-list'].innerHTML,/data-play-index="0"/);
  assert.match(h.nodes['continue-list'].innerHTML,/data-play-index="1"/);
});
test('a delayed source becomes available without replacing a different title selected for playback',async()=>{
  const h=harness({fetchImpl:request=>{
    if(request.url==='/api/add')return {id:'pending',status:'accepted',selectionKey:'first'};
    if(request.url.startsWith('/api/files'))return [{index:0,name:'Other.mp4',size:100,playable:true}];
    return ready({mode:'direct',url:'/stream',progress:1});
  }});
  await h.api.addSource('first','movies');
  await h.api.openPlayer('second');
  h.api.setOperations([{id:'pending',status:'ready',selectionKey:'first',hash:'first-hash'}]);
  await h.api.reconcileOperations();
  assert.equal(h.api.getActive().hash,'second');
  assert.equal(h.api.additions.get('first').hash,'first-hash');
  assert.match(h.nodes.notice.textContent,/ready in Downloads/);
});

test('passport uses real presentation and uninterrupted generation for exact-file browser observations',async()=>{
  const h=harness({fetchImpl:request=>ready({
    mode:'direct',url:'/stream?hash=abc&index='+String(request.data?.index??new URL(request.url,'http://localhost').searchParams.get('index')??0),
    hash:'abc',index:0,probeFacts:{videoCodec:'h264',audioCodec:'aac',width:1920,height:1080}
  })});
  const video=h.nodes.video,passport=()=>h.insightUpdates.at(-1)?.passport;
  await h.api.selectFile();
  const first=[...h.frameCallbacks.values()][0];
  assert.equal(typeof first,'function');
  h.setNow(300);video.readyState=2;video.emit('waiting');await tick();
  assert.equal(passport().firstPictureMs,null);
  h.setNow(950);video.readyState=3;video.emit('playing');h.present(1920,1080);await tick();
  assert.equal(passport().firstPictureMs,950);
  assert.equal(passport().picture.width,1920);
  assert.equal(passport().probe.videoCodec,'h264');
  assert.equal(passport().stalls.count,0);

  h.setNow(1500);video.readyState=2;video.emit('waiting');
  h.setNow(2300);video.emit('timeupdate');await tick();
  assert.equal(passport().stalls.count,1);
  assert.equal(passport().stalls.waiting,true);
  h.setNow(2420);video.readyState=3;video.emit('playing');await tick();
  assert.equal(passport().stalls.totalMs,920);

  h.setNow(3000);video.seeking=true;video.readyState=2;video.emit('seeking');video.emit('waiting');
  h.setNow(3900);video.seeking=false;video.readyState=3;video.emit('seeked');video.emit('playing');await tick();
  assert.equal(passport().stalls.count,1);

  h.api.getActive().files.push({index:1,name:'Second.mkv',size:1024});
  h.nodes['file-select'].value='1';
  await h.api.selectFile();
  first(3999,{presentationTime:3999});
  await tick();
  assert.equal(passport().fileName,'Second.mkv');
  assert.equal(passport().probe,null,'Backend facts for the previous index must not carry over');
  assert.equal(passport().picture,null,'A stale frame callback must not carry over');
  assert.equal(passport().stalls.count,0);
});

test('warm playback mounts existing states and a fallback decoder error cannot prepare a new converter',async()=>{
  const a=ready({hash:'abc',index:0,sessionId:'original'});
  const b=ready({hash:'def',index:1,sessionId:'fallback',mode:'direct',url:'/stream?hash=def&index=1',progress:1,complete:true});
  const option={hash:b.hash,index:b.index,sessionId:b.sessionId,fileName:'Ready.mp4',mode:b.mode};
  const attach=(state,name)=>({state,file:{index:state.index,name,size:1024,progress:state.progress,playable:true}});
  const h=harness({fetchImpl:request=>{
    if(request.url.includes('/warm/options?'))return {options:[option]};
    if(request.data?.action==='switch')return {lease:{ticket:'warm',expiresAt:Date.now()+75000,phase:'ready',
      hash:a.hash,index:a.index,sessionId:a.sessionId,url:a.url},attachment:attach(b,'Ready.mp4')};
    if(request.data?.action==='return')return {attachment:attach(a,'Test.mkv')};
    return a;
  }});
  await h.api.selectFile();
  const video=h.nodes.video;
  h.api.getActive().resumed=true;
  h.api.getActive().hasPlayed=true;
  h.api.getActive().manifestRanges=[[0,24]];
  video.currentTime=6;video.readyState=4;video.paused=false;
  video.buffered=ranges([[0,24]]);video.seekable=ranges([[0,24]]);
  await h.api.warmFlow.options();
  await h.api.warmFlow.switchTo(option);
  assert.equal(h.api.getActive().hash,'def');
  assert.equal(h.api.getActive().preparedOnly.fallback,true);
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,1);

  video.currentTime=5;video.readyState=4;video.emit('playing');video.error={code:3};video.emit('error');
  await tick();
  assert.equal(h.api.getActive().failed,true);
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,1);
  assert.equal(h.api.getHistory().def.files[1].time,5);

  video.error=null;
  await h.api.warmFlow.returnToParked();
  assert.equal(h.api.getActive().hash,'abc');
  assert.equal(h.api.getActive().preparedOnly.sessionId,'original');
  assert.equal(h.api.getActive().resumeTarget,6);
  assert.equal(h.api.getActive().resumeVerified,true);
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,1);
});

test('an explicit background rescue download never prepares or replaces the active file',async()=>{
  const h=harness({fetchImpl:request=>{
    if(request.url==='/api/add')return {id:'rescue-download',status:'accepted',selectionKey:'rescue'};
    return {connected:true,library:[],operations:[]};
  }});
  const original=h.api.getActive();
  await h.api.addSource('rescue','tv',true,{showId:'1',episodeId:'2'},{background:true});
  assert.deepEqual(h.requests.find(request=>request.url==='/api/add').data,
    {key:'rescue',category:'tv',allowDuplicate:true});
  h.api.setOperations([{id:'rescue-download',status:'ready',selectionKey:'rescue',hash:'replacement'}]);
  await h.api.reconcileOperations();
  assert.equal(h.api.getActive(),original);
  assert.equal(h.api.additions.get('rescue').hash,'replacement');
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,0);
});

test('a mapped rescue stays paused at the decoded target, and a failure offers the original',async()=>{
  const h=harness({fetchImpl:()=>({})});
  const attachment={
    file:{index:0,name:'Replacement.mp4',size:1024,progress:1,playable:true},
    state:ready({hash:'replacement',index:0,sessionId:'checked',mode:'direct',url:'/stream?hash=replacement&index=0',progress:1,duration:20}),
  };
  await h.api.openPlayer('replacement',null,0,{attachment,context:{position:19,positionVerified:true,paused:true,
    rescueOriginal:{hash:'abc',index:0}}});
  const video=h.nodes.video;
  video.duration=20;video.readyState=1;video.emit('loadedmetadata');
  assert.equal(video.currentTime,19);
  assert.equal(h.api.getActive().rescueSeekPending,true);
  assert.equal(video.playCalls,0);
  video.readyState=3;video.emit('seeked');
  assert.equal(h.api.getActive().rescueSeekPending,false);
  assert.equal(video.playCalls,0);
  assert.match(h.nodes['playback-status'].textContent,/Paused at your scene/);
  video.error={code:3};video.emit('error');
  assert.equal(h.nodes['rescue-reopen'].hidden,false);
  assert.equal(h.requests.filter(request=>request.url==='/api/prepare').length,0);
});

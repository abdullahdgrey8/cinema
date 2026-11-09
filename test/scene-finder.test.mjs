import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEnrichment} from '../public/enrichment.js';
import {createSceneFinder,findDialogue,indexDialogue,lastDialogue} from '../public/scene-finder.js';

const cue=(startTime,endTime,text)=>({startTime,endTime,text});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

class Element extends EventTarget{
  children=[];
  disabled=false;
  hidden=false;
  open=true;
  textContent='';
  value='';
  focused=false;
  nodes=new Map();
  querySelector(key){
    if(!this.nodes.has(key))this.nodes.set(key,new Element());
    return this.nodes.get(key);
  }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  remove(){this.removed=true;}
  focus(){this.focused=true;}
  emit(type,fields={}){const event=Object.assign(new Event(type,{cancelable:true}),fields);this.dispatchEvent(event);return event;}
}

function mockDocument(t){
  const previous=globalThis.document;
  const document=new Element();
  document.createElement=tag=>{
    const element=new Element();
    if(tag==='track')element.track={cues:[],mode:'disabled'};
    return element;
  };
  globalThis.document=document;
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  return document;
}

function fixture(t,cues){
  mockDocument(t);
  const panel=new Element(),host=new Element(),video=new Element();
  const queries=key=>host.querySelector(key==='input'?key:'[data-scene-'+key+']');
  const button=(index=0)=>queries('matches').children[index].children[0];
  const seeks=[],previews=[],captions=[];
  let ready=()=>true,land=async()=>true,previewable=()=>false,previewStarted=true;
  let attachmentKey='film:0:ticket-1';
  let track={revision:1,cues,status:'ready',hasFile:true,fileKey:'film:0'};
  const view=createSceneFinder({
    panel,host,video,getTrack:()=>track,canSeekScene:seconds=>ready(seconds),
    seekScene:(seconds,revision)=>{seeks.push([seconds,revision]);return land();},
    canPreviewScene:seconds=>previewable(seconds),previewScene:(seconds,options)=>{previews.push([seconds,options]);return previewStarted;},
    previewAttachmentKey:()=>attachmentKey,
    replayCaption:(caption,revision)=>captions.push([caption,revision]),formatTime:seconds=>'t='+seconds,openSubtitles(){},
  });
  panel.emit('toggle');
  return {
    panel,video,view,queries,button,seeks,previews,captions,setReady:fn=>{ready=fn;},setLanding:fn=>{land=fn;},
    setPreviewable:fn=>{previewable=fn;},setPreviewStarted:value=>{previewStarted=value;},
    setAttachmentKey:value=>{attachmentKey=value;},
    replaceTrack:newCues=>{track={...track,revision:track.revision+1,cues:newCues};view.trackChanged();},
    search:value=>{queries('input').value=value;queries('search').emit('submit');},
  };
}

test('dialogue matches normalize text, allow adjacent cue boundaries, and skip long gaps',()=>{
  const index=indexDialogue([
    cue(13,14,'there tomorrow'),cue(0,1,'It’s déjà vu.'),cue(5,6,'Meet me'),
    cue(6.2,7,'outside, please.'),cue(9,10,'I’ll see you'),cue(1,0,'Invalid time'),cue(12,13,''),
  ]);
  assert.deepEqual(findDialogue(index,'ITS DEJA VU').map(row=>row.startTime),[0]);
  assert.deepEqual(findDialogue(index,'me OUTSIDE please'),[cue(5,6,'Meet me outside, please.')]);
  assert.deepEqual(findDialogue(index,'you there tomorrow'),[]);
  assert.deepEqual(findDialogue(index,'!!!'),[]);
  assert.equal(lastDialogue(index,-1),null);
  assert.equal(lastDialogue(index,6.1).startTime,5);
  assert.equal(lastDialogue(index,6.2).startTime,6.2);
});

test('scene matches paginate and Arrow Down focuses a playable match; readiness is rechecked on activation',async t=>{
  const f=fixture(t,Array.from({length:11},(_,i)=>cue(i+1,i+1.75,'One moment')));
  f.setReady(seconds=>seconds>1);
  f.search('one moment');
  assert.equal(f.queries('matches').children.length,8);
  assert.equal(f.button(0).disabled,true);
  assert.equal(f.queries('input').emit('keydown',{key:'ArrowDown'}).defaultPrevented,true);
  assert.equal(f.button(1).focused,true);
  f.setReady(()=>false);
  f.button(1).emit('click');
  assert.deepEqual(f.seeks,[]);
  assert.equal(f.button(1).disabled,true);
  f.setReady(()=>true);f.view.refresh();
  f.queries('next').emit('click');
  assert.equal(f.queries('matches').children.length,3);
  assert.equal(f.queries('page').textContent,'Page 2 of 2');
  f.button().emit('click');await tick();
  assert.deepEqual(f.seeks,[[9,1]]);
  assert.equal(f.panel.open,false);
  assert.equal(f.panel.querySelector('summary').focused,true);
});

test('scene results offer a preview only on an eligible unready line',async t=>{
  const f=fixture(t,[cue(12,13,'Train stop'),cue(67.125,68,'Train station'),cue(90,91,'Train bridge')]);
  f.setReady(seconds=>seconds===12);
  f.setPreviewable(seconds=>seconds===67.125);
  f.search('train');
  assert.equal(f.button(0).children[2].textContent,'Jump');
  assert.equal(f.button(1).children[2].textContent,'Preview');
  assert.equal(f.button(2).children[2].textContent,'Not ready yet');
  assert.equal(f.button(2).disabled,true);
  f.button(2).emit('click');
  assert.deepEqual(f.previews,[]);
  f.button(1).emit('click');
  assert.deepEqual(f.seeks,[]);
  const [[seconds,options]]=f.previews;
  assert.equal(seconds,67.125);
  assert.deepEqual(Object.keys(options).sort(),['attachmentKey','opener','origin','validate']);
  assert.equal(options.attachmentKey,'film:0:ticket-1');
  assert.equal(options.origin,'dialogue');
  assert.equal(options.opener,f.button(1));
  assert.equal(options.validate(),true);
  f.button(0).emit('click');await tick();
  assert.deepEqual(f.seeks,[[12,1]]);
});

test('a change in readiness never swaps the action of the current activation',async t=>{
  const f=fixture(t,[cue(67.125,68,'Find this line')]);
  f.setReady(()=>false);f.setPreviewable(()=>true);f.search('line');
  assert.equal(f.button().children[2].textContent,'Preview');
  f.setReady(()=>true);f.button().emit('click');
  assert.deepEqual(f.seeks,[]);assert.deepEqual(f.previews,[]);
  assert.equal(f.button().children[2].textContent,'Jump');
  assert.match(f.queries('status').textContent,/Choose Jump/);
  f.setReady(()=>false);f.button().emit('click');
  assert.deepEqual(f.seeks,[]);assert.deepEqual(f.previews,[]);
  assert.equal(f.button().children[2].textContent,'Preview');
  f.setPreviewStarted(false);f.button().emit('click');
  assert.equal(f.previews.length,1);
  assert.match(f.queries('status').textContent,/again in a moment/);
  const old=f.button();f.search('other');old.emit('click');
  assert.equal(f.previews.length,1);
});

test('a row refresh during a pointer or keyboard press preserves the pressed action',t=>{
  const f=fixture(t,[cue(67.125,68,'Find this line')]);
  f.setReady(()=>false);f.setPreviewable(()=>true);f.search('line');
  f.button().emit('pointerdown',{button:0});
  f.setReady(()=>true);f.view.refresh();
  assert.equal(f.button().children[2].textContent,'Jump');
  f.button().emit('click',{detail:1});
  assert.deepEqual(f.seeks,[]);assert.deepEqual(f.previews,[]);
  assert.match(f.queries('status').textContent,/Choose Jump/);
  f.button().emit('keydown',{key:' '});
  f.setReady(()=>false);f.view.refresh();
  assert.equal(f.button().children[2].textContent,'Preview');
  f.button().emit('click',{detail:0});
  assert.deepEqual(f.seeks,[]);assert.deepEqual(f.previews,[]);
  assert.equal(f.button().emit('keydown',{key:'Enter',repeat:true}).defaultPrevented,true);
});

test('a Finder row and held gesture refuse a replacement ticket for the same file and captions',t=>{
  const f=fixture(t,[cue(67.125,68,'Find this line')]);
  f.setReady(()=>false);f.setPreviewable(()=>true);f.search('line');
  f.button().emit('click');
  assert.equal(f.previews[0][1].attachmentKey,'film:0:ticket-1');
  f.setAttachmentKey('film:0:ticket-2');
  assert.equal(f.previews[0][1].validate(),false);
  f.button().emit('click');
  assert.equal(f.previews.length,1);
  assert.match(f.queries('status').textContent,/Playback changed/);
  f.button().emit('pointerdown',{button:0});
  f.setAttachmentKey('film:0:ticket-3');f.view.refresh();
  f.button().emit('click',{detail:1});
  assert.equal(f.previews.length,1);
  f.button().emit('keydown',{key:' '});
  f.setAttachmentKey('film:0:ticket-4');f.view.refresh();
  f.button().emit('click',{detail:0});
  assert.equal(f.previews.length,1);
  f.button().emit('click');
  assert.equal(f.previews[1][1].attachmentKey,'film:0:ticket-4');
  assert.equal(f.previews[1][1].validate(),true);
  assert.deepEqual(f.seeks,[]);
});

test('replay uses the last dialogue cue, waits for landing, and discards stale completions',async t=>{
  const line=cue(12,15,'A line to replay');
  const f=fixture(t,[line]);
  let finish;
  f.setLanding(()=>new Promise(resolve=>{finish=resolve;}));
  f.video.currentTime=13;f.video.emit('timeupdate');
  f.queries('replay').emit('click');
  assert.deepEqual(f.seeks,[[12,1]]);
  assert.equal(f.panel.open,true);
  f.replaceTrack([cue(20,21,'Replacement subtitle')]);
  finish(true);await tick();
  assert.equal(f.panel.open,true);
  assert.deepEqual(f.captions,[]);
  f.setLanding(async()=>true);
  f.video.currentTime=20;f.video.emit('timeupdate');
  f.queries('replay').emit('click');await tick();
  assert.deepEqual(f.seeks,[[12,1],[20,2]]);
  assert.deepEqual(f.captions,[[cue(20,21,'Replacement subtitle'),2]]);
  assert.equal(f.panel.open,false);
});

test('enrichment exposes current offset-adjusted cue snapshots and invalidates on file changes',t=>{
  const document=mockDocument(t),previous=globalThis.localStorage,storage=new Map();
  globalThis.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;});
  storage.set('cinema-subtitles',JSON.stringify({'movie:0':{id:'subtitle_12345678',enabled:false,offset:1.5}}));
  let file={hash:'movie',index:0,files:[]},changeCount=0;
  // This test exercises the cue bridge without rendering the separate scene panel.
  document.nodes.set('#scene-panel',null);
  const enrichment=createEnrichment({
    api(){},clean:String,escape:String,onChange(){},getActive:()=>file,getLibrary:()=>[],
    onSceneTrackChange:()=>{changeCount++;},
  });
  enrichment.fileChanged();
  assert.deepEqual(enrichment.sceneCues(),[]);
  const track=document.querySelector('#video').children[0];
  track.track.cues=[{...cue(2,3,'<i>Line</i>'),getCueAsHTML:()=>({textContent:'Line'})}];
  track.emit('load');
  assert.equal(track.track.mode,'hidden');
  assert.deepEqual(enrichment.sceneCues(),[cue(3.5,4.5,'Line')]);
  const revision=enrichment.sceneTrackIdentity();
  document.querySelector('#subtitle-offset').value='-1';
  document.querySelector('#subtitle-offset').emit('input');
  assert.ok(enrichment.sceneTrackIdentity()>revision);
  assert.deepEqual(enrichment.sceneCues(),[cue(1,2,'Line')]);
  file={hash:'movie',index:1,files:[]};
  assert.deepEqual(enrichment.sceneCues(),[]);
  enrichment.fileChanged();
  track.emit('load');
  assert.deepEqual(enrichment.sceneCues(),[]);
  assert.ok(changeCount>=4);
});

test('a Finder preview uses the adjusted caption timestamp and loses authority on offset or file changes',t=>{
  const document=mockDocument(t),previous=globalThis.localStorage,storage=new Map();
  globalThis.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;});
  storage.set('cinema-subtitles',JSON.stringify({'movie:0':{id:'subtitle_12345678',enabled:false,offset:1.125}}));
  let file={hash:'movie',index:0,files:[]};
  const previews=[];
  const enrichment=createEnrichment({
    api(){},clean:String,escape:String,onChange(){},getActive:()=>file,getLibrary:()=>[],
    canSeekScene:()=>false,canPreviewScene:()=>true,previewAttachmentKey:()=>'movie:0:ticket-1',
    previewScene:(seconds,options)=>{previews.push({seconds,...options});return true;},
  });
  enrichment.fileChanged();
  const track=document.querySelector('#video').children[0];
  track.track.cues=[cue(66,67,'Found in captions')];
  track.emit('load');
  const finder=document.querySelector('#scene-finder');
  finder.querySelector('input').value='captions';
  finder.querySelector('[data-scene-search]').emit('submit');
  const first=finder.querySelector('[data-scene-matches]').children[0].children[0];
  first.emit('click');
  assert.equal(previews[0].seconds,67.125);
  assert.equal(previews[0].validate(),true);
  document.querySelector('#subtitle-offset').value='2.5';
  document.querySelector('#subtitle-offset').emit('input');
  assert.equal(previews[0].validate(),false);
  first.emit('click');assert.equal(previews.length,1);
  const second=finder.querySelector('[data-scene-matches]').children[0].children[0];
  second.emit('click');
  assert.equal(previews[1].seconds,68.5);
  file={hash:'movie',index:1,files:[]};
  assert.equal(previews[1].validate(),false);
  second.emit('click');assert.equal(previews.length,2);
});

test('a landed replay briefly reveals captions without saving that visibility setting',async t=>{
  const document=mockDocument(t),previous=globalThis.localStorage,storage=new Map();
  globalThis.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  t.after(()=>{if(previous===undefined)delete globalThis.localStorage;else globalThis.localStorage=previous;});
  storage.set('cinema-subtitles',JSON.stringify({'movie:0':{id:'subtitle_12345678',enabled:false}}));
  const video=document.querySelector('#video');
  video.currentTime=4;
  const enrichment=createEnrichment({
    api(){},clean:String,escape:String,onChange(){},getActive:()=>({hash:'movie',index:0,files:[]}),getLibrary:()=>[],
    canSeekScene:()=>true,seekScene:async seconds=>{video.currentTime=seconds;return true;},
  });
  enrichment.fileChanged();
  const track=video.children[0];
  track.track.cues=[cue(2,3,'A line to replay')];
  track.emit('load');
  assert.equal(track.track.mode,'hidden');
  document.querySelector('#scene-finder').querySelector('[data-scene-replay]').emit('click');
  await tick();
  assert.equal(track.track.mode,'showing');
  assert.equal(document.querySelector('#subtitle-enabled').checked,false);
  assert.equal(JSON.parse(storage.get('cinema-subtitles'))['movie:0'].enabled,false);
  video.currentTime=3.2;video.emit('timeupdate');
  assert.equal(track.track.mode,'hidden');
});

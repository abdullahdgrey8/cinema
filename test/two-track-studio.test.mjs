import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {watchedCueDigest} from '../public/watched-captions.js';
import {STUDIO_PAIRINGS_KEY,readStudioPairings,writeStudioPairings} from '../public/two-track-model.js';
import {createTwoTrackStudio} from '../public/two-track-studio.js';

const ids={primary:'1'.repeat(32),second:'2'.repeat(32),replacement:'3'.repeat(32)};
const fileKey='a'.repeat(40)+':0';
const defaultPrimary=[[1000,3000,'Primary caption']];
const defaultSecond=[[1000,3000,'Second caption']];
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const panelMarkup=html.match(/<details id="two-track-panel"[\s\S]*?<\/details>/)?.[0];
const nextTurn=()=>delay(1);
async function until(check,label){
  const end=Date.now()+1500;
  while(Date.now()<end){if(check())return;await nextTurn();}
  assert.fail('Timed out waiting for '+label);
}
const defer=()=>{
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
};
async function caption(cues){return {cues,digest:await watchedCueDigest(cues)};}
async function savedPair(primary=defaultPrimary,second=defaultSecond,offsetMs=0){
  return {fileKey,primaryId:ids.primary,primaryDigest:await watchedCueDigest(primary),secondaryId:ids.second,
    secondaryDigest:await watchedCueDigest(second),name:'Saved translation.srt',offsetMs};
}

function fixture(t,{primary=defaultPrimary,position=1.25,pairing=null}={}){
  const globals=['document','MutationObserver','requestAnimationFrame','cancelAnimationFrame'];
  const old=globals.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  const document=new EventTarget(),observers=new WeakMap(),frames=new Map();
  let frameId=0;
  class Element extends EventTarget{
    constructor(){super();this.hidden=false;this.disabled=false;this.value='';this.writes=0;this.attributes=new Map();}
    openFlag=false;text='';
    get open(){return this.openFlag;}
    set open(value){
      if(value===this.openFlag)return;
      this.openFlag=value;
      for(const callback of observers.get(this)||[])queueMicrotask(callback);
    }
    get textContent(){return this.text;}
    set textContent(value){this.text=value;this.writes++;}
    setAttribute(name,value){this.attributes.set(name,String(value));}
    getAttribute(name){return this.attributes.get(name)??null;}
    focus(){document.activeElement=this;}
    emit(type){this.dispatchEvent(new Event(type));}
  }
  Object.assign(globalThis,{document,MutationObserver:class{
    constructor(callback){this.callback=callback;}
    observe(target){observers.set(target,[this.callback]);}
  },requestAnimationFrame(callback){frames.set(++frameId,callback);return frameId;},
  cancelAnimationFrame(id){frames.delete(id);}});
  t.after(()=>{
    for(const [key,descriptor] of old){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  });
  document.activeElement=null;document.hidden=false;
  assert.ok(panelMarkup,'Studio markup is mounted in the player');
  const nodes=new Map(Array.from(panelMarkup.matchAll(/id="two-track-([a-z-]+)"([^>]*)>/g),match=>{
    const element=new Element();
    element.hidden=/\bhidden\b/.test(match[2]);element.disabled=/\bdisabled\b/.test(match[2]);
    return [match[1],element];
  }));
  const node=name=>nodes.get(name);
  const panel=new Element(),ancestor=new Element(),dialog=new Element(),video=new Element();
  panel.querySelector=selector=>node(selector.slice('#two-track-'.length));
  ancestor.open=true;dialog.open=true;
  Object.assign(video,{paused:true,ended:false,seeking:false,readyState:3,currentTime:position});
  const element=Object.freeze({track:Object.freeze({mode:'hidden'})});
  const rows=Object.freeze(primary.map(([start,end,text])=>Object.freeze([Object.freeze({}),start/1000,end/1000,text])));
  let selected=Object.freeze({id:ids.primary,name:'Primary.srt',fileKey,element,rows,offset:0,revision:1,status:'ready'});
  let player={generation:1,url:'/stream?index=0'};
  let importAnswer=async payload=>({id:ids.second,name:payload.name});
  let readAnswer=async ()=>caption(defaultSecond),seekAnswer=async()=>true,canSeek=()=>true;
  let stored=pairing?writeStudioPairings([pairing]):null;
  const imports=[],reads=[],seeks=[],writes=[];
  const studio=createTwoTrackStudio({panel,ancestor,dialog,video,getPrimary:()=>selected,getPlayerIdentity:()=>player,
    importCaption:(payload,signal)=>{imports.push({payload,signal});return importAnswer(payload,signal);},
    readCaption:(id,signal)=>{reads.push({id,signal});return readAnswer(id,signal);},
    canSeekScene:seconds=>canSeek(seconds),seekScene:(time,revision)=>{seeks.push([time,revision]);return seekAnswer(time,revision);},
    formatTime:seconds=>String(Math.floor(seconds)),
    storage:{getItem(key){assert.equal(key,STUDIO_PAIRINGS_KEY);return stored;},
      setItem(key,value){assert.equal(key,STUDIO_PAIRINGS_KEY);writes.push(value);stored=value;}},
  });
  function open(){panel.open=true;panel.emit('toggle');}
  return {document,panel,ancestor,dialog,video,node,studio,imports,reads,seeks,writes,frames,open,
    get primary(){return selected;},get saved(){return readStudioPairings(stored);},
    setAncestor(open){ancestor.open=open;ancestor.emit('toggle');},
    primaryOffset(offset){selected=Object.freeze({...selected,offset,revision:selected.revision+1});studio.primaryChanged();},
    newAttachment(){player={generation:2,url:'/stream?index=0&new=1'};studio.refresh();},
    setImport(callback){importAnswer=callback;},
    setRead(callback){readAnswer=callback;},
    setSeek(callback){seekAnswer=callback;},
    setReady(callback){canSeek=callback;studio.refresh();},
    choose(name='Translation.srt',value='1\n00:00:01,000 --> 00:00:03,000\nTranslated line'){
      const data=new TextEncoder().encode(value);
      node('file').files=[{name,size:data.byteLength,arrayBuffer:async()=>data.buffer}];
      node('file').emit('change');
    },
    offset(value){node('offset').value=String(value);node('offset').emit('input');},
    time(value,event='timeupdate'){video.currentTime=value;video.emit(event);},
    tickFrame(now){
      const scheduled=[...frames.values()];
      frames.clear();
      for(const callback of scheduled)callback(now);
    },
  };
}

test('closing Subtitle settings with Studio open aborts pending read and suppresses late status or save',async t=>{
  const f=fixture(t),reading=defer();
  f.setRead(()=>reading.promise);
  f.open();f.choose();
  await until(()=>f.reads.length===1,'the explicitly chosen second subtitle read');
  f.setAncestor(false);
  assert.equal(f.panel.open,true);
  assert.equal(f.reads[0].signal.aborted,true);
  reading.reject(Error('Normalized network error'));
  await nextTurn();await nextTurn();
  assert.equal(f.writes.length,0);
  f.setAncestor(true);
  assert.equal(f.node('secondary-line').textContent,'No second track selected.');
  assert.doesNotMatch(f.node('status').textContent,/couldn’t|unreadable/i);
  assert.equal(f.reads.length,1,'restoring the ancestor does not restart the abandoned request');
});

test('timing changes preserve the pair, failed replacement retains it, and a different successful import resets offset',async t=>{
  const f=fixture(t);
  f.open();f.choose();
  await until(()=>f.node('secondary-line').textContent==='Second caption','the loaded second caption');
  assert.equal(f.primary.element.track.mode,'hidden');
  const originalRows=f.primary.rows;
  f.offset('.125');
  assert.equal(f.saved[0].offsetMs,125);
  f.primaryOffset(.5);
  assert.equal(f.node('offset').value,'.125');
  assert.equal(f.node('secondary-line').textContent,'Second caption');
  assert.equal(f.node('primary-line').textContent,'No primary line at this moment.');
  assert.equal(f.reads.length,1);
  assert.equal(f.primary.rows,originalRows);
  assert.equal(f.primary.offset,.5);
  assert.equal(f.primary.element.track.mode,'hidden');
  f.offset(121);
  assert.equal(f.saved[0].offsetMs,125);
  f.node('offset').emit('blur');
  assert.equal(f.node('offset').value,'0.125');

  f.setImport(async()=>({id:ids.replacement,name:'Replacement.srt'}));
  f.setRead(async()=>({bytes:1024*1024}));
  const writes=f.writes.length;
  f.choose('Replacement.srt');
  await until(()=>/unreadable/.test(f.node('status').textContent),'a bounded read error');
  assert.equal(f.node('secondary-line').textContent,'Second caption');
  assert.equal(f.node('offset').value,'0.125');
  assert.equal(f.writes.length,writes);

  f.setRead(async()=>caption([[1000,3000,'Replacement caption']]));
  f.choose('Replacement.srt');
  await until(()=>f.node('secondary-line').textContent==='Replacement caption','the valid replacement');
  assert.equal(f.node('offset').value,'0');
  assert.equal(f.saved[0].offsetMs,0);
  f.node('forget').emit('click');
  f.offset('.2');
  assert.deepEqual(f.saved,[],'changing a forgotten pairing does not recreate it');
  assert.equal(f.node('secondary-line').textContent,'Replacement caption');
});

test('saved pairs require explicit restore and reject changed, missing, limited, or timed-out captions without saving',async t=>{
  const pairing=await savedPair(defaultPrimary,defaultSecond,175),f=fixture(t,{pairing});
  f.open();
  assert.equal(f.node('restore').textContent,'Restore Saved translation.srt');
  assert.equal(f.reads.length,0);
  const cases=[
    {response:async()=>caption([[1000,3000,'Changed text']]),status:/has changed/},
    {response:async()=>({bytes:0}),status:/unreadable/},
    {response:async()=>({bytes:1024*1024}),status:/unreadable/},
    {response:async()=>{throw Error('Normalized timeout');},status:/unreadable/},
  ];
  for(const entry of cases){
    f.setRead(entry.response);f.node('restore').emit('click');
    await until(()=>entry.status.test(f.node('status').textContent),'a rejected restore');
    assert.equal(f.node('secondary-line').textContent,'No second track selected.');
    assert.equal(f.writes.length,0);
  }
  assert.equal(f.reads.length,cases.length);
  f.setRead(async()=>caption(defaultSecond));f.node('restore').emit('click');
  await until(()=>f.node('secondary-line').textContent==='Second caption','the verified restored pair');
  assert.equal(f.node('offset').value,'0.175');
  f.newAttachment();
  assert.equal(f.node('secondary-line').textContent,'No second track selected.');
  assert.equal(f.node('restore').hidden,false);
  assert.equal(f.reads.length,cases.length+1,'a new attachment offers but does not read Restore');
});

test('a 200 ms playing overlap renders quietly, expires before click, and stops sampling while hidden',async t=>{
  const second=[[1200,1400,'Short overlap']];
  const f=fixture(t,{position:1.1});
  f.setRead(async()=>caption(second));
  f.open();f.choose();
  await until(()=>f.node('secondary-name').textContent==='Translation.srt','the comparison');
  const count=f.node('status').writes;
  f.video.paused=false;f.video.emit('playing');
  f.video.currentTime=1.25;f.tickFrame(100);
  assert.equal(f.node('secondary-line').textContent,'Short overlap');
  assert.equal(f.node('jump').hidden,false);
  assert.match(f.node('overlap').textContent,/0\.2 sec overlap/);
  assert.equal(f.node('status').writes,count,'caption movement stays quiet');
  f.video.currentTime=1.4;
  f.node('jump').emit('click');
  assert.deepEqual(f.seeks,[]);
  assert.equal(f.node('jump').hidden,true);
  f.setAncestor(false);
  assert.equal(f.frames.size,0);
});

test('a changed effective span for the same pair requires a fresh click; short overlaps never seek',async t=>{
  const primary=[[1000,2000,'Primary'],[1400,1450,'Aside']];
  const f=fixture(t,{primary,position:1.2});
  f.setRead(async()=>caption([[1000,2000,'Second']]));
  f.open();f.choose();
  await until(()=>!f.node('jump').hidden,'the first effective overlap');
  f.video.currentTime=1.5;
  f.node('jump').emit('click');
  assert.deepEqual(f.seeks,[]);
  assert.equal(f.node('primary-line').textContent,'Primary');
  f.time(1.42);
  assert.equal(f.node('primary-line').textContent,'Aside');
  assert.equal(f.node('jump').hidden,true);
  f.node('jump').emit('click');
  assert.deepEqual(f.seeks,[]);
});

test('successful seeks require fractional containment and a same-revision visible operation',async t=>{
  const f=fixture(t,{position:1.1});
  f.setRead(async()=>caption([[1000,1250,'Second']]));
  f.open();f.choose();
  await until(()=>!f.node('jump').hidden,'the playable overlap');

  let landing=defer();f.setSeek(()=>landing.promise);f.node('jump').emit('click');
  assert.deepEqual(f.seeks,[[1.05,1]]);
  f.video.currentTime=1.25;landing.resolve(true);await nextTurn();
  assert.doesNotMatch(f.node('status').textContent,/Jumped/);

  f.time(1.1);landing=defer();f.setSeek(()=>landing.promise);f.node('jump').emit('click');
  f.video.currentTime=1.2499;landing.resolve(true);
  await until(()=>/Jumped/.test(f.node('status').textContent),'the confirmed fractional landing');
  assert.equal(f.video.paused,true);

  f.time(1.1);landing=defer();f.setSeek(()=>landing.promise);f.node('jump').emit('click');
  f.primaryOffset(.01);landing.resolve(true);await nextTurn();
  assert.doesNotMatch(f.node('status').textContent,/Jumped/);
});

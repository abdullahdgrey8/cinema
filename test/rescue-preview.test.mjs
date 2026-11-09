import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mapRescueScene} from '../public/rescue-preview.js';

const a='a'.repeat(40),b='b'.repeat(40);
const identity='movie:2024:midnight bridge:wikipedia-123';
const cue=(startTime,text,length=1.5)=>({startTime,endTime:startTime+length,text});
const phrases=[
  'The lantern stays on until the ferry arrives.',
  'Our neighbor left the keys beneath the garden bench.',
  'Bring the letter to the blue house before sunrise.',
  'A quiet storm is coming across the harbor tonight.',
  'Only the baker knows where she buried the compass.',
  'The last freight train stops at the eastern bridge.',
  'We will find the old oak tree near the river.',
  'Do not forget the silver pocket watch on the shelf.'
];
const first=phrases.map((text,index)=>cue(4+index*6,text));
const second=phrases.map((text,index)=>cue(6+index*6+(index>=4?12:0),text));
second.splice(4,0,cue(26,'The ferryman paid for this boat with six copper coins.'),
  cue(30,'He wrote his secret name on a postcard for Nora.'));
const source=(time=34.5,changes={})=>({
  hash:a,index:0,fileKey:a+':0',sessionId:'session-a',identity,time,track:1,cues:first,duration:52,offset:0,...changes
});
const target=(changes={})=>({
  hash:b,index:0,fileKey:b+':0',sessionId:'session-b',identity,track:2,cues:second,duration:66,offset:0,...changes
});

test('Rescue uses local dialogue at the last presented moment, on both sides of an insertion',()=>{
  assert.equal(mapRescueScene(source(16.5),target()),18.5);
  assert.equal(mapRescueScene(source(34.5),target()),48.5);
});

test('a cue at the edge of a non-shared interval does not produce a continuation',()=>{
  assert.equal(mapRescueScene(source(22.4),target()),null);
  assert.equal(mapRescueScene(source(48),target()),null);
});

test('a repeated candidate scene is not selected solely because the target opens',()=>{
  const repeated=[...second,...second.slice(5,8).map(row=>cue(row.startTime+75,row.text))];
  assert.equal(mapRescueScene(source(),target({cues:repeated,duration:155})),null);
});

test('the same raw track with a different adjustment is not independent evidence',()=>{
  const duplicate=first.map(row=>cue(row.startTime+7,row.text,row.endTime-row.startTime));
  const originalTimes=first.map(row=>[row.startTime,row.endTime]);
  assert.equal(mapRescueScene(source(),target({cues:duplicate,offset:7,originalTimes})),null);
});

test('different stories, same torrent, and unavailable last frames cannot offer a mapped scene',()=>{
  assert.equal(mapRescueScene(source(),target({identity:identity.replace('123','124')})),null);
  assert.equal(mapRescueScene(source(),target({hash:a,index:1,fileKey:a+':1'})),null);
  assert.equal(mapRescueScene(source(NaN),target()),null);
});

const origin='http://127.0.0.1:3210';
const direct=(progress=1)=>({identity,file:{index:0,name:'Replacement.mp4'},
  state:{hash:b,index:0,sessionId:'session-b',status:'ready',mode:'direct',
    url:'/stream?hash='+b+'&index=0',duration:66,progress}});

test('a preview address stays on the exact local prepared file or completed HLS run',async()=>{
  const {rescuePreviewURL}=await import('../public/rescue-preview.js');
  const {state}=direct();
  assert.equal(rescuePreviewURL(state,origin),origin+state.url);
  assert.equal(rescuePreviewURL({...state,url:'https://example.com'+state.url},origin),null);
  assert.equal(rescuePreviewURL({...state,url:state.url+'&internal=x'},origin),null);
  assert.equal(rescuePreviewURL({...state,url:'/stream?hash='+a+'&index=0'},origin),null);
  const hls={...state,mode:'hls',complete:true,url:'/hls/'+b+'-0/abcdef012345/index.m3u8'};
  assert.equal(rescuePreviewURL(hls,origin),origin+hls.url);
  assert.equal(rescuePreviewURL({...hls,complete:false},origin),null);
  assert.equal(rescuePreviewURL({...hls,url:hls.url.replace('-0/','-2/')},origin),null);
});

const ranges=(...items)=>({length:items.length,start:index=>items[index][0],end:index=>items[index][1]});

function previewHarness(t,{withFrames=true}={}){
  const originalDocument=globalThis.document,originalLocation=globalThis.location;
  let currentVideo,created=0;
  class Video extends EventTarget{
    constructor(){
      super();
      Object.assign(this,{videoWidth:320,videoHeight:180,readyState:4,currentTime:0,
        duration:66,paused:true,seekable:ranges([0,66]),buffered:ranges([0,4]),style:{},frames:new Map(),
        plays:0,removed:false,loads:0,tracks:[]});
    }
    setAttribute(){}
    removeAttribute(name){delete this[name];}
    append(track){
      this.tracks.push(track);
      queueMicrotask(()=>track.dispatchEvent(new Event('load')));
    }
    requestVideoFrameCallback(fn){const id=++created;this.frames.set(id,fn);return id;}
    cancelVideoFrameCallback(id){this.frames.delete(id);}
    play(){
      this.paused=false;
      this.plays++;
      if(withFrames)queueMicrotask(()=>{
        for(const [id,frame] of this.frames){
          this.frames.delete(id);
          frame(performance.now(),{mediaTime:this.currentTime+.04});
          break;
        }
      });
      return Promise.resolve();
    }
    pause(){this.paused=true;}
    load(){this.loads++;}
    remove(){this.removed=true;}
  }
  class Track extends EventTarget{
    track={cues:second};
    remove(){this.removed=true;}
  }
  globalThis.location={origin};
  globalThis.document={querySelector(){return null;},body:{append(video){currentVideo=video;}},
    createElement(name){return name==='video'?new Video():new Track();}};
  t.after(()=>{globalThis.document=originalDocument;globalThis.location=originalLocation;});
  return ()=>currentVideo;
}

test('decoded opening and decoded scene proof use one muted preview and release the elements',async t=>{
  const {previewRescue}=await import('../public/rescue-preview.js');
  const video=previewHarness(t);
  const proof=await previewRescue({attachment:direct(),source:source(),subtitle:{id:'c'.repeat(32),offset:0}});
  assert.equal(proof.beginning,true);
  assert.equal(proof.openingFrame,.04);
  assert.equal(proof.sceneTime,48.5);
  assert.equal(proof.sceneFrame,48.54);
  assert.equal(video().plays,2);
  assert.equal(video().muted,true);
  assert.equal(video().removed,true);
  assert.equal(video().tracks[0].removed,true);
  assert.equal(video().frames.size,0);
});

test('a partial direct file cannot use an advertised seekable range for a distant scene',async t=>{
  const {previewRescue}=await import('../public/rescue-preview.js');
  const video=previewHarness(t);
  const proof=await previewRescue({attachment:direct(.2),source:source(),subtitle:{id:'c'.repeat(32),offset:0}});
  assert.deepEqual(proof,{beginning:true,openingFrame:.04,sceneTime:null});
  assert.equal(video().plays,1);
  assert.equal(video().removed,true);
});

test('canceling while no frame has decoded releases the video and its frame request',async t=>{
  const {previewRescue}=await import('../public/rescue-preview.js');
  const video=previewHarness(t,{withFrames:false}),controller=new AbortController();
  const pending=previewRescue({attachment:direct(),source:source(),signal:controller.signal});
  assert.equal(video().frames.size,1);
  controller.abort(new DOMException('Canceled','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(video().removed,true);
  assert.equal(video().frames.size,0);
  assert.equal(video().paused,true);
  assert.equal(video().src,undefined);
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {previewFastStart} from '../public/fast-start-preview.js';

const origin='http://127.0.0.1:3210';
const hash='a'.repeat(40);
const state={status:'ready',mode:'direct',hash,index:2,sessionId:'session-2',url:'/stream?hash='+hash+'&index=2'};
const attachment={state,file:{index:2,name:'Fixtures/Opening.mp4',size:16}};
const request={attachment,previewBytes:8};

function browser(t,fetch,document={}){
  const saved=['location','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
  Object.defineProperty(globalThis,'location',{configurable:true,value:{origin}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:document});
  t.mock.method(globalThis,'fetch',fetch);
  t.after(()=>{
    for(const [key,descriptor] of saved){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  });
}

function partial(body=new Uint8Array(8),options={}){
  return new Response(body,{status:206,headers:{'Content-Range':'bytes 0-7/16'},...options});
}

test('a different byte range never reaches the decoder',async t=>{
  let called=0,range;
  browser(t,async (_url,options)=>{
    called++;range=options.headers.Range;
    assert.equal(options.redirect,'error');
    return partial(undefined,{headers:{'Content-Range':'bytes 1-8/16'}});
  },{createElement(){assert.fail('unverified response reached video');}});
  await assert.rejects(previewFastStart(request),/range/i);
  assert.equal(called,1);
  assert.equal(range,'bytes=0-7');
});
 
function decoder(t,fetch){
  let appended,removed=false,reset=false,createdBlob,revoked,handle=0,finishStart;
  const callbacks=new Map();
  const started=new Promise(resolve=>{finishStart=resolve;});
  const video=Object.assign(new EventTarget(),{
    style:{},paused:true,seeking:false,readyState:2,videoWidth:320,videoHeight:180,
    setAttribute(){},
    removeAttribute(name){if(name==='src')this.src='';},
    requestVideoFrameCallback(callback){callbacks.set(++handle,callback);return handle;},
    cancelVideoFrameCallback(id){callbacks.delete(id);},
    play(){this.paused=false;finishStart();return Promise.resolve();},
    pause(){this.paused=true;},
    load(){reset=true;},
    remove(){removed=true;},
  });
  browser(t,fetch,{
    createElement(tag){assert.equal(tag,'video');return video;},
    querySelector(){return null;},
    body:{append(element){appended=element;}},
  });
  t.mock.method(URL,'createObjectURL',blob=>{
    createdBlob=blob;
    return 'blob:'+origin+'/fixture';
  });
  t.mock.method(URL,'revokeObjectURL',url=>{revoked=url;});
  return {
    video,started,frame(time){
      assert.equal(callbacks.size,1);
      const [id,callback]=callbacks.entries().next().value;
      callbacks.delete(id);
      callback(0,{mediaTime:time});
    },
    get blob(){return createdBlob;},
    assertCleanup(){
      assert.equal(appended,video);
      assert.equal(removed,true);
      assert.equal(reset,true);
      assert.equal(revoked,'blob:'+origin+'/fixture');
      assert.equal(video.src,'');
      assert.equal(video.paused,true);
      assert.equal(callbacks.size,0);
    },
  };
}

test('a verified prefix needs two decoded frames before it can prove the opening',async t=>{
  const bytes=new Uint8Array([13,19,25,28,39,40,60,83]);
  const proof=decoder(t,async (url,options)=>{
    assert.equal(url,origin+state.url);
    assert.equal(options.headers.Range,'bytes=0-7');
    return partial(bytes);
  });
  let settled=false;
  const attempt=previewFastStart(request).then(result=>{settled=true;return result;});
  await Promise.race([proof.started,attempt]);
  assert.equal(proof.video.muted,true);
  assert.equal(proof.video.src,'blob:'+origin+'/fixture');
  assert.deepEqual(new Uint8Array(await proof.blob.arrayBuffer()),bytes);
  proof.frame(.2);
  proof.frame(3.1);
  await Promise.resolve();
  assert.equal(settled,false,'a frame less than three seconds later is insufficient');
  proof.frame(3.25);
  assert.deepEqual(await attempt,{openingFrame:.2,runwayFrame:3.25,bytes:8});
  proof.assertCleanup();
});

test('invalid local attachment, unsupported container and oversized prefix never make a request',async t=>{
  browser(t,()=>assert.fail('invalid preview reached fetch'));
  const cases=[
    {...request,attachment:{...attachment,state:{...state,url:'https://elsewhere.example'+state.url}}},
    {...request,attachment:{...attachment,state:{...state,url:state.url+'&redirect=1'}}},
    {...request,attachment:{...attachment,file:{...attachment.file,index:3}}},
    {...request,attachment:{...attachment,file:{...attachment.file,name:'Opening.mkv'}}},
    {...request,previewBytes:6*1024*1024+1,attachment:{...attachment,file:{...attachment.file,size:7*1024*1024}}},
  ];
  for(const candidate of cases)await assert.rejects(previewFastStart(candidate),/preview/i);
});

test('matching headers cannot disguise a shorter or oversized response body',async t=>{
  const cases=[new Uint8Array(7),new Uint8Array(9)];
  browser(t,async ()=>partial(cases.shift()),{createElement(){assert.fail('unverified bytes reached video');}});
  await assert.rejects(previewFastStart(request),/shorter/i);
  await assert.rejects(previewFastStart(request),/exceeded/i);
});

test('aborting a pending range read cancels the stream before attaching a video',async t=>{
  const controller=new AbortController(),reason=Error('Original started');
  let signal,cancelled=false,readStarted;
  const waiting=new Promise(resolve=>{readStarted=resolve;});
  browser(t,async (_url,options)=>{
    signal=options.signal;
    return partial(new ReadableStream({
      pull(){readStarted();},
      cancel(){cancelled=true;},
    },{highWaterMark:0}));
  },{createElement(){assert.fail('cancelled read reached video');}});
  const attempt=previewFastStart({...request,signal:controller.signal});
  await Promise.race([waiting,attempt]);
  controller.abort(reason);
  await assert.rejects(attempt,error=>error===reason);
  assert.equal(signal.aborted,true);
  assert.equal(cancelled,true);
});

test('aborting after the first frame clears the decoder, callback and blob',async t=>{
  const proof=decoder(t,async ()=>partial());
  const controller=new AbortController(),reason=Error('Original started');
  const attempt=previewFastStart({...request,signal:controller.signal});
  await Promise.race([proof.started,attempt]);
  proof.frame(.1);
  controller.abort(reason);
  await assert.rejects(attempt,error=>error===reason);
  proof.assertCleanup();
});

test('a truncated local opening that ends before the runway frame cannot win',async t=>{
  const proof=decoder(t,async ()=>partial());
  const attempt=previewFastStart(request);
  await Promise.race([proof.started,attempt]);
  proof.frame(.1);
  proof.frame(2.7);
  proof.video.dispatchEvent(new Event('ended'));
  await assert.rejects(attempt,/three seconds/);
  proof.assertCleanup();
});

test('a silent decoder times out within the local comparison budget and releases the surface',async t=>{
  const proof=decoder(t,async ()=>partial());
  const setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout;
  let expire,cleared=false;
  const comparisonTimer=Symbol('comparison timer');
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
    if(delay!==8500)return setTimer(callback,delay,...args);
    expire=callback;
    return comparisonTimer;
  });
  t.mock.method(globalThis,'clearTimeout',timer=>{
    if(timer===comparisonTimer)cleared=true;
    else clearTimer(timer);
  });
  const attempt=previewFastStart(request);
  await Promise.race([proof.started,attempt]);
  expire();
  await assert.rejects(attempt,/did not finish in time/);
  assert.equal(cleared,true);
  proof.assertCleanup();
});

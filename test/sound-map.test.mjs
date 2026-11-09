import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {createSoundMap} from '../public/sound-map.js';

const markup=readFileSync(new URL('../public/index.html',import.meta.url),'utf8')
  .match(/<details id="sound-map-panel"[\s\S]*?<\/details>/)?.[0];
const entity=value=>value.replace(/&(amp|quot|lt|gt|#39);/g,(_,key)=>({
  amp:'&',quot:'"',lt:'<',gt:'>','#39':"'"
}[key]));
const tick=()=>delay(1);
async function until(predicate,description){
  const deadline=Date.now()+1500;
  while(Date.now()<deadline){
    if(predicate())return;
    await tick();
  }
  assert.fail('Timed out waiting for '+description);
}

function makeDOM(t){
  const saved=new Map(['document','CSS','MutationObserver'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const document=new EventTarget(),observers=new WeakMap();
  class Element extends EventTarget{
    constructor(tag){super();this.tagName=tag.toUpperCase();}
    children=[];parentElement=null;hidden=false;openState=false;valueText='';attrs=new Map();dataset={};
    get open(){return this.openState;}
    set open(value){
      if(value===this.openState)return;
      this.openState=value;
      for(const callback of observers.get(this)||[])queueMicrotask(callback);
    }
    get attributes(){return [...this.attrs].map(([name,value])=>({name,value}));}
    get firstElementChild(){return this.children[0]||null;}
    get nextElementSibling(){const siblings=this.parentElement?.children;return siblings?.[siblings.indexOf(this)+1]||null;}
    get isConnected(){return this===document.body||Boolean(this.parentElement?.isConnected);}
    get textContent(){return this.valueText+this.children.map(child=>child.textContent).join('');}
    set textContent(value){for(const child of [...this.children])child.remove();this.valueText=String(value);}
    setAttribute(name,value){
      this.attrs.set(name,String(value));
      if(name==='hidden')this.hidden=true;
      if(name.startsWith('data-')){
        const key=name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());
        this.dataset[key]=String(value);
      }
    }
    getAttribute(name){return this.attrs.get(name)??null;}
    matches(selector){
      if(selector.startsWith('#'))return this.getAttribute('id')===selector.slice(1);
      if(selector.startsWith('.'))return this.getAttribute('class')?.split(/\s+/).includes(selector.slice(1));
      if(selector==='[data-sound-cue]')return this.attrs.has('data-sound-cue');
      const data=/^button\[data-sound-cue="(.*)"\]$/.exec(selector);
      return Boolean(data&&this.tagName==='BUTTON'&&this.getAttribute('data-sound-cue')===data[1]);
    }
    querySelector(selector){
      for(const child of this.children){
        if(child.matches(selector))return child;
        const result=child.querySelector(selector);
        if(result)return result;
      }
      return null;
    }
    closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
    contains(element){return Boolean(element&&(element===this||this.children.some(child=>child.contains(element))));}
    append(node){this.insertBefore(node,null);}
    insertBefore(node,before){
      if(node===before)return;
      const source=node.parentElement;
      if(source)source.children.splice(source.children.indexOf(node),1);
      const index=before===null?this.children.length:this.children.indexOf(before);
      assert.ok(index>=0);
      this.children.splice(index,0,node);node.parentElement=this;
    }
    replaceWith(node){this.parentElement.insertBefore(node,this);this.remove();}
    remove(){
      if(!this.parentElement)return;
      if(this.contains(document.activeElement))document.activeElement=document.body;
      const parent=this.parentElement;
      parent.children.splice(parent.children.indexOf(this),1);this.parentElement=null;
    }
    focus(){document.activeElement=this;}
    emit(type,target=this){
      const event=new Event(type);
      Object.defineProperty(event,'target',{value:target});
      this.dispatchEvent(event);
    }
  }
  function parse(html){
    const fragment=new Element('fragment'),stack=[fragment];
    for(const [token] of html.matchAll(/<\/?[a-z][^<>]*>|[^<]+/gi)){
      if(token.startsWith('</')){stack.pop();continue;}
      if(!token.startsWith('<')){stack.at(-1).valueText+=entity(token);continue;}
      const [,tag,attributes]=/^<([a-z][\w-]*)([^>]*)>$/i.exec(token);
      const node=new Element(tag);
      for(const [,name,value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
        node.setAttribute(name,entity(value??''));
      stack.at(-1).append(node);
      if(!token.endsWith('/>'))stack.push(node);
    }
    return fragment;
  }
  document.body=new Element('body');
  document.activeElement=document.body;
  document.hidden=false;
  document.createElement=tag=>{
    assert.equal(tag,'template');
    return {content:null,set innerHTML(html){this.content=parse(html);}};
  };
  Object.assign(globalThis,{document,CSS:{escape:String},MutationObserver:class{
    constructor(callback){this.callback=callback;}
    observe(target){observers.set(target,[...(observers.get(target)||[]),this.callback]);}
  }});
  t.after(()=>{
    for(const [key,descriptor] of saved){
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  });
  return {document,Element,parse};
}

function cue(at,label='Music',onDecode=()=>{}){
  const value='['+label+']';
  return [{text:value,getCueAsHTML(){onDecode();return {textContent:value};}},at,at+.6,'unused caption snapshot'];
}
function fixture(t,rows,{position=2}={}){
  const {document,Element,parse}=makeDOM(t);
  const dialog=new Element('dialog'),ancestor=new Element('details'),video=new Element('video');
  assert.ok(markup,'Sound Map markup is installed');
  const panel=parse(markup).firstElementChild;
  document.body.append(dialog);dialog.append(video);dialog.append(ancestor);ancestor.append(panel);
  dialog.open=true;ancestor.open=true;
  Object.assign(video,{currentTime:position,seeking:false,readyState:3,paused:true});
  let track={revision:1,element:{},fileKey:'film:0',offset:0,rows,status:'ready',hasFile:true};
  let player={generation:1,url:'/stream?index=0'},land=async()=>true,ready=()=>true;
  const seeks=[];
  const view=createSoundMap({panel,ancestor,dialog,video,getTrack:()=>track,getPlayerIdentity:()=>player,
    canSeekScene:seconds=>ready(seconds),seekScene:(seconds,revision)=>{seeks.push([seconds,revision]);return land();},
    formatTime:seconds=>'t='+seconds,openSubtitles(){assert.fail('Sound Map opened subtitle settings automatically');}});
  const node=id=>panel.querySelector('#sound-map-'+id),list=node('list');
  const buttons=()=>list.children.map(row=>row.firstElementChild);
  const labels=()=>buttons().map(button=>button.querySelector('.sound-map-label').textContent);
  const times=()=>buttons().map(button=>button.querySelector('.sound-map-time').textContent);
  return {document,dialog,ancestor,panel,video,view,seeks,node,list,buttons,labels,times,
    open(){panel.open=true;panel.emit('toggle');},
    setAncestor(open){ancestor.open=open;ancestor.emit('toggle');},
    setPosition(value,event='timeupdate'){video.currentTime=value;video.emit(event);},
    setHidden(hidden){document.hidden=hidden;document.dispatchEvent(new Event('visibilitychange'));},
    setLanding(callback){land=callback;},
    setReady(callback){ready=callback;view.refresh();},
    replaceTrack(newRows){track={...track,revision:track.revision+1,element:{},rows:newRows};view.trackChanged();},
    replaceFile(){track={...track,fileKey:'film:1'};player={generation:2,url:'/stream?index=1'};view.refresh();},
    clickCue(index=0){list.emit('click',buttons()[index]);},
  };
}

test('hiding an open Sound Map through Scenes cancels the scan and a completed attachment survives dialog restore',async t=>{
  let scanned=0,f;
  const rows=Array.from({length:150},(_,index)=>cue(index+1,'Music',()=>{
    scanned++;
    if(scanned===1)queueMicrotask(()=>f.setAncestor(false));
  }));
  f=fixture(t,rows,{position:151});
  assert.equal(scanned,0);
  f.open();
  await until(()=>scanned>0&&!f.ancestor.open,'the first scan to start and Scenes to close');
  await tick();await tick();
  assert.equal(f.panel.open,true,'the nested disclosure remained open');
  assert.ok(scanned<rows.length,'closing the ancestor stopped the remaining caption work');
  assert.deepEqual(f.labels(),[],'an aborted scan publishes no rows');
  f.setAncestor(true);
  await until(()=>f.labels().length===10,'the reopened scan to publish');
  const completed=scanned;
  f.dialog.open=false;f.dialog.emit('close');
  f.dialog.open=true;
  await tick();await tick();
  assert.equal(f.panel.open,true);
  assert.equal(f.labels().length,10);
  assert.equal(scanned,completed,'the exact completed index was reused after modal restoration');
});

test('default DOM and accessible state omit later cues and hold the settled position during seeking',async t=>{
  const oversized=' '.repeat(1024*1024+1);
  const f=fixture(t,[cue(1,'Footsteps'),cue(90,'Thunder'),[{text:oversized},91,92,'']]);
  f.open();
  await until(()=>f.labels().length===1,'the first visible cue');
  assert.deepEqual(f.labels(),['Footsteps']);
  assert.equal(f.node('later').getAttribute('aria-pressed'),'false');
  assert.equal(f.node('pages').hidden,true);
  assert.equal(f.node('page').textContent,'Page 1 of 1');
  assert.equal(f.node('limited').hidden,true);
  assert.doesNotMatch(f.list.textContent,/Thunder|t=90/);
  assert.doesNotMatch(JSON.stringify(f.buttons().map(button=>button.attributes)),/Thunder|90000/);
  assert.doesNotMatch(f.node('status').textContent,/later|limit|2 cues/i);

  f.node('later').emit('click');
  assert.deepEqual(f.labels(),['Footsteps','Thunder']);
  assert.equal(f.node('limited').hidden,false);
  f.node('later').emit('click');

  f.video.seeking=true;f.setPosition(95,'seeking');
  assert.deepEqual(f.labels(),['Footsteps']);
  assert.equal(f.node('limited').hidden,true);
  assert.equal(f.buttons()[0].getAttribute('aria-disabled'),'true');
  f.clickCue();
  assert.deepEqual(f.seeks,[]);
  f.video.seeking=false;f.setPosition(95,'seeked');
  assert.deepEqual(f.labels(),['Footsteps','Thunder']);
  assert.equal(f.node('limited').hidden,false);
});

test('a page stays anchored as cues become eligible and a removed focused row returns focus to the heading',async t=>{
  const f=fixture(t,Array.from({length:25},(_,index)=>cue(index+1)),{position:12});
  f.open();
  await until(()=>f.times().length===2,'the latest eligible page');
  assert.deepEqual(f.times(),['t=11','t=12']);
  assert.equal(f.node('page').textContent,'Page 2 of 2');
  const focused=f.buttons()[1];
  focused.focus();

  f.setPosition(25);
  assert.equal(f.node('page').textContent,'Page 2 of 3');
  assert.equal(f.times()[0],'t=11');
  assert.equal(f.times().at(-1),'t=20');
  assert.equal(f.buttons()[1],focused);
  assert.equal(f.document.activeElement,focused);

  f.video.seeking=true;f.setPosition(8,'seeking');
  assert.equal(f.document.activeElement,focused);
  f.video.seeking=false;f.setPosition(8,'seeked');
  assert.equal(f.node('page').textContent,'Page 1 of 1');
  assert.equal(f.times().at(-1),'t=8');
  assert.equal(f.document.activeElement,f.node('heading'));
});

test('a current confirmed jump announces after landing while preserving pause',async t=>{
  const f=fixture(t,[cue(1,'Footsteps')]);
  f.open();
  await until(()=>f.buttons().length===1,'a ready jump');
  let land;
  f.setLanding(()=>new Promise(resolve=>{land=resolve;}));
  f.clickCue();
  assert.deepEqual(f.seeks,[[1,1]]);
  assert.doesNotMatch(f.node('status').textContent,/Jumped|Jump complete/);
  land(true);
  await until(()=>f.node('status').textContent==='Jumped to t=1.','the confirmed announcement');
  assert.equal(f.video.paused,true);
});

test('deferred successful seeks cannot announce after a revision, file or visibility change',async t=>{
  for(const change of ['caption revision','file attachment','document visibility']){
    await t.test(change,async t=>{
      const f=fixture(t,[cue(1,'Footsteps')]);
      f.open();
      await until(()=>f.buttons().length===1,'the original cue');
      let land;
      f.setLanding(()=>new Promise(resolve=>{land=resolve;}));
      f.clickCue();
      assert.deepEqual(f.seeks,[[1,1]]);
      if(change==='caption revision')f.replaceTrack([cue(1,'Applause')]);
      else if(change==='file attachment')f.replaceFile();
      else f.setHidden(true);
      land(true);
      await tick();await tick();
      assert.doesNotMatch(f.node('status').textContent,/Jumped|Jump complete/);
      if(change==='document visibility'){
        f.setHidden(false);
        await until(()=>f.buttons().length===1,'the restored view');
        assert.doesNotMatch(f.node('status').textContent,/Jumped|Jump complete/);
      }
    });
  }
});

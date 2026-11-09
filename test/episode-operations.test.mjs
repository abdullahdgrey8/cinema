import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAddManager} from '../add-manager.mjs';

const HASH='a'.repeat(40),OTHER='b'.repeat(40);
const intent=episode=>({showId:'tvmaze-1',showTitle:'Example Series',episodeId:'tvmaze-episode-'+episode,season:1,episode,kind:'tv',fileVerificationRequired:true});
const source=(episode,changes={})=>({key:'episode-key-'+episode,fileName:'Example Series S01 COMPLETE 1080p',fileUrl:'magnet:?xt=urn:btih:'+HASH,kind:'tv',intent:intent(episode),...changes});
async function fixture(t,{register=true}={}){
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-episode-intent-')),state={torrents:[],adds:0};
  const qb=async(endpoint,args)=>{if(endpoint==='torrents/info')return state.torrents;if(endpoint==='torrents/categories')return {tv:{}};if(endpoint==='torrents/add'){state.adds++;if(register)state.torrents=[{hash:HASH,name:'Example Series S01 COMPLETE 1080p',tags:args.tags}];return '';}return '';};
  const managers=[];const manager=await createAddManager({local,qb});managers.push(manager);
  t.after(async()=>{for(const m of managers)await m.close();assert.equal(path.dirname(path.resolve(local)),path.resolve(os.tmpdir()));assert.ok(path.basename(local).startsWith('cinema-episode-intent-'));await fs.rm(local,{recursive:true,force:true});});
  return {manager,state,async reload(){await manager.close();const next=await createAddManager({local,qb});managers.push(next);return next;}};
}
async function settle(manager,id){for(let i=0;i<200;i++){const op=manager.get(id);if(op.status!=='adding')return op;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Add operation did not settle');}

test('episode intent survives accepted add reconciliation and manager restart',async t=>{
  const f=await fixture(t),created=await f.manager.create(source(1),'tv');await settle(f.manager,created.id);
  f.manager.reconcile(f.state.torrents);assert.deepEqual(f.manager.get(created.id).intent,intent(1));
  const reloaded=await f.reload(),restored=reloaded.get(created.id);assert.equal(restored.hash,HASH);assert.equal(restored.status,'ready');assert.deepEqual(restored.intent,intent(1));assert.equal('source' in restored,false);assert.equal(f.state.adds,1);
});

test('opening a different episode in an existing linked pack durably updates the operation context',async t=>{
  const f=await fixture(t),created=await f.manager.create(source(1),'tv');await settle(f.manager,created.id);f.manager.reconcile(f.state.torrents);
  const reopened=await f.manager.create(source(2),'tv');assert.equal(reopened.id,created.id);assert.deepEqual(reopened.intent,intent(2));assert.equal(reopened.selectionKey,'episode-key-2');
  const restored=(await f.reload()).get(created.id);assert.deepEqual(restored.intent,intent(2));assert.equal(restored.selectionKey,'episode-key-2');assert.equal(f.state.adds,1);
});

test('reusing a pending torrent identity keeps the newest episode and selection key across restart',async t=>{
  const f=await fixture(t,{register:false}),created=await f.manager.create(source(1),'tv');await settle(f.manager,created.id);
  const second=await f.manager.create(source(2),'tv');assert.equal(second.id,created.id);assert.deepEqual(second.intent,intent(2));assert.equal(second.selectionKey,'episode-key-2');
  const restored=(await f.reload()).get(created.id);assert.deepEqual(restored.intent,intent(2));assert.equal(restored.selectionKey,'episode-key-2');assert.equal(f.state.adds,1);
});

test('same-title pending alternative preserves chosen episode when duplicate adds are suppressed',async t=>{
  const f=await fixture(t,{register:false}),created=await f.manager.create(source(1),'tv');await settle(f.manager,created.id);
  const second=await f.manager.create(source(2,{fileUrl:'magnet:?xt=urn:btih:'+OTHER}),'tv');assert.equal(second.id,created.id);assert.equal(second.existing,true);assert.deepEqual(second.intent,intent(2));assert.equal(second.selectionKey,'episode-key-2');
  const restored=(await f.reload()).get(created.id);assert.deepEqual(restored.intent,intent(2));assert.equal(restored.selectionKey,'episode-key-2');assert.equal(f.state.adds,1);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {cinema,HASH,torrent,until,wait} from './helpers.mjs';

const result = (overrides={}) => ({fileName:'Example.Movie.1080p.mp4',fileUrl:`magnet:?xt=urn:btih:${HASH}`,fileSize:36,nbSeeders:20,nbLeechers:3,siteUrl:'https://video.example',descrLink:'https://video.example/details',...overrides});
async function selection(c, source=result(), category='movies', plugin='video') {
  c.state.results=[source];
  const job=await c.api('/api/search',{query:'Example',category,plugin});
  const found=await c.api('/api/results?id='+job.id);
  assert.equal(found.results.length,1);
  return found.results[0];
}
async function terminal(c,operation) {
  if (['ready','failed','uncertain','duplicate'].includes(operation.status)) return operation;
  assert.ok(operation.id,'Every accepted add has a recoverable operation identifier');
  return until(async()=>{
    const next=await c.api('/api/add/status?id='+operation.id);
    return ['ready','failed','uncertain','duplicate'].includes(next.status) && next;
  },{timeout:20000,interval:100,description:'source operation to reconcile with qBittorrent'});
}
function base32(hex) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';
  for(const byte of Buffer.from(hex,'hex'))bits+=byte.toString(2).padStart(8,'0');
  return bits.match(/.{5}/g).map(group=>alphabet[parseInt(group,2)]).join('');
}

test('modern qBittorrent JSON adds reconcile and concurrent retries reuse the torrent',async t=>{
  const c=await cinema(t);
  c.state.handlers['torrents/add']=async({params,send})=>{
    await wait(80);
    c.state.torrents.push(torrent(c.dir,{tags:params.get('tags')}));
    send({success_count:1,pending_count:0,failure_count:0,added_torrent_ids:[HASH]});
  };
  const selected=await selection(c);
  const operations=await Promise.all(Array.from({length:4},()=>c.api('/api/add',{key:selected.key,category:'movies'})));
  const ready=await terminal(c,operations[0]);
  assert.equal(ready.status,'ready');assert.equal(ready.hash,HASH);
  for(const operation of operations)assert.equal(operation.id,operations[0].id,'Concurrent clicks must share one operation');
  const retry=await c.api('/api/add',{key:selected.key,category:'movies'});
  assert.equal((await terminal(c,retry)).hash,HASH);
  const equivalent=await selection(c,result({fileUrl:`magnet:?dn=renamed&xt=urn:btih:${base32(HASH)}`}));
  const reused=await c.api('/api/add',{key:equivalent.key,category:'movies'});
  assert.equal((await terminal(c,reused)).hash,HASH);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1,'Equivalent magnet/repeated click must never enqueue a second download');
});

test('pending HTTP source is matched by tag instead of reporting a false failure',async t=>{
  const c=await cinema(t);let register;
  t.after(()=>clearTimeout(register));
  c.state.handlers['torrents/add']=({params,send})=>{
    register=setTimeout(()=>c.state.torrents.push(torrent(c.dir,{tags:params.get('tags')})),300);
    send({success_count:0,pending_count:1,failure_count:0,added_torrent_ids:[]});
  };
  const selected=await selection(c,result({fileUrl:'https://video.example/download/123.torrent'}));
  const operation=await c.api('/api/add',{key:selected.key,category:'movies'});
  assert.ok(['adding','accepted','ready'].includes(operation.status));
  const ready=await terminal(c,operation);assert.equal(ready.status,'ready');assert.equal(ready.hash,HASH);
  const state=await c.api('/api/state');
  assert.ok(state.operations.some(op=>op.id===operation.id && op.hash===HASH));
  assert.ok(state.library.some(item=>item.hash===HASH),'A registered torrent must appear in the library');
});

test('a different release of a pending title reuses its operation instead of starting another download',async t=>{
  const c=await cinema(t);
  c.state.handlers['torrents/add']=({send})=>send({success_count:0,pending_count:1,failure_count:0,added_torrent_ids:[]});
  const first=await selection(c,result({fileUrl:'https://video.example/first.torrent'}));
  const firstOp=await c.api('/api/add',{key:first.key,category:'movies'});
  await until(()=>c.state.requests.some(r=>r.endpoint==='torrents/add'));
  const second=await selection(c,result({fileName:'Example.Movie.720p.mkv',fileUrl:'https://video.example/second.torrent'}));
  const secondOp=await c.api('/api/add',{key:second.key,category:'movies'});
  assert.equal(secondOp.id,firstOp.id);assert.ok(secondOp.message);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1);
});

test('pending operations survive a server restart and reconcile without resubmitting',async t=>{
  const c=await cinema(t);let submittedTag;
  c.state.handlers['torrents/add']=({params,send})=>{
    submittedTag=params.get('tags');send({success_count:0,pending_count:1,failure_count:0,added_torrent_ids:[]});
  };
  const selected=await selection(c,result({fileUrl:'https://video.example/restart.torrent'}));
  const operation=await c.api('/api/add',{key:selected.key,category:'movies'});
  await until(()=>submittedTag);
  const oldToken=c.token;
  await c.restart();
  assert.notEqual(c.token,oldToken);
  const restored=await c.api('/api/add/status?id='+operation.id);
  assert.equal(restored.id,operation.id);assert.ok(['adding','accepted','uncertain'].includes(restored.status));
  c.state.torrents.push(torrent(c.dir,{tags:submittedTag}));
  const ready=await terminal(c,restored);assert.equal(ready.hash,HASH);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1,'Restart must not resend a pending add');
  assert.equal((await c.request('/api/torrent/action',{hash:HASH,action:'pause'},{headers:{'X-Cinema-Token':oldToken}})).status,403);
});

test('a rejected add becomes a visible failure without silently trying another source',async t=>{
  const c=await cinema(t);
  c.state.handlers['torrents/add']=({send})=>send({success_count:0,pending_count:0,failure_count:1,added_torrent_ids:[]});
  const selected=await selection(c);
  const operation=await c.api('/api/add',{key:selected.key,category:'movies'});
  const failed=await terminal(c,operation);
  assert.equal(failed.status,'failed');assert.ok(failed.message);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1);
  assert.equal(c.state.torrents.length,0);
});

test('explicit failed-source retry reuses its identity and concurrent clicks submit only once',async t=>{
  const c=await cinema(t);
  c.state.handlers['torrents/add']=({send})=>send({success_count:0,pending_count:0,failure_count:1,added_torrent_ids:[]});
  const selected=await selection(c);
  const initial=await c.api('/api/add',{key:selected.key,category:'movies'});
  assert.equal(initial.selectionKey,selected.key,'Response-loss recovery needs the originating selection key');
  assert.equal((await terminal(c,initial)).status,'failed');
  const unconfirmed=await c.request('/api/add/retry',{id:initial.id});assert.equal(unconfirmed.status,400);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1);
  c.state.handlers['torrents/add']=async({params,send})=>{
    await wait(80);c.state.torrents.push(torrent(c.dir,{tags:params.get('tags')}));
    send({success_count:1,pending_count:0,failure_count:0,added_torrent_ids:[HASH]});
  };
  const retries=await Promise.all(Array.from({length:4},()=>c.api('/api/add/retry',{id:initial.id,confirmRetry:true})));
  assert.ok(retries.every(op=>op.id===initial.id));
  const ready=await terminal(c,retries[0]);assert.equal(ready.status,'ready');assert.equal(ready.hash,HASH);assert.equal(ready.attempts,2);
  const submissions=c.state.requests.filter(r=>r.endpoint==='torrents/add');
  assert.equal(submissions.length,2);assert.equal(submissions[0].params.get('tags'),submissions[1].params.get('tags'));
});

test('retry reconciles an uncertain source before any resubmission',async t=>{
  const c=await cinema(t);
  c.state.handlers['torrents/add']=({send})=>send('Source response was interrupted',500);
  const selected=await selection(c,result({fileUrl:'https://video.example/uncertain.torrent'}));
  const initial=await c.api('/api/add',{key:selected.key,category:'movies'});
  assert.equal((await terminal(c,initial)).status,'uncertain');
  const submission=c.state.requests.find(r=>r.endpoint==='torrents/add');
  c.state.torrents.push(torrent(c.dir,{tags:submission.params.get('tags')}));
  const reused=await c.api('/api/add/retry',{id:initial.id,confirmRetry:true});
  assert.equal(reused.status,'ready');assert.equal(reused.hash,HASH);assert.equal(reused.id,initial.id);
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1,'A late registration must prevent another source submission');
});

test('a second release of an existing title needs an explicit duplicate choice',async t=>{
  const c=await cinema(t);
  c.state.torrents=[torrent(c.dir,{name:'Example.Movie.720p.mp4'})];
  c.state.handlers['torrents/add']=({params,send})=>{
    const h='b'.repeat(40);c.state.torrents.push(torrent(c.dir,{hash:h,tags:params.get('tags')}));
    send({success_count:1,pending_count:0,failure_count:0,added_torrent_ids:[h]});
  };
  const selected=await selection(c,result({fileUrl:`magnet:?xt=urn:btih:${'b'.repeat(40)}`}));
  const duplicate=await c.api('/api/add',{key:selected.key,category:'movies'});
  assert.equal(duplicate.status,'duplicate');assert.ok(duplicate.duplicateCandidates.some(x=>x.hash===HASH));
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,0);
  const approved=await c.api('/api/add',{key:selected.key,category:'movies',allowDuplicate:true});
  assert.equal((await terminal(c,approved)).hash,'b'.repeat(40));
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/add').length,1);
});

test('state reflects external qBittorrent changes and exposes advertised miscellaneous plugin categories',async t=>{
  const c=await cinema(t);
  c.state.torrents=[torrent(c.dir,{state:'stalledDL',progress:.2,dlspeed:0,eta:8640000,category:'anime'})];
  let state=await until(async()=>{const s=await c.api('/api/state');return s.library.some(x=>x.hash===HASH)&&s;});
  assert.equal(state.connected,true);assert.equal(state.library[0].hash,HASH);assert.equal(state.library[0].kind,'anime');
  assert.ok(state.library[0].statusLabel);assert.ok(state.updatedAt);
  const plugins=await c.api('/api/plugins');
  const misc=plugins.find(p=>p.name==='misc');assert.ok(misc.groups.some(g=>['misc','other'].includes(g)));
  assert.ok(misc.supportedCategories.some(cat=>cat.id==='books'));
  await c.api('/api/search',{query:'A book',category:'books',plugin:'misc'});
  assert.equal(c.state.searches.at(-1).plugins,'misc');assert.equal(c.state.searches.at(-1).category,'books');
  const invalid=await c.request('/api/search',{query:'A book',category:'books',plugin:'disabled'});assert.equal(invalid.status,400);
  c.state.torrents[0].state='stoppedDL';c.state.torrents[0].progress=.65;
  state=await until(async()=>{const s=await c.api('/api/state');return s.library[0]?.progress===.65&&s;});assert.equal(state.library[0].state,'stoppedDL');
  c.state.torrents=[];
  state=await until(async()=>{const s=await c.api('/api/state');return s.library.length===0&&s;});assert.equal(state.library.length,0,'External removals must leave the UI state');
});

test('losing qBittorrent keeps the last known library visible and reconnects without an app restart',async t=>{
  const c=await cinema(t);c.state.torrents=[torrent(c.dir,{progress:.4})];
  const initial=await until(async()=>{const s=await c.api('/api/state');return s.connected&&s.library.length===1&&s;});
  c.state.handlers['torrents/info']=({send})=>send('Temporarily unavailable',503);
  const offline=await until(async()=>{const s=await c.api('/api/state');return !s.connected&&s;});
  assert.equal(offline.library[0].hash,HASH);assert.equal(offline.library[0].progress,.4);
  assert.equal(offline.updatedAt,initial.updatedAt);assert.ok(offline.error);
  delete c.state.handlers['torrents/info'];c.state.torrents[0].progress=.9;
  const recovered=await until(async()=>{const s=await c.api('/api/state');return s.connected&&s.library[0]?.progress===.9&&s;});
  assert.ok(recovered.updatedAt>offline.updatedAt);assert.equal(recovered.error,null);
});

test('pause/resume target only the chosen torrent and deletion needs exact confirmation',async t=>{
  const c=await cinema(t);c.state.torrents=[torrent(c.dir)];
  await c.api('/api/torrent/action',{hash:HASH,action:'pause'});
  await c.api('/api/torrent/action',{hash:HASH,action:'resume'});
  const pauses=c.state.requests.filter(r=>['torrents/stop','torrents/pause'].includes(r.endpoint));
  const starts=c.state.requests.filter(r=>['torrents/start','torrents/resume'].includes(r.endpoint));
  assert.equal(pauses.length,1);assert.equal(pauses[0].params.get('hashes'),HASH);
  assert.equal(starts.length,1);assert.equal(starts[0].params.get('hashes'),HASH);
  const unconfirmed=await c.request('/api/torrent/action',{hash:HASH,action:'delete',deleteFiles:true});
  assert.ok(unconfirmed.status>=400);assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/delete').length,0);
  const ambiguous=await c.request('/api/torrent/action',{hash:HASH,action:'delete',confirmName:c.state.torrents[0].name});
  assert.ok(ambiguous.status>=400,'Deleting needs an explicit choice about the retained files');
  assert.equal(c.state.requests.filter(r=>r.endpoint==='torrents/delete').length,0);
  await c.api('/api/torrent/action',{hash:HASH,action:'delete',deleteFiles:false,confirmName:c.state.torrents[0].name});
  const deletion=c.state.requests.find(r=>r.endpoint==='torrents/delete');
  assert.equal(deletion.params.get('hashes'),HASH);assert.equal(deletion.params.get('deleteFiles'),'false');
});

test('explicit file deletion cleans only that torrent playback copies, while keep-files retains them',async t=>{
  const c=await cinema(t);c.state.torrents=[torrent(c.dir)];
  const other='b'.repeat(40);
  const selectedHls=path.join(c.dir,'hls',HASH+'-0','abcdef123456','seg000000.ts');
  const otherHls=path.join(c.dir,'hls',other+'-0','abcdef123456','seg000000.ts');
  const selectedCopy=path.join(c.dir,'playback',HASH+'-0.mp4');
  const otherCopy=path.join(c.dir,'playback',other+'-0.mp4');
  for(const filename of [selectedHls,otherHls,selectedCopy,otherCopy]){
    await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,'fixture');
  }
  await c.api('/api/torrent/action',{hash:HASH,action:'delete',deleteFiles:false,confirmName:c.state.torrents[0].name});
  assert.equal(await fs.readFile(selectedHls,'utf8'),'fixture');assert.equal(await fs.readFile(selectedCopy,'utf8'),'fixture');
  await c.api('/api/torrent/action',{hash:HASH,action:'delete',deleteFiles:true,confirmName:c.state.torrents[0].name});
  assert.equal(await fs.access(selectedHls).then(()=>true,()=>false),false);
  assert.equal(await fs.access(selectedCopy).then(()=>true,()=>false),false);
  assert.equal(await fs.readFile(otherHls,'utf8'),'fixture');assert.equal(await fs.readFile(otherCopy,'utf8'),'fixture');
  const deletions=c.state.requests.filter(r=>r.endpoint==='torrents/delete');
  assert.deepEqual(deletions.map(r=>r.params.get('deleteFiles')),['false','true']);
});

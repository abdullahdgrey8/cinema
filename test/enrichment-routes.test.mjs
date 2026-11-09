import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cinema} from './helpers.mjs';

const captions='1\n00:00:01,200 --> 00:00:03,450\nA local caption.\n';

test('subtitle routes protect imports and persist normalized WebVTT across a server restart',async t=>{
  const c=await cinema(t);
  const unauthenticated=await fetch(c.base+'/api/subtitles/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'en.srt',text:captions})});
  assert.equal(unauthenticated.status,403);
  const imported=await c.api('/api/subtitles/import',{name:'../English.srt',text:captions});
  assert.equal(imported.name,'English.srt');assert.equal(imported.cues,1);assert.match(imported.id,/^[a-f0-9]{32}$/);assert.equal(imported.url,'/api/subtitles/file?id='+imported.id);
  let response=await c.request(imported.url);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/vtt/);
  const text=await response.text();assert.match(text,/^WEBVTT\n\n/);assert.match(text,/00:00:01\.200 --> 00:00:03\.450/);
  response=await c.request(imported.url,undefined,{method:'HEAD'});assert.equal(response.status,200);assert.equal(await response.text(),'');
  await c.restart();response=await c.request(imported.url);assert.equal(response.status,200);assert.equal(await response.text(),text);
  for(const id of ['../../connection.json','%2f..%2fconnection.json','x'.repeat(32),'f'.repeat(32)]){
    assert.equal((await c.request('/api/subtitles/file?id='+encodeURIComponent(id))).status,404);
  }
  assert.equal(c.state.requests.filter(r=>r.endpoint==='search/start'||r.endpoint==='torrents/add').length,0,'Import and subtitle playback must not run provider searches or add torrents');
});

test('subtitle import handles larger caption files while enforcing JSON and text size limits',async t=>{
  const c=await cinema(t);
  const large=Array.from({length:1400},(_,i)=>`${i+1}\n00:00:01,000 --> 00:00:02,000\n${'A caption. '.repeat(6)}`).join('\n\n');
  assert.ok(Buffer.byteLength(large)>65536);
  assert.equal((await c.api('/api/subtitles/import',{name:'large.srt',text:large})).cues,1400);
  const invalidJson=await c.request('/api/subtitles/import',undefined,{method:'POST',headers:{'X-Cinema-Token':c.token,'Content-Type':'application/json'},body:'{"name":'});assert.equal(invalidJson.status,400);
  const textTooLarge=await c.request('/api/subtitles/import',{name:'huge.srt',text:'x'.repeat(2*1024*1024+1)});assert.equal(textTooLarge.status,413);
  const jsonTooLarge=await c.request('/api/subtitles/import',{name:'huge.srt',text:'x'.repeat(3*1024*1024+1)});assert.equal(jsonTooLarge.status,413);
  assert.equal((await c.request('/api/subtitles/import',{name:'error.srt',text:'<html><body>Access denied</body></html>'})).status,400);
  assert.equal((await c.request('/api/subtitles/download',{id:'https://127.0.0.1/private'})).status,404);
});

test('enrichment and discovery browser modules are delivered as same-origin JavaScript',async t=>{
  const c=await cinema(t);
  for(const route of ['/enrichment.js','/discovery.js']){
    const response=await c.request(route);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/javascript/);
    assert.match(response.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await response.text(),/export function/);
  }
  const response=await c.request('/app.js');const app=await response.text();assert.match(app,/['"]\.\/enrichment\.js['"]/);assert.match(app,/['"]\.\/discovery\.js['"]/);
});

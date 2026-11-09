import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createQbit} from '../qbit-client.mjs';

// These tests use only an isolated local HTTP server and synthetic credentials.
// Requests are recorded at the public qBittorrent boundary, not client internals.
async function connection(t) {
  const requests=[],handlers=new Map();
  const server=http.createServer((req,res)=>{
    const endpoint=new URL(req.url,'http://localhost').pathname.replace('/api/v2/','');
    requests.push({endpoint,method:req.method,cookie:req.headers.cookie});
    req.resume();
    if(endpoint==='auth/login'){
      res.setHeader('Set-Cookie','SID=ordinary-session; Path=/; HttpOnly');
      res.end('Ok.');return;
    }
    if(handlers.has(endpoint)){handlers.get(endpoint)(req,res);return;}
    assert.equal(req.headers.cookie,'SID=ordinary-session');
    res.end(endpoint==='app/version'?'v5.2.4':'[]');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  let config={url:`http://127.0.0.1:${server.address().port}`,username:'fixture',password:'fixture'};
  const client=createQbit(()=>config);
  await client.qb('app/version');
  return {client,requests,handlers,get config(){return config;},replace(){config={...config,username:'replacement'};}};
}

test('scene 401 and 403 responses never relogin or replace the ordinary cookie',async t=>{
  const c=await connection(t), reader=c.client.sceneReader(new AbortController().signal);
  for(const status of [401,403]){
    c.handlers.set('torrents/properties',(_req,res)=>{
      res.writeHead(status,{'Set-Cookie':'SID=poisoned; Path=/'});res.end('Not authorized');
    });
    await assert.rejects(reader.json('torrents/properties',{hash:'a'.repeat(40)}),{code:'scene-changed'});
  }
  assert.equal(c.requests.filter(request=>request.endpoint==='auth/login').length,1);
  await c.client.qb('app/version');
  assert.equal(c.requests.at(-1).cookie,'SID=ordinary-session');
  assert.deepEqual(c.requests.filter(request=>request.endpoint==='torrents/properties').map(request=>request.method),['GET','GET']);
  const count=c.requests.length;
  await assert.rejects(reader.raw('torrents/delete',{hashes:'a'.repeat(40)}),/Invalid scene observation endpoint/);
  assert.equal(c.requests.length,count,'A scene reader must never send a mutation endpoint');
});

test('a captured reader refuses new configuration before sending any request',async t=>{
  const c=await connection(t), reader=c.client.sceneReader(new AbortController().signal), count=c.requests.length;
  c.replace();
  await assert.rejects(reader.json('torrents/info',{hashes:'a'.repeat(40)}),{code:'scene-changed'});
  assert.equal(c.requests.length,count);
});

test('configuration replacement during a held response fails without retry or authentication',async t=>{
  const c=await connection(t), reader=c.client.sceneReader(new AbortController().signal);
  let release;
  const received=new Promise(resolve=>{
    c.handlers.set('torrents/properties',(_req,res)=>{release=()=>res.end('{}');resolve();});
  });
  const request=reader.json('torrents/properties',{hash:'a'.repeat(40)});
  const rejected=assert.rejects(request,{code:'scene-changed'});
  await received;c.replace();release();await rejected;
  assert.equal(c.requests.filter(request=>request.endpoint==='torrents/properties').length,1);
  assert.equal(c.requests.filter(request=>request.endpoint==='auth/login').length,1);
});

test('abort interrupts an in-flight scene body without resetting ordinary authentication',{timeout:5000},async t=>{
  const c=await connection(t), control=new AbortController(), reader=c.client.sceneReader(control.signal);
  let onClose;
  const closed=new Promise(resolve=>{onClose=resolve;});
  const received=new Promise(resolve=>{
    c.handlers.set('torrents/properties',(_req,res)=>{
      res.once('close',onClose);
      res.writeHead(200,{'Content-Type':'application/json'});res.write('{');resolve();
    });
  });
  const reading=reader.json('torrents/properties',{hash:'a'.repeat(40)}), rejected=assert.rejects(reading,{name:'AbortError'});
  await received;control.abort();await rejected;
  // A subsequent ordinary request shares its authenticated cookie, proving the
  // cancelled scene did not reset the application's normal qBittorrent session.
  await c.client.qb('app/version');
  assert.equal(c.requests.filter(request=>request.endpoint==='auth/login').length,1);
  await closed;
});

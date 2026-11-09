import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const HASH = 'a'.repeat(40);
export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function until(check, {timeout = 10000, interval = 50, description = 'condition'} = {}) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (value) return value;
    await wait(interval);
  }
  assert.fail(`Timed out waiting for ${description}; last value: ${JSON.stringify(value)}`);
}

// Every server uses a private temporary directory and a mock qBittorrent. Tests
// never use the user's saved connection, real torrents, or download directory.
export async function cinema(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-test-'));
  const state = {
    torrents: [], files: new Map(), properties: {piece_size: 16}, pieces: [],
    plugins: [
      {name:'video', fullName:'Video source', enabled:true, url:'https://video.example', supportedCategories:[{id:'all', name:'All'},{id:'movies',name:'Movies'},{id:'tv',name:'TV shows'}]},
      {name:'anime', fullName:'Anime source', enabled:true, url:'https://anime.example', supportedCategories:[{id:'all',name:'All'},{id:'anime',name:'Anime'}]},
      {name:'misc', fullName:'Misc source', enabled:true, url:'https://misc.example', supportedCategories:[{id:'all',name:'All'},{id:'books',name:'Books'},{id:'software',name:'Software'}]},
      {name:'disabled', fullName:'Disabled source', enabled:false, url:'https://disabled.example', supportedCategories:[{id:'all',name:'All'}]},
    ],
    results: [], searches: [], requests: [], categories: {}, handlers: {},
    authCookieName:'SID',authCookieValue:'test',authStatus:200,authExtraCookies:[],
    transfer: {dl_info_speed:0,up_info_speed:0,connection_status:'connected'},
    ...overrides,
  };
  const fake = http.createServer(async (req,res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const endpoint = u.pathname.replace('/api/v2/', '');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const params = req.method === 'GET' ? u.searchParams : new URLSearchParams(rawBody.toString());
      state.requests.push({endpoint, method:req.method, params, rawBody, headers:req.headers});
      const send = (value, status = 200) => {
        res.statusCode=status;
        res.setHeader('Content-Type', typeof value === 'string' ? 'text/plain' : 'application/json');
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      if (endpoint === 'auth/login') {
        res.setHeader('Set-Cookie',[...state.authExtraCookies,`${state.authCookieName}=${state.authCookieValue}; Path=/; HttpOnly; SameSite=Strict`]);
        return send('Ok.',state.authStatus);
      }
      if (req.headers.cookie !== `${state.authCookieName}=${state.authCookieValue}`) return send('Forbidden', 403);
      if (state.handlers[endpoint]) return await state.handlers[endpoint]({req,res,params,rawBody,state,send});
      if (endpoint === 'app/version') return send('v5.2.4');
      if (endpoint === 'app/webapiVersion') return send('2.11.4');
      if (endpoint === 'transfer/info') return send(state.transfer);
      if (endpoint === 'torrents/info') {
        const hashes = params.get('hashes')?.split('|');
        return send(state.torrents.filter(x => !hashes || hashes.includes(x.hash)));
      }
      if (endpoint === 'torrents/files') return send(state.files.get(params.get('hash')) || []);
      if (endpoint === 'torrents/properties') return send(state.properties);
      if (endpoint === 'torrents/pieceStates') return send(state.pieces);
      if (endpoint === 'torrents/categories') return send(state.categories);
      if (endpoint === 'torrents/createCategory') {
        state.categories[params.get('category')]={name:params.get('category'),savePath:''};
        return send('');
      }
      if (endpoint === 'search/plugins') return send(state.plugins);
      if (endpoint === 'search/start') {
        const id = state.searches.length + 1;
        state.searches.push({id, ...Object.fromEntries(params)});
        return send({id});
      }
      if (endpoint === 'search/results') {
        const offset=Number(params.get('offset'))||0,limit=Number(params.get('limit'))||500;
        return send({status:'Stopped',total:state.results.length,results:state.results.slice(offset,offset+limit)});
      }
      if (endpoint === 'search/status') return send(state.searches.map(s=>({id:s.id,status:'Stopped',total:state.results.length})));
      return send('');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  fake.listen(0,'127.0.0.1'); await once(fake,'listening');
  await fs.writeFile(path.join(dir,'connection.json'), JSON.stringify({url:`http://127.0.0.1:${fake.address().port}`,username:'test',password:'test'}));
  const probe = http.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  let child,token,diagnostics='';
  function launch() {
    child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),CINEMA_DATA_DIR:dir},stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',b=>diagnostics+=b); child.stderr.on('data',b=>diagnostics+=b);
  }
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) { const ended=once(child,'exit'); child.kill(); await ended; }
  }
  launch();
  const base=`http://127.0.0.1:${port}`;
  t.after(async()=>{
    await stop();
    fake.closeAllConnections(); await new Promise(resolve=>fake.close(resolve));
    const resolved=path.resolve(dir), parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),parent,'Cleanup must stay in the temporary directory');
    assert.ok(path.basename(resolved).startsWith('cinema-test-'));
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  async function connect() {
    await until(async()=>{
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Cinema exited: ${diagnostics}`);
      return fetch(base+'/api/session').then(r=>r.ok).catch(()=>false);
    },{description:`Cinema startup (${base})`});
    token=(await (await fetch(base+'/api/session')).json()).token;
  }
  await connect();
  async function restart() {await stop();launch();await connect();}
  const request=(route, data, init={})=>fetch(base+route,{...init,method:data === undefined ? (init.method || 'GET') : 'POST',headers:{...(data === undefined ? {} : {'Content-Type':'application/json','X-Cinema-Token':token}),...init.headers},...(data === undefined ? {} : {body:JSON.stringify(data)})});
  async function api(route,data) {
    const r=await request(route,data); const body=await r.json();
    assert.ok(r.ok,`${route}: HTTP ${r.status}: ${JSON.stringify(body)}; ${diagnostics}`);
    return body;
  }
  return {dir,state,base,get token(){return token;},request,api,get child(){return child;},restart};
}

export function torrent(dir, changes={}) {
  return {hash:HASH,name:'Example.Movie.1080p.mp4',save_path:dir,progress:1,size:36,total_size:36,
    downloaded:36,dlspeed:0,upspeed:0,eta:0,num_seeds:5,num_leechs:1,state:'uploading',
    seq_dl:true,f_l_piece_prio:true,category:'movies',tags:'',added_on:1,amount_left:0,...changes};
}

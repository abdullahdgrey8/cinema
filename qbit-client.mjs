import {X509Certificate} from 'node:crypto';
import {Agent,request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {checkServerIdentity} from 'node:tls';

const sceneRoute='torrents/cinemaScene';
const sceneLeaseId=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function scenePair(origin,key,certificate){
  if(typeof key!=='string'||!/^[a-f\d]{64}$/.test(key)||typeof origin!=='string'||!certificate)return null;
  try{
    const url=new URL(origin);
    if(url.origin!==origin||url.protocol!=='https:'||url.hostname!=='127.0.0.1'||!url.port)return null;
    const leaf=new X509Certificate(certificate);
    if(!leaf.checkIP(url.hostname))return null;
    const agent=new Agent({ca:leaf.toString(),rejectUnauthorized:true,maxCachedSessions:0,maxSockets:6,checkServerIdentity(host,peer){
      return checkServerIdentity(host,peer)||(peer.fingerprint256===leaf.fingerprint256?undefined:
        Error('The qBittorrent companion certificate changed.'));
    }});
    return {origin,key,agent};
  }catch{return null;}
}

function pinnedRequest(url,{method='GET',headers,body,signal},agent){
  const payload=body?.toString();
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method,agent,signal,headers:{...headers,...(payload!==undefined?{
      'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(payload)}:{})}},incoming=>{
      try{
        const headers=new Headers();
        for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
        const status=incoming.statusCode;
        const stream=[204,205,304].includes(status)?null:Readable.toWeb(incoming);
        if(!stream)incoming.resume();
        resolve(new Response(stream,{status,headers}));
      }catch(error){incoming.destroy();reject(error);}
    });
    request.once('error',reject);
    request.end(payload);
  });
}

export function createQbit(getConfig,{sceneOrigin,sceneKey,sceneCertificate}={}){
  let cookie='',loginPromise,generation=0;
  const pairing=scenePair(sceneOrigin,sceneKey,sceneCertificate);
  function acceptsSceneOrigin(origin){return Boolean(pairing&&origin===pairing.origin);}
  function send(url,options){
    if(acceptsSceneOrigin(url.origin))return pinnedRequest(url,options,pairing.agent);
    if(url.protocol==='https:')throw Error('The qBittorrent companion is unpaired.');
    return fetch(url,options);
  }
  async function request(endpoint,params,method='GET',signal){
    const config=getConfig(),u=new URL('/api/v2/'+endpoint,config.url);if(method==='GET'&&params)u.search=new URLSearchParams(params);
    const timeout=AbortSignal.timeout(20000);
    let response;try{response=await send(u,{method,headers:{Referer:config.url+'/',Cookie:cookie,...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},body:method==='POST'?new URLSearchParams(params):undefined,signal:signal?AbortSignal.any([signal,timeout]):timeout});}catch{const e=Error('qBittorrent is not responding. Your downloads may still be running; reconnect to check.');e.status=503;throw e;}
    const sessionCookies=response.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>/^(?:SID|QBT_SID_\d+)=/.test(value));
    if(sessionCookies.length)cookie=sessionCookies.join('; ');return response;
  }
  async function login(signal){const c=getConfig(),r=await request('auth/login',{username:c.username,password:c.password},'POST',signal),body=(await r.text()).trim();if(!r.ok||!(body==='Ok.'||(r.status===204&&cookie))){cookie='';const e=Error('qBittorrent login failed. Check Connection settings.');e.status=401;throw e;}}
  async function authenticate(signal){loginPromise ||= login(signal).finally(()=>{loginPromise=null;});return loginPromise;}
  async function raw(endpoint,params,method='GET',beforeSend){
    const epoch=generation;
    async function attempt(){
      if(beforeSend){
        await beforeSend();
        if(epoch!==generation)throw Object.assign(Error('The qBittorrent connection changed before this download was sent.'),{qbitStatus:409});
      }
      return request(endpoint,params,method);
    }
    if(!cookie)await authenticate();let r=await attempt();
    if([401,403].includes(r.status)){cookie='';await authenticate();r=await attempt();}
    if(!r.ok){const details=(await r.text()).slice(0,250);const e=Error(`qBittorrent ${endpoint}: ${details||'HTTP '+r.status}`);e.status=502;e.qbitStatus=r.status;throw e;}return r;
  }
  async function qb(endpoint,params,method='GET',beforeSend){const r=await raw(endpoint,params,method,beforeSend),t=await r.text();try{return JSON.parse(t);}catch{return t;}}
  function sceneReader(signal){
    const config=getConfig(),url=config.url,session=cookie,epoch=generation;
    const endpoints=new Set(['torrents/info','torrents/files','torrents/pieceStates','torrents/export','torrents/properties','app/preferences']);
    function assertConnection(){
      if(!session||epoch!==generation||config!==getConfig()){
        throw Object.assign(Error('The qBittorrent connection changed.'),{code:'scene-changed'});
      }
    }
    function assertCurrent(){signal.throwIfAborted();assertConnection();}
    async function read(endpoint,params,phaseSignal){
      assertCurrent();
      phaseSignal?.throwIfAborted();
      if(!endpoints.has(endpoint))throw Error('Invalid scene observation endpoint');
      const u=new URL('/api/v2/'+endpoint,url);
      if(params)u.search=new URLSearchParams(params);
      const response=await send(u,{headers:{Referer:url+'/',Cookie:session},redirect:'error',
        signal:AbortSignal.any([signal,AbortSignal.timeout(4000),...(phaseSignal?[phaseSignal]:[])])});
      try{
        assertCurrent();
        if(response.status===401||response.status===403)throw Object.assign(Error('The qBittorrent connection changed.'),{code:'scene-changed'});
        if(!response.ok)throw Object.assign(Error('qBittorrent could not observe this download.'),
          {code:'scene-unavailable',qbitStatus:response.status});
        return response;
      }catch(error){
        await response.body?.cancel().catch(()=>{});
        throw error;
      }
    }
    function pairedScheduler(){
      if(!acceptsSceneOrigin(url))return null;
      const endpoint=new URL('/api/v2/'+sceneRoute,pairing.origin);
      const authorization='Basic '+Buffer.from(`${config.username}:${config.password}`).toString('base64');
      const unavailable=()=>Object.assign(Error('The scene fetch engine is unavailable.'),{code:'scene-fetch-unavailable'});
      async function call(operation,params={},parent){
        parent?.throwIfAborted();assertConnection();
        const timeout=AbortSignal.timeout(operation==='request'?1250:750);
        const requestSignal=parent?AbortSignal.any([parent,timeout]):timeout;
        let response;
        try{
          response=await send(endpoint,{method:'POST',redirect:'error',headers:{Origin:pairing.origin,Referer:pairing.origin+'/',
            Cookie:session,Authorization:authorization,'X-Cinema-Scene-Key':pairing.key},
          body:new URLSearchParams({operation,...params}),signal:requestSignal});
          assertConnection();
          if(!response.ok){
            await response.body?.cancel().catch(()=>{});
            if([404,409].includes(response.status))return null;
            throw unavailable();
          }
          const chunks=[];
          let length=0;
          for await(const value of response.body){
            length+=value.byteLength;
            if(length>1024)throw unavailable();
            chunks.push(value);
          }
          assertConnection();requestSignal.throwIfAborted();
          return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
        }catch(error){
          await response?.body?.cancel().catch(()=>{});
          parent?.throwIfAborted();assertConnection();
          throw unavailable();
        }
      }
      function lease(value,id){
        if(value===null)return null;
        if(!value||typeof value.id!=='string'||!sceneLeaseId.test(value.id)||(id&&id!==value.id)||
          !Number.isInteger(value.pieces)||value.pieces<1||value.pieces>16||!Number.isInteger(value.verified)||
          value.verified<0||value.verified>value.pieces||value.state!==(value.verified===value.pieces?'complete':'requested')||
          !Number.isInteger(value.ttlMs)||value.ttlMs<0||value.ttlMs>6000)throw unavailable();
        const {id:leaseId,pieces,verified,state,ttlMs}=value;
        return {id:leaseId,pieces,verified,state,ttlMs};
      }
      return {
        async available(){
          try{const value=await call('capability',{},signal);return value?.version===1&&value.available===true;}
          catch{assertCurrent();return false;}
        },
        async request({hash,index,size,reserve,ranges}){
          assertCurrent();
          // Once issued, retain the bounded reply long enough to identify and cancel the lease.
          return lease(await call('request',{hash,file:index,size,reserve:reserve.join(':'),
            ranges:ranges.map(range=>range.join(':')).join(',')}));
        },
        async status(hash,id){return lease(await call('status',{hash,id},signal),id);},
        async cancel(hash,id){await call('cancel',{hash,id});},
      };
    }
    return {raw:read,scheduler:pairedScheduler(),async json(endpoint,params,phaseSignal){
      const response=await read(endpoint,params,phaseSignal),chunks=[];
      let length=0;
      for await(const value of response.body){
        assertCurrent();
        phaseSignal?.throwIfAborted();
        length+=value.byteLength;
        if(length>2*1024*1024)throw Object.assign(Error('Scene observation exceeds its bound.'),{code:'scene-limit'});
        chunks.push(value);
      }
      assertCurrent();
      phaseSignal?.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
    }};
  }
  return {qb,raw,sceneReader,acceptsSceneOrigin,login:authenticate,reset(){generation++;cookie='';loginPromise=null;}};
}

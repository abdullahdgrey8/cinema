// An isolated local-only qBittorrent profile and synthetic BitTorrent peer.
// The public swarm, production profile and retained downloads are never used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,pbkdf2Sync,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {until,wait} from './helpers.mjs';

const pieceSize=65536;
const protocol=Buffer.from('BitTorrent protocol');
const peerId=Buffer.from('-CL0002-000000000000');
function bencode(value){
  if(Buffer.isBuffer(value))return Buffer.concat([Buffer.from(value.length+':'),value]);
  if(typeof value==='string')return bencode(Buffer.from(value));
  if(typeof value==='number')return Buffer.from('i'+value+'e');
  return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(key=>[bencode(key),bencode(value[key])]),Buffer.from('e')]);
}
async function freePort(){
  const server=net.createServer();
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

export async function realQbitFixture(c,fixture){
  const profile=path.join(c.dir,'isolated-qbit'),config=path.join(profile,'qBittorrent','config'),downloads=path.join(profile,'downloads');
  await fs.mkdir(config,{recursive:true});await fs.mkdir(downloads);
  const [port,torrentPort]=await Promise.all([freePort(),freePort()]);
  const url='http://127.0.0.1:'+port,username='cinema-fixture',password='private-fixture-only';
  const salt=randomBytes(16),encoded=salt.toString('base64')+':'+pbkdf2Sync(password,salt,100000,64,'sha512').toString('base64');
  await fs.writeFile(path.join(config,'qBittorrent.ini'),String.raw`[LegalNotice]
Accepted=true
[GUI]
StartUpWindowState=Hidden
[Preferences]
WebUI\Enabled=true
WebUI\Address=127.0.0.1
WebUI\Port=${port}
WebUI\LocalHostAuth=false
WebUI\Username=${username}
WebUI\Password_PBKDF2=@ByteArray(${encoded})
WebUI\CSRFProtection=false
WebUI\HostHeaderValidation=true
Connection\UPnP=false
[BitTorrent]
Session\DHTEnabled=false
Session\LSDEnabled=false
Session\PeXEnabled=false
Session\UPnP=false
Session\Port=${torrentPort}
Session\InterfaceAddress=127.0.0.1
Session\DefaultSavePath=${downloads.split(path.sep).join('/')}
`);
  const executable=path.join(process.env.ProgramFiles||'C:\\Program Files','qBittorrent','qbittorrent.exe');
  const client=spawn(executable,['--profile='+profile,'--webui-port='+port,'--torrenting-port='+torrentPort,'--confirm-legal-notice','--no-splash'],{windowsHide:true,stdio:'ignore'});
  let launchError,peer,file,available=fixture.have/pieceSize,requests=0,closed=false;
  client.on('error',error=>launchError=error);
  const sockets=new Map();
  async function qb(endpoint,params){
    const response=await fetch(url+'/api/v2/'+endpoint,{method:params?'POST':'GET',signal:AbortSignal.timeout(2000),body:params?(params instanceof FormData?params:new URLSearchParams(params)):undefined});
    const raw=await response.text();assert.ok(response.ok,endpoint+' failed: HTTP '+response.status);
    try{return JSON.parse(raw);}catch{return raw;}
  }
  async function close(){
    if(closed)return;closed=true;
    for(const socket of sockets.keys())socket.destroy();
    if(peer)await new Promise(resolve=>peer.close(resolve));
    if(client.exitCode===null&&client.pid){
      await qb('app/shutdown',{}).catch(()=>{});
      for(let i=0;i<25&&client.exitCode===null;i++)await wait(100);
      if(client.exitCode===null){const exited=once(client,'exit');client.kill();await exited;}
    }
    await file?.close();
  }
  try{
    const version=await until(async()=>{
      if(launchError)throw launchError;
      if(client.exitCode!==null)throw Error('Isolated qBittorrent exited.');
      return qb('app/version').catch(()=>null);
    },{timeout:15000,interval:250,description:'isolated qBittorrent startup'});
    assert.deepEqual(await qb('torrents/info'),[],'Real test must use a fresh profile');
    await qb('app/setPreferences',{json:JSON.stringify({dht:false,pex:false,lsd:false,upnp:false,random_port:false,listen_port:torrentPort,save_path:downloads})});
    const prefs=await qb('app/preferences');
    assert.equal(prefs.dht,false);assert.equal(prefs.pex,false);assert.equal(prefs.lsd,false);
    assert.equal(path.resolve(prefs.save_path),downloads);
    file=await fs.open(fixture.remainder,'r');
    const size=(await file.stat()).size,count=Math.ceil(size/pieceSize),hashes=[],piece=Buffer.alloc(pieceSize);
    for(let index=0;index<count;index++){
      const {bytesRead}=await file.read(piece,0,pieceSize,index*pieceSize);
      hashes.push(createHash('sha1').update(piece.subarray(0,bytesRead)).digest());
    }
    const info={name:'Local-peer-streaming-test.mkv',length:size,'piece length':pieceSize,pieces:Buffer.concat(hashes),private:1};
    const hash=createHash('sha1').update(bencode(info)).digest('hex');
    peer=net.createServer(socket=>{
      let pending=Buffer.alloc(0),handshake=false;
      const frame=(type,payload=Buffer.alloc(0))=>{
        if(socket.destroyed)return;
        const header=Buffer.alloc(5);header.writeUInt32BE(payload.length+1);header[4]=type;
        socket.write(Buffer.concat([header,payload]));
      };
      sockets.set(socket,frame);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      socket.on('data',chunk=>{
        pending=Buffer.concat([pending,chunk]);
        if(!handshake){
          if(pending.length<68)return;
          if(pending[0]!==19||pending.subarray(28,48).toString('hex')!==hash){socket.destroy();return;}
          handshake=true;pending=pending.subarray(68);
          socket.write(Buffer.concat([Buffer.from([19]),protocol,Buffer.alloc(8),Buffer.from(hash,'hex'),peerId]));
          const bitfield=Buffer.alloc(Math.ceil(count/8));
          for(let index=0;index<available;index++)bitfield[index>>3]|=0x80>>(index&7);
          frame(5,bitfield);frame(1);
        }
        while(pending.length>=4){
          const length=pending.readUInt32BE();
          if(length>1048576){socket.destroy();return;}
          if(pending.length<length+4)return;
          const message=pending.subarray(4,length+4);pending=pending.subarray(length+4);
          if(message[0]!==6||message.length!==13)continue;
          const index=message.readUInt32BE(1),begin=message.readUInt32BE(5),lengthRequested=message.readUInt32BE(9);
          const at=index*pieceSize+begin;
          if(index>=available||!lengthRequested||lengthRequested>16384||begin+lengthRequested>pieceSize||at+lengthRequested>size)continue;
          requests++;
          const payload=Buffer.alloc(8+lengthRequested);payload.writeUInt32BE(index);payload.writeUInt32BE(begin,4);
          void file.read(payload,8,lengthRequested,at).then(({bytesRead})=>{
            if(bytesRead===lengthRequested)frame(7,payload);
          }).catch(()=>socket.destroy());
        }
      });
    });
    peer.listen(0,'127.0.0.1');await once(peer,'listening');
    const form=new FormData();
    form.append('torrents',new Blob([bencode({info})]),'local-peer.torrent');
    form.append('savepath',downloads);form.append('sequentialDownload','true');form.append('firstLastPiecePrio','true');
    await qb('torrents/add',form);
    const status=async()=>(await qb('torrents/info?hashes='+hash))[0];
    await until(status,{description:'local fixture torrent added'});
    await qb('torrents/addPeers',{hashes:hash,peers:'127.0.0.1:'+peer.address().port});
    await until(async()=>((await status())?.downloaded>=fixture.have),{timeout:20000,description:'opening pieces transferred by the loopback peer'});
    assert.ok(requests>0);
    await c.api('/api/connect',{url,username,password});
    async function feed(){
      for(let step=0;step<10&&!closed;step++){
        for(let next=0;next<8&&available<count;next++){
          const index=available++,payload=Buffer.alloc(4);payload.writeUInt32BE(index);
          for(const frame of sockets.values())frame(4,payload);
        }
        await wait(500);
      }
      return until(async()=>{
        const torrent=await status();
        return torrent?.downloaded>=Math.min(size,available*pieceSize)?torrent:null;
      },{timeout:20000,interval:250,description:'new pieces verified by real qBittorrent'});
    }
    return {hash,version,close,feed,status,get requests(){return requests;}};
  }catch(error){await close();throw error;}
}

// Run from an interactive terminal after desktop/Build.ps1 -Qa.
// Commands: feed (deliver the next verified pieces), status, stop.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cinema, HASH, wait } from './helpers.mjs';
import { setupSparseMkv } from './startup-fixture.mjs';
import { realQbitFixture } from './real-qbit-fixture.mjs';

if(process.platform!=='win32')throw Error('This preview requires Windows and WebView2.');
const executable=fileURLToPath(new URL('../.local/desktop-qa/Cinema.exe',import.meta.url));
await fs.access(executable);
let cleanup, desktop, real, closing=false, feeding=false;
const c=await cinema({after(fn){cleanup=fn;}});
async function close(){
  if(closing)return;
  closing=true;
  if(desktop&&desktop.exitCode===null&&desktop.signalCode===null){
    const exited=once(desktop,'exit');
    desktop.kill();
    await exited;
  }
  while(feeding)await wait(50);
  await real?.close();
  await cleanup();
}
try{
  const fixture=await setupSparseMkv(c,{retainRemainder:true});
  let received=fixture.have;
  const torrent=c.state.torrents[0], subtitle=path.join(c.dir,'cinema-proof.srt');
  Object.assign(torrent,{state:'downloading',downloaded:received,amount_left:fixture.size-received,dlspeed:0,num_seeds:1});
  c.state.handlers['torrents/filePrio']=({params,send})=>{
    for(const id of params.get('id').split('|')){
      const file=c.state.files.get(HASH).find(item=>item.index===Number(id));
      if(file)file.priority=Number(params.get('priority'));
    }
    send('');
  };
  await fs.writeFile(subtitle,'1\r\n00:00:01,000 --> 00:01:50,000\r\nCinema verified caption\r\n\r\n2\r\n00:00:04,000 --> 00:00:07,000\r\nSecond cue\r\n');
  if(process.argv.includes('--real-qbit'))real=await realQbitFixture(c,fixture);
  const initial=real?await real.status():torrent;
  desktop=spawn(executable,['--fixture',c.base,c.dir],{stdio:'ignore'});
  const opened=once(desktop,'spawn');
  await opened;
  console.log(JSON.stringify({url:c.base,dir:c.dir,subtitle,percent:initial.progress*100,totalBytes:initial.size,realQbit:real?.version,peerRequests:real?.requests}));
  const input=readline.createInterface({input:process.stdin});
  async function feed(){
    if(feeding||closing)return;
    feeding=true;
    try{
      if(real){
        const live=await real.feed();
        console.log(JSON.stringify({received:live.downloaded,percent:live.progress*100,peerRequests:real.requests}));
        return;
      }
      const from=await fs.open(fixture.remainder,'r');
      try{
        const to=await fs.open(fixture.file,'r+');
        try{
          for(let step=0;step<10&&!closing;step++){
            const bytes=Buffer.alloc(8*fixture.pieceSize);
            const {bytesRead}=await from.read(bytes,0,bytes.length,received);
            if(bytesRead!==bytes.length)throw Error('The fixture ran out of source data.');
            const {bytesWritten}=await to.write(bytes,0,bytes.length,received);
            if(bytesWritten!==bytes.length)throw Error('Could not write a complete verified piece.');
            const old=received;
            received+=bytesWritten;
            c.state.pieces.fill(2,old/fixture.pieceSize,received/fixture.pieceSize);
            c.state.files.get(HASH)[0].progress=received/fixture.size;
            Object.assign(torrent,{progress:received/fixture.size,downloaded:received,amount_left:fixture.size-received,dlspeed:bytesWritten*2});
            await wait(500);
          }
        }finally{await to.close();}
      }finally{await from.close();}
      torrent.dlspeed=0;
      console.log(JSON.stringify({received,percent:torrent.progress*100}));
    }finally{feeding=false;}
  }
  input.on('line',line=>{
    const command=line.trim();
    if(command==='stop')input.close();
    if(command==='feed')void feed().catch(error=>console.error(error));
    if(command==='status')void c.api('/api/playback?hash='+(real?.hash||HASH)+'&index=0').then(result=>console.log(JSON.stringify(result))).catch(error=>console.error(error));
  });
  process.on('SIGINT',()=>input.close());
  process.on('SIGTERM',()=>input.close());
  await once(input,'close');
}finally{
  await close();
}

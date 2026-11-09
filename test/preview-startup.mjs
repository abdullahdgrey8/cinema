// Browser QA only. All torrent state and media are isolated synthetic fixtures.
// Run in an interactive terminal (PTY): node test/preview-startup.mjs.
// Type stop, close stdin or press Ctrl+C to clean up the generated fixture.
import readline from 'node:readline';
import {cinema,HASH} from './helpers.mjs';
import {setupSparseMkv} from './startup-fixture.mjs';

let cleanup,closing=false;
const c=await cinema({after(fn){cleanup=fn;}});
try {
  const fixture=await setupSparseMkv(c);
  Object.assign(c.state.torrents[0],{name:'Streaming startup validation — 99% unavailable',state:'downloading',downloaded:fixture.have,amount_left:fixture.size-fixture.have,dlspeed:0,num_seeds:1});
  c.state.handlers['torrents/filePrio']=({params,send})=>{for(const id of params.get('id').split('|')){const file=c.state.files.get(HASH).find(f=>f.index===Number(id));if(file)file.priority=Number(params.get('priority'));}send('');};
  async function close(){if(closing)return;closing=true;await cleanup();console.log('Startup preview cleaned up.');process.exit(0);}
  process.on('SIGINT',close);process.on('SIGTERM',close);
  const input=readline.createInterface({input:process.stdin});
  input.on('close',close);
  input.on('line',async command=>{if(command.trim()==='stop'){input.close();await close();}else if(command.trim()==='status'){const p=await c.api(`/api/playback?hash=${HASH}&index=0`);console.log(JSON.stringify(p));}});
  console.log(JSON.stringify({url:c.base,hash:HASH,downloadedPercent:fixture.progress*100,availableBytes:fixture.have,totalBytes:fixture.size,description:'Only the opening 2 MiB exists; all remaining pieces and tail metadata remain unavailable. No public torrent is used.'}));
  await new Promise(()=>{});
}catch(e){await cleanup();throw e;}

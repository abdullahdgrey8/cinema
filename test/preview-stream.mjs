// Manual browser QA against generated media and a fake qBittorrent only.
// Run: node test/preview-stream.mjs. Ctrl+C removes its temporary files.
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import ffmpeg from 'ffmpeg-static';
import {cinema,HASH,torrent} from './helpers.mjs';

let cleanup;
const c=await cinema({after(fn){cleanup=fn;}}),name='Cinema streaming demo.mkv';
const encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=640x360:r=25:d=120','-f','lavfi','-i','sine=frequency=440:duration=120','-c:v','ffv1','-c:a','pcm_s16le','-shortest',path.join(c.dir,name)],{windowsHide:true,stdio:'ignore'});
if((await once(encoder,'close'))[0]!==0)throw Error('Fixture encoding failed');
const original=await fs.readFile(path.join(c.dir,name)),size=original.length,pieceSize=65536,count=Math.ceil(size/pieceSize),have=Math.ceil(count*.35);
c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress:.35,dlspeed:3500000,num_seeds:49,eta:222,state:'downloading',downloaded:Math.floor(size*.35)})];
c.state.files.set(HASH,[{index:0,name,size,progress:.35,piece_range:[0,count-1],priority:1}]);
c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,i)=>i<have?2:0);
const handle=await fs.open(path.join(c.dir,name),'r+');await handle.write(Buffer.alloc(size-have*pieceSize),0,size-have*pieceSize,have*pieceSize);await handle.close();
c.state.results=[{fileName:'Inception.2010.1080p.WEB-DL.mp4',fileUrl:`magnet:?xt=urn:btih:${HASH}`,fileSize:size,nbSeeders:49,nbLeechers:3,siteUrl:'https://video.example',descrLink:'https://video.example/details',engineName:'video'},{fileName:'Inception.2010.720p.WEB-DL.mp4',fileUrl:`magnet:?xt=urn:btih:${'b'.repeat(40)}`,fileSize:Math.floor(size*.6),nbSeeders:12,nbLeechers:3,siteUrl:'https://video.example',descrLink:'https://video.example/details',engineName:'video'}];
c.state.handlers['torrents/filePrio']=({params,send})=>{for(const id of params.get('id').split('|')){const f=c.state.files.get(HASH).find(f=>f.index===Number(id));if(f)f.priority=Number(params.get('priority'));}send('');};
console.log(JSON.stringify({url:c.base,hash:HASH,dir:c.dir,description:'Synthetic 120s test pattern. 35% downloaded; remaining 65% of pieces unavailable. Send complete on stdin to supply the remaining pieces; stop to clean up.'}));
let closing=false;async function close(){if(closing)return;closing=true;await cleanup();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
const input=readline.createInterface({input:process.stdin});let completing=false;
input.on('line',async command=>{
  if(command.trim()==='stop'){input.close();await close();return;}
  if(command.trim()!=='complete'||completing)return;completing=true;
  try {
    const at=have*pieceSize,file=await fs.open(path.join(c.dir,name),'r+');
    try{for(let cursor=at;cursor<size;){const length=Math.min(1024*1024,size-cursor);const {bytesWritten}=await file.write(original,cursor,length,cursor);if(!bytesWritten)throw Error('Could not complete fixture write');cursor+=bytesWritten;}}finally{await file.close();}
    c.state.pieces.fill(2);c.state.files.get(HASH)[0].progress=1;Object.assign(c.state.torrents[0],{progress:1,downloaded:size,dlspeed:0,eta:0,state:'uploading'});
    console.log(JSON.stringify({completed:true,url:c.base,description:'All generated source bytes are now available. The existing HLS encoder and player can continue.'}));
  }catch(e){completing=false;console.error(e.message);}
});
await new Promise(()=>{});

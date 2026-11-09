import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {torrent} from '../helpers.mjs';

const run=promisify(execFile);
const pieceSize=64*1024;
const tones=[440,660,880];
const sha1=buffer=>createHash('sha1').update(buffer).digest();

function bencode(value){
  if(Buffer.isBuffer(value))return Buffer.concat([Buffer.from(value.length+':'),value]);
  if(typeof value==='string')return bencode(Buffer.from(value));
  if(typeof value==='number')return Buffer.from('i'+value+'e');
  return Buffer.concat([Buffer.from('d'),...Object.keys(value).sort().flatMap(key=>[bencode(key),bencode(value[key])]),Buffer.from('e')]);
}

export async function makeAudioDescriptionMedia(file,{variant='declared',duration=28}={}){
  assert.ok(['declared','decoy','reordered'].includes(variant));
  assert.ok(Number.isSafeInteger(duration)&&duration>=12&&duration<=90);
  const sourceOrder=variant==='reordered'?[2,1,3]:[1,2,3];
  const title={1:'Original English',2:'English AD',3:'English alternate'};
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-filter_threads','1',
    '-f','lavfi','-i','testsrc2=s=160x90:r=12:d='+duration,
    ...tones.flatMap(hz=>['-f','lavfi','-i','sine=frequency='+hz+':sample_rate=48000:duration='+duration]),
    '-map','0:v:0',...sourceOrder.flatMap(input=>['-map',input+':a:0']),
    '-c:v','libx264','-threads:v','1','-preset','ultrafast','-pix_fmt','yuv420p',
    '-g','12','-keyint_min','12','-sc_threshold','0','-b:v','1M','-minrate','1M','-maxrate','1M',
    '-bufsize','2M','-x264-params','nal-hrd=cbr',
    '-c:a','aac','-threads:a','1','-profile:a','aac_low','-ac','2','-b:a','80k',
    ...sourceOrder.flatMap((input,i)=>[
      '-disposition:a:'+i,input===1?'default':input===3&&variant!=='decoy'?'visual_impaired':'0',
      '-metadata:s:a:'+i,'title='+title[input],'-metadata:s:a:'+i,'language=eng',
    ]),file],{windowsHide:true,timeout:15000,maxBuffer:256*1024});
  return file;
}

export async function installAudioDescriptionFixture({dir,state},{
  variant='declared',partial=false,fixturePath,duration=28,
}={}){
  const name='Cinema Audio '+variant+' 2024.mkv';
  const file=path.join(dir,name);
  const generated=fixturePath||await makeAudioDescriptionMedia(path.join(dir,'full-audio-'+variant+'.mkv'),{variant,duration});
  const source=await fs.readFile(generated);
  const size=source.length,totalPieces=Math.ceil(size/pieceSize);
  const initialVerifiedPieces=partial?Math.floor(totalPieces*.46):totalPieces;
  const have=Math.min(size,initialVerifiedPieces*pieceSize);
  if(partial){
    assert.ok(have>=768*1024&&have+pieceSize<size,'Physically partial source needs an adequate but bounded prefix');
    const withheld=source.subarray(have,have+pieceSize);
    assert.ok(withheld.some(byte=>byte!==0),'Withheld source has nonzero media bytes');
  }
  await fs.writeFile(file,source.subarray(0,have));
  if(partial){
    await fs.truncate(file,size);
    const handle=await fs.open(file,'r');
    try{
      const withheld=Buffer.alloc(pieceSize);
      assert.equal((await handle.read(withheld,0,pieceSize,have)).bytesRead,pieceSize);
      assert.ok(withheld.every(byte=>byte===0),'Unavailable on-disk bytes must actually be withheld');
    }finally{await handle.close();}
  }
  const pieces=Buffer.concat(Array.from({length:totalPieces},(_,i)=>sha1(source.subarray(i*pieceSize,(i+1)*pieceSize))));
  const info={length:size,name,'piece length':pieceSize,pieces};
  const hash=sha1(bencode(info)).toString('hex');
  const metadata=bencode({info});
  const progress=have/size;
  const row={index:0,name,size,progress,piece_range:[0,totalPieces-1],priority:1};
  const entry=torrent(dir,{hash,name,size,total_size:size,content_path:file,progress,downloaded:have,
    amount_left:size-have,state:partial?'downloading':'uploading',dlspeed:0,eta:partial?8640000:0});
  const states=Array.from({length:totalPieces},(_,i)=>i<initialVerifiedPieces?2:0);
  state.torrents.push(entry);
  state.files.set(hash,[row]);
  state.properties={...state.properties,piece_size:pieceSize};
  state.pieces=states;
  const exportOther=state.handlers['torrents/export'];
  state.handlers['torrents/export']=request=>{
    if(request.params.get('hash')!==hash)return exportOther?exportOther(request):request.send('',404);
    request.res.writeHead(200,{'Content-Type':'application/x-bittorrent','Content-Length':metadata.length});
    request.res.end(metadata);
  };
  const piecesOther=state.handlers['torrents/pieceStates'];
  state.handlers['torrents/pieceStates']=request=>request.params.get('hash')===hash?
    request.send(states):piecesOther?piecesOther(request):request.send(state.pieces);

  let advancing=false;
  async function advance(verifiedPieces){
    const before=entry.downloaded,end=Math.min(size,verifiedPieces*pieceSize);
    assert.ok(!advancing&&Number.isSafeInteger(verifiedPieces)&&verifiedPieces<=totalPieces&&end>=before);
    if(end===before)return {verifiedPieces,verifiedBytes:end,progress:end/size};
    advancing=true;
    try{
      const next=source.subarray(before,end),handle=await fs.open(file,'r+');
      try{
        assert.equal((await handle.write(next,0,next.length,before)).bytesWritten,next.length);
        await handle.sync();
      }finally{await handle.close();}
      states.fill(2,Math.floor(before/pieceSize),verifiedPieces);
      row.progress=end/size;
      Object.assign(entry,{progress:row.progress,downloaded:end,amount_left:size-end,
        state:end===size?'uploading':'downloading',eta:end===size?0:8640000});
      return {verifiedPieces,verifiedBytes:end,progress:row.progress};
    }finally{advancing=false;}
  }

  return {hash,index:row.index,name,file,size,pieceSize,totalPieces,initialVerifiedPieces,progress,have,
    generated,advance,complete:()=>advance(totalPieces)};
}

export async function readFixtureTone(file){
  const {stdout}=await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-threads','1','-i',file,
    '-map','0:a:0','-t','0.5','-ac','1','-ar','8000','-f','s16le','pipe:1'],
  {windowsHide:true,timeout:8000,maxBuffer:128*1024,encoding:'buffer'});
  assert.ok(stdout.length>=8000&&stdout.length<=8020,'Expected half a second of decoded mono PCM with at most ten rounding samples');
  const evidence=tones.map(frequency=>{
    const coefficient=2*Math.cos(2*Math.PI*frequency/8000);
    let last=0,previous=0;
    for(let i=0;i<8000;i+=2){
      const value=stdout.readInt16LE(i)+coefficient*last-previous;
      previous=last;
      last=value;
    }
    return {frequency,power:last**2+previous**2-coefficient*last*previous};
  }).sort((a,b)=>b.power-a.power);
  assert.ok(evidence[0].power>1e8&&evidence[0].power>evidence[1].power*20,
    'A fixture audio segment must carry one real dominant reference tone');
  return evidence[0].frequency;
}

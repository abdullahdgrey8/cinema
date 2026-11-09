import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {HASH,torrent} from './helpers.mjs';

function vint(buffer,at,keepMarker=false){const first=buffer[at];let width=1;while(width<=8&&!(first&(1<<(8-width))))width++;assert.ok(width<=8);let value=BigInt(keepMarker?first:first&((1<<(8-width))-1));for(let i=1;i<width;i++)value=value*256n+BigInt(buffer[at+i]);return {width,value:Number(value)};}
function element(buffer,at){const id=vint(buffer,at,true),size=vint(buffer,at+id.width),data=at+id.width+size.width;return {id:id.value,start:at,data,end:data+size.value,size:size.value,sizeAt:at+id.width,sizeWidth:size.width};}
function encodedSize(value,width){if(!width){width=1;while(BigInt(value)>=(1n<<BigInt(width*7))-1n)width++;}const b=Buffer.alloc(width);let v=BigInt(value)|(1n<<BigInt(width*7));for(let i=width-1;i>=0;i--){b[i]=Number(v&255n);v>>=8n;}return b;}
const sized=(id,payload)=>Buffer.concat([Buffer.from(id,'hex'),encodedSize(payload.length),payload]);
function voidBytes(total){for(let width=1;width<=8;width++){const body=total-1-width;if(body>=0&&BigInt(body)<(1n<<BigInt(width*7))-1n)return Buffer.concat([Buffer.from([0xec]),encodedSize(body,width),Buffer.alloc(body)]);}assert.fail('Cannot create EBML void');}

export async function setupSparseMkv(c,{retainRemainder=false}={}){
  const name='long-partial-seekhead.mkv',file=path.join(c.dir,name);
  const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=160x90:r=12:d=1800','-f','lavfi','-i','sine=frequency=440:duration=1800','-c:v','libx264','-preset','ultrafast','-g','48','-sc_threshold','0','-b:v','1M','-minrate','1M','-maxrate','1M','-bufsize','2M','-x264-params','nal-hrd=cbr','-c:a','aac','-b:a','64k','-shortest',file],{windowsHide:true,stdio:'ignore'});
  assert.equal((await once(child,'close'))[0],0);
  const originalSize=(await fs.stat(file)).size,have=2*1024*1024,prefix=Buffer.alloc(have),reader=await fs.open(file,'r');await reader.read(prefix,0,prefix.length,0);await reader.close();
  const ebml=element(prefix,0),segment=element(prefix,ebml.end),headers=[];for(let at=segment.data;at<prefix.length;){const e=element(prefix,at);if(e.id===0x1f43b675)break;headers.push(e);at=e.end;}
  const tags=headers.find(e=>e.id===0x1254c367),seekhead=headers.find(e=>e.id===0x114d9b74),padding=headers.find(e=>e.start===seekhead.end&&e.id===0xec);assert.ok(tags&&padding);
  const entries=[];for(let at=seekhead.data;at<seekhead.end;){const entry=element(prefix,at);if(entry.id!==0x4dbb){at=entry.end;continue;}let seekId,position;for(let part=entry.data;part<entry.end;){const e=element(prefix,part);if(e.id===0x53ab)seekId=prefix.subarray(e.data,e.end);if(e.id===0x53ac){position=0;for(let i=e.data;i<e.end;i++)position=position*256+prefix[i];}part=e.end;}const p=Buffer.alloc(8);p.writeBigUInt64BE(BigInt(seekId.toString('hex')==='1254c367'?originalSize-segment.data:position));entries.push(sized('4dbb',Buffer.concat([sized('53ab',seekId),sized('53ac',p)])));at=entry.end;}
  const relocated=sized('114d9b74',Buffer.concat(entries)),space=padding.end-seekhead.start;assert.ok(relocated.length+2<=space);relocated.copy(prefix,seekhead.start);voidBytes(space-relocated.length).copy(prefix,seekhead.start+relocated.length);
  const tailTags=Buffer.from(prefix.subarray(tags.start,tags.end)),size=originalSize+tailTags.length;voidBytes(tags.end-tags.start).copy(prefix,tags.start);encodedSize(size-segment.data,segment.sizeWidth).copy(prefix,segment.sizeAt);
  // Recreate a sparse source whose unavailable bytes genuinely do not exist.
  const remainder=retainRemainder?path.join(c.dir,'original-test-source.mkv'):null;
  if(remainder)await fs.rename(file,remainder);
  const out=await fs.open(file,'w');await out.truncate(size);await out.write(prefix,0,prefix.length,0);await out.close();
  const pieceSize=65536,count=Math.ceil(size/pieceSize),available=have/pieceSize,progress=have/size;assert.ok(progress<.01,`Expected <1%, got ${progress}`);
  c.state.torrents=[torrent(c.dir,{name,size,total_size:size,progress,dlspeed:1_000_000})];c.state.files.set(HASH,[{index:0,name,size,progress,piece_range:[0,count-1],priority:1}]);c.state.properties={piece_size:pieceSize};c.state.pieces=Array.from({length:count},(_,i)=>i<available?2:0);
  return {name,file,size,have,progress,remainder,pieceSize};
}

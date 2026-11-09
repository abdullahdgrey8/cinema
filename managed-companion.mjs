import {createHash,createHmac,X509Certificate} from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {magnetHashes,torrentIdentity} from './lib.mjs';

export const MANAGED_CINEMA_PORT=3212;
const executableDigest='edc19c0599648f97369fb87f3b965e493c1e790c6259fb4f564e99e275927cef';
const managedName=/^SceneCompanion(?:-qa-[a-z\d][a-z\d-]{0,47})?$/i;
const reservedPorts=new Set([3210,MANAGED_CINEMA_PORT,6881,8080]);
const fold=value=>process.platform==='win32'?value.toLowerCase():value;
const invalid=()=>Error('Cinema Scene Preview could not verify its installed companion profile.');
const isPort=value=>Number.isInteger(value)&&value>=1024&&value<=65535&&!reservedPorts.has(value);
const samePath=(left,right)=>typeof left==='string'&&path.isAbsolute(left)&&fold(path.resolve(left))===fold(path.resolve(right));

async function verifiedPath(filename,directory){
  const info=await fs.lstat(filename);
  if(info.isSymbolicLink()||!(directory?info.isDirectory():info.isFile())||!samePath(await fs.realpath(filename),filename))throw invalid();
  return filename;
}

async function readBounded(filename,limit){
  const handle=await fs.open(await verifiedPath(filename,false),'r');
  try{
    const bytes=Buffer.alloc(limit+1),{bytesRead}=await handle.read(bytes);
    if(bytesRead>limit)throw invalid();
    return bytes.subarray(0,bytesRead);
  }finally{await handle.close();}
}

export async function loadManagedCompanion(value){
  if(process.platform!=='win32'||!path.isAbsolute(process.env.USERPROFILE||'')||
    typeof value!=='string'||!path.isAbsolute(value))throw invalid();
  const root=path.resolve(value), parent=path.resolve(process.env.USERPROFILE,'CinemaData');
  if(!samePath(path.dirname(root),parent)||!managedName.test(path.basename(root)))throw invalid();
  try{
    await verifiedPath(parent,true);
    await verifiedPath(root,true);
    const folder=name=>verifiedPath(path.join(root,name),true);
    const [runtime,identity,qbitProfile,appData,downloads,incomplete]=await Promise.all(
      ['runtime','identity','qbit-profile','app-data','downloads','incomplete'].map(folder));
    const profile=JSON.parse((await readBounded(path.join(root,'profile.json'),4096)).toString('utf8').replace(/^\uFEFF/,''));
    const {schema,ownerSid,webPort,peerPort,password,sceneKey,certificateSha256}=profile??{};
    if(schema!==1||typeof ownerSid!=='string'||!/^S-1-(?:\d+-){1,14}\d+$/.test(ownerSid)||
      !isPort(webPort)||!isPort(peerPort)||webPort===peerPort||typeof password!=='string'||!/^[a-f\d]{48}$/.test(password)||
      typeof sceneKey!=='string'||!/^[a-f\d]{64}$/.test(sceneKey)||typeof certificateSha256!=='string'||
      !/^[a-f\d]{64}$/.test(certificateSha256))throw invalid();
    const qbDir=await verifiedPath(path.join(qbitProfile,'qBittorrent'),true);
    const qbConfig=await verifiedPath(path.join(qbDir,'config'),true);
    await verifiedPath(path.join(qbConfig,'qBittorrent.ini'),false);
    await verifiedPath(path.join(identity,'key.pem'),false);
    const certificateFile=path.join(identity,'cert.pem'),certificate=await readBounded(certificateFile,16*1024);
    const leaf=new X509Certificate(certificate);
    if(createHash('sha256').update(certificate).digest('hex')!==certificateSha256||!leaf.checkIP('127.0.0.1')||
      leaf.subject!==leaf.issuer||!leaf.verify(leaf.publicKey))throw invalid();
    const qbitExecutable=await verifiedPath(path.join(runtime,'qbittorrent-nox.exe'),false), digest=createHash('sha256');
    for await(const chunk of createReadStream(qbitExecutable))digest.update(chunk);
    if(digest.digest('hex')!==executableDigest)throw invalid();
    return {root,appData,downloads,incomplete,qbitProfile,qbitExecutable,webPort,peerPort,ownerSid,
      certificateFile,certificate,certificateSha256,sceneKey,config:{url:`https://127.0.0.1:${webPort}`,username:'cinema',password}};
  }catch{throw invalid();}
}

export function managedLaunchProof(profile,challenge){
  if(typeof challenge!=='string'||!/^[a-f\d]{64}$/.test(challenge))throw Error('Invalid Cinema launcher challenge.');
  return createHmac('sha256',Buffer.from(profile.sceneKey,'hex')).update(JSON.stringify([
    'cinema-scene-launch-v1',challenge,fold(profile.root),profile.ownerSid,profile.certificateSha256,profile.config.url,profile.peerPort,
  ])).digest('hex');
}

export function managedStorageMatches(profile,prefs){
  return prefs?.web_ui_address==='127.0.0.1'&&prefs.web_ui_port===profile.webPort&&prefs.use_https===true&&
    prefs.temp_path_enabled===true&&samePath(prefs.save_path,profile.downloads)&&samePath(prefs.temp_path,profile.incomplete);
}

export async function managedTorrentStorageMatches(profile,torrent){
  const contained=value=>typeof value==='string'&&path.isAbsolute(value)&&[profile.downloads,profile.incomplete].some(root=>{
    const relative=path.relative(fold(root),fold(path.resolve(value)));
    return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
  });
  if(!torrent?.save_path)return false;
  for(const location of [torrent.save_path,torrent.download_path,torrent.content_path].filter(Boolean)){
    if(!contained(location))return false;
    try{if(!contained(await fs.realpath(location)))return false;}
    catch(error){if(error.code!=='ENOENT')return false;}
  }
  return true;
}

export function managedMagnetSource(value){
  if(typeof value!=='string'||value.length>8192||/[\u0000-\u001f\u007f]/.test(value))return null;
  const input=value.trim();
  if(!/^magnet:\?/i.test(input))return null;
  const url=URL.parse(input),hashes=magnetHashes(input);
  if(!url||url.hash||hashes.length<1||hashes.length>2||url.searchParams.getAll('xt').length!==hashes.length||
    new Set(hashes.map(hash=>hash.length)).size!==hashes.length)return null;
  const fileUrl=url.href;
  const name=url.searchParams.get('dn')?.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160);
  return {fileUrl,fileName:name||`Torrent ${hashes[0].slice(0,8)}`,
    key:createHash('sha256').update(torrentIdentity(fileUrl)).digest('hex').slice(0,32)};
}

import fs from 'node:fs/promises';
import path from 'node:path';
import {audioMediaFile} from './hls-audio.mjs';

const GIB=1024**3;
const sessionName=/^(?:[a-f0-9]{40}|[a-f0-9]{64})-\d+$/i;
const runName=/^[a-f0-9]{12}$/i;
const generatedName=name=>/^(?:index\.m3u8|seg\d{6}\.ts)(?:\.tmp)?$/.test(name)||
  audioMediaFile(name.replace(/\.tmp$/,''));

export async function createPlaybackCache({local,protectedRuns=()=>new Set()}){
  const root=path.resolve(local,'hls'),settings=path.join(local,'playback-cache.json');
  const reservations=new Set();
  let quotaGiB=await fs.readFile(settings,'utf8').then(raw=>JSON.parse(raw).quotaGiB).catch(()=>null);
  if(!Number.isInteger(quotaGiB)||quotaGiB<1||quotaGiB>1000)quotaGiB=null;
  let queued=Promise.resolve();

  async function folders(directory,pattern){
    return (await fs.readdir(directory,{withFileTypes:true}).catch(error=>{
      if(error.code==='ENOENT')return [];
      throw error;
    })).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&pattern.test(entry.name)).map(entry=>path.join(directory,entry.name));
  }

  async function describe(folder){
    const contents=await fs.readdir(folder,{withFileTypes:true}).catch(error=>{
      if(error.code==='ENOENT')return [];
      throw error;
    });
    const names=contents.filter(entry=>entry.isFile()&&!entry.isSymbolicLink()&&generatedName(entry.name)).map(entry=>entry.name);
    let bytes=0,updated=0,files=0;
    for(let offset=0;offset<names.length;offset+=32){
      const stats=await Promise.all(names.slice(offset,offset+32).map(name=>fs.lstat(path.join(folder,name)).catch(error=>{
        if(error.code==='ENOENT')return null;
        throw error;
      })));
      for(const stat of stats)if(stat?.isFile()&&!stat.isSymbolicLink()){
        bytes+=stat.size;updated=Math.max(updated,stat.mtimeMs);files++;
      }
    }
    return {folder,bytes,updated,files,names,owned:contents.length>0&&files===contents.length};
  }

  async function scan(){
    const stat=await fs.lstat(root).catch(error=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(!stat?.isDirectory()||stat.isSymbolicLink())return [];
    const runs=[];
    for(const session of await folders(root,sessionName)){
      for(const folder of await folders(session,runName))runs.push(await describe(folder));
    }
    return runs;
  }

  const eligible=(run,protectedSet)=>run.owned&&!protectedSet.has(run.folder)&&!reservations.has(run.folder);
  function summarize(runs){
    const protectedSet=protectedRuns();
    return {quotaGiB,bytes:runs.reduce((sum,run)=>sum+run.bytes,0),files:runs.reduce((sum,run)=>sum+run.files,0),
      reclaimableBytes:runs.filter(run=>eligible(run,protectedSet)).reduce((sum,run)=>sum+run.bytes,0)};
  }

  async function removeRun(run){
    const protectedSet=protectedRuns();
    if(!eligible(run,protectedSet))return 0;
    reservations.add(run.folder);
    try{
      const session=path.dirname(run.folder);
      const locations=[root,session,run.folder];
      const stats=await Promise.all(locations.map(location=>fs.lstat(location).catch(()=>null)));
      if(stats.some(stat=>!stat?.isDirectory()||stat.isSymbolicLink())||protectedRuns().has(run.folder))return 0;
      const live=await describe(run.folder);
      const real=await Promise.all(locations.map(location=>fs.realpath(location).catch(()=>null)));
      if(real.some(location=>!location)||path.dirname(real[2])!==real[1]||path.dirname(real[1])!==real[0]||
        !live.owned||protectedRuns().has(run.folder))return 0;
      for(const name of live.names)await fs.unlink(path.join(run.folder,name));
      await fs.rmdir(run.folder);
      return live.bytes;
    }finally{reservations.delete(run.folder);}
  }

  function serialize(work){
    const result=queued.then(work);
    queued=result.catch(()=>{});
    return result;
  }
  async function trim(all=false){
    const runs=await scan();
    let size=summarize(runs).bytes,removedBytes=0,failedRuns=0;
    for(const run of runs.sort((a,b)=>a.updated-b.updated)){
      if(!all&&(quotaGiB===null||size<=quotaGiB*GIB))break;
      try{const removed=await removeRun(run);size-=removed;removedBytes+=removed;}
      catch{failedRuns++;}
    }
    return {...summarize(removedBytes||failedRuns?await scan():runs),removedBytes,failedRuns};
  }
  const timer=setInterval(()=>{if(quotaGiB!==null)void serialize(()=>trim()).catch(()=>{});},15*60_000);
  timer.unref();
  return {
    reserved:folder=>reservations.has(path.resolve(folder)),
    status:()=>serialize(async()=>summarize(await scan())),
    clear:()=>serialize(()=>trim(true)),
    setQuota(value){
      if(value!==null&&(!Number.isInteger(value)||value<1||value>1000))throw Object.assign(Error('Enter a cache limit between 1 and 1000 GB.'),{status:400});
      return serialize(async()=>{
        const temporary=settings+'.tmp';
        await fs.writeFile(temporary,JSON.stringify({quotaGiB:value}));
        await fs.rename(temporary,settings);
        quotaGiB=value;
        return trim();
      });
    },
    async close(){clearInterval(timer);await queued;},
  };
}

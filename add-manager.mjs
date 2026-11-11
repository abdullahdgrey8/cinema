import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {classify,magnetHashes,torrentIdentity,titleKey,title} from './lib.mjs';
import {verifyDownloadFolder} from './download-location.mjs';

const starterFilmDescriptors=new Set([
  'https://webtorrent.io/torrents/big-buck-bunny.torrent',
  'https://webtorrent.io/torrents/sintel.torrent',
  'https://webtorrent.io/torrents/tears-of-steel.torrent',
  'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
  'https://archive.org/download/167622/167622_archive.torrent',
]);
const ubuntuTrackerDescriptor=/^https:\/\/torrent\.ubuntu\.com\/file\?info_hash=(?:[A-Za-z\d._~-]|%[A-Fa-f\d]{2}){20}$/;
function useNativeDownloader({engineName,fileUrl}){
  if(engineName==='cinema_open_films')return starterFilmDescriptors.has(fileUrl);
  return engineName==='cinema_ubuntu'&&fileUrl===fileUrl.trim()&&ubuntuTrackerDescriptor.test(fileUrl);
}

export async function createAddManager({qb,local,onChange=()=>{},downloadFolder=()=>null}){
  const filename=path.join(local,'operations.json');
  const stored=await fs.readFile(filename,'utf8').then(JSON.parse).catch(()=>[]);
  const ops=new Map(stored.map(o=>[o.id,o]));let writing=Promise.resolve(),creating=Promise.resolve();
  for(const o of ops.values())if(o.status==='adding'){o.status='uncertain';o.message='Reconnecting after restart. Checking whether qBittorrent accepted this source.';}
  function save(){const data=JSON.stringify([...ops.values()].slice(-250));writing=writing.catch(()=>{}).then(async()=>{const temp=filename+'.tmp';await fs.writeFile(temp,data);await fs.rename(temp,filename);});return writing;}
  function publicOp(o){if(!o)return null;const {source,identity,tag,hashes,knownIds,before,downloadFolder,...p}=o;return p;}
  function list(){return [...ops.values()].map(publicOp).sort((a,b)=>b.createdAt-a.createdAt);}
  function findTorrent(o,ts){return ts.find(t=>[t.hash,t.infohash_v1,t.infohash_v2].filter(Boolean).some(h=>[...(o.hashes||[]),...(o.knownIds||[]),o.hash].filter(Boolean).includes(h.toLowerCase()))||(t.tags||'').split(',').map(s=>s.trim()).includes(o.tag));}
  function reconcile(ts){let changed=false;for(const o of ops.values()){
    const found=findTorrent(o,ts);
    if(found && (o.status!=='ready'||o.hash!==found.hash)){o.hash=found.hash;o.status='ready';o.message='Added to your library. Downloads and playback stay in sync.';o.updatedAt=Date.now();changed=true;}
    else if(!found&&o.status==='ready'){o.status='removed';o.message='Removed from qBittorrent.';changed=true;}
    else if(!found&&['accepted','adding'].includes(o.status)&&Date.now()-o.createdAt>90000){o.status='uncertain';o.message='Still waiting for qBittorrent to register this source. No automatic retry was sent. Check connection and source availability.';changed=true;}
  }if(changed){save().catch(()=>{});onChange();}}
  async function run(o){
    let submitted=false;
    try{
      const cats=await qb('torrents/categories');if(!cats[o.category]){try{await qb('torrents/createCategory',{category:o.category},'POST');}catch(e){if(!(await qb('torrents/categories'))[o.category])throw e;}}
      const args={urls:o.source.fileUrl,category:o.category,tags:o.tag,sequentialDownload:'true',firstLastPiecePrio:'true',stopped:'false'};
      const folder=o.downloadFolder;
      if(folder!==undefined){
        // qBittorrent trims savepath. A trailing separator protects any whitespace in the folder name.
        const savepath=folder.endsWith(path.sep)?folder:folder+path.sep;
        Object.assign(args,{savepath,autoTMM:'false',useDownloadPath:'false'});
      }
      // The bundled engines publish plain torrent descriptors. Using qBittorrent's
      // native downloader also avoids Nova's space-delimited temporary path protocol.
      if(o.source.engineName&&!o.source.fileUrl.startsWith('magnet:')&&!useNativeDownloader(o.source))args.downloader=o.source.engineName;
      const beforeSend=folder===undefined?undefined:()=>verifyDownloadFolder(folder,{unchanged:true});
      submitted=true;
      const result=await qb('torrents/add',args,'POST',beforeSend);
      if(result&&typeof result==='object'){
        o.knownIds=(result.added_torrent_ids||[]).map(x=>typeof x==='string'?x:x.id||x.hash).filter(Boolean).map(x=>x.toLowerCase());
        if(Number(result.failure_count)>0 && !Number(result.success_count)&&!Number(result.pending_count)&&!o.knownIds.length){o.status='failed';o.message='qBittorrent rejected this source. Try a different source.';}
        else{o.status='accepted';o.message=Number(result.pending_count)>0?'Source accepted. Fetching torrent metadata…':'Source accepted. Connecting it to your library…';}
      }else if(typeof result==='string'&&/^fails?\.?$/i.test(result.trim())){o.status='failed';o.message='qBittorrent rejected this source.';}
      else{o.status='accepted';o.message='Source submitted. Checking the actual torrent before reporting success.';}
    }catch(e){
      const folderProblem=e.code==='download-folder';
      o.status=(folderProblem||!submitted||e.qbitStatus===409)?'failed':'uncertain';
      o.message=folderProblem?e.message:o.status==='failed'?'qBittorrent could not accept this source. '+e.message:'The response was interrupted. Checking qBittorrent before any retry; the download may already have started.';
      o.detail=e.message;
    }
    o.updatedAt=Date.now();await save();onChange();
    try{reconcile(await qb('torrents/info'));}catch{}
  }
  async function createInternal(source,category,allowDuplicate=false){
    const identity=torrentIdentity(source.fileUrl),hashes=magnetHashes(source.fileUrl),ts=await qb('torrents/info');reconcile(ts);
    const exact=ts.find(t=>[t.hash,t.infohash_v1,t.infohash_v2].filter(Boolean).some(h=>hashes.includes(h.toLowerCase())));
    if(exact){
      const linked=[...ops.values()].reverse().find(o=>o.identity===identity||o.hash===exact.hash);
      if(linked&&source.intent){linked.intent=source.intent;linked.selectionKey=source.key;await save();}
      return {...(linked?publicOp(linked):{}),id:linked?.id||'existing-'+exact.hash,status:'ready',hash:exact.hash,name:exact.name,...(source.intent?{intent:source.intent}:{}),existing:true,message:'This source is already in your library. Opening the existing download.'};
    }
    const previous=[...ops.values()].reverse().find(o=>o.identity===identity&&!['removed','failed'].includes(o.status));
    if(previous){
      if(source.intent){previous.intent=source.intent;previous.selectionKey=source.key;await save();}
      const operation=publicOp(previous);
      return source.manualMagnet?{...operation,existing:true,message:'This magnet is already being added.'}:operation;
    }
    const key=titleKey(source.fileName),kind=source.kind||classify(source.fileName,category);
    const pendingTitle=[...ops.values()].find(o=>['adding','accepted','uncertain'].includes(o.status)&&titleKey(o.name)===key&&key.length>3);
    if(pendingTitle&&!allowDuplicate){if(source.intent){pendingTitle.intent=source.intent;pendingTitle.selectionKey=source.key;await save();}return {...publicOp(pendingTitle),existing:true,message:'A version of this title is already being added. Waiting for that request instead of starting a second download.'};}
    const alternatives=ts.filter(t=>titleKey(t.name)===key&&key.length>3);
    if(alternatives.length&&!allowDuplicate)return {status:'duplicate',name:source.fileName,message:'Another version of this title is already in your library.',duplicateCandidates:alternatives.map(t=>({hash:t.hash,title:title(t.name),name:t.name,progress:t.progress,size:t.total_size||t.size}))};
    const folder=downloadFolder();
    const id=randomBytes(12).toString('hex'),o={id,identity,hashes,tag:'cinema-'+id,knownIds:[],source,selectionKey:source.key,...(source.intent?{intent:source.intent}:{}),category:['movies','tv','anime'].includes(category)?category:['movies','tv','anime'].includes(kind)?kind:'other',status:'adding',name:source.fileName,message:'Sending this source to qBittorrent…',createdAt:Date.now(),updatedAt:Date.now(),...(folder?{downloadFolder:folder}:{})};
    ops.set(id,o);await save();setImmediate(()=>run(o).catch(e=>{o.status='uncertain';o.message=e.message;save().catch(()=>{});}));return publicOp(o);
  }
  function serialized(work){const result=creating.catch(()=>{}).then(work);creating=result;return result;}
  return {list,reconcile,get(id){return publicOp(ops.get(id));},create(source,category,allowDuplicate){return serialized(()=>createInternal(source,category,allowDuplicate));},retry(id){return serialized(async()=>{
    const o=ops.get(id);if(!o)throw Object.assign(Error('Download request not found'),{status:404});
    reconcile(await qb('torrents/info'));
    if(!['uncertain','failed'].includes(o.status))return publicOp(o);
    o.status='adding';o.createdAt=Date.now();o.updatedAt=Date.now();o.message='Retry requested. Checking the same source with qBittorrent…';o.attempts=(o.attempts||1)+1;await save();setImmediate(()=>run(o).catch(()=>{}));return publicOp(o);
  });},async close(){await writing;}};
}

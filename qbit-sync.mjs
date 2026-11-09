const hashPattern=/^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function createQbitSync(qb){
  let rid=0, previous=new Map(), server={}, fallbackUntil=0;
  function reset(){
    rid=0;previous=new Map();server={};fallbackUntil=0;
  }

  async function full(){
    const [torrents,transfer]=await Promise.all([qb('torrents/info'),qb('transfer/info')]);
    rid=0;
    return {torrents,transfer};
  }

  async function read({fresh=false}={}){
    if(fresh||Date.now()<fallbackUntil)return full();
    let result;
    try{result=await qb('sync/maindata',{rid});}
    catch(error){if(error.qbitStatus!==404&&error.qbitStatus!==405)throw error;}
    if(!record(result)||!Number.isSafeInteger(result.rid)||result.rid<=0||
      (!rid&&result.full_update!==true)){
      fallbackUntil=Date.now()+10*60_000;
      return full();
    }

    if(result.torrents!==undefined&&!record(result.torrents)||
      result.torrents_removed!==undefined&&(!Array.isArray(result.torrents_removed)||
        result.torrents_removed.some(hash=>typeof hash!=='string'||!hashPattern.test(hash))))return full();
    const next=result.full_update===true?new Map():new Map(previous);
    for(const [key,torrent] of Object.entries(result.torrents||{})){
      if(!hashPattern.test(key)||!record(torrent))return full();
      const hash=key.toLowerCase();
      const merged={...next.get(hash),...torrent,hash};
      if(typeof merged.name!=='string')return full();
      next.set(hash,merged);
    }
    if(result.torrents_removed)for(const hash of result.torrents_removed)next.delete(hash.toLowerCase());
    const transfer={...(result.full_update===true?{}:server),...result.server_state};
    rid=result.rid;previous=next;server=transfer;
    return {torrents:[...next.values()],transfer};
  }
  return {read,reset};
}

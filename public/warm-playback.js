export function samePlaybackSession(left,right){
  return Boolean(left&&right&&left.hash===right.hash&&left.index===right.index&&
    typeof left.sessionId==='string'&&left.sessionId.length&&left.sessionId===right.sessionId);
}

export function matchesPlaybackAttachment(attachment,expected){
  const {file,state}=attachment||{};
  return Boolean(samePlaybackSession(state,expected)&&file?.index===expected.index&&
    typeof file.name==='string'&&file.name.length&&Number.isFinite(file.size)&&file.size>0&&
    (!expected.url||state.url===expected.url));
}

export function createWarmPlayback({api,getSource,attach,render,titleFor,now=Date.now,schedule=setTimeout,cancel=clearTimeout}){
  let choices=[],error='',returnNotice='',loading=false,busy=false,operation=0,timer=null;
  let parked=null;
  const route='/api/playback/warm';
  const sourceRef=source=>({hash:source.hash,index:source.index,sessionId:source.sessionId});
  const sameSource=(left,right)=>samePlaybackSession(left,right)&&left.generation===right.generation;

  function paint(){
    const source=getSource();
    render({available:Boolean(source)&&!parked,options:choices,error,returnNotice,loading,busy,
      lease:parked?{title:parked.source.title,phase:parked.lease.phase,expiresAt:parked.lease.expiresAt}:null});
  }

  function release(ticket){
    if(ticket)void api(route,{action:'dismiss',ticket}).catch(()=>{});
  }

  function forget({releaseLease=false,message=''}={}){
    const ticket=parked?.lease.ticket;
    operation++;
    cancel(timer);timer=null;
    parked=null;choices=[];error='';returnNotice=message;loading=busy=false;
    if(releaseLease)release(ticket);
    paint();
  }

  function clear(){forget({releaseLease:true});}
  function cancelPendingSwitch(){if(!parked&&busy)forget();}
  function lostReturn(releaseLease=false){
    forget({releaseLease,message:'Return is no longer available. Reopen the original title from My Library.'});
  }

  function refresh(){
    if(parked&&!busy&&parked.lease.expiresAt<=now())lostReturn();
    else paint();
  }

  function queueStatus(){
    if(parked)timer=schedule(checkStatus,Math.max(1,Math.min(2000,parked.lease.expiresAt-now())));
  }

  async function checkStatus(){
    timer=null;
    const current=parked,request=operation;
    if(!current||busy)return;
    if(current.lease.expiresAt<=now()){lostReturn();return;}
    try{
      const {lease}=await api(route+'?ticket='+encodeURIComponent(current.lease.ticket));
      if(parked!==current||request!==operation)return;
      if(!samePlaybackSession(lease,current.lease)||lease.ticket!==current.lease.ticket||
        current.lease.url&&lease.url!==current.lease.url){lostReturn();return;}
      current.lease=lease;
    }catch(failure){
      if(parked!==current||request!==operation)return;
      if([400,404,409,410].includes(failure.status)){lostReturn();return;}
    }
    refresh();
    if(parked===current)queueStatus();
  }

  async function options(){
    const source=getSource();
    if(!source||parked||loading||busy)return;
    const request=++operation;
    choices=[];error='';loading=true;paint();
    try{
      const params=new URLSearchParams(sourceRef(source));
      const data=await api(route+'/options?'+params);
      if(request!==operation||!sameSource(source,getSource()))return;
      choices=(Array.isArray(data?.options)?data.options:[]).filter(option=>option?.hash!==source.hash&&
        typeof option?.hash==='string'&&Number.isInteger(option.index)&&typeof option.sessionId==='string')
        .slice(0,8).map(option=>({...option,title:titleFor(option)}));
    }catch(failure){
      if(request===operation)error=failure.message||'Cinema could not check the ready titles.';
    }finally{
      if(request===operation){loading=false;paint();}
    }
  }

  async function switchTo(option){
    const source=getSource();
    if(!source||parked||busy||!choices.some(choice=>samePlaybackSession(choice,option)))return;
    const request=++operation;
    busy=true;error='';paint();
    try{
      const data=await api(route,{action:'switch',from:sourceRef(source),to:sourceRef(option)});
      const lease=data?.lease,current=getSource();
      if(request!==operation||!sameSource(source,current)){
        release(lease?.ticket);
        return;
      }
      if(!samePlaybackSession(lease,source)||!lease.ticket||!Number.isFinite(lease.expiresAt)||lease.expiresAt<=now()||
        source.url&&lease.url!==source.url||!matchesPlaybackAttachment(data.attachment,option)||
        data.attachment.state.status!=='ready'||!data.attachment.state.url){
        release(lease?.ticket);
        throw Error('The prepared video changed. Keep watching here or choose another title.');
      }
      parked={lease,source:current};
      choices=[];
      attach(data.attachment,{fallback:true});
      queueStatus();
    }catch(failure){
      if(request===operation)error=failure.message||'This title is no longer ready.';
    }finally{
      if(request===operation){busy=false;paint();}
    }
  }

  async function returnToParked(){
    const current=parked;
    if(!current||busy)return;
    if(current.lease.expiresAt<=now()){lostReturn();return;}
    const request=++operation;
    cancel(timer);timer=null;
    busy=true;error='';paint();
    try{
      const data=await api(route,{action:'return',ticket:current.lease.ticket});
      if(request!==operation||parked!==current)return;
      if(!matchesPlaybackAttachment(data?.attachment,current.lease)){
        lostReturn();
        return;
      }
      const sameRun=current.source.url&&current.source.url===data.attachment.state.url;
      const source=current.source;
      forget();
      attach(data.attachment,{fallback:false,intent:source.intent,verifiedEpisode:source.verifiedEpisode,
        position:sameRun?source.position:0,positionVerified:Boolean(sameRun&&source.positionVerified),paused:source.paused});
    }catch(failure){
      if(request!==operation)return;
      if([404,409,410].includes(failure.status))lostReturn();
      else error=failure.message||'Cinema could not return to the prepared title.';
    }finally{
      if(request===operation){
        busy=false;refresh();
        if(parked===current)queueStatus();
      }
    }
  }

  return {options,switchTo,returnToParked,clear,refresh,cancelPendingSwitch,
    invalidate(hash){if(parked?.source.hash===hash)lostReturn(true);}};
}

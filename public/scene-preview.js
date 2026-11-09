const TTL = 60_000;
const FETCH_BUFFER_MS = 11_000;
const WALL_CLOCK_PADDING_MS = 20;
const MAX_TARGET_MS = 86_400_000;
const returnLabels = {timeline:'Back to playback map',dialogue:'Back to dialogue results'};

export function bindMomentAction(button,capture,activate) {
  let pressed;
  button.addEventListener('pointerdown',event=>{
    if(event.button===0&&event.isPrimary!==false)pressed={pointer:true,value:capture()};
  });
  button.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    if(event.repeat){event.preventDefault();return;}
    pressed={pointer:false,value:capture()};
  });
  button.addEventListener('pointercancel',()=>{if(pressed?.pointer)pressed=undefined;});
  button.addEventListener('blur',()=>{if(pressed&&!pressed.pointer)pressed=undefined;});
  button.addEventListener('click',event=>{
    const value=pressed?.pointer===(event.detail>0)?pressed.value:capture();
    pressed=undefined;
    activate(value);
  });
}

export function parseSceneTime(value) {
  const match = /^(\d{1,4}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [,a,b,c,fraction=''] = match;
  if (Number(b)>=60||c!==undefined&&Number(c)>=60) return null;
  const seconds = c===undefined ? Number(a)*60+Number(b) : Number(a)*3600+Number(b)*60+Number(c);
  const milliseconds = seconds*1000+Number(fraction.padEnd(3,'0'));
  return milliseconds<=MAX_TARGET_MS ? milliseconds : null;
}

function inputTime(ms) {
  const total=Math.floor(ms/1000),hours=Math.floor(total/3600),minutes=Math.floor(total/60)%60;
  const two=number=>String(number).padStart(2,'0');
  const fraction=ms%1000;
  return `${hours?hours+':'+two(minutes):minutes}:${two(total%60)}${fraction?'.'+String(fraction).padStart(3,'0'):''}`;
}

const sameAttachment = (left,right) => Boolean(left&&right&&left.key===right.key&&left.hash===right.hash&&
  left.index===right.index&&left.sessionId===right.sessionId);
const attachmentIdentity = source => source?JSON.stringify([source.key,source.hash,source.index,source.sessionId]):null;

export function createScenePreviewUI({panel,ancestor,mainVideo,getContext,canSeek,request,formatTime,returnFocus}) {
  const get = id => panel.querySelector('#scene-preview-'+id);
  const form=get('form'), time=get('time'), trigger=get('request'), status=get('status');
  const card=get('card'), video=get('video'), play=get('play'), audio=get('audio'), close=get('close'), back=get('return');
  let current, offer, fetchButton, entry;

  function announce(text) { status.textContent = text; }
  function mainAudible() { return !mainVideo.paused&&!mainVideo.muted&&mainVideo.volume>0; }
  function insideVideo(source,targetMs) {
    return Boolean(source&&Number.isSafeInteger(targetMs)&&targetMs>=0&&targetMs<=MAX_TARGET_MS&&
      Number.isFinite(source.duration)&&targetMs/1000<source.duration);
  }
  function entryCurrent(link,context=getContext()) {
    return !link||link===entry&&sameAttachment(link.source,context)&&insideVideo(context,link.targetMs)&&link.validate();
  }
  function valid(attempt) {
    const context=getContext();
    return attempt===current&&sameAttachment(attempt.source,context)&&panel.open&&ancestor.open&&
      attempt.entry===entry&&entryCurrent(attempt.entry,context);
  }
  function setEntry(link) {
    entry=link;
    back.hidden=!link;
    back.textContent=link?returnLabels[link.origin]:'';
  }
  function restoreOrigin(link) {
    const candidates=[link.opener,...(returnFocus?.(link.origin)||[])];
    candidates.find(node=>node?.isConnected&&!node.hidden&&!node.disabled&&
      (!node.getClientRects||node.getClientRects().length))?.focus();
  }
  function busy(value) {
    const fetching = value&&current?.fetch===true;
    form.setAttribute('aria-busy',String(value));
    trigger.setAttribute('aria-disabled',String(value));
    time.readOnly = fetching;
    status.toggleAttribute('data-fetching',fetching);
    close.hidden = !value&&!current?.url;
    close.textContent = value?'Cancel':'Close preview';
  }
  function clearOffer() {
    offer = undefined;
    if (fetchButton) fetchButton.hidden = true;
  }
  function showOffer(source,targetMs,message='This scene is still downloading. You can request a short preview.') {
    if (!fetchButton) {
      fetchButton = document.createElement('button');
      fetchButton.type = 'button';
      fetchButton.className = 'player-primary scene-preview-fetch';
      fetchButton.textContent = 'Get preview';
      fetchButton.setAttribute('aria-describedby','scene-preview-status');
      fetchButton.addEventListener('click',fetchScene);
      form.insertBefore(fetchButton,close);
    }
    offer = {source,targetMs,entry};
    fetchButton.hidden = false;
    announce(message);
  }
  function reset({focus=false,message='',keepEntry=false}={}) {
    const attempt = current;
    current = undefined;
    clearOffer();
    if(!keepEntry){
      if(entry&&parseSceneTime(time.value)===entry.targetMs)time.value='';
      setEntry(undefined);
    }
    if (attempt) {
      attempt.control.abort();
      clearTimeout(attempt.expires);
      clearTimeout(attempt.loading);
      if (attempt.url) {
        video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(attempt.url);
      }
    }
    card.hidden = true;
    video.muted = true;video.defaultMuted = true;
    play.disabled = true;play.textContent = 'Play preview';
    audio.textContent = 'Preview sound';audio.setAttribute('aria-pressed','false');
    busy(false);announce(message);
    if (focus&&!panel.hidden&&panel.open&&ancestor.open) trigger.focus({preventScroll:true});
  }
  function invalidate(context=getContext()) {
    const link=entry,focused=panel.contains(document.activeElement);
    reset({message:link&&context?'The selected moment changed. Choose it again.':''});
    if(link&&focused){
      if(context&&panel.open&&ancestor.open)trigger.focus();
      else restoreOrigin(link);
    }
  }
  function refresh(context=getContext()) {
    const source = current?.source??offer?.source;
    if ((source&&!sameAttachment(source,context))||!entryCurrent(entry,context)) invalidate(context);
    panel.hidden = !context;
    if (panel.hidden) panel.open = false;
  }
  function revalidateEntry() {
    if(!entry)return;
    const context=getContext();
    if(!entryCurrent(entry,context))invalidate(context);
  }
  function updateAudio() {
    const audible = mainAudible();
    if (audible) video.muted = true;
    audio.disabled = !current?.ready||audible;
    audio.setAttribute('aria-pressed',String(!video.muted));
    audio.title = audible?'Pause the main video to hear the preview.':'';
  }
  function land() {
    const attempt = current;
    if (!attempt?.url||!valid(attempt)||attempt.ready||video.readyState<2||video.seeking||
      Math.abs(video.currentTime-attempt.seek)>.05) return;
    clearTimeout(attempt.loading);
    attempt.ready = true;
    play.disabled = false;
    updateAudio();
    announce('Preview ready at '+formatTime(attempt.targetMs/1000)+'.');
    if ((attempt.fetch||attempt.entry)&&document.activeElement===close) play.focus();
  }
  function previewFailed(attempt,message) {
    const focus=document.activeElement===close;
    const linked=Boolean(attempt.entry&&entryCurrent(attempt.entry));
    reset({focus:!linked&&attempt.fetch&&focus,message,keepEntry:linked});
    if(linked&&focus)back.focus();
  }
  video.addEventListener('loadedmetadata',()=>{
    const attempt = current;
    if (!attempt?.url||!valid(attempt)) return;
    if (!Number.isFinite(video.duration)||attempt.seek>=video.duration) {
      previewFailed(attempt,'Cinema could not open this preview. Try again.');
      return;
    }
    try { if (Math.abs(video.currentTime-attempt.seek)>.002) video.currentTime=attempt.seek; }
    catch {previewFailed(attempt,'Cinema could not open this preview. Try again.');}
    land();
  });
  video.addEventListener('loadeddata',land);
  video.addEventListener('seeked',land);
  video.addEventListener('play',()=>{if(current?.ready)play.textContent='Pause preview';});
  video.addEventListener('pause',()=>{play.textContent='Play preview';});
  video.addEventListener('ended',()=>{play.textContent='Replay preview';});
  video.addEventListener('error',()=>{if(current?.url)previewFailed(current,'Cinema could not open this preview. Try again.');});

  time.addEventListener('input',()=>{
    if (entry&&parseSceneTime(time.value)!==entry.targetMs) {reset();return;}
    if (offer&&parseSceneTime(time.value)!==offer.targetMs) {clearOffer();announce('');}
  });
  form.addEventListener('submit',event=>{
    event.preventDefault();
    const source = getContext();
    if (!source||current&&!current.url) return;
    const targetMs = parseSceneTime(time.value);
    if (targetMs===null) {announce('Enter a time like 12:30 or 1:12:30.');time.focus();return;}
    if (Number.isFinite(source.duration)&&source.duration>0&&targetMs/1000>=source.duration) {
      announce('Choose a moment inside this video.');time.focus();return;
    }
    if(entry&&(entry.targetMs!==targetMs||!entryCurrent(entry,source))){invalidate(source);return;}
    if (canSeek(targetMs/1000)) {
      clearOffer();announce('This moment is already available on the main timeline.');return;
    }
    void run(source,targetMs);
  });
  function fetchScene() {
    const source = getContext();
    if (!offer||!panel.open||!ancestor.open||parseSceneTime(time.value)!==offer.targetMs) return;
    if(!sameAttachment(source,offer.source)||offer.entry!==entry||!entryCurrent(entry,source)){invalidate(source);return;}
    const {targetMs} = offer;
    if (canSeek(targetMs/1000)) {
      clearOffer();trigger.focus({preventScroll:true});
      announce('This moment is already available on the main timeline.');return;
    }
    if (mainVideo.paused) {announce('Resume your video, then try Get preview again.');return;}
    if (mainVideo.playbackRate!==1) {announce('Return to normal playback speed to get a preview.');return;}
    // Browser and Node can quantize the same Windows wall clock differently.
    // Age the sample slightly so the server keeps its strict freshness check.
    const sampledAt = Date.now() - WALL_CLOCK_PADDING_MS;
    const position = mainVideo.currentTime;
    if (mainVideo.readyState>=3&&!mainVideo.seeking&&!mainVideo.ended&&!mainVideo.error&&
      Number.isFinite(position)&&position>=0) {
      const playheadMs = Math.ceil(position*1000);
      const buffered = mainVideo.buffered;
      for (let i=0;i<buffered.length;i++) {
        if (buffered.start(i)>position) break;
        const bufferedUntilMs = Math.floor(buffered.end(i)*1000);
        if (Number.isSafeInteger(bufferedUntilMs)&&bufferedUntilMs-playheadMs>=FETCH_BUFFER_MS) {
          void run(source,targetMs,{fetch:true,playheadMs,bufferedUntilMs,sampledAt});
          return;
        }
      }
    }
    announce('Give your video a little more time to buffer, then try Get preview again.');
  }
  async function run(source,targetMs,options) {
    const fetching = options?.fetch===true;
    const focusCancel = fetching?document.activeElement===fetchButton:Boolean(entry);
    reset({keepEntry:Boolean(entry)});
    const attempt = {source,targetMs,fetch:fetching,entry,control:new AbortController()};
    current = attempt;
    busy(true);
    if (focusCancel) close.focus();
    announce(fetching?'Getting a short preview…':'Checking whether this moment is ready…');
    try {
      if(!valid(attempt))return;
      const {blob,seek} = await request(source,targetMs,attempt.control.signal,options);
      if (!valid(attempt)) return;
      attempt.seek = seek;
      attempt.url = URL.createObjectURL(blob);
      attempt.expires = setTimeout(()=>{
        if (attempt===current) reset({focus:card.contains(document.activeElement)||document.activeElement===close,
          message:'This preview expired. You can check the moment again.',keepEntry:Boolean(attempt.entry&&entryCurrent(attempt.entry))});
      },TTL);
      attempt.loading = setTimeout(()=>{
        if (attempt===current&&!attempt.ready) previewFailed(attempt,'The preview could not open. Try again.');
      },3500);
      video.muted = true;video.defaultMuted = true;
      video.src = attempt.url;card.hidden = false;busy(false);
      announce('Opening the preview…');
    } catch(error) {
      if (valid(attempt)) {
        const message = error.message||'Cinema could not preview this scene. Try again.';
        const retry = fetching&&(error.code==='scene-runway'||error.code==='scene-fetch-unavailable');
        const available = !fetching&&error.code==='scene-missing'&&error.canFetch===true;
        if ((retry||available)&&parseSceneTime(time.value)===targetMs) {
          const focusRetry = (retry||attempt.entry)&&document.activeElement===close;
          reset({keepEntry:Boolean(attempt.entry)});
          showOffer(source,targetMs,retry?message:undefined);
          if (focusRetry) fetchButton.focus();
        } else previewFailed(attempt,message);
      }
    } finally {
      if (current===attempt&&!valid(attempt)) invalidate();
    }
  }
  play.addEventListener('click',()=>{
    const attempt = current;
    if (!attempt?.ready||!valid(attempt)) return;
    if (!video.paused&&!video.ended) {video.pause();return;}
    if (video.ended) video.currentTime=attempt.seek;
    void video.play().catch(()=>{if(valid(attempt))announce('Press Play preview again.');});
  });
  audio.addEventListener('click',()=>{if(!current?.ready||mainAudible())return;video.muted=!video.muted;updateAudio();});
  function cancel() {
    if(entry){returnToOrigin();return;}
    reset({focus:true,message:current?.fetch&&!current.url?'Preview canceled.':''});
  }
  function returnToOrigin() {
    if(!entry)return;
    const link=entry;
    reset();panel.open=false;
    if(link.openedAncestor)ancestor.open=false;
    restoreOrigin(link);
  }
  close.addEventListener('click',cancel);
  back.addEventListener('click',returnToOrigin);
  for (const event of ['play','pause','volumechange']) mainVideo.addEventListener(event,updateAudio);
  for (const event of ['pause','seeking','waiting','stalled','ended','error','emptied','ratechange']) {
    mainVideo.addEventListener(event,()=>{
      if (current?.fetch&&!current.url&&(event!=='stalled'||mainVideo.readyState<3))
        previewFailed(current,'Preview stopped to give the main video priority. Check the scene again when ready.');
    });
  }
  ancestor.addEventListener('toggle',()=>{if(!ancestor.open)reset();});
  panel.addEventListener('toggle',()=>{if(!panel.open)reset();});

  return {reset,refresh,revalidateEntry,
    attachmentKey(source=getContext()){return attachmentIdentity(source);},
    canCheckAt(seconds){return Number.isFinite(seconds)&&seconds>=0&&insideVideo(getContext(),Math.round(seconds*1000));},
    checkAt(seconds,{origin,opener,validate,attachmentKey}={}){
      if(!Number.isFinite(seconds)||seconds<0||!Object.hasOwn(returnLabels,origin)||typeof validate!=='function')return false;
      const source=getContext(),targetMs=Math.round(seconds*1000);
      if(!insideVideo(source,targetMs)||attachmentKey!==attachmentIdentity(source)||!validate()||canSeek(targetMs/1000)||
        (current&&!current.url))return false;
      if(entry?.targetMs===targetMs&&entry.origin===origin&&sameAttachment(entry.source,source)&&(current||offer))return false;
      const openedAncestor=origin==='timeline'&&(!ancestor.open||Boolean(entry?.openedAncestor));
      setEntry({source,targetMs,origin,opener,validate,openedAncestor});
      ancestor.open=true;panel.hidden=false;panel.open=true;time.value=inputTime(targetMs);
      void run(source,targetMs);
      return true;
    },escape(){
    if(entry){if(!panel.contains(document.activeElement))return false;returnToOrigin();return true;}
    if (!current&&!panel.open) return false;
    if (current) {cancel();return true;}
    if (!ancestor.open||!panel.contains(document.activeElement)) return false;
    panel.open = false;panel.querySelector('summary').focus({preventScroll:true});return true;
  }};
}

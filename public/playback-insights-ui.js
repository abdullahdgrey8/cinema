const unavailable='Not measured';
const phaseCopy={
  idle:'Waiting for video',preparing:'Preparing playback',paused:'Paused',
  waiting:'Waiting for more video',checking:'Checking this position',blocked:'Playback needs attention',ended:'Playback ended',
};
const trendCopy={
  collecting:'Checking playback pace',steady:'Keeping pace so far',draining:'Prepared video is running down',
  uncertain:'Playback pace uncertain',unavailable:'Playing',
};
const formatMode={hls:'Prepared video stream',direct:'Direct from the file'};
const codecNames={
  h264:'H.264',hevc:'HEVC',h265:'HEVC',av1:'AV1',vp8:'VP8',vp9:'VP9',mpeg2video:'MPEG-2',mpeg4:'MPEG-4',
  vc1:'VC-1',theora:'Theora',aac:'AAC',ac3:'Dolby Digital',eac3:'Dolby Digital Plus',opus:'Opus',
  mp3:'MP3',flac:'FLAC',dts:'DTS',truehd:'Dolby TrueHD',vorbis:'Vorbis',alac:'ALAC',
};

function setText(node,value){
  if(node.textContent!==value)node.textContent=value;
}

function coarseSpan(seconds){
  if(!Number.isFinite(seconds)||seconds<0)return unavailable;
  if(seconds===0)return '0 sec';
  if(seconds<5)return 'Under 5 sec';
  const minute=[10,4,2,1].find(value=>seconds>=value*60);
  if(minute)return minute+'+ min';
  return [45,30,20,10,5].find(value=>seconds>=value)+'+ sec';
}

function lowWindow(estimate){
  if(!estimate)return '';
  const {earliest,latest}=estimate;
  if(!Number.isFinite(earliest)||!Number.isFinite(latest)||earliest<0||latest<=0||latest<earliest)return '';
  const edges=[15,30,45,60];
  const high=edges.find(value=>value>=latest);
  if(!high)return '';
  const low=edges.findLast(value=>value<=earliest&&value<high);
  return low?`May run low in ${low}–${high} sec`:`May run low within ${high} sec`;
}

function basename(value){
  if(typeof value!=='string')return '';
  const name=value.split(/[\\/]/).at(-1).replace(/[\p{Cc}\p{Cf}]/gu,'').split('?')[0].replace(/^[a-z]:/i,'').trim().slice(0,240);
  return name==='.'||name==='..'?'':name;
}

function filenameClaims(name){
  const tokens=name.replace(/[._]+/g,' ');
  const size=tokens.match(/\b(?:2160p|1440p|1080[pi]|720p|576p|480p)\b/i)?.[0].toLowerCase();
  const video=/\b(?:hevc|[xh][ -]?265)\b/i.test(tokens)?'HEVC':/\b[xh][ -]?264\b/i.test(tokens)?'H.264':/\bav1\b/i.test(tokens)?'AV1':null;
  const range=/\b(?:dolby[ -]+vision|dovi|dv)\b/i.test(tokens)?'Dolby Vision':/\bhdr10\+/i.test(tokens)?'HDR10+':/\bhdr(?:10)?\b/i.test(tokens)?'HDR':null;
  const source=/\bblu[ -]?ray\b/i.test(tokens)?'Blu-ray':/\bweb[ -]?dl\b/i.test(tokens)?'WEB-DL':/\bwebrip\b/i.test(tokens)?'WEBRip':/\bhdtv\b/i.test(tokens)?'HDTV':null;
  return [size,video,range,source].filter(Boolean).join(' · ');
}

function dimensions(value){
  const {width,height}=value||{};
  return Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width<=32768&&height<=32768?
    width+' × '+height:null;
}

function codec(value){
  if(typeof value!=='string')return null;
  const key=value.toLowerCase();
  return Object.hasOwn(codecNames,key)?codecNames[key]:/^[a-z0-9][a-z0-9_]{0,23}$/.test(key)?key.toUpperCase():null;
}

function clock(seconds){
  if(!Number.isFinite(seconds)||seconds<=0)return unavailable;
  const total=Math.round(seconds),hours=Math.floor(total/3600),minutes=Math.floor(total/60)%60;
  return (hours?hours+':'+String(minutes).padStart(2,'0'):String(minutes))+':'+String(total%60).padStart(2,'0');
}

function elapsed(ms){
  if(!Number.isFinite(ms)||ms<0)return unavailable;
  const seconds=ms/1000;
  return seconds>=60?clock(seconds):(seconds<.1?'<0.1':Number(seconds.toFixed(1)))+' sec';
}

function interruptionSummary(passport){
  const {stalls,firstPictureMs,picture}=passport;
  if(!stalls||!Number.isSafeInteger(stalls.count)||stalls.count<0)return unavailable;
  if(!stalls.count&&!dimensions(picture)&&!Number.isFinite(firstPictureMs))return 'Not observed yet';
  if(!stalls.count)return 'None observed';
  const count=stalls.count+(stalls.count===1?' interruption':' interruptions');
  const observedMs=stalls.waiting?Math.floor(stalls.totalMs/1000)*1000:stalls.totalMs;
  const total=Number.isFinite(observedMs)&&observedMs>0?' · '+elapsed(observedMs):'';
  return count+total+(stalls.waiting?' · Waiting now':'');
}

function runwayView(host){
  if(!host)return ()=>{};
  host.innerHTML=`<div class="runway-line">
    <span class="runway-title"><svg class="cinema-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18M5 13h4m3 0h7M7 9h8M11 5h6"/></svg><span>Playback runway</span></span>
    <div class="runway-readings">
      <span class="runway-reading"><span class="runway-swatch runway-swatch-buffer" aria-hidden="true"></span><span>Browser buffer</span><strong data-runway-buffer></strong></span>
      <span class="runway-reading" data-runway-prepared-row hidden><span class="runway-swatch runway-swatch-prepared" aria-hidden="true"></span><span>Prepared video</span><strong data-runway-prepared></strong></span>
    </div>
    <span class="runway-state" data-runway-state></span>
  </div><span class="sr-only" data-runway-announcement role="status" aria-live="polite" aria-atomic="true"></span>`;
  const $=selector=>host.querySelector(selector);
  const buffer=$('[data-runway-buffer]'),prepared=$('[data-runway-prepared]'),preparedRow=$('[data-runway-prepared-row]');
  const status=$('[data-runway-state]'),announcement=$('[data-runway-announcement]');
  let lastState='';

  return (value,mode)=>{
    if(!value){
      host.hidden=true;lastState='';
      for(const node of [buffer,prepared,status,announcement])setText(node,'');
      preparedRow.hidden=true;delete status.dataset.tone;
      return;
    }
    host.hidden=false;
    setText(buffer,coarseSpan(value.bufferedAhead));
    const showPrepared=!value.complete&&(mode==='hls'||Number.isFinite(value.preparedAhead));
    preparedRow.hidden=!showPrepared;
    setText(prepared,showPrepared?coarseSpan(value.preparedAhead):'');
    const forecast=value.phase==='playing'&&showPrepared&&value.trend==='draining'?lowWindow(value.estimate):'';
    const notice=phaseCopy[value.phase]||(value.complete?'Full video available':forecast||(showPrepared?trendCopy[value.trend]:'Playing'));
    const state=value.phase==='waiting'?'waiting':value.phase==='blocked'?'blocked':forecast?'risk':value.phase;
    setText(status,notice||'Playback pace uncertain');
    if(status.dataset.tone!==state)status.dataset.tone=state;
    if(state!==lastState){
      // The existing player status already announces when playback is waiting.
      const live=state==='risk'?'Prepared video may run low at the current pace.':'';
      setText(announcement,live);lastState=state;
    }
  };
}

function passportView(host){
  if(!host)return ()=>{};
  host.innerHTML=`<summary>
    <svg class="cinema-icon passport-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 8h6M8 12h8m-8 4h5"/></svg>
    <span>Release Passport</span>
    <svg class="cinema-icon passport-chevron" aria-hidden="true"><use href="#ico-down"/></svg>
  </summary>
  <div class="passport-body">
    <section class="passport-label"><h4>Release filename</h4><p class="passport-filename" data-passport-file></p>
      <p class="passport-claims"><span>Filename claims</span><strong data-passport-claims></strong></p></section>
    <section><h4>Local file inspection</h4><dl>
      <div><dt>Video</dt><dd data-passport-video></dd></div>
      <div><dt>Audio</dt><dd data-passport-audio></dd></div>
    </dl></section>
    <section><h4>This playback</h4><dl>
      <div><dt>Playback path</dt><dd data-passport-mode></dd></div>
      <div><dt>Video length</dt><dd data-passport-duration></dd></div>
      <div><dt>Presented picture</dt><dd data-passport-picture></dd></div>
      <div><dt>First picture</dt><dd data-passport-first-picture></dd></div>
      <div><dt>Interruptions</dt><dd data-passport-stalls></dd></div>
    </dl></section>
  </div>`;
  const fields=new Map(['file','claims','video','audio','mode','duration','picture','first-picture','stalls']
    .map(key=>[key,host.querySelector('[data-passport-'+key+']')]));
  return value=>{
    host.hidden=!value;
    if(!value){
      host.open=false;
      for(const field of fields.values())setText(field,'');
      return;
    }
    const name=basename(value.fileName),video=[codec(value.probe?.videoCodec),dimensions(value.probe)].filter(Boolean).join(' · ');
    const copy={
      file:name||'Filename unavailable',claims:filenameClaims(name)||'None recognized',
      video:video||unavailable,audio:codec(value.probe?.audioCodec)||unavailable,
      mode:formatMode[value.mode]||unavailable,duration:clock(value.duration),
      picture:dimensions(value.picture)||'Not presented yet','first-picture':elapsed(value.firstPictureMs),stalls:interruptionSummary(value),
    };
    for(const [key,field] of fields)setText(field,copy[key]);
  };
}

export function createPlaybackInsightsUI({runwayHost,passportHost}){
  const renderRunway=runwayView(runwayHost),renderPassport=passportView(passportHost);
  function update({runway=null,passport=null}={}){
    renderRunway(runway,passport?.mode);
    renderPassport(passport);
  }
  update();
  return {update};
}


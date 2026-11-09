import {updateHTML,updateKeyedList} from './dom.js';

const DAY_MS=86400000;
const FOLLOW_ID=/^tvmaze-[1-9]\d{0,11}$/;
const EPISODE_ID=/^tvmaze-episode-[1-9]\d{0,11}$/;
const escape=value=>String(value??'').replace(/[&<>"']/g,character=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[character]));
const calendarDate=stamp=>new Date(stamp).toISOString().slice(0,10);
const deviceZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const localFormatter=timeZone=>new Intl.DateTimeFormat('en-CA',{timeZone,calendar:'gregory',numberingSystem:'latn',
  year:'numeric',month:'2-digit',day:'2-digit'});
function localKey(formatter,stamp){
  const parts=Object.fromEntries(formatter.formatToParts(stamp).map(part=>[part.type,part.value]));
  return parts.year+'-'+parts.month+'-'+parts.day;
}
function dateStamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;
  const stamp=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(stamp)&&calendarDate(stamp)===value?stamp:NaN;
}
function instant(value){
  if(Number.isFinite(value)&&Math.abs(value)<=8640000000000000)return value;
  return typeof value==='string'&&/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)?Date.parse(value):NaN;
}

export function weekDays({now=Date.now(),offset=0,timeZone=deviceZone()}={}){
  const today=localKey(localFormatter(timeZone),now);
  const base=dateStamp(today),weekday=(new Date(base).getUTCDay()+6)%7;
  const start=base+(offset*7-weekday)*DAY_MS;
  return {today,days:Array.from({length:7},(_,index)=>calendarDate(start+index*DAY_MS))};
}

export function groupWeekEpisodes(follows,schedules,{now=Date.now(),offset=0,timeZone=deviceZone()}={}){
  const week=weekDays({now,offset,timeZone});
  const days=week.days.map(key=>({key,episodes:[]}));
  const byDay=new Map(days.map(day=>[day.key,day]));
  const format=localFormatter(timeZone);
  let undatedCount=0;
  for(const show of follows){
    const result=schedules.get(show.id);
    if(result?.showId!==show.id)continue;
    if(Number.isSafeInteger(result.undatedCount)&&result.undatedCount>0)undatedCount+=result.undatedCount;
    const seen=new Set();
    for(const episode of result.episodes||[]){
      if(!EPISODE_ID.test(episode?.id||'')||seen.has(episode.id))continue;
      seen.add(episode.id);
      const schedule=episode.schedule;
      if(schedule?.precision==='instant'){
        const at=instant(schedule.at);
        if(Number.isFinite(at))byDay.get(localKey(format,at))?.episodes.push({
          show,episode,at,phase:at<=Number(now)?'aired':'upcoming'
        });
      }else if(schedule?.precision==='date'&&Number.isFinite(dateStamp(schedule.date))){
        byDay.get(schedule.date)?.episodes.push({show,episode,at:null,phase:'date'});
      }
    }
  }
  for(const day of days)day.episodes.sort((a,b)=>(a.at??Infinity)-(b.at??Infinity)||
    a.show.title.localeCompare(b.show.title)||Number(a.episode.number)-Number(b.episode.number));
  return {today:week.today,days,undatedCount};
}

const typeLabel=kind=>kind==='anime'?'Anime':kind==='korean'?'Korean drama':'Series';
const plural=(count,word)=>count+' '+word+(count===1?'':'s');
const labels={
  weekday:new Intl.DateTimeFormat(undefined,{weekday:'short',timeZone:'UTC'}),
  date:new Intl.DateTimeFormat(undefined,{month:'long',day:'numeric',weekday:'long',timeZone:'UTC'}),
  range:new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',timeZone:'UTC'})
};
const episodeKey=(show,episode)=>show.id+':'+episode.id;
const episodeLabel=episode=>episode.special?'Special':Number.isInteger(episode.season)&&Number.isInteger(episode.number)?
  (episode.season>=1900?episode.season:'S'+episode.season)+' · E'+episode.number:
  Number.isInteger(episode.number)?'Episode '+episode.number:'Episode';
const logo='<svg class="cinema-icon" aria-hidden="true"><use href="#ico-film"/></svg>';
function normalizeFollows(values){
  const entries=new Map();
  for(const show of Array.isArray(values)?values:[]){
    if(FOLLOW_ID.test(show?.id||'')&&typeof show.title==='string'&&show.title.trim()&&!entries.has(show.id))
      entries.set(show.id,show);
    if(entries.size>=12)break;
  }
  return [...entries.values()];
}

export function createFollowWeekUI({getFollows,loadSchedule,onUnfollow,onOpenEpisode,checkEpisode,onBrowse}){
  const dialog=document.getElementById('follow-week-dialog');
  const launchers=[...document.querySelectorAll('[data-follow-week-open]')];
  if(!dialog||!launchers.length)return {refreshFollows(){},invalidateEvidence(){}};
  const $=selector=>dialog.querySelector(selector);
  const tabs=$('#follow-week-days'),panel=$('#follow-week-day-panel'),list=$('#follow-week-episodes');
  const dayTitle=$('#follow-week-day-title'),range=$('#follow-week-range'),empty=$('#follow-week-empty');
  const message=$('#follow-week-warning'),refresh=$('#follow-week-retry'),undated=$('#follow-week-undated');
  const manage=$('#follow-week-manage'),manageList=$('#follow-week-manage-list'),count=$('#follow-week-count');
  const prev=$('#follow-week-previous'),next=$('#follow-week-next'),live=$('#follow-week-live');
  const feedback=$('#follow-week-feedback');
  const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
  const schedules=new Map(),errors=new Set(),evidence=new Map();
  let follows=[],offset=0,selectedDate=null,selectedRows=[],scheduleRun=null,checking=null,returnFocus=null,handoff=false,dayMotion=null;
  let week={today:'',days:[]},clock,clockZone;
  tabs.innerHTML=Array.from({length:7},(_,index)=>
    '<button type="button" id="follow-week-day-'+index+'" class="week-day" role="tab" data-week-day="'+index+
    '" aria-selected="false" aria-controls="follow-week-day-panel" tabindex="-1"><span class="week-day-name"></span>'+
    '<strong class="week-day-number"></strong><span class="week-day-count" aria-hidden="true"></span></button>').join('');
  const dayButtons=[...tabs.querySelectorAll('[data-week-day]')];
  const announcer=value=>setText(live,value);
  const hasFollow=id=>follows.some(show=>show.id===id);
  const activeDayIndex=()=>week.days.findIndex(day=>day.key===selectedDate);

  function renderLauncher(){
    const home=document.querySelector('#follow-week-entry p');
    if(home)setText(home,follows.length?follows.length+' followed series · Your upcoming episodes':
      'See when episodes from your followed series air.');
  }

  function cancelCheck(){
    const active=checking;
    checking=null;
    active?.controller.abort();
  }

  function stopSchedule(){
    const run=scheduleRun;
    scheduleRun=null;
    for(const controller of run?.controllers.values()||[])controller.abort();
  }

  function renderManage(){
    manage.hidden=!follows.length;
    setText(count,String(follows.length));
    updateHTML(manageList,follows.map(show=>'<li><div><strong>'+escape(show.title)+'</strong><span>'+escape(typeLabel(show.kind))+
      '</span></div><div class="week-manage-actions"><button class="text-button" type="button" data-week-guide="'+escape(show.id)+
      '" aria-label="Episode guide for '+escape(show.title)+'">Episode guide</button><button class="text-button" type="button" data-week-unfollow="'+
      escape(show.id)+'" aria-label="Unfollow '+escape(show.title)+'">Unfollow</button></div></li>').join(''));
  }

  function episodeMarkup(row){
    const {show,episode,at,phase}=row,key=episodeKey(show,episode);
    const stored=evidence.get(key),pending=checking?.key===key;
    const airTime=at===null?'Time unconfirmed':clock.format(at);
    const dateTime=at===null?selectedDate:new Date(at).toISOString();
    const airState=phase==='aired'?'Aired':phase==='upcoming'?'Upcoming':'Provider date';
    const canCheck=phase==='aired'||phase==='date'&&selectedDate<week.today;
    const poster=typeof show.posterUrl==='string'&&show.posterUrl.startsWith('/api/metadata/poster?')?show.posterUrl:null;
    const title=typeof episode.title==='string'&&episode.title.trim()?episode.title:'Episode details';
    const name=show.title+', '+episodeLabel(episode);
    return '<li class="week-episode"><div class="week-air"><time datetime="'+dateTime+'">'+
      escape(airTime)+'</time><span>'+airState+'</span></div><div class="week-episode-art" aria-hidden="true">'+logo+
      (poster?'<img src="'+escape(poster)+'" alt="" loading="lazy" decoding="async">':'')+'</div>'+
      '<div class="week-episode-copy"><span class="week-episode-kicker">'+escape(typeLabel(show.kind)+' · '+episodeLabel(episode))+
      '</span><h4>'+escape(show.title)+'</h4><p>'+escape(title)+'</p><dl class="week-episode-evidence"><div><dt>Source</dt><dd>'+
      escape(pending?'Checking…':stored?.source||'Not checked')+'</dd></div><div><dt>Captions</dt><dd>'+
      escape(pending?'Checking…':stored?.captions||'Not checked')+'</dd></div></dl></div><div class="week-episode-actions">'+
      '<button class="subtle" type="button" data-week-episode="'+escape(key)+'" aria-label="Episode guide for '+escape(name)+
      '">Episode guide</button>'+(canCheck?'<button class="text-button" type="button" data-week-check="'+escape(key)+'" aria-label="Check My Library for '+
      escape(name)+'" aria-disabled="'+Boolean(checking)+'">'+(pending?'Checking…':'Check My Library')+'</button>':'')+'</div></li>';
  }

  function render({motion=false}={}){
    if(!dialog.open)return;
    const timeZone=deviceZone();
    if(!clock||clockZone!==timeZone){
      clockZone=timeZone;
      clock=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',timeZoneName:'short',timeZone});
    }
    week=groupWeekEpisodes(follows,schedules,{offset,timeZone});
    if(activeDayIndex()<0)selectedDate=week.days.find(day=>day.key===week.today)?.key||week.days[0].key;
    const activeIndex=activeDayIndex(),selected=week.days[activeIndex];
    selectedRows=selected.episodes;
    const start=dateStamp(week.days[0].key),end=dateStamp(week.days[6].key);
    setText(range,labels.range.formatRange(start,end));
    prev.setAttribute('aria-disabled',String(offset<=-1));
    next.setAttribute('aria-disabled',String(offset>=2));
    for(const [index,button] of dayButtons.entries()){
      const day=week.days[index],stamp=dateStamp(day.key),isToday=day.key===week.today,isSelected=index===activeIndex;
      setText(button.querySelector('.week-day-name'),labels.weekday.format(stamp));
      setText(button.querySelector('.week-day-number'),String(Number(day.key.slice(-2))));
      setText(button.querySelector('.week-day-count'),day.episodes.length?String(day.episodes.length):'');
      button.tabIndex=isSelected?0:-1;
      button.setAttribute('aria-selected',String(isSelected));
      if(isToday)button.setAttribute('aria-current','date');else button.removeAttribute('aria-current');
      button.setAttribute('aria-label',labels.date.format(stamp)+', '+plural(day.episodes.length,'episode')+(isToday?', today':''));
    }
    panel.setAttribute('aria-labelledby',dayButtons[activeIndex].id);
    panel.setAttribute('aria-busy',String(Boolean(scheduleRun&&!schedules.size)));
    setText(dayTitle,labels.date.format(dateStamp(selectedDate)));
    const failed=[...errors].filter(hasFollow).length;
    const failedWithCache=[...errors].some(id=>hasFollow(id)&&schedules.has(id));
    message.hidden=!failed&&!scheduleRun;
    setText(message,failed?(failedWithCache?'Some schedules couldn’t refresh. Showing the last available listings.':
      'Some schedules are unavailable. Try again to refresh them.'):scheduleRun?'Checking followed series…':'');
    const hideRetry=!failed&&!scheduleRun?.retry;
    if(hideRetry&&document.activeElement===refresh)focusDay();
    refresh.hidden=hideRetry;
    refresh.setAttribute('aria-disabled',String(Boolean(scheduleRun)));
    undated.hidden=!week.undatedCount;
    setText(undated,week.undatedCount?plural(week.undatedCount,'episode')+' without a published date.':'');
    list.hidden=!selectedRows.length;
    empty.hidden=Boolean(selectedRows.length);
    if(!follows.length)updateHTML(empty,'<h4>Follow your first series</h4><p>Open a series and choose Follow in its episode guide. New episodes will appear here.</p>'+
      '<button class="primary" type="button" data-week-browse>Browse series</button>');
    else if(!selectedRows.length)updateHTML(empty,scheduleRun&&!schedules.size?
      '<h4>Loading schedules…</h4><p>Checking the series you follow.</p>':failed&&!schedules.size?
      '<h4>Schedules are unavailable</h4><p>You can still open the episode guides below.</p>':
      '<h4>No episodes listed for this day</h4><p>Choose another day or open a followed series below.</p>');
    updateKeyedList(list,selectedRows.map(row=>{
      const markup=episodeMarkup(row);
      return {key:episodeKey(row.show,row.episode),signature:markup,html:()=>markup,
        patch(element){const image=element.querySelector('img');if(image)image.addEventListener('error',()=>image.remove(),{once:true});}};
    }));
    renderManage();
    if(motion&&selectedRows.length&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      dayMotion?.cancel();
      dayMotion=list.animate([{opacity:.4,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],
        {duration:165,easing:'ease-out'});
    }
  }

  function refreshFollows(){
    const before=follows;
    follows=normalizeFollows(getFollows());
    for(const show of before){
      if(hasFollow(show.id))continue;
      schedules.delete(show.id);
      errors.delete(show.id);
      for(const key of evidence.keys())if(key.startsWith(show.id+':'))evidence.delete(key);
      if(checking?.key.startsWith(show.id+':'))cancelCheck();
      scheduleRun?.skipped.add(show.id);
      scheduleRun?.controllers.get(show.id)?.abort();
    }
    renderLauncher();
    render();
  }

  async function fetchSchedules({retry=false}={}){
    if(!dialog.open||scheduleRun||!follows.length)return;
    const run={ids:follows.map(show=>show.id),index:0,controllers:new Map(),skipped:new Set(),retry};
    scheduleRun=run;
    render();
    async function worker(){
      while(scheduleRun===run&&run.index<run.ids.length){
        const id=run.ids[run.index++];
        if(!hasFollow(id)||run.skipped.has(id))continue;
        const controller=new AbortController();
        run.controllers.set(id,controller);
        const current=()=>scheduleRun===run&&dialog.open&&hasFollow(id)&&!run.skipped.has(id)&&!controller.signal.aborted;
        try{
          const value=await loadSchedule(id,controller.signal);
          if(current()){
            if(value?.showId!==id||!Array.isArray(value.episodes))throw Error('Invalid schedule.');
            schedules.set(id,value);
            errors.delete(id);
          }
        }catch{if(current())errors.add(id);}
        finally{
          run.controllers.delete(id);
          if(current())render();
        }
      }
    }
    await Promise.all([worker(),worker()]);
    if(scheduleRun!==run)return;
    scheduleRun=null;
    render();
    announcer(errors.size?'Schedule check finished. Some followed series could not refresh.':'Schedule check finished.');
  }

  function focusDay(){
    const button=dayButtons[activeDayIndex()];
    button?.focus({preventScroll:true});
    button?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  }

  function selectDay(index,{focus=false}={}){
    const day=week.days[index];
    if(!day)return;
    const changed=selectedDate!==day.key;
    if(changed){cancelCheck();setText(feedback,'');}
    selectedDate=day.key;
    render({motion:changed});
    if(focus)focusDay();
    if(changed)announcer(labels.date.format(dateStamp(day.key))+', '+plural(day.episodes.length,'episode')+'.');
  }

  function navigateWeek(delta){
    const proposed=offset+delta;
    if(proposed< -1||proposed>2)return;
    const prior=selectedDate;
    cancelCheck();
    setText(feedback,'');
    offset=proposed;selectedDate=null;
    render({motion:true});
    if(selectedDate!==prior)announcer('Week of '+labels.date.format(dateStamp(week.days[0].key))+'.');
  }

  async function checkRow(key){
    const row=selectedRows.find(item=>episodeKey(item.show,item.episode)===key);
    if(!row||checking||!(row.phase==='aired'||row.phase==='date'&&selectedDate<week.today))return;
    const job={key,controller:new AbortController()};
    checking=job;
    setText(feedback,'');
    render();
    announcer('Checking My Library for '+row.show.title+'.');
    try{
      const result=await checkEpisode(row.show,row.episode,job.controller.signal);
      if(checking!==job||!dialog.open||job.controller.signal.aborted)return;
      const fact=value=>typeof value==='string'&&value.trim()?value.trim().slice(0,160):'Not checked';
      const report={source:fact(result?.source),captions:fact(result?.captions)};
      evidence.set(key,report);
      announcer('Source: '+report.source+'. Captions: '+report.captions+'.');
    }catch{
      if(checking===job&&!job.controller.signal.aborted){
        const text='Couldn’t check this episode. Try again.';
        setText(feedback,text);
        announcer(text);
      }
    }finally{
      if(checking===job){checking=null;render();}
    }
  }

  function invalidateEvidence(){
    cancelCheck();
    evidence.clear();
    if(dialog.open){setText(feedback,'');render();}
  }

  function leave(callback){
    handoff=true;
    dialog.close();
    callback();
  }

  function open(event){
    if(dialog.open)return;
    returnFocus=event.currentTarget;
    handoff=false;
    refreshFollows();
    dialog.showModal();
    render();
    focusDay();
    if(follows.length)void fetchSchedules();
  }

  for(const launcher of launchers)launcher.addEventListener('click',open);
  $('#follow-week-close').addEventListener('click',()=>dialog.close());
  prev.addEventListener('click',()=>navigateWeek(-1));
  next.addEventListener('click',()=>navigateWeek(1));
  $('#follow-week-today').addEventListener('click',()=>{
    const prior=selectedDate;
    if(offset!==0||selectedDate!==week.today){cancelCheck();setText(feedback,'');}
    offset=0;selectedDate=weekDays().today;
    render({motion:selectedDate!==prior});
    if(selectedDate!==prior)announcer('Today, '+labels.date.format(dateStamp(selectedDate))+'.');
  });
  refresh.addEventListener('click',()=>void fetchSchedules({retry:true}));
  tabs.addEventListener('click',event=>{
    const button=event.target.closest('[data-week-day]');
    if(button)selectDay(Number(button.dataset.weekDay),{focus:true});
  });
  tabs.addEventListener('keydown',event=>{
    const button=event.target.closest('[data-week-day]');
    if(!button)return;
    const current=Number(button.dataset.weekDay);
    const target={ArrowLeft:(current+6)%7,ArrowRight:(current+1)%7,Home:0,End:6}[event.key];
    if(target===undefined)return;
    event.preventDefault();
    selectDay(target,{focus:true});
  });
  dialog.addEventListener('click',event=>{
    const episode=event.target.closest('[data-week-episode]');
    const check=event.target.closest('[data-week-check]');
    const guide=event.target.closest('[data-week-guide]');
    const remove=event.target.closest('[data-week-unfollow]');
    if(episode){
      const row=selectedRows.find(item=>episodeKey(item.show,item.episode)===episode.dataset.weekEpisode);
      if(row)leave(()=>onOpenEpisode(row.show,row.episode.id));
    }else if(check)void checkRow(check.dataset.weekCheck);
    else if(guide){
      const show=follows.find(item=>item.id===guide.dataset.weekGuide);
      if(show)leave(()=>onOpenEpisode(show,null));
    }else if(remove){
      const index=follows.findIndex(show=>show.id===remove.dataset.weekUnfollow);
      if(index<0)return;
      const show=follows[index],result=onUnfollow(show.id);
      if(!result?.ok){
        const text=result?.message||'Couldn’t save this change. Try again.';
        setText(feedback,text);announcer(text);return;
      }
      setText(feedback,'');
      refreshFollows();
      const nextButton=manageList.querySelectorAll('[data-week-unfollow]')[Math.min(index,follows.length-1)];
      if(nextButton)nextButton.focus({preventScroll:true});
      else focusDay();
      announcer('Unfollowed '+show.title+'.');
    }else if(event.target.closest('[data-week-browse]'))leave(onBrowse);
  });
  dialog.addEventListener('close',()=>{
    if(dialog.open)return;
    stopSchedule();cancelCheck();dayMotion?.cancel();
    setText(feedback,'');announcer('');
    if(!handoff&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    handoff=false;returnFocus=null;
  });

  refreshFollows();
  return {refreshFollows,invalidateEvidence};
}

import { updateHTML } from './dom.js';
import { captureEdition, compareEditions } from './edition-atlas-model.js';

const PAGE_SIZE=8;
const labels={shared:'Shared dialogue','first-only':'Dialogue only in the saved track',
  'second-only':'Dialogue only in the current track',uncertain:'Uncertain'};
const issues={
  'same-file':'Open a different release of this title from My Library.',
  'wrong-title':'Open a verified release of the same movie or episode.',
  'duplicate-track':'These releases have the same subtitle evidence. Load the track timed for the current release.',
  insufficient:'There is not enough distinctive shared dialogue to compare these tracks.',
};
const sameCapture=(a,b)=>Boolean(a&&b&&a.fileKey===b.fileKey&&a.generation===b.generation&&
  a.sessionId===b.sessionId&&a.identity===b.identity&&a.track===b.track);
const displayLabel=value=>String(value||'Local video').replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,140);
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));

export function createEditionAtlasUI({host,getContext,canSeek,seek,clockTime,escape}){
  if(!host)return {refresh(){}};
  const $=selector=>host.querySelector(selector);
  const primary=$('[data-atlas-primary]'),clear=$('[data-atlas-clear]'),status=$('[data-atlas-status]');
  const instructions=$('[data-atlas-instructions]'),savedLabel=$('[data-atlas-saved]');
  const resultBox=$('[data-atlas-result]'),chart=$('[data-atlas-chart]'),timings=$('[data-atlas-timings]');
  const list=$('[data-atlas-passages]'),pager=$('.atlas-pages'),pageLabel=$('[data-atlas-page]');
  const previous=$('[data-atlas-previous]'),next=$('[data-atlas-next]');
  const parent=host.parentElement?.closest('details');
  let saved=null,result=null,page=0,working=false,seeking=false,feedback='';
  let presentedContext=null;

  function setText(node,value){if(node.textContent!==value)node.textContent=value;}
  function resetResult(){
    if(result&&resultBox.contains(document.activeElement))primary.focus({preventScroll:true});
    result=null;page=0;seeking=false;
    resultBox.hidden=true;timings.open=false;
    chart.replaceChildren();list.replaceChildren();pager.hidden=true;
  }
  function allowed(context){
    return Boolean(context?.canCapture&&(!saved||context.fileKey!==saved.fileKey&&context.identity===saved.identity));
  }
  function refresh(canSeekTime=canSeek){
    if(!host.open||parent&&!parent.open)return;
    const context=getContext();
    if(!sameCapture(presentedContext,context)&&presentedContext!==context){
      presentedContext=context;
      feedback='';
    }
    if(result&&!sameCapture(result.context,context))resetResult();
    let hint='Save the edition you’re watching, then open a second release in My Library.';
    if(!context?.identity)hint='Open a verified movie or episode to compare its releases.';
    else if(!context.canCapture)hint=context.hasTrack?'Play the video to capture this edition.':'Load the subtitle track for this release first.';
    else if(saved&&context.fileKey===saved.fileKey)hint='Open a second release of this title from My Library. Your saved edition stays here.';
    else if(saved&&context.identity!==saved.identity)hint=issues['wrong-title'];
    else if(saved)hint='Compare the subtitle timings from both releases.';
    setText(instructions,hint);
    setText(status,feedback);
    setText(primary,working?(saved?'Comparing…':'Saving…'):saved?'Compare with saved edition':'Save this edition');
    primary.setAttribute('aria-disabled',String(working||!allowed(context)));
    clear.hidden=!saved;clear.disabled=working;
    savedLabel.hidden=!saved;
    setText(savedLabel,saved?'Saved edition: '+saved.label:'');
    if(result&&timings.open)refreshJumps(canSeekTime);
  }

  function rail(side,duration,spans){
    const width=1000,knownEnd=Number.isFinite(duration)&&duration>0?duration:0;
    const range=knownEnd||spans.at(-1)?.[side][1]||1;
    const marks=spans.map(span=>{
      const [start,end]=span[side],x=Math.min(width,Math.max(0,start/range*width));
      const size=Math.min(width-x,Math.max(0,(end-start)/range*width));
      if(size<.05)return '';
      const fill=span.kind==='shared'?'shared':span.kind===side+'-only'?'only':'uncertain';
      return `<rect class="atlas-${fill}" x="${x.toFixed(2)}" y="1" width="${size.toFixed(2)}" height="10"/>`;
    }).join('');
    return `<svg viewBox="0 0 1000 12" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="atlas-uncertain" x="0" y="1" width="1000" height="10"/>${marks}</svg>`;
  }
  function present(second,comparison,context){
    result={second,comparison,context};
    const counts=comparison.counts,only=counts.firstOnly+counts.secondOnly;
    const row=(name,edition,side)=>`<div class="atlas-track"><div><span>${name}</span><strong>${escape(edition.label)}</strong></div>${rail(side,edition.duration,comparison.spans)}</div>`;
    chart.innerHTML=`<div class="atlas-summary"><span>${counts.shared} shared</span><span>${only} one-track</span><span>${counts.uncertain} uncertain</span></div>
      ${row('Saved edition',saved,'first')}${row('Current edition',second,'second')}
      <div class="atlas-legend" aria-label="Timeline legend"><span class="atlas-key-shared">Shared dialogue</span><span class="atlas-key-only">One track only</span><span class="atlas-key-uncertain">Uncertain</span></div>
      <p class="atlas-qualifier">Based on subtitle dialogue and timing. A difference may come from the captions or the cut.</p>`;
    timings.open=false;resultBox.hidden=false;page=0;renderPage();
  }
  function refreshJumps(canSeekTime=canSeek){
    for(const button of list.querySelectorAll('[data-atlas-jump]')){
      const span=result?.comparison.spans[Number(button.dataset.atlasJump)];
      const available=Boolean(span&&Number.isFinite(span.jumpSecond)&&canSeekTime(span.jumpSecond));
      button.setAttribute('aria-disabled',String(!available||seeking));
      setText(button,available?'Jump in current edition':'Not ready to jump');
      button.setAttribute('aria-label',available?`Jump to ${clockTime(span.jumpSecond)} in the current edition`:
        `Passage at ${clockTime(span.jumpSecond)} is not ready to jump`);
    }
  }
  function renderPage(){
    const spans=result.comparison.spans,pages=Math.max(1,Math.ceil(spans.length/PAGE_SIZE));
    page=Math.min(Math.max(0,page),pages-1);
    const start=page*PAGE_SIZE;
    const times=range=>range[1]>range[0]?`${clockTime(range[0])}–${clockTime(range[1])}`:'No timed span';
    const items=spans.slice(start,start+PAGE_SIZE).map((span,i)=>`<li data-atlas-kind="${span.kind}">
      <div><strong>${labels[span.kind]}</strong><span>Saved ${times(span.first)} · Current ${times(span.second)}</span></div>
      ${Number.isFinite(span.jumpSecond)?`<button class="player-control" type="button" data-atlas-jump="${start+i}">Jump in current edition</button>`:''}
    </li>`);
    updateHTML(list,items.join(''));
    pager.hidden=pages<2;
    previous.setAttribute('aria-disabled',String(page===0));
    next.setAttribute('aria-disabled',String(page===pages-1));
    setText(pageLabel,`Page ${page+1} of ${pages}`);
    refreshJumps();
  }

  primary.addEventListener('click',async()=>{
    const context=getContext();
    if(working||!allowed(context))return;
    working=true;resetResult();
    feedback=saved?'Matching dialogue across both tracks…':'Reading this edition’s subtitle track…';
    refresh();
    await frame();
    try{
      const current=getContext();
      if(!host.open||parent&&!parent.open||!sameCapture(current,context)||!allowed(current))return;
      const captured=captureEdition({...current,label:displayLabel(current.label),originalTimes:current.originalTimes()});
      if(!captured){feedback='This track does not have enough usable dialogue to save.';return;}
      if(!saved){saved=captured;feedback='Edition saved. Open a different release of this title in My Library.';return;}
      const comparison=compareEditions(saved,captured);
      if(comparison.status!=='ready'){feedback=issues[comparison.status]||issues.insufficient;return;}
      present(captured,comparison,current);
      feedback='Comparison ready. Show passage timings to explore the evidence.';
    }finally{
      working=false;refresh();
    }
  });
  clear.addEventListener('click',()=>{
    if(working)return;
    resetResult();saved=null;feedback='Saved edition cleared.';
    primary.focus({preventScroll:true});refresh();
  });
  list.addEventListener('click',async event=>{
    const button=event.target.closest('[data-atlas-jump]');
    if(!button||!result||seeking)return;
    const current=result,target=current.comparison.spans[Number(button.dataset.atlasJump)]?.jumpSecond;
    if(!sameCapture(current.context,getContext())||!Number.isFinite(target)||!canSeek(target)){refresh();return;}
    seeking=true;refreshJumps();
    let moved=false;
    try{moved=await seek(target,current.context.track);}catch{}
    if(result!==current||!sameCapture(current.context,getContext()))return;
    seeking=false;
    feedback=moved?'Jumped to '+clockTime(target)+' in the current edition.':'That passage is unavailable for playback.';
    refresh();
  });
  previous.addEventListener('click',()=>{if(result&&page>0){page--;renderPage();}});
  next.addEventListener('click',()=>{if(result&&(page+1)*PAGE_SIZE<result.comparison.spans.length){page++;renderPage();}});
  host.addEventListener('toggle',()=>refresh());
  timings.addEventListener('toggle',()=>refresh());
  parent?.addEventListener('toggle',()=>refresh());
  return {refresh};
}

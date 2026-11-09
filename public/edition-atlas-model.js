const MAX_CUES=8000;
const MAX_WORDS=48000;
const MAX_SPANS=64;
const MAX_DURATION=24*60*60;
const PHRASE_WORDS=6;
const MAX_CUE_GAP=1.5;
const MAX_SHARED_SPAN=65;
const MAX_DIFFERENCE_SPAN=90;
const MIN_DIFFERENCE=6;
const snapshots=new WeakMap();

function dialogueWords(value){
  return String(value??'').slice(0,900).normalize('NFKC').toLowerCase()
    .replace(/<[^>]*>|\[[^\]]*\]|\{[^}]*\}|&(?:nbsp|amp|lt|gt|quot);/gi,' ')
    .replace(/[’']/g,'').match(/[\p{L}\p{N}]+/gu)||[];
}
function safeId(value){
  return typeof value==='string'&&value.length>0&&value.length<=256&&!/[\p{Cc}\p{Cf}\\/]/u.test(value);
}
const knownDuration=value=>Number.isFinite(value)&&value>0&&value<=MAX_DURATION?value:null;
const validTimes=(start,end)=>Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=MAX_DURATION;
const rounded=value=>Math.round(value*100)/100;

export function captureEdition({identity,fileKey,label,duration,sessionId,track,offset=0,cues,originalTimes}={}){
  if(![identity,fileKey,sessionId].every(safeId)||!Number.isSafeInteger(track)||track<0||
    !Number.isFinite(offset)||Math.abs(offset)>3600||!Array.isArray(cues))return null;
  const length=knownDuration(duration),rows=[],raw=[];
  let wordsSeen=0;
  for(let index=0;index<Math.min(MAX_CUES,cues.length);index++){
    const cue=cues[index];
    if(!validTimes(cue?.startTime,cue?.endTime))continue;
    const words=dialogueWords(cue.text);
    if(!words.length)continue;
    wordsSeen+=words.length;
    if(wordsSeen>MAX_WORDS)break;
    const source=originalTimes?.[index];
    const supplied=Array.isArray(source)&&validTimes(source[0],source[1]);
    const clipped=offset<0&&cue.startTime===0;
    const original=supplied?source:!clipped?[cue.startTime-offset,cue.endTime-offset]:[];
    raw.push({
      text:words.join(' '),
      times:validTimes(original[0],original[1])?original.slice(0,2).map(rounded):null
    });
    const end=Math.min(length??MAX_DURATION,cue.endTime);
    if(end>cue.startTime)rows.push({start:cue.startTime,end,words});
  }
  if(!rows.length)return null;
  rows.sort((a,b)=>a.start-b.start||a.end-b.end);
  const fileLabel=typeof label==='string'?label.split(/[\\/]/).at(-1).replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,160):'';
  const edition=Object.freeze({
    identity,fileKey,label:fileLabel||'Edition',duration:length,sessionId,track,offset
  });
  snapshots.set(edition,{rows,raw});
  return edition;
}

function duplicateTrack(first,second){
  if(first.length!==second.length)return false;
  let equalTimes=0;
  for(let index=0;index<first.length;index++){
    const a=first[index],b=second[index];
    if(a.text!==b.text)return false;
    if(!a.times||!b.times)continue;
    if(a.times[0]!==b.times[0]||a.times[1]!==b.times[1])return false;
    equalTimes++;
  }
  return equalTimes>=Math.min(2,first.length);
}

function phraseIndex(rows){
  const tokens=[],windows=new Map(),cueKeys=rows.map(()=>[]);
  let block=0,previousEnd=-Infinity;
  for(const [cue,row] of rows.entries()){
    if(row.start>previousEnd+MAX_CUE_GAP)block++;
    for(const [index,word] of row.words.entries())tokens.push({word,cue,head:index===0,block});
    previousEnd=Math.max(previousEnd,row.end);
  }
  for(let index=0;index<=tokens.length-PHRASE_WORDS;index++){
    const start=tokens[index],end=tokens[index+PHRASE_WORDS-1];
    if(start.block!==end.block||rows[end.cue].start-rows[start.cue].start>6)continue;
    const words=tokens.slice(index,index+PHRASE_WORDS).map(token=>token.word);
    const phrase=words.join(' ');
    if(phrase.length<24||new Set(words).size<4)continue;
    windows.set(phrase,windows.has(phrase)?null:start);
    if(start.cue===end.cue)cueKeys[start.cue].push(phrase);
  }
  return {windows,cueKeys};
}

function orderedAnchors(first,second,rowsA,rowsB){
  const candidates=[];
  for(const [phrase,a] of first.windows){
    const b=second.windows.get(phrase);
    // Both starts are actual cue boundaries. A split cue may still supply
    // the phrase through adjacent lines, but an interior word has no clock.
    if(a?.head&&b?.head)candidates.push({a:rowsA[a.cue].start,b:rowsB[b.cue].start});
  }
  candidates.sort((a,b)=>a.a-b.a||a.b-b.b);
  const laterMinimum=[];
  let minimum=Infinity;
  for(let index=candidates.length-1;index>=0;index--){
    laterMinimum[index]=minimum;
    minimum=Math.min(minimum,candidates[index].b);
  }
  let earlierMaximum=-Infinity;
  const anchors=[],conflicts=[];
  for(const [index,point] of candidates.entries()){
    const sameFirst=candidates[index-1]?.a===point.a||candidates[index+1]?.a===point.a;
    const ordered=!sameFirst&&point.b>earlierMaximum&&point.b<laterMinimum[index];
    (ordered?anchors:conflicts).push(point);
    earlierMaximum=Math.max(earlierMaximum,point.b);
  }
  return {anchors,conflicts};
}

function unmatchedRows(rows,keys,other){
  return rows.flatMap((row,index)=>keys[index].length&&keys[index].every(key=>!other.has(key))?
    [{time:row.start,text:row.words.join(' ')}]:[]);
}

function after(items,time){
  let low=0,high=items.length;
  while(low<high){
    const middle=Math.floor((low+high)/2);
    if(items[middle].time<=time)low=middle+1;
    else high=middle;
  }
  return low;
}
function interior(items,start,end){
  return items.slice(after(items,start),after(items,end)).filter(item=>item.time<end);
}
function substantive(rows){
  return rows.length>=2&&rows.at(-1).time-rows[0].time>=1.5&&new Set(rows.map(row=>row.text)).size>=2;
}
function comparisonInterval(left,right,evidence){
  const first=[left.a,right.a],second=[left.b,right.b];
  const lengthA=right.a-left.a,lengthB=right.b-left.b,difference=lengthB-lengthA;
  const conflict=interior(evidence.conflictsA,left.a,right.a).length||interior(evidence.conflictsB,left.b,right.b).length;
  const onlyA=interior(evidence.onlyA,left.a,right.a),onlyB=interior(evidence.onlyB,left.b,right.b);
  const mismatchA=substantive(onlyA),mismatchB=substantive(onlyB);
  const coherent=Math.min(lengthA,lengthB)>=1.5&&Math.max(lengthA,lengthB)<=MAX_SHARED_SPAN&&
    Math.abs(difference)<=Math.max(.75,Math.min(1.5,Math.min(lengthA,lengthB)*.04));
  if(!conflict&&coherent&&!mismatchA&&!mismatchB)return {
    span:{kind:'shared',first,second,jumpSecond:left.b,offset:rounded(((left.b-left.a)+(right.b-right.a))/2)}
  };
  const differenceKind=!conflict&&Math.max(lengthA,lengthB)<=MAX_DIFFERENCE_SPAN&&
    (difference>=MIN_DIFFERENCE&&mismatchB&&!onlyA.length?'second-only':
      difference<=-MIN_DIFFERENCE&&mismatchA&&!onlyB.length?'first-only':null);
  return {span:{kind:'uncertain',first,second},differenceKind};
}

function appendSpan(spans,span){
  const previous=spans.at(-1);
  const mergeable=previous?.kind===span.kind&&(span.kind==='uncertain'||
    span.kind==='shared'&&Math.abs(previous.offset-span.offset)<=.6&&
      Math.abs((span.second[1]-span.first[1])-(previous.second[0]-previous.first[0]))<=1);
  if(!mergeable){spans.push(span);return;}
  previous.first[1]=span.first[1];
  previous.second[1]=span.second[1];
  if(span.kind==='shared')previous.offset=rounded(((previous.second[0]-previous.first[0])+
    (previous.second[1]-previous.first[1]))/2);
}
const endOf=(edition,rows)=>edition.duration??rows.reduce((end,row)=>Math.max(end,row.end),0);

export function compareEditions(first,second){
  const a=snapshots.get(first),b=snapshots.get(second);
  if(!a||!b)return {status:'insufficient'};
  if(first.fileKey===second.fileKey||first.sessionId===second.sessionId)return {status:'same-file'};
  if(first.identity!==second.identity)return {status:'wrong-title'};
  if(duplicateTrack(a.raw,b.raw))return {status:'duplicate-track'};
  const phrasesA=phraseIndex(a.rows),phrasesB=phraseIndex(b.rows);
  const {anchors,conflicts}=orderedAnchors(phrasesA,phrasesB,a.rows,b.rows);
  if(anchors.length<3)return {status:'insufficient'};
  const evidence={
    conflictsA:conflicts.map(point=>({time:point.a})),
    conflictsB:conflicts.map(point=>({time:point.b})).sort((left,right)=>left.time-right.time),
    onlyA:unmatchedRows(a.rows,phrasesA.cueKeys,phrasesB.windows),
    onlyB:unmatchedRows(b.rows,phrasesB.cueKeys,phrasesA.windows)
  };
  const intervals=anchors.slice(1).map((point,index)=>comparisonInterval(anchors[index],point,evidence));
  if(!intervals.some(({span})=>span.kind==='shared'))return {status:'insufficient'};
  const spans=[];
  const start=anchors[0];
  if(start.a>0||start.b>0)appendSpan(spans,{kind:'uncertain',first:[0,start.a],second:[0,start.b]});
  for(const [index,{span,differenceKind}] of intervals.entries()){
    // A longer section alone cannot distinguish edits from sparse or different
    // captions. Require shared intervals directly before and after the bracket.
    if(differenceKind&&intervals[index-1]?.span.kind==='shared'&&intervals[index+1]?.span.kind==='shared')
      appendSpan(spans,{...span,kind:differenceKind});
    else appendSpan(spans,span);
  }
  const last=anchors.at(-1),endA=endOf(first,a.rows),endB=endOf(second,b.rows);
  if(endA>last.a||endB>last.b)appendSpan(spans,{kind:'uncertain',first:[last.a,endA],second:[last.b,endB]});
  if(spans.length>MAX_SPANS){
    const start=spans[MAX_SPANS-1],end=spans.at(-1);
    spans.splice(MAX_SPANS-1,spans.length,{kind:'uncertain',
      first:[start.first[0],end.first[1]],second:[start.second[0],end.second[1]]});
  }
  const counts={shared:0,firstOnly:0,secondOnly:0,uncertain:0};
  const countKey={'first-only':'firstOnly','second-only':'secondOnly'};
  for(const {kind} of spans)counts[countKey[kind]||kind]++;
  return {status:'ready',counts,spans};
}

const MIN_OBSERVATION_MS=12000;
const WINDOW_MS=16000;
const SAMPLE_INTERVAL_MS=1500;
const MIN_SLOPE_INTERVAL_MS=6000;
const MAX_CLOCK_GAP_MS=6500;
const MAX_ESTIMATE_SECONDS=60;
const MAX_ESTIMATE_WIDTH_SECONDS=30;
const EDGE_TOLERANCE=.05;

function contiguousAt(ranges,position,duration){
  const limit=Number.isFinite(duration)&&duration>0?duration:Infinity;
  const valid=(Array.isArray(ranges)?ranges:[])
    .filter(range=>Array.isArray(range)&&Number.isFinite(range[0])&&Number.isFinite(range[1]))
    .map(([start,end])=>[Math.max(0,start),Math.min(limit,end)])
    .filter(([start,end])=>end>start)
    .sort((a,b)=>a[0]-b[0]);
  let interval=null;
  for(const [start,end] of valid){
    if(interval&&start<=interval[1]){
      interval[1]=Math.max(interval[1],end);
      continue;
    }
    if(interval&&interval[1]>position)break;
    interval=[start,end];
  }
  const contains=interval&&position>=interval[0]&&position<interval[1];
  return {interval:contains?interval:null,known:valid.length>0};
}

function isDiscontinuous(previous,current){
  const elapsed=current.now-previous.now;
  const advance=current.position-previous.position;
  const expected=current.rate*elapsed/1000;
  return current.key!==previous.key||current.rate!==previous.rate||elapsed<0||elapsed>MAX_CLOCK_GAP_MS||
    advance<-.15||advance>expected+.8+expected*.12||
    elapsed>=2000&&advance<expected-1.25||
    Math.abs(current.start-previous.start)>EDGE_TOLERANCE||current.edge<previous.edge-EDGE_TOLERANCE;
}

function growthBand(points,cadence){
  let low=Infinity,high=0;
  const span=points.at(-1).now-points[0].now;
  const base=Math.min(MIN_OBSERVATION_MS,Math.max(MIN_SLOPE_INTERVAL_MS,span*.6));
  const minimum=Math.min(span,Math.max(base,Math.min(14000,(cadence??0)*1.75)));
  // As observations accumulate, use wider windows to average segment batches.
  // Keep the extremes so mixed rates cannot produce a confident warning.
  for(let right=1;right<points.length;right++){
    for(let left=0;left<right;left++){
      const elapsed=points[right].now-points[left].now;
      if(elapsed<minimum)continue;
      const growth=Math.max(0,points[right].edge-points[left].edge)*1000/elapsed;
      low=Math.min(low,growth);
      high=Math.max(high,growth);
    }
  }
  return {low,high};
}

export function createPlaybackRunway(){
  let previous=null,points=[],lastGrowthAt=null,lastGrowthGap=null;

  function reset(){
    previous=null;
    points=[];
    lastGrowthAt=lastGrowthGap=null;
  }

  function observe(sample={}){
    const {now,key,mode,position,playbackRate:rate,phase='idle',buffered,manifest,duration,visible}=sample;
    const complete=sample.complete===true;
    const validPosition=Number.isFinite(position)&&position>=0;
    const hasMedia=validPosition&&['hls','direct'].includes(mode);
    const buffer=hasMedia?contiguousAt(buffered,position,duration).interval:null;
    const published=validPosition&&mode==='hls'?contiguousAt(manifest,position,duration):null;
    const prepared=published?.interval;
    const result={
      phase,complete,
      bufferedAhead:hasMedia&&Array.isArray(buffered)?buffer?buffer[1]-position:0:null,
      preparedAhead:published?.known?prepared?prepared[1]-position:0:null,
      trend:'unavailable',estimate:null
    };

    if(!prepared||mode!=='hls'||complete||visible!==true||phase!=='playing'||
      key===null||key===undefined||key===''||!Number.isFinite(now)||!Number.isFinite(rate)||rate<=0||
      Number.isFinite(duration)&&duration>0&&prepared[1]>=duration-EDGE_TOLERANCE){
      reset();
      return result;
    }

    const current={now,key,rate,position,start:prepared[0],edge:prepared[1]};
    if(previous&&isDiscontinuous(previous,current))reset();
    if(previous&&current.edge-previous.edge>.25){
      lastGrowthGap=lastGrowthAt===null?null:now-lastGrowthAt;
      lastGrowthAt=now;
    }
    previous=current;
    if(!points.length||now-points.at(-1).now>=SAMPLE_INTERVAL_MS)points.push(current);
    points=points.filter(point=>now-point.now<=WINDOW_MS).slice(-20);
    result.trend='collecting';
    if(points.length<4||points.at(-1).now-points[0].now<MIN_OBSERVATION_MS)return result;

    const elapsed=(now-points[0].now)/1000;
    const expected=elapsed*rate;
    if(Math.abs(position-points[0].position-expected)>Math.max(1.25,expected*.15)){
      points=[current];
      return result;
    }

    const analysis=points.at(-1).now<now?[...points,current]:points;
    const {low,high}=growthBand(analysis,lastGrowthGap);
    const caution=Math.max(.035,rate*.03);
    const upper=high+caution;
    if(low>=rate*.995){
      result.trend='steady';
      return result;
    }
    result.trend='uncertain';
    // A known long batch cycle can leave the short observation window flat.
    if(lastGrowthGap>=MIN_OBSERVATION_MS&&now-lastGrowthAt<Math.min(45000,lastGrowthGap*1.25))return result;
    if(upper>=rate-Math.max(.05,rate*.07))return result;

    const earliest=result.preparedAhead/(rate-Math.max(0,low-caution));
    const latest=result.preparedAhead/(rate-upper);
    if(latest>MAX_ESTIMATE_SECONDS||latest-earliest>MAX_ESTIMATE_WIDTH_SECONDS)return result;
    result.trend='draining';
    result.estimate={earliest,latest};
    return result;
  }

  return {observe,reset};
}

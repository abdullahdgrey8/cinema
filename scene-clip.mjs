import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';

const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_BYTES = 512 * 1024;
const MAX_PACKETS = 1600;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_REQUESTS = 32;
const half = {n:1n,d:2n};
const tick = {n:1n,d:1000n};
const abs = n => n < 0n ? -n : n;

function requireProof(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason),{code:'scene-unverified'});
}
function gcd(a,b) {
  while (b) [a,b] = [b,a%b];
  return abs(a);
}
function fraction(n,d) {
  requireProof(d>0n,'Invalid packet clock');
  const common = gcd(n,d);
  return {n:n/common,d:d/common};
}
const compare = (a,b) => a.n*b.d-b.n*a.d;
const equal = (a,b) => compare(a,b)===0n;
const add = (a,b) => fraction(a.n*b.d+b.n*a.d,a.d*b.d);
const subtract = (a,b) => fraction(a.n*b.d-b.n*a.d,a.d*b.d);
const ticks = (n,clock) => fraction(n*clock.n,clock.d);
const seconds = value => Number(value.n)/Number(value.d);

function integer(value) {
  if (Number.isSafeInteger(value)) return BigInt(value);
  requireProof(typeof value==='string' && /^-?\d{1,16}$/.test(value),'Invalid packet integer');
  return BigInt(value);
}

function streamClock(value) {
  const parts = typeof value==='string' && /^(\d{1,9})\/(\d{1,10})$/.exec(value);
  requireProof(parts && BigInt(parts[1])>0n,'Invalid output clock');
  return fraction(BigInt(parts[1]),BigInt(parts[2]));
}

function sourcePackets(track,read) {
  const timebase = fraction(1n,integer(track.timescale));
  let previous;
  return track.samples.map(sample=>{
    requireProof(!previous||(sample.number===previous.number+1&&
      sample.decodeTime===previous.decodeTime+previous.duration),'Source packets are not consecutive');
    const body = read(sample.start,sample.end);
    requireProof(Buffer.isBuffer(body)&&body.length===sample.end-sample.start&&body.length>0,'Incomplete packet bytes');
    const duration = ticks(integer(sample.duration),timebase);
    const pts = sample.presentationTime;
    requireProof(duration.n>0n&&equal(add(pts,duration),sample.presentationEnd),'Invalid source packet duration');
    const dts = add(pts,ticks(integer(sample.decodeTime)-integer(sample.compositionTime),timebase));
    previous = sample;
    return {pts,dts,duration,size:body.length,hash:'SHA256:'+createHash('sha256').update(body).digest('hex')};
  });
}

function outputPacket(packet,timebase,terminalAudio) {
  const size = Number(integer(packet.size));
  let duration = ticks(integer(packet.duration),timebase);
  if (terminalAudio && typeof packet.pos==='string' && Number(packet.pos)===terminalAudio.start &&
      terminalAudio.end-terminalAudio.start===size) {
    // Older bundled FFprobe can use the end of the track edit for this final
    // packet. Its exact byte position binds the independent stts duration.
    duration = fraction(integer(terminalAudio.duration),integer(terminalAudio.timescale));
  }
  requireProof(size>0&&duration.n>0n&&typeof packet.data_hash==='string','Invalid output packet');
  return {size,duration,pts:ticks(integer(packet.pts),timebase),dts:ticks(integer(packet.dts),timebase),hash:packet.data_hash};
}

function matches(source,packet,origin) {
  return source.size===packet.size && source.hash===packet.hash && equal(source.duration,packet.duration) &&
    equal(subtract(source.pts,origin),packet.pts) && equal(subtract(source.dts,origin),packet.dts);
}

function covers(packets,start,end) {
  let cursor = start;
  for (const packet of [...packets].sort((a,b)=>Math.sign(seconds(subtract(a.pts,b.pts))))) {
    const right = add(packet.pts,packet.duration);
    if (compare(right,cursor)<=0n) continue;
    if (compare(packet.pts,cursor)>0n) return false;
    cursor = right;
    if (compare(cursor,end)>=0n) return true;
  }
  return false;
}

export function verifyScenePackets({probe,scene,read,targetMs,terminalAudio}) {
  const streams = probe?.streams;
  requireProof(Array.isArray(streams)&&streams.length===2&&streams[0].index===0&&streams[1].index===1&&
    streams[0].codec_type==='video'&&streams[0].codec_name==='h264'&&
    streams[1].codec_type==='audio'&&streams[1].codec_name==='aac','Unexpected output streams');
  requireProof(Array.isArray(probe.packets)&&probe.packets.length<=MAX_PACKETS,'Too many output packets');
  const byStream = [[],[]];
  for (const packet of probe.packets) {
    requireProof(packet.stream_index===0||packet.stream_index===1,'Unexpected output packet stream');
    byStream[packet.stream_index].push(packet);
  }
  requireProof(byStream.every(packets=>packets.length)&&scene.keyframe.sync&&
    scene.keyframe.number===scene.video.samples[0].number&&byStream[0][0].flags?.includes('K'),'Output does not start at the selected keyframe');
  const clocks = streams.map(stream=>streamClock(stream.time_base));
  const output = byStream.map((packets,stream)=>packets.map((packet,index)=>outputPacket(packet,clocks[stream],
    stream===1&&index===packets.length-1 ? terminalAudio : null)));
  const source = [sourcePackets(scene.video,read),sourcePackets(scene.audio,read)];
  const videoOrigin = subtract(source[0][0].pts,output[0][0].pts);
  const widest = compare(clocks[0],clocks[1])>0n ? clocks[0] : clocks[1];
  const tolerance = compare(widest,tick)<0n ? widest : tick;
  let audioAnchor;
  for (const [index,sample] of source[1].entries()) {
    const origin = subtract(sample.pts,output[1][0].pts);
    const delta = subtract(origin,videoOrigin);
    if (abs(delta.n)*tolerance.d>tolerance.n*delta.d || !matches(sample,output[1][0],origin)) continue;
    requireProof(!audioAnchor,'Audio origin is ambiguous');
    audioAnchor = {index,origin};
  }
  requireProof(audioAnchor,'Audio does not match the exact verified clock');
  const origins = [videoOrigin,audioAnchor.origin];
  const start = fraction(integer(targetMs),1000n), end = add(start,half);
  for (const [stream,first] of [0,audioAnchor.index].entries()) {
    const selected = source[stream].slice(first,first+output[stream].length);
    requireProof(selected.length===output[stream].length&&selected.every((packet,index)=>
      matches(packet,output[stream][index],origins[stream])),'Output changed packet order, bytes or cadence');
    requireProof(covers(selected,start,end),'Output does not cover the selected scene');
  }
  const seekSeconds = seconds(subtract(start,videoOrigin));
  const duration = Number(streams[0].duration);
  requireProof(Number.isFinite(duration)&&seekSeconds>=0&&seekSeconds+.5<=duration,'Output duration does not cover the selected scene');
  return {seekSeconds,packetCount:probe.packets.length};
}

export function runSceneChild(exe,args,signal,{maxOutput=4096,allowDiagnostic=false}={}) {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child = spawn(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const buffers = [];
    let length = 0, errors = 0, failure;
    function stop(reason) {
      failure ??= reason;
      if (child.exitCode===null) child.kill();
    }
    function abort() { stop(signal.reason); }
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
    child.stdout.on('data',chunk=>{
      length += chunk.length;
      if (length>maxOutput) stop(Object.assign(new Error('Scene output exceeded its bound'),{code:'scene-limit'}));
      else if (!failure) buffers.push(chunk);
    });
    child.stderr.on('data',chunk=>{
      errors += chunk.length;
      if (errors>8192) stop(new Error('Scene media inspection failed'));
    });
    child.once('error',error=>{ failure ??= error; });
    child.once('close',code=>{
      signal.removeEventListener('abort',abort);
      if (failure || code!==0 || (errors&&!allowDiagnostic)) return reject(failure??new Error('Scene media inspection failed'));
      resolve(Buffer.concat(buffers,length));
    });
  });
}

async function privateInput(sourceSize,pieces,signal,action) {
  signal.throwIfAborted();
  const route = '/'+randomBytes(24).toString('hex')+'.mp4';
  let requests = 0, bytes = 0, missing = false;
  const server = http.createServer((req,res)=>{
    if (signal.aborted||req.method!=='GET'||req.url!==route||++requests>MAX_REQUESTS) {
      res.writeHead(404,{'Connection':'close'}).end();
      return;
    }
    try {
      const range = /^bytes=(\d{1,12})-(\d{0,12})$/.exec(req.headers.range||'bytes=0-');
      const start = range ? Number(range[1]) : sourceSize;
      const explicitEnd = range?.[2] ? Number(range[2])+1 : null;
      const available = start<sourceSize ? pieces.availableEnd(start) : start;
      const end = explicitEnd??available;
      if (start>=end||end>available||bytes+end-start>MAX_INPUT_BYTES) {
        missing ||= start>=available||end>available;
        res.writeHead(416,{'Connection':'close'}).end();
        return;
      }
      const body = pieces.slice(start,end);
      bytes += body.length;
      res.writeHead(206,{'Connection':'close','Content-Type':'video/mp4','Accept-Ranges':'bytes',
        'Content-Range':`bytes ${start}-${end-1}/${sourceSize}`,'Content-Length':body.length});
      res.end(body);
    } catch {
      missing = true;
      res.writeHead(416,{'Connection':'close'}).end();
    }
  });
  const disconnect = () => server.closeAllConnections();
  signal.addEventListener('abort',disconnect,{once:true});
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    signal.throwIfAborted();
    try {
      return await action('http://127.0.0.1:'+server.address().port+route);
    } catch (error) {
      if (missing && !signal.aborted) throw Object.assign(new Error('The scene is missing verified bytes'),{code:'scene-missing'});
      throw error;
    }
  } finally {
    signal.removeEventListener('abort',disconnect);
    const closed = new Promise(resolve=>server.close(()=>resolve()));
    disconnect();
    await closed;
  }
}

export async function buildSceneClip({scene,pieces,sourceSize,targetMs,folder,signal,copySignal=signal,probeMs=3000}) {
  const {isH264IdrSample,parseSceneMovie} = await import('./scene-mp4-index.mjs');
  const key = scene.keyframe;
  requireProof(isH264IdrSample(pieces.slice(key.start,key.end)),'The selected keyframe is not an IDR');
  const keySeconds = seconds(key.presentationTime);
  const inputSeek = keySeconds+.001, duration = targetMs/1000+1.5-inputSeek;
  const commonClock = [scene.video.timescale,scene.audio.timescale].map(integer)
    .reduce((previous,clock)=>previous/gcd(previous,clock)*clock,1000n);
  requireProof(inputSeek>=0&&duration>=1.49&&duration<=8&&commonClock<=1_000_000_000n,'The scene has no bounded copy window');
  const filename = path.join(folder,'preview.mp4');
  await privateInput(sourceSize,pieces,copySignal,url=>runSceneChild(ffmpeg,[
    '-nostdin','-v','error','-xerror','-n','-threads','1','-max_alloc','33554432',
    '-probesize','32768','-analyzeduration','100000','-protocol_whitelist','http,tcp','-f','mov',
    '-ss',inputSeek.toFixed(6),'-noaccurate_seek','-i',url,'-t',duration.toFixed(6),
    '-map','0:v:0','-map','0:a:0','-c','copy','-avoid_negative_ts','make_zero','-use_editlist','1',
    '-movie_timescale',String(commonClock),'-movflags','+faststart','-fs',String(MAX_CLIP_BYTES+1),filename,
  ],copySignal,{allowDiagnostic:true}));
  signal.throwIfAborted();
  const file = await stat(filename);
  requireProof(file.isFile()&&file.size>0&&file.size<=MAX_CLIP_BYTES,'The copied preview exceeds its bound');
  const bytes = await readFile(filename,{signal});
  requireProof(bytes.length===file.size,'The copied preview changed during inspection');
  const raw = await runSceneChild(ffprobe.path,[
    '-v','error','-protocol_whitelist','file','-show_packets','-show_streams','-show_data_hash','sha256',
    '-show_entries','stream=index,codec_type,codec_name,time_base,duration:packet=stream_index,dts,pts,duration,size,flags,pos,data_hash',
    '-of','json',filename,
  ],AbortSignal.any([signal,AbortSignal.timeout(probeMs)]),{maxOutput:MAX_PROBE_BYTES});
  const probe = JSON.parse(raw.toString('utf8'));
  const terminalAudio = parseSceneMovie(bytes,bytes.length).lastAudioSampleDuration;
  const proof = verifyScenePackets({probe,scene,read:pieces.slice,targetMs,terminalAudio});
  signal.throwIfAborted();
  return {...proof,bytes};
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {cinema,until} from './helpers.mjs';
import {installAudioDescriptionFixture,readFixtureTone} from './fixtures/audio-description-fixture.mjs';

const probeKey='CINEMA_DESCRIPTION_FFPROBE';
const suppliedProbe=process.env[probeKey];
const knownWindowsProbe='C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg/bin/ffprobe.exe';
const modernProbe=[suppliedProbe,process.platform==='win32'&&knownWindowsProbe]
  .find(candidate=>candidate&&path.isAbsolute(candidate)&&existsSync(candidate));
const withoutModern=modernProbe?false:'A trusted installed modern FFprobe was not available for this case';

async function configuredCinema(t,probePath){
  const previous=process.env[probeKey];
  process.env[probeKey]=probePath;
  t.after(()=>{
    if(previous===undefined)delete process.env[probeKey];
    else process.env[probeKey]=previous;
  });
  return cinema(t);
}

const playback=(c,f)=>c.api('/api/playback?hash='+f.hash+'&index='+f.index);
async function prepare(c,f){
  await c.api('/api/prepare',{hash:f.hash,index:f.index});
}
async function statusUntil(c,f,expect,description,timeout=12000){
  return until(async()=>{
    const state=await playback(c,f);
    assert.ok(!['error','unsupported'].includes(state.status),state.message);
    return expect(state)?state:false;
  },{timeout,interval:75,description});
}

async function manifest(c,url){
  const response=await c.request(url);
  assert.equal(response.status,200,url);
  assert.match(response.headers.get('content-type'),/application\/vnd\.apple\.mpegurl/);
  const text=await response.text();
  assert.match(text,/^#EXTM3U\b/);
  return text;
}
function assertAudioProjection(state,fixture){
  assert.equal(state.mode,'hls');
  assert.match(state.url,new RegExp('^/hls/'+fixture.hash+'-0/[a-f0-9]{12}/index\\.m3u8$'));
  assert.ok(state.audio,'A verified authored description should be admitted on the exact playback run');
  const directory=state.url.slice(0,-'index.m3u8'.length);
  assert.equal(state.audio.url,directory+'audio-master.m3u8');
  assert.equal(state.audio.original,directory+'audio-original.m3u8');
  assert.equal(state.audio.description,directory+'audio-description.m3u8');
  assert.ok(Number.isFinite(state.audio.originalDuration)&&state.audio.originalDuration>0);
  assert.ok(Number.isFinite(state.audio.descriptionDuration)&&state.audio.descriptionDuration>0);
  return directory;
}
async function assertRendition(c,url,filePattern,expectedTone,expectEnd){
  const playlist=await manifest(c,url);
  assert.equal(/#EXT-X-ENDLIST\b/.test(playlist),expectEnd,'ENDLIST follows verified source and rendition completion');
  const segments=playlist.trim().split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
  assert.ok(segments.length>0&&segments.every(line=>filePattern.test(line)));
  const segment=url.slice(0,url.lastIndexOf('/')+1)+segments[0];
  const response=await c.request(segment);
  assert.equal(response.status,200,segment);
  assert.match(response.headers.get('content-type'),/video\/mp2t/);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length>188&&bytes[0]===0x47);
  const saved=path.join(c.dir,'audible-'+expectedTone+'.ts');
  await fs.writeFile(saved,bytes);
  assert.equal(await readFixtureTone(saved),expectedTone,'Decoded routed samples must match the authored reference');
}

test('declared description publishes exact alternate URLs and decodes the genuine role', {skip:withoutModern},async t=>{
  const c=await configuredCinema(t,modernProbe);
  const packageVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
  assert.equal((await c.api('/api/session')).appVersion,packageVersion,'Runtime must report the installed package version');
  const f=await installAudioDescriptionFixture(c,{duration:16});
  await prepare(c,f);
  const done=await statusUntil(c,f,state=>state.status==='ready'&&state.complete,'a completed HLS copy');
  const directory=assertAudioProjection(done,f);
  const master=await manifest(c,done.audio.url);
  assert.match(master,/URI="audio-original\.m3u8"/);
  assert.match(master,/URI="audio-description\.m3u8"/);
  assert.match(master,/CHARACTERISTICS="public\.accessibility\.describes-video"/);
  assert.match(master,/(?:^|\n)index\.m3u8(?:\r?\n|$)/);
  assert.doesNotMatch(master,/English AD|English alternate|https?:/);
  await assertRendition(c,done.url,/^seg\d{6}\.ts$/,440,true);
  await assertRendition(c,done.audio.original,/^audio-original-\d{6}\.ts$/,440,true);
  await assertRendition(c,done.audio.description,/^audio-description-\d{6}\.ts$/,880,true);

  const wrongRun=directory.replace(/\/([a-f0-9])([a-f0-9]{11})\/$/,(_all,first,rest)=>'/'+(first==='a'?'b':'a')+rest+'/');
  assert.notEqual(wrongRun,directory);
  assert.equal((await c.request(wrongRun+'audio-master.m3u8')).status,404);
  assert.equal((await c.request(wrongRun+'audio-description-000000.ts')).status,404);
  assert.equal((await c.request(directory+'audio-description-000000.ts.tmp')).status,404);

  await c.restart();
  await prepare(c,f);
  const restored=await statusUntil(c,f,state=>state.status==='ready'&&state.complete,'restoring the existing copy');
  assert.equal(restored.url,done.url);
  assert.equal(assertAudioProjection(restored,f),directory);
  assert.equal(restored.audio.description,done.audio.description);
  await assertRendition(c,restored.audio.description,/^audio-description-\d{6}\.ts$/,880,true);
  const stamp=await fs.stat(f.file);
  await fs.utimes(f.file,stamp.atime,new Date(stamp.mtimeMs+2000));
  await c.restart();
  await prepare(c,f);
  const changed=await statusUntil(c,f,state=>state.status==='ready'&&state.complete,'ordinary restoration after backing stamp changes');
  assert.equal(changed.url,done.url);
  assert.equal(changed.audio??null,null);
  assert.equal((await c.request(restored.audio.url)).status,404);
});

test('verified partial media offers its available audio and finishes the same run when pieces arrive', {skip:withoutModern},async t=>{
  const c=await configuredCinema(t,modernProbe);
  const f=await installAudioDescriptionFixture(c,{partial:true});
  assert.ok(f.progress>0&&f.progress<.5);
  await prepare(c,f);
  const opening=await statusUntil(c,f,state=>state.status==='ready'&&state.audio,'available alternate renditions while physical bytes are withheld');
  assertAudioProjection(opening,f);
  assert.equal(opening.complete,false);
  assert.ok(opening.progress<.5);
  assert.ok(opening.audio.descriptionDuration<opening.duration);
  await assertRendition(c,opening.url,/^seg\d{6}\.ts$/,440,false);
  await assertRendition(c,opening.audio.description,/^audio-description-\d{6}\.ts$/,880,false);

  assert.equal((await f.complete()).progress,1);
  const done=await statusUntil(c,f,state=>state.status==='ready'&&state.complete&&state.audio,'the same run to finish after real piece writes',16000);
  assertAudioProjection(done,f);
  assert.equal(done.sessionId,opening.sessionId);
  assert.equal(done.url,opening.url);
  assert.equal(done.audio.url,opening.audio.url);
  assert.ok(done.audio.descriptionDuration>opening.audio.descriptionDuration);
  await assertRendition(c,done.audio.original,/^audio-original-\d{6}\.ts$/,440,true);
  await assertRendition(c,done.audio.description,/^audio-description-\d{6}\.ts$/,880,true);
});

test('ineligible audio keeps the canonical player and never exposes description routes',async t=>{
  const cases=[
    {name:'title-only AD is not authored description',variant:'decoy',probe:modernProbe||'',tone:440},
    {name:'reordered default cannot silently change ordinary audio',variant:'reordered',probe:modernProbe||'',tone:660},
    {name:'optional probe explicitly absent',variant:'declared',probe:'',tone:440},
    {name:'optional probe process fails',variant:'declared',probe:process.execPath,tone:440},
  ];
  for(const row of cases)await t.test(row.name,async inner=>{
    const c=await configuredCinema(inner,row.probe);
    const f=await installAudioDescriptionFixture(c,{variant:row.variant,duration:12});
    await prepare(c,f);
    const done=await statusUntil(c,f,state=>state.status==='ready'&&state.complete,'ordinary HLS to finish without an alternate');
    assert.equal(done.audio??null,null);
    assert.equal(done.mode,'hls');
    assert.match(done.url,/\/index\.m3u8$/);
    const directory=done.url.slice(0,-'index.m3u8'.length);
    assert.equal((await c.request(directory+'audio-master.m3u8')).status,404);
    assert.equal((await c.request(directory+'audio-description.m3u8')).status,404);
    await assertRendition(c,done.url,/^seg\d{6}\.ts$/,row.tone,true);
  });
});

test('a description writer failure keeps the exact canonical video and withdraws the alternate', {skip:withoutModern},async t=>{
  const c=await configuredCinema(t,modernProbe);
  const f=await installAudioDescriptionFixture(c,{partial:true});
  await prepare(c,f);
  const opening=await statusUntil(c,f,state=>state.status==='ready'&&state.audio,'an admitted description before failure');
  const directory=assertAudioProjection(opening,f),run=directory.split('/').at(-2);
  const folder=path.join(c.dir,'hls',f.hash+'-'+f.index,run);
  const published=await fs.readdir(folder);
  const last=Math.max(-1,...published.filter(name=>/^audio-description-\d{6}\.ts$/.test(name))
    .map(name=>Number(name.match(/\d+/)[0])));
  assert.ok(last>=0,'the description actually published before the write failure');
  for(let i=last+1;i<30;i++)await fs.mkdir(path.join(folder,'audio-description-'+String(i).padStart(6,'0')+'.ts.tmp'));
  await f.complete();
  const done=await statusUntil(c,f,state=>state.status==='ready'&&state.complete&&!state.audio,'canonical completion after alternate failure',16000);
  assert.equal(done.url,opening.url);
  assert.equal(done.sessionId,opening.sessionId);
  assert.equal((await c.request(opening.audio.url)).status,404);
  await assertRendition(c,done.url,/^seg\d{6}\.ts$/,440,true);
});

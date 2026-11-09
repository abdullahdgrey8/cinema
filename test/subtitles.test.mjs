import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createSubtitles,toWebVtt,subtitleFromZip} from '../subtitles.mjs';

const SRT='1\n00:00:01,250 --> 00:00:02,900\n<b>Hello</b> &amp; goodbye.\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond caption.\n';
function zip(entries){
  const files=[],directory=[];let offset=0;
  for(const entry of entries){const name=Buffer.from(entry.name),data=Buffer.from(entry.text||SRT),compressed=deflateRawSync(data),head=Buffer.alloc(30),central=Buffer.alloc(46);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(8,8);head.writeUInt32LE(compressed.length,18);head.writeUInt32LE(entry.size??data.length,22);head.writeUInt16LE(name.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(entry.size??data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);files.push(head,name,compressed);directory.push(central,name);offset+=head.length+name.length+compressed.length;}
  const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...files,dir,end]);
}
async function service(t,fetchImpl){const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-subs-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(local)),path.resolve(os.tmpdir()));assert.ok(path.basename(local).startsWith('cinema-subs-'));await fs.rm(local,{recursive:true,force:true});});return {local,client:createSubtitles({local,fetchImpl})};}

test('SRT conversion preserves exact timing and renders caption markup as plain text',()=>{
  const {vtt,cues}=toWebVtt(SRT,'en.srt');assert.equal(cues,2);assert.match(vtt,/^WEBVTT\n\n/);assert.match(vtt,/00:00:01\.250 --> 00:00:02\.900\nHello &amp; goodbye\./);assert.doesNotMatch(vtt,/<b>/);
  assert.match(toWebVtt('00:01.2 --> 00:02.23\n&lt;safe&gt;','x.vtt').vtt,/00:00:01\.200 --> 00:00:02\.230\n&lt;safe&gt;/);
  assert.match(toWebVtt('00:00:0,500 --> 00:00:2,00\nCaption','x.srt').vtt,/00:00:00\.500 --> 00:00:02\.000/);
});
test('WebVTT cue settings are normalized and ASS dialogues preserve lines and commas',()=>{
  assert.equal(toWebVtt('WEBVTT\n\n00:01.000 --> 00:02.000 position:50%\nCaption','x.vtt').cues,1);
  const ass='[Script Info]\nTitle: Example\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.20,0:00:03.45,Default,,0,0,0,,{\\i1}Hello, friend\\NSecond line';
  const converted=toWebVtt(ass,'x.ass');assert.equal(converted.cues,1);assert.match(converted.vtt,/00:00:01\.200 --> 00:00:03\.450\nHello, friend\nSecond line/);assert.doesNotMatch(converted.vtt,/\\i1/);
});
test('invalid timestamps, HTML challenges, empty files and oversized content are rejected',()=>{
  for(const text of ['<html><body>Denied</body></html>','1\n00:00:03,000 --> 00:00:02,000\nBackwards','1\n00:60:01,000 --> 00:60:02,000\nInvalid','No captions','1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script>'])assert.throws(()=>toWebVtt(text));
  assert.throws(()=>toWebVtt('x'.repeat(2*1024*1024+1)),error=>error.status===413);
});
test('ZIP extraction accepts only bounded subtitle text and rejects unsafe archive paths and packs',()=>{
  assert.equal(subtitleFromZip(zip([{name:'captions/movie.en.srt'}])).text,SRT);
  assert.throws(()=>subtitleFromZip(zip([{name:'../escape.srt'}])),/Unsafe/);
  assert.throws(()=>subtitleFromZip(zip([{name:'C:\\escape.srt'}])),/Unsafe/);
  assert.throws(()=>subtitleFromZip(zip([{name:'huge.srt',size:20*1024*1024}])),/too large/);
  assert.throws(()=>subtitleFromZip(zip([{name:'one.srt'},{name:'two.srt'}])),/multiple subtitle files/);
  assert.throws(()=>subtitleFromZip(Buffer.from('Not a ZIP')),/supported subtitle ZIP/);
});
test('local imports remain readable across server instances and cannot escape subtitle storage',async t=>{
  const {client,local}=await service(t,async()=>{throw Error('Offline');});
  const imported=await client.import({name:'../English.srt',text:SRT});assert.equal(imported.name,'English.srt');assert.equal(imported.cues,2);assert.equal(imported.language,'en');assert.equal(imported.url,'/api/subtitles/file?id='+imported.id);
  assert.match(await createSubtitles({local}).get(imported.id),/^WEBVTT/);
  await assert.rejects(client.get('../../connection.json'),error=>error.status===404);
});
test('movie search exposes only English server-known results and downloads a validated ZIP',async t=>{
  const requests=[];const {client}=await service(t,async url=>{
    requests.push(String(url));const u=new URL(url);
    if(u.pathname==='/movies-N.html')return new Response('<a href="movie-12.html"><b>Nosferatu</b><div>1922</div><img src="images/flags/en.gif"></a>');
    if(u.pathname==='/tvshows.html')return new Response('<html>No matching shows</html>');
    if(u.pathname==='/movie-12.html')return new Response('<a href="/subtitle-44.html" title="Download english subtitles"><img src="images/flags/en.gif"><b>Nosferatu 1922 English subtitles (BluRay)</b></a><a href="/subtitle-45.html"><img src="images/flags/fr.gif"><b>French</b></a>');
    if(u.pathname==='/download-44.html')return new Response(zip([{name:'Nosferatu.en.srt'}]),{headers:{'Content-Type':'application/zip'}});
    throw Error('Unexpected provider URL '+u);
  });
  const found=await client.search({query:'Nosferatu 1922'});assert.equal(found.results.length,1);assert.equal(found.results[0].release,'BluRay');assert.equal(found.results[0].language,'en');assert.equal(found.warnings.length,0);
  const subtitle=await client.download({id:found.results[0].id});assert.equal(subtitle.cues,2);assert.match(await client.get(subtitle.id),/Hello/);
  const before=requests.length;await assert.rejects(client.download({id:'http://127.0.0.1/private'}),error=>error.status===404);assert.equal(requests.length,before);
});
test('TV search routes parsed season/episode and safely follows literal public download redirects',async t=>{
  const requests=[];const {client}=await service(t,async url=>{
    const u=new URL(url);requests.push(u.pathname);
    if(u.pathname==='/tvshows.html')return new Response([
      '<tr><td><a href="tvshow-22-1.html"><b>Sherlock</b></a></td><td>1</td><td>8</td><td>19</td><td>2025</td></tr>',
      '<tr><td><a href="tvshow-42-3.html"><b>Sherlock</b></a></td><td>4</td><td>12</td><td>130</td><td>2010-2017</td></tr>'
    ].join(''));
    if(u.pathname==='/tvshow-42-1.html')return new Response('<tr><td>1x01</td><td><a href="episode-100.html">First</a></td></tr><tr><td>1x02</td><td><a href="episode-101.html">Second</a></td></tr>');
    if(u.pathname==='/episode-101-en.html')return new Response('<a href="/subtitle-77.html"><h5><img src="images/flags/en.gif">Sherlock 1x02 (HDTV)</h5></a>');
    if(u.pathname==='/download-77.html')return new Response("<script>var s1='files/';var s2='Sherlock.en.zip';document.location=s1+s2;</script>");
    if(u.pathname==='/files/Sherlock.en.zip')return new Response(zip([{name:'episode.en.srt'}]));
    throw Error('Unexpected request '+u);
  });
  const found=await client.search({query:'Sherlock.S01E02.1080p',year:2010,kind:'tv'});assert.equal(found.results.length,1);assert.equal(found.providers.length,1);assert.ok(requests.includes('/episode-101-en.html'));assert.ok(!requests.includes('/episode-100-en.html'));assert.ok(!requests.includes('/tvshow-22-1.html'));
  assert.equal((await client.download({id:found.results[0].id})).cues,2);
});
test('provider outages and private redirects are reported honestly while local import still works',async t=>{
  let requests=0;const {client}=await service(t,async()=>{requests++;return new Response('',{status:302,headers:{Location:'http://127.0.0.1:8080/api/v2/torrents/info'}});});
  const found=await client.search({query:'Example S01E01'});assert.equal(found.results.length,0);assert.equal(found.providers[0].status,'unavailable');assert.equal(found.warnings.length,1);assert.equal(requests,1,'Private redirect must not be followed');
  assert.equal((await client.import({name:'offline.srt',text:SRT})).cues,2);
  await assert.rejects(client.search({query:'Example',language:'fr'}),/English/);
});
test('oversized and challenge responses are refused without claiming the provider has no subtitles',async t=>{
  const {client}=await service(t,async()=>new Response('<html>Verify you are human captcha</html>'));
  const blocked=await client.search({query:'Example S01E01'});assert.equal(blocked.providers[0].status,'unavailable');assert.match(blocked.warnings[0],/unavailable/);
  const oversized=createSubtitles({local:os.tmpdir(),fetchImpl:async()=>new Response('x',{headers:{'Content-Length':String(3*1024*1024)}})});
  assert.match((await oversized.search({query:'Example S01E01'})).warnings[0],/size limit/);
});

test('a movie search never serves a series and does not fall back to a title substring',async t=>{
  const requests=[];
  const {client}=await service(t,async url=>{
    requests.push(url.pathname);
    if(url.pathname==='/v1/movie/search')return Response.json({success:true,results:[
      {title:'Obsession',type:'tvseries',releaseYear:2026,link:'/series/obsession'},
      {title:'Obsession in the Night',type:'movie',releaseYear:2026,link:'/subtitles/obsession-in-the-night-2026'},
      {title:'Obsession',type:'movie',releaseYear:2019,link:'/subtitles/obsession-2019'}
    ]});
    if(url.pathname==='/movies-O.html')return new Response('<a href="movie-1.html"><b>Obsession in the Night</b><div>2026</div><img src="images/flags/en.gif"></a>');
    return new Response('<a href="/subtitle-21.html" title="English subtitles"><b>Wrong result</b></a>');
  });
  const found=await client.search({query:'Obsession',kind:'movies',year:2026});
  assert.deepEqual(found.results,[]);
  assert.deepEqual(requests,['/v1/movie/search','/movies-O.html']);
});

test('the public movie index verifies an adjacent catalog year and matches the correct English ZIP variant',async t=>{
  const hash='a'.repeat(64),paths=[];
  const {client}=await service(t,async(url,options)=>{
    paths.push(url.pathname);
    switch(url.pathname){
      case '/v1/movie/search':{
        assert.equal(options.method,'POST');
        assert.equal(options.redirect,'manual');
        assert.deepEqual(JSON.parse(options.body),{query:'Obsession',includeSeasons:false,limit:15});
        return Response.json({success:true,results:[
          {title:'Obsession',type:'movie',releaseYear:2025,link:'/subtitles/obsession-2025'},
          {title:'Obsession',type:'tvseries',releaseYear:2026,link:'/series/obsession'}
        ]});
      }
      case '/subtitles/obsession-2025/english':
        return new Response('<a href="/subtitle/obsession-2025/english/101">English — Obsession.2026.1080p.BluRay</a><a href="/subtitle/obsession-2025/english/102">English — Obsession.2025.MoviesAnywhere.Amazon.WEB</a><a href="/subtitle/obsession-2025/english/102">English — Obsession.2025.Amazon.WEB</a><a href="/subtitle/another-2026/english/103">English — Another movie</a><a href="/subtitle/obsession-2025/french/104">French — Obsession.2026.AMZN.WEB-DL</a>');
      case '/subtitle/obsession-2025/english/102':
        return new Response('<a href="http://127.0.0.1/download">Download</a><a href="https://api.subsource.net/v1/subtitle/download/'+hash+'">Download English Subtitle</a>');
      case '/v1/subtitle/download/'+hash:
        return new Response(zip([
          {name:'Obsession.2025.MoviesAnywhere.WEB.en.srt'},
          {name:'Obsession.2025.Amazon.WEB.en.hi.srt'},
          {name:'Obsession.2025.Amazon.WEB.en.srt'}
        ]),{headers:{'Content-Type':'application/zip'}});
      default:throw Error('Unexpected provider URL '+url);
    }
  });
  const found=await client.search({query:'Obsession',year:2026,kind:'movies',release:'Obsession.2026.1080p.AMZN.WEB-DL.mkv'});
  assert.equal(found.results.length,2);
  assert.equal(found.results[0].source,'SubSource');
  assert.match(found.results[0].sourceUrl,/\/102$/);
  assert.equal((await client.download({id:found.results[0].id})).name,'Obsession.2025.Amazon.WEB.en.srt');
  assert.equal(paths.length,4);
});

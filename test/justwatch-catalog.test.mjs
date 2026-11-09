import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {isJustWatchBackdropUrl,isJustWatchPosterUrl,justWatchChartUrl,justWatchReleaseUrl,parseJustWatchBackdrop,parseJustWatchChart} from '../justwatch-catalog.mjs';
import {createMetadata} from '../metadata.mjs';
import {createRecentCatalog} from '../recent-catalog.mjs';
import {recentFetch} from './recent-fixtures.mjs';

const timestamp='2026-10-08T07:10:00Z',now=()=>Date.parse('2026-10-08T12:00:00Z');
const strip=value=>String(value||'').replace(/<[^>]*>/g,' ').trim();
function chart(kind='movies',time=timestamp){
  const type=kind==='movies'?'movie':'tv-show',hydration=[kind==='movies'?'MovieContent':'ShowContent'];
  const row=(rank,id,poster=`https://images.justwatch.com/poster/12345/s166/chart-${id}.jpg`)=>`<tr><td>
    <p class="title-ranking-list__rank--condensed title-ranking-list__rank">${rank}. </p></td><td>
    <a href="/us/${type}/chart-${id}"><img src="${poster}"></a>
    <a href="/us/${type}/chart-${id}"><div class="list__row__item__content__title"><span>Chart title ${id}</span></div></a>
    </td></tr>`;
  for(let i=1;i<=10;i++){
    const fullPath=hydration.push(`/us/${type}/chart-${i}`)-1;
    const originalReleaseYear=hydration.push(2026)-1;
    const shortDescription=hydration.push('Synopsis for '+i)-1,runtime=hydration.push(104)-1;
    hydration.push({__typename:0,fullPath,originalReleaseYear,shortDescription,runtime});
  }
  return `<p>Streaming charts last updated: <time datetime="${time}">07:10</time></p>
    <table>${Array.from({length:10},(_,i)=>row(i+1,i+1,i===0?'https://127.0.0.1/poster/1/s166/bad.jpg':undefined)).join('')}
    ${row(2,11)}${row(11,1)}</table><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(hydration)}</script>`;
}

function currentMovies(){
  const hydration=['MovieContent'],cards=[];
  for(let i=1;i<=12;i++){
    const href='/us/movie/chart-'+i;
    const fullPath=hydration.push(href)-1,originalReleaseYear=hydration.push(i===12?2025:2026)-1;
    const title=hydration.push('Film '+i)-1;
    hydration.push({__typename:0,fullPath,originalReleaseYear,title});
    cards.push(`<a class="title-list-grid__item--link" href="${href}"><img src="https://images.justwatch.com/poster/12345/s332/film-${i}.jpg"></a>`);
  }
  return cards.join('')+`<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(hydration)}</script>`;
}

test('JustWatch chart keeps ranked titles, verified years and safe posters with a dated rolling window',()=>{
  const row=parseJustWatchChart(chart(),{kind:'movies',period:'week',now:now(),plainText:strip});
  assert.equal(row.periodStart,'2026-10-02');
  assert.equal(row.periodEnd,'2026-10-08');
  assert.equal(row.items.length,10);
  assert.equal(row.items[0].title,'Chart title 1');
  assert.equal(row.items[0].year,2026);
  assert.equal(row.items[0].overview,'Synopsis for 1');
  assert.equal(row.items[0].runtime,104);
  assert.equal(row.items[0].posterRemote,null);
  assert.equal(row.items[1].posterRemote,'https://images.justwatch.com/poster/12345/s166/chart-2.jpg');
  assert.equal(isJustWatchPosterUrl(new URL('https://images.justwatch.com/unsafe/chart-2.jpg')),false);
  assert.throws(()=>parseJustWatchChart(chart('movies','2026-08-01T09:00:00Z'),{kind:'movies',period:'week',now:now(),plainText:strip}),/current chart timestamp/);
});

const detailUrl='https://www.justwatch.com/us/movie/chart-1';
const artUrl='https://images.justwatch.com/backdrop/1841/s1440/chart-1.webp';
function titlePage() {
  const data=['MovieContent','Backdrop','/us/movie/related','/us/movie/chart-1',
    '/backdrop/999/{profile}/related.{format}','https://example.invalid/backdrop/1841/{profile}/chart-1.{format}',
    '/backdrop/1841/{profile}/chart-1.{format}',
    {__typename:1,backdropUrl:4},{__typename:1,backdropUrl:5},{__typename:1,backdropUrl:6},[7],[8,9],
    {__typename:0,fullPath:2,backdrops:10},{__typename:0,fullPath:3,backdrops:11}];
  return '<script type="application/json" id="__NUXT_DATA__">'+JSON.stringify(data)+'</script>';
}

test('backdrop selects only the exact title and a verified JustWatch artwork profile',()=>{
  assert.equal(parseJustWatchBackdrop(titlePage(),detailUrl),artUrl);
  assert.equal(parseJustWatchBackdrop(titlePage(),detailUrl+'/'),artUrl);
  assert.equal(parseJustWatchBackdrop(titlePage(),detailUrl.replace('chart-1','wrong')),null);
  assert.equal(parseJustWatchBackdrop(titlePage(),detailUrl.replace('www.justwatch.com','example.invalid')),null);
  assert.equal(isJustWatchBackdropUrl(new URL(artUrl+'?url=other')),false);
  assert.equal(isJustWatchBackdropUrl(new URL(artUrl.replace('s1440','s1920'))),false);
});

test('discovery publishes an opaque backdrop lazily and caches the verified image',async t=>{
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-backdrop-'));
  const calls=[],image=Buffer.from('RIFF1234WEBP');
  const metadata=await createMetadata({local,now,minIntervalMs:0,fetchImpl:async url=>{
    calls.push(url);
    if(url===justWatchChartUrl('movies','week'))return new Response(chart());
    if(url===detailUrl)return new Response(titlePage(),{headers:{'Content-Type':'text/html'}});
    if(url===artUrl)return new Response(image,{headers:{'Content-Type':'image/webp'}});
    return recentFetch(url);
  }});
  t.after(async()=>{await metadata.close();await fs.rm(local,{recursive:true,force:true});});
  const shelf=(await metadata.discovery()).rows.find(row=>row.id==='movies');
  const item=shelf.items[0];
  assert.match(item.backdropUrl,/^\/api\/metadata\/poster\?id=[a-f0-9]{32}$/);
  assert.equal(calls.includes(detailUrl),false,'Browsing should not eagerly request title pages');
  const id=new URL(item.backdropUrl,'http://localhost').searchParams.get('id');
  const [first,second]=await Promise.all([metadata.poster(id),metadata.poster(id)]);
  assert.equal(first.contentType,'image/webp');
  assert.deepEqual(first.body,image);
  assert.deepEqual(second,first);
  await metadata.poster(id);
  assert.equal(calls.filter(url=>url===detailUrl).length,1);
  assert.equal(calls.filter(url=>url===artUrl).length,1);
});

test('cross-service movies publish ahead of delayed series, and other shelves retain their sources',async t=>{
  let releaseShows,announcedMovies;
  const shows=new Promise(resolve=>{releaseShows=resolve;});
  const announced=new Promise(resolve=>{announcedMovies=resolve;});
  const catalog=createRecentCatalog({now,fetchImpl:async url=>{
    if(url===justWatchChartUrl('movies','month'))return new Response(chart());
    if(url===justWatchChartUrl('tv','month'))return shows;
    return recentFetch(url);
  }});
  t.after(async()=>{releaseShows(new Response(chart('tv')));await catalog.close();});
  const pending=catalog.discovery({period:'month',onPartial:row=>{if(row.id==='movies')announcedMovies(row);}});
  const early=await announced;
  assert.equal(early.chartProvider,'justwatch');
  assert.equal(early.periodStart,'2026-09-09');
  releaseShows(new Response(chart('tv')));
  const result=await pending;
  assert.equal(result.rows.find(row=>row.id==='tv').items[0].isSeries,true);
  assert.match(result.rows.find(row=>row.id==='anime').source,/Anime Corner/);
  assert.match(result.rows.find(row=>row.id==='korean').source,/Netflix/);
});

test('an unavailable JustWatch provider falls back to dated Netflix charts',async t=>{
  const catalog=createRecentCatalog({now,fetchImpl:async url=>url.includes('justwatch.com')?new Response('',{status:503}):recentFetch(url)});
  t.after(()=>catalog.close());
  const result=await catalog.discovery();
  assert.match(result.rows.find(row=>row.id==='movies').source,/Netflix/);
  assert.ok(result.rows.find(row=>row.id==='movies').items.length>0);
});

test('the release-year shelf is separate from the Top 10 and excludes older and duplicate movies',async t=>{
  const catalog=createRecentCatalog({now,fetchImpl:async url=>{
    if(url===justWatchChartUrl('movies','week'))return new Response(chart());
    if(url===justWatchReleaseUrl(2026))return new Response(currentMovies());
    return recentFetch(url);
  }});
  t.after(()=>catalog.close());
  const result=await catalog.discovery();
  const row=result.rows.find(row=>row.id==='new-movies');
  assert.equal(result.rows[1],row);
  assert.equal(row.category,'movies');
  assert.equal(row.title,'Popular 2026 movies');
  assert.deepEqual(row.items.map(item=>[item.title,item.year]),[['Film 11',2026]]);
  assert.match(row.items[0].posterRemote,/s332/);
});

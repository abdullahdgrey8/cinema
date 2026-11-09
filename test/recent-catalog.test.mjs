import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecentCatalog,parseChartTSV,aggregateNetflix,aggregateNetflixGlobal,parseAnimePoll,aggregateAnime,NETFLIX_GLOBAL,NETFLIX_COUNTRIES,ANIME_POLLS} from '../recent-catalog.mjs';
import {recentFetch,pollHTML,pollUrl} from './recent-fixtures.mjs';
const now=()=>Date.parse('2026-10-08T12:00:00Z');

test('published Netflix windows return many unique dated titles and never classify Korean from chart country',async()=>{
  const requests=[],catalog=createRecentCatalog({now,fetchImpl:async url=>{requests.push(url);return recentFetch(url);}}),week=await catalog.discovery({period:'week'}),month=await catalog.discovery({period:'month'});
  assert.deepEqual(week.rows.map(row=>row.items.length),[20,20,19,35]);assert.equal(week.rows[0].periodStart,'2026-09-28');assert.equal(month.rows[0].periodStart,'2026-09-07');assert.equal(month.rows[0].periodEnd,'2026-10-04');assert.equal(week.rows[0].items[0].year,null);assert.equal(month.rows[0].items.length,50);
  assert.ok(week.rows[2].items.every(item=>item.language==='Korean'));assert.ok(!week.rows[2].items.some(item=>item.title==='Foreign series'));assert.ok(!week.rows.flatMap(row=>row.items).some(item=>item.title==='Obsolete Show'));assert.equal(requests.filter(url=>url===NETFLIX_GLOBAL).length,1);assert.equal(requests.filter(url=>url===NETFLIX_COUNTRIES).length,0);assert.equal(week.rows[0].items[0].isSeries,false);assert.equal(week.rows[1].items[0].isSeries,true);assert.match(week.warnings.join(' '),/Sep|2026-09-25/);
});

test('global series aggregation counts only the best season per week, then sums across the period',()=>{
  const rows=[{week:'2026-10-04',category:'TV (English)',weekly_rank:1,show_title:'A Show',weekly_views:100,season_title:'Season 1'},{week:'2026-10-04',category:'TV (English)',weekly_rank:2,show_title:'A Show',weekly_views:80,season_title:'Season 2'},{week:'2026-09-27',category:'TV (English)',weekly_rank:1,show_title:'A Show',weekly_views:200,season_title:'Season 1'}];const items=aggregateNetflixGlobal(rows,['2026-10-04','2026-09-27'],'tv');assert.equal(items.length,1);assert.equal(items[0].weeklyViews,300);assert.equal(items[0].weeksOnChart,2);assert.deepEqual(items[0].seasons,['Season 1','Season 2']);
});

test('country charts deduplicate a series across seasons without inventing its release year',()=>{
  const header='week\tcategory\tweekly_rank\tshow_title\tcountry_iso2\tseason_title\n',records=parseChartTSV(header+'2026-10-04\tTV\t1\tA Show\tUS\tSeason 1\n2026-10-04\tTV\t3\tA Show\tUK\tSeason 2\n2026-09-27\tTV\t1\tOld\tUS\tN/A');const items=aggregateNetflix(records,['2026-10-04'],'tv');assert.equal(items.length,1);assert.equal(items[0].chartPoints,18);assert.equal(items[0].countryCount,2);assert.equal(items[0].year,null);assert.deepEqual(items[0].seasons,['Season 1','Season 2']);
});

test('anime parses all hidden ranking rows, preserved artwork, exact vote period, and sums weekly shares',()=>{
  const first=parseAnimePoll(pollHTML(12,59),pollUrl(12)),second=parseAnimePoll(pollHTML(11,59),pollUrl(11)),combined=aggregateAnime([first,second]);assert.equal(first.items.length,59);assert.equal(first.periodEnd,'2026-09-25');assert.equal(first.items[0].posterRemote,'https://static.animecorner.me/2026/06/poster-0.jpg');assert.equal(combined.length,59);assert.equal(combined[0].voteShare,20);assert.equal(combined[0].weeksOnChart,2);assert.equal(combined[0].year,null);assert.throws(()=>parseAnimePoll('<h1>Blocked</h1>',pollUrl(12)),/voting period/);
});

test('refresh bypasses source caches and failures stay explicit with no curated fallback',async()=>{
  let calls=0,offline=false;const catalog=createRecentCatalog({now,fetchImpl:async url=>{calls++;if(offline)throw Error('Offline');return recentFetch(url);}});await catalog.discovery();const initial=calls;await catalog.discovery();assert.equal(calls,initial);offline=true;const failed=await catalog.discovery({refresh:true});assert.ok(calls>initial);assert.ok(failed.rows.every(row=>row.unavailable&&row.items.length===0));assert.ok(failed.warnings.some(value=>value.includes('Netflix charts unavailable')));await assert.rejects(catalog.discovery({period:'alltime'}),{status:400});
});

test('chart fetch rejects private redirects, excessive payloads, and unpublished future weeks',async()=>{
  const calls=[],catalog=createRecentCatalog({now,fetchImpl:async url=>{calls.push(url);return new Response('',{status:302,headers:{location:'http://127.0.0.1:8080/private'}});}});const result=await catalog.discovery();assert.ok(result.rows.every(row=>row.items.length===0));assert.ok(calls.every(url=>url.startsWith('https://')));
  const huge=createRecentCatalog({now,fetchImpl:async()=>new Response('tiny',{headers:{'content-length':String(100*1024*1024)}})});assert.match((await huge.discovery()).warnings.join(' '),/too large/);
  const future=createRecentCatalog({now,fetchImpl:async url=>url.includes('all-weeks-global')?new Response('week\tcategory\n2099-01-01\tFilms'):recentFetch(url)});assert.match((await future.discovery()).warnings.join(' '),/dated chart/);
});

test('current open anime poll is skipped so a monthly shelf contains four completed polls',async()=>{
  const current='https://animecorner.me/polls/vote/w01-fall2026/results',catalog=createRecentCatalog({now,fetchImpl:async url=>url===ANIME_POLLS?new Response(`<a href="${current}">Open</a>`+await recentFetch(url).text()):url===current?new Response('Voting is still open'):recentFetch(url)});const result=await catalog.discovery({period:'month'}),anime=result.rows.find(row=>row.id==='anime');assert.equal(anime.chartWeeks.length,4);assert.equal(anime.periodStart,'2026-08-28');assert.equal(anime.periodEnd,'2026-09-25');assert.ok(!result.warnings.some(message=>message.includes('unavailable weeks')));
});

test('same-name Korean series from different years can be classified without a guessed poster or year',async()=>{
  const catalog=createRecentCatalog({now,fetchImpl:async url=>{if(!url.includes('en.wikipedia.org'))return recentFetch(url);return Response.json({query:{pages:[{title:'Series 0 (2013 TV series)',pageprops:{'wikibase-shortdesc':'2013 South Korean television series'},thumbnail:{source:'https://upload.wikimedia.org/wikipedia/en/a/ab/Old.jpg'}},{title:'Series 0 (2026 TV series)',pageprops:{'wikibase-shortdesc':'2026 South Korean television series'},thumbnail:{source:'https://upload.wikimedia.org/wikipedia/en/a/ab/New.jpg'}}]}});}}),result=await catalog.discovery(),item=result.rows.find(row=>row.id==='korean').items.find(item=>item.title==='Series 0');assert.ok(item);assert.equal(item.year,null);assert.equal(item.posterRemote,null);assert.equal(item.metadataAmbiguous,true);
});

test('Korean weekly FUNdex buzz and monthly Netflix charts keep their distinct windows and metrics',async t=>{
  const calls=[],catalog=createRecentCatalog({now,fetchImpl:async(url,options)=>{calls.push({url,options});if(url==='https://www.fundex.co.kr/fxmain.do')return new Response('<p>Last updated on <span>October 06.2026.</span></p><script>var __WCD="202640";params.wcd="202640";</script>',{headers:{'content-type':'text/html'}});if(url==='https://www.fundex.co.kr/select/nowplay.getOqlistNew.do')return Response.json(Array.from({length:10},(_,i)=>({pj_seq:i+1,pjname:'Drama '+i,epjname:'Korean Drama '+i,cat_rank:i+1,cat_id:'cat001',cat_sharepoint:10,startday:i===9?'20261010':'20260901'})));return recentFetch(url);}});t.after(()=>catalog.close());const week=await catalog.discovery(),weekly=week.rows.find(row=>row.id==='korean');assert.equal(weekly.items.length,10);assert.match(weekly.source,/FUNdex/);assert.match(weekly.rankingMethod,/not viewers/);assert.equal(weekly.publishedAt,'2026-10-06');assert.equal(weekly.items[9].upcoming,true);
  const month=await catalog.discovery({period:'month'}),monthly=month.rows.find(row=>row.id==='korean');assert.match(monthly.source,/Netflix/);assert.equal(monthly.periodStart,'2026-09-07');assert.ok(monthly.items.every(item=>item.id.startsWith('netflix-')));assert.equal(calls.filter(call=>call.url.includes('fundex')).length,2,'Monthly mode never requests historical FUNdex or paid pagination');
});

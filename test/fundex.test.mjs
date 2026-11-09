import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFundexCatalog,parseFundexPage,parseFundexRecords,FUNDEX_PAGE} from '../fundex-catalog.mjs';
const NOW=Date.parse('2026-10-08T12:00:00Z');
const page='<p>Last updated on <span class="update">October 06.2026.</span></p><script>var __WCD="202640";params.wcd="202640";</script><script>var __WCD="202314";</script>';
const record=(n,changes={})=>({pj_seq:n,pjname:'한국 제목 '+n,epjname:'Fixture drama '+n,startday:'20260901',cat_id:'cat001',cat_rank:n,cat_sharepoint:20,genre_list:'드라마,코미디',...changes});
test('FUNdex dates cross-check current page requests, ignoring stale footer week',()=>{
  assert.deepEqual(parseFundexPage(page,{now:NOW}),{week:'202640',periodStart:'2026-09-28',periodEnd:'2026-10-04',publishedAt:'2026-10-06'});
  assert.throws(()=>parseFundexPage(page.replace(/202640/g,'202314'),{now:NOW}),/verified/);
  assert.throws(()=>parseFundexPage(page.replace('October 06.2026.','October 40.2026.'),{now:NOW}),/invalid update/);
  assert.throws(()=>parseFundexPage(page.replace('params.wcd="202640"','params.wcd="202641"'),{now:NOW}),/verified/);
});
test('FUNdex keeps only the ten public drama rows and builds image URLs from validated ids',()=>{
  const period=parseFundexPage(page,{now:NOW}),rows=Array.from({length:12},(_,i)=>record(i+1));rows[1]=record(2,{cat_id:'cat002'});rows[2]=record(3,{pj_seq:'https://127.0.0.1/private'});rows[3]=record(4,{startday:'20261010',image:'https://127.0.0.1/private'});
  const items=parseFundexRecords(rows,period,{now:NOW});assert.equal(items.length,8);assert.ok(items.every(item=>item.chartRank<=10));assert.equal(items[1].upcoming,true);assert.equal(items[1].posterRemote,'https://www.fundex.co.kr/pjmeta/pjimg/pj_4.jpg');assert.equal(items[1].isSeries,true);assert.equal(items[1].kind,'tv');assert.equal(items[1].browseCategory,'korean');assert.equal(items[0].alternateTitle,'한국 제목 1');assert.equal(items[0].year,2026);
  assert.throws(()=>parseFundexRecords({rows},period,{now:NOW}),/invalid public chart/);
});
test('FUNdex uses current public request only, coalesces calls, and caches detached results for six hours',async t=>{
  let current=NOW;const calls=[];const provider=createFundexCatalog({now:()=>current,fetchImpl:async(url,options)=>{calls.push({url,options});return url===FUNDEX_PAGE?new Response(page,{headers:{'content-type':'text/html'}}):Response.json([record(1),record(2)]);}});t.after(()=>provider.close());
  const [first,second]=await Promise.all([provider.discovery(),provider.discovery()]);assert.equal(calls.length,2);assert.equal(first.items.length,2);assert.equal(second.period,'week');assert.match(first.rankingMethod,/not viewers/);const params=JSON.parse(new URLSearchParams(calls[1].options.body).get('param'));assert.deepEqual(params,{perPage:10,pageoff:0,clsid:null,is_ott:'ott',order:'oqpoint',cat_id:'cat001',wcd:'202640',wtype:'week',table:'tvr_week_rank_nor_ott'});assert.equal(calls[1].options.credentials,'omit');assert.equal(calls[1].options.redirect,'manual');assert.ok(!Object.keys(calls[1].options.headers).some(name=>/cookie|authorization/i.test(name)));
  first.items[0].title='Changed by caller';assert.equal((await provider.discovery()).items[0].title,'Fixture drama 1');assert.equal(calls.length,2);current+=6*60*60*1000+1;await provider.discovery();assert.equal(calls.length,4);
});
test('FUNdex refuses redirects and oversized responses without contacting their destinations',async t=>{
  for(const response of [new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),new Response('x',{headers:{'content-type':'text/html','content-length':String(1024*1024)}}),new Response('x'.repeat(513*1024),{headers:{'content-type':'text/html'}})]){
    const urls=[];const provider=createFundexCatalog({now:()=>NOW,fetchImpl:async url=>{urls.push(url);return response;}});t.after(()=>provider.close());await assert.rejects(provider.discovery(),/HTTP 302|oversized|size limit/);assert.deepEqual(urls,[FUNDEX_PAGE]);await assert.rejects(provider.discovery());assert.equal(urls.length,1,'failed attempts are briefly throttled');
  }
});
test('FUNdex retains dated cached chart with an explicit stale warning when refresh fails',async t=>{
  let fail=false;const provider=createFundexCatalog({now:()=>NOW,fetchImpl:async url=>fail?new Response('down',{status:503}):url===FUNDEX_PAGE?new Response(page,{headers:{'content-type':'text/html'}}):Response.json([record(1)])});t.after(()=>provider.close());await provider.discovery();fail=true;const value=await provider.discovery({refresh:true});assert.equal(value.stale,true);assert.equal(value.periodEnd,'2026-10-04');assert.equal(value.items.length,1);assert.match(value.warning,/503/);const repeated=await provider.discovery();assert.equal(repeated.stale,true);assert.match(repeated.warning,/503/);
});
test('FUNdex handles the live JSON endpoint omitting Content-Type without accepting HTML as data',async t=>{
  const provider=createFundexCatalog({now:()=>NOW,fetchImpl:async url=>url===FUNDEX_PAGE?new Response(page,{headers:{'content-type':'text/html'}}):new Response(new TextEncoder().encode(JSON.stringify([record(1)])))});t.after(()=>provider.close());assert.equal((await provider.discovery()).items.length,1);
  const bad=createFundexCatalog({now:()=>NOW,fetchImpl:async url=>new Response(url===FUNDEX_PAGE?page:'<h1>Error</h1>',{headers:{'content-type':'text/html'}})});t.after(()=>bad.close());await assert.rejects(bad.discovery(),/content type/);
});

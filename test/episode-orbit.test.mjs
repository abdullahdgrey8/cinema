import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEpisodeOrbit} from '../episode-orbit.mjs';

const firefly='tvmaze-180';
const orderSource='https://www.tvmaze.com/alternatelists/1/firefly-dvd-release';
const episode=(id,title,season,number,special=false)=>({id:'tvmaze-episode-'+id,title,season,number,special});
const link=id=>({href:'https://api.tvmaze.com/episodes/'+id});
const alternate=(id,title,season,number,links,type='regular')=>({id,name:title,season,number,type,_links:{episodes:links}});
const dvd={id:1,url:orderSource,dvd_release:true};
const canonicalCatalog=(showId,episodes)=>({show:{id:showId},episodes});

test('Firefly DVD S01E01 points only to the original Serenity episode S01E11',async()=>{
  const requests=[],catalogReads=[];
  const original=[episode(12995,'The Train Job',1,1),episode(13005,'Serenity',1,11)];
  const orbit=createEpisodeOrbit({
    async request(path,byteLimit){
      requests.push({path,byteLimit});
      if(path==='/shows/180/alternatelists')return [dvd];
      if(path==='/alternatelists/1/alternateepisodes')return [
        alternate(2,'The Train Job',1,2,[link(12995)]),
        alternate(1,'<b>Serenity</b>',1,1,[link(13005),link(13005)])
      ];
      assert.fail('Unexpected provider request '+path);
    },
    async catalog(input){catalogReads.push(input);return canonicalCatalog(firefly,original);}
  });
  const orderInfo={id:1,label:'DVD release',sourceUrl:orderSource};
  assert.deepEqual(await orbit.orders({showId:firefly}),{showId:firefly,orders:[orderInfo]});
  assert.deepEqual(catalogReads,[],'The index needs only the alternate-list provider request');
  const order=await orbit.order({showId:firefly,orderId:1});
  assert.deepEqual(order,{showId:firefly,order:orderInfo,seasons:[{number:1,count:2}],season:1,page:1,totalPages:1,totalRows:2,coveredCount:2,canonicalCount:2,rows:[
    {id:1,title:'Serenity',season:1,number:1,special:false,split:false,merged:false,incomplete:false,canonical:[original[1]]},
    {id:2,title:'The Train Job',season:1,number:2,special:false,split:false,merged:false,incomplete:false,canonical:[original[0]]}
  ]});
  assert.deepEqual(catalogReads,[{id:firefly}]);
  assert.deepEqual(requests.map(row=>row.path),['/shows/180/alternatelists','/alternatelists/1/alternateepisodes']);
  assert.equal(requests[1].byteLimit,3*1024*1024);
});

test('Stargate verbatim pilot parts share one canonical episode without inventing unmapped seasons',async()=>{
  const showId='tvmaze-204', pilot=episode(13436,'Children of the Gods',1,1);
  const canonical=[pilot,episode(13438,'The Enemy Within',1,2),episode(13653,'Stargate: The Ark of Truth',10,null,true)];
  const orbit=createEpisodeOrbit({
    request:path=>path.endsWith('/alternatelists')
      ?[{id:175,verbatim_order:true,url:'https://www.tvmaze.com/alternatelists/175/stargate-sg-1-verbatim-order'}]
      :[alternate(1622,'Children of the Gods, Part 1',1,1,[link(13436)]),
        alternate(1623,'Children of the Gods, Part 2',1,2,[link(13436)])],
    catalog:()=>canonicalCatalog(showId,canonical)
  });
  const page=await orbit.order({showId,orderId:175});
  assert.equal(page.order.label,'Verbatim order');
  assert.deepEqual(page.seasons,[{number:1,count:2}]);
  assert.equal(page.coveredCount,1);
  assert.equal(page.canonicalCount,3,'The original coverage denominator includes specials');
  assert.deepEqual(page.rows.map(row=>({number:row.number,split:row.split,canonical:row.canonical})),[
    {number:1,split:true,canonical:[pilot]},
    {number:2,split:true,canonical:[pilot]}
  ]);
  await assert.rejects(orbit.order({showId,orderId:175,season:10}),{status:404});
});

test('Full-order mapping detects a split across pages, mixed links, and a significant unnumbered special',async()=>{
  const known=[episode(11,'First',1,1),episode(12,'Second',1,2),episode(13,'Special',10,null,true)];
  const forged=[
    {href:'http://api.tvmaze.com/episodes/11'},
    {href:'https://api.tvmaze.com.example/episodes/11'},
    {href:'https://api.tvmaze.com:443/episodes/11'},
    {href:'https://name@api.tvmaze.com/episodes/11'},
    {href:'https://api.tvmaze.com/move/../episodes/11'},
    {href:'https://api.tvmaze.com/episodes/11?foo'},
    {href:'https://api.tvmaze.com/episodes/11#fragment'},
    {href:'https://api.tvmaze.com/episodes/11\n'},
    link(888)
  ];
  const first=alternate(1,'First',1,1,[link(11),link(11),...forged]);
  const unknown=alternate(2,'The title alone is insufficient',1,2,forged);
  const middle=Array.from({length:22},(_,index)=>alternate(index+3,'Unlinked',1,index+3,[]));
  const end=alternate(25,'Double feature',1,25,[link(11),link(12),link(11)]);
  const special=alternate(26,'Bonus &amp; ep',null,null,[link(13)],'significant_special');
  const orbit=createEpisodeOrbit({
    request:path=>path.endsWith('/alternatelists')
      ?[{id:1,dvd_release:true,language_premiere:true,url:'https://evil.example/alternatelists/1/forged'}]
      :[special,end,...middle,unknown,first],
    catalog:()=>canonicalCatalog(firefly,known)
  });
  const page=await orbit.order({showId:firefly,orderId:1});
  assert.equal(page.order.label,'DVD release · Language premiere');
  assert.equal(page.order.sourceUrl,'https://www.tvmaze.com/alternatelists/1');
  assert.deepEqual(page.seasons,[{number:1,count:25},{number:null,count:1}]);
  assert.equal(page.totalRows,25);
  assert.equal(page.totalPages,2);
  assert.equal(page.rows.length,24);
  assert.deepEqual(page.rows[0],{id:1,title:'First',season:1,number:1,special:false,split:true,merged:false,incomplete:true,canonical:[known[0]]});
  assert.deepEqual(page.rows[1],{id:2,title:'The title alone is insufficient',season:1,number:2,special:false,split:false,merged:false,incomplete:false,canonical:[]});
  const next=await orbit.order({showId:firefly,orderId:1,season:1,page:2});
  assert.deepEqual(next.rows,[{id:25,title:'Double feature',season:1,number:25,special:false,split:true,merged:true,incomplete:false,canonical:known.slice(0,2)}]);
  assert.equal(next.coveredCount,3);
  const unnumbered=await orbit.order({showId:firefly,orderId:1,season:null});
  assert.deepEqual(unnumbered.rows,[{id:26,title:'Bonus & ep',season:null,number:null,special:true,split:false,merged:false,incomplete:false,canonical:[known[2]]}]);
});

test('Membership and exact request inputs are validated before fetching alternate episodes',async()=>{
  const calls=[];
  const orbit=createEpisodeOrbit({
    request(path){calls.push(path);return [dvd];},
    catalog(){assert.fail('The canonical catalog must stay idle');}
  });
  for(const request of [null,{}, {showId:'tvmaze-0180'}, {showId:'tvmaze-180\n'}, {showId:'https://api.tvmaze.com/shows/180'}])
    await assert.rejects(orbit.orders(request),{status:400});
  for(const request of [null,{showId:firefly,orderId:'1'}, {showId:firefly,orderId:1,page:0}, {showId:firefly,orderId:1,season:-1}])
    await assert.rejects(orbit.order(request),{status:400});
  assert.deepEqual(calls,[]);
  await assert.rejects(orbit.order({showId:firefly,orderId:999}),{status:404});
  assert.deepEqual(calls,['/shows/180/alternatelists']);
});

test('Provider failures and oversize or duplicate data are retryable without trusting a partial order',async()=>{
  let indexReads=0, orderReads=0, canonicalReads=0;
  const malformed=[{unexpected:true},[dvd,dvd],Array.from({length:33},(_,index)=>({id:index+1})),[dvd]];
  const row=alternate(1,'Serenity',1,1,[link(13005)]);
  const responses=[{unexpected:true},[row,row],Array.from({length:4097},(_,index)=>({...row,id:index+1})),
    [{...row,_links:{episodes:Array(33).fill(link(13005))}}],[row],[row]];
  const orbit=createEpisodeOrbit({
    request(path){
      if(path.endsWith('/alternatelists'))return malformed[indexReads++];
      if(!orderReads++){
        throw Object.assign(Error('TVmaze request unavailable (HTTP 429)'),{status:502});
      }
      return responses[orderReads-2];
    },
    catalog(){
      const showId=++canonicalReads===2?'tvmaze-204':firefly;
      return canonicalCatalog(showId,[episode(13005,'Serenity',1,11)]);
    }
  });
  for(let attempt=0;attempt<3;attempt++)await assert.rejects(orbit.orders({showId:firefly}),{status:502});
  assert.equal((await orbit.orders({showId:firefly})).orders.length,1);
  for(let attempt=0;attempt<6;attempt++)await assert.rejects(orbit.order({showId:firefly,orderId:1}),{status:502});
  assert.equal((await orbit.order({showId:firefly,orderId:1})).rows[0].canonical[0].id,'tvmaze-episode-13005');
  assert.equal(indexReads,4);
  assert.equal(orderReads,7);
});

test('Empty and positive order caches expire independently and stale membership cannot open an old order',async()=>{
  const hour=60*60*1000;
  let clock=0, indexReads=0, orderReads=0, available=[], episodes=[];
  const orbit=createEpisodeOrbit({
    now:()=>clock,
    request(path){
      if(path.endsWith('/alternatelists')){indexReads++;return available;}
      orderReads++;return episodes;
    },
    catalog:()=>canonicalCatalog(firefly,[episode(13005,'Serenity',1,11)])
  });
  assert.deepEqual((await orbit.orders({showId:firefly})).orders,[]);
  available=[dvd];
  clock=30*60*1000-1;
  assert.deepEqual((await orbit.orders({showId:firefly})).orders,[]);
  assert.equal(indexReads,1);
  clock++;
  assert.equal((await orbit.orders({showId:firefly})).orders.length,1);
  const empty=await orbit.order({showId:firefly,orderId:1});
  assert.deepEqual({season:empty.season,totalRows:empty.totalRows,page:empty.page,rows:empty.rows},
    {season:null,totalRows:0,page:1,rows:[]});
  episodes=[alternate(1,'Serenity',1,1,[link(13005)])];
  clock+=30*60*1000-1;
  assert.equal((await orbit.order({showId:firefly,orderId:1})).rows.length,0);
  clock++;
  assert.equal((await orbit.order({showId:firefly,orderId:1})).rows.length,1);
  assert.equal(orderReads,2);
  available=[];
  clock=6*hour+30*60*1000-1;
  assert.equal((await orbit.order({showId:firefly,orderId:1})).rows.length,1);
  clock++;
  await assert.rejects(orbit.order({showId:firefly,orderId:1}),{status:404});
  assert.equal(indexReads,3);
  assert.equal(orderReads,2);
});

test('Same order requests share work and eight distinct pending loads bound provider traffic',async()=>{
  const started=[];
  let finish;
  const gate=new Promise(resolve=>{finish=resolve;});
  const orbit=createEpisodeOrbit({
    async request(path){started.push(path);await gate;return [];},
    catalog(){assert.fail('Opening the index does not load canonical episodes');}
  });
  const first=orbit.orders({showId:firefly}), duplicate=orbit.orders({showId:firefly});
  const others=Array.from({length:7},(_,index)=>orbit.orders({showId:'tvmaze-'+(index+1)}));
  await assert.rejects(orbit.orders({showId:'tvmaze-42'}),{status:429});
  assert.equal(started.length,8);
  finish();
  const [original,copy]=await Promise.all([first,duplicate,...others]);
  assert.deepEqual(original,copy);
  assert.deepEqual(await orbit.orders({showId:'tvmaze-42'}),{showId:'tvmaze-42',orders:[]});
});


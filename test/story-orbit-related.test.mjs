import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRelatedTitles} from '../story-orbit-related.mjs';

const claim=(value,rank='normal')=>({rank,mainsnak:{snaktype:'value',datavalue:{value}}});
const item=id=>({'entity-type':'item',id});
const entity=(id,title,claims)=>({id,labels:{en:{language:'en',value:title}},claims});
const tv=(id,title,maze,extra={})=>entity(id,title,{P8600:[claim(maze)],...extra});
const film=entity('Q691611','Serenity',{
  P31:[claim(item('Q11424'))],P345:[claim('tt0379786')],P577:[claim({time:'+2005-09-30T00:00:00Z',precision:11})]
});

function fixture(handler){
  const calls=[];
  const service=createRelatedTitles({fetchImpl:async (url,options)=>{
    const address=new URL(url);
    assert.equal(address.origin,'https://www.wikidata.org');
    assert.equal(address.pathname,'/w/api.php');
    assert.match(options.headers['User-Agent'],/CinemaLocal/);
    assert.equal(options.redirect,'error');
    const query=Object.fromEntries(address.searchParams);
    calls.push(query);
    const data=await handler(query);
    return data instanceof Response?data:Response.json(data);
  }});
  return {service,calls};
}

test('explicit related view opens exact TV and film identities and omits unverified and conflicting relationships',async t=>{
  const source=tv('Q11622','Firefly','180',{
    P155:[claim(item('Q201')),claim(item('Q100')),claim(item('Q100')),claim(item('Q9'),'deprecated')],
    P156:[claim(item('Q691611')),claim(item('Q201')),claim(item('Q600')),claim(item('Q160'))]
  });
  const {service,calls}=fixture(query=>{
    if(query.action==='query'){
      assert.equal(query.srsearch,'haswbstatement:P8600=180');
      assert.equal(query.srnamespace,'0');
      return {query:{searchinfo:{totalhits:2},search:[{title:'Q5'},{title:'Q11622'}]}};
    }
    if(query.ids==='Q5|Q11622')return {entities:{Q5:tv('Q5','Wrong match','999'),Q11622:source}};
    assert.equal(query.action,'wbgetentities');
    assert.equal(query.ids,'Q100|Q691611|Q600|Q160');
    return {entities:{
      Q100:tv('Q100','Earlier series','99',{P8600:[claim('99'),claim('8','deprecated')]}),
      Q691611:film,
      Q600:entity('Q600','A comic',{P31:[claim(item('Q1004'))],P345:[claim('tt1234567')]}),
      Q160:tv('Q160','Ambiguous series','96',{P8600:[claim('96','preferred'),claim('97')]})
    }};
  });
  t.after(()=>service.close());
  const got=await service.related({showId:'tvmaze-180'});
  assert.deepEqual(got,{showId:'tvmaze-180',partial:true,items:[
    {id:'tvmaze-99',title:'Earlier series',kind:'tv',year:null,relation:'follows',sourceUrl:'https://www.wikidata.org/wiki/Q100'},
    {id:'wikidata-Q691611',title:'Serenity',kind:'movies',year:2005,relation:'followed-by',sourceUrl:'https://www.wikidata.org/wiki/Q691611'}
  ]});
  assert.deepEqual(await service.related({showId:'tvmaze-180'}),got);
  assert.equal(calls.length,3);
});

test('declines a crowded search or a duplicated exact source claim before looking at edges',async t=>{
  const {service,calls}=fixture(query=>{
    if(query.action==='query')return query.srsearch.endsWith('180')?
      {query:{searchinfo:{totalhits:4},search:[{title:'Q1'},{title:'Q2'},{title:'Q3'}]}}:
      {query:{searchinfo:{totalhits:2},search:[{title:'Q1'},{title:'Q2'}]}};
    return {entities:{Q1:tv('Q1','One','181'),Q2:tv('Q2','Two','181')}};
  });
  t.after(()=>service.close());
  assert.deepEqual(await service.related({showId:'tvmaze-180'}),{showId:'tvmaze-180',partial:true,items:[]});
  assert.deepEqual(await service.related({showId:'tvmaze-181'}),{showId:'tvmaze-181',partial:true,items:[]});
  await assert.rejects(()=>service.related({showId:'Some show'}),{status:400});
  assert.equal(calls.length,3);
});

test('coalesces a cold lookup, isolates a provider failure and retries it without caching the failure',async t=>{
  let resolve,requests=0;
  const waiting=new Promise(done=>{resolve=done;});
  const {service,calls}=fixture(async query=>{
    if(query.srsearch.endsWith('180')&&++requests===1){
      await waiting;
      return Response.json({}, {status:429});
    }
    return {query:{searchinfo:{totalhits:0},search:[]}};
  });
  t.after(()=>service.close());
  const first=service.related({showId:'tvmaze-180'});
  const second=service.related({showId:'tvmaze-180'});
  const failures=Promise.all([assert.rejects(first,{status:502}),assert.rejects(second,{status:502})]);
  assert.deepEqual(await service.related({showId:'tvmaze-181'}),{showId:'tvmaze-181',partial:false,items:[]});
  resolve();
  await failures;
  assert.deepEqual(await service.related({showId:'tvmaze-180'}),{showId:'tvmaze-180',partial:false,items:[]});
  assert.equal(calls.length,3);
});

test('bounds targets, queued work and responses without accepting an uninspected edge',async t=>{
  let resolve;
  const waiting=new Promise(done=>{resolve=done;});
  const edges=Array.from({length:12},(_,index)=>claim(item('Q'+(10+index))));
  const {service,calls}=fixture(async query=>{
    if(query.srsearch?.endsWith('180')){
      await waiting;
      return {query:{searchinfo:{totalhits:1},search:[{title:'Q1'}]}};
    }
    if(query.srsearch?.endsWith('181')){
      await waiting;
      return new Response('{}',{headers:{'Content-Length':'1048577'}});
    }
    if(query.ids==='Q1')return {entities:{Q1:tv('Q1','Firefly','180',{P156:edges})}};
    assert.equal(query.ids,'Q10|Q11|Q12|Q13|Q14|Q15|Q16|Q17');
    return {entities:{Q10:tv('Q10','Another','3')}};
  });
  t.after(()=>service.close());
  const first=service.related({showId:'tvmaze-180'});
  const second=service.related({showId:'tvmaze-181'});
  const oversized=assert.rejects(second,{status:502});
  await assert.rejects(()=>service.related({showId:'tvmaze-182'}),{status:429});
  resolve();
  const got=await first;
  await oversized;
  assert.equal(got.partial,true);
  assert.deepEqual(got.items.map(row=>row.id),['tvmaze-3']);
  assert.equal(calls.length,4);
});

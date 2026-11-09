import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteLocalJson, createSourceMemory } from '../source-memory.mjs';

const scope='a'.repeat(64), alternateScope='b'.repeat(64);
const file={hash:'c'.repeat(40),index:0,name:'Sample.Title/private-video.mp4',size:1024,condition:'downloading',mode:'direct'};
const library=[{hash:file.hash}];
const session=n=>n.toString(16).padStart(32,'0');
const ledgerName='source-memory.json';
const clock=Date.UTC(2026,10,9);

async function fixture(t,{prepareLocal,rename}={}){
  const local=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-source-memory-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(local)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(local).startsWith('cinema-source-memory-'));
    await fs.rm(local,{recursive:true,force:true});
  });
  let now=clock;
  const boot=()=>createSourceMemory({local,now:()=>now,prepareLocal,rename});
  return {local,filename:path.join(local,ledgerName),boot,tick:ms=>{now+=ms;},memory:await boot()};
}
function report(memory,n,info=file,firstPictureMs=1400,extra={}){
  return memory.record({scope,sessionId:session(n),revision:memory.admission(),firstPictureMs,
    attest:()=>info,...extra});
}
function cohorts(memory,key=scope,items=library){
  return memory.view(key,items).observed;
}

test('new memory starts off and never writes or attests until the user opts in',async t=>{
  const {local,memory}=await fixture(t);
  assert.equal(memory.admission(),null);
  assert.deepEqual(cohorts(memory),[]);
  assert.equal(memory.view(scope,library).enabled,false);
  assert.equal(memory.view(scope,library).available,true);
  assert.equal(memory.view('unavailable',library).available,false);
  assert.equal(await report(memory,1,file,800,{attest:()=>assert.fail('attestation while off')}),false);
  assert.deepEqual(await fs.readdir(local),[]);
});

test('committed opt-in observations survive restart without persisting source identifiers',async t=>{
  const {filename,boot,memory}=await fixture(t);
  const enabled=memory.setEnabled(true);
  assert.equal(memory.admission(),null);
  await enabled;
  const revision=memory.admission();
  assert.match(revision,/^[0-9a-f]+$/);
  assert.equal(await report(memory,1,file,800),true);
  assert.equal(await report(memory,2,file,1600),true);
  assert.equal(await report(memory,3,{...file,condition:'downloaded'},220),true);
  assert.deepEqual(cohorts(memory),[{hash:file.hash,cohorts:[
    {condition:'downloading',mode:'direct',count:2,medianMs:1200},
    {condition:'downloaded',mode:'direct',count:1,medianMs:220},
  ]}]);
  const stored=await fs.readFile(filename,'utf8');
  for(const forbidden of [file.hash,file.name,scope,session(1),revision])assert.ok(!stored.includes(forbidden));
  const restored=await boot();
  assert.deepEqual(cohorts(restored),cohorts(memory));
  assert.equal(await report(restored,1,file,800,{attest:()=>assert.fail('duplicate after restart')}),false);
  assert.deepEqual(cohorts(restored,alternateScope),[]);
  assert.deepEqual(cohorts(restored,scope,[]),[]);
});

test('clear and opt-out fence reports before any queued write can publish them',async t=>{
  const {memory,boot}=await fixture(t);
  await memory.setEnabled(true);
  assert.equal(await report(memory,1),true);
  const stale=memory.admission();
  const queued=report(memory,2,file,800,{attest:()=>assert.fail('queued stale attestation')});
  const cleared=memory.clear();
  assert.equal(memory.admission(),null);
  assert.deepEqual(cohorts(memory),[]);
  assert.equal(await queued,false);
  await cleared;
  assert.notEqual(memory.admission(),stale);
  assert.deepEqual(cohorts(await boot()),[]);
  assert.equal(await report(memory,3,file,800,{revision:stale,attest:()=>assert.fail('old revision')}),false);

  let started;
  const inAttestation=new Promise(resolve=>{started=resolve;});
  const inFlight=report(memory,4,file,800,{attest:()=>{started();return file;}});
  await inAttestation;
  const disabled=memory.setEnabled(false);
  assert.equal(memory.admission(),null);
  assert.equal(await inFlight,false);
  await disabled;
  assert.equal((await boot()).view(scope,library).enabled,false);
  await memory.setEnabled(true);
  assert.deepEqual(cohorts(memory),[]);
});

test('duplicates run one attestation and separate modes and exact latest file identity',async t=>{
  const {memory}=await fixture(t);
  await memory.setEnabled(true);
  const first=report(memory,1,file,800);
  const duplicate=report(memory,1,file,800,{attest:()=>assert.fail('second attestation')});
  assert.deepEqual(await Promise.all([first,duplicate]),[true,false]);
  assert.equal(await report(memory,2,{...file,mode:'hls'},3500),true);
  assert.equal(await report(memory,3,{...file,index:1},9000),true);
  assert.deepEqual(cohorts(memory),[{hash:file.hash,cohorts:[
    {condition:'downloading',mode:'direct',count:1,medianMs:9000},
  ]}]);
  assert.equal(await report(memory,4,file,1200),true);
  assert.deepEqual(cohorts(memory),[{hash:file.hash,cohorts:[
    {condition:'downloading',mode:'direct',count:2,medianMs:1000},
    {condition:'downloading',mode:'hls',count:1,medianMs:3500},
  ]}]);
  assert.equal(await report(memory,5,{...file,size:2048},3000),true);
  assert.equal(cohorts(memory)[0].cohorts[0].medianMs,3000);
  assert.equal(await report(memory,6,{...file,name:'../escape.mp4'}),false);
  assert.equal(await report(memory,6,{...file,mode:'unknown'}),false);
  assert.equal(await report(memory,6,file,30*60_000+1,{attest:()=>assert.fail('out-of-bounds input')}),false);
});

test('retains only the newest 120 observations and expires them by 30 days without a boot write',async t=>{
  const {memory,filename,tick,boot}=await fixture(t);
  await memory.setEnabled(true);
  for(let id=1;id<=121;id++)assert.equal(await report(memory,id,file,id),true);
  assert.deepEqual(cohorts(memory)[0].cohorts,[{condition:'downloading',mode:'direct',count:120,medianMs:61.5}]);
  const before=await fs.readFile(filename);
  tick(30*24*60*60_000);
  assert.deepEqual(cohorts(memory),[]);
  assert.deepEqual(cohorts(await boot()),[]);
  assert.deepEqual(await fs.readFile(filename),before);
  assert.equal(await report(memory,122,file,350),true);
  assert.equal(cohorts(memory)[0].cohorts[0].count,1);
});

test('corrupt ledger and damaged master key stay untouched until explicit recovery archives them',async t=>{
  const {local,filename,boot}=await fixture(t);
  const damaged=Buffer.from([0xff,0,0x7b,0x7d,1]);
  await fs.writeFile(filename,damaged);
  const empty=await boot();
  assert.equal(empty.admission(),null);
  assert.deepEqual(await fs.readdir(local),[ledgerName]);
  assert.deepEqual(await fs.readFile(filename),damaged);
  await empty.setEnabled(true);
  const ledgerArchive=(await fs.readdir(local)).find(name=>name.startsWith(ledgerName+'.corrupt-'));
  assert.deepEqual(await fs.readFile(path.join(local,ledgerArchive)),damaged);
  assert.equal(await report(empty,1),true);

  const keyFile=path.join(local,'source-memory.key');
  const oldLedger=await fs.readFile(filename), damagedKey=Buffer.from('broken');
  await fs.writeFile(keyFile,damagedKey);
  const recovered=await boot();
  assert.equal(recovered.admission(),null);
  assert.deepEqual(await fs.readFile(keyFile),damagedKey);
  assert.deepEqual(await fs.readFile(filename),oldLedger);
  await recovered.setEnabled(true);
  const files=await fs.readdir(local);
  const keyArchive=files.find(name=>name.startsWith('source-memory.key.corrupt-'));
  assert.deepEqual(await fs.readFile(path.join(local,keyArchive)),damagedKey);
  assert.ok((await Promise.all(files.filter(name=>name.startsWith(ledgerName+'.corrupt-'))
    .map(name=>fs.readFile(path.join(local,name))))).some(bytes=>bytes.equals(oldLedger)));
  assert.equal((await fs.readFile(keyFile)).length,32);
  assert.deepEqual(cohorts(recovered),[]);
});

test('a failed disk mutation keeps committed data, rotates admission and permits a later successful write',async t=>{
  const {memory,filename,boot,local}=await fixture(t);
  await memory.setEnabled(true);
  assert.equal(await report(memory,1),true);
  const before=memory.view(scope,library);
  const saved=filename+'.saved';
  await fs.rename(filename,saved);
  await fs.mkdir(filename);
  await assert.rejects(memory.clear());
  assert.equal(memory.view(scope,library).version,before.version);
  assert.deepEqual(cohorts(memory),before.observed);
  assert.notEqual(memory.admission(),before.revision);
  assert.ok(!(await fs.readdir(local)).some(name=>name.endsWith('.tmp')));
  await fs.rmdir(filename);
  await fs.rename(saved,filename);
  await memory.setEnabled(false);
  assert.deepEqual(cohorts(await boot()),[]);
  await memory.setEnabled(true);
  assert.deepEqual(cohorts(await boot()),before.observed);
});

test('the shared atomic writer rejects unserializable values without replacing committed JSON',async t=>{
  const {local}=await fixture(t);
  const config=path.join(local,'connect-test.json');
  await atomicWriteLocalJson(config,{setting:'first'});
  await assert.rejects(atomicWriteLocalJson(config,undefined),TypeError);
  assert.deepEqual(JSON.parse(await fs.readFile(config,'utf8')),{setting:'first'});
  assert.deepEqual(await fs.readdir(local),['connect-test.json']);
});

test('a report rechecks private storage and declines a changed ACL without writing',async t=>{
  let privateStorage=true;
  const checks=[];
  const {memory,filename,local}=await fixture(t,{prepareLocal:async create=>{
    checks.push(create);
    if(!privateStorage)throw Error('private storage ACL changed');
  }});
  await memory.setEnabled(true);
  assert.equal(await report(memory,1),true);
  const before=await fs.readFile(filename);
  const names=await fs.readdir(local);
  const version=memory.view(scope,library).version;
  privateStorage=false;

  assert.equal(await report(memory,2,file,900,{attest:()=>assert.fail('attestation after changed ACL')}),false);
  assert.deepEqual(checks,[false,true,false,false]);
  const refused=memory.view(scope,library);
  assert.equal(refused.version,version+1);
  assert.equal(refused.storageAvailable,false);
  assert.equal(refused.available,false);
  assert.deepEqual(refused.observed,[]);
  assert.equal(memory.admission(),null);
  assert.deepEqual(await fs.readFile(filename),before);
  assert.deepEqual(await fs.readdir(local),names);
});

test('a paused privacy check cannot attest after a connection change or queued opt-out',async t=>{
  for(const change of ['connection','opt-out']){
    let checkStarted,finishCheck,holdCheck=false;
    const started=new Promise(resolve=>{checkStarted=resolve;});
    const unblocked=new Promise(resolve=>{finishCheck=resolve;});
    const {memory,filename}=await fixture(t,{prepareLocal:async create=>{
      if(create||!holdCheck)return;
      checkStarted();
      await unblocked;
    }});
    await memory.setEnabled(true);
    const before=await fs.readFile(filename);
    holdCheck=true;
    let current=true;
    const pending=report(memory,1,file,900,{isCurrent:()=>current,
      attest:()=>assert.fail('stale report attestation after privacy check')});
    await started;
    let disabled;
    if(change==='connection')current=false;
    else disabled=memory.setEnabled(false);
    finishCheck();

    assert.equal(await pending,false);
    if(disabled){
      await disabled;
      await memory.setEnabled(true);
    }else assert.deepEqual(await fs.readFile(filename),before);
    assert.deepEqual(cohorts(memory),[]);
  }
});

function renameError(code){
  return Object.assign(Error('simulated replacement failure'),{code});
}

test('atomic JSON replacement retries only bounded transient lock errors and cleans its temporary file',async t=>{
  const {local}=await fixture(t);
  const config=path.join(local,'connect-test.json');
  await atomicWriteLocalJson(config,{setting:'first'});
  const locks=['EPERM','EBUSY','EACCES'], attempted=[];
  await atomicWriteLocalJson(config,{setting:'second'},{rename:async (temporary,destination)=>{
    assert.equal(destination,config);
    attempted.push(temporary);
    assert.deepEqual(JSON.parse(await fs.readFile(config,'utf8')),{setting:'first'});
    if(locks.length)throw renameError(locks.shift());
    await fs.rename(temporary,destination);
  }});
  assert.equal(attempted.length,4);
  assert.equal(new Set(attempted).size,1,'all retries use the same fully written temporary file');
  assert.deepEqual(JSON.parse(await fs.readFile(config,'utf8')),{setting:'second'});

  let permanent=0;
  await assert.rejects(atomicWriteLocalJson(config,{setting:'bad'},{rename:async ()=>{
    permanent++;
    throw renameError('ENOSPC');
  }}),{code:'ENOSPC'});
  assert.equal(permanent,1);

  let exhausted=0;
  await assert.rejects(atomicWriteLocalJson(config,{setting:'bad'},{rename:async ()=>{
    exhausted++;
    throw renameError('EPERM');
  }}),{code:'EPERM'});
  assert.equal(exhausted,6);
  assert.deepEqual(JSON.parse(await fs.readFile(config,'utf8')),{setting:'second'});
  assert.deepEqual(await fs.readdir(local),['connect-test.json']);
});

test('atomic record retry rechecks current consent after a transient lock',async t=>{
  let started,attempts=0,lock=false;
  const locked=new Promise(resolve=>{started=resolve;});
  const {local,filename,memory}=await fixture(t,{rename:async (temporary,destination)=>{
    if(lock){
      attempts++;
      started();
      throw renameError('EBUSY');
    }
    await fs.rename(temporary,destination);
  }});
  await memory.setEnabled(true);
  const before=await fs.readFile(filename);
  const names=await fs.readdir(local);
  const version=memory.view(scope,library).version;
  lock=true;
  let current=true;
  const pending=report(memory,1,file,900,{isCurrent:()=>current});
  await locked;
  current=false;
  assert.equal(await pending,false);
  assert.equal(attempts,1);
  assert.equal(memory.view(scope,library).version,version);
  assert.deepEqual(await fs.readFile(filename),before);
  assert.deepEqual(await fs.readdir(local),names);
  assert.deepEqual(cohorts(memory),[]);
});

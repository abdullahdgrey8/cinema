import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createSourceMemory} from '../source-memory.mjs';
import {prepareSourceMemoryDirectory} from '../source-memory-storage.mjs';

test('explicit opt-in creates restricted storage while boot and inherited-folder refusal preserve data',async t=>{
  const base=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(base,'cinema-source-memory-acl-'));
  t.after(async()=>{
    const candidate=await fs.realpath(root);
    assert.match(path.relative(base,candidate),/^cinema-source-memory-acl-[\w-]+$/);
    await fs.rm(candidate,{recursive:true,force:true,maxRetries:4,retryDelay:125});
  });
  const inherited=path.join(root,'inherited');
  await fs.mkdir(inherited,{mode:0o755});
  await assert.rejects(prepareSourceMemoryDirectory(inherited,false),/private folder/);
  const local=path.join(root,'private-memory');
  const memory=await createSourceMemory({local,prepareLocal:create=>prepareSourceMemoryDirectory(local,create)});
  assert.equal(memory.admission(),null);
  await assert.rejects(fs.stat(local),{code:'ENOENT'});
  await memory.setEnabled(true);
  assert.equal(typeof memory.admission(),'string');
  await prepareSourceMemoryDirectory(local,false);
  assert.deepEqual((await fs.readdir(local)).sort(),['source-memory.json','source-memory.key']);
  const redirected=path.join(local,'redirected');
  await fs.symlink(inherited,redirected,process.platform==='win32'?'junction':'dir');
  if(process.platform==='win32'){
    await assert.rejects(prepareSourceMemoryDirectory(local,false),/private folder/);
    await fs.unlink(redirected);
    const archive=path.join(local,'source-memory.json.corrupt-test');
    await fs.writeFile(archive,'synthetic archived bytes only');
    const icacls=path.join(process.env.SystemRoot||'C:/Windows','System32','icacls.exe');
    await promisify(execFile)(icacls,[archive,'/grant','*S-1-1-0:(R)'],{windowsHide:true});
    await assert.rejects(prepareSourceMemoryDirectory(local,false),/private folder/);
    const refused=await createSourceMemory({local,prepareLocal:create=>prepareSourceMemoryDirectory(local,create)});
    assert.equal(refused.admission(),null);
    await assert.rejects(refused.setEnabled(true),/private storage/);
  }else{
    await assert.rejects(prepareSourceMemoryDirectory(redirected,false),/private local folder/);
    await assert.rejects(prepareSourceMemoryDirectory(local,false),/private folder/);
    await fs.unlink(redirected);
    await fs.chmod(path.join(local,'source-memory.json'),0o644);
    await assert.rejects(prepareSourceMemoryDirectory(local,false),/private folder/);
  }
});

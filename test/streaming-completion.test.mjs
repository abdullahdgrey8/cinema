import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishCompletedManifest} from '../torrent-media.mjs';

const manifest=(names,end=true)=>'#EXTM3U\n'+names.map(name=>'#EXTINF:4.000000,\n'+name+'\n').join('')+(end?'#EXT-X-ENDLIST\n':'');
async function fixture(t){
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-manifest-completion-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('cinema-manifest-completion-'));await fs.rm(folder,{recursive:true,force:true});});
  const published=manifest(['seg000000.ts'],false),complete=manifest(['seg000000.ts','seg000001.ts']);
  await fs.writeFile(path.join(folder,'index.m3u8'),published);await fs.writeFile(path.join(folder,'index.m3u8.tmp'),complete);
  await fs.writeFile(path.join(folder,'seg000000.ts'),Buffer.alloc(188,0x47));await fs.writeFile(path.join(folder,'seg000001.ts'),Buffer.alloc(188,0x47));
  return {folder,published,complete};
}
test('completion publishes a valid full temporary manifest left by a failed Windows rename',async t=>{
  const f=await fixture(t);const result=await publishCompletedManifest(f.folder,{sourceComplete:true,duration:8,published:f.published});
  assert.equal(result,f.complete);assert.equal(await fs.readFile(path.join(f.folder,'index.m3u8'),'utf8'),f.complete);await assert.rejects(fs.stat(path.join(f.folder,'index.m3u8.tmp')),{code:'ENOENT'});
});
test('completion never promotes incomplete source, missing segments, unsafe filenames, or short/unfinished output',async t=>{
  for(const fault of ['partial-source','missing-segment','unsafe-name','short-output','no-end-marker']){
    const f=await fixture(t);let candidate=f.complete;
    if(fault==='missing-segment')await fs.unlink(path.join(f.folder,'seg000001.ts'));
    if(fault==='unsafe-name')candidate=manifest(['seg000000.ts','../outside.ts']);
    if(fault==='short-output')candidate=manifest(['seg000000.ts']);
    if(fault==='no-end-marker')candidate=manifest(['seg000000.ts','seg000001.ts'],false);
    await fs.writeFile(path.join(f.folder,'index.m3u8.tmp'),candidate);
    const result=await publishCompletedManifest(f.folder,{sourceComplete:fault!=='partial-source',duration:8,published:f.published});
    assert.equal(result,f.published,fault);assert.equal(await fs.readFile(path.join(f.folder,'index.m3u8'),'utf8'),f.published,fault);assert.equal(await fs.readFile(path.join(f.folder,'index.m3u8.tmp'),'utf8'),candidate,fault);
  }
});

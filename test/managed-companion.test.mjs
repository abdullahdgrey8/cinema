import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadManagedCompanion,managedLaunchProof,managedMagnetSource,managedStorageMatches,
  managedTorrentStorageMatches} from '../managed-companion.mjs';

const v1='a'.repeat(40),v2='b'.repeat(64);

test('one bounded magnet has exact v1/v2 identity independent of its label and tracker',()=>{
  const first=managedMagnetSource(`magnet:?xt=urn:btih:${v1}&dn=First`);
  assert.equal(first.fileName,'First');
  assert.equal(first.key,managedMagnetSource(`magnet:?dn=Another&xt=urn:btih:${v1.toUpperCase()}&tr=udp://test.invalid:80`).key);
  const hybrid=managedMagnetSource(`magnet:?xt=urn:btmh:1220${v2}&xt=urn:btih:${v1}&dn=With%20spaces`);
  assert.equal(hybrid.fileName,'With spaces');
  assert.notEqual(hybrid.key,first.key);
  assert.equal(managedMagnetSource(`magnet:?xt=urn:btmh:1220${v2}`).fileName,'Torrent bbbbbbbb');
  for(const bad of [null,{},'https://example.invalid/example.torrent','magnet:?dn=NoHash',
    `magnet:?xt=urn:btih:${v1}&xt=urn:btih:${v1}`,`magnet:?xt=urn:btih:${v1}&xt=bad`,
    `magnet:?xt=urn:btih:${v1}\nmagnet:?xt=urn:btmh:1220${v2}`,`magnet:?xt=urn:btih:${v1}#fragment`,
    `magnet:?xt=urn:btih:${v1}&dn=${'c'.repeat(8192)}`])assert.equal(managedMagnetSource(bad),null);
});

test('the launcher proof changes with the nonce, profile, owner, peer port, pin or key',()=>{
  const profile={root:path.resolve('fixture'),ownerSid:'S-1-5-21-123',certificateSha256:'b'.repeat(64),
    config:{url:'https://127.0.0.1:42973'},peerPort:42974,sceneKey:'a'.repeat(64)};
  const nonce='c'.repeat(64),proof=managedLaunchProof(profile,nonce);
  assert.match(proof,/^[a-f0-9]{64}$/);
  assert.equal(managedLaunchProof(profile,nonce),proof);
  assert.notEqual(managedLaunchProof(profile,'d'.repeat(64)),proof);
  for(const changes of [{root:path.resolve('another')},{ownerSid:'S-1-5-21-456'},
    {certificateSha256:'0'.repeat(64)},{sceneKey:'0'.repeat(64)},{peerPort:42975},
    {config:{url:'https://127.0.0.1:42976'}}])assert.notEqual(managedLaunchProof({...profile,...changes},nonce),proof);
  assert.throws(()=>managedLaunchProof(profile,'short'),/challenge/);
});

test('managed storage requires every bound Web UI and download setting',()=>{
  const profile={downloads:path.resolve('downloads'),incomplete:path.resolve('incomplete'),webPort:42973};
  const prefs={web_ui_address:'127.0.0.1',web_ui_port:42973,use_https:true,save_path:profile.downloads,
    temp_path_enabled:true,temp_path:profile.incomplete};
  assert.equal(managedStorageMatches(profile,prefs),true);
  for(const change of [{web_ui_address:'*'},{web_ui_port:8080},{use_https:false},{save_path:'downloads'},
    {temp_path_enabled:false},{temp_path:profile.downloads}])assert.equal(managedStorageMatches(profile,{...prefs,...change}),false);
});

test('managed file deletion refuses outside paths and a junction escaping downloads',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cinema-managed-paths-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const downloads=path.join(root,'downloads'),incomplete=path.join(root,'incomplete'),foreign=path.join(root,'foreign');
  for(const directory of [downloads,incomplete,foreign])await fs.mkdir(directory);
  await fs.symlink(foreign,path.join(downloads,'outside'),'junction');
  const profile={downloads,incomplete},valid={save_path:downloads,download_path:incomplete,content_path:path.join(incomplete,'file.mp4')};
  assert.equal(await managedTorrentStorageMatches(profile,valid),true);
  assert.equal(await managedTorrentStorageMatches(profile,{...valid,save_path:foreign}),false);
  assert.equal(await managedTorrentStorageMatches(profile,{...valid,content_path:path.join(downloads,'outside')}),false);
  await assert.rejects(loadManagedCompanion(root),/could not verify/);
});

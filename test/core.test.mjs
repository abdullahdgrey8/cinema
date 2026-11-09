import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {classify,rangeFor,contained,title,magnetHashes,torrentIdentity,titleKey,pluginGroups,statusLabel} from '../lib.mjs';
test('HTTP ranges support seeking and suffix requests',()=>{assert.deepEqual(rangeFor('bytes=10-19',100),{start:10,end:19,partial:true});assert.deepEqual(rangeFor('bytes=-10',100),{start:90,end:99,partial:true});assert.equal(rangeFor('bytes=20-',100).end,99);assert.throws(()=>rangeFor('bytes=101-',100));assert.throws(()=>rangeFor('bytes=0-1,4-5',100));assert.throws(()=>rangeFor('bytes=-0',100));});
test('torrent names cannot escape their download directory',()=>{const base=path.resolve('media');assert.ok(contained(base,path.join(base,'show','episode.mp4')));assert.ok(!contained(base,path.resolve(base,'..','private.txt')));assert.ok(!contained(base,path.resolve('media-other','file.mp4')));});
test('explicit categories and episode patterns classify conservatively',()=>{assert.equal(classify('Example.S01E02.1080p'),'tv');assert.equal(classify('Example','anime'),'anime');assert.equal(classify('Example','movies'),'movies');assert.equal(classify('Unrecognized archive'),'other');assert.equal(title('Example.Movie.1080p.WEB-DL.mkv'),'Example Movie');});

test('magnet identity ignores display labels and normalizes base32 info hashes',()=>{
  const hex='0'.repeat(40), base32='A'.repeat(32);
  const a=`magnet:?xt=urn:btih:${hex}&dn=Original&tr=https://tracker.example/announce`;
  const b=`magnet:?dn=Renamed&xt=urn:btih:${base32}`;
  assert.deepEqual(magnetHashes(b),[hex]);assert.equal(torrentIdentity(a),torrentIdentity(b));
  assert.deepEqual(magnetHashes(`magnet:?xt=urn:btmh:1220${'a'.repeat(64)}`),['a'.repeat(64)]);
  assert.deepEqual(magnetHashes('https://example.com/?xt=urn:btih:'+hex),[]);
  assert.deepEqual(magnetHashes('magnet:?xt=urn:btih:not-a-valid-hash'),[]);
});

test('release titles detect duplicates without collapsing different episodes',()=>{
  assert.equal(titleKey('Example.Movie.2024.1080p.WEB-DL.mkv'),titleKey('Example Movie 2024 720p BluRay.mp4'));
  assert.notEqual(titleKey('Example.S01E01.1080p.mkv'),titleKey('Example.S01E02.1080p.mkv'));
  assert.equal(classify('Example.Movie.2024.1080p.mkv'),'movies');
  assert.equal(classify('Book.epub','books'),'other');
  assert.equal(classify('[Uploader] Unrecognized.archive.zip'),'other');
});

test('plugin groups preserve native miscellaneous categories and mixed providers',()=>{
  assert.deepEqual(pluginGroups({supportedCategories:[{id:'all'}]}),['misc']);
  assert.deepEqual(pluginGroups({supportedCategories:[{id:'all'},{id:'movies'},{id:'books'},{id:'anime'}]}),['movies','anime','misc']);
  assert.deepEqual(pluginGroups({supportedCategories:[{id:'tv'}]}),['tv']);
  assert.deepEqual(pluginGroups({}),['misc']);
});

test('download labels distinguish waiting, paused, missing files and completed data',()=>{
  assert.match(statusLabel({state:'stalledDL',progress:.2}),/peers/i);
  assert.match(statusLabel({state:'stoppedDL',progress:.2}),/paused/i);
  assert.match(statusLabel({state:'missingFiles',progress:1}),/missing/i);
  assert.match(statusLabel({state:'metaDL',progress:0}),/metadata/i);
  assert.match(statusLabel({state:'checkingDL',progress:.9}),/checking/i);
  assert.match(statusLabel({state:'uploading',progress:1}),/downloaded/i);
});

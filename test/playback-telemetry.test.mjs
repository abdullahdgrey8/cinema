import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cinema, HASH, torrent, until, wait } from './helpers.mjs';

test('frequent playback status reads share background telemetry and do not delay seeing new pieces', async t => {
  const c = await cinema(t);
  const name = 'waiting.mkv';
  const pieceSize = 65536;
  const size = pieceSize * 16;
  c.state.torrents = [torrent(c.dir, { name, size, total_size: size, progress: 0, state: 'downloading' })];
  c.state.files.set(HASH, [{ index: 0, name, size, progress: 0, piece_range: [0, 15], priority: 1 }]);
  c.state.properties = { piece_size: pieceSize };
  c.state.pieces = Array(16).fill(0);
  const route = `/api/playback?hash=${HASH}&index=0`;
  await c.api('/api/prepare', { hash: HASH, index: 0 });
  await until(async () => (await c.api(route)).message.includes('opening video pieces'));
  c.state.requests.length = 0;
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(Array.from({ length: 8 }, () => c.api(route)));
    assert.ok(results.every(result => result.status === 'buffering'));
    await wait(500);
  }
  const hashInfo = c.state.requests.filter(request => request.endpoint === 'torrents/info' && request.params.has('hashes')).length;
  const fileReads = c.state.requests.filter(request => request.endpoint === 'torrents/files').length;
  const pieceReads = c.state.requests.filter(request => request.endpoint === 'torrents/pieceStates').length;
  t.diagnostic(JSON.stringify({ statusReads: 24, hashInfo, fileReads, pieceReads }));
  assert.ok(hashInfo <= 3 && fileReads <= 3 && pieceReads <= 3, 'Status reads must not start their own torrent requests');

  c.state.pieces[0] = 2;
  c.state.files.get(HASH)[0].progress = 1 / 16;
  await wait(1900); // The media scheduler sees new pieces without any player requests.
  const updated = await c.api(route);
  assert.equal(updated.progress, 1 / 16);
  assert.equal(updated.bufferedBytes, pieceSize);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { cinema, HASH, torrent, until } from './helpers.mjs';

test('incompatible video starts with less than eight seconds of verified media', async t => {
  const c = await cinema(t);
  const name = 'short-opening.avi';
  const file = path.join(c.dir, name);
  const encoded = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=45',
    '-c:v', 'mpeg4', '-vtag', 'XVID', '-q:v', '2', file,
  ], { windowsHide: true, stdio: 'ignore' });
  assert.equal((await once(encoded, 'close'))[0], 0);
  const inspected = spawn(ffprobe.path, [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,pos,size',
    '-of', 'json', file,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  inspected.stdout.on('data', chunk => { output += chunk; });
  assert.equal((await once(inspected, 'close'))[0], 0);
  const packets = JSON.parse(output).packets;
  const pieceSize = 32768;
  const cutoff = packets.find(packet => Number(packet.pts_time) >= 6);
  const have = Math.ceil(Number(cutoff.pos) / pieceSize) * pieceSize;
  const seconds = Number(packets.find(packet => Number(packet.pos) >= have).pts_time);
  assert.ok(have >= 512 * 1024 && seconds < 8, `Fixture requires enough header data but fewer than eight seconds (found ${have} bytes, ${seconds}s)`);
  const original = await fs.readFile(file);
  const size = original.length;
  const partial = await fs.open(file, 'w');
  try {
    await partial.truncate(size);
    await partial.write(original.subarray(0, have));
  } finally { await partial.close(); }
  const pieceCount = Math.ceil(size / pieceSize);
  c.state.torrents = [torrent(c.dir, { name, size, total_size: size, progress: have / size, state: 'downloading' })];
  c.state.files.set(HASH, [{ index: 0, name, size, progress: have / size, piece_range: [0, pieceCount - 1], priority: 1 }]);
  c.state.properties = { piece_size: pieceSize };
  c.state.pieces = Array.from({ length: pieceCount }, (_, index) => index * pieceSize < have ? 2 : 0);
  const start = Date.now();
  await c.api('/api/prepare', { hash: HASH, index: 0 });
  const ready = await until(async () => {
    const status = await c.api(`/api/playback?hash=${HASH}&index=0`);
    assert.notEqual(status.status, 'error', JSON.stringify(status));
    return status.status === 'ready' && status;
  }, { timeout: 8500, interval: 100, description: 'two closed HLS segments from the six-second opening' });
  const playlist = await (await c.request(ready.url)).text();
  const segments = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)].map(match => Number(match[1]));
  assert.ok(segments.length >= 2 && segments.slice(0, 2).every(duration => duration >= 1.9 && duration <= 2.1));
  assert.doesNotMatch(playlist, /#EXT-X-ENDLIST/);
  assert.equal(ready.complete, false);
  t.diagnostic(JSON.stringify({ secondsAvailable: seconds, segments, readyMs: Date.now() - start }));
});

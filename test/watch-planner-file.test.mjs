import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {cinema, HASH, torrent} from './helpers.mjs';

const route = '/api/planner-file?hash=' + HASH;
const file = (name, index = 0, progress = 1, size = 36) => ({name, index, progress, size});

test('planner verifies one completed file on disk without reading piece layout or changing qBittorrent', async t => {
  const c = await cinema(t);
  const name = 'Exact Movie 2024.mp4';
  await fs.writeFile(path.join(c.dir, name), Buffer.alloc(36));
  c.state.torrents.push(torrent(c.dir, {name}));
  c.state.files.set(HASH, [file(name, 3), file('sample.mp4', 4)]);
  assert.deepEqual(await c.api(route), {index: 3, fileName: name, size: 36});
  assert.equal(c.state.requests.some(r => r.endpoint === 'torrents/export' || r.endpoint === 'torrents/properties' || r.endpoint === 'torrents/pieceStates'), false);
  assert.deepEqual(c.state.requests.filter(r => r.method === 'POST').map(r => r.endpoint), ['auth/login']);
});

test('planner withholds proof for removed, partial, ambiguous, sample-only, truncated and escaped files', async t => {
  const c = await cinema(t);
  const name = 'Exact Movie 2024.mp4';
  const libraryItem = torrent(c.dir, {name});
  c.state.torrents.push(libraryItem);
  const cases = [
    [file(name)], // File does not exist yet.
    [file(name, 0, .9)],
    [file(name), file('Another Movie.mp4', 1)],
    [file('Sample.mp4')],
    [file(name, 0, 1, 50)],
    [file('../Cinema-outside.mp4')],
    [file(path.join(c.dir, name))],
  ];
  for (const [index, files] of cases.entries()) {
    if (index === 1) await fs.writeFile(path.join(c.dir, name), Buffer.alloc(36));
    c.state.files.set(HASH, files);
    assert.equal(await c.api(route), null, 'verification case ' + index);
  }
  c.state.files.set(HASH, [file(name)]);
  c.state.torrents.length = 0;
  assert.equal(await c.api(route), null);
});

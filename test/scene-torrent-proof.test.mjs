import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readSceneMetainfo, matchSceneTorrentFile, createVerifiedScenePieces } from '../scene-torrent-proof.mjs';

const PIECE = 16 * 1024;
function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return encode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [encode(key), encode(value[key])]), Buffer.from('e')]);
}
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest();
function fixture(data, extra = {}) {
  const pieces = [];
  for (let i = 0; i < data.length; i += PIECE) pieces.push(digest('sha1', data.subarray(i, i + PIECE)));
  const info = { length: data.length, name: 'movie.mp4', 'piece length': PIECE, pieces: Buffer.concat(pieces), ...extra };
  const rawInfo = encode(info), hash = digest('sha1', rawInfo).toString('hex');
  return { data, info, bytes: encode({ info }), hash, properties: { infohash_v1: hash, infohash_v2: '' } };
}
function fromInfo(info) {
  const bytes = encode({ info }), raw = encode(info), v1 = digest('sha1', raw).toString('hex'), v2 = digest('sha256', raw).toString('hex');
  return { info, bytes, hash: info['meta version'] === 2 ? v2.slice(0, 40) : v1,
    properties: { infohash_v1: v1, infohash_v2: info['meta version'] === 2 ? v2 : '' } };
}
const response = bytes => new Response(bytes, { headers: { 'Content-Type': 'application/x-bittorrent' } });
const metadata = item => readSceneMetainfo(response(item.bytes), item);
const memoryHandle = bytes => ({ async read(target, offset, length, position) {
  const bytesRead = Math.max(0, Math.min(length, bytes.length - position));
  bytes.copy(target, offset, position, position + bytesRead);
  return { bytesRead, buffer: target };
} });
async function readerFor(item, options = {}) {
  const meta = await metadata(item);
  const file = matchSceneTorrentFile(meta, { name: 'movie.mp4', index: 0, size: item.data.length, piece_range: [0, meta.pieceCount - 1] });
  return createVerifiedScenePieces({ metadata: meta, file, handle: memoryHandle(item.data), ...options });
}

test('scene fetch rounds an authenticated runway out and only requests missing target pieces', async () => {
  const reader = await readerFor(fixture(Buffer.alloc(8 * PIECE + 2)));
  const foreground = { start: PIECE + 7, end: 3 * PIECE - 9 };
  const states = Uint8Array.of(2, 2, 2, 1, 0, 2, 0, 0, 0);
  await reader.read(0, 16, states);
  const ranges = [[0, 16], [PIECE + 8, 7 * PIECE], [8 * PIECE, 8 * PIECE + 2]];
  const plan = reader.fetchPlan(ranges, foreground, states);
  assert.deepEqual(plan, { reserve: [PIECE, 3 * PIECE],
    ranges: [[3 * PIECE, 5 * PIECE], [6 * PIECE, 7 * PIECE], [8 * PIECE, 8 * PIECE + 2]] });
  assert.equal(reader.pieceCount, 1);
  assert.equal(reader.hasRunway(plan.reserve, states), true);
  states[2] = 1;
  assert.equal(reader.hasRunway(plan.reserve, states), false);
  assert.equal(reader.fetchPlan(ranges, foreground, states), null);
  states[2] = 2;
  states[0] = 0;
  assert.equal(reader.hasRunway(plan.reserve, states), false);
  assert.equal(reader.fetchPlan(ranges, foreground, states), null);
});

test('scene fetch aligns a displaced file in torrent space and rejects a shared target boundary', async () => {
  const offset = 17, whole = Buffer.alloc(6 * PIECE), movie = whole.subarray(offset);
  const item = fromInfo({ name: 'Root', 'piece length': PIECE, pieces: fixture(whole).info.pieces, files: [
    { length: offset, path: ['neighbor.bin'] }, { length: movie.length, path: ['movie.mp4'] }
  ] });
  const meta = await metadata(item);
  const file = matchSceneTorrentFile(meta, { name: 'Root/movie.mp4', size: movie.length, index: 1, piece_range: [0, 5] });
  const reader = createVerifiedScenePieces({ metadata: meta, file, handle: memoryHandle(movie) });
  const states = [0, 2, 2, 0, 0, 0], foreground = { start: PIECE, end: 2 * PIECE - offset };
  const targets = [[3 * PIECE, 4 * PIECE - offset]];
  assert.deepEqual(reader.fetchPlan(targets, foreground, states), {
    reserve: [PIECE - offset, 3 * PIECE - offset], ranges: [[3 * PIECE - offset, 4 * PIECE - offset]]
  });
  assert.equal(reader.hasRunway([PIECE, 3 * PIECE], states), false);
  assert.equal(reader.fetchPlan([[0, 1]], foreground, states), null);
  assert.equal(reader.fetchPlan(targets, { start: 0, end: 2 * PIECE }, states), null);
});

test('scene fetch fails closed for out-of-bounds, invalid or oversized native plans', async () => {
  const reader = await readerFor(fixture(Buffer.alloc(85 * PIECE)));
  const states = [...Array(65).fill(2), ...Array(20).fill(0)];
  const ranges = [[65 * PIECE, 82 * PIECE]];
  assert.equal(reader.fetchPlan(ranges, { start: 0, end: 2 * PIECE }, states), null);
  assert.equal(reader.fetchPlan([[65 * PIECE, 66 * PIECE]], { start: 0, end: 65 * PIECE }, states), null);
  assert.equal(reader.fetchPlan([[65 * PIECE, 86 * PIECE]], { start: 0, end: 2 * PIECE }, states), null);
  assert.equal(reader.fetchPlan([[0, PIECE]], { start: 0, end: 2 * PIECE }, states), null);
  assert.equal(reader.fetchPlan(ranges, { start: 0, end: 2 * PIECE }, states.slice(1)), null);
  states[65] = 7;
  assert.equal(reader.fetchPlan([[65 * PIECE, 66 * PIECE]], { start: 0, end: 2 * PIECE }, states), null);
});

test('authenticates canonical single-file metadata against the selected torrent', async () => {
  const item = fixture(Buffer.from('The last piece is shorter.'));
  const result = await metadata(item);
  assert.equal(result.pieceSize, PIECE);
  assert.equal(result.pieceCount, 1);
  assert.equal(result.totalSize, 26);
  assert.deepEqual(result.entries, [{ name: 'movie.mp4', size: 26, offset: 0, padding: false }]);
  await assert.rejects(readSceneMetainfo(response(item.bytes), { ...item, hash: '0'.repeat(40) }), { code: 'scene-unverified' });
});

test('copies verified discontiguous pieces while keeping the missing middle unavailable', async () => {
  const data = Buffer.alloc(2 * PIECE + 5, 0x61); data.write('SCENE', 2 * PIECE);
  const reader = await readerFor(fixture(data));
  assert.equal((await reader.read(0, 5, [2, 0, 2])).toString(), 'aaaaa');
  await reader.admit([{ start: 2 * PIECE, end: data.length }], [2, 0, 2]);
  assert.equal(reader.pieceCount, 2);
  assert.equal(reader.availableEnd(0), PIECE);
  assert.equal(reader.availableEnd(PIECE), PIECE);
  assert.equal(reader.availableEnd(2 * PIECE), data.length);
  const copy = reader.slice(2 * PIECE, data.length);
  assert.equal(copy.toString(), 'SCENE');
  copy.fill(0); data.fill(0);
  assert.equal(reader.slice(2 * PIECE, 2 * PIECE + 5).toString(), 'SCENE');
  assert.throws(() => reader.slice(PIECE - 1, 2 * PIECE + 1), { code: 'scene-missing' });
  assert.throws(() => reader.recheck([2, 0, 0]), { code: 'scene-missing' });
});

test('supports older v1 identity fields but rejects conflicting or malformed identities', async () => {
  const item = fixture(Buffer.from('film'));
  assert.equal((await readSceneMetainfo(response(item.bytes), { hash: item.hash, properties: {} })).totalSize, 4);
  for (const properties of [{ infohash_v1: '' }, { infohash_v1: 'f'.repeat(40) }, { infohash_v2: 'f'.repeat(64) }, null,
    { infohash_v1: { toLowerCase: 'not a function' } }]) {
    await assert.rejects(readSceneMetainfo(response(item.bytes), { hash: item.hash, properties }), { code: 'scene-unverified' });
  }
});

test('rejects duplicate, unsorted, noncanonical and binary-disguised bencode tokens', async () => {
  const item = fixture(Buffer.from('film'));
  const invalid = [
    Buffer.concat([Buffer.from('d4:info'), encode(item.info), Buffer.from('4:info'), encode(item.info), Buffer.from('e')]),
    Buffer.concat([Buffer.from('d1:zi0e4:info'), encode(item.info), Buffer.from('e')]),
    Buffer.from('d4:infod6:lengthi04eeee'), Buffer.from('d4:infod6:lengthi-0eeee'),
    Buffer.from('d04:infodee'), Buffer.concat([item.bytes, Buffer.from('junk')]),
    Buffer.concat([Buffer.from('d4:infod6:lengthi'), Buffer.from([0xb1]), Buffer.from('eeee')])
  ];
  for (const bytes of invalid) await assert.rejects(readSceneMetainfo(response(bytes), item), { code: 'scene-unverified' });
});

test('requires full hybrid identities and congruent v1/v2 file layouts', async () => {
  const base = fixture(Buffer.from('film'));
  const hybrid = fromInfo({ ...base.info, 'meta version': 2, 'file tree': { 'movie.mp4': { '': { length: 4, 'pieces root': Buffer.alloc(32, 7) } } } });
  assert.equal((await metadata(hybrid)).hybrid, true);
  for (const change of [{ hash: hybrid.properties.infohash_v1 }, { properties: { infohash_v1: hybrid.properties.infohash_v1 } },
    { properties: { ...hybrid.properties, infohash_v2: '0'.repeat(64) } }])
    await assert.rejects(readSceneMetainfo(response(hybrid.bytes), { ...hybrid, ...change }), { code: 'scene-unverified' });
  const mismatch = fromInfo({ ...hybrid.info, 'file tree': { 'other.mp4': { '': { length: 4, 'pieces root': Buffer.alloc(32, 7) } } } });
  await assert.rejects(metadata(mismatch), { code: 'scene-unverified' });
  const v2Only = { ...hybrid.info }; delete v2Only.pieces; delete v2Only.length;
  await assert.rejects(metadata(fromInfo(v2Only)), { code: 'scene-unsupported' });
});

test('admits a padded multifile hybrid only when its real files have identical aligned layouts', async () => {
  const movie = Buffer.from('FILM'), pad = Buffer.alloc(PIECE - 4), next = Buffer.from('NEXT');
  const info = { name: 'Root', 'piece length': PIECE, pieces: Buffer.concat([digest('sha1', Buffer.concat([movie, pad])), digest('sha1', next)]),
    'meta version': 2, files: [{ length: 4, path: ['movie.mp4'] }, { length: pad.length, path: ['.pad', String(pad.length)], attr: 'p' }, { length: 4, path: ['next.mp4'] }],
    'file tree': { 'movie.mp4': { '': { length: 4, 'pieces root': Buffer.alloc(32, 1) } }, 'next.mp4': { '': { length: 4, 'pieces root': Buffer.alloc(32, 2) } } }
  };
  const meta = await metadata(fromInfo(info)), file = matchSceneTorrentFile(meta, { name: 'Root/movie.mp4', size: 4, index: 0, piece_range: [0, 0] });
  const reader = createVerifiedScenePieces({ metadata: meta, file, handle: memoryHandle(movie) });
  assert.equal((await reader.read(0, 4, [2, 0])).toString(), 'FILM');
  const misaligned = fromInfo({ ...info, files: info.files.filter(file => !file.attr), pieces: digest('sha1', Buffer.concat([movie, next])) });
  await assert.rejects(metadata(misaligned), { code: 'scene-unverified' });
});

test('rejects conflicting legacy UTF-8 aliases rather than selecting a different spelling', async () => {
  await assert.rejects(metadata(fixture(Buffer.from('film'), { 'name.utf-8': 'other.mp4' })), { code: 'scene-unverified' });
  const info = { name: 'Root', 'piece length': PIECE, pieces: digest('sha1', Buffer.from('film')),
    files: [{ path: ['movie.mp4'], 'path.utf-8': ['other.mp4'], length: 4 }] };
  await assert.rejects(metadata(fromInfo(info)), { code: 'scene-unverified' });
});

test('binds exact file name, size and piece range and rejects unsafe Windows paths', async () => {
  const item = fixture(Buffer.from('film')), meta = await metadata(item);
  const file = { name: 'movie.mp4', size: 4, index: 8, piece_range: [0, 0] };
  assert.deepEqual(matchSceneTorrentFile(meta, file), { name: 'movie.mp4', size: 4, index: 8, offset: 0 });
  for (const change of [{ name: 'other.mp4' }, { size: 3 }, { piece_range: [0, 1] }, { piece_range: undefined }, { index: -1 }])
    assert.throws(() => matchSceneTorrentFile(meta, { ...file, ...change }), { code: 'scene-unverified' });
  for (const name of ['../movie.mp4', 'C:movie.mp4', 'movie.mp4:secret', 'NUL.mp4', 'file.', 'file ', 'bad\0name'])
    await assert.rejects(metadata(fixture(Buffer.from('film'), { name })), { code: 'scene-unsupported' });
  for (const paths of [[['MOVIE.mp4'], ['movie.mp4']], [['a'], ['a-'], ['a', 'b']]]) {
    const info = { name: 'Root', 'piece length': PIECE, pieces: Buffer.alloc(20), files: paths.map(path => ({ path, length: 1 })) };
    await assert.rejects(metadata(fromInfo(info)), { code: 'scene-unsupported' });
  }
});

test('hashes full boundary pieces with explicit padding but never assumes a neighboring file', async () => {
  const movie = Buffer.from('FILM'), whole = Buffer.concat([Buffer.alloc(7), movie, Buffer.alloc(5)]);
  const info = { name: 'Root', 'piece length': PIECE, pieces: digest('sha1', whole), files: [
    { length: 7, path: ['.pad', '7'], attr: 'p' }, { length: 4, path: ['movie.mp4'] }, { length: 5, path: ['.pad', '5'], attr: 'p' }
  ] };
  const meta = await metadata(fromInfo(info)), file = matchSceneTorrentFile(meta, { name: 'Root/movie.mp4', size: 4, index: 1, piece_range: [0, 0] });
  assert.equal(file.offset, 7);
  const reader = createVerifiedScenePieces({ metadata: meta, file, handle: memoryHandle(movie) });
  assert.equal((await reader.read(0, 4, [2])).toString(), 'FILM');
  const neighbor = fromInfo({ ...info, files: info.files.map((file, index) => index ? file : { length: 7, path: ['neighbor.bin'] }) });
  const other = await metadata(neighbor), bound = matchSceneTorrentFile(other, { name: 'movie.mp4', size: 4, index: 1, piece_range: [0, 0] });
  let reads = 0;
  const denied = createVerifiedScenePieces({ metadata: other, file: bound, handle: { async read() { reads++; } } });
  await assert.rejects(denied.read(0, 4, [2]), { code: 'scene-unsupported' });
  assert.equal(reads, 0);
  const wrongPadding = await metadata(fromInfo({ ...info, pieces: digest('sha1', Buffer.alloc(16, 1)) }));
  const wrong = createVerifiedScenePieces({ metadata: wrongPadding, file: matchSceneTorrentFile(wrongPadding, { name: 'movie.mp4', size: 4, index: 1, piece_range: [0, 0] }), handle: memoryHandle(movie) });
  await assert.rejects(wrong.read(0, 4, [2]), { code: 'scene-unverified' });
});

test('rejects false complete states, short disk data and changed piece flags without trusting exposed hashes', async () => {
  const item = fixture(Buffer.from('FILM')), meta = await metadata(item);
  const file = matchSceneTorrentFile(meta, { name: 'movie.mp4', size: 4, index: 0, piece_range: [0, 0] });
  const tampered = Buffer.from('EVIL'); meta.pieceHashes.set(digest('sha1', tampered));
  for (const data of [tampered, Buffer.from('FIL')]) {
    const reader = createVerifiedScenePieces({ metadata: meta, file, handle: memoryHandle(data) });
    await assert.rejects(reader.read(0, 4, [2]), { code: 'scene-unverified' });
    assert.equal(reader.pieceCount, 0);
  }
  const reader = await readerFor(item);
  await assert.rejects(reader.read(0, 4, [0]), { code: 'scene-missing' });
  assert.equal(reader.pieceCount, 0);
});

test('handles short successful disk reads but rejects a flag flipped during copying', async () => {
  const item = fixture(Buffer.from('FILM')), backing = memoryHandle(item.data);
  const short = await readerFor(item, { handle: { read(target, offset, length, position) { return backing.read(target, offset, Math.min(2, length), position); } } });
  assert.equal((await short.read(0, 4, [2])).toString(), 'FILM');
  const states = [2], flipped = await readerFor(item, { handle: { async read(...args) { const result = await backing.read(...args); states[0] = 0; return result; } } });
  await assert.rejects(flipped.read(0, 4, states), { code: 'scene-missing' });
  assert.equal(flipped.pieceCount, 0);
  const failed = await readerFor(item, { handle: { async read() { throw Object.assign(Error('private path'), { code: 'EIO' }); } } });
  await assert.rejects(failed.read(0, 4, [2]), error => error.code === 'scene-unverified' && !error.message.includes('private path'));
});

test('cancels metadata and descriptor reads and never admits bytes after phase cancellation', async () => {
  const item = fixture(Buffer.from('FILM')), pending = new AbortController();
  const stream = new ReadableStream({ pull() {}, cancel() {} });
  const reading = readSceneMetainfo(new Response(stream), { ...item, signal: pending.signal });
  pending.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  const phase = new AbortController(), parent = new AbortController();
  const reader = await readerFor(item, { signal: parent.signal, handle: { async read(...args) {
    const result = await memoryHandle(item.data).read(...args); phase.abort(); return result;
  } } });
  await assert.rejects(reader.read(0, 4, [2], phase.signal), { name: 'AbortError' });
  assert.equal(reader.pieceCount, 0);
  parent.abort();
  assert.throws(() => reader.slice(0, 0), { name: 'AbortError' });
});

test('enforces decoded metadata and copy budgets before large data reads', async () => {
  const item = fixture(Buffer.from('FILM'));
  let cancelled = false;
  const over = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readSceneMetainfo(new Response(over, { headers: { 'Content-Length': '1' } }), item), { code: 'scene-limit' });
  assert.equal(cancelled, true);
  const large = fromInfo({ name: 'movie.mp4', length: 32 * 1024 * 1024, 'piece length': 8 * 1024 * 1024, pieces: Buffer.alloc(80) });
  const meta = await metadata(large), file = matchSceneTorrentFile(meta, { name: 'movie.mp4', size: meta.totalSize, index: 0, piece_range: [0, 3] });
  let reads = 0;
  const reader = createVerifiedScenePieces({ metadata: meta, file, handle: { async read() { reads++; } } });
  await assert.rejects(reader.admit([{ start: 0, end: meta.totalSize }], [2, 2, 2, 2]), { code: 'scene-limit' });
  await assert.rejects(reader.read(0, 256 * 1024 + 1, [2, 2, 2, 2]), { code: 'scene-limit' });
  assert.equal(reads, 0);
});

test('rejects inconsistent export lengths, unavailable metadata, unsupported sizes and missing digests', async () => {
  const item = fixture(Buffer.from('FILM'));
  await assert.rejects(readSceneMetainfo(new Response(item.bytes, { headers: { 'Content-Length': String(item.bytes.length + 1) } }), item), { code: 'scene-unverified' });
  await assert.rejects(readSceneMetainfo(new Response('Missing metadata', { status: 409 }), item), { code: 'scene-missing' });
  for (const pieceSize of [PIECE - 1, 8 * 1024 * 1024 + 1])
    await assert.rejects(metadata(fromInfo({ ...item.info, 'piece length': pieceSize })), { code: 'scene-limit' });
  await assert.rejects(metadata(fromInfo({ ...item.info, pieces: Buffer.alloc(40) })), { code: 'scene-unverified' });
  await assert.rejects(metadata(fromInfo({ ...item.info, length: 64 * 1024 ** 3 + 1 })), { code: 'scene-limit' });
});

test('bounds cumulative bootstrap bytes without charging duplicate pieces twice', async () => {
  const item = fixture(Buffer.alloc(256 * 1024, 1)), reader = await readerFor(item), states = Array(16).fill(2);
  for (let i = 0; i < 32; i++) await reader.read(0, item.data.length, states);
  assert.equal(reader.pieceCount, 16);
  await assert.rejects(reader.read(0, 1, states), { code: 'scene-limit' });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapNeeded, isH264IdrSample, NeedMoreScenePrefix, parseSceneMovie, selectScene, UnsupportedSceneMp4,
} from '../scene-mp4-index.mjs';

function words(...values) {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => out.writeUInt32BE(value, i * 4));
  return out;
}
const box = (name, ...parts) => Buffer.concat([words(8 + parts.reduce((size, part) => size + part.length, 0)),
  Buffer.from(name), ...parts]);
const full = (name, ...parts) => box(name, words(0), ...parts);
const ftyp = box('ftyp', Buffer.from('isom'), words(0), Buffer.from('isom'));
const dataReference = box('dinf', full('dref', words(1), box('url ', words(1))));
const idr = Buffer.from([0, 0, 0, 2, 0x65, 0xaa]);
const audioConfiguration = Buffer.from('031900010004114015000000000000000000000005021190060102', 'hex');

function track(visual, start, size, count, { signed = false, edits = false, declaredComposition = false,
  delta = 1000, wide = false, variable = false } = {}) {
  const entry = Buffer.alloc(visual ? 78 : 28);
  entry.writeUInt16BE(1, 6);
  const config = visual ? box('avcC', Buffer.from([1, 0, 0, 0, 0xff, 0, 0])) : full('esds', audioConfiguration);
  const descriptions = full('stsd', words(1), box(visual ? 'avc1' : 'mp4a', entry, config));
  const offset = wide ? Buffer.alloc(8) : words(start);
  if (wide) offset.writeBigUInt64BE(BigInt(start));
  const sizes = variable ? words(0, count, ...Array(count).fill(size)) : words(size, count);
  const tables = [descriptions, full('stts', words(1, count, delta)), full('stsc', words(1, 1, count, 1)),
    full('stsz', sizes), full(wide ? 'co64' : 'stco', words(1), offset)];
  if (visual) {
    tables.push(full('stss', words(1, 1)));
    if (signed) tables.push(box('ctts', words(0x01000000, 3, 1, 0, 1, 1000, 1, 0xfffffc18)));
    if (declaredComposition) tables.push(full('ctts', words(1, count, 0)));
  }
  const tkhd = Buffer.alloc(80);
  tkhd.writeUInt32BE(visual ? 1 : 2, 8);
  tkhd.writeUInt32BE(count * delta + Number(edits), 16);
  const mdhd = Buffer.alloc(20);
  mdhd.writeUInt32BE(1000, 8);
  mdhd.writeUInt32BE(count * delta, 12);
  const handler = Buffer.alloc(20);
  handler.write(visual ? 'vide' : 'soun', 4);
  const minf = box('minf', box(visual ? 'vmhd' : 'smhd'), dataReference, box('stbl', ...tables));
  const children = [full('tkhd', tkhd), box('mdia', full('mdhd', mdhd), full('hdlr', handler), minf)];
  if (edits) children.push(box('edts', full('elst', words(2, 100, 0xffffffff, 0x10000, count * delta - 100, 0, 0x10000))));
  return box('trak', ...children);
}

function movieHeader(duration) {
  const data = Buffer.alloc(96);
  data.writeUInt32BE(1000, 8);
  data.writeUInt32BE(duration, 12);
  return full('mvhd', data);
}

function fixture({ signed = false, edits = false, overlap = false, variable = false,
  counts = [3, 3], delta = 1000, declaredComposition = false } = {}) {
  const mvhd = movieHeader(Math.max(...counts) * delta + Number(edits));
  const moov = (start) => box('moov', mvhd,
    track(true, start, idr.length, counts[0], { signed, edits, delta, variable, declaredComposition }),
    track(false, start + (overlap ? 0 : 3 * idr.length), 4, counts[1], { edits, delta, variable }));
  const bootstrap = ftyp.length + moov(0).length + 8;
  const data = Buffer.concat([ftyp, moov(bootstrap), box('mdat', idr, idr, idr, Buffer.alloc(12, 0x42))]);
  return { bootstrap, data, size: data.length };
}

test('bootstrap needs only exact verified header ends and refuses a too-large moov before reading it', () => {
  const { bootstrap, data, size } = fixture();
  assert.throws(() => bootstrapNeeded(Buffer.alloc(0), size),
    error => error instanceof NeedMoreScenePrefix && error.minimumBytes === 8);
  assert.equal(bootstrapNeeded(data.subarray(0, bootstrap), size), bootstrap);
  assert.throws(() => bootstrapNeeded(data.subarray(0, bootstrap - 1), size),
    error => error instanceof NeedMoreScenePrefix && error.minimumBytes === bootstrap);

  const oversized = Buffer.concat([ftyp, words(8 * 1024 * 1024), Buffer.from('moov')]);
  assert.throws(() => bootstrapNeeded(oversized, oversized.length + 8 * 1024 * 1024),
    error => error instanceof UnsupportedSceneMp4 && !(error instanceof NeedMoreScenePrefix));
});

test('exact integer offsets, scene coverage and terminal audio extent survive reusable selection', () => {
  const { bootstrap, data, size } = fixture();
  const movie = parseSceneMovie(new Uint8Array(data.subarray(0, bootstrap)), size);
  assert.deepEqual(movie.sampleCounts, [3, 3]);
  assert.deepEqual(movie.lastAudioSampleDuration, { duration: 1000, timescale: 1000, start: size - 4, end: size });
  const scene = selectScene(movie, 1100, 300, { readAheadMs: 0 });
  assert.equal(scene.keyframe, scene.video.samples[0]);
  assert.deepEqual(scene.keyframe, {
    number: 1, decodeTime: 0, duration: 1000, start: bootstrap, end: bootstrap + 6, sync: true,
    compositionTime: 0, presentationTime: { n: 0n, d: 1n }, presentationEnd: { n: 1n, d: 1n },
  });
  assert.deepEqual(scene.video.samples.map(sample => sample.number), [1, 2]);
  assert.deepEqual(scene.audio.samples.map(sample => sample.number), [1, 2]);
  assert.deepEqual(scene.ranges, [[0, bootstrap + 12], [bootstrap + 18, bootstrap + 26]]);
  assert.equal(selectScene(movie, 2100, 300).video.samples.length, 3);
  assert.throws(() => selectScene(movie, 3000, 100), UnsupportedSceneMp4);
});

test('signed composition offsets and one-tick edit rounding keep exact mapped movie time', () => {
  const { bootstrap, data, size } = fixture({ signed: true, edits: true });
  const movie = parseSceneMovie(data.subarray(0, bootstrap), size);
  assert.throws(() => selectScene(movie, 50, 50), UnsupportedSceneMp4);
  const scene = selectScene(movie, 1120, 100, { readAheadMs: 0 });
  assert.deepEqual(scene.video.edit, { movieStart: 100, duration: 2900, mediaStart: 0, hasExplicitEdit: true });
  assert.deepEqual(scene.video.samples.map(sample => sample.compositionTime), [0, 2000, 1000]);
  assert.deepEqual(scene.video.samples[2].presentationTime, { n: 11n, d: 10n });
  assert.throws(() => selectScene(movie, 2950, 51), UnsupportedSceneMp4);
});

test('overlapping track chunks, fragmented boxes and malformed IDR samples fail closed', () => {
  const { bootstrap, data, size } = fixture({ overlap: true });
  assert.throws(() => parseSceneMovie(data.subarray(0, bootstrap), size), /overlap/i);
  const fragmented = Buffer.concat([ftyp, box('moof'), box('mdat', idr)]);
  assert.throws(() => bootstrapNeeded(fragmented, fragmented.length), /unsupported/i);
  assert.equal(isH264IdrSample(idr), true);
  for (const invalid of [Buffer.alloc(0), idr.subarray(0, 5), Buffer.from([0, 0, 0, 2, 0x61, 0]), Buffer.from([0, 0, 0, 2, 0xe5, 0])]) {
    assert.equal(isH264IdrSample(invalid), false);
  }
});

test('aggregate declarations and packed memory budgets reject independently of sample contents', () => {
  const tooMany = fixture({ counts: [700_000, 600_000], delta: 1 });
  assert.throws(() => parseSceneMovie(tooMany.data.subarray(0, tooMany.bootstrap), tooMany.size), /Aggregate sample count/);
  const tooLarge = fixture({ counts: [1_199_999, 1], delta: 1, declaredComposition: true });
  assert.throws(() => parseSceneMovie(tooLarge.data.subarray(0, tooLarge.bootstrap), tooLarge.size), /Declared packed data/);
});

test('co64 and an extended mdat retain exact offsets above 4 GiB', () => {
  const start = 2 ** 32 + 128;
  const sourceLength = start + 30;
  const moov = box('moov', movieHeader(3000), track(true, start, idr.length, 3, { wide: true }),
    track(false, start + 18, 4, 3, { wide: true }));
  const extended = Buffer.alloc(16);
  extended.writeUInt32BE(1);
  extended.write('mdat', 4);
  extended.writeBigUInt64BE(BigInt(sourceLength - ftyp.length - moov.length), 8);
  const prefix = Buffer.concat([ftyp, moov, extended]);
  assert.equal(bootstrapNeeded(prefix, sourceLength), prefix.length);
  const scene = selectScene(parseSceneMovie(prefix, sourceLength), 1100, 300, { readAheadMs: 0 });
  assert.deepEqual(scene.ranges, [[0, prefix.length], [start, start + 12], [start + 18, start + 26]]);
});

test('reusing the caller prefix cannot change the retained size table or ranges', () => {
  const { bootstrap, data, size } = fixture({ variable: true });
  const prefix = data.subarray(0, bootstrap);
  const movie = parseSceneMovie(prefix, size);
  const before = selectScene(movie, 1100, 300);
  prefix.fill(0);
  assert.deepEqual(selectScene(movie, 1100, 300), before);
});

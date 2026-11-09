import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STUDIO_PAIRINGS_KEY, activeStudioCue, createStudioCueIndex, decodeStudioSubtitle,
  primaryStudioCues, readStudioPairings, removeStudioPairing, saveStudioPairing, studioJumpTarget,
  studioOffsetMs, studioOverlap, studioPairKey, studioSeekLanded, writeStudioPairings
} from '../public/two-track-model.js';

const fileKey = 'a'.repeat(40) + ':0';
const primaryId = 'b'.repeat(32);
const base = {
  fileKey, primaryId, primaryDigest: 'c'.repeat(64), secondaryId: 'd'.repeat(32),
  secondaryDigest: 'e'.repeat(64), name: '제2 자막.srt', offsetMs: -250
};
const utf8 = new TextEncoder();
const subtitle = '00:00:01.000 --> 00:00:02.000\n안녕하세요 🌙';
function utf16(text, littleEndian) {
  const result = new Uint8Array(text.length * 2 + 2);
  result.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  const view = new DataView(result.buffer);
  for (let i = 0; i < text.length; i += 1) view.setUint16(i * 2 + 2, text.charCodeAt(i), littleEndian);
  return result;
}

test('decodes strict UTF-8 and both BOM-marked UTF-16 byte orders', () => {
  assert.equal(decodeStudioSubtitle(utf8.encode(subtitle).buffer), subtitle);
  assert.equal(decodeStudioSubtitle(utf8.encode('\uFEFF' + subtitle)), subtitle);
  assert.equal(decodeStudioSubtitle(utf16(subtitle, true)), subtitle);
  assert.equal(decodeStudioSubtitle(utf16(subtitle, false)), subtitle);
  const shifted = Uint8Array.from([0xff, ...utf8.encode(subtitle), 0xff]);
  assert.equal(decodeStudioSubtitle(shifted.subarray(1, -1)), subtitle);
});

test('rejects oversized, invalid, NUL-containing and unsupported subtitle encodings', () => {
  assert.equal(decodeStudioSubtitle(utf8.encode('a'.repeat(1024 * 1024))).length, 1024 * 1024);
  assert.throws(() => decodeStudioSubtitle(new Uint8Array(1024 * 1024 + 1)), /1 MiB/i);
  assert.throws(() => decodeStudioSubtitle(Uint8Array.of(0xc3, 0x28)), /UTF/i);
  assert.throws(() => decodeStudioSubtitle(Uint8Array.of(0xff, 0xfe, 0x61)), /UTF/i);
  assert.throws(() => decodeStudioSubtitle(Uint8Array.of(0xff, 0xfe, 0x00, 0xd8)), /UTF/i);
  assert.throws(() => decodeStudioSubtitle(Uint8Array.of(0xff, 0xfe, 0, 0, 0x61, 0, 0, 0)), /UTF/i);
  assert.throws(() => decodeStudioSubtitle(utf16('text', true).subarray(2)), /UTF/i);
  assert.throws(() => decodeStudioSubtitle(utf8.encode('  ')), /text/i);
  assert.throws(() => decodeStudioSubtitle(null), /file/i);
});

test('copies original primary tuples in milliseconds without accessing live cue timing', () => {
  const native = { get startTime() { assert.fail('offset-applied live cue was read'); } };
  const rows = Object.freeze([Object.freeze([native, 1.0246, 3.2, '  A   line  '])]);
  assert.deepEqual(primaryStudioCues(rows), [[1025, 3200, '  A   line  ']]);
  assert.equal(primaryStudioCues([[native, 2, 1, 'bad']]), null);
  assert.equal(primaryStudioCues([[native, 1, 1.0001, 'submillisecond collapsed range']]), null);
  assert.equal(primaryStudioCues([[native, 0, 1, 'a'.repeat(1024 * 1024 + 1)]]), null);
  assert.equal(primaryStudioCues(new Array(64_001)), null);
  assert.equal(createStudioCueIndex(new Array(64_001)), null);
});

test('uses half-open intervals, no nearby line, independent offsets and exact clipping', () => {
  const first = createStudioCueIndex([[1000, 2000, 'One'], [2200, 2300, 'Next']]);
  const second = createStudioCueIndex([[1800, 2700, 'اثنان']]);
  const firstAt = time => activeStudioCue(first, time, -1200);
  const secondAt = time => activeStudioCue(second, time, -1700);
  assert.deepEqual(firstAt(0), { startMs: 0, endMs: 800, activeStartMs: 0, activeEndMs: 800, text: 'One' });
  assert.equal(firstAt(799.9).text, 'One');
  assert.equal(firstAt(800), null);
  assert.equal(firstAt(999.99), null);
  assert.equal(firstAt(1000).text, 'Next');
  assert.equal(firstAt(1100), null);
  assert.equal(secondAt(99.9), null);
  assert.equal(secondAt(100).text, 'اثنان');
  assert.deepEqual(studioOverlap(firstAt(100), secondAt(100)), { startMs: 100, endMs: 800 });
  assert.equal(studioOverlap(firstAt(50), secondAt(50)), null);
  assert.equal(activeStudioCue(createStudioCueIndex([[500, 1000, 'expired']]), 0, -1000), null);
  assert.equal(activeStudioCue(first, 2000, NaN), null);
});

test('uses identical canonical priority for raw primary and detached secondary cues', () => {
  const tuples = [
    [500, 2200, 'Background'],
    [1000, 2000, 'Earlier end wins regardless of text until a shorter cue starts'],
    [1000, 1500, '\u{10000} astral'],
    [1000, 1500, '\uE000 BMP'],
    [1000, 1700, 'A longer end loses']
  ];
  const rawPrimary = tuples.map(([start, end, text]) => [null, start / 1000, end / 1000, text]);
  const a = createStudioCueIndex(primaryStudioCues(rawPrimary));
  const b = createStudioCueIndex([...tuples].reverse());
  for (const [time, expected] of [
    [999, 'Background'], [1000, '\uE000 BMP'], [1499.99, '\uE000 BMP'],
    [1500, 'A longer end loses'], [1700, 'Earlier end wins regardless of text until a shorter cue starts'],
    [2000, 'Background'], [2200, undefined]
  ]) {
    assert.equal(activeStudioCue(a, time)?.text, expected);
    assert.deepEqual(activeStudioCue(a, time), activeStudioCue(b, time));
  }
  assert.equal(activeStudioCue(a, 0, -1200).text, '\uE000 BMP', 'different starts clipped to zero preserve authored start priority');
});

test('winning spans stop at a competing cue and resume as a different effective span', () => {
  const first = createStudioCueIndex([[0, 5000, 'Long'], [1000, 1500, 'Interruption']]);
  const second = createStudioCueIndex([[0, 5000, 'Other']]);
  const other = activeStudioCue(second, 2100);
  const before = activeStudioCue(first, 800);
  const during = activeStudioCue(first, 1200);
  const after = activeStudioCue(first, 2100);
  assert.deepEqual([before.activeStartMs, before.activeEndMs], [0, 1000]);
  assert.deepEqual([during.activeStartMs, during.activeEndMs], [1000, 1500]);
  assert.deepEqual([after.activeStartMs, after.activeEndMs], [1500, 5000]);
  assert.equal(after.text, before.text);
  assert.deepEqual(studioOverlap(after, other), { startMs: 1500, endMs: 5000 });
  assert.equal(studioJumpTarget(studioOverlap(after, other)), 1550);
  assert.equal(studioJumpTarget({ startMs: 0, endMs: 199 }), null);
  assert.equal(studioJumpTarget({ startMs: 0, endMs: 200 }), 50);
});

test('confirms a seek only with current identity and actual fractional landing within the exact overlap', () => {
  const overlap = { startMs: 1500, endMs: 2000 };
  const landed = (positionMs, moved = true, current = true) => studioSeekLanded({ positionMs, moved, current, overlap });
  assert.equal(landed(1499.999), false);
  assert.equal(landed(1500), true);
  assert.equal(landed(1999.999), true);
  assert.equal(landed(2000), false);
  assert.equal(landed(1550, false), false);
  assert.equal(landed(1550, true, false), false);
  assert.equal(landed(Infinity), false);
});

test('validates second-track offset as finite input in the approved range', () => {
  assert.equal(studioOffsetMs(0.1236), 124);
  assert.equal(studioOffsetMs(-0.25), -250);
  assert.equal(studioOffsetMs(-120), -120_000);
  assert.equal(studioOffsetMs(120), 120_000);
  assert.equal(studioOffsetMs(-0), 0);
  for (const value of [Infinity, NaN, 120.001, -120.001, '', '2', null]) assert.equal(studioOffsetMs(value), null);
});

test('keys preferences by exact local file and primary, limits names, and stores no extra fields', () => {
  assert.equal(STUDIO_PAIRINGS_KEY, 'cinema-two-track-v1');
  assert.equal(studioPairKey(fileKey, primaryId), fileKey + ':' + primaryId);
  assert.equal(studioPairKey('a'.repeat(64) + ':2', primaryId), 'a'.repeat(64) + ':2:' + primaryId);
  for (const key of ['a'.repeat(41) + ':0', 'a'.repeat(40) + ':01', 'a'.repeat(40) + ':-1',
    'a'.repeat(40) + ':9007199254740992', '../file:0']) assert.equal(studioPairKey(key, primaryId), null);
  assert.equal(studioPairKey(fileKey, 'B'.repeat(32)), null);
  const unrelated = { ...base, primaryId: 'f'.repeat(32), name: 'Another track' };
  const filename = '🎞'.repeat(65);
  const pairings = saveStudioPairing([base, unrelated], { ...base, name: filename, offsetMs: 1000, cues: ['private'] });
  const expected = [unrelated, { ...base, name: '🎞'.repeat(60), offsetMs: 1000 }];
  assert.deepEqual(pairings, expected);
  const text = writeStudioPairings(pairings);
  assert.equal(text.includes('private'), false);
  assert.deepEqual(readStudioPairings(text), expected);
  assert.deepEqual(removeStudioPairing(pairings, fileKey, primaryId), [unrelated]);
  assert.equal(base.offsetMs, -250);
});

test('ignores corrupt pairs without disturbing valid records and rejects malformed envelopes', () => {
  const valid = JSON.parse(writeStudioPairings([base]));
  const invalid = [
    { ...base, secondaryDigest: 'z'.repeat(64) },
    { ...base, secondaryDigest: base.primaryDigest },
    { ...base, secondaryId: base.primaryId },
    { ...base, name: '../secret.vtt' },
    { ...base, name: 'x'.repeat(61) },
    { ...base, offsetMs: 1.25 },
    { ...base, offsetMs: 120_001 },
    { ...base, transcript: 'private cue' }
  ];
  assert.deepEqual(readStudioPairings(JSON.stringify({ ...valid, pairings: [...invalid, base] })), [base]);
  assert.deepEqual(readStudioPairings(JSON.stringify({ ...valid, version: 2 })), []);
  assert.deepEqual(readStudioPairings(JSON.stringify({ ...valid, extra: true })), []);
  assert.deepEqual(readStudioPairings('{'), []);
  assert.deepEqual(readStudioPairings(null), []);
  assert.deepEqual(saveStudioPairing([base], invalid[1]), [base]);
});

test('enforces recent whole-record and serialized UTF-8 limits', () => {
  const rows = Array.from({ length: 38 }, (_, index) => ({
    ...base, fileKey: 'a'.repeat(40) + ':' + index, name: '🎞'.repeat(57) + index
  }));
  const serialized = writeStudioPairings(rows);
  const pairs = readStudioPairings(serialized);
  assert.equal(pairs.length, 32);
  assert.equal(pairs[0].fileKey, 'a'.repeat(40) + ':6');
  assert.equal(pairs.at(-1).fileKey, 'a'.repeat(40) + ':37');
  assert.ok(utf8.encode(serialized).byteLength <= 24 * 1024);

  const oversizedUtf8 = JSON.stringify({ version: 1, pairings: [base, { ...base, name: '界'.repeat(8200) }] });
  assert.ok(oversizedUtf8.length < 24 * 1024);
  assert.ok(utf8.encode(oversizedUtf8).byteLength > 24 * 1024);
  assert.deepEqual(readStudioPairings(oversizedUtf8), []);
});

test('compares fractional positions directly against adjusted half-open cue boundaries', () => {
  const index = createStudioCueIndex([[120_000, 120_200, 'Before'], [120_200, 120_400, 'After']]);
  assert.equal(activeStudioCue(index, 199.99999999999997, -120_000)?.text, 'Before');
  assert.equal(activeStudioCue(index, 200, -120_000)?.text, 'After');
});

test('a bounded display name can round-trip when its last retained character is whitespace', () => {
  const prefix = 'x'.repeat(59);
  const text = writeStudioPairings([{ ...base, name: prefix + ' Extra' }]);
  assert.deepEqual(readStudioPairings(text), [{ ...base, name: prefix }]);
});

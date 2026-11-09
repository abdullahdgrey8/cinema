import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catchUpPassage,
  containsCoverage,
  coveredCaptionRanges,
  createCoverageWitness,
  mergeCoverage,
  readCoverageStore,
  writeCoverageStore
} from '../public/watched-coverage.js';

const hash = 'a'.repeat(40);
const binding = { id: 'b'.repeat(32), digest: 'c'.repeat(64), offsetMs: 0 };
const proof = { kind: 'sealed', seal: 'd'.repeat(64), timeline: { mode: 'direct', offsetMs: 0, run: null } };
const captions = (ranges, identity = binding) => ({ ...identity, ranges });
const record = (overrides = {}) => ({ hash, index: 0, proof, updatedAt: 1, video: [], caption: null, ...overrides });
const take = (witness, wallMs, mediaMs, played, caption = { ...binding, showing: true }, extra = {}) =>
  witness.observe({ wallMs, mediaMs, rate: 1, played, caption, ...extra });

test('showing captions alone do not witness a range', () => {
  const witness = createCoverageWitness();
  take(witness, 0, 1000, [[0, 10_000]]);
  take(witness, 1000, 1000, [[0, 10_000]]);
  take(witness, 2000, 2000, [[0, 10_000]], { ...binding, showing: true }, { eligible: false });
  assert.deepEqual(witness.snapshot(), { video: [], caption: captions([]) });
});

test('intersects the whole continuous witness with late played endpoints and never overshoots the last frame', () => {
  const witness = createCoverageWitness();
  take(witness, 0, 0, []);
  take(witness, 1000, 1000, [[0, 500]]);
  assert.deepEqual(witness.snapshot().video, [[0, 500]]);
  take(witness, 2000, 2000, [[0, 1700]]);
  witness.boundary([[0, 2500]]);
  assert.deepEqual(witness.snapshot(), { video: [[0, 2000]], caption: captions([[0, 2000]]) });
  const snapshot = witness.snapshot();
  snapshot.video[0][1] = 6000;
  snapshot.caption.ranges.length = 0;
  assert.deepEqual(witness.snapshot(), { video: [[0, 2000]], caption: captions([[0, 2000]]) });
});

test('lifecycle boundary preserves a subthreshold seek gap even when played merges the ranges', () => {
  const witness = createCoverageWitness();
  take(witness, 0, 0, []);
  take(witness, 1000, 1000, [[0, 950]]);
  witness.boundary([[0, 2300]]);
  take(witness, 1020, 1100, [[0, 2300]]);
  take(witness, 1920, 2000, [[0, 2300]]);
  assert.deepEqual(witness.snapshot(), {
    video: [[0, 1000], [1100, 2000]],
    caption: captions([[0, 1000], [1100, 2000]])
  });
  assert.equal(containsCoverage(witness.snapshot().video, 900, 1200), false);
});

test('sampling gaps, rate changes, and excessive advances cannot bridge unwitnessed time', () => {
  const witness = createCoverageWitness();
  take(witness, 0, 0, [[0, 20_000]]);
  take(witness, 1000, 1000, [[0, 20_000]]);
  take(witness, 2201, 2201, [[0, 20_000]]);
  take(witness, 2401, 2601, [[0, 20_000]], null, { rate: 2 });
  take(witness, 2801, 3800, [[0, 20_000]], null, { rate: 2 });
  take(witness, 3301, 4800, [[0, 20_000]], null, { rate: 2 });
  assert.deepEqual(witness.snapshot(), { video: [[0, 1000], [3800, 4800]], caption: null });
});

test('hidden captions break their interval, and a changed binding clears captions without dropping video', () => {
  const witness = createCoverageWitness();
  const showing = { ...binding, showing: true };
  take(witness, 0, 0, [], showing);
  take(witness, 1000, 1000, [[0, 800]], showing);
  take(witness, 2000, 2000, [[0, 1900]], { ...showing, showing: false });
  take(witness, 3000, 3000, [[0, 3000]], showing);
  take(witness, 4000, 4000, [[0, 4000]], showing);
  assert.deepEqual(witness.snapshot(), { video: [[0, 4000]], caption: captions([[0, 1000], [3000, 4000]]) });

  const shifted = { ...binding, offsetMs: 200 };
  take(witness, 5000, 5000, [[0, 5000]], { ...shifted, showing: true });
  take(witness, 6000, 6000, [[0, 6000]], { ...shifted, showing: true });
  const evidence = witness.snapshot();
  assert.deepEqual(evidence, { video: [[0, 6000]], caption: captions([[5000, 6000]], shifted) });
  assert.deepEqual(coveredCaptionRanges(evidence, binding), []);
  assert.deepEqual(coveredCaptionRanges(evidence, shifted), [[5000, 6000]]);
  assert.deepEqual(coveredCaptionRanges(evidence, { ...shifted, digest: 'e'.repeat(64) }), []);
});

test('each group independently evicts oldest whole intervals, and only their surviving intersection is eligible', () => {
  const witness = createCoverageWitness();
  for (let i = 0; i < 65; i += 1) {
    const at = i * 2000;
    const shown = { ...binding, showing: i === 0 || i === 64 };
    take(witness, at, at, [[at, at + 1000]], shown);
    take(witness, at + 1000, at + 1000, [[at, at + 1000]], shown);
    witness.boundary();
  }
  const evidence = witness.snapshot();
  assert.equal(evidence.video.length, 64);
  assert.deepEqual(evidence.video[0], [2000, 3000]);
  assert.deepEqual(evidence.caption.ranges, [[0, 1000], [128_000, 129_000]]);
  assert.deepEqual(coveredCaptionRanges(evidence, binding), [[128_000, 129_000]]);

  const captionHeavy = createCoverageWitness();
  for (let i = 0; i <= 130; i += 1) {
    const at = i * 1000;
    take(captionHeavy, at, at, [[0, at]], { ...binding, showing: i % 2 === 1 || i === 130 });
    if (i > 0 && i % 2 === 1) {
      take(captionHeavy, at + 500, at + 500, [[0, at + 500]], { ...binding, showing: true });
    }
  }
  const captionEvidence = captionHeavy.snapshot();
  assert.deepEqual(captionEvidence.video, [[0, 130_000]]);
  assert.equal(captionEvidence.caption.ranges.length, 64);
  assert.deepEqual(captionEvidence.caption.ranges[0], [3000, 3500]);
  assert.equal(containsCoverage(coveredCaptionRanges(captionEvidence, binding), 1000, 1500), false);
});

test('store serializes inward in 250 ms ticks and requires both cue endpoints', () => {
  const evidence = record({
    video: [[101, 1124], [2100, 2400]],
    caption: captions([[151, 1090], [2120, 2360]])
  });
  const serialized = writeCoverageStore([evidence]);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.records[0].video, [[1, 4]]);
  assert.deepEqual(parsed.records[0].caption.ranges, [[1, 4]]);
  const [decoded] = readCoverageStore(serialized);
  assert.deepEqual(decoded.video, [[250, 1000]]);
  const eligible = coveredCaptionRanges(decoded, binding);
  assert.equal(containsCoverage(eligible, 250, 1000), true);
  assert.equal(containsCoverage(eligible, 249, 500), false);
  assert.equal(containsCoverage(eligible, 500, 1001), false);
  assert.deepEqual(evidence.video, [[101, 1124], [2100, 2400]]);
});

test('merge is detached and exact proof or caption mismatch cannot carry old evidence', () => {
  const prior = record({ video: [[0, 1000]], caption: captions([[0, 1000]]) });
  const batch = record({ updatedAt: 2, video: [[900, 1700]], caption: captions([[900, 1700]]) });
  const merged = mergeCoverage([prior], batch);
  assert.deepEqual(merged[0].video, [[0, 1700]]);
  assert.deepEqual(merged[0].caption.ranges, [[0, 1700]]);
  assert.deepEqual(prior.video, [[0, 1000]]);
  assert.deepEqual(batch.video, [[900, 1700]]);

  const shifted = mergeCoverage(merged, { ...batch, caption: captions([[900, 1700]], { ...binding, offsetMs: 250 }) });
  assert.deepEqual(shifted[0].video, [[0, 1700]]);
  assert.deepEqual(shifted[0].caption.ranges, [[900, 1700]]);
  assert.deepEqual(coveredCaptionRanges(shifted[0], binding), []);
  assert.equal(mergeCoverage(shifted, { ...batch, caption: null })[0].caption, null);

  const changedSeal = { ...proof, seal: 'e'.repeat(64) };
  assert.deepEqual(mergeCoverage(merged, { ...batch, proof: changedSeal })[0].video, [[900, 1700]]);
  const firstRun = { ...proof, timeline: { mode: 'hls', offsetMs: 0, run: 'a'.repeat(12) } };
  const nextRun = { ...firstRun, timeline: { ...firstRun.timeline, run: 'b'.repeat(12) } };
  const priorRun = [{ ...prior, proof: firstRun }];
  assert.deepEqual(mergeCoverage(priorRun, { ...batch, proof: nextRun })[0].video, [[900, 1700]]);
  assert.deepEqual(mergeCoverage([prior], { ...batch, proof: { ...proof, kind: 'volatile' } }), [prior]);
});

test('bad version, shape, ranges, duplicate records, count and byte size fail closed', () => {
  const valid = JSON.parse(writeCoverageStore([record({ video: [[0, 1000]] })]));
  assert.deepEqual(readCoverageStore('{'), []);
  assert.deepEqual(readCoverageStore(' '.repeat(128 * 1024 + 1)), []);
  assert.deepEqual(readCoverageStore(JSON.stringify({ ...valid, version: 2 })), []);
  assert.deepEqual(readCoverageStore(JSON.stringify({ ...valid, extra: true })), []);
  assert.deepEqual(readCoverageStore(JSON.stringify({ ...valid, records: [valid.records[0], valid.records[0]] })), []);
  assert.deepEqual(readCoverageStore(JSON.stringify({
    ...valid, records: Array.from({ length: 49 }, (_, index) => ({ ...valid.records[0], index }))
  })), []);
  for (const video of [[[0, -1]], [[1, 1]], [[0, 1.5]], [[0, Number.MAX_SAFE_INTEGER]], [[0, 4], [3, 5]],
    Array.from({ length: 65 }, (_, index) => [index * 2, index * 2 + 1])]) {
    assert.deepEqual(readCoverageStore(JSON.stringify({
      ...valid, records: [{ ...valid.records[0], video }]
    })), []);
  }
  const rawCaption = { ...captions([[0, 4]]), text: 'Do not persist this' };
  assert.deepEqual(readCoverageStore(JSON.stringify({
    ...valid, records: [{ ...valid.records[0], caption: rawCaption }]
  })), []);
});

test('writer enforces count and UTF-8 byte caps by dropping oldest complete records', () => {
  const plain = Array.from({ length: 51 }, (_, index) => record({ index, updatedAt: index, video: [[0, 1000]] }));
  const limited = readCoverageStore(writeCoverageStore(plain));
  assert.equal(limited.length, 48);
  assert.equal(limited[0].index, 3);
  assert.equal(limited.at(-1).index, 50);

  const largeRanges = Array.from({ length: 64 }, (_, index) => {
    const base = 8_000_000_000_000_000 + index * 1000;
    return [base, base + 500];
  });
  const large = plain.map(item => ({ ...item, video: largeRanges, caption: captions(largeRanges) }));
  const serialized = writeCoverageStore(large);
  const decoded = readCoverageStore(serialized);
  assert.ok(Buffer.byteLength(serialized) <= 128 * 1024);
  assert.ok(decoded.length > 0 && decoded.length < 48);
  assert.equal(decoded.at(-1).index, 50);
  assert.equal(decoded[0].index, 51 - decoded.length);
  assert.equal(decoded[0].video.length, 64);
  assert.equal(decoded[0].caption.ranges.length, 64);
});

test('Catch Up selects the most recent continuous passage, clips to resume, and returns at most 45 seconds', () => {
  const video = [[70_000, 180_000], [0, 50_000], [195_000, 220_000]];
  assert.deepEqual(catchUpPassage(video, 155_000), [110_000, 155_000]);
  assert.deepEqual(catchUpPassage(video, 190_000), [135_000, 180_000]);
  assert.deepEqual(catchUpPassage(video, 205_000), [195_000, 205_000]);
  assert.equal(catchUpPassage([[1000, 5000]], 1000), null);
});

test('late older batches cannot replace newer binding evidence, and malformed in-memory intervals are ignored', () => {
  const current = record({ updatedAt: 10, video: [[0, 1000]] });
  const late = record({ updatedAt: 9, proof: { ...proof, seal: 'e'.repeat(64) }, video: [[2000, 3000]] });
  assert.deepEqual(mergeCoverage([current], late), [current]);

  const sparse = record({ updatedAt: 11, video: new Array(2) });
  assert.deepEqual(mergeCoverage([current], sparse), [current]);
  assert.deepEqual(readCoverageStore(writeCoverageStore([current, sparse])), [current]);
  assert.deepEqual(readCoverageStore(writeCoverageStore([{ ...current, displayTitle: 'Private title' }])), [current]);
});

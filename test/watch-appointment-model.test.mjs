import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendAppointmentSample,
  classifyAppointmentDeadline,
  estimateAppointment,
  localAppointmentInput,
  parseAppointmentDeadline,
} from '../public/watch-appointment-model.js';

const MiB = 1024 * 1024;
const file = (downloaded, extra = {}) => ({
  key: 'primary',
  status: 'downloading',
  size: 32 * MiB,
  downloaded,
  ...extra,
});

function collect(observations) {
  return observations.reduce(
    (samples, [observedMs, downloaded, extra]) => appendAppointmentSample(samples, file(downloaded, extra), observedMs),
    [],
  );
}

test('local deadline round trips across midnight and is limited to the next 12 hours', () => {
  const now = new Date(2026, 10, 9, 23, 25, 0, 0).getTime();
  const nextDay = new Date(2026, 10, 10, 0, 5, 0, 0).getTime();
  assert.equal(localAppointmentInput(nextDay), '2026-11-10T00:05');
  assert.equal(localAppointmentInput(NaN), '');
  assert.equal(parseAppointmentDeadline('2026-11-10T00:05', now), nextDay);
  assert.equal(parseAppointmentDeadline('2026-11-09T23:25', now), null);
  assert.equal(parseAppointmentDeadline(localAppointmentInput(now + 60_000), now + 59_999), now + 60_000);
  assert.equal(parseAppointmentDeadline(localAppointmentInput(now + 12 * 3_600_000), now), now + 12 * 3_600_000);
  assert.equal(parseAppointmentDeadline(localAppointmentInput(now + 12 * 3_600_000 + 60_000), now), null);
  assert.equal(parseAppointmentDeadline('2026-11-10T00:05', Infinity), null);
  for (const value of ['', '2026-11-10 00:05', '2026-11-10T00:05Z', '2026-11-10T00:05:00', '2026-11-09T24:00']) {
    assert.equal(parseAppointmentDeadline(value, now), null, value);
  }
  const february = new Date(2026, 1, 28, 23, 0).getTime();
  assert.equal(parseAppointmentDeadline('2026-02-29T00:00', february), null);
});

test('local deadline rejects DST gaps and folds, including half-hour folds', () => {
  const previousTz = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const spring = new Date(2026, 2, 8, 0, 0).getTime();
    const autumn = new Date(2026, 10, 1, 0, 0).getTime();
    assert.equal(parseAppointmentDeadline('2026-03-08T02:30', spring), null);
    assert.equal(parseAppointmentDeadline('2026-11-01T01:30', autumn), null);
    assert.equal(parseAppointmentDeadline('2026-03-08T03:00', spring), new Date(2026, 2, 8, 3).getTime());
    assert.equal(parseAppointmentDeadline('2026-11-01T02:00', autumn), new Date(2026, 10, 1, 2).getTime());

    process.env.TZ = 'Australia/Lord_Howe';
    const halfHourAutumn = new Date(2026, 3, 5, 0, 0).getTime();
    assert.equal(parseAppointmentDeadline('2026-04-05T01:45', halfHourAutumn), null);
    assert.equal(parseAppointmentDeadline('2026-04-05T02:00', halfHourAutumn), new Date(2026, 3, 5, 2).getTime());
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('four positive exact-file samples produce outward-rounded minutes and retain only four points', () => {
  const samples = collect([[10, MiB], [12_010, 2 * MiB], [24_010, 4 * MiB], [36_010, 5 * MiB]]);
  assert.deepEqual(samples[3], { key: 'primary', size: 32 * MiB, downloaded: 5 * MiB, observedMs: 36_010 });
  assert.equal(estimateAppointment(samples.slice(0, 3)), null);
  assert.deepEqual(estimateAppointment(samples), { earlyMinutes: 2, lateMinutes: 9 });
  const next = appendAppointmentSample(samples, file(6 * MiB), 48_010);
  assert.equal(samples[0].observedMs, 10);
  assert.equal(next.length, 4);
  assert.equal(next[0].observedMs, 12_010);
});

test('sample history drops across pauses, identity changes, stale checks, and weak progress', () => {
  const samples = collect([[100, MiB], [12_100, 2 * MiB], [24_100, 3 * MiB]]);
  assert.deepEqual(appendAppointmentSample(samples, null, 36_100), []);
  assert.deepEqual(appendAppointmentSample(samples, file(3 * MiB, { status: 'paused' }), 36_100), []);
  assert.deepEqual(appendAppointmentSample(samples, file(3 * MiB, { status: 'ready' }), 36_100), []);
  assert.deepEqual(appendAppointmentSample(samples, file(32 * MiB), 36_100), []);
  assert.deepEqual(appendAppointmentSample(samples, file(4 * MiB), 24_100), []);
  assert.deepEqual(appendAppointmentSample(samples, file(4 * MiB), 23_000), []);
  assert.deepEqual(appendAppointmentSample(samples, file(4 * MiB), NaN), []);
  for (const [incoming, at] of [
    [file(4 * MiB, { key: 'replacement' }), 36_100],
    [file(4 * MiB, { size: 33 * MiB }), 36_100],
    [file(2 * MiB), 36_100],
    [file(3 * MiB), 36_100],
    [file(3 * MiB + 256 * 1024 - 1), 36_100],
    [file(4 * MiB), 32_099],
    [file(4 * MiB), 44_101],
  ]) {
    const next = appendAppointmentSample(samples, incoming, at);
    assert.equal(next.length, 1);
    assert.equal(next[0].observedMs, at);
    assert.equal(estimateAppointment(next), null);
  }
  const large = { size: 100_000 * MiB };
  assert.equal(collect([[0, 0, large], [12_000, MiB - 1, large]]).length, 1);
  assert.equal(collect([[0, 0, large], [12_000, MiB, large]]).length, 2);
});

test('the estimate rejects short, unstable, very wide and very distant samples', () => {
  const short = collect([[0, 0], [8_000, MiB], [16_000, 2 * MiB], [24_000, 3 * MiB]]);
  assert.equal(short.length, 4);
  assert.equal(estimateAppointment(short), null);
  const invalidRate = collect([[0, 0], [10_000, MiB], [20_000, 2 * MiB], [30_000, 5 * MiB]]);
  assert.equal(invalidRate.length, 1);
  const threshold = collect([[0, 0], [10_000, MiB], [20_000, 2 * MiB], [30_000, 4.5 * MiB]]);
  assert.equal(threshold.length, 4);
  assert.ok(estimateAppointment(threshold));

  const observations = (size) => [[0, 0], [12_000, MiB], [24_000, 2 * MiB], [36_000, 3 * MiB]].map(
    ([time, bytes]) => [time, bytes, { size }],
  );
  assert.equal(estimateAppointment(collect(observations(1500 * MiB))), null);
  assert.equal(estimateAppointment(collect(observations(2500 * MiB))), null);
  assert.equal(estimateAppointment([...threshold.slice(0, 3), { ...threshold[3], key: 'other' }]), null);
});

test('deadline uses only a recent applicable pre-deadline outcome', () => {
  const due = 200_000;
  const known = { due, checkedAt: due - 20_000, status: 'ready', available: true };
  assert.equal(classifyAppointmentDeadline(known), 'ready');
  assert.equal(classifyAppointmentDeadline({ ...known, checkedAt: due }), 'ready');
  assert.equal(classifyAppointmentDeadline({ ...known, status: 'downloading' }), 'waiting');
  assert.equal(classifyAppointmentDeadline({ ...known, status: 'paused' }), 'waiting');
  assert.equal(classifyAppointmentDeadline({ ...known, status: 'on-disk' }), 'waiting');
  for (const update of [
    { checkedAt: due - 20_001 }, { checkedAt: due + 1 }, { checkedAt: null }, { due: Infinity },
    { available: false }, { status: 'disconnected' }, { status: 'unavailable' }, { status: 'finding' }, { status: undefined },
  ]) {
    assert.equal(classifyAppointmentDeadline({ ...known, ...update }), 'unconfirmed');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSoundIndex, parseSoundLine, projectSoundCues } from '../public/sound-cues.js';

const row = (raw, start, end, decoded = raw, onDecode = () => {}) => [{
  text: raw,
  getCueAsHTML() {
    onDecode();
    return { textContent: decoded };
  }
}, start, end, 'ordinary Scene Finder and Watched Dialogue input'];

test('recognizes only supported bracketed phrases and preserves normalized author case', () => {
  const accepted = [
    'Door slams', 'Knocking', 'Applause', 'Distant sirens', 'Music', 'Thunder', 'phone rings',
    'glass breaks', 'footsteps', 'wind howls', 'laughter', 'upbeat music playing', 'Loud distant thunder'
  ];
  for (const label of accepted) assert.equal(parseSoundLine(' [' + label + '] '), label);
  assert.equal(parseSoundLine('\t[Door\u00a0 \tslams] '), 'Door slams');
  assert.equal(parseSoundLine('[KnOcKiNg]'), 'KnOcKiNg');

  const rejected = [
    '[MARA]', '[MAN:]', '[whispering]', '[Music video]', '[Door slams before Mara falls]', '[Door slams] Wait',
    '[Footsteps] [Knocking]', '[door 2]', '[https://example.com]', '♪ a lyric ♪', '(Thunder)', 'Thunder',
    'MAN: [door slams]', '[Door\nslams]', '[Door\u2028slams]', '[upbeat thunder]', '[soft loud distant thunder]',
    '[[Music]]', '[Knocking]', '[' + 'Music '.repeat(16) + 'playing]'
  ];
  for (const label of rejected) assert.equal(parseSoundLine(label), null, label);
});

test('uses browser-decoded full lines and keeps native cues and existing witness tuples unchanged', async () => {
  let decodes = 0;
  const rows = [
    row('Hello.\r\n<i>[Glass breaks]</i>\r\n[Door\u00a0slams]\r\nWait. [knocking]',
      2, 3, 'Hello.\r\n[Glass breaks]\r\n[Door\u00a0slams]\r\nWait. [knocking]', () => decodes++),
    row('No square brackets and no sound line.', 0, 1, '[Music]', () => decodes++),
    row('[Footsteps] [Knocking]', 3, 4),
    row('[Door\nslams]', 4, 5),
    row('[Door\u2028slams]', 4, 5),
    row('<v Mara>[Knocking]</v>\nSpeaker: hello.', 4, 5, '[Knocking]\nSpeaker: hello.'),
    row('[MARA]\n[Music video]', 5, 6)
  ];
  for (const tuple of rows) Object.freeze(tuple[0]), Object.freeze(tuple);
  Object.freeze(rows);
  const index = await buildSoundIndex({ rows, offset: 0 });
  assert.equal(decodes, 1, 'ordinary dialogue must never create a browser cue fragment');
  assert.deepEqual(index.cues.map(({ label, startMs, endMs }) => [label, startMs, endMs]), [
    ['Glass breaks', 2000, 3000], ['Door slams', 2000, 3000], ['Knocking', 4000, 5000]
  ]);
  assert.equal(rows[0][3], 'ordinary Scene Finder and Watched Dialogue input');
  assert.equal(rows[0][0].text.includes('<i>'), true);
  assert.equal(index.limited, false);
});

test('fails closed for unavailable browser decoding and raw HTML lookalikes', async () => {
  const index = await buildSoundIndex({
    rows: [
      [{ text: '[Music]' }, 0, 1],
      [{ text: '[Music]', getCueAsHTML() { throw Error('removed cue'); } }, 1, 2],
      row('<i>[music]</i>', 2, 3, '<i>[music]</i>'),
      row('[door slams]', 3, 4, null)
    ],
    offset: 0
  });
  assert.deepEqual(index.cues, []);
});

test('shifts original timing, clips crossings at zero, and drops expired or rounded-empty ranges', async () => {
  const rows = [
    row('[music]', 0, 1),
    row('[glass breaks]', 0.4, 1.25),
    row('[footsteps]', 1.0001, 1.0002),
    row('[Knocking]', 1.25, 1.5),
    row('[thunder]', NaN, 4),
    row('[Applause]', 5, 4)
  ];
  const index = await buildSoundIndex({ rows, offset: -1 });
  assert.deepEqual(index.cues.map(({ label, startMs, endMs }) => [label, startMs, endMs]), [
    ['glass breaks', 0, 250],
    ['Knocking', 250, 500]
  ]);
});

test('dedupes exact normalized labels and adjusted time, keeps different cases or ranges, and orders ties', async () => {
  const rows = [
    row('[Music]', 7, 8),
    row('[Door  slams]\n[Door slams]\n[door slams]', 1, 3),
    row('[Door slams]', 1, 2),
    row('[Door slams]', 1, 3)
  ];
  const index = await buildSoundIndex({ rows, offset: 0.25 });
  assert.deepEqual(index.cues.map(({ label, startMs, endMs }) => [label, startMs, endMs]), [
    ['Door slams', 1250, 2250], ['Door slams', 1250, 3250], ['door slams', 1250, 3250], ['Music', 7250, 8250]
  ]);
  assert.equal(new Set(index.cues.map(cue => cue.key)).size, 4);
  const rebuilt = await buildSoundIndex({ rows, offset: 0.25 });
  assert.deepEqual(rebuilt.cues, index.cues);
});

test('projects only cues that start at or before confirmed position unless later cues are requested', async () => {
  const { cues } = await buildSoundIndex({
    rows: [row('[Music]', 0, 2), row('[Applause]\n[Knocking]', 2, 3), row('[Footsteps]', 5, 7)],
    offset: 0
  });
  assert.deepEqual(projectSoundCues(cues, null), []);
  assert.deepEqual(projectSoundCues(cues, NaN), []);
  assert.deepEqual(projectSoundCues(cues, -1), []);
  assert.deepEqual(projectSoundCues(cues, 0).map(cue => cue.label), ['Music']);
  assert.deepEqual(projectSoundCues(cues, 1999).map(cue => cue.label), ['Music']);
  assert.deepEqual(projectSoundCues(cues, 2000).map(cue => cue.label), ['Music', 'Applause', 'Knocking']);
  assert.deepEqual(projectSoundCues(cues, null, true), cues);
});

test('scan cap never reads the body of a source cue beyond the first 16,384 rows', async () => {
  let examined = 0;
  const common = [{ get text() { examined++; return 'not a sound'; } }, 1, 2];
  const rows = Array.from({ length: 16_385 }, () => common);
  let excludedBodyReads = 0;
  rows[16_384] = [{ get text() { excludedBodyReads++; return '[music]'; } }, 5, 6];
  const index = await buildSoundIndex({ rows, offset: 0 });
  assert.equal(examined, 16_384);
  assert.equal(excludedBodyReads, 0);
  assert.equal(index.limited, true);
  assert.equal(index.limitedAtMs, 5000);
  assert.deepEqual(index.cues, []);
});

test('bounds raw and browser-decoded UTF-8 under one 1 MiB processing budget', async () => {
  const tooMuch = '€'.repeat(350_000);
  let oversizedDecodes = 0;
  const rawLarge = await buildSoundIndex({
    rows: [row('[Music]', 0, 1), row(tooMuch + '[Music]', 2, 3, '[Music]', () => oversizedDecodes++)],
    offset: 0
  });
  assert.equal(rawLarge.cues.length, 1);
  assert.equal(oversizedDecodes, 0);
  assert.equal(rawLarge.limited, true);
  assert.equal(rawLarge.limitedAtMs, 2000);

  const combined = 'é'.repeat(270_000);
  const decodedLarge = await buildSoundIndex({
    rows: [row(combined, 1, 2), row('[Music]', 2, 3, combined + '\n[Music]')],
    offset: 0
  });
  assert.equal(decodedLarge.cues.length, 0);
  assert.equal(decodedLarge.limited, true);
  assert.equal(decodedLarge.limitedAtMs, 2000);
});

test('stops at 720 unique results and reports the timestamp of the first omitted cue', async () => {
  const rows = Array.from({ length: 721 }, (_, i) => row('[music]\n[music]', i, i + 1));
  const index = await buildSoundIndex({ rows, offset: 0 });
  assert.equal(index.cues.length, 720);
  assert.equal(index.limited, true);
  assert.equal(index.limitedAtMs, 720_000);
  assert.equal(index.cues.at(-1).startMs, 719_000);
  const exact = await buildSoundIndex({ rows: rows.slice(0, 720), offset: 0 });
  assert.equal(exact.limited, false);
});

test('starts after yielding and returns no partial results after abort or a stale exact track handle', async () => {
  const controller = new AbortController();
  const staleTrack = { rows: [row('[Music]', 0, 1, '[Music]', () => assert.fail('aborted scan decoded'))], offset: 0 };
  const started = buildSoundIndex(staleTrack, { signal: controller.signal });
  controller.abort();
  assert.equal(await started, null);

  let live = true;
  let examined = 0;
  const rows = Array.from({ length: 1000 }, (_, i) =>
    row('[Music]', i, i + 1, '[Music]', () => {
      examined++;
      if (examined === 1) setTimeout(() => { live = false; }, 0);
    }));
  const track = { rows, offset: 0 };
  const result = await buildSoundIndex(track, {
    isCurrent(handle) { assert.equal(handle, track); return live; }
  });
  assert.equal(result, null);
  assert.ok(examined > 0 && examined < rows.length);

  let current = true;
  const one = { rows: [row('[Music]', 0, 1, '[Music]', () => { current = false; })], offset: 0 };
  assert.equal(await buildSoundIndex(one, { isCurrent: () => current }), null, 'rechecks before publication');
});

test('opening-bracket entities remain subject to actual browser decoding', async () => {
  const index = await buildSoundIndex({
    rows: [
      row('&#91;Music&#93;', 0, 1, '[Music]'),
      row('&#x5b;Knocking&#x5d;', 1, 2, '[Knocking]'),
      row('&lbrack;Footsteps&rbrack;', 2, 3, '[Footsteps]'),
      row('&lsqb;Applause&rsqb;', 3, 4, '&lsqb;Applause&rsqb;')
    ],
    offset: 0
  });
  assert.deepEqual(index.cues.map(cue => cue.label), ['Music', 'Knocking', 'Footsteps']);
});

test('one densely multiline native cue can be cancelled during its scan', async () => {
  const controller = new AbortController();
  const dense = '[unknown]\n'.repeat(6000) + '[Music]';
  const rows = [row(dense, 0, 1, dense, () => setTimeout(() => controller.abort(), 0))];
  assert.equal(await buildSoundIndex({ rows, offset: 0 }, { signal: controller.signal }), null);
});

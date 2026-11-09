const MAX_ROWS = 16_384;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_RESULTS = 720;
const CHUNK_ROWS = 128;
const MAX_LABEL_LENGTH = 80;
const encoder = new TextEncoder();
const lineBreak = /\r\n?|\n|\u2028|\u2029/u;
const openingBracket = /\[|&#(?:0*91|x0*5b);|&(?:lbrack|lsqb);/iu;
const bracketedLine = /(?:^|[\r\n\u2028\u2029])[^\S\r\n\u2028\u2029]*(\[[^\[\]\r\n\u2028\u2029]*\])[^\S\r\n\u2028\u2029]*(?=$|[\r\n\u2028\u2029])/gu;

const effects = new Set([
  'alarm blares', 'applause', 'bells ringing', 'birds chirping', 'car horn',
  'cheering', 'crowd cheering', 'dog barks', 'dogs barking', 'door creaks', 'door slams',
  'footsteps', 'glass breaks', 'glass shattering', 'gunshot', 'gunshots', 'knocking',
  'laughter', 'phone ringing', 'phone rings', 'rain falling', 'sirens',
  'thunder', 'thunder rumbling', 'wind blowing', 'wind howls'
]);
const music = new Set(['music', 'music plays', 'music playing']);
const soundModifiers = new Set(['distant', 'faint', 'loud', 'muffled', 'soft', 'sudden']);
const musicModifiers = new Set(['gentle', 'ominous', 'somber', 'upbeat']);

export function parseSoundLine(line) {
  if (typeof line !== 'string' || lineBreak.test(line)) return null;
  const source = line.trim();
  if (!source.startsWith('[') || !source.endsWith(']')) return null;
  const label = source.slice(1, -1).trim().replace(/\s+/gu, ' ');
  if (label.length > MAX_LABEL_LENGTH || !/^[A-Za-z]+(?: [A-Za-z]+)*$/u.test(label)) return null;

  const words = label.toLowerCase().split(' ');
  for (let count = 0; count <= 2 && count < words.length; count += 1) {
    const phrase = words.slice(count).join(' ');
    const isMusic = music.has(phrase);
    if ((isMusic || effects.has(phrase)) &&
        words.slice(0, count).every(word => soundModifiers.has(word) || (isMusic && musicModifiers.has(word)))) {
      return label;
    }
  }
  return null;
}

function adjustedRange(row, offset) {
  const start = row?.[1];
  const end = row?.[2];
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || end + offset <= 0) return null;
  const startMs = Math.round(Math.max(0, start + offset) * 1000);
  const endMs = Math.round((end + offset) * 1000);
  return Number.isSafeInteger(endMs) && endMs > startMs ? [startMs, endMs] : null;
}

function boundedBytes(value, remaining) {
  if (value.length > remaining) return null;
  const size = encoder.encode(value).byteLength;
  return size <= remaining ? size : null;
}

function decodedCueText(cue) {
  try {
    return cue.getCueAsHTML()?.textContent;
  } catch {
    return null;
  }
}

function yieldTask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export async function buildSoundIndex(track, { signal, isCurrent } = {}) {
  const { rows, offset } = track ?? {};
  const current = () => !signal?.aborted && (!isCurrent || isCurrent(track));
  if (!Array.isArray(rows) || !Number.isFinite(offset) || !current()) return null;

  let remaining = MAX_TEXT_BYTES;
  const results = new Map();
  const limit = Math.min(rows.length, MAX_ROWS);
  function finish(limited = false, limitedAtMs = null) {
    if (!current()) return null;
    const cues = [...results.values()].sort((first, second) =>
      first.startMs - second.startMs || first.endMs - second.endMs);
    return { cues: Object.freeze(cues), limited, limitedAtMs };
  }

  for (let index = 0; index < limit; index += 1) {
    if (index % CHUNK_ROWS === 0) {
      await yieldTask();
      if (!current()) return null;
    }
    const row = rows[index];
    const range = adjustedRange(row, offset);
    if (!range) continue;

    const [startMs, endMs] = range;
    const cue = row[0];
    const raw = cue?.text;
    if (typeof raw !== 'string') continue;
    const rawBytes = boundedBytes(raw, remaining);
    if (rawBytes === null) return finish(true, startMs);
    remaining -= rawBytes;
    if (!openingBracket.test(raw)) continue;

    const decoded = decodedCueText(cue);
    if (typeof decoded !== 'string') continue;
    const decodedBytes = boundedBytes(decoded, remaining);
    if (decodedBytes === null) return finish(true, startMs);
    remaining -= decodedBytes;

    let checkedLines = 0;
    for (const [, line] of decoded.matchAll(bracketedLine)) {
      if (checkedLines > 0 && checkedLines % CHUNK_ROWS === 0) {
        await yieldTask();
        if (!current()) return null;
      }
      checkedLines += 1;
      const label = parseSoundLine(line);
      if (!label) continue;
      const key = startMs + ':' + endMs + ':' + label;
      if (results.has(key)) continue;
      if (results.size === MAX_RESULTS) return finish(true, startMs);
      results.set(key, Object.freeze({ key, label, startMs, endMs }));
    }
  }

  if (rows.length <= limit) return finish();
  // The browser cue list is chronological. Peek at the first excluded timing only,
  // so a default-scope notice can stay hidden until that time is eligible.
  return finish(true, adjustedRange(rows[limit], offset)?.[0] ?? null);
}

export function projectSoundCues(cues, positionMs, showLater = false) {
  if (!Array.isArray(cues)) return [];
  if (showLater) return cues;
  if (!Number.isFinite(positionMs) || positionMs < 0) return [];

  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle].startMs <= positionMs) low = middle + 1;
    else high = middle;
  }
  return low === cues.length ? cues : cues.slice(0, low);
}

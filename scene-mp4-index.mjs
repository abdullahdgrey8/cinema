import { Buffer } from 'node:buffer';

export const MAX_SCENE_PREFIX = 8 * 1024 * 1024;
export const MAX_SCENE_BOOTSTRAP_READ = 256 * 1024;
export const MAX_SCENE_SOURCE = 64 * 1024 ** 3;
const MAX_TOTAL_SAMPLES = 1_200_000;
const MAX_PACKED_BYTES = 32 * 1024 * 1024;
const MAX_BOXES = 64;
const MAX_WINDOW_MS = 30_000;
const MAX_SELECTED_SAMPLES = 8_192;
const MAX_COMPOSITION_OFFSET_SECONDS = 2;
const MAX_REORDER_SAMPLES = 32;
const MAX_TIMESCALE = 1_000_000_000;
const MAX_SECONDS = 24 * 3600;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const movieTracks = new WeakMap();

export class UnsupportedSceneMp4 extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedSceneMp4';
  }
}

export class NeedMoreScenePrefix extends UnsupportedSceneMp4 {
  constructor(minimumBytes) {
    super('Need ' + minimumBytes + ' verified leading bytes');
    this.name = 'NeedMoreScenePrefix';
    this.minimumBytes = minimumBytes;
  }
}

function requireMp4(condition, message) {
  if (!condition) throw new UnsupportedSceneMp4(message);
}

function asBytes(value) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function verifiedBytes(value, sourceLength) {
  const data = asBytes(value);
  requireMp4(Number.isSafeInteger(sourceLength) && sourceLength >= 16 && sourceLength <= MAX_SCENE_SOURCE,
    'Invalid source length');
  requireMp4(data && data.length <= Math.min(sourceLength, MAX_SCENE_PREFIX), 'Invalid verified prefix');
  return data;
}

function needPrefix(data, end) {
  requireMp4(end <= MAX_SCENE_PREFIX, 'Fast-start index exceeds the prefix bound');
  if (end > data.length) throw new NeedMoreScenePrefix(end);
}

function integer64(data, offset, signed = false) {
  const value = signed ? data.readBigInt64BE(offset) : data.readBigUInt64BE(offset);
  requireMp4(value >= -MAX_SAFE_BIGINT && value <= MAX_SAFE_BIGINT, '64-bit MP4 value is outside the safe range');
  return Number(value);
}

function tag(data, offset) {
  return data.toString('latin1', offset, offset + 4);
}

function box(data, start, limit, top = false) {
  requireMp4(start + 8 <= limit, 'Truncated MP4 box header');
  if (top) needPrefix(data, start + 8);
  let size = data.readUInt32BE(start);
  const kind = tag(data, start + 4);
  let header = 8;
  if (size === 1) {
    header = 16;
    requireMp4(start + header <= limit, 'Truncated MP4 box header');
    if (top) needPrefix(data, start + header);
    size = integer64(data, start + 8);
  }
  requireMp4(kind !== 'uuid', 'Private UUID boxes are unsupported');
  requireMp4(size >= header && size <= limit - start, 'Invalid MP4 box size');
  return { kind, payload: start + header, end: start + size };
}

function children(data, start, end, allowed) {
  const found = new Map();
  let count = 0;
  while (start < end) {
    requireMp4(++count <= MAX_BOXES, 'Too many children in an MP4 box');
    const child = box(data, start, end);
    requireMp4(allowed.includes(child.kind), 'Unsupported MP4 box ' + child.kind);
    const matches = found.get(child.kind);
    if (matches) matches.push(child);
    else found.set(child.kind, [child]);
    start = child.end;
  }
  return found;
}

function childBoxes(data, parent, allowed) {
  return children(data, parent.payload, parent.end, allowed);
}

function one(boxes, kind, optional = false) {
  const found = boxes.get(kind);
  if (optional && !found) return null;
  requireMp4(found?.length === 1, 'Expected one ' + kind + ' box');
  return found[0];
}

function fullBox(data, entry, maxVersion = 0, minFlags = 0, maxFlags = minFlags, minVersion = 0) {
  requireMp4(entry.payload + 4 <= entry.end, 'Truncated ' + entry.kind + ' full box');
  const value = data.readUInt32BE(entry.payload);
  const version = value >>> 24;
  const flags = value & 0xffffff;
  requireMp4(version >= minVersion && version <= maxVersion && flags >= minFlags && flags <= maxFlags,
    'Unsupported ' + entry.kind + ' version or flags');
  return { version, start: entry.payload + 4 };
}

function declaredRows(data, entry, width, limit, maxVersion = 0) {
  const { version, start } = fullBox(data, entry, maxVersion);
  requireMp4(start + 4 <= entry.end, 'Missing ' + entry.kind + ' count');
  const count = data.readUInt32BE(start);
  requireMp4(count > 0 && count <= limit && entry.end - start - 4 === count * width,
    'Invalid ' + entry.kind + ' entry count');
  return { start: start + 4, count, width, version };
}

function movieBoxes(data, sourceLength) {
  let start = 0;
  let hasType = false;
  let moov = null;
  for (let index = 0; index < MAX_BOXES; index++) {
    const top = box(data, start, sourceLength, true);
    if (top.kind === 'mdat') {
      requireMp4(hasType && moov && top.end === sourceLength && top.payload < top.end,
        'Expected one final mdat after a fast-start moov');
      return { moov, mdatStart: top.payload };
    }
    requireMp4(['ftyp', 'moov', 'free', 'skip'].includes(top.kind), 'Unsupported top-level MP4 box ' + top.kind);
    needPrefix(data, top.end);
    if (top.kind === 'ftyp') {
      const length = top.end - top.payload;
      requireMp4(start === 0 && !hasType && length >= 8 && length <= 128 && length % 4 === 0,
        'Expected a bounded ftyp at the start of the file');
      const brands = [tag(data, top.payload)];
      for (let at = top.payload + 8; at < top.end; at += 4) brands.push(tag(data, at));
      requireMp4(brands.some(brand => ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand)) &&
        !brands.some(brand => ['qt  ', 'dash', 'cmfc', 'cmfs'].includes(brand)), 'Expected ordinary ISO BMFF MP4 branding');
      hasType = true;
    } else if (top.kind === 'moov') {
      requireMp4(hasType && !moov, 'Invalid fast-start moov placement');
      moov = top;
    }
    start = top.end;
  }
  throw new UnsupportedSceneMp4('Too many top-level MP4 boxes');
}

/** Return the exact exclusive bootstrap byte end or the next minimum required end. */
export function bootstrapNeeded(prefix, sourceLength) {
  return movieBoxes(verifiedBytes(prefix, sourceLength), sourceLength).mdatStart;
}

function verifyDataReference(data, dinf) {
  const dref = one(childBoxes(data, dinf, ['dref']), 'dref');
  const { start } = fullBox(data, dref);
  requireMp4(start + 4 <= dref.end && data.readUInt32BE(start) === 1,
    'Expected one self-contained media data reference');
  const url = one(children(data, start + 4, dref.end, ['url ']), 'url ');
  requireMp4(fullBox(data, url, 0, 1).start === url.end, 'External media data references are unsupported');
}

function descriptor(data, start, end, expected) {
  requireMp4(start < end && data[start] === expected, 'Unexpected MPEG-4 descriptor');
  start++;
  let length = 0;
  for (let index = 0; index < 4; index++) {
    requireMp4(start < end, 'Truncated MPEG-4 descriptor length');
    const value = data[start++];
    length = length * 128 + (value & 0x7f);
    if (!(value & 0x80)) {
      requireMp4(start + length <= end, 'MPEG-4 descriptor exceeds its parent');
      return [start, start + length];
    }
  }
  throw new UnsupportedSceneMp4('Oversized MPEG-4 descriptor length');
}

function verifyAac(data, esds) {
  const { start } = fullBox(data, esds);
  const [es, esEnd] = descriptor(data, start, esds.end, 3);
  requireMp4(esEnd === esds.end && es + 3 <= esEnd && data[es + 2] === 0,
    'Unsupported elementary audio stream descriptor');
  const [config, configEnd] = descriptor(data, es + 3, esEnd, 4);
  requireMp4(config + 13 <= configEnd && data[config] === 0x40 && data[config + 1] === 0x15,
    'Expected MPEG-4 Audio decoder configuration');
  const [specific, specificEnd] = descriptor(data, config + 13, configEnd, 5);
  const specificLength = specificEnd - specific;
  requireMp4(specificEnd === configEnd && (specificLength === 2 || specificLength === 5),
    'Unsupported AAC AudioSpecificConfig');
  const asc = data.readUInt16BE(specific);
  const channels = (asc >>> 3) & 15;
  requireMp4((asc >>> 11) === 2 && ((asc >>> 7) & 15) <= 12 && channels >= 1 && channels <= 7 && !(asc & 7),
    'Expected AAC-LC with ordinary rate, channels and frame length');
  if (specificLength === 5) {
    requireMp4(data[specific + 2] === 0x56 && data[specific + 3] === 0xe5 && data[specific + 4] === 0,
      'Unsupported AAC synchronization extension');
  }
  const [sl, slEnd] = descriptor(data, configEnd, esEnd, 6);
  requireMp4(slEnd === esEnd && slEnd - sl === 1 && data[sl] === 2, 'Unsupported AAC SL configuration');
}

function verifySampleEntry(data, stsd, visual) {
  const { start } = fullBox(data, stsd);
  requireMp4(start + 4 <= stsd.end && data.readUInt32BE(start) === 1, 'Expected one sample description');
  const entry = box(data, start + 4, stsd.end);
  const length = visual ? 78 : 28;
  requireMp4(entry.end === stsd.end && entry.payload + length <= entry.end &&
    entry.kind === (visual ? 'avc1' : 'mp4a') && data.readUInt16BE(entry.payload + 6) === 1,
  'Unsupported media sample entry');
  const entries = children(data, entry.payload + length, entry.end,
    visual ? ['avcC', 'pasp', 'btrt', 'colr'] : ['esds', 'btrt']);
  if (visual) {
    const avcc = one(entries, 'avcC');
    requireMp4(avcc.end - avcc.payload >= 7 && data[avcc.payload] === 1 && data[avcc.payload + 4] === 0xff,
      'Expected four-byte H.264 NAL length prefixes');
  } else {
    requireMp4(data.readUInt16BE(entry.payload + 8) === 0, 'Unsupported audio sample-entry version');
    verifyAac(data, one(entries, 'esds'));
  }
}

export function isH264IdrSample(value) {
  const data = asBytes(value);
  if (!data) return false;
  let at = 0;
  let sawIdr = false;
  while (at < data.length) {
    if (data.length - at < 5) return false;
    const size = data.readUInt32BE(at);
    at += 4;
    if (!size || size > data.length - at || (data[at] & 0x80)) return false;
    const kind = data[at] & 31;
    if (kind < 5 || kind >= 19) return false;
    sawIdr ||= kind === 5;
    at += size;
  }
  return sawIdr;
}

function sampleSizes(data, stsz) {
  const { start } = fullBox(data, stsz);
  requireMp4(start + 8 <= stsz.end, 'Missing stsz sample size and count');
  const constantSize = data.readUInt32BE(start);
  const count = data.readUInt32BE(start + 4);
  requireMp4(count > 0 && count <= MAX_TOTAL_SAMPLES &&
    stsz.end - start - 8 === (constantSize ? 0 : count * 4), 'Invalid stsz size or count');
  return { count, at: index => constantSize || data.readUInt32BE(start + 8 + index * 4) };
}

function declaredEdit(data, edts, trackDuration) {
  if (!edts) return { movieStart: 0, duration: trackDuration, mediaStart: 0, hasExplicitEdit: false };
  const elst = one(childBoxes(data, edts, ['elst']), 'elst');
  const { version, start } = fullBox(data, elst, 1);
  requireMp4(start + 4 <= elst.end, 'Missing edit count');
  const count = data.readUInt32BE(start);
  const width = version === 0 ? 12 : 20;
  requireMp4((count === 1 || count === 2) && elst.end - start - 4 === count * width,
    'Unsupported edit list shape');
  let movieStart = 0;
  let duration;
  let mediaStart;
  for (let index = 0; index < count; index++) {
    const at = start + 4 + index * width;
    duration = version === 0 ? data.readUInt32BE(at) : integer64(data, at);
    mediaStart = version === 0 ? data.readInt32BE(at + 4) : integer64(data, at + 8, true);
    requireMp4(duration > 0 && duration <= trackDuration && data.readUInt32BE(at + width - 4) === 0x10000,
      'Only positive normal-rate track edits are supported');
    if (count === 2 && index === 0) {
      requireMp4(mediaStart === -1, 'The first of two edits must be a leading empty edit');
      movieStart = duration;
    }
  }
  // A rounded-up track header may differ by one movie tick. The edit defines coverage.
  const difference = trackDuration - movieStart - duration;
  requireMp4(mediaStart >= 0 && difference >= 0 && difference <= 1,
    'Media edit is outside the track clock or disagrees with its duration');
  return { movieStart, duration, mediaStart, hasExplicitEdit: true };
}

function audioRoll(data, tables, count) {
  const sgpd = one(tables, 'sgpd', true);
  const sbgp = one(tables, 'sbgp', true);
  if (!sgpd && !sbgp) return 0;
  requireMp4(sgpd && sbgp, 'Incomplete AAC roll group');
  const { start: groups } = fullBox(data, sgpd, 1, 0, 0, 1);
  const { start: mapping } = fullBox(data, sbgp);
  requireMp4(sgpd.end - groups === 14 && sbgp.end - mapping === 16 &&
    tag(data, groups) === 'roll' && tag(data, mapping) === 'roll' &&
    data.readUInt32BE(groups + 4) === 2 && data.readUInt32BE(groups + 8) === 1 &&
    data.readUInt32BE(mapping + 4) === 1 && data.readUInt32BE(mapping + 8) === count &&
    data.readUInt32BE(mapping + 12) === 1, 'Unsupported AAC roll group');
  const distance = data.readInt16BE(groups + 12);
  requireMp4(distance >= -32 && distance < 0, 'Unsupported AAC roll distance');
  return -distance;
}

function clock(data, header, expectedSize) {
  const { version, start } = fullBox(data, header, 1);
  requireMp4(header.end - start === expectedSize + (version === 0 ? 0 : 12),
    'Invalid ' + header.kind + ' header size');
  const timescale = data.readUInt32BE(start + (version === 0 ? 8 : 16));
  const duration = version === 0 ? data.readUInt32BE(start + 12) : integer64(data, start + 20);
  requireMp4(timescale > 0 && timescale <= MAX_TIMESCALE && duration > 0 && duration <= timescale * MAX_SECONDS,
    'Invalid ' + header.kind + ' clock');
  return { timescale, duration };
}

function trackTables(data, track, movieDuration) {
  const boxes = childBoxes(data, track, ['tkhd', 'mdia', 'edts', 'udta']);
  const tkhd = one(boxes, 'tkhd');
  const { version, start } = fullBox(data, tkhd, 1, 0, 15);
  requireMp4(tkhd.end - start === (version === 0 ? 80 : 92), 'Invalid track header size');
  const trackId = data.readUInt32BE(start + (version === 0 ? 8 : 16));
  const trackDuration = version === 0 ? data.readUInt32BE(start + 16) : integer64(data, start + 24);
  requireMp4(trackId > 0 && trackDuration > 0 && trackDuration <= movieDuration, 'Invalid track identity or duration');

  const media = childBoxes(data, one(boxes, 'mdia'), ['mdhd', 'hdlr', 'minf']);
  const { timescale, duration } = clock(data, one(media, 'mdhd'), 20);
  const handler = one(media, 'hdlr');
  const { start: handlerStart } = fullBox(data, handler);
  requireMp4(handlerStart + 20 <= handler.end, 'Truncated media handler');
  const kind = tag(data, handlerStart + 4);
  requireMp4(kind === 'vide' || kind === 'soun', 'Expected video and audio tracks only');

  const visual = kind === 'vide';
  const header = visual ? 'vmhd' : 'smhd';
  const info = childBoxes(data, one(media, 'minf'), [header, 'dinf', 'stbl']);
  one(info, header);
  verifyDataReference(data, one(info, 'dinf'));
  const allowed = ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64'];
  allowed.push(...(visual ? ['stss', 'ctts'] : ['sgpd', 'sbgp']));
  const tables = childBoxes(data, one(info, 'stbl'), allowed);
  verifySampleEntry(data, one(tables, 'stsd'), visual);
  const sizes = sampleSizes(data, one(tables, 'stsz'));
  const timing = declaredRows(data, one(tables, 'stts'), 8, sizes.count);
  const stco = one(tables, 'stco', true);
  const co64 = one(tables, 'co64', true);
  requireMp4(Boolean(stco) !== Boolean(co64), 'Expected one chunk-offset table');
  const offsets = declaredRows(data, stco || co64, stco ? 4 : 8, sizes.count);
  const chunkRuns = declaredRows(data, one(tables, 'stsc'), 12, offsets.count);
  const sync = visual ? declaredRows(data, one(tables, 'stss'), 4, sizes.count) : null;
  const ctts = visual ? one(tables, 'ctts', true) : null;
  const composition = ctts ? declaredRows(data, ctts, 8, sizes.count, 1) : null;
  const roll = visual ? 0 : audioRoll(data, tables, sizes.count);
  const edit = declaredEdit(data, one(boxes, 'edts', true), trackDuration);
  return { visual, trackId, timescale, duration, sizes, timing, offsets, chunkRuns, sync, composition, roll, edit };
}

function packedBytesFor(tables) {
  // Supported source sizes and tick values fit exactly in Number. Float64Array
  // stores each integer tick and offset losslessly, including signed PTS.
  return (2 * tables.sizes.count + 1) * Float64Array.BYTES_PER_ELEMENT +
    (tables.sync?.count ?? 0) * Uint32Array.BYTES_PER_ELEMENT +
    (tables.composition ? tables.sizes.count * (Float64Array.BYTES_PER_ELEMENT + Uint32Array.BYTES_PER_ELEMENT) : 0);
}

function decodeTimes(data, { timing, sizes, duration }) {
  const times = new Float64Array(sizes.count + 1);
  let cursor = 0;
  let tick = 0;
  for (let index = 0; index < timing.count; index++) {
    const at = timing.start + index * timing.width;
    const count = data.readUInt32BE(at);
    const delta = data.readUInt32BE(at + 4);
    requireMp4(count > 0 && count <= sizes.count - cursor && delta > 0 && count * delta <= duration - tick,
      'Invalid stts run');
    const end = cursor + count;
    while (cursor < end) {
      tick += delta;
      times[++cursor] = tick;
    }
  }
  requireMp4(cursor === sizes.count && tick === duration, 'stts durations do not match the media header');
  return times;
}

function pushPresentation(heap, index, pts) {
  let child = heap.length;
  heap.push(index);
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (pts[heap[parent]] <= pts[index]) break;
    heap[child] = heap[parent];
    child = parent;
  }
  heap[child] = index;
}

function popPresentation(heap, pts) {
  const first = heap[0];
  const last = heap.pop();
  if (!heap.length) return first;
  let parent = 0;
  while (parent * 2 + 1 < heap.length) {
    let child = parent * 2 + 1;
    if (child + 1 < heap.length && pts[heap[child + 1]] < pts[heap[child]]) child++;
    if (pts[last] <= pts[heap[child]]) break;
    heap[parent] = heap[child];
    parent = child;
  }
  heap[parent] = last;
  return first;
}

function compositionTimes(data, rows, times, timescale) {
  if (!rows) return { pts: times, order: null, depth: 0 };
  const count = times.length - 1;
  const pts = new Float64Array(count);
  let filled = 0;
  for (let index = 0; index < rows.count; index++) {
    const at = rows.start + index * rows.width;
    const size = data.readUInt32BE(at);
    const offset = rows.version === 0 ? data.readUInt32BE(at + 4) : data.readInt32BE(at + 4);
    requireMp4(size > 0 && size <= count - filled && Math.abs(offset) <= MAX_COMPOSITION_OFFSET_SECONDS * timescale,
      'Invalid or excessive ctts offset');
    const end = filled + size;
    while (filled < end) {
      pts[filled] = times[filled] + offset;
      filled++;
    }
  }
  requireMp4(filled === count, 'ctts omits samples');
  const order = new Uint32Array(count);
  const heap = [];
  let rank = 0;
  let depth = 0;
  let previousEnd = null;
  const append = () => {
    const index = popPresentation(heap, pts);
    const start = pts[index];
    depth = Math.max(depth, Math.abs(rank - index));
    requireMp4(depth <= MAX_REORDER_SAMPLES, 'Composition reordering exceeds the sample bound');
    requireMp4(previousEnd === null || previousEnd === start, 'Ambiguous composition sample intervals');
    previousEnd = start + times[index + 1] - times[index];
    order[rank++] = index;
  };

  // A sample at presentation rank r can have decode index at most r + this depth.
  for (let index = 0; index < count; index++) {
    pushPresentation(heap, index, pts);
    if (heap.length > MAX_REORDER_SAMPLES) append();
  }
  while (heap.length) append();
  return { pts, order, depth };
}

function syncSamples(data, rows, count) {
  if (!rows) return null;
  const sync = new Uint32Array(rows.count);
  let previous = 0;
  for (let index = 0; index < rows.count; index++) {
    const sample = data.readUInt32BE(rows.start + index * rows.width);
    requireMp4((index > 0 || sample === 1) && previous < sample && sample <= count, 'Invalid video sync sample table');
    sync[index] = sample - 1;
    previous = sample;
  }
  return sync;
}

function checkGops(times, pts, sync) {
  const count = times.length - 1;
  for (let ordinal = 0; ordinal < sync.length; ordinal++) {
    const start = sync[ordinal];
    const following = sync[ordinal + 1] ?? count;
    const boundary = following < count ? pts[following] : Infinity;
    for (let sample = start; sample < following; sample++) {
      requireMp4(pts[sample] >= pts[start] && pts[sample] + times[sample + 1] - times[sample] <= boundary,
        'Composition crosses a video random-access boundary');
    }
  }
}

function* trackChunks(data, { sizes, chunkRuns, offsets }, positions, mdatStart, sourceLength) {
  let previous = 0;
  for (let index = 0; index < chunkRuns.count; index++) {
    const at = chunkRuns.start + index * chunkRuns.width;
    const first = data.readUInt32BE(at);
    const count = data.readUInt32BE(at + 4);
    const description = data.readUInt32BE(at + 8);
    requireMp4(first > previous && first <= offsets.count && count > 0 && count <= sizes.count && description === 1,
      'Invalid stsc chunk mapping');
    previous = first;
  }
  requireMp4(data.readUInt32BE(chunkRuns.start) === 1, 'stsc must start with chunk one');
  let runIndex = 0;
  let samplesInChunk = data.readUInt32BE(chunkRuns.start + 4);
  let nextRun = chunkRuns.count > 1 ? data.readUInt32BE(chunkRuns.start + chunkRuns.width) : Infinity;
  let index = 0;
  let previousEnd = mdatStart;
  for (let chunk = 1; chunk <= offsets.count; chunk++) {
    if (chunk === nextRun) {
      runIndex++;
      const at = chunkRuns.start + runIndex * chunkRuns.width;
      samplesInChunk = data.readUInt32BE(at + 4);
      nextRun = runIndex + 1 < chunkRuns.count ? data.readUInt32BE(at + chunkRuns.width) : Infinity;
    }
    const at = offsets.start + (chunk - 1) * offsets.width;
    const offset = offsets.width === 4 ? data.readUInt32BE(at) : integer64(data, at);
    const limit = index + samplesInChunk;
    requireMp4(limit <= sizes.count && previousEnd <= offset && offset < sourceLength,
      'Chunk sample count or offset is outside the media extent');
    let cursor = offset;
    for (; index < limit; index++) {
      const size = sizes.at(index);
      requireMp4(size > 0 && cursor + size <= sourceLength, 'Zero-byte sample or sample beyond the media extent');
      positions[index] = cursor;
      cursor += size;
    }
    previousEnd = cursor;
    yield { start: offset, end: cursor };
  }
  requireMp4(index === sizes.count, 'The chunk table omits samples');
}

function samplePositions(data, tables, mdatStart, sourceLength) {
  const positions = tables.map(track => new Float64Array(track.sizes.count));
  const left = trackChunks(data, tables[0], positions[0], mdatStart, sourceLength);
  const right = trackChunks(data, tables[1], positions[1], mdatStart, sourceLength);
  let a = left.next().value;
  let b = right.next().value;
  let previousEnd = mdatStart;
  while (a || b) {
    const chooseLeft = !b || Boolean(a && a.start <= b.start);
    const chunk = chooseLeft ? a : b;
    requireMp4(previousEnd <= chunk.start, 'Track chunks overlap in the media file');
    previousEnd = chunk.end;
    if (chooseLeft) a = left.next().value;
    else b = right.next().value;
  }
  return positions;
}

function fraction(n, d) {
  let left = n < 0n ? -n : n;
  let right = d;
  while (right) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return { n: n / left, d: d / left };
}

function ratio(n, d) {
  return fraction(BigInt(n), BigInt(d));
}

function compare(left, right) {
  const delta = left.n * right.d - right.n * left.d;
  return delta < 0n ? -1 : Number(delta > 0n);
}

function minimum(left, right) {
  return compare(left, right) <= 0 ? left : right;
}

function movieTime(track, mediaTick) {
  const movieScale = BigInt(track.movieTimescale);
  const mediaScale = BigInt(track.timescale);
  const { movieStart, mediaStart } = track.edit;
  return fraction(BigInt(movieStart) * mediaScale + BigInt(mediaTick - mediaStart) * movieScale,
    movieScale * mediaScale);
}

function mediaTime(track, time) {
  const movieScale = BigInt(track.movieTimescale);
  const mediaScale = BigInt(track.timescale);
  const { movieStart, mediaStart } = track.edit;
  const denominator = time.d * movieScale;
  return {
    n: BigInt(mediaStart) * denominator + (time.n * movieScale - BigInt(movieStart) * time.d) * mediaScale,
    d: denominator,
  };
}

function editCoverage(track) {
  const { edit, times, pts, order, timescale, movieTimescale } = track;
  const count = times.length - 1;
  const last = order?.[count - 1] ?? count - 1;
  const actualStart = pts[order?.[0] ?? 0];
  const actualEnd = pts[last] + times[last + 1] - times[last];
  const mediaScale = BigInt(timescale);
  const movieScale = BigInt(movieTimescale);
  if (!edit.hasExplicitEdit) {
    const delta = BigInt(edit.duration) * mediaScale - BigInt(times[count]) * movieScale;
    requireMp4(delta >= -mediaScale && delta <= mediaScale,
      'Unedited track duration disagrees with the media clock');
    const start = Math.max(0, actualStart);
    const end = Math.min(times[count], actualEnd);
    requireMp4(start < end, 'Unedited track has no continuous presentation');
    return [ratio(start, timescale), ratio(end, timescale)];
  }

  requireMp4(actualStart <= edit.mediaStart && edit.mediaStart < actualEnd,
    'Media edit is outside the track clock or disagrees with its duration');
  const editSpan = BigInt(edit.duration) * mediaScale;
  const actualSpan = BigInt(actualEnd - edit.mediaStart) * movieScale;
  requireMp4(editSpan <= actualSpan + mediaScale, 'Media edit extends past the available presentation');
  const end = editSpan <= actualSpan ? ratio(edit.movieStart + edit.duration, movieTimescale) : movieTime(track, actualEnd);
  return [ratio(edit.movieStart, movieTimescale), end];
}

function materializeTrack(data, tables, positions, movieTimescale) {
  const times = decodeTimes(data, tables);
  const sync = syncSamples(data, tables.sync, tables.sizes.count);
  const { pts, order, depth } = compositionTimes(data, tables.composition, times, tables.timescale);
  if (sync) checkGops(times, pts, sync);
  const track = {
    timescale: tables.timescale, movieTimescale, edit: Object.freeze(tables.edit), sizes: tables.sizes,
    times, positions, sync, pts, order, depth, roll: tables.roll,
  };
  track.coverage = Object.freeze(editCoverage(track).map(value => Object.freeze(value)));
  return track;
}

/** Index a verified prefix once. No source payload is read or exposed by this function. */
export function parseSceneMovie(prefix, sourceLength) {
  const supplied = verifiedBytes(prefix, sourceLength);
  const { moov, mdatStart } = movieBoxes(supplied, sourceLength);
  // Retained table views must remain exact even if the caller reuses its input buffer.
  const data = Buffer.from(supplied.subarray(0, mdatStart));
  const boxes = childBoxes(data, moov, ['mvhd', 'trak', 'udta', 'free']);
  const { timescale, duration } = clock(data, one(boxes, 'mvhd'), 96);
  const tracks = boxes.get('trak');
  requireMp4(tracks?.length === 2, 'Expected exactly one video and one audio track');
  const tables = tracks.map(track => trackTables(data, track, duration));
  requireMp4(tables[0].visual !== tables[1].visual && tables[0].trackId !== tables[1].trackId,
    'Expected distinct video and audio tracks');
  requireMp4(tables[0].sizes.count + tables[1].sizes.count <= MAX_TOTAL_SAMPLES,
    'Aggregate sample count exceeds the index bound');
  const packedBytes = packedBytesFor(tables[0]) + packedBytesFor(tables[1]);
  requireMp4(packedBytes <= MAX_PACKED_BYTES, 'Declared packed data exceeds the index bound');

  if (!tables[0].visual) tables.reverse();
  const positions = samplePositions(data, tables, mdatStart, sourceLength);
  const video = materializeTrack(data, tables[0], positions[0], timescale);
  const audio = materializeTrack(data, tables[1], positions[1], timescale);
  const last = audio.sizes.count - 1;
  const start = audio.positions[last];
  const movie = Object.freeze({
    bootstrap: Object.freeze([0, mdatStart]),
    packedBytes,
    sampleCounts: Object.freeze([video.sizes.count, audio.sizes.count]),
    lastAudioSampleDuration: Object.freeze({
      duration: audio.times[last + 1] - audio.times[last], timescale: audio.timescale,
      start, end: start + audio.sizes.at(last),
    }),
  });
  movieTracks.set(movie, { video, audio });
  return movie;
}

function tickBound(count, valueAt, value, includeEqual = false) {
  let first = 0;
  let end = count;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    const scaled = BigInt(valueAt(middle)) * value.d;
    if (scaled < value.n || (includeEqual && scaled === value.n)) first = middle + 1;
    else end = middle;
  }
  return first;
}

function presentationSelection(track, first, end) {
  const startTick = mediaTime(track, first);
  const endTick = mediaTime(track, end);
  const count = track.sizes.count;
  const indexAt = rank => track.order?.[rank] ?? rank;
  const timeAt = rank => track.pts[indexAt(rank)];
  const firstRank = tickBound(count, timeAt, startTick, true) - 1;
  const endRank = tickBound(count, timeAt, endTick);
  requireMp4(firstRank >= 0 && firstRank < endRank && endRank <= count, 'Empty or uncovered presentation window');
  requireMp4(endRank - firstRank <= MAX_SELECTED_SAMPLES, 'Selected presentation window is too large');

  let earliest = indexAt(firstRank);
  let latest = earliest;
  for (let rank = firstRank + 1; rank < endRank; rank++) {
    const index = indexAt(rank);
    earliest = Math.min(earliest, index);
    latest = Math.max(latest, index);
  }
  return { startTick, earliest, latest };
}

function selectedTrack(track, first, end) {
  requireMp4(first >= 0 && first < end && end <= track.sizes.count && end - first <= MAX_SELECTED_SAMPLES,
    'Selected sample window is empty or too large');
  const syncSamples = track.sync;
  let ordinal = syncSamples ? tickBound(syncSamples.length, at => syncSamples[at], ratio(first, 1)) : 0;
  const samples = [];
  for (let index = first; index < end; index++) {
    const sync = !syncSamples || syncSamples[ordinal] === index;
    if (syncSamples && sync) ordinal++;
    const decodeTime = track.times[index];
    const duration = track.times[index + 1] - decodeTime;
    const compositionTime = track.pts[index];
    const start = track.positions[index];
    samples.push({
      number: index + 1, decodeTime, duration, start, end: start + track.sizes.at(index), sync, compositionTime,
      presentationTime: movieTime(track, compositionTime), presentationEnd: movieTime(track, compositionTime + duration),
    });
  }
  return {
    timescale: track.timescale, movieTimescale: track.movieTimescale, edit: track.edit,
    presentationCoverage: track.coverage, reorderDepth: track.depth, samples,
  };
}

function mergeRanges(bootstrap, video, audio) {
  const ranges = [bootstrap, ...video.samples.map(sample => [sample.start, sample.end]),
    ...audio.samples.map(sample => [sample.start, sample.end])];
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Select exact scene extents and clocks without reparsing any table. */
export function selectScene(movie, startMs, durationMs, { audioPrerollSamples = 2, readAheadMs = 250 } = {}) {
  const tracks = movieTracks.get(movie);
  requireMp4(tracks, 'Invalid reusable scene movie');
  requireMp4([startMs, durationMs, audioPrerollSamples, readAheadMs].every(Number.isSafeInteger) &&
    startMs >= 0 && startMs <= MAX_SECONDS * 1000 && durationMs > 0 && durationMs <= MAX_WINDOW_MS &&
    audioPrerollSamples >= 0 && audioPrerollSamples <= 32 && readAheadMs >= 0 && readAheadMs <= 2000,
  'Invalid scene time or padding');
  const { video, audio } = tracks;
  const start = ratio(startMs, 1000);
  const end = ratio(startMs + durationMs, 1000);
  const tail = ratio(startMs + durationMs + readAheadMs, 1000);
  requireMp4([video, audio].every(track => compare(track.coverage[0], start) <= 0 && compare(end, track.coverage[1]) <= 0),
    'The scene is outside a shared audio and video presentation interval');

  const wantedVideo = presentationSelection(video, start, minimum(tail, video.coverage[1]));
  const key = tickBound(video.sync.length, at => video.pts[video.sync[at]], wantedVideo.startTick, true) - 1;
  requireMp4(key >= 0, 'No preceding video sync sample');
  const videoFirst = video.sync[key];
  requireMp4(videoFirst <= wantedVideo.earliest, 'The scene crosses an unsupported random-access boundary');
  const videoEnd = Math.min(video.sizes.count, wantedVideo.latest + 1 + video.depth);

  const audioTick = mediaTime(audio, movieTime(video, video.pts[videoFirst]));
  const audioFirst = Math.max(0, tickBound(audio.times.length, at => audio.times[at], audioTick, true) - 1 -
    Math.max(audio.roll, audioPrerollSamples));
  const wantedAudio = presentationSelection(audio, start, minimum(tail, audio.coverage[1]));
  const audioEnd = wantedAudio.latest + 1;
  const videoWindow = selectedTrack(video, videoFirst, videoEnd);
  const audioWindow = selectedTrack(audio, audioFirst, audioEnd);
  return {
    bootstrap: movie.bootstrap, ranges: mergeRanges(movie.bootstrap, videoWindow, audioWindow), keyframe: videoWindow.samples[0],
    video: videoWindow, audio: audioWindow,
  };
}

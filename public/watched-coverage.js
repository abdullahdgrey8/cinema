const MAX_GAP_MS = 1200;
const SAMPLE_TOLERANCE_MS = 160;
const CATCH_UP_MS = 45_000;
const STORE_VERSION = 1;
const TICK_MS = 250;
const MAX_INTERVALS = 64;
const MAX_RECORDS = 48;
const MAX_STORE_BYTES = 128 * 1024;
const HASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SEAL_PATTERN = /^[a-f0-9]{64}$/u;
const CAPTION_ID_PATTERN = /^[a-f0-9]{32}$/u;
const RUN_PATTERN = /^[a-f0-9]{12}$/u;
const encoder = new TextEncoder();

function matches(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

function objectWithKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function timestamp(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function interval(value) {
  return Array.isArray(value) && value.length === 2 && timestamp(value[0]) &&
    timestamp(value[1]) && value[0] < value[1];
}

function captionBinding(value) {
  return value && matches(CAPTION_ID_PATTERN, value.id) && matches(SEAL_PATTERN, value.digest) &&
    Number.isSafeInteger(value.offsetMs)
    ? { id: value.id, digest: value.digest, offsetMs: value.offsetMs }
    : null;
}

function sameCaption(first, second) {
  return first && second && first.id === second.id &&
    first.digest === second.digest && first.offsetMs === second.offsetMs;
}

// In-memory order is observation age. Extend a covered interval only for new evidence.
function addRecent(ranges, start, end) {
  if (ranges.some(([low, high]) => low <= start && end <= high)) return;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const [low, high] = ranges[index];
    if (high < start || end < low) continue;
    start = Math.min(start, low);
    end = Math.max(end, high);
    ranges.splice(index, 1);
  }
  ranges.push([start, end]);
  if (ranges.length > MAX_INTERVALS) ranges.shift();
}

function harvest(ranges, played, start, end) {
  if (start === null || end <= start || !Array.isArray(played)) return;
  for (const range of played) {
    if (!interval(range)) continue;
    const low = Math.max(start, range[0]);
    const high = Math.min(end, range[1]);
    if (low < high) addRecent(ranges, low, high);
  }
}

function copyRanges(ranges) {
  return ranges.map(([start, end]) => [start, end]);
}

export function createCoverageWitness() {
  const video = [];
  let caption = null;
  let last = null;
  let videoStart = null;
  let captionStart = null;

  function boundary(played) {
    if (last) {
      harvest(video, played, videoStart, last.mediaMs);
      if (caption) harvest(caption.ranges, played, captionStart, last.mediaMs);
    }
    last = null;
    videoStart = null;
    captionStart = null;
  }

  function observe({ wallMs, mediaMs, rate, played, caption: selection = null, eligible = true } = {}) {
    const binding = captionBinding(selection);
    const changed = binding ? !sameCaption(caption, binding) : caption !== null;
    const showing = binding !== null && selection.showing === true;

    if (!eligible || !timestamp(wallMs) || !timestamp(mediaMs) || !Number.isFinite(rate) || rate <= 0) {
      boundary();
      if (changed) caption = binding && { ...binding, ranges: [] };
      return;
    }

    const wallAdvance = last ? wallMs - last.wallMs : 0;
    const mediaAdvance = last ? mediaMs - last.mediaMs : 0;
    const continuous = last && last.rate === rate && wallAdvance > 0 && wallAdvance <= MAX_GAP_MS &&
      mediaAdvance > 0 && mediaAdvance <= wallAdvance * rate + SAMPLE_TOLERANCE_MS;

    if (!continuous) boundary(played);
    else if (caption && (changed || !showing)) {
      harvest(caption.ranges, played, captionStart, last.mediaMs);
      captionStart = null;
    }

    if (changed) caption = binding && { ...binding, ranges: [] };
    if (videoStart === null) videoStart = mediaMs;
    if (showing && captionStart === null) captionStart = mediaMs;
    last = { wallMs, mediaMs, rate };

    // A played endpoint can lag the presented frame, so reconsider the full open passage.
    harvest(video, played, videoStart, mediaMs);
    if (showing) harvest(caption.ranges, played, captionStart, mediaMs);
  }

  function snapshot() {
    return {
      video: copyRanges(video),
      caption: caption && { ...caption, ranges: copyRanges(caption.ranges) }
    };
  }

  return { observe, boundary, snapshot };
}

export function containsCoverage(ranges, startMs, endMs) {
  return timestamp(startMs) && timestamp(endMs) && startMs < endMs && Array.isArray(ranges) &&
    ranges.some(range => interval(range) && range[0] <= startMs && endMs <= range[1]);
}

function byStart(first, second) {
  return first[0] - second[0] || first[1] - second[1];
}

function sortedRanges(ranges) {
  return Array.isArray(ranges) ? ranges.filter(interval).sort(byStart) : [];
}

export function coveredCaptionRanges(record, binding) {
  if (!sameCaption(captionBinding(record?.caption), captionBinding(binding))) return [];
  const video = sortedRanges(record.video);
  const captions = sortedRanges(record.caption.ranges);
  const shared = [];
  let videoIndex = 0;
  let captionIndex = 0;
  while (videoIndex < video.length && captionIndex < captions.length) {
    const [videoStart, videoEnd] = video[videoIndex];
    const [captionStart, captionEnd] = captions[captionIndex];
    const start = Math.max(videoStart, captionStart);
    const end = Math.min(videoEnd, captionEnd);
    if (start < end) shared.push([start, end]);
    if (videoEnd <= captionEnd) videoIndex += 1;
    if (captionEnd <= videoEnd) captionIndex += 1;
  }
  return shared;
}

export function catchUpPassage(video, resumeMs) {
  if (!timestamp(resumeMs) || !Array.isArray(video)) return null;
  let latest = null;
  for (const range of video) {
    if (!interval(range)) continue;
    const end = Math.min(range[1], resumeMs);
    const start = Math.max(range[0], end - CATCH_UP_MS);
    if (start >= end) continue;
    if (!latest || end > latest[1] || (end === latest[1] && start < latest[0])) latest = [start, end];
  }
  return latest;
}

function sealedProof(value) {
  if (!value || value.kind !== 'sealed' || !matches(SEAL_PATTERN, value.seal)) return null;
  const timeline = value.timeline;
  if (!timeline || timeline.offsetMs !== 0) return null;
  const direct = timeline.mode === 'direct' && timeline.run === null;
  const hls = timeline.mode === 'hls' && matches(RUN_PATTERN, timeline.run);
  return direct || hls
    ? { kind: 'sealed', seal: value.seal, timeline: { mode: timeline.mode, offsetMs: 0, run: timeline.run } }
    : null;
}

function sameProof(first, second) {
  return first.seal === second.seal && first.timeline.mode === second.timeline.mode &&
    first.timeline.run === second.timeline.run;
}

function readRanges(value, fromTicks) {
  if (!Array.isArray(value) || value.length > MAX_INTERVALS) return null;
  const pairs = Array.from(value);
  if (pairs.some(range => !interval(range) || (fromTicks && !range.every(Number.isSafeInteger)))) return null;
  const ranges = fromTicks ? pairs.map(range => range.map(tick => tick * TICK_MS)) : pairs;
  if (!ranges.every(interval)) return null;
  const ordered = [...ranges].sort(byStart);
  if (ordered.some(([start], index) => index > 0 && start <= ordered[index - 1][1])) return null;
  return copyRanges(ranges);
}

function readRecord(value, fromTicks = false) {
  if (!value || !matches(HASH_PATTERN, value.hash) || !Number.isSafeInteger(value.index) || value.index < 0 ||
      !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return null;
  if (fromTicks && (!objectWithKeys(value, ['hash', 'index', 'proof', 'updatedAt', 'video', 'caption']) ||
      !objectWithKeys(value.proof, ['kind', 'seal', 'timeline']) ||
      !objectWithKeys(value.proof.timeline, ['mode', 'offsetMs', 'run']))) return null;
  const proof = sealedProof(value.proof);
  const video = readRanges(value.video, fromTicks);
  if (!proof || !video) return null;

  let caption = null;
  if (value.caption !== null) {
    if (fromTicks && !objectWithKeys(value.caption, ['id', 'digest', 'offsetMs', 'ranges'])) return null;
    const binding = captionBinding(value.caption);
    const ranges = binding && readRanges(value.caption.ranges, fromTicks);
    if (!ranges) return null;
    caption = { ...binding, ranges };
  }
  return { hash: value.hash, index: value.index, proof, updatedAt: value.updatedAt, video, caption };
}

function fileKey(record) {
  return record.hash + ':' + record.index;
}

function byUpdatedAt(first, second) {
  return first.updatedAt - second.updatedAt;
}

function recentRecords(records) {
  return [...records].sort(byUpdatedAt).slice(-MAX_RECORDS);
}

export function mergeCoverage(records, batch) {
  const incoming = readRecord(batch);
  if (!incoming) return records;
  const byFile = new Map();
  for (const record of records) {
    const clean = readRecord(record);
    if (clean) byFile.set(fileKey(clean), clean);
  }

  const key = fileKey(incoming);
  const previous = byFile.get(key);
  if (previous && incoming.updatedAt < previous.updatedAt) return recentRecords(byFile.values());
  if (previous && sameProof(previous.proof, incoming.proof)) {
    const video = previous.video;
    for (const [start, end] of incoming.video) addRecent(video, start, end);
    incoming.video = video;
    if (sameCaption(previous.caption, incoming.caption)) {
      const ranges = previous.caption.ranges;
      for (const [start, end] of incoming.caption.ranges) addRecent(ranges, start, end);
      incoming.caption.ranges = ranges;
    }
  }
  byFile.set(key, incoming);
  return recentRecords(byFile.values());
}

export function readCoverageStore(text) {
  if (typeof text !== 'string' || text.length > MAX_STORE_BYTES || encoder.encode(text).byteLength > MAX_STORE_BYTES) return [];
  try {
    const store = JSON.parse(text);
    if (!objectWithKeys(store, ['version', 'records']) || store.version !== STORE_VERSION ||
        !Array.isArray(store.records) || store.records.length > MAX_RECORDS) return [];
    const records = [];
    const seen = new Set();
    for (const value of store.records) {
      const record = readRecord(value, true);
      if (!record || seen.has(fileKey(record))) return [];
      seen.add(fileKey(record));
      records.push(record);
    }
    return records.sort(byUpdatedAt);
  } catch {
    return [];
  }
}

function inwardTicks(ranges) {
  return ranges.map(([start, end]) => {
    let first = Math.ceil(start / TICK_MS);
    let last = Math.floor(end / TICK_MS);
    if (first * TICK_MS < start) first += 1;
    if (last * TICK_MS > end) last -= 1;
    return [first, last];
  }).filter(([start, end]) => start < end);
}

export function writeCoverageStore(records) {
  const byFile = new Map();
  for (const value of records) {
    const record = readRecord(value);
    if (!record) continue;
    const key = fileKey(record);
    if ((byFile.get(key)?.updatedAt ?? -1) <= record.updatedAt) byFile.set(key, record);
  }
  const encodedRecords = recentRecords(byFile.values()).map(record => ({
    ...record,
    video: inwardTicks(record.video),
    caption: record.caption && { ...record.caption, ranges: inwardTicks(record.caption.ranges) }
  }));
  const encoded = { version: STORE_VERSION, records: encodedRecords };
  let text = JSON.stringify(encoded);
  while (encoder.encode(text).byteLength > MAX_STORE_BYTES) {
    encodedRecords.shift();
    text = JSON.stringify(encoded);
  }
  return text;
}

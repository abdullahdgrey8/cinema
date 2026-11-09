import { canonicalWatchedCues } from './watched-captions.js';

export const STUDIO_PAIRINGS_KEY = 'cinema-two-track-v1';
const MAX_SUBTITLE_BYTES = 1024 * 1024;
const MAX_CUES = 64_000;
const MAX_OFFSET_SECONDS = 120;
const MAX_OFFSET_MS = MAX_OFFSET_SECONDS * 1000;
const MIN_JUMP_MS = 200;
const JUMP_INSET_MS = 50;
const MAX_PAIRINGS = 32;
const MAX_STORE_BYTES = 24 * 1024;
const MAX_NAME_POINTS = 60;
const STORE_VERSION = 1;
const fileKeyPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64}):(0|[1-9]\d{0,15})$/u;
const captionId = /^[a-f0-9]{32}$/u;
const captionDigest = /^[a-f0-9]{64}$/u;
const pairFields = ['fileKey', 'primaryId', 'primaryDigest', 'secondaryId', 'secondaryDigest', 'name', 'offsetMs'];
const encoder = new TextEncoder();

export function decodeStudioSubtitle(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new Error('Choose a subtitle file.');
  if (bytes.byteLength > MAX_SUBTITLE_BYTES) throw new Error('Choose a subtitle file up to 1 MiB.');

  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';

  let decoded;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (decoded.includes('\0')) throw new Error('Unsupported subtitle encoding');
  } catch {
    throw new Error('Choose a UTF-8 or BOM-marked UTF-16 subtitle file.');
  }
  if (!decoded.trim()) throw new Error('Choose a subtitle file with text.');
  return decoded;
}

export function primaryStudioCues(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_CUES) return null;
  const cues = [];
  let chars = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) return null;
    const [, start, end, text] = row;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || typeof text !== 'string') return null;
    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) return null;
    chars += text.length;
    if (chars > MAX_SUBTITLE_BYTES) return null;
    cues.push([startMs, endMs, text]);
  }
  return cues;
}

function addWinner(heap, row, precedes) {
  let child = heap.length;
  heap.push(row);
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!precedes(row, heap[parent])) break;
    heap[child] = heap[parent];
    child = parent;
  }
  heap[child] = row;
}

function removeWinner(heap, precedes) {
  const replacement = heap.pop();
  if (!heap.length) return;
  let parent = 0;
  while (parent * 2 + 1 < heap.length) {
    let child = parent * 2 + 1;
    if (child + 1 < heap.length && precedes(heap[child + 1], heap[child])) child += 1;
    if (!precedes(heap[child], replacement)) break;
    heap[parent] = heap[child];
    parent = child;
  }
  heap[parent] = replacement;
}

function winningSpans(rows) {
  const spans = [];
  const heap = [];
  const precedes = (first, second) => rows[first][0] > rows[second][0] ||
    (rows[first][0] === rows[second][0] && first < second);
  let cursor = 0;
  let at = rows[0]?.[0];
  while (cursor < rows.length || heap.length) {
    while (cursor < rows.length && rows[cursor][0] === at) {
      addWinner(heap, cursor, precedes);
      cursor += 1;
    }
    while (heap.length && rows[heap[0]][1] <= at) removeWinner(heap, precedes);
    if (!heap.length) {
      at = rows[cursor]?.[0];
      continue;
    }

    // Only a new cue's start or the winner's end can change which cue is shown.
    const row = heap[0];
    const next = Math.min(rows[row][1], rows[cursor]?.[0] ?? Infinity);
    const previous = spans.at(-1);
    if (previous?.row === row && previous.end === at) previous.end = next;
    else spans.push({ start: at, end: next, row });
    at = next;
  }
  return spans;
}

export function createStudioCueIndex(tuples) {
  const rows = canonicalWatchedCues(tuples);
  if (!rows) return null;
  const spans = winningSpans(rows);
  return Object.freeze({
    at(positionMs, offsetMs) {
      let low = 0;
      let high = spans.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (spans[middle].start + offsetMs <= positionMs) low = middle + 1;
        else high = middle;
      }

      const span = spans[low - 1];
      if (!span || positionMs >= span.end + offsetMs) return null;
      const [start, end, text] = rows[span.row];
      const endMs = end + offsetMs;
      if (!Number.isSafeInteger(endMs)) return null;
      return {
        startMs: Math.max(0, start + offsetMs),
        endMs,
        text,
        activeStartMs: Math.max(0, span.start + offsetMs),
        activeEndMs: span.end + offsetMs
      };
    }
  });
}

export function activeStudioCue(index, positionMs, offsetMs = 0) {
  if (typeof index?.at !== 'function' || !Number.isFinite(positionMs) || positionMs < 0 ||
      !Number.isSafeInteger(offsetMs)) return null;
  return index.at(positionMs, offsetMs);
}

function validRange(start, end) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < end;
}

function validActiveCue(cue) {
  return cue && validRange(cue.startMs, cue.endMs) && validRange(cue.activeStartMs, cue.activeEndMs) &&
    cue.startMs <= cue.activeStartMs && cue.activeEndMs <= cue.endMs;
}

export function studioOverlap(first, second) {
  if (!validActiveCue(first) || !validActiveCue(second)) return null;
  const startMs = Math.max(first.activeStartMs, second.activeStartMs);
  const endMs = Math.min(first.activeEndMs, second.activeEndMs);
  return startMs < endMs ? { startMs, endMs } : null;
}

export function studioJumpTarget(overlap) {
  if (!overlap || !validRange(overlap.startMs, overlap.endMs) ||
      overlap.endMs - overlap.startMs < MIN_JUMP_MS) return null;
  return overlap.startMs + JUMP_INSET_MS;
}

export function studioSeekLanded({ moved, current, positionMs, overlap } = {}) {
  return moved === true && current === true && Number.isFinite(positionMs) &&
    studioJumpTarget(overlap) !== null && positionMs >= overlap.startMs && positionMs < overlap.endMs;
}

export function studioOffsetMs(seconds) {
  if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_OFFSET_SECONDS) return null;
  return Math.round(seconds * 1000) || 0;
}

function matches(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

export function studioPairKey(fileKey, primaryId) {
  if (typeof fileKey !== 'string' || !matches(captionId, primaryId)) return null;
  const match = fileKeyPattern.exec(fileKey);
  return match && Number.isSafeInteger(Number(match[1])) ? fileKey + ':' + primaryId : null;
}

function ownFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function cleanPair(value, fromStorage = false) {
  if (!value || (fromStorage && !ownFields(value, pairFields))) return null;
  const { fileKey, primaryId, primaryDigest, secondaryId, secondaryDigest, name, offsetMs } = value;
  if (!studioPairKey(fileKey, primaryId) || !matches(captionId, secondaryId) || primaryId === secondaryId ||
      !matches(captionDigest, primaryDigest) || !matches(captionDigest, secondaryDigest) ||
      primaryDigest === secondaryDigest || !Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > MAX_OFFSET_MS ||
      typeof name !== 'string' || /[/\\\p{Cc}\u2028\u2029]/u.test(name)) return null;
  const trimmed = name.trim();
  const points = Array.from(trimmed);
  if (!points.length || (fromStorage && (trimmed !== name || points.length > MAX_NAME_POINTS))) return null;
  return {
    fileKey, primaryId, primaryDigest, secondaryId, secondaryDigest,
    name: points.slice(0, MAX_NAME_POINTS).join('').trimEnd(), offsetMs: offsetMs || 0
  };
}

function normalizePairs(records, fromStorage = false) {
  const newest = new Map();
  for (const value of Array.isArray(records) ? records : []) {
    const pair = cleanPair(value, fromStorage);
    if (!pair) continue;
    const key = studioPairKey(pair.fileKey, pair.primaryId);
    newest.delete(key);
    newest.set(key, pair);
  }
  return [...newest.values()].slice(-MAX_PAIRINGS);
}

function boundedStore(pairings) {
  const stored = { version: STORE_VERSION, pairings };
  let text = JSON.stringify(stored);
  while (encoder.encode(text).byteLength > MAX_STORE_BYTES) {
    pairings.shift();
    text = JSON.stringify(stored);
  }
  return { pairings, text };
}

export function readStudioPairings(text) {
  if (typeof text !== 'string' || text.length > MAX_STORE_BYTES || encoder.encode(text).byteLength > MAX_STORE_BYTES) return [];
  try {
    const value = JSON.parse(text);
    return ownFields(value, ['version', 'pairings']) && value.version === STORE_VERSION && Array.isArray(value.pairings)
      ? normalizePairs(value.pairings, true)
      : [];
  } catch {
    return [];
  }
}

export function writeStudioPairings(records) {
  return boundedStore(normalizePairs(records)).text;
}

export function saveStudioPairing(records, pair) {
  const next = normalizePairs([...(Array.isArray(records) ? records : []), pair]);
  return boundedStore(next).pairings;
}

export function removeStudioPairing(records, fileKey, primaryId) {
  const key = studioPairKey(fileKey, primaryId);
  return normalizePairs(records).filter(pair => studioPairKey(pair.fileKey, pair.primaryId) !== key);
}

import { createHash } from 'node:crypto';

const METADATA_LIMIT = 8 * 1024 * 1024;
const SOURCE_LIMIT = 64 * 1024 * 1024 * 1024;
const PIECE_MIN = 16 * 1024, PIECE_MAX = 8 * 1024 * 1024;
const COPY_LIMIT = 24 * 1024 * 1024;
const FETCH_MAX_RESERVE_PIECES = 64;
const FETCH_MAX_TARGET_PIECES = 16;
const FETCH_MAX_TARGET_BYTES = 8 * 1024 * 1024;
const verifiedMetadata = new WeakMap();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class SceneProofError extends Error {
  constructor(code, message) { super(message); this.name = 'SceneProofError'; this.code = code; }
}
const fail = (code, message) => { throw new SceneProofError(code, message); };
const bad = () => fail('scene-unverified', 'The torrent metadata could not be verified.');
const abort = signal => signal?.throwIfAborted();
const hashBytes = (algorithm, bytes) => createHash(algorithm).update(bytes).digest();
const key = name => Buffer.from(name).toString('hex');
const get = (dict, name) => dict instanceof Map ? dict.get(key(name)) : undefined;
const has = (dict, name) => dict instanceof Map && dict.has(key(name));

async function cappedBody(response, signal) {
  abort(signal);
  if (response?.status === 409) fail('scene-missing', 'The torrent metadata is not available yet.');
  if (!response?.ok || response.status !== 200 || !response.body?.getReader) bad();
  const type = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/x-bittorrent') bad();
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) bad();
  if (length && Number(length) > METADATA_LIMIT) {
    await response.body.cancel().catch(() => {});
    fail('scene-limit', 'This torrent metadata exceeds the preview limit.');
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false, page, used = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      abort(signal);
      let next;
      try { next = await reader.read(); } catch { abort(signal); bad(); }
      const { done, value } = next;
      abort(signal);
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) bad();
      if (value.byteLength > METADATA_LIMIT - size) fail('scene-limit', 'This torrent metadata exceeds the preview limit.');
      size += value.byteLength;
      // Fixed pages also bound object overhead if a response is fragmented
      // into tiny chunks. Never retain one Buffer object per incoming chunk.
      for (let offset = 0; offset < value.byteLength;) {
        if (!page) page = Buffer.allocUnsafe(64 * 1024);
        const length = Math.min(page.length - used, value.byteLength - offset);
        page.set(value.subarray(offset, offset + length), used);
        offset += length; used += length;
        if (used === page.length) { chunks.push(page); page = undefined; used = 0; }
      }
    }
    if (!size) bad();
    if (page && used) chunks.push(page.subarray(0, used));
    if (length && !response.headers?.get('content-encoding') && size !== Number(length)) bad();
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Retain the original info span. Re-encoding a permissively decoded dictionary
// is not an info-hash proof. Binary keys remain binary, including piece layers.
function strictDecode(bytes) {
  let cursor = 0, tokens = 0, infoSpan;
  function value(depth) {
    if (++tokens > 200000 || depth > 32) fail('scene-limit', 'This torrent metadata is too complex for a preview.');
    const type = bytes[cursor];
    if (type === 105) {
      const end = bytes.indexOf(101, ++cursor);
      if (end < 0 || end - cursor > 17) bad();
      const encoded = bytes.toString('latin1', cursor, end);
      if (!/^(?:0|-?[1-9][0-9]*)$/.test(encoded)) bad();
      const result = Number(encoded);
      if (!Number.isSafeInteger(result)) bad();
      cursor = end + 1;
      return result;
    }
    if (type >= 48 && type <= 57) {
      const end = bytes.indexOf(58, cursor);
      if (end < 0 || end - cursor > 8) bad();
      const encoded = bytes.toString('latin1', cursor, end);
      if (!/^(?:0|[1-9][0-9]*)$/.test(encoded)) bad();
      const length = Number(encoded);
      cursor = end + 1;
      if (length > bytes.length - cursor) bad();
      const result = bytes.subarray(cursor, cursor + length);
      cursor += length;
      return result;
    }
    if (type === 108) {
      cursor++;
      const list = [];
      while (bytes[cursor] !== 101) { if (cursor >= bytes.length) bad(); list.push(value(depth + 1)); }
      cursor++;
      return list;
    }
    if (type === 100) {
      cursor++;
      const dict = new Map();
      let previous;
      while (bytes[cursor] !== 101) {
        if (cursor >= bytes.length) bad();
        const name = value(depth + 1);
        if (!Buffer.isBuffer(name) || previous && Buffer.compare(previous, name) >= 0) bad();
        previous = name;
        const start = cursor, item = value(depth + 1);
        if (depth === 0 && name.equals(Buffer.from('info'))) infoSpan = [start, cursor];
        dict.set(name.toString('hex'), item);
      }
      cursor++;
      return dict;
    }
    bad();
  }
  const root = value(0);
  if (!(root instanceof Map) || cursor !== bytes.length || !infoSpan || !(get(root, 'info') instanceof Map)) bad();
  return { info: get(root, 'info'), rawInfo: bytes.subarray(...infoSpan) };
}

function text(value) {
  if (!Buffer.isBuffer(value)) bad();
  try { return utf8.decode(value); } catch { bad(); }
}
function component(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' ||
      /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value))
    fail('scene-unsupported', 'This torrent has an unsupported file path.');
  return value;
}
function fileSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) bad();
  if (value > SOURCE_LIMIT) fail('scene-limit', 'This source exceeds the preview size limit.');
  return value;
}
function attributes(dict) {
  const attr = get(dict, 'attr');
  const result = attr === undefined ? '' : text(attr);
  if (result.includes('l') || has(dict, 'symlink path')) fail('scene-unsupported', 'Linked files cannot be previewed.');
  return result;
}
function uniquePaths(entries) {
  const paths = new Set();
  for (const entry of entries) {
    const name = entry.name.normalize('NFC').toLowerCase();
    if (paths.has(name)) fail('scene-unsupported', 'The torrent file paths are ambiguous.');
    paths.add(name);
  }
  for (const name of paths) {
    const parts = name.split('/');
    for (let length = 1; length < parts.length; length++) if (paths.has(parts.slice(0, length).join('/')))
      fail('scene-unsupported', 'The torrent file paths are ambiguous.');
  }
}
function v2Files(tree, pieceSize) {
  if (!(tree instanceof Map) || tree.size === 0) bad();
  const files = [];
  let offset = 0;
  function visit(node, path) {
    if (!(node instanceof Map) || !node.size) bad();
    if (has(node, '')) {
      if (node.size !== 1 || !path.length) bad();
      const leaf = get(node, '');
      if (!(leaf instanceof Map) || attributes(leaf).includes('p')) bad();
      const size = fileSize(get(leaf, 'length')), root = get(leaf, 'pieces root');
      if (size > 0 ? !Buffer.isBuffer(root) || root.length !== 32 : root !== undefined) bad();
      files.push({ name: path.join('/'), size, offset });
      offset += Math.ceil(size / pieceSize) * pieceSize;
      if (offset > SOURCE_LIMIT + pieceSize) fail('scene-limit', 'This source exceeds the preview size limit.');
      return;
    }
    for (const [encoded, child] of node) visit(child, [...path, component(text(Buffer.from(encoded, 'hex')))]);
  }
  visit(tree, []);
  uniquePaths(files);
  return files;
}

/** Read bounded authenticated export bytes. The caller owns connection identity.
 * Hybrid support proves the original info under both advertised hashes and
 * requires congruent, piece-aligned v1/v2 real-file layouts. Only v1 piece hashes
 * are used for local byte verification; pure v2 is intentionally unsupported. */
async function readMetainfo(response, { hash, properties = {}, signal } = {}) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) bad();
  const bytes = await cappedBody(response, signal);
  abort(signal);
  const { info, rawInfo } = strictDecode(bytes);
  const pieceSize = get(info, 'piece length');
  if (!Number.isSafeInteger(pieceSize) || pieceSize < PIECE_MIN || pieceSize > PIECE_MAX)
    fail('scene-limit', 'This torrent piece size is outside the preview limits.');
  const hashes = get(info, 'pieces');
  if (!Buffer.isBuffer(hashes)) fail('scene-unsupported', 'This torrent format cannot be previewed yet.');
  const v1 = hashBytes('sha1', rawInfo).toString('hex');
  const active = typeof hash === 'string' ? hash.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(active)) bad();
  const hybrid = has(info, 'meta version') || has(info, 'file tree');
  const propertyV1 = typeof properties.infohash_v1 === 'string' ? properties.infohash_v1.toLowerCase() : null;
  const propertyV2 = typeof properties.infohash_v2 === 'string' ? properties.infohash_v2.toLowerCase() : null;
  if (hybrid) {
    const v2 = hashBytes('sha256', rawInfo).toString('hex');
    if (get(info, 'meta version') !== 2 || !Number.isInteger(Math.log2(pieceSize)) || !(get(info, 'file tree') instanceof Map) ||
        propertyV1 !== v1 || propertyV2 !== v2 || active !== v2.slice(0, 40)) bad();
  } else if (active !== v1 || Object.hasOwn(properties, 'infohash_v1') && propertyV1 !== v1 ||
      properties.infohash_v2 !== undefined && properties.infohash_v2 !== '') bad();
  const rootName = component(text(get(info, 'name'))), entries = [];
  if (has(info, 'name.utf-8') && text(get(info, 'name.utf-8')) !== rootName) bad();
  let totalSize = 0;
  const add = (name, size, padding) => {
    entries.push(Object.freeze({ name, size, offset: totalSize, padding }));
    totalSize += size;
    if (totalSize > SOURCE_LIMIT) fail('scene-limit', 'This source exceeds the preview size limit.');
  };
  if (has(info, 'files') === has(info, 'length')) bad();
  if (has(info, 'length')) {
    if (attributes(info).includes('p')) bad();
    add(rootName, fileSize(get(info, 'length')), false);
  } else {
    const files = get(info, 'files');
    if (!Array.isArray(files) || !files.length) bad();
    for (const file of files) {
      if (!(file instanceof Map)) bad();
      const path = get(file, 'path');
      if (!Array.isArray(path) || !path.length) bad();
      const parts = path.map(value => component(text(value)));
      if (has(file, 'path.utf-8')) {
        const alias = get(file, 'path.utf-8');
        if (!Array.isArray(alias) || alias.length !== parts.length || alias.some((value, index) => text(value) !== parts[index])) bad();
      }
      add(parts.join('/'), fileSize(get(file, 'length')), attributes(file).includes('p'));
    }
  }
  if (!totalSize) fail('scene-unsupported', 'This torrent has no previewable data.');
  uniquePaths(entries);
  const pieceCount = Math.ceil(totalSize / pieceSize);
  if (hashes.length !== pieceCount * 20) bad();
  if (hybrid) {
    const actual = entries.filter(entry => !entry.padding), tree = v2Files(get(info, 'file tree'), pieceSize);
    if (actual.length !== tree.length || actual.some((file, index) =>
      file.name !== tree[index].name || file.size !== tree[index].size || file.offset !== tree[index].offset)) bad();
  }
  const result = Object.freeze({ pieceSize, pieceCount, totalSize, pieceHashes: Buffer.from(hashes), entries: Object.freeze(entries), rootName, hybrid });
  verifiedMetadata.set(result, { ...result, pieceHashes: Buffer.from(hashes) });
  return result;
}

export async function readSceneMetainfo(response, options) {
  try { return await readMetainfo(response, options); }
  catch (error) {
    // Also release rejected status/type/identity responses whose body was never
    // consumed. The ordinary authenticated session is owned by the caller.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw error;
  }
}

export function matchSceneTorrentFile(metadata, file) {
  const trusted = verifiedMetadata.get(metadata);
  if (!trusted || !file || !Number.isSafeInteger(file.index) || file.index < 0 || !Number.isSafeInteger(file.size) || file.size < 1) bad();
  if (typeof file.name !== 'string') bad();
  const name = file.name.replaceAll('\\', '/').split('/').map(component).join('/');
  const matches = trusted.entries.filter(entry => !entry.padding && entry.size === file.size &&
    (name === entry.name || name === trusted.rootName + '/' + entry.name));
  if (matches.length !== 1) fail('scene-unverified', 'The selected file does not match the torrent metadata.');
  const entry = matches[0], first = Math.floor(entry.offset / trusted.pieceSize), last = Math.floor((entry.offset + entry.size - 1) / trusted.pieceSize);
  if (!Array.isArray(file.piece_range) || file.piece_range.length !== 2 || file.piece_range[0] !== first || file.piece_range[1] !== last) bad();
  return Object.freeze({ name, index: file.index, size: file.size, offset: entry.offset });
}
/** The caller owns/leases the descriptor and must check its identity and current
 * connection/source layout before publication. This reader never closes it,
 * contacts qBittorrent, waits for missing data, or changes download priorities.
 * Every range is file-relative and half-open. Returned slices are independent
 * copies; only full-piece authenticated bytes are retained internally. */
export function createVerifiedScenePieces({ metadata, file, handle, signal } = {}) {
  const trusted = verifiedMetadata.get(metadata);
  if (!trusted || !file || !handle || typeof handle.read !== 'function' || !Number.isSafeInteger(file.index) || file.index < 0) bad();
  const selected = trusted.entries.filter(entry => !entry.padding && entry.offset === file.offset && entry.size === file.size &&
    (file.name === entry.name || file.name === trusted.rootName + '/' + entry.name));
  if (selected.length !== 1 || file.size < 1) bad();
  const entry = selected[0], copies = new Map();
  let copiedBytes = 0, bootstrapBytes = 0, busy = false;
  const check = phaseSignal => { abort(signal); abort(phaseSignal); };
  const range = (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > entry.size)
      fail('scene-unverified', 'The requested preview range is invalid.');
  };
  const pieceLength = piece => Math.min(trusted.pieceSize, trusted.totalSize - piece * trusted.pieceSize);
  function statesShape(states) {
    if (!(Array.isArray(states) || ArrayBuffer.isView(states)) || states.length !== trusted.pieceCount)
      fail('scene-unverified', 'The torrent piece state could not be verified.');
  }
  function requireState(states, piece) {
    if (states[piece] !== 2) fail('scene-missing', 'The requested scene data is not available yet.');
  }
  function recheck(states) {
    check(); statesShape(states);
    for (const piece of copies.keys()) requireState(states, piece);
  }
  function piecePlan(piece) {
    const start = piece * trusted.pieceSize, end = start + pieceLength(piece), segments = [];
    let low = 0, high = trusted.entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2), item = trusted.entries[middle];
      if (item.offset + item.size <= start) low = middle + 1; else high = middle;
    }
    let covered = start;
    for (let i = low; i < trusted.entries.length && trusted.entries[i].offset < end; i++) {
      const item = trusted.entries[i], from = Math.max(start, item.offset), to = Math.min(end, item.offset + item.size);
      if (to <= from) continue;
      if (from !== covered) bad();
      if (item !== entry && !item.padding)
        fail('scene-unsupported', 'A required piece also contains another file.');
      if (!item.padding) segments.push({ target: from - start, position: from - entry.offset, length: to - from });
      covered = to;
    }
    if (covered !== end) bad();
    return { piece, length: end - start, segments };
  }
  function neededPieces(ranges) {
    if (!Array.isArray(ranges) || ranges.length > 65536) fail('scene-limit', 'Too many preview ranges were requested.');
    const needed = new Set();
    for (const item of ranges) {
      const start = Array.isArray(item) ? item[0] : item?.start, end = Array.isArray(item) ? item[1] : item?.end;
      range(start, end);
      if (start === end) continue;
      const first = Math.floor((entry.offset + start) / trusted.pieceSize), last = Math.floor((entry.offset + end - 1) / trusted.pieceSize);
      for (let piece = first; piece <= last; piece++) {
        if (!copies.has(piece)) needed.add(piece);
        // Bound this set before building plans or allocating data, even for a
        // malicious request spanning a very large otherwise-valid source.
        if (needed.size * PIECE_MIN > COPY_LIMIT) fail('scene-limit', 'This scene exceeds the preview data limit.');
      }
    }
    return needed;
  }
  function hasRunway(reserve, states) {
    check();
    try {
      recheck(states);
      if (!Array.isArray(reserve) || reserve.length !== 2) return false;
      const [start, end] = reserve;
      range(start, end);
      const first = (entry.offset + start) / trusted.pieceSize, limit = (entry.offset + end) / trusted.pieceSize;
      if (!Number.isInteger(first) || !Number.isInteger(limit) || limit - first < 2 ||
          limit - first > FETCH_MAX_RESERVE_PIECES || limit > trusted.pieceCount) return false;
      for (let piece = first; piece < limit; piece++) requireState(states, piece);
      return true;
    } catch (error) {
      if (!(error instanceof SceneProofError)) throw error;
      return false;
    }
  }
  function fetchPlan(ranges, foreground, states) {
    check();
    if (!foreground) return null;
    try {
      const { start, end } = foreground;
      range(start, end);
      if (start === end) return null;
      statesShape(states);
      const size = trusted.pieceSize;
      let first = Math.floor((entry.offset + start) / size), limit = Math.ceil((entry.offset + end) / size);
      if (limit - first === 1) {
        if ((limit + 1) * size <= entry.offset + entry.size && states[limit] === 2) limit++;
        else if ((first - 1) * size >= entry.offset && states[first - 1] === 2) first--;
      }
      // Native alignment is relative to the torrent, even when the file starts mid-piece.
      const reserve = [first * size - entry.offset, limit * size - entry.offset];
      if (!hasRunway(reserve, states)) return null;

      let copyBytes = copiedBytes, targetBytes = 0;
      const missing = [];
      for (const piece of neededPieces(ranges)) {
        const { length } = piecePlan(piece);
        copyBytes += length;
        if (copyBytes > COPY_LIMIT) return null;
        if (states[piece] === 2) continue;
        if ((states[piece] !== 0 && states[piece] !== 1) || (piece >= first && piece < limit)) return null;
        targetBytes += length;
        if (targetBytes > FETCH_MAX_TARGET_BYTES || missing.length >= FETCH_MAX_TARGET_PIECES) return null;
        missing.push(piece);
      }
      if (!missing.length) return null;
      const targets = [];
      for (const piece of missing.sort((left, right) => left - right)) {
        const from = Math.max(0, piece * size - entry.offset);
        const to = Math.min(entry.size, (piece + 1) * size - entry.offset);
        const last = targets.at(-1);
        if (last?.[1] === from) last[1] = to;
        else targets.push([from, to]);
      }
      return { reserve, ranges: targets };
    } catch (error) {
      if (!(error instanceof SceneProofError)) throw error;
      return null;
    }
  }
  async function admitInner(ranges, states, phaseSignal) {
    check(phaseSignal); recheck(states);
    const needed = neededPieces(ranges);
    let newBytes = 0;
    const plans = [];
    for (const piece of needed) {
      newBytes += pieceLength(piece);
      if (newBytes > COPY_LIMIT - copiedBytes) fail('scene-limit', 'This scene exceeds the preview data limit.');
      requireState(states, piece);
      plans.push(piecePlan(piece));
    }
    const pending = new Map();
    for (const plan of plans) {
      check(phaseSignal);
      // Only declared padding remains zero. The entire reconstructed piece,
      // including padding, must match its original digest before admission.
      const bytes = Buffer.alloc(plan.length);
      for (const segment of plan.segments) {
        let read = 0;
        while (read < segment.length) {
          check(phaseSignal);
          let result;
          try { result = await handle.read(bytes, segment.target + read, segment.length - read, segment.position + read); }
          catch { check(phaseSignal); fail('scene-unverified', 'The requested scene bytes could not be read.'); }
          check(phaseSignal);
          if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 1 || result.bytesRead > segment.length - read)
            fail('scene-unverified', 'The requested scene bytes could not be read completely.');
          read += result.bytesRead;
        }
      }
      check(phaseSignal);
      const expected = trusted.pieceHashes.subarray(plan.piece * 20, (plan.piece + 1) * 20);
      if (!hashBytes('sha1', bytes).equals(expected)) fail('scene-unverified', 'The requested scene bytes did not pass verification.');
      pending.set(plan.piece, bytes);
    }
    check(phaseSignal); recheck(states);
    for (const piece of pending.keys()) requireState(states, piece);
    for (const [piece, bytes] of pending) copies.set(piece, bytes);
    copiedBytes += newBytes;
  }
  async function exclusive(work) {
    if (busy) fail('scene-limit', 'A preview read is already in progress.');
    busy = true;
    try { return await work(); } finally { busy = false; }
  }
  function availableEnd(start) {
    check(); range(start, start);
    let position = entry.offset + start;
    const end = entry.offset + entry.size;
    while (position < end) {
      const piece = Math.floor(position / trusted.pieceSize);
      if (!copies.has(piece)) break;
      position = Math.min(end, (piece + 1) * trusted.pieceSize);
    }
    return position - entry.offset;
  }
  function slice(start, end) {
    check(); range(start, end);
    if (availableEnd(start) < end) fail('scene-missing', 'The requested scene data is not available yet.');
    const result = Buffer.alloc(end - start);
    let position = entry.offset + start, written = 0;
    while (written < result.length) {
      const piece = Math.floor(position / trusted.pieceSize), bytes = copies.get(piece), from = position % trusted.pieceSize;
      const length = Math.min(bytes.length - from, result.length - written);
      bytes.copy(result, written, from, from + length);
      written += length; position += length;
    }
    return result;
  }
  return Object.freeze({
    read(start, end, states, phaseSignal) {
      return exclusive(async () => {
        check(phaseSignal); range(start, end);
        if (end - start > 256 * 1024 || end - start > METADATA_LIMIT - bootstrapBytes)
          fail('scene-limit', 'The video opening exceeds the preview index limit.');
        await admitInner([{ start, end }], states, phaseSignal);
        check(phaseSignal);
        bootstrapBytes += end - start;
        return slice(start, end);
      });
    },
    admit(ranges, states, phaseSignal) { return exclusive(() => admitInner(ranges, states, phaseSignal)); },
    recheck, availableEnd, slice, fetchPlan, hasRunway,
    get pieceCount() { return copies.size; }
  });
}

import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const maximumSamples = 120;
const minuteMs = 60_000;
const retentionMs = 30 * 24 * 60 * minuteMs;
const maximumStartMs = 30 * minuteMs;
const maximumLedgerBytes = 64 * 1024;
const maximumArchiveBytes = 256 * 1024;
const maximumArchives = 3;
const renameAttempts = 6;
const renameRetryMs = 80;
const transientRenameErrors = new Set(['EPERM', 'EBUSY', 'EACCES']);
const conditions = ['downloading', 'downloaded'];
const modes = ['direct', 'hls'];
const digestPattern = /^[0-9a-f]{64}$/;
const hashPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const sessionPattern = /^[0-9a-f]{32}$/i;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

function nonce(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

function sign(key, purpose, value = '') {
  return createHmac('sha256', key).update('cinema-source-memory:' + purpose + ':v1\0')
    .update(value).digest('hex');
}

function scopeKey(master, salt, scope) {
  return Buffer.from(sign(master, 'scope', salt + scope), 'hex');
}

function normalizeFile(file) {
  if (!matches(file?.hash, hashPattern) || !Number.isSafeInteger(file.index) || file.index < 0 ||
    !Number.isSafeInteger(file.size) || file.size <= 0 || !conditions.includes(file.condition) ||
    !modes.includes(file.mode) || typeof file.name !== 'string' || !file.name || file.name.length > 4096 ||
    /[\u0000-\u001f]/.test(file.name)) return null;
  const name = file.name.replaceAll('\\', '/');
  if (path.win32.isAbsolute(name) || /^[a-z]:/i.test(name) ||
    name.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return { hash: file.hash.toLowerCase(), index: file.index, name, size: file.size,
    condition: file.condition, mode: file.mode };
}

function validStart(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximumStartMs;
}

function validStoredSample(sample) {
  return matches(sample?.release, digestPattern) && matches(sample.file, digestPattern) &&
    matches(sample.session, digestPattern) && conditions.includes(sample.condition) &&
    modes.includes(sample.mode) && validStart(sample.firstPictureMs) &&
    Number.isSafeInteger(sample.at) && sample.at >= 0 && sample.at % minuteMs === 0;
}

function decodeLedger(raw, master) {
  if (!master || !raw?.bytes || raw.bytes.length > maximumLedgerBytes) return null;
  let value;
  try { value = JSON.parse(raw.bytes.toString('utf8')); } catch { return null; }
  if (value?.schema !== 1 || typeof value.enabled !== 'boolean' ||
    !matches(value.salt, digestPattern) || value.keyCheck !== sign(master, 'key-check') ||
    !Array.isArray(value.samples) || value.samples.length > maximumSamples ||
    !value.samples.every(validStoredSample) ||
    new Set(value.samples.map(sample => sample.session)).size !== value.samples.length) return null;
  const samples = value.samples.map(({release, file, session, condition, mode, firstPictureMs, at}) =>
    ({release, file, session, condition, mode, firstPictureMs, at}));
  return { enabled: value.enabled, salt: value.salt, samples };
}

async function readBounded(file, limit) {
  let handle;
  try { handle = await fs.open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Source Memory storage is not a regular file');
    if (stat.size > limit) return { oversize: true };
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < bytes.length) {
      const {bytesRead} = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    return total > limit ? { oversize: true } : { bytes: bytes.subarray(0, total) };
  } finally { await handle.close(); }
}

async function writeExclusive(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(file).catch(() => {});
    throw error;
  }
}

async function atomicReplace(file, data, {beforeRename = () => true, rename = fs.rename} = {}) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + nonce(12) + '.tmp');
  await writeExclusive(temporary, data);
  let moved = false;
  try {
    for (let attempt = 1; ; attempt++) {
      if (!beforeRename()) return false;
      try {
        await rename(temporary, file);
        moved = true;
        return true;
      } catch (error) {
        if (attempt >= renameAttempts || !transientRenameErrors.has(error?.code)) throw error;
        await delay(renameRetryMs);
      }
    }
  } finally {
    if (!moved) await fs.unlink(temporary).catch(() => {});
  }
}

function jsonBytes(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Value must be serializable as JSON');
  return Buffer.from(encoded + '\n');
}

export async function atomicWriteLocalJson(file, value, {rename = fs.rename} = {}) {
  await atomicReplace(file, jsonBytes(value), {rename});
}

async function archiveOriginal(file) {
  const raw = await readBounded(file, maximumArchiveBytes);
  if (!raw?.bytes) throw new Error('Source Memory cannot preserve the damaged file within the recovery limit');
  const directory = path.dirname(file);
  const prefix = path.basename(file) + '.corrupt-';
  const names = await fs.readdir(directory);
  const archives = names.filter(name => name.startsWith(prefix) &&
    /^[0-9a-f]{24}$/.test(name.slice(prefix.length)));
  if (archives.length >= maximumArchives) throw new Error('Source Memory recovery archive limit reached');
  await writeExclusive(path.join(directory, prefix + nonce(12)), raw.bytes);
}

function median(values) {
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export async function createSourceMemory({local, now = Date.now, prepareLocal, rename = fs.rename}) {
  const filename = path.join(local, 'source-memory.json');
  const keyFilename = path.join(local, 'source-memory.key');
  let privateStorage=true,raw=null,rawKey=null;
  try{
    await prepareLocal?.(false);
    [raw,rawKey]=await Promise.all([readBounded(filename,maximumLedgerBytes),readBounded(keyFilename,32)]);
  }catch{privateStorage=false;}
  let master = rawKey?.bytes?.length === 32 ? rawKey.bytes : null;
  const decoded = decodeLedger(raw, master);
  let damagedLedger = Boolean(raw && !decoded), damagedKey = Boolean(rawKey && !master);
  let archivedLedger = false, archivedKey = false;
  let state = decoded ?? { enabled: false, salt: nonce(32), samples: [] };
  let revision = nonce(), version = 0, pendingPreference = 0, queue = Promise.resolve();

  async function verifyStorage(create) {
    if (!privateStorage) return false;
    try { if (await prepareLocal?.(create) !== false) return true; }
    catch { /* The storage path no longer meets the privacy boundary. */ }
    privateStorage = false;
    revision = nonce();
    version++;
    return false;
  }

  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  function currentTime() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid Source Memory clock');
    return value;
  }

  function retained(samples, time) {
    return samples.filter(sample => sample.at <= time && time - sample.at < retentionMs);
  }

  function admission() {
    return privateStorage && state.enabled && master && !pendingPreference ? revision : null;
  }

  function save(next, guard) {
    return atomicReplace(filename, jsonBytes({ schema: 1, enabled: next.enabled, salt: next.salt,
      keyCheck: sign(master, 'key-check'), samples: next.samples }), {beforeRename: guard, rename});
  }

  function changePreference(update) {
    // Fence previously issued admissions before any async or queued disk work.
    revision = nonce();
    pendingPreference++;
    return serial(async () => {
      try {
        if(!await verifyStorage(true))throw Error('Cinema could not open private storage for Source Memory.');
        if (damagedLedger && !archivedLedger) {
          await archiveOriginal(filename);
          archivedLedger = true;
        }
        if (damagedKey && !archivedKey) {
          await archiveOriginal(keyFilename);
          archivedKey = true;
        }
        if (!master) {
          const nextMaster = randomBytes(32);
          await atomicReplace(keyFilename, nextMaster, {rename});
          master = nextMaster;
          damagedKey = false;
        }
        const next = update({ ...state, samples: retained(state.samples, currentTime()) });
        await save(next);
        state = next;
        damagedLedger = false;
        version++;
      } finally { pendingPreference--; }
    });
  }

  function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Source Memory preference must be boolean');
    return changePreference(next => ({ ...next, enabled }));
  }

  function clear() {
    return changePreference(next => ({ ...next, salt: nonce(32), samples: [] }));
  }

  async function record(report) {
    const { revision: admitted, scope, sessionId, firstPictureMs, attest, isCurrent = () => true } = report ?? {};
    const current = () => typeof admitted === 'string' && admitted === admission() && isCurrent();
    if (!current() || !matches(scope, digestPattern) || !matches(sessionId, sessionPattern) ||
      !validStart(firstPictureMs) || typeof attest !== 'function') return false;
    return serial(async () => {
      if (!current()) return false;
      const key = scopeKey(master, state.salt, scope);
      const session = sign(key, 'session', sessionId.toLowerCase());
      if (state.samples.some(sample => sample.session === session)) return false;
      // A verified ACL can change after startup or the last preference write.
      if (!await verifyStorage(false) || !current()) return false;
      const selected = normalizeFile(attest());
      if (!selected || !current()) return false;
      const time = currentTime();
      const sample = {
        release: sign(key, 'release', selected.hash),
        file: sign(key, 'file', JSON.stringify([selected.hash, selected.index, selected.name, selected.size])),
        session, condition: selected.condition, mode: selected.mode, firstPictureMs,
        at: Math.floor(time / minuteMs) * minuteMs,
      };
      const next = { ...state, samples: [...retained(state.samples, time), sample].slice(-maximumSamples) };
      if (!await save(next, current)) return false;
      state = next;
      version++;
      return current();
    });
  }

  function view(scope, library) {
    const available = privateStorage && matches(scope, digestPattern);
    const result = { enabled: state.enabled, revision, version, available, storageAvailable: privateStorage, observed: [] };
    if (!admission() || !available || !Array.isArray(library)) return result;
    const samples = retained(state.samples, currentTime());
    if (!samples.length) return result;
    const key = scopeKey(master, state.salt, scope);
    const byRelease = new Map();
    for (const sample of samples) {
      let entry = byRelease.get(sample.release);
      if (!entry) {
        entry = { file: sample.file, samples: [] };
        byRelease.set(sample.release, entry);
      }
      entry.file = sample.file;
      entry.samples.push(sample);
    }
    const seen = new Set();
    for (const item of library) {
      if (!matches(item?.hash, hashPattern)) continue;
      const hash = item.hash.toLowerCase();
      if (seen.has(hash)) continue;
      seen.add(hash);
      const matching = byRelease.get(sign(key, 'release', hash));
      if (!matching) continue;
      const cohorts = [];
      for (const condition of conditions) for (const mode of modes) {
        const values = matching.samples.filter(sample => sample.file === matching.file &&
          sample.condition === condition && sample.mode === mode).map(sample => sample.firstPictureMs);
        if (values.length) cohorts.push({condition, mode, count: values.length, medianMs: median(values)});
      }
      result.observed.push({hash, cohorts});
    }
    return result;
  }

  return { admission, view, setEnabled, clear, record };
}

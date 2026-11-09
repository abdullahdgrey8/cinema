const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_DEADLINE_MS = 12 * HOUR_MS;
const OUTCOME_MAX_AGE_MS = 20_000;
const SAMPLE_COUNT = 4;
const MIN_SAMPLE_INTERVAL_MS = 8_000;
const MAX_SAMPLE_INTERVAL_MS = 20_000;
const MIN_SAMPLE_WINDOW_MS = 30_000;
const MIN_SAMPLE_BYTES = 256 * 1024;
const MIN_SAMPLE_SHARE_DENOMINATOR = 100_000;
const MAX_RATE_RATIO = 2.5;
const WAITING = new Set(['downloading', 'paused', 'on-disk']);

export function localAppointmentInput(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const year = date.getFullYear();
  if (!Number.isInteger(year) || year < 0 || year > 9999) return '';
  const twoDigits = (part) => String(part).padStart(2, '0');
  return [
    String(year).padStart(4, '0'),
    '-', twoDigits(date.getMonth() + 1),
    '-', twoDigits(date.getDate()),
    'T', twoDigits(date.getHours()),
    ':', twoDigits(date.getMinutes()),
  ].join('');
}

export function parseAppointmentDeadline(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(now)) return null;
  const date = new Date(value + ':00');
  const ms = date.getTime();
  if (!(ms > now && ms - now <= MAX_DEADLINE_MS) || localAppointmentInput(ms) !== value) return null;

  // Local Date chooses one instant in a repeated hour. Test the adjacent offsets to detect the other instant.
  const offset = date.getTimezoneOffset();
  for (const day of [-24 * HOUR_MS, 24 * HOUR_MS]) {
    const offsetChange = new Date(ms + day).getTimezoneOffset() - offset;
    if (offsetChange && localAppointmentInput(ms + offsetChange * MINUTE_MS) === value) return null;
  }
  return ms;
}

function validSample(sample) {
  return sample && typeof sample.key === 'string' && sample.key.length > 0 &&
    Number.isSafeInteger(sample.size) && sample.size > 0 &&
    Number.isSafeInteger(sample.downloaded) && sample.downloaded >= 0 && sample.downloaded < sample.size &&
    Number.isFinite(sample.observedMs) && sample.observedMs >= 0;
}

function sampleRates(samples) {
  let slowest = Infinity;
  let fastest = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const next = samples[i];
    if (!validSample(prev) || !validSample(next) || next.key !== prev.key || next.size !== prev.size) return null;
    const elapsed = next.observedMs - prev.observedMs;
    const bytes = next.downloaded - prev.downloaded;
    if (elapsed < MIN_SAMPLE_INTERVAL_MS || elapsed > MAX_SAMPLE_INTERVAL_MS ||
        bytes < Math.max(MIN_SAMPLE_BYTES, next.size / MIN_SAMPLE_SHARE_DENOMINATOR)) return null;
    const rate = bytes / elapsed;
    slowest = Math.min(slowest, rate);
    fastest = Math.max(fastest, rate);
  }
  return fastest / slowest <= MAX_RATE_RATIO ? { fastest, slowest } : null;
}

export function appendAppointmentSample(samples, file, observedMs) {
  if (file?.status !== 'downloading') return [];
  const { key, size, downloaded } = file;
  const sample = { key, size, downloaded, observedMs };
  if (!validSample(sample)) return [];
  const previous = samples.at(-1);
  if (!validSample(previous)) return [sample];
  if (observedMs <= previous.observedMs) return [];

  const window = [...samples.slice(-(SAMPLE_COUNT - 1)), sample];
  return sampleRates(window) ? window : [sample];
}

export function estimateAppointment(samples) {
  if (samples.length !== SAMPLE_COUNT) return null;
  const rates = sampleRates(samples);
  if (!rates) return null;
  const last = samples.at(-1);
  if (last.observedMs - samples[0].observedMs < MIN_SAMPLE_WINDOW_MS) return null;

  const remaining = last.size - last.downloaded;
  const earlyMinutes = Math.floor(remaining / (1.15 * rates.fastest * MINUTE_MS));
  const lateMinutes = Math.ceil(remaining / (0.65 * rates.slowest * MINUTE_MS));
  if (lateMinutes > MAX_DEADLINE_MS / MINUTE_MS || lateMinutes - earlyMinutes > 180) return null;
  return { earlyMinutes, lateMinutes };
}

export function classifyAppointmentDeadline({ due, checkedAt, status, available }) {
  if (available !== true || !Number.isFinite(due) || !Number.isFinite(checkedAt) ||
      checkedAt > due || due - checkedAt > OUTCOME_MAX_AGE_MS) return 'unconfirmed';
  if (status === 'ready') return 'ready';
  return WAITING.has(status) ? 'waiting' : 'unconfirmed';
}

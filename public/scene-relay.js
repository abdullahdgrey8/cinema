import { updateHTML } from './dom.js';

const PIN_LIMIT = 120;
const PIN_STORAGE = 'cinema-scene-pins-v1';
const CARD_BYTES = 4096;
const CARD_FILENAME = 'cinema-scene-card.json';
const CONTEXT_SECONDS = 25;
const words = text => String(text).slice(0, 900).normalize('NFKC').toLowerCase()
  .replace(/<[^>]*>|\[[^\]]*\]|\{[^}]*\}|&(?:nbsp|amp|lt|gt|quot);/gi, ' ')
  .replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) || [];
const fingerprint = word => {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
  return hash >>> 0;
};
const identityText = text => String(text).normalize('NFKC').toLowerCase()
  .replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function portableSceneIdentity({ episode, fileLabel, metadata } = {}) {
  if (/^tvmaze-\d+$/.test(episode?.showId) && /^tvmaze-episode-\d+$/.test(episode?.episodeId)) return `episode:${episode.showId}:${episode.episodeId}`;
  if (metadata?.kind !== 'movies' || metadata.isSeries === true) return null;
  const parsed = /^(.*?)\s+[([]?((?:18|19|20)\d{2})[)\]]?(?:[ .–-]+(?:extended(?: edition| cut)?|directors?'? cut|final cut|theatrical(?: cut)?|unrated|remastered))*$/i.exec(String(fileLabel).trim());
  if (!parsed || Number(parsed[2]) !== Number(metadata.year)) return null;
  const title = identityText(parsed[1]);
  return title && title === identityText(metadata.title) ? `movie:${parsed[2]}:${title}` : null;
}

export function createDialogueIndex(cues) {
  const lines = [];
  const tokens = [], starts = new Map();
  for (const cue of (cues || []).slice(0, 20000).sort((a, b) => a.startTime - b.startTime)) {
    if (!Number.isFinite(cue.startTime) || !Number.isFinite(cue.endTime) || cue.endTime <= cue.startTime) continue;
    const parts = words(cue.text);
    if (!parts.length) continue;
    const line = { time: cue.startTime, end: cue.endTime, offset: tokens.length, chars: parts.join('').length, phrase: parts.map(fingerprint) };
    lines.push(line);
    for (const value of line.phrase) {
      if (!starts.has(value)) starts.set(value, []);
      starts.get(value).push(tokens.length);
      tokens.push({ value, line });
    }
  }
  return { lines, tokens, starts };
}

export function createSceneAnchor(index, time) {
  if (!Number.isFinite(time)) return null;
  const usable = line => line.phrase.length >= 4 && line.chars >= 16;
  const near = index.lines.filter(line => usable(line) && line.phrase.length >= 5 && time >= line.time - 2 && time <= line.end + 2 && time - line.time <= 6);
  const primary = near.sort((a, b) => Math.abs(a.time - time) - Math.abs(b.time - time))[0];
  if (!primary) return null;
  const previous = index.lines.findLast(line => usable(line) && line.end <= primary.time && primary.time - line.time <= CONTEXT_SECONDS);
  const next = index.lines.find(line => usable(line) && line.time >= primary.end && line.time - primary.time <= CONTEXT_SECONDS);
  if (!previous && !next) return null;
  return { phrase: primary.phrase.slice(0, 12), before: previous?.phrase.slice(0, 9), after: next?.phrase.slice(0, 9), delta: time - primary.time };
}

function findPhrase(index, phrase, min = 0, max = index.tokens.length - 1) {
  if (!phrase?.length) return [];
  const matches = [];
  for (const offset of index.starts.get(phrase[0]) || []) {
    if (offset < min) continue;
    if (offset > max) break;
    const first = index.tokens[offset].line, last = index.tokens[offset + phrase.length - 1]?.line;
    if (!last || last.time - first.time > 7 || !phrase.every((value, i) => index.tokens[offset + i]?.value === value)) continue;
    matches.push({ offset, first, last });
    if (matches.length > 120) break;
  }
  return matches;
}

export function resolveScenePin(pin, { fileKey, identity, index } = {}) {
  if (fileKey && fileKey === pin.fileKey) return { state: 'original', time: pin.position };
  if (!identity || pin.identity !== identity) return { state: 'unrelated' };
  if (!pin.anchor) return { state: 'local-only' };
  if (!index?.tokens.length) return { state: 'needs-track' };
  const { phrase, before, after, delta } = pin.anchor;
  const candidates = findPhrase(index, phrase);
  if (candidates.length > 120) return { state: 'ambiguous' };
  const ranked = [];
  for (const match of candidates) {
    const previous = findPhrase(index, before, Math.max(0, match.offset - 300), match.offset - (before?.length || 0))
      .some(hit => match.first.time - hit.first.time <= CONTEXT_SECONDS && hit.first !== match.first);
    const following = findPhrase(index, after, match.offset + phrase.length, match.offset + phrase.length + 300)
      .some(hit => hit.first.time - match.first.time <= CONTEXT_SECONDS && hit.first !== match.first);
    if (!previous && !following) continue;
    const time = match.first.time + delta;
    if (time >= 0 && !ranked.some(row => row.time === time)) ranked.push({ time, score: Number(previous) + Number(following) });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return { state: candidates.length > 1 ? 'ambiguous' : 'missing' };
  if (ranked[1]?.score === ranked[0].score) return { state: 'ambiguous' };
  return { state: 'matched', time: ranked[0].time };
}

function validAnchor(anchor) {
  const validPhrase = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max && Array.from(value).every(word => Number.isInteger(word) && word >= 0 && word <= 0xffffffff);
  return anchor && validPhrase(anchor.phrase, 5, 12) && (validPhrase(anchor.before, 4, 9) || validPhrase(anchor.after, 4, 9)) &&
    (anchor.before === undefined || validPhrase(anchor.before, 4, 9)) && (anchor.after === undefined || validPhrase(anchor.after, 4, 9)) &&
    Number.isFinite(anchor.delta) && anchor.delta >= -2 && anchor.delta <= 6;
}


function validCardIdentity(identity) {
  if (typeof identity !== 'string' || identity.length > 256) return false;
  if (/^episode:tvmaze-\d{1,12}:tvmaze-episode-\d{1,12}$/.test(identity)) return true;
  const title = /^movie:(?:18|19|20)\d{2}:(.+)$/u.exec(identity)?.[1];
  return Boolean(title && title === identityText(title));
}

function cardAnchor(anchor) {
  if (!validAnchor(anchor)) return null;
  const { phrase, before, after, delta } = anchor;
  return {
    phrase: [...phrase],
    ...(before ? { before: [...before] } : {}),
    ...(after ? { after: [...after] } : {}),
    delta
  };
}

const hasOnlyFields = (value, fields) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => fields.includes(key)));
const fitsCard = value => typeof value === 'string' && value.length <= CARD_BYTES &&
  new TextEncoder().encode(value).length <= CARD_BYTES;

export function serializeSceneCard(pin) {
  if (!validCardIdentity(pin?.identity)) return null;
  const anchor = cardAnchor(pin.anchor);
  if (!anchor) return null;
  const json = JSON.stringify({ version: 1, identity: pin.identity, anchor }) + '\n';
  return fitsCard(json) ? json : null;
}

export function parseSceneCard(value, activeIdentity) {
  if (typeof value !== 'string') throw Error('This file is not a valid Cinema scene card.');
  if (!fitsCard(value)) throw Error('Choose a scene card no larger than 4 KiB.');
  let card;
  try { card = JSON.parse(value); } catch { throw Error('This file is not a valid Cinema scene card.'); }
  if (!hasOnlyFields(card, ['version', 'identity', 'anchor']) || !Object.hasOwn(card, 'version')) {
    throw Error('This file is not a valid Cinema scene card.');
  }
  if (card.version !== 1) throw Error('This scene card version is not supported.');
  if (!validCardIdentity(card.identity) || !hasOnlyFields(card.anchor, ['phrase', 'before', 'after', 'delta'])) {
    throw Error('This file is not a valid Cinema scene card.');
  }
  const anchor = cardAnchor(card.anchor);
  if (!anchor) throw Error('This file is not a valid Cinema scene card.');
  if (card.identity !== activeIdentity) throw Error('This scene card is for a different movie or episode.');
  return { identity: card.identity, anchor };
}


function restorePin(pin) {
  if (typeof pin?.id !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(pin.id)) return null;
  const anchor = cardAnchor(pin.anchor);
  if (typeof pin.fileKey === 'string' && Number.isFinite(pin.position) && pin.position >= 0 && typeof pin.note === 'string') {
    return { id: pin.id, fileKey: pin.fileKey, identity: typeof pin.identity === 'string' ? pin.identity : null,
      position: pin.position, note: pin.note.slice(0, 75), anchor };
  }
  if (!Object.hasOwn(pin, 'fileKey') && !Object.hasOwn(pin, 'position') && validCardIdentity(pin.identity) && anchor) {
    return { id: pin.id, identity: pin.identity, anchor };
  }
  return null;
}

export function createSceneRelay({ host, arrival, getContext, canSeek, seek, clockTime, escape, onChange }) {
  const list = host.querySelector('.scene-pin-list'), status = host.querySelector('.scene-pin-status');
  const add = host.querySelector('.scene-pin-save'), note = host.querySelector('#scene-pin-label');
  const importCard = host.querySelector('.scene-card-import'), cardFile = host.querySelector('.scene-card-file');
  const arrivalStatus = arrival.querySelector('[role="status"]'), jump = arrival.querySelector('.scene-arrival-jump');
  let pins = [], generation = null, track = null, story = null, index, fileKey = null, waiting = null, matches = [], dirty = true;
  let pickerTarget = null, pickerId = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(PIN_STORAGE) || '[]');
    if (Array.isArray(saved)) {
      for (const value of saved) {
        const pin = restorePin(value);
        if (pin) pins.push(pin);
        if (pins.length >= PIN_LIMIT) break;
      }
    }
  } catch { /* An unavailable store is reported if the viewer tries to save. */ }

  function message(text) { if (status.textContent !== text) status.textContent = text; }
  function save(next) {
    try { localStorage.setItem(PIN_STORAGE, JSON.stringify(next)); }
    catch { message('Cinema could not save scene pins on this device.'); return false; }
    pins = next;
    dirty = true;
    return true;
  }

  function refresh(canSeekTime = canSeek) {
    const current = getContext();
    if (fileKey !== current?.fileKey) {
      fileKey = current?.fileKey;
      waiting = null;
      note.value = '';
      message('');
      dirty = true;
    }
    if (current?.track !== track || current?.generation !== generation || current?.identity !== story || dirty) {
      track = current?.track;
      generation = current?.generation;
      story = current?.identity;
      const relevant = pins.filter(pin => fileKey && pin.fileKey === fileKey || story && pin.identity === story);
      index = relevant.some(pin => pin.fileKey !== fileKey && pin.anchor) ? createDialogueIndex(current?.cues()) : null;
      matches = relevant.map(pin => ({ pin, portable: validCardIdentity(pin.identity) && Boolean(pin.anchor),
        ...resolveScenePin(pin, { fileKey, identity: story, index }) }));
      dirty = false;
    }
    add.disabled = !current?.canPin;
    if (importCard) importCard.disabled = !current?.fileKey || !validCardIdentity(current.identity);
    const marks = [];
    const html = matches.map(match => {
      const {pin, state, time, portable} = match;
      const ready = Number.isFinite(time) && canSeekTime(time);
      if (Number.isFinite(time)) marks.push({ id: pin.id, time, ready });
      const followed = waiting === pin.id;
      const detail = Number.isFinite(time) ? `${clockTime(time)} · ${state === 'matched' ? 'Matched in this release' : portable ? 'Portable pin' : 'This file'}` : ({
        ambiguous: 'Several scenes match', missing: 'This scene could not be matched', 'local-only': 'Available in the original file', 'needs-track': 'Load a matching subtitle track to locate this scene'
      }[state] || 'This scene belongs to another title');
      const action = ready ? 'Jump' : followed ? 'Unfollow' : 'Follow scene';
      const label = pin.note || (Number.isFinite(pin.position) ? `Scene at ${clockTime(pin.position)}` : 'Imported scene');
      return `<li><div><strong>${escape(label)}</strong><small>${escape(detail)}</small></div><div class="scene-pin-actions">
        ${Number.isFinite(time) ? `<button type="button" class="player-control" data-pin-action="${pin.id}">${action}</button>` : ''}
        ${portable ? `<button type="button" class="player-control" data-pin-export="${pin.id}" aria-label="${escape('Export scene card for ' + label)}">Export card</button>` : ''}
        <button type="button" class="player-control" data-pin-remove="${pin.id}" aria-label="Remove scene pin">×</button></div></li>`;
    }).join('');
    updateHTML(list, html);
    list.hidden = !matches.length;
    const selected = matches.find(match => match.pin.id === waiting);
    arrival.hidden = !selected;
    if (selected) {
      const ready = Number.isFinite(selected.time) && canSeekTime(selected.time);
      const text = ready ? `Scene ready at ${clockTime(selected.time)}.` : Number.isFinite(selected.time) ? `Waiting for the scene at ${clockTime(selected.time)}.` : 'Waiting for this scene to be located.';
      if (arrivalStatus.textContent !== text) arrivalStatus.textContent = text;
      jump.hidden = !ready;
    }
    return marks;
  }

  async function openPin(id, follow = true) {
    const current = getContext();
    refresh();
    const match = matches.find(row => row.pin.id === id);
    if (!Number.isFinite(match?.time)) return;
    if (!canSeek(match.time)) {
      if (follow) waiting = waiting === id ? null : id;
      refresh();
      onChange?.();
      return;
    }
    const moved = await seek(match.time, match.state === 'matched' ? current?.track : undefined);
    const now = getContext();
    if (now?.generation !== current?.generation || now?.track !== current?.track) return;
    if (!moved) { message('That scene is not ready to play.'); refresh(); return; }
    if (waiting === id) waiting = null;
    message(`Jumped to ${clockTime(match.time)}.`);
    refresh();
    onChange?.();
  }

  add.addEventListener('click', () => {
    const current = getContext();
    if (!current?.canPin || !Number.isFinite(current.time)) return;
    if (pins.length >= PIN_LIMIT) { message('Scene pins are full. Remove a pin before saving another.'); return; }
    const anchor = current.identity ? createSceneAnchor(index || createDialogueIndex(current.cues()), current.time) : null;
    const pin = { id: crypto.randomUUID(), fileKey: current.fileKey, identity: current.identity, position: current.time, note: note.value.trim().slice(0, 75), anchor };
    if (!save([pin, ...pins])) return;
    note.value = '';
    refresh();
    message(anchor ? 'Scene pinned. Cinema can look for it in another release.' : 'Scene pinned to this file.');
    onChange?.();
  });

  function exportPin(id) {
    refresh();
    const pin = matches.find(match => match.pin.id === id)?.pin;
    const json = serializeSceneCard(pin);
    if (!json) { message('This pin does not have matching dialogue to export.'); return; }
    let url, link;
    try {
      url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      link = document.createElement('a');
      link.href = url;
      link.download = CARD_FILENAME;
      document.body.append(link);
      link.click();
      message('Scene card export requested. Check your downloads.');
    } catch { message('Cinema could not start the scene card export.'); }
    finally {
      link?.remove();
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  importCard?.addEventListener('click', () => {
    const current = getContext();
    if (!cardFile || !current?.fileKey || !validCardIdentity(current.identity)) {
      message('Open a verified movie or episode to import a scene card.');
      return;
    }
    pickerTarget = { id: ++pickerId, fileKey: current.fileKey, generation: current.generation, identity: current.identity };
    cardFile.value = '';
    cardFile.click();
  });
  cardFile?.addEventListener('cancel', () => { pickerTarget = null; });
  cardFile?.addEventListener('change', async () => {
    const target = pickerTarget, file = cardFile.files?.[0];
    pickerTarget = null;
    cardFile.value = '';
    const stillCurrent = () => {
      const current = getContext();
      return target && target.id === pickerId && target.fileKey === current?.fileKey &&
        target.generation === current.generation && target.identity === current.identity;
    };
    if (!file || !stillCurrent()) return;
    if (file.size > CARD_BYTES) { message('Choose a scene card no larger than 4 KiB.'); return; }
    let raw;
    try { raw = await file.text(); }
    catch { if (stillCurrent()) message('Cinema could not read this scene card.'); return; }
    if (!stillCurrent()) return;
    let card;
    try { card = parseSceneCard(raw, target.identity); }
    catch (error) { message(error.message); return; }
    const canonical = serializeSceneCard(card);
    if (pins.some(pin => pin.identity === card.identity && serializeSceneCard(pin) === canonical)) {
      message('This scene card is already in your pins.');
      return;
    }
    if (pins.length >= PIN_LIMIT) { message('Scene pins are full. Remove a pin before importing another.'); return; }
    const pin = { id: crypto.randomUUID(), ...card };
    if (!save([pin, ...pins])) return;
    refresh();
    const match = matches.find(row => row.pin.id === pin.id);
    message(match?.state === 'needs-track' ? 'Scene card imported. Load matching subtitles to locate it.' : 'Scene card imported.');
    onChange?.();
  });

  list.addEventListener('click', event => {
    const action = event.target.closest('[data-pin-action]');
    if (action) { void openPin(action.dataset.pinAction); return; }
    const exported = event.target.closest('[data-pin-export]');
    if (exported) { exportPin(exported.dataset.pinExport); return; }
    const remove = event.target.closest('[data-pin-remove]');
    if (!remove) return;
    const id = remove.dataset.pinRemove;
    if (!save(pins.filter(pin => pin.id !== id))) return;
    if (waiting === id) waiting = null;
    refresh();
    (add.disabled && importCard && !importCard.disabled ? importCard : add).focus({ preventScroll: true });
    message('Scene pin removed.');
    onChange?.();
  });
  jump.addEventListener('click', () => { if (waiting) void openPin(waiting, false); });
  arrival.querySelector('.scene-arrival-cancel').addEventListener('click', () => { waiting = null; refresh(); onChange?.(); });

  return {
    refresh,
    focusPin(id) {
      host.closest('details').open = true;
      refresh();
      const button = [...list.querySelectorAll('[data-pin-action]')].find(item => item.dataset.pinAction === id);
      (button || (add.disabled && importCard && !importCard.disabled ? importCard : add)).focus();
    }
  };
}

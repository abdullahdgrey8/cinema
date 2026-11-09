import test from 'node:test';
import assert from 'node:assert/strict';
import { createDialogueIndex, createSceneAnchor, portableSceneIdentity, resolveScenePin } from '../public/scene-relay.js';

const identity = 'movie:2024:midnight bridge';
const cue = (startTime, text, length = 2) => ({startTime, endTime: startTime + length, text});
const scene = (shift = 0) => [cue(30 + shift, 'The last train leaves after midnight.'), cue(35 + shift, 'Keep the brass key beside the broken lantern.'), cue(40 + shift, 'We will meet behind the old station.')];
const pin = () => ({fileKey: 'cut-a:0', identity, position: 36, anchor: createSceneAnchor(createDialogueIndex(scene()), 36)});

test('a pin follows the same dialogue across a shifted release with different subtitle line breaks', () => {
  const [before, , after] = scene(17);
  const index = createDialogueIndex([before, cue(52, 'Keep the brass key'), cue(53, 'beside the broken lantern!'), after]);
  assert.deepEqual(resolveScenePin(pin(), {fileKey: 'cut-b:0', identity, index}), {state: 'matched', time: 53});
});

test('an indistinguishable repeated scene or a removed line never falls back to the old timestamp', () => {
  const repeat = createDialogueIndex([...scene(17), ...scene(120)]);
  assert.equal(resolveScenePin(pin(), {fileKey: 'cut-b:0', identity, index: repeat}).state, 'ambiguous');
  assert.equal(resolveScenePin(pin(), {fileKey: 'cut-b:0', identity, index: createDialogueIndex([scene(17)[0]])}).state, 'missing');
});

test('a different edition may share a story identity but a remake and an unverified episode cannot', () => {
  const metadata = {title: 'Midnight Bridge', year: 2024, kind: 'movies'};
  assert.equal(portableSceneIdentity({fileLabel: 'Midnight Bridge (2024) Extended Cut', metadata}), identity);
  assert.equal(portableSceneIdentity({fileLabel: 'Midnight Bridge 1978', metadata}), null);
  assert.equal(portableSceneIdentity({fileLabel: 'Midnight Bridge 2 2024', metadata}), null);
  assert.equal(portableSceneIdentity({fileLabel: 'Midnight Bridge', metadata}), null);
  assert.equal(portableSceneIdentity({episode: {showId: 'tvmaze-34', episodeId: 'tvmaze-episode-51'}}), 'episode:tvmaze-34:tvmaze-episode-51');
  assert.equal(resolveScenePin(pin(), {fileKey: 'remake:0', identity: 'movie:1978:midnight bridge', index: createDialogueIndex(scene(17))}).state, 'unrelated');
  assert.deepEqual(resolveScenePin(pin(), {fileKey: 'cut-a:0'}), {state: 'original', time: 36});
});

test('portable cards project only story and dialogue evidence and relocate after reimport', async () => {
  const { serializeSceneCard, parseSceneCard } = await import('../public/scene-relay.js');
  const local = { ...pin(), id: 'local-id', note: 'Private note', path: 'C:\\secret\\video.mkv', url: 'http://127.0.0.1/stream' };
  const payload = serializeSceneCard(local);
  assert.deepEqual(Object.keys(JSON.parse(payload)), ['version', 'identity', 'anchor']);
  assert.doesNotMatch(payload, /local-id|Private note|cut-a:0|secret|position|127\.0\.0\.1/);
  const imported = parseSceneCard(payload, identity);
  assert.deepEqual(Object.keys(imported), ['identity', 'anchor']);
  const [before, , after] = scene(17);
  const index = createDialogueIndex([before, cue(52, 'Keep the brass key'), cue(53, 'beside the broken lantern!'), after]);
  assert.deepEqual(resolveScenePin(imported, {fileKey: 'cut-b:0', identity, index}), {state: 'matched', time: 53});
  assert.equal(resolveScenePin(imported, {fileKey: 'cut-a:0', identity}).state, 'needs-track');
});


function relayFixture(t) {
  const storage = new Map(), storageBefore = globalThis.localStorage, documentBefore = globalThis.document;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.document = { activeElement: null };
  t.after(() => {
    if (storageBefore === undefined) delete globalThis.localStorage; else globalThis.localStorage = storageBefore;
    if (documentBefore === undefined) delete globalThis.document; else globalThis.document = documentBefore;
  });
  function element() {
    const nodes = new Map(), handlers = new Map();
    return {
      value: '', textContent: '', hidden: false, clicks: 0,
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, element());
        return nodes.get(selector);
      },
      addEventListener(name, handler) { handlers.set(name, handler); },
      emit(name) { return handlers.get(name)?.({ target: this }); },
      click() { this.clicks++; },
      contains() { return false; }
    };
  }
  let current = { fileKey: 'cut-b:0', identity, generation: 1, track: null, cues: () => [] };
  const host = element(), arrival = element(), jumps = [];
  const mount = createSceneRelay => createSceneRelay({ host, arrival, getContext: () => current, canSeek: () => true,
    seek: time => { jumps.push(time); return true; }, clockTime: String, escape: String });
  const picker = host.querySelector('.scene-card-file'), trigger = host.querySelector('.scene-card-import');
  function choose(file) {
    trigger.emit('click');
    picker.files = [file];
    return picker.emit('change');
  }
  return { mount, choose, picker, jumps, storage, status: host.querySelector('.scene-pin-status'),
    changeContext: patch => { current = { ...current, ...patch }; } };
}

test('an import belongs to the playback file and generation at picker launch and persists once', async t => {
  const { createSceneRelay, serializeSceneCard } = await import('../public/scene-relay.js');
  const f = relayFixture(t);
  const relay = f.mount(createSceneRelay), payload = serializeSceneCard(pin());
  let finishRead;
  const deferred = new Promise(resolve => { finishRead = resolve; });
  const first = f.choose({ size: payload.length, text: () => deferred });
  assert.equal(f.picker.clicks, 1, 'The picker opens synchronously from its button');
  f.changeContext({ generation: 2, fileKey: 'cut-c:0' });
  finishRead(payload);
  await first;
  assert.equal(f.storage.size, 0, 'An old file read cannot import into a new player generation');

  const card = new File([payload], 'cinema-scene-card.json');
  await f.choose(card);
  assert.match(f.status.textContent, /imported/i);
  assert.equal(relay.refresh().length, 0, 'An import needs local subtitles to locate a scene');
  await f.choose(card);
  assert.match(f.status.textContent, /already/i);
  const saved = JSON.parse(f.storage.get('cinema-scene-pins-v1'));
  assert.equal(saved.length, 1);
  assert.equal(Object.hasOwn(saved[0], 'fileKey'), false);
  assert.equal(Object.hasOwn(saved[0], 'position'), false);
  f.changeContext({ track: 'local-track', cues: () => scene(17) });
  const reloaded = f.mount(createSceneRelay);
  assert.deepEqual(reloaded.refresh(), [{ id: saved[0].id, time: 53, ready: true }]);
  assert.deepEqual(f.jumps, [], 'Import and rehydration never seek');
});


test('portable cards reject malformed, unsupported, oversized, extra and wrong-story data', async () => {
  const { serializeSceneCard, parseSceneCard } = await import('../public/scene-relay.js');
  const payload = serializeSceneCard(pin()), card = JSON.parse(payload);
  const parse = value => parseSceneCard(JSON.stringify(value), identity);
  assert.equal(serializeSceneCard({ ...pin(), identity: null }), null);
  assert.equal(serializeSceneCard({ ...pin(), anchor: null }), null);
  assert.throws(() => parseSceneCard('{broken', identity), /valid Cinema scene card/);
  assert.throws(() => parse({ ...card, version: 2 }), /version is not supported/);
  assert.throws(() => parseSceneCard('é'.repeat(2049), identity), /4 KiB/);
  assert.throws(() => parse({ ...card, note: 'local-only' }), /valid Cinema scene card/);
  assert.throws(() => parse({ ...card, anchor: { ...card.anchor, absoluteTime: 53 } }), /valid Cinema scene card/);
  assert.throws(() => parse({ ...card, anchor: { ...card.anchor, phrase: [0, 1, 2, 3, 4294967296] } }), /valid Cinema scene card/);
  assert.throws(() => parse({ ...card, anchor: { ...card.anchor, delta: 7 } }), /valid Cinema scene card/);
  assert.throws(() => parseSceneCard(payload, 'movie:1978:midnight bridge'), /different movie or episode/);
  assert.throws(() => parseSceneCard(serializeSceneCard({ ...pin(), identity: 'episode:tvmaze-8:tvmaze-episode-12' }),
    'episode:tvmaze-8:tvmaze-episode-13'), /different movie or episode/);
});

test('invalid or oversized local files and a full pin store leave existing pins intact', async t => {
  const { createSceneRelay, serializeSceneCard } = await import('../public/scene-relay.js');
  const f = relayFixture(t);
  const record = n => ({ id: 'legacy-' + n, fileKey: 'old:' + n, identity: null, position: 5, note: '', anchor: null });
  const saved = JSON.stringify(Array.from({ length: 120 }, (_, n) => record(n)));
  f.storage.set('cinema-scene-pins-v1', saved);
  f.mount(createSceneRelay);
  let read = false;
  await f.choose({ size: 4097, text: async () => { read = true; return ''; } });
  assert.equal(read, false);
  assert.match(f.status.textContent, /4 KiB/);
  await f.choose(new File(['{}'], 'scene-card.json'));
  assert.match(f.status.textContent, /valid Cinema scene card/);
  await f.choose(new File([serializeSceneCard(pin())], 'scene-card.json'));
  assert.match(f.status.textContent, /Scene pins are full/);
  assert.equal(f.storage.get('cinema-scene-pins-v1'), saved);
  assert.deepEqual(f.jumps, []);
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlaybackMap, playbackMap, readyToSeek } from '../public/playback-map.js';

test('a growing HLS playlist keeps the full movie duration and exposes only usable ranges', () => {
  const map = playbackMap({ mode: 'hls', duration: 6100, mediaDuration: 83,
    manifest: [[0, 40], [40, 82], [120, 150]], buffered: [[0, 13]], seekable: [[0, 74], [132, 145]] });
  assert.equal(map.duration, 6100);
  assert.deepEqual(map.ready, [[0, 74], [132, 145]]);
  assert.equal(readyToSeek(map, 80), false);
  assert.equal(readyToSeek(map, 140), true);
});

test('direct partial media excludes unverified seekable bytes and unknown HLS runtime stays unknown', () => {
  const direct = playbackMap({mode: 'direct', mediaDuration: 90, buffered: [[0, 15]], seekable: [[0, 90]]});
  assert.deepEqual(direct.ready, [[0, 15]]);
  assert.equal(readyToSeek(direct, 16), false);
  const completed = playbackMap({mode: 'direct', complete: true, mediaDuration: 90, seekable: [[0, 90]]});
  assert.equal(readyToSeek(completed, 88), true);
  const streaming = playbackMap({mode: 'hls', mediaDuration: 20, publishedDuration: 19, seekable: [[0, 20]]});
  assert.equal(streaming.duration, null);
  assert.deepEqual(streaming.prepared, [[0, 19]]);
  assert.equal(readyToSeek(streaming, 5), false);
});

class Element extends EventTarget {
  constructor(parent = null) {
    super();
    this.parent = parent;
    this.children = [];
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = '';
    this.dataset = {};
    const styles = new Map();
    this.style = { setProperty: (name, value) => styles.set(name, value), getPropertyValue: name => styles.get(name) };
  }

  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  focus() { document.activeElement = this; }
  contains(element) {
    for (let current = element; current; current = current.parent) if (current === this) return true;
    return false;
  }
}

function fixture(t, options = {}) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, createElement: () => new Element() } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const panel = new Element();
  panel.open = true;
  const strip = new Element(panel);
  const nodes = new Map([
    ['#timeline-selection', strip],
    ...['input', 'summary', '.timeline-ranges', '.timeline-playhead', '.timeline-pins', '.timeline-summary', '.timeline-time', '.timeline-feedback', '#timeline-selection-marker']
      .map(selector => [selector, new Element(panel)]),
    ...['time', 'preview', 'jump', 'return'].map(name => ['#timeline-selection-' + name, new Element(strip)]),
  ]);
  panel.querySelector = selector => nodes.get(selector);
  const slider = nodes.get('input'), check = nodes.get('#timeline-selection-preview');
  const seeks = [], previews = [];
  const timeline = createPlaybackMap({ panel, clockTime: seconds => String(Math.floor(seconds)), focusScene() {},
    seek(position) { seeks.push(position); return options.seek?.(position) ?? Promise.resolve(true); },
    canPreviewAt: options.canPreviewAt ?? (() => true),
    previewAt(position, context) { previews.push({ position, ...context }); return options.open !== false; },
    onSelectionChange: options.onSelectionChange,
  });
  let model = { duration: 120, ready: [[0, 20]], prepared: [], marks: [], position: 10, blocked: false, attachmentKey: 'current-file' };
  function update(change = {}) { model = { ...model, ...change }; timeline.update(model); }
  function emit(node, event, properties = {}) { node.dispatchEvent(Object.assign(new Event(event, {cancelable:true}), properties)); }
  function choose(position) { slider.value = position; emit(slider, 'input'); emit(slider, 'change'); }
  update();
  return { timeline, panel, nodes, slider, strip, check, seeks, previews, update, emit, choose };
}

test('timeline draft and commit keep the live playhead and only an explicit check opens the exact moment', t => {
  const { slider, strip, nodes, update, emit, check, seeks, previews, choose } = fixture(t);
  const marker = nodes.get('#timeline-selection-marker'), playhead = nodes.get('.timeline-playhead');
  slider.value = 49.413;
  emit(slider, 'input');
  assert.equal(strip.hidden, true);
  assert.equal(marker.hidden, false);
  assert.equal(marker.style.getPropertyValue('--position'), `${49.413 / 120 * 100}%`);
  update({ position: 11 });
  assert.equal(playhead.style.getPropertyValue('--position'), `${11 / 120 * 100}%`);
  assert.deepEqual(previews, []);
  assert.deepEqual(seeks, []);

  emit(slider, 'change');
  assert.equal(strip.hidden, false);
  assert.equal(nodes.get('#timeline-selection-time').textContent, '49.413');
  assert.equal(nodes.get('.timeline-time').textContent, '11 / 120');
  assert.match(nodes.get('.timeline-feedback').textContent, /Selected 49\.413/);
  update({ position: 12 });
  emit(slider, 'blur');
  assert.equal(slider.value, 49.413);
  assert.deepEqual(previews, []);
  assert.deepEqual(seeks, []);

  emit(check, 'click');
  assert.equal(previews.length, 1);
  const [first] = previews;
  assert.equal(first.position, 49.413);
  assert.equal(first.origin, 'timeline');
  assert.equal(first.opener, check);
  assert.equal(first.attachmentKey, 'current-file');
  assert.equal(first.validate(), true);
  choose(51.8);
  assert.equal(first.validate(), false);
  assert.equal(previews.length, 1);
  assert.deepEqual(seeks, []);
});

test('a ready transition offers a distinct Jump and stale Check never seeks', async t => {
  const { nodes, slider, strip, choose, check, update, emit, previews, seeks } = fixture(t);
  const jump = nodes.get('#timeline-selection-jump');
  choose(50);
  check.focus();
  update({ ready: [[0, 20], [48, 54]] });
  assert.equal(check.hidden, true);
  assert.equal(jump.hidden, false);
  assert.equal(document.activeElement, slider);
  assert.match(nodes.get('.timeline-feedback').textContent, /50 is ready.*Jump/);
  emit(check, 'click');
  assert.deepEqual(previews, []);
  assert.deepEqual(seeks, []);
  assert.match(nodes.get('.timeline-feedback').textContent, /selection changed/);

  update({ ready: [[0, 20]] });
  emit(jump, 'click');
  assert.deepEqual(previews, []);
  assert.deepEqual(seeks, []);
  update({ ready: [[0, 20], [48, 54]] });
  jump.focus();
  emit(jump, 'click');
  await Promise.resolve();
  assert.deepEqual(seeks, [50]);
  assert.equal(strip.hidden, true);
  assert.equal(document.activeElement, slider);
});

test('an unready draft that becomes ready before release waits for a separate Jump', async t => {
  let previewAvailable = true;
  const { nodes, slider, strip, check, update, emit, previews, seeks } = fixture(t, { canPreviewAt: () => previewAvailable });
  const jump = nodes.get('#timeline-selection-jump');
  slider.value = 50.3;
  emit(slider, 'input');
  assert.match(slider.getAttribute('aria-valuetext'), /not ready yet/);
  previewAvailable = false;
  update({ ready: [[0, 20], [48, 54]] });
  assert.match(slider.getAttribute('aria-valuetext'), /not ready yet/);
  emit(slider, 'change');
  assert.equal(strip.hidden, false);
  assert.equal(check.hidden, true);
  assert.equal(jump.hidden, false);
  assert.match(nodes.get('.timeline-feedback').textContent, /Selected 50\.3.*Jump/);
  assert.deepEqual(seeks, []);
  assert.deepEqual(previews, []);

  emit(jump, 'click');
  await Promise.resolve();
  assert.deepEqual(seeks, [50.3]);
  assert.equal(strip.hidden, true);
});

test('ready slider commits still seek and unsupported selections reset without a request', async t => {
  const { slider, nodes, update, choose, strip, seeks, previews } = fixture(t);
  choose(13.2);
  await Promise.resolve();
  assert.deepEqual(seeks, [13.2]);
  assert.equal(strip.hidden, true);
  update({ attachmentKey: undefined, position: 13.2 });
  choose(80);
  assert.equal(slider.value, 13.2);
  assert.equal(strip.hidden, true);
  assert.equal(nodes.get('#timeline-selection-marker').hidden, true);
  assert.deepEqual(seeks, [13.2]);
  assert.deepEqual(previews, []);
});

test('return, ordinary disclosure closure and attachment change revoke a selected preview origin', t => {
  const { panel, slider, nodes, strip, choose, emit, check, update, previews, seeks } = fixture(t);
  const returnButton = nodes.get('#timeline-selection-return');
  function select() { choose(70); emit(check, 'click'); return previews.at(-1).validate; }
  let valid = select();
  returnButton.focus();
  emit(returnButton, 'click');
  assert.equal(valid(), false);
  assert.equal(document.activeElement, slider);
  assert.equal(strip.hidden, true);

  valid = select();
  panel.open = false;
  emit(panel, 'toggle');
  assert.equal(valid(), false);
  assert.equal(strip.hidden, true);
  panel.open = true;
  valid = select();
  check.focus();
  update({ attachmentKey: 'other-file', position: 6 });
  assert.equal(valid(), false);
  assert.equal(strip.hidden, true);
  assert.equal(slider.value, 6);
  assert.equal(document.activeElement, slider);

  slider.value = 40;
  emit(slider, 'input');
  update({ attachmentKey: 'third-file', position: 3, ready: [[0, 45]] });
  emit(slider, 'change');
  assert.deepEqual(seeks, []);
  assert.equal(slider.value, 3);
  assert.match(nodes.get('.timeline-feedback').textContent, /video changed/);
});

test('a held timeline Check cannot adopt a replacement selection or ticket',t=>{
  const {choose,check,update,emit,previews,seeks}=fixture(t);
  choose(50);
  emit(check,'pointerdown',{button:0});
  emit(check,'blur');
  update({attachmentKey:'replacement-ticket'});
  choose(70);
  emit(check,'click',{detail:1});
  assert.equal(previews.length,0);

  emit(check,'keydown',{key:' '});
  choose(71);
  emit(check,'click',{detail:0});
  assert.equal(previews.length,0);
  assert.deepEqual(seeks,[]);

  emit(check,'pointerdown',{button:0});
  emit(check,'click',{detail:1});
  assert.equal(previews.length,1);
  assert.equal(previews[0].position,71);
  assert.equal(previews[0].attachmentKey,'replacement-ticket');
});

test('committed selection changes notify synchronously when playback sends no updates', async t => {
  const visible = [];
  let pending;
  const { panel, strip, nodes, check, choose, emit, update, previews, seeks } = fixture(t, {
    onSelectionChange() {
      visible.push(!strip.hidden);
      if (pending && !pending.validate()) pending.controller.abort();
    },
    seek() {
      assert.equal(pending.controller.signal.aborted, true, 'cancel the old preview before moving playback');
      return Promise.resolve(true);
    },
  });
  function openPreview() {
    emit(check, 'click');
    pending = { ...previews.at(-1), controller: new AbortController() };
    assert.equal(pending.validate(), true);
    return pending.controller.signal;
  }
  choose(70);
  let signal = openPreview();
  update({ ready: [[0, 20], [68, 73]] });
  assert.deepEqual(visible, [true]);
  assert.equal(signal.aborted, false, 'readiness alone leaves the chosen moment active');
  emit(nodes.get('#timeline-selection-return'), 'click');
  assert.equal(signal.aborted, true);

  choose(75);
  signal = openPreview();
  choose(80);
  assert.equal(signal.aborted, true);
  signal = openPreview();
  panel.open = false;
  emit(panel, 'toggle');
  assert.equal(signal.aborted, true);

  panel.open = true;
  choose(85);
  signal = openPreview();
  update({ attachmentKey: 'other-file' });
  assert.equal(signal.aborted, true);

  choose(86);
  signal = openPreview();
  choose(12);
  assert.equal(signal.aborted, true);
  await Promise.resolve();
  assert.deepEqual(seeks, [12]);
  assert.deepEqual(visible, [true, false, true, true, false, true, false, true, false]);
});

test('the selected moment reveal respects the reduced-motion preference', async () => {
  const styles = await readFile(new URL('../public/playback-map.css', import.meta.url), 'utf8');
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.timeline-selection[^}]*animation:\s*none/);
});

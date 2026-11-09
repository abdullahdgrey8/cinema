import assert from 'node:assert/strict';
import test from 'node:test';
import { createScenePreviewUI } from '../public/scene-preview.js';

class Element extends EventTarget {
  constructor(parent = null) {
    super();
    this.parent = parent;
    this.attributes = new Map();
    this.hidden = false;
    this.isConnected = true;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  toggleAttribute(name, on) {
    if (on) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }
  insertBefore(node, before) {
    assert.equal(before.parent, this);
    node.parent = this;
  }
  focus(options) {
    document.activeElement = this;
    this.focusOptions = options;
  }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
}

class Video extends Element {
  constructor(parent) {
    super(parent);
    this.paused = true;
    this.seeking = false;
    this.readyState = 0;
    this.playbackRate = 1;
    this.currentTime = 0;
    this.duration = 3;
    this.volume = 1;
    this.muted = true;
    this.plays = 0;
    this.pauses = 0;
    this.loads = 0;
    this.src = '';
  }

  removeAttribute(name) {
    super.removeAttribute(name);
    if (name === 'src') this.src = '';
  }
  play() {
    this.plays++;
    this.paused = false;
    emit(this, 'play');
    return Promise.resolve();
  }
  pause() {
    this.pauses++;
    this.paused = true;
    emit(this, 'pause');
  }
  load() { this.loads++; }
}

function emit(node, type) {
  node.dispatchEvent(new Event(type, { cancelable: true }));
}

function clock(t) {
  let now = 0;
  let next = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++next;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => { timers.delete(id); });
  return {
    get count() { return timers.size; },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const nextTimer = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!nextTimer) break;
        const [id, timer] = nextTimer;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

function setup(t) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const buttons = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null,
    createElement(tag) {
      assert.equal(tag, 'button');
      const button = new Element();
      buttons.push(button);
      return button;
    },
  } });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else delete globalThis.document;
  });
  const timers = clock(t);
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', blob => {
    created.push(blob);
    return 'blob:scene/' + created.length;
  });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));

  const ancestor = new Element();
  const panel = new Element(ancestor);
  const summary = new Element(panel);
  const card = new Element(panel);
  const main = new Video();
  const video = new Video(card);
  const form = new Element(panel);
  const time = new Element(form);
  const trigger = new Element(form);
  const status = new Element(panel);
  const play = new Element(card);
  const audio = new Element(card);
  const close = new Element(form);
  const back = new Element(panel);
  const timelineFallback = new Element(), dialogueFallback = new Element();
  const byId = { form, time, request: trigger, status, card, video, play, audio, close, return: back };
  panel.querySelector = selector => selector === 'summary' ? summary : byId[selector.slice('#scene-preview-'.length)];
  ancestor.open = panel.open = true;
  card.hidden = play.disabled = true;
  time.value = '1:55:00.413';
  main.currentTime = 81.5;
  main.src = '/stream?fixture=main';

  let context = { key: 'attached-release-a', hash: 'release-a', index: 0, sessionId: 'session-a', duration: 7200 };
  let seekable = false;
  const requests = [];
  const ui = createScenePreviewUI({ panel, ancestor, mainVideo: main,
    getContext: () => context, canSeek: () => seekable,
    request(source, targetMs, signal, options) {
      const pending = Promise.withResolvers();
      requests.push({ source, targetMs, signal, options, ...pending });
      return pending.promise;
    },
    formatTime: seconds => seconds.toFixed(3),
    returnFocus: origin => [origin === 'timeline' ? timelineFallback : dialogueFallback],
  });

  return {
    ui, panel, ancestor, summary, card, main, video, form, time, trigger, status, play, audio, close, back,
    timelineFallback, dialogueFallback,
    created, revoked, timers, requests,
    get fetch() { return buttons[0]; },
    buffer(ranges) {
      main.buffered = { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] };
    },
    async missing(request, canFetch) {
      request.reject(Object.assign(new Error('This part is still downloading.'), { code: 'scene-missing', canFetch }));
      await request.promise.catch(() => {});
    },
    switchSource() { context = { key: 'attached-release-b', duration: 7200 }; },
    changeContext(changes) { context = {...context,...changes}; },
    setSeekable(value) { seekable = value; },
    link(origin,opener,validate=()=>true){return {origin,opener,validate,attachmentKey:ui.attachmentKey()};},
    submit() {
      const event = new Event('submit', { cancelable: true });
      assert.equal(form.dispatchEvent(event), false);
      assert.equal(event.defaultPrevented, true);
      const request = requests.at(-1);
      assert.equal(request.targetMs, 6_900_413);
      return request;
    },
    async respond(request, seek = 0.509015625) {
      const blob = new Blob(['scene fixture'], { type: 'video/mp4' });
      request.resolve({ blob, seek });
      await request.promise;
      return blob;
    },
    land() {
      video.readyState = 1;
      video.seeking = true;
      emit(video, 'loadedmetadata');
      video.readyState = 2;
      video.seeking = false;
      emit(video, 'seeked');
    },
    assertReleased(request, url = 'blob:scene/1') {
      assert.equal(request.signal.aborted, true);
      assert.deepEqual(revoked, [url]);
      assert.equal(video.src, '');
      assert.equal(video.paused, true);
      assert.equal(video.muted, true);
      assert.equal(video.defaultMuted, true);
      assert.equal(video.loads, 1);
      assert.equal(card.hidden, true);
      assert.equal(play.disabled, true);
      assert.equal(timers.count, 0);
    },
  };
}

test('a response for a changed attachment cannot create a preview', async t => {
  const app = setup(t);
  const stale = app.submit();
  app.switchSource();
  await app.respond(stale);
  assert.deepEqual(app.created, []);
  assert.deepEqual(app.revoked, []);
  assert.equal(stale.signal.aborted, true);
  assert.equal(app.card.hidden, true);
  assert.equal(app.video.src, '');
  assert.equal(app.timers.count, 0);
});

test('an exact linked check is single-flight and offers a separate fetch without moving playback', async t => {
  const app = setup(t), opener = new Element();
  app.ancestor.open = app.panel.open = false;
  const link=app.link('timeline',opener);
  assert.equal(app.ui.canCheckAt(6900.413),true);
  assert.equal(app.requests.length,0);
  assert.equal(app.ui.checkAt(6900.413,link),true);
  assert.equal(app.ui.checkAt(6900.413,link),false);
  const [request]=app.requests;
  assert.equal(request.targetMs,6_900_413);
  assert.equal(request.options,undefined);
  assert.equal(app.time.value,'1:55:00.413');
  assert.equal(app.back.textContent,'Back to playback map');
  assert.equal(document.activeElement,app.close);
  await app.missing(request,true);
  assert.equal(app.requests.length,1);
  assert.equal(document.activeElement,app.fetch);
  emit(app.back,'click');
  assert.equal(app.panel.open,false);
  assert.equal(app.ancestor.open,false);
  assert.equal(document.activeElement,opener);
  assert.equal(app.main.currentTime,81.5);
  assert.equal(app.main.src,'/stream?fixture=main');
  assert.equal(app.main.plays+app.main.pauses+app.main.loads,0);
});

test('a stale linked caption cancels a pending response and a pending offer', async t => {
  const app=setup(t),opener=new Element();
  let revision=true;
  const link=app.link('dialogue',opener,()=>revision);
  assert.equal(app.ui.checkAt(67.125,link),true);
  assert.equal(app.requests[0].targetMs,67_125);
  assert.equal(app.back.textContent,'Back to dialogue results');
  revision=false;
  app.ui.revalidateEntry();
  assert.equal(app.requests[0].signal.aborted,true);
  await app.respond(app.requests[0]);
  assert.equal(app.created.length,0);
  assert.match(app.status.textContent,/selected moment changed/);
  revision=true;
  assert.equal(app.ui.checkAt(67.125,link),true);
  await app.missing(app.requests[1],true);
  revision=false;
  app.main.paused=false;
  app.main.readyState=4;
  app.buffer([[0,100]]);
  emit(app.fetch,'click');
  assert.equal(app.requests.length,2);
  assert.equal(app.fetch.hidden,true);
  assert.equal(app.back.hidden,true);
});

test('a linked check revalidates the playback ticket even on the same attachment key', async t => {
  const app=setup(t);
  const link=app.link('dialogue',new Element());
  assert.equal(app.ui.checkAt(67.125,link),true);
  app.changeContext({sessionId:'session-b'});
  await app.respond(app.requests[0]);
  assert.equal(app.created.length,0);
  assert.equal(app.requests[0].signal.aborted,true);
});

test('Escape from the linked preview cancels and restores a visible origin fallback', async t => {
  const app=setup(t),opener=new Element();
  assert.equal(app.ui.checkAt(67.125,app.link('dialogue',opener)),true);
  opener.focus();
  assert.equal(app.ui.escape(),false,'Escape outside the linked panel stays with the player');
  opener.isConnected=false;
  app.close.focus();
  assert.equal(app.ui.escape(),true);
  assert.equal(document.activeElement,app.dialogueFallback);
  assert.equal(app.ancestor.open,true);
  assert.equal(app.panel.open,false);
  assert.equal(app.requests[0].signal.aborted,true);
});

test('linked checks refuse out-of-range, unknown-duration, ready or unbound selections', t => {
  const app=setup(t),link=app.link('timeline',new Element());
  for(const value of [-1,Infinity,NaN,7200])assert.equal(app.ui.checkAt(value,link),false);
  assert.equal(app.ui.checkAt(67.125,{...link,validate:()=>false}),false);
  app.changeContext({duration:undefined});
  assert.equal(app.ui.canCheckAt(67.125),false);
  assert.equal(app.ui.checkAt(67.125,link),false);
  app.changeContext({duration:7200});
  app.setSeekable(true);
  assert.equal(app.ui.checkAt(67.125,link),false);
  assert.equal(app.requests.length,0);
});

test('a displayed linked action refuses a replacement ticket before sending a request',t=>{
  const app=setup(t),link=app.link('dialogue',new Element());
  app.changeContext({sessionId:'replacement-ticket'});
  assert.equal(app.ui.checkAt(67.125,link),false);
  assert.equal(app.requests.length,0);
  assert.equal(app.ui.checkAt(67.125,app.link('dialogue',new Element())),true);
  assert.equal(app.requests[0].source.sessionId,'replacement-ticket');
});

test('an unchanged stale linked form cannot become a manual check',async t=>{
  const app=setup(t);
  let revision=true;
  const link=app.link('dialogue',new Element(),()=>revision);
  assert.equal(app.ui.checkAt(51.413,link),true);
  await app.missing(app.requests[0],true);
  revision=false;
  app.changeContext({sessionId:'replacement-ticket'});
  emit(app.form,'submit');
  assert.equal(app.requests.length,1);
  assert.equal(app.time.value,'');
  assert.equal(app.back.hidden,true);
  assert.match(app.status.textContent,/selected moment changed/);
});

test('a linked origin change stops a mounted clip immediately',async t=>{
  const app=setup(t);
  let selection=true;
  assert.equal(app.ui.checkAt(67.125,app.link('timeline',new Element(),()=>selection)),true);
  const request=app.requests[0];
  await app.respond(request);
  app.land();
  emit(app.play,'click');
  assert.equal(app.video.paused,false);
  assert.equal(app.back.hidden,false);
  selection=false;
  app.ui.revalidateEntry();
  assert.equal(app.back.hidden,true);
  app.assertReleased(request);
});

test('a response after reset cannot reopen or replace a fresh preview', async t => {
  const app = setup(t);
  const stale = app.submit();
  app.ui.reset();
  assert.equal(stale.signal.aborted, true);
  const fresh = app.submit();
  const blob = await app.respond(fresh);
  await app.respond(stale);
  assert.deepEqual(app.created, [blob]);
  assert.deepEqual(app.revoked, []);
  assert.equal(app.video.src, 'blob:scene/1');
  assert.equal(app.card.hidden, false);
  app.ui.reset();
  app.assertReleased(fresh);
});

test('verified seek enables the muted preview, which releases exactly at 60 seconds', async t => {
  const app = setup(t);
  const request = app.submit();
  await app.respond(request);
  assert.equal(app.play.disabled, true);
  assert.equal(app.video.muted, true);
  assert.equal(app.video.defaultMuted, true);

  app.video.readyState = 1;
  app.video.seeking = true;
  emit(app.video, 'loadedmetadata');
  assert.equal(app.video.currentTime, 0.509015625);
  app.video.readyState = 2;
  emit(app.video, 'loadeddata');
  assert.equal(app.play.disabled, true, 'a seeking decoder cannot land');
  app.video.seeking = false;
  app.video.currentTime = 0.7;
  emit(app.video, 'seeked');
  assert.equal(app.play.disabled, true, 'a decoded wrong-time preview cannot land');
  app.video.currentTime = 0.509015625;
  emit(app.video, 'seeked');
  assert.equal(app.play.disabled, false);
  assert.match(app.status.textContent, /ready at 6900\.413/);
  emit(app.play, 'click');
  assert.equal(app.video.plays, 1);
  assert.equal(app.main.currentTime, 81.5);
  assert.equal(app.main.src, '/stream?fixture=main');
  assert.equal(app.main.plays + app.main.pauses + app.main.loads, 0);

  app.play.focus();
  app.timers.tick(59_999);
  assert.equal(app.card.hidden, false);
  assert.equal(request.signal.aborted, false);
  assert.deepEqual(app.revoked, []);
  app.timers.tick(1);
  app.assertReleased(request);
  assert.equal(document.activeElement, app.trigger);
  assert.match(app.status.textContent, /expired/);
});

test('Escape closes the active preview, then returns focus from the panel to its summary', async t => {
  const app = setup(t);
  const request = app.submit();
  await app.respond(request);
  app.land();
  app.close.focus();

  assert.equal(app.ui.escape(), true);
  app.assertReleased(request);
  assert.equal(app.panel.open, true);
  assert.equal(document.activeElement, app.trigger);
  assert.deepEqual(app.trigger.focusOptions, { preventScroll: true });
  assert.equal(app.ui.escape(), true);
  assert.equal(app.panel.open, false);
  assert.equal(document.activeElement, app.summary);
  assert.deepEqual(app.summary.focusOptions, { preventScroll: true });
  assert.equal(app.ui.escape(), false);
});

test('an audible main video remutes preview sound and ancestor closing releases it', async t => {
  const app = setup(t);
  const request = app.submit();
  await app.respond(request);
  app.land();
  emit(app.audio, 'click');
  assert.equal(app.video.muted, false);
  assert.equal(app.audio.getAttribute('aria-pressed'), 'true');

  app.main.paused = false;
  app.main.muted = false;
  emit(app.main, 'play');
  assert.equal(app.video.muted, true);
  assert.equal(app.audio.disabled, true);
  assert.equal(app.audio.getAttribute('aria-pressed'), 'false');
  emit(app.audio, 'click');
  assert.equal(app.video.muted, true);

  app.ancestor.open = false;
  emit(app.ancestor, 'toggle');
  app.assertReleased(request);
  assert.equal(app.main.currentTime, 81.5);
  assert.equal(app.main.muted, false);
});

test('a stock miss offers no fetch and editing a scene invalidates a supported offer', async t => {
  const app = setup(t);
  const ordinary = app.submit();
  assert.equal(ordinary.options, undefined);
  await app.missing(ordinary, false);
  assert.equal(app.fetch, undefined);
  assert.match(app.status.textContent, /still downloading/);

  await app.missing(app.submit(), true);
  assert.equal(app.fetch.hidden, false);
  assert.equal(app.fetch.getAttribute('aria-describedby'), 'scene-preview-status');
  assert.equal(app.requests.length, 2, 'showing the offer never starts a fetch');
  app.time.value = '20:30';
  emit(app.time, 'input');
  assert.equal(app.fetch.hidden, true);
  emit(app.fetch, 'click');
  assert.equal(app.requests.length, 2);
});

test('getting a preview requires a current uninterrupted buffer and returns focus to Play', async t => {
  const app = setup(t);
  await app.missing(app.submit(), true);
  app.fetch.focus();
  emit(app.fetch, 'click');
  assert.match(app.status.textContent, /Resume your video/);
  app.main.paused = false;
  app.main.playbackRate = 1.25;
  emit(app.fetch, 'click');
  assert.match(app.status.textContent, /normal playback speed/);
  app.main.playbackRate = 1;
  app.main.readyState = 3;
  app.buffer([[70, 85], [90, 110]]);
  emit(app.fetch, 'click');
  assert.match(app.status.textContent, /more time to buffer/);
  assert.equal(app.requests.length, 1, 'later buffered data across a gap is insufficient');

  app.main.currentTime = 94.2505;
  app.buffer([[70, 85], [90, 105.25]]);
  emit(app.fetch, 'click');
  assert.equal(app.requests.length, 1, 'the client leaves an extra second for admission');
  app.buffer([[70, 85], [90, 105.2518]]);
  const sampledAt = 1_700_000_000_123;
  t.mock.method(Date, 'now', () => sampledAt);
  emit(app.fetch, 'click');
  const request = app.requests[1];
  assert.deepEqual(request.options, { fetch: true, playheadMs: 94_251, bufferedUntilMs: 105_251, sampledAt: sampledAt - 20 });
  assert.equal(app.fetch.hidden, true);
  assert.equal(app.time.readOnly, true);
  assert.equal(app.close.textContent, 'Cancel');
  assert.equal(document.activeElement, app.close);
  assert.equal(app.status.getAttribute('data-fetching'), '');
  await app.respond(request);
  app.land();
  assert.equal(app.time.readOnly, false);
  assert.equal(app.status.getAttribute('data-fetching'), undefined);
  assert.equal(document.activeElement, app.play);
  assert.equal(app.main.currentTime, 94.2505);
  assert.equal(app.main.plays + app.main.pauses + app.main.loads, 0);
});

test('temporary fetch failures keep the offer and restore focus only from Cancel', async t => {
  const app = setup(t);
  app.main.paused = false;
  app.main.readyState = 3;
  app.buffer([[70, 105]]);
  await app.missing(app.submit(), true);
  for (const [code, message, moveFocus] of [
    ['scene-runway', 'Let the video build more buffer, then try the preview again.', false],
    ['scene-fetch-unavailable', 'Cinema could not fetch this preview yet. Try again in a moment.', true],
  ]) {
    app.fetch.focus();
    emit(app.fetch, 'click');
    const request = app.requests.at(-1);
    assert.equal(request.options.fetch, true);
    assert.equal(document.activeElement, app.close);
    if (moveFocus) app.time.focus();
    request.reject(Object.assign(new Error(message), { code }));
    await request.promise.catch(() => {});
    assert.equal(app.fetch.hidden, false);
    assert.equal(app.close.hidden, true);
    assert.equal(app.time.readOnly, false);
    assert.equal(app.status.textContent, message);
    assert.equal(document.activeElement, moveFocus?app.time:app.fetch);
  }
  assert.equal(app.requests.length, 3, 'a retry requires another click and no repeated check');

  emit(app.fetch, 'click');
  const stale = app.requests.at(-1);
  app.switchSource();
  stale.reject(Object.assign(new Error('Try again in a moment.'), { code: 'scene-fetch-unavailable' }));
  await stale.promise.catch(() => {});
  assert.equal(app.fetch.hidden, true);
  assert.equal(stale.signal.aborted, true);
});

async function setupPendingFetch(t) {
  const app = setup(t);
  app.main.paused = false;
  app.main.readyState = 3;
  app.buffer([[70, 105]]);
  await app.missing(app.submit(), true);
  app.fetch.focus();
  emit(app.fetch, 'click');
  return { app, request: app.requests.at(-1) };
}

for (const event of ['pause', 'seeking', 'waiting', 'stalled', 'ended', 'error', 'emptied', 'ratechange', 'cancel']) {
  test(`an unfinished fetch stops on ${event}`, async t => {
    const { app, request } = await setupPendingFetch(t);
    assert.equal(request.options.fetch, true);
    emit(app.main, 'stalled');
    assert.equal(request.signal.aborted, false, 'network stall with enough decoded media is not a playback stall');
    if (event==='stalled') app.main.readyState = 2;
    if (event==='cancel') emit(app.close, 'click');
    else emit(app.main, event);
    assert.equal(request.signal.aborted, true);
    assert.equal(document.activeElement, app.trigger);
    assert.match(app.status.textContent, event==='cancel'?/canceled/:/main video priority/);
    await app.respond(request);
    assert.deepEqual(app.created, []);
    assert.equal(app.card.hidden, true);
  });
}

test('changing the foreground attachment immediately resets an unfinished fetch', async t => {
  const { app, request } = await setupPendingFetch(t);
  assert.equal(request.options.fetch, true);
  app.switchSource();
  app.ui.refresh();
  assert.equal(request.signal.aborted, true);
  assert.equal(app.close.hidden, true);
  assert.equal(app.fetch.hidden, true);
  assert.equal(app.time.readOnly, false);
  await app.respond(request);
  assert.deepEqual(app.created, []);
  assert.equal(app.card.hidden, true);
});

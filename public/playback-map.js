import {bindMomentAction} from './scene-preview.js';

const positive = value => Number.isFinite(value) && value > 0;

function intervals(ranges, duration = Infinity) {
  const sorted = (ranges || []).filter(pair => Array.isArray(pair) && pair.every(Number.isFinite))
    .map(([start, end]) => [Math.max(0, start), Math.min(duration, end)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function intersect(left, right) {
  const result = [];
  let a = 0, b = 0;
  while (a < left.length && b < right.length) {
    const start = Math.max(left[a][0], right[b][0]), end = Math.min(left[a][1], right[b][1]);
    if (end > start) result.push([start, end]);
    if (left[a][1] < right[b][1]) a++;
    else b++;
  }
  return result;
}

export function playbackMap({ mode, duration, mediaDuration, complete, manifest, buffered, seekable, publishedDuration } = {}) {
  const total = positive(duration) ? duration : (mode === 'direct' || complete) && positive(mediaDuration) ? mediaDuration : null;
  const limit = total ?? Infinity;
  const local = intervals(buffered, limit), browser = intervals(seekable, limit);
  const published = mode === 'hls' ? intervals(manifest, limit) : [];
  const prepared = published.length ? published : mode === 'hls' && positive(publishedDuration) ? intervals([[0, publishedDuration]], limit) : [];
  const ready = mode === 'hls' ? intervals([...intersect(published, browser), ...local], limit) :
    mode === 'direct' && complete ? intervals([...browser, ...local], limit) : local;
  return { duration: total, ready, prepared };
}

export function readyToSeek(map, time) {
  return Number.isFinite(time) && time >= 0 && map.ready.some(([start, end]) => time >= start && time + .2 < end);
}

export function readTimeRanges(ranges) {
  return Array.from({ length: ranges.length }, (_, i) => [ranges.start(i), ranges.end(i)]);
}

export function createPlaybackMap({ panel, clockTime, seek, focusScene, canPreviewAt, previewAt, onSelectionChange }) {
  const slider = panel.querySelector('input'), layers = panel.querySelector('.timeline-ranges');
  const playhead = panel.querySelector('.timeline-playhead'), pins = panel.querySelector('.timeline-pins');
  const summary = panel.querySelector('.timeline-summary'), time = panel.querySelector('.timeline-time');
  const feedback = panel.querySelector('.timeline-feedback');
  const strip = panel.querySelector('#timeline-selection'), marker = panel.querySelector('#timeline-selection-marker');
  const selectedTime = panel.querySelector('#timeline-selection-time');
  const check = panel.querySelector('#timeline-selection-preview'), jump = panel.querySelector('#timeline-selection-jump');
  const returnButton = panel.querySelector('#timeline-selection-return');
  let signature = '', drawing = '', pinSignature = '', model = null, draft = null, request = 0;
  let selection = null, notifiedSelection = null, selectionReady = false, jumping = null;

  function status(message) { if (feedback.textContent !== message) feedback.textContent = message; }
  function notifySelection() {
    if (selection === notifiedSelection) return;
    notifiedSelection = selection;
    onSelectionChange?.();
  }
  function momentTime(seconds) {
    const milliseconds = Math.round(seconds * 1000);
    const fraction = String(milliseconds % 1000).padStart(3, '0').replace(/0+$/, '');
    return clockTime(Math.floor(milliseconds / 1000)) + (fraction ? '.' + fraction : '');
  }
  function updateTime() {
    if (!model) return;
    const { duration: max, position } = model;
    const actual = max === null ? position : Math.min(max, position);
    const currentDraft = draft?.key === model.attachmentKey ? draft : null;
    const displayed = currentDraft?.position ?? actual;
    const selected = currentDraft?.position ?? selection?.position;
    const label = `${clockTime(displayed)}${max === null ? '' : ' / ' + clockTime(max)}`;
    if (time.textContent !== label) time.textContent = label;
    if (max !== null) playhead.style.setProperty('--position', `${actual / max * 100}%`);
    marker.hidden = max === null || selected === undefined;
    if (!marker.hidden) marker.style.setProperty('--position', `${selected / max * 100}%`);
    const controlPosition = selected ?? actual;
    const ready = currentDraft?.ready ?? readyToSeek(model, controlPosition);
    const spoken = `${selected === undefined ? clockTime(actual) : momentTime(selected)}, ${ready ? 'ready to play' : 'not ready yet'}`;
    if (slider.getAttribute('aria-valuetext') !== spoken) slider.setAttribute('aria-valuetext', spoken);
  }
  function validSelection(selected) {
    return selected && selected === selection && panel.open && model?.attachmentKey === selected.key &&
      !model.blocked && Number.isFinite(model.duration) && selected.position < model.duration;
  }
  function focusRange() {
    const target = !panel.open || slider.disabled ? panel.querySelector('summary') : slider;
    if (document.activeElement !== target) target?.focus({ preventScroll: true });
  }
  function renderSelection(announce = false) {
    const focused = document.activeElement;
    if (selection && !validSelection(selection)) {
      selection = jumping = null;
      request++;
      status('');
    }
    strip.hidden = !selection;
    if (!selection) {
      if (strip.contains(focused) && panel.open) focusRange();
      return;
    }
    const ready = readyToSeek(model, selection.position), label = momentTime(selection.position);
    if (selectedTime.textContent !== label) selectedTime.textContent = label;
    check.hidden = ready;
    jump.hidden = !ready;
    jump.disabled = jumping === selection;
    if ((check.hidden && focused === check) || (jump.hidden && focused === jump)) focusRange();
    if (announce) status(`Selected ${label}. ${ready ? 'Ready to watch. Choose Jump to move playback.' : 'Choose Check preview.'}`);
    else if (ready !== selectionReady) {
      status(ready ? `${label} is ready. Choose Jump to move playback.` : `${label} is waiting for video. You can check for a preview.`);
    }
    selectionReady = ready;
  }
  function returnToPlayhead({ focus = false } = {}) {
    selection = jumping = null;
    request++;
    draft = null;
    if (model) slider.value = model.position;
    renderSelection();
    updateTime();
    status('');
    if (focus) focusRange();
    notifySelection();
  }
  async function seekPosition(position, selected) {
    const current = ++request;
    if (selected) {
      jumping = selected;
      jump.disabled = true;
    }
    const moved = await seek(position);
    if (current !== request) return;
    if (moved && selected) { returnToPlayhead({ focus: document.activeElement === jump }); return; }
    jumping = null;
    draft = null;
    renderSelection();
    status(moved ? '' : 'That point is not ready to play.');
    if (!moved && model && !selection) slider.value = model.position;
    updateTime();
    notifySelection();
  }

  slider.addEventListener('input', () => {
    if (!model?.duration) return;
    const position = Number(slider.value);
    draft = { position, key: model.attachmentKey, ready: !model.blocked && readyToSeek(model, position) };
    updateTime();
  });
  slider.addEventListener('change', () => {
    const position = Number(slider.value);
    if (draft && draft.key !== model?.attachmentKey) {
      returnToPlayhead();
      status('The video changed. Select the moment again.');
      return;
    }
    const ready = model && !model.blocked && readyToSeek(model, position);
    const becameReady = ready && draft?.position === position && draft?.ready === false;
    if (ready && !becameReady) {
      selection = jumping = null;
      renderSelection();
      notifySelection();
      void seekPosition(position);
      return;
    }
    if (panel.open && model?.attachmentKey && !model.blocked && Number.isFinite(position) &&
        position >= 0 && position < model.duration && (becameReady || canPreviewAt?.(position))) {
      request++;
      selection = { position, key: model.attachmentKey };
      jumping = null;
      draft = null;
      renderSelection(true);
      updateTime();
      notifySelection();
      return;
    }
    returnToPlayhead();
    status(becameReady ? 'That point is ready now. Select it again to move playback.' : 'That point is not ready to play.');
  });
  for (const event of ['blur', 'pointercancel']) slider.addEventListener(event, () => {
    draft = null;
    if (model) { slider.value = selection?.position ?? model.position; updateTime(); }
  });
  function stillSelected(selected) {
    if(validSelection(selected))return true;
    if(selected)status('This selection changed. Check the available action again.');
    return false;
  }
  bindMomentAction(check, () => selection, selected => {
    if (!stillSelected(selected)) return;
    if (readyToSeek(model, selected.position) || !canPreviewAt?.(selected.position)) {
      renderSelection();
      status('This selection changed. Check the available action again.');
      return;
    }
    if (!previewAt?.(selected.position, { origin: 'timeline', opener: check, attachmentKey: selected.key,
        validate: () => validSelection(selected) })) {
      status('This moment could not open for preview. Try again.');
    }
  });
  bindMomentAction(jump, () => selection, selected => {
    if (!stillSelected(selected) || jumping === selected) return;
    if (!readyToSeek(model, selected.position)) {
      renderSelection();
      status('This selection changed. Check the available action again.');
      return;
    }
    void seekPosition(selected.position, selected);
  });
  returnButton.addEventListener('click', () => returnToPlayhead({ focus: true }));
  panel.addEventListener('toggle', () => { if (!panel.open && (selection || draft)) returnToPlayhead(); });
  pins.addEventListener('click', event => {
    const button = event.target.closest('[data-timeline-pin]');
    if (button) focusScene(button.dataset.timelinePin);
  });

  return {
    update(next) {
      model = next;
      const { duration, ready, prepared, position, blocked, marks } = next;
      const furthest = Math.max(0, ...ready.map(range => range[1]));
      const text = ready.length ? `${clockTime(furthest)} ${ready.length > 1 || ready[0][0] > .05 ? 'furthest ready' : 'ready'}` : 'Preparing video';
      if (summary.textContent !== text) summary.textContent = text;
      slider.disabled = duration === null || !ready.length || blocked;
      const controlLabel = next.attachmentKey ? 'Select a moment on the playback map' : 'Seek within ready video';
      if (slider.getAttribute('aria-label') !== controlLabel) slider.setAttribute('aria-label', controlLabel);
      renderSelection();
      if (!draft || draft.key !== next.attachmentKey) {
        slider.max = duration ?? 0;
        slider.value = selection?.position ?? position;
      }
      updateTime();
      playhead.hidden = duration === null;
      const nextDrawing = JSON.stringify([duration, ready, prepared]);
      if (drawing !== nextDrawing) {
        drawing = nextDrawing;
        const ranges = duration === null ? [] : [...prepared.map(range => [range, 'prepared']), ...ready.map(range => [range, 'ready'])];
        ranges.forEach(([[start, end], kind], index) => {
          const bar = layers.children[index] || layers.appendChild(document.createElement('span'));
          bar.className = `timeline-range ${kind}`;
          bar.style.setProperty('--start', start / duration * 100 + '%');
          bar.style.setProperty('--span', (end - start) / duration);
        });
        while (layers.children.length > ranges.length) layers.lastElementChild.remove();
      }
      const visibleMarks = duration === null ? [] : marks.filter(mark => mark.time >= 0 && mark.time <= duration).slice(0, 24);
      const nextPins = JSON.stringify([duration, visibleMarks]);
      if (pinSignature !== nextPins) {
        pinSignature = nextPins;
        const focused = document.activeElement?.dataset.timelinePin;
        pins.replaceChildren(...visibleMarks.map(mark => {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.timelinePin = mark.id;
          button.style.setProperty('--position', mark.time / duration * 100 + '%');
          button.setAttribute('aria-label', `Open scene pin at ${clockTime(mark.time)}${mark.ready ? '' : ', not ready yet'}`);
          button.title = `${clockTime(mark.time)}${mark.ready ? ' · Scene pin' : ' · Waiting for video'}`;
          if (mark.ready) button.className = 'is-ready';
          return button;
        }));
        if (focused) [...pins.children].find(button => button.dataset.timelinePin === focused)?.focus();
      }
      const nextSignature = String(blocked) + ':' + Boolean(ready.length);
      if (signature !== nextSignature) {
        signature = nextSignature;
        if (ready.length && !blocked && !selection) status('');
      }
      notifySelection();
    },
    reset() {
      slider.disabled = true;
      returnToPlayhead();
      model = null;
      drawing = '';
      layers.replaceChildren();
    },
  };
}

import {readyToSeek} from './playback-map.js';

export function createVideoControls({video, controls, panels, getPlayback, seek, clockTime, onInteract}) {
  const stage = controls.parentElement;
  const dialog = stage.closest('dialog');
  const part = name => controls.querySelector(`[data-video-${name}]`);
  const timeline = part('seek'), toggle = part('toggle'), mute = part('mute'), volume = part('volume');
  const speed = part('speed'), speedOptions = [...speed.querySelectorAll('[data-rate]')];
  const fullscreen = part('fullscreen'), pip = part('pip');
  const feedback = part('message'), readyRail = part('buffer'), progress = part('progress');
  const disclosures = [...panels, speed];
  const adjustedCues = new Map();
  let draft = null, hideTimer, feedbackTimer, clickTimer, message = '', bufferSignature = '', attachment = null;
  let lastVolume = video.volume || 1;

  controls.querySelector('.video-track-controls').append(...panels);
  for (const panel of panels) {
    const name = panel.id === 'audio-panel' ? 'Audio' : 'Subtitles';
    label(panel.querySelector('summary'), name);
  }
  video.tabIndex = 0;
  video.controls = false;
  fullscreen.hidden = !document.fullscreenEnabled || typeof stage.requestFullscreen !== 'function';
  pip.hidden = !document.pictureInPictureEnabled || typeof video.requestPictureInPicture !== 'function';

  function announce(text = '') {
    if (message === text) return;
    message = text;
    feedback.textContent = text;
    feedback.hidden = !text;
    clearTimeout(feedbackTimer);
    if (text) feedbackTimer = setTimeout(() => announce(), 3500);
  }

  function label(button, name, shortcut = '') {
    button.setAttribute('aria-label', name);
    button.title = shortcut ? `${name} (${shortcut})` : name;
  }

  function reveal() {
    clearTimeout(hideTimer);
    stage.classList.remove('video-controls-idle');
    positionCaptions();
    if (!controls.hidden && !video.paused && !video.ended && !message &&
        !controls.matches(':hover') && !controls.querySelector(':focus-visible') &&
        !disclosures.some(panel => panel.open)) {
      hideTimer = setTimeout(() => {
        stage.classList.add('video-controls-idle');
        positionCaptions();
      }, 2300);
    }
  }

  function positionCaptions() {
    const showControls = !controls.hidden && !stage.classList.contains('video-controls-idle') &&
      document.pictureInPictureElement !== video;
    const height = video.clientHeight;
    const offset = Math.min(126, height * .48);
    const line = Math.round(100 * (height - offset) / Math.max(height, 1));
    const visibleCues = new Set();
    if (showControls) for (const track of video.textTracks) {
      if (track.mode !== 'showing') continue;
      for (const cue of Array.from(track.activeCues || [])) {
        if (cue.region || (cue.line !== 'auto' && !adjustedCues.has(cue))) continue;
        if (!adjustedCues.has(cue)) {
          adjustedCues.set(cue, {snapToLines: cue.snapToLines, lineAlign: cue.lineAlign});
          cue.snapToLines = false;
          cue.lineAlign = 'end';
        }
        if (cue.line !== line) cue.line = line;
        visibleCues.add(cue);
      }
    }
    for (const [cue, original] of adjustedCues) {
      if (visibleCues.has(cue)) continue;
      cue.line = 'auto';
      cue.lineAlign = original.lineAlign;
      cue.snapToLines = original.snapToLines;
      adjustedCues.delete(cue);
    }
  }

  function drawTimeline(playback) {
    const {map, key} = playback;
    if (draft?.key !== key) draft = null;
    const duration = map.duration;
    timeline.disabled = map.blocked || !duration;
    const position = Math.min(draft?.time ?? map.position, duration ?? Infinity);
    const available = draft ? readyToSeek(map, position) : true;
    const time = clockTime(position);
    const timeLabel = duration ? `${time} / ${clockTime(duration)}` : time;
    timeline.max = String(duration || 1);
    if (!draft) timeline.value = String(position);
    timeline.setAttribute('aria-valuetext', available ? timeLabel : `${timeLabel}, still downloading`);
    part('time').textContent = timeLabel;
    progress.style.width = duration ? `${position / duration * 100}%` : '0%';

    const ranges = duration ? map.ready : [];
    const signature = JSON.stringify([duration, ranges]);
    if (signature === bufferSignature) return;
    bufferSignature = signature;
    readyRail.replaceChildren(...ranges.map(([start, end]) => {
      const segment = document.createElement('span');
      segment.style.left = `${start / duration * 100}%`;
      segment.style.width = `${(end - start) / duration * 100}%`;
      return segment;
    }));
  }

  function update() {
    const playback = getPlayback();
    const hidden = !dialog.open || !playback.visible;
    if (attachment !== playback.key || hidden !== controls.hidden) {
      attachment = playback.key;
      controls.hidden = hidden;
      draft = null;
      clearTimeout(clickTimer);
      announce();
      disclosures.forEach(panel => { panel.open = false; });
      if (hidden && document.fullscreenElement === stage) void document.exitFullscreen().catch(() => {});
      reveal();
    }
    if (!hidden) drawTimeline(playback);
  }

  function renderMediaState() {
    const playing = !video.paused && !video.ended;
    const silent = video.muted || video.volume === 0;
    const full = document.fullscreenElement === stage;
    const mini = document.pictureInPictureElement === video;
    label(toggle, playing ? 'Pause' : 'Play', 'K');
    label(mute, silent ? 'Unmute' : 'Mute', 'M');
    label(fullscreen, full ? 'Exit fullscreen' : 'Fullscreen', 'F');
    label(pip, mini ? 'Exit picture in picture' : 'Picture in picture');
    pip.setAttribute('aria-pressed', String(mini));
    part('play').toggleAttribute('hidden', playing);
    part('pause').toggleAttribute('hidden', !playing);
    part('muted').toggleAttribute('hidden', !silent);
    part('unmuted').toggleAttribute('hidden', silent);
    part('expand').toggleAttribute('hidden', full);
    part('collapse').toggleAttribute('hidden', !full);
    if (video.volume > 0) lastVolume = video.volume;
    volume.value = String(silent ? 0 : video.volume);
    volume.setAttribute('aria-valuetext', `${Math.round(Number(volume.value) * 100)} percent`);
    part('rate').textContent = `${video.playbackRate}×`;
    for (const option of speedOptions) {
      option.setAttribute('aria-pressed', String(Number(option.dataset.rate) === video.playbackRate));
    }
    reveal();
  }

  async function moveTo(time, key = getPlayback().key) {
    const {map, key: current} = getPlayback();
    if (controls.hidden || current !== key || map.blocked) return;
    onInteract();
    const maximum = map.duration ? Math.max(0, map.duration - .25) : Infinity;
    const target = Math.max(0, Math.min(time, maximum));
    if (!readyToSeek(map, target)) {
      announce('This part is still downloading.');
      reveal();
      update();
      return;
    }
    announce();
    const moved = await seek(target);
    if (!moved && getPlayback().key === key) announce('Playback could not move to that point.');
    update();
    reveal();
  }

  function skip(seconds) {
    void moveTo(video.currentTime + seconds);
  }

  function togglePlaying() {
    onInteract();
    if (video.paused || video.ended) {
      const key = getPlayback().key;
      void video.play().catch(() => {
        if (key === getPlayback().key) announce('Could not start playback. Try again.');
      });
    } else {
      video.pause();
    }
  }

  function toggleMute() {
    if (!video.volume) {
      video.volume = lastVolume;
      video.muted = false;
    } else {
      video.muted = !video.muted;
    }
  }

  async function toggleFullscreen() {
    if (fullscreen.hidden) return;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      announce('Fullscreen is unavailable.');
    }
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      announce('Picture in picture is unavailable for this video.');
    }
  }

  toggle.onclick = togglePlaying;
  mute.onclick = toggleMute;
  volume.oninput = () => {
    video.volume = Number(volume.value);
    video.muted = false;
  };
  fullscreen.onclick = toggleFullscreen;
  pip.onclick = togglePip;
  for (const button of controls.querySelectorAll('[data-video-skip]')) {
    button.onclick = () => skip(Number(button.dataset.videoSkip));
  }
  for (const option of speedOptions) {
    option.onclick = () => {
      onInteract();
      video.defaultPlaybackRate = video.playbackRate = Number(option.dataset.rate);
      speed.open = false;
      speed.querySelector('summary').focus({preventScroll: true});
    };
  }
  timeline.oninput = () => {
    draft = {time: Number(timeline.value), key: getPlayback().key};
    update();
  };
  timeline.onchange = () => {
    const selected = draft;
    draft = null;
    if (selected) void moveTo(selected.time, selected.key);
  };
  timeline.addEventListener('pointercancel', () => { draft = null; update(); });

  video.addEventListener('click', event => {
    if (controls.hidden) return;
    const open = disclosures.filter(panel => panel.open);
    if (open.length) open.forEach(panel => { panel.open = false; });
    else if (event.detail === 1) clickTimer = setTimeout(togglePlaying, 220);
  });
  video.addEventListener('dblclick', event => {
    if (!controls.hidden) {
      event.preventDefault();
      clearTimeout(clickTimer);
      void toggleFullscreen();
    }
  });
  for (const event of ['play', 'pause', 'ended', 'volumechange', 'ratechange', 'enterpictureinpicture', 'leavepictureinpicture']) {
    video.addEventListener(event, renderMediaState);
  }
  document.addEventListener('fullscreenchange', renderMediaState);
  for (const track of video.textTracks) track.addEventListener('cuechange', positionCaptions);
  video.textTracks.addEventListener('addtrack', ({track}) => track.addEventListener('cuechange', positionCaptions));
  video.textTracks.addEventListener('removetrack', ({track}) => {
    track.removeEventListener('cuechange', positionCaptions);
    positionCaptions();
  });
  new ResizeObserver(positionCaptions).observe(video);
  for (const event of ['pointermove', 'pointerleave', 'focusin', 'focusout']) stage.addEventListener(event, reveal);
  for (const panel of disclosures) panel.addEventListener('toggle', reveal);
  const overlays = stage.querySelectorAll('#player-placeholder, #resume-choice');
  const observer = new MutationObserver(update);
  observer.observe(dialog, {attributes: true, attributeFilter: ['open']});
  for (const overlay of overlays) observer.observe(overlay, {attributes: true, attributeFilter: ['hidden']});

  dialog.addEventListener('keydown', event => {
    if (controls.hidden || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey ||
        event.target.closest('input, select, textarea, [contenteditable]') ||
        disclosures.some(panel => panel.open)) return;
    const key = event.key.toLowerCase();
    if (key === ' ' && event.target.closest('button, summary, a')) return;
    const actions = {' ': togglePlaying, k: togglePlaying, arrowleft: () => skip(-10),
      arrowright: () => skip(10), m: toggleMute, f: toggleFullscreen};
    if (!actions[key]) return;
    event.preventDefault();
    reveal();
    void actions[key]();
  });
  renderMediaState();
  update();
  return {update, closeMenus: () => {
    const panel = disclosures.find(item => item.open);
    if (!panel) return false;
    const nested = [...panel.querySelectorAll('details[open]')].at(-1);
    const target = nested || panel;
    target.open = false;
    target.querySelector('summary').focus({preventScroll: true});
    return true;
  }};
}

const confirmedWaitMs = 600;

export function createReleaseObservation(startedAt) {
  let picture = null;
  let firstPictureMs = null;
  let firstSeen = false;
  let startExcluded = false;
  let waitingSince = null;
  let count = 0;
  let totalMs = 0;

  function elapsedWait(now) {
    return waitingSince === null || !Number.isFinite(now) ? 0 : Math.max(0, Math.round(now - waitingSince));
  }

  return {
    excludeStart() {
      startExcluded = true;
    },
    frame(now, width, height) {
      if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
        picture = {width, height};
      }
      if (firstSeen) return;
      firstSeen = true;
      if (!startExcluded && Number.isFinite(now) && now >= startedAt) {
        firstPictureMs = Math.round(now - startedAt);
      }
    },
    wait(now) {
      if (firstSeen && waitingSince === null && Number.isFinite(now)) waitingSince = now;
    },
    settle(now) {
      const elapsed = elapsedWait(now);
      waitingSince = null;
      if (elapsed < confirmedWaitMs) return;
      count++;
      totalMs += elapsed;
    },
    snapshot(now) {
      const pending = elapsedWait(now);
      const waiting = pending >= confirmedWaitMs;
      return {picture, firstPictureMs, stalls:{
        count:count + Number(waiting), totalMs:totalMs + (waiting ? pending : 0), waiting,
      }};
    },
  };
}

import {parentPort, workerData} from 'node:worker_threads';
import {parseSceneMovie, selectScene} from './scene-mp4-index.mjs';

const RUNWAY_MS = 12_000;
const padding = {audioPrerollSamples:8,readAheadMs:600};

function foregroundRange(movie,playheadMs) {
  if (!Number.isSafeInteger(playheadMs) || playheadMs<0) return;
  try {
    const {video,audio} = selectScene(movie,playheadMs,RUNWAY_MS,padding);
    let start = Infinity, end = 0;
    // Include the preceding random-access point, audio preroll and reorder
    // samples. The separately verified MP4 bootstrap is not part of the runway.
    for (const track of [video,audio]) {
      for (const sample of track.samples) {
        start = Math.min(start,sample.start);
        end = Math.max(end,sample.end);
      }
    }
    if (start<end) return {start,end,throughMs:playheadMs+RUNWAY_MS};
  } catch {
    // A missing exact foreground map only disables the optional fetch.
  }
}

try {
  const {prefix,sourceSize,targetMs,playheadMs} = workerData;
  const movie = parseSceneMovie(prefix,sourceSize);
  const scene = selectScene(movie,targetMs,2000,padding);
  const foreground = foregroundRange(movie,playheadMs);
  if (foreground) scene.foreground = foreground;
  parentPort.postMessage({scene});
} catch {
  parentPort.postMessage({unsupported:true});
} finally {
  parentPort.close();
}

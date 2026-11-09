import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MANAGED_CINEMA_PORT, managedLaunchProof, managedStorageMatches } from './managed-companion.mjs';
import { createQbit } from './qbit-client.mjs';

const launchEnvironment = new Set(['PORT', 'CINEMA_DATA_DIR', 'CINEMA_MANAGED_SCENE_ROOT',
  'CINEMA_SCENE_ORIGIN', 'CINEMA_SCENE_KEY', 'CINEMA_SCENE_CERT_FILE', 'QBITTORRENT_CINEMA_SCENE_KEY']);
const bounded = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

function loopbackListening(port, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, signal });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function readProof(response) {
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 512) return null;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))?.proof;
}

async function verifyBackend(profile, signal, request) {
  const challenge = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${MANAGED_CINEMA_PORT}/api/launcher/scene?challenge=${challenge}`;
  const proof = await request(url, { signal, redirect: 'error' }).then(readProof).catch(() => null);
  if (typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)) {
    const expected = managedLaunchProof(profile, challenge);
    if (timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(expected, 'hex'))) return;
  }
  throw Error('Another local service is using the Cinema Scene Preview port.');
}

async function verifyDownloader(profile, signal, createClient) {
  const client = createClient(() => profile.config, {
    sceneOrigin: profile.config.url, sceneKey: profile.sceneKey, sceneCertificate: profile.certificate,
  });
  let preferences;
  try {
    if (!client.acceptsSceneOrigin(profile.config.url)) throw Error();
    await client.login(signal);
    const reader = client.sceneReader(signal);
    if (!await reader.scheduler?.available()) throw Error();
    preferences = await reader.json('app/preferences');
  } catch {
    throw Error('Cinema could not verify the Scene Preview downloader. Check the paired connection.');
  }
  if (!managedStorageMatches(profile, preferences)) {
    throw Error('The Scene Preview downloader has unexpected connection or storage settings.');
  }
}

async function waitForListener(child, port, label, signal, listening) {
  try {
    while (!await listening(port, bounded(signal, 1500))) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`${label} closed during startup.`);
      await delay(125, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) throw Error(`${label} did not start in time.`);
    throw error;
  }
}

async function requireStartedChild(start, executable, args, options, ready) {
  const child = await start(executable, args, options);
  try {
    await ready(child);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
    throw error;
  }
}

export async function launchManagedCompanion(profile, start, {
  listening = loopbackListening, request = fetch, createClient = createQbit,
  startupSignal = AbortSignal.timeout(55_000), environment = process.env,
} = {}) {
  const cinemaReady = async () => {
    if (!await listening(MANAGED_CINEMA_PORT, bounded(startupSignal, 1500))) return false;
    await verifyBackend(profile, bounded(startupSignal, 1500), request);
    return true;
  };
  // Check for a foreign Cinema listener before touching either managed service.
  await cinemaReady();
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !launchEnvironment.has(key.toUpperCase())));
  const verifyQbit = () => verifyDownloader(profile, bounded(startupSignal, 4500), createClient);
  if (await listening(profile.webPort, bounded(startupSignal, 1500))) {
    await verifyQbit();
  } else {
    await requireStartedChild(start, profile.qbitExecutable, [
      `--profile=${profile.qbitProfile}`, `--webui-port=${profile.webPort}`,
      `--torrenting-port=${profile.peerPort}`, '--confirm-legal-notice',
    ], { cwd: path.dirname(profile.qbitExecutable), env: { ...env, QBITTORRENT_CINEMA_SCENE_KEY: profile.sceneKey } }, async child => {
      await waitForListener(child, profile.webPort, 'The Scene Preview downloader', bounded(startupSignal, 20_000), listening);
      await verifyQbit();
    });
  }

  if (await cinemaReady()) return;
  await requireStartedChild(start, process.execPath, ['server.mjs'], { env: { ...env, CINEMA_MANAGED_SCENE_ROOT: profile.root } }, async child => {
    await waitForListener(child, MANAGED_CINEMA_PORT, 'The Cinema Scene Preview service', bounded(startupSignal, 25_000), listening);
    await verifyBackend(profile, bounded(startupSignal, 1500), request);
  });
}

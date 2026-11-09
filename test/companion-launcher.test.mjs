import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchManagedCompanion } from '../companion-launcher.mjs';
import { MANAGED_CINEMA_PORT, managedLaunchProof } from '../managed-companion.mjs';

const root = path.join(os.tmpdir(), 'Cinema', 'SceneCompanion-qa-launch');
const profile = {
  root, appData: path.join(root, 'cinema'), qbitProfile: path.join(root, 'qbit'),
  qbitExecutable: path.join(root, 'payload', 'qbittorrent-nox.exe'),
  downloads: path.join(root, 'downloads'), incomplete: path.join(root, 'incomplete'),
  webPort: 47443, peerPort: 47444, config: { url: 'https://127.0.0.1:47443', username: 'fixture', password: 'fixture-only' },
  sceneKey: 'a'.repeat(64), certificateSha256: 'b'.repeat(64), certificate: Buffer.from('synthetic certificate'),
  certificateFile: path.join(root, 'certificate.pem'), ownerSid: 'S-1-5-21-1000-1000-1000-1001',
};
const matchingPreferences = {
  web_ui_address: '127.0.0.1', web_ui_port: profile.webPort, use_https: true,
  save_path: profile.downloads.replaceAll('\\', '/'), temp_path_enabled: true,
  temp_path: `${profile.incomplete.replaceAll('\\', '/')}/`,
};

function fixture({ cinema = false, qbit = false, preferences = matchingPreferences, capability = true,
  loginError = false, backendReply, onStart, startupSignal } = {}) {
  const ports = new Set([...(cinema ? [MANAGED_CINEMA_PORT] : []), ...(qbit ? [profile.webPort] : [])]);
  const events = [], spawns = [], challenges = [];
  async function start(executable, args, options) {
    const service = executable === profile.qbitExecutable ? 'qbit' : 'cinema';
    const child = { exitCode: null, signalCode: null, stopped: false, kill() { this.stopped = true; } };
    spawns.push({ executable, args, options, child });
    events.push(`spawn:${service}`);
    if (onStart) onStart(service, ports, child);
    else ports.add(service === 'qbit' ? profile.webPort : MANAGED_CINEMA_PORT);
    return child;
  }
  const options = {
    startupSignal,
    environment: { Path: 'fixture-path', PORT: '7000', CINEMA_DATA_DIR: 'other-data', CINEMA_MANAGED_SCENE_ROOT: 'other-root',
      cinema_scene_key: 'old-secret', CINEMA_SCENE_ORIGIN: 'https://127.0.0.1:4000', CINEMA_SCENE_CERT_FILE: 'other-cert',
      QBITTORRENT_CINEMA_SCENE_KEY: 'old-daemon-secret' },
    async listening(port, signal) { signal.throwIfAborted(); events.push(`listen:${port}`); return ports.has(port); },
    async request(address, options) {
      options.signal.throwIfAborted();
      assert.equal(options.redirect, 'error');
      const url = new URL(address);
      assert.equal(url.origin, `http://127.0.0.1:${MANAGED_CINEMA_PORT}`);
      assert.equal(url.pathname, '/api/launcher/scene');
      const challenge = url.searchParams.get('challenge');
      assert.match(challenge, /^[a-f0-9]{64}$/);
      challenges.push(challenge);
      events.push('backend-proof');
      return backendReply ? backendReply(challenge) : Response.json({ proof: managedLaunchProof(profile, challenge) });
    },
    createClient(getConfig, options) {
      assert.equal(getConfig(), profile.config);
      assert.deepEqual(options, { sceneOrigin: profile.config.url, sceneKey: profile.sceneKey, sceneCertificate: profile.certificate });
      return {
        acceptsSceneOrigin: origin => origin === profile.config.url,
        async login(signal) {
          signal.throwIfAborted(); events.push('qbit-login');
          if (loginError) throw Error('certificate rejected');
        },
        sceneReader(signal) {
          return {
            scheduler: { async available() { signal.throwIfAborted(); events.push('qbit-capability'); return capability; } },
            async json(endpoint) {
              signal.throwIfAborted(); assert.equal(endpoint, 'app/preferences'); events.push('qbit-preferences'); return preferences;
            },
          };
        },
      };
    },
  };
  return { events, spawns, challenges, run: () => launchManagedCompanion(profile, start, options) };
}

test('an existing paired Cinema is reused only after fresh proofs and a pinned companion capability and storage check', async () => {
  const state = fixture({ cinema: true, qbit: true });
  await state.run();
  assert.deepEqual(state.spawns, []);
  assert.deepEqual(state.events, [
    `listen:${MANAGED_CINEMA_PORT}`, 'backend-proof', `listen:${profile.webPort}`,
    'qbit-login', 'qbit-capability', 'qbit-preferences', `listen:${MANAGED_CINEMA_PORT}`, 'backend-proof',
  ]);
  assert.equal(new Set(state.challenges).size, 2);
});

test('a foreign backend, stale proof, or oversized response stops before the downloader is contacted', async () => {
  const stale = managedLaunchProof(profile, '0'.repeat(64));
  for (const backendReply of [
    () => Response.json({ proof: stale }),
    challenge => Response.json({ proof: managedLaunchProof(profile, challenge), pad: 'a'.repeat(512) }),
    () => new Response('redirect', { status: 302, headers: { Location: 'http://127.0.0.1:3210/' } }),
  ]) {
    const state = fixture({ cinema: true, qbit: true, backendReply });
    await assert.rejects(state.run(), /Another local service/);
    assert.deepEqual(state.events, [`listen:${MANAGED_CINEMA_PORT}`, 'backend-proof']);
    assert.deepEqual(state.spawns, []);
  }
});

test('an occupied downloader port with wrong TLS, absent scheduler, or unexpected preferences never spawns', async () => {
  for (const [options, error] of [
    [{ loginError: true }, /could not verify/],
    [{ capability: false }, /could not verify/],
    [{ preferences: { ...matchingPreferences, use_https: false } }, /unexpected connection or storage/],
    [{ preferences: { ...matchingPreferences, save_path: root } }, /unexpected connection or storage/],
    [{ preferences: { ...matchingPreferences, temp_path_enabled: false } }, /unexpected connection or storage/],
  ]) {
    const state = fixture({ ...options, qbit: true });
    await assert.rejects(state.run(), error);
    assert.deepEqual(state.spawns, []);
    if (options.loginError) assert.ok(!state.events.includes('qbit-capability'));
  }
});

test('free ports start only the pinned executable and managed Cinema with separate arguments and environment', async () => {
  const state = fixture();
  await state.run();
  assert.equal(state.spawns.length, 2);
  const [downloader, cinema] = state.spawns;
  assert.equal(downloader.executable, profile.qbitExecutable);
  assert.deepEqual(downloader.args, [`--profile=${profile.qbitProfile}`, `--webui-port=${profile.webPort}`,
    `--torrenting-port=${profile.peerPort}`, '--confirm-legal-notice']);
  assert.deepEqual(downloader.options, { cwd: path.dirname(profile.qbitExecutable),
    env: { Path: 'fixture-path', QBITTORRENT_CINEMA_SCENE_KEY: profile.sceneKey } });
  assert.equal(cinema.executable, process.execPath);
  assert.deepEqual(cinema.args, ['server.mjs']);
  assert.deepEqual(cinema.options, { env: { Path: 'fixture-path', CINEMA_MANAGED_SCENE_ROOT: root } });
  assert.ok(state.events.indexOf('qbit-preferences') < state.events.indexOf('spawn:cinema'));
  assert.equal(downloader.child.stopped, false);
  assert.equal(cinema.child.stopped, false);
});

test('a failed startup stops only its tracked child and keeps an already verified downloader alive', async () => {
  const state = fixture({ backendReply: () => Response.json({ proof: '0'.repeat(64) }) });
  await assert.rejects(state.run(), /Another local service/);
  assert.equal(state.spawns.length, 2);
  assert.equal(state.spawns[0].child.stopped, false);
  assert.equal(state.spawns[1].child.stopped, true);

  const failed = fixture({ loginError: true });
  await assert.rejects(failed.run(), /could not verify/);
  assert.equal(failed.spawns.length, 1);
  assert.equal(failed.spawns[0].child.stopped, true);
});

test('a bounded readiness failure stops the new child before spawning the second service', async () => {
  const deadline = new AbortController();
  const state = fixture({ startupSignal: deadline.signal, onStart: () => deadline.abort() });
  await assert.rejects(state.run(), /downloader did not start in time/);
  assert.equal(state.spawns.length, 1);
  assert.equal(state.spawns[0].child.stopped, true);
});

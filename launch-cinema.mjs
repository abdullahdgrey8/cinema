import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { launchManagedCompanion } from './companion-launcher.mjs';
import { loadManagedCompanion } from './managed-companion.mjs';
import { launchInstalledCinema } from './installed-cinema.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const local = new URL('.local/', import.meta.url);
const log = new URL('launcher-error.log', local);
const origin = 'http://127.0.0.1:3210';
function start(executable, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root, detached: true, stdio: 'ignore', windowsHide: true, ...options,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child); });
  });
}

async function request(url) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  } catch {
    return null;
  }
}

async function cinemaReady() {
  const response = await request(origin + '/api/session');
  if (!response?.ok) return false;
  const session = await response.json().catch(() => null);
  return typeof session?.appVersion === 'string' &&
    typeof session?.token === 'string' && typeof session?.url === 'string';
}

async function startQbit() {
  const config = await readFile(new URL('connection.json', local), 'utf8')
    .then(value => JSON.parse(value.replace(/^\uFEFF/, '')))
    .catch(() => ({ url: 'http://127.0.0.1:8080' }));
  const url = new URL(config.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return;
  const response = await request(new URL('api/v2/app/version', url.href.replace(/\/?$/, '/')));
  if (response) {
    await response.body?.cancel();
    return;
  }
  await start('C:\\Program Files\\qBittorrent\\qbittorrent.exe');
}

async function startCinema() {
  if (await cinemaReady()) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'CINEMA_MANAGED_SCENE_ROOT'));
  await start(process.execPath, ['server.mjs'], { env });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await cinemaReady()) return;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('Cinema did not become ready on port 3210. Check whether the port is already in use.');
}

async function launchOrdinary(servicesOnly) {
  try {
    await mkdir(local, { recursive: true });
    const qbit = startQbit().catch(error => appendFile(log, error.message + '\n').catch(() => {}));
    try {
      await startCinema();
      if (!servicesOnly) await start('explorer.exe', [origin + '/']);
    } finally {
      await qbit;
    }
  } catch (error) {
    await appendFile(log, error.message + '\n').catch(() => {});
    if (!servicesOnly) await start('notepad.exe', [fileURLToPath(log)]).catch(() => {});
    throw error;
  }
}

try {
  const { values } = parseArgs({ options: {
    'services-only': { type: 'boolean' }, 'scene-companion': { type: 'string' }, installed: { type: 'boolean' },
  } });
  if (values.installed) {
    if (!values['services-only'] || values['scene-companion'] !== undefined) throw Error('Open the installed Cinema desktop app.');
    await launchInstalledCinema(root, start);
  } else if (values['scene-companion'] !== undefined) {
    if (!values['services-only']) throw Error('Open Scene Preview from its desktop shortcut.');
    const profile = await loadManagedCompanion(values['scene-companion']);
    await launchManagedCompanion(profile, start);
  } else {
    await launchOrdinary(values['services-only']);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

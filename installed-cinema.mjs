import { execFile } from 'node:child_process';
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export const INSTALLED_CINEMA_PORT = 3211;
const username = 'cinema';
const loopback = '127.0.0.1';
const privateHex = /^[a-f0-9]{64}$/;
const pluginFile = /^[a-z][a-z0-9_]*\.py$/;
const runFile = promisify(execFile);
const scoped = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);

export function installedCinemaProof(secret, challenge) {
  return createHmac('sha256', secret).update(`cinema-installed-launch:${challenge}`).digest('hex');
}

async function item(file) {
  return fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function directory(folder) {
  if (!await item(folder)) {
    await directory(path.dirname(folder));
    await fs.mkdir(folder, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  if (!(await item(folder))?.isDirectory()) throw Error('Cinema needs a regular folder for its private profile.');
  return folder;
}

async function runtimeFile(file) {
  if (!(await item(file))?.isFile()) throw Error('Cinema is missing a bundled component. Run Cinema Setup again.');
  return file;
}

async function writeNew(file, bytes) {
  // A second launcher can read the complete file as soon as it appears.
  const temporary = path.join(path.dirname(file), `.cinema-${randomBytes(12).toString('hex')}.tmp`);
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await fs.link(temporary, file).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    if (!(await item(file))?.isFile()) throw Error('Cinema could not verify a file in its private profile.');
  } finally {
    await fs.unlink(temporary);
  }
}

async function privateJson(file) {
  const info = await item(file);
  if (!info) return null;
  if (!info.isFile() || info.size > 8192) throw Error('Cinema could not verify its private setup file.');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw Error('Cinema could not read its private setup file.');
  }
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, loopback, () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function installState(dataRoot, stateFile) {
  let state = await privateJson(stateFile);
  if (state === null) {
    const existing = await Promise.all(['app-data', 'qbit-profile'].map(name => item(path.join(dataRoot, name))));
    if (existing.some(Boolean)) {
      state = await privateJson(stateFile);
      if (state === null) throw Error('Cinema found an existing profile without its private setup settings.');
    }
  }
  if (state === null) {
    const webPort = await ephemeralPort();
    let peerPort;
    do { peerPort = await ephemeralPort(); } while (peerPort === webPort);
    const fresh = {
      schema: 1, webPort, peerPort, password: randomBytes(32).toString('hex'), secret: randomBytes(32).toString('hex'),
    };
    await writeNew(stateFile, JSON.stringify(fresh) + '\n');
    state = await privateJson(stateFile);
  }
  const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535 && ![3210, 3211, 3212, 8080].includes(port);
  if (state?.schema !== 1 || !validPort(state.webPort) || !validPort(state.peerPort) || state.webPort === state.peerPort ||
      typeof state.password !== 'string' || !privateHex.test(state.password) ||
      typeof state.secret !== 'string' || !privateHex.test(state.secret)) {
    throw Error('Cinema could not verify its private setup settings.');
  }
  return {
    ...state, dataRoot, origin: `http://${loopback}:${state.webPort}`,
    appData: path.join(dataRoot, 'app-data'), qbitProfile: path.join(dataRoot, 'qbit-profile'),
  };
}

function qbitSettings(profile, python, downloads, incomplete) {
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(profile.password, salt, 100000, 64, 'sha512');
  const passwordHash = `${salt.toString('base64')}:${digest.toString('base64')}`;
  const settingsPath = value => '"' + value.replaceAll('\\', '/') + '"';
  return [
    '[Application]', 'InstanceName=Cinema',
    '[BitTorrent]', `Session\\Port=${profile.peerPort}`, `Session\\DefaultSavePath=${settingsPath(downloads)}`,
    `Session\\TempPath=${settingsPath(incomplete)}`, 'Session\\TempPathEnabled=true',
    '[GUI]', 'StartUpWindowState=Hidden',
    '[LegalNotice]', 'Accepted=true',
    '[Preferences]', 'General\\SystrayEnabled=true', 'General\\MinimizeToTray=true', 'General\\MinimizeToTrayNotified=true',
    `Search\\pythonExecutablePath=${settingsPath(python)}`, 'WebUI\\Enabled=true', `WebUI\\Address=${loopback}`,
    `WebUI\\Port=${profile.webPort}`, `WebUI\\Username=${username}`, `WebUI\\Password_PBKDF2=@ByteArray(${passwordHash})`,
    `WebUI\\ServerDomains=${loopback}`, 'WebUI\\LocalHostAuth=true', 'WebUI\\AuthSubnetWhitelistEnabled=false',
    'WebUI\\CSRFProtection=true', 'WebUI\\HostHeaderValidation=true', 'WebUI\\UseUPnP=false',
    'WebUI\\SecureCookie=false', 'WebUI\\ReverseProxySupportEnabled=false', 'WebUI\\HTTPS\\Enabled=false', '',
  ].join('\r\n');
}

async function configure(profile, python, plugins, firstRun) {
  await directory(profile.appData);
  const connection = path.join(profile.appData, 'connection.json');
  const config = { url: profile.origin, username, password: profile.password };
  let saved = await privateJson(connection);
  if (saved === null) {
    await writeNew(connection, JSON.stringify(config) + '\n');
    saved = await privateJson(connection);
  }
  if (saved?.url !== config.url || saved.username !== config.username || saved.password !== config.password) {
    throw Error('Cinema could not verify its bundled downloader connection settings.');
  }

  const profileBase = await directory(path.join(await directory(profile.qbitProfile), 'qBittorrent'));
  const configRoot = await directory(path.join(profileBase, 'config'));
  const ini = path.join(configRoot, 'qBittorrent.ini');
  const previousIni = await item(ini);
  const pendingIni = !previousIni && !firstRun && (await item(path.join(configRoot, 'qBittorrent_new.ini')))?.isFile();
  if ((!firstRun && !previousIni && !pendingIni) || (previousIni && !previousIni.isFile())) {
    throw Error('Cinema could not verify its qBittorrent profile settings.');
  }
  if (!previousIni && !pendingIni) {
    const downloads = await directory(path.join(profile.dataRoot, 'downloads'));
    const incomplete = await directory(path.join(profile.dataRoot, 'incomplete'));
    await writeNew(ini, qbitSettings(profile, python, downloads, incomplete));
  }

  const names = (await fs.readdir(plugins)).filter(name => pluginFile.test(name)).sort();
  if (!names.length) throw Error('Cinema is missing its starter search plugins. Run Cinema Setup again.');
  const data = await directory(path.join(profileBase, 'data'));
  const nova = await directory(path.join(data, 'nova3'));
  const engines = await directory(path.join(nova, 'engines'));
  const receipts = await directory(path.join(profile.dataRoot, 'bundled-plugin-receipts'));
  const pending = [];
  for (const name of names) {
    const receipt = path.join(receipts, name + '.installed');
    if (await item(receipt)) continue;
    if (!firstRun && ['cinema_open_films.py', 'cinema_ubuntu.py'].includes(name)) {
      await writeNew(receipt, '1\n');
      continue;
    }
    const source = await runtimeFile(path.join(plugins, name));
    const target = path.join(engines, name);
    const existing = await item(target);
    if (!existing) await writeNew(target, await fs.readFile(source));
    else if (!existing.isFile()) throw Error('Cinema could not verify a starter search plugin in its private profile.');
    pending.push({name: path.basename(name, '.py'), receipt});
  }
  return pending;
}

function listening(port, signal) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: loopback, port, signal });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

function samePath(left, right) {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  const normalize = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalize(left) === normalize(right);
}

async function windowsDownloaderMatches(port, executable, signal) {
  if (process.platform !== 'win32') return false;
  const socket = connect({ host: loopback, port, signal });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    // Inspect the accepted connection. Some Windows environments omit the listening socket from this table.
    const command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
      `$connections = @(Get-NetTCPConnection -LocalAddress ${loopback} -LocalPort ${port} -RemoteAddress ${loopback} ` +
      `-RemotePort ${socket.localPort} -State Established -ErrorAction Stop); ` +
      'if ($connections.Count -eq 1) { (Get-Process -Id $connections[0].OwningProcess -ErrorAction Stop).Path }';
    const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      signal, windowsHide: true, maxBuffer: 8192,
    });
    return !socket.destroyed && samePath(stdout.trim(), executable);
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}

async function readResponse(response, maximum) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw Error('Unexpected response from a local service.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maximum) throw Error('Unexpected response from a local service.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

async function verifyCinema(request, secret, signal) {
  const challenge = randomBytes(16).toString('hex');
  const url = `http://${loopback}:${INSTALLED_CINEMA_PORT}/api/installed/ready?challenge=${challenge}`;
  const proof = await request(url, { signal, redirect: 'error' })
    .then(response => readResponse(response, 512)).then(value => JSON.parse(value)?.proof).catch(() => null);
  if (typeof proof === 'string' && privateHex.test(proof) &&
      timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(installedCinemaProof(secret, challenge), 'hex'))) return;
  throw Error('Another local service is using the installed Cinema port (3211).');
}

async function verifyDownloader(request, profile, python, pluginNames, signal) {
  const endpoint = route => `${profile.origin}/api/v2/${route}`;
  const headers = { Referer: `${profile.origin}/` };
  const options = { signal, redirect: 'error' };
  let preferences;
  try {
    const response = await request(endpoint('auth/login'), {
      ...options, headers, method: 'POST', body: new URLSearchParams({ username, password: profile.password }),
    });
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0])
      .filter(value => /^(?:SID|QBT_SID_\d+)=/.test(value)).join('; ');
    const result = response.status === 204 ? '' : (await readResponse(response, 128)).trim();
    if (!cookie || (response.status !== 204 && result !== 'Ok.')) throw Error();
    headers.Cookie = cookie;
    const settings = await request(endpoint('app/preferences'), { ...options, headers });
    preferences = JSON.parse(await readResponse(settings, 256 * 1024));
  } catch {
    throw Error('Cinema could not sign in to its bundled qBittorrent. Check its tray icon and retry.');
  }
  if (preferences?.web_ui_address !== loopback || preferences.web_ui_port !== profile.webPort ||
      preferences.web_ui_username !== username || preferences.bypass_local_auth !== false ||
      preferences.bypass_auth_subnet_whitelist_enabled !== false || preferences.web_ui_host_header_validation_enabled !== true ||
      preferences.web_ui_csrf_protection_enabled !== true) {
    throw Error('The bundled qBittorrent Web UI settings have changed. Restore the private connection and retry.');
  }
  if (!pluginNames.length) return;
  if (!samePath(preferences.python_executable_path, python)) {
    throw Error('The bundled qBittorrent could not find its Python runtime. Run Cinema Setup again.');
  }
  let loaded;
  try {
    const response = await request(endpoint('search/plugins'), { ...options, headers });
    const plugins = JSON.parse(await readResponse(response, 256 * 1024));
    loaded = new Set(plugins.map(plugin => plugin.name));
  } catch {
    throw Error('Cinema could not read the starter search plugins from qBittorrent. Retry to finish setup.');
  }
  if (!pluginNames.every(name => loaded.has(name))) {
    throw Error('qBittorrent did not load the full starter search plugin set. Run Cinema Setup again.');
  }
}

async function waitForPort(child, port, name, signal, isListening) {
  try {
    while (!await isListening(port, scoped(signal, 1500))) {
      if ((child.exitCode != null && child.exitCode !== 0) || child.signalCode != null) {
        throw Error(`${name} closed during startup.`);
      }
      await delay(150, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) throw Error(`${name} did not start in time.`);
    throw error;
  }
}

export async function launchInstalledCinema(root, start, {
  environment = process.env, isListening = listening, request = fetch, ownsDownloader = windowsDownloaderMatches,
  startupSignal = AbortSignal.timeout(55_000),
} = {}) {
  const override = environment.CINEMA_INSTALL_DATA_DIR;
  const local = environment.LOCALAPPDATA;
  if (!path.isAbsolute(override || local || '')) throw Error('Windows Local AppData is unavailable for Cinema.');
  const dataRoot = override ? path.normalize(override) : path.join(await directory(local), 'Cinema', 'Installed');
  if (!override) await directory(path.dirname(dataRoot));
  await directory(dataRoot);

  const runtime = path.join(root, 'runtime');
  const qbit = await runtimeFile(path.join(runtime, 'qbit', 'qbittorrent.exe'));
  const python = await runtimeFile(path.join(runtime, 'python', 'python.exe'));
  const stateFile = path.join(dataRoot, 'install.json');
  const profile = await installState(dataRoot, stateFile);
  const cinemaReady = async () => {
    if (!await isListening(INSTALLED_CINEMA_PORT, scoped(startupSignal, 1500))) return false;
    await verifyCinema(request, profile.secret, scoped(startupSignal, 2500));
    return true;
  };
  await cinemaReady();

  const marker = path.join(dataRoot, 'starter-plugins.ready');
  const previousSetup = await item(marker);
  if (previousSetup && !previousSetup.isFile()) throw Error('Cinema could not verify its private setup marker.');
  const pendingPlugins = await configure(profile, python, path.join(runtime, 'plugins'), !previousSetup);
  const excluded = /^(?:PORT$|CINEMA_DATA_DIR$|CINEMA_INSTALLED_SECRET$|CINEMA_MANAGED_SCENE_ROOT$|CINEMA_SCENE_|QBT_|QBITTORRENT_CINEMA_)/i;
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !excluded.test(key)));

  if (!await isListening(profile.webPort, scoped(startupSignal, 1500))) {
    const child = await start(qbit, [`--profile=${profile.qbitProfile}`, `--webui-port=${profile.webPort}`,
      `--torrenting-port=${profile.peerPort}`, '--confirm-legal-notice', '--no-splash'], { cwd: path.dirname(qbit), env });
    await waitForPort(child, profile.webPort, 'The bundled qBittorrent', scoped(startupSignal, 22_000), isListening);
  }
  if (!await ownsDownloader(profile.webPort, qbit, scoped(startupSignal, 8_000))) {
    throw Error('Cinema could not verify ownership of its qBittorrent connection. Close any conflicting local service and retry.');
  }
  await verifyDownloader(request, profile, python, pendingPlugins.map(plugin => plugin.name), scoped(startupSignal, 14_000));
  for (const plugin of pendingPlugins) await writeNew(plugin.receipt, '1\n');
  if (!previousSetup) await writeNew(marker, '1\n');

  if (await cinemaReady()) return;
  const service = await start(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
    ...env, PORT: String(INSTALLED_CINEMA_PORT), CINEMA_DATA_DIR: profile.appData, CINEMA_INSTALLED_SECRET: profile.secret,
    CINEMA_DESCRIPTION_FFPROBE: path.join(root, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'),
  } });
  await waitForPort(service, INSTALLED_CINEMA_PORT, 'The installed Cinema service', scoped(startupSignal, 24_000), isListening);
  await verifyCinema(request, profile.secret, scoped(startupSignal, 2500));
}

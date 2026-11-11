import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INSTALLED_CINEMA_PORT, installedCinemaProof, launchInstalledCinema } from '../installed-cinema.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-installed-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'program');
  const data = path.join(temporary, 'data');
  const qbit = path.join(root, 'runtime', 'qbit', 'qbittorrent.exe');
  const python = path.join(root, 'runtime', 'python', 'python.exe');
  const starter = path.join(root, 'runtime', 'plugins', 'cinema_open_films.py');
  for (const file of [qbit, python, starter]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'starter package fixture');
  }
  const starts = [], requests = [], ports = new Set();
  const state = () => fs.readFile(path.join(data, 'install.json'), 'utf8').then(JSON.parse);
  const signals = { downloaderOwned: true, starterLoaded: true };
  async function start(executable, args, options) {
    starts.push({ executable, args, options });
    ports.add(executable === qbit ? (await state()).webPort : INSTALLED_CINEMA_PORT);
    return { exitCode: null, signalCode: null };
  }
  const options = {
    environment: { CINEMA_INSTALL_DATA_DIR: data, CINEMA_MANAGED_SCENE_ROOT: 'other profile', QBT_CONFIGURATION: 'other config' },
    isListening: async port => ports.has(port),
    ownsDownloader: async (_, file) => file === qbit && signals.downloaderOwned,
    async request(rawUrl, { body }) {
      const url = new URL(rawUrl);
      requests.push(url.pathname);
      if (url.pathname === '/api/installed/ready') {
        const service = starts.find(call => call.executable === process.execPath);
        const secret = service?.options.env.CINEMA_INSTALLED_SECRET || 'unrelated service';
        return Response.json({ proof: installedCinemaProof(secret, url.searchParams.get('challenge')) });
      }
      if (url.pathname === '/api/v2/auth/login') {
        assert.equal(body.get('username'), 'cinema');
        assert.ok(body.get('password') === (await state()).password, 'login uses the private credential');
        return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=fixture; HttpOnly' } });
      }
      if (url.pathname === '/api/v2/app/preferences') {
        return Response.json({ web_ui_address: '127.0.0.1', web_ui_port: (await state()).webPort,
          web_ui_username: 'cinema', bypass_local_auth: false, bypass_auth_subnet_whitelist_enabled: false,
          web_ui_host_header_validation_enabled: true, web_ui_csrf_protection_enabled: true, python_executable_path: python });
      }
      return Response.json(signals.starterLoaded ? [{ name: 'cinema_open_films', enabled: true }, ...(
        signals.extraLoaded ? [{name:'extra', enabled:true}] : []
      )] : []);
    },
  };
  return { data, qbit, starts, requests, ports, state, signals,
    addBundledPlugin: () => fs.writeFile(path.join(path.dirname(starter), 'extra.py'), 'extra package fixture'),
    launch: () => launchInstalledCinema(root, start, options) };
}

test('installed launcher configures the private profile once and preserves plugin changes', async t => {
  const f = await fixture(t);
  await f.launch();
  assert.equal(f.starts.length, 2);
  const [downloader, service] = f.starts;
  assert.equal(downloader.executable, f.qbit);
  assert.equal(downloader.args[0], `--profile=${path.join(f.data, 'qbit-profile')}`);
  assert.equal(downloader.options.env.QBT_CONFIGURATION, undefined);
  assert.equal(service.options.env.CINEMA_MANAGED_SCENE_ROOT, undefined);
  assert.equal(service.options.env.CINEMA_DATA_DIR, path.join(f.data, 'app-data'));
  assert.equal(service.options.env.PORT, '3211');
  const configBase = path.join(f.data, 'qbit-profile', 'qBittorrent');
  const ini = path.join(configBase, 'config', 'qBittorrent.ini');
  const plugin = path.join(configBase, 'data', 'nova3', 'engines', 'cinema_open_films.py');
  assert.match(await fs.readFile(ini, 'utf8'), /StartUpWindowState=Hidden/);
  assert.equal(await fs.readFile(plugin, 'utf8'), 'starter package fixture');
  assert.equal(f.requests.filter(route => route.endsWith('/plugins')).length, 1);
  await fs.unlink(plugin);
  await fs.appendFile(ini, '\n# user setting\n');
  const original = await f.state();
  f.signals.starterLoaded = false;
  await f.launch();
  assert.equal(f.starts.length, 2);
  assert.equal(f.requests.filter(route => route.endsWith('/plugins')).length, 1);
  assert.match(await fs.readFile(ini, 'utf8'), /# user setting/);
  assert.ok((await f.state()).secret === original.secret, 'the installation keeps its original identity');
  await assert.rejects(fs.access(plugin), { code: 'ENOENT' });
});

test('an upgraded bundle adds a new plugin to an existing profile once', async t => {
  const f = await fixture(t);
  await f.launch();
  await fs.unlink(path.join(f.data, 'bundled-plugin-receipts', 'cinema_open_films.py.installed'));
  await f.addBundledPlugin();
  f.signals.extraLoaded = true;
  await f.launch();
  const extra = path.join(f.data, 'qbit-profile', 'qBittorrent', 'data', 'nova3', 'engines', 'extra.py');
  assert.equal(await fs.readFile(extra, 'utf8'), 'extra package fixture');
  assert.equal(f.starts.length, 2);
  await fs.unlink(extra);
  await f.launch();
  await assert.rejects(fs.access(extra), {code:'ENOENT'});
});

test('first launch waits for the full starter plugin list before starting Cinema', async t => {
  const f = await fixture(t);
  f.signals.starterLoaded = false;
  await assert.rejects(f.launch(), /did not load the full starter search plugin set/);
  assert.equal(f.starts.length, 1);
  await assert.rejects(fs.access(path.join(f.data, 'starter-plugins.ready')), { code: 'ENOENT' });
  f.signals.starterLoaded = true;
  await f.launch();
  assert.equal(f.starts.length, 2);
});

test('installed launcher rejects unrelated services before sending qBittorrent credentials', async t => {
  const f = await fixture(t);
  f.ports.add(INSTALLED_CINEMA_PORT);
  await assert.rejects(f.launch(), /Another local service/);
  assert.equal(f.starts.length, 0);
  f.ports.clear();
  f.ports.add((await f.state()).webPort);
  f.signals.downloaderOwned = false;
  await assert.rejects(f.launch(), /could not verify ownership/);
  assert.deepEqual(f.requests, ['/api/installed/ready']);
  assert.equal(f.starts.length, 0);
});

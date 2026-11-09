import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {cinema, HASH, torrent, until} from './helpers.mjs';

const settingsRoute = '/api/download-location';
const destinationFields = ['savepath', 'autoTMM', 'useDownloadPath'];
const submissions = c => c.state.requests.filter(request => request.endpoint === 'torrents/add');

async function select(c, hash, fileName) {
  c.state.results = [{fileName, fileUrl:`magnet:?xt=urn:btih:${hash}`, fileSize:36,
    nbSeeders:20, nbLeechers:3, siteUrl:'https://video.example', descrLink:'https://video.example/details'}];
  const job = await c.api('/api/search', {query:fileName, category:'movies', plugin:'video'});
  const found = await c.api('/api/results?id='+job.id);
  assert.equal(found.results.length, 1);
  return {key:found.results[0].key, category:'movies'};
}

async function terminal(c, operation) {
  return until(async () => {
    const status = await c.api('/api/add/status?id='+operation.id);
    return ['ready', 'failed', 'uncertain'].includes(status.status) && status;
  }, {description:'qBittorrent add to settle'});
}

function assertDestination(request, expectedPath) {
  assert.equal(request.method, 'POST');
  const wirePath = expectedPath===null || expectedPath.endsWith(path.sep) ? expectedPath : expectedPath+path.sep;
  assert.deepEqual(destinationFields.map(field => request.params.get(field)),
    wirePath === null ? [null, null, null] : [wirePath, 'false', 'false']);
  assert.equal(request.params.get('sequentialDownload'), 'true');
  assert.equal(request.params.get('firstLastPiecePrio'), 'true');
}

function assertNoGlobalChanges(c) {
  assert.deepEqual(c.state.requests.filter(({endpoint}) => [
    'app/setPreferences', 'torrents/setLocation', 'torrents/setAutoManagement',
    'torrents/setSavePath', 'torrents/setDownloadPath',
  ].includes(endpoint)), []);
}

test('download location is local, protected and persistent, and reset uses the qBittorrent defaults for new adds', async t => {
  const c = await cinema(t);
  const withoutWhitespace = await fs.mkdtemp(path.join(c.dir, 'Movie downloads '));
  const custom = withoutWhitespace+'\u00a0';
  await fs.mkdir(custom);
  const canonical = await fs.realpath(custom);
  assert.notEqual(canonical,await fs.realpath(withoutWhitespace));
  const file = path.join(c.dir, 'regular-file');
  await fs.writeFile(file, 'fixture');
  const defaults = {mode:'default', path:null};
  const choice = {mode:'custom', path:canonical};

  assert.deepEqual(await c.api(settingsRoute), defaults);
  assert.equal((await c.request(settingsRoute, undefined, {headers:{Origin:'https://other.example'}})).status, 403);
  assert.equal((await c.request(settingsRoute, {path:custom}, {headers:{Origin:'https://other.example'}})).status, 403);
  assert.equal((await c.request(settingsRoute, {path:custom}, {headers:{'X-Cinema-Token':''}})).status, 403);
  assert.deepEqual(await c.api(settingsRoute), defaults);
  assert.deepEqual(await c.api(settingsRoute, {path:custom}), choice);
  for (const body of [{}, {path:42}, {path:{}}, {path:'relative'}, {path:' '}, {path:custom+'\n'}, {path:file}, {path:path.join(c.dir, 'missing')}]) {
    const response = await c.request(settingsRoute, body);
    assert.ok(response.status >= 400 && response.status < 500, `Expected validation error for ${JSON.stringify(body)}`);
    assert.deepEqual(await c.api(settingsRoute), choice);
  }

  const {url} = await c.api('/api/session');
  await c.api('/api/connect', {url, username:'test', password:'test'});
  assert.deepEqual(await c.api(settingsRoute), choice);
  await c.restart();
  assert.deepEqual(await c.api(settingsRoute), choice);

  c.state.handlers['torrents/add'] = ({params, send}) => {
    const hash = new URL(params.get('urls')).searchParams.get('xt').slice('urn:btih:'.length);
    const name = c.state.results[0].fileName;
    c.state.torrents.push(torrent(path.resolve(params.get('savepath') || c.dir), {hash, name, tags:params.get('tags')}));
    send({success_count:1, pending_count:0, failure_count:0, added_torrent_ids:[hash]});
  };
  const first = await select(c, HASH, 'Garden.Story.2020.1080p.mp4');
  const added = await terminal(c, await c.api('/api/add', first));
  assert.equal(added.status, 'ready');
  assertDestination(submissions(c)[0], canonical);

  assert.deepEqual(await c.api(settingsRoute, {path:null}), defaults);
  const existing = await c.api('/api/add', first);
  assert.equal(existing.id, added.id);
  assert.equal(existing.hash, HASH);
  assert.equal(submissions(c).length, 1, 'Changing the setting must not resubmit an existing torrent');
  assert.equal(c.state.torrents[0].save_path, canonical);

  const second = await select(c, 'b'.repeat(40), 'Different.Planet.2021.1080p.mp4');
  assert.equal((await terminal(c, await c.api('/api/add', second))).status, 'ready');
  assert.equal(submissions(c).length, 2);
  assertDestination(submissions(c)[1], null);
  assertNoGlobalChanges(c);
});

test('retry retains its original custom location after a settings change and refuses a missing original folder', async t => {
  const c = await cinema(t);
  const original = await fs.mkdtemp(path.join(c.dir, 'Original '));
  const originalPath = await fs.realpath(original);
  const replacement = await fs.mkdtemp(path.join(c.dir, 'Replacement '));
  const replacementPath = await fs.realpath(replacement);
  await c.api(settingsRoute, {path:original});
  c.state.handlers['torrents/add'] = ({send}) => send({success_count:0, pending_count:0, failure_count:1, added_torrent_ids:[]});
  const input = await select(c, HASH, 'Retry.Story.2022.1080p.mp4');
  const initial = await terminal(c, await c.api('/api/add', input));
  assert.equal(initial.status, 'failed');
  assertDestination(submissions(c)[0], originalPath);

  await c.api(settingsRoute, {path:replacement});
  await c.restart();
  assert.deepEqual(await c.api(settingsRoute), {mode:'custom', path:replacementPath});
  const retry = {id:initial.id, confirmRetry:true};
  const retried = await terminal(c, await c.api('/api/add/retry', retry));
  assert.equal(retried.id, initial.id);
  assert.equal(retried.status, 'failed');
  assert.equal(submissions(c).length, 2);
  assertDestination(submissions(c)[1], originalPath);
  assert.equal(submissions(c)[1].params.get('tags'), submissions(c)[0].params.get('tags'));

  await fs.rmdir(original);
  const missing = await terminal(c, await c.api('/api/add/retry', retry));
  assert.equal(missing.status, 'failed');
  assert.match(missing.message, /folder and drive are available/i);
  assert.equal(submissions(c).length, 2, 'A missing original folder must prevent resubmission');

  await fs.symlink(replacement, original, process.platform==='win32'?'junction':'dir');
  const redirected = await terminal(c, await c.api('/api/add/retry', retry));
  assert.equal(redirected.status, 'failed');
  assert.match(redirected.message, /points somewhere else/i);
  assert.equal(submissions(c).length, 2, 'A redirected original folder must prevent resubmission');
  assert.deepEqual(await c.api(settingsRoute), {mode:'custom', path:replacementPath});
  assertNoGlobalChanges(c);
});

test('an unreadable download preference can be reset without silently reverting to the default', async t => {
  const c = await cinema(t);
  await fs.writeFile(path.join(c.dir, 'download-location.json'), '{invalid');
  await c.restart();
  assert.equal((await c.request(settingsRoute)).status, 500);
  const source = await select(c, HASH, 'Repair.Story.2023.1080p.mp4');
  assert.equal((await c.request('/api/add', source)).status, 500);
  assert.equal(submissions(c).length, 0);
  assert.deepEqual(await c.api(settingsRoute, {path:null}), {mode:'default', path:null});
  await c.restart();
  assert.deepEqual(await c.api(settingsRoute), {mode:'default', path:null});
});

test('an expired qBittorrent session rechecks the custom folder before replaying an add', async t => {
  const c = await cinema(t);
  const folder = await fs.mkdtemp(path.join(c.dir, 'Expiring session '));
  const canonical = await fs.realpath(folder);
  await c.api(settingsRoute, {path:folder});
  c.state.handlers['torrents/add'] = async ({send}) => {
    await fs.rmdir(folder);
    send('Forbidden',403);
  };
  const selection = await select(c, HASH, 'Session.Expiry.2022.1080p.mp4');
  const operation = await terminal(c, await c.api('/api/add', selection));
  assert.equal(operation.status,'failed');
  assert.match(operation.message,/folder and drive are available/i);
  assert.equal(submissions(c).length,1,'The rejected add must not be replayed to the missing folder');
  assertDestination(submissions(c)[0], canonical);
  const firstAttempt=c.state.requests.indexOf(submissions(c)[0]);
  assert.ok(c.state.requests.slice(firstAttempt+1).some(request=>request.endpoint==='auth/login'));
});

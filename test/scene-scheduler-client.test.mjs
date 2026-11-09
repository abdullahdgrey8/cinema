import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { connect as tlsConnect } from 'node:tls';
import { createQbit } from '../qbit-client.mjs';

const key = 'a'.repeat(64);
const hash = 'b'.repeat(40);
const id = 'f2222222-2222-4222-8222-222222222222';
const sceneEndpoint = '/api/v2/torrents/cinemaScene';
const credentials = { username: 'paired-fixture', password: 'test-only' };
const authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
const input = { hash, index: 3, size: 65536, reserve: [0, 32768], ranges: [[32768, 49152], [50000, 65536]] };
const requested = { id, pieces: 3, verified: 1, state: 'requested', ttlMs: 5750 };
const unavailable = { code: 'scene-fetch-unavailable' };
const changed = { code: 'scene-changed' };

// Synthetic loopback-only fixtures. The second leaf chains to the first, so
// trusting the paired certificate merely as a CA would accept the wrong leaf.
const pairedTls = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBpzCCAU2gAwIBAgICEAEwCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwaQ2luZW1h
IFBhaXJlZCBUZXN0IEZpeHR1cmUwIBcNMjAwMTAxMDAwMDAwWhgPMjA5OTAxMDEw
MDAwMDBaMCUxIzAhBgNVBAMMGkNpbmVtYSBQYWlyZWQgVGVzdCBGaXh0dXJlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVvOSyyY1aWfk7Za0C+tZ/SK88v8OwL8u
N9PL9VbpbCjyLo5DWGPxvygzh1dR97UK2WDx+v0rRZxJCFBS098hoaNrMGkwEgYD
VR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAoQwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwDwYDVR0RBAgwBocEfwAAATAdBgNVHQ4EFgQUfkwVlTqdMiINqCxoM57g
b5AOnr4wCgYIKoZIzj0EAwIDSAAwRQIgZN5NV8HImxW7RbgoWh9rerMwQDIUXVw1
R9kjj0AA8RYCIQC3S+2zYHsXhy3cIgHAQKu28JM7MbhjGAwSKI7GAgVu/g==
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsMAcbE/aZPUuTYYK
Q/4K2VxyBfT4gMBYk7pZ4jYzuyGhRANCAARW85LLJjVpZ+TtlrQL61n9Irzy/w7A
vy4308v1VulsKPIujkNYY/G/KDOHV1H3tQrZYPH6/StFnEkIUFLT3yGh
-----END PRIVATE KEY-----`
};
const wrongTls = {
  cert: `-----BEGIN CERTIFICATE-----
MIIByTCCAW6gAwIBAgICEAIwCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwaQ2luZW1h
IFBhaXJlZCBUZXN0IEZpeHR1cmUwIBcNMjAwMTAxMDAwMDAwWhgPMjA5OTAxMDEw
MDAwMDBaMCkxJzAlBgNVBAMMHkNpbmVtYSBXcm9uZyBMZWFmIFRlc3QgRml4dHVy
ZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNTXNmCJZWYUFNKojX6y2Npty1K6
+lrOgewnVi1vzUB88CKRAZTaNHSsp8CkXnKoSl9iBCVa8K6uhuKOR8HGGJajgYcw
gYQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwDwYDVR0RBAgwBocEfwAAATAdBgNVHQ4EFgQUbkwoRQz2XFXW/OUtcUfr
vjVorUkwHwYDVR0jBBgwFoAUfkwVlTqdMiINqCxoM57gb5AOnr4wCgYIKoZIzj0E
AwIDSQAwRgIhAJMcFu+cDSL//KF+J1VXC+5yfFDPyUvK32fmCkpYQeOuAiEA6iUE
pNg9LLYYUMDRTQ0FEAVBANhN9vu/N/ILVaRhJt8=
-----END CERTIFICATE-----`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgq2D+SWTmoYCCzAQj
mekPesz8xRjYl0AimGH4oB+SNJehRANCAATU1zZgiWVmFBTSqI1+stjabctSuvpa
zoHsJ1Ytb81AfPAikQGU2jR0rKfApF5yqEpfYgQlWvCurobijkfBxhiW
-----END PRIVATE KEY-----`
};
const wrongIpCertificate = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgICEAMwCgYIKoZIzj0EAwIwFDESMBAGA1UEAwwJMTI3LjAu
MC4xMCAXDTIwMDEwMTAwMDAwMFoYDzIwOTkwMTAxMDAwMDAwWjAUMRIwEAYDVQQD
DAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARW85LLJjVpZ+Tt
lrQL61n9Irzy/w7Avy4308v1VulsKPIujkNYY/G/KDOHV1H3tQrZYPH6/StFnEkI
UFLT3yGho2swaTASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIChDAT
BgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREECDAGhwR/AAACMB0GA1UdDgQWBBR+
TBWVOp0yIg2oLGgznuBvkA6evjAKBggqhkjOPQQDAgNIADBFAiEA9I0V0Jkq0uRj
wwlkN9Qkg8QtzzvwUW5wFIJOt2KY5OICIFswCL9MonMLOWNHv9jE2zPIvcbHeksc
QVSIBjFz6WFz
-----END CERTIFICATE-----`;
const expiredCertificate = `-----BEGIN CERTIFICATE-----
MIIBpjCCAU2gAwIBAgICEAQwCgYIKoZIzj0EAwIwJjEkMCIGA1UEAwwbQ2luZW1h
IEV4cGlyZWQgVGVzdCBGaXh0dXJlMB4XDTIwMDEwMTAwMDAwMFoXDTIxMDEwMTAw
MDAwMFowJjEkMCIGA1UEAwwbQ2luZW1hIEV4cGlyZWQgVGVzdCBGaXh0dXJlMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVvOSyyY1aWfk7Za0C+tZ/SK88v8OwL8u
N9PL9VbpbCjyLo5DWGPxvygzh1dR97UK2WDx+v0rRZxJCFBS098hoaNrMGkwEgYD
VR0TAQH/BAgwBgEB/wIBADAOBgNVHQ8BAf8EBAMCAoQwEwYDVR0lBAwwCgYIKwYB
BQUHAwEwDwYDVR0RBAgwBocEfwAAATAdBgNVHQ4EFgQUfkwVlTqdMiINqCxoM57g
b5AOnr4wCgYIKoZIzj0EAwIDRwAwRAIgRz6vpEWtCdfwny1fvetFuQQl1EczIHAj
J70F3GryMBMCIE/jd4YBn84pL58YU5sxVV7Arh9UI0/1DM2gLSbiZ1u/
-----END CERTIFICATE-----`;

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function mock(t, { tls = pairedTls, port = 0, closeAfterReply = false } = {}) {
  const requests = [], resumed = [];
  let scene = (_req, res) => sendJson(res, { version: 1, available: true });
  const handleRequest = (req, res) => {
    req.setEncoding('utf8');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      const entry = { pathname, method: req.method, headers: req.headers, fields: Object.fromEntries(new URLSearchParams(body)) };
      requests.push(entry);
      if (closeAfterReply) res.setHeader('Connection', 'close');
      if (pathname === '/api/v2/auth/login') {
        res.setHeader('Set-Cookie', 'SID=mock-session; Path=/; HttpOnly');
        res.end('Ok.');
      } else if (pathname === sceneEndpoint) {
        scene(entry, res);
      } else {
        sendJson(res, []);
      }
    });
  };
  const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
  server.on('secureConnection', socket => { resumed.push(socket.isSessionReused()); });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  async function close() {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  t.after(close);
  return { url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, requests, resumed, close,
    handle(handler) { scene = handler; } };
}

function pairing(sceneOrigin, sceneKey = key) {
  return { sceneOrigin, sceneKey, sceneCertificate: pairedTls.cert };
}

function setup(server, options = pairing(server.url), config = { url: server.url, ...credentials }) {
  return createQbit(() => config, options);
}

test('only the exact paired loopback scene endpoint receives the key, Basic credentials and captured cookie', async t => {
  const server = await mock(t);
  const client = setup(server);
  const signal = new AbortController().signal;
  await client.qb('app/version');
  const reader = client.sceneReader(signal);
  assert.deepEqual(await reader.json('torrents/info', { hashes: hash }), []);
  assert.equal(await reader.scheduler.available(), true);
  assert.equal(server.requests.length, 4);
  const [login, ordinaryRead, sceneRead, scheduler] = server.requests;
  assert.deepEqual(login.fields, credentials);
  for (const entry of [login, ordinaryRead, sceneRead]) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers['x-cinema-scene-key'], undefined);
  }
  assert.equal(scheduler.pathname, sceneEndpoint);
  assert.equal(scheduler.method, 'POST');
  assert.deepEqual(scheduler.fields, { operation: 'capability' });
  assert.equal(scheduler.headers.origin, server.url);
  assert.equal(scheduler.headers.referer, `${server.url}/`);
  assert.equal(scheduler.headers.authorization, authorization);
  assert.equal(scheduler.headers['x-cinema-scene-key'], key);
  assert.equal(scheduler.headers.cookie, 'SID=mock-session');

  const unpaired = await mock(t, { tls: null });
  const unpairedClient = setup(unpaired, pairing(server.url));
  await unpairedClient.qb('app/version');
  assert.equal(unpairedClient.sceneReader(signal).scheduler, null);
  assert.deepEqual(await unpairedClient.sceneReader(signal).json('torrents/info'), []);
  assert.equal(unpaired.requests.length, 3);
  assert.ok(unpaired.requests.every(entry => !entry.headers.authorization && !entry.headers['x-cinema-scene-key']));

  const port = new URL(server.url).port;
  for (const url of [`https://localhost:${port}`, `http://127.0.0.1:${port}`, `${server.url}/`]) {
    const invalid = setup(server, pairing(url), { url, ...credentials });
    assert.equal(invalid.sceneReader(signal).scheduler, null);
  }
  assert.equal(setup(server, pairing(server.url, 'invalid')).sceneReader(signal).scheduler, null);
  assert.equal(setup(server, { ...pairing(server.url), sceneCertificate: 'invalid' }).sceneReader(signal).scheduler, null);
  assert.equal(setup(server, { sceneOrigin: server.url, sceneKey: key }).sceneReader(signal).scheduler, null);
  assert.equal(setup(server, pairing(server.url),
    { url: `${server.url}/`, ...credentials }).sceneReader(signal).scheduler, null);
  assert.equal(server.requests.length, 4);
});

test('paired scene redirects and unauthorized replies never replay, relogin or replace the ordinary cookie', async t => {
  const server = await mock(t), sink = await mock(t);
  const client = setup(server);
  await client.login();
  const { scheduler } = client.sceneReader(new AbortController().signal);
  server.handle((_req, res) => {
    res.writeHead(307, { Location: sink.url + sceneEndpoint });
    res.end();
  });
  assert.equal(await scheduler.available(), false);
  await assert.rejects(scheduler.request(input), unavailable);
  assert.equal(sink.requests.length, 0);

  for (const status of [401, 403]) {
    server.handle((_req, res) => {
      res.setHeader('Set-Cookie', 'SID=poisoned; Path=/');
      sendJson(res, {}, status);
    });
    await assert.rejects(scheduler.request(input), unavailable);
  }
  assert.deepEqual(server.requests.map(entry => entry.pathname), ['/api/v2/auth/login', ...Array(4).fill(sceneEndpoint)]);
  await client.qb('app/version');
  assert.equal(server.requests.at(-1).headers.cookie, 'SID=mock-session');
});

test('paired scene lease rejects malformed, oversized and mismatched replies', async t => {
  const server = await mock(t);
  const client = setup(server);
  await client.login();
  const { scheduler } = client.sceneReader(new AbortController().signal);
  server.handle((_req, res) => sendJson(res, requested));
  assert.deepEqual(await scheduler.request(input), requested);
  assert.deepEqual(server.requests.at(-1).fields, {
    operation: 'request', hash, file: '3', size: '65536', reserve: '0:32768', ranges: '32768:49152,50000:65536'
  });
  const complete = { ...requested, verified: 3, state: 'complete', ttlMs: 0 };
  server.handle((_req, res) => sendJson(res, complete));
  assert.deepEqual(await scheduler.status(hash, id), complete);
  assert.deepEqual(server.requests.at(-1).fields, { operation: 'status', hash, id });

  for (const change of [
    { id: 'bad-id' }, { pieces: 17 }, { pieces: 0 }, { verified: -1 }, { verified: 4 },
    { verified: 1.5 }, { ttlMs: 6001 }, { ttlMs: -1 }, { state: 'complete' }, { detail: 'x'.repeat(1025) }
  ]) {
    server.handle((_req, res) => sendJson(res, { ...requested, ...change }));
    await assert.rejects(scheduler.request(input), unavailable);
  }
  server.handle((_req, res) => sendJson(res, { ...requested, id: 'e' + id.slice(1) }));
  await assert.rejects(scheduler.status(hash, id), unavailable);
  for (const status of [404, 409]) {
    server.handle((_req, res) => sendJson(res, {}, status));
    assert.equal(await scheduler.request(input), null);
    assert.equal(await scheduler.status(hash, id), null);
  }
});

test('an already issued lease can be cancelled after abort, but a reset owner cannot send stale cancellation', { timeout: 5000 }, async t => {
  const server = await mock(t);
  const client = setup(server);
  await client.login();
  const control = new AbortController(), reason = Error('synthetic scene owner cancellation');
  const { scheduler } = client.sceneReader(control.signal);
  let received;
  const arrival = new Promise(resolve => { received = resolve; });
  server.handle((entry, res) => {
    if (entry.fields.operation === 'request') received(() => sendJson(res, requested));
    else sendJson(res, { state: 'cancelled' });
  });
  const request = scheduler.request(input);
  const reply = await arrival;
  control.abort(reason);
  reply();
  assert.deepEqual(await request, requested);
  await assert.rejects(scheduler.status(hash, id), error => error === reason);
  await scheduler.cancel(hash, id);
  const cancel = server.requests.at(-1);
  assert.deepEqual(cancel.fields, { operation: 'cancel', hash, id });
  assert.equal(cancel.headers.cookie, 'SID=mock-session');
  assert.equal(cancel.headers['x-cinema-scene-key'], key);

  client.reset();
  await client.login();
  await assert.rejects(scheduler.cancel(hash, id), changed);
  assert.equal(server.requests.filter(entry => entry.fields.operation === 'cancel').length, 1);
});

test('a different TLS leaf on the same loopback port receives no HTTP request or credentials', { timeout: 5000 }, async t => {
  const server = await mock(t);
  const client = setup(server);
  await client.login();
  const reader = client.sceneReader(new AbortController().signal);
  assert.equal(await reader.scheduler.available(), true);
  const port = Number(new URL(server.url).port);
  await server.close();
  const impostor = await mock(t, { tls: wrongTls, port });
  assert.equal(impostor.url, server.url);

  const chainOnly = tlsConnect({ host: '127.0.0.1', port, ca: pairedTls.cert, rejectUnauthorized: true });
  try {
    await once(chainOnly, 'secureConnect');
    assert.equal(chainOnly.authorized, true);
  } finally {
    chainOnly.destroy();
  }

  assert.equal(await reader.scheduler.available(), false);
  const ambientTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // Tests within this file run sequentially in their own Node test process.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    assert.equal(await reader.scheduler.available(), false);
    await assert.rejects(reader.scheduler.request(input), unavailable);
    await assert.rejects(reader.scheduler.cancel(hash, id), unavailable);
    await assert.rejects(reader.json('torrents/info'));
    await assert.rejects(client.qb('app/version'));
    client.reset();
    await assert.rejects(client.login());
  } finally {
    if (ambientTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = ambientTls;
  }
  assert.deepEqual(impostor.requests, []);
});

test('a certificate with a different IP SAN fails pairing even when its common name matches', async t => {
  const server = await mock(t, { tls: { ...pairedTls, cert: wrongIpCertificate } });
  const client = setup(server, { ...pairing(server.url), sceneCertificate: wrongIpCertificate });
  assert.equal(client.acceptsSceneOrigin(server.url), false);
  assert.equal(client.sceneReader(new AbortController().signal).scheduler, null);
  await assert.rejects(client.login(), { status: 503 });
  assert.deepEqual(server.requests, []);
});

test('an expired pinned certificate fails before any HTTP credentials are transmitted', async t => {
  const server = await mock(t, { tls: { ...pairedTls, cert: expiredCertificate } });
  const client = setup(server, { ...pairing(server.url), sceneCertificate: expiredCertificate });
  assert.equal(client.acceptsSceneOrigin(server.url), true);
  await assert.rejects(client.login(), { status: 503 });
  assert.deepEqual(server.requests, []);
});

test('paired TLS reconnects use full handshakes with session resumption disabled', async t => {
  const server = await mock(t, { tls: { ...pairedTls, maxVersion: 'TLSv1.2' }, closeAfterReply: true });
  const control = new https.Agent({ ca: pairedTls.cert, maxCachedSessions: 2 });
  t.after(() => control.destroy());
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve, reject) => {
      https.get(server.url, { agent: control }, response => {
        response.resume();
        response.once('end', resolve);
      }).once('error', reject);
    });
  }
  assert.deepEqual(server.resumed, [false, true], 'The fixture supports resumption across closed sockets');

  const client = setup(server);
  await client.login();
  const reader = client.sceneReader(new AbortController().signal);
  assert.equal(await reader.scheduler.available(), true);
  await reader.json('torrents/info');
  assert.deepEqual(server.resumed.slice(2), [false, false, false]);
});

test('a stalled cancellation closes its connection after the bounded timeout without replay', { timeout: 4000 }, async t => {
  const server = await mock(t);
  const client = setup(server);
  await client.login();
  const { scheduler } = client.sceneReader(new AbortController().signal);
  server.handle((_entry, res) => sendJson(res, requested));
  assert.deepEqual(await scheduler.request(input), requested);
  let connectionClosed;
  const closed = new Promise(resolve => { connectionClosed = resolve; });
  server.handle((_entry, res) => { res.once('close', connectionClosed); });
  const started = performance.now();
  await assert.rejects(scheduler.cancel(hash, id), unavailable);
  assert.ok(performance.now() - started >= 500, 'The unanswered cancellation reached its timeout');
  await closed;
  assert.deepEqual(server.requests.filter(entry => entry.fields.operation === 'cancel').map(entry => entry.fields), [
    { operation: 'cancel', hash, id }
  ]);
});

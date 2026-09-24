// The LAN fallback hands a TV's session to whatever answers at a cached private
// address, so the parts worth pinning are the ones that keep that safe: the
// proof is the exact HMAC every client computes, it is only given to a direct
// LAN request, and a pair id only ever returns a token that still works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proofFor, lanAddrs, isDirectLan, loadIdentity, registerLan } from '../src/lan.js';

// A stand-in for the Fastify app: just enough to register routes and call them.
// CI runs `npm test` without installing dependencies, so the tests can't
// import fastify itself.
function fakeApp() {
  const routes = {};
  const app = {
    get: (p, h) => { routes['GET ' + p] = h; },
    post: (p, h) => { routes['POST ' + p] = h; },
    async inject({ method, url, payload, headers = {}, remoteAddress = '127.0.0.1' }) {
      const [p, qs] = url.split('?');
      const req = { method, url, headers, body: payload, query: Object.fromEntries(new URLSearchParams(qs || '')), socket: { remoteAddress } };
      const res = { statusCode: 200, headers: {}, body: undefined };
      const reply = {
        header(k, v) { res.headers[k.toLowerCase()] = v; return reply; },
        code(c) { res.statusCode = c; return reply; },
        send(b) { res.body = b; return reply; }
      };
      const out = await routes[method + ' ' + p](req, reply);
      const body = out === reply ? res.body : out;
      return { statusCode: res.statusCode, headers: res.headers, json: () => body };
    }
  };
  return app;
}

// The clients (Swift, Kotlin, BrightScript, the webOS shell) all implement this
// by hand. A fixed vector is the only way to know they agree with the server.
test('proof is HMAC-SHA256 over "marquee-lan:" + nonce, keyed by the key string itself', () => {
  const key = 'a'.repeat(64);
  const want = crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update('marquee-lan:abc12345').digest('hex');
  assert.equal(proofFor(key, 'abc12345'), want);
  // The vector in docs/LAN.md. Check a client against this.
  assert.equal(proofFor('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'TestNonce123'),
    '5228742fab314bfeacb3b8bd5a092dcec8f8f036ccffa9395841782884d9b9e3');
});

test('lanAddrs keeps the house network and drops tunnels and virtual switches', () => {
  const ifaces = {
    Ethernet: [{ family: 'IPv4', address: '192.168.1.103', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    wgpia0: [{ family: 'IPv4', address: '10.13.128.7', internal: false }],
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [{ family: 'IPv4', address: '169.254.3.4', internal: false }]
  };
  assert.deepEqual(lanAddrs(undefined, ifaces), ['192.168.1.103']);
  assert.deepEqual(lanAddrs(['10.0.0.5'], ifaces), ['10.0.0.5']);
});

test('a request that came through Caddy is never "direct", whatever its peer', () => {
  const sock = (a) => ({ socket: { remoteAddress: a } });
  assert.equal(isDirectLan({ ...sock('192.168.1.170'), headers: {} }), true);
  assert.equal(isDirectLan({ ...sock('::ffff:192.168.1.170'), headers: {} }), true);
  assert.equal(isDirectLan({ ...sock('127.0.0.1'), headers: {} }), true);
  assert.equal(isDirectLan({ ...sock('127.0.0.1'), headers: { 'x-forwarded-for': '8.8.8.8' } }), false);
  assert.equal(isDirectLan({ ...sock('192.168.1.170'), headers: { via: '1.1 Caddy' } }), false);
  assert.equal(isDirectLan({ ...sock('71.195.112.219'), headers: {} }), false);
});

async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-'));
  const file = path.join(dir, 'lan.json');
  const tokens = new Set(['good-token']);
  const app = fakeApp();
  const tok = (req) => {
    const a = req.headers.authorization || '';
    return a.startsWith('Bearer ') ? a.slice(7) : null;
  };
  registerLan(app, {
    file, port: 8096, lanOverride: ['192.168.1.103'],
    currentUser: (req) => (tokens.has(tok(req)) ? { id: 1 } : null),
    tokenOf: tok,
    tokenValid: (t) => tokens.has(t),
    internet: () => false
  });
  return { app, file, tokens };
}

test('GET /api/lan: public fields, proof only with a nonce, key only with a session', async () => {
  const { app, file } = await harness();
  const ident = loadIdentity(file);

  const plain = await app.inject({ method: 'GET', url: '/api/lan', remoteAddress: '192.168.1.170' });
  const p = plain.json();
  assert.equal(p.app, 'marquee');
  assert.equal(p.id, ident.id);
  assert.deepEqual(p.lan, ['http://192.168.1.103:8096']);
  assert.equal(p.internet, false);
  assert.equal(p.key, undefined);
  assert.equal(p.proof, undefined);
  assert.equal(plain.headers['access-control-allow-origin'], '*');

  const withNonce = (await app.inject({ method: 'GET', url: '/api/lan?nonce=abcdefgh12345678', remoteAddress: '192.168.1.170' })).json();
  assert.equal(withNonce.proof, proofFor(ident.key, 'abcdefgh12345678'));

  const viaCaddy = (await app.inject({ method: 'GET', url: '/api/lan?nonce=abcdefgh12345678', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '8.8.8.8' } })).json();
  assert.equal(viaCaddy.proof, undefined, 'a proof must never go out through the proxy');

  const authed = (await app.inject({ method: 'GET', url: '/api/lan', headers: { authorization: 'Bearer good-token' } })).json();
  assert.equal(authed.key, ident.key);
});

test('a pair id trades for the session only after the signed-in app registers it', async () => {
  const { app, tokens } = await harness();
  const pair = 'p'.repeat(40);

  assert.equal((await app.inject({ method: 'GET', url: `/api/lan?pair=${pair}` })).json().token, undefined);
  assert.equal((await app.inject({ method: 'POST', url: '/api/lan/pair', payload: { pair } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/lan/pair', payload: { pair: 'short' }, headers: { authorization: 'Bearer good-token' } })).statusCode, 400);

  const reg = await app.inject({ method: 'POST', url: '/api/lan/pair', payload: { pair }, headers: { authorization: 'Bearer good-token' } });
  assert.equal(reg.statusCode, 200);
  const got = (await app.inject({ method: 'GET', url: `/api/lan?pair=${pair}` })).json();
  assert.equal(got.token, 'good-token');
  assert.ok(got.key);

  // Signing out everywhere (password change) drops the token; the pair dies with it.
  tokens.delete('good-token');
  assert.equal((await app.inject({ method: 'GET', url: `/api/lan?pair=${pair}` })).json().token, undefined);
});

test('the identity survives a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lan-')), 'lan.json');
  const a = loadIdentity(file);
  const b = loadIdentity(file);
  assert.equal(a.id, b.id);
  assert.equal(a.key, b.key);
  assert.match(a.key, /^[0-9a-f]{64}$/);
});

// Finding the server on the home network — the server half of docs/LAN.md.
//
// The TV apps only knew the public name. Inside the house that name should
// resolve to the Dell, but when it doesn't (a device with its own DNS, a router
// without the record) and the internet is down, a TV cannot reach a server that
// is sitting on its own LAN. So GET /api/lan tells every client the server's LAN
// address while it is online, and lets it check, later and offline, that the
// thing answering at that address really is this server.
//
// The check matters because a cached "http://192.168.1.103:8096" means nothing
// on somebody else's network, where that address can be anything. A client never
// sends its session to a LAN address until the server there proves it holds the
// LAN key (an HMAC over a nonce the client picked), and the proof is only ever
// given to a direct LAN request, never through Caddy, so it cannot be relayed
// in from the internet.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PAIR_RE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_PAIRS = 100;

// Adapters that are not the house network: PIA's WireGuard tunnel (wgpia0),
// other VPNs, and Hyper-V/WSL/VirtualBox virtual switches.
const VIRTUAL_IF = /wg|pia|vpn|tun|tap|wireguard|nordlynx|zerotier|tailscale|vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|bluetooth/i;

export function isLanIPv4(a) {
  return /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

/** The server's LAN IPv4 addresses, best first. `override` (config.lanAddrs) wins. */
export function lanAddrs(override, ifaces = os.networkInterfaces()) {
  if (Array.isArray(override) && override.length) return override.map(String);
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    if (VIRTUAL_IF.test(name)) continue;
    for (const a of list || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4' || a.internal) continue;
      // 10.x is skipped on purpose: it is what the PIA tunnel hands out, and
      // this house is 192.168.1.x. A LAN that really is 10.x sets lanAddrs.
      if (isLanIPv4(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)].sort((x, y) => (y.startsWith('192.168.') - x.startsWith('192.168.')));
}

/** HMAC-SHA256(key, "marquee-lan:" + nonce) as lowercase hex. The key string's UTF-8 bytes ARE the key. */
export function proofFor(key, nonce) {
  return crypto.createHmac('sha256', Buffer.from(String(key), 'utf8')).update('marquee-lan:' + nonce, 'utf8').digest('hex');
}

const hashPair = (p) => crypto.createHash('sha256').update(String(p)).digest('hex');

/** Load (or create on first run) data/lan.json: the server id, the LAN key, and pair ids. */
export function loadIdentity(file) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { /* first run */ }
  if (!d || typeof d.id !== 'string' || typeof d.key !== 'string') {
    d = { id: crypto.randomBytes(12).toString('hex'), key: crypto.randomBytes(32).toString('hex'), pairs: {} };
    saveIdentity(file, d);
  }
  if (!d.pairs || typeof d.pairs !== 'object') d.pairs = {};
  return d;
}

function saveIdentity(file, d) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Did this request come straight from a device on the LAN, rather than in
 * through Caddy? Caddy connects from loopback and always adds forwarding
 * headers; a TV hitting :8096 directly does neither. Loopback without those
 * headers is someone on the Dell itself, which is also fine.
 */
export function isDirectLan(req) {
  const h = req.headers || {};
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-proto'] || h['forwarded'] || h['via']) return false;
  const a = String((req.socket && req.socket.remoteAddress) || req.raw?.socket?.remoteAddress || '').replace(/^::ffff:/, '').toLowerCase();
  if (a === '127.0.0.1' || a === '::1') return true;
  return isLanIPv4(a) || /^10\./.test(a) || /^(fe80:|fc|fd)/.test(a);
}

/**
 * GET /api/lan and POST /api/lan/pair. `currentUser(req)` resolves a session
 * (or null); `tokenValid(token)` says whether a stored token still works.
 */
export function registerLan(app, { file, port, lanOverride, currentUser, tokenOf, tokenValid, internet }) {
  const ident = loadIdentity(file);

  app.get('/api/lan', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'no-store');
    const out = {
      app: 'marquee',
      id: ident.id,
      port,
      lan: lanAddrs(lanOverride).map((a) => `http://${a}:${port}`),
      internet: internet()
    };
    const nonce = String(req.query.nonce || '');
    if (NONCE_RE.test(nonce) && isDirectLan(req)) out.proof = proofFor(ident.key, nonce);

    if (currentUser(req)) out.key = ident.key;

    const pair = String(req.query.pair || '');
    if (PAIR_RE.test(pair)) {
      const tok = ident.pairs[hashPair(pair)]?.token;
      if (tok && tokenValid(tok)) { out.key = ident.key; out.token = tok; }
    }
    return out;
  });

  // A web-view shell (Android TV, webOS) cannot read the HttpOnly session
  // cookie, so it has no token to carry to another origin. It invents a pair id,
  // puts it on the web app's URL, and the signed-in web app registers it here;
  // from then on the shell can trade the pair id for the session at /api/lan.
  app.post('/api/lan/pair', async (req, reply) => {
    const pair = String((req.body && req.body.pair) || '');
    if (!PAIR_RE.test(pair)) return reply.code(400).send({ error: 'bad pair id' });
    const tok = tokenOf(req);
    if (!tok) return reply.code(401).send({ error: 'sign in first' });
    const h = hashPair(pair);
    if (ident.pairs[h]?.token !== tok) {
      ident.pairs[h] = { token: tok, at: Date.now() };
      const keys = Object.keys(ident.pairs);
      if (keys.length > MAX_PAIRS) {
        keys.sort((a, b) => ident.pairs[a].at - ident.pairs[b].at);
        for (const k of keys.slice(0, keys.length - MAX_PAIRS)) delete ident.pairs[k];
      }
      saveIdentity(file, ident);
    }
    return { ok: true };
  });

  return ident;
}

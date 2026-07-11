import crypto from 'node:crypto';

// Password hashing with scrypt (Node stdlib — no native deps, in keeping with
// the project's "stdlib only" rule). Stored as `scrypt$<saltHex>$<hashHex>`.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// A long, random, opaque session token. Persisted so a device stays logged in.
export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Pull the auth token off a request. fetch() calls send it as a Bearer header;
// media elements (<video>/<img>) can't set headers, so those rely on the
// cookie (or a ?token= query). We accept all three.
const COOKIE = 'mstoken';
export function tokenFromReq(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const cookie = req.headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      if (k === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }

  const q = (req.url || '').split('?')[1];
  if (q) {
    const t = new URLSearchParams(q).get('token');
    if (t) return t;
  }
  return null;
}

// Build a Set-Cookie value for the session token (HttpOnly so page JS can't
// leak it; SameSite=Lax; 1-year life so "log in once" sticks). `secure` is set
// once we're behind HTTPS; `clear` expires it on logout.
export function cookieHeader(token, { secure = false, clear = false } = {}) {
  const attrs = [
    `${COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    clear ? 'Max-Age=0' : 'Max-Age=31536000'
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

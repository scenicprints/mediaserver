// Roku simulator harness: serves brs-engine + the Roku shell (pointed back at
// this origin) and proxies the Marquee API/art/app-zip routes to the dev server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIM_PORT) || 8099, UP = process.env.MQ_SERVER || 'http://127.0.0.1:8096';
const TOOLS = path.join(HERE, 'node_modules');
const SHELL = path.resolve(HERE, '../../shell');
const iso = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
function walk(d, b = d, o = []) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p, b, o) : o.push([path.relative(b, p).split(path.sep).join('/'), p]); } return o; }
function zip(entries) { const L = [], C = []; let off = 0; for (const [name, data] of entries) { const crc = zlib.crc32(data), body = zlib.deflateRawSync(data), nb = Buffer.from(name); const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26); L.push(lh, nb, body); const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42); C.push(ch, nb); off += 30 + nb.length + body.length; } const cd = Buffer.concat(C), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16); return Buffer.concat([...L, cd, e]); }
const STATIC = { '/lib/brs.api.js': TOOLS + '/brs-engine/lib/brs.api.js', '/lib/brs.worker.js': TOOLS + '/brs-engine/lib/brs.worker.js', '/lib/brs-sg.js': TOOLS + '/brs-scenegraph/lib/brs-sg.js', '/assets/common.zip': (fs.existsSync(TOOLS + '/brs-scenegraph/assets/common.zip') ? TOOLS + '/brs-scenegraph/assets/common.zip' : TOOLS + '/brs-engine/assets/common.zip'), '/': path.join(HERE, 'sim.html') };
http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (STATIC[u]) { const f = STATIC[u]; res.writeHead(200, { ...iso, 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); fs.createReadStream(f).pipe(res); return; }
  if (u === '/save' && req.method === 'POST') {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      const name = (new URL(req.url, 'http://x').searchParams.get('n') || 'shot').replace(/[^a-z0-9_-]/gi, '');
      const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, '');
      fs.mkdirSync(path.join(HERE, 'out'), { recursive: true }); fs.writeFileSync(path.join(HERE, 'out', name + '.png'), Buffer.from(b64, 'base64'));
      res.writeHead(200, iso); res.end('ok');
    }); return;
  }
  if (u === '/shell.zip') {
    const origin = 'http://' + req.headers.host;
    const entries = walk(SHELL).map(([n, p]) => [n, n === 'manifest' ? Buffer.from(fs.readFileSync(p, 'utf8').replace(/^marquee_server=.*$/m, 'marquee_server=' + origin)) : fs.readFileSync(p)]);
    // SIM ONLY: the simulator resolves pkg:/ inside a component library to the host
    // app, and can't start a library's Task. A real Roku resolves to the library
    // (Playlet ships its lib images that way), so mirror the lib's assets + Http here.
    const LIB = path.resolve(HERE, '../../lib');
    const have = new Set(entries.map((e) => e[0]));
    for (const [n, p] of walk(LIB)) {
      if ((n.startsWith('fonts/') || n.startsWith('images/') || n.startsWith('components/Http.')) && !have.has(n)) entries.push([n, fs.readFileSync(p)]);
    }
    res.writeHead(200, { ...iso, 'Content-Type': 'application/zip' }); res.end(zip(entries)); return;
  }
  const p = http.request(UP + req.url, { method: req.method, headers: { ...req.headers, host: new URL(UP).host } }, (r) => {
    const h = { ...r.headers, ...iso }; delete h['cache-control'];
    let body = [];
    r.on('data', (c) => body.push(c)); r.on('end', () => {
      let b = Buffer.concat(body);
      // Art URLs come back absolute to the upstream; point them at this origin.
      if (String(r.headers['content-type'] || '').includes('json')) { b = Buffer.from(b.toString('utf8').split(UP).join('http://' + req.headers.host)); h['content-length'] = b.length; }
      res.writeHead(r.statusCode, h); res.end(b);
    });
  });
  p.on('error', (e) => { res.writeHead(502, iso); res.end(String(e)); });
  req.pipe(p);
}).listen(PORT, () => console.log('sim on', PORT));

// Dev-only helper for visual tuning: receives data-URL images POSTed by the page's
// window.__jnsn.capture(name) (dev builds only) and writes them to wip/captures/ (or $CAPTURE_DIR).
// Run from the project root:  node tools/capture-server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.CAPTURE_DIR || path.join(process.cwd(), 'wip', 'captures');
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'POST' || url.pathname !== '/save') { res.writeHead(404); return res.end(); }
  const name = (url.searchParams.get('name') || 'capture').replace(/[^a-z0-9_-]/gi, '_');
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = body.match(/^data:image\/(png|jpeg);base64,(.+)$/s);
    if (!m) { res.writeHead(400); return res.end('bad data url'); }
    const file = path.join(OUT, `${name}.${m[1] === 'png' ? 'png' : 'jpg'}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(file);
  });
}).listen(5199, () => console.log('capture server on http://localhost:5199 ->', OUT));

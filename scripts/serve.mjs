// Serves docs/ under /crm-agent-harness-demo/, the same sub-path GitHub Pages uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const BASE = '/crm-agent-harness-demo/';
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith(BASE)) { res.writeHead(302, { location: BASE }).end(); return; }
  let rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^[\\/]+/, '');
  if (!rel || rel === '.' || /[\\/]$/.test(rel)) rel = join(rel, 'index.html');
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(join('docs', rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}${BASE}`));

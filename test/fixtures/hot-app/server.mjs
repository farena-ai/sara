// Phase 89 (CU3) fixture: a tiny dev server of its own (no dependencies), standing in for a Vite
// dev server in tests and in the live check. It serves this folder, watches it, and tells every
// open page to reload over a WebSocket at /__hot when a file changes (hot reload). Its app has a
// seeded bug: app.js reads cart.totl (a typo), so the page logs a TypeError and shows no total.
//   node server.mjs [--port 5173]     prints "Local: http://127.0.0.1:<port>/" once it listens
import { createHash } from 'node:crypto';
import { readFile, watch } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : 5173;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const clients = new Set();

// One text frame from the server (not masked, as the protocol says for servers).
function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/api/cart') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ items: [{ name: 'Tea', price: 3.5 }, { name: 'Cake', price: 4.25 }], total: 7.75 }));
  }
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || file.endsWith('server.mjs')) {
    res.writeHead(404);
    return res.end('Not found');
  }
  readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url ?? '').split('?')[0] !== '/__hot' || typeof key !== 'string') return socket.destroy();
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.write(frame('connected'));
  socket.on('data', (d) => {
    // A close frame from the page: answer and go.
    if ((d[0] & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0]));
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

let timer;
watch(root, { recursive: false }, (_ev, name) => {
  if (!name || name.endsWith('server.mjs')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`changed: ${name} (reloading ${clients.size} page${clients.size === 1 ? '' : 's'})`);
    for (const c of clients) c.write(frame(`reload ${name}`));
  }, 80);
});

server.listen(port, '127.0.0.1', () => console.log(`hot-app dev server ready\n  Local: http://127.0.0.1:${server.address().port}/`));

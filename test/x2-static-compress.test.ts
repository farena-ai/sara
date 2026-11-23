// X2: the web app's text files are sent compressed, each compressed once per version of the file.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { compressedFile, encodedEtag, etagMatches, pickEncoding } from '../src/static-compress.ts';
import { staticModules, versionPage, webBuildId } from '../src/static-version.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

/** node:http, so nothing unpacks the body for us (fetch would). */
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-22T12:00:00Z') });
  const server = createSaraServer({ app, auth: new OwnerAuth(dir), webDir: join(ROOT, 'web') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  return (server.address() as AddressInfo).port;
}

test('X2 compress: which encoding a browser gets', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(pickEncoding('identity'), undefined);
  assert.equal(pickEncoding(undefined), undefined);
  assert.equal(encodedEtag('"abc-1"', 'br'), '"abc-1-br"');
  assert.equal(etagMatches('"abc-1-gzip"', '"abc-1"'), true);
  assert.equal(etagMatches('W/"abc-1-br", "zzz"', '"abc-1"'), true);
  assert.equal(etagMatches('"abc-2-br"', '"abc-1"'), false);
});

test('X2 compress: app.js and the style sheet arrive compressed and unpack to the file on disk', async (t) => {
  const port = await rig(t);
  for (const [path, file] of [['/app.js', 'app.js'], ['/style.css', 'style.css'], ['/', 'index.html']] as const) {
    const disk = readFileSync(join(ROOT, 'web', file));
    const webId = webBuildId(join(ROOT, 'web'), [join(ROOT, 'src', 'identity.ts')]);
    // Z4: the page goes out with its scripts and stylesheets pointed at /v/<id>/ (src/static-version.ts).
    const raw = path === '/' ? Buffer.from(versionPage(disk.toString('utf8'), webId, (entry) => staticModules(join(ROOT, 'web'), entry, webId, ['identity.js']))) : disk;
    const br = await get(port, path, { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(br.status, 200);
    assert.equal(br.headers['content-encoding'], 'br', path);
    assert.equal(br.headers.vary, 'accept-encoding');
    assert.equal(Number(br.headers['content-length']), br.body.length);
    assert.ok(brotliDecompressSync(br.body).equals(raw), `${path} unpacks to the file`);
    assert.ok(br.body.length < raw.length / 3, `${path}: ${raw.length} -> ${br.body.length} bytes`);
    const gz = await get(port, path, { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.ok(gunzipSync(gz.body).equals(raw));
    assert.notEqual(gz.headers.etag, br.headers.etag, 'each encoding has its own ETag');
    const plain = await get(port, path);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(plain.body.equals(raw), 'a client that asks for nothing gets the file as it is');
    // Unchanged on the next load: a 304 whichever copy the browser holds.
    for (const tag of [br.headers.etag, gz.headers.etag, plain.headers.etag]) {
      const again = await get(port, path, { 'accept-encoding': 'br', 'if-none-match': String(tag) });
      assert.equal(again.status, 304, `${path} with ${tag}`);
      assert.equal(again.body.length, 0);
    }
    const head = await get(port, path, { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-encoding'], 'br');
  }
});

test('X2 compress: pictures are left alone, and a file is compressed once per version', async (t) => {
  const port = await rig(t);
  const pic = await get(port, '/sara-portrait.jpg', { 'accept-encoding': 'br, gzip' });
  assert.equal(pic.status, 200);
  assert.equal(pic.headers['content-encoding'], undefined);
  const file = join(ROOT, 'web', 'style.css');
  const st = statSync(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  assert.equal(compressedFile(file, etag, 'br'), compressedFile(file, etag, 'br'), 'the same buffer the second time');
});

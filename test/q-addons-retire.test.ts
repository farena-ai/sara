// Q-ADDONS: a companion added and retired again within her first 20 seconds must not take Sara down.
// Her delayed start-up work (the history import's resume, the first vector pass) ran after Retire
// had closed her database and the unexpected "database is not open" stopped the whole server. This
// runs the real server on a free loopback port with a throwaway data folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => done(p)); }); });

test('retiring a just-added companion leaves Sara running after her delayed start-up work', { timeout: 90_000 }, async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'sara-retire-'));
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'src/main.ts')], { cwd: ROOT, env: { ...process.env, SARA_DATA: data, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_TESTING: '1', SARA_STORE_URL: 'http://127.0.0.1:9/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let exited: number | null | undefined;
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code) => (exited = code));
  t.after(async () => { if (exited === undefined) { child.kill(); await new Promise((r) => child.once('exit', r)); } rmSync(data, { recursive: true, force: true, maxRetries: 5 }); });
  const end = Date.now() + 40_000;
  while (!/listening on/.test(out)) { assert.ok(exited === undefined && Date.now() < end, out.slice(-2000)); await new Promise((r) => setTimeout(r, 100)); }
  const token = /owner token[^\n]*\n\s*(\S+)/.exec(out)?.[1];
  assert.ok(token, 'the first owner token');
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const made = await api('POST', '/api/companions', { name: 'Brief Visitor' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = String(made.json.id);
  assert.equal((await api('DELETE', `/api/companions/${id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 23_000)); // past her 20-second delayed start-up work
  assert.equal(exited, undefined, `Sara stopped: ${out.slice(-1500)}`);
  assert.equal((await api('GET', '/api/companions')).status, 200);
  assert.doesNotMatch(out, /stopped because of an unexpected error/);
});

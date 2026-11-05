import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBusinessProfile } from '../src/business/profile.ts';
import { createBusinessRuntime } from '../src/business/runtime.ts';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').replace(/\\\r?\n\s*/g, ' ');
const command = dockerfile.match(/HEALTHCHECK[^\n]*CMD node -e "([^"]+)"/)?.[1];
assert.ok(command, 'Extract the actual shipped Docker HEALTHCHECK Node command');

function status(url: string, headers: Record<string, string> = {}): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
}

async function health(port: number | string, profile?: string, origin?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_PORT: String(port) };
  delete env.SARA_PROFILE; delete env.SARA_BUSINESS_ORIGIN;
  if (profile !== undefined) env.SARA_PROFILE = profile;
  if (origin !== undefined) env.SARA_BUSINESS_ORIGIN = origin;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', command!], { env, timeout: 5000, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

for (const hostname of ['localhost', 'https://team.example.test']) {
  test(`shipped container health reaches only loopback with business Host ${hostname}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'sara-business-container-health-'));
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const address = probe.address(); assert.ok(address && typeof address === 'object');
    const port = address.port; await new Promise<void>(r => probe.close(() => r()));
    const origin = hostname === 'localhost' ? `http://localhost:${port}` : hostname;
    const runtime = createBusinessRuntime({ profile: openBusinessProfile(root), origin });
    try {
      await new Promise<void>(r => runtime.server.listen(port, '127.0.0.1', r));
      const url = `http://127.0.0.1:${port}/api/health`;
      assert.equal(await status(url), 403, 'loopback Host stays forbidden');
      assert.equal(await status(url, { host: new URL(origin).host }), 200);
      assert.deepEqual(await health(port, 'business', origin), { code: 0, stdout: '', stderr: '' });
      assert.equal(await status(url), 403, 'the corrected probe must not weaken runtime Host checks');
    } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('shipped container health preserves personal probes and rejects invalid profile/origin without output', async () => {
  const hosts: (string | undefined)[] = [];
  const server = createServer((request, response) => { hosts.push(request.headers.host); response.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const port = address.port;
  try {
    for (const profile of [undefined, 'personal']) assert.deepEqual(await health(port, profile, 'ignored-invalid-origin'), { code: 0, stdout: '', stderr: '' });
    for (const origin of [undefined, '', 'not an origin', 'https://user:password@team.example.test', 'https://team.example.test/path', 'https://team.example.test?query=private', 'https://team.example.test#private', 'http://team.example.test', 'https://TEAM.example.test', 'https://team.example.test:443', 'https://team.example.test/']) {
      assert.deepEqual(await health(port, 'business', origin), { code: 1, stdout: '', stderr: '' }, 'invalid business origin must fail silently');
    }
    for (const profile of ['', 'Business', ' business', 'business ', 'unknown']) assert.deepEqual(await health(port, profile, 'https://team.example.test'), { code: 1, stdout: '', stderr: '' });
    assert.deepEqual(hosts, [`127.0.0.1:${port}`, `127.0.0.1:${port}`], 'invalid configuration must not make any request');
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('shipped business health rejects injected port without changing destination or adding authorization', async () => {
  const requests: { host: string | undefined; path: string | undefined; authorizationPresent: boolean }[] = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url, authorizationPresent: request.headers.authorization !== undefined });
    response.end('ok');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.2', r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const response = await health(`1@127.0.0.2:${address.port}`, 'business', 'https://team.example.test');
    assert.deepEqual({ response, requests }, { response: { code: 1, stdout: '', stderr: '' }, requests: [] });
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

test('shipped business health rejects invalid ports silently before making a request', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    for (const port of ['', '0', '-1', '65536', '1.5', 'NaN', 'Infinity', 'abc', `${address.port}/other`, `${address.port}?query=fixture`, `${address.port}#fixture`]) {
      assert.deepEqual(await health(port, 'business', 'https://team.example.test'), { code: 1, stdout: '', stderr: '' }, 'invalid business port must fail silently');
    }
    assert.equal(requests, 0);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});

// W5.2 (docs/design/W5LOCAL.md): Local-only mode, proven. A REAL Sara server (src/main.ts) runs
// with Local-only mode on and a network trap under the net guard (test/fixtures/w5-net-trap.ts,
// loaded with --import into the server and every Node program it starts): every TCP/TLS socket,
// fetch, DNS question and UDP packet that is not this computer is refused and logged. A scripted
// full day of features then runs against it over HTTP (chat, memory, reminders, photos, voice,
// the briefing, the Library, the planner, automations, health), and the test asserts:
//   1. the trap saw zero attempts to reach another computer, and
//   2. the privacy ledger (Settings → Privacy → What left this server) shows zero requests.
// A control step first proves the trap is not blind: with "update checks" allowed, an update
// check is caught by the trap and counted by the ledger; then the allowance is taken back.
// A new feature that opens a way out in the future makes step 1 fail with its stack.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { fakeJpeg } from './fixtures/v4-photos.ts';
import { ROOT, tempDir } from './helpers.ts';

interface Hit { kind: string; target: string; loopback: boolean; pid: number; stack: string[] }

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });

/** An OpenAI-compatible model on this computer: short plain answers, streamed or not. */
const toolsTried: string[] = [];
function fakeModel(): Promise<{ server: Server; port: number; calls: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-1', object: 'model' }] }));
      n++;
      let body: { stream?: boolean; messages?: { content?: unknown }[] } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* answer anyway */
      }
      const seen = JSON.stringify(body.messages ?? []);
      const msgs = (body.messages ?? []) as { role?: string; content?: unknown }[];
      const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
      const answered = msgs.slice(lastUser + 1).some((m) => m.role === 'tool' || m.role === 'assistant');
      const tools = ((body as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((x) => x.function?.name);
      const ask = /search the web/i.test(JSON.stringify(msgs[lastUser]?.content ?? '')) ? (['web_search', 'web_fetch'].find((n) => tools.includes(n)) ?? '') : '';
      if (body.stream && ask && !answered) {
        n++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const args = ask === 'web_search' ? { query: 'soup recipe' } : { url: 'https://www.example.com/soup' };
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: ask, arguments: JSON.stringify(args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        return void res.end('data: [DONE]\n\n');
      }
      if (body.stream && ask) toolsTried.push(ask);
      const text = /image_url/.test(seen) ? 'A cup of tea on a wooden table.' : /briefing/i.test(seen) ? 'Good morning! Two things today: the dentist and call Mom.' : 'Okay, noted.';
      if (!body.stream) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port, calls: () => n })));
}

const readHits = (file: string): Hit[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Hit) : []);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('Local-only mode: a full day of features on a real server sends nothing to any other computer, and the ledger shows zero', { timeout: 240_000 }, async (t) => {
  const { dir } = tempDir();
  const data = join(dir, 'data');
  const photos = join(dir, 'photos');
  mkdirSync(data, { recursive: true });
  mkdirSync(photos, { recursive: true });
  writeFileSync(join(photos, 'tea.jpg'), fakeJpeg({ date: '2026:11:19 08:00:00', lat: 41.88, lon: -87.63, make: 'Phone', tag: 'tea' }));
  const log = join(dir, 'trap.jsonl');
  const model = await fakeModel();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(data, 'settings.json'),
    JSON.stringify({
      providers: [{ id: 'here', kind: 'openai-compatible', label: 'On this PC', baseUrl: `http://127.0.0.1:${model.port}/v1`, defaultModel: 'local-1', needsKey: false }],
      defaultProviderId: 'here',
      defaultModel: 'local-1',
      ownerName: 'Alex',
      timeZone: 'America/Chicago',
      disclosureAcceptedAt: '2026-11-01T00:00:00.000Z',
      setupDone: true,
      // Set up the way a person would have it before turning the mode on: weather for the
      // briefing (the internet) and a web search (the internet). Both must stay home.
      briefing: { enabled: true, time: '07:00', place: { name: 'Chicago', lat: 41.88, lon: -87.63 } },
      search: { provider: 'searxng', url: 'https://search.example.com' },
    }),
  );
  const trap = pathToFileURL(join(ROOT, 'test', 'fixtures', 'w5-net-trap.ts')).href;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SARA_DATA: data,
    SARA_PORT: String(port),
    SARA_HOST: '127.0.0.1',
    SARA_SANDBOX: 'none',
    SARA_REPORT_TO: 'off',
    SARA_SETUP: 'off',
    SARA_TESTING: '1',
    SARA_PRIVATE_LOCAL: 'start',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trap}`.trim(),
    W5_TRAP_LOG: log,
    W5_TRAP_PORTS: `${port},${model.port}`,
  };
  for (const k of ['SARA_DEMO', 'SARA_MASTER_KEY', 'SARA_INSTANCE', 'SARA_LOG_FILE', 'NODE_TEST_CONTEXT', 'SARA_STORE_URL', 'SARA_VOICE_DIR']) delete env[k];
  let out = '';
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')));
  t.after(async () => {
    child.kill();
    model.server.close();
    await wait(300);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold the folder a moment longer */
    }
  });
  // Boot.
  const tokenFile = join(data, 'first-token.txt');
  for (let i = 0; i < 240 && !(existsSync(tokenFile) && /listening on/.test(out)); i++) await wait(250);
  assert.ok(existsSync(tokenFile), `the server started:\n${out.slice(-2000)}`);
  const token = readFileSync(tokenFile, 'utf8').trim();
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { authorization: `Bearer ${token}`, origin: base, ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(raw ? { body: new Uint8Array(raw) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { text };
    }
    statuses.push(`${method} ${path.split('?')[0]} ${res.status}`);
    return { status: res.status, body: json };
  };
  const statuses: string[] = [];
  const steps: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const r = await fn();
    steps.push(name);
    return r;
  };

  // The switch: on from the first start, nothing allowed.
  const pl = await call('GET', '/private-local');
  assert.equal(pl.body.on, true);
  assert.deepEqual(pl.body.allow, []);

  // Control: allow update checks, check, and the trap must see it (the ledger counts it too).
  assert.equal((await call('PUT', '/private-local', { allow: ['updates'] })).status, 200);
  await call('POST', '/update', { action: 'check' });
  const control = readHits(log).filter((h) => !h.loopback);
  assert.ok(control.some((h) => /github\.com/.test(h.target)), `the trap caught the allowed update check: ${JSON.stringify(control.map((h) => h.target))}`);
  const led0 = await call('GET', '/private-local/ledger');
  assert.ok(((led0.body.total as { count: number }).count ?? 0) >= 1, 'the ledger counted the allowed update check');
  // Take the allowance back; start counting the day from zero.
  assert.deepEqual((await call('PUT', '/private-local', { allow: [] })).body.allow, []);
  assert.equal((await call('POST', '/update', { action: 'check' })).status, 409, 'update checks are paused again');
  await call('DELETE', '/private-local/ledger');
  writeFileSync(log, '');

  // A full day.
  const now = Date.now();
  await step('chat', async () => {
    const conv = await call('POST', '/conversations', {});
    const id = String(conv.body.id);
    for (const content of ['Good morning! What should I focus on today?', 'Please look up the weather and search the web for a soup recipe.']) {
      const res = await fetch(`${base}/api/conversations/${id}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
      assert.equal(res.status, 200, content);
      await res.text();
    }
  });
  await step('memory', async () => {
    assert.ok([200, 201].includes((await call('POST', '/memories', { content: 'Alex likes green tea in the morning.' })).status));
    await call('GET', '/memories?q=tea');
  });
  await step('reminders', async () => {
    assert.equal((await call('POST', '/reminders', { text: 'Call Mom', when: new Date(now + 1500).toISOString() })).status, 201);
    await wait(2000);
    await call('POST', '/reminders/check', {});
    await call('GET', '/reminders');
  });
  await step('planner', async () => {
    assert.ok([200, 201].includes((await call('POST', '/tasks', { title: 'Dentist at 3', due: new Date(now + 3_600_000).toISOString() })).status));
    await call('GET', '/planner');
    await call('GET', '/today');
  });
  await step('library', async () => {
    const up = await call('POST', '/library?name=soup.txt&keep=1&learn=0', undefined, Buffer.from('Grandma soup: carrots, leeks, potatoes. Simmer 40 minutes.'));
    assert.ok([200, 201].includes(up.status), JSON.stringify(up.body));
    await call('GET', '/library');
  });
  await step('photos', async () => {
    assert.equal((await call('PUT', '/moments/folder', { folder: photos })).status, 200);
    await call('POST', '/moments/folder/scan', {});
    await wait(1500);
    await call('GET', '/moments/folder');
  });
  await step('voice', async () => {
    await call('GET', '/voice');
    // No voice engine on this server: a plain refusal, never a cloud voice.
    const sp = await call('POST', '/voice/speak', { text: 'Good morning' });
    assert.notEqual(sp.status, 500);
  });
  await step('briefing', async () => {
    const b = await call('POST', '/briefing/send', {});
    assert.equal(b.status, 200, JSON.stringify(b.body));
  });
  await step('automations', async () => {
    const a = await call('POST', '/automations', { gallery: 'weekly-review', values: {}, allow: true });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const id = (a.body.automation as { id: number }).id;
    await call('POST', `/automations/${encodeURIComponent(`auto:${id}`)}/run`, {});
    await wait(1500);
    await call('GET', `/automations/${encodeURIComponent(`auto:${id}`)}/history`);
  });
  await step('health', async () => {
    assert.equal((await call('POST', '/health-log/entries', { text: 'mood 7/10' })).status, 200);
    await call('GET', '/health-log/series?name=mood');
  });
  // Let background work (titles, memory notes, picture descriptions, the run) finish.
  await wait(2500);
  assert.equal(steps.length, 10);
  assert.ok(model.calls() > 0, 'the model on this computer did the work');

  // 1. Nothing tried to reach another computer.
  const out1 = readHits(log).filter((h) => !h.loopback);
  assert.deepEqual(
    out1.map((h) => `${h.kind} ${h.target}\n    ${h.stack.slice(0, 5).join('\n    ')}`),
    [],
    'a new way out of the server: route it through src/net-guard.ts (netFetch / checkOutbound) so Local-only mode stops it',
  );
  // 2. The ledger shows zero bytes and zero requests for the day.
  const led = await call('GET', '/private-local/ledger');
  const total = led.body.total as { count: number; bytes: number; places: number };
  assert.deepEqual({ count: total.count, bytes: total.bytes, places: total.places }, { count: 0, bytes: 0, places: 0 }, JSON.stringify(led.body.groups));
  assert.equal(led.body.privateLocal, true);
  // What the guard stopped is listed (it never left): the briefing's weather, the web search.
  const stopped = (led.body.stopped as { host: string }[]).map((s) => s.host);
  t.diagnostic(`stopped before leaving: ${stopped.join(', ') || 'nothing'}`);
  t.diagnostic(`web tools the model called: ${toolsTried.join(', ') || 'none'}`);
  t.diagnostic(`requests: ${statuses.join(' | ')}`);
  t.diagnostic(`loopback ports refused by the trap: ${[...new Set(readHits(log).filter((h) => h.loopback).map((h) => h.target))].join(', ') || 'none'}`);
});

test('the trap is not blind: raw sockets, TLS, DNS, UDP and fetch to another computer are caught and refused before anything is sent', { timeout: 60_000 }, async (t) => {
  const { dir } = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'trap.jsonl');
  const script = [
    "import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';",
    "const s = net.connect(443, '203.0.113.7'); s.on('error', () => {});",
    "const s2 = tls.connect({ host: 'example.com', port: 443 }); s2.on('error', () => {});",
    "dns.lookup('example.com', () => {}); await dns.promises.resolve4('example.org').catch(() => {});",
    "const u = dgram.createSocket('udp4'); u.send(Buffer.from('x'), 5353, '224.0.0.251', () => u.close());",
    "await fetch('https://example.net/x').catch(() => {});",
    "const ok = net.connect(9, '127.0.0.1'); ok.on('error', () => {});",
    "await new Promise((r) => setTimeout(r, 300)); process.exit(0);",
  ].join('\n');
  const trap = pathToFileURL(join(ROOT, 'test', 'fixtures', 'w5-net-trap.ts')).href;
  await new Promise<void>((resolve, reject) => {
    const c = spawn(process.execPath, ['--import', trap, '--input-type=module', '-e', script], { env: { ...process.env, W5_TRAP_LOG: log, W5_TRAP_PORTS: '' }, stdio: 'ignore' });
    c.on('exit', () => resolve());
    c.on('error', reject);
  });
  const hits = readHits(log);
  const kinds = new Set(hits.map((h) => `${h.kind} ${h.target}`));
  for (const want of ['socket 203.0.113.7:443', 'tls example.com:443', 'dns example.com', 'dns example.org', 'udp 224.0.0.251:5353', 'fetch https://example.net/x']) assert.ok(kinds.has(want), `${want} in ${[...kinds].join(', ')}`);
  // A loopback port the test did not open is refused too (a real program on this PC), marked as loopback.
  assert.ok(hits.some((h) => h.loopback && h.target === '127.0.0.1:9'));
});

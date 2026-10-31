// Phase 67: "Nothing leaves this computer" (private local mode) and a model on this computer.
// The choke point (src/net-guard.ts), a scan of src/ for any other way out, each feature that
// would reach the internet refusing or pausing, the hardware → model table, Ollama's pull stream,
// the switch's rules (a local model first, confirm to turn off, SARA_PRIVATE_LOCAL) and the demo.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { geocode } from '../src/briefing.ts';
import { classify, resolveChain } from '../src/chat.ts';
import { TelegramBridge } from '../src/bridges/telegram.ts';
import { DiscordBridge } from '../src/bridges/discord.ts';
import { CPU_TIERS, detectHardware, GPU_TIERS, memoryBudget, ModelPuller, parseNvidiaSmi, PullProgress, recommendModel } from '../src/local-models.ts';
import { assertOnline, checkOutbound, isLoopbackHost, isPrivateLocalError, netFetch, openWebSocket, outboundAllowed, privateLocalOn, PrivateLocalError, setNetTransport, setPrivateLocal } from '../src/net-guard.ts';
import { envMode, onThisComputer, PrivateLocalStore, talksHere, whatWouldLeave } from '../src/private-local.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.ts';
import { PushService } from '../src/push.ts';
import { ReportStore } from '../src/reports.ts';
import { createSaraServer } from '../src/server.ts';
import { McpManager } from '../src/tools/mcp.ts';
import { createHomeTools, HOME_VAULT } from '../src/tools/home.ts';
import { PRIVATE_LOCAL_ENV, runCommand } from '../src/tools/sandbox.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { createWebSearchTool } from '../src/tools/search.ts';
import { webFetchTool } from '../src/tools/builtin.ts';
import { Updater } from '../src/updates.ts';
import { xaiSpeak } from '../src/voice.ts';
import { uploadOffsite } from '../src/offsite.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

/** A fake network: records every address and answers 200 {}. Loopback calls the test makes itself pass through. */
const realFetch = globalThis.fetch.bind(globalThis);
let seen: string[] = [];
let ollamaModels: { name: string; size: number; remote_host?: string }[] = [];
function fakeNet(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  seen.push(url);
  if (/^http:\/\/127\.0\.0\.1:(?!11434)\d+\//.test(url)) return realFetch(input, init);
  if (url.endsWith(':11434/api/version')) return Promise.resolve(Response.json({ version: '0.40.10' }));
  if (url.endsWith(':11434/api/tags')) return Promise.resolve(Response.json({ models: ollamaModels }));
  return Promise.resolve(Response.json({}));
}
before(() => setNetTransport(fakeNet as typeof fetch));
afterEach(() => {
  setPrivateLocal(false);
  seen = [];
});
after(() => setNetTransport());

const blocked = async (p: Promise<unknown>) => {
  await assert.rejects(p, (err: unknown) => isPrivateLocalError(err) || /private local mode/i.test(String((err as Error)?.message)));
};

test('the guard: only literal loopback hosts pass while the mode is on, decided before any DNS lookup', async () => {
  for (const ok of ['http://127.0.0.1:11434/api/tags', 'http://127.8.9.10/', 'http://localhost:7860/x', 'http://LOCALHOST./', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'ws://localhost:9222/devtools', 'data:text/plain,hi']) {
    setPrivateLocal(true);
    assert.equal(outboundAllowed(ok), true, ok);
  }
  for (const no of ['https://api.openai.com/v1', 'http://10.0.0.5:11434', 'http://192.168.1.2:11434/v1', 'http://100.64.1.1/', 'http://[::2]/', 'http://[fe80::1]/', 'http://localhost.example.com/', 'http://127.0.0.1.nip.io/', 'http://0.0.0.0/', 'file:///etc/passwd', 'ftp://127.0.0.1/', 'wss://gateway.discord.gg', 'not a url']) {
    assert.equal(outboundAllowed(no), false, no);
    assert.throws(() => checkOutbound(no), PrivateLocalError, no);
  }
  assert.equal(isLoopbackHost('::ffff:7f00:1'), true);
  assert.equal(isLoopbackHost('::ffff:a00:1'), false);
  // Off: everything is allowed (the mode is the only rule here).
  setPrivateLocal(false);
  assert.equal(outboundAllowed('https://api.openai.com/v1'), true);
  assert.doesNotThrow(() => checkOutbound('https://example.com'));
});

test('netFetch: refuses non-loopback addresses without sending, lets loopback through, and wraps the global fetch only while on', async () => {
  const before = globalThis.fetch;
  setPrivateLocal(true);
  assert.equal(privateLocalOn(), true);
  assert.notEqual(globalThis.fetch, before, 'the global fetch is guarded too');
  await blocked(netFetch('https://example.com/'));
  await blocked(globalThis.fetch('https://example.com/'));
  await blocked(netFetch(new Request('https://api.anthropic.com/v1/messages')));
  assert.deepEqual(seen, [], 'nothing reached the network');
  await netFetch('http://127.0.0.1:11434/api/version');
  assert.deepEqual(seen, ['http://127.0.0.1:11434/api/version']);
  // A loopback Ollama asked to reach the internet for us: download, cloud model, web search.
  await blocked(netFetch('http://127.0.0.1:11434/api/pull', { method: 'POST', body: JSON.stringify({ model: 'qwen3.5:9b' }) }));
  await blocked(netFetch('http://localhost:11434/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-oss:120b-cloud', messages: [] }) }));
  await blocked(netFetch('http://127.0.0.1:11434/api/experimental/web_search', { method: 'POST', body: '{}' }));
  await netFetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: 'qwen3.5:9b', messages: [] }) });
  assert.equal(seen.length, 2);
  // WebSockets and programs that talk to their vendor.
  assert.throws(() => openWebSocket('wss://gateway.discord.gg/?v=10'), PrivateLocalError);
  assert.throws(() => assertOnline('Claude (your subscription)'), /Paused in private local mode/);
  setPrivateLocal(false);
  assert.equal(globalThis.fetch, before, 'the global fetch is back');
  await netFetch('https://example.com/');
  assert.deepEqual(seen.at(-1), 'https://example.com/');
});

test('every outside service Sara talks to is refused while the mode is on', async () => {
  setPrivateLocal(true);
  const hosts = [
    'https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages', 'https://api.x.ai/v1/images/generations', 'https://openrouter.ai/api/v1/models', 'https://ollama.com/v1/models', 'https://ollama.com/api/web_search',
    'https://api.search.brave.com/res/v1/web/search', 'https://api.tavily.com/search', 'https://api.telegram.org/botX/getMe', 'https://discord.com/api/v10/users/@me', 'https://gmail.googleapis.com/gmail/v1/users/me/messages', 'https://oauth2.googleapis.com/token',
    'https://api.github.com/user', 'https://api.open-meteo.com/v1/forecast', 'https://geocoding-api.open-meteo.com/v1/search', 'https://nominatim.openstreetmap.org/search', 'https://routing.openstreetmap.de/routed-car/route/v1', 'https://sara.backstagecoding.com/api/report-inbox',
    'https://fcm.googleapis.com/fcm/send/x', 'https://api.push.apple.com/3/device/x', 'https://api.elevenlabs.io/v1/text-to-speech/x', 'https://auth.openai.com/.well-known/openid-configuration', 'https://s3.us-west-002.backblazeb2.com/bucket/x', 'https://homeassistant.example.com/api/states',
  ];
  for (const h of hosts) await blocked(netFetch(h));
  assert.deepEqual(seen, []);
  for (const ws of ['wss://gateway.discord.gg/?v=10', 'wss://api.x.ai/v1/realtime', 'wss://api.openai.com/v1/realtime']) assert.throws(() => openWebSocket(ws), PrivateLocalError);
});

// ---------- the source scan: no way out except through the guard ----------

const ALLOWED: Record<string, string> = {
  'src/net-guard.ts': 'the guard itself (the one real fetch and WebSocket)',
  'src/mcp-bridge.ts': "the stdio bridge that runs on the owner's other computer (handed out as sara-mcp.ts); not part of the server",
  'src/preview.ts': "the preview proxy: connects only to 127.0.0.1, to ports her own jobs listen on",
  'src/browser-guard.ts': "the testing browser's proxy: checks outboundAllowed() before connecting",
  'src/ws.ts': 'the DevTools WebSocket client: calls checkOutbound() before connecting',
  'src/tools/builtin.ts': 'web_fetch: calls checkOutbound() before every hop',
  'src/apns.ts': "iPhone notifications over HTTP/2: calls checkOutbound() before connecting",
  'src/tunnel.ts': "Phase 89 dev tunnel: connects only to 127.0.0.1, to a port her own job listens on, after checkOutbound()",
};

/** Lines of code that open a connection without the guard. */
export function rawNetworkUses(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split('\n')) {
    // Trailing comments are left out too (" // …" after code; a URL's "://" is not a comment).
    const s = line.trim().replace(/\s\/\/ .*$/, '');
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    if (/(?<![\w.#'"`-])fetch\(/.test(s) || /(?:=|\?\?)\s*fetch\b(?!\w)(?!\s*:)/.test(s) || /new WebSocket\(/.test(s)) out.push(s);
    if (/from 'node:(https?|http2|net|tls|dgram)'/.test(s) && /\b(request|get|connect|createConnection|createSocket|Socket)\b(?! as httpRequest\b)?/.test(s.replace(/type \w+/g, '').replace(/createServer/g, ''))) out.push(s);
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
}

test('source scan: no module in src/ calls fetch, WebSocket or a raw socket except through the guard (allowlist, each justified)', () => {
  // The scan itself finds what it should.
  assert.equal(rawNetworkUses("const r = await fetch('https://x');").length, 1);
  assert.equal(rawNetworkUses('constructor(f: typeof fetch = fetch) {}').length, 1);
  assert.equal(rawNetworkUses("import { request } from 'node:https';").length, 1);
  assert.equal(rawNetworkUses('const ws = new WebSocket(url);').length, 1);
  assert.equal(rawNetworkUses("const r = await netFetch('https://x'); // fetch( in a comment\ngit(['fetch', 'origin']);").length, 0);
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const uses = rawNetworkUses(readFileSync(file, 'utf8'));
    if (uses.length && !ALLOWED[rel]) offenders.push(`${rel}: ${uses[0].slice(0, 120)}`);
  }
  assert.deepEqual(offenders, [], 'every outgoing request must use netFetch/openWebSocket from src/net-guard.ts');
  // The allowlisted modules really check (or only ever reach loopback).
  for (const [rel, why] of Object.entries(ALLOWED)) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    if (rel === 'src/net-guard.ts' || rel === 'src/mcp-bridge.ts') continue;
    if (rel === 'src/preview.ts') assert.match(src, /host: '127\.0\.0\.1'/, why);
    else assert.match(src, /checkOutbound\(|outboundAllowed\(/, `${rel}: ${why}`);
  }
});

// ---------- each feature refuses or pauses (fakes) ----------

test('features: web search, web pages, reports, updates, weather, voices, off-server backups and cloud providers are refused', async () => {
  setPrivateLocal(true);
  const ctx = { workspaceDir: '.', signal: AbortSignal.timeout(5000), sandbox: { mode: 'none' as const, network: true, detail: '' } };
  await blocked(createWebSearchTool(() => ({ provider: 'brave', apiKey: 'k' })).run({ query: 'news' }, ctx as never));
  await blocked(createWebSearchTool(() => ({ provider: 'ollama', apiKey: 'k' })).run({ query: 'news' }, ctx as never));
  await assert.rejects(webFetchTool.run({ url: 'https://example.com/' }, ctx as never), /private local mode|private or local address/i);
  // Refused before any DNS lookup (the lookup would tell the resolver the name): a name that
  // can't resolve still gets the private-mode answer, not "Could not resolve".
  await assert.rejects(webFetchTool.run({ url: 'https://private-local-check.invalid/' }, ctx as never), /private local mode/i);
  // A report stays here; sending it to the developer is refused (and recorded as not sent).
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date('2026-10-28T12:00:00Z') });
    const reports = new ReportStore(app.store.db);
    const r = reports.add({ text: 'a reply', reason: 'other' as never });
    assert.equal(await reports.send(r.id, { platform: 'web', appVersion: '1.7.0' }), false);
    assert.match(reports.get(r.id)!.sendError ?? '', /private local mode/);
    app.store.close();
  } finally {
    cleanup();
  }
  const upd = await new Updater({ dataDir: '.', version: '1.6.0', platform: 'win32' }).check();
  assert.notEqual(upd.state, 'available');
  assert.throws(() => new Updater({ dataDir: '.', platform: 'linux', unitDir: ROOT }).request('check'), /private local mode|updater|command line/i);
  await blocked(geocode('Lisbon'));
  await blocked(xaiSpeak({ voiceId: 'eve', language: 'en' }, 'k', 'hi', 1));
  await blocked(uploadOffsite(join(ROOT, 'package.json'), { kind: 's3', endpoint: 'https://s3.example.com', bucket: 'b', region: 'r', accessKeyId: 'a' } as never, { passphrase: 'pass phrase here', s3Secret: 's' }));
  const cloud = new OpenAICompatibleProvider({ id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: true }, 'k');
  await blocked((async () => {
    for await (const _ of cloud.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })) void _;
  })());
  await blocked(cloud.listModels());
  assert.deepEqual(seen, [], 'nothing reached the network');
  // A model on this computer still works.
  const local = new OpenAICompatibleProvider({ id: 'ollama-local', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true }, undefined);
  await local.listModels().catch(() => []);
  assert.ok((seen as string[]).some((u) => u.startsWith('http://127.0.0.1:11434/v1/models')));
});

test('features: bridges, notifications, MCP on other computers, Home Assistant and commands pause; loopback ones keep working', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-28T12:00:00Z') });
  try {
    setPrivateLocal(true);
    app.vault.set('bridge:telegram', '123:abc');
    app.vault.set('bridge:discord', 'tok');
    app.settings.update({ telegram: { enabled: true }, discord: { enabled: true } } as never);
    const tg = new TelegramBridge(app);
    await tg.restart();
    assert.equal(tg.status().running, false);
    assert.match(tg.status().error ?? '', /private local mode/);
    const dc = new DiscordBridge(app);
    await dc.restart();
    assert.match(dc.status().error ?? '', /private local mode/);
    // Notifications: nothing sent, nothing counted as failed (no device dropped).
    const push = new PushService(app.store.db, app.vault, app.settings);
    assert.deepEqual(await push.sendAll({ title: 'x', body: 'y', url: '/', tag: 't' }), { sent: 0, failed: 0, removed: 0 });
    // MCP over HTTP on another computer: refused; stdio programs on this computer are fine.
    const mcp = new McpManager(new ToolRegistry(), { dataDir: dir, sandbox: { mode: 'none', network: true, detail: '' }, secrets: () => ({}) });
    const conn = await mcp.start({ name: 'remote', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp' });
    assert.equal(conn.status, 'error');
    assert.match(conn.error ?? '', /private local mode/);
    mcp.stopAll();
    // Home Assistant: only when it is on this computer.
    app.vault.set(HOME_VAULT, 'ha-token');
    const status = createHomeTools(app).find((t) => t.spec.name === 'home_status')!;
    app.settings.update({ home: { url: 'https://homeassistant.example.com' } });
    await assert.rejects(status.run({}, { workspaceDir: dir, signal: AbortSignal.timeout(5000), sandbox: app.sandbox } as never), /private local mode/);
    app.settings.update({ home: { url: 'http://127.0.0.1:8123' } });
    await status.run({}, { workspaceDir: dir, signal: AbortSignal.timeout(5000), sandbox: app.sandbox } as never).catch(() => '');
    assert.ok(seen.some((u) => u.startsWith('http://127.0.0.1:8123/api/')), 'a Home Assistant on this computer is still reached');
    assert.ok(!seen.some((u) => u.includes('example.com') || u.includes('telegram') || u.includes('discord')));
    // Commands: no network in the sandbox, and the no-network settings for every program.
    const r = await runCommand(`"${process.execPath}" -e "process.stdout.write([process.env.GIT_ALLOW_PROTOCOL, process.env.HTTPS_PROXY, process.env.npm_config_offline].join('|'))"`, dir, { mode: 'none', network: true, detail: '' }, { timeoutMs: 20_000, signal: AbortSignal.timeout(25_000) });
    assert.match(r.output, /file\|http:\/\/127\.0\.0\.1:9\|true/);
    assert.equal(PRIVATE_LOCAL_ENV.NO_PROXY, 'localhost,127.0.0.1,::1');
  } finally {
    app.store.close();
    cleanup();
  }
});

test('routing: a cloud default model is paused, the private model on this computer takes over; nothing to fall back on says so', async () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-10-28T12:00:00Z') });
  try {
    app.settings.update({
      providers: [
        { id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', needsKey: false },
        { id: 'ollama-local', label: 'Ollama on the server', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
        { id: 'lan', label: 'Ollama on my computer', kind: 'openai-compatible', baseUrl: 'http://192.168.1.20:11434/v1', local: true },
      ],
      defaultProviderId: 'openai',
      defaultModel: 'gpt-5',
    });
    const conv = app.store.createConversation({ title: 't' });
    assert.equal(resolveChain(app, conv, 'turn')[0].provider.config.id, 'openai', 'off: unchanged');
    setPrivateLocal(true);
    assert.throws(() => resolveChain(app, conv, 'turn'), /paused in private local mode/);
    app.settings.update({ routes: { private: { providerId: 'lan', model: 'qwen3.5:9b' } } });
    assert.throws(() => resolveChain(app, conv, 'turn'), /paused in private local mode/, 'a LAN Ollama is not this computer');
    app.settings.update({ routes: { private: { providerId: 'ollama-local', model: 'qwen3.5:9b' } } });
    const [first] = resolveChain(app, conv, 'turn');
    assert.equal(first.provider.config.id, 'ollama-local');
    assert.equal(first.model, 'qwen3.5:9b');
    assert.equal(talksHere(app.settings.get()), true);
    // The optional safety check on a cloud model is skipped (no request), never an error.
    app.settings.update({ safetyClassifier: { providerId: 'openai', model: 'gpt-5-mini' } });
    const before = app.requests.length;
    assert.equal(await classify(app, 'hello'), 'OK');
    assert.equal(app.requests.length, before, 'the cloud classifier was not asked');
    assert.equal(onThisComputer({ kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }, 'gemma4:31b-cloud'), false);
    assert.equal(onThisComputer({ kind: 'claude-code', baseUrl: 'http://127.0.0.1' }), false);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('what would leave: built from the settings, with what is set up marked', () => {
  const items = whatWouldLeave({ providers: [{ id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }, { id: 'o', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' }], telegram: { enabled: true }, mcpServers: [{ name: 'cal', enabled: true, transport: 'http', url: 'https://cal.example.com/mcp' }, { name: 'here', enabled: true, transport: 'http', url: 'http://127.0.0.1:9000/mcp' }], home: { url: 'http://127.0.0.1:8123' } } as never, { pushDevices: 2 });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(by['cloud-models'].names, ['OpenAI']);
  assert.equal(by.telegram.active, true);
  assert.equal(by.discord.active, false);
  assert.equal(by.push.active, true);
  assert.deepEqual(by.mcp.names, ['cal']);
  assert.equal(by.home.active, false, 'a Home Assistant on this computer is not leaving');
  for (const i of items) assert.ok(i.label.length > 3);
});

// ---------- hardware → model, Ollama's pull stream ----------

test('hardware → model: the table follows docs/CHOOSING_A_MODEL.md', async () => {
  const pick = (budgetGb: number, basis: 'gpu' | 'unified' | 'cpu' = 'gpu') => recommendModel({ budgetGb, basis }).model;
  assert.equal(pick(2), 'qwen3.5:2b');
  assert.equal(pick(6), 'qwen3.5:4b');
  assert.equal(pick(8), 'qwen3.5:9b');
  assert.equal(pick(12), 'gemma4:12b');
  assert.equal(pick(16), 'gpt-oss:20b');
  assert.equal(pick(24), 'qwen3.8:27b');
  assert.equal(pick(32), 'qwen3.8:27b');
  assert.equal(pick(8, 'cpu'), 'qwen3.5:2b');
  assert.equal(pick(32, 'cpu'), 'qwen3.5:4b');
  // Every row fits: the download is smaller than the memory it is picked for (from 4 GB up).
  for (const t of GPU_TIERS) if (t.minGb >= 8) assert.ok(t.sizeGb < t.minGb, t.model);
  assert.ok(GPU_TIERS.every((t, i) => i === 0 || t.minGb > GPU_TIERS[i - 1].minGb));
  assert.ok(CPU_TIERS.length >= 2);
  // A Mac's unified memory: 32 GB → a 12-14B model, 64 GB → 27B (as the doc says).
  assert.equal(recommendModel(memoryBudget({ ramGb: 32, appleSilicon: true })).model, 'gemma4:12b');
  assert.equal(recommendModel(memoryBudget({ ramGb: 64, appleSilicon: true })).model, 'qwen3.8:27b');
  assert.deepEqual(memoryBudget({ ramGb: 64, gpu: { name: 'X', vramGb: 12 } }), { budgetGb: 12, basis: 'gpu' });
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288\r\nNVIDIA GeForce RTX 4090, 24564\n'), { name: 'NVIDIA GeForce RTX 4090', vramGb: 24 });
  assert.equal(parseNvidiaSmi(''), undefined);
  const win = await detectHardware({ platform: 'win32', arch: 'x64', totalmem: 64 * 1024 ** 3, exec: async (f) => (f === 'nvidia-smi' ? 'NVIDIA GeForce RTX 5090, 32607\n' : '') });
  assert.equal(win.basis, 'gpu');
  assert.equal(recommendModel(win).model, 'qwen3.8:27b');
  const noGpu = await detectHardware({ platform: 'linux', arch: 'x64', totalmem: 8 * 1024 ** 3, exec: async () => Promise.reject(new Error('not found')) });
  assert.equal(noGpu.basis, 'cpu');
  assert.equal(recommendModel(noGpu).model, 'qwen3.5:2b');
  const mac = await detectHardware({ platform: 'darwin', arch: 'arm64', totalmem: 1, exec: async (f, a) => (f === 'sysctl' && a.includes('hw.memsize') ? String(36 * 1024 ** 3) : '') });
  assert.equal(mac.basis, 'unified');
  assert.equal(mac.ramGb, 36);
});

test("Ollama's pull stream: progress from split lines, success, errors", () => {
  const p = new PullProgress();
  p.push('{"status":"pulling manifest"}\n{"status":"pulling a1","digest":"sha256:a1","total":1000,"comp');
  p.push('leted":250}\n{"status":"pulling b2","digest":"sha256:b2","total":3000,"completed":0}\n');
  assert.equal(p.totalBytes, 4000);
  assert.equal(p.percent, 6);
  p.push('{"status":"pulling a1","digest":"sha256:a1","total":1000,"completed":1000}\n{"status":"pulling b2","digest":"sha256:b2","total":3000,"completed":3000}\nnot json\n');
  assert.equal(p.percent, 99, 'never 100 before success');
  p.push('{"status":"verifying sha256 digest"}\n{"status":"success"}');
  assert.equal(p.done, false);
  p.end();
  assert.equal(p.done, true);
  assert.equal(p.percent, 100);
  const e = new PullProgress();
  e.push('{"error":"pull model manifest: file does not exist"}\n');
  assert.match(e.error ?? '', /does not exist/);
});

function ndjsonResponse(lines: string[], opts: { hang?: boolean } = {}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const l of lines) c.enqueue(enc.encode(`${l}\n`));
        if (!opts.hang) return c.close();
        init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(stream, { status: 200 });
  };
}

test('downloading: progress, then the model is used; Cancel stops it; an error is shown', async () => {
  const done: string[] = [];
  const ok = new ModelPuller(ndjsonResponse(['{"status":"pulling a","digest":"a","total":10,"completed":5}', '{"status":"pulling a","digest":"a","total":10,"completed":10}', '{"status":"success"}']) as typeof fetch);
  ok.onDone = (m) => done.push(m);
  ok.start('http://127.0.0.1:11434', 'qwen3.5:2b');
  assert.throws(() => ok.start('http://127.0.0.1:11434', 'qwen3.5:4b'), /already running/);
  for (let i = 0; i < 50 && ok.running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(ok.status()!.state, 'done');
  assert.equal(ok.status()!.percent, 100);
  assert.deepEqual(done, ['qwen3.5:2b']);
  const slow = new ModelPuller(ndjsonResponse(['{"status":"pulling a","digest":"a","total":100,"completed":40}'], { hang: true }) as typeof fetch);
  slow.start('http://127.0.0.1:11434', 'qwen3.5:9b');
  for (let i = 0; i < 50 && slow.status()!.percent === null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(slow.status()!.percent, 40);
  assert.equal(slow.cancel(), true);
  for (let i = 0; i < 50 && slow.running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(slow.status()!.state, 'cancelled');
  const bad = new ModelPuller(ndjsonResponse(['{"error":"pull model manifest: file does not exist"}']) as typeof fetch);
  bad.start('http://127.0.0.1:11434', 'nope:1b');
  for (let i = 0; i < 50 && bad.running; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bad.status()!.state, 'error');
  assert.match(bad.status()!.error ?? '', /does not exist/);
  assert.throws(() => bad.start('http://127.0.0.1:11434', 'gpt-oss:120b-cloud'), /not a model name/);
});

// ---------- the switch: state, rules, server routes, demo ----------

test('SARA_PRIVATE_LOCAL: 1 keeps it on, start turns it on until the owner turns it off', () => {
  assert.equal(envMode('1'), 'locked');
  assert.equal(envMode('START'), 'start');
  assert.equal(envMode(''), undefined);
  const a = tempDir();
  try {
    const locked = new PrivateLocalStore(a.dir, '1');
    assert.deepEqual({ on: locked.get().on, locked: locked.get().locked }, { on: true, locked: true });
    assert.throws(() => locked.set(false), /stays on/);
  } finally {
    a.cleanup();
  }
  const b = tempDir();
  try {
    const first = new PrivateLocalStore(b.dir, 'start');
    assert.equal(first.get().on, true);
    first.set(false);
    assert.equal(new PrivateLocalStore(b.dir, 'start').get().on, false, 'turning it off sticks');
    assert.equal(new PrivateLocalStore(b.dir, undefined).get().on, false);
  } finally {
    b.cleanup();
    setPrivateLocal(false);
  }
});

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-10-28T12:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'openai', label: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' }], defaultProviderId: 'openai', defaultModel: 'gpt-5', disclosureAcceptedAt: clock.now.toISOString() });
const auth = new OwnerAuth(dir, () => clock.now);
const owner = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const demoDir = tempDir();
const demoApp = makeApp(demoDir.dir, clock);
const demo = createSaraServer({ app: demoApp, auth: new OwnerAuth(demoDir.dir, () => clock.now), webDir: join(ROOT, 'web'), demo: true });
let base = '';
let demoBase = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await new Promise<void>((r) => demo.listen(0, '127.0.0.1', r));
  demoBase = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  demo.close();
  app.store.close();
  demoApp.store.close();
  cleanup();
  demoDir.cleanup();
});
const call = async (path: string, method = 'GET', body?: unknown) => {
  const r = await realFetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${owner}`, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
};

test('server: turning it on needs a model on this computer, picks it for private talk, refuses cloud picks; off asks first', async () => {
  ollamaModels = [];
  let r = await call('/private-local');
  assert.equal(r.status, 200);
  assert.equal(r.json.on, false);
  assert.ok(Array.isArray(r.json.leave));
  r = await call('/private-local', 'PUT', { on: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.needsModel, true);
  assert.equal(privateLocalOn(), false);
  // Ollama on this computer with one real model (and a cloud one, which doesn't count).
  ollamaModels = [{ name: 'gpt-oss:20b-cloud', size: 300, remote_host: 'https://ollama.com' }, { name: 'qwen3.5:9b', size: 6.6 * 1024 ** 3 }];
  const lm = await call('/local-models');
  assert.equal((lm.json.ollama as { found: boolean }).found, true);
  r = await call('/private-local', 'PUT', { on: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.on, true);
  assert.equal(privateLocalOn(), true);
  const s = app.settings.get();
  const local = s.providers.find((p) => p.baseUrl === 'http://127.0.0.1:11434/v1')!;
  assert.ok(local?.local, 'the Ollama on this computer was added as a local provider');
  assert.deepEqual(s.routes?.private, { providerId: local.id, model: 'qwen3.5:9b' });
  assert.equal(s.defaultProviderId, 'openai', 'the cloud default is kept (paused), not removed');
  const session = (await (await realFetch(`${base}/api/session`, { headers: { authorization: `Bearer ${owner}` } })).json()) as { privateLocal?: boolean };
  assert.equal(session.privateLocal, true);
  // Picking a cloud model now is refused; a model on this computer is fine.
  r = await call('/settings', 'PUT', { companionModel: { providerId: 'openai', model: 'gpt-5' } });
  assert.equal(r.status, 409);
  assert.match(String(r.json.error), /paused in private local mode/);
  r = await call('/settings', 'PUT', { companionModel: { providerId: local.id, model: 'qwen3.5:9b' } });
  assert.equal(r.status, 200);
  // Downloads, winget and update checks need the internet.
  assert.equal((await call('/local-models/pull', 'POST', { model: 'qwen3.5:4b' })).status, 409);
  assert.equal((await call('/update', 'POST', { action: 'check' })).status, 409);
  // A cloud provider's test is refused by the guard (nothing sent).
  seen = [];
  await call('/model-jobs/test', 'POST', { job: 'chat', providerId: 'openai', model: 'gpt-5' });
  assert.ok(!seen.some((u) => u.includes('openai.com')));
  // Off: asks for confirmation first.
  r = await call('/private-local', 'PUT', { on: false });
  assert.equal(r.status, 409);
  assert.equal(r.json.needsConfirm, true);
  r = await call('/private-local', 'PUT', { on: false, confirm: true });
  assert.equal(r.json.on, false);
  assert.equal(privateLocalOn(), false);
});

test('server: Use sets a downloaded model as her model and the background model, provider marked local', async () => {
  ollamaModels = [{ name: 'qwen3.5:9b', size: 1 }];
  assert.equal((await call('/local-models/use', 'POST', { model: 'not-here:1b' })).status, 400);
  const r = await call('/local-models/use', 'POST', { model: 'qwen3.5:9b' });
  assert.equal(r.status, 200);
  const s = app.settings.get();
  assert.equal(s.companionModel?.model, 'qwen3.5:9b');
  assert.equal(s.routes?.background?.model, 'qwen3.5:9b');
  assert.equal(s.providers.find((p) => p.id === s.companionModel?.providerId)?.local, true);
});

test('demo: private local mode and downloads are read-only', async () => {
  const start = await realFetch(`${demoBase}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: demoBase }, body: '{}' });
  const cookie = start.headers.get('set-cookie')!.split(';')[0];
  for (const [path, method, body] of [['/api/private-local', 'PUT', { on: true }], ['/api/local-models/pull', 'POST', { model: 'qwen3.5:2b' }], ['/api/local-models/install-ollama', 'POST', { confirm: true }], ['/api/local-models/use', 'POST', { model: 'x' }]] as const) {
    const r = await realFetch(demoBase + path, { method, headers: { cookie, origin: demoBase, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, path);
  }
  assert.equal(privateLocalOn(), false);
});

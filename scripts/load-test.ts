// EC18 (docs/ops/EC1828_DESIGN.md, docs/ops/SCALE.md): a repeatable load test against a THROWAWAY
// Sara. It never targets an installed server: it makes a fresh data folder under $TMPDIR, starts a
// fake OpenAI-compatible model (no paid calls) and a fake Telegram Bot API, boots the real
// src/main.ts on a loopback port (SARA_TESTING=1: no hub check-in or store fetch; private local
// mode would pause the Telegram bridge), sets both up through the API and drives N
// concurrent virtual users. Each user has its own chat and does T turns: plain turns, a tool call
// every 3rd turn, a library upload before every 4th, and a Telegram message every 5th (timed until
// the bot's reply reaches the fake). Reports p50/p95 per kind, error rate, throughput, CPU, memory,
// event-loop lag and SQLite contention (“database is locked” / SQLITE_BUSY seen anywhere).
//   node scripts/load-test.ts [--sizes 5,20,50] [--turns 10] [--model-ms 300] [--port 0] [--continuity on|off] [--out file.json] [--keep]
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLY = 'Load reply ok.';
const TG_TOKEN = `123456:${'a'.repeat(35)}`;
const BUSY = /database is locked|SQLITE_BUSY/gi;
const TG_OWNERS_MAX = 50;

export type Kind = 'turn' | 'tool' | 'upload' | 'telegram';
export interface SizeResult {
  concurrency: number;
  continuity: boolean;
  turnsPerUser: number;
  ops: number;
  errors: number;
  errorRate: number;
  wallSeconds: number;
  opsPerSecond: number;
  latency: Record<Kind, { count: number; p50Ms: number; p95Ms: number; maxMs: number }>;
  cpuPercent: number;
  peakRssMb: number;
  eventLoopP95Ms: number;
  eventLoopMaxMs: number;
  sqliteBusy: number;
  modelCalls: number;
  toolCalls: number;
  /** Most model requests the fake model saw at the same time. */
  peakModelInFlight: number;
  bootMs: number;
  firstErrors: string[];
}

export function summary(values: number[]): { count: number; p50Ms: number; p95Ms: number; maxMs: number } {
  if (!values.length) return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(s[Math.max(0, Math.ceil(s.length * p) - 1)]);
  return { count: s.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: Math.round(s.at(-1)!) };
}

/** What a virtual user does on turn i (0-based): pure, so the mix is the same every run. */
export function planTurn(i: number): { upload: boolean; telegram: boolean; tool: boolean } {
  return { upload: i % 4 === 3, telegram: i % 5 === 4, tool: i % 3 === 2 };
}

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const body = (req: IncomingMessage) => new Promise<string>((r) => {
  const c: Buffer[] = [];
  req.on('data', (d: Buffer) => c.push(d));
  req.on('end', () => r(Buffer.concat(c).toString('utf8')));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake OpenAI-compatible model: a short streamed reply, or one tool call when the user asked "[tool]". */
function fakeModel(delayMs: number) {
  let calls = 0;
  let toolCalls = 0;
  let inFlight = 0;
  let peak = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await body(req);
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fake-load' }] }));
    }
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    res.once('close', () => inFlight--);
    let b: { stream?: boolean; messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] } = {};
    try {
      b = JSON.parse(raw);
    } catch {
      /* empty */
    }
    await sleep(delayMs);
    const msgs = b.messages ?? [];
    const userAt = msgs.findLastIndex((m) => m.role === 'user');
    // One tool call per asking turn: none once a tool already answered after the user's message.
    const toolDone = msgs.slice(userAt + 1).some((m) => m.role === 'tool');
    const names = (b.tools ?? []).map((t) => String(t.function?.name));
    const pick = ['list_tasks', 'list_notes', 'search_memory', 'recall'].find((n) => names.includes(n));
    const wantTool = !toolDone && pick && JSON.stringify(msgs[userAt]?.content ?? '').includes('[tool]');
    const usage = { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 };
    if (b.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (wantTool) {
        toolCalls++;
        const args = pick === 'search_memory' || pick === 'recall' ? { query: 'tea' } : {};
        send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: pick, arguments: JSON.stringify(args) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: REPLY } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage });
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage }));
  });
  return { server, calls: () => calls, toolCalls: () => toolCalls, peak: () => peak };
}

/** A fake Telegram Bot API: long-polled updates in, every send recorded and awaitable per chat. */
function fakeTelegram() {
  let updateId = 1;
  let messageId = 1;
  const queue: unknown[] = [];
  let poller: (() => void) | undefined;
  const waiters = new Map<number, ((text: string) => void)[]>();
  const server = createServer(async (req, res) => {
    const raw = await body(req);
    const method = String(req.url ?? '').split('/').pop()?.split('?')[0] ?? '';
    let b: Record<string, unknown> = {};
    try {
      b = raw ? JSON.parse(raw) : {};
    } catch {
      /* multipart: not used here */
    }
    const ok = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    if (method === 'getMe') return ok({ id: 999, is_bot: true, first_name: 'Load', username: 'load_bot', can_read_all_group_messages: false });
    if (method === 'getUpdates') {
      if (!queue.length) await Promise.race([new Promise<void>((r) => (poller = r)), sleep(Math.min(20, Number(b.timeout ?? 0)) * 1000)]);
      poller = undefined;
      return ok(queue.splice(0));
    }
    const chat = Number(b.chat_id);
    if (method === 'sendMessage' && Number.isFinite(chat)) {
      const text = String(b.text ?? '');
      for (const w of waiters.get(chat)?.splice(0) ?? []) w(text);
    }
    return ok({ message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: 'private' }, text: String(b.text ?? '') });
  });
  return {
    server,
    /** Sends a private message from owner `user`; resolves when her reply (the fake model's text) comes back. */
    say(user: number, text: string): Promise<void> {
      return new Promise((resolveSay, reject) => {
        const timer = setTimeout(() => reject(new Error('telegram reply timed out')), 180_000);
        const wait = () => {
          const list = waiters.get(user) ?? [];
          list.push((t) => {
            if (t.includes(REPLY)) {
              clearTimeout(timer);
              resolveSay();
            } else if (/already waiting|could not|failed/i.test(t)) {
              clearTimeout(timer);
              reject(new Error(`telegram → ${t.slice(0, 120)}`));
            } else wait();
          });
          waiters.set(user, list);
        };
        wait();
        queue.push({ update_id: updateId++, message: { message_id: messageId++, date: Math.floor(Date.now() / 1000), chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: `User ${user}`, language_code: 'en' }, text } });
        poller?.();
      });
    },
  };
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

/** One size: a fresh throwaway Sara, N users × T turns. */
export async function runSize(o: { concurrency: number; turns: number; modelMs: number; port?: number; continuity?: boolean; keep?: boolean; log?: (s: string) => void }): Promise<SizeResult> {
  const log = o.log ?? ((s: string) => console.error(s));
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'sara-loadtest-'));
  const model = fakeModel(o.modelMs);
  const tg = fakeTelegram();
  const modelPort = await listen(model.server);
  const tgPort = await listen(tg.server);
  const port = o.port || (await freePort());
  const base = `http://127.0.0.1:${port}/api`;
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: dir, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_VOICE_DIR: join(dir, 'novoice'), SARA_TELEGRAM_API: `http://127.0.0.1:${tgPort}`, SARA_TESTING: '1' };
  for (const k of ['NODE_TEST_CONTEXT', 'SARA_DEMO', 'SARA_PRIVATE_LOCAL', 'SARA_MASTER_KEY', 'SARA_INSTANCE', 'SARA_LOG_FILE', 'SARA_RESTORE_DRILL']) delete env[k];
  if (await fetch(`${base}/health`).then(() => true, () => false)) throw new Error(`port ${port} is already in use: refusing to load-test a server this script did not start`);
  let out = '';
  let busy = 0;
  const started = performance.now();
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'main.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onOut = (d: Buffer) => {
    const s = d.toString();
    busy += s.match(BUSY)?.length ?? 0;
    out = (out + s).slice(-20_000);
  };
  child.stdout!.on('data', onOut);
  child.stderr!.on('data', onOut);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    for (const until = Date.now() + 180_000; ; ) {
      if (existsSync(join(dir, 'first-token.txt')) && (await fetch(`${base}/health`).then((r) => r.ok, () => false))) break;
      if (child.exitCode !== null || Date.now() > until) throw new Error(`the throwaway Sara did not start:\n${out.slice(-2000)}`);
      await sleep(200);
    }
    const bootMs = Math.round(performance.now() - started);
    const token = readFileSync(join(dir, 'first-token.txt'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (method: string, path: string, data?: unknown, extra: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method, headers: { ...headers, ...extra }, ...(data === undefined ? {} : { body: data instanceof Buffer ? data : JSON.stringify(data) }), signal: AbortSignal.timeout(180_000) });
      const text = await r.text();
      busy += text.match(BUSY)?.length ?? 0;
      if (!r.ok) throw new Error(`${method} ${path.split('?')[0]} → ${r.status} ${text.slice(0, 160)}`);
      return text ? (JSON.parse(text.startsWith('{') || text.startsWith('[') ? text : '{}') as Record<string, unknown>) : {};
    };
    /** One web turn: the streamed reply must contain the fake model's text; an error event fails it. */
    const say = async (conv: string, content: string, docs: number[]) => {
      const r = await fetch(`${base}/conversations/${conv}/messages`, { method: 'POST', headers, body: JSON.stringify({ content, ...(docs.length ? { docs } : {}) }), signal: AbortSignal.timeout(180_000) });
      const text = await r.text();
      busy += text.match(BUSY)?.length ?? 0;
      if (!r.ok) throw new Error(`turn → ${r.status} ${text.slice(0, 160)}`);
      if (!text.includes(REPLY)) {
        const err = /event: error\ndata: (.*)/.exec(text)?.[1];
        throw new Error(`turn → ${err ? (JSON.parse(err) as { message?: string }).message : 'no reply'}`);
      }
    };
    await call('PUT', '/providers/fake', { kind: 'openai-compatible', label: 'Fake load model', baseUrl: `http://127.0.0.1:${modelPort}/v1`, defaultModel: 'fake-load', needsKey: false });
    // Owner-session continuity (on by default) orders the owner's model steps one at a time per space
    // (src/session-step-gate.ts); --continuity off measures the server without that queue.
    await call('PUT', '/settings', { defaultProviderId: 'fake', defaultModel: 'fake-load', ownerName: 'Load' });
    if (o.continuity === false) await call('PUT', '/chats/continuity', { enabled: false });
    await call('POST', '/disclosure/accept', {});
    const users = Array.from({ length: o.concurrency }, (_, i) => 1001 + i);
    await call('PUT', '/bridges/telegram', { token: TG_TOKEN, enabled: true, ownerUserIds: users.slice(0, TG_OWNERS_MAX) });
    for (const until = Date.now() + 30_000; ; ) {
      const st = await call('GET', '/bridges/telegram');
      if (st.running) break;
      if (Date.now() > until) throw new Error(`telegram bridge did not start: ${JSON.stringify(st).slice(0, 200)}`);
      await sleep(200);
    }
    const ops0 = (await call('GET', '/operations')) as { process: { cpu: { userMs: number; systemMs: number } } };
    const lat: Record<Kind, number[]> = { turn: [], tool: [], upload: [], telegram: [] };
    const errors: string[] = [];
    let peakRss = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const s = (await call('GET', '/operations').catch(() => undefined)) as { process?: { rssBytes: number } } | undefined;
        if (s?.process) peakRss = Math.max(peakRss, s.process.rssBytes);
        await sleep(500);
      }
    })();
    const time = async (kind: Kind, f: () => Promise<unknown>) => {
      const t0 = performance.now();
      try {
        await f();
        lat[kind].push(performance.now() - t0);
      } catch (err) {
        errors.push(`${kind}: ${(err as Error).message}`);
      }
    };
    log(`  ${o.concurrency} users × ${o.turns} turns: booted in ${(bootMs / 1000).toFixed(1)} s, running…`);
    const t0 = performance.now();
    await Promise.all(users.map(async (user, u) => {
      const conv = (await call('POST', '/conversations', {}).catch((e: Error) => (errors.push(`conversation: ${e.message}`), undefined))) as { id?: string } | undefined;
      if (!conv?.id) return;
      for (let i = 0; i < o.turns; i++) {
        const plan = planTurn(i);
        let docs: number[] = [];
        if (plan.upload) {
          await time('upload', async () => {
            const r = (await call('POST', `/library?name=load-${u}-${i}.txt&learn=0`, Buffer.from(`Load test file ${u}/${i}. `.repeat(2000)), { 'content-type': 'application/octet-stream' })) as { doc?: { id: number } };
            if (r.doc?.id) docs = [r.doc.id];
          });
        }
        // Telegram keeps at most 50 owner IDs (cleanTelegramIds): users past 50 chat on the web only.
        if (plan.telegram && u < TG_OWNERS_MAX) await time('telegram', () => tg.say(user, `Hello from Telegram, turn ${i}`));
        else await time(plan.tool ? 'tool' : 'turn', () => say(conv.id!, `Turn ${i} from user ${u}${plan.tool ? ' [tool]' : ''}`, docs));
      }
    }));
    const wall = (performance.now() - t0) / 1000;
    sampling = false;
    await sampler;
    const ops1 = (await call('GET', '/operations')) as { process: { rssBytes: number; cpu: { userMs: number; systemMs: number }; eventLoop: { p95Ms: number; maxMs: number } } };
    peakRss = Math.max(peakRss, ops1.process.rssBytes);
    const cpuMs = ops1.process.cpu.userMs + ops1.process.cpu.systemMs - (ops0.process.cpu.userMs + ops0.process.cpu.systemMs);
    const ops = Object.values(lat).reduce((n, v) => n + v.length, 0) + errors.length;
    return {
      concurrency: o.concurrency,
      continuity: o.continuity !== false,
      turnsPerUser: o.turns,
      ops,
      errors: errors.length,
      errorRate: ops ? Math.round((errors.length / ops) * 10000) / 10000 : 0,
      wallSeconds: Math.round(wall * 10) / 10,
      opsPerSecond: Math.round((ops / wall) * 100) / 100,
      latency: { turn: summary(lat.turn), tool: summary(lat.tool), upload: summary(lat.upload), telegram: summary(lat.telegram) },
      cpuPercent: Math.round((cpuMs / (wall * 1000)) * 1000) / 10,
      peakRssMb: Math.round(peakRss / 1048576),
      eventLoopP95Ms: Math.round(ops1.process.eventLoop.p95Ms),
      eventLoopMaxMs: Math.round(ops1.process.eventLoop.maxMs),
      sqliteBusy: busy,
      modelCalls: model.calls(),
      toolCalls: model.toolCalls(),
      peakModelInFlight: model.peak(),
      bootMs,
      firstErrors: [...new Set(errors)].slice(0, 5),
    };
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, sleep(10_000)]);
    model.server.closeAllConnections();
    tg.server.closeAllConnections();
    model.server.close();
    tg.server.close();
    if (!o.keep) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

export function markdownRow(r: SizeResult): string {
  const l = r.latency;
  return `| ${r.concurrency} | ${r.ops} | ${(r.errorRate * 100).toFixed(1)} % | ${r.opsPerSecond} | ${l.turn.p50Ms} / ${l.turn.p95Ms} | ${l.tool.p50Ms} / ${l.tool.p95Ms} | ${l.upload.p50Ms} / ${l.upload.p95Ms} | ${l.telegram.p50Ms} / ${l.telegram.p95Ms} | ${r.cpuPercent} % | ${r.peakRssMb} MB | ${r.eventLoopP95Ms} / ${r.eventLoopMaxMs} | ${r.sqliteBusy} |`;
}
export const MARKDOWN_HEAD = '| Users | Ops | Errors | Ops/s | Turn p50 / p95 ms | Tool turn p50 / p95 ms | Upload p50 / p95 ms | Telegram p50 / p95 ms | Server CPU | Peak RSS | Loop p95 / max ms | SQLite busy |\n|---|---|---|---|---|---|---|---|---|---|---|---|';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { sizes: { type: 'string', default: '5,20,50' }, turns: { type: 'string', default: '10' }, 'model-ms': { type: 'string', default: '300' }, out: { type: 'string' }, port: { type: 'string', default: '0' }, continuity: { type: 'string', default: 'on' }, keep: { type: 'boolean', default: false } } });
  const sizes = values.sizes.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const turns = Number(values.turns);
  const modelMs = Number(values['model-ms']);
  const host = { platform: `${platform()} ${release()}`, cpus: `${cpus().length} × ${cpus()[0]?.model.trim() ?? '?'}`, memoryGb: Math.round(totalmem() / 1e9), node: process.version };
  console.error(`Load test on ${host.platform}, ${host.cpus}, ${host.memoryGb} GB, Node ${host.node}; fake model ${modelMs} ms per call; owner-session continuity ${values.continuity}.`);
  const results: SizeResult[] = [];
  for (const n of sizes) results.push(await runSize({ concurrency: n, turns, modelMs, port: Number(values.port), continuity: values.continuity !== 'off', keep: values.keep }));
  const report = { at: new Date().toISOString(), host, turns, modelMs, continuity: values.continuity, results };
  if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(MARKDOWN_HEAD);
  for (const r of results) console.log(markdownRow(r));
  for (const r of results) if (r.firstErrors.length) console.log(`\n${r.concurrency} users, first errors:\n- ${r.firstErrors.join('\n- ')}`);
}

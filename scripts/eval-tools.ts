// Z6 (docs/TOOL_EVALS.md): does a message reach the right tool and the right model?
//
// Three questions, asked of a real, throwaway Sara (her whole tool list, her real instructions):
//   1. OFFER   When the person asks for something, is the tool for it in the list she sends the model
//              (the short tool list, src/lean.ts), or would the model have to look for it first?
//   2. ROUTE   Which model does the message go to (chat, research, coding: src/chat.ts)?
//   3. CHOICE  Given that list and those instructions, which tool does a real model reach for first?
//
// How: this script starts `node src/main.ts` on a temporary data folder (never the owner's Sara),
// with one "model provider" that is this script itself. Every model request Sara makes lands here,
// so the script sees exactly what a model would be sent: the tools offered, the model asked for,
// the size of the instructions. For 1 and 2 no model is needed (the script answers "ok"). For 3 the
// request is passed on to a real model (any OpenAI-style server, e.g. Ollama on this computer), its
// first move is written down, and Sara is still answered "ok": no tool ever runs, nothing is sent
// anywhere, and the chosen tool is never carried out.
//
//   node scripts/eval-tools.ts                      offer and route only (no model, about a minute)
//   node scripts/eval-tools.ts --model qwen3:8b     also ask a real model (Ollama on this computer)
//        [--upstream http://127.0.0.1:11434/v1] [--ctx 32768] [--only id,id] [--list-tools] [--out outputs/tool-evals/<date>]
//   node scripts/eval-tools.ts --embed nomic-embed-text   with tools also picked by meaning (src/tool-meaning.ts)
//   A key for a hosted model is read from the EVAL_API_KEY environment variable (never written out).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CASES, type EvalCase } from './eval-tools-cases.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The models named in the throwaway settings: which one a request asks for tells the route. */
export const ROUTE_MODELS = { chat: 'eval-chat', research: 'eval-research', coding: 'eval-coding', quick: 'eval-quick', background: 'eval-background' } as const;
export type RouteName = keyof typeof ROUTE_MODELS;
export const routeOfModel = (model: string): RouteName | 'other' => (Object.entries(ROUTE_MODELS).find(([, m]) => m === model)?.[0] as RouteName | undefined) ?? 'other';

export interface Seen {
  model: string;
  tools: string[];
  /** Characters of the tool list as sent (names, descriptions, schemas). */
  toolChars: number;
  /** Characters of the instructions (system messages). */
  systemChars: number;
}

/** What a model did first: the tools it called (in order) and whether it wrote words. */
export interface Move {
  calls: string[];
  text: string;
}

export type Verdict = 'right' | 'looked' | 'wrong' | 'none' | 'error';

export interface CaseResult {
  id: string;
  text: string;
  want: string[];
  /** 1. Was a wanted tool offered? ('n/a' when the case wants no tool.) */
  offered: boolean | 'n/a';
  /** 2. The route taken, and whether it is the one the case expects. */
  route: string;
  routeOk: boolean | 'n/a';
  seen?: Seen;
  /** 3. With a model: what it did and how that counts. */
  move?: Move;
  verdict?: Verdict;
  ms?: number;
  error?: string;
}

/** Reads an OpenAI-style streamed (or plain) answer: the tool calls by index, and the words. */
export function readMove(body: string): Move {
  const names = new Map<number, string>();
  let text = '';
  const take = (choice: { delta?: { content?: unknown; tool_calls?: { index?: number; function?: { name?: string } }[] }; message?: { content?: unknown; tool_calls?: { function?: { name?: string } }[] } } | undefined) => {
    const d = choice?.delta ?? choice?.message;
    if (!d) return;
    if (typeof d.content === 'string') text += d.content;
    (d.tool_calls ?? []).forEach((c, i) => {
      const at = (c as { index?: number }).index ?? i;
      if (c.function?.name) names.set(at, (names.get(at) ?? '') + c.function.name);
    });
  };
  const lines = body.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (lines.length) {
    for (const l of lines) {
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        take((JSON.parse(data) as { choices?: never[] }).choices?.[0]);
      } catch {
        /* a broken line is skipped */
      }
    }
  } else {
    try {
      take((JSON.parse(body) as { choices?: never[] }).choices?.[0]);
    } catch {
      /* not JSON: no move */
    }
  }
  return { calls: [...names.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n), text: text.trim() };
}

/**
 * How a model's first move counts.
 * - right:  it called a wanted tool (or, for a case that wants none, called nothing).
 * - looked: it asked for more tools (find_tools) instead: slower, not wrong.
 * - none:   a tool was wanted and it only wrote words.
 * - wrong:  it called something else (or called a tool when none was wanted).
 */
export function grade(c: Pick<EvalCase, 'want' | 'alsoFine'>, move: Move): Verdict {
  const fine = new Set([...c.want, ...(c.alsoFine ?? [])]);
  if (!c.want.length) return move.calls.length && !move.calls.every((n) => fine.has(n)) ? 'wrong' : 'right';
  if (move.calls.some((n) => fine.has(n))) return 'right';
  if (!move.calls.length) return 'none';
  return move.calls.every((n) => n === 'find_tools') ? 'looked' : 'wrong';
}

export interface Summary {
  cases: number;
  offer: { asked: number; offered: number };
  route: { asked: number; right: number };
  choice?: Record<Verdict, number>;
  /** The model's first move was right, split by whether the wanted tool was in the list: [right, cases]. */
  rightWhen?: { offered: [number, number]; notOffered: [number, number] };
  /** The held-out cases alone (ids starting with h-): never tuned on. */
  heldOut: { offer: { asked: number; offered: number }; route: { asked: number; right: number } };
  /** The fresh cases alone (ids starting with f-): written after picking by meaning was set, run as found. */
  fresh: { offer: { asked: number; offered: number } };
  toolsOffered: { median: number; max: number };
  toolChars: { median: number };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

export function summarize(results: CaseResult[]): Summary {
  const offer = results.filter((r) => r.offered !== 'n/a');
  const route = results.filter((r) => r.routeOk !== 'n/a');
  const judged = results.filter((r) => r.verdict);
  const choice = judged.length ? ({ right: 0, looked: 0, wrong: 0, none: 0, error: 0 } as Record<Verdict, number>) : undefined;
  for (const r of judged) choice![r.verdict!]++;
  const seen = results.map((r) => r.seen).filter((s): s is Seen => Boolean(s));
  return {
    cases: results.length,
    offer: { asked: offer.length, offered: offer.filter((r) => r.offered === true).length },
    route: { asked: route.length, right: route.filter((r) => r.routeOk === true).length },
    ...(choice ? { choice } : {}),
    ...(choice
      ? {
          rightWhen: {
            offered: [judged.filter((r) => r.offered === true && r.verdict === 'right').length, judged.filter((r) => r.offered === true).length],
            notOffered: [judged.filter((r) => r.offered === false && r.verdict === 'right').length, judged.filter((r) => r.offered === false).length],
          },
        }
      : {}),
    heldOut: {
      offer: { asked: offer.filter((r) => r.id.startsWith('h-')).length, offered: offer.filter((r) => r.id.startsWith('h-') && r.offered === true).length },
      route: { asked: route.filter((r) => r.id.startsWith('h-')).length, right: route.filter((r) => r.id.startsWith('h-') && r.routeOk === true).length },
    },
    fresh: { offer: { asked: offer.filter((r) => r.id.startsWith('f-')).length, offered: offer.filter((r) => r.id.startsWith('f-') && r.offered === true).length } },
    toolsOffered: { median: median(seen.map((s) => s.tools.length)), max: Math.max(0, ...seen.map((s) => s.tools.length)) },
    toolChars: { median: median(seen.map((s) => s.toolChars)) },
  };
}

const pct = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

export function report(results: CaseResult[], meta: { version: string; model?: string; at: string; embed?: string }): string {
  const s = summarize(results);
  const out: string[] = [];
  out.push(`# Tool and routing evals`, '', `Sara ${meta.version} · ${meta.at}${meta.model ? ` · model: ${meta.model}` : ' · no model (offer and route only)'}${meta.embed ? ` · tools also picked by meaning (${meta.embed})` : ''}`, '');
  out.push(`- **Offer:** the tool for the job was in the list sent to the model in ${s.offer.offered} of ${s.offer.asked} cases (${pct(s.offer.offered, s.offer.asked)}).`);
  out.push(`- **Route:** the message went to the expected model in ${s.route.right} of ${s.route.asked} cases (${pct(s.route.right, s.route.asked)}).`);
  if (s.choice) {
    const n = Object.values(s.choice).reduce((a, b) => a + b, 0);
    out.push(`- **Choice:** the model's first move was right in ${s.choice.right} of ${n} (${pct(s.choice.right, n)}); it looked for tools first in ${s.choice.looked}, called something else in ${s.choice.wrong}, only wrote words in ${s.choice.none}, failed in ${s.choice.error}.`);
    if (s.rightWhen) out.push(`- **Where it goes wrong:** with the tool in the list the model was right in ${s.rightWhen.offered[0]} of ${s.rightWhen.offered[1]} (${pct(...s.rightWhen.offered)}); without it, in ${s.rightWhen.notOffered[0]} of ${s.rightWhen.notOffered[1]} (${pct(...s.rightWhen.notOffered)}).`);
  }
  if (s.heldOut.offer.asked) out.push(`- **Held-out cases** (never tuned on): offered in ${s.heldOut.offer.offered} of ${s.heldOut.offer.asked} (${pct(s.heldOut.offer.offered, s.heldOut.offer.asked)}); routed as expected in ${s.heldOut.route.right} of ${s.heldOut.route.asked}.`);
  if (s.fresh.offer.asked) out.push(`- **Fresh cases** (written last, run as found): offered in ${s.fresh.offer.offered} of ${s.fresh.offer.asked} (${pct(s.fresh.offer.offered, s.fresh.offer.asked)}).`);
  out.push(`- **Size:** ${s.toolsOffered.median} tools offered on a typical turn (most: ${s.toolsOffered.max}); the tool list is about ${Math.round(s.toolChars.median / 4).toLocaleString('en-US')} tokens.`, '');
  const bad = results.filter((r) => r.offered === false || r.routeOk === false || (r.verdict && r.verdict !== 'right') || r.error);
  if (bad.length) {
    out.push('## Worth a look', '', '| Case | Message | Wanted | What happened |', '|---|---|---|---|');
    for (const r of bad) {
      const what = [r.error ? `error: ${r.error}` : '', r.offered === false ? 'not offered' : '', r.routeOk === false ? `went to ${r.route}` : '', r.verdict && r.verdict !== 'right' ? `model: ${r.verdict}${r.move?.calls.length ? ` (${r.move.calls.join(', ')})` : ''}` : ''].filter(Boolean).join('; ');
      out.push(`| ${r.id} | ${r.text.replace(/\|/g, '/').slice(0, 80)} | ${r.want.join(' or ') || 'no tool'} | ${what} |`);
    }
    out.push('');
  }
  out.push('## Every case', '', '| Case | Offered | Route | Model |', '|---|---|---|---|');
  for (const r of results) out.push(`| ${r.id} | ${r.offered === 'n/a' ? '-' : r.offered ? 'yes' : 'NO'} | ${r.route}${r.routeOk === false ? ' (unexpected)' : ''} | ${r.verdict ?? '-'}${r.move?.calls.length ? ` (${r.move.calls.join(', ')})` : ''} |`);
  return `${out.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------
// The run (only when started as a script)
// ------------------------------------------------------------------------------------------------

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });

const okStream = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;

interface Waiting {
  marker: string;
  done: (r: { seen: Seen; move?: Move; error?: string }) => void;
}

async function main(): Promise<void> {
  const { values: opt } = parseArgs({
    options: { model: { type: 'string' }, upstream: { type: 'string', default: 'http://127.0.0.1:11434/v1' }, only: { type: 'string' }, out: { type: 'string' }, 'list-tools': { type: 'boolean' }, 'turn-seconds': { type: 'string', default: '180' }, ctx: { type: 'string', default: '32768' }, embed: { type: 'string' }, 'embed-upstream': { type: 'string', default: 'http://127.0.0.1:11434/v1' } },
  });
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  const at = new Date().toISOString();
  const outDir = resolve(opt.out ?? join(ROOT, 'outputs', 'tool-evals', at.slice(0, 10)));
  const only = opt.only ? new Set(opt.only.split(',').map((s) => s.trim())) : undefined;
  const cases = CASES.filter((c) => !only || only.has(c.id));
  const TURN_MS = Number(opt['turn-seconds']) * 1000;
  const key = process.env.EVAL_API_KEY;
  /** The Ollama daemon's own address when the model server is one (its usual port). */
  const ollama = opt.model && /:11434(\/v1)?\/?$/.test(opt.upstream!) ? opt.upstream!.replace(/\/v1\/?$/, '').replace(/\/+$/, '') : undefined;

  // The stand-in model provider: sees every request Sara makes.
  let waiting: Waiting | undefined;
  const provider: Server = createServer((req, res) => {
    void (async () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ data: Object.values(ROUTE_MODELS).map((id) => ({ id })) }));
      }
      if (req.url?.endsWith('/embeddings') && opt.embed) {
        // --embed: her "Meaning search" job points here; the vectors come from the real embedding model.
        const up = await fetch(`${opt['embed-upstream']!.replace(/\/+$/, '')}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(JSON.parse(await readBody(req)) as object), model: opt.embed }) });
        res.writeHead(up.status, { 'content-type': 'application/json' });
        return void res.end(await up.text());
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return void res.end('{"error":"not here"}');
      }
      const raw = await readBody(req);
      let body: { model?: string; messages?: { role: string; content: unknown }[]; tools?: { function?: { name?: string } }[] };
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      const w = waiting;
      // The turn itself: the first request that carries this case's message. Everything else
      // (titles, memory notes) is answered "ok" and not counted.
      const isTurn = w && JSON.stringify(body.messages ?? []).includes(w.marker);
      let move: Move | undefined;
      let error: string | undefined;
      if (isTurn) {
        waiting = undefined;
        const seen: Seen = {
          model: String(body.model ?? ''),
          tools: (body.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean),
          toolChars: JSON.stringify(body.tools ?? []).length,
          systemChars: (body.messages ?? []).filter((m) => m.role === 'system').reduce((n, m) => n + String(m.content ?? '').length, 0),
        };
        if (opt.model) {
          try {
            // Ollama: its own endpoint, because only there can the context size be set (its OpenAI-style
            // endpoint would cut her instructions off at the daemon's default).
            const up = ollama
              ? await fetch(`${ollama}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: opt.model, messages: body.messages, tools: body.tools, stream: false, options: { num_ctx: Number(opt.ctx) } }), signal: AbortSignal.timeout(TURN_MS) })
              : await fetch(`${opt.upstream!.replace(/\/+$/, '')}/chat/completions`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
                  body: JSON.stringify({ ...body, model: opt.model, stream: true }),
                  signal: AbortSignal.timeout(TURN_MS),
                });
            const text = ollama && up.ok ? JSON.stringify({ choices: [{ message: ((await up.json()) as { message?: unknown }).message }] }) : await up.text();
            if (!up.ok) error = `model server answered ${up.status}: ${text.slice(0, 200)}`;
            else move = readMove(text);
          } catch (e) {
            error = `model server: ${(e as Error).message}`;
          }
        }
        w!.done({ seen, ...(move ? { move } : {}), ...(error ? { error } : {}) });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(okStream('ok'));
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok));
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;

  // The throwaway Sara.
  const data = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'sara-tool-eval-'));
  const route = (model: string) => ({ providerId: 'eval', model });
  writeFileSync(
    join(data, 'settings.json'),
    JSON.stringify({
      providers: [{ id: 'eval', label: 'Eval', kind: 'openai-compatible', baseUrl: providerUrl, defaultModel: ROUTE_MODELS.chat }],
      defaultProviderId: 'eval',
      defaultModel: ROUTE_MODELS.chat,
      autoJobs: [],
      // Web search on, so its tools are hers to offer (the address is this script; no tool ever runs).
      search: { provider: 'searxng', url: providerUrl },
      routes: { research: route(ROUTE_MODELS.research), coding: route(ROUTE_MODELS.coding), quick: route(ROUTE_MODELS.quick), background: route(ROUTE_MODELS.background), ...(opt.embed ? { embeddings: route(opt.embed) } : {}) },
      ownerName: 'Alex',
      timeZone: 'America/Chicago',
      disclosureAcceptedAt: at,
      setupDone: true,
    }),
  );
  const port = await new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
  let log = '';
  const sara: ChildProcess = spawn(process.execPath, [join(ROOT, 'src', 'main.ts')], {
    cwd: ROOT,
    // No check-ins with the hub or the store while this runs.
    env: { ...process.env, SARA_DATA: data, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_HUB_FIRST_MS: '999999999', SARA_STORE_FIRST_MS: '999999999', SARA_STOP_ON_STDIN_END: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  sara.stdout!.on('data', (c: Buffer) => (log += c.toString()));
  sara.stderr!.on('data', (c: Buffer) => (log += c.toString()));
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    sara.kill();
    await new Promise((ok) => setTimeout(ok, 800));
    provider.close();
    try {
      rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      console.warn(`could not delete ${data}`);
    }
  };
  try {
    const t0 = Date.now();
    for (;;) {
      if (sara.exitCode !== null) throw new Error(`Sara stopped while starting:\n${log.slice(-2000)}`);
      if (existsSync(join(data, 'first-token.txt')) && (await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) break;
      if (Date.now() - t0 > 90_000) throw new Error(`Sara did not start in 90 seconds:\n${log.slice(-2000)}`);
      await new Promise((ok) => setTimeout(ok, 300));
    }
    const token = readFileSync(join(data, 'first-token.txt'), 'utf8').trim();
    const api = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
      const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${String(j.error ?? '')}`);
      return j;
    };

    if (opt['list-tools']) {
      // Every tool she has here (name and what it says it does), for writing cases.
      const all = (await api('GET', '/tools')) as { tools?: { name: string; description?: string }[] };
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, 'tools.json'), JSON.stringify(all.tools ?? [], null, 1));
      for (const t of all.tools ?? []) console.log(`${t.name.padEnd(28)} ${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    const results: CaseResult[] = [];
    for (const c of cases) {
      const started = Date.now();
      const conv = String((await api('POST', '/conversations', c.coding ? { mode: 'coding' } : {})).id);
      const got = new Promise<{ seen: Seen; move?: Move; error?: string }>((done) => (waiting = { marker: JSON.stringify(c.text).slice(1, -1), done }));
      const turn = fetch(`${base}/api/conversations/${conv}/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ content: c.text }), signal: AbortSignal.timeout(TURN_MS + 30_000) })
        .then((r) => r.text())
        .catch((e: Error) => `turn failed: ${e.message}`);
      const r = await Promise.race([got, turn.then((t) => ({ error: `the turn ended without a model request (${t.slice(0, 160).replace(/\s+/g, ' ')})` }) as { seen?: Seen; move?: Move; error?: string })]);
      await turn;
      waiting = undefined;
      const seen = r.seen;
      const routeName = seen ? routeOfModel(seen.model) : 'other';
      const res: CaseResult = {
        id: c.id,
        text: c.text,
        want: c.want,
        offered: !c.want.length ? 'n/a' : Boolean(seen && c.want.some((n) => seen.tools.includes(n))),
        route: routeName,
        routeOk: c.route ? routeName === c.route : 'n/a',
        ...(seen ? { seen } : {}),
        ...(r.move ? { move: r.move, verdict: grade(c, r.move) } : opt.model && r.error ? { verdict: 'error' as const } : {}),
        ...(r.error ? { error: r.error } : {}),
        ms: Date.now() - started,
      };
      results.push(res);
      console.log(`${res.id.padEnd(28)} offered:${String(res.offered).padEnd(5)} route:${res.route.padEnd(9)}${res.verdict ? ` model:${res.verdict}${res.move?.calls.length ? ` (${res.move.calls.join(', ')})` : ''}` : ''}${res.error ? `  ! ${res.error}` : ''}`);
      if (opt['list-tools'] && seen) {
        console.log(seen.tools.join(' '));
        break;
      }
    }
    mkdirSync(outDir, { recursive: true });
    const name = (opt.model ? `results-${opt.model.replace(/[^\w.-]+/g, '_')}` : 'results-offer') + (opt.embed ? '-meaning' : '');
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ version, at, model: opt.model ?? null, embed: opt.embed ?? null, summary: summarize(results), results }, null, 1));
    const md = report(results, { version, at, ...(opt.model ? { model: opt.model } : {}), ...(opt.embed ? { embed: opt.embed } : {}) });
    writeFileSync(join(outDir, `${name.replace('results', 'report')}.md`), md);
    console.log(`\n${md.split('\n## ')[0]}`);
    console.log(`Written to ${outDir}`);
  } finally {
    await stop();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}

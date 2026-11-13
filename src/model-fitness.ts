// E7 (docs/design/EVERYDAY.md, docs/CHOOSING_A_MODEL.md "Is my model right for this computer?"):
// a small check of the talking model against this hardware. A local model bigger than 3 billion
// parameters on a computer without a graphics card answers in minutes; the last few chat turns'
// timing says how slow it really is here; a model without tool support can't do computer use,
// documents or shopping. The check only reads (the runs table, Ollama's /api/ps and /api/show,
// the connected model lists); a faster choice changes the chat route only when the person clicks
// "Use this" (Settings → Models, the full check), with Undo. Nothing switches by itself.
import type { DatabaseSync } from 'node:sqlite';
import { resolveChain, type AppContext } from './chat.ts';
import { isOllamaDaemon, noteOllamaPs } from './model-context.ts';
import { isCloudModelName, EMBED_MODEL_NAME } from './model-names.ts';
import { connectedModels, modelSizeB, type Candidate } from './modelpicks.ts';
import { netFetch } from './net-guard.ts';
import type { Conversation } from './store.ts';
import { suggestModel } from '../web/model-suggest.js';

/** Replies slower than this (median of the last turns) get the notice. */
export const SLOW_MEDIAN_MS = 30_000;
/** At least this many recent turns before timing counts. */
export const MIN_TURNS = 3;
/** How many recent turns are looked at. */
export const LAST_TURNS = 10;
/** On the processor, models up to this size (billions of parameters) are still usable. */
export const CPU_OK_B = 3;

export interface TurnTime {
  /** Time to the first streamed word (ms), when known. */
  firstMs?: number;
  /** The model call's whole time (ms). */
  totalMs: number;
}

export interface FitnessInput {
  model: string;
  /** The model runs on an Ollama daemon (not Ollama Cloud, not a cloud service). */
  onDaemon: boolean;
  /** Where that daemon runs it ('unknown' for cloud models). */
  hw: 'gpu' | 'cpu' | 'unknown';
  /** Billions of parameters (Ollama /api/show, else the tag), when known. */
  paramsB?: number;
  turns: TurnTime[];
  /** Ollama /api/show capabilities: true/false when known. */
  tools?: boolean;
}

export type FitnessReason = 'cpu-big' | 'slow-replies' | 'no-tools';

export interface Fitness {
  reasons: FitnessReason[];
  /** Median whole reply time of the recent turns (seconds), when there are enough. */
  medianS?: number;
  medianFirstS?: number;
  turns: number;
}

export function median(xs: number[]): number | undefined {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The rules: big local model on the processor, slow recent replies, no tool support. */
export function rateFitness(i: FitnessInput): Fitness {
  const reasons: FitnessReason[] = [];
  if (i.onDaemon && i.hw === 'cpu' && (i.paramsB ?? 0) > CPU_OK_B) reasons.push('cpu-big');
  const turns = i.turns.slice(0, LAST_TURNS);
  const total = turns.length >= MIN_TURNS ? median(turns.map((x) => x.totalMs)) : undefined;
  const first = turns.length >= MIN_TURNS ? median(turns.filter((x) => x.firstMs !== undefined).map((x) => x.firstMs!)) : undefined;
  if (total !== undefined && total > SLOW_MEDIAN_MS) reasons.push('slow-replies');
  if (i.tools === false) reasons.push('no-tools');
  return { reasons, turns: turns.length, ...(total !== undefined ? { medianS: Math.round(total / 1000) } : {}), ...(first !== undefined ? { medianFirstS: Math.round(first / 1000) } : {}) };
}

/** Ollama /api/show details.parameter_size ("4.0B", "671M") in billions. */
export function paramsFromShow(body: unknown): number | undefined {
  const s = (body as { details?: { parameter_size?: unknown } } | undefined)?.details?.parameter_size;
  const m = typeof s === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*([BMK])/i.exec(s) : null;
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2].toUpperCase() === 'B' ? n : m[2].toUpperCase() === 'M' ? n / 1000 : n / 1e6;
}

/** Ollama /api/show capabilities: does it list "tools" (undefined when the answer has no list). */
export function toolsFromShow(body: unknown): boolean | undefined {
  const c = (body as { capabilities?: unknown } | undefined)?.capabilities;
  return Array.isArray(c) ? c.includes('tools') : undefined;
}

/**
 * The last turns' timing for one model, from the runs table: each chat turn's first model call
 * (the main call, not a safety check or judge) with its time to first word and whole time.
 */
export function recentTurns(db: DatabaseSync, providerId: string, model: string, n = LAST_TURNS): TurnTime[] {
  const out: TurnTime[] = [];
  try {
    const rows = db
      .prepare("SELECT s.calls AS calls FROM runs r JOIN run_steps s ON s.run_id = r.id AND s.idx = 0 WHERE r.kind = 'turn' AND r.status = 'ok' AND s.calls IS NOT NULL ORDER BY r.id DESC LIMIT 200")
      .all() as { calls: string }[];
    for (const row of rows) {
      let calls: { model?: string; providerId?: string; purpose?: string; ms?: number; firstMs?: number; ok?: boolean }[];
      try {
        calls = JSON.parse(row.calls);
      } catch {
        continue;
      }
      const c = Array.isArray(calls) ? calls.find((x) => !x.purpose && x.ok !== false) : undefined;
      if (!c || c.providerId !== providerId || c.model !== model || typeof c.ms !== 'number') continue;
      out.push({ totalMs: c.ms, ...(typeof c.firstMs === 'number' ? { firstMs: c.firstMs } : {}) });
      if (out.length >= n) break;
    }
  } catch {
    /* no runs table yet */
  }
  return out;
}

export interface Choice {
  providerId: string;
  model: string;
  provider: string;
  /** 'cloud': Ollama Cloud through the local Ollama · 'service': a cloud service with a key or plan · 'small': a small model on this computer. */
  kind: 'cloud' | 'service' | 'small';
}

const NOT_CHAT = /embed|bge-|\be5-|gte-|minilm|caption|whisper|tts|rerank|guard|image|imagine|ocr/i;

/**
 * Faster (or tool-capable) choices from what is connected: Ollama Cloud models first, then one
 * pick per cloud service, then (on the processor, when tools aren't the problem) a small local
 * model. At most three; never the current model.
 */
export function fasterChoices(cands: (Candidate & { daemon?: boolean })[], current: { providerId: string; model: string }, o: { needTools: boolean; cpu: boolean }): Choice[] {
  const ok = cands.filter((c) => !NOT_CHAT.test(c.model) && !EMBED_MODEL_NAME.test(c.model) && !(c.providerId === current.providerId && c.model === current.model));
  const out: Choice[] = [];
  const cloud = ok.filter((c) => c.daemon && isCloudModelName(c.model));
  const best = suggestModel(cloud.map((c) => c.model));
  for (const c of [...cloud.filter((x) => x.model === best), ...cloud.filter((x) => x.model !== best)].slice(0, 2)) out.push({ providerId: c.providerId, model: c.model, provider: c.provider, kind: 'cloud' });
  const services = [...new Set(ok.filter((c) => !c.local && !c.daemon).map((c) => c.providerId))];
  for (const pid of services) {
    const list = ok.filter((c) => c.providerId === pid);
    const m = suggestModel(list.map((c) => c.model));
    const c = list.find((x) => x.model === m);
    if (c) out.push({ providerId: c.providerId, model: c.model, provider: c.provider, kind: 'service' });
  }
  if (o.cpu && !o.needTools) {
    const small = ok.filter((c) => c.local && !isCloudModelName(c.model) && (modelSizeB(c.model) ?? 99) <= CPU_OK_B).sort((a, b) => (modelSizeB(b.model) ?? 0) - (modelSizeB(a.model) ?? 0))[0];
    if (small) out.push({ providerId: small.providerId, model: small.model, provider: small.provider, kind: 'small' });
  }
  return out.slice(0, 3);
}

export interface FitnessView extends Fitness {
  providerId: string;
  provider: string;
  model: string;
  hw: 'gpu' | 'cpu' | 'unknown';
  paramsB?: number;
  tools?: boolean;
  choices: Choice[];
}

export interface FitnessDeps {
  /** Ollama POST /api/show for a model (tests pass a fake). */
  show?: (root: string, model: string) => Promise<unknown>;
  /** Ollama GET /api/ps (tests pass a fake). */
  ps?: (root: string) => Promise<unknown>;
  /** The connected models (tests pass a list). */
  candidates?: () => Promise<Candidate[]>;
}

const CHAT_CONV = { id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' } as unknown as Conversation;
const rootOf = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');

async function showModel(root: string, model: string): Promise<unknown> {
  const r = await netFetch(`${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
  return r.ok ? r.json() : undefined;
}

async function readPs(root: string): Promise<unknown> {
  const r = await netFetch(`${root}/api/ps`, { signal: AbortSignal.timeout(3000) });
  return r.ok ? r.json() : undefined;
}

/** The check for the talking model (undefined when no model is set up). */
export async function modelFitness(app: AppContext, deps: FitnessDeps = {}): Promise<FitnessView | undefined> {
  let pick;
  try {
    pick = resolveChain(app, CHAT_CONV, 'turn', false, true)[0];
  } catch {
    return undefined;
  }
  if (!pick) return undefined;
  const config = pick.provider.config;
  const model = pick.model;
  // An Ollama on another port counts once the model lists found it (its /api/version answered).
  const daemon = isOllamaDaemon(config) || Boolean(app.modelCatalog?.isDaemon(config));
  const onDaemon = daemon && !isCloudModelName(model);
  let hw: FitnessView['hw'] = 'unknown';
  let paramsB: number | undefined;
  let tools: boolean | undefined;
  if (daemon) {
    // Where the daemon runs it now: its own /api/ps (the dry pick has no provider to ask).
    if (onDaemon) {
      try {
        const ps = await (deps.ps ?? readPs)(rootOf(config.baseUrl));
        if (ps !== undefined) noteOllamaPs(config.baseUrl, ps);
      } catch {
        /* the last answer stays */
      }
    }
    if (onDaemon && app.modelContext) hw = app.modelContext.hardware(config, model).kind;
    try {
      const body = await (deps.show ?? showModel)(rootOf(config.baseUrl), model);
      paramsB = paramsFromShow(body);
      tools = toolsFromShow(body);
    } catch {
      /* not answered: the tag says the size */
    }
  }
  paramsB ??= onDaemon ? modelSizeB(model) : undefined;
  const turns = recentTurns(app.store.db, config.id, model);
  const f = rateFitness({ model, onDaemon, hw, ...(paramsB !== undefined ? { paramsB } : {}), turns, ...(tools !== undefined ? { tools } : {}) });
  let choices: Choice[] = [];
  if (f.reasons.length) {
    const s = app.settings.get();
    const cands = await (deps.candidates ?? (() => connectedModels(app)))().catch(() => [] as Candidate[]);
    const cfgOf = (id: string) => s.providers.find((p) => p.id === id);
    const marked = cands.map((c) => {
      const p = cfgOf(c.providerId);
      return { ...c, daemon: Boolean(p && (isOllamaDaemon(p) || app.modelCatalog?.isDaemon(p))) };
    });
    choices = fasterChoices(marked, { providerId: config.id, model }, { needTools: f.reasons.includes('no-tools'), cpu: hw === 'cpu' });
  }
  return { ...f, providerId: config.id, provider: config.label, model, hw, ...(paramsB !== undefined ? { paramsB } : {}), ...(tools !== undefined ? { tools } : {}), choices };
}

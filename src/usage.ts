// Phase 52: the cost and token meter. Every model call that reports its token counts is recorded
// (tokens in / out / cached, provider, model, what it was for, the conversation, job or team run).
// Costs are an estimate from a per-model price table the owner can edit. Local models and
// subscriptions are never given a price: they show as "local" and "$0 (subscription)".
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import type { Budget } from './budget.ts';
import { hub } from './telemetry/hub.ts';
import { SUBSCRIPTION_KINDS, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent } from './providers/types.ts';

/** How a call is paid for. */
export type Billing = 'api' | 'local' | 'subscription';

/** What a call was for (the route purpose, or the kind of work around it). */
export type UsagePurpose = string;

/**
 * Where a call happens. Set with `usageScope.run(scope, fn)` around a job, a team run or a
 * background worker; calls inside it are attributed to it, and its totals grow as they come in.
 */
export interface UsageScope {
  purpose?: UsagePurpose;
  conversationId?: string;
  jobId?: number;
  teamTaskId?: number;
  /** Running totals of the calls made inside this scope (filled in by the meter). */
  tokens?: number;
  usd?: number;
  /** Calls inside the scope that reported their usage / that didn't. */
  reported?: number;
  unreported?: number;
  /** Phase 78: the run being recorded (jobs, team runs): its id goes on the usage rows. */
  runId?: number;
  /** Phase 78: told about every call in the scope (the run recorder's step list). */
  onCall?: (c: CallInfo) => void;
}

/** Phase 78: one provider call as the meter saw it (for the run recorder, src/runs.ts). */
export interface CallInfo {
  model: string;
  provider: string;
  providerId: string;
  in: number;
  out: number;
  cached: number;
  /** null = cost unknown (no price, or no usage reported). */
  usd: number | null;
  /** How the call is paid for (local and subscription calls are $0, not "unknown"). */
  billing: Billing;
  reported: boolean;
  ms: number;
  firstMs?: number;
  ok: boolean;
  error?: string;
}
export const usageScope = new AsyncLocalStorage<UsageScope>();

/** One price row: US dollars per million tokens. `cachedIn` defaults to the input price. */
export interface PriceRow {
  model: string;
  /** Only for this provider id (else any API provider with this model name). */
  providerId?: string;
  inPerM: number;
  outPerM: number;
  cachedInPerM?: number;
  /** Where the price comes from (shown in Settings). */
  source?: string;
}

/**
 * Default prices: only public list prices (standard tier, USD per 1M tokens) checked on the
 * providers' own pricing pages on 2026-10-27:
 * - OpenAI: https://developers.openai.com/api/docs/pricing (Flagship models, Standard)
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (Model pricing; "Hits and
 *   refreshes" = cached input). Claude Haiku 5.5 is left out: its price depends on prompt length.
 * - xAI: https://docs.x.ai/developers/models (Grok 4.7; no cached price listed there)
 * Anything else (OpenRouter, Ollama Cloud, other models) is "unknown" until the owner adds a price:
 * the meter then shows tokens only.
 */
export const DEFAULT_PRICES: readonly PriceRow[] = [
  { model: 'gpt-6-astra', inPerM: 10, outPerM: 50, cachedInPerM: 1, source: 'OpenAI pricing page, 2026-10-27' },
  { model: 'gpt-6.1-sol', inPerM: 2, outPerM: 10, cachedInPerM: 0.1, source: 'OpenAI pricing page, 2026-10-27' },
  { model: 'gpt-6.1-terra', inPerM: 1, outPerM: 5, cachedInPerM: 0.05, source: 'OpenAI pricing page, 2026-10-27' },
  { model: 'gpt-6-luna', inPerM: 0.1, outPerM: 0.5, cachedInPerM: 0.01, source: 'OpenAI pricing page, 2026-10-27' },
  { model: 'claude-fable-5-1', inPerM: 10, outPerM: 50, cachedInPerM: 0.25, source: 'Anthropic pricing page, 2026-10-27' },
  { model: 'claude-opus-5-5', inPerM: 4, outPerM: 20, cachedInPerM: 0.2, source: 'Anthropic pricing page, 2026-10-27' },
  { model: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10, cachedInPerM: 0.1, source: 'Anthropic pricing page, 2026-10-27' },
  { model: 'grok-4.7', inPerM: 2, outPerM: 6, source: 'xAI models page, 2026-10-27' },
];

/** Cleans the owner's price table (Settings → Data & health → Usage). */
export function cleanPrices(v: unknown): PriceRow[] {
  if (!Array.isArray(v)) throw new Error('prices must be a list.');
  if (v.length > 200) throw new Error('Up to 200 prices.');
  const n = (x: unknown, what: string, model: string) => {
    const k = Number(x);
    if (!Number.isFinite(k) || k < 0 || k > 10_000) throw new Error(`${model}: the ${what} price must be a number of dollars per million tokens (0 to 10000).`);
    return Math.round(k * 10_000) / 10_000;
  };
  const out: PriceRow[] = [];
  for (const raw of v) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const model = String(r.model ?? '').trim().slice(0, 200);
    if (!model) continue;
    const row: PriceRow = { model, inPerM: n(r.inPerM, 'input', model), outPerM: n(r.outPerM, 'output', model) };
    if (r.cachedInPerM !== undefined && r.cachedInPerM !== null && r.cachedInPerM !== '') row.cachedInPerM = n(r.cachedInPerM, 'cached input', model);
    if (r.providerId) row.providerId = String(r.providerId).slice(0, 41);
    if (r.source) row.source = String(r.source).slice(0, 120);
    if (out.some((o) => o.model.toLowerCase() === model.toLowerCase() && (o.providerId ?? '') === (row.providerId ?? ''))) continue;
    out.push(row);
  }
  return out;
}

/** The price table in use: the owner's own rows win over the defaults with the same model name. */
export function priceTable(own: PriceRow[] | undefined): PriceRow[] {
  const mine = own ?? [];
  return [...mine, ...DEFAULT_PRICES.filter((d) => !mine.some((m) => m.model.toLowerCase() === d.model.toLowerCase() && !m.providerId))];
}

/** A model name with a date stamp or tag on the end still matches its price ("gpt-6-luna-2026-09-01"). */
const bare = (m: string) => m.toLowerCase().replace(/[-@](\d{4}-?\d{2}-?\d{2}|latest)$/, '');

export function findPrice(table: PriceRow[], providerId: string, model: string): PriceRow | undefined {
  const m = model.toLowerCase();
  const b = bare(model);
  return table.find((p) => p.providerId === providerId && (p.model.toLowerCase() === m || p.model.toLowerCase() === b)) ?? table.find((p) => !p.providerId && (p.model.toLowerCase() === m || p.model.toLowerCase() === b));
}

/** Local = runs on the owner's hardware (marked local, or a model server on this machine / home network). */
export function billingOf(config: ProviderConfig): Billing {
  if (SUBSCRIPTION_KINDS.includes(config.kind)) return 'subscription';
  if (config.local) return 'local';
  try {
    const h = new URL(config.baseUrl).hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'local';
  } catch {
    /* keep api */
  }
  return 'api';
}

export interface UsageNumbers {
  input: number;
  output: number;
  cached?: number;
}

/** Dollars for one call, or null when the price is unknown. Local and subscription calls are $0. */
export function costOf(billing: Billing, price: PriceRow | undefined, u: UsageNumbers): number | null {
  if (billing !== 'api') return 0;
  if (!price) return null;
  const cached = Math.min(u.cached ?? 0, u.input);
  const usd = ((u.input - cached) * price.inPerM + cached * (price.cachedInPerM ?? price.inPerM) + u.output * price.outPerM) / 1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

export interface UsageRow {
  id: number;
  at: string;
  providerId: string;
  providerLabel: string;
  model: string;
  billing: Billing;
  purpose: string;
  conversationId: string | null;
  jobId: number | null;
  teamTaskId: number | null;
  input: number;
  output: number;
  cached: number;
  usd: number | null;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cached: number;
  tokens: number;
  /** Estimated dollars for the calls with a known price. */
  usd: number;
  /** Calls on a paid API whose price is unknown (their cost isn't in `usd`). */
  unpriced: number;
  /** Which kinds of billing are in here (so the app can say "local" or "$0 (subscription)"). */
  billing: Billing[];
}

type Row = Record<string, string | number | null>;

export class UsageStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  /** The price table (read on every call so Settings changes apply at once). */
  prices: () => PriceRow[] = () => priceTable(undefined);

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_label TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      billing TEXT NOT NULL,
      purpose TEXT NOT NULL,
      conversation_id TEXT,
      job_id INTEGER,
      team_task_id INTEGER,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      usd REAL
    );
    CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
    CREATE INDEX IF NOT EXISTS usage_conv ON usage(conversation_id);
    CREATE INDEX IF NOT EXISTS usage_job ON usage(job_id);
    CREATE INDEX IF NOT EXISTS usage_team ON usage(team_task_id);`);
    // Phase 78: which recorded run a call belongs to (additive).
    if (!(db.prepare('PRAGMA table_info(usage)').all() as Row[]).some((r) => r.name === 'run_id')) db.exec('ALTER TABLE usage ADD COLUMN run_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS usage_run ON usage(run_id)');
  }

  /** Records one call (and adds it to the running totals of the scope it happened in). */
  record(config: ProviderConfig, model: string, u: UsageNumbers, where: UsageScope & { purpose: string }): UsageRow {
    const billing = billingOf(config);
    const usd = costOf(billing, findPrice(this.prices(), config.id, model), u);
    const at = this.#now().toISOString();
    const clean = (n: unknown) => Math.max(0, Math.min(1e9, Math.round(Number(n) || 0)));
    const input = clean(u.input);
    const output = clean(u.output);
    const cached = clean(u.cached);
    const r = this.#db
      .prepare('INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, conversation_id, job_id, team_task_id, input, output, cached, usd, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, config.id, config.label.slice(0, 80), model.slice(0, 200), billing, where.purpose.slice(0, 40), where.conversationId ?? null, where.jobId ?? null, where.teamTaskId ?? null, input, output, cached, usd, where.runId || null);
    return { id: Number(r.lastInsertRowid), at, providerId: config.id, providerLabel: config.label, model, billing, purpose: where.purpose, conversationId: where.conversationId ?? null, jobId: where.jobId ?? null, teamTaskId: where.teamTaskId ?? null, input, output, cached, usd };
  }

  /**
   * C8: one paid tool call (a picture, an add-on that costs money) on the same ledger. Its row has
   * provider `tool`, the tool's name as the model and purpose `tool`; `usd` null = price unknown.
   */
  recordTool(name: string, usd: number | null, where: UsageScope = {}): UsageRow {
    const at = this.#now().toISOString();
    const cost = usd === null || !Number.isFinite(usd) ? null : Math.max(0, Math.min(10_000, usd));
    const r = this.#db
      .prepare("INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, conversation_id, job_id, team_task_id, input, output, cached, usd, run_id) VALUES (?, 'tool', 'Paid tool', ?, 'api', 'tool', ?, ?, ?, 0, 0, 0, ?, ?)")
      .run(at, name.slice(0, 200), where.conversationId ?? null, where.jobId ?? null, where.teamTaskId ?? null, cost, where.runId || null);
    const sc = usageScope.getStore();
    if (cost && sc) sc.usd = (sc.usd ?? 0) + cost;
    return { id: Number(r.lastInsertRowid), at, providerId: 'tool', providerLabel: 'Paid tool', model: name, billing: 'api', purpose: 'tool', conversationId: where.conversationId ?? null, jobId: where.jobId ?? null, teamTaskId: where.teamTaskId ?? null, input: 0, output: 0, cached: 0, usd: cost };
  }

  /** C8: dollars and tokens since a time (all rows), and the dollars of one paid tool. */
  spentSince(sinceIso: string, tool?: string): { usd: number; tokens: number; toolUsd: number } {
    const r = this.#db.prepare("SELECT COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(input + output),0) AS tokens, COALESCE(SUM(CASE WHEN provider_id = 'tool' AND purpose = 'tool' AND model = ? THEN usd ELSE 0 END),0) AS tool FROM usage WHERE at >= ?").get(tool ?? '', sinceIso) as Row;
    const round = (n: unknown) => Math.round(Number(n) * 1e6) / 1e6;
    return { usd: round(r.usd), tokens: Number(r.tokens), toolUsd: round(r.tool) };
  }

  #totals(where: string, args: (string | number)[]): UsageTotals {
    const r = this.#db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output, COALESCE(SUM(cached),0) AS cached, COALESCE(SUM(usd),0) AS usd, COALESCE(SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END),0) AS unpriced, GROUP_CONCAT(DISTINCT billing) AS billing FROM usage WHERE ${where}`).get(...args) as Row;
    const input = Number(r.input);
    const output = Number(r.output);
    return { calls: Number(r.calls), input, output, cached: Number(r.cached), tokens: input + output, usd: Math.round(Number(r.usd) * 1e6) / 1e6, unpriced: Number(r.unpriced), billing: String(r.billing ?? '').split(',').filter(Boolean) as Billing[] };
  }

  forConversation(id: string): UsageTotals {
    return this.#totals('conversation_id = ?', [id]);
  }

  forJob(id: number): UsageTotals {
    return this.#totals('job_id = ?', [id]);
  }

  forTeam(id: number): UsageTotals {
    return this.#totals('team_task_id = ?', [id]);
  }

  /** Totals since a time, by model and by purpose (Settings → Data & health → Usage). */
  summary(sinceIso: string): { total: UsageTotals; byModel: (UsageTotals & { providerId: string; providerLabel: string; model: string })[]; byPurpose: (UsageTotals & { purpose: string })[] } {
    const group = (cols: string) =>
      this.#db.prepare(`SELECT ${cols}, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached, COALESCE(SUM(usd),0) AS usd, SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END) AS unpriced, GROUP_CONCAT(DISTINCT billing) AS billing FROM usage WHERE at >= ? GROUP BY ${cols} ORDER BY SUM(input) + SUM(output) DESC LIMIT 50`).all(sinceIso) as Row[];
    const t = (r: Row): UsageTotals => ({ calls: Number(r.calls), input: Number(r.input), output: Number(r.output), cached: Number(r.cached), tokens: Number(r.input) + Number(r.output), usd: Math.round(Number(r.usd) * 1e6) / 1e6, unpriced: Number(r.unpriced), billing: String(r.billing ?? '').split(',').filter(Boolean) as Billing[] });
    return {
      total: this.#totals('at >= ?', [sinceIso]),
      byModel: group('provider_id, provider_label, model').map((r) => ({ ...t(r), providerId: String(r.provider_id), providerLabel: String(r.provider_label), model: String(r.model) })),
      byPurpose: group('purpose').map((r) => ({ ...t(r), purpose: String(r.purpose) })),
    };
  }

  /** For data export. */
  exportRows(): Row[] {
    return this.#db.prepare('SELECT * FROM usage ORDER BY id').all() as Row[];
  }

  /** Data import: rows already here (same time, model and numbers) are skipped. Returns how many were added. */
  importRows(rows: unknown, convExists: (id: string) => boolean): number {
    if (!Array.isArray(rows)) return 0;
    let n = 0;
    // Identical rows can be real (two calls in the same millisecond): a row is skipped only as many
    // times as it is already here, so a second import adds nothing.
    const seen = new Map<string, number>();
    for (const raw of rows.slice(0, 500_000)) {
      const r = (raw ?? {}) as Row;
      const at = String(r.at ?? '');
      const model = String(r.model ?? '').slice(0, 200);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !model) continue;
      const num = (x: unknown) => Math.max(0, Math.round(Number(x) || 0));
      const billing = ['api', 'local', 'subscription'].includes(String(r.billing)) ? String(r.billing) : 'api';
      const input = num(r.input);
      const output = num(r.output);
      const key = JSON.stringify([at, model, input, output, String(r.purpose ?? ''), String(r.provider_id ?? '')]);
      const k = (seen.get(key) ?? 0) + 1;
      seen.set(key, k);
      const here = Number((this.#db.prepare('SELECT COUNT(*) AS n FROM usage WHERE at = ? AND model = ? AND input = ? AND output = ? AND purpose = ? AND provider_id = ?').get(at, model, input, output, String(r.purpose ?? 'chat').slice(0, 40), String(r.provider_id ?? '').slice(0, 41)) as { n: number }).n);
      if (k <= here) continue;
      const conv = r.conversation_id && convExists(String(r.conversation_id)) ? String(r.conversation_id) : null;
      const usd = r.usd === null || r.usd === undefined || r.usd === '' ? null : Number(r.usd);
      this.#db
        .prepare('INSERT INTO usage (at, provider_id, provider_label, model, billing, purpose, conversation_id, job_id, team_task_id, input, output, cached, usd) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)')
        .run(at, String(r.provider_id ?? '').slice(0, 41), String(r.provider_label ?? '').slice(0, 80), model, billing, String(r.purpose ?? 'chat').slice(0, 40), conv, input, output, num(r.cached), Number.isFinite(usd) ? usd : null);
      n++;
    }
    return n;
  }
}

/**
 * Wraps a provider so the usage it reports is recorded. The `usage` events are taken out of the
 * stream (callers only see text and tool calls, as before).
 */
export type UsageSummary = ReturnType<UsageStore['summary']>;

/** Adds usage totals together (calls, tokens, dollars; billing kinds joined). */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, tokens: a.tokens + b.tokens, usd: Math.round((a.usd + b.usd) * 1e6) / 1e6, unpriced: a.unpriced + b.unpriced, billing: [...new Set([...a.billing, ...b.billing])] };
}
const NO_USAGE: UsageTotals = { calls: 0, input: 0, output: 0, cached: 0, tokens: 0, usd: 0, unpriced: 0, billing: [] };

/**
 * M11: one server-wide summary from every companion's meter (each companion keeps its own rows,
 * so conversation, job and team budgets still count per companion), with a split by companion.
 */
export function mergeSummaries(parts: { id: string; name: string; summary: UsageSummary }[]): UsageSummary & { byCompanion: (UsageTotals & { id: string; name: string })[] } {
  const models = new Map<string, UsageSummary['byModel'][number]>();
  const purposes = new Map<string, UsageSummary['byPurpose'][number]>();
  let total = NO_USAGE;
  for (const { summary: s } of parts) {
    total = addTotals(total, s.total);
    for (const m of s.byModel) {
      const k = `${m.providerId}\u0000${m.model}`;
      const had = models.get(k);
      models.set(k, had ? { ...addTotals(had, m), providerId: m.providerId, providerLabel: had.providerLabel || m.providerLabel, model: m.model } : { ...m });
    }
    for (const p of s.byPurpose) {
      const had = purposes.get(p.purpose);
      purposes.set(p.purpose, had ? { ...addTotals(had, p), purpose: p.purpose } : { ...p });
    }
  }
  const bySize = <T extends UsageTotals>(x: T[]) => x.sort((a, b) => b.tokens - a.tokens);
  return {
    total,
    byModel: bySize([...models.values()]).slice(0, 50),
    byPurpose: bySize([...purposes.values()]),
    byCompanion: parts.map((p) => ({ ...p.summary.total, id: p.id, name: p.name })),
  };
}

/** Phase 78: who else hears about each call (the run recorder), and the run id for its usage rows. */
export interface MeterHook {
  runId?: number;
  onCall?: (c: CallInfo) => void;
}

/**
 * The provider with its calls metered. Phase 78: `meter.rewrap(hook)` makes the same provider with
 * a run's id and recorder (src/runs.ts, passed explicitly into a turn: risk 1); without a hook the
 * usage scope's (jobs, team runs) is used. Each call's latency is measured here too.
 */
export function metered(provider: Provider, store: UsageStore, tag: { purpose?: string; conversationId?: string } = {}, hook?: MeterHook): Provider & { meter: { rewrap: (h: MeterHook) => Provider } } {
  return {
    config: provider.config,
    listModels: (signal?: AbortSignal) => provider.listModels(signal),
    ...(provider.modelLimits ? { modelLimits: (model: string, signal?: AbortSignal) => provider.modelLimits!(model, signal) } : {}),
    meter: { rewrap: (h: MeterHook) => metered(provider, store, tag, h) },
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const scope = usageScope.getStore();
      const runId = hook?.runId ?? scope?.runId;
      const onCall = hook?.onCall ?? scope?.onCall;
      const t0 = Date.now();
      let first: number | undefined;
      let seen = false;
      let row: UsageRow | undefined;
      let ok = true;
      let error: string | undefined;
      try {
        for await (const ev of provider.stream(req)) {
          first ??= Date.now() - t0;
          if (ev.type === 'usage') {
            seen = true;
            row = store.record(provider.config, req.model, ev, { ...scope, purpose: scope?.purpose ?? tag.purpose ?? 'other', conversationId: scope?.conversationId ?? tag.conversationId, ...(runId ? { runId } : {}) });
            if (scope) {
              scope.tokens = (scope.tokens ?? 0) + row.input + row.output;
              scope.usd = (scope.usd ?? 0) + (row.usd ?? 0);
              scope.reported = (scope.reported ?? 0) + 1;
            }
            continue;
          }
          yield ev;
        }
      } catch (err) {
        ok = false;
        error = (err as Error).message.slice(0, 200);
        throw err;
      } finally {
        if (!seen && scope) scope.unreported = (scope.unreported ?? 0) + 1;
        const info: CallInfo = { model: req.model, provider: provider.config.label, providerId: provider.config.id, billing: billingOf(provider.config), in: row?.input ?? 0, out: row?.output ?? 0, cached: row?.cached ?? 0, usd: row ? row.usd : null, reported: seen, ms: Date.now() - t0, ...(first !== undefined ? { firstMs: first } : {}), ok, ...(error ? { error } : {}) };
        if (onCall) {
          try {
            onCall(info);
          } catch {
            /* recording never breaks a call */
          }
        }
        // EC3: metrics and traces (src/telemetry/hub.ts); a listener never breaks the call.
        hub.modelCall({ ...info, startedAt: t0, purpose: scope?.purpose ?? tag.purpose ?? 'other' });
      }
    },
  };
}

/** "12.3k tokens · about $0.04" / "· local" / "· $0 (subscription)" / "· cost unknown". */
export function usageLine(t: UsageTotals): string {
  if (!t.calls) return 'No model usage recorded yet.';
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const paid = t.billing.includes('api');
  const cost = paid ? (t.usd > 0 || !t.unpriced ? `about $${t.usd < 0.01 && t.usd > 0 ? t.usd.toFixed(4) : t.usd.toFixed(2)}${t.unpriced ? ' + calls with no price' : ''}` : 'cost unknown (no price for this model)') : t.billing.includes('subscription') ? '$0 (subscription)' : 'local';
  return `${k(t.tokens)} tokens (${k(t.input)} in, ${k(t.output)} out) · ${cost}`;
}

/**
 * Phase 52: budgets for a job or team run (0/undefined = none). Phase 79: one Budget for every task
 * (tokens, dollars, steps, minutes and the degrade ladder) lives in src/budget.ts; jobs and team
 * tasks are checked through it (`overBudget` keeps Phase 52's words and rules).
 */
export type { Budget } from './budget.ts';
export { overBudget } from './budget.ts';

export function cleanBudget(v: unknown): Budget {
  const b = (v ?? {}) as Record<string, unknown>;
  const out: Budget = {};
  const t = Number(b.tokens);
  if (b.tokens !== undefined && b.tokens !== null && b.tokens !== '' && Number.isFinite(t) && t > 0) out.tokens = Math.min(50_000_000, Math.max(1000, Math.round(t)));
  const u = Number(b.usd);
  if (b.usd !== undefined && b.usd !== null && b.usd !== '' && Number.isFinite(u) && u > 0) out.usd = Math.min(10_000, Math.round(u * 100) / 100);
  return out;
}

// N1 (docs/design/NEXT.md, docs/CHOOSING_A_MODEL.md "Auto"): the right model per job, picked from
// what is connected. A small scored table: can it use tools, can it see, on this computer or not,
// how fast it really answered here (median time to first word from the runs table), how often it
// failed lately, and the spend limit. The best two make the job's chain: the first answers, the
// second takes over once when the first errors, stays silent or is slow (src/chat.ts does that and
// says so). Private conversations and "Nothing leaves this computer" only ever pick models on this
// computer. Everything here only reads (settings, the stored model lists, the runs table).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { isCloudModelName, EMBED_MODEL_NAME } from './model-names.ts';
import { onThisComputer } from './private-local.ts';
import { privateLocalOn } from './net-guard.ts';
import { spendSettings, spentNow } from './spend.ts';
import { billingOf } from './usage.ts';
import { modelSeesByName } from './video.ts';
import type { ProviderConfig } from './providers/types.ts';
import type { Settings } from './settings.ts';

/** The jobs Auto can pick for: talking, tools and long tasks (coding), pictures, web research. */
export const AUTO_JOBS = ['chat', 'coding', 'vision', 'research'] as const;
export type AutoJob = (typeof AUTO_JOBS)[number];
export const isAutoJob = (j: string): j is AutoJob => (AUTO_JOBS as readonly string[]).includes(j);
/** Auto's first-word deadline before the next-best model takes over (matches the 3.4.5 slow notice). */
export const AUTO_FIRST_MS = 45_000;
/** The deadline in use (tests shorten it). */
export const autoTiming = { firstMs: AUTO_FIRST_MS };
/** How many models an Auto chain holds: the pick and one fallback ("retry once"). */
export const AUTO_CHAIN = 2;
/** Runs looked at for speed and errors (days). */
export const STATS_DAYS = 14;

/**
 * New installs get Auto for every job: the first model provider ever added (no providers yet, no
 * choice made). Existing installs keep their routes; the E7 notice offers Auto.
 */
export function newInstallAuto(s: Pick<Settings, 'providers' | 'autoJobs'>): Pick<Settings, 'autoJobs'> {
  return !s.providers.length && s.autoJobs === undefined ? { autoJobs: [...AUTO_JOBS] } : {};
}

/** Is Auto on for this job? */
export function autoOn(s: Pick<Settings, 'autoJobs'>, job: string): boolean {
  return Array.isArray(s.autoJobs) && isAutoJob(job) && s.autoJobs.includes(job);
}

export interface AutoCand {
  providerId: string;
  provider: string;
  model: string;
  /** On this computer (loopback provider, not an Ollama Cloud model). */
  local: boolean;
  billing: 'api' | 'local' | 'subscription';
  /** Known tool support (Ollama capabilities, or a model that refused tools here). */
  tools?: boolean;
  /** Known picture support (provider list, else the name). */
  vision?: boolean;
  /** Median time to first word here (ms), when there are enough turns. */
  firstMs?: number;
  /** Main model calls looked at, and how many failed. */
  calls?: number;
  errors?: number;
  /** A model over 3B running on the processor (no graphics card). */
  cpuBig?: boolean;
}

export interface AutoOpts {
  /** Only models on this computer (private conversation or private local mode). */
  localOnly?: boolean;
  /** The day or month spend limit is reached: no pay-per-use models. */
  spendHit?: boolean;
}

export interface AutoPick {
  providerId: string;
  provider: string;
  model: string;
  score: number;
  /** One line: why this one (English; the app translates the parts). */
  why: string;
}

/** The size in billions from a tag like qwen3:4b (the same rule as modelpicks.ts, kept here to avoid an import cycle). */
const sizeB = (model: string): number | undefined => {
  const m = /[:-](\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
  return m ? Number(m[1]) : undefined;
};

const NOT_CHAT = /embed|bge-|\be5-|gte-|minilm|caption|whisper|tts|rerank|guard|imagine|ocr/i;
const STRONG = /gpt-5|claude|opus|sonnet|kimi-k[23]|glm-5|deepseek-v[34]|grok-4(?!.*fast)|mistral-large|qwen3[.\d]*-(?:max|coder)|gpt-oss:120b|:(?:3\d|[4-9]\d|\d{3})b\b/i;
const CODE = /coder|codestral|devstral|-code\b|kimi-k[23]|deepseek|glm-5|gpt-5|claude|sonnet|opus|grok-code/i;
const FAST = /flash|mini\b|-mini|nano|haiku|small|lite|fast|:(\d|1[0-4])b\b|-(\d|1[0-4])b\b|gpt-oss:20b/i;
const NEEDS_TOOLS: readonly AutoJob[] = ['chat', 'coding', 'research'];
/** Remixes and raw pulls (abliterated, uncensored, straight from Hugging Face): never Auto's first choice. */
const REMIX = /ablit|uncensor|heretic|nsfw|unleashed|^hf\.co\//i;

/**
 * The score of one model for one job (higher is better), with the reasons; undefined when it may
 * not be used (not on this computer for a private chat, pay-per-use past the spend limit, a picture
 * job and it can't see, not a chat model).
 */
export function scoreCandidate(c: AutoCand, job: AutoJob, o: AutoOpts = {}): { score: number; good: string[]; bad: string[] } | undefined {
  if (NOT_CHAT.test(c.model) || EMBED_MODEL_NAME.test(c.model)) return undefined;
  if (o.localOnly && !c.local) return undefined;
  if (o.spendHit && c.billing === 'api') return undefined;
  const sees = c.vision ?? modelSeesByName(c.model);
  if (job === 'vision' && !sees) return undefined;
  let score = 50;
  const good: string[] = [];
  const bad: string[] = [];
  if (REMIX.test(c.model)) score -= 25;
  if (NEEDS_TOOLS.includes(job)) {
    if (c.tools === false) {
      score -= 40;
      bad.push("can't use tools");
    } else if (c.tools === true) {
      score += 8;
      good.push('can use tools');
    }
  }
  if (job === 'vision') good.push('can see pictures');
  if ((job === 'coding' || job === 'research') && STRONG.test(c.model)) {
    score += 20;
    good.push('strong with long tasks');
  }
  if (job === 'coding' && CODE.test(c.model)) score += 8;
  if (job === 'chat' && FAST.test(c.model)) {
    score += 8;
    good.push('quick model');
  }
  if (c.firstMs !== undefined) {
    const s = Math.round(c.firstMs / 1000);
    if (c.firstMs <= 5_000) {
      score += 18;
      good.push(`first word in ${s} s here`);
    } else if (c.firstMs <= 15_000) {
      score += 6;
      good.push(`first word in ${s} s here`);
    } else if (c.firstMs > AUTO_FIRST_MS) {
      score -= 45;
      bad.push(`slow here (${s} s to the first word)`);
    } else if (c.firstMs > 30_000) {
      score -= 25;
      bad.push(`slow here (${s} s to the first word)`);
    }
  } else if (c.cpuBig) {
    // Bigger is slower on the processor: the smallest of them goes first.
    score -= 40 + Math.min(20, Math.round((sizeB(c.model) ?? 8) - 3));
    bad.push('too big for this processor');
  }
  const calls = c.calls ?? 0;
  if (calls > 0 && (c.errors ?? 0) > 0) {
    // Fewer than three calls count less (one bad call is a hint, not a verdict).
    const rate = (c.errors ?? 0) / calls;
    score -= Math.round(60 * rate * Math.min(1, calls / 3));
    if (rate >= 0.2) bad.push(`failed ${Math.round(rate * 100)}% of the time lately`);
  }
  if (c.local) {
    score += 3;
    if (o.localOnly) good.push('on this computer');
  }
  if (c.billing === 'api') score -= 3;
  return { score, good, bad };
}

/** The best models for a job, best first (at most `n`); ties keep the given order. */
export function autoChoose(cands: AutoCand[], job: AutoJob, o: AutoOpts = {}, n = AUTO_CHAIN): AutoPick[] {
  const scored: AutoPick[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const key = `${c.providerId}/${c.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = scoreCandidate(c, job, o);
    if (!r) continue;
    scored.push({ providerId: c.providerId, provider: c.provider, model: c.model, score: r.score, why: reasonLine(job, r.good, r.bad) });
  }
  return scored.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score || a.i - b.i).slice(0, n).map((x) => x.p);
}

const JOB_WORD: Record<AutoJob, string> = { chat: 'talking', coding: 'tools and long tasks', vision: 'pictures', research: 'web research' };

/** "Auto for talking: first word in 3 s here, can use tools." */
export function reasonLine(job: AutoJob, good: string[], bad: string[]): string {
  // The best of it, and its worst when there is one (a fallback that was slow says so).
  const parts = good.length ? [...good.slice(0, 2), ...bad.slice(0, 1)] : bad.slice(0, 1).map((b) => `best left (${b})`);
  return `Auto for ${JOB_WORD[job]}: ${parts.length ? parts.join(', ') : 'the best match connected'}.`;
}

export interface ModelStat {
  firstMs: number[];
  calls: number;
  errors: number;
}

const statsCache = new WeakMap<DatabaseSync, { at: number; map: Map<string, ModelStat> }>();

/**
 * Per model (providerId/model): the time to first word of each turn's main call and how many of
 * them failed, from the last STATS_DAYS days of runs. Kept a minute.
 */
export function modelStats(db: DatabaseSync, now: Date = new Date()): Map<string, ModelStat> {
  const hit = statsCache.get(db);
  if (hit && now.getTime() - hit.at < 60_000) return hit.map;
  const map = new Map<string, ModelStat>();
  try {
    const since = new Date(now.getTime() - STATS_DAYS * 86_400_000).toISOString();
    const rows = db.prepare("SELECT s.calls AS calls FROM runs r JOIN run_steps s ON s.run_id = r.id WHERE r.kind = 'turn' AND r.started_at >= ? AND s.calls IS NOT NULL ORDER BY r.id DESC LIMIT 600").all(since) as { calls: string }[];
    for (const row of rows) {
      let calls: { model?: string; providerId?: string; purpose?: string; firstMs?: number; ms?: number; ok?: boolean; error?: string }[];
      try {
        calls = JSON.parse(row.calls);
      } catch {
        continue;
      }
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        if (c.purpose || !c.providerId || !c.model) continue;
        const key = `${c.providerId}/${c.model}`;
        const m = map.get(key) ?? { firstMs: [], calls: 0, errors: 0 };
        m.calls++;
        if (c.ok === false) m.errors++;
        // A call that gave up waiting for the first word is a speed measurement too (at least that slow).
        const first = typeof c.firstMs === 'number' ? c.firstMs : c.ok === false && /no answer within/i.test(c.error ?? '') && typeof c.ms === 'number' ? c.ms : undefined;
        if (first !== undefined && m.firstMs.length < 10) m.firstMs.push(first);
        map.set(key, m);
      }
    }
  } catch {
    /* no runs table yet */
  }
  statsCache.set(db, { at: now.getTime(), map });
  return map;
}

/** Forget the cached stats (tests, and after a fallback so the next turn sees it). */
export function forgetStats(db: DatabaseSync): void {
  statsCache.delete(db);
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The models of one provider Auto may choose from: the ones the owner already picked somewhere
 * (default, a job, her own model), its default, then its stored model list.
 */
function modelsOf(app: AppContext, p: ProviderConfig): string[] {
  const s = app.settings.get();
  const chosen = [
    ...(s.defaultProviderId === p.id && s.defaultModel ? [s.defaultModel] : []),
    ...Object.values(s.routes ?? {}).flatMap((r) => (r ? [r, ...(r.fallbacks ?? [])] : [])).filter((r) => r.providerId === p.id).map((r) => r.model),
    ...(s.companionModel?.providerId === p.id ? [s.companionModel.model] : []),
  ];
  let listed: string[] = [];
  try {
    const v = app.modelCatalog?.view(p.id);
    if (v) listed = v.entries.filter((e) => !e.unpulled).map((e) => e.id);
  } catch {
    /* no list */
  }
  return [...new Set([...chosen, ...(p.defaultModel ? [p.defaultModel] : []), ...listed.slice(0, 40)])];
}

/** Every connected model, with what is known about it here (no network). */
export function autoCandidates(app: AppContext): AutoCand[] {
  const s = app.settings.get();
  const stats = modelStats(app.store.db, app.now());
  const out: AutoCand[] = [];
  for (const p of s.providers) {
    // A provider whose key is missing can't answer.
    if (p.needsKey && !app.vault.get(`provider:${p.id}`)) continue;
    for (const model of modelsOf(app, p)) {
      if (app.member) {
        try {
          app.member.checkModel(p.id, model);
        } catch {
          continue;
        }
      }
      const limits = app.modelContext?.limits(p, model).limits;
      const st = stats.get(`${p.id}/${model}`);
      const first = st ? median(st.firstMs) : undefined;
      const onDaemon = !isCloudModelName(model) && Boolean(p.local);
      let cpuBig = false;
      try {
        cpuBig = onDaemon && Boolean(app.modelContext) && app.modelContext!.hardware(p, model).kind === 'cpu' && (sizeB(model) ?? 0) > 3;
      } catch {
        /* unknown hardware */
      }
      const noTools = app.noToolModels?.has(`${p.id}/${model}`);
      out.push({
        providerId: p.id,
        provider: p.label,
        model,
        local: onThisComputer(p, model),
        billing: billingOf(p),
        ...(noTools ? { tools: false } : limits?.tools !== undefined ? { tools: limits.tools } : {}),
        ...(limits?.vision !== undefined ? { vision: limits.vision } : {}),
        ...(first !== undefined ? { firstMs: first } : {}),
        ...(st ? { calls: st.calls, errors: st.errors } : {}),
        ...(cpuBig ? { cpuBig } : {}),
      });
    }
  }
  return out;
}

/** Is the day or month spend limit reached (then Auto skips pay-per-use models)? */
export function spendLimitHit(app: AppContext): boolean {
  const s = app.settings.get();
  const sp = spendSettings(s);
  if (!sp.dayUsd && !sp.monthUsd) return false;
  const spent = spentNow(app.usage, app.now(), s.timeZone);
  return Boolean((sp.dayUsd && spent.day >= sp.dayUsd) || (sp.monthUsd && spent.month >= sp.monthUsd));
}

/** Auto's chain for a job here and now (empty when nothing connected fits). */
export function autoChain(app: AppContext, job: AutoJob, o: { private?: boolean } = {}): AutoPick[] {
  const localOnly = Boolean(o.private) || privateLocalOn();
  return autoChoose(autoCandidates(app), job, { localOnly, spendHit: spendLimitHit(app) });
}

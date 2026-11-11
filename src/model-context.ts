// 3.4.1: how much each model can hold (its context window), so "how much of the chat she keeps in
// mind" follows the model instead of one fixed 48,000 characters (about 12,000 tokens).
//
// Sources, best first: the provider's own model list (OpenRouter /models, Ollama /api/tags and
// /api/show, Gemini's models API, Anthropic's models API, OpenAI-compatible /models when it carries
// a window field: vLLM's max_model_len, LM Studio's max_context_length, ...), then a dated table of
// well-known model families (conservative values), then today's default. An unknown model never gets
// more than the old default by guess. Lookups are kept in memory and in a small JSON file in the data
// folder, refreshed once a day; offline, the last known numbers keep working.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';
import { isCloudModelName } from './model-names.ts';
import { SUBSCRIPTION_KINDS, type Provider, type ProviderConfig } from './providers/types.ts';

export interface ModelLimits {
  /** The model's context window in tokens (everything it reads plus what it writes). */
  context: number;
  /** The most it writes in one reply (tokens), when known. */
  maxOutput?: number;
  /** Ollama: the num_ctx the model's Modelfile sets (what /v1 calls get without options). */
  numCtx?: number;
  /**
   * 3.4.3: whether the model can look at pictures, when its provider's list says so (Ollama's
   * capabilities, OpenRouter's input modalities). Unknown stays unset.
   */
  vision?: boolean;
}

/** 3.4.3: Ollama's `capabilities` list ("vision" among them) or OpenRouter's input modalities. */
function visionOf(m: Record<string, unknown>): { vision?: boolean } {
  if (Array.isArray(m.capabilities)) return { vision: m.capabilities.includes('vision') };
  const mods = (m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
  if (Array.isArray(mods)) return { vision: mods.includes('image') };
  return {};
}

export type LimitsSource = 'provider' | 'table' | 'default';

/** Today's default: what Sara used for every model before 3.4.1 (48,000 characters). */
export const DEFAULT_WINDOW_TOKENS = 12_000;
/** Characters per token for English-like text (measured on Sara's own prompts: 3.8 to 4.3). */
export const CHARS_PER_TOKEN = 4;
/** Balanced ceiling for pay-per-token cloud models: at most this much history (tokens) by default. */
export const BALANCED_HISTORY_TOKENS = 128_000;
/** What Sara sends besides the chat (system prompt, tool list, notes, skills), estimated (tokens). */
export const OVERHEAD_TOKENS = 12_000;
/** Ollama on your own computer: the context Sara asks for by default (num_ctx). */
export const LOCAL_DEFAULT_CTX = 32_768;
/** The largest history the app holds in one turn (characters, about 1M tokens). */
export const HARD_MAX_CHARS = 4_000_000;
/** The smallest history setting (characters). */
export const MIN_HISTORY_CHARS = 8_000;
/** A provider list is checked again after this long. */
export const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 10 * 60_000;
export const WINDOWS_FILE = 'model-windows.json';

/**
 * Well-known model families, checked 2026-11-11 against OpenRouter's public /models list
 * (context_length, top_provider.max_completion_tokens) and the vendors' model pages. Values are the
 * conservative end: where a vendor offers a bigger window only as an opt-in variant (Claude's 1M
 * beta) the table keeps the standard one and the variant id ("…[1m]", "…-1m") gets the big one.
 * First match wins, so specific patterns come before family patterns.
 */
export const TABLE_DATE = '2026-11-11';
export const KNOWN_WINDOWS: readonly { re: RegExp; context: number; maxOutput?: number }[] = [
  // Anthropic Claude: 200k standard; 1M as an opt-in variant.
  { re: /claude.*(\[1m\]|-1m\b)/i, context: 1_000_000, maxOutput: 64_000 },
  { re: /claude|^(opus|sonnet|haiku)$/i, context: 200_000, maxOutput: 32_000 },
  // OpenAI
  { re: /gpt-4\.1/i, context: 1_047_576, maxOutput: 32_768 },
  { re: /gpt-(5\.[4-9]|6)/i, context: 1_050_000, maxOutput: 128_000 },
  { re: /gpt-5\.2-chat|gpt-5-chat/i, context: 128_000, maxOutput: 16_384 },
  { re: /gpt-5|gpt-chat-latest/i, context: 400_000, maxOutput: 128_000 },
  { re: /gpt-oss/i, context: 131_072, maxOutput: 32_768 },
  { re: /gpt-4o|chatgpt-4o|gpt-4-turbo/i, context: 128_000, maxOutput: 16_384 },
  { re: /\bo[34](-mini|-pro)?\b/i, context: 200_000, maxOutput: 100_000 },
  { re: /gpt-3\.5/i, context: 16_385, maxOutput: 4_096 },
  // Google
  { re: /gemini-.*(image|nano-banana)/i, context: 32_768, maxOutput: 8_192 },
  { re: /gemini-(1\.5|2|3|4)/i, context: 1_048_576, maxOutput: 65_536 },
  { re: /gemma-?4/i, context: 131_072, maxOutput: 16_384 },
  { re: /gemma-?3/i, context: 131_072, maxOutput: 8_192 },
  { re: /gemma-?2/i, context: 8_192, maxOutput: 2_048 },
  // xAI
  { re: /grok-4\.20/i, context: 2_000_000, maxOutput: 32_768 },
  { re: /grok-(4|5)/i, context: 256_000, maxOutput: 32_768 },
  { re: /grok-3/i, context: 131_072, maxOutput: 16_384 },
  // Meta Llama
  { re: /llama-?4/i, context: 524_288, maxOutput: 16_384 },
  { re: /llama-?3\.[1-3]/i, context: 131_072, maxOutput: 8_192 },
  { re: /llama-?3\b/i, context: 8_192, maxOutput: 4_096 },
  // Qwen
  { re: /qwen3\.?[5-9]|qwen3-(coder|next|vl|235b|30b-a3b-instruct)/i, context: 262_144, maxOutput: 32_768 },
  { re: /qwen3/i, context: 40_960, maxOutput: 16_384 },
  { re: /qwen-?2\.5/i, context: 32_768, maxOutput: 8_192 },
  // Mistral
  { re: /mistral-large-4/i, context: 1_048_576, maxOutput: 32_768 },
  { re: /mistral-(large|medium|small)-(2512|2603|3-5|3\.2)|devstral|codestral|ministral/i, context: 256_000, maxOutput: 32_768 },
  { re: /mistral-(large|medium|small)|mistral-nemo|pixtral/i, context: 128_000, maxOutput: 16_384 },
  { re: /mixtral/i, context: 65_536, maxOutput: 8_192 },
  // DeepSeek
  { re: /deepseek-v4/i, context: 1_048_576, maxOutput: 65_536 },
  { re: /deepseek/i, context: 163_840, maxOutput: 16_384 },
  // Moonshot, Zhipu, MiniMax
  { re: /kimi-k3/i, context: 1_048_576, maxOutput: 65_536 },
  { re: /kimi-k2/i, context: 262_144, maxOutput: 32_768 },
  { re: /glm-5\.[2-9]/i, context: 1_048_576, maxOutput: 65_536 },
  { re: /glm-(4\.[67]|5)/i, context: 200_000, maxOutput: 65_536 },
  { re: /glm-4/i, context: 131_072, maxOutput: 32_768 },
  { re: /minimax-m3/i, context: 1_000_000, maxOutput: 65_536 },
  { re: /minimax-m2/i, context: 196_608, maxOutput: 65_536 },
];

/** The table's numbers for a model id (provider prefixes like "openai/" are fine), or undefined. */
export function tableLimits(model: string): ModelLimits | undefined {
  const id = model.trim();
  if (!id) return undefined;
  const hit = KNOWN_WINDOWS.find((w) => w.re.test(id));
  return hit ? { context: hit.context, ...(hit.maxOutput ? { maxOutput: hit.maxOutput } : {}) } : undefined;
}

const posInt = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 512 && n <= 100_000_000 ? Math.floor(n) : undefined;
};
const outInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 16 && n <= 100_000_000 ? Math.floor(n) : undefined;
};
const limitsOf = (context: unknown, maxOutput?: unknown): ModelLimits | undefined => {
  const c = posInt(context);
  if (!c) return undefined;
  const o = outInt(maxOutput);
  return { context: c, ...(o && o < c ? { maxOutput: o } : {}) };
};
const listOf = (body: unknown, key = 'data'): Record<string, unknown>[] => {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [];
};

/** OpenRouter GET /models: context_length, top_provider.{context_length,max_completion_tokens}. */
export function parseOpenRouter(body: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const m of listOf(body)) {
    const top = (m.top_provider ?? {}) as Record<string, unknown>;
    const l = limitsOf(top.context_length ?? m.context_length, top.max_completion_tokens);
    if (typeof m.id === 'string' && l) out[m.id] = { ...l, ...visionOf(m) };
  }
  return out;
}

/** Any OpenAI-compatible GET /models: whichever window field the server includes (often none). */
export function parseOpenAIList(body: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const m of [...listOf(body), ...listOf(body, 'models')]) {
    const id = typeof m.id === 'string' ? m.id : typeof m.slug === 'string' ? m.slug : undefined;
    // vLLM: max_model_len. LM Studio: max_context_length / loaded_context_length. Together/Fireworks/
    // Groq: context_length / context_window. Codex model list: context_window. Mistral: max_context_length.
    const top = (m.top_provider ?? {}) as Record<string, unknown>;
    const l = limitsOf(m.loaded_context_length ?? m.context_length ?? m.context_window ?? m.max_model_len ?? m.max_context_length ?? m.max_input_tokens ?? top.context_length, m.max_completion_tokens ?? m.max_output_tokens ?? top.max_completion_tokens);
    if (id && l) out[id] = l;
  }
  return out;
}

/** Anthropic GET /v1/models: max_input_tokens (window) and max_tokens (longest reply). */
export function parseAnthropic(body: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const m of listOf(body)) {
    const l = limitsOf(m.max_input_tokens, m.max_tokens);
    if (typeof m.id === 'string' && l) out[m.id] = l;
  }
  return out;
}

/** Gemini GET /v1beta/models: name "models/<id>", inputTokenLimit, outputTokenLimit. */
export function parseGemini(body: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const m of listOf(body, 'models')) {
    const id = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : undefined;
    // inputTokenLimit is what it reads (the window Sara fills); outputTokenLimit the longest reply.
    const l = limitsOf(m.inputTokenLimit, m.outputTokenLimit);
    if (id && l) out[id] = l;
  }
  return out;
}

/** Ollama GET /api/tags: details.context_length on recent versions (all models in one call). */
export function parseOllamaTags(body: unknown): Record<string, ModelLimits> {
  const out: Record<string, ModelLimits> = {};
  for (const m of listOf(body, 'models')) {
    const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : undefined;
    const l0 = limitsOf(((m.details ?? {}) as Record<string, unknown>).context_length ?? m.context_length);
    if (name && l0) {
      const l = { ...l0, ...visionOf(m) };
      out[name] = l;
      if (name.endsWith(':latest')) out[name.slice(0, -7)] = l;
    }
  }
  return out;
}

/** Ollama POST /api/show: model_info["<arch>.context_length"] and the Modelfile's num_ctx. */
export function parseOllamaShow(body: unknown): ModelLimits | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { model_info?: Record<string, unknown>; parameters?: unknown; capabilities?: unknown };
  const info = b.model_info ?? {};
  const arch = typeof info['general.architecture'] === 'string' ? String(info['general.architecture']) : '';
  const ctx = info[`${arch}.context_length`] ?? Object.entries(info).find(([k]) => k.endsWith('.context_length'))?.[1];
  const num = typeof b.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(b.parameters)?.[1] : undefined;
  const l = limitsOf(ctx);
  const numCtx = posInt(num);
  const v = visionOf(b as Record<string, unknown>);
  if (!l) return numCtx ? { context: numCtx, numCtx, ...v } : undefined;
  return { ...l, ...(numCtx ? { numCtx } : {}), ...v };
}

/** Rough characters per token for a piece of text (4 for English; less for CJK, Cyrillic, ...). */
export function charsPerToken(sample: string): number {
  const s = sample.slice(-40_000);
  if (s.length < 200) return CHARS_PER_TOKEN;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    else if (c > 0x024f && !(c >= 0x2000 && c <= 0x2bff) && !(c >= 0x1f000)) other++;
  }
  const n = [...s].length;
  const r = cjk / n;
  const o = other / n;
  return Math.max(1.2, Math.round((CHARS_PER_TOKEN - 2.8 * r - 1.2 * o) * 10) / 10);
}

export type HistoryMode = 'auto' | 'full' | 'fixed';
export type Billing = 'api' | 'local' | 'subscription';

export interface AutoInput {
  /** The model's window (tokens); undefined = unknown. */
  limits?: ModelLimits;
  source: LimitsSource;
  billing: Billing;
  mode: HistoryMode;
  /** Fixed mode: the owner's size (characters). */
  fixedChars?: number;
  /** Ollama on your own computer: the context Sara will ask for (num_ctx); replaces the window. */
  localCtx?: number;
  /** Cloud model reached through a local Ollama (runs on ollama.com): cost-capped like the cloud. */
  cloudThroughDaemon?: boolean;
  charsPerToken?: number;
  overheadTokens?: number;
}

export interface HistoryBudget {
  /** The history size buildHistory keeps under (characters). */
  chars: number;
  /** The same in tokens (estimated). */
  tokens: number;
  /** What the model holds (tokens), as used for this call; 0 when unknown. */
  windowTokens: number;
  mode: HistoryMode;
  source: LimitsSource;
  /** Why it isn't bigger: 'balanced' (cost guard), 'local' (Sara's num_ctx), 'max' (app limit), 'fixed'. */
  capped?: 'balanced' | 'local' | 'max' | 'fixed';
  billing: Billing;
  charsPerToken: number;
}

/**
 * The auto math: history = (window - reply reserve - system prompt/tools/notes - margin) × 0.85,
 * then the cost guard (pay-per-token: at most BALANCED_HISTORY_TOKENS unless "full window"), then the
 * app's limits. Unknown window: today's default, never more.
 */
export function autoHistory(i: AutoInput): HistoryBudget {
  const cpt = i.charsPerToken ?? CHARS_PER_TOKEN;
  const base = { mode: i.mode, source: i.source, billing: i.billing, charsPerToken: cpt };
  const clampChars = (c: number) => Math.max(MIN_HISTORY_CHARS, Math.min(HARD_MAX_CHARS, Math.round(c)));
  const window = i.localCtx ? Math.min(i.localCtx, i.limits?.context ?? i.localCtx) : i.limits?.context ?? 0;
  if (i.mode === 'fixed') {
    // The owner's size as saved (the settings route checks its range).
    const chars = Math.max(1, Math.min(HARD_MAX_CHARS, Math.round(i.fixedChars ?? DEFAULT_WINDOW_TOKENS * CHARS_PER_TOKEN)));
    return { ...base, chars, tokens: Math.round(chars / cpt), windowTokens: window, capped: 'fixed' };
  }
  if (!window || i.source === 'default') {
    const chars = DEFAULT_WINDOW_TOKENS * CHARS_PER_TOKEN;
    return { ...base, chars, tokens: Math.round(chars / cpt), windowTokens: 0 };
  }
  const reserve = Math.min(i.limits?.maxOutput ?? 8_192, 16_000, Math.round(window * 0.15));
  const overhead = Math.min(i.overheadTokens ?? OVERHEAD_TOKENS, Math.round(window * 0.3));
  let tokens = Math.max(0, Math.floor((window - reserve - overhead) * 0.85));
  let capped: HistoryBudget['capped'] = i.localCtx && i.localCtx < (i.limits?.context ?? Infinity) ? 'local' : undefined;
  const paid = i.billing === 'api' || i.cloudThroughDaemon;
  if (paid && i.mode === 'auto' && tokens > BALANCED_HISTORY_TOKENS) {
    tokens = BALANCED_HISTORY_TOKENS;
    capped = 'balanced';
  }
  let chars = tokens * cpt;
  if (chars > HARD_MAX_CHARS) capped = 'max';
  chars = clampChars(chars);
  return { ...base, chars, tokens: Math.round(chars / cpt), windowTokens: window, ...(capped ? { capped } : {}) };
}

/** 3.4.5: an Ollama daemon whose model runs on the processor (or isn't known yet): small and quick. */
export const CPU_CTX = 8_192;
/** 3.4.5: the most "full window" asks for on the processor. */
export const CPU_FULL_CTX = 16_384;
/** 3.4.5: graphics memory left free below which Sara doesn't ask for more than Ollama's own default. */
export const GPU_HEADROOM_GB = 2;

/**
 * 3.4.5: what Sara knows about the hardware of the Ollama daemon a model runs on. `kind` 'gpu':
 * the model runs on the graphics card (`vramGb` its memory when known, `freeGb` what's left);
 * 'cpu': on the processor (or split between the two, just as slow); 'unknown': not known yet.
 */
export interface DaemonHardware {
  kind: 'gpu' | 'cpu' | 'unknown';
  vramGb?: number;
  freeGb?: number;
  /** The context the model is loaded with right now (Ollama /api/ps), if loaded. */
  loadedCtx?: number;
  /** The Modelfile's num_ctx (what Ollama itself would use). */
  defaultCtx?: number;
  /** Where it was learned: Ollama's own /api/ps, this computer's graphics card, or nothing yet. */
  basis: 'daemon' | 'this-machine' | 'none';
}

/**
 * Ollama: the num_ctx Sara asks for, by the daemon's hardware. On the processor (or not known yet)
 * Auto asks for 8k and "full window" at most 16k: more context there makes every turn take
 * minutes. On a graphics card Auto asks for 32k (64k with 24 GB, 128k with 48 GB); "full window"
 * the model's maximum bounded by the card; a nearly full card (other models loaded) gets no more
 * than the model already has or Ollama's own default. Fixed: enough for the owner's size.
 */
export function localNumCtx(o: { mode: HistoryMode; modelMax?: number; fixedChars?: number; hw?: DaemonHardware }): number {
  const max = o.modelMax ?? LOCAL_DEFAULT_CTX;
  const roundUp = (n: number) => Math.ceil(n / 1024) * 1024;
  const hw = o.hw ?? { kind: 'unknown', basis: 'none' };
  if (o.mode === 'fixed' && o.fixedChars) return Math.min(max, Math.max(8_192, roundUp(o.fixedChars / CHARS_PER_TOKEN + OVERHEAD_TOKENS + 8_192)));
  if (hw.kind !== 'gpu') return Math.min(max, o.mode === 'full' ? CPU_FULL_CTX : CPU_CTX);
  const v = hw.vramGb;
  let want = o.mode === 'full' ? (v === undefined ? 65_536 : v >= 48 ? 262_144 : v >= 24 ? 131_072 : 65_536) : v === undefined || v < 24 ? LOCAL_DEFAULT_CTX : v < 48 ? 65_536 : 131_072;
  // A nearly full card: a bigger context would push the model off the card (or crash it).
  if (hw.freeGb !== undefined && hw.freeGb < GPU_HEADROOM_GB) want = Math.min(want, hw.loadedCtx ?? hw.defaultCtx ?? CPU_CTX);
  return Math.min(max, want);
}

/** One model Ollama has loaded (/api/ps): its size, the part on the graphics card, its context. */
export interface LoadedModel {
  name: string;
  sizeGb: number;
  vramGb: number;
  ctx?: number;
}
const GB = 1024 ** 3;
/** Ollama GET /api/ps: the loaded models, with size and size_vram (0 = on the processor). */
export function parseOllamaPs(body: unknown): LoadedModel[] {
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: LoadedModel[] = [];
  for (const m of models as Record<string, unknown>[]) {
    const name = typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : '';
    const size = Number(m?.size);
    if (!name || !Number.isFinite(size) || size <= 0) continue;
    const vram = Math.max(0, Number(m.size_vram) || 0);
    const ctx = posInt(m.context_length);
    out.push({ name, sizeGb: size / GB, vramGb: vram / GB, ...(ctx ? { ctx } : {}) });
  }
  return out;
}

const daemonPs = new Map<string, { at: number; models: LoadedModel[] }>();
/** 3.4.5: what a daemon's /api/ps said (refreshed when a model loads or a call is slow). */
export function noteOllamaPs(baseUrl: string, body: unknown, at = Date.now()): void {
  daemonPs.set(rootOf(baseUrl), { at, models: parseOllamaPs(body) });
}
/** When the daemon's /api/ps was last read (0 = never). */
export const daemonPsAt = (baseUrl: string): number => daemonPs.get(rootOf(baseUrl))?.at ?? 0;
/** Tests: forget what the daemons said. */
export function resetDaemonHardware(): void {
  daemonPs.clear();
}

/** An address on the computer Sara runs on (the daemon shares its hardware). */
export function sameMachine(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
  } catch {
    return false;
  }
}

const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || b === `${a}:latest`;

/**
 * 3.4.5: the hardware of the daemon at `baseUrl` for `model`. Ollama's own /api/ps decides (the
 * model's size_vram against its size: all on the card = gpu; none or part = cpu); a daemon with
 * other models loaded tells whether it has a card at all. Not loaded anywhere: a daemon on this
 * computer has this computer's card (`here`; none = cpu); another computer's daemon is unknown.
 * Sara's own graphics memory never stands in for another computer's.
 */
export function daemonHardware(baseUrl: string, model: string, here?: { known: boolean; vramGb?: number }, defaultCtx?: number): DaemonHardware {
  const local = sameMachine(baseUrl);
  const hereGb = local && here?.known ? here.vramGb : undefined;
  const ps = daemonPs.get(rootOf(baseUrl))?.models ?? [];
  const used = ps.reduce((n, m) => n + m.vramGb, 0);
  const free = hereGb !== undefined ? Math.max(0, hereGb - used) : undefined;
  const extra = { ...(defaultCtx ? { defaultCtx } : {}), ...(free !== undefined ? { freeGb: Math.round(free * 10) / 10 } : {}) };
  const mine = ps.find((m) => sameModel(m.name, model));
  if (mine) {
    // Within 5% counts as all on the card (Ollama rounds); less is a split, as slow as the processor.
    if (mine.vramGb >= mine.sizeGb * 0.95) return { kind: 'gpu', basis: 'daemon', ...(hereGb ? { vramGb: hereGb } : {}), ...(mine.ctx ? { loadedCtx: mine.ctx } : {}), ...extra };
    return { kind: 'cpu', basis: 'daemon', ...(mine.ctx ? { loadedCtx: mine.ctx } : {}), ...extra };
  }
  if (ps.length) {
    if (ps.some((m) => m.vramGb > 0)) return { kind: 'gpu', basis: 'daemon', ...(hereGb ? { vramGb: hereGb } : {}), ...extra };
    return { kind: 'cpu', basis: 'daemon', ...extra };
  }
  if (local && here?.known) return here.vramGb ? { kind: 'gpu', basis: 'this-machine', vramGb: here.vramGb, ...extra } : { kind: 'cpu', basis: 'this-machine', ...extra };
  return { kind: 'unknown', basis: 'none', ...extra };
}

const rootOf = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
/** Addresses the model lists found to be Ollama daemons on another port (src/model-catalog.ts). */
const knownDaemons = new Set<string>();
export function noteOllamaDaemon(baseUrl: string): void {
  knownDaemons.add(rootOf(baseUrl));
}
/** A local Ollama daemon (not Ollama's own cloud API), where num_ctx matters. */
export const isOllamaDaemon = (config: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean => config.kind === 'openai-compatible' && !/ollama\.com/i.test(config.baseUrl) && (/:11434\b/.test(config.baseUrl) || knownDaemons.has(rootOf(config.baseUrl)));

interface ProviderEntry {
  checkedAt?: string;
  triedAt?: string;
  models: Record<string, ModelLimits>;
}

const PS_REFRESH_MS = 60_000;
const psInflight = new Map<string, Promise<void>>();
/** 3.4.5: reads a daemon's /api/ps now (one at a time per daemon; never throws). */
export function refreshPs(provider: Pick<Provider, 'config' | 'loadedModels'>): Promise<void> {
  const root = rootOf(provider.config.baseUrl);
  let p = psInflight.get(root);
  if (!p) {
    p = (async () => {
      try {
        const body = await provider.loadedModels!(AbortSignal.timeout(5_000));
        if (body !== undefined) noteOllamaPs(provider.config.baseUrl, body);
      } catch {
        /* the last answer stays */
      }
    })().finally(() => psInflight.delete(root));
    psInflight.set(root, p);
  }
  return p;
}
async function raceFor(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

/** The cache: provider lists (memory + data/model-windows.json), refreshed daily, kept offline. */
export class ModelContextStore {
  readonly #file: string | undefined;
  readonly #now: () => Date;
  #data: Record<string, ProviderEntry> = {};
  readonly #inflight = new Map<string, Promise<void>>();
  /** This computer's graphics memory (GB), for Ollama daemons on this computer only. */
  vramGb: number | undefined;
  /** 3.4.5: this computer's hardware has been checked (no vramGb then = no graphics card). */
  hardwareKnown = false;

  /** 3.4.5: the hardware of a daemon for a model (see daemonHardware). */
  hardware(config: Pick<ProviderConfig, 'id' | 'baseUrl' | 'kind'>, model: string): DaemonHardware {
    const known = this.limits(config, model);
    return daemonHardware(config.baseUrl, model, { known: this.hardwareKnown, vramGb: this.vramGb }, known.source === 'provider' ? known.limits?.numCtx : undefined);
  }

  constructor(dataDir: string | undefined, now: () => Date = () => new Date()) {
    this.#file = dataDir ? join(dataDir, WINDOWS_FILE) : undefined;
    this.#now = now;
    try {
      if (this.#file && existsSync(this.#file)) {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as { providers?: Record<string, ProviderEntry> };
        if (raw.providers && typeof raw.providers === 'object') this.#data = raw.providers;
      }
    } catch {
      /* a damaged file starts empty */
    }
  }

  static key(config: Pick<ProviderConfig, 'id' | 'baseUrl'>): string {
    return `${config.id}|${config.baseUrl.replace(/\/+$/, '')}`;
  }

  /** What is known for a model, without waiting: the provider's list, then the table, then nothing. */
  limits(config: Pick<ProviderConfig, 'id' | 'baseUrl' | 'kind'>, model: string): { limits?: ModelLimits; source: LimitsSource } {
    const models = this.#data[ModelContextStore.key(config)]?.models ?? {};
    const hit = models[model] ?? models[`${model}:latest`] ?? models[model.replace(/^models\//, '')];
    if (hit) return { limits: hit, source: 'provider' };
    return lookupTable(config, model);
  }

  /** Checks the provider's list when it is old or lacks the model (at most `waitMs`; never throws). */
  async prime(provider: Provider, model: string, waitMs = 1500): Promise<void> {
    // 3.4.5: an Ollama daemon also says where its models run (/api/ps, at most once a minute).
    const ps = typeof provider.loadedModels === 'function' && isOllamaDaemon(provider.config) && this.#now().getTime() - daemonPsAt(provider.config.baseUrl) > PS_REFRESH_MS ? refreshPs(provider) : undefined;
    if (typeof provider.modelLimits !== 'function') {
      if (ps) await raceFor(ps, waitMs);
      return;
    }
    const k = ModelContextStore.key(provider.config);
    const e = this.#data[k];
    const now = this.#now().getTime();
    const fresh = e?.checkedAt && now - Date.parse(e.checkedAt) < REFRESH_MS;
    const triedLately = e?.triedAt && now - Date.parse(e.triedAt) < RETRY_MS;
    if ((fresh && e.models[model]) || triedLately) {
      if (ps) await raceFor(ps, waitMs);
      return;
    }
    let p = this.#inflight.get(k);
    if (!p) {
      p = this.#refresh(provider, model, k).finally(() => this.#inflight.delete(k));
      this.#inflight.set(k, p);
    }
    await raceFor(ps ? Promise.all([p, ps]).then(() => undefined) : p, waitMs);
  }

  async #refresh(provider: Provider, model: string, k: string): Promise<void> {
    const at = this.#now().toISOString();
    const old = this.#data[k];
    this.#data[k] = { ...(old ?? { models: {} }), triedAt: at };
    try {
      const got = await provider.modelLimits!(model, AbortSignal.timeout(15_000));
      if (got && Object.keys(got).length) this.#data[k] = { checkedAt: at, triedAt: at, models: { ...(old?.models ?? {}), ...got } };
    } catch {
      /* offline or refused: the last known numbers stay */
    }
    this.#save();
  }

  /** Tests and Health: the cached entry for a provider. */
  entry(config: Pick<ProviderConfig, 'id' | 'baseUrl'>): ProviderEntry | undefined {
    return this.#data[ModelContextStore.key(config)];
  }

  #save(): void {
    if (!this.#file) return;
    try {
      writeFileAtomic(this.#file, `${JSON.stringify({ version: 1, providers: this.#data }, null, 1)}\n`);
    } catch {
      /* memory only */
    }
  }
}

/** The table for a provider + model; subscriptions use their model's family. */
export function lookupTable(config: Pick<ProviderConfig, 'kind'>, model: string): { limits?: ModelLimits; source: LimitsSource } {
  let t = tableLimits(model);
  // ChatGPT plan (Codex backend): its GPT-5 models hold 272k input there.
  if (config.kind === 'chatgpt' && t && /gpt-5/i.test(model)) t = { context: 272_000, maxOutput: 128_000 };
  // Claude subscription aliases ("sonnet", "opus") and Grok CLI models.
  if (!t && config.kind === 'claude-code') t = { context: 200_000, maxOutput: 32_000 };
  if (!t && config.kind === 'grok-cli') t = { context: 256_000, maxOutput: 32_768 };
  return t ? { limits: t, source: 'table' } : { source: 'default' };
}

export const isSubscription = (config: Pick<ProviderConfig, 'kind'>): boolean => SUBSCRIPTION_KINDS.includes(config.kind);
export const cloudThroughDaemon = (config: Pick<ProviderConfig, 'kind' | 'baseUrl'>, model: string): boolean => isOllamaDaemon(config) && isCloudModelName(model);

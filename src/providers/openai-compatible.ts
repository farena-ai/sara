// Adapter for any OpenAI-compatible chat API: OpenAI, xAI (Grok), Ollama (local and cloud),
// OpenRouter, vLLM, LM Studio, llama.cpp server, Groq, etc.
import { randomUUID } from 'node:crypto';
import { sseEvents } from '../sse.ts';
import { isCloudModelName } from '../model-names.ts';
import { isOllamaDaemon, parseGemini, refreshPs, parseOllamaShow, parseOllamaTags, parseOpenAIList, parseOpenRouter, type ModelLimits } from '../model-context.ts';
import {
  failFromResponse,
  foldSteers,
  reach,
  parseToolArguments,
  partialPath,
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type Provider,
  type ProviderConfig,
  type StreamEvent,
} from './types.ts';

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Phase 116: APIs known to refuse a user line straight after tool results (they fold steers). */
export const strictToolOrder = (baseUrl: string): boolean => /api\.mistral\.ai/i.test(baseUrl);

export function toOpenAIMessages(messages: ChatMessage[], opts: { strictToolOrder?: boolean } = {}): WireMessage[] {
  if (opts.strictToolOrder) messages = foldSteers(messages);
  const wire = messages.map((m): WireMessage => {
    if (m.role === 'assistant') {
      return m.toolCalls?.length
        ? {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
          }
        : { role: 'assistant', content: m.content };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'user' && m.images?.length) {
      return { role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mime};base64,${img.data}` } }))] };
    }
    return { role: m.role, content: m.content };
  });
  // Phase 49: screenshots from tools. Tool results must follow their request directly, so the
  // pictures go in one user message after the last result of the group.
  if (!messages.some((m) => m.role === 'tool' && m.images?.length)) return wire;
  const out: WireMessage[] = [];
  let pending: { url: string }[] = [];
  messages.forEach((m, i) => {
    out.push(wire[i]);
    if (m.role === 'tool' && m.images?.length) pending.push(...m.images.map((img) => ({ url: `data:${img.mime};base64,${img.data}` })));
    if (pending.length && messages[i + 1]?.role !== 'tool') {
      out.push({ role: 'user', content: [{ type: 'text', text: '[Note from the app: the screenshot(s) your tools just took, for you to look at.]' }, ...pending.map((u) => ({ type: 'image_url' as const, image_url: u }))] });
      pending = [];
    }
  });
  return out;
}

/** Ollama (local or cloud) accepts reasoning_effort, including 'none', on every model. */
export const isOllama = (baseUrl: string) => /:11434\b|ollama\.com/i.test(baseUrl);
/** An Ollama daemon (yours, not Ollama's cloud API): has /api/chat, /api/tags and /api/show. */
const isDaemon = (baseUrl: string) => isOllamaDaemon({ kind: 'openai-compatible', baseUrl });
const daemonRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');

/**
 * 3.4.1: the num_ctx last asked for per daemon + model. Every later call to that model (background
 * chores included) asks for the same, so Ollama doesn't reload the model between calls.
 */
const ollamaCtx = new Map<string, number>();
/** Daemons whose /api/chat failed (an old Ollama or another server on that port): /v1 from then on. */
const noNativeChat = new Set<string>();

/** Messages in Ollama's own /api/chat shape (pictures as base64, tool arguments as objects). */
export function toOllamaMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let shots: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } })) } : {}) });
    else if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_name: m.name, tool_call_id: m.toolCallId });
      if (m.images?.length) shots.push(...m.images.map((x) => x.data));
    } else if (m.role === 'user') out.push({ role: 'user', content: m.content, ...(m.images?.length ? { images: m.images.map((x) => x.data) } : {}) });
    else out.push({ role: m.role, content: m.content });
    if (shots.length && messages[i + 1]?.role !== 'tool') {
      out.push({ role: 'user', content: '[Note from the app: the screenshot(s) your tools just took, for you to look at.]', images: shots });
      shots = [];
    }
  });
  return out;
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
  /** Length at the last progress report. */
  reported?: number;
  /** Phase 63: its first piece went out as a `tool_delta`. */
  announced?: boolean;
}

export class OpenAICompatibleProvider implements Provider {
  readonly config: ProviderConfig;
  readonly #apiKey: string | undefined;

  constructor(config: ProviderConfig, apiKey?: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey) h.authorization = `Bearer ${this.#apiKey}`;
    return h;
  }

  #url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await reach(this.config, this.#url('/models'), { headers: this.#headers(), signal });
    if (!res.ok) await failFromResponse(res, this.config.label);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id).sort();
  }

  /**
   * 3.4.1: context windows from the provider's own list: Ollama /api/tags (+ /api/show for the model
   * asked about), OpenRouter /models, Gemini's models API, else whatever /models carries.
   */
  async modelLimits(model: string, signal?: AbortSignal): Promise<Record<string, ModelLimits>> {
    const base = this.config.baseUrl;
    if (isDaemon(base)) {
      const root = daemonRoot(base);
      let out: Record<string, ModelLimits> = {};
      const tags = await reach(this.config, `${root}/api/tags`, { signal }).catch(() => undefined);
      if (tags?.ok) out = parseOllamaTags(await tags.json());
      const show = await reach(this.config, `${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal }).catch(() => undefined);
      const l = show?.ok ? parseOllamaShow(await show.json()) : undefined;
      if (l) out[model] = { ...out[model], ...l };
      return out;
    }
    if (/generativelanguage\.googleapis\.com/i.test(base)) {
      const key = this.#apiKey;
      const res = await reach(this.config, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: key ? { 'x-goog-api-key': key } : {}, signal });
      return res.ok ? parseGemini(await res.json()) : {};
    }
    const res = await reach(this.config, this.#url('/models'), { headers: this.#headers(), signal });
    if (!res.ok) return {};
    const body = await res.json();
    if (/openrouter\.ai/i.test(base)) return parseOpenRouter(body);
    const out = parseOpenAIList(body);
    // LM Studio keeps the window in its own list.
    if (!Object.keys(out).length && /:1234\b/.test(base)) {
      const lm = await reach(this.config, `${daemonRoot(base)}/api/v0/models`, { headers: this.#headers(), signal }).catch(() => undefined);
      if (lm?.ok) return parseOpenAIList(await lm.json());
    }
    return out;
  }

  /** 3.4.5: Ollama's /api/ps (undefined when this isn't a daemon or it didn't answer). */
  async loadedModels(signal?: AbortSignal): Promise<unknown> {
    if (!isDaemon(this.config.baseUrl)) return undefined;
    const res = await reach(this.config, `${daemonRoot(this.config.baseUrl)}/api/ps`, { signal }).catch(() => undefined);
    return res?.ok ? await res.json().catch(() => undefined) : undefined;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    // 3.4.1: Ollama on your own computer gets the context Sara chose (its /v1 ignores num_ctx).
    const ctxKey = `${daemonRoot(this.config.baseUrl)}|${req.model}`;
    if (req.numCtx) ollamaCtx.set(ctxKey, req.numCtx);
    const numCtx = req.numCtx ?? ollamaCtx.get(ctxKey);
    if (numCtx && isDaemon(this.config.baseUrl) && !isCloudModelName(req.model) && !noNativeChat.has(daemonRoot(this.config.baseUrl)) && !req.strictUsage && req.maxResponseBytes === undefined) {
      const native = await this.#ollamaChat(req, numCtx);
      if (native) {
        yield* native;
        return;
      }
    }
    const res = await reach(this.config, this.#url('/chat/completions'), {
      method: 'POST',
      headers: this.#headers(),
      signal: req.signal,
      ...(req.redirect ? { redirect: req.redirect } : {}),
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAIMessages(req.messages, { strictToolOrder: strictToolOrder(this.config.baseUrl) }),
        stream: true,
        // Phase 52: ask for the token counts at the end of the stream (servers that don't know
        // the option ignore it).
        stream_options: { include_usage: true },
        ...(req.tools?.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        ...(req.reasoning && isOllama(this.config.baseUrl) ? { reasoning_effort: req.reasoning } : {}),
      }),
    });
    if (!res.ok) {
      if (req.strictUsage || req.maxResponseBytes !== undefined) {
        void res.body?.cancel().catch(() => {});
        throw new ProviderError('Configured provider refused the request.', res.status);
      }
      await failFromResponse(res, this.config.label, req.model);
    }
    if (!res.body) throw new ProviderError(`${this.config.label} returned no body`);

    const calls = new Map<number, PartialCall>();
    let usage: StreamEvent | undefined;
    let strictUsageInvalid = false;
    let finished = false;
    const flush = function* (): Generator<StreamEvent> {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (c.name) yield { type: 'tool_call', call: { id: c.id || `call_${randomUUID()}`, name: c.name, arguments: parseToolArguments(c.args) } };
      }
      calls.clear();
    };

    for await (const ev of sseEvents(res.body, req.maxResponseBytes)) {
      if (ev.data === '[DONE]') break;
      let json: {
        choices?: {
          delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
          finish_reason?: string | null;
        }[];
        error?: { message?: string };
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
      };
      try {
        json = JSON.parse(ev.data);
      } catch {
        if (req.strictUsage) strictUsageInvalid = true;
        continue;
      }
      if (json.error) throw new ProviderError(`${this.config.label}: ${json.error.message ?? 'stream error'}`);
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const [i, tc] of (delta?.tool_calls ?? []).entries()) {
        const index = tc.index ?? i;
        const cur = calls.get(index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(index, cur);
        // Phase 63: the piece itself, so the app can show the call taking shape.
        // (Pieces that came before the name are sent with the first one that has it.)
        if (cur.name) {
          const piece = cur.announced ? (tc.function?.arguments ?? '') : cur.args;
          cur.announced = true;
          yield { type: 'tool_delta', index, ...(cur.id ? { id: cur.id } : {}), name: cur.name, args: piece };
        }
        // Long arguments (a big file): report progress every ~2 KB so the app isn't silent.
        if (cur.name && cur.args.length - (cur.reported ?? 0) >= 2048) {
          cur.reported = cur.args.length;
          yield { type: 'tool_progress', name: cur.name, chars: cur.args.length, path: partialPath(cur.args) };
        }
      }
      if (json.usage && (json.usage.prompt_tokens !== undefined || json.usage.completion_tokens !== undefined)) {
        if (req.strictUsage) {
          const valid = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
          const cached = json.usage.prompt_tokens_details?.cached_tokens;
          if (usage || !valid(json.usage.prompt_tokens) || !valid(json.usage.completion_tokens) || cached !== undefined && (!valid(cached) || cached > Number(json.usage.prompt_tokens))) strictUsageInvalid = true;
        }
        usage = { type: 'usage', input: Number(json.usage.prompt_tokens ?? 0), output: Number(json.usage.completion_tokens ?? 0), ...(json.usage.prompt_tokens_details?.cached_tokens ? { cached: Number(json.usage.prompt_tokens_details.cached_tokens) } : {}) };
      }
      if (choice?.finish_reason) { finished = true; yield* flush(); }
    }
    yield* flush();
    if (req.strictUsage && (strictUsageInvalid || !finished)) yield { type: 'usage', input: NaN, output: NaN };
    else if (usage) yield usage;
  }

  /**
   * 3.4.1: one call through Ollama's /api/chat with options.num_ctx. Undefined when this daemon has
   * no /api/chat (an old Ollama, another server): the caller uses /v1 instead, from then on.
   */
  async #ollamaChat(req: ChatRequest, numCtx: number): Promise<AsyncIterable<StreamEvent> | undefined> {
    const root = daemonRoot(this.config.baseUrl);
    const think = req.reasoning === undefined ? undefined : req.reasoning === 'none' ? false : /gpt-oss/i.test(req.model) ? req.reasoning : true;
    const res = await reach(this.config, `${root}/api/chat`, {
      method: 'POST',
      headers: this.#headers(),
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: toOllamaMessages(req.messages),
        stream: true,
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        options: { num_ctx: numCtx, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}) },
        ...(think !== undefined ? { think } : {}),
      }),
    });
    if (res.status === 404 || res.status === 405) {
      const text = await res.text().catch(() => '');
      // "model not found" is a real answer; a missing route means no native API here.
      if (!/model/i.test(text)) {
        noNativeChat.add(root);
        return undefined;
      }
      throw new ProviderError(friendlyNotFound(this.config.label, req.model, text), 404);
    }
    if (!res.ok) await failFromResponse(res, this.config.label, req.model);
    if (!res.body) throw new ProviderError(`${this.config.label} returned no body`);
    const body = res.body;
    const self = this;
    return (async function* (): AsyncGenerator<StreamEvent> {
      // 3.4.5: the model is loaded now: where it runs (/api/ps) decides the next calls' context.
      let loaded = false;
      const decoder = new TextDecoder();
      let buf = '';
      let n = 0;
      const lines = async function* (): AsyncGenerator<string> {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) yield line;
          }
        }
        if (buf.trim()) yield buf.trim();
      };
      for await (const line of lines()) {
        let j: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] }; done?: boolean; error?: string; prompt_eval_count?: number; eval_count?: number };
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(`${'Ollama'}: ${j.error}`);
        if (!loaded) {
          loaded = true;
          void refreshPs(self);
        }
        if (j.message?.content) yield { type: 'text', text: j.message.content };
        for (const c of j.message?.tool_calls ?? []) {
          const name = c.function?.name;
          if (!name) continue;
          const a = c.function?.arguments;
          const args = a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : typeof a === 'string' ? parseToolArguments(a) : {};
          const id = c.id || `call_${randomUUID()}`;
          yield { type: 'tool_delta', index: n, id, name, args: JSON.stringify(args) };
          yield { type: 'tool_call', call: { id, name, arguments: args } };
          n++;
        }
        if (j.done) {
          if (j.prompt_eval_count !== undefined || j.eval_count !== undefined) yield { type: 'usage', input: Number(j.prompt_eval_count ?? 0), output: Number(j.eval_count ?? 0) };
          break;
        }
      }
    })();
  }
}

const friendlyNotFound = (label: string, model: string, text: string): string => `${label} doesn't have the model "${model}". Pick another one in Settings → Models, or download it with: ollama pull ${model}${text ? ` (${label} said: ${text.replace(/\s+/g, ' ').slice(0, 200)})` : ''}`;

/** Tests: forget the remembered num_ctx and the daemons without /api/chat. */
export function resetOllamaContext(): void {
  ollamaCtx.clear();
  noNativeChat.clear();
}

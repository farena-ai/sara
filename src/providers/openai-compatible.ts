// Adapter for any OpenAI-compatible chat API: OpenAI, xAI (Grok), Ollama (local and cloud),
// OpenRouter, vLLM, LM Studio, llama.cpp server, Groq, etc.
import { randomUUID } from 'node:crypto';
import { sseEvents } from '../sse.ts';
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

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const res = await reach(this.config, this.#url('/chat/completions'), {
      method: 'POST',
      headers: this.#headers(),
      signal: req.signal,
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
    if (!res.ok) await failFromResponse(res, this.config.label, req.model);
    if (!res.body) throw new ProviderError(`${this.config.label} returned no body`);

    const calls = new Map<number, PartialCall>();
    let usage: StreamEvent | undefined;
    const flush = function* (): Generator<StreamEvent> {
      for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (c.name) yield { type: 'tool_call', call: { id: c.id || `call_${randomUUID()}`, name: c.name, arguments: parseToolArguments(c.args) } };
      }
      calls.clear();
    };

    for await (const ev of sseEvents(res.body)) {
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
        usage = { type: 'usage', input: Number(json.usage.prompt_tokens ?? 0), output: Number(json.usage.completion_tokens ?? 0), ...(json.usage.prompt_tokens_details?.cached_tokens ? { cached: Number(json.usage.prompt_tokens_details.cached_tokens) } : {}) };
      }
      if (choice?.finish_reason) yield* flush();
    }
    yield* flush();
    if (usage) yield usage;
  }
}

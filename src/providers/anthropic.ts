// Adapter for the Anthropic Messages API (API-key auth).
import { sseEvents } from '../sse.ts';
import { parseAnthropic, type ModelLimits } from '../model-context.ts';
import {
  failFromResponse,
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

const API_VERSION = '2023-06-01';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Block[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface WireMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

/** Converts to Anthropic format: system prompt separate; tool results become user tool_result blocks. */
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: WireMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        const blocks: Block[] = m.content ? [{ type: 'text', text: m.content }] : [];
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else if (m.role === 'tool') {
      // Phase 49: screenshots a tool took go inside its result.
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map((img): Block => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }))] : m.content };
      const prev = out.at(-1);
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((b) => b.type === 'tool_result')) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else {
      const blocks: Block[] = [...(m.images ?? []).map((img): Block => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })), { type: 'text', text: m.content }];
      // Phase 116 (BR2 risk 1): a user line after tool results (a steer) or after another user line
      // goes into the same user turn: the tool_result blocks first, then the text.
      const prev = out.at(-1);
      if (prev?.role === 'user') {
        prev.content = [...(typeof prev.content === 'string' ? [{ type: 'text', text: prev.content } as Block] : prev.content), ...blocks];
      } else if (m.images?.length) out.push({ role: 'user', content: blocks });
      else out.push({ role: 'user', content: m.content });
    }
  }
  return { system, messages: out };
}

export class AnthropicProvider implements Provider {
  readonly config: ProviderConfig;
  readonly #apiKey: string | undefined;

  constructor(config: ProviderConfig, apiKey?: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': API_VERSION };
    if (this.#apiKey) h['x-api-key'] = this.#apiKey;
    return h;
  }

  #url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  /** 3.4.1: max_input_tokens / max_tokens from the models API (src/model-context.ts). */
  async modelLimits(_model: string, signal?: AbortSignal): Promise<Record<string, ModelLimits>> {
    const res = await reach(this.config, this.#url('/models?limit=1000'), { headers: this.#headers(), signal });
    if (!res.ok) return {};
    return parseAnthropic(await res.json());
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await reach(this.config, this.#url('/models?limit=100'), { headers: this.#headers(), signal });
    if (!res.ok) await failFromResponse(res, this.config.label);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id).sort();
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const { system, messages } = toAnthropic(req.messages);
    const res = await reach(this.config, this.#url('/messages'), {
      method: 'POST',
      headers: this.#headers(),
      signal: req.signal,
      ...(req.redirect ? { redirect: req.redirect } : {}),
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
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

    const tools = new Map<number, { id: string; name: string; json: string; reported?: number }>();
    let used: { input: number; output: number; cached: number } | undefined;
    let strictUsageInvalid = false;
    let strictInput = false;
    let strictOutput = false;
    // Cache reads and writes are input too (reads are the cheap "cached" part).
    const addUsage = (u: AnthropicUsage) => {
      if (req.strictUsage) {
        // Usage also carries descriptive metadata; only the known accounting counters are numeric.
        for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
          const value = u[field];
          if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) strictUsageInvalid = true;
        }
      }
      used ??= { input: 0, output: 0, cached: 0 };
      if (u.input_tokens !== undefined || u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined) {
        used.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) || used.input;
        used.cached = u.cache_read_input_tokens ?? used.cached;
      }
      if (u.output_tokens !== undefined) used.output = u.output_tokens;
    };
    for await (const ev of sseEvents(res.body, req.maxResponseBytes)) {
      let json: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string };
        error?: { message?: string };
        message?: { usage?: AnthropicUsage };
        usage?: AnthropicUsage;
      };
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (json.type) {
        case 'error':
          throw new ProviderError(`${this.config.label}: ${json.error?.message ?? 'stream error'}`);
        case 'content_block_start':
          if (json.content_block?.type === 'tool_use') {
            tools.set(json.index ?? 0, { id: json.content_block.id ?? '', name: json.content_block.name ?? '', json: '' });
            // Phase 63: the app shows the call from its first moment.
            yield { type: 'tool_delta', index: json.index ?? 0, ...(json.content_block.id ? { id: json.content_block.id } : {}), name: json.content_block.name ?? '', args: '' };
          }
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta' && json.delta.text) yield { type: 'text', text: json.delta.text };
          else if (json.delta?.type === 'input_json_delta') {
            const t = tools.get(json.index ?? 0);
            if (t) {
              t.json += json.delta.partial_json ?? '';
              if (json.delta.partial_json) yield { type: 'tool_delta', index: json.index ?? 0, ...(t.id ? { id: t.id } : {}), name: t.name, args: json.delta.partial_json };
              // Long arguments (a big file): report progress every ~2 KB.
              if (t.json.length - (t.reported ?? 0) >= 2048) {
                t.reported = t.json.length;
                yield { type: 'tool_progress', name: t.name, chars: t.json.length, path: partialPath(t.json) };
              }
            }
          }
          break;
        case 'content_block_stop': {
          const t = tools.get(json.index ?? 0);
          if (t) {
            tools.delete(json.index ?? 0);
            yield { type: 'tool_call', call: { id: t.id, name: t.name, arguments: parseToolArguments(t.json) } };
          }
          break;
        }
        case 'message_start':
          // Phase 52: input tokens come first, output tokens grow in message_delta.
          if (json.message?.usage) { strictInput = json.message.usage.input_tokens !== undefined; addUsage(json.message.usage); }
          break;
        case 'message_delta':
          if (json.usage) { strictOutput ||= json.usage.output_tokens !== undefined; addUsage(json.usage); }
          break;
        case 'message_stop':
          if (req.strictUsage && (strictUsageInvalid || !strictInput || !strictOutput || !used || !Number.isSafeInteger(used.input) || !Number.isSafeInteger(used.output))) yield { type: 'usage', input: NaN, output: NaN };
          else if (used) yield { type: 'usage', input: used.input, output: used.output, ...(used.cached ? { cached: used.cached } : {}) };
          return;
      }
    }
  }
}

// Adapter for the Anthropic Messages API (API-key auth).
import { moveClockToEnd } from '../time-sense.ts';
import { sseEvents } from '../sse.ts';
import { parseAnthropic, type ModelLimits } from '../model-context.ts';
import { claudeExtras } from './claude-traits.ts';
import {
  errorDetail,
  failFromResponse,
  friendlyHttpError,
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

type CacheMark = { cache_control?: { type: 'ephemeral' } };
type Block = CacheMark & (
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Block[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  // Z5: a thinking block handed back as it came (signed; never edited, never marked for the cache).
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
);

const isThinking = (b: unknown): boolean => typeof b === 'object' && b !== null && ((b as { type?: unknown }).type === 'thinking' || (b as { type?: unknown }).type === 'redacted_thinking');

interface WireMessage {
  role: 'user' | 'assistant';
  content: string | Block[];
}

/** X1: how a system note that comes after the conversation started is shown to the model (it is not the person speaking). */
export const APP_NOTE = '[Note from the app, not from the person]';

/**
 * Converts to Anthropic format: system prompt separate; tool results become user tool_result blocks.
 * X1: only the system messages before the conversation make the system prompt. A system note after
 * that (the time now, a correction, a steer) stays where it is, as a marked note in the user turn:
 * hoisting it into the system prompt changed the prompt every step, which threw away the cache of
 * everything after it, and put "see the results above" above the results.
 */
export function toAnthropic(input: ChatMessage[], thinkingFor?: string): { system: string; messages: WireMessage[]; stableBlocks: number; thinking: number } {
  let thinking = 0;
  const messages = moveClockToEnd(input);
  const lead = messages.findIndex((m) => m.role !== 'system');
  const head = lead < 0 ? messages : messages.slice(0, lead);
  const system = head.map((m) => m.content).join('\n\n');
  const out: WireMessage[] = [];
  /** Late notes waiting to go at the end of the user turn they follow. */
  let notes: string[] = [];
  let stableBlocks = 0;
  const count = () => out.reduce((n, w) => n + (typeof w.content === 'string' ? 1 : w.content.length), 0);
  for (const m of lead < 0 ? [] : messages.slice(lead)) {
    if (m.role === 'system') {
      if (m.content.trim()) notes.push(m.content);
      continue;
    }
    if (notes.length) {
      // A note between two messages: its own user text, joined to the user turn around it.
      const prev = out.at(-1);
      const block: Block = { type: 'text', text: `${APP_NOTE}\n${notes.join('\n\n')}` };
      if (prev?.role === 'user') prev.content = [...(typeof prev.content === 'string' ? [{ type: 'text', text: prev.content } as Block] : prev.content), block];
      else out.push({ role: 'user', content: [block] });
      notes = [];
    }
    if (m.role === 'assistant') {
      if (m.toolCalls?.length) {
        // Z5: what this model thought before these calls goes back first, as it came. Another model's
        // thinking is left out (it could not read it).
        const thought = thinkingFor && m.thinking?.model === thinkingFor ? (m.thinking.blocks.filter(isThinking) as Block[]) : [];
        thinking += thought.length;
        const blocks: Block[] = [...thought, ...(m.content ? [{ type: 'text', text: m.content } as Block] : [])];
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
  // Everything up to here is the same on the next step; the notes after it change every step.
  stableBlocks = count();
  if (notes.length) {
    const prev = out.at(-1);
    const block: Block = { type: 'text', text: `${APP_NOTE}\n${notes.join('\n\n')}` };
    if (prev?.role === 'user') prev.content = [...(typeof prev.content === 'string' ? [{ type: 'text', text: prev.content } as Block] : prev.content), block];
    else out.push({ role: 'user', content: [block] });
  }
  return { system, messages: out, stableBlocks, thinking };
}

/**
 * X1: the most a model writes in one reply when the caller sets no limit. 4,096 cut long files and
 * plans short on every current model; the old models keep their real ceilings.
 */
export function defaultMaxTokens(model: string): number {
  if (/claude-3-5|claude-3\.5/i.test(model)) return 8192;
  if (/claude-(3|2|instant)\b|claude-3-(opus|sonnet|haiku)/i.test(model)) return 4096;
  return 32_000;
}

/** Y4: where her instructions turn from what stays the same to what changes each turn (src/persona.ts). */
export const LIVE_PART = '\n\n## Right now\n';

/**
 * Y4: the system prompt as blocks. The part that is the same on every turn carries the cache mark; the
 * part that changes each turn (time, mood, memory) follows unmarked, so a new turn still reuses the
 * tools and the long first part. Within one turn the mark on the last message covers all of it.
 */
function systemBlocks(system: string, mark: { cache_control: { type: 'ephemeral' } }): (Block & { type: 'text' })[] {
  const at = system.indexOf(LIVE_PART);
  if (at <= 0) return [{ type: 'text', text: system, ...mark }];
  return [
    { type: 'text', text: system.slice(0, at), ...mark },
    { type: 'text', text: system.slice(at + 2) },
  ];
}

/**
 * X1: prompt caching. The request is read as tools, then the system prompt, then the messages, and a
 * cache mark stores everything before it for a few minutes at a tenth of the price. Three marks: the
 * last tool, the system prompt, and the last block that will still be there on the next step (not the
 * per-step notes after it). A changed byte before a mark means no hit from there on, which is why the
 * time of day is not in the system prompt (src/chat.ts).
 */
export function withCacheMarks<T extends { name: string }>(system: string, messages: WireMessage[], stableBlocks: number, tools: T[] | undefined): { system?: (Block & { type: 'text' })[]; messages: WireMessage[]; tools?: (T & CacheMark)[] } {
  const mark = { cache_control: { type: 'ephemeral' as const } };
  let left = stableBlocks;
  const marked = messages.map((w): WireMessage => {
    const n = typeof w.content === 'string' ? 1 : w.content.length;
    const hit = left > 0 && left <= n;
    const at = left - 1;
    left -= n;
    if (!hit) return w;
    const blocks: Block[] = typeof w.content === 'string' ? [{ type: 'text', text: w.content }] : [...w.content];
    // An empty text block can't carry a mark.
    const b = blocks[at]!;
    if (b.type === 'text' && !b.text) return w;
    if (isThinking(b)) return w; // a thinking block goes back untouched
    blocks[at] = { ...b, ...mark };
    return { ...w, content: blocks };
  });
  return {
    ...(system ? { system: systemBlocks(system, mark) } : {}),
    messages: marked,
    ...(tools?.length ? { tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, ...mark } : t)) } : {}),
  };
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

  /** Z5: after the API refused replayed thinking once, it is left out for a while (ms since epoch). */
  #noReplayUntil = 0;

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const toolSpecs = req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    // Z5 (src/providers/claude-traits.ts): what this model takes: no temperature on the newer ones,
    // effort in place of a thinking switch, room for thinking under a small reply limit.
    const extras = claudeExtras(req, defaultMaxTokens(req.model));
    const send = (replay: boolean): Promise<Response> & { thinking?: number } => {
      const wire = toAnthropic(req.messages, replay ? req.model : undefined);
      const cached = withCacheMarks(wire.system, wire.messages, wire.stableBlocks, toolSpecs);
      const p: Promise<Response> & { thinking?: number } = reach(this.config, this.#url('/messages'), {
        method: 'POST',
        headers: this.#headers(),
        signal: req.signal,
        ...(req.redirect ? { redirect: req.redirect } : {}),
        body: JSON.stringify({
          model: req.model,
          stream: true,
          ...extras,
          ...(cached.system ? { system: cached.system } : {}),
          messages: cached.messages,
          ...(cached.tools ? { tools: cached.tools } : {}),
        }),
      });
      p.thinking = wire.thinking;
      return p;
    };
    const first = send(Date.now() >= this.#noReplayUntil);
    let res = await first;
    if (res.status === 400 && first.thinking && !(req.strictUsage || req.maxResponseBytes !== undefined)) {
      // Z5: thinking handed back is checked by the API against the conversation it came from. Her
      // per-step notes can make that check fail on accounts where it is enforced. Then the step runs
      // once more without the thinking (the documented recovery), and it stays out for ten minutes.
      const said = errorDetail((await res.text().catch(() => '')).slice(0, 2000));
      if (!/thinking/i.test(said)) throw new ProviderError(friendlyHttpError(this.config.label, 400, said, req.model), 400);
      this.#noReplayUntil = Date.now() + 10 * 60_000;
      console.warn(`${this.config.label} (${req.model}) would not take its earlier thinking back; this step runs without it`);
      res = await send(false);
    }
    if (!res.ok) {
      if (req.strictUsage || req.maxResponseBytes !== undefined) {
        void res.body?.cancel().catch(() => {});
        throw new ProviderError('Configured provider refused the request.', res.status);
      }
      await failFromResponse(res, this.config.label, req.model);
    }
    if (!res.body) throw new ProviderError(`${this.config.label} returned no body`);

    const tools = new Map<number, { id: string; name: string; json: string; reported?: number }>();
    // Z5: thinking blocks as they arrive (by position), then in order once each is complete.
    const thinking = new Map<number, Record<string, unknown>>();
    const thought: Record<string, unknown>[] = [];
    let thoughtChars = 0;
    let thoughtSaid = false;
    const sayThought = function* (model: string): Generator<StreamEvent> {
      if (thoughtSaid || !thought.length) return;
      thoughtSaid = true;
      // Never an empty count: with the text left out by the API, a block is still thinking that happened.
      yield { type: 'reasoning', chars: Math.max(thoughtChars, thought.length) };
      yield { type: 'thinking', kept: { model, blocks: thought } };
    };
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
        content_block?: { type?: string; id?: string; name?: string; [k: string]: unknown };
        delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string | null };
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
          } else if (json.content_block?.type === 'thinking') {
            thinking.set(json.index ?? 0, { type: 'thinking', thinking: typeof json.content_block.thinking === 'string' ? json.content_block.thinking : '', signature: typeof json.content_block.signature === 'string' ? json.content_block.signature : '' });
          } else if (json.content_block?.type === 'redacted_thinking') {
            thinking.set(json.index ?? 0, { ...json.content_block });
          }
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta' && json.delta.text) yield { type: 'text', text: json.delta.text };
          else if (json.delta?.type === 'thinking_delta' || json.delta?.type === 'signature_delta') {
            const b = thinking.get(json.index ?? 0);
            if (b && json.delta.type === 'thinking_delta' && json.delta.thinking) {
              b.thinking = `${b.thinking as string}${json.delta.thinking}`;
              thoughtChars += json.delta.thinking.length;
            } else if (b && json.delta.type === 'signature_delta' && json.delta.signature) b.signature = `${b.signature as string}${json.delta.signature}`;
          } else if (json.delta?.type === 'input_json_delta') {
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
          const th = thinking.get(json.index ?? 0);
          if (th) {
            thinking.delete(json.index ?? 0);
            // A block with no signature cannot be handed back (cut off mid-block): leave it out.
            if (th.type !== 'thinking' || th.signature) thought.push(th);
            else thoughtChars ||= 1;
          }
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
          // X1: a reply cut at the output limit, or declined by the provider, is said so (never silently short).
          if (json.delta?.stop_reason === 'max_tokens') {
            // A tool call still being written is incomplete: hand it over as it is, marked by its unparsed text.
            for (const [i, t] of tools) {
              tools.delete(i);
              yield { type: 'tool_call', call: { id: t.id, name: t.name, arguments: { _raw: t.json } } };
            }
            yield { type: 'stop', reason: 'length' };
          } else if (json.delta?.stop_reason === 'refusal') yield { type: 'stop', reason: 'refusal' };
          break;
        case 'message_stop':
          yield* sayThought(req.model);
          if (!thoughtSaid && thoughtChars) yield { type: 'reasoning', chars: thoughtChars };
          if (req.strictUsage && (strictUsageInvalid || !strictInput || !strictOutput || !used || !Number.isSafeInteger(used.input) || !Number.isSafeInteger(used.output))) yield { type: 'usage', input: NaN, output: NaN };
          else if (used) yield { type: 'usage', input: used.input, output: used.output, ...(used.cached ? { cached: used.cached } : {}) };
          return;
      }
    }
  }
}

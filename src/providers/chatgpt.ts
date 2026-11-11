// ChatGPT plan provider: OpenAI Responses API with the owner's Sign in with ChatGPT token.
// Route rules (preview): store:false + stream:true, system text in `instructions` (later system
// notes as developer messages), function tools grouped in a namespace, no temperature /
// max_output_tokens, full history in `input`. Bearer tokens go only to api.openai.com.
import { parseOpenAIList, type ModelLimits } from '../model-context.ts';
import { netFetch } from '../net-guard.ts';
import { sseEvents } from '../sse.ts';
import { USAGE_URL, type ChatGptAuth } from '../subscriptions/chatgpt.ts';
import { parseToolArguments, ProviderError, type ChatMessage, type ChatRequest, type Provider, type ProviderConfig, type StreamEvent } from './types.ts';

export const CHATGPT_API = 'https://api.openai.com/v1';
const NS = 'sara';

type InputItem =
  | { role: 'user' | 'assistant' | 'developer'; content: string }
  | { role: 'user'; content: ({ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string })[] }
  | { type: 'function_call'; call_id: string; name: string; namespace: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export function toResponsesInput(messages: ChatMessage[]): { instructions: string; input: InputItem[] } {
  let instructions = '';
  const input: InputItem[] = [];
  const shots: { mime: string; data: string }[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'system') {
      if (i === 0) instructions = m.content;
      else input.push({ role: 'developer', content: m.content });
    } else if (m.role === 'user') {
      if (m.images?.length) input.push({ role: 'user', content: [{ type: 'input_text', text: m.content }, ...m.images.map((img) => ({ type: 'input_image' as const, image_url: `data:${img.mime};base64,${img.data}` }))] });
      else input.push({ role: 'user', content: m.content });
    }
    else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const c of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.name, namespace: NS, arguments: JSON.stringify(c.arguments) });
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
      // Phase 49: screenshots a tool took, after the last result of the group.
      if (m.images?.length) shots.push(...m.images);
      if (shots.length && messages[i + 1]?.role !== 'tool') {
        input.push({ role: 'user', content: [{ type: 'input_text', text: '[Note from the app: the screenshot(s) your tools just took, for you to look at.]' }, ...shots.map((img) => ({ type: 'input_image' as const, image_url: `data:${img.mime};base64,${img.data}` }))] });
        shots.length = 0;
      }
    }
  });
  return { instructions, input };
}

const FRIENDLY: Record<string, string> = {
  subscription_sharing_usage_limit_exceeded: `You've reached your ChatGPT plan's usage limit for now. Manage usage: ${USAGE_URL}`,
  subscription_sharing_usage_unavailable: `ChatGPT plan usage isn't available right now. Manage usage: ${USAGE_URL}`,
  subscription_sharing_user_not_eligible: 'This ChatGPT account or workspace is not eligible to use its plan in other apps.',
};

export class ChatGptProvider implements Provider {
  readonly config: ProviderConfig;
  readonly #auth: ChatGptAuth;
  readonly #api: string;

  constructor(config: ProviderConfig, auth: ChatGptAuth, opts: { api?: string } = {}) {
    this.config = config;
    this.#auth = auth;
    // Fixed endpoint: never send the ChatGPT token to a configurable base URL.
    this.#api = opts.api ?? CHATGPT_API;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await netFetch(`${this.#api}/models`, { headers: { authorization: `Bearer ${await this.#auth.accessToken()}` }, signal });
    if (!res.ok) throw new ProviderError(`ChatGPT models: HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { models?: { slug: string; visibility?: string }[]; data?: { id: string }[] };
    if (body.models) return body.models.filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug);
    return (body.data ?? []).map((m) => m.id);
  }

  /** 3.4.1: the plan's model list carries context_window on recent backends (else the table). */
  async modelLimits(_model: string, signal?: AbortSignal): Promise<Record<string, ModelLimits>> {
    const res = await netFetch(`${this.#api}/models`, { headers: { authorization: `Bearer ${await this.#auth.accessToken()}` }, signal });
    if (!res.ok) return {};
    return parseOpenAIList(await res.json());
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const { instructions, input } = toResponsesInput(req.messages);
    const body: Record<string, unknown> = { model: req.model, instructions, input, store: false, stream: true };
    if (req.tools?.length) {
      body.tools = [{ type: 'namespace', name: NS, description: "Sara's tools on the owner's server.", tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    if (req.reasoning && req.reasoning !== 'none') body.reasoning = { effort: req.reasoning };
    const res = await netFetch(`${this.#api}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.#auth.accessToken()}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code = '';
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string }; detail?: string };
        code = j.error?.code ?? '';
        message = j.error?.message ?? j.detail ?? message;
      } catch {
        /* not JSON */
      }
      throw new ProviderError(FRIENDLY[code] ?? `ChatGPT returned HTTP ${res.status}: ${message}`, res.status);
    }
    if (!res.body) throw new ProviderError('ChatGPT returned no body');
    let completed = false;
    for await (const ev of sseEvents(res.body)) {
      let j: { type?: string; delta?: string; output_index?: number; item?: { type?: string; call_id?: string; name?: string; arguments?: string }; response?: { error?: { code?: string; message?: string }; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } };
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (j.type) {
        case 'response.output_text.delta':
          if (j.delta) yield { type: 'text', text: j.delta };
          break;
        // Phase 63: a function call taking shape (shown in the app; run only once it's done).
        case 'response.output_item.added':
          if (j.item?.type === 'function_call') yield { type: 'tool_delta', index: j.output_index ?? 0, ...(j.item.call_id ? { id: j.item.call_id } : {}), name: j.item.name ?? '', args: j.item.arguments ?? '' };
          break;
        case 'response.function_call_arguments.delta':
          if (j.delta) yield { type: 'tool_delta', index: j.output_index ?? 0, args: j.delta };
          break;
        case 'response.output_item.done':
          if (j.item?.type === 'function_call') yield { type: 'tool_call', call: { id: j.item.call_id ?? '', name: j.item.name ?? '', arguments: parseToolArguments(j.item.arguments ?? '') } };
          break;
        case 'response.failed': {
          const code = j.response?.error?.code ?? '';
          throw new ProviderError(FRIENDLY[code] ?? `ChatGPT: ${j.response?.error?.message ?? code ?? 'response failed'}`, code.includes('limit') ? 429 : undefined);
        }
        case 'error':
          throw new ProviderError(`ChatGPT: ${(j as { message?: string }).message ?? 'stream error'}`);
        case 'response.incomplete':
          // Ran out of room or was cut short; what arrived so far stands.
          return;
        case 'response.completed': {
          completed = true;
          // Phase 52: the plan's token counts (billed to the subscription: shown as $0).
          const u = j.response?.usage;
          if (u && (u.input_tokens !== undefined || u.output_tokens !== undefined)) yield { type: 'usage', input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, ...(u.input_tokens_details?.cached_tokens ? { cached: u.input_tokens_details.cached_tokens } : {}) };
          return;
        }
      }
    }
    if (!completed) throw new ProviderError('ChatGPT stream ended early. Try again.');
  }
}

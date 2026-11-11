import { isPrivateLocalError, netFetch } from '../net-guard.ts';
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. `arguments` is the parsed JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  /** Phase 116: `steer` = a message the owner sent while she worked, right after tool results (adapters that can't take that shape fold it). */
  | { role: 'user'; content: string; images?: ImageData[]; steer?: boolean }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  /** Phase 49: `images` are screenshots a tool took for the model to look at. */
  | { role: 'tool'; toolCallId: string; name: string; content: string; images?: ImageData[] };

/**
 * Phase 116 (BR2 risk 1): for APIs that refuse a user line straight after tool results (strict
 * tool → assistant ordering), a steer is folded into the tool result before it, labelled, so
 * nothing is lost. A steer with pictures stays its own line (a tool result can't carry them).
 */
export function foldSteers(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out.at(-1);
    if (m.role === 'user' && m.steer && !m.images?.length && prev?.role === 'tool') {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n[Message from the person you are helping, sent while this step ran:]\n${m.content}` };
      continue;
    }
    out.push(m);
  }
  return out;
}

/** A photo sent to a vision model (base64, no data: prefix). */
export interface ImageData {
  mime: string;
  data: string;
}

/** Tool definition sent to the model. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /**
   * How much the model may "think" first. 'none' for background chores (memory notes) so a
   * reasoning model doesn't spend its whole budget thinking. Sent where the API supports it.
   */
  reasoning?: 'none' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  /** Business admission requires complete, exact aggregate usage; unknown counts stay non-finite. */
  strictUsage?: boolean;
  /** Optional total raw streaming-response byte ceiling, checked before SSE buffering. */
  maxResponseBytes?: number;
  /** Business requests require the configured canonical endpoint and refuse all redirects. */
  redirect?: 'error';
  /**
   * 3.4.1: Ollama on your own computer: the context to load the model with (options.num_ctx). Its
   * OpenAI-compatible endpoint ignores it, so the request goes to Ollama's own /api/chat.
   */
  numCtx?: number;
}

/** Streamed output: text deltas as they arrive; tool calls once fully assembled. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  /** A long tool call is still arriving (e.g. a big file being written): how much so far. */
  | { type: 'tool_progress'; name: string; chars: number; path?: string }
  /**
   * Phase 63: a raw piece of a tool call's arguments as the model writes it (`args` is only the
   * new part). `index` tells parallel calls apart. Only for showing: never run anything from it.
   */
  | { type: 'tool_delta'; index: number; id?: string; name?: string; args: string }
  /** Phase 52: the token counts the provider reported for this call (once, at the end). */
  | { type: 'usage'; input: number; output: number; cached?: number };

/**
 * 'chatgpt' = ChatGPT plan via Sign in with ChatGPT; 'claude-code' / 'grok-cli' = subscription
 * models through the vendors' official command-line programs.
 */
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'chatgpt' | 'claude-code' | 'grok-cli';
export const SUBSCRIPTION_KINDS: readonly ProviderKind[] = ['chatgpt', 'claude-code', 'grok-cli'];
/** Subscription command-line agents get text only: a photo never reaches them (2.52.1). */
export const BLIND_KINDS: readonly ProviderKind[] = ['claude-code', 'grok-cli'];
export const seesPictures = (config: { kind: ProviderKind }): boolean => !BLIND_KINDS.includes(config.kind);

/** Stored provider settings. API keys are never stored here; they live in the encrypted vault. */
export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel?: string;
  /** Runs on hardware the owner controls (eligible for private/local-only conversations). */
  local?: boolean;
  /** Whether this provider needs an API key to work. */
  needsKey?: boolean;
}

export interface Provider {
  readonly config: ProviderConfig;
  listModels(signal?: AbortSignal): Promise<string[]>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /**
   * 3.4.1: context windows from the provider's own model list (tokens), keyed by model id; may
   * cover more models than the one asked for. Absent where the provider says nothing.
   */
  modelLimits?(model: string, signal?: AbortSignal): Promise<Record<string, import('../model-context.ts').ModelLimits>>;
  /** 3.4.5: an Ollama daemon's /api/ps body (the loaded models and how much of each is on the graphics card). */
  loadedModels?(signal?: AbortSignal): Promise<unknown>;
}

export class ProviderError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** True when a provider rejected the request because the model can't use tools. */
export function isToolsUnsupported(err: unknown): boolean {
  return err instanceof ProviderError && err.status === 400 && /tool/i.test(err.message);
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: raw };
  }
}

/** The provider's own words from an error body (`{"error":{"message":…}}` and the like). */
export function errorDetail(body: string): string {
  let text = body.trim();
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    const e = j.error;
    const m = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : typeof j.message === 'string' ? j.message : typeof j.detail === 'string' ? j.detail : '';
    if (m) text = m;
  } catch {
    // not JSON: keep the text (an HTML error page becomes nothing useful, so drop it)
    if (/^<!doctype|^<html/i.test(text)) text = '';
  }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/** A plain sentence for a failed provider request, with what to do, then the provider's words. */
export function friendlyHttpError(label: string, status: number, detail: string, model?: string): string {
  const said = detail ? ` (${label} said: ${detail})` : '';
  if (status === 401 || status === 403) return `${label} didn't accept the key or sign-in. Check it in Settings → Models → ${label}.${said}`;
  if (status === 404 && /model/i.test(detail)) return `${label} doesn't have the model${model ? ` "${model}"` : ''}. Pick another one in Settings → Models${/ollama/i.test(label) ? `, or download it with: ollama pull ${model ?? '<model>'}` : ''}.${said}`;
  if (status === 429) return `${label} says it's busy or the usage limit is reached. Try again in a minute, or set a backup model in Settings → Models.${said}`;
  if (status === 402 || /insufficient|quota|credit|billing/i.test(detail)) return `${label} needs credit or a paid plan for this.${said}`;
  if (status >= 500) return `${label} had a problem on its side (HTTP ${status}). Try again in a minute.${said}`;
  return `${label} returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

export async function failFromResponse(res: Response, label: string, model?: string): Promise<never> {
  let detail = '';
  try {
    detail = errorDetail((await res.text()).slice(0, 2000));
  } catch {
    // ignore
  }
  throw new ProviderError(friendlyHttpError(label, res.status, detail, model), res.status);
}

/** fetch() that turns "can't connect" into a plain sentence naming the provider and address. */
export async function reach(config: ProviderConfig, url: string, init: RequestInit): Promise<Response> {
  try {
    return await netFetch(url, init);
  } catch (err) {
    // Phase 67: "blocked by private local mode" is the real reason: say that, not "couldn't reach".
    if (init.signal?.aborted || (err as Error).name === 'AbortError' || isPrivateLocalError(err)) throw err;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep url */
    }
    throw new ProviderError(`Couldn't reach ${config.label} at ${host}. Is that computer on and its model server running?`);
  }
}

/** Phase 27: the file a tool is writing, read from its arguments while they are still arriving. */
export function partialPath(json: string): string | undefined {
  const m = /"(?:path|file|filename)"\s*:\s*"((?:[^"\\]|\\.){1,300})"/.exec(json);
  if (!m) return undefined;
  try {
    return (JSON.parse(`"${m[1]}"`) as string).split(/[\\/]/).pop() || undefined;
  } catch {
    return undefined;
  }
}

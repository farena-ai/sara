// EC3 (docs/ops/EC3_DESIGN.md §6): OpenTelemetry traces, hand-rolled as OTLP/HTTP JSON over fetch.
// One trace per sampled turn: the turn, its model calls, its tool and MCP calls. Attributes are ids,
// names, counts, sizes, durations and outcomes; never message text, prompts, arguments, output,
// error messages or secrets. Exports run after the turn and never throw into it.
import { randomBytes } from 'node:crypto';
import { netFetch } from '../net-guard.ts';
import type { ModelCallSeen } from './hub.ts';
import { tracesUrl, type TelemetrySettings } from './config.ts';
import type { ToolOutcome, TurnOutcome } from './metrics.ts';

export const MAX_SPANS = 256;
export const EXPORT_TIMEOUT_MS = 5000;
const KIND = { internal: 1, server: 2, client: 3 } as const;

type AttrValue = string | number | boolean;
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  /** Milliseconds since the epoch. */
  start: number;
  end: number;
  attributes: Record<string, AttrValue>;
  /** true = error, false = ok, undefined = unset (a stopped turn). */
  error?: boolean;
}

export interface ExportStatus {
  at: string;
  ok: boolean;
  spans: number;
  /** A fixed word or "HTTP <code>": never the collector's or the network's own text. */
  error?: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nanos = (ms: number) => (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();

function attr(key: string, v: AttrValue) {
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') return { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } };
  return { key, value: { stringValue: v } };
}

/** The OTLP/HTTP JSON request body for a batch (capped at MAX_SPANS). */
export function otlpBody(spans: SpanData[], version: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', 'sara'), attr('service.version', version)] },
        scopeSpans: [
          {
            scope: { name: 'sara', version },
            spans: spans.slice(0, MAX_SPANS).map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(Math.max(s.start, s.end)),
              attributes: Object.entries(s.attributes).map(([k, v]) => attr(k, v)),
              status: { code: s.error === undefined ? 0 : s.error ? 2 : 1 },
            })),
          },
        ],
      },
    ],
  };
}

function why(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (/private local/i.test(String(e?.message ?? ''))) return 'blocked';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  if (e?.name === 'TypeError' || e?.cause?.code) return 'unreachable';
  return 'failed';
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface TracerOptions {
  random?: () => number;
  fetch?: Fetch;
  timeoutMs?: number;
  now?: () => number;
  version?: string;
  /** Told about each export's outcome (the metrics counter). */
  onExport?: (ok: boolean) => void;
}

export interface TurnTrace {
  model(c: ModelCallSeen): void;
  tool(t: { tool: string; name: string; mcpServer?: string; outcome: ToolOutcome; ms: number; outputBytes: number }): void;
  end(outcome: TurnOutcome, o: { firstTokenMs?: number | null }): Promise<void>;
}

export class Tracer {
  readonly #o: TracerOptions;
  #last: ExportStatus | null = null;
  constructor(o: TracerOptions = {}) {
    this.#o = o;
  }
  get last(): ExportStatus | null {
    return this.#last;
  }
  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** A trace for this turn, or null when traces are off or the draw says not this one. */
  startTurn(cfg: TelemetrySettings['traces'], o: { conversationId: string; headers?: Record<string, string> }): TurnTrace | null {
    if (!cfg.enabled || !cfg.endpoint || !(cfg.sample > 0)) return null;
    if ((this.#o.random ?? Math.random)() >= cfg.sample) return null;
    const traceId = hex(16);
    const rootId = hex(8);
    const start = this.#now();
    const spans: SpanData[] = [];
    let models = 0;
    let tools = 0;
    let ended = false;
    const child = (s: Omit<SpanData, 'traceId' | 'spanId' | 'parentSpanId'>) => {
      if (ended || spans.length >= MAX_SPANS - 1) return;
      spans.push({ ...s, traceId, spanId: hex(8), parentSpanId: rootId });
    };
    return {
      model: (c) => {
        models++;
        child({
          name: 'sara.model.call',
          kind: KIND.client,
          start: c.startedAt,
          end: c.startedAt + c.ms,
          error: !c.ok,
          attributes: {
            'gen_ai.system': c.providerId,
            'gen_ai.request.model': c.model,
            'gen_ai.usage.input_tokens': c.in,
            'gen_ai.usage.output_tokens': c.out,
            'sara.usage.cached_tokens': c.cached,
            'sara.billing': c.billing,
            'sara.purpose': c.purpose ?? 'other',
            'sara.outcome': c.ok ? 'ok' : 'error',
            ...(c.usd !== null ? { 'sara.cost_usd': c.usd } : {}),
            ...(c.firstMs !== undefined ? { 'sara.first_token_ms': c.firstMs } : {}),
          },
        });
      },
      tool: (t) => {
        tools++;
        const end = this.#now();
        child({
          name: t.mcpServer ? 'sara.mcp.call' : 'sara.tool.call',
          kind: t.mcpServer ? KIND.client : KIND.internal,
          start: end - t.ms,
          end,
          error: t.outcome === 'error',
          attributes: { 'sara.tool.name': t.name, 'sara.outcome': t.outcome, 'sara.tool.output_bytes': t.outputBytes, ...(t.mcpServer ? { 'sara.mcp.server': t.mcpServer } : {}) },
        });
      },
      end: async (outcome, e) => {
        if (ended) return;
        ended = true;
        spans.unshift({
          traceId,
          spanId: rootId,
          name: 'sara.turn',
          kind: KIND.server,
          start,
          end: this.#now(),
          ...(outcome === 'stopped' ? {} : { error: outcome === 'error' }),
          attributes: { 'sara.conversation.id': o.conversationId, 'sara.turn.outcome': outcome, 'sara.turn.model_calls': models, 'sara.turn.tool_calls': tools, ...(e.firstTokenMs ? { 'sara.turn.first_token_ms': e.firstTokenMs } : {}) },
        });
        await this.send(cfg.endpoint, spans, o.headers ?? {});
      },
    };
  }

  /** Posts a batch. Never throws; remembers the outcome. */
  async send(endpoint: string, spans: SpanData[], headers: Record<string, string>): Promise<ExportStatus> {
    const n = Math.min(spans.length, MAX_SPANS);
    let status: ExportStatus;
    try {
      const f = this.#o.fetch ?? netFetch;
      const r = await f(tracesUrl(endpoint), {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(otlpBody(spans, this.#o.version ?? 'dev')),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? EXPORT_TIMEOUT_MS),
      });
      await r.body?.cancel().catch(() => {});
      status = r.ok ? { at: new Date().toISOString(), ok: true, spans: n } : { at: new Date().toISOString(), ok: false, spans: n, error: `HTTP ${r.status}` };
    } catch (err) {
      status = { at: new Date().toISOString(), ok: false, spans: n, error: why(err) };
    }
    this.#last = status;
    try {
      this.#o.onExport?.(status.ok);
    } catch {
      /* counting never breaks anything */
    }
    return status;
  }

  /** "Send a test trace": one span named sara.test. */
  sendTest(endpoint: string, headers: Record<string, string>): Promise<ExportStatus> {
    const now = this.#now();
    return this.send(endpoint, [{ traceId: hex(16), spanId: hex(8), name: 'sara.test', kind: KIND.internal, start: now, end: now + 1, error: false, attributes: { 'sara.test': true } }], headers);
  }
}

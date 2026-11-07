// EC3 (docs/ops/EC3_DESIGN.md): the server's telemetry: metrics fed by the meter (through the hub)
// and by each turn's events, and a trace for each sampled turn. Model calls find their turn through
// AsyncLocalStorage (the turn's events are iterated inside it).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppContext, ChatEvent } from '../chat.ts';
import { OTLP_HEADERS_VAULT, telemetrySettings } from './config.ts';
import { hub } from './hub.ts';
import { SaraMetrics, TurnWatch, type TurnOutcome } from './metrics.ts';
import { Tracer, type ExportStatus, type TracerOptions, type TurnTrace } from './otlp.ts';

export interface TurnHandle {
  event(ev: ChatEvent): void;
  end(outcome: TurnOutcome): void;
  /** The turn's events, iterated so model calls inside the turn belong to it. */
  wrap<T>(it: AsyncIterable<T>): AsyncIterable<T>;
}

/** The MCP server a tool belongs to (its source is "MCP: <server>"), else undefined. */
export function mcpServerOf(app: AppContext, tool: string): string | undefined {
  try {
    const src = app.tools.get(tool)?.source ?? '';
    return src.startsWith('MCP: ') ? src.slice(5) : undefined;
  } catch {
    return undefined;
  }
}

function vaultHeaders(app: AppContext): Record<string, string> {
  try {
    const raw = app.vault.get(OTLP_HEADERS_VAULT);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const quiet = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* telemetry never breaks the turn */
  }
};

export class Telemetry {
  readonly metrics = new SaraMetrics();
  readonly tracer: Tracer;
  readonly #current = new AsyncLocalStorage<TurnTrace>();
  readonly #off: (() => void)[] = [];
  constructor(o: TracerOptions = {}) {
    this.tracer = new Tracer({ ...o, onExport: (ok) => this.metrics.exports.inc({ outcome: ok ? 'ok' : 'failed' }) });
    this.#off.push(
      hub.onModelCall((c) => {
        this.metrics.modelCall(c);
        this.#current.getStore()?.model(c);
      }),
      hub.onPluginJob((o) => this.metrics.pluginJob(o)),
    );
  }
  last(): ExportStatus | null {
    return this.tracer.last;
  }
  async sendTest(app: AppContext): Promise<ExportStatus> {
    return this.tracer.sendTest(telemetrySettings(app.settings.get()).traces.endpoint, vaultHeaders(app));
  }
  turn(app: AppContext, conversationId: string): TurnHandle {
    const watch = new TurnWatch(this.metrics, { mcpServerOf: (t) => mcpServerOf(app, t) });
    let tr: TurnTrace | null = null;
    try {
      const cfg = telemetrySettings(app.settings.get()).traces;
      if (cfg.enabled) tr = this.tracer.startTurn(cfg, { conversationId, headers: vaultHeaders(app) });
    } catch {
      tr = null;
    }
    const trace = tr;
    if (trace) watch.onTool = (t) => trace.tool(t);
    const als = this.#current;
    return {
      event: (ev) => quiet(() => watch.event(ev)),
      end: (outcome) =>
        quiet(() => {
          watch.end(outcome);
          // Sent after the turn, never awaited by it.
          if (trace) void trace.end(outcome, { firstTokenMs: watch.firstTokenMs }).catch(() => {});
        }),
      wrap: <T>(it: AsyncIterable<T>): AsyncIterable<T> => {
        if (!trace) return it;
        return {
          [Symbol.asyncIterator]() {
            const inner = it[Symbol.asyncIterator]();
            return {
              next: () => als.run(trace, () => inner.next()),
              return: (v?: unknown) => als.run(trace, () => inner.return?.(v as never) ?? Promise.resolve({ done: true as const, value: v as T })),
              throw: (e?: unknown) => als.run(trace, () => inner.throw?.(e) ?? Promise.reject(e)),
            };
          },
        };
      },
    };
  }
  close(): void {
    for (const off of this.#off.splice(0)) off();
  }
}

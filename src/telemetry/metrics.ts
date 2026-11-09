// EC3 (docs/ops/EC3_DESIGN.md): Sara's metrics. Counters and histograms are fed by the meter and
// the turn loop; gauges are read when scraped from what already exists (the operations snapshot,
// MCP connections, plugin jobs, bridges). Labels are ids, fixed words and clipped names only.
import type { AppContext, ChatEvent } from '../chat.ts';
import type { AppInfo } from '../health.ts';
import type { OperationsMonitor } from '../operations.ts';
import type { ModelCallSeen, PluginJobOutcome } from './hub.ts';
import { Registry } from './prom.ts';

export const SECONDS_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const;
export type TurnOutcome = 'ok' | 'error' | 'stopped';
export type ToolOutcome = 'ok' | 'error' | 'denied';

export class SaraMetrics {
  readonly registry = new Registry();
  readonly #r = this.registry;
  readonly buildInfo = this.#r.gauge('sara_build_info', 'Sara version, revision and Node version (always 1).', ['version', 'revision', 'node']);
  readonly uptime = this.#r.gauge('sara_uptime_seconds', 'Seconds since this Sara process started.');
  readonly turns = this.#r.counter('sara_turns_total', 'Chat turns finished, by outcome.', ['outcome']);
  readonly turnSeconds = this.#r.histogram('sara_turn_duration_seconds', 'How long a chat turn took, by outcome.', ['outcome'], SECONDS_BUCKETS);
  readonly firstToken = this.#r.histogram('sara_turn_first_token_seconds', 'Time until the first word of her reply.', [], SECONDS_BUCKETS);
  readonly modelCalls = this.#r.counter('sara_model_calls_total', 'Model provider calls, by provider id, model and outcome.', ['provider', 'model', 'outcome']);
  readonly modelSeconds = this.#r.histogram('sara_model_call_duration_seconds', 'Model call latency, by provider id and model.', ['provider', 'model'], SECONDS_BUCKETS);
  readonly tokens = this.#r.counter('sara_model_tokens_total', 'Tokens reported by providers, by kind (input, output, cached).', ['provider', 'model', 'kind']);
  readonly cost = this.#r.counter('sara_model_cost_usd_total', 'Estimated cost in US dollars from the price table (local and subscription are 0).', ['provider', 'model']);
  readonly tools = this.#r.counter('sara_tool_calls_total', 'Tool calls by tool (MCP tools as mcp:<server>) and outcome.', ['tool', 'outcome']);
  readonly approvalsAsked = this.#r.counter('sara_approvals_requested_total', 'Approval cards shown.');
  readonly approvalsDone = this.#r.counter('sara_approvals_resolved_total', 'Approval cards answered, by outcome.', ['outcome']);
  readonly errors = this.#r.counter('sara_errors_total', 'Errors, by source (turn, model).', ['source']);
  readonly mcpUp = this.#r.gauge('sara_mcp_server_up', 'Switched-on MCP servers: 1 ready, 0 not.', ['server']);
  readonly pluginRunning = this.#r.gauge('sara_plugin_jobs_running', 'Plugin jobs running now.');
  readonly pluginJobs = this.#r.counter('sara_plugin_jobs_total', 'Plugin jobs finished, by outcome.', ['outcome']);
  readonly bridges = this.#r.gauge('sara_bridge_connected', 'Switched-on chat bridges: 1 connected, 0 not.', ['bridge']);
  readonly queue = this.#r.gauge('sara_queue_items', 'Queued and recorded work, by queue and state.', ['queue', 'state']);
  readonly dbBytes = this.#r.gauge('sara_database_bytes', 'Size of the main database.');
  readonly backupAge = this.#r.gauge('sara_backup_age_seconds', 'Age of the newest local backup (absent when there is none).');
  readonly httpTotal = this.#r.gauge('sara_http_requests_total', 'HTTP responses since start (from the operations monitor).');
  readonly httpInFlight = this.#r.gauge('sara_http_requests_in_flight', 'HTTP requests being answered now.');
  readonly rss = this.#r.gauge('sara_process_resident_memory_bytes', 'Resident memory of the Sara process.');
  readonly exports = this.#r.counter('sara_trace_exports_total', 'Trace batches sent to the OpenTelemetry collector, by outcome.', ['outcome']);

  modelCall(c: ModelCallSeen): void {
    const l = { provider: c.providerId, model: c.model };
    this.modelCalls.inc({ ...l, outcome: c.ok ? 'ok' : 'error' });
    this.modelSeconds.observe(l, c.ms / 1000);
    if (c.in) this.tokens.inc({ ...l, kind: 'input' }, c.in);
    if (c.out) this.tokens.inc({ ...l, kind: 'output' }, c.out);
    if (c.cached) this.tokens.inc({ ...l, kind: 'cached' }, c.cached);
    this.cost.inc(l, c.usd && c.usd > 0 ? c.usd : 0);
    if (!c.ok) this.errors.inc({ source: 'model' });
  }
  pluginJob(o: PluginJobOutcome): void {
    this.pluginJobs.inc({ outcome: o });
  }

  /** The text exposition, with gauges read now. Every probe is best effort. */
  render(app?: AppContext, ops?: OperationsMonitor, info?: AppInfo): string {
    if (info) {
      this.buildInfo.reset();
      this.buildInfo.set({ version: info.version, revision: info.revision ?? '', node: process.version }, 1);
    }
    this.uptime.set({}, Math.round(process.uptime()));
    this.rss.set({}, process.memoryUsage().rss);
    if (app) this.#gauges(app, ops);
    return this.registry.render();
  }

  #gauges(app: AppContext, ops?: OperationsMonitor): void {
    const s = app.settings.get();
    this.mcpUp.reset();
    for (const c of s.mcpServers ?? []) if (c.enabled) this.mcpUp.set({ server: c.name }, app.mcp?.get(c.name)?.status === 'ready' ? 1 : 0);
    const pm = app.plugins as unknown as { jobs?: () => unknown[] } | undefined;
    this.pluginRunning.set({}, typeof pm?.jobs === 'function' ? pm.jobs().length : 0);
    this.bridges.reset();
    for (const name of ['telegram', 'discord'] as const) {
      if (!s[name]?.enabled) continue;
      let up = 0;
      try {
        up = app.bridges?.[name]?.status().running ? 1 : 0;
      } catch {
        /* no evidence: 0 */
      }
      this.bridges.set({ bridge: name }, up);
    }
    if (!ops) return;
    const snap = ops.snapshot(app);
    this.queue.reset();
    for (const [queue, q] of Object.entries(snap.queues)) {
      if (!q || typeof q !== 'object') continue;
      for (const [state, n] of Object.entries((q as { states: Record<string, number> }).states)) this.queue.set({ queue, state }, n);
    }
    if (snap.queues.databaseBytes !== null) this.dbBytes.set({}, snap.queues.databaseBytes);
    this.backupAge.reset();
    const last = snap.readiness.backup.lastCreatedAt;
    if (last) this.backupAge.set({}, Math.max(0, Math.round((Date.now() - Date.parse(last)) / 1000)));
    this.httpTotal.set({}, snap.requests.total);
    this.httpInFlight.set({}, snap.requests.inFlight);
  }
}

/** What one turn did, from its events: tools, approvals, errors, first token, the outcome. */
export class TurnWatch {
  readonly #m: SaraMetrics;
  readonly #mcpServerOf: (tool: string) => string | undefined;
  readonly #started: number;
  readonly #asked = new Set<string>();
  #firstToken = 0;
  #failed = false;
  #ended = false;
  /** Told about each finished tool call (for the trace). */
  onTool?: (t: { id: string; tool: string; name: string; mcpServer?: string; outcome: ToolOutcome; ms: number; outputBytes: number }) => void;
  constructor(m: SaraMetrics, o: { mcpServerOf?: (tool: string) => string | undefined; now?: () => number } = {}) {
    this.#m = m;
    this.#mcpServerOf = o.mcpServerOf ?? (() => undefined);
    this.#now = o.now ?? Date.now;
    this.#started = this.#now();
  }
  readonly #now: () => number;
  get firstTokenMs(): number | null {
    return this.#firstToken || null;
  }
  get failed(): boolean {
    return this.#failed;
  }
  event(ev: ChatEvent): void {
    if (this.#ended) return;
    if (ev.type === 'token' && !this.#firstToken) this.#firstToken = Math.max(1, this.#now() - this.#started);
    else if (ev.type === 'approval') {
      this.#asked.add(ev.id);
      this.#m.approvalsAsked.inc();
    } else if (ev.type === 'tool_result') {
      const mcp = this.#mcpServerOf(ev.name);
      const tool = mcp ? `mcp:${mcp}` : ev.name;
      this.#m.tools.inc({ tool, outcome: ev.status });
      if (this.#asked.delete(ev.id)) this.#m.approvalsDone.inc({ outcome: ev.status === 'denied' ? 'denied' : 'approved' });
      try {
        this.onTool?.({ id: ev.id, tool, name: ev.name, ...(mcp ? { mcpServer: mcp } : {}), outcome: ev.status, ms: ev.ms, outputBytes: Buffer.byteLength(ev.output ?? '') });
      } catch {
        /* the trace never breaks the turn */
      }
    } else if (ev.type === 'error') {
      this.#failed = true;
      this.#m.errors.inc({ source: 'turn' });
    }
  }
  /** Count the turn once. Returns its duration in ms. */
  end(outcome: TurnOutcome): number {
    const ms = this.#now() - this.#started;
    if (this.#ended) return ms;
    this.#ended = true;
    this.#m.turns.inc({ outcome });
    this.#m.turnSeconds.observe({ outcome }, ms / 1000);
    if (this.#firstToken) this.#m.firstToken.observe({}, this.#firstToken / 1000);
    return ms;
  }
}

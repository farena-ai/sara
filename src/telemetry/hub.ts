// EC3 (docs/ops/EC3_DESIGN.md §1): who hears about model calls and plugin jobs. The meter
// (src/usage.ts) and the plugin manager announce here; the server's telemetry listens. A listener
// that throws is ignored: observing never breaks the work it observes.
import type { CallInfo } from '../usage.ts';

/** One finished provider call (the meter's CallInfo plus when it started, in ms since the epoch). */
export type ModelCallSeen = CallInfo & { startedAt: number; purpose?: string };
export type PluginJobOutcome = 'ok' | 'failed' | 'stopped' | 'timeout' | 'declined';

const modelCalls = new Set<(c: ModelCallSeen) => void>();
const pluginJobs = new Set<(o: PluginJobOutcome) => void>();

function emit<T>(set: Set<(v: T) => void>, v: T): void {
  for (const fn of set) {
    try {
      fn(v);
    } catch {
      /* observing never breaks the call */
    }
  }
}

export const hub = {
  modelCall: (c: ModelCallSeen) => emit(modelCalls, c),
  pluginJob: (o: PluginJobOutcome) => emit(pluginJobs, o),
  onModelCall(fn: (c: ModelCallSeen) => void): () => void {
    modelCalls.add(fn);
    return () => void modelCalls.delete(fn);
  },
  onPluginJob(fn: (o: PluginJobOutcome) => void): () => void {
    pluginJobs.add(fn);
    return () => void pluginJobs.delete(fn);
  },
};

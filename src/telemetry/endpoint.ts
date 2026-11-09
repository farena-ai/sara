// EC3 (docs/ops/EC3_DESIGN.md §4, §5): GET /metrics for Prometheus and the public readiness probe.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppContext } from '../chat.ts';
import type { AppInfo } from '../health.ts';
import { clientIp, SECURITY_HEADERS } from '../http.ts';
import type { OperationsMonitor } from '../operations.ts';
import { allowed, METRICS_TOKEN_VAULT, telemetrySettings } from './config.ts';
import type { SaraMetrics } from './metrics.ts';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** True when the request carries the scrape token. */
export function scrapeTokenOk(app: AppContext, header: string | undefined): boolean {
  const saved = app.vault.get(METRICS_TOKEN_VAULT);
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return Boolean(saved && m && timingSafeEqual(digest(m[1]), digest(saved)));
}

export interface MetricsDeps {
  app: AppContext;
  metrics: SaraMetrics;
  operations: OperationsMonitor;
  info: AppInfo;
  trustProxy?: boolean | { secret: string };
  /** Demo and household member spaces: never served. */
  closed: boolean;
}

export function serveMetrics(req: IncomingMessage, res: ServerResponse, d: MetricsDeps): void {
  const cfg = telemetrySettings(d.app.settings.get()).metrics;
  const plain = (status: number, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (d.closed || !cfg.enabled || (req.method !== 'GET' && req.method !== 'HEAD')) return plain(404, 'Not found\n');
  const ok = allowed(cfg.allow, clientIp(req, d.trustProxy ?? false)) || scrapeTokenOk(d.app, req.headers.authorization);
  if (!ok) return plain(401, 'Unauthorized\n', { 'www-authenticate': 'Bearer realm="sara-metrics"' });
  let body: string;
  try {
    body = d.metrics.render(d.app, d.operations, d.info);
  } catch {
    return plain(500, 'Metrics unavailable\n');
  }
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Readiness from the operations snapshot: fixed names only, no paths or versions. */
export function readiness(app: AppContext, ops: OperationsMonitor): { ok: boolean; failing?: string[] } {
  let failing: string[];
  try {
    const r = ops.snapshot(app).readiness;
    failing = [r.database.status !== 'ready' ? 'database' : '', r.storage.status !== 'ready' && r.storage.totalBytes !== null ? 'storage' : ''].filter(Boolean);
  } catch {
    failing = ['database'];
  }
  return failing.length ? { ok: false, failing } : { ok: true };
}

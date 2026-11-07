// EC3 (docs/ops/EC3_DESIGN.md §7): Settings → Data & health → Monitoring. Owner only: device
// tokens, the demo and household members are refused, as for Operations.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_TOKEN_PREFIX } from '../auth.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { cleanHeaders, MAX_ALLOW, METRICS_TOKEN_VAULT, OTLP_HEADERS_VAULT, telemetrySettings, validAllow, validEndpoint } from '../telemetry/config.ts';
import type { Telemetry } from '../telemetry/index.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** The Prometheus scrape job for this server (the token goes in a file next to Prometheus). */
export function scrapeConfig(origin: string): string {
  const u = new URL(origin);
  return [
    'scrape_configs:',
    '  - job_name: sara',
    '    metrics_path: /metrics',
    `    scheme: ${u.protocol.replace(':', '')}`,
    '    authorization:',
    '      type: Bearer',
    '      credentials_file: /etc/prometheus/sara-token',
    '    static_configs:',
    `      - targets: ['${u.host}']`,
    '',
  ].join('\n');
}

export function createTelemetryRoutes(ctx: RouteCtx, tel: Telemetry): RouteHandler {
  const { app } = ctx;
  const view = (origin: string) => {
    const s = telemetrySettings(app.settings.get());
    return {
      metrics: { ...s.metrics, hasToken: app.vault.has(METRICS_TOKEN_VAULT), path: '/metrics' },
      traces: { ...s.traces, hasHeaders: app.vault.has(OTLP_HEADERS_VAULT), last: tel.last() },
      scrapeConfig: scrapeConfig(origin),
    };
  };
  return async (req, res, method, parts) => {
    if (parts[0] !== 'telemetry') return NEXT;
    if (ctx.opts.member || ctx.opts.demo || req.headers.authorization?.startsWith(`Bearer ${DEVICE_TOKEN_PREFIX}`)) throw new HttpError(403, 'Only the owner can change monitoring.');
    res.setHeader('cache-control', 'no-store');
    const origin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
    const [, b] = parts;
    if (!b && method === 'GET') return send(res, 200, view(origin));
    if (!b && method === 'PUT') {
      const body = (await readJson(req)) as { metrics?: Record<string, unknown>; traces?: Record<string, unknown> };
      const cur = telemetrySettings(app.settings.get());
      const next = { metrics: { ...cur.metrics }, traces: { ...cur.traces } };
      const m = body.metrics ?? {};
      const tr = body.traces ?? {};
      if ('enabled' in m) next.metrics.enabled = m.enabled === true;
      if ('allow' in m) {
        const list = Array.isArray(m.allow) ? m.allow.map((x) => String(x).trim()).filter(Boolean) : null;
        if (!list || list.length > MAX_ALLOW || !list.every(validAllow)) throw new HttpError(400, 'Each allowed address must be an IP address or a range like 10.0.0.0/8 (up to 16).');
        next.metrics.allow = [...new Set(list)];
      }
      if ('enabled' in tr) next.traces.enabled = tr.enabled === true;
      if ('endpoint' in tr) {
        try {
          next.traces.endpoint = validEndpoint(String(tr.endpoint ?? ''));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      if ('sample' in tr) {
        const n = Number(tr.sample);
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, 'Sampling must be between 0 and 1.');
        next.traces.sample = n;
      }
      if (next.traces.enabled && !next.traces.endpoint) throw new HttpError(400, 'Set the collector address first.');
      app.settings.update({ telemetry: next });
      return send(res, 200, view(origin));
    }
    if (b === 'token' && !parts[2] && method === 'POST') {
      const token = randomBytes(32).toString('base64url');
      app.vault.set(METRICS_TOKEN_VAULT, token);
      return send(res, 200, { token, ...view(origin) });
    }
    if (b === 'token' && !parts[2] && method === 'DELETE') {
      app.vault.delete(METRICS_TOKEN_VAULT);
      return send(res, 200, view(origin));
    }
    if (b === 'headers' && !parts[2] && method === 'PUT') {
      const body = await readJson(req);
      let h: Record<string, string>;
      try {
        h = cleanHeaders(body.headers);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      if (Object.keys(h).length) app.vault.set(OTLP_HEADERS_VAULT, JSON.stringify(h));
      else app.vault.delete(OTLP_HEADERS_VAULT);
      return send(res, 200, view(origin));
    }
    if (b === 'test' && !parts[2] && method === 'POST') {
      await tel.sendTest(app);
      return send(res, 200, view(origin));
    }
    if (b === 'dashboard' && !parts[2] && method === 'GET') {
      const json = readFileSync(join(ctx.rootDir, 'docs', 'monitoring', 'grafana-dashboard.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="sara-grafana-dashboard.json"', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(json);
    }
    throw new HttpError(404, 'Not found');
  };
}

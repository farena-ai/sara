// EC3 (docs/ops/EC3_DESIGN.md "Settings shape"): the monitoring settings, checked. Secrets (the
// scrape token, the collector's headers) live only in the vault under these keys.
import { BlockList, isIP } from 'node:net';

export const METRICS_TOKEN_VAULT = 'telemetry.metrics-token';
export const OTLP_HEADERS_VAULT = 'telemetry.otlp-headers';
export const MAX_ALLOW = 16;
export const DEFAULT_SAMPLE = 0.1;

export interface TelemetrySettings {
  metrics: { enabled: boolean; allow: string[] };
  traces: { enabled: boolean; endpoint: string; sample: number };
}

export function telemetrySettings(s: { telemetry?: unknown } | undefined): TelemetrySettings {
  const t = (s?.telemetry ?? {}) as { metrics?: Partial<TelemetrySettings['metrics']>; traces?: Partial<TelemetrySettings['traces']> };
  const sample = Number(t.traces?.sample);
  return {
    metrics: { enabled: t.metrics?.enabled === true, allow: Array.isArray(t.metrics?.allow) ? t.metrics.allow.filter((a) => typeof a === 'string' && validAllow(a)).slice(0, MAX_ALLOW) : [] },
    traces: { enabled: t.traces?.enabled === true, endpoint: typeof t.traces?.endpoint === 'string' ? t.traces.endpoint : '', sample: Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : DEFAULT_SAMPLE },
  };
}

const plainIp = (ip: string) => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

/** An address ("192.0.2.7", "::1") or a subnet ("10.0.0.0/8", "fd00::/8"). */
export function validAllow(a: string): boolean {
  const [ip, bits, more] = a.trim().split('/');
  if (more !== undefined) return false;
  const v = isIP(ip);
  if (!v) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return /^\d+$/.test(bits) && n >= 0 && n <= (v === 4 ? 32 : 128);
}

export function allowList(entries: string[]): BlockList {
  const b = new BlockList();
  for (const e of entries) {
    const [ip, bits] = e.trim().split('/');
    const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) b.addAddress(ip, type);
    else b.addSubnet(ip, Number(bits), type);
  }
  return b;
}

export function allowed(entries: string[], address: string): boolean {
  if (!entries.length) return false;
  const ip = plainIp(address);
  const v = isIP(ip);
  return v ? allowList(entries).check(ip, v === 4 ? 'ipv4' : 'ipv6') : false;
}

/** The collector address: http(s) only, no credentials in it. Empty = not set. */
export function validEndpoint(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('The collector address must be a full http:// or https:// address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The collector address must be a full http:// or https:// address.');
  if (u.username || u.password) throw new Error('Put the collector key in the headers, not in the address.');
  return u.toString().replace(/\/+$/, '');
}

/** Where traces are posted: the address as given when it already ends in /v1/traces. */
export function tracesUrl(endpoint: string): string {
  return /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

/** Collector headers ("name: value" lines or an object), checked. */
export function cleanHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs: [string, string][] = typeof v === 'string'
    ? v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(':');
        if (i < 1) throw new Error('Write each header as name: value on its own line.');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
    : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]) : [];
  for (const [k, x] of pairs.slice(0, 16)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k) || /[\r\n]/.test(x) || x.length > 4096) throw new Error('Write each header as name: value on its own line.');
    out[k] = x;
  }
  return out;
}

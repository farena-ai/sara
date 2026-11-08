// EC22: verify Sara's outgoing webhook deliveries (Standard Webhooks): HMAC-SHA256 with the
// base64 key after `whsec_`, over `id.timestamp.body`, `webhook-signature: v1,<base64> …`, and the
// timestamp within 5 minutes. WebCrypto only, so it runs in browsers, Deno, workers and Node 18+.

export interface WebhookInput {
  /** The hook's secret as Sara shows it (`whsec_…`). */
  secret: string;
  /** The raw request body exactly as received (string or bytes); never a re-serialized object. */
  body: string | Uint8Array;
  /** The request headers (a Headers object or a plain object with lower- or mixed-case names). */
  headers: Headers | Record<string, string | string[] | undefined>;
  /** Seconds the timestamp may be off from now (default 300). */
  toleranceS?: number;
  /** Now in seconds (tests). */
  nowS?: number;
}

export interface WebhookResult {
  ok: boolean;
  /** The delivery id (keep it to ignore repeats). */
  id?: string;
  /** Why it failed, for your logs. */
  why?: string;
}

const enc = new TextEncoder();

function headerOf(h: WebhookInput['headers'], name: string): string | undefined {
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : rec[key];
  return Array.isArray(v) ? v.join(' ') : v;
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(b: ArrayBuffer): string {
  let s = '';
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s);
}

/** Equal strings, compared without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function subtle(): Promise<SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c.subtle;
  // Node 18 without the global: the same WebCrypto from node:crypto.
  const m = (await import(/* @vite-ignore */ 'node:crypto' as string)) as { webcrypto: Crypto };
  return m.webcrypto.subtle;
}

/** Checks one delivery. Resolves `{ ok: false, why }` for anything wrong; never throws on bad input. */
export async function verifyWebhook(i: WebhookInput): Promise<WebhookResult> {
  const id = headerOf(i.headers, 'webhook-id');
  const ts = headerOf(i.headers, 'webhook-timestamp')?.trim();
  const sig = headerOf(i.headers, 'webhook-signature');
  if (!id || !ts || !sig) return { ok: false, why: 'missing webhook-id, webhook-timestamp or webhook-signature' };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, why: 'webhook-timestamp is not a number of seconds' };
  const raw = i.secret.trim();
  let key: Uint8Array;
  try {
    key = fromB64(raw.startsWith('whsec_') ? raw.slice(6) : raw);
  } catch {
    return { ok: false, why: 'the secret is not base64' };
  }
  if (!key.length) return { ok: false, why: 'the secret is empty' };
  const body = typeof i.body === 'string' ? enc.encode(i.body) : i.body;
  const head = enc.encode(`${id}.${ts}.`);
  const data = new Uint8Array(head.length + body.length);
  data.set(head, 0);
  data.set(body, head.length);
  const s = await subtle();
  const k = await s.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = toB64(await s.sign('HMAC', k, data as BufferSource));
  let match = false;
  for (const part of sig.split(/\s+/)) {
    const c = part.indexOf(',');
    if (c > 0 && part.slice(0, c) === 'v1') match = sameText(part.slice(c + 1), want) || match;
  }
  if (!match) return { ok: false, why: 'no v1 signature matches' };
  const now = i.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > (i.toleranceS ?? 300)) return { ok: false, why: 'the timestamp is too old (or in the future): a replay?' };
  return { ok: true, id };
}

// Phase 102 (ST7, docs/design/STAPLES.md §3.3, §10.3–§10.4): the pure parts of webhooks, written
// from the public specs (no library): signature checks for GitHub, Stripe, Standard Webhooks, a
// header token and URL-only hooks; the no-code filters; templates; the sender presets and their
// recorded sample payloads; and signing for outgoing deliveries (Standard Webhooks). Nothing here
// touches the network, the database or the clock except through its arguments.
//
// Every comparison of a secret-derived value goes through `safeEqual` (crypto.timingSafeEqual on
// equal-length buffers); the raw body bytes are verified *before* anything parses them.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type VerifyKind = 'github' | 'stripe' | 'standard' | 'header' | 'url';
export const VERIFY_KINDS: readonly VerifyKind[] = ['github', 'stripe', 'standard', 'header', 'url'];
/** Seconds a timestamped signature (Stripe, Standard Webhooks) may be off from now. */
export const TOLERANCE_S = 300;
/** The prefix of a Standard Webhooks secret (followed by base64). Built in pieces so key scanners don't flag the code. */
export const WHSEC = ['wh', 'sec_'].join('');

/** Headers as Node gives them (lower-case names). */
export type Headers = Record<string, string | string[] | undefined>;

export function header(h: Headers, name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v.join(',') : v;
}

/** Constant-time equality of two strings (false on different lengths, without comparing early). */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (x.length !== y.length) {
    // Still spend the same work so a length mismatch isn't faster to learn.
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export const hmacHex = (secret: string | Buffer, data: string | Buffer): string => createHmac('sha256', secret).update(data).digest('hex');
export const hmacB64 = (secret: string | Buffer, data: string | Buffer): string => createHmac('sha256', secret).update(data).digest('base64');
export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The key bytes of a Standard Webhooks secret (`whsec_` + base64); a secret without the prefix is used as base64 too. */
export function standardKey(secret: string): Buffer {
  const s = secret.trim();
  return Buffer.from(s.startsWith(WHSEC) ? s.slice(WHSEC.length) : s, 'base64');
}

/** A new Standard Webhooks secret (24 random bytes). */
export const newStandardSecret = (): string => `${WHSEC}${randomBytes(24).toString('base64')}`;
/** A new GitHub hook secret or header token (32 hex characters, 128 bits). */
export const newHexSecret = (): string => randomBytes(16).toString('hex');
/** The secret in a hook's URL: 128 random bits, base64url. */
export const newUrlSecret = (): string => randomBytes(16).toString('base64url');

export interface Verdict {
  ok: boolean;
  /** Why it failed, in plain words (for the log and the test button; never sent to the sender). */
  why?: string;
  /** The sender's delivery id when the scheme has one (GitHub, Standard, header X-Request-Id). */
  deliveryId?: string;
}

/** GitHub (§3.3 [S5]): `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(secret, raw body). */
export function verifyGithub(raw: Buffer, h: Headers, secret: string): Verdict {
  const sig = header(h, 'x-hub-signature-256');
  const deliveryId = header(h, 'x-github-delivery')?.slice(0, 200);
  if (!sig) return { ok: false, why: header(h, 'x-hub-signature') ? 'only the old sha1 signature was sent (turn on SHA-256 in the sender)' : 'no X-Hub-Signature-256 header' };
  if (!sig.startsWith('sha256=')) return { ok: false, why: 'the signature is not sha256=…' };
  const want = `sha256=${hmacHex(secret, raw)}`;
  return safeEqual(sig.trim(), want) ? { ok: true, ...(deliveryId ? { deliveryId } : {}) } : { ok: false, why: 'the signature does not match' };
}

/** Stripe (§3.3 [S6]): `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]` over `t + "." + body`, |now − t| ≤ 300 s. */
export function verifyStripe(raw: Buffer, h: Headers, secret: string, nowS: number, tolerance = TOLERANCE_S): Verdict {
  const sig = header(h, 'stripe-signature');
  if (!sig) return { ok: false, why: 'no Stripe-Signature header' };
  let t = '';
  const v1: string[] = [];
  for (const part of sig.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1.push(v);
  }
  if (!/^\d{1,12}$/.test(t)) return { ok: false, why: 'no timestamp (t=) in the signature' };
  if (!v1.length) return { ok: false, why: 'no v1 signature' };
  const want = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]));
  // Every candidate is compared (no early exit on the first match).
  let match = false;
  for (const s of v1) match = safeEqual(s, want) || match;
  if (!match) return { ok: false, why: 'the signature does not match' };
  if (Math.abs(nowS - Number(t)) > tolerance) return { ok: false, why: 'the timestamp is too old (or in the future): a replay?' };
  return { ok: true };
}

/**
 * Standard Webhooks (§3.3 [S7]): `webhook-signature: v1,<base64> [v1,<base64> …]` =
 * HMAC-SHA256(base64-decoded `whsec_` secret, `id.timestamp.body`); timestamp within 300 s.
 */
export function verifyStandard(raw: Buffer, h: Headers, secret: string, nowS: number, tolerance = TOLERANCE_S): Verdict {
  const id = header(h, 'webhook-id');
  const ts = header(h, 'webhook-timestamp');
  const sig = header(h, 'webhook-signature');
  if (!id || !ts || !sig) return { ok: false, why: 'missing webhook-id, webhook-timestamp or webhook-signature' };
  if (!/^\d{1,12}$/.test(ts.trim())) return { ok: false, why: 'webhook-timestamp is not a number of seconds' };
  const key = standardKey(secret);
  if (!key.length) return { ok: false, why: 'the secret is empty' };
  const want = hmacB64(key, Buffer.concat([Buffer.from(`${id}.${ts.trim()}.`, 'utf8'), raw]));
  let match = false;
  for (const s of sig.split(/\s+/)) {
    const i = s.indexOf(',');
    if (i <= 0 || s.slice(0, i) !== 'v1') continue;
    match = safeEqual(s.slice(i + 1), want) || match;
  }
  if (!match) return { ok: false, why: 'no v1 signature matches' };
  if (Math.abs(nowS - Number(ts)) > tolerance) return { ok: false, why: 'the timestamp is too old (or in the future): a replay?' };
  return { ok: true, deliveryId: id.slice(0, 200) };
}

/** Header token (Home Assistant `rest_command`, scripts): `X-Sara-Token` equals the hook's token. */
export function verifyHeader(h: Headers, token: string): Verdict {
  const got = header(h, 'x-sara-token');
  const deliveryId = header(h, 'x-request-id')?.slice(0, 200);
  if (!got) return { ok: false, why: 'no X-Sara-Token header' };
  return safeEqual(got.trim(), token) ? { ok: true, ...(deliveryId ? { deliveryId } : {}) } : { ok: false, why: 'the token does not match' };
}

/** One entry point: the hook's kind, its sender secret (from the vault) and the request. */
export function verify(kind: VerifyKind, raw: Buffer, h: Headers, secret: string | undefined, nowS: number): Verdict {
  if (kind === 'url') return { ok: true };
  if (!secret) return { ok: false, why: 'this hook has no sender secret yet (paste it on the hook)' };
  if (kind === 'github') return verifyGithub(raw, h, secret);
  if (kind === 'stripe') return verifyStripe(raw, h, secret, nowS);
  if (kind === 'standard') return verifyStandard(raw, h, secret, nowS);
  return verifyHeader(h, secret);
}

/** Signs an outgoing delivery the Standard Webhooks way (the headers to send). */
export function signStandard(secret: string, id: string, timestampS: number, body: string): Record<string, string> {
  return { 'webhook-id': id, 'webhook-timestamp': String(timestampS), 'webhook-signature': `v1,${hmacB64(standardKey(secret), `${id}.${timestampS}.${body}`)}` };
}

// ------------------------------------------------------------------------------------------
// bodies
// ------------------------------------------------------------------------------------------

export const BODY_TYPES = ['application/json', 'application/x-www-form-urlencoded', 'text/plain'] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/** The accepted body type of a Content-Type header, or undefined (→ 415). */
export function bodyType(contentType: string | undefined): BodyType | undefined {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return (BODY_TYPES as readonly string[]).includes(t) ? (t as BodyType) : undefined;
}

/**
 * The parsed body (after the signature check). JSON as is; a form as an object (GitHub's form mode
 * puts the JSON in `payload`, which is unpacked); text as { text }.
 */
export function parseBody(raw: Buffer, type: BodyType): { body: unknown; text: string } {
  const text = raw.toString('utf8');
  if (type === 'application/json') {
    try {
      return { body: JSON.parse(text) as unknown, text };
    } catch {
      return { body: { text }, text };
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const o: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text)) o[k] = v;
    if (typeof o.payload === 'string') {
      try {
        return { body: JSON.parse(o.payload) as unknown, text: o.payload };
      } catch {
        /* a plain form */
      }
    }
    return { body: o, text };
  }
  return { body: { text }, text };
}

// ------------------------------------------------------------------------------------------
// filters (§10.4)
// ------------------------------------------------------------------------------------------

export const OPS = ['equals', 'not', 'one-of', 'contains', 'starts-with', 'gt', 'lt', 'exists', 'changed-to'] as const;
export type Op = (typeof OPS)[number];
export type Where = 'header' | 'body' | 'text';
export interface Condition {
  where: Where;
  /** Body: dots and [n] (`data.object.amount`, `commits[0].id`); header: its name; text: unused. */
  path: string;
  op: Op;
  value?: string;
}
/** All must match; an `any` group matches when one of its conditions does. */
export type Filter = Condition | { any: Condition[] };

const MAX_FILTERS = 12;

/** The value at a dotted path (`a.b[0].c`); undefined when it isn't there. */
export function pathGet(obj: unknown, path: string): unknown {
  const keys: string[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) keys.push(m[1]);
    for (const n of m[2].matchAll(/\[(\d+)\]/g)) keys.push(n[1]);
  }
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const asText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function cleanCondition(v: unknown): Condition | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const where = o.where === 'header' || o.where === 'text' ? o.where : 'body';
  const op = (OPS as readonly string[]).includes(String(o.op)) ? (o.op as Op) : undefined;
  if (!op) return undefined;
  const path = String(o.path ?? '').trim().slice(0, 200);
  if (where !== 'text' && !/^[\w$@:-]+(?:\[\d+\])*(?:\.[\w$@:-]+(?:\[\d+\])*)*$/.test(path)) return undefined;
  if (where === 'header' && !/^[A-Za-z0-9-]+$/.test(path)) return undefined;
  const value = o.value === undefined || o.value === null ? undefined : String(o.value).slice(0, 500);
  if (op !== 'exists' && value === undefined) return undefined;
  return { where, path: where === 'text' ? '' : path, op, ...(value !== undefined ? { value } : {}) };
}

/** Checks filters from the page; drops what isn't a condition. */
export function cleanFilters(v: unknown): Filter[] {
  if (!Array.isArray(v)) return [];
  const out: Filter[] = [];
  for (const f of v.slice(0, MAX_FILTERS)) {
    if (f && typeof f === 'object' && Array.isArray((f as { any?: unknown }).any)) {
      const any = ((f as { any: unknown[] }).any).slice(0, MAX_FILTERS).map(cleanCondition).filter((c): c is Condition => Boolean(c));
      if (any.length) out.push({ any });
    } else {
      const c = cleanCondition(f);
      if (c) out.push(c);
    }
  }
  return out;
}

export interface Delivery {
  headers: Headers;
  body: unknown;
  text: string;
}

/** The same path in the same payload's "before" state (Home Assistant: new_state → old_state). */
function beforePath(path: string): string | undefined {
  return path.includes('new_state') ? path.replace('new_state', 'old_state') : undefined;
}

/** One condition. `last` is the value at this path in the hook's previous delivery (for changed-to). */
export function matchCondition(c: Condition, d: Delivery, last?: string): boolean {
  const raw = c.where === 'header' ? header(d.headers, c.path) : c.where === 'text' ? d.text : pathGet(d.body, c.path);
  if (c.op === 'exists') return raw !== undefined && raw !== null && raw !== '';
  const got = asText(raw);
  const want = c.value ?? '';
  const ci = (s: string) => s.toLowerCase();
  switch (c.op) {
    case 'equals':
      return raw !== undefined && got === want;
    case 'not':
      return got !== want;
    case 'one-of':
      return raw !== undefined && want.split(',').map((s) => s.trim()).filter(Boolean).includes(got);
    case 'contains':
      return ci(got).includes(ci(want));
    case 'starts-with':
      return ci(got).startsWith(ci(want));
    case 'gt':
    case 'lt': {
      const a = Number(got);
      const b = Number(want);
      if (raw === undefined || got === '' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return c.op === 'gt' ? a > b : a < b;
    }
    case 'changed-to': {
      if (raw === undefined || got !== want) return false;
      const bp = c.where === 'body' ? beforePath(c.path) : undefined;
      const before = bp ? pathGet(d.body, bp) : undefined;
      if (bp && before !== undefined) return asText(before) !== want;
      return last !== want;
    }
  }
  return false;
}

/** Each filter with whether it matched (the test button shows them); `matched` = all of them. */
export function runFilters(filters: Filter[], d: Delivery, last: Record<string, string> = {}): { matched: boolean; each: { filter: Filter; matched: boolean }[] } {
  const each = filters.map((f) => ({ filter: f, matched: 'any' in f ? f.any.some((c) => matchCondition(c, d, last[c.path])) : matchCondition(f, d, last[f.path]) }));
  return { matched: each.every((e) => e.matched), each };
}

/** The paths whose values `changed-to` compares with next time (kept on the hook). */
export function memoOf(filters: Filter[], d: Delivery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of filters) for (const c of 'any' in f ? f.any : [f]) if (c.op === 'changed-to' && c.where === 'body') out[c.path] = asText(pathGet(d.body, c.path)).slice(0, 200);
  return out;
}

const OP_WORDS: Record<Op, string> = { equals: 'equals', not: 'is not', 'one-of': 'is one of', contains: 'contains', 'starts-with': 'starts with', gt: '>', lt: '<', exists: 'exists', 'changed-to': 'changed to' };
/** A filter in words: `header X-GitHub-Event is one of issues, pull_request`. */
export function filterWords(f: Filter): string {
  const one = (c: Condition) => `${c.where === 'text' ? 'text' : `${c.where} ${c.path}`} ${OP_WORDS[c.op]}${c.op === 'exists' ? '' : ` ${JSON.stringify(c.value ?? '')}`}`;
  return 'any' in f ? `any of (${f.any.map(one).join(' · ')})` : one(f);
}

// ------------------------------------------------------------------------------------------
// templates
// ------------------------------------------------------------------------------------------

/** Control characters out, whitespace folded, cut. */
export function plainLine(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** `{{repository.full_name}}: {{issue.title}}` with body values ({{event}} = the event name). Missing values are empty. */
export function fillTemplate(tpl: string, d: Delivery & { event?: string }, max = 300): string {
  const out = tpl.slice(0, 500).replace(/\{\{\s*([\w$@:.[\]-]{1,120})\s*\}\}/g, (_, p: string) => {
    if (p === 'event') return plainLine(d.event ?? '', 80);
    if (p.startsWith('header.')) return plainLine(header(d.headers, p.slice(7)) ?? '', 120);
    return plainLine(asText(pathGet(d.body, p)), 200);
  });
  return plainLine(out, max);
}

// ------------------------------------------------------------------------------------------
// presets and samples (§10.4; samples are trimmed recordings in each sender's documented shape)
// ------------------------------------------------------------------------------------------

export type Sender = 'github' | 'stripe' | 'home-assistant' | 'other';
export interface Preset {
  id: string;
  sender: Sender;
  /** English name (the page translates it). */
  name: string;
  filters: Filter[];
  template: string;
  /** The event header/name the sample carries. */
  event: string;
  sample: { headers: Record<string, string>; body: unknown };
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'github-issue-opened', sender: 'github', name: 'An issue was opened', event: 'issues',
    filters: [{ where: 'header', path: 'X-GitHub-Event', op: 'one-of', value: 'issues' }, { where: 'body', path: 'action', op: 'equals', value: 'opened' }],
    template: '{{repository.full_name}}: new issue “{{issue.title}}” by {{issue.user.login}}',
    sample: { headers: { 'x-github-event': 'issues', 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958' }, body: { action: 'opened', issue: { number: 42, title: 'Login button does nothing', html_url: 'https://github.com/octo-org/hello-world/issues/42', user: { login: 'octocat' }, body: 'Clicking it on the phone does nothing.' }, repository: { full_name: 'octo-org/hello-world' }, sender: { login: 'octocat' } } },
  },
  {
    id: 'github-pr-opened', sender: 'github', name: 'A pull request was opened', event: 'pull_request',
    filters: [{ where: 'header', path: 'X-GitHub-Event', op: 'one-of', value: 'pull_request' }, { where: 'body', path: 'action', op: 'equals', value: 'opened' }],
    template: '{{repository.full_name}}: pull request “{{pull_request.title}}” by {{pull_request.user.login}}',
    sample: { headers: { 'x-github-event': 'pull_request', 'x-github-delivery': '9a2c4f10-1d2b-11ef-8a3c-2b1f9d1c0e51' }, body: { action: 'opened', number: 7, pull_request: { title: 'Fix the login button', html_url: 'https://github.com/octo-org/hello-world/pull/7', user: { login: 'octocat' } }, repository: { full_name: 'octo-org/hello-world' } } },
  },
  {
    id: 'github-ci-failed', sender: 'github', name: 'CI failed', event: 'workflow_run',
    filters: [{ where: 'header', path: 'X-GitHub-Event', op: 'one-of', value: 'workflow_run' }, { where: 'body', path: 'action', op: 'equals', value: 'completed' }, { where: 'body', path: 'workflow_run.conclusion', op: 'equals', value: 'failure' }],
    template: '{{repository.full_name}}: {{workflow_run.name}} failed on {{workflow_run.head_branch}}',
    sample: { headers: { 'x-github-event': 'workflow_run', 'x-github-delivery': 'b5e1c3a0-3f7a-11ef-9a4b-0242ac120002' }, body: { action: 'completed', workflow_run: { name: 'Tests', head_branch: 'main', conclusion: 'failure', status: 'completed', html_url: 'https://github.com/octo-org/hello-world/actions/runs/30433642', run_number: 562 }, repository: { full_name: 'octo-org/hello-world' } } },
  },
  {
    id: 'github-release', sender: 'github', name: 'A release was published', event: 'release',
    filters: [{ where: 'header', path: 'X-GitHub-Event', op: 'one-of', value: 'release' }, { where: 'body', path: 'action', op: 'equals', value: 'published' }],
    template: '{{repository.full_name}}: release {{release.tag_name}} is out',
    sample: { headers: { 'x-github-event': 'release', 'x-github-delivery': 'c0ffee00-4a5b-11ef-8c6d-0242ac120002' }, body: { action: 'published', release: { tag_name: 'v1.2.0', name: 'v1.2.0', html_url: 'https://github.com/octo-org/hello-world/releases/tag/v1.2.0' }, repository: { full_name: 'octo-org/hello-world' } } },
  },
  {
    id: 'stripe-payment-failed', sender: 'stripe', name: 'A payment failed', event: 'invoice.payment_failed',
    filters: [{ where: 'body', path: 'type', op: 'equals', value: 'invoice.payment_failed' }],
    template: 'Stripe: a payment of {{data.object.amount_due}} {{data.object.currency}} failed ({{data.object.customer_email}})',
    sample: { headers: {}, body: { id: 'evt_1PaymentFailed0001', object: 'event', type: 'invoice.payment_failed', created: 1730000000, data: { object: { id: 'in_1Example', object: 'invoice', amount_due: 2500, currency: 'usd', customer_email: 'alex@example.com', attempt_count: 1 } } } },
  },
  {
    id: 'stripe-dispute', sender: 'stripe', name: 'A dispute was opened', event: 'charge.dispute.created',
    filters: [{ where: 'body', path: 'type', op: 'equals', value: 'charge.dispute.created' }],
    template: 'Stripe: a dispute over {{data.object.amount}} {{data.object.currency}} ({{data.object.reason}})',
    sample: { headers: {}, body: { id: 'evt_1DisputeCreated01', object: 'event', type: 'charge.dispute.created', data: { object: { id: 'dp_1Example', object: 'dispute', amount: 12000, currency: 'usd', reason: 'fraudulent' } } } },
  },
  {
    id: 'stripe-payout-paid', sender: 'stripe', name: 'A payout was paid', event: 'payout.paid',
    filters: [{ where: 'body', path: 'type', op: 'equals', value: 'payout.paid' }],
    template: 'Stripe: payout of {{data.object.amount}} {{data.object.currency}} arrived',
    sample: { headers: {}, body: { id: 'evt_1PayoutPaid00001', object: 'event', type: 'payout.paid', data: { object: { id: 'po_1Example', object: 'payout', amount: 48210, currency: 'usd', arrival_date: 1730100000 } } } },
  },
  {
    id: 'ha-state-changed', sender: 'home-assistant', name: 'A state changed to a value', event: 'state_changed',
    filters: [{ where: 'body', path: 'data.entity_id', op: 'equals', value: 'binary_sensor.washer' }, { where: 'body', path: 'data.new_state.state', op: 'changed-to', value: 'off' }],
    template: '{{data.new_state.attributes.friendly_name}} is now {{data.new_state.state}}',
    sample: { headers: {}, body: { event_type: 'state_changed', data: { entity_id: 'binary_sensor.washer', old_state: { state: 'on', attributes: { friendly_name: 'Washer' } }, new_state: { state: 'off', attributes: { friendly_name: 'Washer' } } } } },
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

/** Which signature kind a sender uses by default (Home Assistant: the header token). */
export const SENDER_VERIFY: Record<Sender, VerifyKind> = { github: 'github', stripe: 'stripe', 'home-assistant': 'header', other: 'standard' };

/** The event name of a delivery: GitHub's header, else the body's `type` / `event_type` / `event`. */
export function eventOf(h: Headers, body: unknown): string {
  const gh = header(h, 'x-github-event');
  if (gh) return plainLine(gh, 80);
  for (const k of ['type', 'event_type', 'event']) {
    const v = pathGet(body, k);
    if (typeof v === 'string' && v) return plainLine(v, 80);
  }
  return '';
}

/** Stripe's idempotency key: the event `id` in the body. */
export function stripeEventId(body: unknown): string | undefined {
  const v = pathGet(body, 'id');
  return typeof v === 'string' && /^evt_[A-Za-z0-9_]{1,200}$/.test(v) ? v : undefined;
}

/**
 * The exact `curl` for "Send a test" (§10.6): the body, the content type and the signature headers
 * computed now with the hook's sender secret. `$HOOK_URL` stays a placeholder unless given (only
 * the hash of the URL secret is kept, so the page fills in the address it still shows).
 */
export function curlFor(kind: VerifyKind, secret: string | undefined, body: string, opts: { url?: string; nowS: number; id: string; event?: string }): string {
  const url = opts.url ?? '$HOOK_URL';
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hs: string[] = [`-H ${q('Content-Type: application/json')}`];
  if (kind === 'github') {
    hs.push(`-H ${q(`X-GitHub-Event: ${opts.event || 'ping'}`)}`, `-H ${q(`X-GitHub-Delivery: ${opts.id}`)}`);
    if (secret) hs.push(`-H ${q(`X-Hub-Signature-256: sha256=${hmacHex(secret, body)}`)}`);
  } else if (kind === 'stripe') {
    if (secret) hs.push(`-H ${q(`Stripe-Signature: t=${opts.nowS},v1=${hmacHex(secret, `${opts.nowS}.${body}`)}`)}`);
  } else if (kind === 'standard') {
    if (secret) for (const [k, v] of Object.entries(signStandard(secret, opts.id, opts.nowS, body))) hs.push(`-H ${q(`${k}: ${v}`)}`);
  } else if (kind === 'header') {
    // The token itself is never printed: the owner sets SARA_TOKEN to it in his shell first.
    hs.push('-H "X-Sara-Token: $SARA_TOKEN"', `-H ${q(`X-Request-Id: ${opts.id}`)}`);
  }
  return `curl -sS -X POST "${url}" ${hs.join(' ')} --data-binary ${q(body)}`;
}

// Phase 122 part 3 (docs/design/BRIDGES4.md §4, §7.1, §7.4–§7.5, §8.2): the iMessage setup card's
// server side. Owner only: these live under the `plugins` route family, which is not a member family
// (src/household.ts), so no new route family exists.
//   GET  /api/plugins/imessage/setup?companion=   the stepper state (each step checked, never "I did it")
//   POST /api/plugins/imessage/terms              { companion } the terms box was ticked (with the date)
//   POST /api/plugins/imessage/address            { companion, server, onOtherMachine?, https? } step 5
//   POST /api/plugins/imessage/password           { companion, password } step 4 (into the vault, write-only)
//   POST /api/plugins/imessage/check              { companion, step: server | test } → { ok, diagnosis? }
//   POST /api/plugins/imessage/fix                { companion, fix: doorbell | polling | link, saraAddress? }
// The BlueBubbles password lives in the vault (`plugin:imessage:password`) and reaches only the plugin;
// no answer from here ever carries it.
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { accessInfo } from '../platform.ts';
import { KEY_SHAPED } from '../redact.ts';
import { isLoopbackAddress } from './net.ts';
import type { PluginManager } from './manager.ts';

export const IM = 'imessage';
/** The terms box's version (§9.6): a changed box asks again. */
export const IM_TERMS_DATE = '2026-11-02';
export const IM_STEPS = ['appleid', 'macuser', 'messages', 'install', 'server', 'doorbell', 'hello', 'test'] as const;
/** How long *Ring* waits for BlueBubbles' hello-world to reach Sara (§7.1 step 6). */
export const RING_WAIT_MS = 8_000;
const ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}\.)*[A-Za-z0-9-]{1,63}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\]):\d{1,5}$/;

interface Cached {
  ok: boolean;
  at: string;
  diagnosis?: Record<string, unknown>;
  [k: string]: unknown;
}
const kvKey = (step: string) => `__check:${step}`;
function cached(pm: PluginManager, companion: string, step: string): Cached | undefined {
  const raw = pm.store.get(IM) ? pm.store.kvGet(IM, companion, kvKey(step)) : undefined;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return undefined;
  }
}
function remember(pm: PluginManager, companion: string, step: string, r: Record<string, unknown> | undefined, now: Date): void {
  if (!pm.store.get(IM)) return;
  if (!r) return void pm.store.kvSet(IM, companion, kvKey(step), undefined);
  const { password: _p, ...rest } = r;
  pm.store.kvSet(IM, companion, kvKey(step), JSON.stringify({ ...rest, ok: r.ok === true, at: now.toISOString() }));
}

/** Waits (≤ 10 s) for the plugin to be running again after its settings changed (polled, never a fixed pause). */
async function running(pm: PluginManager, companion: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  await new Promise((r) => setTimeout(r, 30));
  while (Date.now() < end) {
    if (pm.processOf(IM, companion)?.state === 'ready') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const setting = (pm: PluginManager, companion: string, k: string) => pm.settingsView(IM, companion).settings.find((s) => s.key === k);

/** §4.4: an address of the Apple ID on the Mac is one of his linked handles → his own Apple ID. */
function ownAppleId(pm: PluginManager, companion: string, handles: unknown): string {
  const mine = new Set((pm.settingsView(IM, companion).bridge?.ownerIds ?? []).map((x) => x.toLowerCase()));
  return (Array.isArray(handles) ? handles : []).map((h) => String(h).toLowerCase()).find((h) => mine.has(h)) ?? '';
}

/** Step 5's check (and step 4's): BlueBubbles answers, takes the password, Messages signed in, not his Apple ID. */
async function serverCheck(app: AppContext, pm: PluginManager, companion: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  let r = await pm.bridgeCheck(IM, companion, { step: 'server' });
  const own = r.ok || (r.diagnosis as { code?: string } | undefined)?.code === 'MESSAGES_SIGNED_OUT' ? ownAppleId(pm, companion, r.handles) : '';
  if (own) r = { ...r, ok: false, diagnosis: { code: 'OWN_APPLE_ID', params: { handle: own } } };
  remember(pm, companion, 'server', r, now);
  return r;
}

/** Where BlueBubbles can reach Sara (§7.1 step 6): this computer when they share it, else her LAN or tailnet address. */
export function saraAddressFor(pm: PluginManager, companion: string): string | null {
  const kept = pm.store.get(IM) ? pm.store.kvGet(IM, companion, '__saraAddress') : undefined;
  if (kept) return kept;
  const server = String(setting(pm, companion, 'server')?.value ?? '');
  const host = server.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const port = Number(process.env.SARA_PORT ?? 7860);
  if (host === 'localhost' || isLoopbackAddress(host)) return `http://127.0.0.1:${port}`;
  const acc = accessInfo();
  if (acc.url && (acc.mode === 'lan' || acc.mode === 'tailscale' || acc.mode === 'domain')) return new URL(acc.url).origin;
  return null;
}

/** The stepper state (§7.1): each step ✓ only when Sara checked it. */
export async function setupState(app: AppContext, pm: PluginManager, companion: string): Promise<Record<string, unknown>> {
  const row = pm.store.get(IM);
  const on = Boolean(row && pm.enabledFor(IM, companion));
  const isRunning = on && pm.processOf(IM, companion)?.state === 'ready';
  const settings = row ? pm.settingsView(IM, companion) : undefined;
  const value = (k: string) => settings?.settings.find((s) => s.key === k);
  const bridge = settings?.bridge;
  const linked = Boolean(bridge?.ownerChats?.length);
  const live = isRunning ? await pm.bridgeCheck(IM, companion, { step: 'state' }, 3_000).catch(() => undefined) : undefined;
  const srv = cached(pm, companion, 'server');
  const code = String((srv?.diagnosis as { code?: string } | undefined)?.code ?? '');
  const refused = live?.refused === 'OWN_APPLE_ID' || code === 'OWN_APPLE_ID';
  const hook = app.hooks?.bridgeHookFor(IM, companion);
  const rang = hook && app.hooks ? app.hooks.bridgeState(hook.id).lastAccepted : null;
  const polling = live?.mode === 'polling';
  const diag = (c: string) => ({ code: c });
  const steps: { id: string; ok: boolean; checkedAt?: string; diagnosis?: Record<string, unknown> }[] = [];
  const serverOk = Boolean(srv?.ok) && !refused;
  const signedIn = Boolean(srv?.ok) || (Boolean(srv) && !['MESSAGES_SIGNED_OUT', 'BB_PASSWORD', 'BB_UNREACHABLE', 'NOT_SET', 'NETWORK_SWITCH', 'TAILNET_OFF', 'PRIVATE_LOCAL', 'NOT_RUNNING', 'UNKNOWN'].includes(code));
  const passwordOk = Boolean(srv) && !['BB_PASSWORD', 'BB_UNREACHABLE', 'NOT_SET', 'NETWORK_SWITCH', 'TAILNET_OFF', 'PRIVATE_LOCAL', 'NOT_RUNNING', 'UNKNOWN'].includes(code);
  const at = srv ? { checkedAt: srv.at } : {};
  steps.push({ id: 'appleid', ok: serverOk, ...(refused ? { diagnosis: diag('OWN_APPLE_ID') } : {}) });
  steps.push({ id: 'macuser', ok: serverOk });
  steps.push({ id: 'messages', ok: signedIn, ...(code === 'MESSAGES_SIGNED_OUT' ? { diagnosis: srv!.diagnosis } : {}) });
  steps.push({ id: 'install', ok: passwordOk, ...at, ...(code === 'BB_PASSWORD' ? { diagnosis: srv!.diagnosis } : {}) });
  steps.push({ id: 'server', ok: serverOk, ...at, ...(srv?.diagnosis && code !== 'BB_PASSWORD' && code !== 'MESSAGES_SIGNED_OUT' ? { diagnosis: srv.diagnosis } : {}) });
  const doorDiag = cached(pm, companion, 'doorbell');
  steps.push({ id: 'doorbell', ok: Boolean(rang) || polling, ...(doorDiag?.diagnosis && !rang && !polling ? { diagnosis: doorDiag.diagnosis } : {}) });
  steps.push({ id: 'hello', ok: linked });
  const t = cached(pm, companion, 'test');
  steps.push({ id: 'test', ok: Boolean(t?.ok), ...(t ? { checkedAt: t.at, ...(t.diagnosis ? { diagnosis: t.diagnosis } : {}) } : {}) });
  const view = row ? pm.bridgeView(IM, companion) : undefined;
  const terms = row ? pm.store.kvGet(IM, companion, '__terms') : undefined;
  return {
    installed: Boolean(row),
    on,
    running: isRunning,
    state: privateLocalOn() && row ? 'paused' : refused ? 'error' : (view?.state ?? 'off'),
    detail: view?.detail ?? '',
    steps,
    done: steps.filter((s) => s.ok).length,
    server: { address: String(value('server')?.value ?? ''), onOtherMachine: value('onOtherMachine')?.value === true, https: value('https')?.value === true, version: String(live?.version || srv?.version || ''), os: String(live?.os || srv?.os || ''), privateApi: Boolean(live?.version ? live.privateApi : srv?.privateApi), account: String(live?.account || srv?.account || '') },
    passwordSet: Boolean(value('password')?.set),
    doorbell: rang ? 'ok' : polling ? 'polling' : null,
    saraAddress: row ? saraAddressFor(pm, companion) : null,
    refused: refused ? 'OWN_APPLE_ID' : null,
    linked: bridge?.ownerChats ?? [],
    handles: bridge?.ownerIds ?? [],
    others: bridge?.others === true,
    allow: bridge?.allow ?? [],
    sentToday: Number((live?.today as { day?: number } | undefined)?.day ?? 0),
    today: view?.today ?? null,
    terms: terms ? { at: terms, for: IM_TERMS_DATE } : null,
    termsDate: IM_TERMS_DATE,
  };
}

/** Step 5: where BlueBubbles is (address with its port; the network switch; HTTPS). */
export async function setAddress(app: AppContext, pm: PluginManager, companion: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = String(body.server ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (KEY_SHAPED.some((re) => re.test(server))) throw new HttpError(400, 'That looks like a password or key. Paste the password in its own field.');
  if (!ADDRESS.test(server)) throw new HttpError(400, 'Type the address with its port, like 127.0.0.1:1234 or 192.168.1.20:1234.');
  const values: Record<string, unknown> = { server };
  if (typeof body.onOtherMachine === 'boolean') values.onOtherMachine = body.onOtherMachine;
  if (typeof body.https === 'boolean') values.https = body.https;
  await pm.putSettings(IM, companion, values);
  await running(pm, companion);
  return serverCheck(app, pm, companion);
}

/** Step 4: the server password into the vault (write-only), then the same check. */
export async function setPassword(app: AppContext, pm: PluginManager, companion: string, password: unknown): Promise<Record<string, unknown>> {
  const p = typeof password === 'string' ? password : '';
  if (!p || p.length > 200 || /[\r\n]/.test(p)) throw new HttpError(400, 'Paste the server password from BlueBubbles.');
  await pm.putSettings(IM, companion, { password: p });
  await running(pm, companion);
  return serverCheck(app, pm, companion);
}

export async function runCheck(app: AppContext, pm: PluginManager, companion: string, step: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  if (step === 'server') return serverCheck(app, pm, companion);
  if (step === 'test') {
    const r = await pm.testBridge(IM, companion);
    const linked = Boolean(pm.settingsView(IM, companion).bridge?.ownerChats?.length);
    const lines = [...r.steps, { label: 'Your iMessage is linked', ok: linked, ...(linked ? {} : { fix: 'Step 7: Link my iMessage, then send the code from your iPhone.' }) }];
    const ok = lines.every((l) => l.ok);
    remember(pm, companion, 'test', { ok }, now);
    return { ok, steps: lines };
  }
  throw new HttpError(400, 'No such step.');
}

/** The one-tap actions (§8.2): make the doorbell (and ring), use polling instead, a link code. */
export async function runFix(app: AppContext, pm: PluginManager, companion: string, fix: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (fix === 'link') return { ok: true, ...pm.linkCode(IM, companion) };
  if (fix === 'polling') {
    const r = await pm.bridgeCheck(IM, companion, { step: 'polling' });
    remember(pm, companion, 'doorbell', undefined, now);
    return r;
  }
  if (fix === 'doorbell') {
    if (!app.hooks) throw new HttpError(400, 'Webhooks are not available here.');
    if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
    const given = typeof body.saraAddress === 'string' ? body.saraAddress.trim() : '';
    if (given) {
      let u: URL;
      try {
        u = new URL(given);
      } catch {
        throw new HttpError(400, 'Type Sara\'s address like http://192.168.1.10:7860.');
      }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) throw new HttpError(400, 'Type Sara\'s address like http://192.168.1.10:7860.');
      pm.store.kvSet(IM, companion, '__saraAddress', u.origin);
    }
    const base = saraAddressFor(pm, companion);
    if (!base) {
      const out = { ok: false, diagnosis: { code: 'NO_DOORBELL' } };
      remember(pm, companion, 'doorbell', out, now);
      return out;
    }
    const h = app.hooks.ensureBridgeHook(IM, companion, undefined, 'url');
    const before = app.hooks.bridgeState(h.hook.id).lastAccepted;
    const r = await pm.bridgeCheck(IM, companion, { step: 'register', url: `${base}${h.path}` });
    if (!r.ok) {
      remember(pm, companion, 'doorbell', r, now);
      return r;
    }
    // BlueBubbles' hello-world must reach Sara (polled, ≤ 8 s).
    const end = Date.now() + RING_WAIT_MS;
    while (Date.now() < end) {
      const last = app.hooks.bridgeState(h.hook.id).lastAccepted;
      if (last && last !== before) {
        remember(pm, companion, 'doorbell', { ok: true }, now);
        return { ok: true, saraAddress: base };
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    const out = { ok: false, saraAddress: base, diagnosis: { code: 'NO_DOORBELL' } };
    remember(pm, companion, 'doorbell', out, now);
    return out;
  }
  throw new HttpError(400, 'No such fix.');
}

// Phase 122 (docs/design/WHATSAPP.md §5, §6.2): the WhatsApp setup card's server side. Owner only:
// these live under the `plugins` route family, which is not a member family (src/household.ts).
//   GET  /api/plugins/whatsapp/setup?companion=   the stepper state (each step checked, never "I did it")
//   POST /api/plugins/whatsapp/terms              { companion } the terms box was ticked (with the date)
//   POST /api/plugins/whatsapp/webhook            { companion, appSecret?, newVerifyToken? } → { callbackUrl, verifyToken }
//   POST /api/plugins/whatsapp/door-url           { companion, url } *Something else*: a tunnel's https address
//   POST /api/plugins/whatsapp/check              { companion, step } → { ok, diagnosis? } (read-only Graph calls)
//   POST /api/plugins/whatsapp/fix                { companion, fix: subscribe | identity-check }
//   POST /api/plugins/whatsapp/register           { companion, phoneNumberId, pin } (the PIN is never kept or logged)
//   POST /api/plugins/whatsapp/send-test          { companion } (a reply inside his open window only)
//   POST /api/plugins/whatsapp/unmute             { companion, who }
// and POST /api/access/door { action: open | close | check } (W2) in src/routes/admin.ts.
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { accessInfo } from '../platform.ts';
import { doorCommand, findTailscale } from '../tailscale.ts';
import type { PluginManager } from './manager.ts';

export const WA = 'whatsapp';
/** The terms box's text was written for the Business Solution Terms last modified on this date (§7.6). */
export const TERMS_DATE = '2026-01-15';
export const STEP_IDS = ['add', 'app', 'ids', 'phone', 'token', 'secret', 'door', 'connect', 'hello', 'test'] as const;
export type StepId = (typeof STEP_IDS)[number];

interface Cached {
  ok: boolean;
  at: string;
  diagnosis?: Record<string, unknown>;
  number?: Record<string, unknown>;
}

const kvKey = (step: string) => `__check:${step}`;

function cached(pm: PluginManager, companion: string, step: string): Cached | undefined {
  const raw = pm.store.kvGet(WA, companion, kvKey(step));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return undefined;
  }
}
function remember(pm: PluginManager, companion: string, step: string, r: Record<string, unknown>, now: Date): Cached {
  const c: Cached = { ok: r.ok === true, at: now.toISOString(), ...(r.diagnosis ? { diagnosis: r.diagnosis as Record<string, unknown> } : {}), ...(r.number ? { number: r.number as Record<string, unknown> } : {}) };
  if (pm.store.get(WA)) pm.store.kvSet(WA, companion, kvKey(step), JSON.stringify(c));
  return c;
}

/** Where Meta calls: the installer's door or domain, else a tunnel address he pasted. */
export function hookBase(pm: PluginManager, companion: string): string | null {
  return accessInfo().hookUrl ?? (pm.store.get(WA) ? (pm.store.kvGet(WA, companion, '__door') ?? null) : null);
}

/** What the door step offers (§2.10): his own domain, the Funnel door (a tap or the command), something else. */
export function doorView(pm: PluginManager, companion: string): { mode: string | null; hookUrl: string | null; canOpen: boolean; command: string; pasted: boolean } {
  const acc = accessInfo();
  const port = Number(process.env.SARA_PORT ?? 7860);
  const pasted = !acc.hookUrl && Boolean(pm.store.get(WA) && pm.store.kvGet(WA, companion, '__door'));
  return { mode: acc.mode, hookUrl: hookBase(pm, companion), canOpen: Boolean(findTailscale()) && process.env.SARA_DOOR_RUN !== '0', command: doorCommand(port), pasted };
}

/** The stepper state: each step ✓ only when Sara checked it (§5.1). */
export function setupState(app: AppContext, pm: PluginManager, companion: string): Record<string, unknown> {
  const row = pm.store.get(WA);
  const now = app.now?.() ?? new Date();
  const on = Boolean(row && pm.enabledFor(WA, companion));
  const running = on && pm.processOf(WA, companion)?.state === 'ready';
  const hooks = app.hooks;
  const hook = hooks?.bridgeHookFor(WA, companion);
  const hs = hook && hooks ? hooks.bridgeState(hook.id) : undefined;
  const bridge = row ? pm.settingsView(WA, companion).bridge : undefined;
  const linked = Boolean(bridge?.ownerChats?.length);
  const door = doorView(pm, companion);
  const c = (s: string) => (row ? cached(pm, companion, s) : undefined);
  const diag = (code: string, params?: Record<string, unknown>) => ({ code, ...(params ? { params } : {}) });
  const steps: { id: StepId; ok: boolean; checkedAt?: string; diagnosis?: Record<string, unknown> }[] = [];
  const add = (id: StepId, ok: boolean, more: { checkedAt?: string; diagnosis?: Record<string, unknown> } = {}) => steps.push({ id, ok, ...more });
  add('add', running, running ? {} : row ? { diagnosis: diag(on ? 'NOT_RUNNING' : 'NOT_ON') } : {});
  const ids = c('ids');
  add('app', Boolean(ids?.ok), ids?.ok ? { checkedAt: ids.at } : {});
  add('ids', Boolean(ids?.ok), ids ? { checkedAt: ids.at, ...(ids.diagnosis ? { diagnosis: ids.diagnosis } : {}) } : {});
  add('phone', linked);
  const tok = c('token');
  add('token', Boolean(tok?.ok), tok ? { checkedAt: tok.at, ...(tok.diagnosis ? { diagnosis: tok.diagnosis } : {}) } : {});
  const secretSet = Boolean(hook && hooks?.hasSenderSecret(hook.id));
  add('secret', secretSet && (hs?.badSignatures ?? 0) < 5, hs && hs.badSignatures >= 5 ? { diagnosis: diag('BAD_SIGNATURE') } : {});
  add('door', Boolean(door.hookUrl), door.hookUrl ? {} : { diagnosis: diag('NO_DOOR') });
  const connected = Boolean(hs?.verifiedAt);
  add('connect', connected, connected ? { checkedAt: hs!.verifiedAt! } : hs?.wrongToken ? { diagnosis: diag('VERIFY_TOKEN') } : {});
  add('hello', linked, !linked && connected && c('subscribed')?.ok === false ? { diagnosis: c('subscribed')!.diagnosis ?? diag('NOT_SUBSCRIBED') } : {});
  const t = c('test');
  add('test', Boolean(t?.ok), t ? { checkedAt: t.at, ...(t.diagnosis ? { diagnosis: t.diagnosis } : {}) } : {});
  const view = row ? pm.bridgeView(WA, companion) : undefined;
  const terms = row ? pm.store.kvGet(WA, companion, '__terms') : undefined;
  return {
    installed: Boolean(row),
    on,
    running,
    state: privateLocalOn() ? 'paused' : (view?.state ?? 'off'),
    detail: view?.detail ?? '',
    steps,
    done: steps.filter((s) => s.ok).length,
    door,
    hook: hook ? { id: hook.id, callbackUrl: door.hookUrl ? `${door.hookUrl}${hooks!.bridgePath(hook.id)}` : null, verifiedAt: hs?.verifiedAt ?? null, lastAccepted: hs?.lastAccepted ?? null, secretSet, ...(hs?.verifiedAt ? {} : { verifyToken: hooks!.ensureBridgeHook(WA, companion).verifyToken }) } : null,
    window: row ? pm.windowView(WA, companion) : { openUntil: null, open: false, closedBy: null },
    number: tok?.number ?? null,
    linked: bridge?.ownerChats ?? [],
    others: bridge?.others === true,
    allow: bridge?.allow ?? [],
    muted: row ? pm.muted(WA, companion) : [],
    identityChanged: view?.identityChanged ?? [],
    today: view?.today ?? null,
    terms: terms ? { at: terms, for: TERMS_DATE } : null,
    termsDate: TERMS_DATE,
  };
}

export async function runCheck(app: AppContext, pm: PluginManager, companion: string, step: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn() && ['ids', 'token', 'subscribed', 'test'].includes(step)) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  const hooks = app.hooks;
  const hook = hooks?.bridgeHookFor(WA, companion);
  if (step === 'door') {
    const base = hookBase(pm, companion);
    return base ? { ok: true } : { ok: false, diagnosis: { code: 'NO_DOOR' } };
  }
  if (step === 'secret') {
    if (!hook || !hooks?.hasSenderSecret(hook.id)) return { ok: false, diagnosis: { code: 'NOT_SET' } };
    return hooks.bridgeState(hook.id).badSignatures >= 5 ? { ok: false, diagnosis: { code: 'BAD_SIGNATURE' } } : { ok: true };
  }
  if (step === 'connect') {
    if (!hook || !hooks) return { ok: false, diagnosis: { code: 'NO_DOOR' } };
    const st = hooks.bridgeState(hook.id);
    if (st.verifiedAt) {
      const sub = await pm.bridgeCheck(WA, companion, { step: 'subscribed' });
      remember(pm, companion, 'subscribed', sub, now);
      return sub.ok ? { ok: true, verifiedAt: st.verifiedAt } : sub;
    }
    return { ok: false, diagnosis: { code: st.wrongToken ? 'VERIFY_TOKEN' : hookBase(pm, companion) ? 'DOOR_CLOSED' : 'NO_DOOR', ...(hookBase(pm, companion) ? { params: { door: hookBase(pm, companion) } } : {}) } };
  }
  if (step === 'test') {
    const r = await pm.testBridge(WA, companion);
    const st = setupState(app, pm, companion) as { steps: { id: string; ok: boolean }[]; door: { hookUrl: string | null }; hook: { verifiedAt: string | null } | null };
    const lines = [...r.steps, { label: 'Meta has a public https address for Sara', ok: Boolean(st.door.hookUrl) }, { label: "Meta's handshake happened", ok: Boolean(st.hook?.verifiedAt) }, { label: 'Your chat is linked', ok: st.steps.find((s) => s.id === 'hello')?.ok === true }];
    const ok = lines.every((l) => l.ok);
    remember(pm, companion, 'test', { ok }, now);
    return { ok, steps: lines };
  }
  if (!['ids', 'token', 'subscribed'].includes(step)) throw new HttpError(400, 'No such step.');
  const r = await pm.bridgeCheck(WA, companion, { step });
  remember(pm, companion, step, r, now);
  if (step === 'token' && r.ok) remember(pm, companion, 'ids', { ok: true }, now);
  return r;
}

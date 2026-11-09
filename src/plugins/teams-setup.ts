// EC7 (docs/ops/EC7_DESIGN.md): the Microsoft Teams setup card's server side, the Slack pattern with
// WhatsApp's door. Owner only: these live under the `plugins` route family (not a member family).
//   GET  /api/plugins/teams/setup?companion=        the stepper state (each step checked, never "I did it")
//   POST /api/plugins/teams/credentials             { companion, appId, tenantId, appPassword } shapes first
//                                                   (no call), then the vault and the hook, then a token
//   POST /api/plugins/teams/door-url                { companion, url } "no public address": a tunnel's https address
//   POST /api/plugins/teams/check                   { companion, step: credentials | endpoint | test }
//   POST /api/plugins/teams/fix                     { companion, fix: link | logout }
//   GET  /api/plugins/teams/app-package?companion=  the Teams app package (zip) he uploads in Teams
// Channels are switched on with the shared POST /api/plugins/teams/group { companion, chat, on }.
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import { accessInfo } from '../platform.ts';
import { doorCommand, findTailscale } from '../tailscale.ts';
import type { PluginManager } from './manager.ts';
import { teamsPackage } from './teams-package.ts';

export const TE = 'teams';
export const TE_STEPS = ['bot', 'credentials', 'door', 'endpoint', 'package', 'link', 'test'] as const;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})+$/i;

interface Cached {
  ok: boolean;
  at: string;
  diagnosis?: Record<string, unknown>;
}
const kvKey = (step: string) => `__check:${step}`;
function cached(pm: PluginManager, companion: string, step: string): Cached | undefined {
  const raw = pm.store.get(TE) ? pm.store.kvGet(TE, companion, kvKey(step)) : undefined;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return undefined;
  }
}
function remember(pm: PluginManager, companion: string, step: string, r: Record<string, unknown> | undefined, now: Date): void {
  if (!pm.store.get(TE)) return;
  if (!r) return void pm.store.kvSet(TE, companion, kvKey(step), undefined);
  pm.store.kvSet(TE, companion, kvKey(step), JSON.stringify({ ok: r.ok === true, at: now.toISOString(), ...(r.diagnosis ? { diagnosis: r.diagnosis } : {}) }));
}

async function running(pm: PluginManager, companion: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pm.processOf(TE, companion)?.state === 'ready') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** The three boxes before anything is sent anywhere: a code for each wrong shape. */
export function credentialShape(appId: string, tenantId: string, secret: string, secretSaved: boolean): string | undefined {
  if (!GUID.test(appId)) return 'APP_ID_SHAPE';
  if (tenantId && !GUID.test(tenantId) && !TENANT_NAME.test(tenantId)) return 'TENANT_SHAPE';
  if (!secret && !secretSaved) return 'NOT_SET';
  // A GUID in the secret box is the secret's ID (Azure shows both side by side).
  if (secret && GUID.test(secret)) return 'SECRET_SHAPE';
  if (secret && (secret.length < 16 || secret.length > 200 || /\s/.test(secret))) return 'SECRET_SHAPE';
  return undefined;
}

/** Where Teams calls: the installer's door or domain, else a tunnel address he pasted. */
export function hookBase(pm: PluginManager, companion: string): string | null {
  return accessInfo().hookUrl ?? (pm.store.get(TE) ? (pm.store.kvGet(TE, companion, '__door') ?? null) : null);
}

export async function setupState(app: AppContext, pm: PluginManager, companion: string): Promise<Record<string, unknown>> {
  const row = pm.store.get(TE);
  const on = Boolean(row && pm.enabledFor(TE, companion));
  const isRunning = on && pm.processOf(TE, companion)?.state === 'ready';
  const settings = row ? pm.settingsView(TE, companion) : undefined;
  const bridge = settings?.bridge;
  const value = (k: string) => String(settings?.settings.find((s) => s.key === k)?.value ?? '');
  const secretSet = Boolean(settings?.settings.find((s) => s.key === 'appPassword')?.set);
  const live = isRunning ? await pm.bridgeCheck(TE, companion, { step: 'status' }, 3_000).catch(() => undefined) : undefined;
  const creds = cached(pm, companion, 'credentials');
  const gone = typeof live?.ended === 'string' && live.ended ? live.ended : '';
  const credsOk = Boolean(creds?.ok && secretSet && value('appId') && !gone);
  const hooks = app.hooks;
  const hook = hooks?.bridgeHookFor(TE, companion);
  const hs = hook && hooks ? hooks.bridgeState(hook.id) : undefined;
  const base = hookBase(pm, companion);
  const acc = accessInfo();
  const called = Boolean(hs?.lastAccepted);
  const linked = Boolean(bridge?.ownerChats?.length);
  const pkg = row ? pm.store.kvGet(TE, companion, '__package') : undefined;
  const t = cached(pm, companion, 'test');
  const steps: { id: string; ok: boolean; checkedAt?: string; diagnosis?: Record<string, unknown> }[] = [
    { id: 'bot', ok: credsOk },
    { id: 'credentials', ok: credsOk, ...(creds ? { checkedAt: creds.at } : {}), ...(gone ? { diagnosis: { code: gone } } : creds?.diagnosis ? { diagnosis: creds.diagnosis } : {}) },
    { id: 'door', ok: Boolean(base), ...(base ? {} : { diagnosis: { code: 'NO_DOOR' } }) },
    { id: 'endpoint', ok: called, ...(called ? { checkedAt: hs!.lastAccepted! } : hs && hs.badSignatures >= 3 ? { diagnosis: { code: 'BAD_SIGNATURE' } } : {}) },
    { id: 'package', ok: Boolean(pkg) && called, ...(pkg ? { checkedAt: pkg } : {}) },
    { id: 'link', ok: linked },
    { id: 'test', ok: Boolean(t?.ok), ...(t ? { checkedAt: t.at, ...(t.diagnosis ? { diagnosis: t.diagnosis } : {}) } : {}) },
  ];
  const view = row ? pm.bridgeView(TE, companion) : undefined;
  const list = isRunning ? await pm.bridgeCheck(TE, companion, { step: 'channels' }, 3_000).catch(() => undefined) : undefined;
  const onSet = new Set((bridge?.groups ?? []).filter((g) => g.on).map((g) => g.key));
  const channels = (Array.isArray(list?.channels) ? list!.channels : []) as { id: string; name: string }[];
  return {
    installed: Boolean(row),
    on,
    running: isRunning,
    state: privateLocalOn() && row ? 'paused' : (view?.state ?? 'off'),
    detail: view?.detail ?? '',
    steps,
    done: steps.filter((s) => s.ok).length,
    appId: value('appId'),
    tenantId: value('tenantId'),
    secretSet,
    door: { mode: acc.mode, hookUrl: base, canOpen: Boolean(findTailscale()) && process.env.SARA_DOOR_RUN !== '0', command: doorCommand(Number(process.env.SARA_PORT ?? 7860)), pasted: !acc.hookUrl && Boolean(base) },
    endpoint: hook && hooks ? (base ? `${base}${hooks.bridgePath(hook.id)}` : null) : null,
    hookPath: hook && hooks ? hooks.bridgePath(hook.id) : null,
    lastCall: hs?.lastAccepted ?? null,
    badSignatures: hs?.badSignatures ?? 0,
    channels: channels.map((c) => ({ ...c, on: onSet.has(c.id) })),
    linked: bridge?.ownerChats ?? [],
    others: bridge?.others === true,
    workInGroups: bridge?.workInGroups === true,
    today: view?.today ?? null,
    herName: app.persona.name,
  };
}

/** Step 2: the three values. Shapes first (nothing is sent), then the vault and the hook, then a token. */
export async function useCredentials(app: AppContext, pm: PluginManager, companion: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  const appId = String(body.appId ?? '').trim().toLowerCase();
  const tenantId = String(body.tenantId ?? '').trim();
  const secret = String(body.appPassword ?? '').trim();
  const secretSaved = Boolean(pm.settingsView(TE, companion).settings.find((s) => s.key === 'appPassword')?.set);
  const shape = credentialShape(appId, tenantId, secret, secretSaved);
  if (shape) return { ok: false, diagnosis: { code: shape } };
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  if (!app.hooks) throw new HttpError(400, 'Webhooks are not available here.');
  // The App ID is the audience Sara checks on every call from Microsoft (kept as the hook's sender secret).
  app.hooks.ensureBridgeHook(TE, companion, appId, 'botframework');
  await pm.putSettings(TE, companion, { appId, tenantId, ...(secret ? { appPassword: secret } : {}) });
  await running(pm, companion);
  const r = await pm.bridgeCheck(TE, companion, { step: 'auth' }, 20_000);
  const code = String((r.diagnosis as { code?: unknown } | undefined)?.code ?? '');
  // A secret Microsoft refused isn't kept.
  if (!r.ok && (code === 'SECRET_WRONG' || code === 'SECRET_EXPIRED')) await pm.putSettings(TE, companion, { appPassword: '' });
  const out = r.ok ? { ok: true } : { ok: false, diagnosis: r.diagnosis ?? { code: 'UNKNOWN' } };
  remember(pm, companion, 'credentials', out, now);
  return out;
}

export async function runCheck(app: AppContext, pm: PluginManager, companion: string, step: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  if (step === 'credentials') {
    const r = await pm.bridgeCheck(TE, companion, { step: 'auth' });
    const out = r.ok ? { ok: true } : { ok: false, diagnosis: r.diagnosis ?? { code: 'UNKNOWN' } };
    remember(pm, companion, 'credentials', out, now);
    return out;
  }
  const hook = app.hooks?.bridgeHookFor(TE, companion);
  const hs = hook ? app.hooks!.bridgeState(hook.id) : undefined;
  if (step === 'endpoint') {
    if (!hookBase(pm, companion)) return { ok: false, diagnosis: { code: 'NO_DOOR' } };
    if (hs?.lastAccepted) return { ok: true, at: hs.lastAccepted };
    return { ok: false, diagnosis: { code: hs && hs.badSignatures >= 3 ? 'BAD_SIGNATURE' : 'NOT_CALLED' } };
  }
  if (step === 'test') {
    const r = await pm.testBridge(TE, companion);
    const linked = Boolean(pm.settingsView(TE, companion).bridge?.ownerChats?.length);
    const lines = [
      ...r.steps,
      { label: 'Teams has a public https address for Sara', ok: Boolean(hookBase(pm, companion)), ...(hookBase(pm, companion) ? {} : { fix: 'Step 3: give Teams a way in.' }) },
      { label: 'Microsoft has called Sara with a signed message', ok: Boolean(hs?.lastAccepted), ...(hs?.lastAccepted ? {} : { fix: 'Step 4: paste the messaging endpoint and add the Teams channel.' }) },
      { label: 'Your Teams account is linked', ok: linked, ...(linked ? {} : { fix: 'Step 6: Link my Teams, then send the code to her in Teams.' }) },
    ];
    const ok = lines.every((l) => l.ok);
    remember(pm, companion, 'test', { ok }, now);
    return { ok, steps: lines };
  }
  throw new HttpError(400, 'No such step.');
}

export async function runFix(app: AppContext, pm: PluginManager, companion: string, fix: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (fix === 'link') return { ok: true, ...pm.linkCode(TE, companion) };
  if (fix === 'logout') {
    await pm.bridgeCheck(TE, companion, { step: 'logout' }).catch(() => undefined);
    await pm.putSettings(TE, companion, { appPassword: '' });
    remember(pm, companion, 'credentials', undefined, now);
    remember(pm, companion, 'test', undefined, now);
    return { ok: true };
  }
  throw new HttpError(400, 'No such fix.');
}

/** `door-url`: "no public address" → his tunnel's https origin (empty = forget it). */
export function useDoorUrl(pm: PluginManager, companion: string, raw: unknown): Record<string, unknown> {
  const s = String(raw ?? '').trim();
  if (!s) {
    pm.store.kvSet(TE, companion, '__door', undefined);
    return { ok: true, hookUrl: hookBase(pm, companion) };
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, 'Paste the whole address, starting with https://');
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new HttpError(400, 'Teams only calls https addresses.');
  pm.store.kvSet(TE, companion, '__door', u.origin);
  return { ok: true, hookUrl: u.origin };
}

/** The Teams app package for this bot (the download is remembered: step 5). */
export function appPackage(app: AppContext, pm: PluginManager, companion: string): Buffer {
  const appId = String(pm.settingsView(TE, companion).settings.find((s) => s.key === 'appId')?.value ?? '');
  if (!appId) throw new HttpError(400, 'Paste the App ID first (step 2).');
  const name = app.persona.name || 'Sara';
  const zip = teamsPackage({
    botId: appId,
    companion,
    name,
    words: {
      short: `${name}, your companion from Sara`,
      full: `${name} is the companion you run yourself with Sara. Chat with her here; in channels, mention her.`,
      help: 'What she can do here',
      newChat: 'Start a new conversation',
      stop: 'Stop what she is doing',
    },
  });
  pm.store.kvSet(TE, companion, '__package', (app.now?.() ?? new Date()).toISOString());
  return zip;
}

// EC1 (docs/ops/EC1_DESIGN.md): the Slack setup card's server side, the Matrix pattern. Owner only:
// these live under the `plugins` route family, which is not a member family (src/household.ts).
//   GET  /api/plugins/slack/setup?companion=   the stepper state (each step checked, never "I did it"), her channels
//   POST /api/plugins/slack/tokens             { companion, botToken, appToken } shapes first (no call), then the
//                                              vault, then auth.test and apps.connections.open through the plugin
//   POST /api/plugins/slack/check              { companion, step: tokens | test } → { ok, diagnosis? }
//   POST /api/plugins/slack/fix                { companion, fix: link | logout }
// Channels are switched on with the shared POST /api/plugins/slack/group { companion, chat, on }.
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import type { PluginManager } from './manager.ts';

export const SL = 'slack';
export const SL_STEPS = ['app', 'tokens', 'link', 'test'] as const;
const BOT = /^xoxb-[A-Za-z0-9-]{10,250}$/;
const APP = /^xapp-[A-Za-z0-9-]{10,250}$/;

interface Cached {
  ok: boolean;
  at: string;
  diagnosis?: Record<string, unknown>;
  [k: string]: unknown;
}
const kvKey = (step: string) => `__check:${step}`;
function cached(pm: PluginManager, companion: string, step: string): Cached | undefined {
  const raw = pm.store.get(SL) ? pm.store.kvGet(SL, companion, kvKey(step)) : undefined;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return undefined;
  }
}
function remember(pm: PluginManager, companion: string, step: string, r: Record<string, unknown> | undefined, now: Date): void {
  if (!pm.store.get(SL)) return;
  if (!r) return void pm.store.kvSet(SL, companion, kvKey(step), undefined);
  pm.store.kvSet(SL, companion, kvKey(step), JSON.stringify({ ...r, ok: r.ok === true, at: now.toISOString() }));
}

/** Waits (≤ 10 s) for the plugin to be running again after its settings changed. */
async function running(pm: PluginManager, companion: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pm.processOf(SL, companion)?.state === 'ready') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** The token boxes before anything is sent anywhere: a code for each wrong shape (and swapped boxes). */
export function tokenShape(botToken: string, appToken: string): string | undefined {
  if (APP.test(botToken) && BOT.test(appToken)) return 'TOKENS_SWAPPED';
  if (!BOT.test(botToken)) return 'BOT_TOKEN_SHAPE';
  if (!APP.test(appToken)) return 'APP_TOKEN_SHAPE';
  return undefined;
}

/** The stepper state: each step ✓ only when Sara checked it; plus her channels from the plugin. */
export async function setupState(app: AppContext, pm: PluginManager, companion: string): Promise<Record<string, unknown>> {
  const row = pm.store.get(SL);
  const on = Boolean(row && pm.enabledFor(SL, companion));
  const isRunning = on && pm.processOf(SL, companion)?.state === 'ready';
  const settings = row ? pm.settingsView(SL, companion) : undefined;
  const bridge = settings?.bridge;
  const set = (k: string) => Boolean(settings?.settings.find((s) => s.key === k)?.set);
  const live = isRunning ? await pm.bridgeCheck(SL, companion, { step: 'status' }, 3_000).catch(() => undefined) : undefined;
  const tokens = cached(pm, companion, 'tokens');
  const gone = typeof live?.ended === 'string' && live.ended ? live.ended : '';
  const tokensOk = Boolean(tokens?.ok && set('botToken') && set('appToken') && !gone);
  const linked = Boolean(bridge?.ownerChats?.length);
  const t = cached(pm, companion, 'test');
  const steps: { id: string; ok: boolean; checkedAt?: string; diagnosis?: Record<string, unknown> }[] = [
    { id: 'app', ok: tokensOk },
    { id: 'tokens', ok: tokensOk, ...(tokens ? { checkedAt: tokens.at } : {}), ...(gone ? { diagnosis: { code: gone } } : tokens?.diagnosis ? { diagnosis: tokens.diagnosis } : {}) },
    { id: 'link', ok: linked },
    { id: 'test', ok: Boolean(t?.ok), ...(t ? { checkedAt: t.at, ...(t.diagnosis ? { diagnosis: t.diagnosis } : {}) } : {}) },
  ];
  const view = row ? pm.bridgeView(SL, companion) : undefined;
  const list = isRunning && tokensOk ? await pm.bridgeCheck(SL, companion, { step: 'channels' }, 5_000).catch(() => undefined) : undefined;
  const onSet = new Set((bridge?.groups ?? []).filter((g) => g.on).map((g) => g.key));
  const channels = (Array.isArray(list?.channels) ? list!.channels : []) as { id: string; name: string; private: boolean }[];
  return {
    installed: Boolean(row),
    on,
    running: isRunning,
    state: privateLocalOn() && row ? 'paused' : (view?.state ?? 'off'),
    detail: view?.detail ?? '',
    steps,
    done: steps.filter((s) => s.ok).length,
    team: String(live?.team || tokens?.team || ''),
    teamUrl: String(live?.teamUrl || tokens?.teamUrl || ''),
    connected: live?.connected === true,
    botTokenSet: set('botToken'),
    appTokenSet: set('appToken'),
    channels: channels.map((c) => ({ ...c, on: onSet.has(c.id) })),
    linked: bridge?.ownerChats ?? [],
    others: bridge?.others === true,
    workInGroups: bridge?.workInGroups === true,
    today: view?.today ?? null,
    herName: app.persona.name,
  };
}

/** Step 2: both tokens. Shapes first (nothing is sent), then the vault, then Slack checks them through the plugin. */
export async function useTokens(app: AppContext, pm: PluginManager, companion: string, botRaw: unknown, appRaw: unknown): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  const botToken = String(botRaw ?? '').trim();
  const appToken = String(appRaw ?? '').trim();
  const shape = tokenShape(botToken, appToken);
  if (shape) return { ok: false, diagnosis: { code: shape } };
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  await pm.putSettings(SL, companion, { botToken, appToken });
  await running(pm, companion);
  const r = await pm.bridgeCheck(SL, companion, { step: 'auth' }, 20_000);
  // A token Slack refused isn't kept (the bot token on auth.test, the app-level one on Socket Mode).
  const code = String((r.diagnosis as { code?: unknown } | undefined)?.code ?? '');
  if (!r.ok && (code === 'TOKEN_WRONG' || code === 'TOKEN_GONE')) await pm.putSettings(SL, companion, r.which === 'app' ? { appToken: '' } : { botToken: '' });
  if (!r.ok && r.which === 'app' && code !== 'TOKEN_WRONG' && code !== 'TOKEN_GONE' && code !== 'CANT_REACH' && code !== 'PRIVATE_LOCAL' && code !== 'RATE_LIMITED') (r.diagnosis as Record<string, unknown>).code = 'SOCKET_OFF';
  const out = r.ok ? { ok: true, team: r.team ?? '', teamUrl: r.teamUrl ?? '', userId: r.userId ?? '' } : { ok: false, diagnosis: r.diagnosis ?? { code: 'UNKNOWN' } };
  remember(pm, companion, 'tokens', out, now);
  return out;
}

export async function runCheck(app: AppContext, pm: PluginManager, companion: string, step: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  if (step === 'tokens') {
    const r = await pm.bridgeCheck(SL, companion, { step: 'auth' });
    const out = r.ok ? { ok: true, team: r.team ?? '', teamUrl: r.teamUrl ?? '' } : { ok: false, diagnosis: r.diagnosis ?? { code: 'UNKNOWN' } };
    remember(pm, companion, 'tokens', out, now);
    return out;
  }
  if (step === 'test') {
    const r = await pm.testBridge(SL, companion);
    const linked = Boolean(pm.settingsView(SL, companion).bridge?.ownerChats?.length);
    const lines = [...r.steps, { label: 'Your Slack account is linked', ok: linked, ...(linked ? {} : { fix: 'Step 3: Link my Slack, then send the code to her in Slack.' }) }];
    const ok = lines.every((l) => l.ok);
    remember(pm, companion, 'test', { ok }, now);
    return { ok, steps: lines };
  }
  throw new HttpError(400, 'No such step.');
}

/** The one-tap actions: a link code (step 3), or disconnect (her bot token revoked at Slack, both tokens removed). */
export async function runFix(app: AppContext, pm: PluginManager, companion: string, fix: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (fix === 'link') return { ok: true, ...pm.linkCode(SL, companion) };
  if (fix === 'logout') {
    const r = await pm.bridgeCheck(SL, companion, { step: 'logout' });
    await pm.putSettings(SL, companion, { botToken: '', appToken: '' });
    remember(pm, companion, 'tokens', undefined, now);
    remember(pm, companion, 'test', undefined, now);
    return { ok: r.ok === true };
  }
  throw new HttpError(400, 'No such fix.');
}

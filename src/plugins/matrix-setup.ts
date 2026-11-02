// Phase 122 part 2 (docs/design/BRIDGES4.md §6.2, §7.3–§7.5, §8.2): the Matrix setup card's server
// side. Owner only: these live under the `plugins` route family, which is not a member family
// (src/household.ts), so no new route family exists.
//   GET  /api/plugins/matrix/setup?companion=   the stepper state (each step checked, never "I did it"), her rooms
//   POST /api/plugins/matrix/terms              { companion } the terms box was ticked (with the date)
//   POST /api/plugins/matrix/login              { companion, mxid, password } (the password is sent once to her
//                                               server through the plugin and forgotten: never stored or logged)
//   POST /api/plugins/matrix/token              { companion, mxid, token } *Paste an access token* (Advanced)
//   POST /api/plugins/matrix/check              { companion, step: login | room | test } → { ok, diagnosis? }
//   POST /api/plugins/matrix/fix                { companion, fix: logout | expect | join | leave, room? }
import type { AppContext } from '../chat.ts';
import { HttpError } from '../http.ts';
import { privateLocalOn } from '../net-guard.ts';
import type { PluginManager } from './manager.ts';

export const MX = 'matrix';
/** The terms box's version (§9.6): a changed box asks again. */
export const MX_TERMS_DATE = '2026-11-02';
export const MX_STEPS = ['account', 'login', 'room', 'hello', 'test'] as const;
/** NOT_INVITED: no invite this long after he reached step 3 (§7.4). */
export const INVITE_WAIT_MS = 2 * 60_000;
const MXID = /^@[a-z0-9._=\-/+]{1,255}:[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/i;

interface Cached {
  ok: boolean;
  at: string;
  diagnosis?: Record<string, unknown>;
  [k: string]: unknown;
}
const kvKey = (step: string) => `__check:${step}`;
function cached(pm: PluginManager, companion: string, step: string): Cached | undefined {
  const raw = pm.store.get(MX) ? pm.store.kvGet(MX, companion, kvKey(step)) : undefined;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Cached;
  } catch {
    return undefined;
  }
}
function remember(pm: PluginManager, companion: string, step: string, r: Record<string, unknown> | undefined, now: Date): void {
  if (!pm.store.get(MX)) return;
  if (!r) return void pm.store.kvSet(MX, companion, kvKey(step), undefined);
  const { token: _t, password: _p, ...rest } = r;
  pm.store.kvSet(MX, companion, kvKey(step), JSON.stringify({ ...rest, ok: r.ok === true, at: now.toISOString() }));
}

/** Waits (≤ 10 s) for the plugin to be running again after its settings changed. */
async function running(pm: PluginManager, companion: string, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pm.processOf(MX, companion)?.state === 'ready') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** `@local:server` → `server` (the first guess at her homeserver). */
export const serverOf = (mxid: string): string => (MXID.test(mxid) ? mxid.slice(mxid.indexOf(':') + 1).toLowerCase() : '');

interface RoomView {
  id: string;
  name: string;
  encrypted: boolean;
  members: number;
  place: string;
}

/** The stepper state (§7.3): each step ✓ only when Sara checked it; plus her rooms from the plugin. */
export async function setupState(app: AppContext, pm: PluginManager, companion: string): Promise<Record<string, unknown>> {
  const row = pm.store.get(MX);
  const now = app.now?.() ?? new Date();
  const on = Boolean(row && pm.enabledFor(MX, companion));
  const isRunning = on && pm.processOf(MX, companion)?.state === 'ready';
  const settings = row ? pm.settingsView(MX, companion) : undefined;
  const value = (k: string) => settings?.settings.find((s) => s.key === k);
  const bridge = settings?.bridge;
  const linked = Boolean(bridge?.ownerChats?.length);
  const live = isRunning ? await pm.bridgeCheck(MX, companion, { step: 'rooms' }, 3_000).catch(() => undefined) : undefined;
  const rooms = (Array.isArray(live?.rooms) ? live!.rooms : []) as RoomView[];
  const login = cached(pm, companion, 'login');
  const tokenSet = Boolean(value('token')?.set);
  const tokenGone = live?.tokenGone === true;
  const diag = (code: string, params?: Record<string, unknown>) => ({ code, ...(params ? { params } : {}) });
  const steps: { id: string; ok: boolean; checkedAt?: string; diagnosis?: Record<string, unknown> }[] = [];
  const loginOk = Boolean(login?.ok && tokenSet && !tokenGone);
  steps.push({ id: 'account', ok: loginOk });
  steps.push({ id: 'login', ok: loginOk, ...(login ? { checkedAt: login.at } : {}), ...(tokenGone ? { diagnosis: diag('TOKEN_GONE') } : login?.diagnosis ? { diagnosis: login.diagnosis } : {}) });
  const plain = rooms.filter((r) => !r.encrypted);
  const waitSince = row ? pm.store.kvGet(MX, companion, '__inviteWait') : undefined;
  const roomDiag = !plain.length && rooms.some((r) => r.encrypted) ? diag('ENCRYPTED_ROOM') : !plain.length && waitSince && now.getTime() - Date.parse(waitSince) > INVITE_WAIT_MS ? diag('NOT_INVITED', { mxid: String(value('mxid')?.value ?? '') }) : undefined;
  steps.push({ id: 'room', ok: plain.length > 0, ...(roomDiag ? { diagnosis: roomDiag } : {}) });
  steps.push({ id: 'hello', ok: linked });
  const t = cached(pm, companion, 'test');
  steps.push({ id: 'test', ok: Boolean(t?.ok), ...(t ? { checkedAt: t.at, ...(t.diagnosis ? { diagnosis: t.diagnosis } : {}) } : {}) });
  const view = row ? pm.bridgeView(MX, companion) : undefined;
  const terms = row ? pm.store.kvGet(MX, companion, '__terms') : undefined;
  const owner = new Set((bridge?.ownerChats ?? []).map((x) => x.toLowerCase()));
  return {
    installed: Boolean(row),
    on,
    running: isRunning,
    state: privateLocalOn() && row ? 'paused' : (view?.state ?? 'off'),
    detail: view?.detail ?? '',
    steps,
    done: steps.filter((s) => s.ok).length,
    mxid: String(value('mxid')?.value ?? ''),
    homeserver: String(value('homeserver')?.value ?? ''),
    me: String(live?.me ?? login?.userId ?? ''),
    device: String(login?.deviceId ?? ''),
    tokenSet,
    rooms: rooms.map((r) => ({ ...r, place: r.encrypted ? 'encrypted' : owner.has(r.id.toLowerCase()) ? 'owner-dm' : r.place })),
    syncing: live?.syncing === true,
    mediaMax: Number(live?.mediaMax ?? 0),
    linked: bridge?.ownerChats ?? [],
    others: bridge?.others === true,
    allow: bridge?.allow ?? [],
    today: view?.today ?? null,
    terms: terms ? { at: terms, for: MX_TERMS_DATE } : null,
    termsDate: MX_TERMS_DATE,
  };
}

/** *Log her in* (§6.2): her server from her Matrix ID, the password flow, the token into the vault. */
export async function login(app: AppContext, pm: PluginManager, companion: string, mxidRaw: unknown, password: unknown): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  const mxid = String(mxidRaw ?? '').trim();
  const pass = typeof password === 'string' ? password : '';
  if (!MXID.test(mxid)) throw new HttpError(400, 'Her Matrix ID looks like @sara-frank:matrix.org.');
  if (!pass || pass.length > 1024) throw new HttpError(400, 'Type her password (it is used once and not kept).');
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  const cur = pm.settingsView(MX, companion).settings;
  const curMxid = String(cur.find((s) => s.key === 'mxid')?.value ?? '');
  const curHs = String(cur.find((s) => s.key === 'homeserver')?.value ?? '');
  // A new Matrix ID starts from its own server; the same one keeps the homeserver he confirmed.
  if (curMxid.toLowerCase() !== mxid.toLowerCase() || !curHs) {
    await pm.putSettings(MX, companion, { mxid, homeserver: serverOf(mxid), token: '' });
    await running(pm, companion);
    const d = await pm.bridgeCheck(MX, companion, { step: 'discover', mxid });
    if (!d.ok) {
      remember(pm, companion, 'login', d, now);
      return d;
    }
    if (d.moved && typeof d.homeserver === 'string') {
      await pm.putSettings(MX, companion, { homeserver: d.homeserver });
      await running(pm, companion);
    }
  }
  const r = await pm.bridgeCheck(MX, companion, { step: 'login', mxid, password: pass }, 20_000, { secret: 'token' });
  if (!r.ok || typeof r.token !== 'string' || !r.token) {
    remember(pm, companion, 'login', r.ok ? { ok: false, diagnosis: { code: 'UNKNOWN' } } : r, now);
    return r.ok ? { ok: false, diagnosis: { code: 'UNKNOWN' } } : r;
  }
  return useToken(app, pm, companion, mxid, r.token, { deviceId: r.deviceId });
}

/** The token into the vault (`plugin:matrix:token`), then whoami proves it (§7.3 step 2). */
export async function useToken(app: AppContext, pm: PluginManager, companion: string, mxid: string, token: string, more: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  const values: Record<string, unknown> = { token };
  const cur = pm.settingsView(MX, companion).settings;
  if (MXID.test(mxid) && String(cur.find((s) => s.key === 'mxid')?.value ?? '').toLowerCase() !== mxid.toLowerCase()) Object.assign(values, { mxid, homeserver: serverOf(mxid) });
  await pm.putSettings(MX, companion, values);
  await running(pm, companion);
  const w = await pm.bridgeCheck(MX, companion, { step: 'whoami' });
  const ok = w.ok === true && (!MXID.test(mxid) || String(w.userId ?? '').toLowerCase() === mxid.toLowerCase());
  const out = ok ? { ok: true, userId: w.userId, deviceId: w.deviceId ?? more.deviceId ?? '' } : w.ok ? { ok: false, diagnosis: { code: 'LOGIN_WRONG' } } : w;
  // A token that doesn't work (or belongs to someone else) isn't kept.
  if (!ok) await pm.putSettings(MX, companion, { token: '' });
  remember(pm, companion, 'login', out, now);
  return out;
}

export async function runCheck(app: AppContext, pm: PluginManager, companion: string, step: string): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (privateLocalOn()) return { ok: false, diagnosis: { code: 'PRIVATE_LOCAL' } };
  if (step === 'login') {
    const r = await pm.bridgeCheck(MX, companion, { step: 'whoami' });
    remember(pm, companion, 'login', r, now);
    return r;
  }
  if (step === 'room') {
    const r = await pm.bridgeCheck(MX, companion, { step: 'rooms' });
    const rooms = (Array.isArray(r.rooms) ? r.rooms : []) as RoomView[];
    if (rooms.some((x) => !x.encrypted)) return { ok: true, rooms };
    return { ok: false, rooms, diagnosis: { code: rooms.length ? 'ENCRYPTED_ROOM' : 'NOT_INVITED' } };
  }
  if (step === 'test') {
    const r = await pm.testBridge(MX, companion);
    const linked = Boolean(pm.settingsView(MX, companion).bridge?.ownerChats?.length);
    const lines = [...r.steps, { label: 'Your room is linked', ok: linked, ...(linked ? {} : { fix: 'Step 4: Link my Matrix, then send the code in your room.' }) }];
    const ok = lines.every((l) => l.ok);
    remember(pm, companion, 'test', { ok }, now);
    return { ok, steps: lines };
  }
  throw new HttpError(400, 'No such step.');
}

/** The one-tap actions (§8.2): log her out, wait for his invite (a link code), join or leave a room. */
export async function runFix(app: AppContext, pm: PluginManager, companion: string, fix: string, room: unknown): Promise<Record<string, unknown>> {
  const now = app.now?.() ?? new Date();
  if (fix === 'logout') {
    // A real revoke at her server (POST /logout), then the vault entries go.
    const r = await pm.bridgeCheck(MX, companion, { step: 'logout' });
    await pm.putSettings(MX, companion, { token: '' });
    app.vault.delete('plugin:matrix:refresh');
    remember(pm, companion, 'login', undefined, now);
    remember(pm, companion, 'test', undefined, now);
    return { ok: r.ok === true };
  }
  if (fix === 'expect') {
    // Step 3: she joins the invite that comes while this code waits (nobody is linked yet).
    pm.store.kvSet(MX, companion, '__inviteWait', now.toISOString());
    return { ok: true, ...pm.linkCode(MX, companion) };
  }
  if (fix === 'join' || fix === 'leave') {
    const id = String(room ?? '').replace(/^!/, '');
    if (!/^[\w.:=+/-]{1,200}$/.test(id)) throw new HttpError(400, 'No such room.');
    if (fix === 'leave') pm.setGroup(MX, companion, id, false);
    return pm.bridgeCheck(MX, companion, { step: fix, room: id });
  }
  throw new HttpError(400, 'No such fix.');
}

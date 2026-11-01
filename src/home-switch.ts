// 2.7.1 (owner decision): real on/off switches on Today's Home tile. Pressing one is the owner acting
// himself, so no approval card: POST /api/home/entities/<id>/toggle (src/routes/connections.ts),
// owner only (members have no Home Assistant routes, src/household.ts → MEMBER_ROUTES), never on
// the demo. Only harmless kinds switch here: lights, switches, fans, helper on/off switches, and
// blinds/curtains/shades/shutters/awnings. Locks, alarms, garage doors, gates, doors and anything
// named like them keep "Ask Sara", so her approval rule for smart-home actions still applies to them.
// The state is read before (to know what "toggle" means) and after (the tile shows what really
// happened), with the same Home Assistant REST calls as her home tools (src/tools/home.ts).
import { netFetch } from './net-guard.ts';
import type { HaState } from './tools/home.ts';

export const ENTITY_ID = /^[a-z_]{1,40}\.[a-z0-9_]{1,120}$/;
/** Kinds the tile may switch directly. */
export const SWITCH_DOMAINS: readonly string[] = ['light', 'switch', 'fan', 'input_boolean', 'cover'];
/** Covers that are only about light and shade (never a garage door, gate, door or window). */
export const SAFE_COVERS: readonly string[] = ['awning', 'blind', 'curtain', 'shade', 'shutter'];
/** Words that make a device sensitive whatever its kind (a "switch" that opens the garage). */
const SENSITIVE = /(^|[^a-z])(garage|gates?|doors?|locks?|unlock|alarms?|siren|security|safe|vault)([^a-z]|$)/i;

/** `ask`: not switchable here (Ask Sara); `unreachable`: Home Assistant can't reach the device. */
export type SwitchPlan = { ok: true; domain: string; service: string; to: 'on' | 'off' | 'open' | 'closed' } | { ok: false; why: 'ask' | 'unreachable' };

/**
 * Phase 111 (TD1, §4.10): a scene may run from Today only when the owner picked it there (a scene can
 * unlock or open, so they are opt-in one by one) and it isn't named like a lock, door or alarm.
 */
export function sceneAllowed(id: string, name: string, picked: readonly string[]): boolean {
  return id.startsWith('scene.') && ENTITY_ID.test(id) && picked.includes(id) && !SENSITIVE.test(name) && !SENSITIVE.test(id.replace(/_/g, ' '));
}

/**
 * What pressing the switch does for this entity in this state, or why it can't be done here.
 * `want` is the state the switch was moved to (on/off); without it, the opposite of now.
 */
export function switchPlan(s: HaState, want?: 'on' | 'off'): SwitchPlan {
  const id = String(s?.entity_id ?? '');
  const domain = id.split('.')[0];
  const name = typeof s?.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : '';
  const askSara = { ok: false as const, why: 'ask' as const };
  if (!ENTITY_ID.test(id) || !SWITCH_DOMAINS.includes(domain)) return askSara;
  if (SENSITIVE.test(id.replace(/_/g, ' ')) || SENSITIVE.test(name)) return askSara;
  const state = String(s.state ?? '');
  if (state === 'unavailable' || state === 'unknown' || state === '') return { ok: false, why: 'unreachable' };
  if (domain === 'cover') {
    const kind = typeof s.attributes?.device_class === 'string' ? s.attributes.device_class : '';
    if (!SAFE_COVERS.includes(kind)) return askSara;
    const isOpen = state === 'open' || state === 'opening';
    const open = want ? want === 'on' : !isOpen;
    return { ok: true, domain, service: open ? 'open_cover' : 'close_cover', to: open ? 'open' : 'closed' };
  }
  const on = want ? want === 'on' : state !== 'on';
  return { ok: true, domain, service: on ? 'turn_on' : 'turn_off', to: on ? 'on' : 'off' };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One Home Assistant REST call with the owner's token. Errors carry a status for the route. */
export async function haCall<T>(base: string, token: string, path: string, init: { method?: string; body?: unknown } = {}, fetchImpl: FetchLike = netFetch): Promise<{ status: number; data?: T }> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(12_000),
      redirect: 'error',
    });
  } catch {
    return { status: 0 };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { status: res.status };
  try {
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  } catch {
    return { status: res.status };
  }
}

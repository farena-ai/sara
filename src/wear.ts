// D2 (docs/WEAR.md): Sara on a Wear OS watch. A tile shows today (her reminders for the rest of the
// day), how many things wait on you and a Talk button. Approvals stay on the phone: the watch only
// says how many there are.
//
// Pairing without typing a token on a watch: the watch asks for a short code (no sign-in), the person
// types it in Sara (Settings → Connections → Phone and notifications → Wear OS watch) and the watch
// picks up a watch-kind Shortcuts token (scope 'ask') once. The pending codes live in this process
// only (a restart drops them), so the cookie-less watch and the signed-in page (any household space)
// meet here.
import { randomBytes } from 'node:crypto';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { localDate } from './memory-worker.ts';

/** How long a pairing code works. */
export const WEAR_PAIR_MS = 10 * 60_000;
/** Open codes per address, and in all. */
const PER_IP = 5;
const MAX_OPEN = 50;
// No 0/O, 1/I/L: easy to read off a small round screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const WEAR_LINES = {
  waiting: en('{n} waiting on you. Answer on your phone.'),
  nothing: en('Nothing else today.'),
  badCode: en('That code is not right or has run out. Get a new one on the watch.'),
  tooMany: en('Too many watch codes from here. Wait a few minutes.'),
  label: en('Wear OS watch'),
};

type Pending = { code: string; poll: string; ip: string; expires: number; ready?: { token: string; name: string } };

/** "abc def" / "ABCDEF" / "abc-def" → "ABC-DEF" (anything else stays as typed, and fails). */
export function normalizeCode(raw: string): string {
  const c = String(raw ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

export class WearPairing {
  readonly #open = new Map<string, Pending>(); // by poll secret
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [k, p] of this.#open) if (p.expires <= now) this.#open.delete(k);
  }

  /** A new code for a watch (undefined when this address or the server has too many open). */
  start(ip: string): { code: string; poll: string; expiresIn: number } | undefined {
    this.#sweep();
    const open = [...this.#open.values()];
    if (open.length >= MAX_OPEN || open.filter((p) => p.ip === ip).length >= PER_IP) return undefined;
    let code = '';
    do {
      const b = randomBytes(6);
      code = normalizeCode([...b].map((x) => ALPHABET[x % ALPHABET.length]).join(''));
    } while (open.some((p) => p.code === code));
    const poll = randomBytes(24).toString('base64url');
    this.#open.set(poll, { code, poll, ip, expires: this.#now() + WEAR_PAIR_MS });
    return { code, poll, expiresIn: Math.round(WEAR_PAIR_MS / 1000) };
  }

  /** The signed-in person typed this code: make the token (only now) and park it for the watch. */
  claim(raw: string, make: () => { token: string; name: string }): boolean {
    this.#sweep();
    const code = normalizeCode(raw);
    const p = [...this.#open.values()].find((x) => x.code === code && !x.ready);
    if (!p) return false;
    p.ready = make();
    return true;
  }

  /** The watch asks: still waiting, its token (once), or gone (wrong, used or run out). */
  take(poll: string): { state: 'pending' } | { state: 'ready'; token: string; name: string } | { state: 'gone' } {
    this.#sweep();
    const p = this.#open.get(String(poll ?? ''));
    if (!p) return { state: 'gone' };
    if (!p.ready) return { state: 'pending' };
    this.#open.delete(p.poll);
    return { state: 'ready', ...p.ready };
  }
}

/** One per process: the watch's cookie-less requests land in the owner space, the claim in any space. */
export const wearPairing = new WearPairing();

export interface WearGlance {
  name: string;
  /** The rest of today's timed reminders, soonest first (at most three). */
  today: { time: string; text: string }[];
  more: number;
  waiting: number;
  lines: { waiting: string; nothing: string };
  at: string;
}

/** What the tile shows. `waiting` = approvals in running turns + inbox cards + errands (waitingCount). */
export function wearGlance(app: Pick<AppContext, 'planner' | 'settings' | 'persona' | 'now'>, waiting: number): WearGlance {
  const s = app.settings.get();
  const now = app.now();
  const iso = now.toISOString();
  const day = localDate(iso, s.timeZone);
  const rest = (app.planner?.reminders({ status: 'pending', kind: 'timed', limit: 200 }) ?? [])
    .filter((r) => !r.placeId && r.dueAt >= iso && localDate(r.dueAt, s.timeZone) === day)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const lang = s.language && s.language !== 'auto' ? s.language : 'en-US';
  const time = (at: string): string => {
    try {
      return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit', ...(s.timeZone ? { timeZone: s.timeZone } : {}) }).format(new Date(at));
    } catch {
      return at.slice(11, 16);
    }
  };
  return {
    name: app.persona.name,
    today: rest.slice(0, 3).map((r) => ({ time: time(r.dueAt), text: r.text.replace(/\s+/g, ' ').slice(0, 80) })),
    more: Math.max(0, rest.length - 3),
    waiting,
    lines: { waiting: trOwner(WEAR_LINES.waiting, s, { n: waiting }), nothing: trOwner(WEAR_LINES.nothing, s) },
    at: iso,
  };
}

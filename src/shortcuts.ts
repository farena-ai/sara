// R4 (docs/IPHONE.md): Sara on an iPhone without the App Store. Apple Shortcuts "Share to Sara"
// (the share sheet), "Ask Sara" (Siri) and a widget line, through a per-device token
// (OwnerAuth.createShortcutToken: `sara_sc.<id>.<secret>`, shown once, hash only, scoped, revocable).
// This file holds the parts without a server: the rate limits, the short answer, the widget's lines,
// the badge count and the owner's iCloud links for the ready-made shortcuts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { FOR_SPEAKER, spokenText } from './spoken.ts';

export type ShortcutRoute = 'share' | 'ask' | 'widget';

/** Per token: a burst per minute and a total per hour (a Shortcut on a loop can't run up a bill). */
export const SHORTCUT_LIMITS: Readonly<Record<ShortcutRoute, { perMinute: number; perHour: number }>> = {
  share: { perMinute: 10, perHour: 60 },
  ask: { perMinute: 6, perHour: 60 },
  widget: { perMinute: 20, perHour: 240 },
};

/** Sliding-window counts per token and route, in memory (a restart starts them again). */
export class ShortcutLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limits: Readonly<Record<ShortcutRoute, { perMinute: number; perHour: number }>>;
  constructor(limits = SHORTCUT_LIMITS) {
    this.#limits = limits;
  }
  /** True (and counted) when this token may use this route now. */
  take(tokenId: string, route: ShortcutRoute, now = Date.now()): boolean {
    const key = `${tokenId}:${route}`;
    const list = (this.#hits.get(key) ?? []).filter((t) => now - t < 3600_000);
    const lim = this.#limits[route];
    if (list.length >= lim.perHour || list.filter((t) => now - t < 60_000).length >= lim.perMinute) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(now);
    this.#hits.set(key, list);
    if (this.#hits.size > 2000) for (const [k, v] of this.#hits) if (!v.some((t) => now - t < 3600_000)) this.#hits.delete(k);
    return true;
  }
}

/** Her reply as at most two short sentences of plain words (Siri reads it aloud). */
export function shortAnswer(text: string, maxSentences = 2, maxChars = 320): string {
  const plain = spokenText(text, { ...FOR_SPEAKER, max: 2_000, restNote: '' }).replace(/\s+/g, ' ').trim();
  const sentences = plain.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  let out = sentences.slice(0, maxSentences).join(' ');
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    out = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), maxChars - 40)).trim()}…`;
  }
  return out || plain.slice(0, maxChars);
}

/** Approvals waiting in her running turns plus inbox cards waiting for a yes: the app badge's number. */
export function waitingCount(active: ReadonlyMap<string, { approvals: ReadonlyMap<string, unknown> }>, app: Pick<AppContext, 'inbox'>): number {
  let n = 0;
  for (const t of active.values()) n += t.approvals.size;
  try {
    n += app.inbox?.list({ status: 'pending', limit: 500 }).length ?? 0;
  } catch {
    /* no inbox here */
  }
  return n;
}

const LINES = {
  next: en('Next: {text}, {when}'),
  nothing: en('Nothing coming up.'),
  watches: en('Watches on: {n}'),
  waiting: en('Waiting for you in Sara: {n}'),
} as const;

/** The widget's plain lines (a Shortcuts widget or "Show Result" shows them as they are). */
export function widgetLines(app: AppContext, extras: { next?: { text: string; at: string }; watches: number }, waiting: number): string[] {
  const s = app.settings.get();
  const out: string[] = [];
  if (extras.next) {
    let when = extras.next.at;
    try {
      when = new Intl.DateTimeFormat(s.language && s.language !== 'auto' ? s.language : 'en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', ...(s.timeZone ? { timeZone: s.timeZone } : {}) }).format(new Date(extras.next.at));
    } catch {
      /* keep the ISO time */
    }
    out.push(trOwner(LINES.next, s, { text: extras.next.text, when }));
  } else out.push(trOwner(LINES.nothing, s));
  if (extras.watches) out.push(trOwner(LINES.watches, s, { n: extras.watches }));
  if (waiting) out.push(trOwner(LINES.waiting, s, { n: waiting }));
  return out;
}

/** What the Shortcut says back (English keys; the route translates). */
export const SC_LINES = {
  bad: en('This Shortcuts token is not valid. Make a new one in Sara: Settings → Connections → Phone and notifications → iPhone Shortcuts.'),
  scope: en('This Shortcuts token is not allowed to do that. Make one that is in Sara: Settings → Connections → Phone and notifications → iPhone Shortcuts.'),
  slow: en('Too many requests from this Shortcut. Wait a minute and try again.'),
  privateLocal: en('Private local mode is on: Sara does not answer other devices until it is off.'),
  saved: en('Saved to Sara: {names}. Open Sara to go on.'),
  savedText: en('Sent to Sara. Open Sara to go on.'),
  skipped: en('Sara could not read: {names}.'),
  empty: en('Say what you want to ask Sara.'),
  later: en("I'm on it. I'll notify you when it's done."),
  laterNoPush: en("I'm on it. The answer will be in Sara's Siri chat."),
  busy: en("I'm still answering your last question. Ask again in a moment."),
  waiting: en('I need your OK in Sara for that: {what}'),
  failed: en("Sorry, I couldn't answer just now. Try again in a moment."),
} as const;

export const ICLOUD_SHORTCUT_RE = /^https:\/\/www\.icloud\.com\/shortcuts\/[0-9a-f]{32}\/?$/i;
export interface ShortcutLinks {
  share?: string;
  ask?: string;
}

/** The owner's iCloud links for the two ready-made shortcuts (one file for the whole server). */
export class ShortcutLinksFile {
  readonly #file: string;
  constructor(dir: string) {
    this.#file = join(dir, 'shortcut-links.json');
  }
  get(): ShortcutLinks {
    try {
      if (!existsSync(this.#file)) return {};
      const j = JSON.parse(readFileSync(this.#file, 'utf8')) as ShortcutLinks;
      return { ...(ICLOUD_SHORTCUT_RE.test(j.share ?? '') ? { share: j.share } : {}), ...(ICLOUD_SHORTCUT_RE.test(j.ask ?? '') ? { ask: j.ask } : {}) };
    } catch {
      return {};
    }
  }
  /** Saves both links (an empty value removes one). Throws for anything but an iCloud shortcut link. */
  set(next: { share?: unknown; ask?: unknown }): ShortcutLinks {
    const out: ShortcutLinks = {};
    for (const k of ['share', 'ask'] as const) {
      const v = String(next[k] ?? '').trim();
      if (!v) continue;
      if (!ICLOUD_SHORTCUT_RE.test(v)) throw new Error('Paste the iCloud link of the shortcut: https://www.icloud.com/shortcuts/…');
      out[k] = v;
    }
    writeFileSync(this.#file, `${JSON.stringify(out, null, 2)}\n`);
    return out;
  }
}

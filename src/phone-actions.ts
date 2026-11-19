// N5b (docs/PHONE.md "Quick actions, share, widget, car mode"): Sara where the person is.
//  - Quick actions on notifications: each actionable notification carries one signed, one-time
//    action token bound to its item (an approval, a reminder, an inbox card, a run that waits), its
//    space and companion, the actions it allows, and a short expiry. The service worker sends it as
//    `Authorization: Bearer sara_act.…` to POST /api/phone/act: no cookie is needed, and the token
//    can do nothing else.
//  - Approvals from the phone are plain cards only: computer use (her hands on a PC, her browser)
//    and cards with a choice to make (contradiction, sandbox, install check, red team, spending)
//    stay on the computer/app by policy, so their notifications carry no Approve button and the
//    route refuses them anyway.
//  - Share to Sara: the PWA share target and the Android share sheet post files, text and links;
//    files go to the Library, a new chat opens with a ready message (a receipt photo suggests an expense).
//  - Car mode: short spoken answers, no computer use or long tasks, read messages on request.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { homeTapOnly } from './home-voice.ts';
import type { DatabaseSync } from 'node:sqlite';
import { en } from './i18n.ts';
import type { Vault } from './vault.ts';

export const ACT_PREFIX = 'sara_act.';
export const ACT_VAULT = 'phone:act-key';
export type ActKind = 'approval' | 'reminder' | 'reply' | 'inbox' | 'automation' | 'kid';
export type ActName = 'approve' | 'decline' | 'snooze' | 'reply' | 'accept';
export const ACT_NAMES: readonly ActName[] = ['approve', 'decline', 'snooze', 'reply', 'accept'];
/** Approvals and runs that wait: as short as the card's own wait (10 minutes) plus a little. */
export const ACT_TTL_SHORT_MS = 15 * 60_000;
/** Reminders, replies and inbox cards stay on the lock screen longer. */
export const ACT_TTL_LONG_MS = 2 * 3600_000;
export const SNOOZE_MS = 3600_000;

export interface ActItem {
  kind: ActKind;
  /** The item's own id (approval id, reminder id, inbox item id, automation run id). */
  id: string;
  /** The conversation it belongs to (Reply posts there; approvals must match it). */
  conv?: string;
  companion?: string;
  acts: ActName[];
}
export interface ActClaims extends ActItem {
  space: string;
  exp: number;
  nonce: string;
}

const SCHEMA = 'CREATE TABLE IF NOT EXISTS phone_act_used (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL)';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Why a token was refused (English; the route translates). */
export const ACT_LINES = {
  bad: en('This action link is not valid. Open Sara to do it there.'),
  expired: en('This notification is too old to act on. Open Sara to do it there.'),
  used: en('This was already done from the notification.'),
  wrongUser: en('This notification belongs to someone else.'),
  notAllowed: en('That action is not offered for this notification.'),
  pcOnly: en('Approvals for computer use happen on the computer itself, never from the phone.'),
  gone: en('That request is no longer waiting.'),
  nothing: en('There is nothing to do here any more.'),
} as const;

export class ActError extends Error {
  readonly status: number;
  readonly key: string;
  constructor(status: number, key: string) {
    super(key);
    this.status = status;
    this.key = key;
  }
}

/** Mints and checks action tokens for one space (its own key in its own vault, its own used list). */
export class PhoneActions {
  readonly #db: DatabaseSync;
  readonly #vault: Vault;
  readonly #now: () => number;
  space: string;
  #key: Buffer | undefined;

  constructor(db: DatabaseSync, vault: Vault, opts: { space?: string; now?: () => number } = {}) {
    this.#db = db;
    this.#vault = vault;
    this.space = opts.space ?? 'owner';
    this.#now = opts.now ?? (() => Date.now());
    db.exec(SCHEMA);
  }

  #secret(): Buffer {
    if (this.#key) return this.#key;
    let k = this.#vault.get(ACT_VAULT);
    if (!k) {
      k = randomBytes(32).toString('base64');
      this.#vault.set(ACT_VAULT, k);
    }
    this.#key = Buffer.from(k, 'base64');
    return this.#key;
  }

  #sign(body: string): Buffer {
    return createHmac('sha256', this.#secret()).update(`${this.space}.${body}`).digest();
  }

  mint(item: ActItem, ttlMs = item.kind === 'approval' || item.kind === 'automation' ? ACT_TTL_SHORT_MS : ACT_TTL_LONG_MS): string {
    const claims: ActClaims = { ...item, acts: item.acts.filter((a) => ACT_NAMES.includes(a)), space: this.space, exp: this.#now() + ttlMs, nonce: randomBytes(12).toString('base64url') };
    const body = b64u(JSON.stringify(claims));
    return `${ACT_PREFIX}${this.space}.${body}.${b64u(this.#sign(body))}`;
  }

  /** Checks a token (signature, space, companion, expiry, action) without using it up. */
  check(token: string, want: { action: string; companion?: string }): ActClaims {
    if (!token.startsWith(ACT_PREFIX)) throw new ActError(401, ACT_LINES.bad);
    const [space, body, sig] = token.slice(ACT_PREFIX.length).split('.');
    if (!space || !body || !sig) throw new ActError(401, ACT_LINES.bad);
    if (space !== this.space) throw new ActError(403, ACT_LINES.wrongUser);
    const expect = this.#sign(body);
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expect.length || !timingSafeEqual(given, expect)) throw new ActError(401, ACT_LINES.bad);
    let c: ActClaims;
    try {
      c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ActClaims;
    } catch {
      throw new ActError(401, ACT_LINES.bad);
    }
    if (c.space !== this.space) throw new ActError(403, ACT_LINES.wrongUser);
    if ((c.companion ?? 'main') !== (want.companion ?? 'main')) throw new ActError(403, ACT_LINES.wrongUser);
    if (!(c.exp > this.#now())) throw new ActError(410, ACT_LINES.expired);
    if (!ACT_NAMES.includes(want.action as ActName) || !c.acts.includes(want.action as ActName)) throw new ActError(400, ACT_LINES.notAllowed);
    if (this.#db.prepare('SELECT 1 FROM phone_act_used WHERE nonce = ?').get(c.nonce)) throw new ActError(409, ACT_LINES.used);
    return c;
  }

  /** Uses a checked token up (one action per notification). */
  spend(c: ActClaims): void {
    const now = this.#now();
    this.#db.prepare('DELETE FROM phone_act_used WHERE exp < ?').run(now);
    const r = this.#db.prepare('INSERT OR IGNORE INTO phone_act_used (nonce, exp) VALUES (?, ?)').run(c.nonce, c.exp);
    if (!Number(r.changes)) throw new ActError(409, ACT_LINES.used);
  }
}

/** The space id inside an action token (main.ts routes the request to that person's space). */
export function actTokenSpace(token: string): string | undefined {
  if (!token.startsWith(ACT_PREFIX)) return undefined;
  const s = token.slice(ACT_PREFIX.length).split('.')[0];
  return s && /^[\w-]{1,64}$/.test(s) ? s : undefined;
}

// ---------------------------------------------------------------------------------------------
// Which approval cards may be answered from a phone notification
// ---------------------------------------------------------------------------------------------

/** Computer use: her hands on a PC (pc_*), her own browser, desktop apps. PC-only by policy. */
export const PC_ONLY_TOOL = (name: string): boolean => /^(pc_|browser_|computer_|hands_|desktop_)/.test(name);

export interface ApprovalShape {
  name: string;
  /** V2.3: the call's arguments (home_control locks and alarms want a tap). */
  args?: Record<string, unknown>;
  computer?: unknown;
  contradiction?: unknown;
  sandbox?: unknown;
  sandboxFirst?: unknown;
  advisory?: unknown;
  redteam?: unknown;
  spend?: unknown;
  price?: unknown;
  untrusted?: boolean;
}

/**
 * U4.24 (docs/VOICE_FIRST.md): never answered by a spoken yes, anywhere (Talk with Sara, car mode,
 * phone calls): money and passwords/sign-ins. A tap on the card (or a phone notification, where
 * phoneMayApprove allows it) still works. web/talk.js voiceMayAnswer mirrors this (tested).
 */
export const VOICE_NEVER_TOOL = (name: string): boolean => /(?:^|_)(?:pay|payment|purchase|buy|checkout|wallet|transfer|password|passkey|vault|secret|credential|login|signin|otp|two_step)(?:_|$)|password/.test(name);

/** A card a spoken yes/no may answer: the phone rule plus the voice hard limits. */
export function voiceMayApprove(ev: ApprovalShape): boolean {
  return phoneMayApprove(ev) && !VOICE_NEVER_TOOL(ev.name) && !homeTapOnly(ev);
}

/** A plain card about a non-computer tool: Approve/Decline may come from the notification. */
export function phoneMayApprove(ev: ApprovalShape): boolean {
  if (PC_ONLY_TOOL(ev.name)) return false;
  return !(ev.computer || ev.contradiction || ev.sandbox || ev.sandboxFirst || ev.advisory || ev.redteam || ev.spend || ev.price || ev.untrusted);
}

/** Notification buttons for an action set (English titles; the push payload translates them). */
export const ACT_TITLES: Record<ActName, string> = {
  approve: en('Approve'),
  decline: en('Decline'),
  snooze: en('Snooze 1 h'),
  reply: en('Reply'),
  accept: en('Accept'),
};

// ---------------------------------------------------------------------------------------------
// Car mode
// ---------------------------------------------------------------------------------------------

/** Auto-off after this long without use (the page keeps the time; the server trusts each turn's flag). */
export const CAR_IDLE_MS = 2 * 3600_000;
/** Tools never offered while driving: computer use and long or background tasks. */
export const CAR_BLOCKED_TOOL = (name: string): boolean =>
  PC_ONLY_TOOL(name) ||
  /^(goal_|loop_|research_|team_|crew_|worker_|job_|agent_|code_|shell|run_command|write_file|edit_file|apply_patch|make_document|fill_document|learn_|skill_run|delegate|spawn)/.test(name);

/** Her instruction while the person drives: voice only, short, nothing to read on a screen. */
export function carNote(owner: string, unread: string[] = [], errands: string[] = []): string {
  // R5: errands by voice: started with errand_start (its card is answered by saying "approve"), and where each open one stands.
  const errandPart = ` ${owner} can start an errand by voice (errand_start; ${owner} answers its card by saying approve or no; cards for computer use wait for the computer).${errands.length ? ` If asked how the errands are going, say where they stand in one short sentence each:\n${errands.map((e) => `- ${e}`).join('\n')}\n` : ''}`;
  const base = `${owner} is driving and using car mode: everything you say is read aloud and ${owner} can't look at a screen. Answer in at most two short spoken sentences unless ${owner} asks for more, with no lists, tables, markdown, links, emoji or code. Don't offer computer use, long tasks, documents or anything to read; if ${owner} asks for one, say it can wait until they've parked. Keep safety first: never encourage looking at the phone.${errandPart}`;
  if (!unread.length) return `${base} If asked to read messages or notifications, say there are none new.`;
  return `${base} If ${owner} asks you to read messages or notifications, read these newest ones aloud briefly, newest first:\n${unread.map((u) => `- ${u}`).join('\n')}`;
}

/** R4: her instruction for "Ask Sara" from Siri or an Apple Shortcut (spoken or shown in a small box). */
export function siriNote(owner: string): string {
  return `${owner} is asking through Siri or an Apple Shortcut on their iPhone: your answer is read aloud or shown in a small box. Answer in at most two short sentences, with no lists, tables, markdown, links, emoji or code. If the request needs a long task, start it and say in one sentence that you'll let ${owner} know when it's done.`;
}

/** Spoken commands that switch car mode (the page checks them before sending; 6 languages). */
export const CAR_ON_RE = /^\s*(?:(?:turn on|start|enable)\s+)?(?:car mode|driving mode|modo (?:coche|carro|conducción)|mode voiture|automodus|auto-modus|modalità auto)(?:\s+on)?\s*[.!]?\s*$/i;
export const CAR_OFF_RE = /^\s*(?:(?:turn off|stop|exit|end|disable)\s+)(?:car mode|driving mode|modo (?:coche|carro|conducción)|mode voiture|automodus|auto-modus|modalità auto)\s*[.!]?\s*$|^\s*(?:car mode|driving mode)\s+off\s*[.!]?\s*$/i;

// ---------------------------------------------------------------------------------------------
// Share to Sara
// ---------------------------------------------------------------------------------------------

export interface SharedPart {
  name: string;
  filename?: string;
  type: string;
  data: Buffer;
}

/** A small multipart/form-data reader (the share target's POST). Fields and files, in order. */
export function parseMultipart(body: Buffer, contentType: string): SharedPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) throw new Error('Not a form upload.');
  const sep = Buffer.from(`--${boundary}`);
  const out: SharedPart[] = [];
  let at = body.indexOf(sep);
  while (at >= 0) {
    const start = at + sep.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(sep, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, next - 2); // past CRLF, before CRLF
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString('utf8');
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      const type = /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim().toLowerCase() ?? (filename !== undefined ? 'application/octet-stream' : 'text/plain');
      out.push({ name, ...(filename !== undefined ? { filename } : {}), type, data: part.subarray(headEnd + 4) });
    }
    at = next;
  }
  return out;
}

const RECEIPT_RE = /\b(receipt|invoice|bill|recibo|factura|reçu|facture|quittung|rechnung|beleg|ricevuta|scontrino|fattura|nota fiscal|cupom)\b/i;

/** The ready message in the new chat (English; the route translates the fixed words). */
export function sharePrefill(s: { title?: string; text?: string; url?: string; files: { name: string; type: string }[] }): { key: string; params: Record<string, string> } {
  const said = [s.title, s.text].filter(Boolean).join(' ').trim();
  const link = s.url || /https?:\/\/\S+/.exec(said)?.[0] || '';
  const images = s.files.filter((f) => f.type.startsWith('image/'));
  const names = s.files.map((f) => f.name).join(' ');
  const receipt = RECEIPT_RE.test(`${said} ${names}`);
  if (images.length && receipt) return { key: en("Here's a photo of a receipt. Please add it as an expense."), params: {} };
  if (images.length === 1 && s.files.length === 1) return { key: said ? en("Here's a photo: {what}") : en("Here's a photo."), params: { what: said.slice(0, 300) } };
  if (s.files.length) return { key: receipt ? en("Here's a receipt ({names}). Please add it as an expense.") : en("Here's what I shared: {names}"), params: { names: s.files.map((f) => f.name).join(', ').slice(0, 300) } };
  if (link) return { key: said && said !== link ? en("Here's a link: {link} ({what})") : en("Here's a link: {link}"), params: { link: link.slice(0, 1000), what: said.replace(link, '').trim().slice(0, 300) } };
  return { key: '{what}', params: { what: said.slice(0, 2000) } };
}

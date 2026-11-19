// V5.3: legacy and emergency access (docs/design/LEGACY.md, user doc docs/LEGACY.md).
// The owner names one trusted person and picks what they get. After N days without a sign-in or a
// chat he typed, Sara reminds him (3 days), waits (W days), then opens an expiring page for that
// person (L days). The person may also ask early: the same waiting period, the owner told at once.
// Any sign-in, owner chat or "I'm here" cancels. One JSON file per owner space; the link token is
// stored only as a hash (plus a vault-sealed copy so the opening mail can carry it).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { en, fill, trOwner } from './i18n.ts';
import { detailLines, myDetailsFor } from './my-details.ts';
import { scrubForShare } from './share.ts';
import { SERVER_SECRET } from './vault.ts';

const DAY = 86_400_000;
/** Days of daily reminders after the N quiet days, before the waiting period starts. */
export const REMIND_DAYS = 3;
/** One emergency request per this many days. */
export const ASK_COOLDOWN_DAYS = 7;
export const LIMITS = { days: [14, 365], waitDays: [3, 60], linkDays: [1, 90] } as const;
const FILE = 'legacy.json';
/** Sealed notes live in the vault under this prefix; no other vault entry can ever be handed out. */
export const SEALED_NAME = /^legacy:[a-z0-9-]{1,40}$/;
export const sealedName = (label: string) => `legacy:${label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'note'}`;

export type LegacyStage = 'off' | 'watching' | 'reminding' | 'waiting' | 'open' | 'closed';
export type LegacyWhy = 'sign-in' | 'chat' | 'here';

export interface LegacyGets {
  /** A letter shown at the top of their page. */
  letter: string;
  /** Short notes (where the spare key is, who to call). */
  notes: string[];
  /** Kept Library documents, by id. */
  docs: number[];
  /** Conversations, by id. None by default. */
  chats: string[];
  /** My details (emergency contact, addresses, insurance...). Off by default. */
  details: boolean;
  /** Sealed notes in the vault (`legacy:<name>`), added one by one with a confirm box. */
  vault: string[];
  /** Labels shown for the sealed notes (name → label). */
  labels?: Record<string, string>;
}

export interface LegacyConfig {
  on: boolean;
  name: string;
  email: string;
  days: number;
  waitDays: number;
  linkDays: number;
  emailThem: boolean;
  allowAsk: boolean;
  gets: LegacyGets;
}

export interface LegacyState {
  config: LegacyConfig;
  lastActive: string;
  tokenHash: string | null;
  tokenSealed: string | null;
  request: { at: string; opensAt: string } | null;
  lastAskAt: string | null;
  openedAt: string | null;
  expiresAt: string | null;
  /** Reminder/alert keys already sent in this round (cleared on cancel). */
  sent: string[];
  views: number;
  history: { at: string; what: string }[];
}

export class LegacyError extends Error {
  readonly status: number;
  readonly params: Record<string, unknown> | undefined;
  constructor(status: number, message: string, params?: Record<string, unknown>) {
    super(fill(message, params));
    this.status = status;
    this.key = message;
    this.params = params;
  }
  readonly key: string;
}

const NO_GETS: LegacyGets = { letter: '', notes: [], docs: [], chats: [], details: false, vault: [] };
const DEFAULT_CONFIG: LegacyConfig = { on: false, name: '', email: '', days: 60, waitDays: 14, linkDays: 30, emailThem: false, allowAsk: true, gets: NO_GETS };

function fresh(now: Date): LegacyState {
  return { config: { ...DEFAULT_CONFIG, gets: { ...NO_GETS } }, lastActive: now.toISOString(), tokenHash: null, tokenSealed: null, request: null, lastAskAt: null, openedAt: null, expiresAt: null, sent: [], views: 0, history: [] };
}

const hash = (token: string) => createHash('sha256').update(`sara-legacy:${token}`).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();

/** The stage at `now`, the day the page opens (when known) and the quiet days so far. Pure. */
export function legacyStage(s: LegacyState, now: Date): { stage: LegacyStage; opensAt?: string; idleDays: number } {
  const t = now.getTime();
  const idleDays = Math.max(0, (t - Date.parse(s.lastActive)) / DAY);
  const c = s.config;
  if (!c.on || !s.tokenHash) return { stage: 'off', idleDays };
  if (s.openedAt) return { stage: s.expiresAt && t < Date.parse(s.expiresAt) ? 'open' : 'closed', idleDays };
  if (s.request) return t >= Date.parse(s.request.opensAt) ? { stage: 'open', opensAt: s.request.opensAt, idleDays } : { stage: 'waiting', opensAt: s.request.opensAt, idleDays };
  const opensAt = iso(Date.parse(s.lastActive) + (c.days + REMIND_DAYS + c.waitDays) * DAY);
  if (idleDays >= c.days + REMIND_DAYS + c.waitDays) return { stage: 'open', opensAt, idleDays };
  if (idleDays >= c.days + REMIND_DAYS) return { stage: 'waiting', opensAt, idleDays };
  if (idleDays >= c.days) return { stage: 'reminding', opensAt, idleDays };
  return { stage: 'watching', idleDays };
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n) : '');
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;

function int(v: unknown, [lo, hi]: readonly [number, number], fallback: number, message: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new LegacyError(400, message, { lo, hi });
  return n;
}

export interface LegacyDeps {
  dataDir: string;
  now: () => Date;
  /** Tell the owner (chat where he chose + push). */
  alert?: (title: string, text: string) => void;
  /** Mail the trusted person (only when the owner chose so). */
  mail?: (to: string, subject: string, body: string) => Promise<void>;
  /** The full page address for a token. */
  link?: (token: string) => string;
  seal?: (v: string) => string;
  unseal?: (v: string) => string;
  /** Fill (and translate) a text for the owner. */
  say?: (text: string, params?: Record<string, unknown>) => string;
}

export class Legacy {
  readonly #o: LegacyDeps;
  readonly #t: (text: string, params?: Record<string, unknown>) => string;
  #s: LegacyState;

  constructor(o: LegacyDeps) {
    this.#o = o;
    this.#t = o.say ?? fill;
    this.#s = this.#read();
  }

  #read(): LegacyState {
    const p = join(this.#o.dataDir, FILE);
    if (!existsSync(p)) return fresh(this.#o.now());
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<LegacyState>;
      const base = fresh(this.#o.now());
      return { ...base, ...raw, config: { ...base.config, ...(raw.config ?? {}), gets: { ...NO_GETS, ...(raw.config?.gets ?? {}) } } };
    } catch {
      return fresh(this.#o.now());
    }
  }

  #save(): void {
    const p = join(this.#o.dataDir, FILE);
    writeFileSync(`${p}.tmp`, JSON.stringify(this.#s, null, 1), { mode: 0o600 });
    renameSync(`${p}.tmp`, p);
    try {
      chmodSync(p, 0o600);
    } catch {
      /* Windows */
    }
  }

  #log(what: string): void {
    this.#s.history = [...this.#s.history, { at: this.#o.now().toISOString(), what }].slice(-50);
  }

  #alert(title: string, text: string): void {
    try {
      this.#o.alert?.(title, text);
    } catch {
      /* an alert that fails must never stop the switch */
    }
  }

  view(): { stage: LegacyStage; opensAt?: string; idleDays: number; config: LegacyConfig; lastActive: string; request: LegacyState['request']; openedAt: string | null; expiresAt: string | null; views: number; history: LegacyState['history']; hasLink: boolean } {
    const st = legacyStage(this.#s, this.#o.now());
    const s = this.#s;
    return { ...st, idleDays: Math.floor(st.idleDays), config: structuredClone(s.config), lastActive: s.lastActive, request: s.request, openedAt: s.openedAt, expiresAt: s.expiresAt, views: s.views, history: s.history.slice(-12), hasLink: Boolean(s.tokenHash) };
  }

  /** Changes that widen who gets what (and so need owner proof). Narrowing never does. */
  needsProof(patch: Partial<LegacyConfig>): boolean {
    const c = this.#s.config;
    if (patch.on === true && !c.on) return true;
    if (patch.name !== undefined && clip(patch.name, 80) !== c.name) return true;
    if (patch.email !== undefined && clip(patch.email, 254) !== c.email) return true;
    if (patch.emailThem === true && !c.emailThem) return true;
    if (patch.allowAsk === true && !c.allowAsk) return true;
    if (patch.days !== undefined && Number(patch.days) < c.days) return true;
    if (patch.waitDays !== undefined && Number(patch.waitDays) < c.waitDays) return true;
    if (patch.linkDays !== undefined && Number(patch.linkDays) > c.linkDays) return true;
    const g = patch.gets;
    if (g) {
      const more = <T>(a: T[] | undefined, b: T[]) => (a ?? []).some((x) => !b.includes(x));
      if ((g.details && !c.gets.details) || more(g.docs, c.gets.docs) || more(g.chats, c.gets.chats) || more(g.vault, c.gets.vault)) return true;
      if (g.letter !== undefined && clip(g.letter, 8000) !== c.gets.letter) return true;
      if (g.notes !== undefined && more(g.notes, c.gets.notes)) return true;
    }
    return false;
  }

  /** Set it up or change it. `token` is returned only when a new link was made. */
  configure(patch: Partial<LegacyConfig>, o: { proven?: boolean; vaultConfirm?: boolean } = {}): { token?: string } {
    if (!o.proven && this.#s.config.on && this.needsProof(patch)) throw new LegacyError(403, en('Confirm it is you first.'));
    const c = this.#s.config;
    const next: LegacyConfig = {
      on: patch.on ?? c.on,
      name: patch.name !== undefined ? clip(patch.name, 80) : c.name,
      email: patch.email !== undefined ? clip(patch.email, 254) : c.email,
      days: int(patch.days, LIMITS.days, c.days, en('Days without a sign-in: choose {lo} to {hi}.')),
      waitDays: int(patch.waitDays, LIMITS.waitDays, c.waitDays, en('Waiting period: choose {lo} to {hi} days.')),
      linkDays: int(patch.linkDays, LIMITS.linkDays, c.linkDays, en('Days the page stays open: choose {lo} to {hi}.')),
      emailThem: patch.emailThem ?? c.emailThem,
      allowAsk: patch.allowAsk ?? c.allowAsk,
      gets: c.gets,
    };
    if (patch.gets) {
      const g = patch.gets;
      const vault = Array.isArray(g.vault) ? [...new Set(g.vault.map((x) => clip(x, 120)).filter(Boolean))].slice(0, 20) : c.gets.vault;
      if (vault.some((n) => SERVER_SECRET.test(n) || !SEALED_NAME.test(n))) throw new LegacyError(400, en('Sara never hands out her own keys (models, chat apps, backups).'));
      const added = vault.filter((n) => !c.gets.vault.includes(n));
      if (added.length && !o.vaultConfirm) throw new LegacyError(400, en('Tick the box to confirm the sealed notes.'));
      next.gets = {
        letter: g.letter !== undefined ? clip(g.letter, 8000) : c.gets.letter,
        notes: Array.isArray(g.notes) ? g.notes.map((x) => clip(x, 1000)).filter(Boolean).slice(0, 30) : c.gets.notes,
        docs: Array.isArray(g.docs) ? [...new Set(g.docs.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50) : c.gets.docs,
        chats: Array.isArray(g.chats) ? [...new Set(g.chats.map((x) => clip(x, 80)).filter(Boolean))].slice(0, 20) : c.gets.chats,
        details: g.details === undefined ? c.gets.details : g.details === true,
        vault,
        labels: Object.fromEntries(vault.map((n) => [n, clip(g.labels?.[n] ?? c.gets.labels?.[n] ?? n.slice(7), 60)])),
      };
    }
    if (next.on && !next.name) throw new LegacyError(400, en('Add the name of the person you trust.'));
    if (next.email && !EMAIL.test(next.email)) throw new LegacyError(400, en('That email address does not look right.'));
    if (next.emailThem && !next.email) next.emailThem = false;
    const turningOn = next.on && !c.on;
    this.#s.config = next;
    let token: string | undefined;
    if (turningOn) {
      this.#s.lastActive = this.#o.now().toISOString();
      this.#reset();
      if (!this.#s.tokenHash) token = this.#newToken();
      this.#log('on');
      this.#alert(this.#t(en('Legacy access is set up')), this.#t(en('{name} gets a page if you stop using Sara for {days} days, after reminders and a {wait}-day wait. Any sign-in cancels it.'), { name: next.name, days: next.days, wait: next.waitDays }));
    } else if (!next.on && c.on) {
      this.turnOff();
      return {};
    } else this.#log('changed');
    this.#save();
    audit({ action: 'legacy.configure', role: 'owner', outcome: 'ok', content: next.on ? 'on' : 'off' });
    return token ? { token } : {};
  }

  #newToken(): string {
    const token = randomBytes(32).toString('base64url');
    this.#s.tokenHash = hash(token);
    this.#s.tokenSealed = this.#o.seal ? this.#o.seal(token) : null;
    return token;
  }

  /** A new link: the old one stops working at once. */
  newLink(): string {
    if (!this.#s.config.on) throw new LegacyError(409, en('Turn legacy access on first.'));
    const token = this.#newToken();
    this.#log('new-link');
    this.#save();
    audit({ action: 'legacy.link', role: 'owner', outcome: 'ok' });
    return token;
  }

  /** Off: the link stops working and everything waiting is dropped. Never needs proof. */
  turnOff(): void {
    this.#s.config = { ...this.#s.config, on: false };
    this.#s.tokenHash = null;
    this.#s.tokenSealed = null;
    this.#reset();
    this.#log('off');
    this.#save();
    audit({ action: 'legacy.off', role: 'owner', outcome: 'ok' });
  }

  #reset(): void {
    this.#s.request = null;
    this.#s.openedAt = null;
    this.#s.expiresAt = null;
    this.#s.sent = [];
  }

  /** The owner was here. Cancels anything after watching; returns whether it did. */
  seen(why: LegacyWhy): boolean {
    const now = this.#o.now();
    const st = legacyStage(this.#s, now).stage;
    const busy = st === 'reminding' || st === 'waiting' || st === 'open' || (st === 'closed' && this.#s.openedAt !== null);
    const stale = now.getTime() - Date.parse(this.#s.lastActive) > 3600_000;
    if (!busy && !stale && why !== 'here') return false;
    this.#s.lastActive = now.toISOString();
    if (busy) {
      const wasOpen = st === 'open';
      this.#reset();
      this.#log(`cancelled:${why}`);
      audit({ action: 'legacy.cancel', role: 'owner', outcome: 'ok', content: why });
      this.#alert(this.#t(en('Legacy access cancelled')), wasOpen ? this.#t(en('You are back, so the page for {name} is closed again. The same link opens it next time.'), { name: this.#s.config.name }) : this.#t(en('You are back, so nothing opens for {name}. The clock starts again today.'), { name: this.#s.config.name }));
    }
    if (st !== 'off') this.#save();
    return busy;
  }

  /** Is this the current link? Constant time. */
  check(token: string): boolean {
    if (!this.#s.tokenHash || !this.#s.config.on || typeof token !== 'string' || token.length > 100) return false;
    const a = Buffer.from(hash(token), 'hex');
    const b = Buffer.from(this.#s.tokenHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The trusted person asks early: the same waiting period, the owner told at once. */
  ask(token: string): { ok: boolean; reason?: string } {
    if (!this.check(token)) return { ok: false, reason: 'gone' };
    const now = this.#o.now();
    const c = this.#s.config;
    const st = legacyStage(this.#s, now).stage;
    if (!c.allowAsk) return { ok: false, reason: 'off' };
    if (st !== 'watching' && st !== 'reminding') return { ok: false, reason: 'busy' };
    if (this.#s.lastAskAt && now.getTime() - Date.parse(this.#s.lastAskAt) < ASK_COOLDOWN_DAYS * DAY) return { ok: false, reason: 'soon' };
    const opensAt = iso(now.getTime() + c.waitDays * DAY);
    this.#s.request = { at: now.toISOString(), opensAt };
    this.#s.lastAskAt = now.toISOString();
    this.#s.sent = [];
    this.#log('asked');
    this.#save();
    audit({ action: 'legacy.ask', role: 'system', who: 'visitor', channel: 'web', outcome: 'ok' });
    this.#alert(this.#t(en('{name} asked for emergency access'), { name: c.name }), this.#t(en('{name} asked for emergency access. Their page opens on {date} unless you cancel. Signing in or pressing I\'m here cancels it.'), { name: c.name, date: opensAt.slice(0, 10) }));
    return { ok: true };
  }

  /** Called on every scheduler tick: reminders, opening, closing. Returns what it did. */
  tick(): string[] {
    const now = this.#o.now();
    const st = legacyStage(this.#s, now);
    const did: string[] = [];
    const c = this.#s.config;
    const once = (key: string, title: string, text: string) => {
      if (this.#s.sent.includes(key)) return;
      this.#s.sent = [...this.#s.sent, key].slice(-60);
      this.#alert(title, text);
      did.push(key);
    };
    if (st.stage === 'reminding') {
      const day = Math.floor(st.idleDays);
      once(`remind:${day}`, this.#t(en('Are you there?')), this.#t(en('You have not used Sara for {days} days. If you don\'t sign in, {name} gets the page you set up on {date}. Sign in or press I\'m here to cancel.'), { days: day, name: c.name, date: (st.opensAt ?? '').slice(0, 10) }));
    } else if (st.stage === 'waiting') {
      const since = this.#s.request ? (now.getTime() - Date.parse(this.#s.request.at)) / DAY : st.idleDays - c.days - REMIND_DAYS;
      const step = Math.floor(Math.max(0, since) / 2);
      once(`wait:${this.#s.request?.at ?? 'idle'}:${step}`, this.#t(en('Legacy access opens soon')), this.#t(en('The page for {name} opens on {date}. Sign in or press I\'m here to cancel.'), { name: c.name, date: (st.opensAt ?? '').slice(0, 10) }));
    } else if (st.stage === 'open' && !this.#s.openedAt) {
      this.#s.openedAt = now.toISOString();
      this.#s.expiresAt = iso(now.getTime() + c.linkDays * DAY);
      this.#log('opened');
      audit({ action: 'legacy.open', role: 'system', outcome: 'ok' });
      this.#alert(this.#t(en('Legacy access opened')), this.#t(en('The page for {name} is open until {date}. Sign in or press I\'m here to close it.'), { name: c.name, date: this.#s.expiresAt.slice(0, 10) }));
      did.push('opened');
      if (c.emailThem && c.email && this.#o.mail && this.#s.tokenSealed && this.#o.unseal) {
        try {
          const token = this.#o.unseal(this.#s.tokenSealed);
          const url = this.#o.link ? this.#o.link(token) : `/legacy/${token}`;
          void this.#o.mail(c.email, this.#t(en('A page was left for you')), [this.#t(en('Hello {name},'), { name: c.name }), this.#t(en('Some time ago you were named as a trusted person. A page with what was left for you is now open until {date}:'), { date: this.#s.expiresAt.slice(0, 10) }), url, this.#t(en('Keep this link private.'))].join('\n\n')).catch(() => this.#log('mail-failed'));
          did.push('mailed');
        } catch {
          this.#log('mail-failed');
        }
      }
    } else if (st.stage === 'closed' && this.#s.openedAt && !this.#s.sent.includes('closed')) {
      this.#s.sent = [...this.#s.sent, 'closed'];
      this.#log('closed');
      did.push('closed');
    } else if (st.stage === 'off' || st.stage === 'watching') return did;
    if (did.length) this.#save();
    return did;
  }

  /** Counted once per page view (shown on the owner's page). */
  viewed(): void {
    this.#s.views++;
    this.#save();
  }

  state(): LegacyState {
    return structuredClone(this.#s);
  }
}

// ---------- per app ----------
const engines = new WeakMap<object, Legacy>();

/** The owner space's engine; undefined for household members, kids and the demo. */
export function legacyOf(app: AppContext): Legacy | undefined {
  if (app.member || app.demo) return undefined;
  let e = engines.get(app);
  if (!e) {
    e = new Legacy({
      dataDir: app.dataDir,
      now: () => app.now(),
      alert: (title, text) => {
        postAlert(app, 'legacy', { role: 'assistant', content: `${title}\n\n${text}`, reason: 'proactive', nudge: { value: 1, urgency: 'safety' } });
        void app.push?.notifyOwner(title, text, '', 'legacy').catch(() => undefined);
      },
      mail: async (to, subject, body) => {
        const accts = app.mailAccounts as { default?: () => { id: string } | undefined; provider?: (id: string) => { send(d: { to: string; subject: string; body: string }): Promise<string> } } | undefined;
        const def = typeof accts?.default === 'function' ? accts.default() : undefined;
        if (!def || typeof accts?.provider !== 'function') throw new Error('no mail account');
        await accts.provider(def.id).send({ to, subject, body });
      },
      link: (token) => `${legacyOrigin(app)}/legacy/${token}`,
      say: (text, params) => trOwner(text, app.settings.get(), params),
      seal: (v) => app.vault.seal(v, 'legacy-link'),
      unseal: (v) => app.vault.unseal(v, 'legacy-link'),
    });
    engines.set(app, e);
  }
  return e;
}

/** The address the owner last used, for the opening mail (set by the routes). */
const origins = new WeakMap<object, string>();
export function rememberLegacyOrigin(app: AppContext, origin: string): void {
  origins.set(app, origin);
}
function legacyOrigin(app: AppContext): string {
  return origins.get(app) ?? '';
}

/** A sign-in, an owner chat or I'm here. Never throws. */
export function legacyActivity(app: AppContext, why: LegacyWhy): void {
  try {
    if (app.member || app.demo) return;
    if (!existsSync(join(app.dataDir, FILE))) return;
    legacyOf(app)?.seen(why);
  } catch {
    /* never in the way of a sign-in or a chat */
  }
}

/** ReminderScheduler.tick: only once it was ever set up (no file = nothing to do). */
export function legacyTick(app: AppContext): void {
  if (app.member || app.demo || !existsSync(join(app.dataDir, FILE))) return;
  legacyOf(app)?.tick();
}

// ---------- what they get ----------
export interface LegacyContent {
  owner: string;
  letter: string;
  notes: string[];
  docs: { id: number; title: string }[];
  chats: { title: string; messages: { who: string; text: string }[] }[];
  details: string[];
  vault: { name: string; value: string }[];
}

export function legacyContent(app: AppContext, c: LegacyConfig): LegacyContent {
  const owner = app.settings.get().ownerName || en('The owner');
  const lib = app.library as { get(id: number): { id: number; name: string; title: string | null; keep: boolean } | undefined } | undefined;
  const docs = c.gets.docs.map((id) => lib?.get(id)).filter((d): d is NonNullable<typeof d> => Boolean(d && d.keep)).map((d) => ({ id: d.id, title: d.title || d.name }));
  const chats = c.gets.chats.flatMap((id) => {
    const conv = app.store.getConversation(id);
    if (!conv) return [];
    const messages = app.store
      .messages(id)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
      .slice(-200)
      .map((m) => ({ who: m.role === 'user' ? owner : app.persona.name, text: scrubForShare(m.content, app.redactor).text }));
    return [{ title: conv.title, messages }];
  });
  let details: string[] = [];
  if (c.gets.details) {
    try {
      details = detailLines(myDetailsFor(app.store.db).get());
    } catch {
      details = [];
    }
  }
  const vault = c.gets.vault.filter((n) => SEALED_NAME.test(n) && !SERVER_SECRET.test(n)).flatMap((name) => {
    const value = app.vault.get(name);
    return value === undefined ? [] : [{ name: c.gets.labels?.[name] ?? name.slice(7), value }];
  });
  return { owner, letter: c.gets.letter, notes: c.gets.notes, docs, chats, details, vault };
}

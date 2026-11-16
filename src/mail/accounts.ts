// M1: one person's mailboxes. Google is the account "google" whenever it is signed in (its own code,
// src/google.ts; the owner's only); Microsoft and IMAP accounts are listed here. The list holds no
// secrets (tokens and app passwords are separate vault entries). The owner's list lives in the
// server's vault; each household member has their own list in their own vault (members/<id>/mail),
// which nobody else's tools, Today or routes ever open. The demo has none; private conversations
// get no mail tools; an admin policy can switch members' mail off (`memberMail: false`).
import type { CalendarLinks } from '../calendar-links.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { GoogleAccount } from '../google.ts';
import type { GoogleAccounts } from '../google-accounts.ts';
import { CalDav, CALDAV_PRESETS, type CalDavConfig } from './caldav.ts';
import type { Vault } from '../vault.ts';
import { GraphMail, msAuthForState, type MicrosoftAuth, type MsOpts, type MsTokens } from './graph.ts';
import { ImapMail, type ImapConfig, type ImapOpts } from './imap.ts';
import { presetById } from './presets.ts';
import type { MailAccountInfo, MailProvider } from './types.ts';

export const ACCOUNTS_VAULT = 'mail:accounts';
export const DEFAULT_VAULT = 'mail:default';
export const imapPasswordVault = (id: string): string => `mail:imap:${id}:password`;

interface Stored extends MailAccountInfo {
  /** IMAP only: servers, sign-in name, copy to Sent, the pinned certificate (Proton Bridge). */
  imap?: Omit<ImapConfig, 'address'>;
  /** MULTIMAIL: IMAP accounts whose provider has CalDAV (iCloud, Fastmail, Yahoo): where it is and the calendars found. */
  caldav?: CalDavConfig;
}

/**
 * MULTIMAIL: what the combined views show (a plain file next to the person's data, not the vault:
 * calendar ids can be addresses, and every vault string is hidden in logs and cards).
 */
export interface MailView {
  /** Accounts left out of the combined inbox, Today's Mail and "waiting for my answer" (ids). */
  off?: string[];
  /** Per account: the calendars that show (ids); false hides the account's calendar entirely. */
  calendars?: Record<string, string[] | false>;
  /** Where new events go when she isn't told: "<account id>" or "<account id>|<calendar id>". */
  calendarDefault?: string;
}

export interface AccountsOpts {
  ms?: MsOpts;
  imap?: Omit<ImapOpts, 'onFingerprint'>;
  /** A member's mailboxes: true while the admin's policy switches members' mail off (nothing listed, nothing added). */
  off?: () => boolean;
  /** MULTIMAIL: every Google sign-in (the owner's); without it, only `google` (the first). */
  googles?: GoogleAccounts;
  /** MULTIMAIL: the combined-view choices (mail-view.json in the person's folder). */
  viewFile?: string;
  /** MULTIMAIL: CalDAV requests (tests: a fake server). */
  caldav?: { fetch?: typeof fetch };
}

/** Which person's accounts a Microsoft sign-in belongs to (the callback route asks by `state`). */
const OF_AUTH = new WeakMap<MicrosoftAuth, MailAccounts>();
export const mailAccountsForState = (state: string): MailAccounts | undefined => {
  const auth = msAuthForState(state);
  return auth ? OF_AUTH.get(auth) : undefined;
};
export const MEMBER_MAIL_OFF = 'Your admin switched off mailboxes for household members on this server.';

export class MailAccounts {
  /** HANDSFREE 3a: this person's calendars added by link (src/calendar-links.ts; main.ts sets it). */
  calendarLinks?: CalendarLinks;
  readonly #vault: Vault;
  readonly #google: GoogleAccount | undefined;
  readonly ms: MicrosoftAuth;
  readonly #o: AccountsOpts;
  readonly #providers = new Map<string, MailProvider>();
  /** main.ts: Today caches of this person's companions forget the old mailbox. */
  onChange?: () => void;

  constructor(vault: Vault, google: GoogleAccount | undefined, ms: MicrosoftAuth, opts: AccountsOpts = {}) {
    this.#vault = vault;
    this.#google = google;
    this.ms = ms;
    this.#o = opts;
    OF_AUTH.set(ms, this);
  }

  /** A household member's mailboxes (not the owner's). */
  get member(): boolean {
    return this.ms.member;
  }
  /** Switched off by the admin's policy (members only). */
  get off(): boolean {
    return this.#o.off?.() === true;
  }
  #assertOn(): void {
    if (this.off) throw new Error(MEMBER_MAIL_OFF);
  }
  #changed(): void {
    try {
      this.onChange?.();
    } catch {
      /* a cache that could not be cleared refreshes on its own */
    }
  }

  #stored(): Stored[] {
    return this.off ? [] : this.#raw();
  }
  #raw(): Stored[] {
    try {
      return JSON.parse(this.#vault.get(ACCOUNTS_VAULT) ?? '[]') as Stored[];
    } catch {
      return [];
    }
  }
  #save(list: Stored[]): void {
    this.#vault.set(ACCOUNTS_VAULT, JSON.stringify(list));
  }

  /** MULTIMAIL: every signed-in Google account (the first one first). */
  googleAccounts(): GoogleAccount[] {
    if (this.#o.googles) return this.#o.googles.all();
    return this.#google?.status().connected ? [this.#google] : [];
  }
  /** MULTIMAIL: a Google account by id ('google', 'google:2'). */
  googleOf(id: string): GoogleAccount | undefined {
    if (this.#o.googles) return this.#o.googles.get(id);
    return id === 'google' ? this.#google : undefined;
  }

  /** Every connected mailbox, Google first. No secrets. */
  list(): MailAccountInfo[] {
    const out: MailAccountInfo[] = [];
    for (const ga of this.googleAccounts()) {
      const g = ga.status();
      if (g.connected && g.gmail) out.push({ id: ga.id, kind: 'google', provider: 'google', address: g.email ?? 'Gmail', addedAt: '', calendar: g.calendar });
    }
    for (const s of this.#stored()) {
      const { imap: _imap, caldav: _cd, ...info } = s;
      void _imap;
      void _cd;
      const signedOut = s.kind === 'microsoft' && !this.ms.hasTokens(s.id);
      out.push({ ...info, ...(signedOut ? { problem: 'Signed out: sign in again.' } : {}) });
    }
    return out;
  }

  /** The default mailbox (the owner's pick, else the first). */
  default(): MailAccountInfo | undefined {
    const all = this.list();
    const want = this.#vault.get(DEFAULT_VAULT);
    return all.find((a) => a.id === want) ?? all[0];
  }
  setDefault(id: string): void {
    if (!this.list().some((a) => a.id === id)) throw new Error('There is no such account.');
    this.#vault.set(DEFAULT_VAULT, id);
    this.#changed();
  }

  /** An account by id or address ("" or undefined: the default). */
  resolve(account?: string): MailAccountInfo {
    const all = this.list();
    if (!all.length) throw new Error('No mailbox is connected yet (Settings → Email and calendar).');
    const a = account?.trim().toLowerCase();
    if (!a) return this.default()!;
    const hit = all.find((x) => x.id === a || x.address.toLowerCase() === a) ?? all.find((x) => x.provider === a || x.kind === a || (a === 'gmail' && x.kind === 'google') || (a === 'outlook' && x.kind === 'microsoft'));
    if (!hit) throw new Error(`There is no mailbox "${account}". Connected: ${all.map((x) => x.address).join(', ')}.`);
    return hit;
  }

  /** The provider of a non-Google account (cached). */
  provider(id: string): MailProvider {
    const hit = this.#providers.get(id);
    if (hit) return hit;
    const s = this.#stored().find((x) => x.id === id);
    if (!s) throw new Error('There is no such account.');
    let p: MailProvider;
    if (s.kind === 'microsoft') p = new GraphMail(this.ms, s.id, s.address, this.#o.ms);
    else if (s.kind === 'imap' && s.imap) {
      const im = new ImapMail({ address: s.address, ...s.imap }, () => this.#vault.get(imapPasswordVault(s.id)), {
        ...this.#o.imap,
        onFingerprint: (fp) => this.#update(s.id, (x) => (x.imap ? { ...x, imap: { ...x.imap, fingerprint: fp } } : x)),
      });
      // MULTIMAIL: the same app password opens the provider's CalDAV calendars.
      if (s.caldav) im.calendar = this.#calDav(s);
      p = im;
    } else throw new Error('That account is handled by Gmail.');
    this.#providers.set(id, p);
    return p;
  }

  #update(id: string, f: (s: Stored) => Stored): void {
    this.#save(this.#raw().map((s) => (s.id === id ? f(s) : s)));
  }

  /** A Microsoft sign-in finished: the account (the same address replaces its older sign-in). */
  addMicrosoft(t: MsTokens): MailAccountInfo {
    this.#assertOn();
    const list = this.#stored();
    const old = list.find((x) => x.kind === 'microsoft' && x.address === t.address);
    const id = old?.id ?? `ms_${randomBytes(5).toString('hex')}`;
    this.ms.saveTokens(id, t);
    this.#providers.delete(id);
    const info: Stored = { id, kind: 'microsoft', provider: 'microsoft', address: t.address, addedAt: old?.addedAt ?? new Date().toISOString(), calendar: /Calendars\.ReadWrite/i.test(t.scopes), ...(t.files ? { files: true } : {}) };
    this.#save([...list.filter((x) => x.id !== id), info]);
    this.#changed();
    return info;
  }

  /** Builds an IMAP account (not saved): the route tests it first, then `saveImap`. */
  imapDraft(input: { preset: string; address: string; password: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number; user?: string }): { info: Stored; password: string; provider: ImapMail; users: string[] } {
    const address = input.address.trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new Error('Type the whole email address.');
    const password = input.password.replace(/\s+/g, '');
    if (password.length < 4) throw new Error('Paste the app password.');
    const p = presetById(input.preset);
    const port = (v: unknown, d: number) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 65536 ? Number(v) : d);
    const imap = p ? p.imap : { host: String(input.imapHost ?? '').trim(), port: port(input.imapPort, 993) };
    const smtp = p ? p.smtp : { host: String(input.smtpHost ?? '').trim(), port: port(input.smtpPort, 465) };
    if (!imap.host || !smtp.host) throw new Error('Type the IMAP and SMTP server names (your provider\'s help page lists them).');
    const users = input.user?.trim() ? [input.user.trim()] : (p?.user ?? ['address']).map((u) => (u === 'local' ? address.split('@')[0] : address));
    const id = `im_${randomBytes(5).toString('hex')}`;
    const info: Stored = { id, kind: 'imap', provider: p?.id ?? 'other', address, addedAt: new Date().toISOString(), calendar: false, imap: { user: users[0], imap, smtp, copySent: p?.copySent ?? true, ...(p?.loopback ? { loopback: true } : {}) } };
    const provider = new ImapMail({ address, ...info.imap! }, () => password, { ...this.#o.imap, onFingerprint: (fp) => (info.imap!.fingerprint = fp) });
    return { info, password, provider, users };
  }

  saveImap(info: Stored, password: string): MailAccountInfo {
    this.#assertOn();
    const list = this.#stored().filter((x) => !(x.kind === 'imap' && x.address === info.address));
    this.#vault.set(imapPasswordVault(info.id), password);
    this.#save([...list, info]);
    this.#providers.delete(info.id);
    this.#changed();
    const { imap: _i, ...pub } = info;
    void _i;
    return pub;
  }

  /** Removes an account and its secrets (Google: use the Google page). */
  async remove(id: string): Promise<void> {
    // MULTIMAIL: a later Google account is signed out here (the first one on its own page, as before).
    if (/^google:\d+$/.test(id) && this.#o.googles) {
      await this.#o.googles.remove(id);
      this.#forgetView(id);
      this.#changed();
      return;
    }
    if (id === 'google') throw new Error('Sign out of Google on its own page.');
    // Removing works even while the admin's policy has members' mail off (their secrets go).
    const s = this.#raw().find((x) => x.id === id);
    if (!s) throw new Error('There is no such account.');
    await this.#providers.get(id)?.close?.().catch(() => undefined);
    this.#providers.delete(id);
    if (s.kind === 'microsoft') this.ms.forget(id);
    this.#vault.delete(imapPasswordVault(id));
    this.#save(this.#raw().filter((x) => x.id !== id));
    if (this.#vault.get(DEFAULT_VAULT) === id) this.#vault.delete(DEFAULT_VAULT);
    this.#forgetView(id);
    this.#changed();
  }
  #forgetView(id: string): void {
    if (this.#vault.get(DEFAULT_VAULT) === id) this.#vault.delete(DEFAULT_VAULT);
    const v = this.view();
    if (!this.#o.viewFile || !existsSync(this.#o.viewFile)) return;
    const cals = { ...(v.calendars ?? {}) };
    delete cals[id];
    const next: MailView = { ...v, off: (v.off ?? []).filter((x) => x !== id), calendars: cals };
    if (next.calendarDefault?.split('|')[0] === id) delete next.calendarDefault;
    writeFileSync(this.#o.viewFile, JSON.stringify(next, null, 1));
  }

  // ---------- MULTIMAIL: CalDAV and the combined views ----------

  #calDav(s: Stored): CalDav {
    return new CalDav(s.caldav!, () => this.#vault.get(imapPasswordVault(s.id)), { ...(this.#o.caldav?.fetch ? { fetch: this.#o.caldav.fetch } : {}), chosen: () => this.chosenCalendars(s.id) });
  }
  /** Where an IMAP account's provider keeps CalDAV (undefined: none Sara knows, e.g. Gmail app passwords). */
  calDavUrl(id: string): string | undefined {
    const s = this.#raw().find((x) => x.id === id);
    return s?.kind === 'imap' ? (s.caldav?.url ?? CALDAV_PRESETS[s.provider]) : undefined;
  }
  /** Turns on an IMAP account's calendar: finds its calendars with the same app password, then saves. */
  async enableCalendar(id: string, url?: string, signal?: AbortSignal): Promise<MailAccountInfo> {
    this.#assertOn();
    const s = this.#raw().find((x) => x.id === id);
    if (!s || s.kind !== 'imap' || !s.imap) throw new Error('There is no such account.');
    const base = url?.trim() || this.calDavUrl(id);
    if (!base) throw new Error(s.provider === 'gmail' ? 'A Gmail app password can\'t open Google Calendar. Sign in with Google instead (Add another → Google) for the calendar.' : 'Sara doesn\'t know a calendar address for this provider. Type its CalDAV address.');
    if (!/^https:\/\//.test(base) && !(this.#o.caldav?.fetch && /^http:\/\/127\.0\.0\.1:\d+\//.test(base))) throw new Error('The calendar address starts with https://.');
    const cfg: CalDavConfig = { url: base, user: s.imap.user };
    const cd = new CalDav(cfg, () => this.#vault.get(imapPasswordVault(id)), this.#o.caldav?.fetch ? { fetch: this.#o.caldav.fetch } : {});
    await cd.discover(signal);
    this.#update(id, (x) => ({ ...x, calendar: true, caldav: cfg }));
    this.#providers.delete(id);
    this.#changed();
    return this.list().find((x) => x.id === id)!;
  }
  /** Turns an IMAP account's calendar off again (mail stays). */
  disableCalendar(id: string): void {
    this.#update(id, (x) => {
      const { caldav: _c, ...rest } = x;
      void _c;
      return { ...rest, calendar: false };
    });
    this.#providers.delete(id);
    this.#changed();
  }

  view(): MailView {
    const f = this.#o.viewFile;
    if (!f || !existsSync(f)) return {};
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as MailView;
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }
  setView(patch: Partial<MailView>): MailView {
    const f = this.#o.viewFile;
    if (!f) throw new Error('Not available here.');
    const ids = new Set(this.list().map((a) => a.id));
    const next: MailView = { ...this.view() };
    if (patch.off !== undefined) next.off = [...new Set((Array.isArray(patch.off) ? patch.off : []).map(String))].filter((x) => ids.has(x));
    if (patch.calendars !== undefined) {
      const cals = { ...(next.calendars ?? {}) };
      for (const [k, v] of Object.entries(patch.calendars ?? {})) {
        if (!ids.has(k) && !this.googleOf(k)) continue;
        if (v === false) cals[k] = false;
        else if (Array.isArray(v)) cals[k] = [...new Set(v.map(String))].slice(0, 50);
        else delete cals[k];
      }
      next.calendars = cals;
    }
    if (patch.calendarDefault !== undefined) {
      const d = String(patch.calendarDefault ?? '');
      if (d && !ids.has(d.split('|')[0]) && !this.googleOf(d.split('|')[0])) throw new Error('There is no such calendar.');
      if (d) next.calendarDefault = d;
      else delete next.calendarDefault;
    }
    writeFileSync(f, JSON.stringify(next, null, 1));
    this.#changed();
    return next;
  }
  /** The accounts in the combined inbox, Today's Mail and "waiting for my answer" (signed-in ones). */
  combined(): MailAccountInfo[] {
    const off = new Set(this.view().off ?? []);
    return this.list().filter((a) => !a.problem && !off.has(a.id));
  }
  /** The calendars chosen for an account (undefined: the account's usual ones; [] when hidden). */
  chosenCalendars(id: string): string[] | undefined {
    const v = this.view().calendars?.[id];
    return v === false ? [] : v;
  }
  /** The calendars found for a CalDAV account (from its last discovery). */
  calDavCalendars(id: string): { id: string; name: string }[] {
    return this.#raw().find((x) => x.id === id)?.caldav?.calendars ?? [];
  }

  /** Any mailbox besides Google (the neutral tools and the page show). */
  hasOthers(): boolean {
    return this.#stored().length > 0;
  }
}

// M1: one person's mailboxes. Google is the account "google" whenever it is signed in (its own code,
// src/google.ts; the owner's only); Microsoft and IMAP accounts are listed here. The list holds no
// secrets (tokens and app passwords are separate vault entries). The owner's list lives in the
// server's vault; each household member has their own list in their own vault (members/<id>/mail),
// which nobody else's tools, Today or routes ever open. The demo has none; private conversations
// get no mail tools; an admin policy can switch members' mail off (`memberMail: false`).
import { randomBytes } from 'node:crypto';
import type { GoogleAccount } from '../google.ts';
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
}

export interface AccountsOpts {
  ms?: MsOpts;
  imap?: Omit<ImapOpts, 'onFingerprint'>;
  /** A member's mailboxes: true while the admin's policy switches members' mail off (nothing listed, nothing added). */
  off?: () => boolean;
}

/** Which person's accounts a Microsoft sign-in belongs to (the callback route asks by `state`). */
const OF_AUTH = new WeakMap<MicrosoftAuth, MailAccounts>();
export const mailAccountsForState = (state: string): MailAccounts | undefined => {
  const auth = msAuthForState(state);
  return auth ? OF_AUTH.get(auth) : undefined;
};
export const MEMBER_MAIL_OFF = 'Your admin switched off mailboxes for household members on this server.';

export class MailAccounts {
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

  /** Every connected mailbox, Google first. No secrets. */
  list(): MailAccountInfo[] {
    const out: MailAccountInfo[] = [];
    const g = this.#google?.status();
    if (g?.connected && g.gmail) out.push({ id: 'google', kind: 'google', provider: 'google', address: g.email ?? 'Gmail', addedAt: '', calendar: g.calendar });
    for (const s of this.#stored()) {
      const { imap: _imap, ...info } = s;
      void _imap;
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
      p = new ImapMail({ address: s.address, ...s.imap }, () => this.#vault.get(imapPasswordVault(s.id)), {
        ...this.#o.imap,
        onFingerprint: (fp) => this.#update(s.id, (x) => (x.imap ? { ...x, imap: { ...x.imap, fingerprint: fp } } : x)),
      });
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
    const info: Stored = { id, kind: 'microsoft', provider: 'microsoft', address: t.address, addedAt: old?.addedAt ?? new Date().toISOString(), calendar: /Calendars\.ReadWrite/i.test(t.scopes) };
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
    this.#changed();
  }

  /** Any mailbox besides Google (the neutral tools and the page show). */
  hasOthers(): boolean {
    return this.#stored().length > 0;
  }
}

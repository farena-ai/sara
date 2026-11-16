// MULTIMAIL (docs/MAIL_ACCOUNTS.md): several Google sign-ins through the owner's one Google app.
// The first stays the account "google" (vault 'google:token', exactly as before); each one added later
// is "google:<n>" with its own vault entry 'google:token:<n>' and its own permissions (Gmail, Calendar,
// optional Docs/Sheets). Removing one never touches the others. The list holds numbers only (no
// addresses: every vault string is hidden in logs). Household members keep their own mailboxes
// (Outlook, IMAP); the Google sign-in stays the owner's.
import { GoogleAccount, type GoogleStatus } from './google.ts';
import type { Vault } from './vault.ts';

export const GOOGLE_EXTRA_VAULT = 'google:accounts';
export const googleTokenVault = (n: number): string => `google:token:${n}`;
const MAX_EXTRA = 9;

type Opts = ConstructorParameters<typeof GoogleAccount>[1];

export class GoogleAccounts {
  readonly primary: GoogleAccount;
  readonly #vault: Vault;
  readonly #opts: Opts;
  readonly #extra = new Map<number, GoogleAccount>();
  /** Sign-ins for a new slot that haven't come back yet (10 minutes, like the PKCE state). */
  readonly #slots = new Map<number, { g: GoogleAccount; at: number }>();
  /** main.ts: Today caches and the tool maps forget the old list. */
  onChange?: () => void;

  constructor(vault: Vault, primary: GoogleAccount, opts: Opts = {}) {
    this.#vault = vault;
    this.primary = primary;
    this.#opts = opts;
  }

  #nums(): number[] {
    try {
      const j = JSON.parse(this.#vault.get(GOOGLE_EXTRA_VAULT) ?? '{}') as { n?: unknown };
      return Array.isArray(j.n) ? j.n.filter((x): x is number => Number.isInteger(x) && x >= 2 && x <= 99) : [];
    } catch {
      return [];
    }
  }
  #saveNums(n: number[]): void {
    if (n.length) this.#vault.set(GOOGLE_EXTRA_VAULT, JSON.stringify({ n: [...new Set(n)].sort((a, b) => a - b) }));
    else this.#vault.delete(GOOGLE_EXTRA_VAULT);
  }
  #make(n: number): GoogleAccount {
    return new GoogleAccount(this.#vault, { ...this.#opts, tokenKey: googleTokenVault(n), id: `google:${n}` });
  }
  #of(n: number): GoogleAccount {
    let g = this.#extra.get(n);
    if (!g) this.#extra.set(n, (g = this.#make(n)));
    return g;
  }

  /** Every Google account with a sign-in, the first one first. */
  all(): GoogleAccount[] {
    const out: GoogleAccount[] = [];
    if (this.primary.status().connected) out.push(this.primary);
    for (const n of this.#nums()) {
      const g = this.#of(n);
      if (g.status().connected) out.push(g);
    }
    return out;
  }
  /** Each signed-in account with its status (for the Settings page). */
  list(): (GoogleStatus & { id: string })[] {
    return this.all().map((g) => ({ ...g.status(), id: g.id }));
  }
  /** An account by id ('google', 'google:2') or address. */
  get(id: string): GoogleAccount | undefined {
    if (id === 'google') return this.primary;
    const m = /^google:(\d{1,2})$/.exec(id);
    if (m) return this.#nums().includes(Number(m[1])) ? this.#of(Number(m[1])) : undefined;
    const a = id.trim().toLowerCase();
    return this.all().find((g) => g.status().email?.toLowerCase() === a);
  }

  /**
   * The Google consent address. `add`: another account (a new slot, chosen on Google's account
   * picker) when the first one is already signed in; otherwise the first one, as before.
   */
  authUrl(redirect: string, opts: { docs?: boolean; add?: boolean; id?: string } = {}): string {
    if (opts.id && opts.id !== 'google') {
      const g = this.get(opts.id);
      if (!g) throw new Error('There is no such Google account.');
      return g.authUrl(redirect, { ...(opts.docs ? { docs: true } : {}), choose: true });
    }
    if (!opts.add || !this.primary.status().connected) return this.primary.authUrl(redirect, opts.docs ? { docs: true } : {});
    const used = new Set([...this.#nums(), ...this.#slots.keys()]);
    if (this.#nums().length >= MAX_EXTRA) throw new Error('That is the most Google accounts Sara keeps (10). Remove one first.');
    let n = 2;
    while (used.has(n)) n++;
    const g = this.#make(n);
    const url = g.authUrl(redirect, { ...(opts.docs ? { docs: true } : {}), choose: true });
    this.#slots.set(n, { g, at: Date.now() });
    return url;
  }

  /**
   * Google came back with a code: the account that started it finishes. A new slot whose address
   * is already signed in replaces that account's sign-in (no duplicates); otherwise it joins the list.
   */
  async finish(code: string, state: string): Promise<GoogleStatus & { id: string }> {
    for (const [n, s] of this.#slots) if (Date.now() - s.at > 10 * 60_000) this.#slots.delete(n);
    for (const [n, s] of this.#slots) {
      if (!s.g.hasPending(state)) continue;
      this.#slots.delete(n);
      const st = await s.g.finish(code, state);
      const email = st.email?.toLowerCase();
      const same = email ? this.all().find((x) => x !== s.g && x.status().email?.toLowerCase() === email) : undefined;
      if (same) {
        const raw = s.g.takeTokens();
        if (raw) same.putTokens(raw);
        this.#changed();
        return { ...same.status(), id: same.id };
      }
      this.#extra.set(n, s.g);
      this.#saveNums([...this.#nums(), n]);
      this.#changed();
      return { ...st, id: s.g.id };
    }
    const g = [this.primary, ...this.#nums().map((n) => this.#of(n))].find((x) => x.hasPending(state)) ?? this.primary;
    const st = await g.finish(code, state);
    this.#changed();
    return { ...st, id: g.id };
  }

  /** Signs one account out (its sign-in is revoked at Google); the others stay. */
  async remove(id: string): Promise<void> {
    if (id === 'google') {
      await this.primary.disconnect();
      this.#changed();
      return;
    }
    const m = /^google:(\d{1,2})$/.exec(id);
    const n = m ? Number(m[1]) : NaN;
    if (!this.#nums().includes(n)) throw new Error('There is no such account.');
    await this.#of(n).disconnect();
    this.#extra.delete(n);
    this.#saveNums(this.#nums().filter((x) => x !== n));
    this.#changed();
  }

  /** The Google app changed or was removed: every later sign-in goes too (they belonged to the old app). */
  forgetExtras(): void {
    for (const n of this.#nums()) this.#of(n).takeTokens();
    this.#extra.clear();
    this.#saveNums([]);
    this.#changed();
  }

  #changed(): void {
    try {
      this.onChange?.();
    } catch {
      /* caches refresh on their own */
    }
  }
}

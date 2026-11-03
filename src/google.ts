// Phase 14: Gmail and Google Calendar through Google's official APIs, signed in with the owner's
// own Google OAuth client (made once in Google Cloud Console; Settings → Add-ons → Gmail and Calendar walks through
// it). Nothing goes through anyone else's servers. Tokens live in the encrypted vault and are
// renewed automatically. Reading is allowed; drafting, sending and adding events ask first.
import { netFetch } from './net-guard.ts';
import { createHash, randomBytes } from 'node:crypto';
import type { Vault } from './vault.ts';

export const GOOGLE_CLIENT_VAULT = 'google:client';
export const GOOGLE_TOKEN_VAULT = 'google:token';
// gmail.modify (organizing: archive, read/unread, labels, trash, spam; never permanent delete) is
// a restricted scope: fine for the owner's own OAuth client with the owner as a test user (or
// published unverified for personal use). Sign-ins from before it was added lack it (`canOrganize`).
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'];
/**
 * Test-only: send Gmail/Calendar API calls to a local fake Google instead (SARA_GOOGLE_API_BASE,
 * e.g. http://127.0.0.1:7899). Only loopback addresses are accepted, so it can never point Sara's
 * Google sign-in at someone else's server.
 */
export function googleApiBase(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.SARA_GOOGLE_API_BASE?.trim().replace(/\/+$/, '');
  return v && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(v) ? v : undefined;
}
/** A Google API answer that wasn't OK (the HTTP status lets callers back off on 429 / 5xx). */
export class GoogleApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

interface Client {
  clientId: string;
  clientSecret: string;
}
interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  email?: string;
  scopes?: string;
}

export interface GoogleStatus {
  /** Client ID/secret saved. */
  configured: boolean;
  clientId?: string;
  connected: boolean;
  email?: string;
  /** Which parts the sign-in allowed (the owner can untick boxes on Google's page). */
  gmail: boolean;
  calendar: boolean;
  /** Organizing mail (archive, labels, read, trash, spam) needs gmail.modify: older sign-ins lack it. */
  canOrganize: boolean;
}

type Fetch = typeof fetch;

export class GoogleAccount {
  readonly #vault: Vault;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  /** Sign-ins in progress: state → PKCE verifier + redirect address (10 minutes). */
  readonly #pending = new Map<string, { verifier: string; redirect: string; at: number }>();

  readonly #base: string | undefined;

  constructor(vault: Vault, opts: { fetch?: Fetch; now?: () => number; apiBase?: string } = {}) {
    this.#vault = vault;
    this.#fetch = opts.fetch ?? netFetch;
    this.#now = opts.now ?? Date.now;
    this.#base = opts.apiBase;
  }

  #client(): Client | undefined {
    const raw = this.#vault.get(GOOGLE_CLIENT_VAULT);
    return raw ? (JSON.parse(raw) as Client) : undefined;
  }
  #tokens(): Tokens | undefined {
    const raw = this.#vault.get(GOOGLE_TOKEN_VAULT);
    return raw ? (JSON.parse(raw) as Tokens) : undefined;
  }

  status(): GoogleStatus {
    const c = this.#client();
    const t = this.#tokens();
    const scopes = t?.scopes ?? '';
    return {
      configured: Boolean(c),
      ...(c ? { clientId: c.clientId } : {}),
      connected: Boolean(t),
      ...(t?.email ? { email: t.email } : {}),
      gmail: Boolean(t) && (scopes.includes('gmail.readonly') || scopes.includes('gmail.modify')),
      calendar: Boolean(t) && scopes.includes('calendar.events'),
      canOrganize: Boolean(t) && scopes.includes('gmail.modify'),
    };
  }

  setClient(clientId: string, clientSecret: string): void {
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('The Client ID ends with .apps.googleusercontent.com. Copy it from Google Cloud Console → Credentials.');
    if (clientSecret.length < 10) throw new Error('Paste the Client secret too (it starts with GOCSPX-).');
    this.#vault.set(GOOGLE_CLIENT_VAULT, JSON.stringify({ clientId, clientSecret }));
    // A different app means the old sign-in no longer matches.
    this.#vault.delete(GOOGLE_TOKEN_VAULT);
  }

  /** The address to send the owner to. `redirect` must be registered in the Google app. */
  authUrl(redirect: string): string {
    const c = this.#client();
    if (!c) throw new Error('Add your Google app (Client ID and secret) first.');
    for (const [k, v] of this.#pending) if (this.#now() - v.at > 10 * 60_000) this.#pending.delete(k);
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.#pending.set(state, { verifier, redirect, at: this.#now() });
    const q = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Google sent the owner back with a code: trade it for tokens. */
  async finish(code: string, state: string): Promise<GoogleStatus> {
    const p = this.#pending.get(state);
    this.#pending.delete(state);
    if (!p || this.#now() - p.at > 10 * 60_000) throw new Error('That sign-in link expired. Start again from Settings.');
    const c = this.#client();
    if (!c) throw new Error('The Google app was removed.');
    const j = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, code_verifier: p.verifier, client_id: c.clientId, client_secret: c.clientSecret });
    if (!j.refresh_token) throw new Error('Google did not give a long-lived sign-in. Remove Sara at myaccount.google.com → Security → Third-party access, then try again.');
    const tokens: Tokens = { access: j.access_token, refresh: j.refresh_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, scopes: j.scope ?? '' };
    this.#vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify(tokens));
    try {
      const prof = (await this.api('https://gmail.googleapis.com/gmail/v1/users/me/profile')) as { emailAddress?: string };
      if (prof.emailAddress) this.#vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify({ ...tokens, email: prof.emailAddress }));
    } catch {
      /* Gmail not allowed: the email address just isn't shown */
    }
    return this.status();
  }

  async #token(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    const r = await this.#fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!r.ok || !j.access_token) {
      if (j.error === 'invalid_grant') {
        this.#vault.delete(GOOGLE_TOKEN_VAULT);
        throw new Error('Google signed Sara out (the sign-in expired or was removed). Sign in again in Settings → Add-ons → Gmail and Calendar.');
      }
      throw new Error(`Google sign-in failed: ${j.error_description ?? j.error ?? r.status}`);
    }
    return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), ...(j.scope ? { scope: j.scope } : {}) };
  }

  async #access(): Promise<string> {
    const t = this.#tokens();
    if (!t) throw new Error('Google is not connected (Settings → Add-ons → Gmail and Calendar).');
    if (t.expiresAt > this.#now()) return t.access;
    const c = this.#client();
    if (!c) throw new Error('The Google app was removed.');
    const j = await this.#token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: c.clientId, client_secret: c.clientSecret });
    const next: Tokens = { ...t, access: j.access_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, ...(j.refresh_token ? { refresh: j.refresh_token } : {}) };
    this.#vault.set(GOOGLE_TOKEN_VAULT, JSON.stringify(next));
    return next.access;
  }

  /** One call to a Google API (JSON in, JSON out). */
  async api(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const access = await this.#access();
    if (this.#base) url = url.replace(/^https:\/\/(gmail|www)\.googleapis\.com/, this.#base);
    const r = await this.#fetch(url, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${access}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (r.status === 204) return {};
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
    if (!r.ok) {
      if (r.status === 403 && /insufficient|scope/i.test(j.error?.message ?? '')) throw new GoogleApiError("The Google sign-in didn't allow this. Sign in again and leave all the boxes ticked.", 403);
      throw new GoogleApiError(`Google: ${j.error?.message ?? r.status}`, r.status);
    }
    return j;
  }

  async disconnect(): Promise<void> {
    const t = this.#tokens();
    this.#vault.delete(GOOGLE_TOKEN_VAULT);
    if (t) await this.#fetch(`${REVOKE_URL}?token=${encodeURIComponent(t.refresh)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  }

  forgetClient(): void {
    this.#vault.delete(GOOGLE_CLIENT_VAULT);
    this.#vault.delete(GOOGLE_TOKEN_VAULT);
  }
}

// ---------- small helpers for the Gmail message format ----------

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export const header = (p: GmailPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** The readable text of a message: plain text if there is some, else the HTML made plain. */
export function messageText(p: GmailPart): string {
  const find = (part: GmailPart, type: string): string | undefined => {
    if (part.mimeType === type && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
    for (const c of part.parts ?? []) {
      const t = find(c, type);
      if (t) return t;
    }
    return undefined;
  };
  const plain = find(p, 'text/plain');
  if (plain) return plain.replace(/\r\n/g, '\n').trim();
  const html = find(p, 'text/html') ?? '';
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function attachments(p: GmailPart): string[] {
  const out: string[] = [];
  const walk = (x: GmailPart) => {
    if (x.filename) out.push(x.filename);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  return out;
}

const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** A plain-text email in the format Gmail's API takes (base64url of the RFC 5322 text). */
export function rawEmail(m: { to: string; cc?: string; subject: string; body: string; inReplyTo?: string; references?: string }): string {
  const lines = [
    `To: ${oneLine(m.to)}`,
    ...(m.cc ? [`Cc: ${oneLine(m.cc)}`] : []),
    `Subject: ${encWord(oneLine(m.subject))}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`, `References: ${oneLine(m.references ?? m.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.body.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

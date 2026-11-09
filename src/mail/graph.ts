// M1: Outlook.com / Hotmail / Live / Microsoft 365 through Microsoft Graph, signed in with an app
// the owner registers in the Microsoft Entra admin center (free; nothing goes through anyone
// else's servers). OAuth 2.0 authorization code + PKCE (S256), one-time `state`, refresh tokens in
// the vault (Microsoft rotates them: the new one is saved every time). Basic-auth IMAP is switched
// off for outlook.com, so Graph is the way in.
//
// Graph semantics, mapped honestly (docs/ops/MAIL_PROVIDERS_DESIGN.md): folders and categories
// instead of labels, a flag instead of a star, the Junk Email folder for spam, Deleted Items for
// trash. There is no permanent delete anywhere in this file (no DELETE on a message, no
// permanentDelete); the only DELETE is a calendar event the owner approved.
import { createHash, randomBytes } from 'node:crypto';
import { netFetch } from '../net-guard.ts';
import type { Vault } from '../vault.ts';
import { toGraph, type SearchTerms } from './search.ts';
import type { ApplyResult, Before, CalendarEventIn, CalendarEventOut, Draft, Folder, MailAction, MailMessage, MailProvider } from './types.ts';

export const MS_CLIENT_VAULT = 'mail:ms:client';
export const msTokenVault = (id: string): string => `mail:ms:${id}:token`;
export const MS_SCOPES = ['offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'];
const LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Test-only: a loopback fake for Graph and the sign-in (SARA_MS_GRAPH_BASE / SARA_MS_LOGIN_BASE). */
export function msBases(env: Record<string, string | undefined> = process.env): { graph?: string; login?: string } {
  const ok = (v?: string) => {
    const s = v?.trim().replace(/\/+$/, '');
    return s && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/[\w/.-]*)?$/.test(s) ? s : undefined;
  };
  const graph = ok(env.SARA_MS_GRAPH_BASE);
  const login = ok(env.SARA_MS_LOGIN_BASE);
  return { ...(graph ? { graph } : {}), ...(login ? { login } : {}) };
}

export class GraphError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
  }
}

interface Client {
  clientId: string;
  clientSecret?: string;
}
export interface MsTokens {
  access: string;
  refresh: string;
  expiresAt: number;
  scopes: string;
  address: string;
}

/**
 * Only the secrets go in the vault entry: every string in a vault JSON value is hidden as a secret
 * everywhere (redact.ts), so the address there turned the mailbox into [REDACTED] on approval cards.
 * The address and the calendar flag live in the account list.
 */
const vaultTokens = (t: Pick<MsTokens, 'access' | 'refresh' | 'expiresAt'>): string => JSON.stringify({ access: t.access, refresh: t.refresh, expiresAt: t.expiresAt });

type Fetch = typeof fetch;
export interface MsOpts {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  graphBase?: string;
  loginBase?: string;
  /**
   * A household member's sign-ins: the Microsoft app is the owner's (read from this vault, never
   * changed from the member's space); the member's tokens stay in their own vault.
   */
  clientVault?: Vault;
}

/** Sign-ins waiting for Microsoft's answer, by `state` (the callback route finds whose it is). */
const WAITING = new Map<string, MicrosoftAuth>();
/** The sign-in (owner's or a member's) that made this `state`, while it is waiting. */
export const msAuthForState = (state: string): MicrosoftAuth | undefined => WAITING.get(state);

/** The owner's Microsoft app (one per server) and the sign-ins made with it (the owner's or a member's). */
export class MicrosoftAuth {
  readonly #vault: Vault;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #login: string;
  readonly graph: string;
  readonly #pending = new Map<string, { verifier: string; redirect: string; at: number }>();
  readonly #clientVault: Vault;
  /** A member's sign-ins use the owner's app and can't change it. */
  readonly member: boolean;

  constructor(vault: Vault, opts: MsOpts = {}) {
    this.#vault = vault;
    this.#clientVault = opts.clientVault ?? vault;
    this.member = Boolean(opts.clientVault);
    this.#fetch = opts.fetch ?? netFetch;
    this.#now = opts.now ?? Date.now;
    this.#login = opts.loginBase ?? LOGIN;
    this.graph = opts.graphBase ?? GRAPH;
  }

  #client(): Client | undefined {
    const raw = this.#clientVault.get(MS_CLIENT_VAULT);
    return raw ? (JSON.parse(raw) as Client) : undefined;
  }
  clientId(): string | undefined {
    return this.#client()?.clientId;
  }

  setClient(clientId: string, clientSecret: string): void {
    if (this.member) throw new Error('Only the owner of this server can set up the Microsoft app.');
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) throw new Error('The Application (client) ID looks like 1a2b3c4d-…-…: copy it from the app\'s Overview page in the Microsoft Entra admin center.');
    if (clientSecret && clientSecret.length < 10) throw new Error('Paste the client secret\'s Value (not its Secret ID).');
    this.#vault.set(MS_CLIENT_VAULT, JSON.stringify({ clientId, ...(clientSecret ? { clientSecret } : {}) }));
  }
  forgetClient(): void {
    if (this.member) throw new Error('Only the owner of this server can set up the Microsoft app.');
    this.#vault.delete(MS_CLIENT_VAULT);
  }

  authUrl(redirect: string, loginHint?: string): string {
    const c = this.#client();
    if (!c) throw new Error('Add your Microsoft app (Application ID and secret) first.');
    for (const [k, v] of this.#pending) {
      if (this.#now() - v.at <= 10 * 60_000) continue;
      this.#pending.delete(k);
      if (WAITING.get(k) === this) WAITING.delete(k);
    }
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.#pending.set(state, { verifier, redirect, at: this.#now() });
    WAITING.set(state, this);
    const q = new URLSearchParams({
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: redirect,
      response_mode: 'query',
      scope: MS_SCOPES.join(' '),
      state,
      prompt: 'select_account',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    return `${this.#login}/authorize?${q}`;
  }

  /** Microsoft sent the owner back: trade the code (once, within 10 minutes) for tokens. */
  async finish(code: string, state: string): Promise<MsTokens> {
    const p = this.#pending.get(state);
    this.#pending.delete(state);
    if (WAITING.get(state) === this) WAITING.delete(state);
    if (!p || this.#now() - p.at > 10 * 60_000) throw new Error('That sign-in link expired. Start again from Settings.');
    const c = this.#client();
    if (!c) throw new Error('The Microsoft app was removed.');
    const j = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, code_verifier: p.verifier, client_id: c.clientId, scope: MS_SCOPES.join(' '), ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) });
    if (!j.refresh_token) throw new Error('Microsoft did not give a long-lived sign-in (offline_access). Add it under API permissions and try again.');
    const t: MsTokens = { access: j.access_token, refresh: j.refresh_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, scopes: j.scope ?? '', address: '' };
    const me = (await this.#get(`${this.graph}/me?$select=mail,userPrincipalName`, t.access)) as { mail?: string; userPrincipalName?: string };
    t.address = String(me.mail || me.userPrincipalName || '').toLowerCase();
    if (!t.address) throw new Error('Microsoft did not say which address this is.');
    return t;
  }

  async #get(url: string, access: string): Promise<unknown> {
    const r = await this.#fetch(url, { headers: { authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!r.ok) throw new GraphError(`Microsoft: ${j.error?.message ?? r.status}`, r.status);
    return j;
  }

  async #token(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    const r = await this.#fetch(`${this.#login}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!r.ok || !j.access_token) {
      // Only the first line of Microsoft's description (it carries trace and correlation ids).
      const why = (j.error_description ?? '').split(/\r?\n/)[0].replace(/^AADSTS\d+:\s*/, '').slice(0, 200);
      if (j.error === 'invalid_grant') throw new SignedOut(why);
      throw new Error(`Microsoft sign-in failed: ${why || j.error || r.status}`);
    }
    return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), ...(j.scope ? { scope: j.scope } : {}) };
  }

  /** A fresh access token for one account (renewed and saved when it expired). */
  async access(accountId: string): Promise<string> {
    const raw = this.#vault.get(msTokenVault(accountId));
    if (!raw) throw new SignedOut('');
    const t = JSON.parse(raw) as MsTokens;
    if (t.expiresAt > this.#now()) return t.access;
    const c = this.#client();
    if (!c) throw new Error('The Microsoft app was removed (Settings → Email and calendar).');
    try {
      const j = await this.#token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: c.clientId, scope: MS_SCOPES.join(' '), ...(c.clientSecret ? { client_secret: c.clientSecret } : {}) });
      const next: MsTokens = { ...t, access: j.access_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, ...(j.refresh_token ? { refresh: j.refresh_token } : {}), ...(j.scope ? { scopes: j.scope } : {}) };
      this.#vault.set(msTokenVault(accountId), vaultTokens(next));
      return next.access;
    } catch (err) {
      if (err instanceof SignedOut) this.#vault.delete(msTokenVault(accountId));
      throw err;
    }
  }

  saveTokens(accountId: string, t: MsTokens): void {
    this.#vault.set(msTokenVault(accountId), vaultTokens(t));
  }
  hasTokens(accountId: string): boolean {
    return this.#vault.has(msTokenVault(accountId));
  }
  forget(accountId: string): void {
    // Microsoft has no token revocation endpoint for personal accounts: removing the token here and
    // the app's consent at account.live.com/consent/Manage ends it.
    this.#vault.delete(msTokenVault(accountId));
  }
}

/** The sign-in was revoked or expired: the owner signs in again. */
export class SignedOut extends Error {
  constructor(why: string) {
    super(`Microsoft signed Sara out${why ? ` (${why})` : ''}. Sign in again in Settings → Email and calendar.`);
    this.name = 'SignedOut';
  }
}

type GMsg = {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  importance?: 'low' | 'normal' | 'high';
  categories?: string[];
  parentFolderId?: string;
  inferenceClassification?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  body?: { contentType?: string; content?: string };
};
const LIST_FIELDS = 'id,conversationId,subject,bodyPreview,receivedDateTime,isRead,flag,hasAttachments,importance,categories,parentFolderId,inferenceClassification,from,toRecipients,ccRecipients,internetMessageId';
const who = (a?: { emailAddress?: { name?: string; address?: string } }) => (a?.emailAddress ? (a.emailAddress.name && a.emailAddress.name !== a.emailAddress.address ? `${a.emailAddress.name} <${a.emailAddress.address ?? ''}>` : (a.emailAddress.address ?? '')) : '');
const recips = (s: string) =>
  s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter((x) => /@/.test(x))
    .map((x) => ({ emailAddress: { address: (/<([^>]+)>/.exec(x)?.[1] ?? x).trim() } }));

/** One Outlook / Microsoft 365 mailbox (and its calendar). */
export class GraphMail implements MailProvider {
  readonly kind = 'microsoft' as const;
  readonly #auth: MicrosoftAuth;
  readonly #id: string;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly address: string;
  #wk = new Map<string, string>();

  constructor(auth: MicrosoftAuth, accountId: string, address: string, opts: MsOpts = {}) {
    this.#auth = auth;
    this.#id = accountId;
    this.address = address;
    this.#fetch = opts.fetch ?? netFetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One Graph call (JSON), again after Retry-After on 429 / 503 / 504 (five tries). Ids are immutable. */
  async call(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${this.#auth.graph}${path}`;
    for (let i = 0; ; i++) {
      const access = await this.#auth.access(this.#id);
      const r = await this.#fetch(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${access}`, prefer: 'IdType="ImmutableId", outlook.body-content-type="text"', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      if (r.status === 202 || r.status === 204) return {};
      const j = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      if (r.ok) return j;
      if ((r.status === 429 || r.status === 503 || r.status === 504) && i < 4 && !init.signal?.aborted) {
        const after = Number(r.headers.get('retry-after'));
        await this.#sleep(Math.min(60, Number.isFinite(after) && after > 0 ? after : 2 ** i) * 1000);
        continue;
      }
      if (r.status === 403 && /scope|denied|insufficient/i.test(`${j.error?.code} ${j.error?.message}`)) throw new GraphError("The Microsoft sign-in didn't allow this. Sign in again and accept every permission.", 403);
      throw new GraphError(`Microsoft: ${j.error?.message ?? r.status}`, r.status);
    }
  }

  async #wellKnown(name: string, signal?: AbortSignal): Promise<string> {
    const hit = this.#wk.get(name);
    if (hit) return hit;
    const f = (await this.call(`/me/mailFolders/${name}?$select=id`, { ...(signal ? { signal } : {}) })) as { id: string };
    this.#wk.set(name, f.id);
    return f.id;
  }
  async #folderByName(name: string, signal?: AbortSignal): Promise<string> {
    const all = await this.folders(signal);
    const f = all.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!f) throw new GraphError(`There is no folder called "${name}". Folders: ${all.map((x) => x.name).join(', ')}`, 404);
    return f.id;
  }

  #msg(m: GMsg, folderNames?: Map<string, string>): MailMessage {
    const h: Record<string, string> = {};
    for (const x of m.internetMessageHeaders ?? []) h[x.name.toLowerCase()] = x.value;
    if (m.internetMessageId) h['message-id'] ??= m.internetMessageId;
    return {
      id: m.id,
      threadId: m.conversationId ?? m.id,
      from: who(m.from),
      to: (m.toRecipients ?? []).map(who).join(', '),
      ...(m.ccRecipients?.length ? { cc: m.ccRecipients.map(who).join(', ') } : {}),
      subject: m.subject ?? '',
      date: m.receivedDateTime ?? '',
      snippet: (m.bodyPreview ?? '').slice(0, 240),
      unread: m.isRead === false,
      flagged: m.flag?.flagStatus === 'flagged',
      ...(m.parentFolderId && folderNames?.get(m.parentFolderId) ? { folder: folderNames.get(m.parentFolderId)! } : {}),
      headers: h,
      ...(m.categories?.length ? { categories: m.categories } : {}),
      ...(m.inferenceClassification ? { focused: m.inferenceClassification === 'focused' } : {}),
      ...(m.importance ? { importance: m.importance } : {}),
    };
  }

  async searchIds(terms: SearchTerms, cap: number, signal?: AbortSignal): Promise<{ ids: string[]; capped: boolean }> {
    const g = toGraph(terms);
    const sig = signal ? { signal } : {};
    const folderId = g.folder ? (g.folder.wellKnown ? await this.#wellKnown(g.folder.wellKnown, signal) : await this.#folderByName(g.folder.name!, signal)) : undefined;
    // Gmail leaves trash and spam out unless asked: so does this.
    const skip = folderId ? new Set<string>() : new Set(await Promise.all(['deleteditems', 'junkemail'].map((n) => this.#wellKnown(n, signal).catch(() => ''))));
    const q = new URLSearchParams({ $select: 'id,receivedDateTime,isRead,flag,hasAttachments,importance,categories,from,parentFolderId', $top: g.search ? '250' : '500' });
    if (g.search) q.set('$search', g.search);
    else if (g.filter) q.set('$filter', g.filter);
    let next: string | undefined = `${folderId ? `/me/mailFolders/${folderId}` : '/me'}/messages?${q}`;
    const ids: string[] = [];
    while (next && !signal?.aborted) {
      const r = (await this.call(next, sig)) as { value?: (GMsg & { '@odata.type'?: string })[]; '@odata.nextLink'?: string };
      for (const m of r.value ?? []) {
        if (m.parentFolderId && skip.has(m.parentFolderId)) continue;
        if (!g.client(m)) continue;
        if (ids.length >= cap) return { ids, capped: true };
        ids.push(m.id);
      }
      next = r['@odata.nextLink'];
    }
    return { ids, capped: false };
  }

  async list(ids: string[], signal?: AbortSignal): Promise<MailMessage[]> {
    const names = await this.#folderNames(signal).catch(() => undefined);
    const out: MailMessage[] = [];
    let i = 0;
    const worker = async () => {
      while (i < ids.length) {
        const id = ids[i++];
        const m = (await this.call(`/me/messages/${encodeURIComponent(id)}?$select=${LIST_FIELDS}`, { ...(signal ? { signal } : {}) }).catch(() => undefined)) as GMsg | undefined;
        if (m) out.push(this.#msg(m, names));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const order = new Map(ids.map((x, k) => [x, k]));
    return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async #folderNames(signal?: AbortSignal): Promise<Map<string, string>> {
    return new Map((await this.folders(signal)).map((f) => [f.id, f.name]));
  }

  async get(id: string, signal?: AbortSignal): Promise<MailMessage> {
    const m = (await this.call(`/me/messages/${encodeURIComponent(id)}?$select=${LIST_FIELDS},body,internetMessageHeaders`, { ...(signal ? { signal } : {}) })) as GMsg;
    const out = this.#msg(m);
    out.text = (m.body?.content ?? '').replace(/\r\n/g, '\n').trim();
    if (m.hasAttachments) {
      const a = (await this.call(`/me/messages/${encodeURIComponent(id)}/attachments?$select=name`, { ...(signal ? { signal } : {}) }).catch(() => ({ value: [] }))) as { value?: { name?: string }[] };
      out.attachments = (a.value ?? []).map((x) => x.name ?? '').filter(Boolean);
    }
    return out;
  }

  async thread(id: string, signal?: AbortSignal): Promise<MailMessage[]> {
    let conv = id;
    // A message id was given: its conversation.
    if (!/^AAQk/.test(id)) {
      const m = (await this.call(`/me/messages/${encodeURIComponent(id)}?$select=conversationId`, { ...(signal ? { signal } : {}) }).catch(() => undefined)) as GMsg | undefined;
      if (m?.conversationId) conv = m.conversationId;
    }
    const r = (await this.call(`/me/messages?${new URLSearchParams({ $filter: `conversationId eq '${conv.replace(/'/g, "''")}'`, $select: `${LIST_FIELDS},body`, $top: '50' })}`, { ...(signal ? { signal } : {}) })) as { value?: GMsg[] };
    return (r.value ?? [])
      .map((m) => ({ ...this.#msg(m), text: (m.body?.content ?? '').replace(/\r\n/g, '\n').trim() }))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  }

  async recentInbox(days: number, max: number, signal?: AbortSignal): Promise<{ latest: MailMessage; count: number }[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = (await this.call(`/me/mailFolders/inbox/messages?${new URLSearchParams({ $filter: `receivedDateTime ge ${since}`, $select: LIST_FIELDS, $top: String(Math.min(100, max * 3)) })}`, { ...(signal ? { signal } : {}) })) as { value?: GMsg[] };
    const seen = new Set<string>();
    const out: { latest: MailMessage; count: number }[] = [];
    for (const m of (r.value ?? []).sort((a, b) => Date.parse(b.receivedDateTime ?? '') - Date.parse(a.receivedDateTime ?? ''))) {
      const conv = m.conversationId ?? m.id;
      if (seen.has(conv)) continue;
      seen.add(conv);
      // The whole conversation (Sent included): did the owner answer after it?
      const all = await this.thread(conv, signal).catch(() => [] as MailMessage[]);
      const latest = all.at(-1) ?? this.#msg(m);
      const withHeaders = latest.id === m.id || !all.length ? await this.get(latest.id, signal).catch(() => latest) : latest;
      out.push({ latest: withHeaders, count: Math.max(1, all.length) });
      if (out.length >= max) break;
    }
    return out;
  }

  #draftBody(d: Draft) {
    return { subject: d.subject, body: { contentType: 'Text', content: d.body }, toRecipients: recips(d.to), ...(d.cc ? { ccRecipients: recips(d.cc) } : {}) };
  }

  async draft(d: Draft, signal?: AbortSignal): Promise<string> {
    const sig = signal ? { signal } : {};
    if (d.replyTo) {
      const r = (await this.call(`/me/messages/${encodeURIComponent(d.replyTo)}/createReply`, { method: 'POST', body: { message: { toRecipients: recips(d.to), ...(d.cc ? { ccRecipients: recips(d.cc) } : {}) }, comment: d.body }, ...sig })) as { id?: string };
      return String(r.id ?? '');
    }
    const r = (await this.call('/me/messages', { method: 'POST', body: this.#draftBody(d), ...sig })) as { id?: string };
    return String(r.id ?? '');
  }

  async send(d: Draft, signal?: AbortSignal): Promise<string> {
    const sig = signal ? { signal } : {};
    if (d.replyTo) {
      await this.call(`/me/messages/${encodeURIComponent(d.replyTo)}/reply`, { method: 'POST', body: { message: { toRecipients: recips(d.to), ...(d.cc ? { ccRecipients: recips(d.cc) } : {}) }, comment: d.body }, ...sig });
      return 'reply';
    }
    await this.call('/me/sendMail', { method: 'POST', body: { message: this.#draftBody(d), saveToSentItems: true }, ...sig });
    return 'sent';
  }

  async folders(signal?: AbortSignal): Promise<Folder[]> {
    const r = (await this.call('/me/mailFolders?$top=200&$select=id,displayName,totalItemCount,unreadItemCount', { ...(signal ? { signal } : {}) })) as { value?: { id: string; displayName: string; totalItemCount?: number; unreadItemCount?: number }[] };
    const roles = new Map<string, string>();
    for (const [wk, role] of [['inbox', 'inbox'], ['archive', 'archive'], ['deleteditems', 'trash'], ['junkemail', 'junk'], ['sentitems', 'sent'], ['drafts', 'drafts']] as const) {
      const id = await this.#wellKnown(wk, signal).catch(() => '');
      if (id) roles.set(id, role);
    }
    return (r.value ?? []).map((f) => ({ id: f.id, name: f.displayName, ...(roles.get(f.id) ? { role: roles.get(f.id)! } : {}), ...(typeof f.totalItemCount === 'number' ? { total: f.totalItemCount } : {}), ...(typeof f.unreadItemCount === 'number' ? { unread: f.unreadItemCount } : {}) }));
  }

  async labels(signal?: AbortSignal): Promise<string[]> {
    const r = (await this.call('/me/outlook/masterCategories', { ...(signal ? { signal } : {}) })) as { value?: { displayName: string }[] };
    return (r.value ?? []).map((c) => c.displayName);
  }

  async #category(name: string, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const all = await this.labels(signal);
    const hit = all.find((c) => c.toLowerCase() === name.toLowerCase());
    if (hit || !create) return hit;
    await this.call('/me/outlook/masterCategories', { method: 'POST', body: { displayName: name, color: 'preset0' }, ...(signal ? { signal } : {}) });
    return name;
  }

  async #each(ids: string[], fn: (id: string) => Promise<Before | undefined>, signal?: AbortSignal, progress?: (n: number) => void): Promise<ApplyResult> {
    const done: Before[] = [];
    let failed = 0;
    let error: string | undefined;
    let i = 0;
    const worker = async () => {
      while (i < ids.length && !signal?.aborted) {
        const id = ids[i++];
        try {
          const b = await fn(id);
          if (b) done.push(b);
        } catch (err) {
          failed++;
          error ??= (err as Error).message;
        }
        if ((done.length + failed) % 25 === 0) progress?.(done.length + failed);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    progress?.(done.length + failed);
    return { done, failed, ...(error ? { error } : {}) };
  }

  async #move(id: string, dest: string): Promise<Before> {
    const m = (await this.call(`/me/messages/${encodeURIComponent(id)}?$select=parentFolderId`)) as GMsg;
    const moved = (await this.call(`/me/messages/${encodeURIComponent(id)}/move`, { method: 'POST', body: { destinationId: dest } })) as { id?: string };
    return { id: moved.id ?? id, ...(m.parentFolderId ? { folder: m.parentFolderId } : {}) };
  }
  #patch(id: string, body: unknown): Promise<unknown> {
    return this.call(`/me/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  }
  async #cats(id: string, f: (c: string[]) => string[]): Promise<void> {
    const m = (await this.call(`/me/messages/${encodeURIComponent(id)}?$select=categories`)) as GMsg;
    await this.#patch(id, { categories: f(m.categories ?? []) });
  }

  async apply(action: MailAction, ids: string[], opts: { target?: string; createLabel?: boolean; signal?: AbortSignal; progress?: (n: number) => void }): Promise<ApplyResult & { target?: string }> {
    const { signal, progress } = opts;
    const one = (b: { id: string }) => ({ id: b.id });
    switch (action) {
      case 'read':
      case 'unread':
        return this.#each(ids, async (id) => (await this.#patch(id, { isRead: action === 'read' }), one({ id })), signal, progress);
      case 'star':
      case 'unstar':
        return this.#each(ids, async (id) => (await this.#patch(id, { flag: { flagStatus: action === 'star' ? 'flagged' : 'notFlagged' } }), one({ id })), signal, progress);
      case 'important':
      case 'not_important':
        return this.#each(ids, async (id) => (await this.#patch(id, { importance: action === 'important' ? 'high' : 'normal' }), one({ id })), signal, progress);
      case 'label':
      case 'unlabel': {
        const name = await this.#category(opts.target ?? '', action === 'label' && Boolean(opts.createLabel), signal);
        if (!name) throw new GraphError(`There is no category called "${opts.target}". Pick one from mail_labels, or set createLabel to make it.`, 404);
        const low = name.toLowerCase();
        const r = await this.#each(ids, async (id) => (await this.#cats(id, (c) => (action === 'label' ? [...c.filter((x) => x.toLowerCase() !== low), name] : c.filter((x) => x.toLowerCase() !== low))), one({ id })), signal, progress);
        return { ...r, target: name };
      }
      case 'archive':
      case 'trash':
      case 'spam':
      case 'untrash':
      case 'not_spam':
      case 'move': {
        const dest = action === 'move' ? await this.#folderByName(opts.target ?? '', signal) : { archive: 'archive', trash: 'deleteditems', spam: 'junkemail', untrash: 'inbox', not_spam: 'inbox' }[action];
        return { ...(await this.#each(ids, (id) => this.#move(id, dest), signal, progress)), ...(action === 'move' ? { target: opts.target ?? '' } : {}) };
      }
    }
  }

  async revert(action: MailAction, done: Before[], opts: { target?: string; signal?: AbortSignal; progress?: (n: number) => void }): Promise<ApplyResult> {
    const back: Partial<Record<MailAction, MailAction>> = { read: 'unread', unread: 'read', star: 'unstar', unstar: 'star', important: 'not_important', not_important: 'important', label: 'unlabel', unlabel: 'label' };
    const ids = done.map((d) => d.id);
    const rev = back[action];
    if (rev) return this.apply(rev, ids, { ...(opts.target ? { target: opts.target } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.progress ? { progress: opts.progress } : {}) });
    // A move: each message goes back to the folder it was in.
    const where = new Map(done.map((d) => [d.id, d.folder]));
    return this.#each(ids, async (id) => {
      const to = where.get(id);
      if (!to) throw new GraphError('it was not recorded where it came from', 400);
      return this.#move(id, to);
    }, opts.signal, opts.progress);
  }

  async inboxCounts(signal?: AbortSignal): Promise<{ total: number; unread: number }> {
    const f = (await this.call('/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount', { ...(signal ? { signal } : {}) })) as { totalItemCount?: number; unreadItemCount?: number };
    return { total: f.totalItemCount ?? 0, unread: f.unreadItemCount ?? 0 };
  }

  async important(max: number, signal?: AbortSignal): Promise<MailMessage[]> {
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const r = (await this.call(`/me/mailFolders/inbox/messages?${new URLSearchParams({ $filter: `isRead eq false and receivedDateTime ge ${since}`, $select: LIST_FIELDS, $top: '25' })}`, { ...(signal ? { signal } : {}) })) as { value?: GMsg[] };
    // Outlook's own reading of importance: Focused Inbox, or marked high importance.
    return (r.value ?? [])
      .filter((m) => m.importance === 'high' || m.inferenceClassification === 'focused')
      .sort((a, b) => Date.parse(b.receivedDateTime ?? '') - Date.parse(a.receivedDateTime ?? ''))
      .slice(0, max)
      .map((m) => this.#msg(m));
  }

  webLink(): string {
    return /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(this.address) ? 'https://outlook.live.com/mail/0/' : 'https://outlook.office.com/mail/';
  }

  calendar = {
    events: async (from: Date, to: Date, query: string | undefined, signal?: AbortSignal): Promise<CalendarEventOut[]> => {
      const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $orderby: 'start/dateTime', $top: '50', $select: 'id,subject,start,end,isAllDay,location,attendees,isCancelled' });
      const r = (await this.call(`/me/calendarView?${q}`, { ...(signal ? { signal } : {}), headers: { prefer: 'outlook.timezone="UTC"' } })) as { value?: { id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; start?: { dateTime?: string }; end?: { dateTime?: string }; location?: { displayName?: string }; attendees?: { emailAddress?: { address?: string } }[] }[] };
      const z = (s?: string) => (s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(/\.\d+$/, '')}Z`) : '');
      return (r.value ?? [])
        .filter((e) => !e.isCancelled && (!query || `${e.subject ?? ''} ${e.location?.displayName ?? ''}`.toLowerCase().includes(query.toLowerCase())))
        .map((e) => ({ id: e.id, title: e.subject ?? '(no title)', start: e.isAllDay ? z(e.start?.dateTime).slice(0, 10) : z(e.start?.dateTime), ...(e.end?.dateTime ? { end: e.isAllDay ? z(e.end.dateTime).slice(0, 10) : z(e.end.dateTime) } : {}), allDay: Boolean(e.isAllDay), ...(e.location?.displayName ? { location: e.location.displayName } : {}), ...(e.attendees?.length ? { attendees: e.attendees.map((a) => a.emailAddress?.address ?? '').filter(Boolean) } : {}) }));
    },
    add: async (e: CalendarEventIn, signal?: AbortSignal): Promise<CalendarEventOut> => {
      const r = (await this.call('/me/events', { method: 'POST', body: eventBody(e), ...(signal ? { signal } : {}) })) as { id: string; subject?: string };
      return { id: r.id, title: r.subject ?? e.title, start: e.start, ...(e.end ? { end: e.end } : {}), allDay: e.allDay, ...(e.location ? { location: e.location } : {}), ...(e.guests.length ? { attendees: e.guests } : {}) };
    },
    update: async (id: string, e: Partial<CalendarEventIn>, signal?: AbortSignal): Promise<CalendarEventOut> => {
      const r = (await this.call(`/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: eventBody(e), ...(signal ? { signal } : {}) })) as { id: string; subject?: string; start?: { dateTime?: string }; isAllDay?: boolean };
      return { id: r.id ?? id, title: r.subject ?? e.title ?? '', start: r.start?.dateTime ?? e.start ?? '', allDay: Boolean(r.isAllDay ?? e.allDay) };
    },
    remove: async (id: string, signal?: AbortSignal): Promise<void> => {
      await this.call(`/me/events/${encodeURIComponent(id)}`, { method: 'DELETE', ...(signal ? { signal } : {}) });
    },
  };

  async test(signal?: AbortSignal): Promise<string> {
    const c = await this.inboxCounts(signal);
    return `Signed in as ${this.address}: ${c.total.toLocaleString('en-US')} emails in the inbox, ${c.unread.toLocaleString('en-US')} unread.`;
  }
}

function eventBody(e: Partial<CalendarEventIn>): Record<string, unknown> {
  const at = (v: string) => (e.allDay ? { dateTime: `${v.slice(0, 10)}T00:00:00`, timeZone: e.timeZone ?? 'UTC' } : { dateTime: v.length === 16 ? `${v}:00` : v.slice(0, 19), timeZone: e.timeZone ?? 'UTC' });
  return {
    ...(e.title !== undefined ? { subject: e.title } : {}),
    ...(e.start ? { start: at(e.start) } : {}),
    ...(e.end ? { end: at(e.end) } : {}),
    ...(e.allDay !== undefined && e.start ? { isAllDay: e.allDay } : {}),
    ...(e.location ? { location: { displayName: e.location } } : {}),
    ...(e.notes ? { body: { contentType: 'Text', content: e.notes } } : {}),
    ...(e.guests?.length ? { attendees: e.guests.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
  };
}

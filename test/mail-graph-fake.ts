// A stand-in for Microsoft's sign-in and Microsoft Graph (mail + calendar), loopback only, for the
// M1 tests. Written from Microsoft's public API reference; small and strict about what Sara sends
// (PKCE verifier, client id, refresh tokens, immutable ids). Never a real account.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMsg {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: string;
  receivedDateTime: string;
  isRead: boolean;
  flag: { flagStatus: string };
  importance: 'low' | 'normal' | 'high';
  categories: string[];
  parentFolderId: string;
  inferenceClassification: 'focused' | 'other';
  hasAttachments: boolean;
  from: { emailAddress: { name?: string; address: string } };
  toRecipients: { emailAddress: { address: string } }[];
  internetMessageHeaders?: { name: string; value: string }[];
  isDraft?: boolean;
}

export class FakeGraph {
  server?: Server;
  base = '';
  /** The client the owner registered. */
  clientId = '11111111-2222-3333-4444-555555555555';
  clientSecret = 'secret-value-123456';
  address = 'ana@outlook.com';
  folders = new Map<string, { id: string; displayName: string; wk?: string }>([
    ['inbox', { id: 'F-INBOX', displayName: 'Inbox', wk: 'inbox' }],
    ['archive', { id: 'F-ARCH', displayName: 'Archive', wk: 'archive' }],
    ['deleteditems', { id: 'F-DEL', displayName: 'Deleted Items', wk: 'deleteditems' }],
    ['junkemail', { id: 'F-JUNK', displayName: 'Junk Email', wk: 'junkemail' }],
    ['sentitems', { id: 'F-SENT', displayName: 'Sent Items', wk: 'sentitems' }],
    ['drafts', { id: 'F-DRAFTS', displayName: 'Drafts', wk: 'drafts' }],
    ['receipts', { id: 'F-RCPT', displayName: 'Receipts' }],
  ]);
  msgs: FakeMsg[] = [];
  categories: string[] = ['Blue category'];
  events: { id: string; subject: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string }; isAllDay: boolean; location?: { displayName: string }; attendees?: unknown[] }[] = [];
  sent: unknown[] = [];
  /** Codes issued at /authorize (state → verifier challenge). */
  codes = new Map<string, { challenge: string; redirect: string }>();
  refreshTokens = new Set<string>();
  accessTokens = new Set<string>();
  revoked = false;
  log: string[] = [];
  /** Bodies of every write call (PATCH/POST/DELETE), for the tests. */
  writes: { method: string; path: string; body: unknown; prefer: string }[] = [];
  /** Answer the next N Graph calls with 429 (Retry-After: 0). */
  throttle = 0;
  #n = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop(): Promise<void> {
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  add(m: Omit<Partial<FakeMsg>, 'from'> & { from: string; subject: string }): FakeMsg {
    const id = `AAMkImm${++this.#n}=`;
    const msg: FakeMsg = {
      id,
      conversationId: m.conversationId ?? `AAQkConv${this.#n}=`,
      subject: m.subject,
      bodyPreview: m.bodyPreview ?? `Hello from ${m.from}?`,
      body: m.body ?? `Hello from ${m.from}?`,
      receivedDateTime: m.receivedDateTime ?? new Date(Date.now() - this.#n * 60_000).toISOString(),
      isRead: m.isRead ?? false,
      flag: m.flag ?? { flagStatus: 'notFlagged' },
      importance: m.importance ?? 'normal',
      categories: m.categories ?? [],
      parentFolderId: m.parentFolderId ?? 'F-INBOX',
      inferenceClassification: m.inferenceClassification ?? 'focused',
      hasAttachments: false,
      from: { emailAddress: { address: m.from } },
      toRecipients: [{ emailAddress: { address: this.address } }],
      ...(m.internetMessageHeaders ? { internetMessageHeaders: m.internetMessageHeaders } : {}),
    };
    this.msgs.push(msg);
    return msg;
  }

  /** What Microsoft's /authorize does after the owner signs in: a code for this state. */
  authorize(url: string): { code: string; state: string } {
    const u = new URL(url);
    const state = u.searchParams.get('state')!;
    const code = `code-${state.slice(0, 6)}`;
    this.codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
    return { code, state };
  }

  #folderId(x: string): string {
    return this.folders.get(x)?.id ?? x;
  }

  async #handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url ?? '/', this.base);
    const json = (code: number, v: unknown, h: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...h });
      res.end(JSON.stringify(v));
    };
    this.log.push(`${req.method} ${url.pathname}${url.search}`);
    // ---- sign-in ----
    if (url.pathname === '/login/token') {
      const f = new URLSearchParams(body);
      if (f.get('client_id') !== this.clientId || f.get('client_secret') !== this.clientSecret) return json(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret.\r\nTrace ID: x' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code') ?? '');
        this.codes.delete(f.get('code') ?? '');
        if (!c || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge || c.redirect !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70008: bad code or verifier' });
        return json(200, this.#tokens(f.get('scope') ?? ''));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token') ?? '';
        if (this.revoked || !this.refreshTokens.has(rt)) return json(400, { error: 'invalid_grant', error_description: 'AADSTS70043: The refresh token has expired or is invalid.\r\nTrace ID: abc\r\nCorrelation ID: def' });
        // Microsoft rotates refresh tokens.
        this.refreshTokens.delete(rt);
        return json(200, this.#tokens(f.get('scope') ?? ''));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    // ---- Graph ----
    const auth = String(req.headers.authorization ?? '');
    if (!auth.startsWith('Bearer ') || !this.accessTokens.has(auth.slice(7))) return json(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty or invalid.' } });
    if (this.throttle > 0) {
      this.throttle--;
      return json(429, { error: { code: 'TooManyRequests', message: 'slow down' } }, { 'retry-after': '0' });
    }
    const prefer = String(req.headers.prefer ?? '');
    const p = url.pathname.replace(/^\/v1\.0/, '');
    const m = req.method ?? 'GET';
    const b = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    if (m !== 'GET') this.writes.push({ method: m, path: p, body: b, prefer });
    let mm: RegExpExecArray | null;
    if (p === '/me') return json(200, { mail: this.address, userPrincipalName: this.address });
    if (p === '/me/mailFolders' && m === 'GET') return json(200, { value: [...this.folders.values()].map((f) => ({ id: f.id, displayName: f.displayName, totalItemCount: this.msgs.filter((x) => x.parentFolderId === f.id).length, unreadItemCount: this.msgs.filter((x) => x.parentFolderId === f.id && !x.isRead).length })) });
    if ((mm = /^\/me\/mailFolders\/([^/]+)$/.exec(p)) && m === 'GET') {
      const f = this.folders.get(mm[1]) ?? [...this.folders.values()].find((x) => x.id === mm![1]);
      if (!f) return json(404, { error: { message: 'folder not found' } });
      return json(200, { id: f.id, displayName: f.displayName, totalItemCount: this.msgs.filter((x) => x.parentFolderId === f.id).length, unreadItemCount: this.msgs.filter((x) => x.parentFolderId === f.id && !x.isRead).length });
    }
    if ((mm = /^\/me(?:\/mailFolders\/([^/]+))?\/messages$/.exec(p)) && m === 'GET') {
      if (url.searchParams.has('$search') && url.searchParams.has('$filter')) return json(400, { error: { message: 'Query option $filter is not allowed with $search.' } });
      let list = this.msgs.filter((x) => !x.isDraft);
      if (mm[1]) list = list.filter((x) => x.parentFolderId === this.#folderId(mm![1]));
      const filter = url.searchParams.get('$filter');
      if (filter) list = list.filter((x) => this.#filter(x, filter));
      const search = url.searchParams.get('$search');
      if (search) list = list.filter((x) => this.#search(x, search));
      list.sort((a2, b2) => Date.parse(b2.receivedDateTime) - Date.parse(a2.receivedDateTime));
      const top = Number(url.searchParams.get('$top') ?? 10);
      const skip = Number(url.searchParams.get('$skip') ?? 0);
      const page = list.slice(skip, skip + top);
      const next = skip + top < list.length ? (() => {
        const u = new URL(url);
        u.searchParams.set('$skip', String(skip + top));
        return u.toString();
      })() : undefined;
      return json(200, { value: page, ...(next ? { '@odata.nextLink': next } : {}) });
    }
    if ((mm = /^\/me\/messages\/([^/]+)$/.exec(p))) {
      const msg = this.msgs.find((x) => x.id === decodeURIComponent(mm![1]));
      if (!msg) return json(404, { error: { message: 'The specified object was not found in the store.' } });
      if (m === 'GET') return json(200, { ...msg, body: { contentType: prefer.includes('body-content-type="text"') ? 'text' : 'html', content: msg.body } });
      if (m === 'PATCH') {
        Object.assign(msg, b);
        return json(200, msg);
      }
      return json(405, { error: { message: 'Sara never deletes messages: this fake refuses DELETE' } });
    }
    if ((mm = /^\/me\/messages\/([^/]+)\/attachments$/.exec(p))) return json(200, { value: [] });
    if ((mm = /^\/me\/messages\/([^/]+)\/move$/.exec(p)) && m === 'POST') {
      const msg = this.msgs.find((x) => x.id === decodeURIComponent(mm![1]));
      if (!msg) return json(404, { error: { message: 'not found' } });
      msg.parentFolderId = this.#folderId(String(b.destinationId));
      // Immutable ids keep the id; without the Prefer header Graph would give a new one.
      if (!prefer.includes('IdType="ImmutableId"')) msg.id = `${msg.id}moved`;
      return json(201, msg);
    }
    if ((mm = /^\/me\/messages\/([^/]+)\/(createReply|reply)$/.exec(p)) && m === 'POST') {
      const orig = this.msgs.find((x) => x.id === decodeURIComponent(mm![1]));
      if (!orig) return json(404, { error: { message: 'not found' } });
      if (mm[2] === 'reply') {
        this.sent.push({ replyTo: orig.id, ...b });
        return json(202, {});
      }
      const d = this.add({ from: this.address, subject: `RE: ${orig.subject}`, parentFolderId: 'F-DRAFTS', conversationId: orig.conversationId, body: String(b.comment ?? '') });
      d.isDraft = true;
      return json(201, d);
    }
    if (p === '/me/messages' && m === 'POST') {
      const d = this.add({ from: this.address, subject: String(b.subject ?? ''), parentFolderId: 'F-DRAFTS' });
      d.isDraft = true;
      return json(201, d);
    }
    if (p === '/me/sendMail' && m === 'POST') {
      this.sent.push(b);
      return json(202, {});
    }
    if (p === '/me/outlook/masterCategories') {
      if (m === 'POST') {
        this.categories.push(String(b.displayName));
        return json(201, { displayName: b.displayName });
      }
      return json(200, { value: this.categories.map((displayName) => ({ displayName })) });
    }
    if (p === '/me/calendarView') {
      const from = Date.parse(url.searchParams.get('startDateTime') ?? '');
      const to = Date.parse(url.searchParams.get('endDateTime') ?? '');
      return json(200, { value: this.events.filter((e) => Date.parse(`${e.start.dateTime}Z`) < to && Date.parse(`${e.end.dateTime}Z`) > from) });
    }
    if (p === '/me/events' && m === 'POST') {
      const e = { id: `EV${++this.#n}`, ...(b as object) } as FakeGraph['events'][number];
      this.events.push(e);
      return json(201, e);
    }
    if ((mm = /^\/me\/events\/([^/]+)$/.exec(p))) {
      const e = this.events.find((x) => x.id === decodeURIComponent(mm![1]));
      if (!e) return json(404, { error: { message: 'not found' } });
      if (m === 'PATCH') {
        Object.assign(e, b);
        return json(200, e);
      }
      if (m === 'DELETE') {
        this.events = this.events.filter((x) => x !== e);
        res.writeHead(204).end();
        return;
      }
    }
    return json(404, { error: { message: `fake: no route ${m} ${p}` } });
  }

  #tokens(scope: string): Record<string, unknown> {
    const access = `at-${++this.#n}`;
    const refresh = `rt-${this.#n}`;
    this.accessTokens.add(access);
    this.refreshTokens.add(refresh);
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, scope: scope.replace('offline_access ', '') };
  }

  #filter(x: FakeMsg, f: string): boolean {
    return f.split(' and ').every((c) => {
      let m: RegExpExecArray | null;
      if ((m = /^receivedDateTime (ge|lt) (\S+)$/.exec(c))) return m[1] === 'ge' ? Date.parse(x.receivedDateTime) >= Date.parse(m[2]) : Date.parse(x.receivedDateTime) < Date.parse(m[2]);
      if ((m = /^isRead eq (true|false)$/.exec(c))) return x.isRead === (m[1] === 'true');
      if ((m = /^flag\/flagStatus (eq|ne) 'flagged'$/.exec(c))) return (x.flag.flagStatus === 'flagged') === (m[1] === 'eq');
      if ((m = /^importance (eq|ne) 'high'$/.exec(c))) return (x.importance === 'high') === (m[1] === 'eq');
      if ((m = /^(not\()?categories\/any\(c:c eq '(.+)'\)\)?$/.exec(c))) return x.categories.includes(m[2]) !== Boolean(m[1]);
      if ((m = /^conversationId eq '(.+)'$/.exec(c))) return x.conversationId === m[1];
      if ((m = /^hasAttachments eq (true|false)$/.exec(c))) return x.hasAttachments === (m[1] === 'true');
      throw new Error(`fake: unknown filter ${c}`);
    });
  }

  #search(x: FakeMsg, s: string): boolean {
    const q = s.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    const parts = [...q.matchAll(/(NOT )?(?:(from|to|subject):)?"([^"]*)"/g)];
    return parts.every(([, not, key, v]) => {
      const val = v.toLowerCase();
      const hay = key === 'from' ? x.from.emailAddress.address : key === 'to' ? x.toRecipients.map((r) => r.emailAddress.address).join(' ') : key === 'subject' ? x.subject : `${x.subject} ${x.body} ${x.from.emailAddress.address}`;
      return hay.toLowerCase().includes(val) !== Boolean(not);
    });
  }
}

// Phase 122 (docs/design/WHATSAPP.md §10): a stand-in for Meta's Graph API and a fake Meta sender,
// written here (no real Meta account, no real network). The Graph stand-in is HTTPS on a self-signed
// test CA (test/mail-fake.ts testCerts), reached by the real plugin through Sara's socket broker and
// its test-only loopback override. It answers the calls the plugin makes, records every request
// (the token's value hidden), can be told to answer any error code once or always, enforces Meta's
// pair rate if asked, and serves media on a second "media host" that needs the bearer token and
// whose URLs die after 5 (fake) minutes. The sender signs payloads with the App Secret
// (X-Hub-Signature-256) and runs the GET verify handshake.
//
// Live check: node test/whatsapp-fake.ts --graph 7891 --media 7892 --control 7893 --dir <folder>
// (writes ca.pem there; POST /webhook?url=… on the control port sends a signed payload).
import { createHash, createHmac } from 'node:crypto';
import { createServer as httpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as httpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testCerts } from './mail-fake.ts';

export const PHONE_ID = '106540352242922';
export const WABA_ID = '102290129340398';
export const TOKEN = `EAAG${'x'.repeat(40)}`;
export const APP_SECRET = '0123456789abcdef0123456789abcdef';
export const OWNER_WA = '15551230001';
export const OWNER_BSUID = 'US.13491208655302741918';

export interface GraphRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  raw?: Buffer;
  at: number;
}

export class FakeGraph {
  readonly certs = testCerts('graph.test');
  requests: GraphRequest[] = [];
  /** Error answers: path pattern → { code, once?, status? }. */
  errors: { match: RegExp; code: number; once?: boolean; status?: number; title?: string }[] = [];
  phones = [{ id: PHONE_ID, display_phone_number: '+1 555-0100', verified_name: 'Test Number', quality_rating: 'GREEN', platform_type: 'CLOUD_API' }];
  /** What GET /<waba>/phone_numbers lists, when it should differ from `phones` (a key that can't see her number). */
  phoneList?: { id: string }[];
  subscribed: { whatsapp_business_api_data: { id: string } }[] = [];
  media = new Map<string, { bytes: Buffer; mime: string; sha256?: string; at: number }>();
  uploads = 0;
  now = () => Date.now();
  graphPort = 0;
  mediaPort = 0;
  pairRate = false;
  #graph?: HttpsServer;
  #media?: HttpsServer;
  #seq = 0;
  #pairSent: number[] = [];

  get caPem(): string {
    return this.certs.ca.pem;
  }

  async start(o: { graphPort?: number; mediaPort?: number; host?: string } = {}): Promise<this> {
    const opts = { key: this.certs.key, cert: this.certs.leaf.pem };
    this.#graph = httpsServer(opts, (req, res) => void this.#onGraph(req, res));
    this.#media = httpsServer(opts, (req, res) => void this.#onMedia(req, res));
    await new Promise<void>((r) => this.#graph!.listen(o.graphPort ?? 0, o.host ?? '127.0.0.1', r));
    await new Promise<void>((r) => this.#media!.listen(o.mediaPort ?? 0, o.host ?? '127.0.0.1', r));
    this.graphPort = (this.#graph.address() as AddressInfo).port;
    this.mediaPort = (this.#media.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const s of [this.#graph, this.#media]) {
      s?.closeAllConnections?.();
      await new Promise<void>((r) => (s ? s.close(() => r()) : r()));
    }
  }

  /** A picture or file Meta holds for an incoming message. */
  addMedia(id: string, bytes: Buffer, mime: string, sha256 = createHash('sha256').update(bytes).digest('hex')): void {
    this.media.set(id, { bytes, mime, sha256, at: this.now() });
  }

  sent(): GraphRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && /\/messages$/.test(r.path));
  }

  async #read(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }

  #error(res: ServerResponse, code: number, status = 400, title = `Error ${code}`): void {
    this.#json(res, status, { error: { message: `(#${code}) ${title}`, type: 'OAuthException', code, error_data: { details: title }, fbtrace_id: 'Atest' } });
  }

  async #onGraph(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await this.#read(req);
    const url = new URL(req.url ?? '/', 'https://graph.test');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = k === 'authorization' ? String(v).replace(/Bearer .+/, 'Bearer [token]') : String(v);
    const ct = String(req.headers['content-type'] ?? '');
    let body: unknown = null;
    if (ct.startsWith('application/json')) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = raw.toString('utf8');
      }
    } else if (ct.startsWith('multipart/')) body = { multipart: true, size: raw.length, type: /name="type"\r\n\r\n([^\r]+)/.exec(raw.toString('latin1'))?.[1] ?? '' };
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers, body, at: this.now() });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.#error(res, 190, 401, 'Error validating access token: Session has expired');
    const path = url.pathname.replace(/^\/v[\d.]+/, '');
    // Read receipts and typing never take a told-to error (those are meant for her messages).
    const isRead = (body as { status?: string } | null)?.status === 'read';
    const e = isRead ? undefined : this.errors.find((x) => x.match.test(`${req.method} ${path}`));
    if (e) {
      if (e.once) this.errors.splice(this.errors.indexOf(e), 1);
      return this.#error(res, e.code, e.status ?? 400, e.title);
    }
    const m = /^\/(\w+)(\/[\w]+)?$/.exec(path);
    const id = m?.[1] ?? '';
    const sub = m?.[2] ?? '';
    if (req.method === 'GET' && !sub) {
      const phone = this.phones.find((p) => p.id === id);
      if (phone) return this.#json(res, 200, phone);
      const md = this.media.get(id);
      if (md) {
        const key = `${id}.${Math.round(this.now() / 1000)}`;
        return this.#json(res, 200, { url: `https://localhost:${this.mediaPort}/whatsapp_business/attachments/?mid=${key}&ext=1`, mime_type: md.mime, sha256: md.sha256, file_size: md.bytes.length, id, messaging_product: 'whatsapp' });
      }
      if (id === WABA_ID) return this.#json(res, 200, { id: WABA_ID, name: 'Test WhatsApp Business Account' });
      return this.#error(res, 100, 400, 'Unsupported get request. Object does not exist');
    }
    if (req.method === 'GET' && sub === '/phone_numbers' && id === WABA_ID) return this.#json(res, 200, { data: this.phoneList ?? this.phones });
    if (sub === '/subscribed_apps' && id === WABA_ID) {
      if (req.method === 'POST') {
        this.subscribed = [{ whatsapp_business_api_data: { id: 'app1' } }];
        return this.#json(res, 200, { success: true });
      }
      return this.#json(res, 200, { data: this.subscribed });
    }
    if (req.method === 'POST' && sub === '/settings') return this.#json(res, 200, { success: true });
    if (req.method === 'POST' && sub === '/register') return this.#json(res, 200, { success: true });
    if (req.method === 'POST' && sub === '/whatsapp_business_profile') return this.#json(res, 200, { success: true });
    if (req.method === 'POST' && sub === '/media') {
      this.uploads++;
      return this.#json(res, 200, { id: `m${++this.#seq}` });
    }
    if (req.method === 'POST' && sub === '/messages') {
      const b = (body ?? {}) as { status?: string; type?: string };
      if (b.status === 'read') return this.#json(res, 200, { success: true });
      if (this.pairRate) {
        const now = this.now();
        this.#pairSent = this.#pairSent.filter((t) => now - t < 6000);
        if (this.#pairSent.length >= 45) return this.#error(res, 131056, 400, '(Business Account, Consumer Account) pair rate limit hit');
        this.#pairSent.push(now);
      }
      return this.#json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: OWNER_WA, wa_id: OWNER_WA }], messages: [{ id: `wamid.out${++this.#seq}` }] });
    }
    return this.#error(res, 100, 400, `Unknown path ${path}`);
  }

  async #onMedia(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.#read(req);
    const url = new URL(req.url ?? '/', 'https://localhost');
    this.requests.push({ method: req.method ?? 'GET', path: `media:${url.pathname}${url.search}`, headers: { authorization: req.headers.authorization ? 'Bearer [token]' : '' }, body: null, at: this.now() });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.#error(res, 190, 401, 'no token');
    const [id, sec] = String(url.searchParams.get('mid') ?? '').split('.');
    const md = this.media.get(id);
    if (!md || this.now() / 1000 - Number(sec) > 300) {
      res.writeHead(404, { 'content-length': '0' });
      return void res.end();
    }
    res.writeHead(200, { 'content-type': md.mime, 'content-length': md.bytes.length });
    res.end(md.bytes);
  }
}

// ------------------------------------------------------------------ the fake Meta sender

export function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

let wseq = 0;
/** One webhook payload for messages to her number (Meta's shape). */
export function payload(messages: Record<string, unknown>[], o: { phoneId?: string; contacts?: Record<string, unknown>[]; statuses?: Record<string, unknown>[] } = {}): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550100', phone_number_id: o.phoneId ?? PHONE_ID }, ...(messages.length ? { contacts: o.contacts ?? [{ profile: { name: 'Alex' }, wa_id: OWNER_WA, user_id: OWNER_BSUID }] } : {}), ...(messages.length ? { messages } : {}), ...(o.statuses ? { statuses: o.statuses } : {}) } }] }],
  });
}

export function textMsg(body: string, o: { from?: string; userId?: string; ts?: number; id?: string; identity?: string; forwarded?: boolean } = {}): Record<string, unknown> {
  return { from: o.from ?? OWNER_WA, ...(o.userId !== undefined ? (o.userId ? { from_user_id: o.userId } : {}) : { from_user_id: OWNER_BSUID }), id: o.id ?? `wamid.in${++wseq}${Date.now()}`, timestamp: String(Math.floor((o.ts ?? Date.now()) / 1000)), type: 'text', text: { body }, ...(o.identity ? { identity_key_hash: o.identity } : {}), ...(o.forwarded ? { context: { forwarded: true } } : {}) };
}

export async function postHook(url: string, body: string, o: { secret?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, o.secret), ...(o.headers ?? {}) }, body });
  return { status: r.status, text: await r.text() };
}

export async function handshake(url: string, token: string, challenge = '1158201444'): Promise<{ status: number; text: string; type: string }> {
  const u = `${url}?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=${encodeURIComponent(token)}`;
  const r = await fetch(u);
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '' };
}

// ------------------------------------------------------------------ the live-check CLI

if (process.argv[1] && /whatsapp-fake\.ts$/.test(process.argv[1])) {
  const arg = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const dir = arg('dir', '.');
  // '::' takes both ::1 and 127.0.0.1 ("localhost" may resolve to either on a real computer).
  const fake = await new FakeGraph().start({ graphPort: Number(arg('graph', '7891')), mediaPort: Number(arg('media', '7892')), host: arg('host', '::') });
  writeFileSync(join(dir, 'ca.pem'), fake.caPem);
  const control: HttpServer = httpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'POST' && u.pathname === '/webhook') {
        const r = await postHook(String(u.searchParams.get('url')), body, { secret: u.searchParams.get('secret') ?? APP_SECRET });
        res.end(JSON.stringify(r));
      } else if (req.method === 'POST' && u.pathname === '/media') {
        const j = JSON.parse(body) as { id: string; b64: string; mime: string };
        fake.addMedia(j.id, Buffer.from(j.b64, 'base64'), j.mime);
        res.end('{}');
      } else if (req.method === 'POST' && u.pathname === '/error') {
        const j = JSON.parse(body) as { match: string; code: number; once?: boolean };
        fake.errors.push({ match: new RegExp(j.match), code: j.code, once: j.once !== false });
        res.end('{}');
      } else if (u.pathname === '/requests') res.end(JSON.stringify(fake.requests.map((r) => ({ ...r, raw: undefined })), null, 1));
      else res.end('{}');
    } catch (err) {
      res.statusCode = 500;
      res.end(String((err as Error).message));
    }
  });
  await new Promise<void>((r) => control.listen(Number(arg('control', '7893')), '127.0.0.1', r));
  console.log(`fake Graph: https://localhost:${fake.graphPort}, media https://localhost:${fake.mediaPort}, control ${arg('control', '7893')}, CA ${join(dir, 'ca.pem')}`);
}

// A stand-in BlueBubbles Server (docs/design/BRIDGES4.md §11.2) for test/phase122c.test.ts and the live
// check: plain HTTP on 127.0.0.1, the REST routes Sara's iMessage plugin uses, the `guid` query password
// required everywhere (401 otherwise), the Private API on or off, Messages signed in or out, and a
// ringer that POSTs unsigned `{type, data}` webhooks to whatever URL was registered (the full message,
// as the real server does: Sara must pass the plugin the ids only). No Mac, no Apple, no network.
import { createServer } from 'node:http';

export const BB_PASSWORD = 'bb-Fixture-Pass-7f3k9q2w';
export const HER = 'sara.frank@icloud.com';
export const OWNER = '+15550001111';
export const OWNER_EMAIL = 'alex@example.com';
export const STRANGER = '+15559990000';
export const PARTNER = 'mia@example.com';
export const dmGuid = (h) => `iMessage;-;${h}`;

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080002000301011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00d2cf20ffd9', 'hex');
export const FIXTURE_JPEG = JPEG;
export const FIXTURE_HEIC = Buffer.concat([Buffer.from('000000186674797068656963000000006d696631', 'hex'), Buffer.alloc(64, 7)]);

export class FakeBlueBubbles {
  constructor(o = {}) {
    this.password = o.password ?? BB_PASSWORD;
    this.privateApi = o.privateApi === true;
    this.signedIn = o.signedIn !== false;
    this.appleId = o.appleId ?? HER;
    this.aliases = o.aliases ?? [HER];
    this.messages = [];
    this.webhooks = [];
    this.sent = [];
    this.files = [];
    this.typing = [];
    this.reacts = [];
    this.edits = [];
    this.reads = [];
    this.requests = [];
    this.rings = [];
    this.attachments = new Map();
    this.heicConverts = false;
    this.down = false;
    this.seq = 0;
    this.hookSeq = 0;
  }

  async start(port = 0) {
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise((r) => this.server.listen(port, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }
  async stop() {
    this.server?.closeAllConnections?.();
    await new Promise((r) => this.server.close(() => r()));
  }

  #json(res, status, data, message = 'Success') {
    const body = JSON.stringify(status < 400 ? { status, message, data } : { status, message, error: { type: message, message: data } });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async #handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    const method = req.method;
    let body = {};
    if (/json/.test(String(req.headers['content-type'] ?? ''))) {
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        body = {};
      }
    }
    const pass = u.searchParams.get('guid') ?? u.searchParams.get('password') ?? u.searchParams.get('token');
    this.requests.push({ method, path, at: Date.now(), body, authed: pass === this.password });
    if (this.down) return void req.socket.destroy();
    if (pass !== this.password) return this.#json(res, 401, 'You are not authorized to access this resource', 'Unauthorized');
    let m;
    if (method === 'GET' && path === '/api/v1/ping') return this.#json(res, 200, 'pong', 'Ping received!');
    if (method === 'GET' && path === '/api/v1/server/info') return this.#json(res, 200, { computer_id: 'MAC-STANDIN', os_version: '15.1', server_version: '1.9.9', private_api: this.privateApi, helper_connected: this.privateApi, proxy_service: 'Dynamic DNS', detected_icloud: this.signedIn ? this.appleId : '', detected_imessage: this.signedIn ? this.appleId : '' });
    if (method === 'GET' && path === '/api/v1/icloud/account') return this.#json(res, 200, { apple_id: this.appleId, vetted_aliases: this.aliases.map((a) => ({ Alias: a, Status: 3 })) });
    if (method === 'POST' && path === '/api/v1/message/query') {
      const after = Number(body.after ?? 0);
      const list = this.messages.filter((x) => x.dateCreated > after).sort((a, b) => a.dateCreated - b.dateCreated).slice(0, Number(body.limit ?? 50));
      return this.#json(res, 200, list);
    }
    if (method === 'GET' && (m = /^\/api\/v1\/message\/([^/]+)$/.exec(path))) {
      const msg = this.messages.find((x) => x.guid === decodeURIComponent(m[1]));
      return msg ? this.#json(res, 200, msg) : this.#json(res, 404, 'Message does not exist!', 'Not Found');
    }
    if (method === 'POST' && path === '/api/v1/message/text') {
      if ((body.method ?? 'apple-script') === 'apple-script' && (!body.tempGuid || !body.message)) return this.#json(res, 400, 'A tempGuid is required when sending via AppleScript', 'Bad Request');
      if (body.selectedMessageGuid && body.method !== 'private-api') return this.#json(res, 400, 'Replies need the Private API', 'Bad Request');
      if (body.method === 'private-api' && !this.privateApi) return this.#json(res, 400, 'iMessage Private API is not enabled', 'Bad Request');
      const out = this.#mine(body.chatGuid, String(body.message));
      this.sent.push({ ...body, guid: out.guid, at: Date.now() });
      return this.#json(res, 200, out, 'Message sent!');
    }
    if (method === 'POST' && path === '/api/v1/message/attachment') {
      const text = raw.toString('latin1');
      const field = (k) => new RegExp(`name="${k}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(text)?.[1];
      const file = /name="attachment"; filename="([^"]*)"/.exec(text);
      if (!file || !field('tempGuid')) return this.#json(res, 400, 'An attachment and tempGuid are required', 'Bad Request');
      const out = this.#mine(field('chatGuid'), '');
      this.files.push({ chatGuid: field('chatGuid'), name: file[1], size: raw.length, guid: out.guid });
      return this.#json(res, 200, out, 'Attachment sent!');
    }
    if (method === 'GET' && (m = /^\/api\/v1\/attachment\/([^/]+)\/download$/.exec(path))) {
      const a = this.attachments.get(decodeURIComponent(m[1]));
      if (!a) return this.#json(res, 404, 'Attachment does not exist', 'Not Found');
      const bytes = a.heic && this.heicConverts ? JPEG : a.bytes;
      res.writeHead(200, { 'content-type': a.heic && this.heicConverts ? 'image/jpeg' : a.mime, 'content-length': bytes.length });
      return void res.end(bytes);
    }
    if ((m = /^\/api\/v1\/chat\/([^/]+)\/typing$/.exec(path)) && (method === 'POST' || method === 'DELETE')) {
      if (!this.privateApi) return this.#json(res, 400, 'iMessage Private API is not enabled', 'Bad Request');
      this.typing.push({ chat: decodeURIComponent(m[1]), on: method === 'POST', at: Date.now() });
      return this.#json(res, 200, null);
    }
    if (method === 'POST' && path === '/api/v1/message/react') {
      if (!this.privateApi) return this.#json(res, 400, 'iMessage Private API is not enabled', 'Bad Request');
      this.reacts.push(body);
      return this.#json(res, 200, {});
    }
    if (method === 'POST' && (m = /^\/api\/v1\/message\/([^/]+)\/edit$/.exec(path))) {
      if (!this.privateApi) return this.#json(res, 400, 'iMessage Private API is not enabled', 'Bad Request');
      this.edits.push({ guid: decodeURIComponent(m[1]), text: body.editedMessage, at: Date.now() });
      return this.#json(res, 200, {});
    }
    if (method === 'POST' && (m = /^\/api\/v1\/chat\/([^/]+)\/read$/.exec(path))) {
      if (!this.privateApi) return this.#json(res, 400, 'iMessage Private API is not enabled', 'Bad Request');
      this.reads.push(decodeURIComponent(m[1]));
      return this.#json(res, 200, null);
    }
    if (method === 'GET' && path === '/api/v1/webhook') return this.#json(res, 200, this.webhooks);
    if (method === 'POST' && path === '/api/v1/webhook') {
      const w = { id: ++this.hookSeq, url: String(body.url), events: body.events ?? ['*'] };
      this.webhooks.push(w);
      setTimeout(() => void this.ringAll('hello-world', {}), 50);
      return this.#json(res, 200, w);
    }
    if (method === 'DELETE' && (m = /^\/api\/v1\/webhook\/(\d+)$/.exec(path))) {
      this.webhooks = this.webhooks.filter((w) => String(w.id) !== m[1]);
      return this.#json(res, 200, null);
    }
    return this.#json(res, 404, `No route ${method} ${path}`, 'Not Found');
  }

  #chat(guid, o = {}) {
    const group = /;\+;/.test(guid);
    return { guid, displayName: o.title ?? '', participants: (o.members ?? (group ? [] : [guid.split(';').pop()])).map((a) => ({ address: a })) };
  }

  #mine(chatGuid, text) {
    const msg = { guid: `sent-${++this.seq}`, text, isFromMe: true, dateCreated: Date.now(), handle: null, chats: [this.#chat(String(chatGuid ?? ''))], attachments: [] };
    this.messages.push(msg);
    return msg;
  }

  /** A message from someone to her Apple ID; rings the registered webhooks unless `ring: false`. */
  incoming(from, text, o = {}) {
    const chatGuid = o.chat ?? dmGuid(from);
    const atts = (o.attachments ?? []).map((a, i) => {
      const guid = `att-${this.seq + 1}-${i}`;
      this.attachments.set(guid, { bytes: a.bytes, mime: a.mime, heic: /heic/.test(a.mime) });
      return { guid, mimeType: a.mime, transferName: a.name, totalBytes: a.bytes.length };
    });
    const msg = { guid: o.guid ?? `p:0/MSG-${++this.seq}`, text, isFromMe: false, dateCreated: Date.now() - (o.agoMs ?? 0), handle: { address: from }, chats: [this.#chat(chatGuid, o)], attachments: atts, isAudioMessage: o.audio === true, ...(o.threadOriginatorGuid ? { threadOriginatorGuid: o.threadOriginatorGuid } : {}) };
    this.messages.push(msg);
    if (o.ring !== false) void this.ringAll('new-message', msg);
    return msg.guid;
  }

  /** POSTs `{type, data}` to every registered webhook, unsigned, without waiting long (as BlueBubbles does). */
  async ringAll(type, data) {
    for (const w of this.webhooks) {
      if (!w.events.includes(type) && !w.events.includes('*')) continue;
      const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, data }), signal: AbortSignal.timeout(15_000) }).catch((e) => ({ status: 0, error: String(e) }));
      this.rings.push({ type, status: r.status, at: Date.now() });
    }
  }

  /** A forged doorbell: a made-up guid, with text that must never reach the plugin. */
  forge(guid, text = 'FORGED TEXT that must never reach Sara') {
    return this.ringAll('new-message', { guid, text, isFromMe: false, handle: { address: OWNER } });
  }
}

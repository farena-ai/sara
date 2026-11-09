// EC1 (docs/ops/EC1_DESIGN.md "Tests"): a stand-in Slack, written here from Slack's public API docs:
// no Slack workspace, no real network. One HTTPS server on a test CA valid for slack.com and
// *.slack.com, reached by the real plugin through Sara's socket broker and its test-only loopback
// override (`netTestLoopback` + `netTestPort`, honoured under `node --test` alone). It answers the Web
// API (form-encoded or JSON; bearer tokens checked: bot `xoxb-`, app-level `xapp-`), file uploads at
// /upload/v1/<id>, private file downloads at /files-pri/… (bearer required) and the Socket Mode
// WebSocket at /link/?ticket=… (RFC 6455: 101 with Sec-WebSocket-Accept, masked client frames, hello,
// envelopes with acks, ping/pong, disconnect, a drop). Every request is recorded (tokens hidden); any
// method can answer an error once or always (`ratelimited` with Retry-After, `invalid_auth` …).
import { createServer as httpsServer } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { makeCert } from '../../x509-test.ts';

export const BOT_TOKEN = 'xoxb-1111-2222-FakeBotTokenForTests';
export const APP_TOKEN = 'xapp-1-A0FAKE-3333-FakeAppLevelTokenForTests';
export const TEAM = 'T0FAKE';
export const BOT_USER = 'U0SARA';
export const BOT_ID = 'B0SARA';
export const OWNER = 'U0ALEX';
export const COLLEAGUE = 'U0MIA';
export const STRANGER = 'U0SPAM';
export const DM = 'D0ALEX';
export const DM_STRANGER = 'D0SPAM';
export const CHANNEL = 'C0GENERAL';
export const OTHER_CHANNEL = 'C0RANDOM';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class FakeSlack {
  constructor() {
    const now = Date.now();
    this.ca = makeCert({ cn: 'Sara test Slack CA', ca: true, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
    this.leaf = makeCert({ cn: 'slack.com', dns: ['slack.com', '*.slack.com', 'localhost'], issuer: this.ca, notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 7 * 86_400_000) });
    this.bot = BOT_TOKEN;
    this.app = APP_TOKEN;
    this.revoked = new Set();
    this.socketMode = true;
    this.requests = [];
    this.posts = [];
    this.updates = [];
    this.ephemeral = [];
    this.reactions = [];
    this.uploads = [];
    this.uploaded = new Map();
    this.downloads = [];
    this.errors = [];
    /** method → ms: answer that Web API method this much later (after recording it), as a slow Slack. */
    this.slow = new Map();
    this.files = new Map();
    this.tickets = new Set();
    this.conns = [];
    this.opens = 0;
    this.hellos = 0;
    this.acks = new Set();
    this.seq = 1000;
    this.users = new Map([[OWNER, 'alex'], [COLLEAGUE, 'mia'], [STRANGER, 'spam'], [BOT_USER, 'sara']]);
    this.channels = new Map([[DM, { id: DM, is_im: true, user: OWNER }], [DM_STRANGER, { id: DM_STRANGER, is_im: true, user: STRANGER }], [CHANNEL, { id: CHANNEL, name: 'general', is_channel: true, member: true }], [OTHER_CHANNEL, { id: OTHER_CHANNEL, name: 'random', is_channel: true, member: true }]]);
    this.port = 0;
  }

  get caPem() {
    return this.ca.pem;
  }

  async start() {
    this.server = httpsServer({ key: this.leaf.key.export({ type: 'pkcs8', format: 'pem' }), cert: this.leaf.pem }, (req, res) => void this.#serve(req, res));
    this.server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    this.sockets = new Set();
    this.server.on('secureConnection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const c of this.conns) c.socket.destroy();
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(() => r()));
  }

  /** The next message timestamp ("1700000000.001001"), increasing. */
  ts() {
    return `1700000000.${String(++this.seq).padStart(6, '0')}`;
  }

  // ------------------------------------------------------------------ the Web API

  #error(method) {
    const i = this.errors.findIndex((e) => e.method === method);
    if (i < 0) return undefined;
    const e = this.errors[i];
    if (e.once) this.errors.splice(i, 1);
    return e;
  }

  #kind(auth) {
    const tok = /^Bearer (.+)$/.exec(auth ?? '')?.[1] ?? '';
    if (!tok) return 'none';
    if (this.revoked.has(tok)) return 'revoked';
    if (tok === this.bot) return 'bot';
    if (tok === this.app) return 'app';
    return 'wrong';
  }

  async #serve(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'https://slack.com');
    const kind = this.#kind(req.headers.authorization);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json; charset=utf-8', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/upload/v1/')) {
      const id = url.pathname.slice('/upload/v1/'.length);
      if (!this.uploaded.has(id)) return send(404, 'no such upload');
      this.uploaded.set(id, { ...this.uploaded.get(id), bytes: fileOfMultipart(raw, req.headers['content-type'] ?? '') ?? raw });
      this.requests.push({ host: req.headers.host, method: 'upload', kind });
      return send(200, 'OK - 1');
    }
    if (url.pathname.startsWith('/files-pri/')) {
      const id = url.pathname.split('/')[2]?.split('-')[1];
      this.downloads.push({ host: req.headers.host, id, bearer: kind === 'bot' });
      if (kind !== 'bot') return send(302, '', { location: 'https://fake.slack.com/?redir=login' });
      const f = this.files.get(id);
      if (!f) return send(404, 'gone');
      res.writeHead(200, { 'content-type': f.mime, 'content-length': f.bytes.length });
      return res.end(f.bytes);
    }
    const method = url.pathname.replace(/^\/api\//, '');
    let args = {};
    const ct = String(req.headers['content-type'] ?? '');
    if (/json/.test(ct)) args = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    else for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) args[k] = v;
    for (const [k, v] of url.searchParams) args[k] = v;
    this.requests.push({ host: req.headers.host, method, kind, args });
    const e = this.#error(method);
    if (e) return send(e.status ?? 200, { ok: false, error: e.error, ...(e.needed ? { needed: e.needed } : {}) }, e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : {});
    if (kind === 'none') return send(200, { ok: false, error: 'not_authed' });
    if (kind === 'revoked') return send(200, { ok: false, error: 'token_revoked' });
    if (kind === 'wrong') return send(200, { ok: false, error: 'invalid_auth' });
    if (method === 'apps.connections.open') {
      if (kind !== 'app') return send(200, { ok: false, error: 'not_allowed_token_type' });
      if (!this.socketMode) return send(200, { ok: false, error: 'socket_mode_disabled' });
      const ticket = randomBytes(8).toString('hex');
      this.tickets.add(ticket);
      this.opens++;
      return send(200, { ok: true, url: `wss://wss-primary.slack.com/link/?ticket=${ticket}&app_id=A0FAKE` });
    }
    if (kind !== 'bot') return send(200, { ok: false, error: 'not_allowed_token_type' });
    const answer = this.#method(method, args);
    if (this.slow.has(method)) await new Promise((r) => setTimeout(r, this.slow.get(method)));
    return send(200, answer);
  }

  #method(method, a) {
    const json = (v) => (typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v);
    if (method === 'auth.test') return { ok: true, url: 'https://fake-team.slack.com/', team: 'Fake Team', user: 'sara', team_id: TEAM, user_id: BOT_USER, bot_id: BOT_ID };
    if (method === 'auth.revoke') {
      this.revoked.add(this.bot);
      return { ok: true, revoked: true };
    }
    if (method === 'chat.postMessage') {
      if (!this.channels.has(a.channel)) return { ok: false, error: 'channel_not_found' };
      if (this.channels.get(a.channel).member === false) return { ok: false, error: 'not_in_channel' };
      const ts = this.ts();
      const m = { channel: a.channel, ts, text: String(a.text ?? ''), blocks: json(a.blocks), thread_ts: a.thread_ts };
      this.posts.push(m);
      return { ok: true, channel: a.channel, ts, message: { ts, text: m.text } };
    }
    if (method === 'chat.postEphemeral') {
      this.ephemeral.push({ channel: a.channel, user: a.user, text: String(a.text ?? '') });
      return { ok: true, message_ts: this.ts() };
    }
    if (method === 'chat.update') {
      this.updates.push({ channel: a.channel, ts: a.ts, text: String(a.text ?? ''), blocks: json(a.blocks) });
      return { ok: true, channel: a.channel, ts: a.ts };
    }
    if (method === 'reactions.add') {
      this.reactions.push({ channel: a.channel, timestamp: a.timestamp, name: a.name });
      return { ok: true };
    }
    if (method === 'users.info') {
      const name = this.users.get(a.user);
      return name ? { ok: true, user: { id: a.user, name, real_name: name, profile: { display_name: name } } } : { ok: false, error: 'user_not_found' };
    }
    if (method === 'conversations.info') {
      const c = this.channels.get(a.channel);
      return c ? { ok: true, channel: { ...c } } : { ok: false, error: 'channel_not_found' };
    }
    if (method === 'users.conversations') return { ok: true, channels: [...this.channels.values()].filter((c) => c.is_channel && c.member !== false).map((c) => ({ id: c.id, name: c.name, is_private: false })), response_metadata: { next_cursor: '' } };
    if (method === 'files.getUploadURLExternal') {
      const id = `F${++this.seq}`;
      this.uploaded.set(id, { name: a.filename, length: Number(a.length) });
      return { ok: true, upload_url: `https://files.slack.com/upload/v1/${id}`, file_id: id };
    }
    if (method === 'files.completeUploadExternal') {
      const files = json(a.files) ?? [];
      for (const f of files) this.uploads.push({ id: f.id, title: f.title, channel: a.channel_id, thread_ts: a.thread_ts, comment: a.initial_comment, ...this.uploaded.get(f.id) });
      return { ok: true, files: files.map((f) => ({ id: f.id, title: f.title })) };
    }
    return { ok: false, error: 'unknown_method' };
  }

  /** A file he shares (its url_private_download needs the bot token). */
  addFile(name, mime, bytes) {
    const id = `F${++this.seq}`;
    this.files.set(id, { name, mime, bytes });
    return { id, name, mimetype: mime, size: bytes.length, mode: 'hosted', url_private_download: `https://files.slack.com/files-pri/${TEAM}-${id}/download/${name}` };
  }

  sentTo(channel) {
    return this.posts.filter((p) => p.channel === channel);
  }

  // ------------------------------------------------------------------ Socket Mode

  #upgrade(req, socket) {
    const url = new URL(req.url, 'https://wss-primary.slack.com');
    const ticket = url.searchParams.get('ticket') ?? '';
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/link/' || !this.tickets.has(ticket) || !key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.tickets.delete(ticket);
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, buf: Buffer.alloc(0), open: true, texts: [], pongs: 0 };
    this.conns.push(conn);
    socket.on('data', (b) => {
      conn.buf = Buffer.concat([conn.buf, b]);
      for (;;) {
        const f = readFrame(conn.buf);
        if (!f) break;
        conn.buf = conn.buf.subarray(f.size);
        if (!f.masked) conn.unmasked = true;
        if (f.op === 1) {
          const text = f.payload.toString('utf8');
          conn.texts.push(text);
          try {
            const m = JSON.parse(text);
            if (m.envelope_id) this.acks.add(m.envelope_id);
          } catch {
            /* not JSON */
          }
        } else if (f.op === 9) socket.write(frame(10, f.payload));
        else if (f.op === 10) conn.pongs++;
        else if (f.op === 8) {
          conn.open = false;
          socket.end(frame(8, Buffer.alloc(0)));
        }
      }
    });
    socket.on('close', () => (conn.open = false));
    socket.on('error', () => undefined);
    this.hellos++;
    this.#push(conn, { type: 'hello', num_connections: 1, debug_info: { host: 'fake-1', approximate_connection_time: 3600 }, connection_info: { app_id: 'A0FAKE' } });
  }

  #push(conn, obj) {
    if (conn?.open) conn.socket.write(frame(1, Buffer.from(JSON.stringify(obj))));
  }

  get live() {
    return this.conns.filter((c) => c.open).at(-1);
  }

  /** One envelope on the newest connection; its id (the plugin must ack it). */
  envelope(type, payload, more = {}) {
    const id = randomBytes(6).toString('hex');
    this.lastEnvelope = id;
    this.#push(this.live, { envelope_id: id, type, payload, accepts_response_payload: type !== 'events_api', ...more });
    return id;
  }

  event(ev) {
    const event_id = `Ev${++this.seq}`;
    return this.envelope('events_api', { token: 'x', team_id: TEAM, api_app_id: 'A0FAKE', type: 'event_callback', event_id, event_time: Math.floor(Date.now() / 1000), event: ev });
  }

  /** A DM to her (message.im). `o`: user, channel, thread_ts, files, subtype. */
  dm(text, o = {}) {
    const ts = this.ts();
    this.event({ type: 'message', channel: o.channel ?? DM, user: o.user ?? OWNER, text, ts, channel_type: 'im', event_ts: ts, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}), ...(o.files ? { files: o.files, subtype: 'file_share' } : {}) });
    return ts;
  }

  /** An @-mention of her in a channel (app_mention). */
  mention(text, o = {}) {
    const ts = this.ts();
    this.event({ type: 'app_mention', channel: o.channel ?? CHANNEL, user: o.user ?? OWNER, text: `<@${BOT_USER}> ${text}`, ts, event_ts: ts, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) });
    return ts;
  }

  /** A button press (block_actions) on one of her messages. */
  click(actionId, o = {}) {
    return this.envelope('interactive', { type: 'block_actions', user: { id: o.user ?? OWNER, name: this.users.get(o.user ?? OWNER) }, team: { id: TEAM }, channel: { id: o.channel ?? DM }, container: { type: 'message', message_ts: o.ts, channel_id: o.channel ?? DM }, message: { ts: o.ts, text: '' }, actions: [{ type: 'button', action_id: actionId, value: actionId, block_id: 'b', action_ts: this.ts() }] });
  }

  /** `/sara <text>` (slash_commands). */
  slash(text, o = {}) {
    return this.envelope('slash_commands', { command: '/sara', text, user_id: o.user ?? OWNER, channel_id: o.channel ?? DM, team_id: TEAM, trigger_id: 't1' });
  }

  disconnect(reason = 'refresh_requested') {
    this.#push(this.live, { type: 'disconnect', reason, debug_info: { host: 'fake-1' } });
  }

  /** The connection drops with no close frame (a network blip). */
  drop() {
    for (const c of this.conns) {
      c.open = false;
      c.socket.destroy();
    }
  }

  ping() {
    if (this.live) this.live.socket.write(frame(9, Buffer.from('hb')));
  }
}

/** One unmasked server frame (FIN set). */
export function frame(op, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** One frame from the front of `buf` (unmasked if masked), or undefined until it is complete. */
export function readFrame(buf) {
  if (buf.length < 2) return undefined;
  const op = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let len = buf[1] & 127;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? buf.subarray(at, at + 4) : undefined;
  if (masked) at += 4;
  if (buf.length < at + len) return undefined;
  const payload = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { op, masked, payload, size: at + len };
}

/** The file part of a multipart/form-data body (or undefined). */
function fileOfMultipart(raw, type) {
  const b = /boundary=([^;]+)/.exec(type)?.[1];
  if (!b) return undefined;
  const s = raw.toString('latin1');
  const start = s.indexOf('filename="');
  if (start < 0) return undefined;
  const body = s.indexOf('\r\n\r\n', start) + 4;
  const end = s.indexOf(`\r\n--${b}`, body);
  return Buffer.from(s.slice(body, end), 'latin1');
}

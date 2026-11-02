// Phase 122 part 2 (docs/design/BRIDGES4.md §11.1): a stand-in Matrix homeserver (the client-server
// API), written here: no real Matrix account, no real network. HTTPS on a self-signed test CA
// (test/mail-fake.ts testCerts), reached by the real plugin through Sara's socket broker and its
// test-only loopback override. It answers /.well-known, /versions, GET|POST /login (the password flow
// can be switched off), whoami, filters, /sync (a real long-poll up to `timeout`), join, leave, send
// (deduped by txn), typing, receipts, profile, joined_members, media upload, authenticated download
// (bearer required), media config and logout. It records every request (the token hidden), can answer
// any error once or always (429 with Retry-After, 401 M_UNKNOWN_TOKEN …) and drop a sync mid-way.
//
// Live check: node test/fixtures/matrix/hs.mjs --port 7894 --control 7895 --dir <folder>
// (writes ca.pem there; the control port takes POST /invite, /say, /image, /encrypt, /state).
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testCerts } from '../../mail-fake.ts';

export const HER = '@sara-frank:hs.test';
export const HER_PASSWORD = 'correct horse battery';
export const OWNER = '@alex:hs.test';
export const STRANGER = '@spam:elsewhere.test';
export const PARTNER = '@mia:family.test';

export class FakeHomeserver {
  constructor(o = {}) {
    this.certs = testCerts('hs.test');
    this.users = new Map([[HER, HER_PASSWORD]]);
    this.passwordFlow = true;
    this.versionsList = ['v1.11', 'v1.12'];
    this.wellKnown = undefined;
    this.uploadMax = o.uploadMax ?? 10 * 1024 * 1024;
    this.tokens = new Map();
    this.rooms = new Map();
    this.stream = [];
    this.pos = 1;
    this.invites = [];
    this.requests = [];
    this.sent = [];
    this.typing = [];
    this.receipts = [];
    this.logouts = 0;
    this.media = new Map();
    this.errors = [];
    this.dropSync = 0;
    this.waiters = new Set();
    this.seq = 0;
    this.txns = new Map();
    this.port = 0;
  }

  get caPem() {
    return this.certs.ca.pem;
  }

  async start(port = 0, host = '127.0.0.1') {
    this.server = httpsServer({ key: this.certs.key, cert: this.certs.leaf.pem }, (req, res) => void this.#serve(req, res));
    this.sockets = new Set();
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise((r) => this.server.listen(port, host, r));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const w of this.waiters) w();
    for (const s of this.sockets ?? []) s.destroy();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  // ------------------------------------------------------------------ test helpers

  room(o = {}) {
    const id = o.id ?? `!r${++this.seq}x:hs.test`;
    this.rooms.set(id, { id, name: o.name ?? '', encrypted: o.encrypted === true, members: new Set(o.members ?? []), creator: o.creator ?? OWNER });
    return id;
  }
  #push(room, ev) {
    const e = { event_id: ev.event_id ?? `$e${++this.seq}x`, origin_server_ts: ev.origin_server_ts ?? Date.now(), room_id: room, ...ev };
    this.stream.push({ pos: ++this.pos, room, ev: e });
    for (const w of this.waiters) w();
    return e.event_id;
  }
  /** Someone invites her (stripped state carries the name and, for an encrypted room, m.room.encryption). */
  invite(from, o = {}) {
    const id = this.room({ name: o.name ?? 'Sara', encrypted: o.encrypted, members: [from, ...(o.members ?? [])], creator: from });
    this.invites.push({ room: id, from, pos: ++this.pos });
    for (const w of this.waiters) w();
    return id;
  }
  /** A message (or any event) from someone in a room. */
  say(room, from, content, type = 'm.room.message') {
    return this.#push(room, { type, sender: from, content });
  }
  text(room, from, body, more = {}) {
    return this.say(room, from, { msgtype: 'm.text', body, ...more });
  }
  encrypt(room, from = OWNER) {
    this.rooms.get(room).encrypted = true;
    return this.#push(room, { type: 'm.room.encryption', sender: from, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } });
  }
  join(room, user) {
    this.rooms.get(room).members.add(user);
    return this.#push(room, { type: 'm.room.member', sender: user, state_key: user, content: { membership: 'join' } });
  }
  putMedia(bytes, mime) {
    const id = `m${++this.seq}`;
    this.media.set(id, { bytes, mime });
    return `mxc://hs.test/${id}`;
  }
  /** Answer the next request matching `match` with an error (once unless `always`). */
  fail(match, status, errcode, o = {}) {
    this.errors.push({ match, status, errcode, retryAfter: o.retryAfter, once: !o.always, error: o.error ?? errcode });
  }
  sentTo(room, type = 'm.room.message') {
    return this.sent.filter((x) => x.room === room && x.type === type);
  }

  // ------------------------------------------------------------------ serving

  async #serve(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'https://hs.test');
    const path = url.pathname;
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    let body = {};
    if (raw.length && /json/.test(String(req.headers['content-type'] ?? ''))) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = {};
      }
    }
    const rec = { method: req.method, path, query: Object.fromEntries(url.searchParams), auth: auth ? '[token]' : null, body: path.endsWith('/login') && body.password ? { ...body, password: '[password]' } : body, at: Date.now() };
    this.requests.push(rec);
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const err = this.errors.find((e) => e.match.test(`${req.method} ${path}`));
    if (err) {
      if (err.once) this.errors.splice(this.errors.indexOf(err), 1);
      return json(err.status, { errcode: err.errcode, error: err.error }, err.retryAfter !== undefined ? { 'retry-after': String(err.retryAfter) } : {});
    }
    if (path === '/.well-known/matrix/client') return this.wellKnown ? json(200, { 'm.homeserver': { base_url: this.wellKnown } }) : json(404, { errcode: 'M_NOT_FOUND' });
    if (path === '/_matrix/client/versions') return json(200, { versions: this.versionsList });
    if (path === '/_matrix/client/v3/login' && req.method === 'GET') return json(200, { flows: this.passwordFlow ? [{ type: 'm.login.password' }, { type: 'm.login.sso' }] : [{ type: 'm.login.sso' }] });
    if (path === '/_matrix/client/v3/login' && req.method === 'POST') {
      const user = String(body.identifier?.user ?? '');
      const mx = user.startsWith('@') ? user : `@${user}:hs.test`;
      if (!this.passwordFlow) return json(400, { errcode: 'M_UNKNOWN', error: 'Unknown login type' });
      if (this.users.get(mx) !== body.password) return json(403, { errcode: 'M_FORBIDDEN', error: 'Invalid username or password' });
      const token = `syt_${Buffer.from(mx).toString('base64url').slice(0, 12)}_${'k'.repeat(20)}${++this.seq}`;
      const device = `DEV${this.seq}`;
      this.tokens.set(token, { user: mx, device, name: body.initial_device_display_name });
      return json(200, { access_token: token, device_id: device, user_id: mx, home_server: 'hs.test' });
    }
    // Everything else needs her token.
    const who = auth ? this.tokens.get(auth) : undefined;
    const media = path.startsWith('/_matrix/client/v1/media/download/');
    if (!who) return json(401, { errcode: auth ? 'M_UNKNOWN_TOKEN' : 'M_MISSING_TOKEN', error: media ? 'media needs the bearer token' : 'Unknown access token' });
    const me = who.user;
    let m;
    if (path === '/_matrix/client/v3/account/whoami') return json(200, { user_id: me, device_id: who.device });
    if (path === '/_matrix/client/v3/logout') {
      this.tokens.delete(auth);
      this.logouts++;
      return json(200, {});
    }
    if ((m = /^\/_matrix\/client\/v3\/user\/([^/]+)\/filter$/.exec(path))) return json(200, { filter_id: `f${++this.seq}` });
    if ((m = /^\/_matrix\/client\/v3\/profile\/([^/]+)\/displayname$/.exec(path))) {
      this.displayName = body.displayname;
      return json(200, {});
    }
    if (path === '/_matrix/client/v3/sync') return this.#sync(url, me, res, json);
    if ((m = /^\/_matrix\/client\/v3\/join\/([^/]+)$/.exec(path))) {
      const room = decodeURIComponent(m[1]);
      if (!this.rooms.has(room)) return json(404, { errcode: 'M_NOT_FOUND' });
      this.invites = this.invites.filter((x) => x.room !== room);
      this.join(room, me);
      return json(200, { room_id: room });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/leave$/.exec(path))) {
      const room = decodeURIComponent(m[1]);
      this.invites = this.invites.filter((x) => x.room !== room);
      const r = this.rooms.get(room);
      if (r?.members.has(me)) {
        r.members.delete(me);
        this.#push(room, { type: 'm.room.member', sender: me, state_key: me, content: { membership: 'leave' } });
      }
      (this.left ??= []).push(room);
      return json(200, {});
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(path))) {
      const room = decodeURIComponent(m[1]);
      const type = decodeURIComponent(m[2]);
      const txn = decodeURIComponent(m[3]);
      const key = `${auth}/${txn}`;
      if (this.txns.has(key)) return json(200, { event_id: this.txns.get(key) });
      const id = this.#push(room, { type, sender: me, content: body });
      this.txns.set(key, id);
      this.sent.push({ room, type, txn, content: body, event_id: id, at: Date.now() });
      return json(200, { event_id: id });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/.exec(path))) {
      this.typing.push({ room: decodeURIComponent(m[1]), typing: body.typing === true, timeout: body.timeout, at: Date.now() });
      return json(200, {});
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/receipt\/m\.read\/([^/]+)$/.exec(path))) {
      this.receipts.push({ room: decodeURIComponent(m[1]), event: decodeURIComponent(m[2]) });
      return json(200, {});
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/.exec(path))) {
      const r = this.rooms.get(decodeURIComponent(m[1]));
      return json(200, { joined: Object.fromEntries([...(r?.members ?? [])].map((x) => [x, {}])) });
    }
    if (path === '/_matrix/client/v1/media/config' || path === '/_matrix/media/v3/config') return json(200, { 'm.upload.size': this.uploadMax });
    if (path === '/_matrix/media/v3/upload' && req.method === 'POST') {
      if (raw.length > this.uploadMax) return json(413, { errcode: 'M_TOO_LARGE', error: 'too large' });
      const uri = this.putMedia(raw, String(req.headers['content-type'] ?? 'application/octet-stream'));
      (this.uploads ??= []).push({ uri, size: raw.length, type: req.headers['content-type'], name: url.searchParams.get('filename') });
      return json(200, { content_uri: uri });
    }
    if ((m = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(path))) {
      const f = this.media.get(decodeURIComponent(m[2]));
      if (!f) return json(404, { errcode: 'M_NOT_FOUND' });
      (this.downloads ??= []).push({ id: m[2], bearer: Boolean(auth) });
      res.writeHead(200, { 'content-type': f.mime, 'content-length': String(f.bytes.length) });
      return res.end(f.bytes);
    }
    return json(404, { errcode: 'M_UNRECOGNIZED', error: `no ${req.method} ${path}` });
  }

  #sync(url, me, res, json) {
    const since = Number(url.searchParams.get('since') ?? 0);
    const timeout = Math.min(60_000, Number(url.searchParams.get('timeout') ?? 0));
    const build = () => {
      const out = { next_batch: String(this.pos), rooms: { join: {}, invite: {}, leave: {} } };
      let any = false;
      for (const inv of this.invites) {
        if (since && inv.pos <= since) continue;
        const r = this.rooms.get(inv.room);
        const evs = [{ type: 'm.room.member', sender: inv.from, state_key: me, content: { membership: 'invite' } }, ...(r.name ? [{ type: 'm.room.name', sender: inv.from, state_key: '', content: { name: r.name } }] : []), ...(r.encrypted ? [{ type: 'm.room.encryption', sender: inv.from, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] : [])];
        out.rooms.invite[inv.room] = { invite_state: { events: evs } };
        any = true;
      }
      for (const [id, r] of this.rooms) {
        if (!r.members.has(me)) continue;
        const evs = this.stream.filter((x) => x.room === id && x.pos > since).map((x) => x.ev);
        if (!since) {
          // The first sync: the room's state and only its newest event.
          const state = [...[...r.members].map((u) => ({ type: 'm.room.member', sender: u, state_key: u, content: { membership: 'join' }, event_id: `$s${++this.seq}` })), ...(r.name ? [{ type: 'm.room.name', state_key: '', sender: r.creator, content: { name: r.name }, event_id: `$s${++this.seq}` }] : []), ...(r.encrypted ? [{ type: 'm.room.encryption', state_key: '', sender: r.creator, content: {}, event_id: `$s${++this.seq}` }] : [])];
          out.rooms.join[id] = { state: { events: state }, timeline: { events: evs.slice(-1), limited: evs.length > 1 }, summary: { 'm.joined_member_count': r.members.size } };
          any = true;
          continue;
        }
        if (!evs.length) continue;
        const joinedNow = evs.some((e) => e.type === 'm.room.member' && e.state_key === me && e.content?.membership === 'join');
        const state = joinedNow ? [...[...r.members].map((u) => ({ type: 'm.room.member', sender: u, state_key: u, content: { membership: 'join' }, event_id: `$s${++this.seq}` })), ...(r.name ? [{ type: 'm.room.name', state_key: '', sender: r.creator, content: { name: r.name }, event_id: `$s${++this.seq}` }] : [])] : [];
        out.rooms.join[id] = { state: { events: state }, timeline: { events: evs, limited: false }, summary: { 'm.joined_member_count': r.members.size } };
        any = true;
      }
      for (const id of this.left ?? []) if (this.stream.some((x) => x.room === id && x.pos > since)) out.rooms.leave[id] = {};
      return { out, any };
    };
    if (this.dropSync > 0 && since) {
      this.dropSync--;
      return res.socket?.destroy();
    }
    const first = build();
    if (first.any || !since || timeout <= 0) return json(200, first.out);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.waiters.delete(wake);
      clearTimeout(timer);
      if (!res.destroyed) json(200, build().out);
    };
    const wake = () => setTimeout(finish, 5);
    this.waiters.add(wake);
    const timer = setTimeout(finish, timeout);
    res.on('close', () => {
      done = true;
      this.waiters.delete(wake);
      clearTimeout(timer);
    });
  }
}

// ------------------------------------------------------------------ the live check's control port

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const hs = await new FakeHomeserver().start(Number(arg('port', 7894)), arg('host', '::'));
  const dir = arg('dir', '.');
  writeFileSync(join(dir, 'ca.pem'), hs.caPem);
  const ctl = httpServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let b = {};
    try {
      b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      b = {};
    }
    const u = new URL(req.url ?? '/', 'http://x');
    const out = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/invite') return out({ room: hs.invite(b.from ?? OWNER, { name: b.name, encrypted: b.encrypted === true }) });
    if (u.pathname === '/say') return out({ event: hs.text(b.room, b.from ?? OWNER, b.body ?? '', b.more ?? {}) });
    if (u.pathname === '/image') {
      const bytes = Buffer.from(b.base64 ?? '', 'base64');
      const uri = hs.putMedia(bytes, b.mime ?? 'image/png');
      return out({ event: hs.say(b.room, b.from ?? OWNER, { msgtype: 'm.image', body: b.name ?? 'photo.png', url: uri, info: { mimetype: b.mime ?? 'image/png', size: bytes.length } }) });
    }
    if (u.pathname === '/encrypt') return out({ event: hs.encrypt(b.room) });
    if (u.pathname === '/revoke') {
      hs.tokens.clear();
      return out({ ok: true });
    }
    if (u.pathname === '/state') return out({ rooms: [...hs.rooms.values()].map((r) => ({ id: r.id, name: r.name, encrypted: r.encrypted, members: [...r.members] })), sent: hs.sent, typing: hs.typing.length, receipts: hs.receipts, left: hs.left ?? [], downloads: hs.downloads ?? [], logouts: hs.logouts, displayName: hs.displayName, requests: hs.requests.length });
    res.writeHead(404);
    res.end();
  });
  ctl.listen(Number(arg('control', 7895)), '127.0.0.1');
  console.log(`stand-in homeserver on https://localhost:${hs.port} (control ${arg('control', 7895)}); ca.pem in ${dir}`);
}

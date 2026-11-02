// The Matrix client-server API calls the plugin makes (docs/design/BRIDGES4.md §2.9, §6.2–§6.3),
// over HTTP/1.1 on sockets Sara holds for it (http1.mjs, the broker). Two endpoints in the manifest:
// `hs` (a public homeserver, TLS always, ports 443/8448) and `hs-local` (his own homeserver at home or
// on his tailnet, with *My homeserver runs on my network*; TLS on 443/8448, plain otherwise, as
// Synapse's own 8008). The host is always the owner's `homeserver` setting: a changed .well-known
// can't move her anywhere (it is shown on the card for him to confirm instead).
import { Http1 } from './http1.mjs';
import { retryAfterMs } from './pace.mjs';

export const SYNC_TIMEOUT_MS = 30_000;
/** The long-poll read: the server holds /sync up to 30 s; the socket waits 40 s (B4). */
export const SYNC_WAIT_MS = 40_000;
export const DEVICE_NAME = 'Sara (bot)';

export class MatrixError extends Error {
  constructor(status, body = {}, headers = {}, o = {}) {
    super(String(body?.error ?? `HTTP ${status}`).replace(/(syt|syr|mat|mct)_[A-Za-z0-9_\-]{8,}/g, '[token]').slice(0, 300));
    this.status = status;
    this.errcode = String(body?.errcode ?? (status === 429 ? 'M_LIMIT_EXCEEDED' : ''));
    this.softLogout = body?.soft_logout === true;
    this.retryMs = status === 429 ? retryAfterMs(headers, body) : undefined;
    this.login = o.login === true;
  }
}

/** `@local:server` → its server part (with a port when given), else ''. */
export function serverOf(mxid) {
  const m = /^@[^:\s]{1,255}:([A-Za-z0-9.-]{1,253}(?::\d{1,5})?|\[[0-9a-fA-F:.]+\](?::\d{1,5})?)$/.exec(String(mxid ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** A .well-known's `m.homeserver.base_url` → `host[:port]` (https only; a path is not supported). */
export function baseHost(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return '';
  }
}

export class Client {
  constructor(sara) {
    this.sara = sara;
    this.main = undefined;
    this.syncConn = undefined;
  }

  get local() {
    return this.sara.settings.onOtherMachine === true;
  }
  get host() {
    return String(this.sara.settings.homeserver ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
  get token() {
    return String(this.sara.secrets.token ?? '').trim();
  }

  #conn(which) {
    const host = this.host;
    const port = Number(/:(\d+)$/.exec(host)?.[1] ?? 443);
    const o = this.local ? { port, tls: port === 443 || port === 8448 } : { port: port === 8448 ? 8448 : 443 };
    const name = host.replace(/:\d+$/, '');
    if (which === 'sync') return (this.syncConn ??= new Http1(this.sara, this.local ? 'hs-local' : 'hs', name, { ...o, ua: 'Sara-Matrix/1.0' }));
    return (this.main ??= new Http1(this.sara, this.local ? 'hs-local' : 'hs', name, { ...o, ua: 'Sara-Matrix/1.0' }));
  }

  /** One call: JSON in and out (or raw bytes for media), the bearer token unless `noAuth`. */
  async call(method, path, body, o = {}) {
    if (!this.host) throw new MatrixError(0, { errcode: 'SARA_NOT_SET', error: 'no homeserver yet' });
    const headers = {};
    if (!o.noAuth) {
      if (!this.token) throw new MatrixError(401, { errcode: 'M_MISSING_TOKEN', error: 'not logged in yet' });
      headers.Authorization = `Bearer ${this.token}`;
    }
    let payload;
    if (o.raw) {
      payload = o.raw;
      headers['Content-Type'] = o.type || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await this.#conn(o.sync ? 'sync' : 'main').request(method, path, headers, payload, o.timeoutMs ? { timeoutMs: o.timeoutMs } : {});
    if (o.bytes && r.status < 400) return { bytes: r.body, type: r.headers['content-type'] ?? '' };
    let data = {};
    try {
      data = r.body.length ? JSON.parse(r.body.toString('utf8')) : {};
    } catch {
      data = {};
    }
    if (r.status >= 400) throw new MatrixError(r.status, data, r.headers, { login: o.login });
    return data;
  }

  async close() {
    await this.main?.close();
    await this.syncConn?.close();
    this.main = undefined;
    this.syncConn = undefined;
  }

  // ------------------------------------------------------------------ the calls

  wellKnown() {
    return this.call('GET', '/.well-known/matrix/client', undefined, { noAuth: true });
  }
  versions() {
    return this.call('GET', '/_matrix/client/versions', undefined, { noAuth: true });
  }
  loginFlows() {
    return this.call('GET', '/_matrix/client/v3/login', undefined, { noAuth: true });
  }
  /** Password once (§6.2): no refresh token asked for; the password is not kept anywhere. */
  login(user, password) {
    return this.call('POST', '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: DEVICE_NAME }, { noAuth: true, login: true });
  }
  whoami() {
    return this.call('GET', '/_matrix/client/v3/account/whoami');
  }
  logout() {
    return this.call('POST', '/_matrix/client/v3/logout', {});
  }
  setName(me, name) {
    return this.call('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(me)}/displayname`, { displayname: name });
  }
  filter(me, body) {
    return this.call('POST', `/_matrix/client/v3/user/${encodeURIComponent(me)}/filter`, body);
  }
  sync(since, filter, timeout = SYNC_TIMEOUT_MS) {
    const q = new URLSearchParams({ timeout: String(timeout), ...(filter ? { filter: String(filter) } : {}), ...(since ? { since } : {}) });
    return this.call('GET', `/_matrix/client/v3/sync?${q}`, undefined, { sync: true, timeoutMs: since ? SYNC_WAIT_MS : SYNC_WAIT_MS + 20_000 });
  }
  join(room) {
    return this.call('POST', `/_matrix/client/v3/join/${encodeURIComponent(room)}`, {});
  }
  leave(room) {
    return this.call('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/leave`, {});
  }
  send(room, type, txn, content) {
    return this.call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txn)}`, content);
  }
  typing(room, me, on) {
    return this.call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/typing/${encodeURIComponent(me)}`, on ? { typing: true, timeout: 30_000 } : { typing: false });
  }
  receipt(room, eventId) {
    return this.call('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/receipt/m.read/${encodeURIComponent(eventId)}`, {});
  }
  members(room) {
    return this.call('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/joined_members`);
  }
  mediaConfig(authenticated) {
    return this.call('GET', authenticated ? '/_matrix/client/v1/media/config' : '/_matrix/media/v3/config');
  }
  /** Authenticated media (v1.11) with the bearer; the old unauthenticated path only for older servers. */
  download(server, mediaId, authenticated) {
    const s = encodeURIComponent(server);
    const id = encodeURIComponent(mediaId);
    return this.call('GET', authenticated ? `/_matrix/client/v1/media/download/${s}/${id}` : `/_matrix/media/v3/download/${s}/${id}`, undefined, { bytes: true, noAuth: !authenticated, timeoutMs: 60_000 });
  }
  upload(bytes, type, name) {
    return this.call('POST', `/_matrix/media/v3/upload?filename=${encodeURIComponent(String(name ?? 'file').slice(0, 120))}`, undefined, { raw: bytes, type, timeoutMs: 60_000 });
  }
}

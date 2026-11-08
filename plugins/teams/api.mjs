// The Microsoft calls the plugin makes (docs/ops/EC7_DESIGN.md), over HTTP/1.1 on sockets Sara holds
// for it (http1.mjs, the broker). Three endpoints in the manifest, all `domain:` (port 443, TLS always):
//   login      login.microsoftonline.com   the client-credentials token for the Bot Connector
//   connector  smba.trafficmanager.net     send, reply, update, inline pictures (bearer)
//   files      sharepoint.com              his OneDrive: file downloads and her file-consent uploads
// Sara allows nothing outside those domains. The token is cached until 5 minutes before it expires and
// fetched again once on a 401. Errors become a TeamsError (status, AADSTS code, Retry-After).
import { Http1 } from './http1.mjs';
import { maskSecrets } from './diagnose.mjs';

export const LOGIN_HOST = 'login.microsoftonline.com';
export const CONNECTOR_HOST = 'smba.trafficmanager.net';
export const DEFAULT_SERVICE = 'https://smba.trafficmanager.net/teams/';
const SCOPE = 'https://api.botframework.com/.default';
const CHUNK = 10 * 320 * 1024;

export class TeamsError extends Error {
  constructor(what, status = 0, body = {}, headers = {}, secret = '') {
    const desc = String(body?.error_description ?? body?.error?.message ?? body?.message ?? '');
    const aad = /AADSTS\d{5,8}/.exec(desc)?.[0] ?? '';
    super(maskSecrets(`${what}: ${status ? `HTTP ${status}` : ''}${aad ? ` ${aad}` : ''}${desc && !aad ? ` ${desc.slice(0, 120)}` : ''}`, secret).slice(0, 300));
    this.status = status;
    this.aad = aad;
    const ra = Number(headers['retry-after']);
    this.retryMs = status === 429 ? (Number.isFinite(ra) && ra >= 0 ? Math.min(300_000, ra * 1000) : 5_000) : undefined;
  }
}

const json = (buf) => {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
};
const hostOk = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export class Api {
  constructor(sara) {
    this.sara = sara;
    this.conns = new Map();
    this.token = '';
    this.until = 0;
  }

  get appId() {
    return String(this.sara.settings.appId ?? '').trim();
  }
  get tenant() {
    return String(this.sara.settings.tenantId ?? '').trim() || 'botframework.com';
  }
  get secret() {
    return String(this.sara.secrets.appPassword ?? '').trim();
  }
  get ready() {
    return Boolean(this.appId && this.secret);
  }

  #conn(endpoint, host) {
    const key = `${endpoint}@${host}`;
    let c = this.conns.get(key);
    if (!c) this.conns.set(key, (c = new Http1(this.sara, key, host, { ua: 'Sara-Teams/1.0' })));
    return c;
  }

  /** The Bot Connector token (client credentials); `fresh` skips the cache. */
  async bearer(fresh = false) {
    if (!fresh && this.token && Date.now() < this.until) return this.token;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.appId, client_secret: this.secret, scope: SCOPE }).toString();
    const r = await this.#conn('login', LOGIN_HOST).request('POST', `/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`, { 'content-type': 'application/x-www-form-urlencoded' }, form);
    const body = json(r.body);
    if (r.status !== 200 || typeof body.access_token !== 'string') throw new TeamsError('token', r.status, body, r.headers, this.secret);
    this.token = body.access_token;
    this.until = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 5 * 60_000;
    return this.token;
  }

  forget() {
    this.token = '';
    this.until = 0;
  }

  /** One Connector call: `serviceUrl` + `path`, the bearer, JSON both ways; a 401 refetches the token once. */
  async connector(method, serviceUrl, path, body) {
    const base = new URL(String(serviceUrl || DEFAULT_SERVICE));
    if (base.protocol !== 'https:' || base.hostname !== CONNECTOR_HOST) throw new TeamsError('not the Bot Connector');
    const full = `${base.pathname.replace(/\/+$/, '')}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.bearer(attempt > 0);
      const r = await this.#conn('connector', CONNECTOR_HOST).request(method, full, { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}) }, body !== undefined ? JSON.stringify(body) : undefined);
      if (r.status === 401 && attempt === 0) continue;
      if (r.status >= 300) throw new TeamsError(`${method} ${path.split('/').slice(0, 4).join('/')}`, r.status, json(r.body), r.headers);
      return json(r.body);
    }
  }

  send(serviceUrl, conversation, activity, replyTo) {
    return this.connector('POST', serviceUrl, `/v3/conversations/${encodeURIComponent(conversation)}/activities${replyTo ? `/${encodeURIComponent(replyTo)}` : ''}`, activity);
  }

  update(serviceUrl, conversation, id, activity) {
    return this.connector('PUT', serviceUrl, `/v3/conversations/${encodeURIComponent(conversation)}/activities/${encodeURIComponent(id)}`, { ...activity, id });
  }

  /** A file he sent: an inline picture on the Connector (bearer) or a OneDrive download link (pre-signed). */
  async download(url, max) {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') throw new TeamsError('not an https file address');
    let r;
    if (u.hostname === CONNECTOR_HOST) r = await this.#conn('connector', CONNECTOR_HOST).request('GET', `${u.pathname}${u.search}`, { authorization: `Bearer ${await this.bearer()}` });
    else if (hostOk(u.hostname, 'sharepoint.com')) r = await this.#conn('files', u.hostname).request('GET', `${u.pathname}${u.search}`, {});
    else throw new TeamsError('not a Teams file address');
    if (r.status !== 200) throw new TeamsError('download', r.status, {}, r.headers);
    if (max && r.body.length > max) throw Object.assign(new TeamsError('download', 413), { status: 413 });
    return { bytes: r.body, type: String(r.headers['content-type'] ?? 'application/octet-stream').split(';')[0] };
  }

  /** Her file into his OneDrive (the upload address Teams gave on his Allow), in 3.2 MB chunks. */
  async upload(uploadUrl, data) {
    const u = new URL(String(uploadUrl));
    if (u.protocol !== 'https:' || !hostOk(u.hostname, 'sharepoint.com')) throw new TeamsError('not a OneDrive upload address');
    const c = this.#conn('files', u.hostname);
    for (let at = 0; at < data.length || (at === 0 && data.length === 0); at += CHUNK) {
      const part = data.subarray(at, Math.min(data.length, at + CHUNK));
      const r = await c.request('PUT', `${u.pathname}${u.search}`, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${at}-${at + part.length - 1}/${data.length}` }, part);
      if (r.status !== 200 && r.status !== 201 && r.status !== 202) throw new TeamsError('upload', r.status, json(r.body), r.headers);
      if (!data.length) break;
    }
  }

  async close() {
    for (const c of this.conns.values()) await c.close();
    this.conns.clear();
  }
}

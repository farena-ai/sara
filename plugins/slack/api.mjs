// The Slack Web API calls the plugin makes (docs/ops/EC1_DESIGN.md), over HTTP/1.1 on sockets Sara
// holds for it (http1.mjs, the broker). One endpoint in the manifest, `slack` = `domain:slack.com`
// (port 443, TLS always): the API at slack.com, files at files.slack.com, Socket Mode at
// wss-*.slack.com; Sara allows nothing outside slack.com. Every call is a form-encoded POST (Slack
// takes that for every method; blocks and file lists ride as JSON strings) with the bot token, except
// apps.connections.open (the app-level token). `{ ok: false }` and HTTP 429 become a SlackError with
// Slack's own error word; Retry-After is kept for the pacer.
import { Http1, multipart } from './http1.mjs';
import { maskTokens } from './diagnose.mjs';

export const ENDPOINT = 'slack';
export const API_HOST = 'slack.com';

export class SlackError extends Error {
  constructor(method, body = {}, status = 200, headers = {}, o = {}) {
    const error = String(body?.error ?? (status === 429 ? 'ratelimited' : `http_${status}`));
    super(maskTokens(`${method}: ${error}${body?.needed ? ` (needs ${body.needed})` : ''}`).slice(0, 300));
    this.method = method;
    this.error = error;
    this.status = status;
    this.needed = body?.needed ? String(body.needed).slice(0, 80) : undefined;
    const ra = Number(headers['retry-after']);
    this.retryMs = status === 429 || error === 'ratelimited' ? (Number.isFinite(ra) && ra >= 0 ? Math.min(300_000, ra * 1000) : 5_000) : undefined;
    this.socket = o.socket === true;
  }
}

const form = (args) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  return p.toString();
};

export class Api {
  constructor(sara) {
    this.sara = sara;
    this.conns = new Map();
  }

  get bot() {
    return String(this.sara.secrets.botToken ?? '').trim();
  }

  get app() {
    return String(this.sara.secrets.appToken ?? '').trim();
  }

  #conn(host) {
    let c = this.conns.get(host);
    if (!c) this.conns.set(host, (c = new Http1(this.sara, `${ENDPOINT}@${host}`, host, { ua: 'Sara-Slack/1.0' })));
    return c;
  }

  /** `call('chat.postMessage', { channel, text })` → Slack's answer (ok: true), or a SlackError. */
  async call(method, args = {}, o = {}) {
    const token = o.app ? this.app : this.bot;
    const r = await this.#conn(API_HOST).request('POST', `/api/${method}`, { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, form(args));
    let body = {};
    try {
      body = JSON.parse(r.body.toString('utf8'));
    } catch {
      body = {};
    }
    if (r.status === 429 || r.status >= 400 || body.ok !== true) throw new SlackError(method, body, r.status, r.headers, { socket: method === 'apps.connections.open' });
    return body;
  }

  /** A private file (`url_private_download`) with the bot token; only from slack.com hosts. */
  async download(url, max) {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || !(u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'))) throw new Error('not a Slack file address');
    const r = await this.#conn(u.hostname).request('GET', `${u.pathname}${u.search}`, { authorization: `Bearer ${this.bot}` });
    if (r.status !== 200) throw new SlackError('files.download', { error: r.status === 302 || r.status === 403 ? 'not_authed' : `http_${r.status}` }, r.status, r.headers);
    if (max && r.body.length > max) throw new SlackError('files.download', { error: 'file_too_large' });
    // A sign-in page instead of the file means the token was not accepted for it.
    if (/text\/html/i.test(r.headers['content-type'] ?? '')) throw new SlackError('files.download', { error: 'missing_scope', needed: 'files:read' });
    return { bytes: r.body, type: String(r.headers['content-type'] ?? 'application/octet-stream').split(';')[0] };
  }

  /** Her file: getUploadURLExternal, the bytes, completeUploadExternal into the channel (and thread). */
  async upload(channel, file, o = {}) {
    const start = await this.call('files.getUploadURLExternal', { filename: String(file.name ?? 'file').slice(0, 120), length: file.data.length });
    const u = new URL(String(start.upload_url));
    if (u.protocol !== 'https:' || !(u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'))) throw new Error('not a Slack upload address');
    const body = multipart({}, { name: file.name, mime: file.mime, data: file.data });
    const r = await this.#conn(u.hostname).request('POST', `${u.pathname}${u.search}`, { 'content-type': body.type }, body.body);
    if (r.status !== 200) throw new SlackError('files.upload', { error: `http_${r.status}` }, r.status, r.headers);
    return this.call('files.completeUploadExternal', { files: [{ id: String(start.file_id), title: String(file.name ?? 'file').slice(0, 120) }], channel_id: channel, ...(o.thread ? { thread_ts: o.thread } : {}), ...(o.comment ? { initial_comment: o.comment } : {}) });
  }

  async close() {
    for (const c of this.conns.values()) await c.close();
    this.conns.clear();
  }
}

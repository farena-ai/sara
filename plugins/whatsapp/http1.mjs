// HTTP/1.1 over a socket Sara holds for the plugin (docs/design/WHATSAPP.md §3.1 W3). The plugin
// never opens a socket: sara.net.open(endpoint) gives a TLS connection to the host in the owner's
// setting, with the certificate checked by Sara. This writes requests (Host, Authorization,
// Content-Length) and reads responses (Content-Length or chunked, keep-alive), one request at a time
// per connection, 30 s each, 25 MB at most. A closed connection is opened again for the next
// request. Plain JavaScript, no dependencies; shared by later plugins that call an HTTPS API.
// Phase 122 part 2 (docs/design/BRIDGES4.md §3.1 B4): every plugin folder carries a byte-equal copy.
// Two additions: a long-poll read (`request(…, { timeoutMs })`, up to 2 minutes, for Matrix's /sync
// and AgentText's wait) and plain HTTP on a `tls: 'optional'` endpoint (`new Http1(…, { tls: false })`).
// A secret that must travel in the query string (`querySecret`) is added at send time only and never
// appears in an error; `safePath()` cuts any path at `?` for logs.

export const TIMEOUT_MS = 30_000;
export const MAX_BODY = 25 * 1024 * 1024;
export const IDLE_MS = 5 * 60_000;
export const LONG_MAX_MS = 120_000;

/** A path for a log line or an error: everything after `?` is cut (a secret may ride there). */
export const safePath = (p) => String(p ?? '').split('?')[0].slice(0, 200);

/** Parses one response from the front of `buf`; undefined until it is complete. */
export function parseResponse(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return undefined;
  const head = buf.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '');
  if (!m) throw new Error('not an HTTP response');
  const headers = {};
  for (const line of head.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let at = end + 4;
  let body;
  if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
    const parts = [];
    let total = 0;
    for (;;) {
      const nl = buf.indexOf('\r\n', at);
      if (nl < 0) return undefined;
      const size = parseInt(buf.subarray(at, nl).toString('latin1').split(';')[0], 16);
      if (!Number.isFinite(size)) throw new Error('a bad chunk size');
      if (buf.length < nl + 2 + size + 2) return undefined;
      if (size === 0) {
        // Trailers (rare) end with an empty line.
        const t = buf.indexOf('\r\n', nl + 2);
        if (t < 0) return undefined;
        at = t + 2;
        break;
      }
      total += size;
      if (total > MAX_BODY) throw new Error('the answer is too big');
      parts.push(buf.subarray(nl + 2, nl + 2 + size));
      at = nl + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  } else {
    const len = Number(headers['content-length'] ?? 0);
    if (len > MAX_BODY) throw new Error('the answer is too big');
    if (buf.length < at + len) return undefined;
    body = buf.subarray(at, at + len);
    at += len;
  }
  return { status: Number(m[1]), headers, body, rest: buf.subarray(at) };
}

/**
 * One keep-alive connection to an endpoint of the manifest (`graph` or `media`). Options: `port`
 * (the manifest port asked for, default 443), `tls` (only for `tls: 'optional'` endpoints), `ua`,
 * `querySecret: () => [name, value]` (added to every path at send time).
 */
export class Http1 {
  constructor(sara, endpoint, host, o = {}) {
    this.sara = sara;
    this.endpoint = endpoint;
    this.host = host;
    this.o = o;
    this.sock = undefined;
    this.buf = Buffer.alloc(0);
    this.waiting = undefined;
    this.chain = Promise.resolve();
    this.idle = undefined;
  }

  async #open() {
    // The manifest's port (443); the host (and, under the test-only override, the stand-in's port) come from the setting.
    const s = await this.sara.net.open(this.endpoint, { port: this.o.port ?? 443, ...(typeof this.o.tls === 'boolean' ? { tls: this.o.tls } : {}) });
    this.sock = s;
    this.buf = Buffer.alloc(0);
    s.onData((b) => {
      this.buf = Buffer.concat([this.buf, b]);
      this.#pump();
    });
    s.onClose((why) => {
      if (this.sock === s) this.sock = undefined;
      const w = this.waiting;
      this.waiting = undefined;
      w?.reject(new Error(`the connection closed (${why})`));
    });
    return s;
  }

  #pump() {
    const w = this.waiting;
    if (!w) return;
    let r;
    try {
      r = parseResponse(this.buf);
    } catch (err) {
      this.waiting = undefined;
      void this.close();
      return w.reject(err);
    }
    if (!r) {
      if (this.buf.length > MAX_BODY + 64 * 1024) {
        this.waiting = undefined;
        void this.close();
        w.reject(new Error('the answer is too big'));
      }
      return;
    }
    this.buf = r.rest;
    this.waiting = undefined;
    if (/close/i.test(r.headers.connection ?? '')) void this.close();
    w.resolve({ status: r.status, headers: r.headers, body: r.body });
  }

  /** `request('GET', '/v26.0/123', { authorization: 'Bearer …' }, body?, { timeoutMs }?)` → { status, headers, body }. */
  request(method, path, headers = {}, body, ro = {}) {
    const wait = Math.min(LONG_MAX_MS, Math.max(1000, Number(ro.timeoutMs) || TIMEOUT_MS));
    const run = async () => {
      clearTimeout(this.idle);
      const s = this.sock ?? (await this.#open());
      const b = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      let full = path;
      const q = this.o.querySecret?.();
      if (q && q[1]) full += `${path.includes('?') ? '&' : '?'}${encodeURIComponent(q[0])}=${encodeURIComponent(q[1])}`;
      const lines = [`${method} ${full} HTTP/1.1`, `Host: ${this.host}`, 'Connection: keep-alive', `User-Agent: ${this.o.ua ?? 'Sara/1.0'}`, 'Accept: application/json'];
      for (const [k, v] of Object.entries(headers)) if (v !== undefined && !/[\r\n]/.test(String(v))) lines.push(`${k}: ${v}`);
      if (b) lines.push(`Content-Length: ${b.length}`);
      const out = Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), ...(b ? [b] : [])]);
      const res = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.waiting?.resolve === done) this.waiting = undefined;
          void this.close();
          reject(new Error(`no answer in ${Math.round(wait / 1000)} s`));
        }, wait);
        timer.unref?.();
        const done = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
        this.waiting = { resolve: done, reject: (e) => (clearTimeout(timer), reject(e)) };
      });
      // Writes go in pieces the broker takes (≤ 256 KB each).
      for (let i = 0; i < out.length; i += 200 * 1024) await s.write(out.subarray(i, i + 200 * 1024));
      const r = await res;
      this.idle = setTimeout(() => void this.close(), IDLE_MS);
      this.idle.unref?.();
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async close() {
    const s = this.sock;
    this.sock = undefined;
    clearTimeout(this.idle);
    if (s) await s.close().catch(() => undefined);
  }
}

/** A multipart/form-data body (RFC 7578) from fields and one file. */
export function multipart(fields, file) {
  const boundary = `----sara${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const name = String(file.name ?? 'file').replace(/["\r\n\\]/g, '_');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.mime || 'application/octet-stream'}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

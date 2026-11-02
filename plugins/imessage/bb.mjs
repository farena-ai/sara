// The BlueBubbles REST calls the plugin makes (docs/design/BRIDGES4.md §2.2, §4.3), over HTTP/1.1 on a
// socket Sara holds for it (http1.mjs, the broker's `bb` endpoint: loopback, his home network or his
// tailnet, plain HTTP unless he switched on *BlueBubbles uses HTTPS*). BlueBubbles' only credential is
// its server password, which it takes in the URL (`?guid=`): http1.mjs adds it at send time from the
// vault (`init.secrets.password`) and it never appears in an error, a log line or a diagnosis here.
import { Http1 } from './http1.mjs';

export class BBError extends Error {
  constructor(status, body = {}, path = '') {
    const words = String(body?.error?.message ?? body?.error?.error ?? body?.message ?? `HTTP ${status}`);
    super(`${words} (${String(path).split('?')[0].slice(0, 80)})`.slice(0, 300));
    this.status = status;
  }
}

/** BlueBubbles chat guids hold `;` (`iMessage;-;+15551234567`), which Sara's chat ids can't: `;` ↔ `:`. */
export const chatOf = (guid) => String(guid ?? '').replace(/;/g, ':');
export const guidOf = (chatId) => String(chatId ?? '').replace(/:/g, ';');
/** A group chat (`iMessage;+;chat123…`) rather than a one-to-one chat (`iMessage;-;…`, `any;-;…`). */
export const isGroupGuid = (guid) => /;\+;/.test(String(guid ?? ''));

let tempSeq = 0;
export const tempGuid = () => `temp-sara-${Date.now().toString(36)}-${(++tempSeq).toString(36)}`;

/** multipart/form-data with BlueBubbles' field names (`attachment` for the file). */
export function form(fields, file) {
  const boundary = `----sarabb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const name = String(file.name ?? 'file').replace(/["\r\n\\]/g, '_');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${name}"\r\nContent-Type: ${file.mime || 'application/octet-stream'}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

export class BB {
  constructor(sara) {
    this.sara = sara;
    this.conn = undefined;
  }

  get address() {
    return String(this.sara.settings.server ?? '').trim();
  }
  get password() {
    return String(this.sara.secrets.password ?? '');
  }
  get https() {
    return this.sara.settings.https === true;
  }

  #http() {
    const host = this.address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const port = Number(/:(\d+)$/.exec(this.address)?.[1] ?? 1234);
    return (this.conn ??= new Http1(this.sara, 'bb', host, { port, tls: this.https, ua: 'Sara-iMessage/1.0', querySecret: () => ['guid', this.password] }));
  }

  /** One call: JSON in and out (or raw bytes), the password added by http1.mjs. */
  async call(method, path, body, o = {}) {
    if (!this.address) throw new BBError(0, { message: 'no BlueBubbles address yet' }, path);
    if (!this.password) throw new BBError(401, { message: 'no BlueBubbles password yet' }, path);
    const headers = {};
    let payload;
    if (o.raw) {
      payload = o.raw;
      headers['Content-Type'] = o.type;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const r = await this.#http().request(method, path, headers, payload, o.timeoutMs ? { timeoutMs: o.timeoutMs } : {});
    if (o.bytes && r.status < 400) return { bytes: r.body, type: String(r.headers['content-type'] ?? '') };
    let data = {};
    try {
      data = r.body.length ? JSON.parse(r.body.toString('utf8')) : {};
    } catch {
      data = {};
    }
    if (r.status >= 400) throw new BBError(r.status, data, path);
    return data?.data ?? data;
  }

  async close() {
    await this.conn?.close();
    this.conn = undefined;
  }

  ping() {
    return this.call('GET', '/api/v1/ping');
  }
  info() {
    return this.call('GET', '/api/v1/server/info');
  }
  account() {
    return this.call('GET', '/api/v1/icloud/account');
  }
  /** Messages after a time (ms since 1970), oldest first: the catch-up and the polling. */
  query(after, limit = 50) {
    return this.call('POST', '/api/v1/message/query', { after: Math.max(0, Math.floor(after)), with: ['chat', 'chat.participants', 'handle', 'attachment'], sort: 'ASC', limit });
  }
  message(guid) {
    return this.call('GET', `/api/v1/message/${encodeURIComponent(guid)}?with=chat,chat.participants,handle,attachment`);
  }
  sendText(chatGuid, message, o = {}) {
    const body = { chatGuid, tempGuid: tempGuid(), message, method: o.privateApi ? 'private-api' : 'apple-script', ...(o.privateApi && o.replyTo ? { selectedMessageGuid: o.replyTo, partIndex: 0 } : {}) };
    return this.call('POST', '/api/v1/message/text', body, { timeoutMs: 60_000 });
  }
  sendFile(chatGuid, file, o = {}) {
    const f = form({ chatGuid, tempGuid: tempGuid(), name: String(file.name ?? 'file').slice(0, 120), method: o.privateApi ? 'private-api' : 'apple-script' }, file);
    return this.call('POST', '/api/v1/message/attachment', undefined, { raw: f.body, type: f.type, timeoutMs: 90_000 });
  }
  download(guid) {
    return this.call('GET', `/api/v1/attachment/${encodeURIComponent(guid)}/download`, undefined, { bytes: true, timeoutMs: 60_000 });
  }
  typing(chatGuid, on) {
    return this.call(on ? 'POST' : 'DELETE', `/api/v1/chat/${encodeURIComponent(chatGuid)}/typing`);
  }
  react(chatGuid, messageGuid, reaction = 'emphasize') {
    return this.call('POST', '/api/v1/message/react', { chatGuid, selectedMessageGuid: messageGuid, reaction });
  }
  edit(messageGuid, text) {
    return this.call('POST', `/api/v1/message/${encodeURIComponent(messageGuid)}/edit`, { editedMessage: text, backwardsCompatibilityMessage: `Edited to "${text}"`, partIndex: 0 });
  }
  read(chatGuid) {
    return this.call('POST', `/api/v1/chat/${encodeURIComponent(chatGuid)}/read`);
  }
  webhooks() {
    return this.call('GET', '/api/v1/webhook');
  }
  addWebhook(url, events) {
    return this.call('POST', '/api/v1/webhook', { url, events });
  }
  removeWebhook(id) {
    return this.call('DELETE', `/api/v1/webhook/${encodeURIComponent(id)}`);
  }
}

/** `server/info` → what Sara needs: version, macOS, Private API (with its helper connected), the account. */
export function readInfo(d = {}) {
  const account = String(d.detected_imessage ?? d.detected_icloud ?? '').trim().toLowerCase();
  return {
    version: String(d.server_version ?? '').slice(0, 30),
    os: String(d.os_version ?? '').slice(0, 30),
    privateApi: d.private_api === true && d.helper_connected !== false,
    account,
    signedIn: Boolean(account),
  };
}

/** `icloud/account` (+ server/info's account) → every address of her Apple ID, lower-case. */
export function accountHandles(acc = {}, infoAccount = '') {
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (s && s.length <= 120) out.add(s);
  };
  add(acc.apple_id ?? acc.appleId ?? acc.account);
  for (const a of Array.isArray(acc.vetted_aliases) ? acc.vetted_aliases : []) add(typeof a === 'string' ? a : (a?.Alias ?? a?.alias));
  for (const a of Array.isArray(acc.aliases) ? acc.aliases : []) add(typeof a === 'string' ? a : (a?.Alias ?? a?.alias));
  add(infoAccount);
  return [...out].slice(0, 20);
}

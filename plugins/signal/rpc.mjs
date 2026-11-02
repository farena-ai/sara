// The Signal plugin's JSON-RPC client for signal-cli's daemon (`daemon --tcp`, docs/design/BRIDGES3.md
// §2.1, §4.3). One line of JSON per request and per answer; ids are s<n>; notifications (`receive`)
// carry no id. The socket is Sara's (sara.net.open): the plugin itself never opens one.

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** Is this error signal-cli's rate limit (exit code 5 / RateLimitException)? */
export const isRateLimit = (err) => Boolean(err) && (err.code === -5 || err.code === 5 || /rate.?limit|429/i.test(String(err.message ?? '')));
/** Is this error an untrusted identity (exit code 4)? */
export const isUntrusted = (err) => Boolean(err) && (err.code === -4 || err.code === 4 || /untrusted|identity/i.test(String(err.message ?? '')));

export class Rpc {
  #sock;
  #buf = '';
  #seq = 0;
  #pending = new Map();
  #onNotify;
  #onClose;
  #closed = false;
  #timeoutMs;

  constructor(sock, { onNotify, onClose, timeoutMs = 30_000 } = {}) {
    this.#sock = sock;
    this.#onNotify = onNotify ?? (() => {});
    this.#onClose = onClose ?? (() => {});
    this.#timeoutMs = timeoutMs;
    sock.onData((bytes) => this.#data(bytes));
    sock.onClose((why) => this.#close(why));
  }

  get closed() {
    return this.#closed;
  }

  #data(bytes) {
    this.#buf += bytes.toString('utf8');
    if (this.#buf.length > 8 * 1024 * 1024) {
      this.#buf = '';
      void this.#sock.close().catch(() => {});
      return;
    }
    let nl;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== undefined && msg.id !== null && this.#pending.has(String(msg.id))) {
        const p = this.#pending.get(String(msg.id));
        this.#pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(String(msg.error.message ?? 'error').slice(0, 300), msg.error.code, msg.error.data));
        else p.resolve(msg.result);
      } else if (msg && typeof msg.method === 'string') this.#onNotify(msg.method, msg.params ?? {});
    }
  }

  #close(why) {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError(`signal-cli connection closed (${why})`));
    }
    this.#pending.clear();
    this.#onClose(why);
  }

  /** One request; resolves with `result` or rejects with an RpcError. */
  call(method, params = {}) {
    if (this.#closed) return Promise.reject(new RpcError('not connected to signal-cli'));
    const id = `s${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcError(`signal-cli didn't answer ${method} within ${Math.round(this.#timeoutMs / 1000)} s`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#sock.write(Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, 'utf8')).catch((err) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new RpcError(`couldn't write to signal-cli: ${err?.message ?? err}`));
      });
    });
  }

  close() {
    return this.#sock.close().catch(() => {});
  }
}

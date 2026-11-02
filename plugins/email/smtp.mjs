// SMTP submission, from scratch, over a socket Sara holds (BRIDGES3 §5.3). Checked against the
// official text (rfc-editor.org, read 2026-11-01):
//
// - RFC 5321 (SMTP): §4.1.1.1 EHLO; §4.2 replies are a three-digit code, and in a multiline reply
//   "every line, except the last, begin with the reply code, followed immediately by a hyphen";
//   2yz is done, 3yz (354 after DATA) wants more, 4yz is "transient negative" (try again later),
//   5yz is "permanent negative"; §4.5.2 transparency: "If the first character is a period, one
//   additional period is inserted at the beginning of the line", and "<CRLF>.<CRLF>" ends the data.
// - RFC 6409 (message submission) on 587 and RFC 8314 (implicit TLS, "submissions" on 465).
// - RFC 4954 (SMTP AUTH) with RFC 4616 PLAIN, or LOGIN when that's all it offers.
//
// The broker guarantees TLS before this code sees the socket (implicit TLS on 465, or Sara's own
// STARTTLS on 587, in which case the greeting was already read and EHLO is sent again over TLS as
// RFC 3207 §4.2 requires), so AUTH is never sent in the clear. One RCPT TO per mail (no reply-all).

export class SmtpError extends Error {
  constructor(message, code = 0) {
    super(message);
    this.code = code;
    /** 4xx: try again later; anything else is final. */
    this.transient = code >= 400 && code < 500;
  }
}

/** RFC 5321 §4.5.2: dot-stuffing, CRLF line ends, and the final "." line. */
export function dotStuff(raw) {
  const s = Buffer.from(raw).toString('latin1').replace(/\r?\n/g, '\r\n');
  const body = s.split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
  return Buffer.from(`${body.endsWith('\r\n') ? body : `${body}\r\n`}.\r\n`, 'latin1');
}

export class Smtp {
  constructor(sock, { clock = { setTimeout, clearTimeout } } = {}) {
    this.sock = sock;
    this.clock = clock;
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.replies = []; // a reply that came before anyone waited for it (the greeting, often)
    this.closed = null;
    this.caps = new Set();
    sock.onData((b) => this.#data(b));
    sock.onClose((why) => {
      this.closed = String(why ?? 'closed');
      this.waiter?.reject(new SmtpError(`the connection closed (${this.closed})`, 421));
      this.waiter = null;
    });
  }

  #data(b) {
    this.buf += Buffer.from(b).toString('latin1');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.lines.push(line);
      // §4.2: the last line of a reply has a space (or nothing) after the code.
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = this.lines;
        this.lines = [];
        const r = { code: Number(line.slice(0, 3)), lines: reply.map((l) => l.slice(4)) };
        const w = this.waiter;
        this.waiter = null;
        if (w) w.resolve(r);
        else if (this.replies.length < 8) this.replies.push(r);
      } else if (!/^\d{3}-/.test(line)) {
        this.waiter?.reject(new SmtpError(`a reply this client doesn't understand (${line.slice(0, 80)})`, 0));
        this.waiter = null;
      }
    }
  }

  #reply(ms = 120_000) {
    return new Promise((resolve, reject) => {
      if (this.replies.length) return resolve(this.replies.shift());
      if (this.closed) return reject(new SmtpError(`the connection is closed (${this.closed})`, 421));
      let timer;
      this.waiter = {
        resolve: (r) => (this.clock.clearTimeout(timer), resolve(r)),
        reject: (e) => (this.clock.clearTimeout(timer), reject(e)),
      };
      timer = this.clock.setTimeout(() => {
        this.waiter = null;
        reject(new SmtpError(`no answer within ${Math.round(ms / 1000)} s`, 421));
      }, ms);
    });
  }

  async #cmd(line, want, ms) {
    const p = this.#reply(ms);
    await this.sock.write(Buffer.from(`${line}\r\n`, 'latin1'));
    const r = await p;
    if (!want.includes(Math.floor(r.code / 100))) throw new SmtpError(`${line.split(' ')[0]}: ${r.code} ${r.lines.join(' ').slice(0, 200)}`, r.code);
    return r;
  }

  /** Greeting (unless Sara already read it for STARTTLS), EHLO, AUTH. */
  async hello(name, user, pass, { greeted = false } = {}) {
    if (!greeted) {
      const g = await this.#reply(60_000);
      if (g.code !== 220) throw new SmtpError(`the server greeted with ${g.code} ${g.lines.join(' ').slice(0, 120)}`, g.code);
    }
    const r = await this.#cmd(`EHLO ${name}`, [2], 60_000);
    this.caps = new Set(r.lines.slice(1).map((l) => l.toUpperCase()));
    const auth = [...this.caps].find((l) => l.startsWith('AUTH ') || l.startsWith('AUTH=')) ?? '';
    const mechs = new Set(auth.slice(5).split(/\s+/));
    if (!user) return;
    if (mechs.has('PLAIN') || !mechs.has('LOGIN')) {
      await this.#cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')}`, [2], 60_000).catch((err) => {
        throw new SmtpError(`the mail server refused the password (${err.message.slice(0, 160)})`, err.code || 535);
      });
    } else {
      await this.#cmd('AUTH LOGIN', [3], 60_000);
      await this.#cmd(Buffer.from(user, 'utf8').toString('base64'), [3], 60_000);
      await this.#cmd(Buffer.from(pass, 'utf8').toString('base64'), [2], 60_000).catch((err) => {
        throw new SmtpError(`the mail server refused the password (${err.message.slice(0, 160)})`, err.code || 535);
      });
    }
  }

  /** One mail to one recipient. */
  async send(from, to, raw) {
    await this.#cmd(`MAIL FROM:<${from}>`, [2]);
    await this.#cmd(`RCPT TO:<${to}>`, [2]);
    await this.#cmd('DATA', [3]);
    const p = this.#reply(300_000);
    await this.sock.write(dotStuff(raw));
    const r = await p;
    if (Math.floor(r.code / 100) !== 2) throw new SmtpError(`DATA: ${r.code} ${r.lines.join(' ').slice(0, 200)}`, r.code);
  }

  async quit() {
    await this.#cmd('QUIT', [2], 5000).catch(() => {});
    await this.sock.close().catch?.(() => {});
  }
}
